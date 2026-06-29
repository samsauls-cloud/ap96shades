
CREATE TABLE IF NOT EXISTS public.delivery_backfill_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'running',
  invoice_ids text[] NOT NULL DEFAULT '{}',
  remaining_ids text[] NOT NULL DEFAULT '{}',
  processed_count int NOT NULL DEFAULT 0,
  saved_count int NOT NULL DEFAULT 0,
  failure_count int NOT NULL DEFAULT 0,
  null_count int NOT NULL DEFAULT 0,
  failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_remaining int,
  last_progress_at timestamptz NOT NULL DEFAULT now(),
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.delivery_backfill_jobs TO authenticated;
GRANT SELECT ON public.delivery_backfill_jobs TO anon;
GRANT ALL ON public.delivery_backfill_jobs TO service_role;

ALTER TABLE public.delivery_backfill_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read backfill jobs" ON public.delivery_backfill_jobs FOR SELECT USING (true);
CREATE POLICY "Anyone can create backfill jobs" ON public.delivery_backfill_jobs FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update backfill jobs" ON public.delivery_backfill_jobs FOR UPDATE USING (true);
