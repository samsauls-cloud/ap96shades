import { supabase } from "@/integrations/supabase/client";
import type { VendorInvoiceInsert } from "@/lib/supabase-queries";
import { normalizeVendor } from "@/lib/invoice-dedup";
import { applyVendorDiscount } from "@/lib/vendor-pricing-rules";

const SYSTEM_PROMPT = `You are a document data extractor for an optical retail business (NinetySix Shades). Extract data from vendor invoices AND purchase orders from: Maui Jim, Kering (Gucci, Saint Laurent, Balenciaga, Bottega Veneta, Alexander McQueen), Safilo (Carrera, Fossil, Hugo Boss, Jimmy Choo), Marcolin (Tom Ford, Guess, Swarovski, Montblanc), Luxottica (Ray-Ban, Oakley, Prada, Versace, Persol, Coach, DKNY, Dolce & Gabbana, Emporio Armani, Giorgio Armani, Burberry, Michael Kors, Tiffany, Vogue), Marchon (Nike, Columbia, Dragon, Flexon, Calvin Klein, Donna Karan, Lacoste, Salvatore Ferragamo, MCM, Nautica, Nine West, Skaga). Luxottica POs use fields: Order Number, Account Number, Carrier, Terms, Item Number, Color Code, Temple, Quantity Ordered, Quantity Shipped, Unit Cost, Extended Cost. Detect INVOICE vs PO. IMPORTANT: If this document contains any of these phrases — "pro forma", "proforma", "not an invoice", "invoice to follow", "for reference only", "preliminary", "THIS IS NOT AN INVOICE", "for reference purposes only" — set doc_type to "proforma". Do NOT set it to "INVOICE". A proforma is NOT a payable document.

PAYMENT TERMS EXTRACTION — CRITICAL:
Carefully read the entire invoice for payment terms. They may appear in the header, footer, terms section, or anywhere on the document. Any term type can appear on any vendor's invoice — do NOT assume based on vendor name.

Extract payment_terms_extracted as a structured object:
- type: "net_single" (Net 30, Net 60, N30, Due on Receipt), "eom_single" (EOM 30, EOM 60), "eom_split" (EOM 30/60/90), "net_split" (Days 30/60/90), "early_pay" (2/10 Net 30), "cod" (COD, Cash on Delivery), or "unknown"
- days: array of day offsets, e.g. [30,60,90]
- installments: number of payments
- eom_based: true if end-of-month based
- discount_pct: discount percentage for early_pay (null otherwise)
- discount_days: days for discount (null otherwise)
- net_days: net days for early_pay (null otherwise)
- confidence: "high" (explicit term text found), "medium" (implied from due date), "low" (nothing found or only FOB)
- raw_text: exact text copied from invoice
- shipping_terms: "FOB" if FOB found (FOB is NOT a payment term)
- extraction_notes: where on document terms were found

IMPORTANT: FOB is a SHIPPING term, not a payment term. If FOB is the ONLY term-like text, set payment_terms to null and shipping_terms to "FOB".

LUXOTTICA PAYMENT TERMS — CRITICAL KNOWLEDGE:
Luxottica invoices use a unique EOM-based split payment system. When you see terms like "30/60/90", "EOM 30/60/90", or references to tranches on a Luxottica invoice:
- The baseline date is always the last day of the invoice month (end of month)
- Payment is split into three equal tranches (1/3 each)
- Tranche 1 due: baseline + 30 days
- Tranche 2 due: baseline + 60 days
- Tranche 3 due: baseline + 90 days
Set payment_terms_extracted.type to "eom_split", eom_based to true, days to [30, 60, 90], and installments to 3.
For Luxottica special/individual orders (not standard procurement), terms are EOM+30+30: end of invoice month + 30 days = baseline, then + 30 days = due date. Set type to "eom_single", eom_based to true, days to [30], installments to 1.

MARCOLIN PAYMENT TERMS:
Marcolin uses EOM-based split payment terms written as "Check X-Y-Z days EoM" or "X/Y/Z days EoM" where X, Y, Z are day offsets from end of invoice month. Common Marcolin terms: "50-80-110 days EoM" = three equal tranches due at 50, 80, and 110 days after end of invoice month. Set payment_terms_extracted.type to "eom_split", eom_based to true, days to [X, Y, Z] (the three numbers), installments to 3. Store the raw term text exactly as written. Do NOT extract just one number.

CREDIT MEMO DETECTION — set doc_type = "credit_memo" if ANY of these are true:
- The word "Credit" appears as a standalone header/title on the document (distinct from appearing in body text)
- The phrase "Credit Note" appears as the document title
- The vendor is Luxottica AND the header reads "Credit" (not "Invoice")
- The vendor is Kering AND the header reads "Credit Note"

LUXOTTICA CREDIT EXTRACTION RULES:
- Amounts are printed with a TRAILING minus sign (e.g. "$727.68-"). Parse these as NEGATIVE numbers (e.g. -727.68)
- total = the "Total Invoice To Pay" value, stored as a NEGATIVE number
- subtotal = same as total (Lux credits have no separate tax line)
- tax = 0
- Line items will have real UPC codes and frame models — extract them fully
- po_number = the "Purchase Order No." field
- Extract the Order Reason code (e.g. "Z1F - CARRIER-SHIPMENT") into notes

KERING CREDIT EXTRACTION RULES:
- Amounts are printed as POSITIVE numbers — the doc type signals the credit
- total = the "Total amount" line (which includes tax) stored as a NEGATIVE number (e.g. 1674.44 on the PDF → -1674.44 stored)
- subtotal = the "Net value" line, stored as a NEGATIVE number
- tax = the "Tax" line, stored as a NEGATIVE number
- Line items are general settlement descriptions with NO UPC codes — extract description and net total per line; upc = null for all lines
- Extract the "Bill.doc." reference number into notes as "References billing doc: [number] dated [date]"
- Extract brand summary (BTV/GUC/SLP etc.) into vendor_brands array

Return ONLY valid JSON: { doc_type, vendor, vendor_brands[], invoice_number, invoice_date (YYYY-MM-DD), po_number, account_number, ship_to, carrier, payment_terms, payment_terms_extracted, shipping_terms, subtotal, tax, freight, total, currency, needs_review, line_items[{upc, item_number, sku, description, brand, model, color_code, color_desc, size, temple, qty_ordered, qty_shipped, qty, unit_price, line_total}], notes }. CRITICAL: Return ONLY raw JSON. No markdown, no code fences, no backticks, no preamble, no explanation. Your response must start with { and end with }. Nothing before {. Nothing after }.`;

