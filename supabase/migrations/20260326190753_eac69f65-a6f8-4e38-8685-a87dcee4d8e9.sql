
CREATE TABLE public.master_assortment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id text,
  vendor text,
  brand text,
  upc text,
  assortment text,
  go_out_location text,
  backstock_location text,
  title text,
  model text,
  color text,
  size text,
  rxable text,
  wholesale numeric,
  online_price numeric,
  msrp numeric,
  default_price numeric,
  price_rule numeric,
  polarized text,
  lens_height text,
  bridge_size text,
  temple_length text,
  image_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_master_assortment_upc ON public.master_assortment(upc);
CREATE INDEX idx_master_assortment_model ON public.master_assortment(model);
CREATE INDEX idx_master_assortment_brand ON public.master_assortment(brand);
CREATE INDEX idx_master_assortment_assortment ON public.master_assortment(assortment);

ALTER TABLE public.master_assortment ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view master_assortment" ON public.master_assortment FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert master_assortment" ON public.master_assortment FOR INSERT TO anon, authenticated WITH CHECK (true);
