import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabase-fetch-all";
import { getLineItems } from "@/lib/supabase-queries";
import { getVendorAliases } from "@/lib/ls-match-engine";

/* ── Types ── */

export type MatchConfidence = "exact" | "high" | "medium" | "low" | "manual" | "legacy";
export type MatchMethod = "po_number" | "upc" | "model_code" | "value" | "manual" | "legacy";

export interface TwoWayMatchResult {
  invoiceId: string;
  invoiceNumber: string;
  vendor: string;
  receivingLineIds: string[];
  sessionIds: string[];
  confidence: MatchConfidence;
  method: MatchMethod;
  upcOverlapPct: number;
  notes: string;
}

/* ── Normalisation helpers ── */

function stripLeadingZeros(s: string): string {
  return s.replace(/^0+/, "");
}

function normalise(s: string): string {
  return s.replace(/\s+/g, "").toUpperCase();
}

/** Extract model code like "439-2M" from pipe-delimited LS description */
function extractModelCode(desc: string): string | null {
  const m = desc.match(/\|\s*([A-Z]?\d[\w]*\s*-\s*[\w]+)\s*\|/i);
  return m ? m[1].replace(/\s+/g, "").toUpperCase() : null;
}

/* ── Core matching logic ── */

export interface MatchEngineInput {
  invoices: any[];
  receivingLines: any[];
  sessions: any[];
}

/**
 * Run the two-way match engine across all unmatched invoices and receiving lines.
 * Returns match results and updates both tables in the database.
 */
