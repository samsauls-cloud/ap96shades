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
  if (desc.includes('COSTA')) return 'EOL';
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

export function calcDiscrepancy(receivingLine: any, invoiceLine: LineItem | null): DiscrepancyResult | null {
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
  if (invPrice > 0) {
    const priceDiff = Math.abs(invPrice - rcvCost);
    if (priceDiff / invPrice > 0.02) return {
      type: 'PRICE_MISMATCH',
      amount: priceDiff * rcvQty,
      detail: `Invoice $${invPrice.toFixed(2)}, cost $${rcvCost.toFixed(2)}`,
    };
  }
  return null;
}

// ── DB Operations ──
export async function createSession(data: {
  session_name: string;
  vendor: string;
  lightspeed_export_type: string;
  raw_filename: string;
  stats: ReturnType<typeof computeSessionStats>;
}) {
  const { data: session, error } = await supabase
    .from('po_receiving_sessions')
    .insert({
      session_name: data.session_name,
      vendor: data.vendor,
      lightspeed_export_type: data.lightspeed_export_type,
      raw_filename: data.raw_filename,
      ...data.stats,
    })
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
