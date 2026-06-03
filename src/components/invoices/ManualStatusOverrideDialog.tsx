import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  manualOverrideInstallmentStatus,
  clearManualStatusOverride,
  type InvoicePayment,
  type ManualOverrideMode,
  derivePaymentStatus,
} from "@/lib/payment-queries";
import { formatCurrency } from "@/lib/supabase-queries";

interface Props {
  payment: InvoicePayment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void;
}

function modeFromStatus(status: string): ManualOverrideMode {
  if (status === "paid" || status === "overpaid") return "paid";
  if (status === "partial") return "partial";
  return "unpaid";
}

export function ManualStatusOverrideDialog({ payment, open, onOpenChange, onComplete }: Props) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<ManualOverrideMode>("unpaid");
  const [partial, setPartial] = useState("");
  const [paidDate, setPaidDate] = useState(new Date().toISOString().split("T")[0]);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Bug 2 fix: fully reset every time the dialog opens or the target installment changes.
  // Radix does not call onOpenChange when `open` flips programmatically, so we cannot
  // rely on handleOpen for resets between installments.
  useEffect(() => {
    if (!open || !payment) return;
    setMode(modeFromStatus(payment.payment_status));
    setPartial("");
    setPaidDate(new Date().toISOString().split("T")[0]);
    setNote("");
    setConfirming(false);
  }, [open, payment?.id]);

  if (!payment) return null;

  const amountDue = Number(payment.amount_due) || 0;
  const before = payment.payment_status;
  const isManualNow = (payment as any).manual_status_override === true;
  const partialNum = parseFloat(partial) || 0;
  const afterStatus =
    mode === "paid" ? "paid"
    : mode === "unpaid" ? "unpaid"
    : derivePaymentStatus(amountDue, partialNum);
  const afterPaid =
    mode === "paid" ? amountDue
    : mode === "unpaid" ? 0
    : partialNum;

  const partialInvalid = mode === "partial" && (!Number.isFinite(partialNum) || partialNum < 0 || partialNum > amountDue);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["invoice_payments_detail", payment.invoice_id] });
    qc.invalidateQueries({ queryKey: ["invoice_payments"] });
    qc.invalidateQueries({ queryKey: ["invoice_stats"] });
    qc.invalidateQueries({ queryKey: ["ap_full_audit"] });
    qc.invalidateQueries({ queryKey: ["vendor_invoices"] });
  };

  const apply = async () => {
    setSubmitting(true);
    try {
      await manualOverrideInstallmentStatus({
        paymentId: payment.id,
        mode,
        partialAmount: mode === "partial" ? partialNum : undefined,
        paidDate: mode === "unpaid" ? undefined : paidDate,
        note,
        performedBy: "Josh",
      });
      toast.success(`Override applied: ${before} → ${afterStatus}`);
      invalidateAll();
      onComplete?.();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Override failed");
    } finally {
      setSubmitting(false);
    }
  };

  const clearOverride = async () => {
    setSubmitting(true);
    try {
      await clearManualStatusOverride(payment.id, "Josh");
      toast.success("Manual override cleared — installment back to computed");
      invalidateAll();
      onComplete?.();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to clear override");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Override installment status</DialogTitle>
          <DialogDescription className="text-xs">
            {payment.invoice_number} · {payment.installment_label} · Due {payment.due_date} · {formatCurrency(amountDue)}
          </DialogDescription>
        </DialogHeader>

        {!confirming ? (
          <div className="space-y-4">
            {isManualNow && (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs flex items-start gap-2">
                <div className="flex-1">
                  <div className="font-medium text-amber-700">This installment is currently a manual override.</div>
                  <div className="text-muted-foreground mt-0.5">
                    Clear it to remove the Manual badge and let the system manage its status again.
                  </div>
                </div>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={clearOverride} disabled={submitting}>
                  <RotateCcw className="h-3 w-3" /> Clear override
                </Button>
              </div>
            )}

            <div>
              <Label className="text-xs mb-2 block">New status</Label>
              <RadioGroup value={mode} onValueChange={v => setMode(v as ManualOverrideMode)} className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="paid" /> Mark as Paid (full {formatCurrency(amountDue)})
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="unpaid" /> Mark as Unpaid (reset to {formatCurrency(amountDue)} owed)
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="partial" /> Set partial amount paid
                </label>
              </RadioGroup>
            </div>

            {mode === "partial" && (
              <div>
                <Label className="text-xs">Amount paid</Label>
                <Input
                  type="number" step="0.01" min="0" max={amountDue}
                  value={partial} onChange={e => setPartial(e.target.value)}
                  className="h-9"
                  placeholder={`0.00 – ${amountDue.toFixed(2)}`}
                />
                {partialInvalid && (
                  <p className="text-xs text-destructive mt-1">Must be between 0 and {amountDue.toFixed(2)}</p>
                )}
              </div>
            )}

            {mode !== "unpaid" && (
              <div>
                <Label className="text-xs">Paid date</Label>
                <Input type="date" value={paidDate} onChange={e => setPaidDate(e.target.value)} className="h-9" />
              </div>
            )}

            <div>
              <Label className="text-xs">Reason / note (optional)</Label>
              <Textarea
                value={note} onChange={e => setNote(e.target.value)}
                placeholder="e.g. check cleared, system missed it"
                className="h-16 text-sm"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button size="sm" disabled={partialInvalid} onClick={() => setConfirming(true)}>
                Review change
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3 text-sm space-y-1">
              <div className="font-medium">Confirm override</div>
              <div className="text-muted-foreground text-xs">
                <span className="capitalize">{before}</span> → <span className="capitalize font-semibold text-foreground">{afterStatus}</span>
              </div>
              <Separator className="my-2" />
              <div className="text-xs space-y-0.5">
                <div>Amount paid: <span className="tabular-nums font-medium">{formatCurrency(afterPaid)}</span></div>
                <div>Balance: <span className="tabular-nums font-medium">{formatCurrency(amountDue - afterPaid)}</span></div>
                {mode !== "unpaid" && <div>Paid date: {paidDate}</div>}
                {note && <div className="text-muted-foreground">Note: {note}</div>}
              </div>
              <p className="text-[10px] text-muted-foreground pt-1">
                This installment will be stamped as a manual override so future recalcs won't revert it. Existing payment history is preserved; a new audit entry is appended.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>Back</Button>
              <Button size="sm" onClick={apply} disabled={submitting}>
                {submitting ? "Applying…" : "Apply override"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
