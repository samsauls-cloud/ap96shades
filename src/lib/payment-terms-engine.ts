/**
 * payment-terms-engine.ts
 *
 * Encodes vendor-specific payment terms logic.
 *
 * LUXOTTICA (primary vendor — most complex):
 * ─────────────────────────────────────────
 * Invoicing runs one month behind. The "Baseline Payment Date" in their ledger
 * is always the last day of the document month (end of month = EOM).
 *
 * Their ledger splits every invoice into tranches identified by DE codes:
 *   DE10 = Tranche 1 — due baseline + 30 days
 *   DE30 = Tranche 2 — due baseline + 60 days
 *   DE60 = Tranche 3 — due baseline + 90 days
 *
 * SPECIAL/INDIVIDUAL ORDERS (EOM+30 terms — also Luxottica):
 * ────────────────────────────────────────────────────────────
 * Document date → end of document month (EOM) → +30 days = Baseline
 * Full payment due = Baseline + 30 days
 *
 * OTHER VENDORS (general logic):
 * ────────────────────────────────
 * Net 30 = due 30 days from invoice date (no EOM step).
 * Net 60 = due 60 days from invoice date.
 * EOM 30 = end of invoice month + 30 days.
 * Split terms (30/60/90) = three equal installments at those offsets from invoice date.
 * Unknown = flag for review, no due date computed.
 */

export type VendorTermsType =
  | 'lux_split_thirds'    // Luxottica DE10/DE30/DE60 — three tranches, EOM-based
  | 'lux_eom_single'      // Luxottica special/individual orders — EOM+30+30
  | 'net_single'          // Standard Net 30 / Net 60 from invoice date
  | 'eom_single'          // EOM + N days (single payment)
  | 'net_eom'             // Due at end of month following invoice month
  | 'split_thirds'        // Generic 30/60/90 split, three equal installments
  | 'unknown';            // Cannot determine — flag for review

export interface PaymentTranche {
  tranche_number: number;
  tranche_label: string;
  due_date: Date;
  amount_fraction: number;
  ledger_code?: string;
  is_overdue: boolean;
  days_until_due: number;
}

export interface PaymentSchedule {
  vendor_terms_type: VendorTermsType;
  baseline_date: Date | null;
  tranches: PaymentTranche[];
  next_due: PaymentTranche | null;
  total_amount: number;
  is_fully_overdue: boolean;
  human_label: string;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
}

