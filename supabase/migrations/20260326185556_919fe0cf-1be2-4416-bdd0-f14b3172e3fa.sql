
-- item_master table
CREATE TABLE public.item_master (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upc text,
  brand text,
  model_number text,
  article_name text,
  wholesale_price numeric,
  retail_price numeric,
  gender text,
  frame_shape text,
  size text,
  color text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- current_planogram table
CREATE TABLE public.current_planogram (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upc text,
  brand text,
  model_number text,
  is_vendor_discontinued boolean DEFAULT false,
  is_discontinued boolean DEFAULT false,
  frame_source text,
  go_out_location text,
  backstock_location text,
  brand_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_item_master_upc ON public.item_master(upc);
CREATE INDEX idx_item_master_model ON public.item_master(model_number);
CREATE INDEX idx_planogram_upc ON public.current_planogram(upc);
CREATE INDEX idx_planogram_model ON public.current_planogram(model_number);

-- RLS
ALTER TABLE public.item_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.current_planogram ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view item_master" ON public.item_master FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert item_master" ON public.item_master FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can view planogram" ON public.current_planogram FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert planogram" ON public.current_planogram FOR INSERT TO anon, authenticated WITH CHECK (true);
