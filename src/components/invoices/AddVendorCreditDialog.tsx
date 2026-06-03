import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Wallet, Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { addVendorCreditAdjustment, type VendorCreditSource } from "@/lib/vendor-credits";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";

interface Props {
  /** Pre-fill vendor and lock the field. Omit for global "add anywhere" mode. */
  lockedVendor?: string;
  /** Pre-fill an invoice number to link this credit to (and resolve its id). */
  defaultInvoiceNumber?: string;
  /** Optional trigger override. */
  trigger?: React.ReactNode;
  /** Compact trigger label when no trigger override is provided. */
  buttonLabel?: string;
  buttonVariant?: "default" | "outline" | "ghost" | "secondary";
  buttonSize?: "default" | "sm" | "lg" | "icon";
  onSaved?: () => void;
}

const SOURCE_OPTIONS: { value: VendorCreditSource; label: string }[] = [
  { value: "manual_adjustment", label: "Manual adjustment" },
  { value: "remittance_overpay", label: "Remittance overpay" },
  { value: "reversal", label: "Reversal" },
];

export function AddVendorCreditDialog({
  lockedVendor,
  defaultInvoiceNumber,
  trigger,
  buttonLabel = "Add Credit",
  buttonVariant = "outline",
  buttonSize = "sm",
  onSaved,
}: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [vendor, setVendor] = useState(lockedVendor ?? "");
  const [amountStr, setAmountStr] = useState("");
  const [description, setDescription] = useState("");
  const [sourceType, setSourceType] = useState<VendorCreditSource>("manual_adjustment");
  const [occurredOn, setOccurredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [invoiceNumber, setInvoiceNumber] = useState(defaultInvoiceNumber ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setVendor(lockedVendor ?? "");
      setAmountStr("");
      setDescription("");
      setSourceType("manual_adjustment");
      setOccurredOn(new Date().toISOString().slice(0, 10));
      setInvoiceNumber(defaultInvoiceNumber ?? "");
    }
  }, [open, lockedVendor, defaultInvoiceNumber]);

  const amount = parseFloat(amountStr);
  const canSave =
    !!vendor.trim() &&
    Number.isFinite(amount) &&
    amount !== 0 &&
    !!description.trim() &&
    !!occurredOn;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      // Resolve invoice id from number if provided.
      let relatedInvoiceId: string | null = null;
      if (invoiceNumber.trim()) {
        const { data, error } = await supabase
          .from("vendor_invoices")
          .select("id")
          .ilike("vendor", vendor.trim())
          .eq("invoice_number", invoiceNumber.trim())
          .maybeSingle();
        if (error) console.warn("[add-credit] invoice lookup failed", error);
        relatedInvoiceId = (data as any)?.id ?? null;
        if (invoiceNumber.trim() && !relatedInvoiceId) {
          toast.warning(
            `Invoice "${invoiceNumber.trim()}" not found for ${vendor.trim()} — credit will be saved without a link.`,
          );
        }
      }

      await addVendorCreditAdjustment({
        vendor: vendor.trim(),
        amount,
        description: description.trim(),
        sourceType,
        occurredOn,
        relatedInvoiceId,
      });

      toast.success(`Credit ${amount > 0 ? "added" : "deducted"} for ${vendor.trim()}`);
      queryClient.invalidateQueries({ queryKey: ["vendor_credit_balances"] });
      queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
      onSaved?.();
      setOpen(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to save credit");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant={buttonVariant} size={buttonSize} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            <Wallet className="h-3.5 w-3.5" />
            {buttonLabel}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-emerald-500" />
            Add Vendor Credit
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs">Vendor</Label>
            <Input
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="e.g. Luxottica"
              disabled={!!lockedVendor}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Amount (negative to deduct)</Label>
              <Input
                type="number"
                step="0.01"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                placeholder="200.00"
              />
            </div>
            <div>
              <Label className="text-xs">Occurred on</Label>
              <Input type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
            </div>
          </div>

          <div>
            <Label className="text-xs">Source</Label>
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as VendorCreditSource)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label className="text-xs">Link to invoice # (optional)</Label>
            <Input
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="Invoice number from this vendor"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              If provided, this credit will deep-link to the invoice in the ledger.
            </p>
          </div>

          <div>
            <Label className="text-xs">Description / reason</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Credit memo CM-12345 issued for damaged shipment"
              rows={3}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            Save credit
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
