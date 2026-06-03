/**
 * SmartApplyCreditDialog
 *
 * Vendor-level credit allocation with a full pick-list + explicit confirm.
 *
 * Hard rules (per 2026-06-03 drop, rev. 2):
 *  - The ONLY write path is `applyVendorCreditToInvoice`, looped per invoice.
 *  - Nothing writes until the user clicks Confirm on the Review screen.
 *  - Preview math == write math, to the cent.
 *  - Additive only — does not touch reverse / triggers / view / existing dialogs.
 *
 * Pick-list semantics:
 *  - Every open invoice for the canonicalized vendor is listed.
 *  - The "Amount to apply" input seeds a suggested allocation (past-due first,
 *    then upcoming, oldest-due first), which pre-checks rows with positive
 *    suggested amounts.
 *  - Josh can: check/uncheck any row, edit any row's applied amount (clamped
 *    to that invoice's owed amount; total across rows must stay ≤ available
 *    credit), or hit "Reset to suggested".
 */
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Wallet, Loader2, ArrowRight, Info, AlertTriangle, RotateCcw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/supabase-queries";
import {
  fetchVendorCreditBalance,
  applyVendorCreditToInvoice,
} from "@/lib/vendor-credits";
import { fetchVendorAliasMap, resolveVendorKey } from "@/lib/vendor-alias-resolver";

