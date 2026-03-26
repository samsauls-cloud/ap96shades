import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Package } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge, DocTypeBadge } from "./Badges";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency, formatDate, getTotalUnits, type VendorInvoice } from "@/lib/supabase-queries";

interface POGroup {
  poNumber: string;
  vendor: string;
  invoices: VendorInvoice[];
  totalInvoiced: number;
  dateRange: string;
}

export function POView({ onRowClick }: { onRowClick: (inv: VendorInvoice) => void }) {
  const [expandedPO, setExpandedPO] = useState<string | null>(null);

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ["vendor_invoices_po_view"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vendor_invoices")
        .select("*")
        .not("po_number", "is", null)
        .neq("po_number", "")
        .order("invoice_date", { ascending: false });
      if (error) throw error;
      return data as VendorInvoice[];
    },
  });

  // Group by PO + vendor
  const groups: POGroup[] = [];
  const groupMap = new Map<string, VendorInvoice[]>();
  for (const inv of invoices) {
    const key = `${inv.po_number}|${inv.vendor}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(inv);
  }

  for (const [key, invs] of groupMap) {
    const [poNumber, vendor] = key.split("|");
    const totalInvoiced = invs.reduce((sum, inv) => sum + Number(inv.total), 0);
    const dates = invs.map(inv => inv.invoice_date).sort();
    const dateRange = dates.length === 1
      ? formatDate(dates[0])
      : `${formatDate(dates[0])} — ${formatDate(dates[dates.length - 1])}`;
    groups.push({ poNumber, vendor, invoices: invs, totalInvoiced, dateRange });
  }

  groups.sort((a, b) => b.invoices.length - a.invoices.length);

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <Package className="h-8 w-8 mb-2 opacity-50" />
        <p className="text-base font-medium">No PO-linked invoices found</p>
        <p className="text-sm">Invoices with PO numbers will appear here grouped by PO.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {groups.map(group => {
        const isExpanded = expandedPO === `${group.poNumber}|${group.vendor}`;
        return (
          <Card key={`${group.poNumber}|${group.vendor}`} className="bg-card border-border">
            <CardContent className="p-0">
              <button
                className="w-full p-4 flex items-center justify-between hover:bg-accent/50 transition-colors"
                onClick={() => setExpandedPO(isExpanded ? null : `${group.poNumber}|${group.vendor}`)}
              >
                <div className="flex items-center gap-3">
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <div className="text-left">
                    <p className="text-sm font-medium">
                      PO {group.poNumber} — <span className="text-muted-foreground">{group.vendor}</span>
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {group.invoices.length} invoice{group.invoices.length > 1 ? "s" : ""} · {group.dateRange}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold tabular-nums">{formatCurrency(group.totalInvoiced)}</p>
                  <p className="text-[10px] text-muted-foreground">total invoiced</p>
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-border">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="text-[10px] font-semibold">Type</TableHead>
                        <TableHead className="text-[10px] font-semibold">Invoice #</TableHead>
                        <TableHead className="text-[10px] font-semibold">Date</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Units</TableHead>
                        <TableHead className="text-[10px] font-semibold text-right">Total</TableHead>
                        <TableHead className="text-[10px] font-semibold">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.invoices.map(inv => (
                        <TableRow
                          key={inv.id}
                          className="border-border cursor-pointer hover:bg-accent/50 transition-colors"
                          onClick={() => onRowClick(inv)}
                        >
                          <TableCell><DocTypeBadge docType={inv.doc_type} /></TableCell>
                          <TableCell className="font-mono text-xs">{inv.invoice_number}</TableCell>
                          <TableCell className="text-xs">{formatDate(inv.invoice_date)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums">{getTotalUnits(inv)}</TableCell>
                          <TableCell className="text-right font-semibold text-sm tabular-nums">{formatCurrency(inv.total)}</TableCell>
                          <TableCell><StatusBadge status={inv.status} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
