import { supabase } from "@/integrations/supabase/client";
import type { LineItem } from "@/lib/supabase-queries";

// ── Vendor normalization — SINGLE SOURCE OF TRUTH ─────
const KNOWN_VENDORS = ["Luxottica", "Kering", "Maui Jim", "Safilo", "Marcolin", "Marchon", "Smith Optics"] as const;
export type KnownVendor = typeof KNOWN_VENDORS[number];

const VENDOR_MAP: Record<string, string> = {
  // Luxottica
  "luxottica": "Luxottica",
  "luxottica of america": "Luxottica",
  "luxottica of america inc": "Luxottica",
  "luxottica of america inc.": "Luxottica",
  "luxottica usa": "Luxottica",
  "essilor luxottica": "Luxottica",
  "essilorluxottica": "Luxottica",
  // Kering
  "kering": "Kering",
  "kering eyewear": "Kering",
  "kering eyewear usa": "Kering",
  "kering eyewear usa inc": "Kering",
  "kering eyewear usa, inc.": "Kering",
  "kering eyewear usa, inc": "Kering",
  "kering eyewear usa inc.": "Kering",
  // Maui Jim
  "maui jim": "Maui Jim",
  "maui jim inc": "Maui Jim",
  "maui jim inc.": "Maui Jim",
  "maui jim, inc.": "Maui Jim",
  "maui jim usa": "Maui Jim",
  "maui jim usa inc": "Maui Jim",
  "maui jim usa, inc.": "Maui Jim",
  "maui jim usa, inc": "Maui Jim",
  // Safilo
  "safilo": "Safilo",
  "safilo usa": "Safilo",
  "safilo usa inc": "Safilo",
  "safilo usa inc.": "Safilo",
  "safilo usa, inc.": "Safilo",
  "safilo usa, inc": "Safilo",
  "safilo s.p.a.": "Safilo",
  "safilo spa": "Safilo",
  "safilo group": "Safilo",
  // Marcolin
  "marcolin": "Marcolin",
  "marcolin usa": "Marcolin",
  "marcolin usa inc": "Marcolin",
  "marcolin usa inc.": "Marcolin",
  "marcolin usa, inc.": "Marcolin",
  "marcolin s.p.a.": "Marcolin",
  "marcolin spa": "Marcolin",
  // Marchon
  "marchon": "Marchon",
  "marchon eyewear": "Marchon",
  "marchon eyewear inc": "Marchon",
  "marchon eyewear inc.": "Marchon",
  "marchon eyewear, inc.": "Marchon",
  "marchon eyewear, inc": "Marchon",
  "marchon italia": "Marchon",
  "marchon usa": "Marchon",
  "marchon usa inc": "Marchon",
  "marchon usa inc.": "Marchon",
  "marchon nyc": "Marchon",
  // Smith Optics
  "smith optics": "Smith Optics",
  "smith optics inc": "Smith Optics",
  "smith optics inc.": "Smith Optics",
  "smith optics, inc.": "Smith Optics",
  "smith sport optics": "Smith Optics",
  "smith sport optics inc": "Smith Optics",
  "smith sport optics inc.": "Smith Optics",
  "smith sport optics, inc.": "Smith Optics",
  "smith": "Smith Optics",
  // Legacy extras
  "chanel": "Chanel",
  "costa del mar": "Costa",
  "costa": "Costa",
  "oliver peoples": "Oliver Peoples",
  "cartier": "Cartier",
};

/**
 * Normalize vendor name (sync — static map only).
 * Returns the canonical vendor name or the trimmed raw string if unknown.
 */
export function normalizeVendor(raw: string | null | undefined): string {
  if (!raw) return "Unknown";
  const lower = raw.toLowerCase().trim();
  if (VENDOR_MAP[lower]) return VENDOR_MAP[lower];
  const stripped = lower.replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
  if (VENDOR_MAP[stripped]) return VENDOR_MAP[stripped];
  return raw.trim();
}

/**
 * Normalize vendor name with async DB lookup.
 * Checks wizard-defined aliases in vendor_alias_map first, then static map.
 */
export async function normalizeVendorAsync(raw: string | null | undefined): Promise<string> {
  if (!raw) return "Unknown";
  // Try static map first (fast path)
  const staticResult = normalizeVendor(raw);
  if (staticResult !== raw.trim()) return staticResult; // matched static map

  // Try dynamic DB lookup
  const { resolveDynamicVendorName } = await import('@/lib/dynamic-vendor-lookup');
  const dynamic = await resolveDynamicVendorName(raw);
  if (dynamic) return dynamic;

  return staticResult;
}

/**
 * Returns true if the vendor is one of the 5 known/supported vendors.
 */
export function isKnownVendor(vendor: string): boolean {
  return (KNOWN_VENDORS as readonly string[]).includes(vendor);
}

export { KNOWN_VENDORS };

// ── Line-level key for dedup ──────────────────────────────
// Primary key: item_number + qty + unit_price (handles exact re-uploads)
/** Normalize an item identifier: strip spaces, punctuation, lowercase */
function normalizeItemId(raw: string): string {
  return raw.replace(/[\s.,\-\/\\]+/g, "").toLowerCase();
}

function lineKey(li: LineItem): string {
  const item = normalizeItemId(String(li.item_number ?? li.sku ?? ""));
  const qty = Number(li.qty_shipped ?? li.qty_ordered ?? li.qty ?? 0);
  const price = Number(li.unit_price ?? 0).toFixed(2);
  return `${item}|${qty}|${price}`;
}

