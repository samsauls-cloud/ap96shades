import { Badge } from "@/components/ui/badge";
import type { InvoiceStatus, DocType } from "@/lib/supabase-queries";

const statusConfig: Record<InvoiceStatus, { label: string; className: string }> = {
  unpaid: { label: "Unpaid", className: "bg-status-unpaid/15 text-status-unpaid border-status-unpaid/30" },
  paid: { label: "Paid", className: "bg-status-paid/15 text-status-paid border-status-paid/30" },
  partial: { label: "Partial", className: "bg-status-partial/15 text-status-partial border-status-partial/30" },
  disputed: { label: "Disputed", className: "bg-status-disputed/15 text-status-disputed border-status-disputed/30" },
};

const docTypeConfig: Record<string, { label: string; className: string }> = {
  INVOICE: { label: "INV", className: "bg-doc-invoice/15 text-doc-invoice border-doc-invoice/30" },
  PO: { label: "PO", className: "bg-doc-po/15 text-doc-po border-doc-po/30" },
};

export function StatusBadge({ status }: { status: string }) {
  const c = statusConfig[status as InvoiceStatus] ?? { label: status, className: "bg-muted text-muted-foreground border-border" };
  return <Badge variant="outline" className={`text-xs font-medium ${c.className}`}>{c.label}</Badge>;
}

export function DocTypeBadge({ docType }: { docType: string }) {
  const c = docTypeConfig[docType] ?? { label: docType, className: "bg-muted text-muted-foreground border-border" };
  return <Badge variant="outline" className={`text-xs font-semibold ${c.className}`}>{c.label}</Badge>;
}
