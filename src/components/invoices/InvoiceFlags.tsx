import { Badge } from "@/components/ui/badge";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { FileX, Clock, DollarSign, AlertCircle } from "lucide-react";
import type { VendorInvoice } from "@/lib/supabase-queries";
import { isProforma } from "@/lib/supabase-queries";

interface Props {
  invoice: VendorInvoice;
}

export function InvoiceFlags({ invoice: inv }: Props) {
  if (isProforma(inv)) return null;

  const flags: { icon: React.ReactNode; label: string; tooltip: string; className: string }[] = [];

  if ((inv as any).terms_status === "needs_review") {
    flags.push({
      icon: <Clock className="h-3 w-3" />,
      label: "Terms",
      tooltip: "Payment terms could not be confirmed from this invoice. " +
               "Open the invoice to review and confirm the payment terms " +
               "so a payment schedule can be generated.",
      className: "bg-amber-500/15 text-amber-600 border-amber-500/30",
    });
  }

  if ((inv as any).terms_confidence === "medium" && (inv as any).terms_status === "confirmed") {
    flags.push({
      icon: <AlertCircle className="h-3 w-3" />,
      label: "Verify Terms",
      tooltip: "Payment terms were interpreted from context but not stated " +
               "explicitly on the invoice. Please verify the terms are correct " +
               "before payment.",
      className: "bg-amber-500/15 text-amber-600 border-amber-500/30",
    });
  }

  if (!(inv as any).pdf_url) {
    flags.push({
      icon: <FileX className="h-3 w-3" />,
      label: "No PDF",
      tooltip: "No original invoice PDF is stored for this record. " +
               "Re-upload via the Upload page to attach the vendor document.",
      className: "bg-muted text-muted-foreground border-border",
    });
  }

  if (!inv.due_date && inv.status !== 'paid') {
    flags.push({
      icon: <DollarSign className="h-3 w-3" />,
      label: "No Schedule",
      tooltip: "No payment schedule has been generated for this invoice. " +
               "Open the invoice drawer to trigger automatic schedule generation.",
      className: "bg-amber-500/15 text-amber-600 border-amber-500/30",
    });
  }

  // NOTE: recon_status "discrepancy" flag removed — 93% of invoices have this
  // as legacy data from the old reconciliation engine, making it meaningless noise.

  if (flags.length === 0) {
    return (
      <span className="text-[10px] text-emerald-500 font-medium">✓ Clean</span>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex flex-wrap gap-1">
        {flags.map((flag, i) => (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <span>
                <Badge
                  variant="outline"
                  className={`text-[10px] font-medium cursor-help gap-1 ${flag.className}`}
                >
                  {flag.icon}
                  {flag.label}
                </Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="left"
              className="max-w-[280px] text-xs leading-relaxed"
            >
              {flag.tooltip}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
