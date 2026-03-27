import { lastDayOfMonth, addDays, format } from "date-fns";
import { normalizeVendor, isKnownVendor } from "@/lib/invoice-dedup";

export interface PaymentInstallment {
  vendor: string;
  invoice_number: string;
  po_number: string | null;
  invoice_amount: number;
  invoice_date: string; // YYYY-MM-DD
  terms: string;
  installment_label: string | null; // e.g. "1 of 3", null for single-payment
  due_date: string; // YYYY-MM-DD
  amount_due: number;
}

// ── Terms configuration — single source of truth ─────────
export interface VendorTermsConfig {
  type: "EOM_SPLIT" | "DAYS_SPLIT" | "EOM_SINGLE";
  installments: number;
  offsets: number[];
  basis: "EOM" | "INVOICE_DATE";
  label: string; // human-readable label
}

export const VENDOR_TERMS: Record<string, VendorTermsConfig> = {
  Luxottica: {
    type: "EOM_SPLIT",
    installments: 3,
    offsets: [30, 60, 90],
    basis: "EOM",
    label: "EOM 30 / 60 / 90",
  },
  Kering: {
    type: "DAYS_SPLIT",
    installments: 3,
    offsets: [30, 60, 90],
    basis: "INVOICE_DATE",
    label: "Days 30 / 60 / 90",
  },
  "Maui Jim": {
    type: "EOM_SPLIT",
    installments: 4,
    offsets: [60, 90, 120, 150],
    basis: "EOM",
    label: "EOM 60 / 90 / 120 / 150",
  },
  Marcolin: {
    type: "EOM_SINGLE",
    installments: 1,
    offsets: [20],
    basis: "EOM",
    label: "EOM 20",
  },
  Safilo: {
    type: "EOM_SINGLE",
    installments: 1,
    offsets: [60],
    basis: "EOM",
    label: "EOM 60",
  },
};

// Maui Jim alternate terms for older POs
const MAUI_JIM_ALT: VendorTermsConfig = {
  type: "DAYS_SPLIT",
  installments: 3,
  offsets: [90, 120, 150],
  basis: "INVOICE_DATE",
  label: "Days 90 / 120 / 150",
};

// ── Due date calculation ──────────────────────────────────
function calculateDueDate(invoiceDate: string, basis: "EOM" | "INVOICE_DATE", offsetDays: number): Date {
  const d = new Date(invoiceDate + "T00:00:00");
  if (basis === "EOM") {
    const endOfMonth = lastDayOfMonth(d);
    return addDays(endOfMonth, offsetDays);
  }
  // INVOICE_DATE
  return addDays(d, offsetDays);
}

// ── Resolve terms config for vendor + payment_terms text ──
function resolveTermsConfig(vendor: string, paymentTermsText?: string | null): VendorTermsConfig | null {
  const normalized = normalizeVendor(vendor);

  // Maui Jim special case: detect legacy terms from PDF text
  if (normalized === "Maui Jim" && paymentTermsText) {
    const lower = paymentTermsText.toLowerCase();
    if (lower.includes("days") || lower.includes("net 90") || lower.includes("net 120")) {
      return MAUI_JIM_ALT;
    }
  }

  return VENDOR_TERMS[normalized] ?? null;
}

// ── Public API ────────────────────────────────────────────

export function getVendorTerms(vendor: string): string | null {
  const config = VENDOR_TERMS[normalizeVendor(vendor)];
  return config?.label ?? null;
}

export function hasTermsEngine(vendor: string): boolean {
  return normalizeVendor(vendor) in VENDOR_TERMS;
}

/**
 * Calculate installments from config-driven terms engine.
 * Returns empty array if vendor has no terms config.
 */
export function calculateInstallments(
  invoiceDate: string,
  total: number,
  vendor: string,
  invoiceNumber: string,
  poNumber: string | null,
  paymentTermsText?: string | null,
): PaymentInstallment[] {
  const normalized = normalizeVendor(vendor);
  const config = resolveTermsConfig(normalized, paymentTermsText);

  if (!config) {
    console.error(`No terms defined for vendor: ${normalized}`);
    return [];
  }

  // Guard: total must be positive
  const parsedTotal = typeof total === "number" ? total : parseFloat(String(total)) || 0;
  if (parsedTotal <= 0) return [];

  const baseAmount = parseFloat((parsedTotal / config.installments).toFixed(2));
  // Last installment absorbs rounding
  const lastAmount = parseFloat((parsedTotal - baseAmount * (config.installments - 1)).toFixed(2));

  return config.offsets.map((offset, index) => {
    const isLast = index === config.installments - 1;
    const amount = isLast ? lastAmount : baseAmount;
    const dueDate = calculateDueDate(invoiceDate, config.basis, offset);

    return {
      vendor: normalized,
      invoice_number: invoiceNumber,
      po_number: poNumber,
      invoice_amount: parsedTotal,
      invoice_date: invoiceDate,
      terms: config.label,
      installment_label: config.installments > 1 ? `${index + 1} of ${config.installments}` : null,
      due_date: format(dueDate, "yyyy-MM-dd"),
      amount_due: amount,
    };
  });
}

/**
 * Verify that installments sum matches invoice total within tolerance.
 * Returns discrepancy (0 = perfect).
 */
export function verifyInstallmentMath(installments: PaymentInstallment[], invoiceTotal: number): number {
  const sum = installments.reduce((s, inst) => s + inst.amount_due, 0);
  return parseFloat((invoiceTotal - sum).toFixed(2));
}
