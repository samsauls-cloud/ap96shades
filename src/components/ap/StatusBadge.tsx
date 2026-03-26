import { Badge } from "@/components/ui/badge";
import type { InvoiceStatus } from "@/lib/supabase-queries";

const config: Record<InvoiceStatus, { label: string; className: string }> = {
  unpaid: { label: "Unpaid", className: "bg-amber-100 text-amber-800 hover:bg-amber-100 border-amber-200" },
  paid: { label: "Paid", className: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200" },
  disputed: { label: "Disputed", className: "bg-rose-100 text-rose-800 hover:bg-rose-100 border-rose-200" },
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  const c = config[status];
  return (
    <Badge variant="outline" className={c.className}>
      {c.label}
    </Badge>
  );
}
