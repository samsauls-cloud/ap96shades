CREATE TABLE public.saved_ledger_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  source_files text[] NOT NULL DEFAULT '{}',
  row_count integer NOT NULL DEFAULT 0,
  total_amount numeric NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  not_uploaded_count integer NOT NULL DEFAULT 0,
  credit_count integer NOT NULL DEFAULT 0,
  rows jsonb NOT NULL DEFAULT '[]'
);

ALTER TABLE public.saved_ledger_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view saved_ledger_checks" ON public.saved_ledger_checks FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can insert saved_ledger_checks" ON public.saved_ledger_checks FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can delete saved_ledger_checks" ON public.saved_ledger_checks FOR DELETE TO anon, authenticated USING (true);