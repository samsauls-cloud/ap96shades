/**
 * SmartApplyCreditDialog
 *
 * Vendor-level credit allocation with preview + explicit confirm.
 *
 * Hard rules (per 2026-06-03 drop):
 *  - The ONLY write path is `applyVendorCreditToInvoice`, looped per invoice.
 *  - Nothing writes until the user clicks Confirm on the Review screen.
 *  - Preview math must equal write math to the cent.
 *  - Additive — does not touch reverse / triggers / view / existing dialogs.
 */
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Wallet, Loader2, ArrowRight, Info, AlertTriangle } from "lucide-react";
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
  earliestDueDate: string; // earliest unpaid installment's due date
  owedNow: number;
  pastDueDays: number; // >0 past due, <=0 upcoming (negative = upcoming)
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function SmartApplyCreditDialog({ vendor, open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const [amountStr, setAmountStr] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<"review" | "confirm">("review");
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; lastApplied: number } | null>(null);

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

  // Fetch every open installment whose vendor canonicalizes to the same key.
  const { data: openInvoices = [], isLoading: invLoading } = useQuery({
    queryKey: ["smart_apply_open_invoices", vendor.toLowerCase(), aliasMap?.size],
    enabled: open && !!aliasMap,
    queryFn: async (): Promise<OpenInvoice[]> => {
      const targetKey = resolveVendorKey(vendor, aliasMap!);

      // Pull every unpaid/partial installment + parent invoice metadata.
      const { data, error } = await supabase
        .from("invoice_payments")
        .select("id, invoice_id, invoice_number, vendor, due_date, balance_remaining, is_paid, payment_status")
        .in("payment_status", ["unpaid", "partial"])
        .eq("is_paid", false);
      if (error) throw error;

      // Filter by canonical vendor + drop void/disputed.
      const rows = (data ?? []).filter((r: any) => {
        if (!r.invoice_id) return false;
        if (resolveVendorKey(r.vendor ?? "", aliasMap!) !== targetKey) return false;
        if (Number(r.balance_remaining) <= 0) return false;
        const st = (r.payment_status ?? "").toLowerCase();
        if (st === "void" || st === "disputed") return false;
        return true;
      });

      if (rows.length === 0) return [];

      // Also pull parent invoice doc_type / status so we can exclude proformas,
      // disputed/void invoices defensively.
      const invoiceIds = Array.from(new Set(rows.map((r: any) => r.invoice_id)));
      const { data: parents } = await supabase
        .from("vendor_invoices")
        .select("id, doc_type, status, invoice_number")
        .in("id", invoiceIds);
      const parentMap = new Map<string, any>();
      (parents ?? []).forEach((p: any) => parentMap.set(p.id, p));

      // Group installments by invoice_id.
      const byInvoice = new Map<string, { earliest: string; owed: number; number: string }>();
      for (const r of rows) {
        const parent = parentMap.get(r.invoice_id);
        if (!parent) continue;
        const docType = (parent.doc_type ?? "INVOICE").toUpperCase();
        if (docType !== "INVOICE") continue;
        const parentStatus = (parent.status ?? "").toLowerCase();
        if (parentStatus === "void" || parentStatus === "disputed") continue;

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

      // Order: past-due first oldest first, then upcoming earliest first.
      out.sort((a, z) => {
        const aPast = a.pastDueDays > 0;
        const zPast = z.pastDueDays > 0;
        if (aPast && !zPast) return -1;
        if (!aPast && zPast) return 1;
        // both past: oldest due first (largest pastDueDays first → earliest date)
        if (aPast && zPast) return z.pastDueDays - a.pastDueDays;
        // both upcoming: soonest first (smallest |pastDueDays|)
        return a.earliestDueDate.localeCompare(z.earliestDueDate);
      });
      return out;
    },
  });

  // Reset state on open.
  useEffect(() => {
    if (open) {
      setExcluded(new Set());
      setStep("review");
      setProgress(null);
      setSubmitting(false);
    }
  }, [open]);

  // Default amount = full balance, capped at total owed of included invoices.
  const totalOwedIncluded = useMemo(
    () => round2(openInvoices.filter(i => !excluded.has(i.invoice_id)).reduce((s, i) => s + i.owedNow, 0)),
    [openInvoices, excluded],
  );
  const cap = round2(Math.min(balance, totalOwedIncluded));

  useEffect(() => {
    if (!open) return;
    if (balLoading || invLoading) return;
    // Auto-fill only on first load; preserve typed value otherwise.
    setAmountStr(prev => (prev === "" ? (cap > 0 ? cap.toFixed(2) : "") : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, balLoading, invLoading]);

  const parsed = Math.max(0, round2(parseFloat(amountStr) || 0));
  const overBalance = parsed > balance + 0.005;
  const overOwed = parsed > totalOwedIncluded + 0.005;
  const valid = parsed > 0 && !overBalance && !overOwed && openInvoices.length > 0;

  // Suggested allocation against currently-included invoices in order.
  const allocations = useMemo(() => {
    let remaining = parsed;
    const out: Array<OpenInvoice & { applied: number; owedAfter: number }> = [];
    for (const inv of openInvoices) {
      if (excluded.has(inv.invoice_id)) continue;
      if (remaining <= 0.005) break;
      const slice = round2(Math.min(remaining, inv.owedNow));
      if (slice <= 0) continue;
      out.push({
        ...inv,
        applied: slice,
        owedAfter: round2(inv.owedNow - slice),
      });
      remaining = round2(remaining - slice);
    }
    return out;
  }, [openInvoices, excluded, parsed]);

  const totalApplied = useMemo(() => round2(allocations.reduce((s, a) => s + a.applied, 0)), [allocations]);
  const creditAfter = round2(Math.max(0, balance - totalApplied));

  function toggleExclude(id: string) {
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleConfirm() {
    if (!valid || allocations.length === 0) return;
    setSubmitting(true);
    setProgress({ done: 0, total: allocations.length, lastApplied: 0 });

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
        setProgress({ done: i + 1, total: allocations.length, lastApplied: a.applied });
      }
      toast.success(
        `Applied ${formatCurrency(totalApplied)} across ${completed.length} invoice${completed.length === 1 ? "" : "s"}`,
      );
      // Same invalidations as the single-invoice path.
      qc.invalidateQueries({ queryKey: ["vendor_credit_balances"] });
      qc.invalidateQueries({ queryKey: ["vendor_credit_ledger"] });
      qc.invalidateQueries({ queryKey: ["vendor_invoices"] });
      qc.invalidateQueries({ queryKey: ["invoice_payments"] });
      qc.invalidateQueries({ queryKey: ["invoice_payments_detail"] });
      qc.invalidateQueries({ queryKey: ["invoice_stats"] });
      qc.invalidateQueries({ queryKey: ["ap_full_audit"] });
      onOpenChange(false);
    } catch (e: any) {
      const remaining = allocations.slice(completed.length);
      const completedSummary = completed.length
        ? `Completed (each individually reversible from the ledger): ${completed.map(c => `${c.invoiceNumber} ${formatCurrency(c.applied)}`).join(", ")}`
        : "No invoices were applied.";
      const skippedSummary = remaining.length
        ? ` Skipped: ${remaining.map(r => r.invoice_number).join(", ")}.`
        : "";
      toast.error(
        `Apply stopped on ${remaining[0]?.invoice_number ?? "?"}: ${e?.message ?? "unknown error"}. ${completedSummary}.${skippedSummary}`,
        { duration: 14000 },
      );
      // Refresh anyway so partial state shows.
      qc.invalidateQueries({ queryKey: ["vendor_credit_balances"] });
      qc.invalidateQueries({ queryKey: ["vendor_credit_ledger"] });
      qc.invalidateQueries({ queryKey: ["vendor_invoices"] });
      qc.invalidateQueries({ queryKey: ["invoice_payments"] });
      qc.invalidateQueries({ queryKey: ["invoice_stats"] });
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }

  const loading = balLoading || invLoading;

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-emerald-500" />
            Smart Apply Credit — {vendor}
            <Badge variant="outline" className="ml-2 text-[10px]">{step === "review" ? "Step 1 of 2 · Review" : "Step 2 of 2 · Confirm"}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* Header stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 rounded border">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Available credit</p>
              <p className="text-lg font-bold tabular-nums text-emerald-500">{formatCurrency(balance)}</p>
            </div>
            <div className="p-3 rounded border">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Open owed (included)</p>
              <p className="text-lg font-bold tabular-nums">{formatCurrency(totalOwedIncluded)}</p>
            </div>
            <div className="p-3 rounded border">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Amount to apply</p>
              <Input
                type="number"
                step="0.01"
                min={0}
                max={cap}
                value={amountStr}
                onChange={e => setAmountStr(e.target.value)}
                className="h-8 mt-0.5"
                disabled={step === "confirm" || submitting}
              />
              <p className="text-[10px] text-muted-foreground mt-0.5">Capped at {formatCurrency(cap)}</p>
            </div>
          </div>

          {/* Reconciliation guardrail copy */}
          <div className="flex items-start gap-2 p-2 rounded border bg-muted/30 text-[11px] text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Tip: vendors decide on their statements which invoices a credit consumes. If you have the vendor's
              statement or credit memo, match their application; use suggested order when you don't.
            </span>
          </div>

          {(overBalance || overOwed) && (
            <div className="flex items-center gap-2 text-[11px] text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              {overBalance
                ? `Exceeds available credit by ${formatCurrency(parsed - balance)}`
                : `Exceeds owed total by ${formatCurrency(parsed - totalOwedIncluded)}`}
            </div>
          )}

          {/* Allocation table */}
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
                      <th className="py-1.5 px-2 text-right">Credit applied</th>
                      <th className="py-1.5 px-2 text-right">Owed after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openInvoices.map(inv => {
                      const isExcluded = excluded.has(inv.invoice_id);
                      const alloc = allocations.find(a => a.invoice_id === inv.invoice_id);
                      const applied = alloc?.applied ?? 0;
                      const owedAfter = round2(inv.owedNow - applied);
                      const isPast = inv.pastDueDays > 0;
                      return (
                        <tr
                          key={inv.invoice_id}
                          className={`border-t hover:bg-muted/20 ${isExcluded ? "opacity-50" : ""}`}
                        >
                          <td className="py-1.5 px-2">
                            <input
                              type="checkbox"
                              checked={!isExcluded}
                              onChange={() => toggleExclude(inv.invoice_id)}
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
                          <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-emerald-500">
                            {applied > 0 ? `−${formatCurrency(applied)}` : "—"}
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
          {valid && (
            <div className="p-3 rounded bg-muted/40 border text-xs space-y-1">
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">Vendor credit balance</span>
                <span className="font-bold tabular-nums">{formatCurrency(balance)}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="font-bold tabular-nums text-emerald-500">{formatCurrency(creditAfter)}</span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
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
                disabled={!valid || allocations.length === 0}
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
                  disabled={!valid || submitting || allocations.length === 0}
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
