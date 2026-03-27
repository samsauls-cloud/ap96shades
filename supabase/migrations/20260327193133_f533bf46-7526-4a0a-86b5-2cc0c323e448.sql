-- TRIGGER 1: New invoice arrives after last recon run
CREATE OR REPLACE FUNCTION public.trg_invoice_stale_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  latest_run_id uuid;
  latest_run_at timestamptz;
  line_item jsonb;
BEGIN
  SELECT id, run_at INTO latest_run_id, latest_run_at
  FROM reconciliation_runs
  ORDER BY run_at DESC
  LIMIT 1;

  IF latest_run_id IS NOT NULL THEN
    NEW.entered_after_recon := true;
    NEW.recon_status := 'pending';
    NEW.recon_stale := true;
    NEW.recon_stale_reason := 'Invoice added after last reconciliation run on ' || to_char(latest_run_at, 'YYYY-MM-DD HH24:MI');

    IF jsonb_typeof(NEW.line_items) = 'array' AND jsonb_array_length(NEW.line_items) > 0 THEN
      FOR line_item IN SELECT * FROM jsonb_array_elements(NEW.line_items)
      LOOP
        INSERT INTO recon_stale_queue (triggered_by, entity_type, entity_id, upc, vendor, brand, prior_recon_run_id)
        VALUES (
          'new_invoice',
          'invoice',
          NEW.id,
          line_item->>'upc',
          NEW.vendor,
          line_item->>'brand',
          latest_run_id
        );
      END LOOP;
    ELSE
      INSERT INTO recon_stale_queue (triggered_by, entity_type, entity_id, vendor, prior_recon_run_id)
      VALUES ('new_invoice', 'invoice', NEW.id, NEW.vendor, latest_run_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vendor_invoices_stale_insert ON vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_stale_insert
  BEFORE INSERT ON vendor_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_invoice_stale_on_insert();

-- TRIGGER 2: Invoice updated after recon
CREATE OR REPLACE FUNCTION public.trg_invoice_stale_on_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed_fields text[] := '{}';
  latest_run_id uuid;
BEGIN
  IF OLD.last_reconciled_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.total IS DISTINCT FROM NEW.total THEN
    changed_fields := array_append(changed_fields, 'total');
  END IF;
  IF OLD.line_items::text IS DISTINCT FROM NEW.line_items::text THEN
    changed_fields := array_append(changed_fields, 'line_items');
  END IF;
  IF OLD.subtotal IS DISTINCT FROM NEW.subtotal THEN
    changed_fields := array_append(changed_fields, 'subtotal');
  END IF;

  IF array_length(changed_fields, 1) > 0 THEN
    NEW.recon_stale := true;
    NEW.recon_stale_reason := 'Invoice updated after reconciliation: ' || array_to_string(changed_fields, ', ');

    SELECT id INTO latest_run_id FROM reconciliation_runs ORDER BY run_at DESC LIMIT 1;

    INSERT INTO recon_stale_queue (triggered_by, entity_type, entity_id, vendor, prior_recon_run_id)
    VALUES ('invoice_updated', 'invoice', NEW.id, NEW.vendor, latest_run_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vendor_invoices_stale_update ON vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_stale_update
  BEFORE UPDATE ON vendor_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_invoice_stale_on_update();