/**
 * vendor-credits.ts
 *
 * Per-vendor on-account credit ledger.
 *
 * - `vendor_credits` rows: positive = credit added, negative = credit applied.
 * - DB trigger `vendor_credits_balance_guard` rejects any insert that would
 *   drive a vendor's running balance below zero.
 *
 * The "Apply Vendor Credit" flow PRESERVES the 2026-05-25 payment_history
 * invariant: every `is_paid = true` write appends a payment_history JSONB entry
 * AND inserts a vendor_credits row in the same logical transaction. Both, not
 * either.
 */

import { supabase } from "@/integrations/supabase/client";
import type { PaymentHistoryEntry } from "./payment-queries";

export type VendorCreditSource =
  | "remittance_overpay"
  | "invoice_application"
  | "manual_adjustment"
  | "reversal";

export interface VendorCredit {
  id: string;
  vendor: string;
  amount: number;
  description: string;
  source_type: VendorCreditSource;
  related_invoice_id: string | null;
  related_payment_id: string | null;
  related_history_index: number | null;
  occurred_on: string;
  created_at: string;
  created_by: string | null;
}

export interface VendorCreditBalance {
  vendor_key: string;
  vendor_name: string;
  balance: number;
  last_activity_on: string | null;
  ledger_entries: number;
}

/* ── Reads ───────────────────────────────────────────────────────────── */

export async function fetchVendorCreditBalance(vendor: string): Promise<number> {
  if (!vendor) return 0;
  const { data, error } = await supabase
    .from("vendor_credit_balances" as any)
    .select("balance")
    .eq("vendor_key", vendor.toLowerCase())
    .maybeSingle();
  if (error) {
    console.warn("[vendor-credits] balance fetch failed", error);
    return 0;
  }
  return Number((data as any)?.balance ?? 0);
}

export async function fetchAllVendorCreditBalances(): Promise<VendorCreditBalance[]> {
  const { data, error } = await supabase
    .from("vendor_credit_balances" as any)
    .select("*")
    .order("balance", { ascending: false });
  if (error) {
    console.warn("[vendor-credits] balances fetch failed", error);
    return [];
  }
  return ((data as any[]) ?? []).map(r => ({
    vendor_key: r.vendor_key,
    vendor_name: r.vendor_name,
    balance: Number(r.balance ?? 0),
    last_activity_on: r.last_activity_on,
    ledger_entries: Number(r.ledger_entries ?? 0),
  }));
}

export async function fetchVendorCreditLedger(vendor: string): Promise<VendorCredit[]> {
  if (!vendor) return [];
  const { data, error } = await supabase
    .from("vendor_credits" as any)
    .select("*")
    .ilike("vendor", vendor)
    .order("occurred_on", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[vendor-credits] ledger fetch failed", error);
    return [];
  }
  return (data as any[]) ?? [];
}

/* ── Writes ──────────────────────────────────────────────────────────── */

/**
 * Apply an existing vendor credit balance to an unpaid installment.
 *
 * Atomicity note: Supabase JS has no true client-side transaction. We perform:
 *   1. Append payment_history entry + flip is_paid on the installment.
 *   2. Insert vendor_credits row (negative amount).
 * The DB negative-balance trigger rejects step 2 if balance would go below 0.
 * If step 2 fails, step 1 is reverted via compensating update.
 */
