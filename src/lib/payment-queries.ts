import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabase-fetch-all";
import { calculateInstallments, hasTermsEngine, verifyInstallmentMath } from "./payment-terms";
import { normalizeVendor, isKnownVendor } from "./invoice-dedup";

export interface PaymentHistoryEntry {
  date: string;
  amount: number;
  method: string;
  reference: string;
  note: string;
  recorded_by: string;
  timestamp: string;
}

export interface InvoicePayment {
  id: string;
  invoice_id: string | null;
  vendor: string;
  invoice_number: string;
  po_number: string | null;
  invoice_amount: number;
  invoice_date: string;
  terms: string | null;
  installment_label: string | null;
  due_date: string;
  amount_due: number;
  amount_paid: number;
  balance_remaining: number;
  payment_status: string;
  payment_method: string | null;
  check_number: string | null;
  payment_reference: string | null;
  payment_history: PaymentHistoryEntry[];
  dispute_reason: string | null;
  void_reason: string | null;
  last_payment_date: string | null;
  recorded_by: string | null;
  is_paid: boolean;
  paid_date: string | null;
  notes: string | null;
  created_at: string;
}

export type PaymentStatus = "unpaid" | "partial" | "paid" | "overpaid" | "disputed" | "void";

export function derivePaymentStatus(amountDue: number, amountPaid: number): PaymentStatus {
  if (amountPaid <= 0) return "unpaid";
  if (amountPaid > amountDue) return "overpaid";
  if (amountPaid >= amountDue) return "paid";
  return "partial";
}

export function isOverdue(dueDate: string, status: string): boolean {
  if (status === "paid" || status === "overpaid" || status === "void") return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dueDate + "T00:00:00") < today;
}

