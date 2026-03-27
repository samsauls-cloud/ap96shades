
-- Part 2: Add reconciliation columns to vendor_invoices
ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS reconciliation_status text DEFAULT 'unreconciled',
  ADD COLUMN IF NOT EXISTS credit_due numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_bill_amount numeric,
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciled_session_id uuid REFERENCES public.po_receiving_sessions(id);

-- Part 3: Create final_bill_ledger table
CREATE TABLE public.final_bill_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  invoice_id uuid REFERENCES public.vendor_invoices(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.po_receiving_sessions(id) ON DELETE SET NULL,
  vendor text NOT NULL,
  invoice_number text NOT NULL,
  po_number text,
  invoice_date date,
  original_invoice_total numeric NOT NULL DEFAULT 0,
  total_ordered_qty integer DEFAULT 0,
  total_received_qty integer DEFAULT 0,
  total_not_received_qty integer DEFAULT 0,
  credit_due_overbilled numeric DEFAULT 0,
  qty_mismatch_amount numeric DEFAULT 0,
  not_on_invoice_amount numeric DEFAULT 0,
  total_credit_due numeric DEFAULT 0,
  final_bill_amount numeric NOT NULL DEFAULT 0,
  final_bill_status text DEFAULT 'pending',
  amount_paid_toward_final numeric DEFAULT 0,
  final_balance_remaining numeric DEFAULT 0,
  discrepancy_line_count integer DEFAULT 0,
  credit_request_sent boolean DEFAULT false,
  credit_request_sent_at timestamptz,
  credit_approved boolean DEFAULT false,
  credit_approved_amount numeric DEFAULT 0,
  credit_approved_at timestamptz,
  notes text,
  approved_by text
);

-- RLS for final_bill_ledger
ALTER TABLE public.final_bill_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view final_bill_ledger" ON public.final_bill_ledger
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Anyone can insert final_bill_ledger" ON public.final_bill_ledger
  FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "Anyone can update final_bill_ledger" ON public.final_bill_ledger
  FOR UPDATE TO anon, authenticated USING (true);

CREATE POLICY "Anyone can delete final_bill_ledger" ON public.final_bill_ledger
  FOR DELETE TO anon, authenticated USING (true);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.final_bill_ledger;
