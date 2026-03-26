-- Drop existing table and enum
DROP TABLE IF EXISTS public.vendor_invoices CASCADE;
DROP TYPE IF EXISTS public.invoice_status CASCADE;
DROP FUNCTION IF EXISTS public.update_updated_at_column() CASCADE;

-- Create vendor_invoices table with new schema
CREATE TABLE public.vendor_invoices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  vendor TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'INVOICE',
  invoice_number TEXT NOT NULL,
  invoice_date DATE NOT NULL,
  po_number TEXT,
  account_number TEXT,
  ship_to TEXT,
  carrier TEXT,
  payment_terms TEXT,
  subtotal NUMERIC,
  tax NUMERIC,
  freight NUMERIC,
  total NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  vendor_brands TEXT[],
  status TEXT NOT NULL DEFAULT 'unpaid',
  notes TEXT,
  filename TEXT,
  line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_by UUID REFERENCES auth.users(id)
);

-- Indexes
CREATE INDEX idx_vi_vendor ON public.vendor_invoices (vendor);
CREATE INDEX idx_vi_doc_type ON public.vendor_invoices (doc_type);
CREATE INDEX idx_vi_invoice_number ON public.vendor_invoices (invoice_number);
CREATE INDEX idx_vi_po_number ON public.vendor_invoices (po_number);
CREATE INDEX idx_vi_status ON public.vendor_invoices (status);
CREATE INDEX idx_vi_invoice_date ON public.vendor_invoices (invoice_date);

-- Full-text search index
CREATE INDEX idx_vi_search ON public.vendor_invoices USING gin (
  to_tsvector('english',
    coalesce(invoice_number, '') || ' ' ||
    coalesce(po_number, '') || ' ' ||
    coalesce(account_number, '') || ' ' ||
    coalesce(vendor, '') || ' ' ||
    coalesce(notes, '') || ' ' ||
    coalesce(filename, '')
  )
);

-- Enable RLS
ALTER TABLE public.vendor_invoices ENABLE ROW LEVEL SECURITY;

-- RLS policies - allow anon and authenticated full access for this internal tool
CREATE POLICY "Anyone can view invoices" ON public.vendor_invoices FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert invoices" ON public.vendor_invoices FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can update invoices" ON public.vendor_invoices FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "Anyone can delete invoices" ON public.vendor_invoices FOR DELETE TO anon, authenticated USING (true);