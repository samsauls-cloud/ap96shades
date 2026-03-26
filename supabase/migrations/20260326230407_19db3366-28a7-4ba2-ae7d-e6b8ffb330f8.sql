ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS amount_paid numeric DEFAULT 0;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS check_number text;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS payment_reference text;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS payment_history jsonb DEFAULT '[]';
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS balance_remaining numeric;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid';
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS dispute_reason text;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS void_reason text;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS last_payment_date date;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS recorded_by text;

-- Initialize balance_remaining for all existing rows
UPDATE invoice_payments SET balance_remaining = amount_due - COALESCE(amount_paid, 0) WHERE balance_remaining IS NULL;

-- Set payment_status for already-paid rows
UPDATE invoice_payments SET payment_status = 'paid', amount_paid = amount_due, balance_remaining = 0 WHERE is_paid = true AND payment_status = 'unpaid';