
-- Create lightspeed_receiving table
CREATE TABLE public.lightspeed_receiving (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  upc TEXT,
  manufact_sku TEXT,
  received_qty INTEGER DEFAULT 0,
  not_received_qty INTEGER DEFAULT 0,
  unit_cost NUMERIC DEFAULT 0,
  vendor_id TEXT,
  item_description TEXT,
  receiving_status TEXT DEFAULT 'pending',
  session_id UUID,
  po_number TEXT
);

-- Create inventory_snapshots table
CREATE TABLE public.inventory_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  upc TEXT,
  quantity_on_hand INTEGER DEFAULT 0,
  store_id TEXT,
  snapshot_date DATE DEFAULT CURRENT_DATE,
  brand TEXT,
  model_number TEXT,
  item_description TEXT
);

-- Enable RLS on both tables
ALTER TABLE public.lightspeed_receiving ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS policies for lightspeed_receiving
CREATE POLICY "Anyone can view lightspeed_receiving" ON public.lightspeed_receiving FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert lightspeed_receiving" ON public.lightspeed_receiving FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can update lightspeed_receiving" ON public.lightspeed_receiving FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "Anyone can delete lightspeed_receiving" ON public.lightspeed_receiving FOR DELETE TO anon, authenticated USING (true);

-- RLS policies for inventory_snapshots
CREATE POLICY "Anyone can view inventory_snapshots" ON public.inventory_snapshots FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert inventory_snapshots" ON public.inventory_snapshots FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can update inventory_snapshots" ON public.inventory_snapshots FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "Anyone can delete inventory_snapshots" ON public.inventory_snapshots FOR DELETE TO anon, authenticated USING (true);

-- Indexes for fast lookups
CREATE INDEX idx_lightspeed_receiving_upc ON public.lightspeed_receiving(upc);
CREATE INDEX idx_lightspeed_receiving_manufact_sku ON public.lightspeed_receiving(manufact_sku);
CREATE INDEX idx_inventory_snapshots_upc ON public.inventory_snapshots(upc);
