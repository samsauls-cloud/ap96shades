
CREATE TABLE public.invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid REFERENCES public.vendor_invoices(id) ON DELETE CASCADE,
  vendor text NOT NULL,
  invoice_number text NOT NULL,
  po_number text,
  invoice_amount numeric NOT NULL,
  invoice_date date NOT NULL,
  terms text,
  installment_label text,
  due_date date NOT NULL,
  amount_due numeric NOT NULL,
  is_paid boolean NOT NULL DEFAULT false,
  paid_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoice_payments_vendor ON public.invoice_payments(vendor);
CREATE INDEX idx_invoice_payments_due_date ON public.invoice_payments(due_date);
CREATE INDEX idx_invoice_payments_is_paid ON public.invoice_payments(is_paid);
CREATE INDEX idx_invoice_payments_invoice_number ON public.invoice_payments(invoice_number);
CREATE INDEX idx_invoice_payments_invoice_id ON public.invoice_payments(invoice_id);

ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view payments" ON public.invoice_payments FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert payments" ON public.invoice_payments FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can update payments" ON public.invoice_payments FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "Anyone can delete payments" ON public.invoice_payments FOR DELETE TO anon, authenticated USING (true);