export const CONCURRENCY = 4;
export const RETRY_CONCURRENCY = 3;
export const STAGGER_DELAY = 4000;
export const RETRY_STAGGER_DELAY = 5000;
export const RETRY_WAITS_429 = [30_000, 60_000, 90_000, 120_000];
export const RETRY_WAITS_OTHER = [20_000, 45_000, 90_000];
export const MAX_RETRIES_429 = 4;
export const MAX_RETRIES_OTHER = 3;
export const RETRY_COOLDOWN = 30_000;
export const FETCH_TIMEOUT = 60_000;

export type DocStatus = "processing" | "done" | "error" | "duplicate" | "retrying" | "staged" | "waiting-retry" | "extended" | "review" | "saving" | "discarded";

export interface ProcessedDoc {
  id: string;
  filename: string;
  vendor: string;
  doc_type: string;
  invoice_number: string;
  total: number;
  line_items_count: number;
  status: DocStatus;
  error?: string;
  dbId?: string;
  retryAttempt?: number;
  retryCountdown?: number;
  duplicateDbId?: string;
  invoiceData?: VendorInvoiceInsert;
  file?: File;
  // Extended invoice info
  extendedInfo?: string;
  // PO link info
  poLinkInfo?: string;
  // Pre-save review fields
  parsedData?: any;
  reviewTerms?: string;
}

