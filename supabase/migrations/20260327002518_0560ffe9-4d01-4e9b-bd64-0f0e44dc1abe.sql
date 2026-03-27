
-- po_receiving_sessions
CREATE TABLE public.po_receiving_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  session_name text NOT NULL,
  vendor text NOT NULL,
  lightspeed_export_type text,
  raw_filename text,
  total_lines int DEFAULT 0,
  fully_received int DEFAULT 0,
  partially_received int DEFAULT 0,
  not_received int DEFAULT 0,
  total_ordered_qty int DEFAULT 0,
  total_received_qty int DEFAULT 0,
  total_ordered_cost numeric DEFAULT 0,
  total_received_cost numeric DEFAULT 0,
  notes text,
  reconciled_invoice_id uuid REFERENCES public.vendor_invoices(id),
  reconciliation_status text NOT NULL DEFAULT 'unreconciled'
);

ALTER TABLE public.po_receiving_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view receiving sessions" ON public.po_receiving_sessions FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert receiving sessions" ON public.po_receiving_sessions FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can update receiving sessions" ON public.po_receiving_sessions FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "Anyone can delete receiving sessions" ON public.po_receiving_sessions FOR DELETE TO anon, authenticated USING (true);

-- po_receiving_lines
CREATE TABLE public.po_receiving_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.po_receiving_sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  system_id text,
  upc text,
  ean text,
  custom_sku text,
  manufact_sku text,
  item_description text,
  vendor_id text,
  order_qty int DEFAULT 0,
  received_qty int,
  not_received_qty int DEFAULT 0,
  unit_cost numeric DEFAULT 0,
  retail_price numeric DEFAULT 0,
  unit_discount numeric DEFAULT 0,
  unit_shipping numeric DEFAULT 0,
  received_cost numeric DEFAULT 0,
  ordered_cost numeric DEFAULT 0,
  lightspeed_status text,
  receiving_status text DEFAULT 'NO_RECEIVING_DATA',
  matched_invoice_line jsonb,
  match_status text,
  billing_discrepancy boolean DEFAULT false,
  discrepancy_type text,
  discrepancy_amount numeric DEFAULT 0,
  notes text
);

ALTER TABLE public.po_receiving_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view receiving lines" ON public.po_receiving_lines FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert receiving lines" ON public.po_receiving_lines FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can update receiving lines" ON public.po_receiving_lines FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "Anyone can delete receiving lines" ON public.po_receiving_lines FOR DELETE TO anon, authenticated USING (true);
