import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Play, Download, AlertTriangle, CheckCircle2, Shield, DollarSign,
  FileText, Clock, Filter, Search, X,
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
import { Checkbox } from "@/components/ui/checkbox";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { supabase } from "@/integrations/supabase/client";
import { runFullReconciliation, type ReconciliationProgress } from "@/lib/reconciliation-engine";
import { formatCurrency, formatDate } from "@/lib/supabase-queries";

type ResolutionAction = "resolved" | "disputed" | "waived";

export default function ReconciliationPage() {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ReconciliationProgress | null>(null);
  const [resolveModal, setResolveModal] = useState<{ id: string; action: ResolutionAction } | null>(null);
  const [resolveNotes, setResolveNotes] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Filters
  const [vendorFilter, setVendorFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Sort
  const [sortField, setSortField] = useState("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Queries
  const { data: discrepancies = [], isLoading: loadingDisc } = useQuery({
    queryKey: ["recon_discrepancies"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reconciliation_discrepancies")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: runs = [] } = useQuery({
    queryKey: ["recon_runs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reconciliation_runs")
        .select("*")
        .order("run_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: vendors = [] } = useQuery({
    queryKey: ["recon_vendors"],
    queryFn: async () => {
      const { data } = await supabase.from("vendor_invoices").select("vendor").order("vendor");
      return [...new Set((data ?? []).map(d => d.vendor))];
    },
  });

  const latestRun = runs[0];

  // Filtered & sorted discrepancies
  const filtered = useMemo(() => {
    let result = [...discrepancies];
    if (vendorFilter) result = result.filter(d => d.vendor === vendorFilter);
    if (typeFilter) result = result.filter(d => d.discrepancy_type === typeFilter);
    if (severityFilter) result = result.filter(d => d.severity === severityFilter);
    if (statusFilter) result = result.filter(d => d.resolution_status === statusFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(d =>
        (d.upc ?? "").toLowerCase().includes(q) ||
        (d.model_number ?? "").toLowerCase().includes(q) ||
        (d.invoice_number ?? "").toLowerCase().includes(q) ||
        (d.po_number ?? "").toLowerCase().includes(q) ||
        (d.sku ?? "").toLowerCase().includes(q)
      );
    }
    result.sort((a, b) => {
      const av = (a as any)[sortField] ?? "";
      const bv = (b as any)[sortField] ?? "";
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return result;
  }, [discrepancies, vendorFilter, typeFilter, severityFilter, statusFilter, searchQuery, sortField, sortDir]);

  // Summary stats
  const stats = useMemo(() => {
    const total = discrepancies.length;
    const critical = discrepancies.filter(d => d.severity === "critical").length;
    const open = discrepancies.filter(d => d.resolution_status === "open").length;
    const atRisk = discrepancies.reduce((s, d) => s + (Number(d.amount_at_risk) || 0), 0);
    const cleanInvoices = latestRun ? (latestRun.total_invoices_checked ?? 0) - new Set(discrepancies.filter(d => d.invoice_id).map(d => d.invoice_id)).size : 0;
    return {
      totalChecked: latestRun?.total_invoices_checked ?? 0,
      total, critical, open, atRisk, cleanInvoices,
    };
  }, [discrepancies, latestRun]);

  const handleRun = async () => {
    setRunning(true);
    setProgress({ step: "Starting…", detail: "Initializing reconciliation engine" });
    try {
      const result = await runFullReconciliation(setProgress);
      toast.success(`Reconciliation complete: ${result.totalDiscrepancies} discrepancies found`);
      qc.invalidateQueries({ queryKey: ["recon_discrepancies"] });
      qc.invalidateQueries({ queryKey: ["recon_runs"] });
      qc.invalidateQueries({ queryKey: ["vendor_invoices"] });
      qc.invalidateQueries({ queryKey: ["invoice_stats"] });
    } catch (err: any) {
      toast.error(`Reconciliation failed: ${err.message}`);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const handleResolve = async () => {
    if (!resolveModal) return;
    const { id, action } = resolveModal;
    const { error } = await supabase
      .from("reconciliation_discrepancies")
      .update({
        resolution_status: action,
        resolved_at: new Date().toISOString(),
        resolution_notes: resolveNotes,
        resolved_by: "admin",
      } as any)
      .eq("id", id);
    if (error) { toast.error("Failed to update"); return; }
    toast.success(`Marked as ${action}`);
    setResolveModal(null);
    setResolveNotes("");
    qc.invalidateQueries({ queryKey: ["recon_discrepancies"] });
  };

  const handleBulkResolve = async () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    for (const id of ids) {
      await supabase
        .from("reconciliation_discrepancies")
        .update({
          resolution_status: "resolved",
          resolved_at: new Date().toISOString(),
          resolved_by: "admin",
          resolution_notes: "Bulk resolved",
        } as any)
        .eq("id", id);
    }
    toast.success(`Resolved ${ids.length} discrepancies`);
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["recon_discrepancies"] });
  };

  const exportCSV = () => {
    const header = "Severity,Type,Vendor,Brand,UPC,Model,Invoice #,PO #,Ord Qty,Inv Qty,Δ Qty,Ord Price,Inv Price,Δ Price,$ at Risk,Status";
    const rows = filtered.map(d => [
      d.severity, d.discrepancy_type, d.vendor ?? "", d.brand ?? "", d.upc ?? "", d.model_number ?? "",
      d.invoice_number ?? "", d.po_number ?? "", d.ordered_qty ?? "", d.invoiced_qty ?? "",
      d.qty_delta ?? "", d.ordered_unit_price ?? "", d.invoiced_unit_price ?? "",
      d.price_delta ?? "", d.amount_at_risk ?? "", d.resolution_status,
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "reconciliation_report.csv"; a.click();
    URL.revokeObjectURL(url);
    toast.success("Report exported");
  };

  const toggleSort = (field: string) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(d => d.id)));
  };

  // Vendor breakdown
  const vendorBreakdown = useMemo(() => {
    const map = new Map<string, { total: number; atRisk: number; critical: number; clean: number }>();
    for (const d of discrepancies) {
      const v = d.vendor ?? "Unknown";
      if (!map.has(v)) map.set(v, { total: 0, atRisk: 0, critical: 0, clean: 0 });
      const m = map.get(v)!;
      m.total++;
      m.atRisk += Number(d.amount_at_risk) || 0;
      if (d.severity === "critical") m.critical++;
    }
    return Array.from(map.entries()).sort((a, b) => b[1].atRisk - a[1].atRisk);
  }, [discrepancies]);

  const TYPES = ["QTY_MISMATCH", "PRICE_MISMATCH", "INVOICE_NO_PO", "PO_NO_INVOICE", "DUPLICATE_INVOICE", "UPC_NOT_FOUND", "OVERPAYMENT", "UNDERPAYMENT"];

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Top bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Reconciliation Center</h1>
            <p className="text-xs text-muted-foreground">
              Last run: {latestRun ? formatDate(latestRun.run_at) : "Never"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="text-xs h-8 gap-1.5" onClick={handleRun} disabled={running}>
              <Play className="h-3.5 w-3.5" />
              {running ? "Running…" : "Run Reconciliation Now"}
            </Button>
            <Button variant="outline" size="sm" className="text-xs h-8 gap-1.5" onClick={exportCSV}>
              <Download className="h-3.5 w-3.5" /> Export Report CSV
            </Button>
          </div>
        </div>

        {/* Progress bar */}
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

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "Invoices Checked", value: stats.totalChecked.toString(), icon: FileText, color: "text-primary" },
            { label: "Total Discrepancies", value: stats.total.toString(), icon: AlertTriangle, color: "text-destructive", badge: stats.total > 0 },
            { label: "Critical Issues", value: stats.critical.toString(), icon: Shield, color: "text-destructive" },
            { label: "$ at Risk", value: formatCurrency(stats.atRisk), icon: DollarSign, color: "text-destructive" },
            { label: "Clean Invoices", value: stats.cleanInvoices.toString(), icon: CheckCircle2, color: "text-emerald-500" },
            { label: "Open Issues", value: stats.open.toString(), icon: Clock, color: "text-amber-500" },
          ].map(item => (
            <Card key={item.label} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{item.label}</span>
                  <item.icon className={`h-3.5 w-3.5 ${item.color} opacity-70`} />
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-lg font-bold tracking-tight">{item.value}</p>
                  {item.badge && <Badge className="bg-destructive text-destructive-foreground text-[9px] h-4 px-1">{stats.total}</Badge>}
                </div>
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
          <Select value={typeFilter || "__all__"} onValueChange={v => setTypeFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-8 w-[160px] text-xs"><SelectValue placeholder="All Types" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Types</SelectItem>
              {TYPES.map(t => <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={severityFilter || "__all__"} onValueChange={v => setSeverityFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-8 w-[120px] text-xs"><SelectValue placeholder="All Severity" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="info">Info</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter || "__all__"} onValueChange={v => setStatusFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-8 w-[120px] text-xs"><SelectValue placeholder="All Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="disputed">Disputed</SelectItem>
              <SelectItem value="waived">Waived</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search UPC, model, invoice, PO…"
              className="h-8 pl-8 text-xs"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          {(vendorFilter || typeFilter || severityFilter || statusFilter || searchQuery) && (
            <Button variant="ghost" size="sm" className="h-8 text-xs gap-1" onClick={() => {
              setVendorFilter(""); setTypeFilter(""); setSeverityFilter(""); setStatusFilter(""); setSearchQuery("");
            }}>
              <X className="h-3 w-3" /> Clear
            </Button>
          )}
        </div>

        {/* Bulk actions */}
        {selected.size > 0 && (
          <div className="flex items-center gap-3 p-2 rounded-md bg-accent/50 border border-border">
            <span className="text-xs font-medium">{selected.size} selected</span>
            <Button size="sm" className="h-7 text-xs" onClick={handleBulkResolve}>
              Mark All Resolved
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}

        {/* Discrepancy table */}
        <div className="rounded-lg border border-border bg-card overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="w-8">
                  <Checkbox
                    checked={selected.size === filtered.length && filtered.length > 0}
                    onCheckedChange={toggleSelectAll}
                  />
                </TableHead>
                <TableHead className="text-[10px] font-semibold cursor-pointer" onClick={() => toggleSort("severity")}>Severity</TableHead>
                <TableHead className="text-[10px] font-semibold cursor-pointer" onClick={() => toggleSort("discrepancy_type")}>Type</TableHead>
                <TableHead className="text-[10px] font-semibold cursor-pointer" onClick={() => toggleSort("vendor")}>Vendor</TableHead>
                <TableHead className="text-[10px] font-semibold">Brand</TableHead>
                <TableHead className="text-[10px] font-semibold">UPC</TableHead>
                <TableHead className="text-[10px] font-semibold">Model</TableHead>
                <TableHead className="text-[10px] font-semibold cursor-pointer" onClick={() => toggleSort("invoice_number")}>Invoice #</TableHead>
                <TableHead className="text-[10px] font-semibold">PO #</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Ord Qty</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Inv Qty</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Δ Qty</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Ord Price</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Inv Price</TableHead>
                <TableHead className="text-[10px] font-semibold text-right">Δ Price</TableHead>
                <TableHead className="text-[10px] font-semibold text-right cursor-pointer" onClick={() => toggleSort("amount_at_risk")}>$ at Risk</TableHead>
                <TableHead className="text-[10px] font-semibold cursor-pointer" onClick={() => toggleSort("resolution_status")}>Status</TableHead>
                <TableHead className="text-[10px] font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={18} className="text-center py-12 text-muted-foreground text-sm">
                    {loadingDisc ? "Loading…" : "No discrepancies found. Run reconciliation to check."}
                  </TableCell>
                </TableRow>
              ) : filtered.map(d => (
                <TableRow key={d.id} className="border-border hover:bg-accent/30">
                  <TableCell>
                    <Checkbox checked={selected.has(d.id)} onCheckedChange={() => toggleSelect(d.id)} />
                  </TableCell>
                  <TableCell><SeverityBadge severity={d.severity ?? "info"} /></TableCell>
                  <TableCell className="text-[10px] font-mono">{(d.discrepancy_type ?? "").replace(/_/g, " ")}</TableCell>
                  <TableCell className="text-[10px]">{d.vendor ?? "—"}</TableCell>
                  <TableCell className="text-[10px]">{d.brand ?? "—"}</TableCell>
                  <TableCell className="text-[10px] font-mono">{d.upc ?? "—"}</TableCell>
                  <TableCell className="text-[10px]">{d.model_number ?? "—"}</TableCell>
                  <TableCell className="text-[10px] font-mono">{d.invoice_number ?? "—"}</TableCell>
                  <TableCell className="text-[10px]">{d.po_number ?? "—"}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{d.ordered_qty ?? "—"}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{d.invoiced_qty ?? "—"}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{d.qty_delta ?? "—"}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{d.ordered_unit_price != null ? formatCurrency(Number(d.ordered_unit_price)) : "—"}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{d.invoiced_unit_price != null ? formatCurrency(Number(d.invoiced_unit_price)) : "—"}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{d.price_delta != null ? formatCurrency(Number(d.price_delta)) : "—"}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums font-semibold">{d.amount_at_risk != null ? formatCurrency(Number(d.amount_at_risk)) : "—"}</TableCell>
                  <TableCell><ResolutionBadge status={d.resolution_status ?? "open"} /></TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="h-6 text-[9px] px-1.5" onClick={() => { setResolveModal({ id: d.id, action: "resolved" }); setResolveNotes(""); }}>
                        Resolve
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 text-[9px] px-1.5" onClick={() => { setResolveModal({ id: d.id, action: "disputed" }); setResolveNotes(""); }}>
                        Dispute
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 text-[9px] px-1.5" onClick={() => { setResolveModal({ id: d.id, action: "waived" }); setResolveNotes(""); }}>
                        Waive
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Vendor Breakdown */}
        {vendorBreakdown.length > 0 && (
          <div>
            <h2 className="text-sm font-bold mb-3">Vendor Breakdown</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {vendorBreakdown.map(([vendor, data]) => {
                const pctClean = stats.totalChecked > 0 ? Math.round(((stats.totalChecked - data.total) / stats.totalChecked) * 100) : 100;
                return (
                  <Card key={vendor} className="bg-card border-border">
                    <CardContent className="p-4">
                      <p className="text-sm font-semibold truncate mb-2">{vendor}</p>
                      <div className="grid grid-cols-2 gap-y-1 text-[10px] text-muted-foreground mb-2">
                        <span>Discrepancies</span><span className="text-right font-medium text-foreground">{data.total}</span>
                        <span>$ at Risk</span><span className="text-right font-medium text-foreground">{formatCurrency(data.atRisk)}</span>
                        <span>Critical</span><span className="text-right font-medium text-destructive">{data.critical}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Progress value={pctClean} className="h-1.5 flex-1" />
                        <span className="text-[9px] text-muted-foreground">{pctClean}% clean</span>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* Run History */}
        <div>
          <h2 className="text-sm font-bold mb-3">Run History</h2>
          <div className="rounded-lg border border-border bg-card overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-[10px] font-semibold">Run #</TableHead>
                  <TableHead className="text-[10px] font-semibold">Run At</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">Invoices</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">PO Lines</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">Discrepancies</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">$ at Risk</TableHead>
                  <TableHead className="text-[10px] font-semibold">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground text-sm">No runs yet</TableCell></TableRow>
                ) : runs.map((r, i) => (
                  <TableRow key={r.id} className="border-border">
                    <TableCell className="text-[10px] font-mono">#{runs.length - i}</TableCell>
                    <TableCell className="text-[10px]">{formatDate(r.run_at)}</TableCell>
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

      {/* Resolution Modal */}
      <Dialog open={!!resolveModal} onOpenChange={o => !o && setResolveModal(null)}>
        <DialogContent className="bg-card border-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="capitalize">Mark as {resolveModal?.action}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={resolveNotes}
            onChange={e => setResolveNotes(e.target.value)}
            placeholder="Add resolution notes (optional)…"
            className="bg-secondary border-border min-h-[80px]"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setResolveModal(null)}>Cancel</Button>
            <Button size="sm" onClick={handleResolve} className="capitalize">{resolveModal?.action}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const config: Record<string, string> = {
    critical: "bg-destructive/15 text-destructive border-destructive/30",
    warning: "bg-amber-500/15 text-amber-600 border-amber-500/30",
    info: "bg-primary/15 text-primary border-primary/30",
  };
  return <Badge variant="outline" className={`text-[9px] font-medium ${config[severity] ?? config.info}`}>{severity}</Badge>;
}

function ResolutionBadge({ status }: { status: string }) {
  const config: Record<string, string> = {
    open: "bg-destructive/10 text-destructive border-destructive/30",
    resolved: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
    disputed: "bg-purple-500/15 text-purple-600 border-purple-500/30",
    waived: "bg-muted text-muted-foreground border-border",
  };
  return <Badge variant="outline" className={`text-[9px] font-medium ${config[status] ?? config.open}`}>{status}</Badge>;
}
