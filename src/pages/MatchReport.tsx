import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { fetchInvoices, formatCurrency } from "@/lib/supabase-queries";
import { runMatchReport, matchResultsToCSV, matchStatusConfig, type MatchStatus } from "@/lib/match-utils";

function MatchBadge({ status }: { status: string }) {
  const c = matchStatusConfig[status as MatchStatus] ?? { label: status, color: "bg-muted text-muted-foreground border-border" };
  return <Badge variant="outline" className={`text-[10px] font-medium whitespace-nowrap ${c.color}`}>{c.label}</Badge>;
}

export default function MatchReportPage() {
  const [selectedId, setSelectedId] = useState<string>("");

  const { data: invoiceData } = useQuery({
    queryKey: ["vendor_invoices_all_for_match"],
    queryFn: () => fetchInvoices({ perPage: 500, sortField: "invoice_date", sortDir: "desc" }),
  });

  const invoices = invoiceData?.data ?? [];
  const selectedInvoice = invoices.find(i => i.id === selectedId);

  const { data: results, isLoading } = useQuery({
    queryKey: ["match_report_full", selectedId],
    queryFn: () => runMatchReport(selectedInvoice!),
    enabled: !!selectedInvoice,
    staleTime: 5 * 60 * 1000,
  });

  const exportCSV = () => {
    if (!results || !selectedInvoice) return;
    const csv = matchResultsToCSV(selectedInvoice, results);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `match_report_${selectedInvoice.invoice_number}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Match report CSV exported");
  };

  const summary = results ? {
    total: results.length,
    matched: results.filter(r => r.status === "MATCHED").length,
    disco: results.filter(r => r.status === "DISCO").length,
    inN1: results.filter(r => r.status === "IN_N1").length,
    newSku: results.filter(r => r.status === "NEW_SKU").length,
    noUpc: results.filter(r => r.status === "NO_UPC").length,
    priceFlags: results.filter(r => r.priceFlag).length,
  } : null;

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-5">
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Match to Item Master</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
              <div className="flex-1 sm:max-w-md">
                <label className="text-xs text-muted-foreground mb-1 block">Select Invoice</label>
                <Select value={selectedId} onValueChange={setSelectedId}>
                  <SelectTrigger className="bg-secondary border-border text-xs">
                    <SelectValue placeholder="Choose an invoice…" />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border max-h-[300px]">
                    {invoices.map(inv => (
                      <SelectItem key={inv.id} value={inv.id} className="text-xs">
                        {inv.vendor} — {inv.invoice_number} — {inv.invoice_date}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {results && (
                <Button variant="outline" size="sm" className="text-xs h-8 w-full sm:w-auto" onClick={exportCSV}>
                  <Download className="h-3 w-3 mr-1" /> Export CSV
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Running match report…</span>
          </div>
        )}

        {summary && results && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              {[
                { label: "Total Items", value: summary.total, color: "text-foreground" },
                { label: "Matched", value: summary.matched, color: "text-status-paid" },
                { label: "Disco", value: summary.disco, color: "text-status-unpaid" },
                { label: "In N1", value: summary.inN1, color: "text-status-partial" },
                { label: "New SKU", value: summary.newSku, color: "text-status-disputed" },
                { label: "No UPC", value: summary.noUpc, color: "text-muted-foreground" },
                { label: "Price Flags", value: summary.priceFlags, color: summary.priceFlags > 0 ? "text-status-unpaid" : "text-muted-foreground" },
              ].map(s => (
                <Card key={s.label} className="bg-card border-border">
                  <CardContent className="p-3 text-center">
                    <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                    <p className="text-[10px] text-muted-foreground">{s.label}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card className="bg-card border-border">
              <CardContent className="p-0">
                <div className="overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border">
                        <TableHead className="text-[10px] font-semibold">Status</TableHead>
                        <TableHead className="text-[10px] font-semibold">UPC</TableHead>
                        <TableHead className="text-[10px] font-semibold">Model</TableHead>
                        <TableHead className="text-[10px] font-semibold">Brand</TableHead>
                        <TableHead className="text-[10px] font-semibold">Assortment</TableHead>
                        <TableHead className="text-[10px] font-semibold">Go Out</TableHead>
                        <TableHead className="text-[10px] font-semibold">Backstock</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Wholesale</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Invoice Price</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Qty</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Line Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {results.map((r, i) => (
                        <TableRow key={i} className={`border-border ${r.priceFlag ? "bg-status-unpaid/5" : ""}`}>
                          <TableCell className="py-1.5"><MatchBadge status={r.status} /></TableCell>
                          <TableCell className="text-[10px] font-mono">{r.lineItem.upc ?? "—"}</TableCell>
                          <TableCell className="text-[10px] font-mono">{r.lineItem.model ?? r.lineItem.item_number ?? "—"}</TableCell>
                          <TableCell className="text-[10px]">{r.lineItem.brand ?? "—"}</TableCell>
                          <TableCell className="text-[10px]">{r.assortmentRecord?.assortment ?? "—"}</TableCell>
                          <TableCell className="text-[10px]">{r.assortmentRecord?.backstock_location ?? "—"}</TableCell>
                          <TableCell className="text-[10px]">{r.assortmentRecord?.backstock_location ?? "—"}</TableCell>
                          <TableCell className="text-[10px] text-right tabular-nums">{formatCurrency(r.assortmentRecord?.wholesale)}</TableCell>
                          <TableCell className={`text-[10px] text-right tabular-nums ${r.priceFlag ? "text-status-unpaid font-bold" : ""}`}>
                            {formatCurrency(r.lineItem.unit_price)}{r.priceFlag && " ⚠"}
                          </TableCell>
                          <TableCell className="text-[10px] text-right tabular-nums">{r.lineItem.qty_shipped ?? r.lineItem.qty_ordered ?? r.lineItem.qty ?? "—"}</TableCell>
                          <TableCell className="text-[10px] text-right tabular-nums font-medium">{formatCurrency(r.lineItem.line_total)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {!selectedId && !isLoading && (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Search className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-sm">Select an invoice to run a match report</p>
          </div>
        )}
      </main>
    </div>
  );
}
