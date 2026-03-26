import { supabase } from "@/integrations/supabase/client";
import type { VendorInvoiceInsert } from "@/lib/supabase-queries";

const SYSTEM_PROMPT = `You are a document data extractor for an optical retail business (NinetySix Shades). Extract data from vendor invoices AND purchase orders from: Maui Jim, Kering (Gucci, Saint Laurent, Balenciaga, Bottega Veneta, Alexander McQueen), Safilo (Carrera, Fossil, Hugo Boss, Jimmy Choo), Marcolin (Tom Ford, Guess, Swarovski, Montblanc), Luxottica (Ray-Ban, Oakley, Prada, Versace, Persol, Coach, DKNY, Dolce & Gabbana, Emporio Armani, Giorgio Armani, Burberry, Michael Kors, Tiffany, Vogue). Luxottica POs use fields: Order Number, Account Number, Carrier, Terms, Item Number, Color Code, Temple, Quantity Ordered, Quantity Shipped, Unit Cost, Extended Cost. Detect INVOICE vs PO. Return ONLY valid JSON: { doc_type, vendor, vendor_brands[], invoice_number, invoice_date (YYYY-MM-DD), po_number, account_number, ship_to, carrier, payment_terms, subtotal, tax, freight, total, currency, line_items[{upc, item_number, sku, description, brand, model, color_code, color_desc, size, temple, qty_ordered, qty_shipped, qty, unit_price, line_total}], notes }`;

export const CONCURRENCY = 5;
export const RETRY_CONCURRENCY = 3;
export const STAGGER_DELAY = 3000;
export const RETRY_WAITS = [20_000, 45_000, 90_000];
export const MAX_RETRIES = 3;
export const RETRY_COOLDOWN = 30_000;

export type DocStatus = "processing" | "done" | "error" | "duplicate" | "retrying" | "staged" | "waiting-retry";

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
}

export interface BatchStats {
  processed: number;
  saved: number;
  duplicates: number;
  failed: number;
  totalValue: number;
  totalUnits: number;
  invoices: number;
  pos: number;
  lineItems: number;
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function callAnthropicAPI(
  apiKey: string,
  base64: string,
): Promise<any> {
  const cleanKey = apiKey.replace(/[^\x20-\x7E]/g, '').trim();
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
      max_tokens: 4000,
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

  let jsonStr = textContent;
  const match = textContent.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) jsonStr = match[1];
  return JSON.parse(jsonStr.trim());
}

export function parsedToInvoice(parsed: any, filename: string): VendorInvoiceInsert {
  return {
    vendor: parsed.vendor || "Unknown",
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

export async function checkDuplicate(invoiceNumber: string, vendor: string): Promise<string | null> {
  const { data } = await supabase
    .from("vendor_invoices")
    .select("id")
    .eq("invoice_number", invoiceNumber)
    .eq("vendor", vendor)
    .limit(1);
  return data && data.length > 0 ? data[0].id : null;
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

/**
 * Staggered rolling queue processor.
 * Starts tasks with STAGGER_DELAY between each, never exceeding maxConcurrency active.
 * onProcess is called for each item; it should return a promise.
 */
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

  const startNext = () => {
    while (nextIndex < items.length && active < maxConcurrency && !cancelRef.current) {
      const idx = nextIndex++;
      active++;
      const staggerDelay = idx < maxConcurrency ? idx * staggerMs : 0;

      setTimeout(() => {
        if (cancelRef.current) {
          active--;
          if (active === 0 && (nextIndex >= items.length || cancelRef.current)) resolveAll();
          return;
        }
        onProcess(items[idx], idx).finally(() => {
          active--;
          if (!cancelRef.current) startNext();
          if (active === 0 && (nextIndex >= items.length || cancelRef.current)) resolveAll();
        });
      }, staggerDelay);

      // Only stagger the initial ramp-up; after that, start immediately as slots open
      if (idx >= maxConcurrency - 1) break;
    }
  };

  startNext();

  // If no items, resolve immediately
  if (items.length === 0) return;

  await allDone;
}
