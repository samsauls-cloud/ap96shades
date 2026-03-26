import { supabase } from "@/integrations/supabase/client";
import type { LineItem, VendorInvoice } from "./supabase-queries";
import { getLineItems } from "./supabase-queries";

export type MatchStatus = "MATCHED" | "MATCHED_DISCO" | "IN_MASTER_ONLY" | "NEW_SKU" | "NO_UPC";

export interface MatchResult {
  lineItem: LineItem;
  lineIndex: number;
  status: MatchStatus;
  planogram?: PlanogramRecord;
  masterItem?: MasterRecord;
  priceFlag?: boolean; // invoice price > 5% above wholesale
}

export interface PlanogramRecord {
  upc: string | null;
  brand: string | null;
  model_number: string | null;
  is_vendor_discontinued: boolean | null;
  is_discontinued: boolean | null;
  frame_source: string | null;
  go_out_location: string | null;
  backstock_location: string | null;
  brand_key: string | null;
}

export interface MasterRecord {
  upc: string | null;
  brand: string | null;
  model_number: string | null;
  article_name: string | null;
  wholesale_price: number | null;
  retail_price: number | null;
  gender: string | null;
  frame_shape: string | null;
  size: string | null;
  color: string | null;
}

export const matchStatusConfig: Record<MatchStatus, { label: string; color: string }> = {
  MATCHED: { label: "Matched", color: "bg-status-paid/15 text-status-paid border-status-paid/30" },
  MATCHED_DISCO: { label: "Matched / Disco", color: "bg-status-unpaid/15 text-status-unpaid border-status-unpaid/30" },
  IN_MASTER_ONLY: { label: "In Master Only", color: "bg-yellow-500/15 text-yellow-500 border-yellow-500/30" },
  NEW_SKU: { label: "New SKU", color: "bg-status-disputed/15 text-status-disputed border-status-disputed/30" },
  NO_UPC: { label: "No UPC", color: "bg-muted text-muted-foreground border-border" },
};

async function fetchAllPlanogram(): Promise<PlanogramRecord[]> {
  const all: PlanogramRecord[] = [];
  let from = 0;
  const batchSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("current_planogram")
      .select("upc, brand, model_number, is_vendor_discontinued, is_discontinued, frame_source, go_out_location, backstock_location, brand_key")
      .range(from, from + batchSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as PlanogramRecord[]));
    if (data.length < batchSize) break;
    from += batchSize;
  }
  return all;
}

async function fetchAllMaster(): Promise<MasterRecord[]> {
  const all: MasterRecord[] = [];
  let from = 0;
  const batchSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("item_master")
      .select("upc, brand, model_number, article_name, wholesale_price, retail_price, gender, frame_shape, size, color")
      .range(from, from + batchSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as MasterRecord[]));
    if (data.length < batchSize) break;
    from += batchSize;
  }
  return all;
}

function normalize(v: string | undefined | null): string {
  return (v ?? "").trim().toLowerCase();
}

function findInList<T extends { upc: string | null; model_number: string | null }>(
  list: T[],
  upc: string | undefined | null,
  model: string | undefined | null
): T | undefined {
  const normUpc = normalize(upc);
  const normModel = normalize(model);

  if (normUpc) {
    const byUpc = list.find(r => normalize(r.upc) === normUpc);
    if (byUpc) return byUpc;
  }
  if (normModel) {
    const byModel = list.find(r => normalize(r.model_number) === normModel);
    if (byModel) return byModel;
  }
  return undefined;
}

export async function runMatchReport(invoice: VendorInvoice): Promise<MatchResult[]> {
  const [planogramData, masterData] = await Promise.all([
    fetchAllPlanogram(),
    fetchAllMaster(),
  ]);

  const lineItems = getLineItems(invoice);
  return lineItems.map((li, idx) => {
    const hasIdentifier = !!(normalize(li.upc) || normalize(li.model) || normalize(li.item_number));
    if (!hasIdentifier) {
      return { lineItem: li, lineIndex: idx, status: "NO_UPC" as MatchStatus };
    }

    const lookupUpc = li.upc;
    const lookupModel = li.model || li.item_number;

    const planogramMatch = findInList(planogramData, lookupUpc, lookupModel);
    const masterMatch = findInList(masterData, lookupUpc, lookupModel);

    let status: MatchStatus;
    if (planogramMatch) {
      const isDisco = planogramMatch.is_vendor_discontinued || planogramMatch.is_discontinued;
      status = isDisco ? "MATCHED_DISCO" : "MATCHED";
    } else if (masterMatch) {
      status = "IN_MASTER_ONLY";
    } else {
      status = "NEW_SKU";
    }

    const wholesalePrice = masterMatch?.wholesale_price;
    const invoicePrice = li.unit_price;
    let priceFlag = false;
    if (wholesalePrice && invoicePrice && wholesalePrice > 0) {
      priceFlag = invoicePrice > wholesalePrice * 1.05;
    }

    return {
      lineItem: li,
      lineIndex: idx,
      status,
      planogram: planogramMatch,
      masterItem: masterMatch,
      priceFlag,
    };
  });
}

export function matchResultsToCSV(invoice: VendorInvoice, results: MatchResult[]): string {
  const header = "Vendor,Invoice #,UPC,Model,Brand,Match Status,Planogram Status,Go Out Location,Backstock Location,Wholesale Price,Invoice Price,Price Flag";
  const rows = results.map(r => {
    const planoStatus = r.planogram
      ? (r.planogram.is_vendor_discontinued || r.planogram.is_discontinued ? "Discontinued" : "Active")
      : "—";
    return [
      invoice.vendor,
      invoice.invoice_number,
      r.lineItem.upc ?? "",
      r.lineItem.model ?? r.lineItem.item_number ?? "",
      r.lineItem.brand ?? "",
      r.status,
      planoStatus,
      r.planogram?.go_out_location ?? "",
      r.planogram?.backstock_location ?? "",
      r.masterItem?.wholesale_price ?? "",
      r.lineItem.unit_price ?? "",
      r.priceFlag ? "⚠ OVER" : "",
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",");
  });
  return [header, ...rows].join("\n");
}
