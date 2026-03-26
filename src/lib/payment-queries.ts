import { supabase } from "@/integrations/supabase/client";
import { calculateInstallments, hasTermsEngine } from "./payment-terms";

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
  is_paid: boolean;
  paid_date: string | null;
  notes: string | null;
  created_at: string;
}

export async function fetchPayments(): Promise<InvoicePayment[]> {
  const { data, error } = await supabase
    .from("invoice_payments")
    .select("*")
    .order("due_date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as InvoicePayment[];
}

export async function fetchPaymentsForInvoice(invoiceId: string): Promise<InvoicePayment[]> {
  const { data, error } = await supabase
    .from("invoice_payments")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("due_date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as InvoicePayment[];
}

export async function markPaymentPaid(paymentId: string): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const { error } = await supabase
    .from("invoice_payments")
    .update({ is_paid: true, paid_date: today })
    .eq("id", paymentId);
  if (error) throw error;
}

export async function markPaymentUnpaid(paymentId: string): Promise<void> {
  const { error } = await supabase
    .from("invoice_payments")
    .update({ is_paid: false, paid_date: null })
    .eq("id", paymentId);
  if (error) throw error;
}

export async function generatePaymentsForInvoice(
  invoiceId: string,
  invoiceDate: string,
  total: number,
  vendor: string,
  invoiceNumber: string,
  poNumber: string | null
): Promise<number> {
  // Check if payments already exist (idempotent)
  const { data: existing } = await supabase
    .from("invoice_payments")
    .select("id")
    .eq("invoice_id", invoiceId)
    .limit(1);

  if (existing && existing.length > 0) return 0;

  if (!hasTermsEngine(vendor)) return 0;

  const installments = calculateInstallments(invoiceDate, total, vendor, invoiceNumber, poNumber);
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
  }));

  const { error } = await supabase.from("invoice_payments").insert(rows);
  if (error) throw error;
  return rows.length;
}

export async function generateAllMissingPayments(): Promise<{ generated: number; invoices: number }> {
  // Fetch all invoices that DON'T have payments yet
  const { data: allInvoices, error: invErr } = await supabase
    .from("vendor_invoices")
    .select("id, invoice_date, total, vendor, invoice_number, po_number");
  if (invErr) throw invErr;

  const { data: existingPayments, error: payErr } = await supabase
    .from("invoice_payments")
    .select("invoice_id");
  if (payErr) throw payErr;

  const hasPayments = new Set((existingPayments ?? []).map(p => (p as any).invoice_id));
  const missing = (allInvoices ?? []).filter(inv => !hasPayments.has(inv.id) && hasTermsEngine(inv.vendor));

  let totalGenerated = 0;
  for (const inv of missing) {
    const count = await generatePaymentsForInvoice(
      inv.id, inv.invoice_date, inv.total, inv.vendor, inv.invoice_number, inv.po_number
    );
    totalGenerated += count;
  }

  return { generated: totalGenerated, invoices: missing.length };
}
