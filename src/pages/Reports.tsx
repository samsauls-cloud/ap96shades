import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Download, FileBarChart, Clock, DollarSign, TrendingUp, PackageCheck, Users, AlertTriangle } from "lucide-react";
import { formatCurrency, formatDate, getLineItems } from "@/lib/supabase-queries";
import type { VendorInvoice } from "@/lib/supabase-queries";
import { fetchPayments, type InvoicePayment, isOverdue, getDaysOverdue } from "@/lib/payment-queries";
import { PaymentStatusBadge } from "@/components/invoices/PaymentStatusBadge";
import { fetchAllRows } from "@/lib/supabase-fetch-all";
import { Badge } from "@/components/ui/badge";
import { addDays, startOfWeek, format, subMonths, isWithinInterval } from "date-fns";

type ReportTab = "aging" | "history" | "outstanding" | "cashflow" | "fulfillment" | "vendorspend" | "backorder";

function exportCSV(rows: string[][], filename: string) {
  const csv = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const [tab, setTab] = useState<ReportTab>("aging");
  const [vendorFilter, setVendorFilter] = useState("all");
  const [methodFilter, setMethodFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ["invoice_payments"],
    queryFn: fetchPayments,
  });

  const { data: invoices = [], isLoading: loadingInv } = useQuery({
    queryKey: ["report_invoices"],
    queryFn: () => fetchAllRows<VendorInvoice>("vendor_invoices"),
  });

  const { data: recSessions = [] } = useQuery({
    queryKey: ["report_rec_sessions"],
    queryFn: () => fetchAllRows("po_receiving_sessions"),
  });

  const { data: recLines = [] } = useQuery({
    queryKey: ["report_rec_lines"],
    queryFn: () => fetchAllRows("po_receiving_lines"),
  });

  const activePayments = payments.filter(p => p.payment_status !== "void");
  const vendors = [...new Set(payments.map(p => p.vendor))].sort();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tabs = [
    { key: "aging" as const, label: "Aging Report", icon: Clock },
    { key: "history" as const, label: "Payment History", icon: DollarSign },
    { key: "outstanding" as const, label: "Outstanding", icon: FileBarChart },
    { key: "cashflow" as const, label: "Cash Flow Forecast", icon: TrendingUp },
    { key: "fulfillment" as const, label: "PO Fulfillment", icon: PackageCheck },
    { key: "vendorspend" as const, label: "Vendor Spend", icon: Users },
    { key: "backorder" as const, label: "Backorder Tracker", icon: AlertTriangle },
  ];

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">
        <div className="flex gap-2 flex-wrap">
          {tabs.map(t => (
            <Button key={t.key} size="sm" variant={tab === t.key ? "default" : "outline"} className="text-xs h-8" onClick={() => setTab(t.key)}>
              <t.icon className="h-3.5 w-3.5 mr-1" /> {t.label}
            </Button>
          ))}
        </div>

        {(isLoading || loadingInv) ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : tab === "aging" ? (
          <AgingReport payments={activePayments} today={today} />
        ) : tab === "history" ? (
          <PaymentHistoryReport payments={payments} vendors={vendors} vendorFilter={vendorFilter} setVendorFilter={setVendorFilter} methodFilter={methodFilter} setMethodFilter={setMethodFilter} dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} />
        ) : tab === "outstanding" ? (
          <OutstandingReport payments={activePayments} today={today} vendors={vendors} vendorFilter={vendorFilter} setVendorFilter={setVendorFilter} />
        ) : tab === "fulfillment" ? (
          <POFulfillmentReport invoices={invoices} />
        ) : tab === "vendorspend" ? (
          <VendorSpendReport invoices={invoices} payments={activePayments} />
        ) : tab === "backorder" ? (
          <BackorderTracker recLines={recLines} recSessions={recSessions} invoices={invoices} />
        ) : (
          <CashFlowForecast payments={activePayments} today={today} />
        )}
      </div>
    </div>
  );
}