export async function applyVendorCreditToInstallment(args: {
  paymentId: string;
  vendor: string;
  invoiceId: string | null;
  invoiceNumber: string;
  amount: number;
  occurredOn: string; // YYYY-MM-DD
}): Promise<void> {
  const { paymentId, vendor, invoiceId, invoiceNumber, amount, occurredOn } = args;
  if (amount <= 0) throw new Error("Apply amount must be positive");

  // Defensive: re-check balance against current ledger before we touch the row.
  const currentBalance = await fetchVendorCreditBalance(vendor);
  if (currentBalance < amount) {
    throw new Error(
      `Insufficient vendor credit: balance $${currentBalance.toFixed(2)} < required $${amount.toFixed(2)}`,
    );
  }

  // Fetch installment so we can append (not overwrite) payment_history.
  const { data: current, error: fetchErr } = await supabase
    .from("invoice_payments")
    .select("amount_due, amount_paid, payment_history, is_paid, payment_status, paid_date, last_payment_date, balance_remaining")
    .eq("id", paymentId)
    .single();
  if (fetchErr) throw fetchErr;
  if ((current as any).is_paid) throw new Error("Installment is already paid");

  const existingHistory = Array.isArray((current as any).payment_history)
    ? ((current as any).payment_history as PaymentHistoryEntry[])
    : [];

  const historyEntry: PaymentHistoryEntry = {
    date: occurredOn,
    amount,
    method: "Vendor Credit",
    reference: "",
    note: `Applied vendor credit to invoice ${invoiceNumber}`,
    recorded_by: "Staff",
    timestamp: new Date().toISOString(),
  };

  const amountDue = Number((current as any).amount_due) || 0;
  const newPaid = (Number((current as any).amount_paid) || 0) + amount;
  const newBalance = amountDue - newPaid;
  const isFullyPaid = newPaid >= amountDue;

  // Snapshot of what we're changing so we can roll back if step 2 fails.
  const snapshot = {
    amount_paid: (current as any).amount_paid,
    balance_remaining: (current as any).balance_remaining,
    payment_status: (current as any).payment_status,
    paid_date: (current as any).paid_date,
    last_payment_date: (current as any).last_payment_date,
    is_paid: (current as any).is_paid,
    payment_history: existingHistory,
  };

  // Step 1: update installment.
  const { error: updErr } = await supabase
    .from("invoice_payments")
    .update({
      amount_paid: newPaid,
      balance_remaining: newBalance,
      payment_status: isFullyPaid ? "paid" : "partial",
      is_paid: isFullyPaid,
      paid_date: isFullyPaid ? occurredOn : (current as any).paid_date,
      last_payment_date: occurredOn,
      payment_method: "Vendor Credit",
      recorded_by: "Staff",
      payment_history: [...existingHistory, historyEntry],
    } as any)
    .eq("id", paymentId);
  if (updErr) throw updErr;

  // Step 2: insert vendor_credits debit row. If this fails, undo step 1.
  const { error: insErr } = await supabase
    .from("vendor_credits" as any)
    .insert({
      vendor,
      amount: -amount,
      description: `Applied to invoice ${invoiceNumber}`,
      source_type: "invoice_application",
      related_invoice_id: invoiceId,
      related_payment_id: paymentId,
      occurred_on: occurredOn,
      created_by: "Staff",
    });
  if (insErr) {
    // Compensating revert
    await supabase
      .from("invoice_payments")
      .update(snapshot as any)
      .eq("id", paymentId);
    throw new Error(`Vendor credit ledger write failed (changes reverted): ${insErr.message}`);
  }
}

/**
 * Manually add (or adjust) a vendor credit. Positive = add, negative = consume.
 * The negative-balance trigger guards us if `amount < 0` would push below zero.
 */
export async function addVendorCreditAdjustment(args: {
  vendor: string;
  amount: number;
  description: string;
  sourceType?: VendorCreditSource;
  occurredOn?: string;
  relatedInvoiceId?: string | null;
}): Promise<void> {
  const { vendor, amount, description } = args;
  if (!vendor || amount === 0 || !description) throw new Error("vendor, amount, description required");
  const occurredOn = args.occurredOn ?? new Date().toISOString().split("T")[0];

  const { error } = await supabase.from("vendor_credits" as any).insert({
    vendor,
    amount,
    description,
    source_type: args.sourceType ?? "manual_adjustment",
    related_invoice_id: args.relatedInvoiceId ?? null,
    occurred_on: occurredOn,
    created_by: "Staff",
  });
  if (error) throw error;
}