export async function runTwoWayMatchEngine(
  input?: MatchEngineInput,
): Promise<{
  matched: TwoWayMatchResult[];
  unmatchedInvoices: any[];
  unmatchedReceipts: any[];
  stats: { total: number; matched: number; invoicesWaiting: number; receiptsWaiting: number };
}> {
  // Fetch data if not provided
  const invoices = input?.invoices ?? await fetchAllRows("vendor_invoices");
  const receivingLines = input?.receivingLines ?? await fetchAllRows("po_receiving_lines");
  const sessions = input?.sessions ?? await fetchAllRows("po_receiving_sessions");

  // Get vendor alias map for type filtering
  const { data: aliasRows } = await supabase.from("vendor_alias_map").select("vendor_id, vendor_name, vendor_type, aliases");
  const accessoryVendorIds = new Set(
    (aliasRows ?? []).filter((a: any) => a.vendor_type === "accessories").map((a: any) => a.vendor_id)
  );

  // Only match INVOICE doc_type, non-proforma
  const matchableInvoices = (invoices as any[]).filter(
    (i) => i.doc_type === "INVOICE" && i.terms_status !== "proforma"
  );

  // Filter out accessory receiving lines
  const matchableLines = (receivingLines as any[]).filter(
    (l) => !accessoryVendorIds.has(l.vendor_id)
  );

  // Build indexes
  // UPC → receiving lines (by vendor_id)
  const upcIndex = new Map<string, Map<string, any[]>>(); // vendor_id → upc → lines[]
  // PO → receiving lines
  const poIndex = new Map<string, any[]>(); // custom_sku/manufact_sku → lines[]
  // Model code → receiving lines (by vendor_id)
  const modelIndex = new Map<string, Map<string, any[]>>();

  // Session lookup
  const sessionMap = new Map<string, any>();
  for (const s of sessions as any[]) sessionMap.set(s.id, s);

  for (const l of matchableLines) {
    const vid = l.vendor_id ?? "";

    // UPC index
    if (l.upc) {
      const upc = stripLeadingZeros(l.upc);
      if (!upcIndex.has(vid)) upcIndex.set(vid, new Map());
      const vm = upcIndex.get(vid)!;
      if (!vm.has(upc)) vm.set(upc, []);
      vm.get(upc)!.push(l);
    }

    // PO index (custom_sku, manufact_sku, po_number)
    for (const field of [l.custom_sku, l.manufact_sku, l.po_number]) {
      if (field && field.trim()) {
        const key = normalise(field);
        if (!poIndex.has(key)) poIndex.set(key, []);
        poIndex.get(key)!.push(l);
      }
    }

    // Model code index
    if (l.item_description) {
      const mc = extractModelCode(l.item_description);
      if (mc) {
        if (!modelIndex.has(vid)) modelIndex.set(vid, new Map());
        const mm = modelIndex.get(vid)!;
        if (!mm.has(mc)) mm.set(mc, []);
        mm.get(mc)!.push(l);
      }
    }
  }

  // Cost index by vendor for value matching
  const costByVendor = new Map<string, { lines: any[]; totalCost: number; createdAt: string }[]>();

  const matched: TwoWayMatchResult[] = [];
  const matchedInvoiceIds = new Set<string>();
  const matchedLineIds = new Set<string>();

  // Try matching each invoice
  for (const inv of matchableInvoices) {
    const lineItems = getLineItems(inv);
    const invVendor = inv.vendor;
    const aliases = getVendorAliases(invVendor);

    // Get all vendor_ids that map to this invoice vendor
    const vendorIds = new Set<string>();
    for (const alias of aliasRows ?? []) {
      const a = alias as any;
      if (a.vendor_name === invVendor || (a.aliases && a.aliases.some((al: string) =>
        aliases.some(va => va.toLowerCase() === al.toLowerCase())
      ))) {
        vendorIds.add(a.vendor_id);
      }
    }

    let bestMatch: TwoWayMatchResult | null = null;

    // METHOD 1: Exact PO match
    if (inv.po_number && inv.po_number.trim()) {
      const poKey = normalise(inv.po_number);
      const poLines = poIndex.get(poKey);
      if (poLines && poLines.length > 0) {
        // Filter to same vendor
        const vendorPoLines = poLines.filter(l => vendorIds.has(l.vendor_id ?? ""));
        if (vendorPoLines.length > 0) {
          const sessionIds = new Set(vendorPoLines.map(l => l.session_id).filter(Boolean));
          bestMatch = {
            invoiceId: inv.id,
            invoiceNumber: inv.invoice_number,
            vendor: invVendor,
            receivingLineIds: vendorPoLines.map(l => l.id),
            sessionIds: Array.from(sessionIds),
            confidence: "exact",
            method: "po_number",
            upcOverlapPct: 100,
            notes: `PO# ${inv.po_number} matched ${vendorPoLines.length} receiving lines`,
          };
        }
      }
    }

    // METHOD 2: UPC overlap
    if (!bestMatch) {
      const invoiceUPCs = new Set(
        lineItems.map(li => stripLeadingZeros(li.upc ?? "")).filter(Boolean)
      );
      if (invoiceUPCs.size > 0) {
        const matchedLines: any[] = [];
        for (const vid of vendorIds) {
          const vendorUPCs = upcIndex.get(vid);
          if (!vendorUPCs) continue;
          for (const upc of invoiceUPCs) {
            const lines = vendorUPCs.get(upc);
            if (lines) matchedLines.push(...lines);
          }
        }
        if (matchedLines.length > 0) {
          const matchedUPCs = new Set(matchedLines.map(l => stripLeadingZeros(l.upc ?? "")));
          const overlapPct = Math.round((matchedUPCs.size / invoiceUPCs.size) * 100);
          if (overlapPct >= 60) {
            const sessionIds = new Set(matchedLines.map(l => l.session_id).filter(Boolean));
            bestMatch = {
              invoiceId: inv.id,
              invoiceNumber: inv.invoice_number,
              vendor: invVendor,
              receivingLineIds: matchedLines.map(l => l.id),
              sessionIds: Array.from(sessionIds),
              confidence: overlapPct >= 80 ? "high" : "medium",
              method: "upc",
              upcOverlapPct: overlapPct,
              notes: `${overlapPct}% UPC overlap (${matchedUPCs.size}/${invoiceUPCs.size} UPCs)`,
            };
          }
        }
      }
    }

    // METHOD 3: Model code match
    if (!bestMatch) {
      const invoiceItemNums = new Set(
        lineItems.map(li => normalise(li.item_number ?? "")).filter(Boolean)
      );
      if (invoiceItemNums.size > 0) {
        const matchedLines: any[] = [];
        for (const vid of vendorIds) {
          const vendorModels = modelIndex.get(vid);
          if (!vendorModels) continue;
          for (const itemNum of invoiceItemNums) {
            const lines = vendorModels.get(itemNum);
            if (lines) matchedLines.push(...lines);
          }
        }
        if (matchedLines.length > 0) {
          const sessionIds = new Set(matchedLines.map(l => l.session_id).filter(Boolean));
          bestMatch = {
            invoiceId: inv.id,
            invoiceNumber: inv.invoice_number,
            vendor: invVendor,
            receivingLineIds: matchedLines.map(l => l.id),
            sessionIds: Array.from(sessionIds),
            confidence: "medium",
            method: "model_code",
            upcOverlapPct: 0,
            notes: `Model code match: ${matchedLines.length} lines matched`,
          };
        }
      }
    }

    // METHOD 4: Value + vendor + date proximity
    if (!bestMatch) {
      const invTotal = Number(inv.total) || 0;
      const invDate = new Date(inv.invoice_date);
      if (invTotal > 0) {
        // Group receiving lines by session, compute session totals
        for (const vid of vendorIds) {
          const vidLines = matchableLines.filter(l => l.vendor_id === vid);
          // Group by session
          const bySession = new Map<string, any[]>();
          for (const l of vidLines) {
            if (!l.session_id) continue;
            if (!bySession.has(l.session_id)) bySession.set(l.session_id, []);
            bySession.get(l.session_id)!.push(l);
          }
          for (const [sid, sLines] of bySession) {
            const sessionTotal = sLines.reduce((s: number, l: any) =>
              s + (Number(l.received_cost) || Number(l.ordered_cost) || 0), 0);
            if (sessionTotal <= 0) continue;
            const pctDiff = Math.abs(invTotal - sessionTotal) / invTotal;
            if (pctDiff > 0.10) continue; // >10% difference
            const session = sessionMap.get(sid);
            if (!session) continue;
            const sessionDate = new Date(session.created_at);
            const daysDiff = Math.abs((invDate.getTime() - sessionDate.getTime()) / 86400000);
            if (daysDiff > 90) continue;
            bestMatch = {
              invoiceId: inv.id,
              invoiceNumber: inv.invoice_number,
              vendor: invVendor,
              receivingLineIds: sLines.map(l => l.id),
              sessionIds: [sid],
              confidence: "low",
              method: "value",
              upcOverlapPct: 0,
              notes: `Value match: invoice $${invTotal.toFixed(0)} ≈ session $${sessionTotal.toFixed(0)} (${(pctDiff * 100).toFixed(1)}% diff, ${daysDiff.toFixed(0)} days apart)`,
            };
            break; // Take first value match
          }
          if (bestMatch) break;
        }
      }
    }

    if (bestMatch) {
      matched.push(bestMatch);
      matchedInvoiceIds.add(inv.id);
      for (const lid of bestMatch.receivingLineIds) matchedLineIds.add(lid);
    }
  }

  // Determine unmatched
  const unmatchedInvoices = matchableInvoices.filter(i => !matchedInvoiceIds.has(i.id));
  const unmatchedReceipts = matchableLines.filter(l =>
    !matchedLineIds.has(l.id) && !accessoryVendorIds.has(l.vendor_id)
  );

  return {
    matched,
    unmatchedInvoices,
    unmatchedReceipts,
    stats: {
      total: matchableInvoices.length,
      matched: matched.length,
      invoicesWaiting: unmatchedInvoices.length,
      receiptsWaiting: new Set(unmatchedReceipts.map(r => r.session_id ?? r.id)).size,
    },
  };
}

/**
 * Persist match results to the database — updates both vendor_invoices and lightspeed_receiving.
 */
export async function persistMatchResults(results: TwoWayMatchResult[]): Promise<number> {
  let saved = 0;
  for (const r of results) {
    const matchStatus = r.confidence === "low" ? "pending_review" : "matched";
    // Update invoice side
    const { error: invErr } = await supabase
      .from("vendor_invoices")
      .update({
        match_status: matchStatus,
        matched_session_ids: r.sessionIds,
        match_confidence: r.confidence,
        match_notes: `[${r.method}] ${r.notes}`,
      })
      .eq("id", r.invoiceId);

    if (invErr) continue;

    // Update receiving side (po_receiving_lines)
    for (const lid of r.receivingLineIds) {
      await supabase
        .from("po_receiving_lines")
        .update({
          invoice_match_status: matchStatus,
          matched_invoice_id: r.invoiceId,
        } as any)
        .eq("id", lid);
    }
    saved++;
  }
  return saved;
}

/**
 * Run engine and persist — convenience wrapper.
 */
export async function runAndPersistMatches(input?: MatchEngineInput) {
  const result = await runTwoWayMatchEngine(input);
  const saved = await persistMatchResults(result.matched);
  return { ...result, saved };
}
