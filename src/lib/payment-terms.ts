import { lastDayOfMonth, addDays, format } from "date-fns";

export interface PaymentInstallment {
  vendor: string;
  invoice_number: string;
  po_number: string | null;
  invoice_amount: number;
  invoice_date: string; // YYYY-MM-DD
  terms: string;
  installment_label: string; // e.g. "1 of 3"
  due_date: string; // YYYY-MM-DD
  amount_due: number;
}

function getEndOfMonth(date: Date): Date {
  return lastDayOfMonth(date);
}

function luxottticaInstallments(
  invoiceDate: string,
  total: number,
  vendor: string,
  invoiceNumber: string,
  poNumber: string | null
): PaymentInstallment[] {
  const date = new Date(invoiceDate + "T00:00:00");
  const eom = getEndOfMonth(date);
  const terms = "EOM 30 / 60 / 90";
  const perPayment = Math.floor((total / 3) * 100) / 100;
  const remainder = Math.round((total - perPayment * 2) * 100) / 100;

  const offsets = [30, 60, 90];
  return offsets.map((offset, i) => ({
    vendor,
    invoice_number: invoiceNumber,
    po_number: poNumber,
    invoice_amount: total,
    invoice_date: invoiceDate,
    terms,
    installment_label: `${i + 1} of 3`,
    due_date: format(addDays(eom, offset), "yyyy-MM-dd"),
    amount_due: i === 2 ? remainder : perPayment,
  }));
}

// FUTURE VENDOR TERMS (not implemented yet — stubs for reference)
// Kering: Days 30/60/90 split from invoice date (3 payments)
// Maui Jim: EOM 60/90/120/150 split (4 payments)
// Marcolin: EOM 20 single payment
// Safilo: EOM 60 single payment

const VENDOR_TERMS: Record<string, string> = {
  Luxottica: "EOM 30 / 60 / 90",
  // Kering: "Days 30 / 60 / 90",
  // "Maui Jim": "EOM 60 / 90 / 120 / 150",
  // Marcolin: "EOM 20",
  // Safilo: "EOM 60",
};

export function getVendorTerms(vendor: string): string | null {
  return VENDOR_TERMS[vendor] ?? null;
}

export function calculateInstallments(
  invoiceDate: string,
  total: number,
  vendor: string,
  invoiceNumber: string,
  poNumber: string | null
): PaymentInstallment[] {
  // Phase 1: Luxottica only
  if (vendor === "Luxottica") {
    return luxottticaInstallments(invoiceDate, total, vendor, invoiceNumber, poNumber);
  }
  // Future vendors will be added here
  return [];
}

export function hasTermsEngine(vendor: string): boolean {
  return vendor === "Luxottica";
}
