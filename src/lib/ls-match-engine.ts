import { getLineItems } from "@/lib/supabase-queries";

/* ── Vendor alias map ── */
const VENDOR_ALIASES: Record<string, string[]> = {
  Luxottica: ["Luxottica", "EOL"],
  Kering: ["Kering"],
  "Maui Jim": ["Maui Jim"],
  Safilo: ["Safilo"],
  Marcolin: ["Marcolin"],
  Marchon: ["Marchon"],
};

export function getVendorAliases(vendor: string): string[] {
  return VENDOR_ALIASES[vendor] ?? [vendor];
}

/* ── Model code normalisation ── */

/** Extract model code like "439 - 2M" from a pipe-delimited LS description */
function extractModelCode(desc: string): string | null {
  // Pattern: letters/digits + " - " + letters/digits, between pipes
  const m = desc.match(/\|\s*([A-Z]?\d[\w]*\s*-\s*[\w]+)\s*\|/i);
  return m ? m[1].replace(/\s+/g, "").toUpperCase() : null;
}

/** Extract all model codes from LS description (some have multiple) */
function extractAllModelCodes(desc: string): string[] {
  const codes: string[] = [];
  // Standard pipe-delimited model codes
  const m = desc.match(/\|\s*([A-Z]?\d[\w]*\s*-\s*[\w]+)\s*\|/gi);
  if (m) {
    for (const match of m) {
      const inner = match.replace(/^\||\|$/g, "").trim().replace(/\s+/g, "").toUpperCase();
      if (inner) codes.push(inner);
    }
  }
  return codes;
}

/** Convert MM invoice item "MM327-002" → normalised model code "327-02" */
function mmToModelCode(item: string): string | null {
  const m = item.match(/^MM(\d+)-(\d+\w*)$/i);
  if (!m) return null;
  // Remove leading zeros from color code: "002" → "02"
  const color = m[2].replace(/^0+/, "") || "0";
  return `${m[1]}-${color}`.toUpperCase();
}

/** Normalise an invoice item_number for comparison (strip spaces, uppercase) */
function normaliseItemNumber(s: string): string {
  return s.replace(/\s+/g, "").toUpperCase();
}

/* ── Types ── */

export interface LSMatchResult {
  invoiceId: string;
  invoiceNumber: string;
  vendor: string;
  invoiceTotal: number;
  invoiceQtyShipped: number;
  lsQtyReceived: number;
  qtyVariance: number;
  sessionsMatched: number;
  status: "fully_received" | "partial" | "not_found";
}

/* ── Build match map (used by both Reconciliation and Audit) ── */

