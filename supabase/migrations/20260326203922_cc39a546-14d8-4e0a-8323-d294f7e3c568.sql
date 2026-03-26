ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS is_multi_shipment boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shipment_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_shipment_date date,
  ADD COLUMN IF NOT EXISTS last_shipment_file text,
  ADD COLUMN IF NOT EXISTS po_total_invoiced numeric;