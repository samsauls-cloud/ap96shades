/**
 * engine-migrations.ts
 *
 * Targeted Option B migrations for historical invoices affected by terms-engine changes.
 *
 * Each migration:
 *  - Identifies a scoped set of invoices (vendor + terms + filter)
 *  - Per invoice: enforces Guard 1 (credits) and Guard 2 (paid rows) — skip if either trips
 *  - Snapshots existing rows, deletes, regenerates via current engine, inserts
 *  - Logs every change to recalc_audit_log with action='engine_migration_<description>'
 *
 * These migrations are NEVER auto-run. They are surfaced in the Audit Panel
 * "Pending Migration" section as an impact report, and execute only when Josh
 * clicks "Approve Migration".
 */

import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabase-fetch-all";
import { resolvePaymentSchedule } from "@/lib/payment-terms-engine";

// ── Guard predicates — exported for testability. The executeMigration path
// re-checks these against fresh DB state; these helpers mirror that logic so
// the impact-report UI and the tests see identical shapes. If you ever change
// what counts as "blocked", change it here AND keep `executeMigration`'s own
// re-check in sync. ────────────────────────────────────────────────────────

type Guard1Row = {
  terms?: string | null;
  installment_label?: string | null;
  amount_due?: number | string | null;
};

type Guard2Row = {
  is_paid?: boolean;
  payment_status?: string | null;
  amount_paid?: number | string | null;
};

/**
 * Guard 1 — blocks migration when any payment row looks like a credit.
 * Credit rows (terms='credit_memo', installment_label='Credit', or
 * negative amount_due) must never have their schedule rewritten.
 */
export function isBlockedByGuard1Credit(rows: readonly Guard1Row[]): boolean {
  return rows.some(
    (r) => r.terms === "credit_memo" || r.installment_label === "Credit" || Number(r.amount_due) < 0
  );
}

/**
 * Guard 2 — blocks migration when any payment row shows payment activity.
 * If is_paid=true, payment_status='paid', or amount_paid>0 on ANY row,
 * the entire invoice is protected (rewriting would corrupt payment history).
 */
export function isBlockedByGuard2Paid(rows: readonly Guard2Row[]): boolean {
  return rows.some(
    (r) => r.is_paid === true || r.payment_status === "paid" || Number(r.amount_paid ?? 0) > 0
  );
}

export type MigrationPattern = "pattern_1_plain_addDays" | "pattern_2_eom_no_round";

export interface MigrationCandidate {
  invoice_id: string;
  invoice_number: string;
  vendor: string;
  invoice_date: string;
  total: number;
  payment_terms: string | null;
  pattern: MigrationPattern;
  /** Existing invoice_payments rows (full data, used for snapshot) */
  stored_rows: any[];
  /** Engine-computed proposed schedule */
  proposed: { due_date: string; amount_due: number; installment_label: string | null; terms: string | null }[];
  /** Per-row day-shifts (positive = stored is later than engine) */
  day_deltas: number[];
  /** Largest absolute day shift on this invoice */
  max_day_shift: number;
  /** Any due_date in the past (relative to today) */
  has_past_due: boolean;
  /** True if 7+ day shift */
  has_large_shift: boolean;
  /** Guard checks (computed pre-migration so the UI can show why some are skipped) */
  blocked_by_guard1_credit: boolean;
  blocked_by_guard2_paid: boolean;
  /** Suggested correct `terms` text label (for Pattern 1 misnamed terms) */
  corrected_terms_label: string | null;
}

export interface MigrationImpactReport {
  candidates: MigrationCandidate[];
  scope_label: string;
  audit_action: string;
}

/**
 * Build the impact report for the Maui Jim "Split Payment EOM" migration.
 * Scope: all confirmed Maui Jim invoices whose stored rows diverge from current engine output,
 * grouped under the single audit action `engine_migration_maui_eom_round`.
 */