export function buildLSMatchResults(
  invoices: any[],
  sessions: any[],
  lines: any[],
): LSMatchResult[] {
  // Index lines by session
  const linesBySession = new Map<string, any[]>();
  for (const l of lines) {
    if (!linesBySession.has(l.session_id)) linesBySession.set(l.session_id, []);
    linesBySession.get(l.session_id)!.push(l);
  }

  // Build UPC → receiving lines index by vendor
  const upcByVendor = new Map<string, Map<string, any[]>>();
  // Build model-code → receiving lines index by vendor (for Maui Jim etc.)
  const modelByVendor = new Map<string, Map<string, any[]>>();

  for (const s of sessions) {
    const sLines = linesBySession.get(s.id) ?? [];
    for (const l of sLines) {
      const tag = { ...l, _sessionId: s.id };

      // UPC index
      if (l.upc) {
        const upc = l.upc.replace(/^0+/, "");
        if (!upcByVendor.has(s.vendor)) upcByVendor.set(s.vendor, new Map());
        const vm = upcByVendor.get(s.vendor)!;
        if (!vm.has(upc)) vm.set(upc, []);
        vm.get(upc)!.push(tag);
      }

      // Model-code index (from item_description)
      if (l.item_description) {
        const mc = extractModelCode(l.item_description);
        if (mc) {
          if (!modelByVendor.has(s.vendor)) modelByVendor.set(s.vendor, new Map());
          const mm = modelByVendor.get(s.vendor)!;
          if (!mm.has(mc)) mm.set(mc, []);
          mm.get(mc)!.push(tag);
        }
      }
    }
  }

  const results: LSMatchResult[] = [];

  for (const inv of invoices) {
    if (inv.doc_type !== "INVOICE") continue;

    const lineItems = getLineItems(inv);
    const invoiceQtyShipped = lineItems.reduce((s: number, li: any) =>
      s + (Number(li.qty_shipped) || Number(li.qty_ordered) || Number(li.qty) || 0), 0);

    const invoiceUPCs = new Set(
      lineItems.map((li: any) => (li.upc ?? "").replace(/^0+/, "")).filter(Boolean)
    );
    const invoiceItemNumbers = new Set(
      lineItems.map((li: any) => normaliseItemNumber(li.item_number ?? "")).filter(Boolean)
    );

    const matchedSessions = new Set<string>();
    const matchedLineIds = new Set<string>();

    // Method 1: Direct links
    if (inv.reconciled_session_id) matchedSessions.add(inv.reconciled_session_id);
    for (const s of sessions) {
      if (s.reconciled_invoice_id === inv.id) matchedSessions.add(s.id);
    }

    const aliases = getVendorAliases(inv.vendor);

    // Method 2: UPC matching
    for (const alias of aliases) {
      const vendorUPCs = upcByVendor.get(alias);
      if (!vendorUPCs) continue;
      for (const upc of invoiceUPCs) {
        const ml = vendorUPCs.get(upc);
        if (ml) ml.forEach(m => { matchedSessions.add(m._sessionId); matchedLineIds.add(m.id); });
      }
    }

    // Method 3: Model-code / item_number matching (fallback for vendors without UPCs)
    if (invoiceUPCs.size === 0 && invoiceItemNumbers.size > 0) {
      for (const alias of aliases) {
        const vendorModels = modelByVendor.get(alias);
        if (!vendorModels) continue;
        for (const itemNum of invoiceItemNumbers) {
          const ml = vendorModels.get(itemNum);
          if (ml) ml.forEach(m => { matchedSessions.add(m._sessionId); matchedLineIds.add(m.id); });
        }
      }
    }

    // Calculate received qty
    let lsQtyReceived = 0;
    if (invoiceUPCs.size > 0) {
      // UPC-based qty counting
      for (const sid of matchedSessions) {
        const sLines = linesBySession.get(sid) ?? [];
        for (const l of sLines) {
          const upc = (l.upc ?? "").replace(/^0+/, "");
          if (invoiceUPCs.has(upc)) lsQtyReceived += Number(l.received_qty) || 0;
        }
      }
    } else {
      // Model-code based qty counting
      for (const sid of matchedSessions) {
        const sLines = linesBySession.get(sid) ?? [];
        for (const l of sLines) {
          if (l.item_description) {
            const mc = extractModelCode(l.item_description);
            if (mc && invoiceItemNumbers.has(mc)) {
              lsQtyReceived += Number(l.received_qty) || 0;
            }
          }
        }
      }
    }

    const qtyVariance = invoiceQtyShipped - lsQtyReceived;
    let status: LSMatchResult["status"] = "not_found";
    if (matchedSessions.size > 0) status = qtyVariance <= 0 ? "fully_received" : "partial";

    results.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number,
      vendor: inv.vendor,
      invoiceTotal: Number(inv.total),
      invoiceQtyShipped,
      lsQtyReceived,
      qtyVariance,
      sessionsMatched: matchedSessions.size,
      status,
    });
  }

  return results;
}

/** Convenience: build as a Map keyed by invoiceId */
export function buildLSMatchMap(
  invoices: any[], sessions: any[], lines: any[]
): Map<string, LSMatchResult> {
  const results = buildLSMatchResults(invoices, sessions, lines);
  const map = new Map<string, LSMatchResult>();
  for (const r of results) map.set(r.invoiceId, r);
  return map;
}
