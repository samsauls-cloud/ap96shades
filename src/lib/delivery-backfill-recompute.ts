import { supabase } from "@/integrations/supabase/client";
import { calculateInstallments } from "@/lib/payment-terms";
import { runRecalcGuards } from "@/lib/payment-queries";

export const BACKFILL_AUDIT_ACTION = "eom_delivery_backfill_2026_06";

export type ExistingRow = {
  id: string;
  installment_label: string | null;
  due_date: string;
  amount_due: number;
  amount_paid: number | null;
  is_paid: boolean | null;
  payment_status: string | null;
  manual_status_override: boolean | null;
  payment_history: any;
};

export type ProposedRow = {
  installment_label: string | null;
  due_date: string;
  amount_due: number;
};

export type RowDiff = {
  existing: ExistingRow;
  proposed: ProposedRow | null;
  willMove: boolean;
  skipReason?: string;
};

export type InvoicePreview = {
  invoiceId: string;
  invoiceNumber: string | null;
  vendor: string | null;
  invoiceDate: string;
  deliveryDate: string;
  total: number;
  paymentTerms: string | null;
  poNumber: string | null;
  guard: "clean" | "manual_correction" | "paid_rows" | "credit_memo" | "no_terms" | "no_existing";
  blocked: boolean;
  message?: string;
  diffs: RowDiff[];
  movableCount: number;
};

function pairByLabel(existing: ExistingRow[], proposed: ProposedRow[]): RowDiff[] {
  const usedProposedIdx = new Set<number>();
  const diffs: RowDiff[] = existing.map((ex) => {
    const idx = proposed.findIndex(
      (p, i) => !usedProposedIdx.has(i) && (p.installment_label ?? "") === (ex.installment_label ?? ""),
    );
    if (idx !== -1) {
      usedProposedIdx.add(idx);
      return { existing: ex, proposed: proposed[idx], willMove: false };
    }
    return { existing: ex, proposed: null, willMove: false };
  });

  for (const d of diffs) {
    const ex = d.existing;
    if (!d.proposed) { d.skipReason = "no matching proposed row"; continue; }
    if (ex.manual_status_override) { d.skipReason = "manual override"; continue; }
    if (ex.payment_status === "paid" || ex.is_paid || (ex.amount_paid ?? 0) > 0) { d.skipReason = "paid/partial"; continue; }
    if (ex.payment_status === "void") { d.skipReason = "void"; continue; }
    if (ex.payment_status === "disputed") { d.skipReason = "disputed"; continue; }
    const histLen = Array.isArray(ex.payment_history) ? ex.payment_history.length : 0;
    if (histLen > 0) { d.skipReason = "has payment history"; continue; }
    const sameDate = d.proposed.due_date === ex.due_date;
    const sameAmt = Math.abs(d.proposed.amount_due - Number(ex.amount_due)) < 0.005;
    if (sameDate && sameAmt) { d.skipReason = "no change"; continue; }
    d.willMove = true;
  }
  return diffs;
}

