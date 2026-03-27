import { supabase } from "@/integrations/supabase/client";
import { getLineItems, type LineItem } from "@/lib/supabase-queries";

// ── Lightspeed Vendor ID Map ──
const LIGHTSPEED_VENDOR_MAP: Record<string, string> = {
  '14': 'Luxottica',
  '15': 'Kering',
  '1738': 'EOL',
  '23': 'Marcolin',
  '21': 'Marchon',
};

// ── EOL Brand → Real Vendor Map ──
export const EOL_BRAND_TO_VENDOR: Record<string, string> = {
  // Luxottica brands
  'OAKLEY': 'Luxottica',
  'RAY-BAN': 'Luxottica',
  'RAYBAN': 'Luxottica',
  'COSTA': 'Luxottica',
  'COSTA DEL MAR': 'Luxottica',
  'PRADA': 'Luxottica',
  'VERSACE': 'Luxottica',
  'PERSOL': 'Luxottica',
  'COACH': 'Luxottica',
  'MICHAEL KORS': 'Luxottica',
  'MK': 'Luxottica',
  'RALPH': 'Luxottica',
  'VOGUE': 'Luxottica',
  'BURBERRY': 'Luxottica',
  'ARNETTE': 'Luxottica',
  'OLIVER PEOPLES': 'Luxottica',
  // Kering brands
  'GUCCI': 'Kering',
  'SAINT LAURENT': 'Kering',
  'YSL': 'Kering',
  'BOTTEGA': 'Kering',
  'BOTTEGA VENETA': 'Kering',
  'BALENCIAGA': 'Kering',
  'ALEXANDER MCQUEEN': 'Kering',
  'CARTIER': 'Kering',
  // Maui Jim
  'MAUI JIM': 'Maui Jim',
  // Safilo brands
  'CARRERA': 'Safilo',
  'BOSS': 'Safilo',
  'HUGO BOSS': 'Safilo',
  'JIMMY CHOO': 'Safilo',
  'FOSSIL': 'Safilo',
  'KATE SPADE': 'Safilo',
  // Marcolin brands
  'TOM FORD': 'Marcolin',
  'GUESS': 'Marcolin',
  'SWAROVSKI': 'Marcolin',
  'MONTBLANC': 'Marcolin',
};

export interface EOLResolution {
  isEOL: boolean;
  realVendor: string;
  realVendors: string[]; // all distinct real vendors found
  isMultiVendor: boolean;
  vendorCounts: Record<string, number>;
}

/**
 * Resolve the real vendor(s) for an EOL session by scanning item descriptions/SKUs.
 */
export function resolveEOLVendor(lines: Array<{ item_description?: string; manufact_sku?: string }>): EOLResolution {
  const vendorCounts: Record<string, number> = {};

  for (const item of lines) {
    const desc = ((item.item_description || '') + ' ' + (item.manufact_sku || '')).toUpperCase();
    // Sort brands by length descending so "COSTA DEL MAR" matches before "COSTA"
    const sortedBrands = Object.keys(EOL_BRAND_TO_VENDOR).sort((a, b) => b.length - a.length);
    for (const brand of sortedBrands) {
      if (desc.includes(brand)) {
        const vendor = EOL_BRAND_TO_VENDOR[brand];
        vendorCounts[vendor] = (vendorCounts[vendor] || 0) + 1;
        break; // only count first brand match per line
      }
    }
  }

  const realVendors = Object.entries(vendorCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([v]) => v);

  return {
    isEOL: true,
    realVendor: realVendors[0] || 'Unknown',
    realVendors,
    isMultiVendor: realVendors.length > 1,
    vendorCounts,
  };
}

export type ExportFormat = 'CHECKIN_A' | 'ITEMS_B' | 'ITEMS_C_NO_RECEIVING' | 'UNKNOWN';

export type ReceivingStatus = 'FULLY_RECEIVED' | 'PARTIALLY_RECEIVED' | 'NOT_RECEIVED' | 'NO_RECEIVING_DATA';
export type MatchStatus = 'MATCHED' | 'UPC_ONLY' | 'SKU_ONLY' | 'NO_MATCH';
export type DiscrepancyType = 'OVERBILLED' | 'UNDERBILLED' | 'QTY_MISMATCH' | 'PRICE_MISMATCH' | 'NOT_ON_INVOICE';

