CREATE OR REPLACE FUNCTION public.get_invoice_stats(p_vendor text DEFAULT NULL::text, p_doc_type text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_search text DEFAULT NULL::text, p_tag text DEFAULT NULL::text, p_min_total numeric DEFAULT NULL::numeric, p_max_total numeric DEFAULT NULL::numeric)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  result json;
  unpaid numeric;
BEGIN
  SELECT json_build_object(
    'total_documents', COUNT(*),
    'total_invoices', COUNT(*) FILTER (WHERE doc_type = 'INVOICE' OR doc_type = 'Invoice'),
    'total_pos', COUNT(*) FILTER (WHERE doc_type = 'PO'),
    'total_ap_value', COALESCE(SUM(total) FILTER (WHERE doc_type NOT IN ('proforma', 'Proforma', 'PRO FORMA', 'pro-forma')), 0),
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

  SELECT COALESCE(SUM(ip.balance_remaining), 0) INTO unpaid
  FROM invoice_payments ip
  INNER JOIN vendor_invoices vi ON ip.invoice_id = vi.id
  WHERE ip.payment_status NOT IN ('paid', 'void')
    AND vi.doc_type NOT IN ('proforma', 'Proforma', 'PRO FORMA', 'pro-forma')
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

  result := json_build_object(
    'total_documents', (result->>'total_documents')::numeric,
    'total_invoices', (result->>'total_invoices')::numeric,
    'total_pos', (result->>'total_pos')::numeric,
    'total_ap_value', (result->>'total_ap_value')::numeric,
    'total_units', (result->>'total_units')::numeric,
    'unpaid_balance', unpaid
  );

  RETURN result;
END;
$function$;