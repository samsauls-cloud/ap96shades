import { supabase } from "@/integrations/supabase/client";
import type { ReconciliationTotals } from "./reconciliation-math";

export interface FinalBillLedgerEntry {
  id: string;
  created_at: string;
  invoice_id: string;
  session_id: string;
  vendor: string;
  invoice_number: string;
  po_number: string | null;
  invoice_date: string;
  original_invoice_total: number;
  total_ordered_qty: number;
  total_received_qty: number;
  total_not_received_qty: number;
  credit_due_overbilled: number;
  qty_mismatch_amount: number;
  not_on_invoice_amount: number;
  total_credit_due: number;
  final_bill_amount: number;
  final_bill_status: string;
  amount_paid_toward_final: number;
  final_balance_remaining: number;
  discrepancy_line_count: number;
  credit_request_sent: boolean;
  credit_request_sent_at: string | null;
  credit_approved: boolean;
  credit_approved_amount: number;
  credit_approved_at: string | null;
  notes: string | null;
  approved_by: string | null;
}

/**
 * Create or update a final bill ledger entry after reconciliation.
 */
export async function upsertFinalBillEntry(
  invoiceId: string,
  sessionId: string,
  invoice: { vendor: string; invoice_number: string; po_number?: string | null; invoice_date: string; total: number },
  session: { total_ordered_qty: number; total_received_qty: number },
  totals: ReconciliationTotals
): Promise<FinalBillLedgerEntry> {
  const totalNotReceivedQty = session.total_ordered_qty - session.total_received_qty;

  // Check if entry exists for this invoice
  const { data: existing } = await supabase
    .from('final_bill_ledger')
    .select('id')
    .eq('invoice_id', invoiceId)
    .limit(1);

  const entry = {
    invoice_id: invoiceId,
    session_id: sessionId,
    vendor: invoice.vendor,
    invoice_number: invoice.invoice_number,
    po_number: invoice.po_number || null,
    invoice_date: invoice.invoice_date,
    original_invoice_total: invoice.total,
    total_ordered_qty: session.total_ordered_qty,
    total_received_qty: session.total_received_qty,
    total_not_received_qty: totalNotReceivedQty,
    credit_due_overbilled: totals.creditDueOverbilled,
    qty_mismatch_amount: totals.qtyMismatchAmount,
    not_on_invoice_amount: totals.notOnInvoiceAmount,
    total_credit_due: totals.totalCreditDue,
    final_bill_amount: totals.finalBillAmount,
    final_balance_remaining: totals.finalBillAmount,
    discrepancy_line_count: totals.discrepancyLineCount,
    final_bill_status: totals.totalCreditDue > 0 ? 'pending' : 'clean',
  };

  if (existing && existing.length > 0) {
    const { data, error } = await supabase
      .from('final_bill_ledger')
      .update(entry)
      .eq('id', existing[0].id)
      .select()
      .single();
    if (error) throw error;
    return data as unknown as FinalBillLedgerEntry;
  }

  const { data, error } = await supabase
    .from('final_bill_ledger')
    .insert(entry)
    .select()
    .single();
  if (error) throw error;
  return data as unknown as FinalBillLedgerEntry;
}

/**
 * Update vendor_invoices with reconciliation results.
 */
export async function updateInvoiceReconciliation(
  invoiceId: string,
  sessionId: string,
  creditDue: number,
  finalBillAmount: number,
  reconStatus: string
) {
  const { error } = await supabase
    .from('vendor_invoices')
    .update({
      reconciliation_status: reconStatus,
      credit_due: creditDue,
      final_bill_amount: finalBillAmount,
      reconciled_at: new Date().toISOString(),
      reconciled_session_id: sessionId,
    } as any)
    .eq('id', invoiceId);
  if (error) throw error;
}

/**
 * Apply credit to invoice payment installments proportionally.
 */