export interface ParsedLine {
  system_id: string;
  upc: string;
  ean: string;
  custom_sku: string;
  manufact_sku: string;
  item_description: string;
  vendor_id: string;
  order_qty: number;
  received_qty: number | null;
  not_received_qty: number;
  unit_cost: number;
  retail_price: number;
  unit_discount: number;
  unit_shipping: number;
  received_cost: number;
  ordered_cost: number;
  lightspeed_status: string;
  receiving_status: ReceivingStatus;
}

// ── Format Detection ──
export function detectFormat(headers: string[]): ExportFormat {
  const h = headers.map(c => c.toLowerCase().trim());
  if (h.includes('# received') && h.includes('checked in')) return 'CHECKIN_A';
  if (h.includes('order qty.') && h.includes('check in qty.')) return 'ITEMS_B';
  if (h.includes('order qty.') && !h.includes('check in qty.')) return 'ITEMS_C_NO_RECEIVING';
  return 'UNKNOWN';
}

export function formatLabel(f: ExportFormat): string {
  switch (f) {
    case 'CHECKIN_A': return 'Check-In Items Export';
    case 'ITEMS_B': return 'Items Export (with check-in data)';
    case 'ITEMS_C_NO_RECEIVING': return 'Items Export (no receiving data)';
    default: return 'Unknown Format';
  }
}

// ── Vendor Detection ──
export function vendorFromLightspeed(vendorId: string, itemDescription?: string): string {
  const mapped = LIGHTSPEED_VENDOR_MAP[String(vendorId)];
  if (mapped) return mapped;
  const desc = (itemDescription || '').toUpperCase();
  if (desc.includes('OAKLEY') || desc.includes('RAY-BAN') || desc.includes('RAYBAN') || desc.includes('PRADA')) return 'Luxottica';
  if (desc.includes('SAINT LAURENT') || desc.includes('GUCCI') || desc.includes('BOTTEGA') || desc.includes('BALENCIAGA')) return 'Kering';
  if (desc.includes('TOM FORD')) return 'Marcolin';
  if (desc.includes('COSTA')) return 'Luxottica';
  if (desc.includes('MAUI JIM')) return 'Maui Jim';
  if (desc.includes('SAFILO')) return 'Safilo';
  return 'Unknown';
}

// ── Receiving Status ──
export function deriveReceivingStatus(orderQty: number, receivedQty: number | null): ReceivingStatus {
  if (receivedQty === null || receivedQty === undefined) return 'NO_RECEIVING_DATA';
  if (receivedQty === 0) return 'NOT_RECEIVED';
  if (receivedQty >= orderQty) return 'FULLY_RECEIVED';
  if (receivedQty > 0 && receivedQty < orderQty) return 'PARTIALLY_RECEIVED';
  return 'NOT_RECEIVED';
}

// ── CSV Parsing ──
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function getCol(row: string[], headers: string[], ...names: string[]): string {
  for (const name of names) {
    const idx = headers.findIndex(h => h.toLowerCase().trim() === name.toLowerCase().trim());
    if (idx >= 0 && row[idx] !== undefined) return row[idx];
  }
  return '';
}

function num(v: string): number {
  const n = parseFloat(v.replace(/[$,]/g, ''));
  return isNaN(n) ? 0 : n;
}

function intVal(v: string): number {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

export function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(parseCSVLine);
  return { headers, rows };
}

