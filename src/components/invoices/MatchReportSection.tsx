import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { VendorInvoice } from "@/lib/supabase-queries";
import { formatCurrency } from "@/lib/supabase-queries";
import { runMatchReport, matchResultsToCSV, matchStatusConfig, type MatchStatus } from "@/lib/match-utils";

interface Props {
  invoice: VendorInvoice;
}

function MatchBadge({ status }: { status: string }) {
  const c = matchStatusConfig[status as MatchStatus] ?? { label: status, color: "bg-muted text-muted-foreground border-border" };
  return <Badge variant="outline" className={`text-[9px] font-medium whitespace-nowrap ${c.color}`}>{c.label}</Badge>;
}

export function MatchReportSection({ invoice }: Props) {
  const { data: results, isLoading, refetch } = useQuery({
    queryKey: ["match_report", invoice.id],
    queryFn: () => runMatchReport(invoice),
    staleTime: 5 * 60 * 1000,
  });

  const exportCSV = () => {
    if (!results) return;
    const csv = matchResultsToCSV(invoice, results);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `match_report_${invoice.invoice_number}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Match report CSV exported");
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Running match report…
      </div>
    );
  }

  if (!results || results.length === 0) {
    return <p className="text-xs text-muted-foreground py-2">No line items to match</p>;
  }

  const summary = {
    matched: results.filter(r => r.status === "MATCHED").length,
    disco: results.filter(r => r.status === "DISCO").length,
    inN1: results.filter(r => r.status === "IN_N1").length,
    newSku: results.filter(r => r.status === "NEW_SKU").length,
    noUpc: results.filter(r => r.status === "NO_UPC").length,
    priceFlags: results.filter(r => r.priceFlag).length,
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-muted-foreground">Match Report ({results.length} items)</h3>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => refetch()}>
            <RefreshCw className="h-3 w-3 mr-1" /> Refresh
          </Button>
          <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={exportCSV}>
            <Download className="h-3 w-3 mr-1" /> Export CSV
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <span className="text-[10px] text-status-paid font-medium">{summary.matched} Matched</span>
        <span className="text-[10px] text-status-unpaid font-medium">{summary.disco} Disco</span>
        <span className="text-[10px] text-status-partial font-medium">{summary.inN1} In N1</span>
        <span className="text-[10px] text-status-disputed font-medium">{summary.newSku} New SKU</span>
        <span className="text-[10px] text-muted-foreground font-medium">{summary.noUpc} No UPC</span>
        {summary.priceFlags > 0 && (
          <span className="text-[10px] text-status-unpaid font-bold">⚠ {summary.priceFlags} Price Flags</span>
        )}
      </div>

      <div className="rounded border border-border overflow-auto max-h-[300px]">
        <Table>
          <TableHeader>
            <TableRow className="border-border">
              <TableHead className="text-[9px] font-semibold">Status</TableHead>
              <TableHead className="text-[9px] font-semibold">UPC</TableHead>
              <TableHead className="text-[9px] font-semibold">Model</TableHead>
              <TableHead className="text-[9px] font-semibold">Brand</TableHead>
              <TableHead className="text-[9px] font-semibold">Assortment</TableHead>
              <TableHead className="text-[9px] font-semibold">Location</TableHead>
              <TableHead className="text-[9px] font-semibold text-right">Wholesale</TableHead>
              <TableHead className="text-[9px] font-semibold text-right">Invoice</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((r, i) => (
              <TableRow key={i} className={`border-border ${r.priceFlag ? "bg-status-unpaid/5" : ""}`}>
                <TableCell className="py-1"><MatchBadge status={r.status} /></TableCell>
                <TableCell className="text-[10px] font-mono">{r.lineItem.upc ?? "—"}</TableCell>
                <TableCell className="text-[10px] font-mono">{r.lineItem.model ?? r.lineItem.item_number ?? "—"}</TableCell>
                <TableCell className="text-[10px]">{r.lineItem.brand ?? "—"}</TableCell>
                <TableCell className="text-[10px]">{r.assortmentRecord?.assortment ?? "—"}</TableCell>
                <TableCell className="text-[10px]">{r.assortmentRecord?.go_out_location ?? "—"}</TableCell>
                <TableCell className="text-[10px] text-right tabular-nums">{formatCurrency(r.assortmentRecord?.wholesale)}</TableCell>
                <TableCell className={`text-[10px] text-right tabular-nums ${r.priceFlag ? "text-status-unpaid font-bold" : ""}`}>
                  {formatCurrency(r.lineItem.unit_price)}{r.priceFlag && " ⚠"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