export async function applyCreditToPayments(invoiceId: string, creditDue: number) {
  if (creditDue <= 0) return;

  const { data: installments, error: fetchErr } = await supabase
    .from('invoice_payments')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('due_date', { ascending: true });
  if (fetchErr) throw fetchErr;
  if (!installments || installments.length === 0) return;

  const totalDue = installments.reduce((s, i) => s + Number(i.amount_due), 0);
  if (totalDue <= 0) return;

  let creditRemaining = creditDue;

  for (let idx = 0; idx < installments.length; idx++) {
    const inst = installments[idx];
    const originalDue = Number(inst.amount_due);
    let creditShare: number;

    if (idx === installments.length - 1) {
      // Last installment absorbs rounding remainder
      creditShare = Math.round(creditRemaining * 100) / 100;
    } else {
      creditShare = Math.round(((originalDue / totalDue) * creditDue) * 100) / 100;
    }

    creditShare = Math.min(creditShare, originalDue);
    creditRemaining -= creditShare;

    const newAmountDue = Math.round((originalDue - creditShare) * 100) / 100;
    const amountPaid = Number(inst.amount_paid || 0);
    const newBalance = Math.max(0, newAmountDue - amountPaid);

    const { error } = await supabase
      .from('invoice_payments')
      .update({
        amount_due: newAmountDue,
        balance_remaining: newBalance,
        notes: inst.notes
          ? `${inst.notes}\nCredit applied: -$${creditShare.toFixed(2)}`
          : `Credit applied: -$${creditShare.toFixed(2)}`,
      } as any)
      .eq('id', inst.id);
    if (error) throw error;
  }
}

/**
 * Fetch all final bill ledger entries.
 */
export async function fetchFinalBillLedger(): Promise<FinalBillLedgerEntry[]> {
  const { data, error } = await supabase
    .from('final_bill_ledger')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as FinalBillLedgerEntry[];
}

/**
 * Mark credit request as sent.
 */
export async function markCreditRequestSent(ledgerId: string) {
  const { error } = await supabase
    .from('final_bill_ledger')
    .update({
      credit_request_sent: true,
      credit_request_sent_at: new Date().toISOString(),
      final_bill_status: 'credit_requested',
    } as any)
    .eq('id', ledgerId);
  if (error) throw error;
}

/**
 * Confirm credit received from vendor.
 */
export async function confirmCreditReceived(
  ledgerId: string,
  invoiceId: string,
  approvedAmount: number,
  approvedBy: string
) {
  // Update ledger
  const { error: ledgerErr } = await supabase
    .from('final_bill_ledger')
    .update({
      credit_approved: true,
      credit_approved_amount: approvedAmount,
      credit_approved_at: new Date().toISOString(),
      approved_by: approvedBy,
      final_bill_status: 'credit_approved',
    } as any)
    .eq('id', ledgerId);
  if (ledgerErr) throw ledgerErr;

  // Apply confirmed credit to payments
  await applyCreditToPayments(invoiceId, approvedAmount);
}

/**
 * Generate credit request CSV for a ledger entry.
 */
export function generateCreditRequestCSV(
  entry: FinalBillLedgerEntry,
  discrepancyLines: any[]
): string {
  const header = 'UPC,Model,Description,Qty Billed,Qty Received,Qty Not Received,Unit Price,Credit Amount,Discrepancy Type';
  const rows = discrepancyLines
    .filter((l: any) => l.billing_discrepancy)
    .map((l: any) =>
      [l.upc, l.manufact_sku, l.item_description, l.order_qty, l.received_qty ?? 0,
       l.not_received_qty, l.unit_cost, l.discrepancy_amount, l.discrepancy_type]
        .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',')
    );
  const summary = [
    '',
    `"CREDIT REQUEST — ${entry.vendor} — ${entry.invoice_date}"`,
    `"Invoice #: ${entry.invoice_number}"`,
    `"PO #: ${entry.po_number || 'N/A'}"`,
    `"Original Invoice Total: $${entry.original_invoice_total.toFixed(2)}"`,
    `"Total Credit Requested: $${entry.total_credit_due.toFixed(2)}"`,
    `"Revised Invoice Total: $${entry.final_bill_amount.toFixed(2)}"`,
  ];
  return [header, ...rows, ...summary].join('\n');
}
