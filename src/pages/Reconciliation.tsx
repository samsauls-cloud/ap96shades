import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Play, Download, AlertTriangle, CheckCircle2, Shield, DollarSign,
  FileText, Clock, Filter, Search, X, ChevronDown, RefreshCw, PackageCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { StaleQueuePanel } from "@/components/invoices/StaleQueuePanel";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabase-fetch-all";
import { runFullReconciliation, type ReconciliationProgress } from "@/lib/reconciliation-engine";
import { runTargetedReconciliation } from "@/lib/targeted-reconciliation";
import { fetchStaleCount } from "@/lib/stale-queue-queries";
import { formatCurrency, formatDate, getLineItems } from "@/lib/supabase-queries";
import type { VendorInvoice } from "@/lib/supabase-queries";

type ResolutionAction = "resolved" | "disputed" | "waived";

/* ── LS matching (shared engine) ── */
import { buildLSMatchMap, type LSMatchResult } from "@/lib/ls-match-engine";

type LSInvoiceMatch = LSMatchResult;

/* ── main ── */

export default function ReconciliationPage() {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ReconciliationProgress | null>(null);
  const [resolveModal, setResolveModal] = useState<{ id: string; action: ResolutionAction } | null>(null);
  const [resolveNotes, setResolveNotes] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [vendorFilter, setVendorFilter] = useState("");
  const [lsStatusFilter, setLsStatusFilter] = useState("");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Queries
  const { data: invoices = [], isLoading: loadingInv } = useQuery({
    queryKey: ["recon_invoices"],
    queryFn: () => fetchAllRows<VendorInvoice>("vendor_invoices"),
  });

  const { data: payments = [] } = useQuery({
    queryKey: ["recon_payments"],
    queryFn: () => fetchAllRows("invoice_payments"),
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ["recon_sessions"],
    queryFn: () => fetchAllRows("po_receiving_sessions"),
  });

  const { data: recLines = [] } = useQuery({
    queryKey: ["recon_lines"],
    queryFn: () => fetchAllRows("po_receiving_lines"),
  });

  const { data: discrepancies = [], isLoading: loadingDisc } = useQuery({
    queryKey: ["recon_discrepancies"],
    queryFn: () => fetchAllRows("reconciliation_discrepancies", { orderBy: "created_at", ascending: false }),
  });

  const { data: runs = [] } = useQuery({
    queryKey: ["recon_runs"],
    queryFn: () => fetchAllRows("reconciliation_runs", { orderBy: "run_at", ascending: false }),
  });

  const { data: vendors = [] } = useQuery({
    queryKey: ["recon_vendors"],
    queryFn: async () => {
      const { data } = await supabase.from("vendor_invoices").select("vendor").order("vendor");
      return [...new Set((data ?? []).map(d => d.vendor))];
    },
  });

  const { data: staleCount = 0 } = useQuery({
    queryKey: ["stale_count"],
    queryFn: fetchStaleCount,
    refetchInterval: 15000,
  });

  const latestRun = runs[0];

  // LS match map
  const lsMatchMap = useMemo(() => buildLSMatchMap(invoices, sessions, recLines), [invoices, sessions, recLines]);

  // Payment status by invoice
  const paymentByInvoice = useMemo(() => {
    const map = new Map<string, { status: string; daysUntilDue: number | null; totalDue: number; totalPaid: number }>();
    const today = new Date();
    const grouped = new Map<string, any[]>();
    for (const p of payments as any[]) {
      if (!p.invoice_id) continue;
      if (!grouped.has(p.invoice_id)) grouped.set(p.invoice_id, []);
      grouped.get(p.invoice_id)!.push(p);
    }
    for (const [invId, pList] of grouped) {
      const allPaid = pList.every(p => p.is_paid);
      const anyPaid = pList.some(p => p.is_paid);
      const anyDisputed = pList.some(p => p.payment_status === "disputed");
      const totalDue = pList.reduce((s, p) => s + (Number(p.amount_due) || 0), 0);
      const totalPaid = pList.reduce((s, p) => s + (Number(p.amount_paid) || 0), 0);

      // Nearest due date
      const unpaidDates = pList.filter(p => !p.is_paid).map(p => p.due_date).sort();
      let daysUntilDue: number | null = null;
      if (unpaidDates.length > 0) {
        const nearest = new Date(unpaidDates[0]);
        daysUntilDue = Math.round((nearest.getTime() - today.getTime()) / 86400000);
      }

      let status = "Unpaid";
      if (allPaid) status = "Paid";
      else if (anyDisputed) status = "Disputed";
      else if (anyPaid) status = "Partial";

      map.set(invId, { status, daysUntilDue, totalDue, totalPaid });
    }
    return map;
  }, [payments]);

  // Build grid rows
  const gridRows = useMemo(() => {
    const inv = invoices.filter((i: any) => i.doc_type === "INVOICE");
    return inv.map((i: any) => {
      const ls = lsMatchMap.get(i.id);
      const pay = paymentByInvoice.get(i.id);
      const li = getLineItems(i);
      const qtyInvoiced = li.reduce((s: number, x: any) =>
        s + (Number(x.qty_shipped) || Number(x.qty_ordered) || Number(x.qty) || 0), 0);

      return {
        id: i.id,
        vendor: i.vendor,
        invoiceNumber: i.invoice_number,
        poNumber: i.po_number ?? "—",
        invoiceDate: i.invoice_date,
        invoiceTotal: Number(i.total),
        qtyInvoiced,
        lsSessions: ls?.sessionsMatched ?? 0,
        lsQtyReceived: ls?.lsQtyReceived ?? 0,
        qtyVariance: ls?.qtyVariance ?? qtyInvoiced,
        lsStatus: ls?.status ?? "not_found",
        hasPaymentSchedule: !!pay,
        paymentStatus: pay?.status ?? "No Schedule",
        daysUntilDue: pay?.daysUntilDue ?? null,
      };
    });
  }, [invoices, lsMatchMap, paymentByInvoice]);

  // Filters
  const filtered = useMemo(() => {
    let result = [...gridRows];
    if (vendorFilter) result = result.filter(r => r.vendor === vendorFilter);
    if (lsStatusFilter) result = result.filter(r => r.lsStatus === lsStatusFilter);
    if (paymentStatusFilter) result = result.filter(r => r.paymentStatus === paymentStatusFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(r =>
        r.invoiceNumber.toLowerCase().includes(q) ||
        r.poNumber.toLowerCase().includes(q) ||
        r.vendor.toLowerCase().includes(q)
      );
    }
    return result;
  }, [gridRows, vendorFilter, lsStatusFilter, paymentStatusFilter, searchQuery]);

  // Summary
  const stats = useMemo(() => ({
    total: gridRows.length,
    fullyReceived: gridRows.filter(r => r.lsStatus === "fully_received").length,
    partial: gridRows.filter(r => r.lsStatus === "partial").length,
    notFound: gridRows.filter(r => r.lsStatus === "not_found").length,
    totalAP: gridRows.reduce((s, r) => s + r.invoiceTotal, 0),
    discrepancyCount: discrepancies.length,
    atRisk: discrepancies.reduce((s, d) => s + (Number(d.amount_at_risk) || 0), 0),
  }), [gridRows, discrepancies]);

  const handleRun = async (mode: "full" | "stale_only") => {
    setRunning(true);
    setProgress({ step: "Starting…", detail: mode === "full" ? "Full reconciliation" : "Re-reconciling stale records" });
    try {
      const result = mode === "full"
        ? await runFullReconciliation(setProgress)
        : await runTargetedReconciliation({ mode: "stale_only" }, setProgress);
      toast.success(`Complete: ${result.totalDiscrepancies} discrepancies found`);
      invalidateAll();
    } catch (err: any) {
      toast.error(`Reconciliation failed: ${err.message}`);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["recon_discrepancies"] });
    qc.invalidateQueries({ queryKey: ["recon_runs"] });
    qc.invalidateQueries({ queryKey: ["recon_invoices"] });
    qc.invalidateQueries({ queryKey: ["recon_payments"] });
    qc.invalidateQueries({ queryKey: ["recon_sessions"] });
    qc.invalidateQueries({ queryKey: ["recon_lines"] });
    qc.invalidateQueries({ queryKey: ["vendor_invoices"] });
    qc.invalidateQueries({ queryKey: ["invoice_stats"] });
    qc.invalidateQueries({ queryKey: ["stale_queue"] });
    qc.invalidateQueries({ queryKey: ["stale_count"] });
    qc.invalidateQueries({ queryKey: ["stale_count_banner"] });
  };

  const exportCSV = () => {
    const header = "Vendor,Invoice #,PO #,Invoice Date,Invoice Total,LS Sessions,Qty Invoiced,Qty Received,Variance,Receipt Status,Payment Status,Days Until Due";
    const rows = filtered.map(r => [
      r.vendor, r.invoiceNumber, r.poNumber, r.invoiceDate, r.invoiceTotal.toFixed(2),
      r.lsSessions, r.qtyInvoiced, r.lsQtyReceived, r.qtyVariance,
      r.lsStatus.replace(/_/g, " "), r.paymentStatus, r.daysUntilDue ?? "",
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "reconciliation_grid.csv"; a.click();
    URL.revokeObjectURL(url);
    toast.success("Grid exported");
  };

  function rowColor(status: string) {
    if (status === "fully_received") return "bg-emerald-500/5 hover:bg-emerald-500/10";
    if (status === "partial") return "bg-amber-500/5 hover:bg-amber-500/10";
    return "bg-destructive/5 hover:bg-destructive/10";
  }

  function ReceiptBadge({ status }: { status: string }) {
    if (status === "fully_received") return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-[9px]">✅ Received</Badge>;
    if (status === "partial") return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 text-[9px]">⚠ Partial</Badge>;
    return <Badge className="bg-destructive/15 text-destructive border-destructive/30 text-[9px]">❌ Not Found</Badge>;
  }

  const runTypeLabels: Record<string, string> = {
    full: "Full", stale_only: "Stale Only",
    targeted_vendor: "Vendor", targeted_upc: "UPC", targeted_invoice: "Invoice",
  };

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Top bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Reconciliation Center</h1>
            <p className="text-xs text-muted-foreground">
              Last run: {latestRun ? formatDate(latestRun.run_at) : "Never"} · {stats.total} invoices
            </p>
          </div>
          <div className="flex gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="text-xs h-8 gap-1.5" disabled={running}>
                  <Play className="h-3.5 w-3.5" />
                  {running ? "Running…" : "Run Reconciliation"}
                  <ChevronDown className="h-3 w-3 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => handleRun("full")} className="text-xs gap-2">
                  <Play className="h-3 w-3" /> Full Reconciliation
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleRun("stale_only")} className="text-xs gap-2" disabled={staleCount === 0}>
                  <RefreshCw className="h-3 w-3" /> Re-Reconcile Stale Only
                  {staleCount > 0 && <Badge className="ml-auto bg-amber-500 text-white text-[9px] h-4 px-1">{staleCount}</Badge>}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" size="sm" className="text-xs h-8 gap-1.5" onClick={exportCSV}>
              <Download className="h-3.5 w-3.5" /> Export CSV
            </Button>
          </div>
        </div>

        {/* Progress */}
        {running && progress && (
          <Card className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <span className="text-sm font-medium">{progress.step}</span>
              </div>
              <p className="text-xs text-muted-foreground mb-2">{progress.detail}</p>
              <Progress value={undefined} className="h-1.5" />
            </CardContent>
          </Card>
        )}

        <StaleQueuePanel onRunComplete={invalidateAll} />

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "Total Invoices", value: stats.total, icon: FileText, color: "text-primary" },
            { label: "✅ Fully Received", value: stats.fullyReceived, icon: CheckCircle2, color: "text-emerald-500" },
            { label: "⚠ Partial", value: stats.partial, icon: AlertTriangle, color: "text-amber-500" },
            { label: "❌ Not Found", value: stats.notFound, icon: Shield, color: "text-destructive" },
            { label: "Total AP Value", value: formatCurrency(stats.totalAP), icon: DollarSign, color: "text-primary" },
            { label: "Discrepancies", value: stats.discrepancyCount, icon: AlertTriangle, color: "text-destructive" },
          ].map(item => (
            <Card key={item.label} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{item.label}</span>
                  <item.icon className={`h-3.5 w-3.5 ${item.color} opacity-70`} />
                </div>
                <p className="text-lg font-bold tracking-tight">{item.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 items-center">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <Select value={vendorFilter || "__all__"} onValueChange={v => setVendorFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-8 w-[160px] text-xs"><SelectValue placeholder="All Vendors" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Vendors</SelectItem>
              {vendors.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={lsStatusFilter || "__all__"} onValueChange={v => setLsStatusFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-8 w-[160px] text-xs"><SelectValue placeholder="All Receipt Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Receipt Status</SelectItem>
              <SelectItem value="fully_received">✅ Fully Received</SelectItem>
              <SelectItem value="partial">⚠ Partial</SelectItem>
              <SelectItem value="not_found">❌ Not Found</SelectItem>
            </SelectContent>
          </Select>
          <Select value={paymentStatusFilter || "__all__"} onValueChange={v => setPaymentStatusFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue placeholder="Payment Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All</SelectItem>
              <SelectItem value="Unpaid">Unpaid</SelectItem>
              <SelectItem value="Partial">Partial</SelectItem>
              <SelectItem value="Paid">Paid</SelectItem>
              <SelectItem value="Disputed">Disputed</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input placeholder="Search invoice, PO, vendor…" className="h-8 pl-8 text-xs" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          </div>
          {(vendorFilter || lsStatusFilter || paymentStatusFilter || searchQuery) && (
            <Button variant="ghost" size="sm" className="h-8 text-xs gap-1" onClick={() => {
              setVendorFilter(""); setLsStatusFilter(""); setPaymentStatusFilter(""); setSearchQuery("");
            }}>
              <X className="h-3 w-3" /> Clear
            </Button>
          )}
        </div>

        {/* Master Reconciliation Grid */}
        <div className="rounded-lg border border-border bg-card overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-[10px] font-semibold">Vendor</TableHead>
                <TableHead className="text-[10px] font-semibold">Invoice #</TableHead>
                <TableHead className="text-[10px] font-semibold">PO #</TableHead>
                <TableHead className="text-[10px] font-semibold">Date</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Total</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">LS Sessions</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Qty Invoiced</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Qty Received</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Variance</TableHead>
                <TableHead className="text-[10px] font-semibold">Receipt Status</TableHead>
                <TableHead className="text-[10px] font-semibold">Payment</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Days Due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={12} className="text-center py-12 text-muted-foreground text-sm">
                    {loadingInv ? "Loading…" : "No invoices match filters."}
                  </TableCell>
                </TableRow>
              ) : filtered.map(r => (
                <TableRow key={r.id} className={`border-border ${rowColor(r.lsStatus)}`}>
                  <TableCell className="text-[10px]">{r.vendor}</TableCell>
                  <TableCell className="text-[10px] font-mono">{r.invoiceNumber}</TableCell>
                  <TableCell className="text-[10px]">{r.poNumber}</TableCell>
                  <TableCell className="text-[10px]">{formatDate(r.invoiceDate)}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{formatCurrency(r.invoiceTotal)}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{r.lsSessions}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{r.qtyInvoiced}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{r.lsQtyReceived}</TableCell>
                  <TableCell className={`text-[10px] text-right tabular-nums font-semibold ${r.qtyVariance > 0 ? "text-amber-500" : r.qtyVariance < 0 ? "text-emerald-500" : ""}`}>
                    {r.qtyVariance !== 0 ? (r.qtyVariance > 0 ? `+${r.qtyVariance}` : r.qtyVariance) : "0"}
                  </TableCell>
                  <TableCell><ReceiptBadge status={r.lsStatus} /></TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-[9px] ${
                      r.paymentStatus === "Paid" ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30" :
                      r.paymentStatus === "Partial" ? "bg-amber-500/15 text-amber-600 border-amber-500/30" :
                      r.paymentStatus === "Disputed" ? "bg-purple-500/15 text-purple-600 border-purple-500/30" :
                      r.paymentStatus === "No Schedule" ? "bg-destructive/15 text-destructive border-destructive/30" :
                      ""
                    }`}>{r.paymentStatus}</Badge>
                  </TableCell>
                  <TableCell className={`text-[10px] text-right tabular-nums ${r.daysUntilDue !== null && r.daysUntilDue < 0 ? "text-destructive font-semibold" : ""}`}>
                    {r.daysUntilDue !== null
                      ? r.daysUntilDue < 0 ? `${Math.abs(r.daysUntilDue)}d overdue` : `${r.daysUntilDue}d`
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* ⚠ Discrepancies Section */}
        <div>
          <h2 className="text-sm font-bold mb-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Billing Discrepancies from Lightspeed Receiving
          </h2>
          {(() => {
            // Build discrepancy rows from po_receiving_lines
            const discRows = (recLines as any[]).filter(l =>
              l.billing_discrepancy === true || (Number(l.discrepancy_amount) || 0) !== 0 || (Number(l.not_received_qty) || 0) > 0
            ).map(l => {
              // Find session and linked invoice
              const session = (sessions as any[]).find(s => s.id === l.session_id);
              const invId = session?.reconciled_invoice_id;
              const inv = invId ? (invoices as any[]).find(i => i.id === invId) : null;
              return {
                ...l,
                vendor: inv?.vendor ?? session?.vendor ?? "—",
                invoiceNumber: inv?.invoice_number ?? "—",
                poNumber: inv?.po_number ?? "—",
                discAmount: Number(l.discrepancy_amount) || 0,
                notReceivedQty: Number(l.not_received_qty) || 0,
              };
            }).sort((a, b) => Math.abs(b.discAmount) - Math.abs(a.discAmount));

            const totalDiscDollars = discRows.reduce((s, r) => s + r.discAmount, 0);
            const priceMismatches = discRows.filter(r => r.billing_discrepancy === true).length;
            const qtyShortages = discRows.filter(r => r.notReceivedQty > 0).length;
            const totalNotReceived = discRows.reduce((s, r) => s + r.notReceivedQty, 0);

            const exportDiscCSV = () => {
              const header = "Vendor,Invoice #,PO #,Item,UPC,SKU,Order Qty,Received Qty,Not Received,LS Unit Cost,Discrepancy Type,Discrepancy Amount,Billing Discrepancy";
              const rows = discRows.map(r => [
                r.vendor, r.invoiceNumber, r.poNumber, r.item_description ?? "", r.upc ?? "", r.manufact_sku ?? "",
                r.order_qty ?? 0, r.received_qty ?? 0, r.notReceivedQty, r.unit_cost ?? 0,
                r.discrepancy_type ?? "", r.discAmount.toFixed(2), r.billing_discrepancy ? "YES" : "NO",
              ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));
              const csv = [header, ...rows].join("\n");
              const blob = new Blob([csv], { type: "text/csv" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href = url; a.download = "billing_discrepancies.csv"; a.click();
              URL.revokeObjectURL(url);
              toast.success("Discrepancies exported");
            };

            return (
              <>
                {/* Summary cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  <Card className="bg-card border-border">
                    <CardContent className="p-3">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Discrepancy Impact</span>
                      <p className="text-lg font-bold tracking-tight text-destructive">{formatCurrency(Math.abs(totalDiscDollars))}</p>
                    </CardContent>
                  </Card>
                  <Card className="bg-card border-border">
                    <CardContent className="p-3">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Price Mismatches</span>
                      <p className="text-lg font-bold tracking-tight">{priceMismatches}</p>
                    </CardContent>
                  </Card>
                  <Card className="bg-card border-border">
                    <CardContent className="p-3">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Qty Shortages</span>
                      <p className="text-lg font-bold tracking-tight text-amber-500">{qtyShortages}</p>
                    </CardContent>
                  </Card>
                  <Card className="bg-card border-border">
                    <CardContent className="p-3">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Units Not Received</span>
                      <p className="text-lg font-bold tracking-tight">{totalNotReceived}</p>
                    </CardContent>
                  </Card>
                </div>

                <div className="flex justify-end mb-2">
                  <Button variant="outline" size="sm" className="text-xs h-8 gap-1.5" onClick={exportDiscCSV}>
                    <Download className="h-3.5 w-3.5" /> Export Discrepancies CSV
                  </Button>
                </div>

                <div className="rounded-lg border border-border bg-card overflow-auto max-h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="text-[10px] font-semibold">Vendor</TableHead>
                        <TableHead className="text-[10px] font-semibold">Invoice #</TableHead>
                        <TableHead className="text-[10px] font-semibold">Item</TableHead>
                        <TableHead className="text-[10px] font-semibold">UPC</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Order</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Received</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Not Rcvd</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Unit Cost</TableHead>
                        <TableHead className="text-[10px] font-semibold">Type</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Disc. Amt</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {discRows.length === 0 ? (
                        <TableRow><TableCell colSpan={10} className="text-center py-8 text-muted-foreground text-sm">No discrepancies found</TableCell></TableRow>
                      ) : discRows.slice(0, 200).map((r, i) => {
                        const isBilling = r.billing_discrepancy === true;
                        const isShort = r.notReceivedQty > 0;
                        const bgClass = isBilling && isShort
                          ? "bg-orange-500/8 hover:bg-orange-500/12"
                          : isBilling
                          ? "bg-destructive/5 hover:bg-destructive/10"
                          : isShort
                          ? "bg-amber-500/5 hover:bg-amber-500/10"
                          : "";
                        return (
                          <TableRow key={`disc-${i}`} className={`border-border ${bgClass}`}>
                            <TableCell className="text-[10px]">{r.vendor}</TableCell>
                            <TableCell className="text-[10px] font-mono">{r.invoiceNumber}</TableCell>
                            <TableCell className="text-[10px] max-w-[150px] truncate">{r.item_description ?? "—"}</TableCell>
                            <TableCell className="text-[10px] font-mono">{r.upc ?? "—"}</TableCell>
                            <TableCell className="text-[10px] text-right tabular-nums">{r.order_qty ?? 0}</TableCell>
                            <TableCell className="text-[10px] text-right tabular-nums">{r.received_qty ?? 0}</TableCell>
                            <TableCell className={`text-[10px] text-right tabular-nums ${isShort ? "text-amber-500 font-semibold" : ""}`}>{r.notReceivedQty || "—"}</TableCell>
                            <TableCell className="text-[10px] text-right tabular-nums">{formatCurrency(Number(r.unit_cost) || 0)}</TableCell>
                            <TableCell className="text-[10px]">
                              <Badge variant="outline" className={`text-[9px] ${isBilling ? "bg-destructive/15 text-destructive border-destructive/30" : "bg-amber-500/15 text-amber-600 border-amber-500/30"}`}>
                                {r.discrepancy_type ?? (isShort ? "short" : "—")}
                              </Badge>
                            </TableCell>
                            <TableCell className={`text-[10px] text-right tabular-nums font-semibold ${r.discAmount !== 0 ? "text-destructive" : ""}`}>
                              {r.discAmount !== 0 ? formatCurrency(r.discAmount) : "—"}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                {discRows.length > 200 && (
                  <p className="text-[10px] text-muted-foreground mt-1">Showing 200 of {discRows.length} — export CSV for full list</p>
                )}
              </>
            );
          })()}
        </div>

        {/* Run History */}
        <div>
          <h2 className="text-sm font-bold mb-3">Run History</h2>
          <div className="rounded-lg border border-border bg-card overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-[10px] font-semibold">Run #</TableHead>
                  <TableHead className="text-[10px] font-semibold">Run At</TableHead>
                  <TableHead className="text-[10px] font-semibold">Type</TableHead>
                  <TableHead className="text-[10px] font-semibold">Scope</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">Invoices</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">PO Lines</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">Discrepancies</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">$ at Risk</TableHead>
                  <TableHead className="text-[10px] font-semibold">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.length === 0 ? (
                  <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground text-sm">No runs yet</TableCell></TableRow>
                ) : runs.map((r, i) => (
                  <TableRow key={r.id} className="border-border">
                    <TableCell className="text-[10px] font-mono">#{runs.length - i}</TableCell>
                    <TableCell className="text-[10px]">{formatDate(r.run_at)}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[9px]">{runTypeLabels[(r as any).run_type] ?? "Full"}</Badge></TableCell>
                    <TableCell className="text-[10px] text-muted-foreground max-w-[200px] truncate">{(r as any).scope_description ?? "All records"}</TableCell>
                    <TableCell className="text-[10px] text-right tabular-nums">{r.total_invoices_checked}</TableCell>
                    <TableCell className="text-[10px] text-right tabular-nums">{r.total_po_lines_checked}</TableCell>
                    <TableCell className="text-[10px] text-right tabular-nums">{r.total_discrepancies}</TableCell>
                    <TableCell className="text-[10px] text-right tabular-nums font-semibold">{formatCurrency(Number(r.total_amount_at_risk))}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[9px] bg-emerald-500/15 text-emerald-600 border-emerald-500/30">{r.status}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </main>
    </div>
  );
}
