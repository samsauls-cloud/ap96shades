CREATE TABLE public.data_health_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  severity text NOT NULL DEFAULT 'ok',
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text
);

GRANT SELECT, INSERT ON public.data_health_runs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.data_health_runs TO authenticated;
GRANT ALL ON public.data_health_runs TO service_role;

ALTER TABLE public.data_health_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view data_health_runs"
  ON public.data_health_runs FOR SELECT
  USING (true);

CREATE POLICY "Anyone can insert data_health_runs"
  ON public.data_health_runs FOR INSERT
  WITH CHECK (true);

CREATE INDEX idx_data_health_runs_ran_at ON public.data_health_runs (ran_at DESC);