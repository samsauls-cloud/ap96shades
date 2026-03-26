-- Allow anonymous read access for the AP tracker (no auth required)
CREATE POLICY "Anyone can view invoices" ON public.vendor_invoices FOR SELECT TO anon USING (true);

-- Allow anonymous updates for status changes
CREATE POLICY "Anyone can update invoices" ON public.vendor_invoices FOR UPDATE TO anon USING (true);

-- Allow anonymous inserts
CREATE POLICY "Anyone can insert invoices" ON public.vendor_invoices FOR INSERT TO anon WITH CHECK (true);