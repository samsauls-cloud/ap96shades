/**
 * Auto-match newly uploaded invoices against partially reconciled sessions.
 * Called after a new invoice is inserted via the PDF Reader.
 */
import { supabase } from "@/integrations/supabase/client";
import type { LineItem } from "@/lib/supabase-queries";

export interface PendingMatchResult {
  sessionId: string;
  sessionName: string;
  matchedLineCount: number;
  unmatchedBefore: number;
  unmatchedAfter: number;
  invoiceId: string;
  invoiceNumber: string;
}

/**
 * Check if a newly uploaded invoice matches any unmatched lines
 * in partially reconciled sessions.
 */
export async function checkPendingMatches(
  newInvoiceId: string,
  newInvoiceNumber: string,
  newInvoiceLineItems: LineItem[]
): Promise<PendingMatchResult[]> {
  // Find all partial_reconciled sessions
  const { data: partialSessions } = await supabase
    .from('po_receiving_sessions')
    .select('id, session_name')
    .eq('reconciliation_status', 'partial_reconciled');

  if (!partialSessions || partialSessions.length === 0) return [];

  // Build UPC lookup from new invoice
  const invoiceUPCs = new Map<string, LineItem>();
  const invoiceSKUs = new Map<string, LineItem>();
  for (const li of newInvoiceLineItems) {
    if (li.upc) {
      invoiceUPCs.set(String(li.upc).replace(/\D/g, ''), li);
    }
    if (li.model) {
      invoiceSKUs.set(li.model.toLowerCase().replace(/[\s\-]/g, ''), li);
    }
  }

  if (invoiceUPCs.size === 0 && invoiceSKUs.size === 0) return [];

  const results: PendingMatchResult[] = [];

  for (const session of partialSessions) {
    // Get unmatched lines from this session
    const { data: unmatchedLines } = await supabase
      .from('po_receiving_lines')
      .select('id, upc, manufact_sku, item_description')
      .eq('session_id', session.id)
      .eq('match_status', 'INVOICE_NOT_UPLOADED');

    if (!unmatchedLines || unmatchedLines.length === 0) continue;

    let matchCount = 0;
    for (const line of unmatchedLines) {
      const lineUpc = line.upc ? String(line.upc).replace(/\D/g, '') : '';
      const lineSku = line.manufact_sku ? line.manufact_sku.toLowerCase().replace(/[\s\-]/g, '') : '';

      if ((lineUpc && invoiceUPCs.has(lineUpc)) || (lineSku && invoiceSKUs.has(lineSku))) {
        matchCount++;
      }
    }

    if (matchCount > 0) {
      results.push({
        sessionId: session.id,
        sessionName: session.session_name,
        matchedLineCount: matchCount,
        unmatchedBefore: unmatchedLines.length,
        unmatchedAfter: unmatchedLines.length - matchCount,
        invoiceId: newInvoiceId,
        invoiceNumber: newInvoiceNumber,
      });
    }
  }

  return results;
}