export function getDaysOverdue(dueDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate + "T00:00:00");
  const diff = Math.ceil((today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(0, diff);
}

function normalizePayment(row: any): InvoicePayment {
  const amountDue = Number(row.amount_due) || 0;
  const amountPaid = Number(row.amount_paid) || 0;
  const balanceRemaining = amountDue - amountPaid;
  let paymentStatus = row.payment_status || derivePaymentStatus(amountDue, amountPaid);
  if (row.payment_status === "disputed" || row.payment_status === "void") {
    paymentStatus = row.payment_status;
  }
  return {
    ...row,
    amount_due: amountDue,
    amount_paid: amountPaid,
    balance_remaining: balanceRemaining,
    payment_status: paymentStatus,
    payment_history: Array.isArray(row.payment_history) ? row.payment_history : [],
  };
}

export async function fetchPayments(): Promise<InvoicePayment[]> {
  const data = await fetchAllRows("invoice_payments", {
    orderBy: "due_date",
    ascending: true,
  });
  return data.map(normalizePayment);
}

export async function fetchPaymentsForInvoice(invoiceId: string): Promise<InvoicePayment[]> {
  const { data, error } = await supabase
    .from("invoice_payments")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("due_date", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(normalizePayment);
}

export async function recordPayment(
  paymentId: string,
  amount: number,
  paymentDate: string,
  method: string,
  reference: string,
  note: string,
  recordedBy: string
): Promise<void> {
  const { data: current, error: fetchErr } = await supabase
    .from("invoice_payments")
    .select("*")
    .eq("id", paymentId)
    .single();
  if (fetchErr) throw fetchErr;

  const amountDue = Number(current.amount_due) || 0;
  const prevPaid = Number(current.amount_paid) || 0;
  const newPaid = prevPaid + amount;
  const newBalance = amountDue - newPaid;
  const newStatus = derivePaymentStatus(amountDue, newPaid);

  const historyEntry: PaymentHistoryEntry = {
    date: paymentDate,
    amount,
    method,
    reference,
    note,
    recorded_by: recordedBy,
    timestamp: new Date().toISOString(),
  };

  const existingHistory = Array.isArray(current.payment_history) ? current.payment_history : [];

  const { error } = await supabase
    .from("invoice_payments")
    .update({
      amount_paid: newPaid,
      balance_remaining: newBalance,
      payment_status: newStatus,
      payment_method: method,
      check_number: method === "Check" ? reference : current.check_number,
      payment_reference: method === "ACH" || method === "Wire" ? reference : current.payment_reference,
      last_payment_date: paymentDate,
      is_paid: newStatus === "paid" || newStatus === "overpaid",
      paid_date: newStatus === "paid" || newStatus === "overpaid" ? paymentDate : current.paid_date,
      recorded_by: recordedBy,
      payment_history: [...existingHistory, historyEntry],
    } as any)
    .eq("id", paymentId);
  if (error) throw error;

  // Sync parent invoice status
  if (current.invoice_id) {
    await syncInvoicePaymentStatus(current.invoice_id);
  }
}

export async function setPaymentDisputed(paymentId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from("invoice_payments")
    .update({ payment_status: "disputed", dispute_reason: reason } as any)
    .eq("id", paymentId);
  if (error) throw error;
}

export async function setPaymentVoid(paymentId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from("invoice_payments")
    .update({ payment_status: "void", void_reason: reason } as any)
    .eq("id", paymentId);
  if (error) throw error;
}

export async function markPaymentPaid(paymentId: string): Promise<void> {
  const { data: current, error: fetchErr } = await supabase
    .from("invoice_payments")
    .select("amount_due, amount_paid, payment_history, invoice_id")
    .eq("id", paymentId)
    .single();
  if (fetchErr) throw fetchErr;

  const amountDue = Number(current.amount_due) || 0;
  const today = new Date().toISOString().split("T")[0];

  const { error } = await supabase
    .from("invoice_payments")
    .update({
      is_paid: true,
      paid_date: today,
      amount_paid: amountDue,
      balance_remaining: 0,
      payment_status: "paid",
      last_payment_date: today,
    } as any)
    .eq("id", paymentId);
  if (error) throw error;

  // Sync parent invoice status
  if (current.invoice_id) {
    await syncInvoicePaymentStatus(current.invoice_id);
  }
}

/** Sync vendor_invoices.status based on all installment statuses */
export async function syncInvoicePaymentStatus(invoiceId: string): Promise<void> {
  const { data: allInstallments, error: fetchErr } = await supabase
    .from("invoice_payments")
    .select("payment_status, balance_remaining")
    .eq("invoice_id", invoiceId);
  if (fetchErr) throw fetchErr;
  if (!allInstallments || allInstallments.length === 0) return;

  const allPaid = allInstallments.every(p => p.payment_status === "paid" || p.payment_status === "overpaid");
  const anyPartial = allInstallments.some(p => p.payment_status === "partial");
  const newStatus = allPaid ? "paid" : anyPartial ? "partial" : "unpaid";

  const { error } = await supabase
    .from("vendor_invoices")
    .update({ status: newStatus } as any)
    .eq("id", invoiceId);
  if (error) throw error;
}

/** Mark ALL installments for an invoice as paid in one shot */
export async function markAllInstallmentsPaid(invoiceId: string): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const { data: installments, error: fetchErr } = await supabase
    .from("invoice_payments")
    .select("id, amount_due")
    .eq("invoice_id", invoiceId);
  if (fetchErr) throw fetchErr;

  for (const inst of installments ?? []) {
    const { error } = await supabase
      .from("invoice_payments")
      .update({
        is_paid: true,
        paid_date: today,
        amount_paid: Number(inst.amount_due) || 0,
        balance_remaining: 0,
        payment_status: "paid",
        last_payment_date: today,
      } as any)
      .eq("id", inst.id);
    if (error) throw error;
  }

  await syncInvoicePaymentStatus(invoiceId);
}

export async function markPaymentUnpaid(paymentId: string): Promise<void> {
  const { error } = await supabase
    .from("invoice_payments")
    .update({
      is_paid: false,
      paid_date: null,
      amount_paid: 0,
      balance_remaining: null,
      payment_status: "unpaid",
    } as any)
    .eq("id", paymentId);
  if (error) throw error;
}

/**
 * Generate payment installments for a single invoice.
 * DUPLICATE PREVENTION: Always checks for existing payments first.
 * Returns count of rows inserted (0 if already exists or vendor not supported).
 */
export async function generatePaymentsForInvoice(
  invoiceId: string,
  invoiceDate: string,
  total: number,
  vendor: string,
  invoiceNumber: string,
  poNumber: string | null,
  paymentTermsText?: string | null,
): Promise<number> {
  // ── Duplicate prevention guard ──────────────────────
  const { data: existing } = await supabase
    .from("invoice_payments")
    .select("id")
    .eq("invoice_id", invoiceId)
    .limit(1);

  if (existing && existing.length > 0) {
    console.log(`Payments already exist for ${invoiceNumber} — skipping`);
    return 0;
  }

  const normalized = normalizeVendor(vendor);

  // Don't generate for unknown vendors
  if (!isKnownVendor(normalized)) {
    console.log(`Unknown vendor "${normalized}" — skipping payment generation`);
    return 0;
  }

  if (!hasTermsEngine(normalized)) return 0;

  const installments = calculateInstallments(invoiceDate, total, normalized, invoiceNumber, poNumber, paymentTermsText);
  if (installments.length === 0) return 0;

  // ── Math verification before insert ─────────────────
  const discrepancy = verifyInstallmentMath(installments, total);
  if (Math.abs(discrepancy) > 0.02) {
    console.error(`Math discrepancy for ${invoiceNumber}: total=${total}, installments sum=${total - discrepancy}, diff=${discrepancy}`);
    // Still insert but log the issue
  }

  const rows = installments.map(inst => ({
    invoice_id: invoiceId,
    vendor: inst.vendor,
    invoice_number: inst.invoice_number,
    po_number: inst.po_number,
    invoice_amount: inst.invoice_amount,
    invoice_date: inst.invoice_date,
    terms: inst.terms,
    installment_label: inst.installment_label,
    due_date: inst.due_date,
    amount_due: inst.amount_due,
    amount_paid: 0,
    balance_remaining: inst.amount_due,
    payment_status: "unpaid",
  }));

  const { error } = await supabase.from("invoice_payments").insert(rows);
  if (error) throw error;
  return rows.length;
}

/**
 * Recalculate payments for an invoice: deletes existing and regenerates.
 * Returns count of new rows inserted.
 */
export async function recalculatePaymentsForInvoice(
  invoiceId: string,
  invoiceDate: string,
  total: number,
  vendor: string,
  invoiceNumber: string,
  poNumber: string | null,
  paymentTermsText?: string | null,
): Promise<number> {
  // Delete existing
  const { error: delErr } = await supabase
    .from("invoice_payments")
    .delete()
    .eq("invoice_id", invoiceId);
  if (delErr) throw delErr;

  const normalized = normalizeVendor(vendor);
  if (!hasTermsEngine(normalized)) return 0;

  const installments = calculateInstallments(invoiceDate, total, normalized, invoiceNumber, poNumber, paymentTermsText);
  if (installments.length === 0) return 0;

  const rows = installments.map(inst => ({
    invoice_id: invoiceId,
    vendor: inst.vendor,
    invoice_number: inst.invoice_number,
    po_number: inst.po_number,
    invoice_amount: inst.invoice_amount,
    invoice_date: inst.invoice_date,
    terms: inst.terms,
    installment_label: inst.installment_label,
    due_date: inst.due_date,
    amount_due: inst.amount_due,
    amount_paid: 0,
    balance_remaining: inst.amount_due,
    payment_status: "unpaid",
  }));

  const { error } = await supabase.from("invoice_payments").insert(rows);
  if (error) throw error;
  return rows.length;
}

export async function generateAllMissingPayments(): Promise<{ generated: number; invoices: number }> {
  const { data: allInvoices, error: invErr } = await supabase
    .from("vendor_invoices")
    .select("id, invoice_date, total, vendor, invoice_number, po_number, payment_terms");
  if (invErr) throw invErr;

  const { data: existingPayments, error: payErr } = await supabase
    .from("invoice_payments")
    .select("invoice_id");
  if (payErr) throw payErr;

  const hasPayments = new Set((existingPayments ?? []).map(p => (p as any).invoice_id));
  const missing = (allInvoices ?? []).filter(inv => {
    const normalized = normalizeVendor(inv.vendor);
    return !hasPayments.has(inv.id) && isKnownVendor(normalized) && hasTermsEngine(normalized);
  });

  let totalGenerated = 0;
  for (const inv of missing) {
    const count = await generatePaymentsForInvoice(
      inv.id, inv.invoice_date, inv.total, inv.vendor, inv.invoice_number, inv.po_number, inv.payment_terms
    );
    totalGenerated += count;
  }

  return { generated: totalGenerated, invoices: missing.length };
}

// ── Audit queries ─────────────────────────────────────────

export interface AuditResult {
  missingPayments: { id: string; invoice_number: string; vendor: string; total: number; invoice_date: string }[];
  mathDiscrepancies: { id: string; invoice_number: string; vendor: string; total: number; installmentsSum: number; discrepancy: number }[];
  unknownVendors: { id: string; invoice_number: string; vendor: string; total: number }[];
  duplicateInvoices: { invoice_number: string; vendor: string; count: number }[];
  lastAuditTime: string;
}

export async function runFullAudit(): Promise<AuditResult> {
  const { data: allInvoices } = await supabase
    .from("vendor_invoices")
    .select("id, invoice_number, vendor, total, invoice_date, doc_type");
  const { data: allPayments } = await supabase
    .from("invoice_payments")
    .select("invoice_id, amount_due");

  const invoices = allInvoices ?? [];
  const payments = allPayments ?? [];

  // 1. Missing payments
  const paymentInvoiceIds = new Set(payments.map((p: any) => p.invoice_id));
  const missingPayments = invoices.filter(inv => {
    const normalized = normalizeVendor(inv.vendor);
    return !paymentInvoiceIds.has(inv.id) && isKnownVendor(normalized) && inv.doc_type === "INVOICE";
  }).map(inv => ({
    id: inv.id,
    invoice_number: inv.invoice_number,
    vendor: normalizeVendor(inv.vendor),
    total: inv.total,
    invoice_date: inv.invoice_date,
  }));

  // 2. Math discrepancies
  const paymentsByInvoice = new Map<string, number>();
  for (const p of payments) {
    const iid = (p as any).invoice_id;
    if (iid) {
      paymentsByInvoice.set(iid, (paymentsByInvoice.get(iid) || 0) + Number((p as any).amount_due));
    }
  }
  const mathDiscrepancies: AuditResult["mathDiscrepancies"] = [];
  for (const inv of invoices) {
    const sum = paymentsByInvoice.get(inv.id);
    if (sum !== undefined) {
      const diff = parseFloat((inv.total - sum).toFixed(2));
      if (Math.abs(diff) > 0.02) {
        mathDiscrepancies.push({
          id: inv.id,
          invoice_number: inv.invoice_number,
          vendor: inv.vendor,
          total: inv.total,
          installmentsSum: sum,
          discrepancy: diff,
        });
      }
    }
  }

  // 3. Unknown vendors
  const unknownVendors = invoices
    .filter(inv => !isKnownVendor(normalizeVendor(inv.vendor)))
    .map(inv => ({
      id: inv.id,
      invoice_number: inv.invoice_number,
      vendor: inv.vendor,
      total: inv.total,
    }));

  // 4. Duplicate invoices
  const invCounts = new Map<string, number>();
  for (const inv of invoices) {
    const key = `${inv.invoice_number}||${normalizeVendor(inv.vendor)}`;
    invCounts.set(key, (invCounts.get(key) || 0) + 1);
  }
  const duplicateInvoices: AuditResult["duplicateInvoices"] = [];
  for (const [key, count] of invCounts) {
    if (count > 1) {
      const [invoice_number, vendor] = key.split("||");
      duplicateInvoices.push({ invoice_number, vendor, count });
    }
  }

  return {
    missingPayments,
    mathDiscrepancies,
    unknownVendors,
    duplicateInvoices,
    lastAuditTime: new Date().toISOString(),
  };
}

// Invoice-level rollup (computed, not stored)
export interface InvoicePaymentRollup {
  total_installments: number;
  installments_paid: number;
  installments_partial: number;
  installments_unpaid: number;
  total_amount_due: number;
  total_amount_paid: number;
  total_balance_remaining: number;
  invoice_payment_status: string;
}

export function computeInvoiceRollup(payments: InvoicePayment[]): InvoicePaymentRollup {
  const total_installments = payments.length;
  const installments_paid = payments.filter(p => p.payment_status === "paid" || p.payment_status === "overpaid").length;
  const installments_partial = payments.filter(p => p.payment_status === "partial").length;
  const installments_unpaid = payments.filter(p => p.payment_status === "unpaid").length;
  const total_amount_due = payments.reduce((s, p) => s + p.amount_due, 0);
  const total_amount_paid = payments.reduce((s, p) => s + p.amount_paid, 0);
  const total_balance_remaining = payments.reduce((s, p) => s + p.balance_remaining, 0);

  let invoice_payment_status = "unpaid";
  if (payments.some(p => p.payment_status === "disputed")) invoice_payment_status = "disputed";
  else if (installments_paid === total_installments && total_installments > 0) invoice_payment_status = "paid";
  else if (total_amount_paid > 0) invoice_payment_status = "partial";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (payments.some(p => isOverdue(p.due_date, p.payment_status))) {
    if (invoice_payment_status === "unpaid" || invoice_payment_status === "partial") {
      invoice_payment_status = "overdue";
    }
  }

  return { total_installments, installments_paid, installments_partial, installments_unpaid, total_amount_due, total_amount_paid, total_balance_remaining, invoice_payment_status };
}
