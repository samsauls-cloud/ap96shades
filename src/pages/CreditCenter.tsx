/**
 * Credit Center — central surface for all vendor on-account credits.
 *
 * - Summary cards (total outstanding, vendors with credit, applied last 30d, oldest unapplied).
 * - Vendor balances table (alias-canonical) with quick actions per row.
 * - Full ledger with filters + CSV export.
 *
 * Apply / Add / Reverse all reuse the existing flows so writes stay identical
 * to InvoiceDrawer + VendorCreditDrawer (same query keys invalidated).
 */
import { useMemo, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Wallet, Search, Download, ExternalLink, Ban, Undo2, Loader2, Filter as FilterIcon } from "lucide-react";
import {
  fetchAllVendorCreditBalances,
  fetchAllVendorCreditLedger,
  voidVendorCredit,
  reverseVendorCreditApplication,
  type VendorCredit,
  type VendorCreditSource,
} from "@/lib/vendor-credits";
import { fetchVendorAliasMap, resolveVendorKey } from "@/lib/vendor-alias-resolver";
import { formatCurrency } from "@/lib/supabase-queries";
import { AddVendorCreditDialog } from "@/components/invoices/AddVendorCreditDialog";
import { ApplyVendorCreditDialog } from "@/components/invoices/ApplyVendorCreditDialog";
import { VendorCreditDrawer } from "@/components/invoices/VendorCreditDrawer";
import { toast } from "sonner";

const SOURCE_LABEL: Record<string, string> = {
  remittance_overpay: "Overpayment",
  invoice_application: "Applied",
  manual_adjustment: "Manual",
  reversal: "Reversal",
  returned_ra: "Returned/RA",
  other: "Other",
};

const SOURCE_TONE: Record<string, string> = {
  remittance_overpay: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  invoice_application: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  manual_adjustment: "bg-muted text-muted-foreground",
  reversal: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  returned_ra: "bg-purple-500/10 text-purple-400 border-purple-500/30",
  other: "bg-muted text-muted-foreground",
};

