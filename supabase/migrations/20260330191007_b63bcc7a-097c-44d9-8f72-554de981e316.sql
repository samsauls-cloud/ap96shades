
-- Add terms_status and terms_confidence columns to vendor_invoices
ALTER TABLE public.vendor_invoices 
  ADD COLUMN IF NOT EXISTS terms_status text NOT NULL DEFAULT 'needs_review',
  ADD COLUMN IF NOT EXISTS terms_confidence text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS payment_terms_extracted jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS payment_terms_source text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shipping_terms text DEFAULT NULL;

-- Backfill: proformas get terms_status='proforma'
UPDATE public.vendor_invoices 
SET terms_status = 'proforma' 
WHERE lower(doc_type) IN ('proforma', 'pro-forma', 'pro forma');

-- Backfill: invoices that already have payment rows → confirmed
UPDATE public.vendor_invoices vi
SET terms_status = 'confirmed', terms_confidence = 'high'
WHERE EXISTS (
  SELECT 1 FROM public.invoice_payments ip WHERE ip.invoice_id = vi.id
)
AND vi.terms_status != 'proforma';

-- Update get_invoice_stats to also return needs_review count/value
CREATE OR REPLACE FUNCTION public.get_invoice_stats(
  p_vendor text DEFAULT NULL,
  p_doc_type text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_tag text DEFAULT NULL,
  p_min_total numeric DEFAULT NULL,
  p_max_total numeric DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  result json;
  unpaid numeric;
  needs_review_count integer;
  needs_review_value numeric;
BEGIN
  SELECT json_build_object(
    'total_documents', COUNT(*),
    'total_invoices', COUNT(*) FILTER (WHERE doc_type = 'INVOICE' OR doc_type = 'Invoice'),
    'total_pos', COUNT(*) FILTER (WHERE doc_type = 'PO'),
    'total_ap_value', COALESCE(SUM(total) FILTER (WHERE doc_type NOT IN ('proforma', 'Proforma', 'PRO FORMA', 'pro-forma') AND terms_status = 'confirmed'), 0),
    'total_units', COALESCE(SUM(
      (SELECT SUM(
        CASE
          WHEN item->>'qty_shipped' ~ '^\d+\.?\d*$' THEN (item->>'qty_shipped')::numeric
          WHEN item->>'qty_ordered' ~ '^\d+\.?\d*$' THEN (item->>'qty_ordered')::numeric
          WHEN item->>'qty' ~ '^\d+\.?\d*$' THEN (item->>'qty')::numeric
          ELSE 0
        END
      ) FROM jsonb_array_elements(line_items) AS item)
    ), 0)
  ) INTO result
  FROM vendor_invoices
  WHERE (p_vendor IS NULL OR vendor = p_vendor)
    AND (p_doc_type IS NULL OR doc_type = p_doc_type)
    AND (p_status IS NULL OR status = p_status)
    AND (p_date_from IS NULL OR invoice_date >= p_date_from)
    AND (p_date_to IS NULL OR invoice_date <= p_date_to)
    AND (p_min_total IS NULL OR total >= p_min_total)
    AND (p_max_total IS NULL OR total <= p_max_total)
    AND (p_search IS NULL OR (
      invoice_number ILIKE '%' || p_search || '%'
      OR po_number ILIKE '%' || p_search || '%'
      OR account_number ILIKE '%' || p_search || '%'
      OR vendor ILIKE '%' || p_search || '%'
      OR notes ILIKE '%' || p_search || '%'
      OR filename ILIKE '%' || p_search || '%'
    ))
    AND (p_tag IS NULL OR tags @> ARRAY[p_tag]);

  -- Unpaid balance (only from confirmed-terms invoices)
  SELECT COALESCE(SUM(ip.balance_remaining), 0) INTO unpaid
  FROM invoice_payments ip
  INNER JOIN vendor_invoices vi ON ip.invoice_id = vi.id
  WHERE ip.payment_status NOT IN ('paid', 'void')
    AND vi.doc_type NOT IN ('proforma', 'Proforma', 'PRO FORMA', 'pro-forma')
    AND vi.terms_status = 'confirmed'
    AND (p_vendor IS NULL OR vi.vendor = p_vendor)
    AND (p_doc_type IS NULL OR vi.doc_type = p_doc_type)
    AND (p_status IS NULL OR vi.status = p_status)
    AND (p_date_from IS NULL OR vi.invoice_date >= p_date_from)
    AND (p_date_to IS NULL OR vi.invoice_date <= p_date_to)
    AND (p_min_total IS NULL OR vi.total >= p_min_total)
    AND (p_max_total IS NULL OR vi.total <= p_max_total)
    AND (p_search IS NULL OR (
      vi.invoice_number ILIKE '%' || p_search || '%'
      OR vi.po_number ILIKE '%' || p_search || '%'
      OR vi.account_number ILIKE '%' || p_search || '%'
      OR vi.vendor ILIKE '%' || p_search || '%'
      OR vi.notes ILIKE '%' || p_search || '%'
      OR vi.filename ILIKE '%' || p_search || '%'
    ))
    AND (p_tag IS NULL OR vi.tags @> ARRAY[p_tag]);

  -- Needs review stats
  SELECT COUNT(*), COALESCE(SUM(total), 0)
  INTO needs_review_count, needs_review_value
  FROM vendor_invoices
  WHERE terms_status = 'needs_review'
    AND doc_type NOT IN ('proforma', 'Proforma', 'PRO FORMA', 'pro-forma')
    AND (p_vendor IS NULL OR vendor = p_vendor)
    AND (p_doc_type IS NULL OR doc_type = p_doc_type)
    AND (p_status IS NULL OR status = p_status)
    AND (p_date_from IS NULL OR invoice_date >= p_date_from)
    AND (p_date_to IS NULL OR invoice_date <= p_date_to)
    AND (p_min_total IS NULL OR total >= p_min_total)
    AND (p_max_total IS NULL OR total <= p_max_total)
    AND (p_search IS NULL OR (
      invoice_number ILIKE '%' || p_search || '%'
      OR po_number ILIKE '%' || p_search || '%'
      OR account_number ILIKE '%' || p_search || '%'
      OR vendor ILIKE '%' || p_search || '%'
      OR notes ILIKE '%' || p_search || '%'
      OR filename ILIKE '%' || p_search || '%'
    ))
    AND (p_tag IS NULL OR tags @> ARRAY[p_tag]);

  result := json_build_object(
    'total_documents', (result->>'total_documents')::numeric,
    'total_invoices', (result->>'total_invoices')::numeric,
    'total_pos', (result->>'total_pos')::numeric,
    'total_ap_value', (result->>'total_ap_value')::numeric,
    'total_units', (result->>'total_units')::numeric,
    'unpaid_balance', unpaid,
    'needs_review_count', needs_review_count,
    'needs_review_value', needs_review_value
  );

  RETURN result;
END;
$$;
