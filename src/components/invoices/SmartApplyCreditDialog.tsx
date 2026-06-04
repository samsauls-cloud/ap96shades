/**
 * SmartApplyCreditDialog (installment-based, rev. 3 — 2026-06-04)
 *
 * Vendor-level credit allocation across INSTALLMENTS (not invoices).
 * Josh's pain point on 6/3: applying by invoice paid down July/Aug/Sep
 * tranches when a June tranche on another invoice was what was actually due.
 *
 * Hard rules:
 *  - One row per OPEN installment for the canonicalized vendor (not paid /
 *    void / disputed; balance_remaining > 0).
 *  - Default order & default split: past-due oldest-first across ALL invoices,
 *    then upcoming soonest-first across ALL invoices.
 *  - manual_status_override rows: greyed out, unchecked, un-checkable.
 *  - Write path: applyVendorCreditToInstallment per row, then
 *    syncInvoicePaymentStatus per distinct invoice. No invoice-level allocator.
 *  - Preview math == write math, to the cent.
 *  - Reversal continues to work per application row via the credit ledger
 *    (each apply writes its own paired history entry + vendor_credits row).
 */
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Wallet, Loader2, ArrowRight, Info, AlertTriangle, RotateCcw, Lock } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/supabase-queries";
import {
  fetchVendorCreditBalance,
  applyVendorCreditToInstallment,
} from "@/lib/vendor-credits";
import { syncInvoicePaymentStatus } from "@/lib/payment-queries";
import { fetchVendorAliasMap, resolveVendorKey } from "@/lib/vendor-alias-resolver";

