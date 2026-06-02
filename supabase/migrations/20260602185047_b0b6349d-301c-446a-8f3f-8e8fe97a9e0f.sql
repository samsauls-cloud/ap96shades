
-- ============================================================
-- DB-LEVEL INVARIANTS (Anti-"Josh-texts-me" guardrails, batch 1)
-- ============================================================
-- These triggers enforce the same rules as the app-level preflight,
-- but at the database boundary so NOTHING — manual SQL, future code,
-- backfills, edge functions — can write violating data.
--
-- Strategy: validation triggers (not CHECK constraints) so they
-- only fire on the relevant column changes and we can scope them
-- to "new bad data" without rejecting the 2 known legacy rows.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. vendor_invoices.doc_type must be uppercase canonical
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_doc_type_canonical()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.doc_type IS NULL OR NEW.doc_type = '' THEN
    NEW.doc_type := 'INVOICE';
    RETURN NEW;
  END IF;

  -- Auto-canonicalize common lowercase variants instead of rejecting,
  -- so a stray writer self-heals rather than 500s.
  NEW.doc_type := CASE LOWER(NEW.doc_type)
    WHEN 'invoice' THEN 'INVOICE'
    WHEN 'po' THEN 'PO'
    WHEN 'proforma' THEN 'proforma'
    WHEN 'pro forma' THEN 'proforma'
    WHEN 'pro-forma' THEN 'proforma'
    WHEN 'credit_memo' THEN 'credit_memo'
    WHEN 'credit memo' THEN 'credit_memo'
    WHEN 'credit' THEN 'credit_memo'
    ELSE NEW.doc_type
  END;

  -- Hard-stop on anything that isn't in the known set
  IF NEW.doc_type NOT IN ('INVOICE','PO','proforma','credit_memo') THEN
    RAISE EXCEPTION
      'doc_type "%" is not allowed. Must be one of: INVOICE, PO, proforma, credit_memo',
      NEW.doc_type;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_doc_type_canonical ON public.vendor_invoices;
CREATE TRIGGER trg_enforce_doc_type_canonical
BEFORE INSERT OR UPDATE OF doc_type ON public.vendor_invoices
FOR EACH ROW EXECUTE FUNCTION public.enforce_doc_type_canonical();


-- ─────────────────────────────────────────────────────────────
-- 2. invoice_payments date sanity:
--    due_date >= invoice_date AND <= invoice_date + 3 years
--    amount_due > 0 (zero-amount paid rows have caused stats bugs)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_payment_row_sanity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.due_date IS NULL OR NEW.invoice_date IS NULL THEN
    RAISE EXCEPTION
      'invoice_payments row must have both invoice_date and due_date (invoice "%", due_date %, invoice_date %)',
      NEW.invoice_number, NEW.due_date, NEW.invoice_date;
  END IF;

  IF NEW.due_date < NEW.invoice_date THEN
    RAISE EXCEPTION
      'invoice_payments due_date (%) is before invoice_date (%) for invoice "%" — likely a date-parsing bug',
      NEW.due_date, NEW.invoice_date, NEW.invoice_number;
  END IF;

  IF (NEW.due_date - NEW.invoice_date) > 1096 THEN
    RAISE EXCEPTION
      'invoice_payments due_date (%) is more than 3 years after invoice_date (%) for invoice "%" — likely a MM/DD vs DD/MM flip',
      NEW.due_date, NEW.invoice_date, NEW.invoice_number;
  END IF;

  IF NEW.amount_due IS NULL OR NEW.amount_due <= 0 THEN
    RAISE EXCEPTION
      'invoice_payments.amount_due must be > 0 (invoice "%", got %)',
      NEW.invoice_number, NEW.amount_due;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_payment_row_sanity ON public.invoice_payments;
CREATE TRIGGER trg_enforce_payment_row_sanity
BEFORE INSERT OR UPDATE OF due_date, invoice_date, amount_due
ON public.invoice_payments
FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_row_sanity();


-- ─────────────────────────────────────────────────────────────
-- 3. payment_history invariant:
--    cannot DELETE or zero-out a row that has recorded payments
--    (this is the strongest "Josh's money has been touched" guard)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.protect_payment_history_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.payment_history IS NOT NULL
     AND jsonb_typeof(OLD.payment_history) = 'array'
     AND jsonb_array_length(OLD.payment_history) > 0 THEN
    RAISE EXCEPTION
      'Cannot delete invoice_payments row % (invoice "%") — it has % recorded payment(s) in payment_history. Void the payment from the app instead.',
      OLD.id, OLD.invoice_number, jsonb_array_length(OLD.payment_history);
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_payment_history_delete ON public.invoice_payments;
CREATE TRIGGER trg_protect_payment_history_delete
BEFORE DELETE ON public.invoice_payments
FOR EACH ROW EXECUTE FUNCTION public.protect_payment_history_on_delete();


CREATE OR REPLACE FUNCTION public.protect_payment_history_on_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  old_len int := 0;
  new_len int := 0;
BEGIN
  IF OLD.payment_history IS NOT NULL AND jsonb_typeof(OLD.payment_history) = 'array' THEN
    old_len := jsonb_array_length(OLD.payment_history);
  END IF;
  IF NEW.payment_history IS NOT NULL AND jsonb_typeof(NEW.payment_history) = 'array' THEN
    new_len := jsonb_array_length(NEW.payment_history);
  END IF;

  -- Allow appends (new_len >= old_len). Block silent shrinks/wipes.
  IF new_len < old_len THEN
    RAISE EXCEPTION
      'Cannot shrink payment_history on invoice_payments % (invoice "%") from % to % entries. Voids must be appended, not removed.',
      OLD.id, OLD.invoice_number, old_len, new_len;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_payment_history_update ON public.invoice_payments;
CREATE TRIGGER trg_protect_payment_history_update
BEFORE UPDATE OF payment_history ON public.invoice_payments
FOR EACH ROW EXECUTE FUNCTION public.protect_payment_history_on_update();


-- ─────────────────────────────────────────────────────────────
-- 4. Protect vendor_invoices from deletion when payments exist
--    (mirrors the "Deletion Rules" core memory: never delete an
--    invoice without manual nullification of references)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.protect_invoice_delete_with_payments()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  paid_count int;
BEGIN
  SELECT COUNT(*) INTO paid_count
  FROM public.invoice_payments
  WHERE invoice_id = OLD.id
    AND payment_history IS NOT NULL
    AND jsonb_typeof(payment_history) = 'array'
    AND jsonb_array_length(payment_history) > 0;

  IF paid_count > 0 THEN
    RAISE EXCEPTION
      'Cannot delete vendor_invoices % ("% / %") — % installment(s) have recorded payments. Nullify references first.',
      OLD.id, OLD.vendor, OLD.invoice_number, paid_count;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_invoice_delete_with_payments ON public.vendor_invoices;
CREATE TRIGGER trg_protect_invoice_delete_with_payments
BEFORE DELETE ON public.vendor_invoices
FOR EACH ROW EXECUTE FUNCTION public.protect_invoice_delete_with_payments();
