import { supabase } from "@/integrations/supabase/client";
import type { LineItem } from "@/lib/supabase-queries";

// ── Vendor normalization ──────────────────────────────────
const vendorMap: Record<string, string> = {
  "luxottica of america inc.": "Luxottica",
  "luxottica of america": "Luxottica",
  "luxottica": "Luxottica",
  "maui jim inc.": "Maui Jim",
  "maui jim, inc.": "Maui Jim",
  "maui jim": "Maui Jim",
  "marcolin usa": "Marcolin",
  "marcolin usa inc.": "Marcolin",
  "marcolin s.p.a.": "Marcolin",
  "marcolin": "Marcolin",
  "kering eyewear": "Kering",
  "kering eyewear usa": "Kering",
  "kering eyewear usa, inc.": "Kering",
  "kering eyewear usa, inc": "Kering",
  "kering": "Kering",
  "safilo usa": "Safilo",
  "safilo usa inc.": "Safilo",
  "safilo usa, inc": "Safilo",
  "safilo usa, inc.": "Safilo",
  "safilo s.p.a.": "Safilo",
  "safilo": "Safilo",
  "maui jim usa, inc.": "Maui Jim",
  "maui jim usa, inc": "Maui Jim",
  "maui jim usa": "Maui Jim",
  "chanel": "Chanel",
  "costa del mar": "Costa",
  "costa": "Costa",
  "oliver peoples": "Oliver Peoples",
  "cartier": "Cartier",
};

export function normalizeVendor(raw: string | null | undefined): string {
  return vendorMap[raw?.toLowerCase().trim() ?? ""] || raw?.trim() || "Unknown";
}

// ── UPC / Model extraction ────────────────────────────────
function extractUPCs(items: LineItem[]): Set<string> {
  return new Set(items.map(li => li.upc).filter(Boolean) as string[]);
}

function extractModels(items: LineItem[]): Set<string> {
  return new Set(
    items.map(li => li.model || li.item_number).filter(Boolean) as string[]
  );
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

  // If we have UPCs to compare
  if (incomingUPCs.size > 0) {
    const overlap = [...incomingUPCs].filter(u => existingUPCs.has(u));
    const newUPCItems = incomingItems.filter(
      li => li.upc && !existingUPCs.has(li.upc)
    );

    if (overlap.length === incomingUPCs.size) {
      return { type: "true_duplicate", existingId: existing.id };
    }

    if (newUPCItems.length > 0) {
      const oldCount = existingItems.length;
      const mergedItems = [...existingItems, ...newUPCItems];
      return {
        type: "extended",
        existingId: existing.id,
        newItems: newUPCItems,
        oldCount,
        newCount: mergedItems.length,
        combinedTotal: Number(existing.total) + incomingTotal,
      };
    }

    // All incoming UPCs overlap → true duplicate
    return { type: "true_duplicate", existingId: existing.id };
  }

  // Fallback: compare by model/item_number
  const incomingModels = extractModels(incomingItems);
  const existingModels = extractModels(existingItems);

  if (incomingModels.size > 0) {
    const newModelItems = incomingItems.filter(li => {
      const key = li.model || li.item_number;
      return key && !existingModels.has(key);
    });

    if (newModelItems.length === 0) {
      return { type: "true_duplicate", existingId: existing.id };
    }

    const oldCount = existingItems.length;
    const mergedItems = [...existingItems, ...newModelItems];
    return {
      type: "extended",
      existingId: existing.id,
      newItems: newModelItems,
      oldCount,
      newCount: mergedItems.length,
      combinedTotal: Number(existing.total) + incomingTotal,
    };
  }

  // No UPCs or models → treat as true duplicate (can't differentiate)
  return { type: "true_duplicate", existingId: existing.id };
}

// ── Merge extended invoice ────────────────────────────────
export async function mergeExtendedInvoice(
  existingId: string,
  newItems: LineItem[],
  combinedTotal: number,
  incomingDate: string,
  incomingFilename: string
) {
  // Get current record
  const { data: current } = await supabase
    .from("vendor_invoices")
    .select("line_items, shipment_count")
    .eq("id", existingId)
    .single();

  if (!current) throw new Error("Could not find existing record to merge");

  const existingItems = (
    Array.isArray(current.line_items) ? current.line_items : []
  ) as unknown as LineItem[];

  const mergedItems = [...existingItems, ...newItems];
  const shipmentCount = (current.shipment_count || 1) + 1;

  const { error } = await supabase
    .from("vendor_invoices")
    .update({
      line_items: mergedItems as any,
      total: combinedTotal,
      is_multi_shipment: true,
      shipment_count: shipmentCount,
      last_shipment_date: incomingDate,
      last_shipment_file: incomingFilename,
    })
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

  // Update all linked records
  await supabase
    .from("vendor_invoices")
    .update({ po_total_invoiced: poTotal })
    .eq("po_number", poNumber)
    .eq("vendor", normalizedVendor);

  return { count: data.length, total: poTotal };
}
