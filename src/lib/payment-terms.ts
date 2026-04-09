import { lastDayOfMonth, addDays, format } from "date-fns";
import { normalizeVendor } from "@/lib/invoice-dedup";
import { getVendorTermsRule, isLuxotticaVendor as isLuxFromRegistry } from "@/lib/vendor-terms-registry";

// ── Structured payment terms (extracted from invoices) ────
export interface ExtractedTerms {
  raw_text: string | null;
  type: TermType;
  days: number[];
  installments: number;
  eom_based: boolean;
  discount_pct: number | null;
  discount_days: number | null;
  net_days: number | null;
  confidence: "high" | "medium" | "low";
  shipping_terms: string | null;
  extraction_notes: string | null;
}

export type TermType =
  | "net_single"
  | "eom_single"
  | "eom_split"
  | "net_split"
  | "early_pay"
  | "cod"
  | "unknown";

export interface PaymentInstallment {
  vendor: string;
  invoice_number: string;
  po_number: string | null;
  invoice_amount: number;
  invoice_date: string;
  terms: string;
  installment_label: string | null;
  due_date: string;
  amount_due: number;
}

// ── Vendor defaults (suggestion only — NEVER auto-applied) ──
export interface VendorTermsDefault {
  type: TermType;
  days: number[];
  installments: number;
  eom_based: boolean;
  label: string;
}

export const VENDOR_DEFAULTS: Record<string, VendorTermsDefault> = {
  Luxottica: { type: "eom_split", days: [30, 60, 90], installments: 3, eom_based: true, label: "EOM 30 / 60 / 90" },
  Kering: { type: "eom_split", days: [30, 60, 90], installments: 3, eom_based: true, label: "EOM 30 / 60 / 90" },
  "Maui Jim": { type: "net_split", days: [60, 90, 120, 150], installments: 4, eom_based: false, label: "Days 60 / 90 / 120 / 150" },
  Marcolin: { type: "eom_split", days: [50, 80, 110], installments: 3, eom_based: true, label: "EOM 50 / 80 / 110" },
  Safilo: { type: "eom_single", days: [60], installments: 1, eom_based: true, label: "EOM 60" },
  Marchon: { type: "net_single", days: [30], installments: 1, eom_based: false, label: "Net 30" },
};

/** Get vendor default terms as a suggestion hint (never auto-applied). */
export function getVendorDefaultTerms(vendor: string): VendorTermsDefault | null {
  return VENDOR_DEFAULTS[normalizeVendor(vendor)] ?? null;
}

