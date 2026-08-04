import { supabase } from "@/integrations/supabase/client";
import type { LineItem } from "@/lib/supabase-queries";

// ── Vendor normalization — SINGLE SOURCE OF TRUTH ─────
const KNOWN_VENDORS = ["Luxottica", "Kering", "Maui Jim", "Safilo", "Marcolin", "Marchon", "Smith Optics", "Revo", "DITA"] as const;
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
  // Revo (B Robinson LLC distributes Revo)
  "revo": "Revo",
  "b robinson": "Revo",
  "b. robinson": "Revo",
  "b robinson llc": "Revo",
  "b. robinson llc": "Revo",
  "b robinson llc / revo": "Revo",
  "b. robinson llc / revo": "Revo",
  "b robinson / revo": "Revo",
  // Dita
  "dita": "DITA",
  "dita inc": "DITA",
  "dita inc.": "DITA",
  "dita, inc.": "DITA",
  "dita usa": "DITA",
  "dita usa inc": "DITA",
  "dita usa inc.": "DITA",
  "dita group": "DITA",
  "dita eyewear": "DITA",
  "dita legends": "DITA",
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

// UPC-based key: catches re-imports where the extraction produced a different
// item_number/sku text but the same physical product, qty and price.
function lineKeyUpc(li: LineItem): string | null {
  const upc = String((li as any).upc ?? "").replace(/\D+/g, "");
  if (!upc) return null;
  const qty = Number(li.qty_shipped ?? li.qty_ordered ?? li.qty ?? 0);
  const price = Number(li.unit_price ?? 0).toFixed(2);
  return `${upc}|${qty}|${price}`;
}

function extractLineKeys(items: LineItem[]): Set<string> {
  return new Set(items.map(lineKey));
}

function extractLooseLineKeys(items: LineItem[]): Set<string> {
  return new Set(items.map(lineKeyLoose));
}

function extractUpcKeys(items: LineItem[]): Set<string> {
  return new Set(items.map(lineKeyUpc).filter(Boolean) as string[]);
}

// ── UPC / Model extraction ────────────────────────────────
function extractUPCs(items: LineItem[]): Set<string> {
  return new Set(items.map(li => li.upc).filter(Boolean) as string[]);
}

// ── Dedup result types ────────────────────────────────────
export type DedupAction =
  | { type: "new" }
  | { type: "true_duplicate"; existingId: string; reason?: string }
  | {
      type: "extended";
      existingId: string;
      newItems: LineItem[];
      oldCount: number;
      newCount: number;
      combinedTotal: number;
    };

function normalizeFilename(name: string | null | undefined): string {
  if (!name) return "";
  return name.toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/[\s_\-().]+/g, "");
}

