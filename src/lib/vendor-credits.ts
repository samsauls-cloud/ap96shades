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
  | "reversal"
  | "returned_ra"
  | "other";

export interface VendorCredit {
  id: string;
  vendor: string;
  amount: number;
  description: string | null;
  reference: string | null;
  source_type: VendorCreditSource;
  related_invoice_id: string | null;
  related_payment_id: string | null;
  related_history_index: number | null;
  reversed_credit_id: string | null;
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
  // Resolve via alias map so "Smith Optics" → same key as "Smith Sport Optics".
  const { fetchVendorAliasMap, resolveVendorKey } = await import("./vendor-alias-resolver");
  const aliasMap = await fetchVendorAliasMap();
  const key = resolveVendorKey(vendor, aliasMap);
  const { data, error } = await supabase
    .from("vendor_credit_balances" as any)
    .select("balance")
    .eq("vendor_key", key)
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
  // Pull every row whose vendor string canonicalizes to the same key.
  const { fetchVendorAliasMap, resolveVendorKey } = await import("./vendor-alias-resolver");
  const aliasMap = await fetchVendorAliasMap();
  const targetKey = resolveVendorKey(vendor, aliasMap);
  const { data, error } = await supabase
    .from("vendor_credits" as any)
    .select("*")
    .order("occurred_on", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[vendor-credits] ledger fetch failed", error);
    return [];
  }
  return ((data as any[]) ?? []).filter(r => resolveVendorKey(r.vendor, aliasMap) === targetKey);
}

