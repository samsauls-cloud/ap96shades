import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { AlertCircle, CheckCircle2, DollarSign, Clock, Ban, AlertTriangle } from "lucide-react";
import { formatCurrency } from "@/lib/supabase-queries";
import { type InvoicePayment, type PaymentHistoryEntry, recordPayment, setPaymentDisputed, setPaymentVoid, markPaymentPaid } from "@/lib/payment-queries";
import { toast } from "sonner";
import { PaymentStatusBadge } from "./PaymentStatusBadge";

interface Props {
  payment: InvoicePayment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}

export function RecordPaymentModal({ payment, open, onOpenChange, onComplete }: Props) {
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split("T")[0]);
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [disputeReason, setDisputeReason] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const [showDispute, setShowDispute] = useState(false);
  const [showVoid, setShowVoid] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!payment) return null;

  const balance = payment.balance_remaining;
  const parsedAmount = parseFloat(amount) || 0;
  const isOverpay = parsedAmount > balance && balance > 0;

  const handleOpen = (isOpen: boolean) => {
    if (isOpen) {
      setAmount(balance > 0 ? balance.toFixed(2) : "");
      setPaymentDate(new Date().toISOString().split("T")[0]);
      setMethod("");
      setReference("");
      setNote("");
      setShowDispute(false);
      setShowVoid(false);
    }
    onOpenChange(isOpen);
  };

  const handleSubmit = async () => {
    if (!parsedAmount || !method) return;
    setSubmitting(true);
    try {
      await recordPayment(payment.id, parsedAmount, paymentDate, method, reference, note, "Staff");
      toast.success(`✓ Payment of ${formatCurrency(parsedAmount)} recorded for ${payment.invoice_number}`);
      onComplete();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(`Failed: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleQuickMarkPaid = async () => {
    setSubmitting(true);
    try {
      await markPaymentPaid(payment.id);
      toast.success(`✓ ${payment.invoice_number} marked as paid (${formatCurrency(payment.amount_due)})`);
      onComplete();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(`Failed: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDispute = async () => {
    if (!disputeReason.trim()) return;
    setSubmitting(true);
    try {
      await setPaymentDisputed(payment.id, disputeReason);
      toast.success(`Marked as disputed — ${payment.invoice_number}`);
      onComplete();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(`Failed: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleVoid = async () => {
    if (!voidReason.trim()) return;
    setSubmitting(true);
    try {
      await setPaymentVoid(payment.id, voidReason);
      toast.success(`Voided — ${payment.invoice_number}`);
      onComplete();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(`Failed: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const history: PaymentHistoryEntry[] = payment.payment_history || [];

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base font-bold">Record Payment</DialogTitle>
        </DialogHeader>

        {/* Section 1: Summary */}
        <div className="space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span className="text-muted-foreground">Invoice #</span>
            <span className="font-mono font-medium">{payment.invoice_number}</span>
            <span className="text-muted-foreground">Vendor</span>
            <span>{payment.vendor}</span>
            <span className="text-muted-foreground">Installment</span>
            <span>{payment.installment_label ?? "—"}</span>
            <span className="text-muted-foreground">Due Date</span>
            <span>{payment.due_date}</span>
          </div>
          <Separator />
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-xs text-muted-foreground">Amount Due</p>
              <p className="font-bold tabular-nums">{formatCurrency(payment.amount_due)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Already Paid</p>
              <p className="font-bold tabular-nums text-primary">{formatCurrency(payment.amount_paid)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Balance</p>
              <p className={`font-bold tabular-nums ${balance > 0 ? "text-destructive" : "text-green-500"}`}>
                {formatCurrency(balance)}
              </p>
            </div>
          </div>
          <div className="flex justify-center">
            <PaymentStatusBadge payment={payment} />
          </div>
        </div>

        <Separator />

        {/* Section 2: New Payment Form */}
        {!showDispute && !showVoid && payment.payment_status !== "void" && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <DollarSign className="h-4 w-4" /> Record New Payment
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Payment Amount</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  className="h-9"
                />
                {isOverpay && (
                  <p className="text-xs text-orange-500 mt-1 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Exceeds balance by {formatCurrency(parsedAmount - balance)} — will be overpayment
                  </p>
                )}
              </div>
              <div>
                <Label className="text-xs">Payment Date</Label>
                <Input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} className="h-9" />
              </div>
            </div>

            <div>
              <Label className="text-xs">Payment Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select method" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Check">Check</SelectItem>
                  <SelectItem value="ACH">ACH</SelectItem>
                  <SelectItem value="Wire">Wire</SelectItem>
                  <SelectItem value="Credit Card">Credit Card</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {method === "Check" && (
              <div>
                <Label className="text-xs">Check #</Label>
                <Input value={reference} onChange={e => setReference(e.target.value)} className="h-9" placeholder="Check number" />
              </div>
            )}
            {(method === "ACH" || method === "Wire") && (
              <div>
                <Label className="text-xs">Reference #</Label>
                <Input value={reference} onChange={e => setReference(e.target.value)} className="h-9" placeholder="Transaction reference" />
              </div>
            )}

            <div>
              <Label className="text-xs">Notes</Label>
              <Textarea value={note} onChange={e => setNote(e.target.value)} className="h-16 text-sm" placeholder="Optional notes" />
            </div>

            {/* Quick Actions */}
            <div className="flex flex-wrap gap-2">
              {balance > 0 && (
                <Button size="sm" className="text-xs h-8 bg-green-600 hover:bg-green-700 text-white" onClick={handleQuickMarkPaid} disabled={submitting}>
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Mark Paid
                </Button>
              )}
              {balance > 0 && parsedAmount !== balance && (
                <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => setAmount(balance.toFixed(2))}>
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Pay Full Balance
                </Button>
              )}
              <Button variant="outline" size="sm" className="text-xs h-8 text-orange-500 hover:text-orange-600" onClick={() => setShowDispute(true)}>
                <AlertCircle className="h-3 w-3 mr-1" /> Mark Disputed
              </Button>
              <Button variant="outline" size="sm" className="text-xs h-8 text-muted-foreground" onClick={() => setShowVoid(true)}>
                <Ban className="h-3 w-3 mr-1" /> Void
              </Button>
            </div>

            <Button className="w-full h-10" onClick={handleSubmit} disabled={submitting || !parsedAmount || !method}>
              {submitting ? "Recording..." : "Record Payment"}
            </Button>
          </div>
        )}

        {/* Dispute form */}
        {showDispute && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-orange-500">Mark as Disputed</h3>
            <Textarea
              placeholder="Reason for dispute..."
              value={disputeReason}
              onChange={e => setDisputeReason(e.target.value)}
              className="h-20 text-sm"
            />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowDispute(false)}>Cancel</Button>
              <Button size="sm" className="bg-orange-500 hover:bg-orange-600" onClick={handleDispute} disabled={submitting || !disputeReason.trim()}>
                Confirm Dispute
              </Button>
            </div>
          </div>
        )}

        {/* Void form */}
        {showVoid && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-muted-foreground">Void Payment</h3>
            <Textarea
              placeholder="Reason for voiding..."
              value={voidReason}
              onChange={e => setVoidReason(e.target.value)}
              className="h-20 text-sm"
            />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowVoid(false)}>Cancel</Button>
              <Button size="sm" variant="destructive" onClick={handleVoid} disabled={submitting || !voidReason.trim()}>
                Confirm Void
              </Button>
            </div>
          </div>
        )}

        {/* Payment History */}
        {history.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <Clock className="h-4 w-4" /> Payment History ({history.length} {history.length === 1 ? "payment" : "payments"})
              </h3>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {[...history].reverse().map((h, i) => {
                  const runningPaid = history.slice(0, history.length - i).reduce((s, e) => s + e.amount, 0);
                  const balAfter = payment.amount_due - runningPaid;
                  return (
                    <div key={i} className="p-2 rounded bg-muted/50 text-xs space-y-0.5">
                      <div className="flex justify-between">
                        <span className="font-medium">{h.date} · {h.method}{h.reference ? ` · ${h.reference}` : ""}</span>
                        <span className="font-bold tabular-nums">{formatCurrency(h.amount)}</span>
                      </div>
                      {h.note && <p className="text-muted-foreground">{h.note}</p>}
                      <div className="flex justify-between text-muted-foreground">
                        <span>Recorded by {h.recorded_by}</span>
                        <span>Balance after: {formatCurrency(balAfter)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
