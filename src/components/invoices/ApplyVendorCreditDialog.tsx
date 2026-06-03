/**
 * ApplyVendorCreditDialog
 *
 * Lets Josh draw down a vendor's available credit balance against an open
 * invoice's amount owed. Supports partial amounts; auto-allocates across
 * unpaid installments oldest-first.
 *
 * Includes a one-time, server-persisted tutorial (onboarding_flags table)
 * that walks through the four key spots on first open. Replayable via "?".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Wallet, HelpCircle, Loader2, ArrowRight } from "lucide-react";
import { formatCurrency } from "@/lib/supabase-queries";
import {
  fetchVendorCreditBalance,
  applyVendorCreditToInvoice,
  isOnboardingFlagDismissed,
  dismissOnboardingFlag,
} from "@/lib/vendor-credits";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const TUTORIAL_FLAG = "apply_credit_tutorial_seen";

interface Props {
  invoiceId: string;
  invoiceNumber: string;
  vendor: string;
  amountOwed: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ApplyVendorCreditDialog({
  invoiceId,
  invoiceNumber,
  vendor,
  amountOwed,
  open,
  onOpenChange,
}: Props) {
  const queryClient = useQueryClient();
  const [amountStr, setAmountStr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [tutorialStep, setTutorialStep] = useState<number | null>(null);

  // Refs for coachmark targets.
  const balanceRef = useRef<HTMLDivElement>(null);
  const owedRef = useRef<HTMLDivElement>(null);
  const amountRef = useRef<HTMLDivElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);

  const { data: balance = 0 } = useQuery({
    queryKey: ["vendor_credit_balances", vendor.toLowerCase()],
    enabled: open && !!vendor,
    queryFn: () => fetchVendorCreditBalance(vendor),
  });

  const cap = Math.min(balance, amountOwed);
  const parsed = Math.max(0, Math.round((parseFloat(amountStr) || 0) * 100) / 100);
  const tooHigh = parsed > cap + 0.005;
  const valid = parsed > 0 && !tooHigh;

  const newOwed = Math.max(0, Math.round((amountOwed - (valid ? parsed : 0)) * 100) / 100);
  const newBalance = Math.max(0, Math.round((balance - (valid ? parsed : 0)) * 100) / 100);

  // Reset + auto-fill + tutorial trigger when opened.
  useEffect(() => {
    if (open) {
      setAmountStr(cap > 0 ? cap.toFixed(2) : "");
      isOnboardingFlagDismissed(TUTORIAL_FLAG).then(seen => {
        if (!seen) setTutorialStep(0);
      });
    } else {
      setTutorialStep(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, balance, amountOwed]);

  async function dismissTutorial(persist: boolean) {
    setTutorialStep(null);
    if (persist) {
      try { await dismissOnboardingFlag(TUTORIAL_FLAG); } catch { /* non-fatal */ }
    }
  }

  async function handleApply() {
    if (!valid) return;
    setSubmitting(true);
    try {
      const allocations = await applyVendorCreditToInvoice({
        vendor,
        invoiceId,
        invoiceNumber,
        amount: parsed,
      });
      toast.success(
        `Applied ${formatCurrency(parsed)} across ${allocations.length} installment${allocations.length === 1 ? "" : "s"}`,
      );
      queryClient.invalidateQueries({ queryKey: ["vendor_credit_balances"] });
      queryClient.invalidateQueries({ queryKey: ["vendor_credit_ledger"] });
      queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_payments_detail", invoiceId] });
      queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
      queryClient.invalidateQueries({ queryKey: ["ap_full_audit"] });
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Apply failed", { duration: 8000 });
    } finally {
      setSubmitting(false);
    }
  }

  const steps = useMemo(() => [
    { ref: balanceRef, title: "Vendor's available credit", body: "This is how much on-account credit the vendor currently has with you." },
    { ref: owedRef, title: "What this invoice owes", body: "The remaining balance across all unpaid installments on this invoice." },
    { ref: amountRef, title: "How much to apply", body: "Enter any amount up to the lower of the two figures above. We pre-fill the max." },
    { ref: applyRef, title: "Apply — and reverse later if needed", body: "Hit Apply. The credit gets recorded on the invoice. You can always reverse it from the vendor ledger." },
  ], []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-emerald-500" />
            Apply Vendor Credit
            <button
              type="button"
              onClick={() => setTutorialStep(0)}
              className="ml-auto text-muted-foreground hover:text-foreground"
              title="Show tutorial"
            >
              <HelpCircle className="h-4 w-4" />
            </button>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div
              ref={balanceRef}
              className={`p-3 rounded border ${tutorialStep === 0 ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-background" : ""}`}
            >
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Available credit</p>
              <p className="text-lg font-bold tabular-nums text-emerald-500">{formatCurrency(balance)}</p>
            </div>
            <div
              ref={owedRef}
              className={`p-3 rounded border ${tutorialStep === 1 ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-background" : ""}`}
            >
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Invoice owed</p>
              <p className="text-lg font-bold tabular-nums">{formatCurrency(amountOwed)}</p>
            </div>
          </div>

          <div
            ref={amountRef}
            className={`space-y-1 ${tutorialStep === 2 ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-background rounded p-2 -m-2" : ""}`}
          >
            <Label htmlFor="apply-amount" className="text-xs">Amount to apply</Label>
            <Input
              id="apply-amount"
              type="number"
              step="0.01"
              min="0"
              max={cap}
              value={amountStr}
              onChange={e => setAmountStr(e.target.value)}
              className="h-10"
            />
            <p className="text-[11px] text-muted-foreground">
              Capped at the lower of available credit and invoice owed: {formatCurrency(cap)}
            </p>
            {tooHigh && (
              <p className="text-[11px] text-destructive">Exceeds the cap by {formatCurrency(parsed - cap)}</p>
            )}
          </div>

          {valid && (
            <div className="p-3 rounded bg-muted/40 border text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Applying</span>
                <span className="font-bold tabular-nums">{formatCurrency(parsed)}</span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">Invoice owed drops to</span>
                <span className="font-bold tabular-nums">{formatCurrency(newOwed)}</span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">Vendor credit balance drops to</span>
                <span className="font-bold tabular-nums text-emerald-500">{formatCurrency(newBalance)}</span>
              </div>
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
            <Button
              ref={applyRef}
              onClick={handleApply}
              disabled={!valid || submitting}
              className={`bg-emerald-600 hover:bg-emerald-700 text-white ${tutorialStep === 3 ? "ring-2 ring-emerald-300 ring-offset-2 ring-offset-background" : ""}`}
            >
              {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Wallet className="h-4 w-4 mr-2" />}
              Apply {valid ? formatCurrency(parsed) : ""}
            </Button>
          </div>
        </div>

        {/* Coachmark overlay */}
        {tutorialStep !== null && tutorialStep >= 0 && tutorialStep < steps.length && (
          <div className="fixed inset-0 z-[60] bg-black/40 flex items-end sm:items-center justify-center p-4 pointer-events-auto">
            <div className="bg-card border rounded-lg shadow-xl p-4 max-w-sm w-full space-y-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white text-xs font-bold">
                  {tutorialStep + 1}
                </span>
                <h4 className="font-semibold text-sm">{steps[tutorialStep].title}</h4>
                <span className="ml-auto text-[10px] text-muted-foreground">{tutorialStep + 1} / {steps.length}</span>
              </div>
              <p className="text-xs text-muted-foreground">{steps[tutorialStep].body}</p>
              <div className="flex items-center gap-2 justify-between">
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground underline"
                  onClick={() => dismissTutorial(true)}
                >
                  Skip tutorial
                </button>
                <div className="flex gap-2">
                  {tutorialStep > 0 && (
                    <Button size="sm" variant="outline" onClick={() => setTutorialStep(tutorialStep - 1)}>Back</Button>
                  )}
                  {tutorialStep < steps.length - 1 ? (
                    <Button size="sm" onClick={() => setTutorialStep(tutorialStep + 1)}>Next</Button>
                  ) : (
                    <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => dismissTutorial(true)}>
                      Got it
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
