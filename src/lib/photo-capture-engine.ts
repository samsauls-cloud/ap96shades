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

Return ONLY valid JSON: { doc_type, vendor, vendor_brands[], invoice_number, invoice_date (YYYY-MM-DD), po_number, account_number, ship_to, carrier, payment_terms, subtotal, tax, freight, total, currency, needs_review, line_items[{upc, item_number, sku, description, brand, model, color_code, color_desc, size, temple, qty_ordered, qty_shipped, qty, unit_price, line_total}], notes }. CRITICAL: Return ONLY raw JSON. No markdown, no code fences, no backticks, no preamble, no explanation. Your response must start with { and end with }. Nothing before {. Nothing after }.`;

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

export async function imageToBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".heic") || name.endsWith(".heif") || file.type === "image/heic" || file.type === "image/heif") {
    return convertHEICToJPEG(file);
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return { base64: btoa(binary), mediaType: getMediaType(file) };
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
