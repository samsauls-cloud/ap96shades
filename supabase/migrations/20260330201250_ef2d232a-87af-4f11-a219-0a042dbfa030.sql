
-- Create vendor_alias_map table
CREATE TABLE IF NOT EXISTS public.vendor_alias_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id text NOT NULL,
  vendor_name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(vendor_id)
);

ALTER TABLE public.vendor_alias_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view vendor_alias_map" ON public.vendor_alias_map FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert vendor_alias_map" ON public.vendor_alias_map FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can update vendor_alias_map" ON public.vendor_alias_map FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "Anyone can delete vendor_alias_map" ON public.vendor_alias_map FOR DELETE TO anon, authenticated USING (true);