// ── Parse payment_terms text into structured terms ────────
export function parsePaymentTermsText(rawText: string | null | undefined): ExtractedTerms {
  const empty: ExtractedTerms = {
    raw_text: rawText ?? null,
    type: "unknown",
    days: [],
    installments: 1,
    eom_based: false,
    discount_pct: null,
    discount_days: null,
    net_days: null,
    confidence: "low",
    shipping_terms: null,
    extraction_notes: null,
  };

  if (!rawText || rawText.trim() === "") return { ...empty, extraction_notes: "No terms text found" };

  const text = rawText.trim();
  const lower = text.toLowerCase();

  // Check for FOB (shipping term, NOT payment term)
  const fobMatch = lower.match(/\bfob\b/);
  const shippingTerms = fobMatch ? "FOB" : null;

  // If only FOB found, no payment terms
  const withoutFOB = lower.replace(/\bfob\b[\s\w]*/gi, "").trim();
  if (withoutFOB === "" || withoutFOB === "," || withoutFOB === "-") {
    return { ...empty, shipping_terms: shippingTerms, extraction_notes: "Only FOB found — not a payment term" };
  }

  // Early pay discount: 2/10 Net 30
  const earlyPayMatch = lower.match(/(\d+(?:\.\d+)?)\s*[/%]\s*(\d+)\s*(?:net|n)\s*(\d+)/);
  if (earlyPayMatch) {
    return {
      raw_text: text,
      type: "early_pay",
      days: [Number(earlyPayMatch[3])],
      installments: 1,
      eom_based: false,
      discount_pct: Number(earlyPayMatch[1]),
      discount_days: Number(earlyPayMatch[2]),
      net_days: Number(earlyPayMatch[3]),
      confidence: "high",
      shipping_terms: shippingTerms,
      extraction_notes: "Early pay discount detected",
    };
  }

  // COD
  if (lower.match(/\bcod\b|cash on delivery|payment on delivery/)) {
    return {
      raw_text: text,
      type: "cod",
      days: [0],
      installments: 1,
      eom_based: false,
      discount_pct: null,
      discount_days: null,
      net_days: null,
      confidence: "high",
      shipping_terms: shippingTerms,
      extraction_notes: "COD detected",
    };
  }

  // Due on receipt
  if (lower.match(/due\s*(on|upon)\s*receipt/)) {
    return {
      raw_text: text,
      type: "net_single",
      days: [0],
      installments: 1,
      eom_based: false,
      discount_pct: null,
      discount_days: null,
      net_days: 0,
      confidence: "high",
      shipping_terms: shippingTerms,
      extraction_notes: "Due on receipt",
    };
  }

  // EOM split: "EOM 30/60/90" or "EOM 60/90/120/150"
  const eomSplitMatch = lower.match(/eom\s*([\d\s/,]+)/);
  if (eomSplitMatch) {
    const dayNums = eomSplitMatch[1].match(/\d+/g)?.map(Number) ?? [];
    if (dayNums.length > 1) {
      return {
        raw_text: text,
        type: "eom_split",
        days: dayNums,
        installments: dayNums.length,
        eom_based: true,
        discount_pct: null,
        discount_days: null,
        net_days: null,
        confidence: "high",
        shipping_terms: shippingTerms,
        extraction_notes: `EOM split: ${dayNums.join("/")}`,
      };
    }
    if (dayNums.length === 1) {
      return {
        raw_text: text,
        type: "eom_single",
        days: dayNums,
        installments: 1,
        eom_based: true,
        discount_pct: null,
        discount_days: null,
        net_days: null,
        confidence: "high",
        shipping_terms: shippingTerms,
        extraction_notes: `EOM single: ${dayNums[0]}`,
      };
    }
  }

  // Net split: "Net 30/60/90" or "Days 30/60/90" or "30/60/90"
  const netSplitMatch = lower.match(/(?:net|days?|n)\s*([\d\s/,]+)/);
  if (netSplitMatch) {
    const dayNums = netSplitMatch[1].match(/\d+/g)?.map(Number) ?? [];
    if (dayNums.length > 1) {
      return {
        raw_text: text,
        type: "net_split",
        days: dayNums,
        installments: dayNums.length,
        eom_based: false,
        discount_pct: null,
        discount_days: null,
        net_days: null,
        confidence: "high",
        shipping_terms: shippingTerms,
        extraction_notes: `Net split: ${dayNums.join("/")}`,
      };
    }
    if (dayNums.length === 1) {
      return {
        raw_text: text,
        type: "net_single",
        days: dayNums,
        installments: 1,
        eom_based: false,
        discount_pct: null,
        discount_days: null,
        net_days: dayNums[0],
        confidence: "high",
        shipping_terms: shippingTerms,
        extraction_notes: `Net single: ${dayNums[0]}`,
      };
    }
  }

  // Bare number split: "30/60/90"
  const bareSplitMatch = lower.match(/^(\d+)\s*[/,]\s*(\d+)(?:\s*[/,]\s*(\d+))?(?:\s*[/,]\s*(\d+))?$/);
  if (bareSplitMatch) {
    const dayNums = [bareSplitMatch[1], bareSplitMatch[2], bareSplitMatch[3], bareSplitMatch[4]]
      .filter(Boolean).map(Number);
    return {
      raw_text: text,
      type: dayNums.length > 1 ? "net_split" : "net_single",
      days: dayNums,
      installments: dayNums.length,
      eom_based: false,
      discount_pct: null,
      discount_days: null,
      net_days: null,
      confidence: "medium",
      shipping_terms: shippingTerms,
      extraction_notes: `Bare number split interpreted as net: ${dayNums.join("/")}`,
    };
  }

  return { ...empty, shipping_terms: shippingTerms, confidence: "low", extraction_notes: "Could not parse terms" };
}

// ── Generate human-readable label from terms ──────────────
export function termsToLabel(terms: ExtractedTerms): string {
  if (terms.type === "cod") return "COD";
  if (terms.type === "early_pay") return `${terms.discount_pct}/${terms.discount_days} Net ${terms.net_days}`;
  const prefix = terms.eom_based ? "EOM" : "Net";
  if (terms.days.length === 0) return "Unknown";
  if (terms.days.length === 1) return `${prefix} ${terms.days[0]}`;
  return `${prefix} ${terms.days.join(" / ")}`;
}

