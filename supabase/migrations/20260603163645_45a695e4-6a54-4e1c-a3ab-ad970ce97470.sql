
ALTER TABLE public.invoice_payments
  ADD COLUMN IF NOT EXISTS manual_status_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_status_set_by text,
  ADD COLUMN IF NOT EXISTS manual_status_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_status_note text;

CREATE INDEX IF NOT EXISTS idx_invoice_payments_manual_override
  ON public.invoice_payments(manual_status_override) WHERE manual_status_override = true;
