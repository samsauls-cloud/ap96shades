
-- Add match columns to po_receiving_lines (where the actual data lives)
ALTER TABLE public.po_receiving_lines 
  ADD COLUMN IF NOT EXISTS invoice_match_status text NOT NULL DEFAULT 'unmatched',
  ADD COLUMN IF NOT EXISTS matched_invoice_id uuid;

-- Backfill po_receiving_lines that have session linked to reconciled invoice
UPDATE public.po_receiving_lines prl
SET invoice_match_status = 'matched',
    matched_invoice_id = prs.reconciled_invoice_id
FROM po_receiving_sessions prs
WHERE prl.session_id = prs.id
  AND prs.reconciled_invoice_id IS NOT NULL
  AND prl.invoice_match_status = 'unmatched';