export async function buildMauiEomMigrationReport(): Promise<MigrationImpactReport> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const invoices = await fetchAllRows<any>("vendor_invoices", {
    select: "id, invoice_number, vendor, invoice_date, total, payment_terms, terms_status, doc_type",
    orderBy: "invoice_date",
    ascending: false,
    filters: (q) => q.eq("terms_status", "confirmed").ilike("vendor", "%maui%"),
    label: "maui_migration_invoices",
  });

  const payments = await fetchAllRows<any>("invoice_payments", {
    select: "*",
    orderBy: "due_date",
    ascending: true,
    label: "maui_migration_payments",
  });

  const byInvoice = new Map<string, any[]>();
  for (const p of payments) {
    if (!p.invoice_id) continue;
    if (!byInvoice.has(p.invoice_id)) byInvoice.set(p.invoice_id, []);
    byInvoice.get(p.invoice_id)!.push(p);
  }

  const candidates: MigrationCandidate[] = [];

  for (const inv of invoices) {
    if (!["INVOICE", "invoice"].includes(inv.doc_type)) continue;
    const rows = byInvoice.get(inv.id) ?? [];
    if (rows.length === 0) continue;

    // Compute current engine proposal
    const invDate = new Date(inv.invoice_date + "T00:00:00");
    const total = Number(inv.total) || 0;
    let schedule;
    try {
      schedule = resolvePaymentSchedule(inv.vendor, "Procurement", invDate, total, inv.payment_terms);
    } catch {
      continue;
    }
    if (!schedule || !schedule.tranches || schedule.tranches.length === 0) continue;

    const proposed = schedule.tranches.map((t, i, arr) => {
      // Distribute amounts so they sum to exactly `total`; last tranche absorbs rounding
      const isLast = i === arr.length - 1;
      let amount = Math.round(t.amount_fraction * total * 100) / 100;
      return {
        due_date: `${t.due_date.getFullYear()}-${String(t.due_date.getMonth() + 1).padStart(2, "0")}-${String(t.due_date.getDate()).padStart(2, "0")}`,
        amount_due: amount,
        installment_label: t.label,
        terms: "Split Payment EOM 60,90,120,150",
        _isLast: isLast,
      };
    });
    // Adjust last for rounding
    if (proposed.length > 0) {
      const sumButLast = proposed.slice(0, -1).reduce((s, r) => s + r.amount_due, 0);
      proposed[proposed.length - 1].amount_due = Math.round((total - sumButLast) * 100) / 100;
    }

    // Sort stored by due_date for direct comparison
    const storedSorted = [...rows].sort((a, b) => a.due_date.localeCompare(b.due_date));

    // Compute day deltas (positive = stored later than engine)
    const day_deltas: number[] = [];
    let max_day_shift = 0;
    let diverged = storedSorted.length !== proposed.length;
    if (!diverged) {
      for (let i = 0; i < storedSorted.length; i++) {
        const a = new Date(storedSorted[i].due_date + "T00:00:00").getTime();
        const b = new Date(proposed[i].due_date + "T00:00:00").getTime();
        const days = Math.round((a - b) / 86_400_000);
        day_deltas.push(days);
        if (days !== 0) diverged = true;
        const absD = Math.abs(days);
        if (absD > max_day_shift) max_day_shift = absD;
        const dollarDiff = Math.abs(Number(storedSorted[i].amount_due) - proposed[i].amount_due);
        if (dollarDiff > 0.01) diverged = true;
      }
    }
    if (!diverged) continue;

    // Pattern detection: pattern_1 = plain addDays from invoice_date (terms label often "Net 60/90/120/150")
    // pattern_2 = EOM-anchored without rounding to month-end
    // Heuristic: examine the stored.terms label and first row's due_date alignment
    const firstStoredTerms = (storedSorted[0]?.terms ?? "").toString().toLowerCase();
    const isPattern1 =
      firstStoredTerms.includes("net") ||
      (!firstStoredTerms.includes("eom") && !firstStoredTerms.includes("split payment"));
    const pattern: MigrationPattern = isPattern1 ? "pattern_1_plain_addDays" : "pattern_2_eom_no_round";

    // Guard checks (informational only — the migration will re-check)
    const blocked_by_guard1_credit = isBlockedByGuard1Credit(rows);
    const blocked_by_guard2_paid = isBlockedByGuard2Paid(rows);

    const has_past_due = storedSorted.some((r) => new Date(r.due_date + "T00:00:00") < today);
    const has_large_shift = max_day_shift >= 7;

    // Suggested corrected terms label for Pattern 1 (mislabeled)
    const corrected_terms_label =
      pattern === "pattern_1_plain_addDays" && firstStoredTerms !== "split payment eom 60,90,120,150"
        ? "Split Payment EOM 60,90,120,150"
        : null;

    candidates.push({
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      vendor: inv.vendor,
      invoice_date: inv.invoice_date,
      total,
      payment_terms: inv.payment_terms,
      pattern,
      stored_rows: storedSorted,
      proposed: proposed.map(({ _isLast, ...rest }) => rest),
      day_deltas,
      max_day_shift,
      has_past_due,
      has_large_shift,
      blocked_by_guard1_credit,
      blocked_by_guard2_paid,
      corrected_terms_label,
    });
  }

  return {
    candidates,
    scope_label: "Maui Jim — Split Payment EOM round-to-month-end",
    audit_action: "engine_migration_maui_eom_round",
  };
}