export function parseLines(headers: string[], rows: string[][], format: ExportFormat): ParsedLine[] {
  return rows.map(row => {
    const orderQty = intVal(getCol(row, headers, 'Quantity', 'Order Qty.', 'Order Qty'));
    let receivedQty: number | null = null;

    if (format === 'CHECKIN_A') {
      receivedQty = intVal(getCol(row, headers, 'Checked In'));
    } else if (format === 'ITEMS_B') {
      receivedQty = intVal(getCol(row, headers, 'Check In Qty.', 'Check In Qty'));
    }
    // ITEMS_C_NO_RECEIVING → receivedQty stays null

    const notReceived = receivedQty !== null ? Math.max(0, orderQty - receivedQty) : orderQty;
    const unitCost = num(getCol(row, headers, 'Unit Cost', 'Cost'));
    const receivedCost = receivedQty !== null ? receivedQty * unitCost : 0;

    return {
      system_id: getCol(row, headers, 'System ID', 'systemID'),
      upc: getCol(row, headers, 'UPC'),
      ean: getCol(row, headers, 'EAN'),
      custom_sku: getCol(row, headers, 'Custom SKU'),
      manufact_sku: getCol(row, headers, 'Manufact. SKU', 'Manufact SKU', 'MFR SKU'),
      item_description: getCol(row, headers, 'Item', 'Description', 'Item Description'),
      vendor_id: getCol(row, headers, 'Vendor ID', 'VendorID', 'Vendor'),
      order_qty: orderQty,
      received_qty: receivedQty,
      not_received_qty: notReceived,
      unit_cost: unitCost,
      retail_price: num(getCol(row, headers, 'Retail', 'Retail Price', 'MSRP')),
      unit_discount: num(getCol(row, headers, 'Discount', 'Unit Discount')),
      unit_shipping: num(getCol(row, headers, 'Shipping', 'Unit Shipping')),
      received_cost: receivedCost,
      ordered_cost: orderQty * unitCost,
      lightspeed_status: getCol(row, headers, 'Status'),
      receiving_status: deriveReceivingStatus(orderQty, receivedQty),
    };
  });
}

// ── Session Stats ──
export function computeSessionStats(lines: ParsedLine[]) {
  let fullyReceived = 0, partiallyReceived = 0, notReceived = 0;
  let totalOrderedQty = 0, totalReceivedQty = 0;
  let totalOrderedCost = 0, totalReceivedCost = 0;

  for (const l of lines) {
    totalOrderedQty += l.order_qty;
    totalReceivedQty += l.received_qty ?? 0;
    totalOrderedCost += l.ordered_cost;
    totalReceivedCost += l.received_cost;
    if (l.receiving_status === 'FULLY_RECEIVED') fullyReceived++;
    else if (l.receiving_status === 'PARTIALLY_RECEIVED') partiallyReceived++;
    else if (l.receiving_status === 'NOT_RECEIVED') notReceived++;
  }

  return {
    total_lines: lines.length,
    fully_received: fullyReceived,
    partially_received: partiallyReceived,
    not_received: notReceived,
    total_ordered_qty: totalOrderedQty,
    total_received_qty: totalReceivedQty,
    total_ordered_cost: totalOrderedCost,
    total_received_cost: totalReceivedCost,
  };
}

// ── Reconciliation ──
export interface DiscrepancyResult {
  type: DiscrepancyType;
  amount: number;
  detail?: string;
}

export function matchReceivingToInvoice(
  receivingLines: any[],
  invoiceLineItems: LineItem[]
): { line: any; matched_invoice_line: LineItem | null; match_status: MatchStatus }[] {
  return receivingLines.map(line => {
    // Match 1: exact UPC
    let match = invoiceLineItems.find(inv =>
      inv.upc && line.upc &&
      String(inv.upc).replace(/\D/g, '') === String(line.upc).replace(/\D/g, '')
    );
    if (match) return { line, matched_invoice_line: match, match_status: 'MATCHED' as MatchStatus };

    // Match 2: Manufact SKU → model
    match = invoiceLineItems.find(inv =>
      inv.model && line.manufact_sku &&
      inv.model.toLowerCase().replace(/[\s\-]/g, '') ===
      line.manufact_sku.toLowerCase().replace(/[\s\-]/g, '')
    );
    if (match) return { line, matched_invoice_line: match, match_status: 'SKU_ONLY' as MatchStatus };

    return { line, matched_invoice_line: null, match_status: 'NO_MATCH' as MatchStatus };
  });
}