interface Props {
  vendor: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface OpenInstallment {
  payment_id: string;
  invoice_id: string;
  invoice_number: string;
  installment_label: string; // e.g. "2 of 4" — falls back to "—"
  due_date: string;
  owedNow: number;
  pastDueDays: number; // >0 past due, <=0 upcoming
  locked: boolean;
  lockReason: string | null;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Greedy fill in display order, skipping locked rows. */
function computeSuggested(amount: number, rows: OpenInstallment[]): Record<string, number> {
  const out: Record<string, number> = {};
  let remaining = round2(amount);
  for (const r of rows) {
    if (remaining <= 0.005) break;
    if (r.locked) continue;
    const slice = round2(Math.min(remaining, r.owedNow));
    if (slice <= 0) continue;
    out[r.payment_id] = slice;
    remaining = round2(remaining - slice);
  }
  return out;
}

export function SmartApplyCreditDialog({ vendor, open, onOpenChange }: Props) {
  const qc = useQueryClient();

  const [seedStr, setSeedStr] = useState("");
  const [allocMap, setAllocMap] = useState<Record<string, number>>({});
  const [dirty, setDirty] = useState(false);
  const [step, setStep] = useState<"review" | "confirm">("review");
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [inputStrs, setInputStrs] = useState<Record<string, string>>({});

  const { data: balance = 0, isLoading: balLoading } = useQuery({
    queryKey: ["vendor_credit_balances", vendor.toLowerCase(), "smart-apply"],
    enabled: open && !!vendor,
    queryFn: () => fetchVendorCreditBalance(vendor),
  });

  const { data: aliasMap } = useQuery({
    queryKey: ["vendor_alias_map"],
    queryFn: fetchVendorAliasMap,
  });

  const { data: serverToday } = useQuery({
    queryKey: ["server_date"],
    queryFn: async () => {
      const { data } = await supabase.rpc("get_server_date" as any);
      return (data as unknown as string) ?? new Date().toISOString().slice(0, 10);
    },
  });

  const { data: openInstallments = [], isLoading: invLoading } = useQuery({
    queryKey: ["smart_apply_open_installments", vendor.toLowerCase(), aliasMap?.size, serverToday],
    enabled: open && !!aliasMap && !!serverToday,
    queryFn: async (): Promise<OpenInstallment[]> => {
      const targetKey = resolveVendorKey(vendor, aliasMap!);

      const { data, error } = await supabase
        .from("invoice_payments")
        .select(
          "id, invoice_id, invoice_number, vendor, due_date, installment_label, balance_remaining, is_paid, payment_status, manual_status_override",
        )
        .in("payment_status", ["unpaid", "partial"])
        .eq("is_paid", false);
      if (error) throw error;

      const rows = (data ?? []).filter((r: any) => {
        if (!r.invoice_id) return false;
        if (resolveVendorKey(r.vendor ?? "", aliasMap!) !== targetKey) return false;
        if (Number(r.balance_remaining) <= 0) return false;
        const st = (r.payment_status ?? "").toLowerCase();
        if (st === "void" || st === "disputed" || st === "paid") return false;
        if (!r.due_date) return false;
        return true;
      });
      if (rows.length === 0) return [];

      const invoiceIds = Array.from(new Set(rows.map((r: any) => r.invoice_id)));
      const { data: parents } = await supabase
        .from("vendor_invoices")
        .select("id, doc_type, status, invoice_number")
        .in("id", invoiceIds);
      const parentMap = new Map<string, any>();
      (parents ?? []).forEach((p: any) => parentMap.set(p.id, p));

      const today = serverToday ?? new Date().toISOString().slice(0, 10);
      const todayMs = new Date(today + "T00:00:00").getTime();

      // Count installments per invoice so we can fall back to "n of m" labels.
      const countPerInvoice = new Map<string, number>();
      for (const r of rows) {
        countPerInvoice.set(r.invoice_id, (countPerInvoice.get(r.invoice_id) ?? 0) + 1);
      }

      const out: OpenInstallment[] = [];
      for (const r of rows) {
        const parent = parentMap.get(r.invoice_id);
        if (!parent) continue;
        if ((parent.doc_type ?? "INVOICE").toUpperCase() !== "INVOICE") continue;
        const pStatus = (parent.status ?? "").toLowerCase();
        if (pStatus === "void" || pStatus === "disputed") continue;

        const due = r.due_date as string;
        const dueMs = new Date(due + "T00:00:00").getTime();
        const diffDays = Math.round((todayMs - dueMs) / (1000 * 60 * 60 * 24));

        const locked = !!r.manual_status_override;
        const lockReason = locked ? "Manual status override — locked" : null;

        out.push({
          payment_id: r.id,
          invoice_id: r.invoice_id,
          invoice_number: parent.invoice_number ?? r.invoice_number ?? "—",
          installment_label: (r.installment_label as string) || "—",
          due_date: due,
          owedNow: round2(Number(r.balance_remaining) || 0),
          pastDueDays: diffDays,
          locked,
          lockReason,
        });
      }

      // Sort: past-due first oldest-first (largest pastDueDays first),
      // then upcoming soonest-first. Apply ACROSS all invoices.
      out.sort((a, z) => {
        const aPast = a.pastDueDays > 0;
        const zPast = z.pastDueDays > 0;
        if (aPast && !zPast) return -1;
        if (!aPast && zPast) return 1;
        if (aPast && zPast) return z.pastDueDays - a.pastDueDays;
        // both upcoming (or due today) — earlier due_date first
        const cmp = a.due_date.localeCompare(z.due_date);
        if (cmp !== 0) return cmp;
        // stable tiebreak by invoice number then label
        const inv = a.invoice_number.localeCompare(z.invoice_number);
        if (inv !== 0) return inv;
        return a.installment_label.localeCompare(z.installment_label);
      });
      return out;
    },
  });

  // Reset state on open.
  useEffect(() => {
    if (open) {
      setAllocMap({});
      setInputStrs({});
      setDirty(false);
      setStep("review");
      setProgress(null);
      setSubmitting(false);
      setSeedStr("");
    }
  }, [open]);

  const totalOwedOpen = useMemo(
    () =>
      round2(
        openInstallments.filter(r => !r.locked).reduce((s, r) => s + r.owedNow, 0),
      ),
    [openInstallments],
  );

  // Seed default once data lands (full balance, capped by total unlockedowed).
  useEffect(() => {
    if (!open || balLoading || invLoading) return;
    if (seedStr !== "") return;
    const cap = round2(Math.min(balance, totalOwedOpen));
    setSeedStr(cap > 0 ? cap.toFixed(2) : "0.00");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, balLoading, invLoading, balance, totalOwedOpen]);

  const seedAmount = Math.max(0, round2(parseFloat(seedStr) || 0));

  // Auto-fill allocation from suggestion whenever seed/rows change AND user
  // hasn't customized.
  useEffect(() => {
    if (!open || dirty) return;
    if (balLoading || invLoading) return;
    setAllocMap(computeSuggested(seedAmount, openInstallments));
    setInputStrs({});
  }, [open, dirty, balLoading, invLoading, seedAmount, openInstallments]);

  const totalApplied = useMemo(
    () => round2(Object.values(allocMap).reduce((s, v) => s + (Number(v) || 0), 0)),
    [allocMap],
  );
  const creditAfter = round2(balance - totalApplied);
  const overBalance = totalApplied > balance + 0.005;
  const nothingPicked = totalApplied <= 0;
  const valid = !overBalance && !nothingPicked && openInstallments.length > 0;

  function setRowAmount(paymentId: string, amount: number) {
    setDirty(true);
    setAllocMap(prev => {
      const next = { ...prev };
      if (amount <= 0) delete next[paymentId];
      else next[paymentId] = round2(amount);
      return next;
    });
  }

  function toggleRow(row: OpenInstallment) {
    if (row.locked) return;
    const current = Number(allocMap[row.payment_id] ?? 0);
    if (current > 0) {
      setRowAmount(row.payment_id, 0);
      setInputStrs(s => ({ ...s, [row.payment_id]: "" }));
    } else {
      const remainingPool = round2(Math.max(0, balance - totalApplied));
      const fill = round2(Math.min(row.owedNow, remainingPool));
      setRowAmount(row.payment_id, fill);
      setInputStrs(s => ({ ...s, [row.payment_id]: fill > 0 ? fill.toFixed(2) : "" }));
    }
  }

  function onRowInputChange(row: OpenInstallment, raw: string) {
    if (row.locked) return;
    setInputStrs(s => ({ ...s, [row.payment_id]: raw }));
    const n = parseFloat(raw);
    if (!isFinite(n) || n <= 0) {
      setRowAmount(row.payment_id, 0);
      return;
    }
    // Clamp to this row's owed AND to remaining credit pool (excluding this row)
    const otherTotal = round2(
      Object.entries(allocMap).reduce(
        (s, [k, v]) => (k === row.payment_id ? s : s + (Number(v) || 0)),
        0,
      ),
    );
    const poolCap = round2(Math.max(0, balance - otherTotal));
    const clamped = round2(Math.min(n, row.owedNow, poolCap));
    setRowAmount(row.payment_id, clamped);
  }

  function resetToSuggested() {
    setDirty(false);
    setInputStrs({});
  }

  // Build the ordered allocations passed to write — preview/write parity.
  const allocations = useMemo(
    () =>
      openInstallments
        .map(r => ({ ...r, applied: round2(Number(allocMap[r.payment_id] ?? 0)) }))
        .filter(a => a.applied > 0 && !a.locked)
        .map(a => ({ ...a, owedAfter: round2(a.owedNow - a.applied) })),
    [openInstallments, allocMap],
  );

  async function handleConfirm() {
    if (!valid) return;
    setSubmitting(true);
    setProgress({ done: 0, total: allocations.length });

    const today = serverToday ?? new Date().toISOString().slice(0, 10);
    const completed: Array<{ label: string; applied: number; invoiceId: string }> = [];
    try {
      for (let i = 0; i < allocations.length; i++) {
        const a = allocations[i];
        await applyVendorCreditToInstallment({
          paymentId: a.payment_id,
          vendor,
          invoiceId: a.invoice_id,
          invoiceNumber: a.invoice_number,
          amount: a.applied,
          occurredOn: today,
        });
        completed.push({
          label: `${a.invoice_number} (${a.installment_label})`,
          applied: a.applied,
          invoiceId: a.invoice_id,
        });
        setProgress({ done: i + 1, total: allocations.length });
      }

      // Sync parent invoice status once per distinct touched invoice.
      const distinctInvoiceIds = Array.from(new Set(completed.map(c => c.invoiceId)));
      for (const invId of distinctInvoiceIds) {
        try {
          await syncInvoicePaymentStatus(invId);
        } catch (e) {
          console.warn("[smart-apply] sync status failed for", invId, e);
        }
      }

      toast.success(
        `Applied ${formatCurrency(totalApplied)} across ${completed.length} installment${completed.length === 1 ? "" : "s"}`,
      );
      invalidateAll();
      onOpenChange(false);
    } catch (e: any) {
      const remaining = allocations.slice(completed.length);
      const done = completed.length
        ? `Completed (each reversible from the credit ledger): ${completed.map(c => `${c.label} ${formatCurrency(c.applied)}`).join(", ")}`
        : "No installments were applied.";
      const skipped = remaining.length
        ? ` Skipped: ${remaining.map(r => `${r.invoice_number} (${r.installment_label})`).join(", ")}.`
        : "";
      toast.error(
        `Apply stopped on ${remaining[0]?.invoice_number ?? "?"} (${remaining[0]?.installment_label ?? "?"}): ${e?.message ?? "unknown error"}. ${done}.${skipped}`,
        { duration: 14000 },
      );

      // Best-effort sync for invoices we did touch.
      const distinctInvoiceIds = Array.from(new Set(completed.map(c => c.invoiceId)));
      for (const invId of distinctInvoiceIds) {
        try { await syncInvoicePaymentStatus(invId); } catch { /* non-fatal */ }
      }
      invalidateAll();
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ["vendor_credit_balances"] });
    qc.invalidateQueries({ queryKey: ["vendor_credit_ledger"] });
    qc.invalidateQueries({ queryKey: ["vendor_invoices"] });
    qc.invalidateQueries({ queryKey: ["invoice_payments"] });
    qc.invalidateQueries({ queryKey: ["invoice_payments_detail"] });
    qc.invalidateQueries({ queryKey: ["invoice_stats"] });
    qc.invalidateQueries({ queryKey: ["ap_full_audit"] });
  }

  const loading = balLoading || invLoading;
  const remainingCredit = round2(Math.max(0, balance - totalApplied));

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="p-6 pb-3 shrink-0 border-b">
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-emerald-500" />
            Smart Apply Credit — {vendor}
            <Badge variant="outline" className="ml-2 text-[10px]">
              {step === "review" ? "Step 1 of 2 · Review" : "Step 2 of 2 · Confirm"}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 text-sm min-h-0">
          {/* Header stats */}
          <div className="grid grid-cols-4 gap-3">
            <div className="p-3 rounded border">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Available credit</p>
              <p className="text-lg font-bold tabular-nums text-emerald-500">{formatCurrency(balance)}</p>
            </div>
            <div className="p-3 rounded border">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Open owed (all installments)</p>
              <p className="text-lg font-bold tabular-nums">{formatCurrency(totalOwedOpen)}</p>
            </div>
            <div className="p-3 rounded border">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Suggested seed</p>
              <Input
                type="number"
                step="0.01"
                min={0}
                max={balance}
                value={seedStr}
                onChange={e => { setSeedStr(e.target.value); setDirty(false); }}
                className="h-8 mt-0.5"
                disabled={step === "confirm" || submitting}
                title="Used to compute the default allocation. Editing per-row amounts overrides this."
              />
              <p className="text-[10px] text-muted-foreground mt-0.5">Drives default split</p>
            </div>
            <div className="p-3 rounded border">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Remaining credit</p>
              <p className={`text-lg font-bold tabular-nums ${overBalance ? "text-destructive" : "text-emerald-500"}`}>
                {formatCurrency(remainingCredit)}
              </p>
            </div>
          </div>

          {/* Guardrail */}
          <div className="flex items-start gap-2 p-2 rounded border bg-muted/30 text-[11px] text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Allocation defaults to <strong>oldest past-due first, then soonest upcoming</strong>, across every
              invoice for this vendor — so a September tranche is never funded before a June one. Override any row.
            </span>
          </div>

          {overBalance && (
            <div className="flex items-center gap-2 text-[11px] text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              Allocation exceeds available credit by {formatCurrency(totalApplied - balance)}
            </div>
          )}

          {/* Pick-list */}
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">
              All open installments for {vendor}. Pre-checked rows are the suggested allocation; uncheck or edit any row.
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px] gap-1"
              onClick={resetToSuggested}
              disabled={step === "confirm" || submitting || !dirty}
            >
              <RotateCcw className="h-3 w-3" /> Reset to suggested
            </Button>
          </div>