export interface BatchStats {
  processed: number;
  saved: number;
  trueDuplicates: number;
  extended: number;
  failed: number;
  totalValue: number;
  totalUnits: number;
  invoices: number;
  pos: number;
  lineItems: number;
  poLinks: number;
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw { isTimeout: true, message: `Request timed out after ${Math.round(timeoutMs / 1000)}s` };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function extractJSON(raw: string): any {
  let cleaned = raw
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im, '')
    .replace(/```\s*$/im, '')
    .trim();

  if (cleaned.includes('`') || !cleaned.startsWith('{')) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      cleaned = cleaned.slice(start, end + 1);
    }
  }

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('JSON parse failed. Raw response:', raw);
    throw { isParseError: true, message: 'Invalid JSON response from Claude' };
  }
}

export async function callAnthropicAPI(
  apiKey: string,
  base64: string,
): Promise<any> {
  const cleanKey = apiKey.replace(/[^\x20-\x7E]/g, '').trim();
  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cleanKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [{
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        }, {
          type: "text",
          text: "Extract all invoice/PO data from this document. Return only valid JSON.",
        }],
      }],
    }),
  }, FETCH_TIMEOUT);

  if (response.status === 429) {
    throw { isRateLimit: true };
  }

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error ${response.status}: ${err}`);
  }

  const result = await response.json();
  const textContent = result.content?.find((c: any) => c.type === "text")?.text;
  if (!textContent) throw new Error("No text content in response");

  return extractJSON(textContent);
}

export function parsedToInvoice(parsed: any, filename: string, pdfUrl?: string | null): VendorInvoiceInsert {
  const vendor = normalizeVendor(parsed.vendor);
  const rawLineItems = parsed.line_items || [];

  // Apply vendor-specific pricing rules (e.g. Marchon 10% discount)
  const { lineItems, subtotal, total, discountApplied, discountPercent } =
    applyVendorDiscount(vendor, rawLineItems, parsed.subtotal, parsed.total);

  const discountNote = discountApplied
    ? `${discountPercent}% vendor discount applied automatically.`
    : null;
  const existingNotes = parsed.notes ? String(parsed.notes) : "";
  const combinedNotes = discountNote
    ? existingNotes
      ? `${existingNotes} | ${discountNote}`
      : discountNote
    : existingNotes || null;

  // Determine terms_status from extraction confidence
  const extractedTerms = parsed.payment_terms_extracted;
  const confidence = extractedTerms?.confidence ?? "low";
  const docType = parsed.doc_type || "INVOICE";
  const isProformaDoc = docType.toLowerCase().includes("proforma") || docType.toLowerCase().includes("pro forma") || docType.toLowerCase().includes("pro-forma");
  const isCreditMemo = docType.toLowerCase() === "credit_memo";

  let termsStatus = "needs_review";
  let termsConfidence: string | null = confidence;
  if (isCreditMemo) {
    termsStatus = "confirmed";
    termsConfidence = "auto";
  } else if (isProformaDoc) {
    termsStatus = "proforma";
    termsConfidence = null;
  } else if (confidence === "high") {
    termsStatus = "confirmed";
  } else if (confidence === "medium") {
    termsStatus = "confirmed"; // Include in AP but flagged
  }
  // low or unknown → needs_review

  // Handle FOB: if payment_terms is FOB-only, clear it
  let paymentTerms = parsed.payment_terms;
  const shippingTerms = parsed.shipping_terms || extractedTerms?.shipping_terms || null;
  if (paymentTerms && typeof paymentTerms === "string") {
    const cleaned = paymentTerms.replace(/\bfob\b[\s\w]*/gi, "").trim();
    if (cleaned === "" || cleaned === ",") paymentTerms = null;
  }

  return {
    vendor,
    doc_type: docType,
    invoice_number: parsed.invoice_number || filename,
    invoice_date: parsed.invoice_date || new Date().toISOString().split("T")[0],
    po_number: parsed.po_number,
    account_number: parsed.account_number,
    ship_to: parsed.ship_to,
    carrier: parsed.carrier,
    payment_terms: paymentTerms,
    subtotal: subtotal ?? parsed.subtotal,
    tax: parsed.tax,
    freight: parsed.freight,
    total: total ?? parsed.total ?? 0,
    currency: parsed.currency || "USD",
    vendor_brands: parsed.vendor_brands,
    notes: combinedNotes,
    filename,
    line_items: lineItems,
    // New terms columns (cast to any for TS compat until types regenerate)
    ...(({
      terms_status: termsStatus,
      terms_confidence: termsConfidence,
      payment_terms_extracted: extractedTerms || null,
      payment_terms_source: "extraction",
      shipping_terms: shippingTerms,
      ...(pdfUrl ? { pdf_url: pdfUrl } : {}),
    }) as any),
  };
}

export async function uploadPDFToStorage(
  file: File,
  vendor: string,
  invoiceNumber: string
): Promise<string | null> {
  try {
    const safeVendor = (vendor || 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .slice(0, 40);
    const safeInvoice = (invoiceNumber || 'unknown')
      .replace(/[^a-zA-Z0-9_\-]/g, '_')
      .slice(0, 60);
    const timestamp = Date.now();
    const path = `${safeVendor}/${safeInvoice}_${timestamp}.pdf`;

    const { data, error } = await supabase.storage
      .from('invoice-pdfs')
      .upload(path, file, {
        contentType: 'application/pdf',
        upsert: false,
      });

    if (error) {
      console.error('PDF storage upload failed:', error.message);
      return null;
    }

    // Signed URL valid for 10 years
    const { data: signed } = await supabase.storage
      .from('invoice-pdfs')
      .createSignedUrl(data.path, 60 * 60 * 24 * 365 * 10);

    return signed?.signedUrl ?? null;
  } catch (err) {
    console.error('PDF upload error:', err);
    return null;
  }
}

export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function batchInsertInvoices(invoices: VendorInvoiceInsert[]) {
  if (invoices.length === 0) return [];
  const { data, error } = await supabase
    .from("vendor_invoices")
    .insert(invoices)
    .select();
  if (error) throw error;
  return data;
}

export type FileDocPair = { file: File; docId: string };

export function getRetryConfig(err: any): { maxRetries: number; waits: number[] } {
  if (err?.isRateLimit) {
    return { maxRetries: MAX_RETRIES_429, waits: RETRY_WAITS_429 };
  }
  return { maxRetries: MAX_RETRIES_OTHER, waits: RETRY_WAITS_OTHER };
}

export async function runRollingQueue<T>(
  items: T[],
  maxConcurrency: number,
  staggerMs: number,
  onProcess: (item: T, index: number) => Promise<void>,
  cancelRef: { current: boolean },
): Promise<void> {
  let nextIndex = 0;
  let active = 0;
  let resolveAll: () => void;
  const allDone = new Promise<void>(r => { resolveAll = r; });

  const launch = (idx: number, delay: number) => {
    setTimeout(() => {
      if (cancelRef.current) {
        active--;
        if (active === 0) resolveAll();
        return;
      }
      onProcess(items[idx], idx).finally(() => {
        active--;
        if (!cancelRef.current && nextIndex < items.length) {
          const ni = nextIndex++;
          active++;
          launch(ni, 0);
        }
        if (active === 0 && (nextIndex >= items.length || cancelRef.current)) resolveAll();
      });
    }, delay);
  };

  const initialCount = Math.min(maxConcurrency, items.length);
  for (let i = 0; i < initialCount; i++) {
    nextIndex++;
    active++;
    launch(i, i * staggerMs);
  }

  if (items.length === 0) return;

  await allDone;
}