export interface MigrationExecutionResult {
  migrated: number;
  skipped_credit: { invoice_number: string }[];
  skipped_paid: { invoice_number: string }[];
  errors: { invoice_number: string; error: string }[];
}

/**
 * Execute a migration report. Triggered ONLY by explicit user "Approve Migration" click.
 * Per invoice: re-checks Guard 1 + Guard 2 against fresh DB state, then snapshot/delete/regenerate/insert,
 * and writes a recalc_audit_log entry tagged with the report's audit_action.
 */
export async function executeMigration(report: MigrationImpactReport): Promise<MigrationExecutionResult> {
  const result: MigrationExecutionResult = { migrated: 0, skipped_credit: [], skipped_paid: [], errors: [] };

  for (const c of report.candidates) {
    try {
      // ── Re-check guards against fresh DB state ──
      const { data: freshRows, error: rowErr } = await supabase
        .from("invoice_payments")
        .select("*")
        .eq("invoice_id", c.invoice_id);
      if (rowErr) throw rowErr;
      const live = freshRows ?? [];

      const isCredit = live.some(
        (r: any) => r.terms === "credit_memo" || r.installment_label === "Credit" || Number(r.amount_due) < 0
      );
      if (isCredit) {
        result.skipped_credit.push({ invoice_number: c.invoice_number });
        continue;
      }
      const isPaid = live.some(
        (r: any) => r.is_paid === true || r.payment_status === "paid" || Number(r.amount_paid ?? 0) > 0
      );
      if (isPaid) {
        result.skipped_paid.push({ invoice_number: c.invoice_number });
        continue;
      }

      // ── Snapshot ──
      const oldSnapshot = live;

      // ── Delete existing ──
      const { error: delErr } = await supabase
        .from("invoice_payments")
        .delete()
        .eq("invoice_id", c.invoice_id);
      if (delErr) throw delErr;

      // ── Build & insert new rows from precomputed proposed schedule ──
      const newRows = c.proposed.map((p) => ({
        invoice_id: c.invoice_id,
        vendor: c.vendor,
        invoice_number: c.invoice_number,
        po_number: null,
        invoice_amount: c.total,
        invoice_date: c.invoice_date,
        terms: c.corrected_terms_label ?? p.terms ?? c.payment_terms,
        installment_label: p.installment_label,
        due_date: p.due_date,
        amount_due: p.amount_due,
        amount_paid: 0,
        balance_remaining: p.amount_due,
        payment_status: "unpaid",
        is_paid: false,
      }));

      const { error: insErr } = await supabase.from("invoice_payments").insert(newRows);
      if (insErr) throw insErr;

      // Sync earliest due_date back to vendor_invoices
      const sortedDates = [...newRows].sort((a, b) => a.due_date.localeCompare(b.due_date));
      if (sortedDates.length > 0) {
        await supabase
          .from("vendor_invoices")
          .update({ due_date: sortedDates[0].due_date } as any)
          .eq("id", c.invoice_id);
      }

      // ── Audit log entry ──
      await supabase.from("recalc_audit_log" as any).insert({
        invoice_id: c.invoice_id,
        invoice_number: c.invoice_number,
        vendor: c.vendor,
        action: report.audit_action,
        old_values: oldSnapshot as any,
        new_values: newRows as any,
        metadata: {
          vendor: c.vendor,
          pattern: c.pattern,
          invoice_number: c.invoice_number,
          payment_terms: c.payment_terms,
          corrected_terms_label: c.corrected_terms_label,
          max_day_shift: c.max_day_shift,
          had_past_due_dates: c.has_past_due,
          approved_by: "migration_ui_button",
        } as any,
        performed_by: "migration_ui_button",
      });

      result.migrated++;
    } catch (e: any) {
      result.errors.push({ invoice_number: c.invoice_number, error: e?.message ?? String(e) });
    }
  }

  return result;
}
