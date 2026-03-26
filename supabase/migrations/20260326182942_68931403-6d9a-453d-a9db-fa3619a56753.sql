-- Create invoice status enum
CREATE TYPE public.invoice_status AS ENUM ('unpaid', 'paid', 'disputed');

-- Create vendor_invoices table
CREATE TABLE public.vendor_invoices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  vendor TEXT NOT NULL,
  doc_type TEXT,
  invoice_number TEXT NOT NULL,
  po_number TEXT,
  account_number TEXT,
  invoice_date DATE NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax NUMERIC(12,2) NOT NULL DEFAULT 0,
  freight NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_terms TEXT,
  carrier TEXT,
  status invoice_status NOT NULL DEFAULT 'unpaid',
  due_date DATE,
  paid_date DATE,
  notes TEXT,
  line_items JSONB DEFAULT '[]'::jsonb,
  filename TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.vendor_invoices ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read invoices
CREATE POLICY "Authenticated users can view invoices"
  ON public.vendor_invoices FOR SELECT TO authenticated USING (true);

-- Allow all authenticated users to insert invoices
CREATE POLICY "Authenticated users can insert invoices"
  ON public.vendor_invoices FOR INSERT TO authenticated WITH CHECK (true);

-- Allow all authenticated users to update invoices
CREATE POLICY "Authenticated users can update invoices"
  ON public.vendor_invoices FOR UPDATE TO authenticated USING (true);

-- Allow all authenticated users to delete invoices
CREATE POLICY "Authenticated users can delete invoices"
  ON public.vendor_invoices FOR DELETE TO authenticated USING (true);

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_vendor_invoices_updated_at
  BEFORE UPDATE ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Index for common filters
CREATE INDEX idx_vendor_invoices_vendor ON public.vendor_invoices (vendor);
CREATE INDEX idx_vendor_invoices_status ON public.vendor_invoices (status);
CREATE INDEX idx_vendor_invoices_invoice_date ON public.vendor_invoices (invoice_date);
CREATE INDEX idx_vendor_invoices_due_date ON public.vendor_invoices (due_date);