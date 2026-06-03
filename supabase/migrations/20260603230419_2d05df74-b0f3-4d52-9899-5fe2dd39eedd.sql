DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.vendor_credits WHERE reference = 'Wire 7300058507') THEN
    RAISE EXCEPTION 'Luxottica Wire 7300058507 credit already booked — aborting to prevent double-booking.';
  END IF;
END $$;

INSERT INTO public.vendor_credits
  (vendor, amount, source_type, reference, occurred_on, description, created_by)
VALUES
  ('Luxottica', 23961.64, 'remittance_overpay', 'Wire 7300058507', '2026-05-18',
   '$65,000.00 wire 5/18/26; $41,038.36 applied across 33 invoices per Lux payment application doc 7300058507; surplus held on-account.',
   'Staff'),
  ('Luxottica', 56.98, 'manual_adjustment', 'Wire 7300058507', '2026-05-18',
   'Prior CA-on-Acc credit rolled into the 5/18/26 payment application; brings on-account balance to $24,018.62 per Lux statement.',
   'Staff');