export function calcDiscrepancy(receivingLine: any, invoiceLine: LineItem | null, skipPriceCheck = false): DiscrepancyResult | null {
  if (!invoiceLine) return { type: 'NOT_ON_INVOICE', amount: receivingLine.ordered_cost ?? 0 };

  const invQty = Number(invoiceLine.qty_shipped || invoiceLine.qty_ordered || invoiceLine.qty || 0);
  const invPrice = Number(invoiceLine.unit_price || 0);
  const rcvQty = Number(receivingLine.received_qty ?? 0);
  const rcvCost = Number(receivingLine.unit_cost ?? 0);

  if (invQty > rcvQty) return {
    type: 'OVERBILLED',
    amount: (invQty - rcvQty) * invPrice,
    detail: `Billed ${invQty}, received ${rcvQty}`,
  };
  if (invQty < rcvQty) return {
    type: 'UNDERBILLED',
    amount: (rcvQty - invQty) * invPrice,
    detail: `Received ${rcvQty}, only billed ${invQty}`,
  };
  // EOL sessions: skip price mismatch — EOL unit costs are discounted and expected to differ
  if (!skipPriceCheck && invPrice > 0) {
    const priceDiff = Math.abs(invPrice - rcvCost);
    if (priceDiff / invPrice > 0.02) return {
      type: 'PRICE_MISMATCH',
      amount: priceDiff * rcvQty,
      detail: `Invoice $${invPrice.toFixed(2)}, cost $${rcvCost.toFixed(2)}`,
    };
  }
  return null;
}

// ── Multi-Invoice Matching ──

export interface MultiInvoiceGroup {
  invoiceId: string;
  invoiceNumber: string;
  invoiceTotal: number;
  vendor: string;
  poNumber: string | null;
  lines: any[];
  matchedLineCount: number;
  orderedValue: number;
  receivedValue: number;
}

export interface MultiInvoiceMatchResult {
  groups: MultiInvoiceGroup[];
  unmatchedLines: any[];
  unmatchedValue: number;
}

/**
 * Match session lines against ALL candidate invoices simultaneously.
 * Each line is assigned to its best-matching invoice by UPC hit.
 */
export function multiInvoiceMatch(
  sessionLines: any[],
  candidateInvoices: any[],
  getLineItemsFn: (inv: any) => LineItem[]
): MultiInvoiceMatchResult {
  // Build UPC → invoice mapping across all invoices
  const upcToInvoice = new Map<string, { invoice: any; invoiceLine: LineItem }>();
  const skuToInvoice = new Map<string, { invoice: any; invoiceLine: LineItem }>();

  for (const inv of candidateInvoices) {
    const invLines = getLineItemsFn(inv);
    for (const il of invLines) {
      if (il.upc) {
        const normUpc = String(il.upc).replace(/\D/g, '');
        if (normUpc && !upcToInvoice.has(normUpc)) {
          upcToInvoice.set(normUpc, { invoice: inv, invoiceLine: il });
        }
      }
      if (il.model) {
        const normSku = il.model.toLowerCase().replace(/[\s\-]/g, '');
        if (normSku && !skuToInvoice.has(normSku)) {
          skuToInvoice.set(normSku, { invoice: inv, invoiceLine: il });
        }
      }
    }
  }

  // Assign each session line to an invoice
  const invoiceGroups = new Map<string, MultiInvoiceGroup>();
  const unmatched: any[] = [];

  for (const line of sessionLines) {
    const lineUpc = line.upc ? String(line.upc).replace(/\D/g, '') : '';
    const lineSku = line.manufact_sku ? line.manufact_sku.toLowerCase().replace(/[\s\-]/g, '') : '';

    let hit = lineUpc ? upcToInvoice.get(lineUpc) : undefined;
    if (!hit && lineSku) hit = skuToInvoice.get(lineSku);

    if (hit) {
      const invId = hit.invoice.id;
      if (!invoiceGroups.has(invId)) {
        invoiceGroups.set(invId, {
          invoiceId: invId,
          invoiceNumber: hit.invoice.invoice_number,
          invoiceTotal: hit.invoice.total,
          vendor: hit.invoice.vendor,
          poNumber: hit.invoice.po_number,
          lines: [],
          matchedLineCount: 0,
          orderedValue: 0,
          receivedValue: 0,
        });
      }
      const group = invoiceGroups.get(invId)!;
      group.lines.push(line);
      group.matchedLineCount++;
      group.orderedValue += Number(line.ordered_cost || 0);
      group.receivedValue += Number(line.received_cost || 0);
    } else {
      unmatched.push(line);
    }
  }

  const groups = Array.from(invoiceGroups.values()).sort((a, b) => b.orderedValue - a.orderedValue);
  const unmatchedValue = unmatched.reduce((s, l) => s + Number(l.ordered_cost || 0), 0);

  return { groups, unmatchedLines: unmatched, unmatchedValue };
}

