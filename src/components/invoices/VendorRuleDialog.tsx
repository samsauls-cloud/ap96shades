/**
 * VendorRuleDialog
 *
 * Modal that fires when a locked vendor rule (e.g. Revo = Net 90) conflicts
 * with the terms extracted from the invoice. User can approve the rule
 * correction with one click. A small "Review manually" escape is kept for
 * genuine exceptions.
 *
 * Rendered from TermsConfirmationPanel on mount when:
 *   - getVendorLockedTerms(vendor) returns a rule, AND
 *   - the extracted/current terms don't already match that rule
 */

import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, ShieldCheck } from "lucide-react";
import type { VendorTermsRule } from "@/lib/vendor-terms-registry";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendor: string;
  extractedTermsText: string | null;
  lockedRule: VendorTermsRule;
  lockedLabel: string;               // human label, e.g. "Net 90"
  applying: boolean;
  onApply: () => void;
  onReviewManually: () => void;
}

export function VendorRuleDialog({
  open, onOpenChange, vendor, extractedTermsText,
  lockedRule, lockedLabel, applying, onApply, onReviewManually,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="h-4 w-4 text-amber-600" />
            <DialogTitle className="text-sm">Vendor rule: {vendor}</DialogTitle>
          </div>
          <DialogDescription className="text-xs leading-relaxed">
            {vendor} terms are always <span className="font-semibold text-foreground">{lockedLabel}</span>.
            The invoice was read as{" "}
            <span className="font-mono text-foreground">"{extractedTermsText || "no terms found"}"</span>,
            which doesn't match. This is usually a parser mis-read.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Standing rule</p>
          <p className="text-xs font-semibold text-foreground">{lockedRule.description}</p>
        </div>

        <DialogFooter className="flex-col sm:flex-col gap-2 sm:space-x-0">
          <Button
            onClick={onApply}
            disabled={applying}
            className="w-full bg-amber-600 hover:bg-amber-700 text-white"
          >
            {applying && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Apply {vendor} rule ({lockedLabel})
          </Button>
          <button
            onClick={onReviewManually}
            disabled={applying}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2 disabled:opacity-50"
          >
            Review manually instead (exception)
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
