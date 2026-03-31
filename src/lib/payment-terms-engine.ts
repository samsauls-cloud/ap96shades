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

// ─── LUXOTTICA logic ────────────────────────────────────────────────────────

export function buildLuxSplitSchedule(
  documentDate: Date,
  totalAmount: number
): PaymentSchedule {
  const baseline = endOfMonth(documentDate);
  const t1 = addDays(baseline, 30);
  const t2 = addDays(baseline, 60);
  const t3 = addDays(baseline, 90);

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
    human_label: '30/60/90 EOM — 3 equal tranches',
  };
}

/**
 * Build an EOM split schedule with custom day offsets.
 * Used for Marcolin (50/80/110) and any vendor with non-standard splits.
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
      addDays(baseline, offset),
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

export function resolvePaymentSchedule(
  vendor: string,
  category: 'Procurement' | 'Special Order' | 'Credit',
  documentDate: Date,
  totalAmount: number,
  paymentTerms?: string | null
): PaymentSchedule {
  const v = (vendor ?? '').toLowerCase();

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

  const isLux = v.includes('luxottica') || v.includes('ray-ban') || v.includes('rayban')
    || v.includes('oakley') || v.includes('costa') || v.includes('chanel')
    || v.includes('prada') || v.includes('versace') || v.includes('coach')
    || v.includes('burberry') || v.includes('michael kors') || v.includes('persol')
    || v.includes('miu miu') || v.includes('oliver peoples') || v.includes('ralph');

if (isLux) {
    const t = (paymentTerms ?? '').toLowerCase().trim();

    // Explicitly a split: must contain 30/60/90
    const isSplit = t.includes('30/60/90') || t.includes('split');

    if (isSplit) {
      return buildLuxSplitSchedule(documentDate, totalAmount);
    }

    // Default for ALL Luxottica — EOM single unless explicitly split
    return buildLuxEomSingleSchedule(documentDate, totalAmount);
  }

  // MARCOLIN — 50/80/110 EOM split
  const isMarcolin = v.includes('marcolin') || v.includes('tom ford')
    || v.includes('guess') || v.includes('swarovski') || v.includes('montblanc');

  if (isMarcolin) {
    const splitMatch = (paymentTerms ?? '').match(/(\d+)[-\/](\d+)[-\/](\d+)/);
    if (splitMatch) {
      const offsets = [
        parseInt(splitMatch[1]),
        parseInt(splitMatch[2]),
        parseInt(splitMatch[3]),
      ];
      return buildEomSplitSchedule(documentDate, totalAmount, offsets, 'Marcolin');
    }
    // Fallback: standard Marcolin is 50/80/110 if no terms string available
    return buildEomSplitSchedule(documentDate, totalAmount, [50, 80, 110], 'Marcolin');
  }

  return buildGeneralSchedule(documentDate, totalAmount, paymentTerms ?? null);
}