export async function fetchAllVendorCreditLedger(): Promise<VendorCredit[]> {
  const { data, error } = await supabase
    .from("vendor_credits" as any)
    .select("*")
    .order("occurred_on", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[vendor-credits] full ledger fetch failed", error);
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

  const historyIndex = existingHistory.length;

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
  // Includes related_history_index so reverseVendorCreditApplication can anchor exactly.
  const { error: insErr } = await supabase
    .from("vendor_credits" as any)
    .insert({
      vendor,
      amount: -amount,
      description: `Applied to invoice ${invoiceNumber}`,
      source_type: "invoice_application",
      related_invoice_id: invoiceId,
      related_payment_id: paymentId,
      related_history_index: historyIndex,
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
 * Description is REQUIRED — blank descriptions are how the Smith $10,788.90
 * row landed without context. The negative-balance trigger guards us if
 * `amount < 0` would push the running balance below zero.
 *
 * Returns the new running balance for this vendor so callers can surface it.
 */
export async function addVendorCreditAdjustment(args: {
  vendor: string;
  amount: number;
  description: string;
  reference?: string | null;
  sourceType?: VendorCreditSource;
  occurredOn?: string;
  relatedInvoiceId?: string | null;
}): Promise<{ newBalance: number }> {
  const { vendor, amount } = args;
  if (!vendor) throw new Error("vendor required");
  if (amount === 0) throw new Error("amount must be non-zero");
  const description = (args.description ?? "").trim();
  if (!description) throw new Error("description is required — describe what this credit is from");

  const occurredOn = args.occurredOn ?? new Date().toISOString().split("T")[0];

  const { error } = await supabase.from("vendor_credits" as any).insert({
    vendor,
    amount,
    description,
    reference: args.reference?.trim() || null,
    source_type: args.sourceType ?? "manual_adjustment",
    related_invoice_id: args.relatedInvoiceId ?? null,
    occurred_on: occurredOn,
    created_by: "Staff",
  });
  if (error) throw error;

  const newBalance = await fetchVendorCreditBalance(vendor);
  return { newBalance };
}

/**
 * Void (reverse) a manual vendor credit row. Inserts an offsetting row that
 * points back at the original via `reversed_credit_id`. The original row is
 * never deleted — enterprise ledgers don't lose history. Double-voids are
 * impossible because we check for an existing reversal first.
 */
export async function voidVendorCredit(id: string): Promise<{ newBalance: number }> {
  const { data: original, error: fetchErr } = await supabase
    .from("vendor_credits" as any)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!original) throw new Error("Credit entry not found");
  const o = original as any;

  if (o.source_type === "invoice_application") {
    throw new Error("This is a system-applied credit — use Reverse on the application instead.");
  }
  if (o.source_type === "reversal" && o.reversed_credit_id) {
    throw new Error("This row is itself a reversal and cannot be voided.");
  }

  // Block double-void.
  const { data: existing } = await supabase
    .from("vendor_credits" as any)
    .select("id")
    .eq("reversed_credit_id", id)
    .maybeSingle();
  if (existing) throw new Error("This entry has already been voided.");

  const { error: insErr } = await supabase.from("vendor_credits" as any).insert({
    vendor: o.vendor,
    amount: -Number(o.amount),
    description: `Void of: ${o.description ?? "(no description)"}`,
    reference: o.reference ?? null,
    source_type: "reversal",
    related_invoice_id: o.related_invoice_id ?? null,
    related_payment_id: o.related_payment_id ?? null,
    reversed_credit_id: id,
    occurred_on: new Date().toISOString().slice(0, 10),
    created_by: "Staff",
  });
  if (insErr) throw insErr;

  const newBalance = await fetchVendorCreditBalance(o.vendor);
  return { newBalance };
}

/**
 * Legacy delete (manual entries only). Prefer voidVendorCredit going forward.
 * Kept for any older callers; new UI uses void.
 */
export async function deleteVendorCredit(id: string): Promise<void> {
  const { data: existing, error: fetchErr } = await supabase
    .from("vendor_credits" as any)
    .select("source_type, related_payment_id")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!existing) throw new Error("Credit entry not found");
  if ((existing as any).source_type === "invoice_application" || (existing as any).related_payment_id) {
    throw new Error("System-applied credits cannot be deleted. Void the linked payment instead.");
  }
  const { error } = await supabase.from("vendor_credits" as any).delete().eq("id", id);
  if (error) throw error;
}

/* ── Apply across an entire invoice (oldest unpaid first) ────────────── */

export interface AppliedAllocation {
  paymentId: string;
  installmentLabel: string | null;
  applied: number;
  creditRowId: string;
}

/**
 * Apply a positive credit amount against an invoice, oldest unpaid installment
 * first, partial-allocating if the amount doesn't cover a full installment.
 * Returns one allocation per installment touched. Each allocation writes its
 * own paired (payment_history append) + (vendor_credits negative row), so the
 * reversal flow can undo them individually via the credit row.
 */
export async function applyVendorCreditToInvoice(args: {
  vendor: string;
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  occurredOn?: string;
}): Promise<AppliedAllocation[]> {
  const { vendor, invoiceId, invoiceNumber, amount } = args;
  if (amount <= 0) throw new Error("Amount must be positive");
  const occurredOn = args.occurredOn ?? new Date().toISOString().split("T")[0];

  const balance = await fetchVendorCreditBalance(vendor);
  if (balance < amount) {
    throw new Error(`Insufficient vendor credit: balance $${balance.toFixed(2)} < requested $${amount.toFixed(2)}`);
  }

  // Pull all unpaid installments for this invoice, oldest first.
  const { data: installments, error } = await supabase
    .from("invoice_payments")
    .select("id, installment_label, amount_due, amount_paid, balance_remaining, is_paid, due_date")
    .eq("invoice_id", invoiceId)
    .eq("is_paid", false)
    .order("due_date", { ascending: true });
  if (error) throw error;
  const rows = (installments ?? []).filter((r: any) => Number(r.balance_remaining) > 0);

  const totalOwed = rows.reduce((s: number, r: any) => s + Number(r.balance_remaining), 0);
  if (totalOwed <= 0) throw new Error("Invoice has no unpaid balance");
  if (amount > totalOwed + 0.005) {
    throw new Error(`Apply amount $${amount.toFixed(2)} exceeds amount owed $${totalOwed.toFixed(2)}`);
  }

  const allocations: AppliedAllocation[] = [];
  let remaining = amount;

  for (const row of rows) {
    if (remaining <= 0.005) break;
    const owed = Number((row as any).balance_remaining);
    const slice = Math.min(remaining, owed);
    if (slice <= 0) continue;

    await applyVendorCreditToInstallmentInternal({
      paymentId: (row as any).id,
      vendor,
      invoiceId,
      invoiceNumber,
      amount: slice,
      occurredOn,
      installmentLabel: (row as any).installment_label,
      collectInto: allocations,
    });

    remaining = Math.round((remaining - slice) * 100) / 100;
  }

  return allocations;
}

/**
 * Internal helper that mirrors applyVendorCreditToInstallment but also
 * captures the inserted vendor_credits row id and the appended history index
 * so the caller (and reversal flow) can reference both.
 */
async function applyVendorCreditToInstallmentInternal(args: {
  paymentId: string;
  vendor: string;
  invoiceId: string | null;
  invoiceNumber: string;
  amount: number;
  occurredOn: string;
  installmentLabel: string | null;
  collectInto: AppliedAllocation[];
}): Promise<void> {
  const { paymentId, vendor, invoiceId, invoiceNumber, amount, occurredOn } = args;

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

  const historyIndex = existingHistory.length;
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
  const newPaid = Math.round(((Number((current as any).amount_paid) || 0) + amount) * 100) / 100;
  const newBalance = Math.round((amountDue - newPaid) * 100) / 100;
  const isFullyPaid = newPaid + 0.005 >= amountDue;

  const snapshot = {
    amount_paid: (current as any).amount_paid,
    balance_remaining: (current as any).balance_remaining,
    payment_status: (current as any).payment_status,
    paid_date: (current as any).paid_date,
    last_payment_date: (current as any).last_payment_date,
    is_paid: (current as any).is_paid,
    payment_history: existingHistory,
  };

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

  const { data: inserted, error: insErr } = await supabase
    .from("vendor_credits" as any)
    .insert({
      vendor,
      amount: -amount,
      description: `Applied to invoice ${invoiceNumber}`,
      source_type: "invoice_application",
      related_invoice_id: invoiceId,
      related_payment_id: paymentId,
      related_history_index: historyIndex,
      occurred_on: occurredOn,
      created_by: "Staff",
    })
    .select("id")
    .single();
  if (insErr) {
    await supabase.from("invoice_payments").update(snapshot as any).eq("id", paymentId);
    throw new Error(`Vendor credit ledger write failed (changes reverted): ${insErr.message}`);
  }

  args.collectInto.push({
    paymentId,
    installmentLabel: args.installmentLabel,
    applied: amount,
    creditRowId: (inserted as any).id,
  });
}

/**
 * Reverse a previously-applied invoice_application credit row.
 * - Removes the matching payment_history entry from the installment.
 * - Restores amount_paid / balance_remaining / status.
 * - Inserts a positive `reversal` row that re-credits the vendor balance.
 * Anchored by `related_history_index` (preferred) or by note+amount fallback.
 */
export async function reverseVendorCreditApplication(creditId: string): Promise<void> {
  const { data: credit, error: cErr } = await supabase
    .from("vendor_credits" as any)
    .select("*")
    .eq("id", creditId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!credit) throw new Error("Credit row not found");
  const c = credit as any;
  if (c.source_type !== "invoice_application") {
    throw new Error("Only applied credits can be reversed");
  }
  if (!c.related_payment_id) throw new Error("Credit is missing related payment reference");

  const reversedAmount = Math.abs(Number(c.amount)); // stored as negative

  // Idempotency: bail if a reversal already exists for this credit row.
  const { data: existingReversal } = await supabase
    .from("vendor_credits" as any)
    .select("id")
    .eq("source_type", "reversal")
    .eq("related_payment_id", c.related_payment_id)
    .ilike("description", `%credit ${creditId}%`)
    .maybeSingle();
  if (existingReversal) throw new Error("This credit has already been reversed");

  const { data: pay, error: pErr } = await supabase
    .from("invoice_payments")
    .select("amount_due, amount_paid, balance_remaining, payment_history, payment_status, is_paid, paid_date, last_payment_date")
    .eq("id", c.related_payment_id)
    .single();
  if (pErr) throw pErr;

  const history = Array.isArray((pay as any).payment_history)
    ? [...((pay as any).payment_history as PaymentHistoryEntry[])]
    : [];

  let removedIndex = -1;
  const targetIdx = c.related_history_index;
  if (typeof targetIdx === "number" && history[targetIdx]?.method === "Vendor Credit" &&
      Math.abs(Number(history[targetIdx].amount) - reversedAmount) < 0.005) {
    removedIndex = targetIdx;
  } else {
    // Fallback: last vendor-credit entry with matching amount + invoice note.
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (h.method === "Vendor Credit" && Math.abs(Number(h.amount) - reversedAmount) < 0.005) {
        removedIndex = i;
        break;
      }
    }
  }
  if (removedIndex < 0) {
    throw new Error("Could not locate the original credit entry in payment history");
  }

  // Note: protect_payment_history_on_update blocks history shrink. We replace
  // the entry with a void-style stub of the same length so the array length
  // doesn't decrease (append-only invariant), and mark it reversed.
  const removed = history[removedIndex];
  history[removedIndex] = {
    ...removed,
    amount: 0,
    note: `${removed.note} — REVERSED on ${new Date().toISOString().slice(0, 10)}`,
  };

  const amountDue = Number((pay as any).amount_due) || 0;
  const newPaid = Math.max(0, Math.round(((Number((pay as any).amount_paid) || 0) - reversedAmount) * 100) / 100);
  const newBalance = Math.round((amountDue - newPaid) * 100) / 100;
  const stillPaid = newPaid + 0.005 >= amountDue;

  const { error: updErr } = await supabase
    .from("invoice_payments")
    .update({
      amount_paid: newPaid,
      balance_remaining: newBalance,
      is_paid: stillPaid,
      payment_status: stillPaid ? "paid" : (newPaid > 0 ? "partial" : "unpaid"),
      paid_date: stillPaid ? (pay as any).paid_date : null,
      payment_history: history,
    } as any)
    .eq("id", c.related_payment_id);
  if (updErr) throw updErr;

  const { error: revErr } = await supabase.from("vendor_credits" as any).insert({
    vendor: c.vendor,
    amount: reversedAmount, // positive — restores balance
    description: `Reversal of credit ${creditId} (was applied to invoice)`,
    source_type: "reversal",
    related_invoice_id: c.related_invoice_id,
    related_payment_id: c.related_payment_id,
    occurred_on: new Date().toISOString().slice(0, 10),
    created_by: "Staff",
  });
  if (revErr) {
    // Compensating revert
    await supabase
      .from("invoice_payments")
      .update({
        amount_paid: (pay as any).amount_paid,
        balance_remaining: (pay as any).balance_remaining,
        is_paid: (pay as any).is_paid,
        payment_status: (pay as any).payment_status,
        paid_date: (pay as any).paid_date,
        payment_history: (pay as any).payment_history,
      } as any)
      .eq("id", c.related_payment_id);
    throw new Error(`Reversal ledger write failed (changes reverted): ${revErr.message}`);
  }
}

/* ── Onboarding flags (server-side persistence, no auth) ─────────────── */

export async function isOnboardingFlagDismissed(flagKey: string): Promise<boolean> {
  const { data } = await supabase
    .from("onboarding_flags" as any)
    .select("flag_key")
    .eq("flag_key", flagKey)
    .maybeSingle();
  return !!data;
}

export async function dismissOnboardingFlag(flagKey: string): Promise<void> {
  await supabase
    .from("onboarding_flags" as any)
    .upsert({ flag_key: flagKey, dismissed_by: "Staff", dismissed_at: new Date().toISOString() });
}

export async function resetOnboardingFlag(flagKey: string): Promise<void> {
  await supabase.from("onboarding_flags" as any).delete().eq("flag_key", flagKey);
}
