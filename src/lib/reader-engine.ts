import { supabase } from "@/integrations/supabase/client";
import type { VendorInvoiceInsert } from "@/lib/supabase-queries";
import { normalizeVendor } from "@/lib/invoice-dedup";

const SYSTEM_PROMPT = `You are a document data extractor for an optical retail business (NinetySix Shades). Extract data from vendor invoices AND purchase orders from: Maui Jim, Kering (Gucci, Saint Laurent, Balenciaga, Bottega Veneta, Alexander McQueen), Safilo (Carrera, Fossil, Hugo Boss, Jimmy Choo), Marcolin (Tom Ford, Guess, Swarovski, Montblanc), Luxottica (Ray-Ban, Oakley, Prada, Versace, Persol, Coach, DKNY, Dolce & Gabbana, Emporio Armani, Giorgio Armani, Burberry, Michael Kors, Tiffany, Vogue). Luxottica POs use fields: Order Number, Account Number, Carrier, Terms, Item Number, Color Code, Temple, Quantity Ordered, Quantity Shipped, Unit Cost, Extended Cost. Detect INVOICE vs PO. Return ONLY valid JSON: { doc_type, vendor, vendor_brands[], invoice_number, invoice_date (YYYY-MM-DD), po_number, account_number, ship_to, carrier, payment_terms, subtotal, tax, freight, total, currency, line_items[{upc, item_number, sku, description, brand, model, color_code, color_desc, size, temple, qty_ordered, qty_shipped, qty, unit_price, line_total}], notes }. CRITICAL: Return ONLY raw JSON. No markdown, no code fences, no backticks, no preamble, no explanation. Your response must start with { and end with }. Nothing before {. Nothing after }.`;

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

export type DocStatus = "processing" | "done" | "error" | "duplicate" | "retrying" | "staged" | "waiting-retry" | "extended";

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

export function parsedToInvoice(parsed: any, filename: string): VendorInvoiceInsert {
  return {
    vendor: normalizeVendor(parsed.vendor),
    doc_type: parsed.doc_type || "INVOICE",
    invoice_number: parsed.invoice_number || filename,
    invoice_date: parsed.invoice_date || new Date().toISOString().split("T")[0],
    po_number: parsed.po_number,
    account_number: parsed.account_number,
    ship_to: parsed.ship_to,
    carrier: parsed.carrier,
    payment_terms: parsed.payment_terms,
    subtotal: parsed.subtotal,
    tax: parsed.tax,
    freight: parsed.freight,
    total: parsed.total || 0,
    currency: parsed.currency || "USD",
    vendor_brands: parsed.vendor_brands,
    notes: parsed.notes,
    filename,
    line_items: parsed.line_items || [],
  };
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
