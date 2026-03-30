import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, FileText, FileCheck, Package, ShoppingCart, AlertCircle } from "lucide-react";
import type { InvoiceStats } from "@/lib/supabase-queries";
import { formatCurrency } from "@/lib/supabase-queries";

export function StatsBar({ stats }: { stats: InvoiceStats | undefined }) {
  const s = stats ?? {
    total_documents: 0, total_invoices: 0, total_pos: 0,
    total_ap_value: 0, total_units: 0, unpaid_balance: 0,
    needs_review_count: 0, needs_review_value: 0,
  };

  const items = [
    { label: "Total AP Value", value: formatCurrency(s.total_ap_value), icon: DollarSign, accent: "text-primary" },
    { label: "Total Documents", value: s.total_documents.toString(), icon: FileText, accent: "text-muted-foreground" },
    { label: "Invoices", value: s.total_invoices.toString(), icon: FileCheck, accent: "text-doc-invoice" },
    { label: "POs", value: s.total_pos.toString(), icon: ShoppingCart, accent: "text-doc-po" },
    { label: "Total Units", value: Number(s.total_units).toLocaleString(), icon: Package, accent: "text-primary" },
    { label: "Unpaid Balance", value: formatCurrency(s.unpaid_balance), icon: AlertCircle, accent: "text-status-unpaid" },
    ...(s.needs_review_count > 0 ? [{ label: "⚠️ Needs Review", value: `${s.needs_review_count} (${formatCurrency(s.needs_review_value)})`, icon: AlertCircle, accent: "text-amber-500" }] : []),
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {items.map(item => (
        <Card key={item.label} className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{item.label}</span>
              <item.icon className={`h-3.5 w-3.5 ${item.accent} opacity-70`} />
            </div>
            <p className="text-lg font-bold tracking-tight">{item.value}</p>
            <p className="text-[9px] text-muted-foreground/60 mt-0.5">
              across all {s.total_documents} documents
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
