import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, FileText, FileCheck, Package, ShoppingCart, AlertCircle } from "lucide-react";
import type { VendorInvoice } from "@/lib/supabase-queries";
import { formatCurrency, getTotalUnits } from "@/lib/supabase-queries";

export function StatsBar({ invoices, totalCount }: { invoices: VendorInvoice[]; totalCount: number }) {
  const totalAP = invoices.reduce((s, i) => s + (i.total ?? 0), 0);
  const invoiceCount = invoices.filter(i => i.doc_type === "INVOICE").length;
  const poCount = invoices.filter(i => i.doc_type === "PO").length;
  const totalUnits = invoices.reduce((s, i) => s + getTotalUnits(i), 0);
  const unpaidBalance = invoices.filter(i => i.status === "unpaid" || i.status === "partial").reduce((s, i) => s + (i.total ?? 0), 0);

  const stats = [
    { label: "Total AP Value", value: formatCurrency(totalAP), icon: DollarSign, accent: "text-primary" },
    { label: "Total Documents", value: totalCount.toString(), icon: FileText, accent: "text-muted-foreground" },
    { label: "Invoices", value: invoiceCount.toString(), icon: FileCheck, accent: "text-doc-invoice" },
    { label: "POs", value: poCount.toString(), icon: ShoppingCart, accent: "text-doc-po" },
    { label: "Total Units", value: totalUnits.toLocaleString(), icon: Package, accent: "text-primary" },
    { label: "Unpaid Balance", value: formatCurrency(unpaidBalance), icon: AlertCircle, accent: "text-status-unpaid" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {stats.map(s => (
        <Card key={s.label} className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{s.label}</span>
              <s.icon className={`h-3.5 w-3.5 ${s.accent} opacity-70`} />
            </div>
            <p className="text-lg font-bold tracking-tight">{s.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
