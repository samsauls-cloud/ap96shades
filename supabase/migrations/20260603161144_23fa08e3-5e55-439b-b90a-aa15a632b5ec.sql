
ALTER TABLE public.vendor_credits DROP CONSTRAINT IF EXISTS vendor_credits_source_type_check;
ALTER TABLE public.vendor_credits ADD CONSTRAINT vendor_credits_source_type_check
  CHECK (source_type IN (
    'remittance_overpay',
    'invoice_application',
    'manual_adjustment',
    'reversal',
    'returned_ra',
    'other'
  ));
ALTER TABLE public.vendor_credits ALTER COLUMN description DROP NOT NULL;
