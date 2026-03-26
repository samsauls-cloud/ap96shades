import { CheckCircle2, Clock, AlertCircle, Ban, AlertTriangle, CircleDollarSign } from "lucide-react";
import { formatCurrency } from "@/lib/supabase-queries";
import { type InvoicePayment, isOverdue, getDaysOverdue } from "@/lib/payment-queries";

interface Props {
  payment: InvoicePayment;
  compact?: boolean;
}

const STATUS_CONFIG: Record<string, { icon: any; label: string; classes: string }> = {
  unpaid: { icon: Clock, label: "UNPAID", classes: "bg-red-500/15 text-red-500 border-red-500/30" },
  partial: { icon: CircleDollarSign, label: "PARTIAL", classes: "bg-blue-500/15 text-blue-500 border-blue-500/30" },
  paid: { icon: CheckCircle2, label: "PAID ✓", classes: "bg-green-500/15 text-green-500 border-green-500/30" },
  overpaid: { icon: AlertTriangle, label: "OVERPAID", classes: "bg-purple-500/15 text-purple-500 border-purple-500/30" },
  disputed: { icon: AlertCircle, label: "DISPUTED", classes: "bg-orange-500/15 text-orange-500 border-orange-500/30" },
  void: { icon: Ban, label: "VOID", classes: "bg-muted text-muted-foreground border-border" },
};

export function PaymentStatusBadge({ payment, compact }: Props) {
  const overdue = isOverdue(payment.due_date, payment.payment_status);
  const status = payment.payment_status;
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.unpaid;
  const Icon = overdue && status !== "void" ? AlertCircle : config.icon;

  let label = config.label;
  let classes = config.classes;

  if (overdue) {
    const days = getDaysOverdue(payment.due_date);
    label = compact ? `🔴 ${days}d` : `OVERDUE — ${days} days past due`;
    classes = "bg-red-500/15 text-red-500 border-red-500/30";
  } else if (status === "partial" && !compact) {
    label = `PARTIAL — ${formatCurrency(payment.balance_remaining)} remaining`;
  } else if (status === "overpaid" && !compact) {
    label = `OVERPAID +${formatCurrency(Math.abs(payment.balance_remaining))}`;
  }

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${classes}`}>
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}
