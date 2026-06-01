/**
 * invoice-preflight.ts
 *
 * Centralized pre-save validation gate for invoices.
 * Run this BEFORE writing the invoice + schedule. If it returns blockers,
 * do not save. If only warnings, prompt the user with "Save anyway?".
 *
 * Reuses existing dedup + vendor + terms logic — do NOT duplicate rules here.
 *
 * NOTE: This does NOT replace the destructive-write Guards in payment-queries.ts
 * or the payment_history invariant — it's a pre-save sanity layer on top.
 */

import { supabase } from "@/integrations/supabase/client";
import { normalizeVendor, normalizeVendorAsync, isKnownVendor } from "@/lib/invoice-dedup";
import { getDynamicVendorTermsRule } from "@/lib/dynamic-vendor-lookup";
import { getVendorLockedTerms } from "@/lib/vendor-terms-registry";
import { toast } from "sonner";

export interface PreflightInvoiceInput {
  id?: string | null;                  // pass when updating an existing row (to exclude self from dup check)
  vendor: string;
  invoice_number: string;
  invoice_date: string;                // YYYY-MM-DD
  total: number;
  payment_terms?: string | null;
  doc_type?: string | null;            // INVOICE | PROFORMA | CREDIT_MEMO | PO | ...
}

export interface PreflightInstallment {
  due_date: string;                    // YYYY-MM-DD
  amount_due: number;
}

export interface PreflightResult {
  blockers: string[];
  warnings: string[];
}

/** Pull the printed N-way day-marker list out of a payment-terms string. */
export function parseTermDayMarkers(termsText: string | null | undefined): number[] {
  if (!termsText) return [];
  const m = String(termsText).match(/\b\d{2,3}(?:\s*[\/,]\s*\d{2,3}){1,}\b/);
  if (!m) return [];
  return m[0]
    .split(/[\/,]/)
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n) && n >= 0);
}

function isCreditOrProforma(docType: string | null | undefined): boolean {
  const t = (docType ?? "").toUpperCase();
  return t === "CREDIT_MEMO" || t === "CREDIT" || t === "PROFORMA";
}

function parseISODate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const THREE_YEARS_DAYS = 365 * 3 + 1;

/**
 * Validate an invoice + its prospective payment schedule before write.
 * Returns blockers (hard-stop) and warnings (soft, dismissible).
 */
