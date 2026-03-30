import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { formatCurrency, formatDate, type VendorInvoice } from "@/lib/supabase-queries";

interface Props {
  onOpenInvoice: (invoice: VendorInvoice) => void;
}

export function NeedsReviewQueue({ onOpenInvoice }: Props) {
  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ["needs_review_invoices"],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("vendor_invoices") as any)
        .select("*")
        .eq("terms_status" as any, "needs_review")
        .neq("doc_type", "proforma")
        .order("invoice_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as VendorInvoice[];
    },
  });

  if (isLoading) return <div className="text-xs text-muted-foreground p-4">Loading…</div>;
  if (invoices.length === 0) return null;

  // Group by vendor
  const byVendor = new Map<string, VendorInvoice[]>();
  for (const inv of invoices) {
    const list = byVendor.get(inv.vendor) || [];
    list.push(inv);
    byVendor.set(inv.vendor, list);
  }

  const totalValue = invoices.reduce((s, i) => s + i.total, 0);

  return (
    <div className="rounded-lg border-2 border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-500" />
          <h3 className="text-sm font-semibold">⚠️ Terms Review Queue</h3>
        </div>
        <span className="text-xs text-muted-foreground">
          {invoices.length} invoice{invoices.length !== 1 ? "s" : ""} · {formatCurrency(totalValue)} excluded from AP
        </span>
      </div>

      {[...byVendor.entries()].map(([vendor, vendorInvoices]) => (
        <div key={vendor} className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground">{vendor} ({vendorInvoices.length})</p>
          {vendorInvoices.map(inv => (
            <div key={inv.id} className="flex items-center justify-between text-xs p-2 rounded border border-border bg-card">
              <span className="font-mono">{inv.invoice_number}</span>
              <span className="text-muted-foreground">{formatDate(inv.invoice_date)}</span>
              <span className="font-medium tabular-nums">{formatCurrency(inv.total)}</span>
              <span className="text-muted-foreground/60 text-[10px] truncate max-w-[120px]">
                {inv.payment_terms || "No terms"}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="text-[10px] h-6 px-2"
                onClick={() => onOpenInvoice(inv)}
              >
                Review
              </Button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function NeedsReviewCount() {
  const { data: count = 0 } = useQuery({
    queryKey: ["needs_review_count"],
    queryFn: async () => {
      const { count, error } = await (supabase
        .from("vendor_invoices") as any)
        .select("id", { count: "exact", head: true })
        .eq("terms_status", "needs_review")
        .neq("doc_type", "proforma");
      if (error) return 0;
      return count ?? 0;
    },
  });

  if (count === 0) return null;
  return (
    <span className="ml-1 px-1 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-600 font-medium">
      ⚠️ {count}
    </span>
  );
}