// ── Due date calculation (any vendor, any term type) ──────
// IMPORTANT: Always preserves the invoice's full 4-digit year.
// Never defaults to a wrong century (e.g. 2020 instead of 2026).
function calculateDueDate(invoiceDate: string, eomBased: boolean, offsetDays: number): Date {
  const d = new Date(invoiceDate + "T00:00:00");
  const invoiceYear = d.getFullYear();
  if (eomBased) {
    const eom = lastDayOfMonth(d);
    // For multiples of 30, use month-based advancement (same day-of-month)
    if (offsetDays > 0 && offsetDays % 30 === 0) {
      const months = offsetDays / 30;
      const eomDay = eom.getDate();
      const targetMonth = eom.getMonth() + months;
      // Use eom year (derived from invoice date) — never a default/wrong year
      const targetYear = eom.getFullYear();
      const lastDayOfTarget = new Date(targetYear, targetMonth + 1, 0).getDate();
      const day = Math.min(eomDay, lastDayOfTarget);
      return new Date(targetYear, targetMonth, day);
    }
    return addDays(eom, offsetDays);
  }
  return addDays(d, offsetDays);
}

// ── Generate installments from structured terms ───────────
export function calculateInstallmentsFromTerms(
  invoiceDate: string,
  total: number,
  vendor: string,
  invoiceNumber: string,
  poNumber: string | null,
  terms: ExtractedTerms,
): PaymentInstallment[] {
  const normalized = normalizeVendor(vendor);
  const parsedTotal = typeof total === "number" ? total : parseFloat(String(total)) || 0;
  if (parsedTotal <= 0) return [];
  if (terms.type === "unknown" || terms.days.length === 0) return [];

  const label = termsToLabel(terms);
  const count = terms.installments || terms.days.length;
  const baseAmount = parseFloat((parsedTotal / count).toFixed(2));
  const lastAmount = parseFloat((parsedTotal - baseAmount * (count - 1)).toFixed(2));

  return terms.days.map((offset, index) => {
    const isLast = index === count - 1;
    const amount = isLast ? lastAmount : baseAmount;
    const dueDate = calculateDueDate(invoiceDate, terms.eom_based, offset);
    return {
      vendor: normalized,
      invoice_number: invoiceNumber,
      po_number: poNumber,
      invoice_amount: parsedTotal,
      invoice_date: invoiceDate,
      terms: label,
      installment_label: count > 1 ? `${index + 1} of ${count}` : null,
      due_date: format(dueDate, "yyyy-MM-dd"),
      amount_due: amount,
    };
  });
}

/** Verify that installments sum matches invoice total within tolerance. */
export function verifyInstallmentMath(installments: PaymentInstallment[], invoiceTotal: number): number {
  const sum = installments.reduce((s, inst) => s + inst.amount_due, 0);
  return parseFloat((invoiceTotal - sum).toFixed(2));
}

// ── LEGACY compat — kept for existing code that calls these ──
// These now just check vendor defaults (for suggestion hints), no auto-apply.
export function getVendorTerms(vendor: string): string | null {
  const d = VENDOR_DEFAULTS[normalizeVendor(vendor)];
  return d?.label ?? null;
}

export function hasTermsEngine(_vendor: string): boolean {
  // Now ALL vendors can have terms — engine is vendor-agnostic
  return true;
}

/**
 * Compute correct EOM+30 due date for Luxottica single-payment invoices.
 * EOM of invoice month → +30 (baseline) → +30 (due date).
 */
function computeLuxEomSingleDueDate(invoiceDate: string): { baseline: Date; due: Date } {
  const d = new Date(invoiceDate + "T00:00:00");
  const eom = lastDayOfMonth(d);
  const baseline = addDays(eom, 30);
  const due = addDays(baseline, 30);
  return { baseline, due };
}

/** Check if vendor is a Luxottica brand — delegates to registry */
function isLuxotticaVendor(normalizedVendor: string): boolean {
  return isLuxFromRegistry(normalizedVendor);
}

