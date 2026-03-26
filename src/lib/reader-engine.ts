import { supabase } from "@/integrations/supabase/client";
import type { VendorInvoiceInsert } from "@/lib/supabase-queries";

const SYSTEM_PROMPT = `You are a document data extractor for an optical retail business (NinetySix Shades). Extract data from vendor invoices AND purchase orders from: Maui Jim, Kering (Gucci, Saint Laurent, Balenciaga, Bottega Veneta, Alexander McQueen), Safilo (Carrera, Fossil, Hugo Boss, Jimmy Choo), Marcolin (Tom Ford, Guess, Swarovski, Montblanc), Luxottica (Ray-Ban, Oakley, Prada, Versace, Persol, Coach, DKNY, Dolce & Gabbana, Emporio Armani, Giorgio Armani, Burberry, Michael Kors, Tiffany, Vogue). Luxottica POs use fields: Order Number, Account Number, Carrier, Terms, Item Number, Color Code, Temple, Quantity Ordered, Quantity Shipped, Unit Cost, Extended Cost. Detect INVOICE vs PO. Return ONLY valid JSON: { doc_type, vendor, vendor_brands[], invoice_number, invoice_date (YYYY-MM-DD), po_number, account_number, ship_to, carrier, payment_terms, subtotal, tax, freight, total, currency, line_items[{upc, item_number, sku, description, brand, model, color_code, color_desc, size, temple, qty_ordered, qty_shipped, qty, unit_price, line_total}], notes }`;

export const CONCURRENCY = 10;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 10_000;

export type DocStatus = "processing" | "done" | "error" | "duplicate" | "retrying" | "staged";

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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function callAnthropicAPI(
  apiKey: string,
  base64: string,
  retryCount = 0,
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

  if (response.status === 429 && retryCount < MAX_RETRIES) {
    throw { isRateLimit: true, retryCount };
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

export { RETRY_DELAY_MS, MAX_RETRIES, sleep };
