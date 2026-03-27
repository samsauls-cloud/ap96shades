
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz DEFAULT now(),
  run_by text,
  total_invoices_checked integer DEFAULT 0,
  total_po_lines_checked integer DEFAULT 0,
  total_discrepancies integer DEFAULT 0,
  total_amount_at_risk numeric(12,2) DEFAULT 0,
  status text DEFAULT 'complete',
  notes text
);

CREATE TABLE IF NOT EXISTS reconciliation_discrepancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  discrepancy_type text NOT NULL,
  severity text DEFAULT 'warning',
  vendor text,
  brand text,
  upc text,
  sku text,
  model_number text,
  invoice_id uuid REFERENCES vendor_invoices(id),
  invoice_number text,
  invoice_date date,
  po_number text,
  ordered_qty integer,
  invoiced_qty integer,
  received_qty integer,
  qty_delta integer,
  ordered_unit_price numeric(10,2),
  invoiced_unit_price numeric(10,2),
  price_delta numeric(10,2),
  ordered_line_total numeric(12,2),
  invoiced_line_total numeric(12,2),
  amount_at_risk numeric(12,2),
  resolution_status text DEFAULT 'open',
  resolved_by text,
  resolved_at timestamptz,
  resolution_notes text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE vendor_invoices
  ADD COLUMN IF NOT EXISTS recon_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS recon_run_id uuid,
  ADD COLUMN IF NOT EXISTS recon_notes text,
  ADD COLUMN IF NOT EXISTS has_discrepancy boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;

ALTER TABLE reconciliation_runs REPLICA IDENTITY FULL;
ALTER TABLE reconciliation_discrepancies REPLICA IDENTITY FULL;

ALTER TABLE reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_discrepancies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view reconciliation_runs" ON reconciliation_runs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert reconciliation_runs" ON reconciliation_runs FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can update reconciliation_runs" ON reconciliation_runs FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "Anyone can delete reconciliation_runs" ON reconciliation_runs FOR DELETE TO anon, authenticated USING (true);

CREATE POLICY "Anyone can view reconciliation_discrepancies" ON reconciliation_discrepancies FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert reconciliation_discrepancies" ON reconciliation_discrepancies FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can update reconciliation_discrepancies" ON reconciliation_discrepancies FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "Anyone can delete reconciliation_discrepancies" ON reconciliation_discrepancies FOR DELETE TO anon, authenticated USING (true);
