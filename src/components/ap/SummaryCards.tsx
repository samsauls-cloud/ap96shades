import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, Clock, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { VendorInvoice } from "@/lib/supabase-queries";

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

export function SummaryCards({ invoices }: { invoices: VendorInvoice[] }) {
  const totalAmount = invoices.reduce((s, i) => s + i.total, 0);
  const unpaid = invoices.filter((i) => i.status === "unpaid");
  const unpaidAmount = unpaid.reduce((s, i) => s + i.total, 0);
  const disputed = invoices.filter((i) => i.status === "disputed");
  const paidCount = invoices.filter((i) => i.status === "paid").length;

  const cards = [
    { label: "Total Invoices", value: formatCurrency(totalAmount), sub: `${invoices.length} invoices`, icon: DollarSign, color: "text-primary" },
    { label: "Unpaid", value: formatCurrency(unpaidAmount), sub: `${unpaid.length} pending`, icon: Clock, color: "text-amber-600" },
    { label: "Disputed", value: `${disputed.length}`, sub: formatCurrency(disputed.reduce((s, i) => s + i.total, 0)), icon: AlertTriangle, color: "text-rose-600" },
    { label: "Paid", value: `${paidCount}`, sub: "completed", icon: CheckCircle2, color: "text-emerald-600" },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c) => (
        <Card key={c.label} className="border bg-card">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{c.label}</p>
                <p className="text-2xl font-bold mt-1">{c.value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{c.sub}</p>
              </div>
              <c.icon className={`h-8 w-8 ${c.color} opacity-80`} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
