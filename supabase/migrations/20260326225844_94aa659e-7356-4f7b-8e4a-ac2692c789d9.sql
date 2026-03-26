ALTER TABLE vendor_invoices REPLICA IDENTITY FULL;
ALTER TABLE invoice_payments REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vendor_invoices;
ALTER PUBLICATION supabase_realtime ADD TABLE public.invoice_payments;