// ── Main dedup check ──────────────────────────────────────
export async function checkInvoiceDuplicate(
  invoiceNumber: string,
  vendor: string,
  incomingItems: LineItem[],
  incomingTotal: number,
  incomingFilename?: string | null
): Promise<DedupAction> {

  // Resolve through alias map (wizard-defined + static) so "Dita"/"DITA"/
  // "DITA Eyewear" all collapse to one canonical vendor before the dup test.
  const normalizedVendor = await normalizeVendorAsync(vendor);

  // Case-insensitive vendor match — protects against legacy rows saved
  // with different casing (the original DITA bug).
  const { data } = await supabase
    .from("vendor_invoices")
    .select("id, line_items, total, subtotal, filename, last_shipment_file, is_multi_shipment, shipment_count")
    .eq("invoice_number", invoiceNumber)
    .ilike("vendor", normalizedVendor)
    .limit(1);

  if (!data || data.length === 0) {
    return { type: "new" };
  }

  const existing = data[0];
  const existingItems = (
    Array.isArray(existing.line_items) ? existing.line_items : []
  ) as unknown as LineItem[];

  // ── Guard 0: same source document ────────────────────────
  // If the incoming file is the very same document already on file (or already
  // merged in as a shipment), this is a re-import — never merge it as a new
  // shipment, that is what doubled invoices in the past.
  const incomingFn = normalizeFilename(incomingFilename);
  if (incomingFn) {
    const existingFns = [
      normalizeFilename((existing as any).filename),
      normalizeFilename((existing as any).last_shipment_file),
    ].filter(Boolean);
    if (existingFns.includes(incomingFn)) {
      return {
        type: "true_duplicate",
        existingId: existing.id,
        reason: "Same source file already imported for this invoice",
      };
    }
  }

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

  // Third pass: UPC + qty + price — catches re-extractions where the item
  // number/sku text came out differently but it is physically the same line.
  if (genuinelyNewItems.length > 0) {
    const existingUpcKeys = extractUpcKeys(existingItems);
    if (existingUpcKeys.size > 0) {
      genuinelyNewItems = genuinelyNewItems.filter(li => {
        const k = lineKeyUpc(li);
        return !(k && existingUpcKeys.has(k));
      });
    }
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

  // ── Guard 1: whole-document match ────────────────────────
  // Same line count and same document total (or the incoming total equals the
  // existing subtotal, the signature of a doubled row) => re-import, not a
  // genuine second shipment.
  const existingTotal = Number(existing.total ?? 0);
  const existingSubtotal = Number((existing as any).subtotal ?? 0);
  const sameMoney =
    (incomingTotal > 0 && Math.abs(incomingTotal - existingTotal) < 0.01) ||
    (incomingTotal > 0 && existingSubtotal > 0 && Math.abs(incomingTotal - existingSubtotal) < 0.01);
  if (
    sameMoney &&
    incomingItems.length > 0 &&
    incomingItems.length === existingItems.length
  ) {
    return {
      type: "true_duplicate",
      existingId: existing.id,
      reason: "Same line count and same invoice total as the existing record",
    };
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
    .select("line_items, shipment_count, pdf_url, filename, last_shipment_file")
    .eq("id", existingId)
    .single();

  if (!current) throw new Error("Could not find existing record to merge");

  // Last-line defence: refuse to merge the same source document twice.
  const fn = normalizeFilename(incomingFilename);
  if (
    fn &&
    [normalizeFilename((current as any).filename), normalizeFilename((current as any).last_shipment_file)]
      .filter(Boolean)
      .includes(fn)
  ) {
    throw new Error(
      `Duplicate invoice — "${incomingFilename}" was already imported for this invoice. Nothing was merged.`
    );
  }

  const existingItems = (
    Array.isArray(current.line_items) ? current.line_items : []
  ) as unknown as LineItem[];

  // Only append lines that are genuinely new relative to what is already stored.
  const storedKeys = extractLineKeys(existingItems);
  const storedLoose = extractLooseLineKeys(existingItems);
  const storedUpc = extractUpcKeys(existingItems);
  const trulyNew = newItems.filter(li => {
    if (storedKeys.has(lineKey(li))) return false;
    if (storedLoose.has(lineKeyLoose(li))) return false;
    const uk = lineKeyUpc(li);
    if (uk && storedUpc.has(uk)) return false;
    return true;
  });

  if (trulyNew.length === 0) {
    throw new Error("Duplicate invoice — no new line items to merge. Nothing was changed.");
  }

  const mergedItems = [...existingItems, ...trulyNew];
  const shipmentCount = (current.shipment_count || 1) + 1;


  // Recompute the total from the lines we actually appended (combinedTotal may
  // have been computed before duplicate lines were filtered out).
  const droppedCount = newItems.length - trulyNew.length;
  const effectiveTotal =
    droppedCount === 0
      ? combinedTotal
      : Number(
          (
            mergedItems.reduce((s, li) => s + Number((li as any).line_total ?? 0), 0)
          ).toFixed(2)
        );

  const updatePayload: any = {
    line_items: mergedItems as any,
    total: effectiveTotal,

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

  // A merge raises the invoice total — bring the existing payment schedule up to
  // the new total (preserving paid installments) and keep invoice_amount in sync.
  // If the gap can't be absorbed automatically, the invoice is flagged
  // "needs reschedule" and appears in the Needs Review queue.
  try {
    const { reconcileScheduleAfterMerge } = await import("./payment-queries");
    return await reconcileScheduleAfterMerge(existingId, effectiveTotal);
  } catch (e) {
    console.error("[merge] schedule reconciliation failed", e);
    return null;
  }
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


// ── Undo a bad shipment merge (duplicate re-import repair) ─
/**
 * Collapses duplicate line items on a multi-shipment invoice back down to the
 * unique lines, restores the total from those lines, and clears the
 * multi-shipment flags. Payment schedule rows are left untouched.
 */
export async function undoDuplicateShipmentMerge(invoiceId: string) {
  const { data: inv, error: fetchErr } = await supabase
    .from("vendor_invoices")
    .select("id, invoice_number, line_items, total, subtotal, tax, freight, notes, shipment_count")
    .eq("id", invoiceId)
    .single();
  if (fetchErr || !inv) throw fetchErr ?? new Error("Invoice not found");

  const items = (Array.isArray(inv.line_items) ? inv.line_items : []) as unknown as LineItem[];

  // Keep the first (richest) occurrence of each unique line.
  const seen = new Set<string>();
  const unique: LineItem[] = [];
  for (const li of [...items].sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)) {
    const keys = [lineKey(li), lineKeyLoose(li), lineKeyUpc(li)].filter(Boolean) as string[];
    if (keys.some(k => seen.has(k))) continue;
    keys.forEach(k => seen.add(k));
    unique.push(li);
  }

  const removed = items.length - unique.length;
  if (removed === 0) {
    throw new Error("No duplicate line items found on this invoice — nothing to undo.");
  }

  const lineSum = unique.reduce((s, li) => s + Number((li as any).line_total ?? 0), 0);
  const newTotal = Number(
    (lineSum + Number(inv.tax ?? 0) + Number(inv.freight ?? 0)).toFixed(2)
  );

  const note = `[data repair] Removed ${removed} duplicate line item(s) from a re-imported shipment; restored total to ${newTotal.toFixed(2)}.`;

  const { error } = await supabase
    .from("vendor_invoices")
    .update({
      line_items: unique as any,
      subtotal: Number(lineSum.toFixed(2)),
      total: newTotal,
      is_multi_shipment: false,
      shipment_count: 1,
      last_shipment_date: null,
      last_shipment_file: null,
      notes: `${inv.notes ? inv.notes + "\n" : ""}${note}`,
    } as any)
    .eq("id", invoiceId);
  if (error) throw error;

  try {
    const { syncInvoicePaymentStatus } = await import("./payment-queries");
    await syncInvoicePaymentStatus(invoiceId);
  } catch { /* non-fatal */ }

  return { removed, newTotal, remaining: unique.length };
}
