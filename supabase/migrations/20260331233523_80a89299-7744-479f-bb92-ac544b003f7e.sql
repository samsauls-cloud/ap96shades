-- Delete old 3-tranche payments for Marcolin 5336045263
DELETE FROM invoice_payments WHERE invoice_number = '5336045263' AND vendor = 'Marcolin';

-- Insert correct single payment: EOM of Feb (2/28) + 20 = 3/20
INSERT INTO invoice_payments (invoice_id, vendor, invoice_number, invoice_amount, invoice_date, terms, installment_label, due_date, amount_due, amount_paid, balance_remaining, payment_status)
VALUES (
  '666a0fd8-cb85-4337-b6e8-d82a1a63a90f',
  'Marcolin', '5336045263', 160.05, '2026-02-18',
  'Check 20 days EoM', NULL, '2026-03-20', 160.05, 0, 160.05, 'unpaid'
);

-- Update vendor_invoices.due_date
UPDATE vendor_invoices SET due_date = '2026-03-20' WHERE id = '666a0fd8-cb85-4337-b6e8-d82a1a63a90f';