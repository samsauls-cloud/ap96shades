CREATE TABLE public.recalc_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  invoice_id uuid,
  invoice_number text,
  vendor text,
  action text NOT NULL,
  old_values jsonb DEFAULT '[]'::jsonb,
  new_values jsonb DEFAULT '[]'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  performed_by text DEFAULT 'system'
);

ALTER TABLE public.recalc_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view recalc_audit_log"
  ON public.recalc_audit_log FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Anyone can insert recalc_audit_log"
  ON public.recalc_audit_log FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);