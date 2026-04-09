-- Delete payment installments for the two broken Luxottica invoices
DELETE FROM invoice_payments 
WHERE invoice_id IN ('b6ea569e-a722-4019-88e5-f31c83b74041', '8ba7fb78-ee95-43d9-9417-be6e870b622b');

-- Delete the invoices themselves so they can be re-imported with correct schedules
DELETE FROM vendor_invoices 
WHERE id IN ('b6ea569e-a722-4019-88e5-f31c83b74041', '8ba7fb78-ee95-43d9-9417-be6e870b622b');