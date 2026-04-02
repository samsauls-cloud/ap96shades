import { supabase } from "@/integrations/supabase/client";
import type { VendorInvoice } from "@/lib/supabase-queries";
import { getLineItems } from "@/lib/supabase-queries";
import { fetchAllRows } from "@/lib/supabase-fetch-all";
import type { ReconciliationProgress } from "@/lib/reconciliation-engine";

const VENDOR_BRAND_MAP: Record<string, string[]> = {
  Luxottica: ["RAY-BAN", "OAKLEY", "OLIVER PEOPLES", "RALPH", "VOGUE", "PERSOL"],
  Kering: ["SAINT LAURENT", "GUCCI", "BOTTEGA VENETA", "CARTIER"],
  Marcolin: ["MIU MIU", "BURBERRY", "COACH", "MICHAEL KORS", "VERSACE"],
  Safilo: ["PRADA", "BOSS"],
  "Maui Jim": ["MAUI JIM"],
  Marchon: ["NIKE", "COLUMBIA", "DRAGON", "FLEXON", "CALVIN KLEIN", "LACOSTE", "SALVATORE FERRAGAMO", "MCM", "NAUTICA"],
  Chanel: ["CHANEL"],
  "Costa del Mar": ["COSTA DEL MAR"],
};

function getBrandForVendor(vendor: string): string | undefined {
  for (const [v, brands] of Object.entries(VENDOR_BRAND_MAP)) {
    if (vendor.toUpperCase().includes(v.toUpperCase())) return brands[0];
    for (const b of brands) {
      if (vendor.toUpperCase().includes(b)) return b;
    }
  }
  return undefined;
}

export type ReconScope =
  | { mode: "full" }
  | { mode: "stale_only" }
  | { mode: "vendor"; vendor: string }
  | { mode: "upc"; upcs: string[] }
  | { mode: "invoice"; invoice_ids: string[] };

function scopeDescription(scope: ReconScope): string {
  switch (scope.mode) {
    case "full": return "Full reconciliation — all records";
    case "stale_only": return "Stale records only — re-reconciling pending queue";
    case "vendor": return `Vendor-targeted — ${scope.vendor}`;
    case "upc": return `UPC-targeted — ${scope.upcs.length} UPCs`;
    case "invoice": return `Invoice-targeted — ${scope.invoice_ids.length} invoices`;
  }
}

function runTypeLabel(scope: ReconScope): string {
  switch (scope.mode) {
    case "full": return "full";
    case "stale_only": return "stale_only";
    case "vendor": return "targeted_vendor";
    case "upc": return "targeted_upc";
    case "invoice": return "targeted_invoice";
  }
}

interface Discrepancy {
  discrepancy_type: string;
  severity: string;
  vendor?: string;
  brand?: string;
  upc?: string;
  sku?: string;
  model_number?: string;
  invoice_id?: string;
  invoice_number?: string;
  invoice_date?: string;
  po_number?: string;
  ordered_qty?: number;
  invoiced_qty?: number;
  received_qty?: number;
  qty_delta?: number;
  ordered_unit_price?: number;
  invoiced_unit_price?: number;
  price_delta?: number;
  ordered_line_total?: number;
  invoiced_line_total?: number;
  amount_at_risk?: number;
}

