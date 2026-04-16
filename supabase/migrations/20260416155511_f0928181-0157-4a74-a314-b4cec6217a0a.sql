-- Delete the 3 phantom EOM 50/80/110 installments for invoice 5336060784
DELETE FROM public.invoice_payments
WHERE invoice_number = '5336060784'
  AND id IN (
    'f1a4e169-9eff-417b-9448-b886ae6b1285',
    'eca1b200-9e87-48ca-8a3b-022013bdd8a4',
    'a0ad198c-301e-4886-b803-3a4a247d9e8a'
  );

-- Insert the correct single Check 20 EoM payment
INSERT INTO public.invoice_payments (
  invoice_id, invoice_number, vendor, invoice_date, invoice_amount,
  amount_due, due_date, is_paid, terms, installment_label, payment_status, balance_remaining
)
VALUES (
  'c2342f11-cdad-475d-85b2-9b12ac49bef0',
  '5336060784',
  'Marcolin',
  '2026-03-18',
  320.10,
  320.10,
  '2026-04-20',
  false,
  'Check 20 EoM',
  NULL,
  'unpaid',
  320.10
);