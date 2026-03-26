import { supabase } from "@/integrations/supabase/client";
import type { LineItem, VendorInvoice } from "./supabase-queries";
import { getLineItems } from "./supabase-queries";

export type MatchStatus = "MATCHED" | "DISCO" | "IN_N1" | "NEW_SKU" | "NO_UPC";

export interface MatchResult {
  lineItem: LineItem;
  lineIndex: number;
  status: MatchStatus;
  assortmentRecord?: AssortmentRecord;
  priceFlag?: boolean;
}

export interface AssortmentRecord {
  system_id: string | null;
  vendor: string | null;
  brand: string | null;
  upc: string | null;
  assortment: string | null;
  go_out_location: string | null;
  backstock_location: string | null;
  title: string | null;
  model: string | null;
  color: string | null;
  size: string | null;
  wholesale: number | null;
  msrp: number | null;
  default_price: number | null;
  image_url: string | null;
}

export const matchStatusConfig: Record<MatchStatus, { label: string; color: string }> = {
  MATCHED:  { label: "Matched",  color: "bg-status-paid/15 text-status-paid border-status-paid/30" },
  DISCO:    { label: "Disco",    color: "bg-status-unpaid/15 text-status-unpaid border-status-unpaid/30" },
  IN_N1:    { label: "In N1",    color: "bg-status-partial/15 text-status-partial border-status-partial/30" },
  NEW_SKU:  { label: "New SKU",  color: "bg-status-disputed/15 text-status-disputed border-status-disputed/30" },
  NO_UPC:   { label: "No UPC",   color: "bg-muted text-muted-foreground border-border" },
};

async function fetchAllAssortment(): Promise<AssortmentRecord[]> {
  const all: AssortmentRecord[] = [];
  let from = 0;
  const batchSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("master_assortment")
      .select("system_id, vendor, brand, upc, assortment, go_out_location, backstock_location, title, model, color, size, wholesale, msrp, default_price, image_url")
      .range(from, from + batchSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as AssortmentRecord[]));
    if (data.length < batchSize) break;
    from += batchSize;
  }
  return all;
}

function normalize(v: string | undefined | null): string {
  return (v ?? "").trim().toLowerCase();
}

function findMatch(
  list: AssortmentRecord[],
  upc: string | undefined | null,
  model: string | undefined | null
): AssortmentRecord | undefined {
  const normUpc = normalize(upc);
  const normModel = normalize(model);

  if (normUpc) {
    const byUpc = list.find(r => normalize(r.upc) === normUpc);
    if (byUpc) return byUpc;
  }
  if (normModel) {
    const byModel = list.find(r => normalize(r.model) === normModel);
    if (byModel) return byModel;
  }
  return undefined;
}

export async function runMatchReport(invoice: VendorInvoice): Promise<MatchResult[]> {
  const assortmentData = await fetchAllAssortment();
  const lineItems = getLineItems(invoice);

  return lineItems.map((li, idx) => {
    const hasIdentifier = !!(normalize(li.upc) || normalize(li.model) || normalize(li.item_number));
    if (!hasIdentifier) {
      return { lineItem: li, lineIndex: idx, status: "NO_UPC" as MatchStatus };
    }

    const lookupUpc = li.upc;
    const lookupModel = li.model || li.item_number;
    const match = findMatch(assortmentData, lookupUpc, lookupModel);

    let status: MatchStatus;
    if (!match) {
      status = "NEW_SKU";
    } else {
      const assort = (match.assortment ?? "").toUpperCase();
      if (assort === "26_DISCO") {
        status = "DISCO";
      } else if (assort === "N1") {
        status = "IN_N1";
      } else {
        status = "MATCHED"; // CARRYOVER, NEW, or other active
      }
    }

    let priceFlag = false;
    if (match?.wholesale && li.unit_price && match.wholesale > 0) {
      priceFlag = li.unit_price > match.wholesale * 1.05;
    }

    return {
      lineItem: li,
      lineIndex: idx,
      status,
      assortmentRecord: match,
      priceFlag,
    };
  });
}

export function matchResultsToCSV(invoice: VendorInvoice, results: MatchResult[]): string {
  const header = "Vendor,Invoice #,UPC,Model,Brand,Match Status,Assortment,Go Out Location,Backstock Location,Wholesale,Invoice Price,Price Flag";
  const rows = results.map(r => {
    return [
      invoice.vendor,
      invoice.invoice_number,
      r.lineItem.upc ?? "",
      r.lineItem.model ?? r.lineItem.item_number ?? "",
      r.lineItem.brand ?? "",
      r.status,
      r.assortmentRecord?.assortment ?? "",
      r.assortmentRecord?.go_out_location ?? "",
      r.assortmentRecord?.backstock_location ?? "",
      r.assortmentRecord?.wholesale ?? "",
      r.lineItem.unit_price ?? "",
      r.priceFlag ? "⚠ OVER" : "",
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",");
  });
  return [header, ...rows].join("\n");
}
