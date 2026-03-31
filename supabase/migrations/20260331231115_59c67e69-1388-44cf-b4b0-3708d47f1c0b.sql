
-- Fix invoice 9115565122 (Maui Jim): replace incorrect 4-tranche schedule with single Net EOM payment due 3/31/2026
DELETE FROM invoice_payments WHERE invoice_id = '94589b89-1313-4c90-92d4-dd299a218831';

INSERT INTO invoice_payments (
  invoice_id, vendor, invoice_number, invoice_amount, invoice_date,
  terms, installment_label, due_date, amount_due, amount_paid, balance_remaining, payment_status
) VALUES (
  '94589b89-1313-4c90-92d4-dd299a218831', 'Maui Jim', '9115565122', 172.12, '2026-02-10',
  'Net EOM', NULL, '2026-03-31', 172.12, 0, 172.12, 'unpaid'
);
