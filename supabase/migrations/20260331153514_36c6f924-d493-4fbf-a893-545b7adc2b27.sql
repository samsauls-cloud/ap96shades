ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS special_order_received boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS special_order_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS special_order_received_by text;