export async function runTargetedReconciliation(
  scope: ReconScope,
  onProgress?: (p: ReconciliationProgress) => void
) {
  const report = (step: string, detail: string) => onProgress?.({ step, detail });

  // 1. Determine which invoices to process
  report("Resolving scope…", scopeDescription(scope));

  let invoiceIds: string[] = [];

  if (scope.mode === "stale_only") {
    const { data: queue } = await supabase
      .from("recon_stale_queue")
      .select("entity_id")
      .eq("status", "pending")
      .eq("entity_type", "invoice");
    invoiceIds = [...new Set((queue ?? []).map(q => q.entity_id).filter(Boolean) as string[])];
  } else if (scope.mode === "vendor") {
    const { data } = await supabase
      .from("vendor_invoices")
      .select("id")
      .eq("vendor", scope.vendor);
    invoiceIds = (data ?? []).map(d => d.id);
  } else if (scope.mode === "upc") {
    const { data: allInv } = await supabase
      .from("vendor_invoices")
      .select("id, line_items");
    const targetUpcs = new Set(scope.upcs);
    for (const inv of allInv ?? []) {
      const items = Array.isArray(inv.line_items) ? inv.line_items : [];
      for (const li of items) {
        if (targetUpcs.has((li as any)?.upc?.trim())) {
          invoiceIds.push(inv.id);
          break;
        }
      }
    }
  } else if (scope.mode === "invoice") {
    invoiceIds = scope.invoice_ids;
  } else {
    const { runFullReconciliation } = await import("@/lib/reconciliation-engine");
    return runFullReconciliation(onProgress);
  }

  if (invoiceIds.length === 0) {
    report("Complete", "No records in scope to reconcile");
    return { runId: null, totalInvoices: 0, totalPOLines: 0, totalDiscrepancies: 0, totalAmountAtRisk: 0 };
  }

  // 2. Fetch the scoped invoices
  report("Loading invoices…", `Processing ${invoiceIds.length} invoices`);
  const invoices: VendorInvoice[] = [];
  for (let i = 0; i < invoiceIds.length; i += 50) {
    const batch = invoiceIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("vendor_invoices")
      .select("*")
      .in("id", batch);
    if (error) throw error;
    invoices.push(...(data ?? []));
  }

  // 3. Fetch PO receiving lines + item master + assortment in parallel
  report("Loading receiving data…", "Cross-referencing procurement");
  const [recLines, itemMasterData, assortmentData] = await Promise.all([
    fetchAllRows("po_receiving_lines", { label: "targeted_po_lines" }),
    fetchAllRows("item_master", { select: "upc", label: "targeted_item_master" }),
    fetchAllRows("master_assortment", { select: "upc", label: "targeted_assortment" }),
  ]);
  const itemMasterUPCs = new Set(itemMasterData.map((r: any) => r.upc).filter(Boolean));
  const assortmentUPCs = new Set(assortmentData.map((r: any) => r.upc).filter(Boolean));

  const recLinesByUPC = new Map<string, typeof recLines>();
  for (const rl of recLines) {
    const upc = rl.upc?.trim();
    if (!upc) continue;
    if (!recLinesByUPC.has(upc)) recLinesByUPC.set(upc, []);
    recLinesByUPC.get(upc)!.push(rl);
  }
  const allKnownUPCs = new Set([...itemMasterUPCs, ...assortmentUPCs, ...recLinesByUPC.keys()]);

  // 5. Delete existing OPEN discrepancies for scoped invoices (keep resolved/waived)
  report("Clearing stale discrepancies…", "Removing open issues for re-check");
  for (let i = 0; i < invoiceIds.length; i += 50) {
    const batch = invoiceIds.slice(i, i + 50);
    await supabase
      .from("reconciliation_discrepancies")
      .delete()
      .in("invoice_id", batch)
      .eq("resolution_status", "open");
  }

  // 6. Run all 7 checks on scoped invoices
  report("Running checks…", "Comparing quantities, prices, duplicates…");
  const discrepancies: Discrepancy[] = [];

  const invoicesByKey = new Map<string, VendorInvoice[]>();
  const invoiceUPCs = new Set<string>();

  for (const inv of invoices) {
    const key = `${inv.vendor}::${inv.invoice_number}`;
    if (!invoicesByKey.has(key)) invoicesByKey.set(key, []);
    invoicesByKey.get(key)!.push(inv);

    const lines = getLineItems(inv);
    for (const li of lines) {
      const upc = li.upc?.trim();
      if (!upc) continue;
      invoiceUPCs.add(upc);

      const matchedRecLines = recLinesByUPC.get(upc);
      if (!matchedRecLines || matchedRecLines.length === 0) continue;
      const recLine = matchedRecLines[0];
      const invoicedQty = li.qty_shipped ?? li.qty_ordered ?? li.qty ?? 0;
      const orderedQty = recLine.order_qty ?? 0;
      const receivedQty = recLine.received_qty ?? 0;

      // CHECK 1 — QTY_MISMATCH
      if (invoicedQty !== orderedQty && orderedQty > 0) {
        const delta = invoicedQty - orderedQty;
        discrepancies.push({
          discrepancy_type: "QTY_MISMATCH",
          severity: Math.abs(delta) > 5 ? "critical" : "warning",
          vendor: inv.vendor, brand: li.brand ?? getBrandForVendor(inv.vendor),
          upc, sku: li.item_number, model_number: li.model,
          invoice_id: inv.id, invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date, po_number: inv.po_number ?? undefined,
          ordered_qty: orderedQty, invoiced_qty: invoicedQty, received_qty: receivedQty,
          qty_delta: delta, amount_at_risk: Math.abs(delta) * (li.unit_price ?? 0),
        });
      }

      // CHECK 2 — PRICE_MISMATCH
      const invoicedPrice = li.unit_price ?? 0;
      const orderedPrice = recLine.unit_cost ?? 0;
      if (orderedPrice > 0 && Math.abs(invoicedPrice - orderedPrice) > 0.50) {
        const priceDelta = invoicedPrice - orderedPrice;
        const atRisk = priceDelta * invoicedQty;
        discrepancies.push({
          discrepancy_type: "PRICE_MISMATCH",
          severity: Math.abs(atRisk) > 100 ? "critical" : "warning",
          vendor: inv.vendor, brand: li.brand ?? getBrandForVendor(inv.vendor),
          upc, sku: li.item_number, model_number: li.model,
          invoice_id: inv.id, invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date, po_number: inv.po_number ?? undefined,
          ordered_unit_price: orderedPrice, invoiced_unit_price: invoicedPrice,
          price_delta: priceDelta, invoiced_qty: invoicedQty,
          amount_at_risk: Math.abs(atRisk),
        });
      }

      // CHECK 6 — UPC_NOT_FOUND
      if (!allKnownUPCs.has(upc)) {
        discrepancies.push({
          discrepancy_type: "UPC_NOT_FOUND", severity: "info",
          vendor: inv.vendor, brand: li.brand ?? getBrandForVendor(inv.vendor),
          upc, sku: li.item_number, model_number: li.model,
          invoice_id: inv.id, invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date,
        });
      }
    }

    // CHECK 3 — INVOICE_NO_PO
    if (inv.doc_type === "INVOICE" && (!inv.po_number || inv.po_number.trim() === "")) {
      discrepancies.push({
        discrepancy_type: "INVOICE_NO_PO", severity: "warning",
        vendor: inv.vendor, invoice_id: inv.id,
        invoice_number: inv.invoice_number, invoice_date: inv.invoice_date,
        amount_at_risk: inv.total,
      });
    }

    // CHECK 7 — OVERPAYMENT / UNDERPAYMENT
    if (lines.length > 0) {
      const lineSum = lines.reduce((s, li) => s + (li.line_total ?? 0), 0);
      const delta = inv.total - lineSum;
      if (Math.abs(delta) > 1) {
        discrepancies.push({
          discrepancy_type: delta > 0 ? "OVERPAYMENT" : "UNDERPAYMENT",
          severity: "warning", vendor: inv.vendor,
          invoice_id: inv.id, invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date, po_number: inv.po_number ?? undefined,
          invoiced_line_total: lineSum, ordered_line_total: inv.total,
          amount_at_risk: Math.abs(delta),
        });
      }
    }
  }

  // CHECK 5 — DUPLICATE_INVOICE
  for (const [, group] of invoicesByKey) {
    if (group.length > 1) {
      for (const inv of group) {
        discrepancies.push({
          discrepancy_type: "DUPLICATE_INVOICE", severity: "critical",
          vendor: inv.vendor, invoice_id: inv.id,
          invoice_number: inv.invoice_number, invoice_date: inv.invoice_date,
          po_number: inv.po_number ?? undefined, amount_at_risk: inv.total,
        });
      }
    }
  }

  // 7. Persist results
  report("Saving results…", "Creating reconciliation run record");
  const totalAtRisk = discrepancies.reduce((s, d) => s + (d.amount_at_risk ?? 0), 0);

  const { data: run, error: runErr } = await supabase
    .from("reconciliation_runs")
    .insert({
      total_invoices_checked: invoices.length,
      total_po_lines_checked: recLines.length,
      total_discrepancies: discrepancies.length,
      total_amount_at_risk: totalAtRisk,
      status: "complete",
      run_type: runTypeLabel(scope),
      scope_description: scopeDescription(scope),
      notes: `Targeted re-reconciliation — ${scopeDescription(scope)}`,
    } as any)
    .select()
    .single();
  if (runErr) throw runErr;

  // Insert discrepancies in batches
  if (discrepancies.length > 0) {
    const batchSize = 100;
    for (let i = 0; i < discrepancies.length; i += batchSize) {
      const batch = discrepancies.slice(i, i + batchSize).map(d => ({
        ...d, run_id: run.id,
      }));
      const { error: dErr } = await supabase
        .from("reconciliation_discrepancies")
        .insert(batch as any);
      if (dErr) throw dErr;
    }
  }

  // 8. Update vendor_invoices recon status
  const invoiceDiscrepancyMap = new Map<string, boolean>();
  for (const d of discrepancies) {
    if (d.invoice_id) invoiceDiscrepancyMap.set(d.invoice_id, true);
  }

  for (const inv of invoices) {
    const hasDis = invoiceDiscrepancyMap.has(inv.id);
    await supabase
      .from("vendor_invoices")
      .update({
        recon_status: hasDis ? "discrepancy" : "clean",
        has_discrepancy: hasDis,
        recon_run_id: run.id,
        last_reconciled_at: new Date().toISOString(),
        recon_stale: false,
        recon_stale_reason: null,
      } as any)
      .eq("id", inv.id);
  }

  // 9. Mark processed stale queue rows
  if (scope.mode === "stale_only") {
    await supabase
      .from("recon_stale_queue")
      .update({ status: "re_reconciled", processed_at: new Date().toISOString() } as any)
      .eq("status", "pending")
      .eq("entity_type", "invoice")
      .in("entity_id", invoiceIds);
  } else {
    for (let i = 0; i < invoiceIds.length; i += 50) {
      const batch = invoiceIds.slice(i, i + 50);
      await supabase
        .from("recon_stale_queue")
        .update({ status: "re_reconciled", processed_at: new Date().toISOString() } as any)
        .eq("status", "pending")
        .in("entity_id", batch);
    }
  }

  report("Complete", `Found ${discrepancies.length} discrepancies across ${invoices.length} invoices`);

  return {
    runId: run.id,
    totalInvoices: invoices.length,
    totalPOLines: recLines.length,
    totalDiscrepancies: discrepancies.length,
    totalAmountAtRisk: totalAtRisk,
  };
}