// ── Session Split by PO ──

export interface POGroup {
  poRef: string;
  lines: any[];
  lineCount: number;
  orderedValue: number;
}

/**
 * Detect distinct PO references within session lines from item descriptions or SKUs.
 */
export function detectPOGroups(lines: any[]): POGroup[] {
  // Try to extract PO-like patterns from descriptions
  const groups = new Map<string, any[]>();

  for (const line of lines) {
    const desc = (line.item_description || '').toUpperCase();
    // Look for brand as the grouping key for EOL (e.g., "RAYBAN", "VOGUE", "OAKLEY")
    const sortedBrands = Object.keys(EOL_BRAND_TO_VENDOR).sort((a, b) => b.length - a.length);
    let brand = 'OTHER';
    for (const b of sortedBrands) {
      if (desc.includes(b)) {
        brand = b;
        break;
      }
    }
    if (!groups.has(brand)) groups.set(brand, []);
    groups.get(brand)!.push(line);
  }

  return Array.from(groups.entries())
    .map(([poRef, lines]) => ({
      poRef,
      lines,
      lineCount: lines.length,
      orderedValue: lines.reduce((s: number, l: any) => s + Number(l.ordered_cost || 0), 0),
    }))
    .sort((a, b) => b.orderedValue - a.orderedValue);
}

/**
 * Split a session into child sessions by PO group.
 */
export async function splitSessionByPO(
  parentSessionId: string,
  parentSession: any,
  poGroups: POGroup[]
): Promise<string[]> {
  const childIds: string[] = [];

  for (const group of poGroups) {
    const vendor = EOL_BRAND_TO_VENDOR[group.poRef] || parentSession.vendor;
    const stats = computeSessionStats(group.lines as ParsedLine[]);
    const childSession = await createSession({
      session_name: `${parentSession.session_name} — ${group.poRef}`,
      vendor,
      lightspeed_export_type: parentSession.lightspeed_export_type || '',
      raw_filename: parentSession.raw_filename || '',
      stats,
      parent_session_id: parentSessionId,
    });

    // Move lines to child session
    const lineIds = group.lines.map((l: any) => l.id);
    for (let i = 0; i < lineIds.length; i += 200) {
      const batch = lineIds.slice(i, i + 200);
      const { error } = await supabase
        .from('po_receiving_lines')
        .update({ session_id: childSession.id })
        .in('id', batch);
      if (error) throw error;
    }

    childIds.push(childSession.id);
  }

  // Mark parent as split with child links
  await supabase
    .from('po_receiving_sessions')
    .update({
      reconciliation_status: 'split',
      notes: `Split into ${poGroups.length} sub-sessions: ${poGroups.map(g => g.poRef).join(', ')}`,
      child_session_ids: childIds,
    } as any)
    .eq('id', parentSessionId);

  return childIds;
}

// ── DB Operations ──
export async function createSession(data: {
  session_name: string;
  vendor: string;
  lightspeed_export_type: string;
  raw_filename: string;
  stats: ReturnType<typeof computeSessionStats>;
  parent_session_id?: string;
}) {
  const insert: any = {
    session_name: data.session_name,
    vendor: data.vendor,
    lightspeed_export_type: data.lightspeed_export_type,
    raw_filename: data.raw_filename,
    ...data.stats,
  };
  if (data.parent_session_id) {
    insert.parent_session_id = data.parent_session_id;
  }
  const { data: session, error } = await supabase
    .from('po_receiving_sessions')
    .insert(insert)
    .select()
    .single();
  if (error) throw error;
  return session;
}

export async function insertReceivingLines(sessionId: string, lines: ParsedLine[]) {
  const rows = lines.map(l => ({ session_id: sessionId, ...l }));
  // Insert in batches of 200
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await supabase.from('po_receiving_lines').insert(batch);
    if (error) throw error;
  }
}