export async function validateInvoiceBeforeSave(
  invoice: PreflightInvoiceInput,
  schedule: PreflightInstallment[],
): Promise<PreflightResult> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const isSchedulable = !isCreditOrProforma(invoice.doc_type);
  const total = Number(invoice.total ?? 0);

  // ── CRITICAL (hard block) — schedule checks only apply to schedulable docs ──
  if (isSchedulable) {
    // (1) at least one installment
    if (!Array.isArray(schedule) || schedule.length === 0) {
      blockers.push(
        "No payment installments would be created — the schedule is empty. " +
          "Confirm the vendor's payment terms before saving.",
      );
    } else {
      // (2) sum equals total within $0.02 per installment
      const sum = schedule.reduce((s, r) => s + Number(r.amount_due ?? 0), 0);
      const tolerance = 0.02 * schedule.length;
      const diff = Math.abs(sum - total);
      if (diff > tolerance) {
        blockers.push(
          `Installment amounts ($${sum.toFixed(2)}) do not equal invoice total ` +
            `($${total.toFixed(2)}) — off by $${diff.toFixed(2)} ` +
            `(tolerance $${tolerance.toFixed(2)}).`,
        );
      }

      // (3) installment count == N day-markers parsed from printed terms
      const markers = parseTermDayMarkers(invoice.payment_terms);
      if (markers.length >= 2 && markers.length !== schedule.length) {
        blockers.push(
          `Terms "${invoice.payment_terms}" print ${markers.length} payment ` +
            `markers (${markers.join("/")}) but the schedule has ${schedule.length} ` +
            `installment${schedule.length === 1 ? "" : "s"}.`,
        );
      }

      // (4) due-date sanity
      const invDate = parseISODate(invoice.invoice_date);
      if (!invDate) {
        blockers.push(`Invoice date "${invoice.invoice_date}" is not a valid YYYY-MM-DD.`);
      } else {
        let prevTs = -Infinity;
        let dateProblem = false;
        for (let i = 0; i < schedule.length; i++) {
          const d = parseISODate(schedule[i].due_date);
          if (!d) {
            blockers.push(`Installment ${i + 1} has an invalid due date "${schedule[i].due_date}".`);
            dateProblem = true;
            break;
          }
          if (d.getTime() < invDate.getTime()) {
            blockers.push(
              `Installment ${i + 1} due date (${schedule[i].due_date}) is before ` +
                `invoice date (${invoice.invoice_date}).`,
            );
            dateProblem = true;
            break;
          }
          if (d.getTime() <= prevTs) {
            blockers.push(
              `Installment due dates must be strictly increasing — ` +
                `installment ${i + 1} (${schedule[i].due_date}) is not after the previous one.`,
            );
            dateProblem = true;
            break;
          }
          const daysOut = (d.getTime() - invDate.getTime()) / DAY_MS;
          if (daysOut > THREE_YEARS_DAYS) {
            blockers.push(
              `Installment ${i + 1} due date (${schedule[i].due_date}) is more than ` +
                `3 years after the invoice date — likely a date-parsing flip (e.g. 4/2/26 → 2026-02-04).`,
            );
            dateProblem = true;
            break;
          }
          prevTs = d.getTime();
        }
        void dateProblem;
      }
    }
  }

  // ── ADVISORY (warnings) ────────────────────────────────────────────────
  // (5) duplicate invoice_number for the same canonical vendor
  try {
    const canonicalVendor = await normalizeVendorAsync(invoice.vendor);
    if (invoice.invoice_number && canonicalVendor) {
      let q = supabase
        .from("vendor_invoices")
        .select("id, vendor, invoice_number, status")
        .eq("invoice_number", invoice.invoice_number)
        .ilike("vendor", canonicalVendor)
        .limit(2);
      if (invoice.id) q = q.neq("id", invoice.id);
      const { data } = await q;
      const dupes = (data ?? []).filter(r => (r as any).status !== "void");
      if (dupes.length > 0) {
        warnings.push(
          `An invoice with number "${invoice.invoice_number}" already exists for ` +
            `${canonicalVendor} (id ${dupes[0].id}). Save will create a second record.`,
        );
      }
    }
  } catch (err) {
    console.warn("preflight: duplicate check failed", err);
  }

  // (6) unrecognized / unconfigured vendor
  try {
    const canonical = normalizeVendor(invoice.vendor);
    if (!isKnownVendor(canonical)) {
      const dyn = await getDynamicVendorTermsRule(invoice.vendor);
      const locked = getVendorLockedTerms(canonical);
      if (!dyn && !locked) {
        warnings.push(
          `Vendor "${invoice.vendor}" is not in the terms registry or vendor configuration. ` +
            `Schedules may not generate correctly until you configure it.`,
        );
      }
    }
  } catch (err) {
    console.warn("preflight: vendor recognition check failed", err);
  }

  return { blockers, warnings };
}

/**
 * One-shot helper for save handlers:
 *  - runs validateInvoiceBeforeSave
 *  - shows blocker toast(s) and returns false if any blockers
 *  - shows a "Save anyway?" window.confirm for warnings; returns user's choice
 *  - returns true if clean
 *
 * Use this in confirm/save handlers; do NOT inline the toast/confirm logic
 * at each call site.
 */
export async function runPreflightOrAbort(
  invoice: PreflightInvoiceInput,
  schedule: PreflightInstallment[],
): Promise<boolean> {
  const { blockers, warnings } = await validateInvoiceBeforeSave(invoice, schedule);

  if (blockers.length > 0) {
    toast.error(
      `Cannot save ${invoice.invoice_number || "invoice"}: ` +
        `${blockers.length} blocking issue${blockers.length === 1 ? "" : "s"}`,
      {
        description: blockers.join("\n• ").replace(/^/, "• "),
        duration: 12000,
      },
    );
    return false;
  }

  if (warnings.length > 0) {
    const msg =
      `Heads up before saving ${invoice.invoice_number || "this invoice"}:\n\n• ` +
      warnings.join("\n• ") +
      `\n\nSave anyway?`;
    // window.confirm is intentional — keeps the gate centralized + sync.
    const ok = typeof window !== "undefined" ? window.confirm(msg) : true;
    if (!ok) {
      toast.message("Save cancelled.");
      return false;
    }
  }

  return true;
}
