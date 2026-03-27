-- Add late-entry & stale recon columns to vendor_invoices
ALTER TABLE vendor_invoices
  ADD COLUMN IF NOT EXISTS entered_after_recon boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS recon_stale boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS recon_stale_reason text,
  ADD COLUMN IF NOT EXISTS import_source text DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS lightspeed_po_number text,
  ADD COLUMN IF NOT EXISTS received_date date,
  ADD COLUMN IF NOT EXISTS invoice_received_at timestamptz DEFAULT now();

-- Add run_type and scope columns to reconciliation_runs
ALTER TABLE reconciliation_runs
  ADD COLUMN IF NOT EXISTS run_type text DEFAULT 'full',
  ADD COLUMN IF NOT EXISTS scope_description text;

-- Create recon_stale_queue table
CREATE TABLE IF NOT EXISTS recon_stale_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  upc text,
  vendor text,
  brand text,
  prior_recon_run_id uuid REFERENCES reconciliation_runs(id),
  queued_at timestamptz DEFAULT now(),
  processed_at timestamptz,
  status text DEFAULT 'pending'
);

ALTER TABLE recon_stale_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view recon_stale_queue" ON recon_stale_queue FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert recon_stale_queue" ON recon_stale_queue FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can update recon_stale_queue" ON recon_stale_queue FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "Anyone can delete recon_stale_queue" ON recon_stale_queue FOR DELETE TO anon, authenticated USING (true);

ALTER TABLE recon_stale_queue REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.recon_stale_queue;