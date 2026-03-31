UPDATE vendor_invoices vi
SET due_date = sub.min_due
FROM (
  SELECT ip.invoice_id, MIN(ip.due_date) AS min_due
  FROM invoice_payments ip
  WHERE ip.invoice_id IS NOT NULL
  GROUP BY ip.invoice_id
) sub
WHERE vi.id = sub.invoice_id
  AND vi.due_date IS NULL;