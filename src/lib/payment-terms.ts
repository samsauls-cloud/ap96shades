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

function keringInstallments(
  invoiceDate: string,
  total: number,
  vendor: string,
  invoiceNumber: string,
  poNumber: string | null
): PaymentInstallment[] {
  const date = new Date(invoiceDate + "T00:00:00");
  const terms = "Days 30 / 60 / 90";
  const perPayment = Math.floor((total / 3) * 100) / 100;
  const remainder = Math.round((total - perPayment * 2) * 100) / 100;

  return [30, 60, 90].map((offset, i) => ({
    vendor,
    invoice_number: invoiceNumber,
    po_number: poNumber,
    invoice_amount: total,
    invoice_date: invoiceDate,
    terms,
    installment_label: `${i + 1} of 3`,
    due_date: format(addDays(date, offset), "yyyy-MM-dd"),
    amount_due: i === 2 ? remainder : perPayment,
  }));
}

function mauiJimInstallments(
  invoiceDate: string,
  total: number,
  vendor: string,
  invoiceNumber: string,
  poNumber: string | null
): PaymentInstallment[] {
  const date = new Date(invoiceDate + "T00:00:00");
  const eom = getEndOfMonth(date);
  const terms = "EOM 60 / 90 / 120 / 150";
  const perPayment = Math.floor((total / 4) * 100) / 100;
  const remainder = Math.round((total - perPayment * 3) * 100) / 100;

  return [60, 90, 120, 150].map((offset, i) => ({
    vendor,
    invoice_number: invoiceNumber,
    po_number: poNumber,
    invoice_amount: total,
    invoice_date: invoiceDate,
    terms,
    installment_label: `${i + 1} of 4`,
    due_date: format(addDays(eom, offset), "yyyy-MM-dd"),
    amount_due: i === 3 ? remainder : perPayment,
  }));
}

function marcolinInstallments(
  invoiceDate: string,
  total: number,
  vendor: string,
  invoiceNumber: string,
  poNumber: string | null
): PaymentInstallment[] {
  const date = new Date(invoiceDate + "T00:00:00");
  const eom = getEndOfMonth(date);
  const terms = "EOM 20";

  return [{
    vendor,
    invoice_number: invoiceNumber,
    po_number: poNumber,
    invoice_amount: total,
    invoice_date: invoiceDate,
    terms,
    installment_label: "1 of 1",
    due_date: format(addDays(eom, 20), "yyyy-MM-dd"),
    amount_due: total,
  }];
}

function safiloInstallments(
  invoiceDate: string,
  total: number,
  vendor: string,
  invoiceNumber: string,
  poNumber: string | null
): PaymentInstallment[] {
  const date = new Date(invoiceDate + "T00:00:00");
  const eom = getEndOfMonth(date);
  const terms = "EOM 60";

  return [{
    vendor,
    invoice_number: invoiceNumber,
    po_number: poNumber,
    invoice_amount: total,
    invoice_date: invoiceDate,
    terms,
    installment_label: "1 of 1",
    due_date: format(addDays(eom, 60), "yyyy-MM-dd"),
    amount_due: total,
  }];
}

const VENDOR_TERMS: Record<string, string> = {
  Luxottica: "EOM 30 / 60 / 90",
  Kering: "Days 30 / 60 / 90",
  "Maui Jim": "EOM 60 / 90 / 120 / 150",
  Marcolin: "EOM 20",
  Safilo: "EOM 60",
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
  if (vendor === "Luxottica") {
    return luxottticaInstallments(invoiceDate, total, vendor, invoiceNumber, poNumber);
  }
  if (vendor === "Kering") {
    return keringInstallments(invoiceDate, total, vendor, invoiceNumber, poNumber);
  }
  if (vendor === "Maui Jim") {
    return mauiJimInstallments(invoiceDate, total, vendor, invoiceNumber, poNumber);
  }
  if (vendor === "Marcolin") {
    return marcolinInstallments(invoiceDate, total, vendor, invoiceNumber, poNumber);
  }
  if (vendor === "Safilo") {
    return safiloInstallments(invoiceDate, total, vendor, invoiceNumber, poNumber);
  }
  return [];
}

export function hasTermsEngine(vendor: string): boolean {
  return vendor in VENDOR_TERMS;
}