          {loading ? (
            <p className="text-xs text-muted-foreground py-6 text-center">Loading open installments…</p>
          ) : openInstallments.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">No open installments for {vendor}.</p>
          ) : (
            <div className="border rounded overflow-hidden">
              <div className="overflow-x-auto max-h-[380px]">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 sticky top-0 z-10">
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1.5 px-2 w-8">Use</th>
                      <th className="py-1.5 px-2">Invoice #</th>
                      <th className="py-1.5 px-2">Inst.</th>
                      <th className="py-1.5 px-2">Due</th>
                      <th className="py-1.5 px-2">Status</th>
                      <th className="py-1.5 px-2 text-right">Owed now</th>
                      <th className="py-1.5 px-2 text-right w-32">Credit applied</th>
                      <th className="py-1.5 px-2 text-right">Owed after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openInstallments.map(row => {
                      const amount = Number(allocMap[row.payment_id] ?? 0);
                      const checked = amount > 0;
                      const owedAfter = round2(row.owedNow - amount);
                      const isPast = row.pastDueDays > 0;
                      const inputVal =
                        inputStrs[row.payment_id] ??
                        (amount > 0 ? amount.toFixed(2) : "");
                      const rowClass = row.locked
                        ? "border-t opacity-50 bg-muted/20 cursor-not-allowed"
                        : `border-t hover:bg-muted/20 ${checked ? "" : "opacity-70"}`;
                      return (
                        <tr key={row.payment_id} className={rowClass} title={row.lockReason ?? undefined}>
                          <td className="py-1.5 px-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleRow(row)}
                              disabled={step === "confirm" || submitting || row.locked}
                            />
                          </td>
                          <td className="py-1.5 px-2 font-mono">{row.invoice_number}</td>
                          <td className="py-1.5 px-2 font-mono whitespace-nowrap">{row.installment_label}</td>
                          <td className="py-1.5 px-2 font-mono">{row.due_date}</td>
                          <td className="py-1.5 px-2">
                            {row.locked ? (
                              <Badge
                                variant="outline"
                                className="text-[10px] h-4 px-1 bg-muted text-muted-foreground border-muted-foreground/30 gap-1"
                              >
                                <Lock className="h-2.5 w-2.5" />
                                Locked
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className={`text-[10px] h-4 px-1 ${
                                  isPast
                                    ? "bg-red-500/10 text-red-400 border-red-500/30"
                                    : "bg-blue-500/10 text-blue-400 border-blue-500/30"
                                }`}
                              >
                                {isPast
                                  ? `Past due ${row.pastDueDays}d`
                                  : row.pastDueDays === 0
                                    ? "Due today"
                                    : `Due in ${Math.abs(row.pastDueDays)}d`}
                              </Badge>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums">{formatCurrency(row.owedNow)}</td>
                          <td className="py-1.5 px-2 text-right">
                            {row.locked ? (
                              <span className="text-[10px] text-muted-foreground italic">{row.lockReason}</span>
                            ) : (
                              <Input
                                type="number"
                                step="0.01"
                                min={0}
                                max={row.owedNow}
                                value={inputVal}
                                onChange={e => onRowInputChange(row, e.target.value)}
                                disabled={step === "confirm" || submitting}
                                className="h-7 text-xs text-right tabular-nums"
                                placeholder="0.00"
                              />
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            {row.locked ? "—" : formatCurrency(owedAfter)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-muted/30 sticky bottom-0">
                    <tr className="border-t">
                      <td colSpan={6} className="py-1.5 px-2 text-right text-muted-foreground">
                        Total applied
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums font-bold text-emerald-500">
                        {formatCurrency(totalApplied)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* Footer math */}
          {!loading && openInstallments.length > 0 && (
            <div className="p-3 rounded bg-muted/40 border text-xs space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">Vendor credit balance</span>
                <span className="font-bold tabular-nums">{formatCurrency(balance)}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className={`font-bold tabular-nums ${overBalance ? "text-destructive" : "text-emerald-500"}`}>
                  {formatCurrency(creditAfter)}
                </span>
                <span className="ml-3 text-muted-foreground">·</span>
                <span className="text-muted-foreground">Installments touched</span>
                <span className="font-bold">{allocations.length}</span>
              </div>
            </div>
          )}

          {progress && (
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Applying {progress.done} / {progress.total}…
            </div>
          )}
        </div>

        {/* Pinned footer */}
        <div className="shrink-0 border-t px-6 py-3 flex gap-2 justify-end bg-background">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          {step === "review" ? (
            <Button
              onClick={() => setStep("confirm")}
              disabled={!valid}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              Review &amp; confirm →
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("review")} disabled={submitting}>
                Back
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={!valid || submitting}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Wallet className="h-4 w-4 mr-2" />
                )}
                Confirm — apply {formatCurrency(totalApplied)} to {allocations.length} installment
                {allocations.length === 1 ? "" : "s"}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