export default function CreditCenter() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: balances = [], isLoading: balLoading } = useQuery({
    queryKey: ["vendor_credit_balances"],
    queryFn: fetchAllVendorCreditBalances,
  });
  const { data: ledger = [], isLoading: ledgerLoading } = useQuery({
    queryKey: ["vendor_credit_ledger"],
    queryFn: fetchAllVendorCreditLedger,
  });
  const { data: aliasMap } = useQuery({
    queryKey: ["vendor_alias_map"],
    queryFn: fetchVendorAliasMap,
  });

  // Filters
  const initialVendor = searchParams.get("vendor") ?? "";
  const [vendorFilter, setVendorFilter] = useState(initialVendor);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [onlyUnapplied, setOnlyUnapplied] = useState(false);
  const [drawerVendor, setDrawerVendor] = useState<string | null>(null);
  const [applyTarget, setApplyTarget] = useState<{ vendor: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Keep URL ?vendor= in sync with filter for shareable links.
  useEffect(() => {
    const current = searchParams.get("vendor") ?? "";
    if (current !== vendorFilter) {
      const next = new URLSearchParams(searchParams);
      if (vendorFilter) next.set("vendor", vendorFilter);
      else next.delete("vendor");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorFilter]);

  // ── Summary cards ────────────────────────────────────────────────────
  const totalOutstanding = useMemo(
    () => balances.filter(b => b.balance > 0).reduce((s, b) => s + b.balance, 0),
    [balances],
  );
  const vendorsWithCredit = useMemo(() => balances.filter(b => b.balance > 0).length, [balances]);

  const appliedLast30 = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const iso = cutoff.toISOString().slice(0, 10);
    return ledger
      .filter(e => e.source_type === "invoice_application" && e.occurred_on >= iso)
      .reduce((s, e) => s + Math.abs(Number(e.amount)), 0);
  }, [ledger]);

  const oldestUnappliedAgeDays = useMemo(() => {
    if (!aliasMap) return null;
    // For each vendor with positive balance, find their oldest still-on-account
    // positive add: first credit-add row scanned oldest-first whose net balance
    // up to that point would still be positive. Simpler proxy: take oldest
    // positive row for vendors with current balance > 0. Good enough for KPI.
    let oldest: string | null = null;
    const positives = ledger.filter(e => Number(e.amount) > 0 && e.source_type !== "invoice_application");
    for (const b of balances) {
      if (b.balance <= 0) continue;
      const vendorPositives = positives
        .filter(e => resolveVendorKey(e.vendor, aliasMap) === b.vendor_key)
        .sort((a, z) => a.occurred_on.localeCompare(z.occurred_on));
      const first = vendorPositives[0]?.occurred_on;
      if (first && (!oldest || first < oldest)) oldest = first;
    }
    if (!oldest) return null;
    const diff = Math.floor((Date.now() - new Date(oldest + "T00:00:00").getTime()) / (1000 * 60 * 60 * 24));
    return diff;
  }, [ledger, balances, aliasMap]);

  // ── Vendor balances table (alias-canonical) ──────────────────────────
  const positiveBalances = useMemo(
    () => balances.filter(b => Math.abs(b.balance) > 0.005).slice().sort((a, z) => z.balance - a.balance),
    [balances],
  );

  // Per-vendor "applied all-time" totals (absolute value of invoice_application rows by canonical key).
  const appliedByKey = useMemo(() => {
    if (!aliasMap) return new Map<string, number>();
    const map = new Map<string, number>();
    for (const e of ledger) {
      if (e.source_type !== "invoice_application") continue;
      const k = resolveVendorKey(e.vendor, aliasMap);
      map.set(k, (map.get(k) ?? 0) + Math.abs(Number(e.amount)));
    }
    return map;
  }, [ledger, aliasMap]);

  // ── Full ledger w/ filters + running balance per vendor ──────────────
  const voidedIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of ledger) if ((e as any).reversed_credit_id) set.add((e as any).reversed_credit_id);
    return set;
  }, [ledger]);

  const filteredLedger = useMemo(() => {
    if (!aliasMap) return [] as VendorCredit[];
    const vKey = vendorFilter ? resolveVendorKey(vendorFilter, aliasMap) : null;
    return ledger.filter(e => {
      if (vKey && resolveVendorKey(e.vendor, aliasMap) !== vKey) return false;
      if (sourceFilter !== "all" && e.source_type !== sourceFilter) return false;
      if (fromDate && e.occurred_on < fromDate) return false;
      if (toDate && e.occurred_on > toDate) return false;
      if (onlyUnapplied) {
        // unapplied addition = positive amount, not yet voided, not invoice_application/reversal
        if (Number(e.amount) <= 0) return false;
        if (e.source_type === "invoice_application" || e.source_type === "reversal") return false;
        if (voidedIds.has(e.id)) return false;
      }
      return true;
    });
  }, [ledger, aliasMap, vendorFilter, sourceFilter, fromDate, toDate, onlyUnapplied, voidedIds]);

  // Running balance is computed per canonical vendor across the *unfiltered* ledger
  // (filters only hide rows; the math behind them is still real).
  const runningByRowId = useMemo(() => {
    if (!aliasMap) return new Map<string, number>();
    const sortedAsc = [...ledger].sort((a, z) => {
      const d = a.occurred_on.localeCompare(z.occurred_on);
      return d !== 0 ? d : a.created_at.localeCompare(z.created_at);
    });
    const running = new Map<string, number>();
    const byRow = new Map<string, number>();
    for (const e of sortedAsc) {
      const k = resolveVendorKey(e.vendor, aliasMap);
      const next = (running.get(k) ?? 0) + Number(e.amount);
      running.set(k, next);
      byRow.set(e.id, next);
    }
    return byRow;
  }, [ledger, aliasMap]);

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ["vendor_credit_balances"] });
    qc.invalidateQueries({ queryKey: ["vendor_credit_ledger"] });
    qc.invalidateQueries({ queryKey: ["vendor_invoices"] });
  }

  async function handleVoid(id: string) {
    if (!confirm("Void this credit entry?\n\nA reversal row will be inserted that offsets it; the original stays for audit.")) return;
    setBusyId(id);
    try {
      const { newBalance } = await voidVendorCredit(id);
      toast.success(`Entry voided. Vendor available balance: ${formatCurrency(newBalance)}`);
      invalidateAll();
    } catch (e: any) {
      toast.error(`Void failed: ${e?.message ?? "unknown error"}`, { duration: 8000 });
    } finally {
      setBusyId(null);
    }
  }
  async function handleReverse(id: string) {
    if (!confirm("Reverse this applied credit?\n\nThe vendor's balance will be restored and the invoice will owe this amount again.")) return;
    setBusyId(id);
    try {
      await reverseVendorCreditApplication(id);
      toast.success("Credit application reversed");
      invalidateAll();
      qc.invalidateQueries({ queryKey: ["invoice_payments"] });
      qc.invalidateQueries({ queryKey: ["invoice_payments_detail"] });
      qc.invalidateQueries({ queryKey: ["invoice_stats"] });
      qc.invalidateQueries({ queryKey: ["ap_full_audit"] });
    } catch (e: any) {
      toast.error(`Reverse failed: ${e?.message ?? "unknown error"}`, { duration: 8000 });
    } finally {
      setBusyId(null);
    }
  }

  function exportCsv() {
    const headers = ["Date", "Vendor", "Source", "Description", "Reference", "Related Invoice ID", "Amount", "Running Balance"];
    const rows = filteredLedger.map(e => [
      e.occurred_on,
      e.vendor,
      SOURCE_LABEL[e.source_type] ?? e.source_type,
      (e.description ?? "").replace(/"/g, '""'),
      (e.reference ?? "").replace(/"/g, '""'),
      e.related_invoice_id ?? "",
      Number(e.amount).toFixed(2),
      (runningByRowId.get(e.id) ?? 0).toFixed(2),
    ]);
    const csv = [headers, ...rows]
      .map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${v}"` : String(v)).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vendor-credits-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
              <Wallet className="h-5 w-5 text-emerald-500" />
              Credit Center
            </h1>
            <p className="text-xs text-muted-foreground">Vendor on-account credits — balances, ledger, apply &amp; reverse.</p>
          </div>
          <AddVendorCreditDialog buttonLabel="Add credit" buttonVariant="default" />
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard label="Total credit outstanding" value={formatCurrency(totalOutstanding)} accent="text-emerald-500" />
          <SummaryCard label="Vendors with credit" value={vendorsWithCredit.toString()} />
          <SummaryCard label="Applied (last 30 days)" value={formatCurrency(appliedLast30)} accent="text-blue-400" />
          <SummaryCard
            label="Oldest unapplied credit"
            value={oldestUnappliedAgeDays == null ? "—" : `${oldestUnappliedAgeDays} day${oldestUnappliedAgeDays === 1 ? "" : "s"}`}
            accent={oldestUnappliedAgeDays != null && oldestUnappliedAgeDays > 60 ? "text-amber-500" : ""}
          />
        </div>

        {/* Vendor balances */}
        <Card className="p-3 sm:p-4">
          <h2 className="text-sm font-semibold mb-3">Vendor balances</h2>
          {balLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : positiveBalances.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">No vendor credit balances on file.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-1.5 pr-2">Vendor</th>
                    <th className="py-1.5 pr-2 text-right">Balance</th>
                    <th className="py-1.5 pr-2 text-right">Applied (all-time)</th>
                    <th className="py-1.5 pr-2">Last activity</th>
                    <th className="py-1.5 pr-2 text-right">Entries</th>
                    <th className="py-1.5 pr-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {positiveBalances.map(b => {
                    const applied = appliedByKey.get(b.vendor_key) ?? 0;
                    return (
                      <tr key={b.vendor_key} className="border-b last:border-0 hover:bg-muted/40">
                        <td className="py-2 pr-2 font-medium">{b.vendor_name}</td>
                        <td className="py-2 pr-2 text-right tabular-nums font-semibold text-emerald-500">
                          {formatCurrency(b.balance)}
                          <span className="block text-[10px] text-muted-foreground font-normal">available</span>
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
                          {formatCurrency(applied)}
                        </td>
                        <td className="py-2 pr-2 font-mono">{b.last_activity_on ?? "—"}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{b.ledger_entries}</td>
                        <td className="py-2 pr-2 text-right">
                          <div className="inline-flex gap-1">
                            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setDrawerVendor(b.vendor_name)}>
                              View ledger
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setVendorFilter(b.vendor_name)}>
                              Filter
                            </Button>
                            <Button size="sm" className="h-7 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setApplyTarget({ vendor: b.vendor_name })}>
                              Apply to invoice
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Full ledger */}
        <Card className="p-3 sm:p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <FilterIcon className="h-3.5 w-3.5" />
              Full ledger
              <span className="text-[11px] text-muted-foreground font-normal">
                ({filteredLedger.length} of {ledger.length} entries)
              </span>
            </h2>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={exportCsv} disabled={!filteredLedger.length}>
              <Download className="h-3.5 w-3.5" /> Export CSV
            </Button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <div className="md:col-span-2">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Vendor</Label>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <Input
                  className="h-8 pl-7 text-xs"
                  placeholder="All vendors"
                  value={vendorFilter}
                  onChange={e => setVendorFilter(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Source</Label>
              <select
                value={sourceFilter}
                onChange={e => setSourceFilter(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="all">All sources</option>
                {Object.entries(SOURCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">From</Label>
              <Input type="date" className="h-8 text-xs" value={fromDate} onChange={e => setFromDate(e.target.value)} />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">To</Label>
              <Input type="date" className="h-8 text-xs" value={toDate} onChange={e => setToDate(e.target.value)} />
            </div>
            <label className="md:col-span-5 flex items-center gap-2 text-xs cursor-pointer pt-1">
              <input type="checkbox" checked={onlyUnapplied} onChange={e => setOnlyUnapplied(e.target.checked)} />
              Only show unapplied credit additions
            </label>
          </div>

          {ledgerLoading ? (
            <p className="text-xs text-muted-foreground">Loading ledger…</p>
          ) : filteredLedger.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">No ledger entries match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-1.5 pr-2">Date</th>
                    <th className="py-1.5 pr-2">Vendor</th>
                    <th className="py-1.5 pr-2">Source</th>
                    <th className="py-1.5 pr-2">Description</th>
                    <th className="py-1.5 pr-2">Reference</th>
                    <th className="py-1.5 pr-2">Linked invoice</th>
                    <th className="py-1.5 pr-2 text-right">Amount</th>
                    <th className="py-1.5 pr-2 text-right">Running</th>
                    <th className="py-1.5 pr-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLedger.map(e => {
                    const isPositive = Number(e.amount) > 0;
                    const isApplication = e.source_type === "invoice_application";
                    const isReversal = e.source_type === "reversal";
                    const alreadyVoided = voidedIds.has(e.id);
                    const canVoid = !isApplication && !isReversal && !alreadyVoided && !(e as any).related_payment_id;
                    const canReverse = isApplication && !alreadyVoided;
                    return (
                      <tr key={e.id} className={`border-b last:border-0 hover:bg-muted/40 ${alreadyVoided ? "opacity-60" : ""}`}>
                        <td className="py-2 pr-2 font-mono">{e.occurred_on}</td>
                        <td className="py-2 pr-2">{e.vendor}</td>
                        <td className="py-2 pr-2">
                          <Badge variant="outline" className={`text-[10px] h-4 px-1 ${SOURCE_TONE[e.source_type] ?? ""}`}>
                            {SOURCE_LABEL[e.source_type] ?? e.source_type}
                          </Badge>
                          {alreadyVoided && (
                            <Badge variant="outline" className="ml-1 text-[10px] h-4 px-1 text-amber-500 border-amber-500/40">
                              Reversed
                            </Badge>
                          )}
                        </td>
                        <td className="py-2 pr-2 max-w-[260px] truncate" title={e.description ?? ""}>
                          {e.description || <span className="text-muted-foreground italic">(no description)</span>}
                        </td>
                        <td className="py-2 pr-2 font-mono text-muted-foreground">{e.reference ?? "—"}</td>
                        <td className="py-2 pr-2">
                          {e.related_invoice_id ? (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                              onClick={() => navigate(`/invoices?open=${e.related_invoice_id}`)}
                            >
                              Open <ExternalLink className="h-3 w-3" />
                            </button>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className={`py-2 pr-2 text-right tabular-nums font-semibold ${isPositive ? "text-emerald-500" : "text-orange-400"}`}>
                          {isPositive ? "+" : ""}{formatCurrency(Number(e.amount))}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
                          {formatCurrency(runningByRowId.get(e.id) ?? 0)}
                        </td>
                        <td className="py-2 pr-2 text-right">
                          <div className="inline-flex gap-1">
                            {canReverse && (
                              <Button variant="ghost" size="icon" className="h-6 w-6" title="Reverse"
                                onClick={() => handleReverse(e.id)} disabled={busyId === e.id}>
                                {busyId === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                              </Button>
                            )}
                            {canVoid && (
                              <Button variant="ghost" size="icon" className="h-6 w-6 hover:text-destructive" title="Void (insert reversal)"
                                onClick={() => handleVoid(e.id)} disabled={busyId === e.id}>
                                {busyId === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </main>

      {drawerVendor && (
        <VendorCreditDrawer
          vendor={drawerVendor}
          open={!!drawerVendor}
          onOpenChange={o => !o && setDrawerVendor(null)}
        />
      )}
      {applyTarget && (
        <ApplyVendorCreditFromCenter
          vendor={applyTarget.vendor}
          open={!!applyTarget}
          onClose={() => setApplyTarget(null)}
        />
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent = "" }: { label: string; value: string; accent?: string }) {
  return (
    <Card className="p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-lg font-bold tabular-nums mt-0.5 ${accent}`}>{value}</p>
    </Card>
  );
}

/**
 * Helper wrapper around ApplyVendorCreditDialog that first prompts Josh to
 * pick which open invoice for this vendor to apply against. We keep the dialog
 * write path untouched (it requires an invoiceId/amountOwed).
 */
function ApplyVendorCreditFromCenter({ vendor, open, onClose }: { vendor: string; open: boolean; onClose: () => void }) {
  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ["open_invoices_for_vendor", vendor.toLowerCase()],
    enabled: open,
    queryFn: async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data, error } = await supabase
        .from("vendor_invoices")
        .select("id, invoice_number, status, doc_type")
        .ilike("vendor", vendor)
        .in("status", ["unpaid", "partial"])
        .order("invoice_date", { ascending: true });
      if (error) throw error;
      // Pull owed totals per invoice from invoice_payments.
      const ids = (data ?? []).map((d: any) => d.id);
      if (ids.length === 0) return [];
      const { data: pays } = await supabase
        .from("invoice_payments")
        .select("invoice_id, balance_remaining, is_paid")
        .in("invoice_id", ids);
      const owed = new Map<string, number>();
      (pays ?? []).forEach((p: any) => {
        if (p.is_paid) return;
        owed.set(p.invoice_id, (owed.get(p.invoice_id) ?? 0) + Number(p.balance_remaining ?? 0));
      });
      return (data ?? [])
        .filter((d: any) => (d.doc_type ?? "INVOICE").toUpperCase() === "INVOICE")
        .map((d: any) => ({ ...d, amountOwed: owed.get(d.id) ?? 0 }))
        .filter((d: any) => d.amountOwed > 0);
    },
  });

  const [picked, setPicked] = useState<{ id: string; number: string; owed: number } | null>(null);

  // When user picks, hand off to the existing dialog.
  if (picked) {
    return (
      <ApplyVendorCreditDialog
        invoiceId={picked.id}
        invoiceNumber={picked.number}
        vendor={vendor}
        amountOwed={picked.owed}
        open={open}
        onOpenChange={(v) => { if (!v) { setPicked(null); onClose(); } }}
      />
    );
  }

  return (
    <div className={`fixed inset-0 z-50 ${open ? "" : "hidden"}`}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-background border rounded-lg shadow-xl p-4 space-y-3">
        <h3 className="font-semibold text-sm flex items-center gap-2">
          <Wallet className="h-4 w-4 text-emerald-500" />
          Pick an invoice — {vendor}
        </h3>
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading open invoices…</p>
        ) : invoices.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">No open invoices for {vendor}.</p>
        ) : (
          <div className="max-h-80 overflow-y-auto space-y-1">
            {invoices.map((inv: any) => (
              <button
                key={inv.id}
                type="button"
                className="w-full text-left p-2 rounded border hover:bg-muted/40 text-xs flex items-center justify-between"
                onClick={() => setPicked({ id: inv.id, number: inv.invoice_number, owed: inv.amountOwed })}
              >
                <span className="font-mono">{inv.invoice_number}</span>
                <span className="tabular-nums font-semibold">{formatCurrency(inv.amountOwed)} owed</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