function daysUntil(d: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

function makeTranche(
  n: number, label: string, due: Date, fraction: number, code?: string
): PaymentTranche {
  const days = daysUntil(due);
  return {
    tranche_number: n,
    tranche_label: label,
    due_date: due,
    amount_fraction: fraction,
    ledger_code: code,
    is_overdue: days < 0,
    days_until_due: days,
  };
}

// ─── helpers (month-based offsets) ──────────────────────────────────────────

/**
 * Advance from an EOM date by N days, using month-based logic for multiples of 30.
 * EOM+30 = same day-of-month in the next month (e.g. 4/30 → 5/30, not 5/31).
 * If the target month has fewer days, clamp to that month's last day.
 */
function addMonthsFromEom(eom: Date, offsetDays: number): Date {
  if (offsetDays > 0 && offsetDays % 30 === 0) {
    const months = offsetDays / 30;
    const eomDay = eom.getDate();
    const targetYear = eom.getFullYear();
    const targetMonth = eom.getMonth() + months;
    // Last day of target month
    const lastDayOfTarget = new Date(targetYear, targetMonth + 1, 0).getDate();
    const day = Math.min(eomDay, lastDayOfTarget);
    return new Date(targetYear, targetMonth, day);
  }
  return addDays(eom, offsetDays);
}

// ─── LUXOTTICA logic ────────────────────────────────────────────────────────
// Luxottica EOM 30/60/90: three tranches at EOM+30, EOM+60, EOM+90.
// EOM itself is NEVER a payment date — it is only the baseline anchor.
// For an invoice dated 4/1: EOM = 4/30 → due dates = 5/30, 6/30, 7/30.

export function buildLuxSplitSchedule(
  documentDate: Date,
  totalAmount: number
): PaymentSchedule {
  const baseline = endOfMonth(documentDate);
  // Always EOM+30, EOM+60, EOM+90 — never EOM itself
  const t1 = addMonthsFromEom(baseline, 30);
  const t2 = addMonthsFromEom(baseline, 60);
  const t3 = addMonthsFromEom(baseline, 90);

  const tranches: PaymentTranche[] = [
    makeTranche(1, '1/3', t1, 1/3, 'DE10'),
    makeTranche(2, '2/3', t2, 1/3, 'DE30'),
    makeTranche(3, '3/3', t3, 1/3, 'DE60'),
  ];

  const next = tranches.find(t => !t.is_overdue) ?? null;

  return {
    vendor_terms_type: 'lux_split_thirds',
    baseline_date: baseline,
    tranches,
    next_due: next,
    total_amount: totalAmount,
    is_fully_overdue: tranches.every(t => t.is_overdue),
    human_label: 'EOM 30/60/90 — 3 equal tranches',
  };
}

/**
 * Build an EOM split schedule with custom day offsets.
 * Uses month-based rounding for multiples-of-30 offsets.
 */
export function buildEomSplitSchedule(
  documentDate: Date,
  totalAmount: number,
  offsets: number[],
  vendorLabel: string
): PaymentSchedule {
  const baseline = endOfMonth(documentDate);
  const tranches = offsets.map((offset, i) =>
    makeTranche(
      i + 1,
      `${i + 1}/${offsets.length}`,
      addMonthsFromEom(baseline, offset),
      1 / offsets.length
    )
  );
  const next = tranches.find(t => !t.is_overdue) ?? null;
  return {
    vendor_terms_type: 'split_thirds',
    baseline_date: baseline,
    tranches,
    next_due: next,
    total_amount: totalAmount,
    is_fully_overdue: tranches.every(t => t.is_overdue),
    human_label: `${vendorLabel} EOM ${offsets.join('/')} — ${offsets.length} tranches`,
  };
}

export function buildLuxEomSingleSchedule(
  documentDate: Date,
  totalAmount: number
): PaymentSchedule {
  // Step 1: EOM = last day of the invoice's OWN month
  const eom = endOfMonth(documentDate);

  // Step 2: Baseline = EOM + 30 days
  const baseline = addDays(eom, 30);

  // Step 3: Due = Baseline + 30 days
  const due = addDays(baseline, 30);

  const tranches: PaymentTranche[] = [
    makeTranche(1, 'Full', due, 1.0),
  ];

  return {
    vendor_terms_type: 'lux_eom_single',
    baseline_date: baseline,
    tranches,
    next_due: tranches[0].is_overdue ? null : tranches[0],
    total_amount: totalAmount,
    is_fully_overdue: tranches[0].is_overdue,
    human_label: 'EOM +30 — Single payment',
  };
}

// ─── NET EOM logic ──────────────────────────────────────────────────────────

/**
 * Net EOM: due at end of the month FOLLOWING the invoice month.
 * Invoice 2/9 → baseline = 2/28, due = 3/31
 * Invoice 3/15 → baseline = 3/31, due = 4/30
 */
export function buildNetEomSchedule(
  documentDate: Date,
  totalAmount: number
): PaymentSchedule {
  const eomInvoiceMonth = endOfMonth(documentDate);
  // End of the NEXT month
  const following = new Date(documentDate.getFullYear(), documentDate.getMonth() + 2, 0);

  const tranches: PaymentTranche[] = [
    makeTranche(1, 'Full', following, 1.0),
  ];

  return {
    vendor_terms_type: 'net_eom',
    baseline_date: eomInvoiceMonth,
    tranches,
    next_due: tranches[0].is_overdue ? null : tranches[0],
    total_amount: totalAmount,
    is_fully_overdue: tranches[0].is_overdue,
    human_label: 'Net EOM — due end of following month',
  };
}

// ─── GENERAL VENDOR logic ───────────────────────────────────────────────────

export function buildGeneralSchedule(
  invoiceDate: Date,
  totalAmount: number,
  paymentTerms: string | null
): PaymentSchedule {
  const terms = (paymentTerms ?? '').toLowerCase().trim();

  if (/30\/60\/90/.test(terms) || /split/.test(terms)) {
    const t1 = addDays(invoiceDate, 30);
    const t2 = addDays(invoiceDate, 60);
    const t3 = addDays(invoiceDate, 90);
    const tranches = [
      makeTranche(1, '1/3', t1, 1/3),
      makeTranche(2, '2/3', t2, 1/3),
      makeTranche(3, '3/3', t3, 1/3),
    ];
    return {
      vendor_terms_type: 'split_thirds',
      baseline_date: invoiceDate,
      tranches,
      next_due: tranches.find(t => !t.is_overdue) ?? null,
      total_amount: totalAmount,
      is_fully_overdue: tranches.every(t => t.is_overdue),
      human_label: '30/60/90 — 3 equal tranches',
    };
  }

  const eomMatch = terms.match(/eom\s*\+?\s*(\d+)/);
  if (eomMatch) {
    const n = parseInt(eomMatch[1]);
    const baseline = endOfMonth(invoiceDate);
    const due = addDays(baseline, n);
    const tranches = [makeTranche(1, 'Full', due, 1.0)];
    return {
      vendor_terms_type: 'eom_single',
      baseline_date: baseline,
      tranches,
      next_due: tranches[0].is_overdue ? null : tranches[0],
      total_amount: totalAmount,
      is_fully_overdue: tranches[0].is_overdue,
      human_label: `EOM + ${n} — Single payment`,
    };
  }

  const netMatch = terms.match(/(?:net|n)\s*(\d+)/);
  if (netMatch) {
    const n = parseInt(netMatch[1]);
    const due = addDays(invoiceDate, n);
    const tranches = [makeTranche(1, 'Full', due, 1.0)];
    return {
      vendor_terms_type: 'net_single',
      baseline_date: invoiceDate,
      tranches,
      next_due: tranches[0].is_overdue ? null : tranches[0],
      total_amount: totalAmount,
      is_fully_overdue: tranches[0].is_overdue,
      human_label: `Net ${n} — Single payment`,
    };
  }

  return {
    vendor_terms_type: 'unknown',
    baseline_date: null,
    tranches: [],
    next_due: null,
    total_amount: totalAmount,
    is_fully_overdue: false,
    human_label: 'Terms unknown — review required',
  };
}

// ─── MAIN RESOLVER ──────────────────────────────────────────────────────────

import { getVendorTermsRule, getVendorTermsRuleAsync, isLuxotticaVendor } from './vendor-terms-registry';

export function resolvePaymentSchedule(
  vendor: string,
  category: 'Procurement' | 'Special Order' | 'Credit',
  documentDate: Date,
  totalAmount: number,
  paymentTerms?: string | null
): PaymentSchedule {

  if (category === 'Credit' || totalAmount < 0) {
    return {
      vendor_terms_type: 'unknown',
      baseline_date: null,
      tranches: [],
      next_due: null,
      total_amount: totalAmount,
      is_fully_overdue: false,
      human_label: 'Credit — no payment due',
    };
  }

  const termsLower = (paymentTerms ?? '').toLowerCase().trim();

  // ── Net EOM detection (any vendor) ──
  const isNetEom =
    termsLower === 'eom' ||
    termsLower.includes('net eom') ||
    termsLower.includes('due eom') ||
    termsLower.includes('due end of month') ||
    termsLower.includes('eom from statement') ||
    termsLower.includes('due eom from') ||
    termsLower.includes('payable eom');

  // ── LUXOTTICA special case: check if explicitly split ──
  if (isLuxotticaVendor(vendor)) {
    if (termsLower.includes('30/60/90') || termsLower.includes('split')) {
      return buildEomSplitSchedule(documentDate, totalAmount, [30, 60, 90], 'EOM 30/60/90 — 3 equal tranches');
    }
    if (isNetEom) {
      return buildNetEomSchedule(documentDate, totalAmount);
    }
    return buildLuxEomSingleSchedule(documentDate, totalAmount);
  }

  // ── Maui Jim "Split Payment EOM" — EOM + offsets, rounded to month-end ──
  // NOTE: Previously imported Maui Jim invoices with "Split Payment EOM" terms
  // may have incorrect installment counts (3 instead of 4). Review and re-import if needed.
  const isMauiJim = (vendor ?? '').toLowerCase().includes('maui');
  if (isMauiJim && termsLower.includes('eom') && (termsLower.includes('split') || /\d+\s*[,/]\s*\d+/.test(termsLower))) {
    // Parse ALL intervals from the term string (e.g. "Split Payment EOM 60,90,120,150" → [60,90,120,150])
    const allNums = termsLower.match(/\d+/g)?.map(Number) ?? [];
    const offsets = allNums.filter(n => n >= 30); // filter out noise like "3" from "3 payments"
    if (offsets.length > 0) {
      return buildMauiEomSplitSchedule(documentDate, totalAmount, offsets);
    }
  }

  // ── MARCOLIN dual-terms: Check 20 EoM vs EOM 50/80/110 ──
  const isMarcolinVendor = (vendor ?? '').toLowerCase().match(/marcolin|tom ford|guess|swarovski|montblanc/);
  if (isMarcolinVendor) {
    // Detect "Check 20 EoM" pattern
    const isCheck20 =
      /check\s*20/i.test(termsLower) ||
      /20\s*(days?)?\s*e[o0]m/i.test(termsLower) ||
      /e[o0]m\s*\+?\s*20\b/i.test(termsLower) ||
      /fine\s*mese\s*\+?\s*20/i.test(termsLower);

    if (isCheck20) {
      // Single payment: EOM + 20 days
      const eom = endOfMonth(documentDate);
      const due = addDays(eom, 20);
      const tranches = [makeTranche(1, 'Full', due, 1.0)];
      return {
        vendor_terms_type: 'eom_single',
        baseline_date: eom,
        tranches,
        next_due: tranches[0].is_overdue ? null : tranches[0],
        total_amount: totalAmount,
        is_fully_overdue: tranches[0].is_overdue,
        human_label: 'Check 20 EoM — Single payment',
      };
    }

    // Default Marcolin: EOM 50/80/110
    if (isNetEom) {
      return buildNetEomSchedule(documentDate, totalAmount);
    }
    return buildEomSplitSchedule(documentDate, totalAmount, [50, 80, 110], 'EOM 50/80/110 — 3 equal tranches');
  }

  // ── All other vendors: use registry ──
  const rule = getVendorTermsRule(vendor);

  if (rule) {
    // Safilo "60 Days EOM" — EOM + 60 single payment
    if (rule.vendor_match?.includes?.('safilo') && termsLower.includes('60') && termsLower.includes('eom')) {
      const eom = endOfMonth(documentDate);
      const due = addDays(eom, 60);
      const tranches = [makeTranche(1, 'Full', due, 1.0)];
      return {
        vendor_terms_type: 'eom_single',
        baseline_date: eom,
        tranches,
        next_due: tranches[0].is_overdue ? null : tranches[0],
        total_amount: totalAmount,
        is_fully_overdue: tranches[0].is_overdue,
        human_label: '60 Days EOM — Single payment',
      };
    }
    // If terms explicitly say EOM (Net EOM), override the default split
    if (isNetEom) {
      return buildNetEomSchedule(documentDate, totalAmount);
    }
    // Skip Marcolin from generic registry path (handled above)
    if (rule.terms_type === 'eom_split') {
      return buildEomSplitSchedule(documentDate, totalAmount, rule.offsets, rule.description);
    }
    if (rule.terms_type === 'days_split') {
      return buildDaysSplitSchedule(documentDate, totalAmount, rule.offsets, rule.description);
    }
    if (rule.terms_type === 'net_single') {
      const n = rule.offsets[0] || 30;
      const due = addDays(documentDate, n);
      const tranches = [makeTranche(1, 'Full', due, 1.0)];
      return {
        vendor_terms_type: 'net_single',
        baseline_date: documentDate,
        tranches,
        next_due: tranches[0].is_overdue ? null : tranches[0],
        total_amount: totalAmount,
        is_fully_overdue: tranches[0].is_overdue,
        human_label: rule.description,
      };
    }
  }

  // ── Net EOM for unregistered vendors ──
  if (isNetEom) {
    return buildNetEomSchedule(documentDate, totalAmount);
  }

  // ── Fallback: read from invoice payment_terms string ──
  return buildGeneralSchedule(documentDate, totalAmount, paymentTerms ?? null);
}

/**
 * Async version of resolvePaymentSchedule that checks DB-defined vendor terms
 * (from the "Define New Vendor" wizard) before falling back to the static registry.
 */
export async function resolvePaymentScheduleAsync(
  vendor: string,
  category: 'Procurement' | 'Special Order' | 'Credit',
  documentDate: Date,
  totalAmount: number,
  paymentTerms?: string | null
): Promise<PaymentSchedule> {

  // Credits never have a payment schedule
  if (category === 'Credit' || totalAmount < 0) {
    return resolvePaymentSchedule(vendor, category, documentDate, totalAmount, paymentTerms);
  }

  // Known static vendors (Luxottica, Kering, etc.) — use sync path
  if (isLuxotticaVendor(vendor) || getVendorTermsRule(vendor)) {
    return resolvePaymentSchedule(vendor, category, documentDate, totalAmount, paymentTerms);
  }

  // Try dynamic DB-defined vendor terms
  const dynamicRule = await getVendorTermsRuleAsync(vendor);
  if (dynamicRule) {
    if (dynamicRule.terms_type === 'eom_split') {
      return buildEomSplitSchedule(documentDate, totalAmount, dynamicRule.offsets, dynamicRule.description);
    }
    if (dynamicRule.terms_type === 'days_split') {
      return buildDaysSplitSchedule(documentDate, totalAmount, dynamicRule.offsets, dynamicRule.description);
    }
    if (dynamicRule.terms_type === 'eom_single') {
      const eom = endOfMonth(documentDate);
      const baselineOffset = dynamicRule.eom_baseline_offset ?? 0;
      const dueOffset = dynamicRule.due_offset ?? dynamicRule.offsets[0] ?? 30;
      const baseline = addDays(eom, baselineOffset);
      const due = addDays(baseline, dueOffset);
      const tranches = [makeTranche(1, 'Full', due, 1.0)];
      return {
        vendor_terms_type: 'eom_single',
        baseline_date: baseline,
        tranches,
        next_due: tranches[0].is_overdue ? null : tranches[0],
        total_amount: totalAmount,
        is_fully_overdue: tranches[0].is_overdue,
        human_label: dynamicRule.description,
      };
    }
    if (dynamicRule.terms_type === 'net_single') {
      const n = dynamicRule.offsets[0] || 30;
      const due = addDays(documentDate, n);
      const tranches = [makeTranche(1, 'Full', due, 1.0)];
      return {
        vendor_terms_type: 'net_single',
        baseline_date: documentDate,
        tranches,
        next_due: tranches[0].is_overdue ? null : tranches[0],
        total_amount: totalAmount,
        is_fully_overdue: tranches[0].is_overdue,
        human_label: dynamicRule.description,
      };
    }
    if (dynamicRule.terms_type === 'net_eom') {
      return buildNetEomSchedule(documentDate, totalAmount);
    }
  }

  // Final fallback: general schedule from invoice terms string
  return buildGeneralSchedule(documentDate, totalAmount, paymentTerms ?? null);
}

// ─── Maui Jim EOM split (EOM + offset → round to end of resulting month) ───

function buildMauiEomSplitSchedule(
  documentDate: Date,
  totalAmount: number,
  offsets: number[],
): PaymentSchedule {
  const eom = endOfMonth(documentDate);
  const tranches = offsets.map((offset, i) => {
    // EOM + offset days, then round to end of that resulting month
    const raw = addDays(eom, offset);
    const rounded = endOfMonth(raw);
    return makeTranche(i + 1, `${i + 1}/${offsets.length}`, rounded, 1 / offsets.length);
  });
  return {
    vendor_terms_type: 'split_thirds',
    baseline_date: eom,
    tranches,
    next_due: tranches.find(t => !t.is_overdue) ?? null,
    total_amount: totalAmount,
    is_fully_overdue: tranches.every(t => t.is_overdue),
    human_label: `Split Payment EOM ${offsets.join('/')} — ${offsets.length} tranches`,
  };
}

// ─── Days split (no EOM step) ───────────────────────────────────────────────

function buildDaysSplitSchedule(
  documentDate: Date,
  totalAmount: number,
  offsets: number[],
  label: string
): PaymentSchedule {
  const tranches = offsets.map((o, i) =>
    makeTranche(i + 1, `${i + 1}/${offsets.length}`, addDays(documentDate, o), 1 / offsets.length)
  );
  return {
    vendor_terms_type: 'split_thirds',
    baseline_date: documentDate,
    tranches,
    next_due: tranches.find(t => !t.is_overdue) ?? null,
    total_amount: totalAmount,
    is_fully_overdue: tranches.every(t => t.is_overdue),
    human_label: label,
  };
}