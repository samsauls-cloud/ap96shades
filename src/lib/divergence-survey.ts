/**
 * divergence-survey.ts
 *
 * Read-only audit utility: compares stored invoice_payments rows
 * against what the current terms engine would produce, and reports
 * any invoices where they diverge.
 *
 * Used by AuditPanel "Schedule Divergences" section.
 *
 * Skip rules (mirrors guard logic — those invoices are not eligible
 * for regeneration anyway):
 *   - any paid row (is_paid OR payment_status in 'paid'/'partial')
 *   - any credit row (terms='credit_memo' OR installment_label='Credit' OR amount_due<0)
 */

import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabase-fetch-all";
import { resolvePaymentSchedule } from "@/lib/payment-terms-engine";

export interface DivergentRow {
  due_date: string;
  amount_due: number;
}

export interface DivergentInvoice {
  invoice_id: string;
  invoice_number: string;
  vendor: string;
  invoice_date: string;
  total: number;
  payment_terms: string | null;
  /** human summary like "2 rows date-shifted by -1d" */
  summary: string;
  /** parsed reasons: each entry one issue */
  reasons: string[];
  /** absolute magnitude in days for the largest date shift; 0 if only amount/count */
  magnitude_days: number;
  /** absolute magnitude in dollars for largest amount delta; 0 if only date/count */
  magnitude_dollars: number;
  stored: DivergentRow[];
  expected: DivergentRow[];
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function categoryFromTerms(_vendor: string, terms: string | null): "Procurement" | "Special Order" | "Credit" {
  // Divergence survey skips credits via row filter; default everything else to Procurement
  if ((terms ?? "").toLowerCase() === "credit_memo") return "Credit";
  return "Procurement";
}

export async function surveyScheduleDivergences(): Promise<DivergentInvoice[]> {
  // Pull confirmed invoices and all payment rows
  const invoices = await fetchAllRows<any>(
    () =>
      supabase
        .from("vendor_invoices")
        .select("id, invoice_number, vendor, invoice_date, total, payment_terms, terms_status, doc_type")
        .eq("terms_status", "confirmed")
  );
  const payments = await fetchAllRows<any>(
    () =>
      supabase
        .from("invoice_payments")
        .select("invoice_id, due_date, amount_due, is_paid, payment_status, terms, installment_label")
  );

  const byInvoice = new Map<string, any[]>();
  for (const p of payments) {
    if (!p.invoice_id) continue;
    if (!byInvoice.has(p.invoice_id)) byInvoice.set(p.invoice_id, []);
    byInvoice.get(p.invoice_id)!.push(p);
  }

  const divergent: DivergentInvoice[] = [];

  for (const inv of invoices) {
    if (!["INVOICE", "invoice"].includes(inv.doc_type)) continue;
    const rows = byInvoice.get(inv.id) ?? [];
    if (rows.length === 0) continue;
    // Skip paid
    if (rows.some((r) => r.is_paid || ["paid", "partial"].includes(r.payment_status))) continue;
    // Skip credits
    if (rows.some((r) => r.terms === "credit_memo" || r.installment_label === "Credit" || Number(r.amount_due) < 0))
      continue;

    const invDate = new Date(inv.invoice_date + "T00:00:00");
    const total = Number(inv.total) || 0;
    const category = categoryFromTerms(inv.vendor, inv.payment_terms);

    let schedule;
    try {
      schedule = resolvePaymentSchedule(inv.vendor, category, invDate, total, inv.payment_terms);
    } catch {
      continue;
    }
    if (!schedule || !schedule.tranches || schedule.tranches.length === 0) continue;

    const expected: DivergentRow[] = schedule.tranches.map((t) => ({
      due_date: fmt(t.due_date),
      amount_due: Math.round(t.amount_fraction * total * 100) / 100,
    }));
    // Adjust last expected row for rounding so total matches
    if (expected.length > 0) {
      const sumButLast = expected.slice(0, -1).reduce((s, r) => s + r.amount_due, 0);
      expected[expected.length - 1].amount_due = Math.round((total - sumButLast) * 100) / 100;
    }

    const stored: DivergentRow[] = [...rows]
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
      .map((r) => ({ due_date: r.due_date, amount_due: Number(r.amount_due) }));

    const reasons: string[] = [];
    let maxDayShift = 0;
    let maxDollarShift = 0;

    if (stored.length !== expected.length) {
      reasons.push(`row count differs: ${stored.length} stored vs ${expected.length} expected`);
    } else {
      const dateDiffs: number[] = [];
      const amtDiffs: number[] = [];
      for (let i = 0; i < stored.length; i++) {
        if (stored[i].due_date !== expected[i].due_date) {
          const a = new Date(stored[i].due_date + "T00:00:00").getTime();
          const b = new Date(expected[i].due_date + "T00:00:00").getTime();
          const days = Math.round((a - b) / 86_400_000);
          dateDiffs.push(days);
          maxDayShift = Math.max(maxDayShift, Math.abs(days));
        }
        const dollarDiff = Math.abs(stored[i].amount_due - expected[i].amount_due);
        if (dollarDiff > 0.01) {
          amtDiffs.push(dollarDiff);
          maxDollarShift = Math.max(maxDollarShift, dollarDiff);
        }
      }
      if (dateDiffs.length) {
        const allSame = dateDiffs.every((d) => d === dateDiffs[0]);
        if (allSame) {
          reasons.push(`${dateDiffs.length} row${dateDiffs.length === 1 ? "" : "s"} date-shifted by ${dateDiffs[0] > 0 ? "+" : ""}${dateDiffs[0]}d`);
        } else {
          reasons.push(`${dateDiffs.length} row${dateDiffs.length === 1 ? "" : "s"} date-shifted (max ${maxDayShift}d)`);
        }
      }
      if (amtDiffs.length) {
        reasons.push(`${amtDiffs.length} amount mismatch${amtDiffs.length === 1 ? "" : "es"} (max $${maxDollarShift.toFixed(2)})`);
      }
    }

    if (reasons.length === 0) continue;

    divergent.push({
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      vendor: inv.vendor,
      invoice_date: inv.invoice_date,
      total,
      payment_terms: inv.payment_terms,
      summary: reasons.join(" · "),
      reasons,
      magnitude_days: maxDayShift,
      magnitude_dollars: maxDollarShift,
      stored,
      expected,
    });
  }

  return divergent;
}
