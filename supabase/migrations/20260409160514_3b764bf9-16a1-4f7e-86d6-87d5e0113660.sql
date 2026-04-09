
-- 1. vendor_definitions
CREATE TABLE public.vendor_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_name text NOT NULL,
  vendor_key text NOT NULL UNIQUE,
  customer_number text,
  remit_to_address text,
  default_currency text NOT NULL DEFAULT 'USD',
  created_by text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vendor_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view vendor_definitions" ON public.vendor_definitions FOR SELECT USING (true);
CREATE POLICY "Anyone can insert vendor_definitions" ON public.vendor_definitions FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update vendor_definitions" ON public.vendor_definitions FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete vendor_definitions" ON public.vendor_definitions FOR DELETE USING (true);

-- 2. vendor_term_definitions
CREATE TABLE public.vendor_term_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendor_definitions(id) ON DELETE CASCADE,
  term_label text,
  term_type text NOT NULL DEFAULT 'unknown',
  payment_count integer NOT NULL DEFAULT 1,
  offset_type text NOT NULL DEFAULT 'from_invoice_date',
  day_intervals integer[] NOT NULL DEFAULT '{}'::integer[],
  is_default boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vendor_term_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view vendor_term_definitions" ON public.vendor_term_definitions FOR SELECT USING (true);
CREATE POLICY "Anyone can insert vendor_term_definitions" ON public.vendor_term_definitions FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update vendor_term_definitions" ON public.vendor_term_definitions FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete vendor_term_definitions" ON public.vendor_term_definitions FOR DELETE USING (true);

-- 3. vendor_field_mappings
CREATE TABLE public.vendor_field_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendor_definitions(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  source_note text,
  confirmed_by text,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vendor_field_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view vendor_field_mappings" ON public.vendor_field_mappings FOR SELECT USING (true);
CREATE POLICY "Anyone can insert vendor_field_mappings" ON public.vendor_field_mappings FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update vendor_field_mappings" ON public.vendor_field_mappings FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete vendor_field_mappings" ON public.vendor_field_mappings FOR DELETE USING (true);
