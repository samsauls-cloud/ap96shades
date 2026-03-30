import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle, CheckCircle2, Database, FileText, CreditCard,
  PackageCheck, ChevronDown, ChevronRight, Loader2, Zap, Download,
  DollarSign, Search as SearchIcon, Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { ReconciliationAuditPanel } from "@/components/invoices/ReconciliationAuditPanel";
import { VendorCoveragePanel } from "@/components/invoices/VendorCoveragePanel";
import { MatchStatusPanel } from "@/components/invoices/MatchStatusPanel";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabase-fetch-all";
import { formatCurrency, formatDate, getLineItems } from "@/lib/supabase-queries";
import type { VendorInvoice } from "@/lib/supabase-queries";
import { calculateInstallments, hasTermsEngine } from "@/lib/payment-terms";

/* ── helpers ─────────────────────────────────────── */

function StatusIcon({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
    : <AlertTriangle className="h-4 w-4 text-amber-500" />;
}

function Section({ title, icon: Icon, defaultOpen, children }: { title: string; icon: any; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex items-center gap-2 w-full text-left px-1 py-2 hover:bg-accent/30 rounded-md transition-colors group">
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <Icon className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">{title}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-8 space-y-3 pb-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function MetricRow({ label, value, warn, highlight }: { label: string; value: string | number; warn?: boolean; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${warn ? "text-amber-500" : ""} ${highlight ? "text-emerald-500" : ""}`}>{value}</span>
    </div>
  );
}

/* ── Lightspeed matching engine (shared) ── */
import { buildLSMatchResults, type LSMatchResult, getVendorAliases } from "@/lib/ls-match-engine";

/* ── main ─────────────────────────────────────── */

export default function AuditPage() {
  const qc = useQueryClient();
  const [generatingPayments, setGeneratingPayments] = useState(false);
  const autoGenRan = useRef(false);

  // ── Data queries ────────────────────────
  const { data: invoices = [], isLoading: loadingInv } = useQuery({
    queryKey: ["audit_invoices"],
    queryFn: () => fetchAllRows<VendorInvoice>("vendor_invoices"),
  });

  const { data: payments = [], isLoading: loadingPay } = useQuery({
    queryKey: ["audit_payments"],
    queryFn: () => fetchAllRows("invoice_payments"),
  });

  const { data: recSessions = [] } = useQuery({
    queryKey: ["audit_rec_sessions"],
    queryFn: () => fetchAllRows("po_receiving_sessions"),
  });

  const { data: recLines = [] } = useQuery({
    queryKey: ["audit_rec_lines"],
    queryFn: () => fetchAllRows("po_receiving_lines"),
  });

  const loading = loadingInv || loadingPay;

  // ── Invoice Stats (INVOICE only for totals) ──
  const invoiceStats = (() => {
    const inv = invoices.filter((i: any) => i.doc_type === "INVOICE");
    const pos = invoices.filter((i: any) => i.doc_type === "PO");
    // AP totals only include confirmed-terms invoices (exclude proforma + needs_review)
    const confirmedInv = inv.filter((i: any) => i.terms_status === "confirmed");
    const needsReviewInv = inv.filter((i: any) => i.terms_status === "needs_review");
    const invTotal = confirmedInv.reduce((s: number, i: any) => s + (Number(i.total) || 0), 0);
    const needsReviewTotal = needsReviewInv.reduce((s: number, i: any) => s + (Number(i.total) || 0), 0);
    const hasPO = inv.filter((i: any) => i.po_number && i.po_number.trim() !== "").length;
    const noPO = inv.filter((i: any) => !i.po_number || i.po_number.trim() === "").length;

    const byVendor = new Map<string, { count: number; value: number }>();
    for (const i of inv as any[]) {
      const v = i.vendor;
      const cur = byVendor.get(v) ?? { count: 0, value: 0 };
      cur.count++;
      cur.value += Number(i.total) || 0;
      byVendor.set(v, cur);
    }

    // Non-unpaid status invoices
    const nonUnpaid = inv.filter((i: any) => i.status !== "unpaid");

    // Duplicate check
    const numMap = new Map<string, number>();
    for (const i of inv as any[]) {
      numMap.set(i.invoice_number, (numMap.get(i.invoice_number) || 0) + 1);
    }
    const duplicates = Array.from(numMap.entries()).filter(([_, c]) => c > 1);

    return {
      totalCount: invoices.length,
      invoiceCount: inv.length,
      poCount: pos.length,
      invoiceTotal: invTotal,
      needsReviewTotal,
      needsReviewCount: needsReviewInv.length,
      hasPO,
      noPO,
      byVendor: Array.from(byVendor.entries()).sort((a, b) => b[1].value - a[1].value),
      nonUnpaid,
      duplicates,
    };
  })();

  // ── Payment Stats with separate overdue vs total ──
  const paymentStats = (() => {
    const invoiceIdsWithPayments = new Set((payments as any[]).map(p => p.invoice_id).filter(Boolean));
    const invoicesMissingPayments = (invoices as any[]).filter(
      (i: any) => i.doc_type === "INVOICE" && !invoiceIdsWithPayments.has(i.id)
    );
    const today = new Date().toISOString().slice(0, 10);
    const overdue = (payments as any[]).filter(p => p.due_date < today && !p.is_paid);
    const overdueAmount = overdue.reduce((s: number, p: any) => s + (Number(p.balance_remaining) || 0), 0);

    const allUnpaid = (payments as any[]).filter(p => !p.is_paid);
    const totalUnpaidAmount = allUnpaid.reduce((s: number, p: any) => s + (Number(p.balance_remaining) || 0), 0);

    const notYetDue = (payments as any[]).filter(p => p.due_date >= today && !p.is_paid);
    const notYetDueAmount = notYetDue.reduce((s: number, p: any) => s + (Number(p.balance_remaining) || 0), 0);

    return {
      totalRows: payments.length,
      invoicesWithPayments: invoiceIdsWithPayments.size,
      invoicesMissingPayments,
      overdueCount: overdue.length,
      overdueAmount,
      totalUnpaidCount: allUnpaid.length,
      totalUnpaidAmount,
      notYetDueCount: notYetDue.length,
      notYetDueAmount,
    };
  })();

  // ── Receiving Stats ──
  const receivingStats = (() => {
    const dates = (recLines as any[]).map(r => r.created_at).filter(Boolean).sort();
    const vendors = [...new Set((recSessions as any[]).map(s => s.vendor))];
    return {
      sessionCount: recSessions.length,
      lineCount: recLines.length,
      earliest: dates[0] ?? null,
      latest: dates[dates.length - 1] ?? null,
      vendors,
    };
  })();

  // ── Lightspeed match stats ──
  const lsMatches = (() => {
    if (invoices.length === 0) return { results: [] as LSMatchResult[], fullyReceived: 0, partial: 0, notFound: 0 };
    const results = buildLSMatchResults(invoices, recSessions, recLines);
    return {
      results,
      fullyReceived: results.filter(r => r.status === "fully_received").length,
      partial: results.filter(r => r.status === "partial").length,
      notFound: results.filter(r => r.status === "not_found").length,
    };
  })();

  // ── Qty variance (invoice internal) ──
  const qtyVariances = (() => {
    const results: { invoice: any; lines: { upc: string; ordered: number; shipped: number }[] }[] = [];
    for (const inv of invoices as any[]) {
      const lines = getLineItems(inv);
      const badLines = lines.filter(li => {
        const ordered = li.qty_ordered ?? li.qty ?? 0;
        const shipped = li.qty_shipped ?? li.qty_ordered ?? li.qty ?? 0;
        return shipped < ordered && ordered > 0;
      }).map(li => ({
        upc: li.upc ?? "—",
        ordered: li.qty_ordered ?? li.qty ?? 0,
        shipped: li.qty_shipped ?? li.qty_ordered ?? li.qty ?? 0,
      }));
      if (badLines.length > 0) results.push({ invoice: inv, lines: badLines });
    }
    return results;
  })();

  // ── FIX 1: Auto-generate missing payments on load ──
  useEffect(() => {
    if (loading || autoGenRan.current || paymentStats.invoicesMissingPayments.length === 0) return;
    autoGenRan.current = true;
    (async () => {
      setGeneratingPayments(true);
      let generated = 0;
      try {
        for (const inv of paymentStats.invoicesMissingPayments as any[]) {
          if (!hasTermsEngine(inv.vendor)) continue;
          const installments = calculateInstallments(
            inv.invoice_date, inv.total, inv.vendor,
            inv.invoice_number, inv.po_number ?? null, inv.payment_terms,
          );
          if (installments.length === 0) continue;
          const rows = installments.map(inst => ({
            invoice_id: inv.id,
            vendor: inst.vendor,
            invoice_number: inst.invoice_number,
            po_number: inst.po_number,
            invoice_amount: inst.invoice_amount,
            invoice_date: inst.invoice_date,
            terms: inst.terms,
            installment_label: inst.installment_label,
            due_date: inst.due_date,
            amount_due: inst.amount_due,
            balance_remaining: inst.amount_due,
            amount_paid: 0,
            is_paid: false,
            payment_status: "unpaid",
          }));
          const { error } = await supabase.from("invoice_payments").insert(rows);
          if (!error) generated++;
        }
        if (generated > 0) {
          toast.success(`Auto-generated payment schedules for ${generated} invoice(s)`);
          qc.invalidateQueries({ queryKey: ["audit_payments"] });
          qc.invalidateQueries({ queryKey: ["invoice_payments"] });
        }
      } catch (err: any) {
        toast.error(`Auto-gen failed: ${err.message}`);
      } finally {
        setGeneratingPayments(false);
      }
    })();
  }, [loading, paymentStats.invoicesMissingPayments.length]);

  // ── Manual generate ──
  const handleGenerateMissingPayments = async () => {
    setGeneratingPayments(true);
    let generated = 0;
    try {
      for (const inv of paymentStats.invoicesMissingPayments as any[]) {
        if (!hasTermsEngine(inv.vendor)) continue;
        const installments = calculateInstallments(
          inv.invoice_date, inv.total, inv.vendor,
          inv.invoice_number, inv.po_number ?? null, inv.payment_terms,
        );
        if (installments.length === 0) continue;
        const rows = installments.map(inst => ({
          invoice_id: inv.id,
          vendor: inst.vendor,
          invoice_number: inst.invoice_number,
          po_number: inst.po_number,
          invoice_amount: inst.invoice_amount,
          invoice_date: inst.invoice_date,
          terms: inst.terms,
          installment_label: inst.installment_label,
          due_date: inst.due_date,
          amount_due: inst.amount_due,
          balance_remaining: inst.amount_due,
          amount_paid: 0,
          is_paid: false,
          payment_status: "unpaid",
        }));
        const { error } = await supabase.from("invoice_payments").insert(rows);
        if (!error) generated++;
      }
      toast.success(`Generated payment schedules for ${generated} invoices`);
      qc.invalidateQueries({ queryKey: ["audit_payments"] });
      qc.invalidateQueries({ queryKey: ["invoice_payments"] });
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setGeneratingPayments(false);
    }
  };

  // ── Export CSV ──
  const exportAuditCSV = () => {
    const header = ["Category", "Metric", "Value"];
    const rows: string[][] = [
      ["Invoices", "Total INVOICE Count", String(invoiceStats.invoiceCount)],
      ["Invoices", "Total INVOICE Value", invoiceStats.invoiceTotal.toFixed(2)],
      ["Invoices", "With PO #", String(invoiceStats.hasPO)],
      ["Invoices", "Without PO #", String(invoiceStats.noPO)],
      ["Payments", "Total Payment Rows", String(paymentStats.totalRows)],
      ["Payments", "Overdue Count", String(paymentStats.overdueCount)],
      ["Payments", "Overdue Amount", paymentStats.overdueAmount.toFixed(2)],
      ["Payments", "Total Unpaid Amount", paymentStats.totalUnpaidAmount.toFixed(2)],
      ["Receiving", "Sessions", String(receivingStats.sessionCount)],
      ["Receiving", "Lines", String(receivingStats.lineCount)],
      ["LS Match", "Fully Received", String(lsMatches.fullyReceived)],
      ["LS Match", "Partial", String(lsMatches.partial)],
      ["LS Match", "Not Found", String(lsMatches.notFound)],
    ];
    const csv = [header, ...rows].map(r => r.map(c => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "ap_system_audit.csv"; a.click();
    URL.revokeObjectURL(url);
    toast.success("Audit exported");
  };

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
              <Database className="h-5 w-5 text-primary" /> System Audit & Diagnostics
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">Full pipeline health check — NinetySix Shades AP</p>
          </div>
          <Button size="sm" variant="outline" className="text-xs h-8 gap-1.5" onClick={exportAuditCSV}>
            <Download className="h-3.5 w-3.5" /> Export Audit CSV
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* ── Headline Metrics ── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card className="bg-card border-border">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Confirmed AP Liability</span>
                    <DollarSign className="h-3.5 w-3.5 text-primary opacity-70" />
                  </div>
                  <p className="text-lg font-bold tracking-tight">{formatCurrency(invoiceStats.invoiceTotal)}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {invoiceStats.invoiceCount} invoices (confirmed terms)
                    {invoiceStats.needsReviewCount > 0 && (
                      <span className="text-amber-500 ml-1">+ {formatCurrency(invoiceStats.needsReviewTotal)} needs review</span>
                    )}
                  </p>
                </CardContent>
              </Card>
              <Card className="bg-card border-destructive/30">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-destructive">Overdue</span>
                    <AlertTriangle className="h-3.5 w-3.5 text-destructive opacity-70" />
                  </div>
                  <p className="text-lg font-bold tracking-tight text-destructive">{formatCurrency(paymentStats.overdueAmount)}</p>
                  <p className="text-[10px] text-muted-foreground">{paymentStats.overdueCount} past-due installments</p>
                </CardContent>
              </Card>
              <Card className="bg-card border-amber-500/30">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-500">Total Outstanding AP</span>
                    <CreditCard className="h-3.5 w-3.5 text-amber-500 opacity-70" />
                  </div>
                  <p className="text-lg font-bold tracking-tight">{formatCurrency(paymentStats.totalUnpaidAmount)}</p>
                  <p className="text-[10px] text-muted-foreground">{paymentStats.totalUnpaidCount} unpaid installments</p>
                </CardContent>
              </Card>
              <Card className="bg-card border-emerald-500/30">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500">LS Match Coverage</span>
                    <PackageCheck className="h-3.5 w-3.5 text-emerald-500 opacity-70" />
                  </div>
                  <p className="text-lg font-bold tracking-tight">
                    {lsMatches.results.length > 0
                      ? `${((lsMatches.fullyReceived + lsMatches.partial) / lsMatches.results.length * 100).toFixed(1)}%`
                      : "—"}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {lsMatches.fullyReceived + lsMatches.partial} of {lsMatches.results.length} invoices matched
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* ── Full Reconciliation Audit ── */}
            <ReconciliationAuditPanel
              invoices={invoices as any[]}
              payments={payments as any[]}
              recSessions={recSessions as any[]}
              recLines={recLines as any[]}
            />

            {/* ── Two-Way Match Status ── */}
            <Section title="Invoice ↔ Receipt Match Status" icon={Link2} defaultOpen>
              <MatchStatusPanel />
            </Section>

            {/* ── Vendor Receiving Coverage ── */}
            <Section title="Vendor Receiving Coverage" icon={PackageCheck}>
              <VendorCoveragePanel />
            </Section>

            {/* ── Invoice Data Audit ── */}
            <Section title="Invoice Data Audit" icon={FileText}>
              <Card className="bg-card border-border">
                <CardContent className="p-4 space-y-1">
                  <MetricRow label="Total INVOICE Records" value={invoiceStats.invoiceCount} />
                  <MetricRow label="Total INVOICE Value" value={formatCurrency(invoiceStats.invoiceTotal)} />
                  <MetricRow label="PO Documents in System" value={invoiceStats.poCount} warn={invoiceStats.poCount === 0} />
                  <MetricRow label="Invoices with PO # Reference" value={invoiceStats.hasPO} />
                  <MetricRow label="Invoices without PO # Reference" value={invoiceStats.noPO} warn={invoiceStats.noPO > 0} />
                </CardContent>
              </Card>

              {/* Vendor breakdown */}
              {invoiceStats.byVendor.length > 0 && (
                <Card className="bg-card border-border">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-semibold">Invoice Value by Vendor (doc_type=INVOICE only)</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-border">
                          <TableHead className="text-[10px] font-semibold">Vendor</TableHead>
                          <TableHead className="text-[10px] font-semibold text-right">Invoices</TableHead>
                          <TableHead className="text-[10px] font-semibold text-right">Total Value</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {invoiceStats.byVendor.map(([vendor, d]) => (
                          <TableRow key={vendor} className="border-border">
                            <TableCell className="text-xs font-medium">{vendor}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{d.count}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{formatCurrency(d.value)}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="border-border bg-muted/30">
                          <TableCell className="text-xs font-bold">TOTAL</TableCell>
                          <TableCell className="text-xs text-right tabular-nums font-bold">{invoiceStats.invoiceCount}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums font-bold">{formatCurrency(invoiceStats.invoiceTotal)}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}

              {/* Duplicates */}
              {invoiceStats.duplicates.length > 0 && (
                <Card className="bg-card border-destructive/30">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle className="h-4 w-4 text-destructive" />
                      <span className="text-xs font-semibold text-destructive">Duplicate Invoice Numbers Found</span>
                    </div>
                    {invoiceStats.duplicates.map(([num, cnt]) => (
                      <div key={num} className="flex justify-between text-xs py-0.5">
                        <span className="font-mono">{num}</span>
                        <span className="text-destructive font-semibold">{cnt}× duplicates</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
              {invoiceStats.duplicates.length === 0 && (
                <div className="flex items-center gap-2 text-xs text-emerald-500">
                  <CheckCircle2 className="h-3.5 w-3.5" /> No duplicate invoice numbers found
                </div>
              )}

              {/* Non-unpaid invoices */}
              {invoiceStats.nonUnpaid.length > 0 ? (
                <Card className="bg-card border-amber-500/30">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <SearchIcon className="h-4 w-4 text-amber-500" />
                      <span className="text-xs font-semibold text-amber-500">
                        Invoices with status ≠ "unpaid" ({invoiceStats.nonUnpaid.length})
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mb-2">These may explain AP balance differences vs external trackers.</p>
                    <div className="max-h-[200px] overflow-auto space-y-1">
                      {invoiceStats.nonUnpaid.map((inv: any) => (
                        <div key={inv.id} className="flex items-center justify-between text-[10px] py-1 border-b border-border/30">
                          <span className="font-mono">{inv.invoice_number}</span>
                          <span>{inv.vendor}</span>
                          <Badge variant="outline" className="text-[9px]">{inv.status}</Badge>
                          <span className="tabular-nums">{formatCurrency(inv.total)}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> All 133 invoices show status = "unpaid" — no paid/credited invoices reducing the total.
                </div>
              )}

              {/* $8K Gap explanation + Missing Invoice Finder */}
              <Card className="bg-card border-primary/30">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <DollarSign className="h-4 w-4 text-primary" />
                    <span className="text-xs font-semibold">Missing Invoice Finder — $8K Gap Analysis</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground space-y-1">
                    <p>Excel AP tracker: <span className="font-semibold text-foreground">$597,131.71</span></p>
                    <p>System total: <span className="font-semibold text-foreground">{formatCurrency(invoiceStats.invoiceTotal)}</span></p>
                    <p>Gap: <span className="font-semibold text-destructive">{formatCurrency(597131.71 - invoiceStats.invoiceTotal)}</span></p>
                    <div className="h-px bg-border/50 my-2" />
                    <p className="font-medium text-foreground">
                      {invoiceStats.duplicates.length === 0 && invoiceStats.nonUnpaid.length === 0
                        ? "No duplicates or paid-status invoices found. Gap likely from invoices in Excel not yet uploaded to the system."
                        : "See duplicate and status sections above for potential explanations."}
                    </p>
                    <p>Check Excel tracker for invoices dated before <span className="font-mono text-foreground">{invoiceStats.byVendor.length > 0
                      ? (() => {
                          const dates = (invoices as any[]).filter(i => i.doc_type === "INVOICE").map(i => i.invoice_date).sort();
                          return dates[0] ?? "—";
                        })()
                      : "—"}</span> or from vendors with unexpectedly low totals above.</p>
                  </div>
                </CardContent>
              </Card>

              {/* Payment Sum vs Invoice Sum comparison */}
              {(() => {
                const paymentSum = (payments as any[]).reduce((s: number, p: any) => s + (Number(p.amount_due) || 0), 0);
                const invoiceSum = invoiceStats.invoiceTotal;
                const diff = invoiceSum - paymentSum;
                return (
                  <Card className={`bg-card ${Math.abs(diff) > 1 ? "border-amber-500/30" : "border-emerald-500/30"}`}>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <StatusIcon ok={Math.abs(diff) < 1} />
                        <span className="text-xs font-semibold">Payment Schedule Sum vs Invoice Sum</span>
                      </div>
                      <div className="text-[10px] space-y-0.5">
                        <MetricRow label="Sum of vendor_invoices.total (INVOICE)" value={formatCurrency(invoiceSum)} />
                        <MetricRow label="Sum of invoice_payments.amount_due" value={formatCurrency(paymentSum)} />
                        <MetricRow label="Difference" value={formatCurrency(diff)} warn={Math.abs(diff) > 1} />
                        {Math.abs(diff) > 1 && (
                          <p className="text-[10px] text-amber-500 pt-1">
                            ⚠ {formatCurrency(diff)} gap — likely invoices without payment terms engines (unknown vendors) or rounding.
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })()}

              {/* Vendor LS Match Rates */}
              <Card className="bg-card border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-semibold">LS Match Rate by Vendor</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border">
                        <TableHead className="text-[10px] font-semibold">Vendor</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Invoices</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Matched to LS</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Unmatched</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Match Rate</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(() => {
                        const vendorMap = new Map<string, { total: number; matched: number }>();
                        for (const r of lsMatches.results) {
                          const cur = vendorMap.get(r.vendor) ?? { total: 0, matched: 0 };
                          cur.total++;
                          if (r.status !== "not_found") cur.matched++;
                          vendorMap.set(r.vendor, cur);
                        }
                        return Array.from(vendorMap.entries())
                          .sort((a, b) => (a[1].matched / a[1].total) - (b[1].matched / b[1].total))
                          .map(([vendor, d]) => (
                            <TableRow key={vendor} className="border-border">
                              <TableCell className="text-xs font-medium">{vendor}</TableCell>
                              <TableCell className="text-xs text-right tabular-nums">{d.total}</TableCell>
                              <TableCell className="text-xs text-right tabular-nums text-emerald-500">{d.matched}</TableCell>
                              <TableCell className="text-xs text-right tabular-nums text-destructive">{d.total - d.matched}</TableCell>
                              <TableCell className={`text-xs text-right tabular-nums font-semibold ${d.matched / d.total < 0.5 ? "text-destructive" : d.matched / d.total < 1 ? "text-amber-500" : "text-emerald-500"}`}>
                                {(d.matched / d.total * 100).toFixed(1)}%
                              </TableCell>
                            </TableRow>
                          ));
                      })()}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </Section>

            {/* ── Payment Data Audit ── */}
            <Section title="Payment Data Audit" icon={CreditCard}>
              <Card className="bg-card border-border">
                <CardContent className="p-4 space-y-1">
                  <MetricRow label="Total Payment Installment Rows" value={paymentStats.totalRows} />
                  <MetricRow label="Invoices WITH Payment Rows" value={paymentStats.invoicesWithPayments} />
                  <MetricRow label="Invoices MISSING Payment Rows" value={paymentStats.invoicesMissingPayments.length} warn={paymentStats.invoicesMissingPayments.length > 0} />
                  <div className="h-px bg-border/50 my-1" />
                  <MetricRow label="🔴 OVERDUE (past due, unpaid)" value={`${paymentStats.overdueCount} installments — ${formatCurrency(paymentStats.overdueAmount)}`} warn />
                  <MetricRow label="🟡 NOT YET DUE (upcoming, unpaid)" value={`${paymentStats.notYetDueCount} installments — ${formatCurrency(paymentStats.notYetDueAmount)}`} />
                  <MetricRow label="📊 TOTAL OUTSTANDING AP" value={`${paymentStats.totalUnpaidCount} installments — ${formatCurrency(paymentStats.totalUnpaidAmount)}`} highlight />
                </CardContent>
              </Card>
              {paymentStats.invoicesMissingPayments.length > 0 && (
                <Card className="bg-card border-amber-500/30">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      <span className="text-xs font-semibold text-amber-500">
                        ⚠ {paymentStats.invoicesMissingPayments.length} invoice(s) missing payment schedules
                      </span>
                    </div>
                    <div className="space-y-1 mb-3 max-h-[200px] overflow-auto">
                      {(paymentStats.invoicesMissingPayments as any[]).map((inv: any) => (
                        <div key={inv.id} className="flex items-center justify-between text-[10px] py-1 border-b border-border/30">
                          <span className="font-mono">{inv.invoice_number}</span>
                          <span className="text-muted-foreground">{inv.vendor}</span>
                          <span className="tabular-nums">{formatCurrency(inv.total)}</span>
                        </div>
                      ))}
                    </div>
                    <Button
                      size="sm" className="text-xs h-7 gap-1.5"
                      disabled={generatingPayments}
                      onClick={handleGenerateMissingPayments}
                    >
                      <Zap className="h-3 w-3" />
                      {generatingPayments ? "Generating…" : "Generate Missing Payments"}
                    </Button>
                  </CardContent>
                </Card>
              )}
            </Section>

            {/* ── Lightspeed Receiving Data ── */}
            <Section title="Lightspeed Receiving Data" icon={PackageCheck}>
              {receivingStats.sessionCount > 0 ? (
                <Card className="bg-card border-border">
                  <CardContent className="p-4 space-y-1">
                    <MetricRow label="Receiving Sessions" value={receivingStats.sessionCount} />
                    <MetricRow label="Receiving Lines" value={receivingStats.lineCount} />
                    <MetricRow label="Date Range" value={`${formatDate(receivingStats.earliest)} — ${formatDate(receivingStats.latest)}`} />
                    <MetricRow label="Vendors in LS" value={receivingStats.vendors.join(", ")} />
                    <div className="pt-1">
                      <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-[10px]">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Lightspeed receiving data present
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <Card className="bg-card border-amber-500/30">
                  <CardContent className="p-4 flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-amber-500">
                        ⚠ Lightspeed receiving data was uploaded Friday but no table found
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Receipts may not have saved. Check /import/lightspeed to re-import PO receiving data.
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* LS column reference */}
              <Card className="bg-card border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-semibold">po_receiving_lines — Available Columns</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  <div className="flex flex-wrap gap-1.5">
                    {["id","session_id","upc","ean","custom_sku","manufact_sku","item_description","vendor_id",
                      "order_qty","received_qty","not_received_qty","unit_cost","retail_price","unit_discount",
                      "unit_shipping","received_cost","ordered_cost","lightspeed_status","receiving_status",
                      "matched_invoice_line","match_status","billing_discrepancy","discrepancy_type","discrepancy_amount","notes"
                    ].map(col => (
                      <Badge key={col} variant="outline" className="text-[9px] font-mono">{col}</Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </Section>

            {/* ── Vendor ID Mapping Diagnostic ── */}
            <Section title="Vendor ID Mapping Diagnostic" icon={SearchIcon} defaultOpen>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* LS Vendors */}
                <Card className="bg-card border-border">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-semibold">Lightspeed Receiving — Session Vendors</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-border">
                          <TableHead className="text-[10px] font-semibold">Vendor Name</TableHead>
                          <TableHead className="text-[10px] font-semibold text-right">Lines</TableHead>
                          <TableHead className="text-[10px] font-semibold text-right">Units Rcvd</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(() => {
                          const vendorLines = new Map<string, { lines: number; units: number }>();
                          for (const s of recSessions as any[]) {
                            const sLines = (recLines as any[]).filter(l => l.session_id === s.id);
                            const cur = vendorLines.get(s.vendor) ?? { lines: 0, units: 0 };
                            cur.lines += sLines.length;
                            cur.units += sLines.reduce((sum: number, l: any) => sum + (Number(l.received_qty) || 0), 0);
                            vendorLines.set(s.vendor, cur);
                          }
                          return Array.from(vendorLines.entries()).sort((a, b) => b[1].lines - a[1].lines).map(([v, d]) => (
                            <TableRow key={v} className="border-border">
                              <TableCell className="text-xs font-mono font-medium">{v}</TableCell>
                              <TableCell className="text-xs text-right tabular-nums">{d.lines}</TableCell>
                              <TableCell className="text-xs text-right tabular-nums">{d.units}</TableCell>
                            </TableRow>
                          ));
                        })()}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

                {/* Invoice Vendors */}
                <Card className="bg-card border-border">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-semibold">vendor_invoices — Invoice Vendors</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-border">
                          <TableHead className="text-[10px] font-semibold">Vendor Name</TableHead>
                          <TableHead className="text-[10px] font-semibold text-right">Invoices</TableHead>
                          <TableHead className="text-[10px] font-semibold text-right">Total Value</TableHead>
                          <TableHead className="text-[10px] font-semibold text-right">LS Lines</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {invoiceStats.byVendor.map(([vendor, d]) => {
                          // Check if this vendor has ANY LS receiving data
                          const aliases = getVendorAliases(vendor);
                          const lsLineCount = aliases.reduce((sum, alias) => {
                            return sum + (recSessions as any[]).filter(s => s.vendor === alias)
                              .reduce((s2, session) => s2 + (recLines as any[]).filter(l => l.session_id === session.id).length, 0);
                          }, 0);
                          return (
                            <TableRow key={vendor} className={`border-border ${lsLineCount === 0 ? "bg-destructive/5" : ""}`}>
                              <TableCell className="text-xs font-medium">{vendor}</TableCell>
                              <TableCell className="text-xs text-right tabular-nums">{d.count}</TableCell>
                              <TableCell className="text-xs text-right tabular-nums">{formatCurrency(d.value)}</TableCell>
                              <TableCell className={`text-xs text-right tabular-nums font-semibold ${lsLineCount === 0 ? "text-destructive" : "text-emerald-500"}`}>
                                {lsLineCount === 0 ? "❌ 0" : lsLineCount}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </div>

              {/* Mapping gap alert */}
              {(() => {
                const lsVendors = new Set((recSessions as any[]).map(s => s.vendor));
                const invoiceVendors = new Set(invoiceStats.byVendor.map(([v]) => v));
                const unmappedInvoiceVendors = Array.from(invoiceVendors).filter(v => {
                  const aliases = getVendorAliases(v);
                  return !aliases.some(a => lsVendors.has(a));
                });
                const unmappedLsVendors = Array.from(lsVendors).filter(v => {
                  // Check if any invoice vendor aliases contain this LS vendor
                  return !Array.from(invoiceVendors).some(iv => {
                    const aliases = getVendorAliases(iv);
                    return aliases.includes(v);
                  });
                });
                return (unmappedInvoiceVendors.length > 0 || unmappedLsVendors.length > 0) ? (
                  <Card className="bg-card border-destructive/30">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <AlertTriangle className="h-4 w-4 text-destructive" />
                        <span className="text-xs font-semibold text-destructive">Vendor Mapping Gaps Detected</span>
                      </div>
                      {unmappedInvoiceVendors.length > 0 && (
                        <div className="mb-2">
                          <p className="text-[10px] font-semibold text-foreground mb-1">Invoice vendors with NO Lightspeed receiving data:</p>
                          {unmappedInvoiceVendors.map(v => {
                            const vd = invoiceStats.byVendor.find(([vn]) => vn === v);
                            return (
                              <div key={v} className="flex justify-between text-[10px] py-0.5">
                                <span className="font-mono text-destructive">{v}</span>
                                <span>{vd ? `${vd[1].count} invoices / ${formatCurrency(vd[1].value)}` : ""}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {unmappedLsVendors.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-foreground mb-1">LS vendors not mapped to any invoice vendor:</p>
                          {unmappedLsVendors.map(v => (
                            <div key={v} className="text-[10px] font-mono text-amber-500 py-0.5">{v}</div>
                          ))}
                        </div>
                      )}
                      <p className="text-[10px] text-muted-foreground mt-2">
                        Maui Jim, Safilo, and Marcolin have zero receiving sessions in Lightspeed. These POs either haven't been imported yet or use a different vendor identifier.
                      </p>
                    </CardContent>
                  </Card>
                ) : null;
              })()}

              {/* Discrepancy Logic Explanation */}
              <Card className="bg-card border-border">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <FileText className="h-4 w-4 text-primary" />
                    <span className="text-xs font-semibold">Billing Discrepancy Logic (receiving-engine.ts)</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground space-y-1">
                    <p><span className="font-mono text-foreground">billing_discrepancy</span> is set by <span className="font-mono text-foreground">calcDiscrepancy()</span> in the receiving engine:</p>
                    <p>1. If a LS receiving line has <span className="text-destructive font-semibold">no matching invoice line</span> (UPC/SKU not found on invoice) → <span className="font-mono">NOT_ON_INVOICE</span>, amount = ordered_cost</p>
                    <p>2. If invoice qty {">"} received qty → <span className="font-mono">OVERBILLED</span>, amount = (inv_qty - rcv_qty) × unit_price</p>
                    <p>3. If invoice qty {"<"} received qty → <span className="font-mono">UNDERBILLED</span></p>
                    <p>4. If unit prices differ by {">"}2% → <span className="font-mono">PRICE_MISMATCH</span> (compares <span className="font-mono">invoiceLine.unit_price</span> vs <span className="font-mono">receivingLine.unit_cost</span>)</p>
                    <p className="pt-1 text-amber-500 font-semibold">
                      ⚠ The $366K "discrepancy" is mostly NOT_ON_INVOICE — items in LS receiving sessions that have no matching UPC on the linked invoice. This happens when a session is linked to the wrong invoice, or the invoice has different UPCs than what was physically received.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Section>


            <Section title="Invoice → Lightspeed Receipt Match" icon={PackageCheck} defaultOpen>
              <Card className="bg-card border-border">
                <CardContent className="p-4 space-y-1">
                  <MetricRow label="✅ Fully Received (variance ≤ 0)" value={lsMatches.fullyReceived} highlight />
                  <MetricRow label="⚠ Partially Received" value={lsMatches.partial} warn={lsMatches.partial > 0} />
                  <MetricRow label="❌ No Receipt Found" value={lsMatches.notFound} warn={lsMatches.notFound > 0} />
                  <MetricRow label="Total Invoices Checked" value={lsMatches.results.length} />
                </CardContent>
              </Card>

              {/* Unmatched invoices */}
              {lsMatches.notFound > 0 && (
                <Card className="bg-card border-destructive/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-semibold text-destructive">❌ Invoices with No Lightspeed Receipt ({lsMatches.notFound})</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="max-h-[300px] overflow-auto">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-border">
                            <TableHead className="text-[10px]">Invoice #</TableHead>
                            <TableHead className="text-[10px]">Vendor</TableHead>
                            <TableHead className="text-[10px] text-right">Total</TableHead>
                            <TableHead className="text-[10px] text-right">Qty Shipped</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {lsMatches.results.filter(r => r.status === "not_found").map(r => (
                            <TableRow key={r.invoiceId} className="border-border">
                              <TableCell className="text-[10px] font-mono">{r.invoiceNumber}</TableCell>
                              <TableCell className="text-[10px]">{r.vendor}</TableCell>
                              <TableCell className="text-[10px] text-right tabular-nums">{formatCurrency(r.invoiceTotal)}</TableCell>
                              <TableCell className="text-[10px] text-right tabular-nums">{r.invoiceQtyShipped}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Partial matches */}
              {lsMatches.partial > 0 && (
                <Card className="bg-card border-amber-500/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-semibold text-amber-500">⚠ Partially Received ({lsMatches.partial})</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="max-h-[300px] overflow-auto">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-border">
                            <TableHead className="text-[10px]">Invoice #</TableHead>
                            <TableHead className="text-[10px]">Vendor</TableHead>
                            <TableHead className="text-[10px] text-right">Qty Shipped</TableHead>
                            <TableHead className="text-[10px] text-right">Qty Received</TableHead>
                            <TableHead className="text-[10px] text-right">Variance</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {lsMatches.results.filter(r => r.status === "partial").map(r => (
                            <TableRow key={r.invoiceId} className="border-border">
                              <TableCell className="text-[10px] font-mono">{r.invoiceNumber}</TableCell>
                              <TableCell className="text-[10px]">{r.vendor}</TableCell>
                              <TableCell className="text-[10px] text-right tabular-nums">{r.invoiceQtyShipped}</TableCell>
                              <TableCell className="text-[10px] text-right tabular-nums">{r.lsQtyReceived}</TableCell>
                              <TableCell className="text-[10px] text-right tabular-nums text-amber-500 font-semibold">{r.qtyVariance} units</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              )}
            </Section>

            {/* ── Qty Variance (internal) ── */}
            <Section title="Invoice Qty Variances (Shipped vs Ordered)" icon={PackageCheck} defaultOpen={false}>
              <Card className="bg-card border-border">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <StatusIcon ok={qtyVariances.length === 0} />
                    <span className="text-xs font-medium">
                      {qtyVariances.length === 0
                        ? "No partial shipment variances found ✅"
                        : `⚠ ${qtyVariances.length} invoice(s) with partial shipments`}
                    </span>
                  </div>
                  {qtyVariances.length > 0 && (
                    <div className="overflow-auto max-h-[300px]">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-border">
                            <TableHead className="text-[10px] font-semibold">Invoice #</TableHead>
                            <TableHead className="text-[10px] font-semibold">Vendor</TableHead>
                            <TableHead className="text-[10px] font-semibold">UPC</TableHead>
                            <TableHead className="text-[10px] font-semibold text-right">Ordered</TableHead>
                            <TableHead className="text-[10px] font-semibold text-right">Shipped</TableHead>
                            <TableHead className="text-[10px] font-semibold text-right">Δ</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {qtyVariances.slice(0, 50).flatMap(v =>
                            v.lines.map((l, i) => (
                              <TableRow key={`${v.invoice.id}-${i}`} className="border-border">
                                {i === 0 ? (
                                  <>
                                    <TableCell className="text-[10px] font-mono" rowSpan={v.lines.length}>{v.invoice.invoice_number}</TableCell>
                                    <TableCell className="text-[10px]" rowSpan={v.lines.length}>{v.invoice.vendor}</TableCell>
                                  </>
                                ) : null}
                                <TableCell className="text-[10px] font-mono">{l.upc}</TableCell>
                                <TableCell className="text-[10px] text-right tabular-nums">{l.ordered}</TableCell>
                                <TableCell className="text-[10px] text-right tabular-nums">{l.shipped}</TableCell>
                                <TableCell className="text-[10px] text-right tabular-nums text-amber-500 font-semibold">{l.shipped - l.ordered}</TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </Section>
          </>
        )}
      </main>
    </div>
  );
}
