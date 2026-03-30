import { Badge } from "@/components/ui/badge";
import type { InvoiceStatus, DocType } from "@/lib/supabase-queries";
import { isProforma } from "@/lib/supabase-queries";

const statusConfig: Record<InvoiceStatus, { label: string; className: string }> = {
  unpaid: { label: "Unpaid", className: "bg-status-unpaid/15 text-status-unpaid border-status-unpaid/30" },
  paid: { label: "Paid", className: "bg-status-paid/15 text-status-paid border-status-paid/30" },
  partial: { label: "Partial", className: "bg-status-partial/15 text-status-partial border-status-partial/30" },
  disputed: { label: "Disputed", className: "bg-status-disputed/15 text-status-disputed border-status-disputed/30" },
};

const docTypeConfig: Record<string, { label: string; className: string }> = {
  INVOICE: { label: "INV", className: "bg-doc-invoice/15 text-doc-invoice border-doc-invoice/30" },
  PO: { label: "PO", className: "bg-doc-po/15 text-doc-po border-doc-po/30" },
  proforma: { label: "proforma", className: "bg-muted text-muted-foreground border-border opacity-70" },
};

const reconStatusConfig: Record<string, { label: string; className: string }> = {
  unreconciled: { label: "⬜ Unreconciled", className: "bg-muted text-muted-foreground border-border" },
  pending: { label: "—", className: "bg-muted text-muted-foreground border-border" },
  clean: { label: "✅ Clean", className: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30" },
  stale: { label: "⟳ Stale", className: "bg-amber-500/15 text-amber-600 border-amber-500/30" },
  discrepancy: { label: "⚠ Issues", className: "bg-destructive/15 text-destructive border-destructive/30" },
  in_progress: { label: "🔄 In Progress", className: "bg-blue-500/15 text-blue-600 border-blue-500/30" },
  reconciled: { label: "✅ Reconciled", className: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30" },
  credit_pending: { label: "⚠ Credit Pending", className: "bg-amber-500/15 text-amber-600 border-amber-500/30" },
  credit_requested: { label: "📤 Credit Requested", className: "bg-orange-500/15 text-orange-600 border-orange-500/30" },
  credit_approved: { label: "✓ Credit Approved", className: "bg-blue-500/15 text-blue-600 border-blue-500/30" },
  paid: { label: "💰 Paid", className: "bg-muted text-muted-foreground border-border" },
};

export function StatusBadge({ status, docType }: { status: string; docType?: string }) {
  if (docType && isProforma({ doc_type: docType })) {
    return <Badge variant="outline" className="text-xs font-medium bg-muted text-muted-foreground border-border opacity-70">N/A</Badge>;
  }
  const c = statusConfig[status as InvoiceStatus] ?? { label: status, className: "bg-muted text-muted-foreground border-border" };
  return <Badge variant="outline" className={`text-xs font-medium ${c.className}`}>{c.label}</Badge>;
}

export function DocTypeBadge({ docType }: { docType: string }) {
  if (isProforma({ doc_type: docType })) {
    return <Badge variant="outline" className="text-xs font-semibold bg-muted text-muted-foreground border-border opacity-70">proforma</Badge>;
  }
  const c = docTypeConfig[docType] ?? { label: docType, className: "bg-muted text-muted-foreground border-border" };
  return <Badge variant="outline" className={`text-xs font-semibold ${c.className}`}>{c.label}</Badge>;
}

export function ReconStatusBadge({ status, isStale, staleReason }: { status: string; isStale?: boolean; staleReason?: string | null }) {
  // If stale and was clean, show stale badge
  const effectiveStatus = isStale && status === "clean" ? "stale" : status;
  const c = reconStatusConfig[effectiveStatus] ?? reconStatusConfig.unreconciled;
  return (
    <Badge
      variant="outline"
      className={`text-[10px] font-medium ${c.className}`}
      title={isStale ? (staleReason ?? "Data changed since last reconciliation") : undefined}
    >
      {c.label}
    </Badge>
  );
}
