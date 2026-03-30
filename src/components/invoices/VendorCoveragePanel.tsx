import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, PackageSearch, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/supabase-queries";

interface VendorCoverage {
  vendor_name: string;
  vendor_id: string;
  vendor_type: string;
  lines: number;
  ordered: number;
  received: number;
  outstanding: number;
  received_value: number;
}

export function VendorCoveragePanel() {
  const { data, isLoading } = useQuery({
    queryKey: ["vendor_coverage_audit"],
    queryFn: async () => {
      // Get alias map
      const { data: aliases } = await supabase
        .from("vendor_alias_map")
        .select("vendor_id, vendor_name");

      const aliasMap = new Map<string, string>();
      for (const a of aliases ?? []) {
        aliasMap.set(a.vendor_id, a.vendor_name);
      }

      // Get all receiving lines grouped
      const { data: lines } = await supabase
        .from("po_receiving_lines")
        .select("vendor_id, order_qty, received_qty, not_received_qty, received_cost");

      const groups = new Map<string, VendorCoverage>();
      for (const l of lines ?? []) {
        const vid = l.vendor_id ?? "UNMAPPED";
        const name = aliasMap.get(vid) ?? vid;
        const cur = groups.get(vid) ?? {
          vendor_name: name,
          vendor_id: vid,
          lines: 0,
          ordered: 0,
          received: 0,
          outstanding: 0,
          received_value: 0,
        };
        cur.lines++;
        cur.ordered += Number(l.order_qty) || 0;
        cur.received += Number(l.received_qty) || 0;
        cur.outstanding += Number(l.not_received_qty) || 0;
        cur.received_value += Number(l.received_cost) || 0;
        groups.set(vid, cur);
      }

      // Check for unmapped
      const unmapped = Array.from(groups.values()).filter(
        g => g.vendor_id === "UNMAPPED" || g.vendor_id === "" || !aliasMap.has(g.vendor_id)
      );

      // Check for Blenders (no invoices)
      const { count: blendersInvoices } = await supabase
        .from("vendor_invoices")
        .select("id", { count: "exact", head: true })
        .ilike("vendor", "%blenders%");

      return {
        vendors: Array.from(groups.values()).sort((a, b) => b.received_value - a.received_value),
        unmapped,
        blendersHasInvoices: (blendersInvoices ?? 0) > 0,
        blendersData: groups.get("blenders") ?? null,
      };
    },
  });

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

  const totalLines = data.vendors.reduce((s, v) => s + v.lines, 0);
  const totalValue = data.vendors.reduce((s, v) => s + v.received_value, 0);

  return (
    <div className="space-y-3">
      {/* Blenders warning */}
      {data.blendersData && !data.blendersHasInvoices && (
        <Card className="bg-card border-amber-500/30">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                  ⚠️ BLENDERS EYEWEAR — No Invoices in System
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {data.blendersData.lines} receiving lines · {data.blendersData.ordered} units ordered · {formatCurrency(data.blendersData.received_value)} received value.
                  Invoices expected but not yet uploaded. Upload when available to close this AP gap.
                </p>
                <Badge variant="outline" className="mt-2 text-[10px] border-amber-500/30 text-amber-600">
                  Terms unknown — needs_review until first invoice uploaded
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Unmapped warning */}
      {data.unmapped.length > 0 && data.unmapped.some(u => u.vendor_id === "UNMAPPED" || u.vendor_id === "") && (
        <Card className="bg-card border-destructive/30">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <span className="text-xs font-semibold text-destructive">
                Unknown/NULL vendor_id rows still exist
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground">
              {data.unmapped.filter(u => u.vendor_id === "UNMAPPED" || u.vendor_id === "").reduce((s, u) => s + u.lines, 0)} lines need manual vendor assignment.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Coverage table */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-semibold flex items-center gap-2">
            <PackageSearch className="h-4 w-4 text-primary" />
            Receiving Coverage by Vendor
            <Badge variant="outline" className="text-[10px] ml-auto">
              {totalLines} lines · {formatCurrency(totalValue)}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border">
                  <TableHead className="text-[10px] font-semibold">Vendor</TableHead>
                  <TableHead className="text-[10px] font-semibold">ID</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">Lines</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">Ordered</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">Received</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">Outstanding</TableHead>
                  <TableHead className="text-[10px] font-semibold text-right">Received Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.vendors.map(v => (
                  <TableRow key={v.vendor_id} className="border-border">
                    <TableCell className="text-xs font-medium">
                      <div className="flex items-center gap-1.5">
                        {v.vendor_name}
                        {(v.vendor_id === "UNMAPPED" || v.vendor_id === "") && (
                          <AlertTriangle className="h-3 w-3 text-destructive" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-[10px] font-mono text-muted-foreground">{v.vendor_id}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{v.lines}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{v.ordered}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{v.received}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {v.outstanding > 0 ? (
                        <span className="text-amber-500 font-semibold">{v.outstanding}</span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums font-medium">{formatCurrency(v.received_value)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-border bg-muted/30">
                  <TableCell className="text-xs font-bold" colSpan={2}>TOTAL</TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-bold">{totalLines}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-bold">{data.vendors.reduce((s, v) => s + v.ordered, 0)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-bold">{data.vendors.reduce((s, v) => s + v.received, 0)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-bold">{data.vendors.reduce((s, v) => s + v.outstanding, 0)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-bold">{formatCurrency(totalValue)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          {/* All clear badge */}
          {data.unmapped.filter(u => u.vendor_id === "UNMAPPED" || u.vendor_id === "").length === 0 && (
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-emerald-500">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Zero Unknown/NULL vendor_id rows — all receiving lines mapped ✓
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