interface Props {
  vendor: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface OpenInvoice {
  invoice_id: string;
  invoice_number: string;
  earliestDueDate: string;
  owedNow: number;
  pastDueDays: number; // >0 past due, <=0 upcoming
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function computeSuggested(amount: number, invoices: OpenInvoice[]): Record<string, number> {
  const out: Record<string, number> = {};
  let remaining = round2(amount);
  for (const inv of invoices) {
    if (remaining <= 0.005) break;
    const slice = round2(Math.min(remaining, inv.owedNow));
    if (slice <= 0) continue;
    out[inv.invoice_id] = slice;
    remaining = round2(remaining - slice);
  }
  return out;
}

export function SmartApplyCreditDialog({ vendor, open, onOpenChange }: Props) {
  const qc = useQueryClient();

  // Seed amount drives the suggested allocation; the actual applied total is
  // the sum of per-row values (which Josh can edit freely up to credit).
  const [seedStr, setSeedStr] = useState("");
  const [allocMap, setAllocMap] = useState<Record<string, number>>({});
  const [dirty, setDirty] = useState(false);
  const [step, setStep] = useState<"review" | "confirm">("review");
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Track per-row input strings so partial typing ("12.") doesn't get clobbered.
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

  const { data: openInvoices = [], isLoading: invLoading } = useQuery({
    queryKey: ["smart_apply_open_invoices", vendor.toLowerCase(), aliasMap?.size],
    enabled: open && !!aliasMap,
    queryFn: async (): Promise<OpenInvoice[]> => {
      const targetKey = resolveVendorKey(vendor, aliasMap!);
      const { data, error } = await supabase
        .from("invoice_payments")
        .select("invoice_id, invoice_number, vendor, due_date, balance_remaining, is_paid, payment_status")
        .in("payment_status", ["unpaid", "partial"])
        .eq("is_paid", false);
      if (error) throw error;

      const rows = (data ?? []).filter((r: any) => {
        if (!r.invoice_id) return false;
        if (resolveVendorKey(r.vendor ?? "", aliasMap!) !== targetKey) return false;
        if (Number(r.balance_remaining) <= 0) return false;
        const st = (r.payment_status ?? "").toLowerCase();
        if (st === "void" || st === "disputed") return false;
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

      const byInvoice = new Map<string, { earliest: string; owed: number; number: string }>();
      for (const r of rows) {
        const parent = parentMap.get(r.invoice_id);
        if (!parent) continue;
        if ((parent.doc_type ?? "INVOICE").toUpperCase() !== "INVOICE") continue;
        const pStatus = (parent.status ?? "").toLowerCase();
        if (pStatus === "void" || pStatus === "disputed") continue;

        const existing = byInvoice.get(r.invoice_id);
        const due = r.due_date as string;
        const owed = Number(r.balance_remaining) || 0;
        const number = parent.invoice_number ?? r.invoice_number ?? "—";
        if (!existing) {
          byInvoice.set(r.invoice_id, { earliest: due, owed, number });
        } else {
          if (due && (!existing.earliest || due < existing.earliest)) existing.earliest = due;
          existing.owed = round2(existing.owed + owed);
        }
      }

      const today = serverToday ?? new Date().toISOString().slice(0, 10);
      const todayMs = new Date(today + "T00:00:00").getTime();

      const out: OpenInvoice[] = [];
      for (const [invoice_id, v] of byInvoice.entries()) {
        if (!v.earliest) continue;
        const dueMs = new Date(v.earliest + "T00:00:00").getTime();
        const diffDays = Math.round((todayMs - dueMs) / (1000 * 60 * 60 * 24));
        out.push({
          invoice_id,
          invoice_number: v.number,
          earliestDueDate: v.earliest,
          owedNow: round2(v.owed),
          pastDueDays: diffDays,
        });
      }
      out.sort((a, z) => {
        const aPast = a.pastDueDays > 0;
        const zPast = z.pastDueDays > 0;
        if (aPast && !zPast) return -1;
        if (!aPast && zPast) return 1;
        if (aPast && zPast) return z.pastDueDays - a.pastDueDays;
        return a.earliestDueDate.localeCompare(z.earliestDueDate);
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

  // Seed default once data lands (full balance, capped by total owed).
  const totalOwed = useMemo(
    () => round2(openInvoices.reduce((s, i) => s + i.owedNow, 0)),
    [openInvoices],
  );
  useEffect(() => {
    if (!open || balLoading || invLoading) return;
    if (seedStr !== "") return;
    const cap = round2(Math.min(balance, totalOwed));
    setSeedStr(cap > 0 ? cap.toFixed(2) : "0.00");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, balLoading, invLoading, balance, totalOwed]);

  const seedAmount = Math.max(0, round2(parseFloat(seedStr) || 0));

  // Auto-fill allocation from suggestion whenever seed/invoices change AND user
  // hasn't customized. As soon as dirty=true, the user is in control.
  useEffect(() => {
    if (!open || dirty) return;
    if (balLoading || invLoading) return;
    setAllocMap(computeSuggested(seedAmount, openInvoices));
    setInputStrs({});
  }, [open, dirty, balLoading, invLoading, seedAmount, openInvoices]);

  const totalApplied = useMemo(
    () => round2(Object.values(allocMap).reduce((s, v) => s + (Number(v) || 0), 0)),
    [allocMap],
  );
  const creditAfter = round2(balance - totalApplied);
  const overBalance = totalApplied > balance + 0.005;
  const nothingPicked = totalApplied <= 0;
  const valid = !overBalance && !nothingPicked && openInvoices.length > 0;

  function setRowAmount(invId: string, amount: number) {
    setDirty(true);
    setAllocMap(prev => {
      const next = { ...prev };
      if (amount <= 0) delete next[invId];
      else next[invId] = round2(amount);
      return next;
    });
  }

  function toggleRow(inv: OpenInvoice) {
    const current = Number(allocMap[inv.invoice_id] ?? 0);
    if (current > 0) {
      // uncheck → 0
      setRowAmount(inv.invoice_id, 0);
      setInputStrs(s => ({ ...s, [inv.invoice_id]: "" }));
    } else {
      // check → fill from remaining pool, capped to owed
      const remainingPool = round2(Math.max(0, balance - totalApplied));
      const fill = round2(Math.min(inv.owedNow, remainingPool));
      setRowAmount(inv.invoice_id, fill);
      setInputStrs(s => ({ ...s, [inv.invoice_id]: fill > 0 ? fill.toFixed(2) : "" }));
    }
  }

  function onRowInputChange(inv: OpenInvoice, raw: string) {
    setInputStrs(s => ({ ...s, [inv.invoice_id]: raw }));
    const n = parseFloat(raw);
    if (!isFinite(n) || n <= 0) {
      setRowAmount(inv.invoice_id, 0);
      return;
    }
    const clamped = Math.min(n, inv.owedNow);
    setRowAmount(inv.invoice_id, clamped);
  }

  function resetToSuggested() {
    setDirty(false);
    setInputStrs({});
    // Effect above will recompute from current seedAmount.
  }

  // Build the ordered allocations passed to write — exact preview/write parity.
  const allocations = useMemo(
    () =>
      openInvoices
        .map(inv => ({ ...inv, applied: round2(Number(allocMap[inv.invoice_id] ?? 0)) }))
        .filter(a => a.applied > 0)
        .map(a => ({ ...a, owedAfter: round2(a.owedNow - a.applied) })),
    [openInvoices, allocMap],
  );

  async function handleConfirm() {
    if (!valid) return;
    setSubmitting(true);
    setProgress({ done: 0, total: allocations.length });

    const completed: Array<{ invoiceNumber: string; applied: number }> = [];
    try {
      for (let i = 0; i < allocations.length; i++) {
        const a = allocations[i];
        await applyVendorCreditToInvoice({
          vendor,
          invoiceId: a.invoice_id,
          invoiceNumber: a.invoice_number,
          amount: a.applied,
        });
        completed.push({ invoiceNumber: a.invoice_number, applied: a.applied });
        setProgress({ done: i + 1, total: allocations.length });
      }
      toast.success(
        `Applied ${formatCurrency(totalApplied)} across ${completed.length} invoice${completed.length === 1 ? "" : "s"}`,
      );
      invalidateAll();
      onOpenChange(false);
    } catch (e: any) {
      const remaining = allocations.slice(completed.length);
      const done = completed.length
        ? `Completed (each individually reversible from the credit ledger): ${completed.map(c => `${c.invoiceNumber} ${formatCurrency(c.applied)}`).join(", ")}`
        : "No invoices were applied.";
      const skipped = remaining.length
        ? ` Skipped: ${remaining.map(r => r.invoice_number).join(", ")}.`
        : "";
      toast.error(
        `Apply stopped on ${remaining[0]?.invoice_number ?? "?"}: ${e?.message ?? "unknown error"}. ${done}.${skipped}`,
        { duration: 14000 },
      );
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
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-emerald-500" />
            Smart Apply Credit — {vendor}
            <Badge variant="outline" className="ml-2 text-[10px]">
              {step === "review" ? "Step 1 of 2 · Review" : "Step 2 of 2 · Confirm"}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* Header stats */}
          <div className="grid grid-cols-4 gap-3">
            <div className="p-3 rounded border">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Available credit</p>
              <p className="text-lg font-bold tabular-nums text-emerald-500">{formatCurrency(balance)}</p>
            </div>
            <div className="p-3 rounded border">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Open owed (all)</p>
              <p className="text-lg font-bold tabular-nums">{formatCurrency(totalOwed)}</p>
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

          {/* Reconciliation guardrail */}
          <div className="flex items-start gap-2 p-2 rounded border bg-muted/30 text-[11px] text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Tip: vendors decide on their statements which invoices a credit consumes. If you have the vendor's
              statement or credit memo, match their application; use suggested order when you don't.
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
              All open invoices for {vendor}. Pre-checked rows are the suggested allocation; uncheck or edit any row.
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
            <p className="text-xs text-muted-foreground py-6 text-center">Loading open invoices…</p>
          ) : openInvoices.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">No open invoices for {vendor}.</p>
          ) : (
            <div className="border rounded overflow-hidden">
              <div className="overflow-x-auto max-h-[340px]">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 sticky top-0">
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1.5 px-2 w-8">Use</th>
                      <th className="py-1.5 px-2">Invoice #</th>
                      <th className="py-1.5 px-2">Due</th>
                      <th className="py-1.5 px-2">Status</th>
                      <th className="py-1.5 px-2 text-right">Owed now</th>
                      <th className="py-1.5 px-2 text-right w-32">Credit applied</th>
                      <th className="py-1.5 px-2 text-right">Owed after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openInvoices.map(inv => {
                      const amount = Number(allocMap[inv.invoice_id] ?? 0);
                      const checked = amount > 0;
                      const owedAfter = round2(inv.owedNow - amount);
                      const isPast = inv.pastDueDays > 0;
                      const inputVal =
                        inputStrs[inv.invoice_id] ??
                        (amount > 0 ? amount.toFixed(2) : "");
                      return (
                        <tr
                          key={inv.invoice_id}
                          className={`border-t hover:bg-muted/20 ${checked ? "" : "opacity-70"}`}
                        >
                          <td className="py-1.5 px-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleRow(inv)}
                              disabled={step === "confirm" || submitting}
                            />
                          </td>
                          <td className="py-1.5 px-2 font-mono">{inv.invoice_number}</td>
                          <td className="py-1.5 px-2 font-mono">{inv.earliestDueDate}</td>
                          <td className="py-1.5 px-2">
                            <Badge
                              variant="outline"
                              className={`text-[10px] h-4 px-1 ${
                                isPast
                                  ? "bg-red-500/10 text-red-400 border-red-500/30"
                                  : "bg-blue-500/10 text-blue-400 border-blue-500/30"
                              }`}
                            >
                              {isPast
                                ? `Past due ${inv.pastDueDays}d`
                                : inv.pastDueDays === 0
                                  ? "Due today"
                                  : `Due in ${Math.abs(inv.pastDueDays)}d`}
                            </Badge>
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums">{formatCurrency(inv.owedNow)}</td>
                          <td className="py-1.5 px-2 text-right">
                            <Input
                              type="number"
                              step="0.01"
                              min={0}
                              max={inv.owedNow}
                              value={inputVal}
                              onChange={e => onRowInputChange(inv, e.target.value)}
                              disabled={step === "confirm" || submitting}
                              className="h-7 text-xs text-right tabular-nums"
                              placeholder="0.00"
                            />
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums">{formatCurrency(owedAfter)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-muted/30 sticky bottom-0">
                    <tr className="border-t">
                      <td colSpan={5} className="py-1.5 px-2 text-right text-muted-foreground">
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
          {!loading && openInvoices.length > 0 && (
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
                <span className="text-muted-foreground">Invoices touched</span>
                <span className="font-bold">{allocations.length}</span>
              </div>
            </div>
          )}

          {progress && (
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Applying {progress.done} / {progress.total}…
            </div>
          )}

          {/* Footer buttons */}
          <div className="flex gap-2 justify-end">
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
                  Confirm — apply {formatCurrency(totalApplied)} to {allocations.length} invoice
                  {allocations.length === 1 ? "" : "s"}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
