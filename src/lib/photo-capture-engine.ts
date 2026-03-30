import { FETCH_TIMEOUT } from "@/lib/reader-engine";

const PHOTO_SYSTEM_PROMPT = `You are extracting data from a photo of a printed vendor invoice for an optical retail business. The photo may be angled, partially shadowed, or imperfectly framed — do your best to read all text.

These fields are CRITICAL — extract them with highest priority even if the rest is unclear:
- invoice_number (look for: Invoice #, Invoice No, Inv #, Document Number)
- po_number (look for: PO #, Purchase Order, Order Number, PO Number, Reference)
- invoice_date (any date format — convert to YYYY-MM-DD)
- vendor (look for company name in header/letterhead)
- total (look for: Total, Amount Due, Balance Due, Grand Total)

For every line item extract:
- upc or item_number or sku (any product code visible)
- description (full item description)
- brand
- model (model number or style code)
- color_code
- color_desc
- qty_ordered
- qty_shipped (may differ from ordered)
- unit_price / unit_cost
- line_total

If any field is genuinely unreadable, set it to null rather than guessing. Flag the invoice with needs_review: true if more than 3 fields are null or if the total cannot be confirmed.

IMPORTANT: If this document contains any of these phrases — "pro forma", "proforma", "not an invoice", "invoice to follow", "for reference only", "preliminary", "THIS IS NOT AN INVOICE", "for reference purposes only" — set doc_type to "proforma". Do NOT set it to "INVOICE". A proforma is NOT a payable document.

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

Return ONLY valid JSON: { doc_type, vendor, vendor_brands[], invoice_number, invoice_date (YYYY-MM-DD), po_number, account_number, ship_to, carrier, payment_terms, payment_terms_extracted, shipping_terms, subtotal, tax, freight, total, currency, needs_review, line_items[{upc, item_number, sku, description, brand, model, color_code, color_desc, size, temple, qty_ordered, qty_shipped, qty, unit_price, line_total}], notes }. CRITICAL: Return ONLY raw JSON. No markdown, no code fences, no backticks, no preamble, no explanation. Your response must start with { and end with }. Nothing before {. Nothing after }.`;

function getMediaType(file: File): string {
  const type = file.type.toLowerCase();
  if (type === "image/heic" || type === "image/heif") return "image/jpeg"; // HEIC will be converted
  if (type === "image/webp") return "image/webp";
  if (type === "image/png") return "image/png";
  return "image/jpeg";
}

export function isImageFile(file: File): boolean {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return (
    type.startsWith("image/") ||
    name.endsWith(".heic") ||
    name.endsWith(".heif") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".png") ||
    name.endsWith(".webp")
  );
}

async function convertHEICToJPEG(file: File): Promise<{ base64: string; mediaType: string }> {
  // For HEIC files, we create a canvas-based conversion
  // Modern browsers with HEIC support will handle this via createImageBitmap
  const blob = file;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const base64 = jpegDataUrl.split(",")[1];
    bitmap.close();
    return { base64, mediaType: "image/jpeg" };
  } catch {
    // Fallback: send raw file as base64, let Claude handle it
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return { base64: btoa(binary), mediaType: "image/jpeg" };
  }
}

const MAX_IMAGE_DIMENSION = 2048;
const JPEG_QUALITY = 0.85;

async function resizeImageToCanvas(file: File): Promise<{ base64: string; mediaType: string }> {
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;

  // Scale down if either dimension exceeds max
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const base64 = dataUrl.split(",")[1];
  return { base64, mediaType: "image/jpeg" };
}

export async function imageToBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  // All image types get resized/compressed via canvas to keep payload small
  try {
    return await resizeImageToCanvas(file);
  } catch {
    // Fallback for formats createImageBitmap can't handle (some HEIC)
    const name = file.name.toLowerCase();
    if (name.endsWith(".heic") || name.endsWith(".heif") || file.type === "image/heic" || file.type === "image/heif") {
      return convertHEICToJPEG(file);
    }
    // Raw fallback
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return { base64: btoa(binary), mediaType: getMediaType(file) };
  }
}

function extractJSON(raw: string): any {
  let cleaned = raw
    .replace(/^```json\s*/im, "")
    .replace(/^```\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim();

  if (cleaned.includes("`") || !cleaned.startsWith("{")) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      cleaned = cleaned.slice(start, end + 1);
    }
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    throw { isParseError: true, message: "Invalid JSON response from Claude (photo)" };
  }
}

export async function callAnthropicImageAPI(
  apiKey: string,
  base64: string,
  mediaType: string
): Promise<any> {
  const cleanKey = apiKey.replace(/[^\x20-\x7E]/g, "").trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
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
        system: PHOTO_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64 },
              },
              {
                type: "text",
                text: "Extract all invoice/PO data from this photo of a printed invoice. Return only valid JSON.",
              },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

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
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw { isTimeout: true, message: "Request timed out" };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