// Fallback key: item_number + line_total (catches OCR price-variant dupes
// where the same item is parsed with MSRP vs wholesale price)
function lineKeyLoose(li: LineItem): string {
  const item = normalizeItemId(String(li.item_number ?? li.sku ?? ""));
  const lt = Number(li.line_total ?? 0).toFixed(2);
  return `${item}|${lt}`;
}

function extractLineKeys(items: LineItem[]): Set<string> {
  return new Set(items.map(lineKey));
}

function extractLooseLineKeys(items: LineItem[]): Set<string> {
  return new Set(items.map(lineKeyLoose));
}

// ── UPC / Model extraction ────────────────────────────────
function extractUPCs(items: LineItem[]): Set<string> {
  return new Set(items.map(li => li.upc).filter(Boolean) as string[]);
}

// ── Dedup result types ────────────────────────────────────
export type DedupAction =
  | { type: "new" }
  | { type: "true_duplicate"; existingId: string }
  | {
      type: "extended";
      existingId: string;
      newItems: LineItem[];
      oldCount: number;
      newCount: number;
      combinedTotal: number;
    };

// ── Main dedup check ──────────────────────────────────────
export async function checkInvoiceDuplicate(
  invoiceNumber: string,
  vendor: string,
  incomingItems: LineItem[],
  incomingTotal: number
): Promise<DedupAction> {
  const normalizedVendor = normalizeVendor(vendor);

  const { data } = await supabase
    .from("vendor_invoices")
    .select("id, line_items, total, is_multi_shipment, shipment_count")
    .eq("invoice_number", invoiceNumber)
    .eq("vendor", normalizedVendor)
    .limit(1);

  if (!data || data.length === 0) {
    return { type: "new" };
  }

  const existing = data[0];
  const existingItems = (
    Array.isArray(existing.line_items) ? existing.line_items : []
  ) as unknown as LineItem[];

  const incomingUPCs = extractUPCs(incomingItems);
  const existingUPCs = extractUPCs(existingItems);

  // Primary dedup: use item_number + qty + unit_price key
  // This is invariant across re-uploads even when model/description text differs
  const existingKeys = extractLineKeys(existingItems);
  let genuinelyNewItems = incomingItems.filter(li => !existingKeys.has(lineKey(li)));

  // Secondary dedup: catch OCR price-variant dupes (same item + line_total, different unit_price)
  if (genuinelyNewItems.length > 0) {
    const existingLooseKeys = extractLooseLineKeys(existingItems);
    genuinelyNewItems = genuinelyNewItems.filter(li => !existingLooseKeys.has(lineKeyLoose(li)));
  }

  if (genuinelyNewItems.length === 0) {
    return { type: "true_duplicate", existingId: existing.id };
  }

  // Fallback: also check UPCs for items without item_numbers
  if (incomingUPCs.size > 0) {
    const overlap = [...incomingUPCs].filter(u => existingUPCs.has(u));
    if (overlap.length === incomingUPCs.size && genuinelyNewItems.length === 0) {
      return { type: "true_duplicate", existingId: existing.id };
    }
  }

  // There are genuinely new line items — this is an extended invoice
  const oldCount = existingItems.length;
  const mergedItems = [...existingItems, ...genuinelyNewItems];
  const newLineTotal = genuinelyNewItems.reduce(
    (sum, li) => sum + Number(li.line_total ?? 0), 0
  );
  return {
    type: "extended",
    existingId: existing.id,
    newItems: genuinelyNewItems,
    oldCount,
    newCount: mergedItems.length,
    combinedTotal: Number(existing.total) + newLineTotal,
  };
}

// ── Merge extended invoice ────────────────────────────────
export async function mergeExtendedInvoice(
  existingId: string,
  newItems: LineItem[],
  combinedTotal: number,
  incomingDate: string,
  incomingFilename: string,
  pdfUrl?: string | null
) {
  const { data: current } = await supabase
    .from("vendor_invoices")
    .select("line_items, shipment_count, pdf_url")
    .eq("id", existingId)
    .single();

  if (!current) throw new Error("Could not find existing record to merge");

  const existingItems = (
    Array.isArray(current.line_items) ? current.line_items : []
  ) as unknown as LineItem[];

  const mergedItems = [...existingItems, ...newItems];
  const shipmentCount = (current.shipment_count || 1) + 1;

  const updatePayload: any = {
    line_items: mergedItems as any,
    total: combinedTotal,
    is_multi_shipment: true,
    shipment_count: shipmentCount,
    last_shipment_date: incomingDate,
    last_shipment_file: incomingFilename,
  };

  // Attach PDF if the existing record doesn't have one yet
  if (pdfUrl && !(current as any).pdf_url) {
    updatePayload.pdf_url = pdfUrl;
  }

  const { error } = await supabase
    .from("vendor_invoices")
    .update(updatePayload)
    .eq("id", existingId);

  if (error) throw error;
}

// ── PO Linkage ────────────────────────────────────────────
export async function updatePOTotalInvoiced(poNumber: string, vendor: string) {
  const normalizedVendor = normalizeVendor(vendor);

  const { data } = await supabase
    .from("vendor_invoices")
    .select("id, total")
    .eq("po_number", poNumber)
    .eq("vendor", normalizedVendor);

  if (!data || data.length === 0) return { count: 0, total: 0 };

  const poTotal = data.reduce((sum, inv) => sum + Number(inv.total), 0);

  await supabase
    .from("vendor_invoices")
    .update({ po_total_invoiced: poTotal })
    .eq("po_number", poNumber)
    .eq("vendor", normalizedVendor);

  return { count: data.length, total: poTotal };
}
