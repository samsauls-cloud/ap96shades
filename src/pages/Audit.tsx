import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle, CheckCircle2, Database, FileText, CreditCard,
  PackageCheck, ChevronDown, ChevronRight, Loader2, Zap, Download,
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

function MetricRow({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${warn ? "text-amber-500" : ""}`}>{value}</span>
    </div>
  );
}

/* ── main ─────────────────────────────────────── */

export default function AuditPage() {
  const qc = useQueryClient();
  const [generatingPayments, setGeneratingPayments] = useState(false);

  // ── STEP 1: Data Audit ────────────────────────
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

  // ── Invoice Stats ──
  const invoiceStats = (() => {
    const inv = invoices.filter((i: any) => i.doc_type === "INVOICE");
    const pos = invoices.filter((i: any) => i.doc_type === "PO");
    const total = invoices.reduce((s: number, i: any) => s + (Number(i.total) || 0), 0);
    const hasPO = invoices.filter((i: any) => i.po_number && i.po_number.trim() !== "").length;
    const noPO = invoices.filter((i: any) => !i.po_number || i.po_number.trim() === "").length;

    const byVendor = new Map<string, { count: number; value: number }>();
    for (const i of invoices as any[]) {
      const v = i.vendor;
      const cur = byVendor.get(v) ?? { count: 0, value: 0 };
      cur.count++;
      cur.value += Number(i.total) || 0;
      byVendor.set(v, cur);
    }

    return {
      totalCount: invoices.length,
      invoiceCount: inv.length,
      poCount: pos.length,
      totalValue: total,
      hasPO,
      noPO,
      byVendor: Array.from(byVendor.entries()).sort((a, b) => b[1].value - a[1].value),
    };
  })();

  // ── Payment Stats ──
  const paymentStats = (() => {
    const invoiceIdsWithPayments = new Set((payments as any[]).map(p => p.invoice_id).filter(Boolean));
    const invoicesMissingPayments = (invoices as any[]).filter(
      (i: any) => i.doc_type === "INVOICE" && !invoiceIdsWithPayments.has(i.id)
    );
    const today = new Date().toISOString().slice(0, 10);
    const overdue = (payments as any[]).filter(p => p.due_date < today && !p.is_paid);
    const unpaidBalance = (payments as any[])
      .filter(p => p.payment_status !== "paid" && p.payment_status !== "void")
      .reduce((s, p) => s + (Number(p.balance_remaining) || 0), 0);

    return {
      totalRows: payments.length,
      invoicesWithPayments: invoiceIdsWithPayments.size,
      invoicesMissingPayments,
      overdueCount: overdue.length,
      unpaidBalance,
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

  // ── STEP 2A: PO → Invoice match ──
  const poMatchStats = (() => {
    const invoicesWithPO = (invoices as any[]).filter(
      (i: any) => i.doc_type === "INVOICE" && i.po_number && i.po_number.trim() !== ""
    );
    const poNumbers = new Set(
      (invoices as any[]).filter((i: any) => i.doc_type === "PO").map((i: any) => i.po_number)
    );
    const matched = invoicesWithPO.filter((i: any) => poNumbers.has(i.po_number));
    const unmatched = invoicesWithPO.filter((i: any) => !poNumbers.has(i.po_number));

    return {
      total: invoicesWithPO.length,
      matched: matched.length,
      unmatched,
      hasPODocs: poNumbers.size,
    };
  })();

  // ── STEP 2C: Qty variance ──
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

  // ── Generate missing payments ──
  const handleGenerateMissingPayments = async () => {
    setGeneratingPayments(true);
    let generated = 0;
    try {
      for (const inv of paymentStats.invoicesMissingPayments as any[]) {
        if (!hasTermsEngine(inv.vendor)) continue;
        const installments = calculateInstallments(
          inv.invoice_date,
          inv.total,
          inv.vendor,
          inv.invoice_number,
          inv.po_number ?? null,
          inv.payment_terms,
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

  // ── Export full audit CSV ──
  const exportAuditCSV = () => {
    const header = ["Category", "Metric", "Value"];
    const rows: string[][] = [
      ["Invoices", "Total Count", String(invoiceStats.totalCount)],
      ["Invoices", "Total Value", invoiceStats.totalValue.toFixed(2)],
      ["Invoices", "INV Count", String(invoiceStats.invoiceCount)],
      ["Invoices", "PO Count", String(invoiceStats.poCount)],
      ["Invoices", "Has PO #", String(invoiceStats.hasPO)],
      ["Invoices", "No PO #", String(invoiceStats.noPO)],
      ["Payments", "Total Rows", String(paymentStats.totalRows)],
      ["Payments", "Invoices With Payments", String(paymentStats.invoicesWithPayments)],
      ["Payments", "Missing Payments", String(paymentStats.invoicesMissingPayments.length)],
      ["Payments", "Overdue", String(paymentStats.overdueCount)],
      ["Payments", "Unpaid Balance", paymentStats.unpaidBalance.toFixed(2)],
      ["Receiving", "Sessions", String(receivingStats.sessionCount)],
      ["Receiving", "Lines", String(receivingStats.lineCount)],
      ["Recon", "PO Match Rate", `${poMatchStats.matched}/${poMatchStats.total}`],
      ["Recon", "Qty Variance Invoices", String(qtyVariances.length)],
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
            {/* ── STEP 1: Data Audit ── */}
            <Section title="Step 1 — Invoice Data Audit" icon={FileText}>
              <Card className="bg-card border-border">
                <CardContent className="p-4 space-y-1">
                  <MetricRow label="Total Invoice Records" value={invoiceStats.totalCount} />
                  <MetricRow label="Total Value" value={formatCurrency(invoiceStats.totalValue)} />
                  <MetricRow label="Invoices (doc_type=INVOICE)" value={invoiceStats.invoiceCount} />
                  <MetricRow label="POs (doc_type=PO)" value={invoiceStats.poCount} warn={invoiceStats.poCount === 0} />
                  <MetricRow label="With PO # Reference" value={invoiceStats.hasPO} />
                  <MetricRow label="Without PO # Reference" value={invoiceStats.noPO} warn={invoiceStats.noPO > 0} />
                </CardContent>
              </Card>
              {invoiceStats.byVendor.length > 0 && (
                <Card className="bg-card border-border">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-semibold">By Vendor</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-border">
                          <TableHead className="text-[10px] font-semibold">Vendor</TableHead>
                          <TableHead className="text-[10px] font-semibold text-right">Count</TableHead>
                          <TableHead className="text-[10px] font-semibold text-right">Value</TableHead>
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
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
            </Section>

            <Section title="Step 1 — Payment Data Audit" icon={CreditCard}>
              <Card className="bg-card border-border">
                <CardContent className="p-4 space-y-1">
                  <MetricRow label="Total Payment Rows" value={paymentStats.totalRows} />
                  <MetricRow label="Invoices WITH Payment Rows" value={paymentStats.invoicesWithPayments} />
                  <MetricRow label="Invoices MISSING Payment Rows" value={paymentStats.invoicesMissingPayments.length} warn={paymentStats.invoicesMissingPayments.length > 0} />
                  <MetricRow label="Overdue Payments" value={paymentStats.overdueCount} warn={paymentStats.overdueCount > 0} />
                  <MetricRow label="Total Unpaid Balance" value={formatCurrency(paymentStats.unpaidBalance)} />
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
                      size="sm"
                      className="text-xs h-7 gap-1.5"
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

            <Section title="Step 1 — Lightspeed Receiving Data" icon={PackageCheck}>
              {receivingStats.sessionCount > 0 ? (
                <Card className="bg-card border-border">
                  <CardContent className="p-4 space-y-1">
                    <MetricRow label="Receiving Sessions" value={receivingStats.sessionCount} />
                    <MetricRow label="Receiving Lines" value={receivingStats.lineCount} />
                    <MetricRow label="Date Range" value={`${formatDate(receivingStats.earliest)} — ${formatDate(receivingStats.latest)}`} />
                    <MetricRow label="Vendors" value={receivingStats.vendors.join(", ")} />
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
            </Section>

            {/* ── STEP 2: Reconciliation Status ── */}
            <Section title="Step 2A — PO → Invoice Match" icon={FileText} defaultOpen>
              <Card className="bg-card border-border">
                <CardContent className="p-4 space-y-1">
                  <MetricRow label="Invoices with PO #" value={poMatchStats.total} />
                  <MetricRow label="PO Docs in System (doc_type=PO)" value={poMatchStats.hasPODocs} warn={poMatchStats.hasPODocs === 0} />
                  <MetricRow label="Matched to PO Doc" value={poMatchStats.matched} />
                  <MetricRow label="Unmatched (PO # exists but no PO doc)" value={poMatchStats.unmatched.length} warn={poMatchStats.unmatched.length > 0} />
                </CardContent>
              </Card>
              {poMatchStats.hasPODocs === 0 && (
                <Card className="bg-card border-amber-500/30">
                  <CardContent className="p-4 flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
                    <div>
                      <p className="text-xs font-semibold text-amber-500">
                        No PO documents (doc_type=&apos;PO&apos;) exist in the system.
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {poMatchStats.total} invoices reference PO numbers but there are no corresponding PO docs to match against.
                        This is expected if PO data comes from Lightspeed receiving sessions rather than uploaded PO documents.
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </Section>

            <Section title="Step 2B — Invoice → Payment Schedule" icon={CreditCard} defaultOpen>
              <Card className="bg-card border-border">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <StatusIcon ok={paymentStats.invoicesMissingPayments.length === 0} />
                    <span className="text-xs font-medium">
                      {paymentStats.invoicesMissingPayments.length === 0
                        ? "All invoices have payment schedules ✅"
                        : `${paymentStats.invoicesMissingPayments.length} invoice(s) missing payment schedules`}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </Section>

            <Section title="Step 2C — Quantity Variances (Shipped vs Ordered)" icon={PackageCheck} defaultOpen>
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
