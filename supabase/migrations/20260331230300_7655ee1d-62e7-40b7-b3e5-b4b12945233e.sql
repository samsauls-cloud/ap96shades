-- Create the storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'invoice-pdfs',
  'invoice-pdfs',
  false,
  52428800,
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Allow anon and authenticated users to upload, read, and delete
CREATE POLICY "Anyone can upload invoice PDFs"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'invoice-pdfs');

CREATE POLICY "Anyone can read invoice PDFs"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'invoice-pdfs');

CREATE POLICY "Anyone can delete invoice PDFs"
ON storage.objects FOR DELETE
TO anon, authenticated
USING (bucket_id = 'invoice-pdfs');

-- Add pdf_url column to vendor_invoices
ALTER TABLE public.vendor_invoices
ADD COLUMN IF NOT EXISTS pdf_url TEXT;

COMMENT ON COLUMN public.vendor_invoices.pdf_url IS
'Supabase Storage URL for the original uploaded PDF';