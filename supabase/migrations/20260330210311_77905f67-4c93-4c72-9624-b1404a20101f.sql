
-- Add match columns to vendor_invoices
ALTER TABLE public.vendor_invoices 
  ADD COLUMN IF NOT EXISTS match_status text NOT NULL DEFAULT 'unmatched',
  ADD COLUMN IF NOT EXISTS matched_session_ids uuid[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS match_confidence text,
  ADD COLUMN IF NOT EXISTS match_notes text;

-- Add match columns to lightspeed_receiving
ALTER TABLE public.lightspeed_receiving 
  ADD COLUMN IF NOT EXISTS invoice_match_status text NOT NULL DEFAULT 'unmatched',
  ADD COLUMN IF NOT EXISTS matched_invoice_id uuid;

-- Backfill vendor_invoices that already have reconciled_session_id
UPDATE public.vendor_invoices 
SET match_status = 'matched',
    matched_session_ids = ARRAY[reconciled_session_id],
    match_confidence = 'legacy',
    match_notes = 'Pre-existing reconciliation link'
WHERE reconciled_session_id IS NOT NULL 
  AND match_status = 'unmatched';

-- Backfill lightspeed_receiving that have session_id linked to a reconciled invoice
UPDATE public.lightspeed_receiving lr
SET invoice_match_status = 'matched',
    matched_invoice_id = prs.reconciled_invoice_id
FROM po_receiving_sessions prs
WHERE lr.session_id = prs.id
  AND prs.reconciled_invoice_id IS NOT NULL
  AND lr.invoice_match_status = 'unmatched';