export async function previewInvoice(invoiceId: string): Promise<InvoicePreview | null> {
  const { data: inv, error: invErr } = await supabase
    .from("vendor_invoices")
    .select("id, invoice_number, vendor, invoice_date, delivery_date, total, payment_terms, po_number, doc_type")
    .eq("id", invoiceId)
    .maybeSingle();
  if (invErr || !inv) return null;
  if (!inv.delivery_date) return null;

  const { data: existingRows, error: payErr } = await supabase
    .from("invoice_payments")
    .select("id, installment_label, due_date, amount_due, amount_paid, is_paid, payment_status, manual_status_override, payment_history")
    .eq("invoice_id", invoiceId)
    .order("due_date");
  if (payErr) return null;

  const guard = await runRecalcGuards(
    inv.id,
    inv.invoice_date as string,
    Number(inv.total),
    inv.vendor as string,
    inv.invoice_number as string,
    (inv as any).po_number ?? null,
    inv.payment_terms ?? null,
    inv.delivery_date as string,
  );

  const base = {
    invoiceId: inv.id,
    invoiceNumber: inv.invoice_number,
    vendor: inv.vendor,
    invoiceDate: inv.invoice_date as string,
    deliveryDate: inv.delivery_date as string,
    total: Number(inv.total),
    paymentTerms: inv.payment_terms ?? null,
    poNumber: (inv as any).po_number ?? null,
  };

  if (guard.guard === "credit_memo") {
    return { ...base, guard: "credit_memo", blocked: true, message: guard.message, diffs: [], movableCount: 0 };
  }
  if (guard.guard === "paid_rows") {
    return { ...base, guard: "paid_rows", blocked: true, message: guard.message, diffs: [], movableCount: 0 };
  }

  const proposed = calculateInstallments(
    inv.invoice_date as string,
    Number(inv.total),
    inv.vendor as string,
    inv.invoice_number as string,
    (inv as any).po_number ?? null,
    inv.payment_terms ?? null,
    inv.delivery_date as string,
  );
  if (proposed.length === 0) {
    return { ...base, guard: "no_terms", blocked: true, message: "Terms engine returned no installments", diffs: [], movableCount: 0 };
  }
  if ((existingRows ?? []).length === 0) {
    return { ...base, guard: "no_existing", blocked: true, message: "No existing installments to update", diffs: [], movableCount: 0 };
  }

  const diffs = pairByLabel(
    (existingRows ?? []) as ExistingRow[],
    proposed.map(p => ({ installment_label: p.installment_label, due_date: p.due_date, amount_due: p.amount_due })),
  );
  const movableCount = diffs.filter(d => d.willMove).length;
  const guardKind = guard.guard === "manual_correction" ? "manual_correction" : "clean";
  return { ...base, guard: guardKind, blocked: false, diffs, movableCount };
}

export async function applyInvoiceBackfill(preview: InvoicePreview): Promise<{ updated: number }> {
  if (preview.blocked) return { updated: 0 };
  const movers = preview.diffs.filter(d => d.willMove && d.proposed);
  if (movers.length === 0) return { updated: 0 };

  const nowIso = new Date().toISOString();
  const oldSnapshot = movers.map(m => ({
    id: m.existing.id,
    installment_label: m.existing.installment_label,
    due_date: m.existing.due_date,
    amount_due: Number(m.existing.amount_due),
  }));
  const newSnapshot = movers.map(m => ({
    id: m.existing.id,
    installment_label: m.existing.installment_label,
    due_date: m.proposed!.due_date,
    amount_due: m.proposed!.amount_due,
  }));

  for (const m of movers) {
    const histArr = Array.isArray(m.existing.payment_history) ? m.existing.payment_history : [];
    const event = {
      action: BACKFILL_AUDIT_ACTION,
      at: nowIso,
      old_due_date: m.existing.due_date,
      new_due_date: m.proposed!.due_date,
      old_amount_due: Number(m.existing.amount_due),
      new_amount_due: m.proposed!.amount_due,
      delivery_date: preview.deliveryDate,
      reason: "EOM schedule re-anchored on backfilled delivery_date",
    };
    const newHist = [...histArr, event];
    const { error } = await supabase
      .from("invoice_payments")
      .update({
        due_date: m.proposed!.due_date,
        amount_due: m.proposed!.amount_due,
        balance_remaining: m.proposed!.amount_due,
        payment_history: newHist,
      } as any)
      .eq("id", m.existing.id);
    if (error) throw error;
  }

  const { data: allRows } = await supabase
    .from("invoice_payments")
    .select("due_date")
    .eq("invoice_id", preview.invoiceId)
    .order("due_date", { ascending: true })
    .limit(1);
  if (allRows && allRows.length > 0 && allRows[0].due_date) {
    await supabase
      .from("vendor_invoices")
      .update({ due_date: allRows[0].due_date } as any)
      .eq("id", preview.invoiceId);
  }

  await supabase.from("recalc_audit_log" as any).insert({
    invoice_id: preview.invoiceId,
    invoice_number: preview.invoiceNumber,
    vendor: preview.vendor,
    action: BACKFILL_AUDIT_ACTION,
    old_values: oldSnapshot,
    new_values: newSnapshot,
    metadata: {
      delivery_date: preview.deliveryDate,
      invoice_date: preview.invoiceDate,
      payment_terms: preview.paymentTerms,
      moved: movers.length,
      total_rows: preview.diffs.length,
      guard: preview.guard,
    },
    performed_by: "josh",
  });

  return { updated: movers.length };
}
