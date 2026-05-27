
-- 1. Table
CREATE TABLE public.vendor_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor text NOT NULL,
  amount numeric(12,2) NOT NULL,
  description text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN (
    'remittance_overpay',
    'invoice_application',
    'manual_adjustment',
    'reversal'
  )),
  related_invoice_id uuid,
  related_payment_id uuid,
  related_history_index integer,
  occurred_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text DEFAULT 'Staff'
);

CREATE INDEX vendor_credits_vendor_idx ON public.vendor_credits (lower(vendor));
CREATE INDEX vendor_credits_occurred_on_idx ON public.vendor_credits (occurred_on DESC);
CREATE INDEX vendor_credits_related_invoice_idx
  ON public.vendor_credits (related_invoice_id) WHERE related_invoice_id IS NOT NULL;

-- 2. Grants (match other tables in this project)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_credits TO anon, authenticated;
GRANT ALL ON public.vendor_credits TO service_role;

-- 3. RLS (open, mirrors invoice_payments)
ALTER TABLE public.vendor_credits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view vendor_credits"
  ON public.vendor_credits FOR SELECT USING (true);
CREATE POLICY "Anyone can insert vendor_credits"
  ON public.vendor_credits FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update vendor_credits"
  ON public.vendor_credits FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete vendor_credits"
  ON public.vendor_credits FOR DELETE USING (true);

-- 4. Per-vendor running balance view (case-insensitive vendor grouping)
CREATE OR REPLACE VIEW public.vendor_credit_balances AS
SELECT
  lower(vendor) AS vendor_key,
  MAX(vendor)   AS vendor_name,
  COALESCE(SUM(amount), 0)::numeric(12,2) AS balance,
  MAX(occurred_on)        AS last_activity_on,
  COUNT(*)::integer       AS ledger_entries
FROM public.vendor_credits
GROUP BY lower(vendor);

GRANT SELECT ON public.vendor_credit_balances TO anon, authenticated;
GRANT ALL ON public.vendor_credit_balances TO service_role;

-- 5. Negative-balance guard
CREATE OR REPLACE FUNCTION public.check_vendor_credit_balance()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = public AS $$
DECLARE
  new_balance numeric;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO new_balance
  FROM public.vendor_credits
  WHERE lower(vendor) = lower(NEW.vendor);

  IF new_balance < 0 THEN
    RAISE EXCEPTION
      'vendor_credits balance would go negative for vendor "%" (resulting balance: %)',
      NEW.vendor, new_balance;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER vendor_credits_balance_guard
  AFTER INSERT OR UPDATE ON public.vendor_credits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_vendor_credit_balance();
