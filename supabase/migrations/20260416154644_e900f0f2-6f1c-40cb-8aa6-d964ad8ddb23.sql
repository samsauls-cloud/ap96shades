
-- Layer 4: Add audit columns to vendor_invoices
ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS extracted_terms_preset text,
  ADD COLUMN IF NOT EXISTS extracted_terms_confidence text,
  ADD COLUMN IF NOT EXISTS extracted_terms_source_text text,
  ADD COLUMN IF NOT EXISTS final_terms_preset text;

-- Layer 1: Add both Marcolin term presets to vendor_terms_config
-- Check 20 EoM (single payment)
INSERT INTO public.vendor_terms_config (vendor_name, vendor_match_strings, terms_type, offsets, eom_based, eom_baseline_offset, due_offset, description, is_active)
VALUES (
  'Marcolin - Check 20 EoM',
  ARRAY['marcolin', 'tom ford', 'guess', 'swarovski', 'montblanc'],
  'eom_single',
  ARRAY[20],
  true,
  0,
  20,
  'Check 20 EoM — Single payment due EOM + 20 days',
  true
)
ON CONFLICT DO NOTHING;

-- EOM 50/80/110 (three installments)
INSERT INTO public.vendor_terms_config (vendor_name, vendor_match_strings, terms_type, offsets, eom_based, eom_baseline_offset, due_offset, description, is_active)
VALUES (
  'Marcolin - EOM 50/80/110',
  ARRAY['marcolin', 'tom ford', 'guess', 'swarovski', 'montblanc'],
  'eom_split',
  ARRAY[50, 80, 110],
  true,
  0,
  null,
  'EOM 50/80/110 — 3 equal tranches',
  true
)
ON CONFLICT DO NOTHING;