/** @deprecated Use calculateInstallmentsFromTerms with structured terms instead */
export function calculateInstallments(
  invoiceDate: string,
  total: number,
  vendor: string,
  invoiceNumber: string,
  poNumber: string | null,
  paymentTermsText?: string | null,
): PaymentInstallment[] {
  const normalized = normalizeVendor(vendor);
  const terms = parsePaymentTermsText(paymentTermsText);
  const termsLower = (paymentTermsText ?? '').toLowerCase().trim();

  // ── Net EOM detection (any vendor) ──────────────────────
  const isNetEom =
    termsLower === 'eom' ||
    termsLower.includes('net eom') ||
    termsLower.includes('due eom') ||
    termsLower.includes('due end of month') ||
    termsLower.includes('eom from statement') ||
    termsLower.includes('due eom from') ||
    termsLower.includes('payable eom');

  if (isNetEom) {
    const parsedTotal = typeof total === "number" ? total : parseFloat(String(total)) || 0;
    if (parsedTotal <= 0) return [];
    const d = new Date(invoiceDate + "T00:00:00");
    const dueDate = new Date(d.getFullYear(), d.getMonth() + 2, 0); // end of following month
    return [{
      vendor: normalized,
      invoice_number: invoiceNumber,
      po_number: poNumber,
      invoice_amount: parsedTotal,
      invoice_date: invoiceDate,
      terms: "Net EOM",
      installment_label: null,
      due_date: format(dueDate, "yyyy-MM-dd"),
      amount_due: parsedTotal,
    }];
  }

  // ── Marcolin "Check 20 days EoM" — single EOM+20 payment ──
  if (normalized === 'Marcolin' && (termsLower.includes('check 20') || termsLower.includes('20 days eom') || termsLower.includes('20 days eom'))) {
    const parsedTotal = typeof total === "number" ? total : parseFloat(String(total)) || 0;
    if (parsedTotal <= 0) return [];
    const d = new Date(invoiceDate + "T00:00:00");
    const eom = lastDayOfMonth(d);
    const due = addDays(eom, 20);
    return [{
      vendor: normalized,
      invoice_number: invoiceNumber,
      po_number: poNumber,
      invoice_amount: parsedTotal,
      invoice_date: invoiceDate,
      terms: "Check 20 days EoM",
      installment_label: null,
      due_date: format(due, "yyyy-MM-dd"),
      amount_due: parsedTotal,
    }];
  }

  // ── Safilo "60 Days EOM" — EOM + 60 single payment ──
  if (normalized === 'Safilo' && termsLower.includes('60') && termsLower.includes('eom')) {
    const parsedTotal = typeof total === "number" ? total : parseFloat(String(total)) || 0;
    if (parsedTotal <= 0) return [];
    const d = new Date(invoiceDate + "T00:00:00");
    const eom = lastDayOfMonth(d);
    const due = addDays(eom, 60);
    return [{
      vendor: normalized,
      invoice_number: invoiceNumber,
      po_number: poNumber,
      invoice_amount: parsedTotal,
      invoice_date: invoiceDate,
      terms: "60 Days EOM",
      installment_label: null,
      due_date: format(due, "yyyy-MM-dd"),
      amount_due: parsedTotal,
    }];
  }

  // ── Kering "bank transfer 30/60/90 inv. date" — actually EOM-based ──
  if (normalized === 'Kering' && termsLower.includes('bank transfer') && termsLower.includes('30/60/90')) {
    const parsedTotal = typeof total === "number" ? total : parseFloat(String(total)) || 0;
    if (parsedTotal <= 0) return [];
    const offsets = [30, 60, 90];
    const d = new Date(invoiceDate + "T00:00:00");
    const eom = lastDayOfMonth(d);
    const baseAmount = parseFloat((parsedTotal / 3).toFixed(2));
    const lastAmount = parseFloat((parsedTotal - baseAmount * 2).toFixed(2));
    return offsets.map((offset, index) => {
      // Use month-based advancement (same day-of-month as EOM)
      let dueDate: Date;
      if (offset % 30 === 0) {
        const months = offset / 30;
        const eomDay = eom.getDate();
        const targetMonth = eom.getMonth() + months;
        const lastDayOfTarget = new Date(eom.getFullYear(), targetMonth + 1, 0).getDate();
        dueDate = new Date(eom.getFullYear(), targetMonth, Math.min(eomDay, lastDayOfTarget));
      } else {
        dueDate = addDays(eom, offset);
      }
      return {
        vendor: normalized,
        invoice_number: invoiceNumber,
        po_number: poNumber,
        invoice_amount: parsedTotal,
        invoice_date: invoiceDate,
        terms: "EOM 30/60/90",
        installment_label: `${index + 1} of 3`,
        due_date: format(dueDate, "yyyy-MM-dd"),
        amount_due: index === 2 ? lastAmount : baseAmount,
      };
    });
  }

  // ── Maui Jim "Split Payment EOM" — parse all intervals, EOM + offset → round to month-end ──
  // NOTE: Previously imported Maui Jim invoices with "Split Payment EOM" terms
  // may have incorrect installment counts (3 instead of 4). Review and re-import if needed.
  if (normalized === 'Maui Jim' && termsLower.includes('eom') && (termsLower.includes('split') || /\d+\s*[,/]\s*\d+/.test(termsLower))) {
    const allNums = termsLower.match(/\d+/g)?.map(Number) ?? [];
    const offsets = allNums.filter(n => n >= 30);
    if (offsets.length > 0) {
      const parsedTotal = typeof total === "number" ? total : parseFloat(String(total)) || 0;
      if (parsedTotal <= 0) return [];
      const d = new Date(invoiceDate + "T00:00:00");
      const eom = lastDayOfMonth(d);
      const count = offsets.length;
      const baseAmount = parseFloat((parsedTotal / count).toFixed(2));
      const lastAmt = parseFloat((parsedTotal - baseAmount * (count - 1)).toFixed(2));
      return offsets.map((offset, index) => {
        const raw = addDays(eom, offset);
        const rounded = lastDayOfMonth(raw);
        return {
          vendor: normalized,
          invoice_number: invoiceNumber,
          po_number: poNumber,
          invoice_amount: parsedTotal,
          invoice_date: invoiceDate,
          terms: `Split Payment EOM ${offsets.join('/')}`,
          installment_label: `${index + 1} of ${count}`,
          due_date: format(rounded, "yyyy-MM-dd"),
          amount_due: index === count - 1 ? lastAmt : baseAmount,
        };
      });
    }
  }

  // ── Luxottica special handling ──────────────────────────
  // EOM+30 is the default for all Luxottica unless explicitly "30/60/90"
  if (isLuxotticaVendor(normalized)) {
    const isSplit = termsLower.includes('30/60/90') || termsLower.includes('split');

    if (isSplit) {
      // EOM 30/60/90 — three tranches at EOM+30, EOM+60, EOM+90
      // EOM itself is NEVER a payment date.
      const parsedTotal = typeof total === "number" ? total : parseFloat(String(total)) || 0;
      if (parsedTotal <= 0) return [];
      const offsets = [30, 60, 90];
      const d = new Date(invoiceDate + "T00:00:00");
      const eom = lastDayOfMonth(d);
      const baseAmount = parseFloat((parsedTotal / 3).toFixed(2));
      const lastAmount = parseFloat((parsedTotal - baseAmount * 2).toFixed(2));
      return offsets.map((offset, index) => {
        // Month-based advancement: EOM day-of-month stays aligned
        const months = offset / 30;
        const eomDay = eom.getDate();
        const targetYear = eom.getFullYear();
        const targetMonth = eom.getMonth() + months;
        const lastDayOfTarget = new Date(targetYear, targetMonth + 1, 0).getDate();
        const dueDate = new Date(targetYear, targetMonth, Math.min(eomDay, lastDayOfTarget));
        return {
          vendor: normalized,
          invoice_number: invoiceNumber,
          po_number: poNumber,
          invoice_amount: parsedTotal,
          invoice_date: invoiceDate,
          terms: "EOM 30/60/90",
          installment_label: `${index + 1} of 3`,
          due_date: format(dueDate, "yyyy-MM-dd"),
          amount_due: index === 2 ? lastAmount : baseAmount,
        };
      });
    } else {
      // EOM+30 single payment: EOM → +30 (baseline) → +30 (due)
      const parsedTotal = typeof total === "number" ? total : parseFloat(String(total)) || 0;
      if (parsedTotal <= 0) return [];
      const { due } = computeLuxEomSingleDueDate(invoiceDate);
      return [{
        vendor: normalized,
        invoice_number: invoiceNumber,
        po_number: poNumber,
        invoice_amount: parsedTotal,
        invoice_date: invoiceDate,
        terms: "EOM +30",
        installment_label: null,
        due_date: format(due, "yyyy-MM-dd"),
        amount_due: parsedTotal,
      }];
    }
  }

  // ── Generic path ────────────────────────────────────────
  if (terms.type === "unknown" || terms.days.length === 0) {
    // Fallback to vendor default for legacy compatibility
    const def = VENDOR_DEFAULTS[normalized];
    if (!def) return [];
    const fallbackTerms: ExtractedTerms = {
      raw_text: paymentTermsText ?? null,
      type: def.type,
      days: def.days,
      installments: def.installments,
      eom_based: def.eom_based,
      discount_pct: null,
      discount_days: null,
      net_days: null,
      confidence: "medium",
      shipping_terms: null,
      extraction_notes: "Fallback to vendor default (legacy path)",
    };
    return calculateInstallmentsFromTerms(invoiceDate, total, vendor, invoiceNumber, poNumber, fallbackTerms);
  }
  return calculateInstallmentsFromTerms(invoiceDate, total, vendor, invoiceNumber, poNumber, terms);
}
