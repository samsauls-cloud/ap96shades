WITH expanded AS (
  SELECT
    elem.ordinality AS ord,
    elem.value AS li,
    lower(regexp_replace(coalesce(elem.value->>'upc', ''), '[^a-zA-Z0-9]', '', 'g')) AS upc_key,
    lower(regexp_replace(coalesce(elem.value->>'item_number', elem.value->>'sku', elem.value->>'model', ''), '[^a-zA-Z0-9]', '', 'g')) AS item_key,
    lower(regexp_replace(coalesce(elem.value->>'color_code', elem.value->>'color_desc', ''), '[^a-zA-Z0-9]', '', 'g')) AS color_key,
    coalesce(elem.value->>'qty_shipped', elem.value->>'qty_ordered', elem.value->>'qty', '0') AS qty_key,
    to_char(coalesce((elem.value->>'unit_price')::numeric, 0), 'FM9999999990.00') AS price_key,
    to_char(coalesce((elem.value->>'line_total')::numeric, 0), 'FM9999999990.00') AS line_total_key
  FROM public.vendor_invoices vi
  CROSS JOIN LATERAL jsonb_array_elements(vi.line_items) WITH ORDINALITY AS elem(value, ordinality)
  WHERE vi.id = '3eec47c3-2ec5-4755-9d4a-35f99aa30f75'
),
deduped AS (
  SELECT DISTINCT ON (
    CASE
      WHEN upc_key <> '' THEN 'upc:' || upc_key
      ELSE 'item:' || item_key || '|color:' || color_key
    END,
    qty_key,
    price_key,
    line_total_key
  )
    ord,
    li
  FROM expanded
  ORDER BY
    CASE
      WHEN upc_key <> '' THEN 'upc:' || upc_key
      ELSE 'item:' || item_key || '|color:' || color_key
    END,
    qty_key,
    price_key,
    line_total_key,
    ord
),
repair AS (
  SELECT
    jsonb_agg(li ORDER BY ord) AS repaired_line_items,
    round(sum(coalesce((li->>'line_total')::numeric, 0)), 2) AS repaired_subtotal
  FROM deduped
)
UPDATE public.vendor_invoices vi
SET line_items = repair.repaired_line_items,
    subtotal = repair.repaired_subtotal,
    total = round(repair.repaired_subtotal + coalesce(vi.freight, 0) + coalesce(vi.tax, 0), 2),
    is_multi_shipment = false,
    shipment_count = 1,
    last_shipment_date = null,
    last_shipment_file = null,
    po_total_invoiced = round(repair.repaired_subtotal + coalesce(vi.freight, 0) + coalesce(vi.tax, 0), 2),
    has_discrepancy = false,
    recon_status = 'pending',
    recon_stale = true,
    recon_stale_reason = 'Invoice repaired after duplicate line merge from PDF reupload',
    recon_notes = 'Stale reconciliation rows cleared after duplicate-line repair; rerun reconciliation if needed.'
FROM repair
WHERE vi.id = '3eec47c3-2ec5-4755-9d4a-35f99aa30f75';

UPDATE public.invoice_payments ip
SET invoice_amount = 17012.36,
    amount_due = vals.amount_due,
    balance_remaining = GREATEST(vals.amount_due - coalesce(ip.amount_paid, 0), 0),
    payment_status = CASE
      WHEN coalesce(ip.amount_paid, 0) <= 0 THEN 'unpaid'
      WHEN coalesce(ip.amount_paid, 0) >= vals.amount_due THEN 'paid'
      ELSE 'partial'
    END,
    is_paid = coalesce(ip.amount_paid, 0) >= vals.amount_due,
    paid_date = CASE WHEN coalesce(ip.amount_paid, 0) >= vals.amount_due THEN ip.paid_date ELSE null END
FROM (
  VALUES
    ('1 of 3', 5670.78::numeric),
    ('2 of 3', 5670.78::numeric),
    ('3 of 3', 5670.80::numeric)
) AS vals(installment_label, amount_due)
WHERE ip.invoice_id = '3eec47c3-2ec5-4755-9d4a-35f99aa30f75'
  AND ip.installment_label = vals.installment_label;

UPDATE public.final_bill_ledger
SET original_invoice_total = 17012.36,
    final_bill_amount = 17012.36,
    final_balance_remaining = 17012.36
WHERE invoice_id = '3eec47c3-2ec5-4755-9d4a-35f99aa30f75'
   OR invoice_number = '6924315132';

DELETE FROM public.reconciliation_discrepancies
WHERE invoice_id = '3eec47c3-2ec5-4755-9d4a-35f99aa30f75'
   OR invoice_number = '6924315132';

INSERT INTO public.recon_stale_queue (triggered_by, entity_type, entity_id, vendor, prior_recon_run_id, status)
SELECT 'invoice_repaired', 'invoice', id, vendor, recon_run_id, 'pending'
FROM public.vendor_invoices
WHERE id = '3eec47c3-2ec5-4755-9d4a-35f99aa30f75';