function AgingReport({ payments, today }: { payments: InvoicePayment[]; today: Date }) {
  const unpaid = payments.filter(p => p.balance_remaining > 0);

  const buckets = useMemo(() => {
    const vendors = [...new Set(unpaid.map(p => p.vendor))].sort();
    const rows = vendors.map(vendor => {
      const vp = unpaid.filter(p => p.vendor === vendor);
      const current = vp.filter(p => !isOverdue(p.due_date, p.payment_status)).reduce((s, p) => s + p.balance_remaining, 0);
      const b = (min: number, max: number) => vp.filter(p => { const d = getDaysOverdue(p.due_date); return d >= min && d <= max; }).reduce((s, p) => s + p.balance_remaining, 0);
      return { vendor, current, d1_30: b(1, 30), d31_60: b(31, 60), d61_90: b(61, 90), d90plus: b(91, 99999) };
    });
    const totals = { vendor: "GRAND TOTAL", current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    rows.forEach(r => { totals.current += r.current; totals.d1_30 += r.d1_30; totals.d31_60 += r.d31_60; totals.d61_90 += r.d61_90; totals.d90plus += r.d90plus; });
    return { rows, totals };
  }, [unpaid]);

  const handleExport = () => {
    const header = ["Vendor", "Current", "1-30 Days", "31-60 Days", "61-90 Days", "90+ Days", "Total"];
    const rows = buckets.rows.map(r => [r.vendor, r.current.toFixed(2), r.d1_30.toFixed(2), r.d31_60.toFixed(2), r.d61_90.toFixed(2), r.d90plus.toFixed(2), (r.current + r.d1_30 + r.d31_60 + r.d61_90 + r.d90plus).toFixed(2)]);
    const total = buckets.totals;
    rows.push(["GRAND TOTAL", total.current.toFixed(2), total.d1_30.toFixed(2), total.d31_60.toFixed(2), total.d61_90.toFixed(2), total.d90plus.toFixed(2), (total.current + total.d1_30 + total.d31_60 + total.d61_90 + total.d90plus).toFixed(2)]);
    exportCSV([header, ...rows], `aging_report_${format(new Date(), "yyyy-MM-dd")}.csv`);
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <CardTitle className="text-sm font-semibold">Aging Report — Outstanding Balances</CardTitle>
        <Button size="sm" variant="outline" className="text-xs h-7 w-full sm:w-auto" onClick={handleExport}><Download className="h-3 w-3 mr-1" /> Export CSV</Button>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="text-xs font-semibold">Vendor</TableHead>
                <TableHead className="text-xs font-semibold text-right">Current</TableHead>
                <TableHead className="text-xs font-semibold text-right">1-30 Days</TableHead>
                <TableHead className="text-xs font-semibold text-right">31-60 Days</TableHead>
                <TableHead className="text-xs font-semibold text-right">61-90 Days</TableHead>
                <TableHead className="text-xs font-semibold text-right">90+ Days</TableHead>
                <TableHead className="text-xs font-semibold text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {buckets.rows.map(r => (
                <TableRow key={r.vendor} className="border-border">
                  <TableCell className="text-xs font-medium">{r.vendor}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">{formatCurrency(r.current)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">{formatCurrency(r.d1_30)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">{formatCurrency(r.d31_60)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">{formatCurrency(r.d61_90)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums text-red-500">{formatCurrency(r.d90plus)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-bold">{formatCurrency(r.current + r.d1_30 + r.d31_60 + r.d61_90 + r.d90plus)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="border-border bg-muted/50 font-semibold">
                <TableCell className="text-xs">GRAND TOTAL</TableCell>
                {[buckets.totals.current, buckets.totals.d1_30, buckets.totals.d31_60, buckets.totals.d61_90, buckets.totals.d90plus].map((v, i) => (
                  <TableCell key={i} className={`text-xs text-right tabular-nums ${i === 4 ? "text-red-500" : ""}`}>{formatCurrency(v)}</TableCell>
                ))}
                <TableCell className="text-xs text-right tabular-nums font-bold">
                  {formatCurrency(buckets.totals.current + buckets.totals.d1_30 + buckets.totals.d31_60 + buckets.totals.d61_90 + buckets.totals.d90plus)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function PaymentHistoryReport({ payments, vendors, vendorFilter, setVendorFilter, methodFilter, setMethodFilter, dateFrom, setDateFrom, dateTo, setDateTo }: any) {
  const allHistory = useMemo(() => {
    const entries: { vendor: string; invoiceNumber: string; installment: string; date: string; method: string; reference: string; amount: number; recordedBy: string }[] = [];
    for (const p of payments as InvoicePayment[]) {
      for (const h of p.payment_history || []) {
        entries.push({ vendor: p.vendor, invoiceNumber: p.invoice_number, installment: p.installment_label || "—", date: h.date, method: h.method, reference: h.reference, amount: h.amount, recordedBy: h.recorded_by });
      }
    }
    return entries.sort((a, b) => b.date.localeCompare(a.date));
  }, [payments]);

  const filtered = allHistory.filter(h => {
    if (vendorFilter !== "all" && h.vendor !== vendorFilter) return false;
    if (methodFilter !== "all" && h.method !== methodFilter) return false;
    if (dateFrom && h.date < dateFrom) return false;
    if (dateTo && h.date > dateTo) return false;
    return true;
  });

  const handleExport = () => {
    const header = ["Date", "Vendor", "Invoice #", "Installment", "Method", "Reference", "Amount Paid", "Recorded By"];
    const rows = filtered.map(h => [h.date, h.vendor, h.invoiceNumber, h.installment, h.method, h.reference, h.amount.toFixed(2), h.recordedBy]);
    exportCSV([header, ...rows], `payment_history_${format(new Date(), "yyyy-MM-dd")}.csv`);
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold">Payment History Report</CardTitle>
          <Button size="sm" variant="outline" className="text-xs h-7 w-full sm:w-auto" onClick={handleExport}><Download className="h-3 w-3 mr-1" /> Export CSV</Button>
        </div>
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 mt-2">
          <Select value={vendorFilter} onValueChange={setVendorFilter}>
            <SelectTrigger className="h-8 w-full sm:w-40 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Vendors</SelectItem>
              {vendors.map((v: string) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={methodFilter} onValueChange={setMethodFilter}>
            <SelectTrigger className="h-8 w-full sm:w-32 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Methods</SelectItem>
              {["Check", "ACH", "Wire", "Credit Card", "Other"].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 w-full sm:w-36 text-xs" placeholder="From" />
          <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 w-full sm:w-36 text-xs" placeholder="To" />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-auto max-h-[600px]">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="text-xs font-semibold">Date</TableHead>
                <TableHead className="text-xs font-semibold">Vendor</TableHead>
                <TableHead className="text-xs font-semibold">Invoice #</TableHead>
                <TableHead className="text-xs font-semibold">Installment</TableHead>
                <TableHead className="text-xs font-semibold">Method</TableHead>
                <TableHead className="text-xs font-semibold">Reference</TableHead>
                <TableHead className="text-xs font-semibold text-right">Amount Paid</TableHead>
                <TableHead className="text-xs font-semibold">Recorded By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center text-xs text-muted-foreground py-8">No payment history recorded yet</TableCell></TableRow>
              ) : filtered.map((h, i) => (
                <TableRow key={i} className="border-border">
                  <TableCell className="text-xs">{h.date}</TableCell>
                  <TableCell className="text-xs">{h.vendor}</TableCell>
                  <TableCell className="text-xs font-mono">{h.invoiceNumber}</TableCell>
                  <TableCell className="text-xs">{h.installment}</TableCell>
                  <TableCell className="text-xs">{h.method}</TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">{h.reference || "—"}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-medium text-green-500">{formatCurrency(h.amount)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{h.recordedBy}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function OutstandingReport({ payments, today, vendors, vendorFilter, setVendorFilter }: any) {
  const outstanding = (payments as InvoicePayment[])
    .filter(p => p.balance_remaining > 0)
    .filter(p => vendorFilter === "all" || p.vendor === vendorFilter)
    .sort((a, b) => getDaysOverdue(b.due_date) - getDaysOverdue(a.due_date));

  const handleExport = () => {
    const header = ["Vendor", "Invoice #", "PO #", "Installment", "Due Date", "Amount Due", "Amount Paid", "Balance", "Days Overdue", "Status"];
    const rows = outstanding.map(p => [p.vendor, p.invoice_number, p.po_number || "", p.installment_label || "", p.due_date, p.amount_due.toFixed(2), p.amount_paid.toFixed(2), p.balance_remaining.toFixed(2), String(getDaysOverdue(p.due_date)), p.payment_status]);
    exportCSV([header, ...rows], `outstanding_balance_${format(new Date(), "yyyy-MM-dd")}.csv`);
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold">Outstanding Balance Report ({outstanding.length} installments · {formatCurrency(outstanding.reduce((s, p) => s + p.balance_remaining, 0))})</CardTitle>
          <Button size="sm" variant="outline" className="text-xs h-7 w-full sm:w-auto" onClick={handleExport}><Download className="h-3 w-3 mr-1" /> Export CSV</Button>
        </div>
        <Select value={vendorFilter} onValueChange={setVendorFilter}>
          <SelectTrigger className="h-8 w-full sm:w-40 text-xs mt-2"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Vendors</SelectItem>
            {vendors.map((v: string) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-auto max-h-[600px]">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="text-xs font-semibold">Vendor</TableHead>
                <TableHead className="text-xs font-semibold">Invoice #</TableHead>
                <TableHead className="text-xs font-semibold">PO #</TableHead>
                <TableHead className="text-xs font-semibold">Installment</TableHead>
                <TableHead className="text-xs font-semibold">Due Date</TableHead>
                <TableHead className="text-xs font-semibold text-right">Amount Due</TableHead>
                <TableHead className="text-xs font-semibold text-right">Paid</TableHead>
                <TableHead className="text-xs font-semibold text-right">Balance</TableHead>
                <TableHead className="text-xs font-semibold text-right">Days Overdue</TableHead>
                <TableHead className="text-xs font-semibold text-center">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outstanding.map(p => {
                const days = getDaysOverdue(p.due_date);
                return (
                  <TableRow key={p.id} className="border-border">
                    <TableCell className="text-xs">{p.vendor}</TableCell>
                    <TableCell className="text-xs font-mono">{p.invoice_number}</TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">{p.po_number || "—"}</TableCell>
                    <TableCell className="text-xs">{p.installment_label || "—"}</TableCell>
                    <TableCell className="text-xs">{formatDate(p.due_date)}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{formatCurrency(p.amount_due)}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums text-green-500">{formatCurrency(p.amount_paid)}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums font-semibold">{formatCurrency(p.balance_remaining)}</TableCell>
                    <TableCell className={`text-xs text-right tabular-nums ${days > 0 ? "text-red-500 font-semibold" : "text-muted-foreground"}`}>{days > 0 ? days : "—"}</TableCell>
                    <TableCell className="text-center"><PaymentStatusBadge payment={p} compact /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function CashFlowForecast({ payments, today }: { payments: InvoicePayment[]; today: Date }) {
  const weeks = useMemo(() => {
    const upcoming = payments.filter(p => p.balance_remaining > 0 && new Date(p.due_date + "T00:00:00") >= today);
    const endDate = addDays(today, 90);
    const weekBuckets: { weekStart: Date; label: string; total: number; cumulative: number }[] = [];
    let cursor = startOfWeek(today, { weekStartsOn: 1 });
    let cumulative = 0;

    while (cursor <= endDate) {
      const weekEnd = addDays(cursor, 6);
      const weekPayments = upcoming.filter(p => {
        const d = new Date(p.due_date + "T00:00:00");
        return d >= cursor && d <= weekEnd;
      });
      const total = weekPayments.reduce((s, p) => s + p.balance_remaining, 0);
      cumulative += total;
      weekBuckets.push({ weekStart: cursor, label: `Week of ${format(cursor, "MMM d")}`, total, cumulative });
      cursor = addDays(cursor, 7);
    }
    return weekBuckets;
  }, [payments, today]);

  const handleExport = () => {
    const header = ["Week", "Amount Due", "Cumulative Total"];
    const rows = weeks.map(w => [w.label, w.total.toFixed(2), w.cumulative.toFixed(2)]);
    exportCSV([header, ...rows], `cash_flow_forecast_${format(new Date(), "yyyy-MM-dd")}.csv`);
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <CardTitle className="text-sm font-semibold">Cash Flow Forecast — Next 90 Days</CardTitle>
        <Button size="sm" variant="outline" className="text-xs h-7 w-full sm:w-auto" onClick={handleExport}><Download className="h-3 w-3 mr-1" /> Export CSV</Button>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="text-xs font-semibold">Week</TableHead>
                <TableHead className="text-xs font-semibold text-right">Amount Due</TableHead>
                <TableHead className="text-xs font-semibold text-right">Cumulative Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {weeks.map((w, i) => (
                <TableRow key={i} className={`border-border ${w.total > 0 ? "" : "opacity-50"}`}>
                  <TableCell className="text-xs font-medium">{w.label}</TableCell>
                  <TableCell className={`text-xs text-right tabular-nums ${w.total > 0 ? "font-semibold" : "text-muted-foreground"}`}>{formatCurrency(w.total)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-bold">{formatCurrency(w.cumulative)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── PO Fulfillment Report ── */
function POFulfillmentReport({ invoices }: { invoices: VendorInvoice[] }) {
  const rows = useMemo(() => {
    const poMap = new Map<string, { vendor: string; poNumber: string; orderedQty: number; shippedQty: number; totalValue: number; invoiceCount: number }>();
    for (const inv of invoices) {
      if (inv.doc_type !== "INVOICE" || !inv.po_number) continue;
      const key = `${inv.vendor}::${inv.po_number}`;
      const cur = poMap.get(key) ?? { vendor: inv.vendor, poNumber: inv.po_number, orderedQty: 0, shippedQty: 0, totalValue: 0, invoiceCount: 0 };
      const lines = getLineItems(inv);
      for (const li of lines) {
        cur.orderedQty += li.qty_ordered ?? li.qty ?? 0;
        cur.shippedQty += li.qty_shipped ?? li.qty_ordered ?? li.qty ?? 0;
      }
      cur.totalValue += inv.total;
      cur.invoiceCount++;
      poMap.set(key, cur);
    }
    return Array.from(poMap.values()).sort((a, b) => b.totalValue - a.totalValue);
  }, [invoices]);

  const handleExport = () => {
    const header = ["Vendor", "PO #", "Invoices", "Ordered Qty", "Shipped Qty", "Fill Rate %", "Backorder Qty", "Total Value"];
    const csvRows = rows.map(r => {
      const fillRate = r.orderedQty > 0 ? ((r.shippedQty / r.orderedQty) * 100).toFixed(1) : "0";
      const backorder = Math.max(0, r.orderedQty - r.shippedQty);
      return [r.vendor, r.poNumber, String(r.invoiceCount), String(r.orderedQty), String(r.shippedQty), fillRate, String(backorder), r.totalValue.toFixed(2)];
    });
    exportCSV([header, ...csvRows], `po_fulfillment_${format(new Date(), "yyyy-MM-dd")}.csv`);
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <CardTitle className="text-sm font-semibold">PO Fulfillment Report ({rows.length} POs)</CardTitle>
        <Button size="sm" variant="outline" className="text-xs h-7 w-full sm:w-auto" onClick={handleExport}><Download className="h-3 w-3 mr-1" /> Export CSV</Button>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-auto max-h-[600px]">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="text-[10px] font-semibold">Vendor</TableHead>
                <TableHead className="text-[10px] font-semibold">PO #</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Invoices</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Ordered</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Shipped</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Fill Rate</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Backorder</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Total Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center text-xs text-muted-foreground py-8">No PO data available</TableCell></TableRow>
              ) : rows.map((r, i) => {
                const fillRate = r.orderedQty > 0 ? (r.shippedQty / r.orderedQty) * 100 : 0;
                const backorder = Math.max(0, r.orderedQty - r.shippedQty);
                return (
                  <TableRow key={i} className={`border-border ${fillRate < 100 ? "bg-amber-500/5" : ""}`}>
                    <TableCell className="text-xs">{r.vendor}</TableCell>
                    <TableCell className="text-xs font-mono">{r.poNumber}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{r.invoiceCount}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{r.orderedQty}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{r.shippedQty}</TableCell>
                    <TableCell className={`text-xs text-right tabular-nums font-semibold ${fillRate < 100 ? "text-amber-500" : "text-emerald-500"}`}>{fillRate.toFixed(1)}%</TableCell>
                    <TableCell className={`text-xs text-right tabular-nums ${backorder > 0 ? "text-destructive font-semibold" : ""}`}>{backorder}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums font-medium">{formatCurrency(r.totalValue)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Vendor Spend Summary ── */
function VendorSpendReport({ invoices, payments }: { invoices: VendorInvoice[]; payments: InvoicePayment[] }) {
  const report = useMemo(() => {
    const now = new Date();
    const months: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = subMonths(now, i);
      months.push(format(d, "yyyy-MM"));
    }

    const vendors = [...new Set((invoices as any[]).map(i => i.vendor))].sort();
    const vendorData = vendors.map(vendor => {
      const vendorInv = (invoices as any[]).filter(i => i.vendor === vendor && i.doc_type === "INVOICE");
      const vendorPay = payments.filter(p => p.vendor === vendor);

      const byMonth = months.map(m => {
        const monthInv = vendorInv.filter(i => (i.invoice_date as string).startsWith(m));
        const monthPaid = vendorPay
          .filter(p => p.payment_status === "paid" && p.paid_date && (p.paid_date as string).startsWith(m))
          .reduce((s, p) => s + (p.amount_paid ?? 0), 0);
        return {
          month: m,
          invoiced: monthInv.reduce((s: number, i: any) => s + (Number(i.total) || 0), 0),
          paid: monthPaid,
        };
      });

      const totalInvoiced = vendorInv.reduce((s: number, i: any) => s + (Number(i.total) || 0), 0);
      const totalPaid = vendorPay.filter(p => p.payment_status === "paid").reduce((s, p) => s + (p.amount_paid ?? 0), 0);
      const outstanding = vendorPay.filter(p => p.payment_status !== "paid" && p.payment_status !== "void").reduce((s, p) => s + p.balance_remaining, 0);

      return { vendor, byMonth, totalInvoiced, totalPaid, outstanding };
    });

    return { months, vendorData };
  }, [invoices, payments]);

  const handleExport = () => {
    const header = ["Vendor", ...report.months.flatMap(m => [`${m} Invoiced`, `${m} Paid`]), "Total Invoiced", "Total Paid", "Outstanding"];
    const rows = report.vendorData.map(v => [
      v.vendor,
      ...v.byMonth.flatMap(m => [m.invoiced.toFixed(2), m.paid.toFixed(2)]),
      v.totalInvoiced.toFixed(2),
      v.totalPaid.toFixed(2),
      v.outstanding.toFixed(2),
    ]);
    exportCSV([header, ...rows], `vendor_spend_${format(new Date(), "yyyy-MM-dd")}.csv`);
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <CardTitle className="text-sm font-semibold">Vendor Spend Summary — Rolling 6 Months</CardTitle>
        <Button size="sm" variant="outline" className="text-xs h-7 w-full sm:w-auto" onClick={handleExport}><Download className="h-3 w-3 mr-1" /> Export CSV</Button>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="text-[10px] font-semibold sticky left-0 bg-card z-10">Vendor</TableHead>
                {report.months.map(m => (
                  <TableHead key={m} className="text-[10px] font-semibold text-right" colSpan={2}>
                    {format(new Date(m + "-01"), "MMM yyyy")}
                  </TableHead>
                ))}
                <TableHead className="text-[10px] font-semibold text-right">Total Invoiced</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Total Paid</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Outstanding</TableHead>
              </TableRow>
              <TableRow className="border-border">
                <TableHead className="sticky left-0 bg-card z-10" />
                {report.months.flatMap(m => [
                  <TableHead key={`${m}-inv`} className="text-[9px] text-muted-foreground text-right">Inv</TableHead>,
                  <TableHead key={`${m}-paid`} className="text-[9px] text-muted-foreground text-right">Paid</TableHead>,
                ])}
                <TableHead /><TableHead /><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.vendorData.map(v => (
                <TableRow key={v.vendor} className="border-border">
                  <TableCell className="text-xs font-medium sticky left-0 bg-card z-10">{v.vendor}</TableCell>
                  {v.byMonth.flatMap((m, i) => [
                    <TableCell key={`${i}-inv`} className="text-[10px] text-right tabular-nums">{m.invoiced > 0 ? formatCurrency(m.invoiced) : "—"}</TableCell>,
                    <TableCell key={`${i}-paid`} className="text-[10px] text-right tabular-nums text-emerald-500">{m.paid > 0 ? formatCurrency(m.paid) : "—"}</TableCell>,
                  ])}
                  <TableCell className="text-xs text-right tabular-nums font-semibold">{formatCurrency(v.totalInvoiced)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-semibold text-emerald-500">{formatCurrency(v.totalPaid)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-semibold text-amber-500">{formatCurrency(v.outstanding)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
