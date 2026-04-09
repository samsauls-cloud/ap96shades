CREATE TABLE public.vendor_terms_config (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  vendor_name text NOT NULL,
  terms_type text NOT NULL DEFAULT 'unknown',
  offsets integer[] NOT NULL DEFAULT '{}',
  eom_based boolean NOT NULL DEFAULT false,
  eom_baseline_offset integer DEFAULT 0,
  due_offset integer DEFAULT NULL,
  description text NOT NULL DEFAULT '',
  vendor_match_strings text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.vendor_terms_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view vendor_terms_config"
ON public.vendor_terms_config FOR SELECT
TO anon, authenticated
USING (true);

CREATE POLICY "Anyone can insert vendor_terms_config"
ON public.vendor_terms_config FOR INSERT
TO anon, authenticated
WITH CHECK (true);

CREATE POLICY "Anyone can update vendor_terms_config"
ON public.vendor_terms_config FOR UPDATE
TO anon, authenticated
USING (true);

CREATE POLICY "Anyone can delete vendor_terms_config"
ON public.vendor_terms_config FOR DELETE
TO anon, authenticated
USING (true);