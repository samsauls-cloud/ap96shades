-- Onboarding flags table (no user accounts in this app; keyed by flag name only).
CREATE TABLE IF NOT EXISTS public.onboarding_flags (
  flag_key text PRIMARY KEY,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  dismissed_by text NOT NULL DEFAULT 'Staff'
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.onboarding_flags TO anon, authenticated;
GRANT ALL ON public.onboarding_flags TO service_role;

ALTER TABLE public.onboarding_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "onboarding_flags readable by all"
  ON public.onboarding_flags FOR SELECT
  USING (true);

CREATE POLICY "onboarding_flags writable by all"
  ON public.onboarding_flags FOR INSERT
  WITH CHECK (true);

CREATE POLICY "onboarding_flags updatable by all"
  ON public.onboarding_flags FOR UPDATE
  USING (true) WITH CHECK (true);

CREATE POLICY "onboarding_flags deletable by all"
  ON public.onboarding_flags FOR DELETE
  USING (true);