export async function fetchSessions(filters?: { vendor?: string; status?: string }) {
  let q = supabase.from('po_receiving_sessions').select('*').order('created_at', { ascending: false });
  if (filters?.vendor) q = q.eq('vendor', filters.vendor);
  if (filters?.status) q = q.eq('reconciliation_status', filters.status);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function fetchSessionLines(sessionId: string) {
  const { data, error } = await supabase
    .from('po_receiving_lines')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function updateSessionReconciliation(
  sessionId: string,
  invoiceId: string,
  status: string
) {
  const { error } = await supabase
    .from('po_receiving_sessions')
    .update({ reconciled_invoice_id: invoiceId, reconciliation_status: status })
    .eq('id', sessionId);
  if (error) throw error;
}

export async function updateLineReconciliation(
  lineId: string,
  data: {
    matched_invoice_line?: any;
    match_status?: string;
    billing_discrepancy?: boolean;
    discrepancy_type?: string;
    discrepancy_amount?: number;
  }
) {
  const { error } = await supabase
    .from('po_receiving_lines')
    .update(data)
    .eq('id', lineId);
  if (error) throw error;
}

// ── Receiving Dedup ──
export type ReceivingDedupAction =
  | { type: 'new' }
  | { type: 'exact_duplicate'; existingSessionId: string; sessionName: string }
  | { type: 'update_available'; existingSessionId: string; sessionName: string; changedLines: number; unchangedLines: number; newLines: number };

export async function checkReceivingDuplicate(
  vendor: string,
  filename: string,
  incomingLines: ParsedLine[]
): Promise<ReceivingDedupAction> {
  // Guard 1: exact filename match
  const { data: byFile } = await supabase
    .from('po_receiving_sessions')
    .select('id, session_name')
    .eq('raw_filename', filename)
    .eq('vendor', vendor)
    .limit(1);

  if (byFile && byFile.length > 0) {
    const existingSession = byFile[0];
    // Check if lines are identical
    const { data: existingLines } = await supabase
      .from('po_receiving_lines')
      .select('upc, manufact_sku, order_qty, received_qty')
      .eq('session_id', existingSession.id);

    if (existingLines) {
      const existingKey = new Set(existingLines.map(l =>
        `${l.upc || ''}|${l.manufact_sku || ''}|${l.order_qty}|${l.received_qty}`
      ));
      const incomingKey = new Set(incomingLines.map(l =>
        `${l.upc || ''}|${l.manufact_sku || ''}|${l.order_qty}|${l.received_qty}`
      ));
      const identical = existingKey.size === incomingKey.size &&
        [...incomingKey].every(k => existingKey.has(k));

      if (identical) {
        return { type: 'exact_duplicate', existingSessionId: existingSession.id, sessionName: existingSession.session_name };
      }

      // Not identical = updated CSV — compute diff
      const existingByUPC = new Map<string, typeof existingLines[0]>();
      for (const l of existingLines) {
        const key = l.upc || l.manufact_sku || '';
        if (key) existingByUPC.set(key, l);
      }

      let changed = 0, unchanged = 0, brandNew = 0;
      for (const inc of incomingLines) {
        const key = inc.upc || inc.manufact_sku || '';
        const existing = key ? existingByUPC.get(key) : undefined;
        if (!existing) { brandNew++; continue; }
        if (existing.received_qty !== inc.received_qty || existing.order_qty !== inc.order_qty) {
          changed++;
        } else {
          unchanged++;
        }
      }

      return {
        type: 'update_available',
        existingSessionId: existingSession.id,
        sessionName: existingSession.session_name,
        changedLines: changed,
        unchangedLines: unchanged,
        newLines: brandNew,
      };
    }
  }

  // Guard 2: same vendor, check for UPC overlap with any session
  const incomingUPCs = incomingLines.map(l => l.upc).filter(Boolean);
  if (incomingUPCs.length > 0) {
    const { data: overlapping } = await supabase
      .from('po_receiving_lines')
      .select('session_id, upc')
      .eq('session_id', (await supabase
        .from('po_receiving_sessions')
        .select('id')
        .eq('vendor', vendor)
        .limit(50)).data?.map(s => s.id)[0] ?? '')
      .in('upc', incomingUPCs.slice(0, 50))
      .limit(1);
    // This is a soft check — the filename guard above is the primary safeguard
  }

  return { type: 'new' };
}

export async function mergeReceivingUpdate(
  existingSessionId: string,
  incomingLines: ParsedLine[]
) {
  // Fetch existing lines
  const { data: existingLines, error: fetchErr } = await supabase
    .from('po_receiving_lines')
    .select('*')
    .eq('session_id', existingSessionId);
  if (fetchErr) throw fetchErr;
  if (!existingLines) throw new Error('No existing lines found');

  // Build lookup by UPC or MFR SKU
  const existingMap = new Map<string, any>();
  for (const l of existingLines) {
    const key = l.upc || l.manufact_sku || '';
    if (key) existingMap.set(key, l);
  }

  let updatedCount = 0;
  let insertedCount = 0;
  const toInsert: any[] = [];

  for (const inc of incomingLines) {
    const key = inc.upc || inc.manufact_sku || '';
    const existing = key ? existingMap.get(key) : undefined;

    if (existing) {
      // Only update if receiving data actually changed
      if (existing.received_qty !== inc.received_qty ||
          existing.order_qty !== inc.order_qty) {
        const { error } = await supabase
          .from('po_receiving_lines')
          .update({
            received_qty: inc.received_qty,
            order_qty: inc.order_qty,
            not_received_qty: inc.not_received_qty,
            received_cost: inc.received_cost,
            ordered_cost: inc.ordered_cost,
            receiving_status: inc.receiving_status,
          })
          .eq('id', existing.id);
        if (error) throw error;
        updatedCount++;
      }
    } else {
      // Brand new line — add it
      toInsert.push({ session_id: existingSessionId, ...inc });
    }
  }

  // Batch insert new lines
  if (toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += 200) {
      const batch = toInsert.slice(i, i + 200);
      const { error } = await supabase.from('po_receiving_lines').insert(batch);
      if (error) throw error;
    }
    insertedCount = toInsert.length;
  }

  // Recompute session stats from updated lines
  const { data: allLines } = await supabase
    .from('po_receiving_lines')
    .select('order_qty, received_qty, ordered_cost, received_cost, receiving_status')
    .eq('session_id', existingSessionId);

  if (allLines) {
    let fullyReceived = 0, partiallyReceived = 0, notReceived = 0;
    let totalOrderedQty = 0, totalReceivedQty = 0, totalOrderedCost = 0, totalReceivedCost = 0;
    for (const l of allLines) {
      totalOrderedQty += Number(l.order_qty || 0);
      totalReceivedQty += Number(l.received_qty || 0);
      totalOrderedCost += Number(l.ordered_cost || 0);
      totalReceivedCost += Number(l.received_cost || 0);
      if (l.receiving_status === 'FULLY_RECEIVED') fullyReceived++;
      else if (l.receiving_status === 'PARTIALLY_RECEIVED') partiallyReceived++;
      else if (l.receiving_status === 'NOT_RECEIVED') notReceived++;
    }
    await supabase.from('po_receiving_sessions').update({
      total_lines: allLines.length,
      fully_received: fullyReceived,
      partially_received: partiallyReceived,
      not_received: notReceived,
      total_ordered_qty: totalOrderedQty,
      total_received_qty: totalReceivedQty,
      total_ordered_cost: totalOrderedCost,
      total_received_cost: totalReceivedCost,
    }).eq('id', existingSessionId);
  }

  return { updatedCount, insertedCount };
}

export function exportReconciliationCSV(lines: any[]): string {
  const header = 'UPC,Manufact SKU,Description,Order Qty,Received Qty,Not Received,Unit Cost,Ordered $,Received $,Status,Match Status,Discrepancy Type,Discrepancy $';
  const rows = lines.map(l =>
    [l.upc, l.manufact_sku, l.item_description, l.order_qty, l.received_qty ?? '', l.not_received_qty,
     l.unit_cost, l.ordered_cost, l.received_cost, l.receiving_status, l.match_status ?? '',
     l.discrepancy_type ?? '', l.discrepancy_amount ?? '']
      .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
      .join(',')
  );
  return [header, ...rows].join('\n');
}
