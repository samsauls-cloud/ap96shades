import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle, CheckCircle2, Clock, FileText, PackageCheck,
  Loader2, Zap, Link2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabase-fetch-all";
import { formatCurrency, formatDate } from "@/lib/supabase-queries";
import { runAndPersistMatches } from "@/lib/match-engine";
import { toast } from "sonner";

/* ── Vendor summary row type ── */
interface VendorMatchSummary {
  vendor: string;
  totalInvoices: number;
  matched: number;
  matchedException: number;
  waitingReceipt: number;
  pendingReview: number;
  receiptsWaitingInvoice: number;
  matchedValue: number;
  waitingValue: number;
  exceptionValue: number;
}

export function MatchStatusPanel() {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["two_way_match_status"],
    queryFn: async () => {
      const [invoices, receiving, aliases] = await Promise.all([
        fetchAllRows("vendor_invoices"),
        fetchAllRows("po_receiving_lines"),
        supabase.from("vendor_alias_map").select("vendor_id, vendor_name, vendor_type").then(r => r.data ?? []),
      ]);

      const accessoryIds = new Set(
        (aliases as any[]).filter(a => a.vendor_type === "accessories").map(a => a.vendor_id)
      );

      const matchableInvoices = (invoices as any[]).filter(
        i => i.doc_type === "INVOICE" && i.terms_status !== "proforma"
      );
      const matchableReceipts = (receiving as any[]).filter(
        l => !accessoryIds.has(l.vendor_id)
      );

      // Build vendor summary
      const vendorMap = new Map<string, VendorMatchSummary>();
      const ensureVendor = (v: string) => {
        if (!vendorMap.has(v)) vendorMap.set(v, {
          vendor: v, totalInvoices: 0, matched: 0, matchedException: 0, waitingReceipt: 0,
          pendingReview: 0, receiptsWaitingInvoice: 0, matchedValue: 0, waitingValue: 0, exceptionValue: 0,
        });
        return vendorMap.get(v)!;
      };

      // Invoice side
      const waitingInvoices: any[] = [];
      for (const inv of matchableInvoices) {
        const vs = ensureVendor(inv.vendor);
        vs.totalInvoices++;
        const ms = inv.match_status ?? "unmatched";
        if (ms === "matched") { vs.matched++; vs.matchedValue += Number(inv.total) || 0; }
        else if (ms === "matched_exception") { vs.matchedException++; vs.exceptionValue += Number(inv.total) || 0; }
        else if (ms === "pending_review") { vs.pendingReview++; vs.waitingValue += Number(inv.total) || 0; }
        else { vs.waitingReceipt++; vs.waitingValue += Number(inv.total) || 0; waitingInvoices.push(inv); }
      }

      // Receipt side — group by vendor_id + session
      const unmatchedByVendor = new Map<string, { lines: number; units: number; value: number; orderedValue: number; sessions: Set<string> }>();
      const waitingReceipts: any[] = [];
      for (const l of matchableReceipts) {
        const ms = l.invoice_match_status ?? "unmatched";
        if (ms !== "unmatched") continue;
        const vid = l.vendor_id ?? "UNKNOWN";
        // Map vendor_id to vendor_name
        const alias = (aliases as any[]).find(a => a.vendor_id === vid);
        const vname = alias?.vendor_name ?? vid;
        if (!unmatchedByVendor.has(vname)) unmatchedByVendor.set(vname, { lines: 0, units: 0, value: 0, orderedValue: 0, sessions: new Set() });
        const g = unmatchedByVendor.get(vname)!;
        g.lines++;
        g.units += Number(l.received_qty) || 0;
        g.value += Number(l.received_cost) || Number(l.unit_cost) || 0;
        g.orderedValue += Number(l.ordered_cost) || 0;
        if (l.session_id) g.sessions.add(l.session_id);
        waitingReceipts.push(l);
      }

      // Update receiptsWaitingInvoice on vendor summaries
      for (const [vname, g] of unmatchedByVendor) {
        const vs = ensureVendor(vname);
        vs.receiptsWaitingInvoice = g.sessions.size;
      }

      const vendorSummaries = Array.from(vendorMap.values()).sort((a, b) => b.totalInvoices - a.totalInvoices);

      const totalMatchedValue = vendorSummaries.reduce((s, v) => s + v.matchedValue, 0);
      const totalWaitingValue = vendorSummaries.reduce((s, v) => s + v.waitingValue, 0);
      const totalReceiptsWaitingValue = Array.from(unmatchedByVendor.values()).reduce((s, g) => s + g.value, 0);

      return {
        vendorSummaries,
        waitingInvoices,
        unmatchedByVendor: Array.from(unmatchedByVendor.entries()).map(([v, g]) => ({
          vendor: v, lines: g.lines, units: g.units, value: g.value,
          orderedValue: g.orderedValue, sessions: g.sessions.size,
        })).sort((a, b) => b.value - a.value),
        totalMatchedValue,
        totalWaitingValue,
        totalReceiptsWaitingValue,
        totalMatched: vendorSummaries.reduce((s, v) => s + v.matched, 0),
        totalInvoices: matchableInvoices.length,
      };
    },
  });

  const handleRunEngine = async () => {
    setRunning(true);
    try {
      const result = await runAndPersistMatches();
      toast.success(
        `Match engine complete: ${result.saved} new matches found. ${result.stats.invoicesWaiting} invoices waiting, ${result.stats.receiptsWaiting} receipts waiting.`
      );
      refetch();
      qc.invalidateQueries({ queryKey: ["audit_invoices"] });
    } catch (err: any) {
      toast.error(`Match engine failed: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  if (isLoading) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const matchRate = data.totalInvoices > 0 ? (data.totalMatched / data.totalInvoices * 100) : 0;

  const cellColor = (waiting: number) =>
    waiting === 0 ? "text-emerald-500" : waiting <= 3 ? "text-amber-500" : "text-destructive";

  return (
    <div className="space-y-3">
      {/* Run engine button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge className={`text-[10px] ${matchRate >= 90 ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30" : matchRate >= 70 ? "bg-amber-500/15 text-amber-600 border-amber-500/30" : "bg-destructive/15 text-destructive border-destructive/30"}`}>
            {matchRate.toFixed(1)}% Match Rate
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            {data.totalMatched} of {data.totalInvoices} invoices matched to receipts
          </span>
        </div>
        <Button size="sm" variant="outline" className="text-xs h-7 gap-1.5" onClick={handleRunEngine} disabled={running}>
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
          {running ? "Running…" : "Run Match Engine"}
        </Button>
      </div>

      {/* Summary totals */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="bg-card border-emerald-500/30">
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Fully Matched</p>
            <p className="text-sm font-bold text-emerald-500">{formatCurrency(data.totalMatchedValue)}</p>
          </CardContent>
        </Card>
        <Card className="bg-card border-amber-500/30">
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Invoices Waiting for Receipt</p>
            <p className="text-sm font-bold text-amber-500">{formatCurrency(data.totalWaitingValue)}</p>
          </CardContent>
        </Card>
        <Card className="bg-card border-primary/30">
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Receipts Waiting for Invoice</p>
            <p className="text-sm font-bold">{formatCurrency(data.totalReceiptsWaitingValue)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Vendor match summary table */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-semibold flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" />
            Match Status by Vendor
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border">
                  <TableHead className="text-[10px] font-semibold">Vendor</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">Invoices</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">Matched</TableHead>
                    <TableHead className="text-[10px] font-semibold text-right">Waiting Receipt</TableHead>
                    <TableHead className="text-[10px] font-semibold text-right">Exceptions</TableHead>
                    <TableHead className="text-[10px] font-semibold text-right">Pending Review</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.vendorSummaries.map(v => (
                  <TableRow key={v.vendor} className="border-border">
                    <TableCell className="text-xs font-medium">{v.vendor}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{v.totalInvoices}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums text-emerald-500 font-semibold">{v.matched}</TableCell>
                    <TableCell className={`text-xs text-right tabular-nums font-semibold ${cellColor(v.waitingReceipt)}`}>{v.waitingReceipt}</TableCell>
                    <TableCell className={`text-xs text-right tabular-nums font-semibold ${cellColor(v.pendingReview)}`}>{v.pendingReview}</TableCell>
                    <TableCell className={`text-xs text-right tabular-nums font-semibold ${cellColor(v.receiptsWaitingInvoice)}`}>{v.receiptsWaitingInvoice}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* QUEUE 1: Invoices waiting for receipt */}
      {data.waitingInvoices.length > 0 && (
        <Card className="bg-card border-amber-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold flex items-center gap-2 text-amber-500">
              <Clock className="h-4 w-4" />
              ⏳ Invoices Waiting for Receipt ({data.waitingInvoices.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <p className="text-[10px] text-muted-foreground px-4 pb-2">
              Upload Lightspeed receiving CSV to match these invoices
            </p>
            <div className="max-h-[300px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border">
                    <TableHead className="text-[10px] font-semibold">Vendor</TableHead>
                    <TableHead className="text-[10px] font-semibold">Invoice #</TableHead>
                    <TableHead className="text-[10px] font-semibold">PO #</TableHead>
                    <TableHead className="text-[10px] font-semibold">Date</TableHead>
                    <TableHead className="text-[10px] font-semibold text-right">Total</TableHead>
                    <TableHead className="text-[10px] font-semibold text-right">Days Waiting</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.waitingInvoices
                    .sort((a: any, b: any) => {
                      const da = new Date(a.invoice_date).getTime();
                      const db = new Date(b.invoice_date).getTime();
                      return da - db;
                    })
                    .map((inv: any) => {
                      const days = Math.floor((Date.now() - new Date(inv.invoice_date).getTime()) / 86400000);
                      return (
                        <TableRow key={inv.id} className="border-border">
                          <TableCell className="text-xs">{inv.vendor}</TableCell>
                          <TableCell className="text-xs font-mono">{inv.invoice_number}</TableCell>
                          <TableCell className="text-xs font-mono text-muted-foreground">{inv.po_number || "—"}</TableCell>
                          <TableCell className="text-xs">{formatDate(inv.invoice_date)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums font-medium">{formatCurrency(inv.total)}</TableCell>
                          <TableCell className={`text-xs text-right tabular-nums font-semibold ${days > 30 ? "text-destructive" : days > 14 ? "text-amber-500" : "text-muted-foreground"}`}>
                            {days}d
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* QUEUE 2: Receipts waiting for invoice */}
      {data.unmatchedByVendor.length > 0 && (
        <Card className="bg-card border-primary/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold flex items-center gap-2">
              <PackageCheck className="h-4 w-4 text-primary" />
              ⏳ Receipts Waiting for Invoice ({data.unmatchedByVendor.reduce((s, v) => s + v.sessions, 0)} sessions)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <p className="text-[10px] text-muted-foreground px-4 pb-2">
              Upload vendor invoices to match these receiving sessions
            </p>
            <div className="max-h-[300px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border">
                    <TableHead className="text-[10px] font-semibold">Vendor</TableHead>
                    <TableHead className="text-[10px] font-semibold text-right">Sessions</TableHead>
                    <TableHead className="text-[10px] font-semibold text-right">Lines</TableHead>
                    <TableHead className="text-[10px] font-semibold text-right">Units</TableHead>
                    <TableHead className="text-[10px] font-semibold text-right">Received Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.unmatchedByVendor.map(v => (
                    <TableRow key={v.vendor} className="border-border">
                      <TableCell className="text-xs font-medium">{v.vendor}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{v.sessions}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{v.lines}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{v.units}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums font-medium">{formatCurrency(v.value)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-border bg-muted/30">
                    <TableCell className="text-xs font-bold">TOTAL</TableCell>
                    <TableCell className="text-xs text-right tabular-nums font-bold">{data.unmatchedByVendor.reduce((s, v) => s + v.sessions, 0)}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums font-bold">{data.unmatchedByVendor.reduce((s, v) => s + v.lines, 0)}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums font-bold">{data.unmatchedByVendor.reduce((s, v) => s + v.units, 0)}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums font-bold">{formatCurrency(data.totalReceiptsWaitingValue)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* All matched badge */}
      {data.waitingInvoices.length === 0 && data.unmatchedByVendor.length === 0 && (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-emerald-500">
          <CheckCircle2 className="h-3.5 w-3.5" />
          All invoices and receipts are fully matched ✓
        </div>
      )}
    </div>
  );
}
