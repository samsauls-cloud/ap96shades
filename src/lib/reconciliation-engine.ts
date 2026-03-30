import { supabase } from "@/integrations/supabase/client";
import type { VendorInvoice, LineItem } from "@/lib/supabase-queries";
import { getLineItems } from "@/lib/supabase-queries";
import { fetchAllRows } from "@/lib/supabase-fetch-all";

/** Safely coerce a value to number — treats "", null, undefined, NaN as 0 */
function safeNum(v: any): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

// Vendor → Brand mapping
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

export interface ReconciliationProgress {
  step: string;
  detail: string;
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

export async function runFullReconciliation(
  onProgress?: (p: ReconciliationProgress) => void
) {
  const report = (step: string, detail: string) => onProgress?.({ step, detail });

  // 1. Fetch all invoices
  report("Scanning invoices…", "Loading all vendor invoices");
  const invoices = await fetchAllRows<VendorInvoice>("vendor_invoices", {
    orderBy: "invoice_date",
    ascending: false,
  });

  // 2. Fetch PO receiving lines
  report("Checking procurement orders…", "Loading receiving data");
  const recLines = await fetchAllRows("po_receiving_lines");

  // 3. Fetch item master for UPC validation
  const itemMasterData = await fetchAllRows("item_master", { select: "upc" });
  const itemMasterUPCs = new Set(itemMasterData.map(r => r.upc).filter(Boolean));

  // 4. Fetch master assortment UPCs
  const assortmentData = await fetchAllRows("master_assortment", { select: "upc" });
  const assortmentUPCs = new Set(assortmentData.map(r => r.upc).filter(Boolean));

  // Build lookup maps
  const recLinesByUPC = new Map<string, typeof recLines>();
  for (const rl of recLines) {
    const upc = rl.upc?.trim();
    if (!upc) continue;
    if (!recLinesByUPC.has(upc)) recLinesByUPC.set(upc, []);
    recLinesByUPC.get(upc)!.push(rl);
  }

  const allKnownUPCs = new Set([...itemMasterUPCs, ...assortmentUPCs, ...recLinesByUPC.keys()]);

  const discrepancies: Discrepancy[] = [];

  // CHECK 1 & 2 — QTY_MISMATCH & PRICE_MISMATCH
  report("Comparing quantities…", "Cross-referencing invoice lines vs receiving data");
  for (const inv of invoices) {
    const lines = getLineItems(inv);
    for (const li of lines) {
      const upc = li.upc?.trim();
      if (!upc) continue;
      const matchedRecLines = recLinesByUPC.get(upc);
      if (!matchedRecLines || matchedRecLines.length === 0) continue;

      const recLine = matchedRecLines[0];
      const invoicedQty = safeNum(li.qty_shipped) || safeNum(li.qty_ordered) || safeNum(li.qty);
      const orderedQty = safeNum(recLine.order_qty);
      const receivedQty = safeNum(recLine.received_qty);

      // CHECK 1 — QTY_MISMATCH
      if (invoicedQty !== orderedQty && orderedQty > 0) {
        const delta = invoicedQty - orderedQty;
        discrepancies.push({
          discrepancy_type: "QTY_MISMATCH",
          severity: Math.abs(delta) > 5 ? "critical" : "warning",
          vendor: inv.vendor,
          brand: li.brand ?? getBrandForVendor(inv.vendor),
          upc,
          sku: li.item_number,
          model_number: li.model,
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date,
          po_number: inv.po_number ?? undefined,
          ordered_qty: orderedQty,
          invoiced_qty: invoicedQty,
          received_qty: receivedQty,
          qty_delta: delta,
          amount_at_risk: Math.abs(delta) * safeNum(li.unit_price),
        });
      }

      // CHECK 2 — PRICE_MISMATCH
      const invoicedPrice = safeNum(li.unit_price);
      const orderedPrice = safeNum(recLine.unit_cost);
      if (orderedPrice > 0 && Math.abs(invoicedPrice - orderedPrice) > 0.50) {
        const priceDelta = invoicedPrice - orderedPrice;
        const atRisk = priceDelta * invoicedQty;
        discrepancies.push({
          discrepancy_type: "PRICE_MISMATCH",
          severity: Math.abs(atRisk) > 100 ? "critical" : "warning",
          vendor: inv.vendor,
          brand: li.brand ?? getBrandForVendor(inv.vendor),
          upc,
          sku: li.item_number,
          model_number: li.model,
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date,
          po_number: inv.po_number ?? undefined,
          ordered_unit_price: orderedPrice,
          invoiced_unit_price: invoicedPrice,
          price_delta: priceDelta,
          invoiced_qty: invoicedQty,
          amount_at_risk: Math.abs(atRisk),
        });
      }
    }
  }

  // CHECK 3 — INVOICE_NO_PO
  report("Comparing prices…", "Checking invoices without PO numbers");
  for (const inv of invoices) {
    if (inv.doc_type !== "INVOICE") continue;
    if (!inv.po_number || inv.po_number.trim() === "") {
      discrepancies.push({
        discrepancy_type: "INVOICE_NO_PO",
        severity: "warning",
        vendor: inv.vendor,
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date,
        amount_at_risk: inv.total,
      });
    }
  }

  // CHECK 4 — PO_NO_INVOICE
  report("Checking for duplicates…", "Verifying all procured items have invoices");
  const invoiceUPCs = new Set<string>();
  for (const inv of invoices) {
    for (const li of getLineItems(inv)) {
      if (li.upc?.trim()) invoiceUPCs.add(li.upc.trim());
    }
  }
  for (const rl of recLines) {
    const upc = rl.upc?.trim();
    if (!upc) continue;
    if ((rl.order_qty ?? 0) > 0 && !invoiceUPCs.has(upc)) {
      discrepancies.push({
        discrepancy_type: "PO_NO_INVOICE",
        severity: "warning",
        upc,
        sku: rl.manufact_sku ?? undefined,
        model_number: rl.item_description ?? undefined,
        ordered_qty: rl.order_qty ?? undefined,
        received_qty: rl.received_qty ?? undefined,
        amount_at_risk: (rl.order_qty ?? 0) * (rl.unit_cost ?? 0),
      });
    }
  }

  // CHECK 5 — DUPLICATE_INVOICE
  const invoicesByKey = new Map<string, VendorInvoice[]>();
  for (const inv of invoices) {
    const key = `${inv.vendor}::${inv.invoice_number}`;
    if (!invoicesByKey.has(key)) invoicesByKey.set(key, []);
    invoicesByKey.get(key)!.push(inv);
  }
  for (const [, group] of invoicesByKey) {
    if (group.length > 1) {
      for (const inv of group) {
        discrepancies.push({
          discrepancy_type: "DUPLICATE_INVOICE",
          severity: "critical",
          vendor: inv.vendor,
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date,
          po_number: inv.po_number ?? undefined,
          amount_at_risk: inv.total,
        });
      }
    }
  }

  // CHECK 6 — UPC_NOT_FOUND
  for (const inv of invoices) {
    for (const li of getLineItems(inv)) {
      const upc = li.upc?.trim();
      if (!upc) continue;
      if (!allKnownUPCs.has(upc)) {
        discrepancies.push({
          discrepancy_type: "UPC_NOT_FOUND",
          severity: "info",
          vendor: inv.vendor,
          brand: li.brand ?? getBrandForVendor(inv.vendor),
          upc,
          sku: li.item_number,
          model_number: li.model,
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date,
        });
      }
    }
  }

  // CHECK 7 — OVERPAYMENT / UNDERPAYMENT
  report("Updating ledger…", "Checking invoice totals vs line item sums");
  for (const inv of invoices) {
    const lines = getLineItems(inv);
    if (lines.length === 0) continue;
    const lineSum = lines.reduce((s, li) => s + safeNum(li.line_total), 0);
    const delta = inv.total - lineSum;
    if (Math.abs(delta) > 1) {
      discrepancies.push({
        discrepancy_type: delta > 0 ? "OVERPAYMENT" : "UNDERPAYMENT",
        severity: "warning",
        vendor: inv.vendor,
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date,
        po_number: inv.po_number ?? undefined,
        invoiced_line_total: lineSum,
        ordered_line_total: inv.total,
        amount_at_risk: Math.abs(delta),
      });
    }
  }

  // Persist results
  report("Complete", "Saving reconciliation results");

  const totalAtRisk = discrepancies.reduce((s, d) => s + (d.amount_at_risk ?? 0), 0);

  // Insert run
  const { data: run, error: runErr } = await supabase
    .from("reconciliation_runs")
    .insert({
      total_invoices_checked: invoices.length,
      total_po_lines_checked: recLines.length,
      total_discrepancies: discrepancies.length,
      total_amount_at_risk: totalAtRisk,
      status: "complete",
    })
    .select()
    .single();
  if (runErr) throw runErr;

  // Insert discrepancies in batches
  if (discrepancies.length > 0) {
    const batchSize = 100;
    for (let i = 0; i < discrepancies.length; i += batchSize) {
      const batch = discrepancies.slice(i, i + batchSize).map(d => ({
        ...d,
        run_id: run.id,
      }));
      const { error: dErr } = await supabase
        .from("reconciliation_discrepancies")
        .insert(batch as any);
      if (dErr) throw dErr;
    }
  }

  // Update vendor_invoices recon status
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
      } as any)
      .eq("id", inv.id);
  }

  return {
    runId: run.id,
    totalInvoices: invoices.length,
    totalPOLines: recLines.length,
    totalDiscrepancies: discrepancies.length,
    totalAmountAtRisk: totalAtRisk,
  };
}
