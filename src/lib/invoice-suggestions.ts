import { getLineItems, type LineItem } from "@/lib/supabase-queries";

export interface InvoiceSuggestion {
  invoice: any;
  score: number;
  upcMatches: number;
  skuMatches: number;
  matchPercent: number;
  poMatch: boolean;
  totalDiff: number;
}

/**
 * Extract a PO number from session filename or name.
 * e.g. "purchase_listings_items_PO108.csv" → "108"
 */
function extractPOFromFilename(filename: string): string | null {
  // Match patterns like PO108, PO-108, PO_108, PO 108
  const match = filename.match(/PO[\s_\-]?(\d+)/i);
  return match ? match[1] : null;
}

/**
 * Score candidate invoices against a receiving session's lines.
 * Returns top 3 suggestions sorted by score descending.
 */
export function suggestMatchingInvoices(
  sessionLines: Array<{ upc?: string | null; manufact_sku?: string | null }>,
  sessionTotalCost: number,
  sessionFilename: string,
  sessionName: string,
  candidateInvoices: any[]
): InvoiceSuggestion[] {
  // Step 1: Extract session UPCs and SKUs
  const sessionUPCs = sessionLines
    .map(l => String(l.upc || '').replace(/\D/g, ''))
    .filter(u => u.length > 3);
  const sessionSKUs = sessionLines
    .map(l => String(l.manufact_sku || '').toLowerCase().replace(/[\s\-]/g, ''))
    .filter(Boolean);

  // Step 2: Check for PO number in filename/session name
  const extractedPO = extractPOFromFilename(sessionFilename) || extractPOFromFilename(sessionName);

  const scores: InvoiceSuggestion[] = [];

  for (const invoice of candidateInvoices) {
    let score = 0;
    let upcMatches = 0;
    let skuMatches = 0;
    let poMatch = false;

    // PO number cross-reference (+10 near-certain match)
    if (extractedPO && invoice.po_number) {
      const invPO = String(invoice.po_number).replace(/\D/g, '');
      if (invPO === extractedPO || invoice.po_number.toLowerCase().includes(extractedPO.toLowerCase())) {
        score += 10;
        poMatch = true;
      }
    }

    // Score line items
    const invItems = getLineItems(invoice);
    const matchedUPCs = new Set<string>();
    const matchedSKUs = new Set<string>();

    for (const item of invItems) {
      const invUPC = String(item.upc || '').replace(/\D/g, '');
      const invModel = String(item.model || item.item_number || '').toLowerCase().replace(/[\s\-]/g, '');

      // UPC match = strong signal (3 points each, deduplicated)
      if (invUPC && invUPC.length > 3 && sessionUPCs.includes(invUPC) && !matchedUPCs.has(invUPC)) {
        score += 3;
        upcMatches++;
        matchedUPCs.add(invUPC);
      }

      // SKU match = medium signal (1 point each)
      if (invModel) {
        for (const sku of sessionSKUs) {
          if (sku.includes(invModel) || invModel.includes(sku)) {
            if (!matchedSKUs.has(invModel)) {
              score += 1;
              skuMatches++;
              matchedSKUs.add(invModel);
            }
            break;
          }
        }
      }
    }

    // Bonus: invoice total close to session ordered cost
    const totalDiff = Math.abs(invoice.total - sessionTotalCost);
    if (totalDiff < 50) score += 5;
    else if (totalDiff < 200) score += 2;

    // Bonus: invoice date recency
    const daysDiff = Math.abs(
      new Date(invoice.invoice_date).getTime() - Date.now()
    ) / (1000 * 60 * 60 * 24);
    if (daysDiff < 14) score += 4;
    else if (daysDiff < 30) score += 2;

    if (score > 0) {
      scores.push({
        invoice,
        score,
        upcMatches,
        skuMatches,
        matchPercent: sessionUPCs.length > 0
          ? Math.round((upcMatches / sessionUPCs.length) * 100)
          : 0,
        poMatch,
        totalDiff,
      });
    }
  }

  return scores.sort((a, b) => b.score - a.score).slice(0, 3);
}

export function matchStrengthBadge(matchPercent: number, poMatch: boolean): {
  label: string;
  className: string;
} {
  if (poMatch) return { label: 'PO NUMBER MATCH', className: 'bg-amber-500 text-white' };
  if (matchPercent >= 90) return { label: 'STRONG MATCH', className: 'bg-emerald-600 text-white' };
  if (matchPercent >= 60) return { label: 'LIKELY MATCH', className: 'bg-amber-500 text-white' };
  return { label: 'POSSIBLE MATCH', className: 'bg-muted text-muted-foreground' };
}
