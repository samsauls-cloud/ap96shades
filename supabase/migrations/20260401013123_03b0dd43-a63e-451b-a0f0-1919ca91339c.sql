
-- Fix payment installments for Luxottica invoice 6924315132
-- Current installments based on wrong subtotal ($16,942.64), should be based on total ($33,955.00)
-- EOM 30/60/90 split: $33,955.00 / 3 = $11,318.33, $11,318.33, $11,318.34

UPDATE invoice_payments
SET amount_due = 11318.33,
    balance_remaining = 11318.33,
    invoice_amount = 33955.00
WHERE invoice_id = '3eec47c3-2ec5-4755-9d4a-35f99aa30f75'
  AND installment_label = '1 of 3';

UPDATE invoice_payments
SET amount_due = 11318.33,
    balance_remaining = 11318.33,
    invoice_amount = 33955.00
WHERE invoice_id = '3eec47c3-2ec5-4755-9d4a-35f99aa30f75'
  AND installment_label = '2 of 3';

UPDATE invoice_payments
SET amount_due = 11318.34,
    balance_remaining = 11318.34,
    invoice_amount = 33955.00
WHERE invoice_id = '3eec47c3-2ec5-4755-9d4a-35f99aa30f75'
  AND installment_label = '3 of 3';
