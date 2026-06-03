import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Wallet, Plus, Loader2, Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import { addVendorCreditAdjustment, type VendorCreditSource } from "@/lib/vendor-credits";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface Props {
  lockedVendor?: string;
  defaultInvoiceNumber?: string;
  trigger?: React.ReactNode;
  buttonLabel?: string;
  buttonVariant?: "default" | "outline" | "ghost" | "secondary";
  buttonSize?: "default" | "sm" | "lg" | "icon";
  onSaved?: () => void;
}

const SOURCE_OPTIONS: { value: VendorCreditSource; label: string }[] = [
  { value: "manual_adjustment", label: "Manual adjustment" },
  { value: "remittance_overpay", label: "Overpayment" },
  { value: "returned_ra", label: "Returned / RA frames" },
  { value: "reversal", label: "Reversal" },
  { value: "other", label: "Other" },
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
  const [vendorPickerOpen, setVendorPickerOpen] = useState(false);
  const [amountStr, setAmountStr] = useState("");
  const [description, setDescription] = useState("");
  const [sourceType, setSourceType] = useState<VendorCreditSource>("manual_adjustment");
  const [occurredOn, setOccurredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [invoiceNumber, setInvoiceNumber] = useState(defaultInvoiceNumber ?? "");
  const [saving, setSaving] = useState(false);

  // Distinct vendor list for searchable select (skip when locked).
  const { data: vendorList = [] } = useQuery({
    queryKey: ["distinct_vendors_credit_dialog"],
    enabled: open && !lockedVendor,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vendor_invoices")
        .select("vendor")
        .not("vendor", "is", null);
      if (error) throw error;
      const set = new Set<string>();
      (data ?? []).forEach((r: any) => r.vendor && set.add(r.vendor));
      return Array.from(set).sort((a, b) => a.localeCompare(b));
    },
  });

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
  const amountValid = Number.isFinite(amount) && amount !== 0;
  const canSave = !!vendor.trim() && amountValid && !!occurredOn && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    try {
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
        if (!relatedInvoiceId) {
          toast.warning(
            `Invoice "${invoiceNumber.trim()}" not found for ${vendor.trim()} — saving credit unlinked.`,
          );
        }
      }

      await addVendorCreditAdjustment({
        vendor: vendor.trim(),
        amount,
        description,
        sourceType,
        occurredOn,
        relatedInvoiceId,
      });

      toast.success(`${amount > 0 ? "Credit added" : "Credit deducted"} for ${vendor.trim()}: $${Math.abs(amount).toFixed(2)}`);
      queryClient.invalidateQueries({ queryKey: ["vendor_credit_balances"] });
      queryClient.invalidateQueries({ queryKey: ["vendor_credit_ledger"] });
      queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
      onSaved?.();
      setOpen(false);
    } catch (e: any) {
      const msg = e?.message ?? "Failed to save credit";
      // Surface trigger errors (negative balance guard, CHECK violations, RLS).
      toast.error(`Save failed: ${msg}`, { duration: 8000 });
      console.error("[add-credit] save failed", e);
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
            <Label className="text-xs">Vendor *</Label>
            {lockedVendor ? (
              <Input value={vendor} disabled />
            ) : (
              <Popover open={vendorPickerOpen} onOpenChange={setVendorPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    className="w-full justify-between font-normal"
                  >
                    {vendor || "Select or type a vendor…"}
                    <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command>
                    <CommandInput
                      placeholder="Search or type new vendor…"
                      value={vendor}
                      onValueChange={setVendor}
                    />
                    <CommandList>
                      <CommandEmpty>
                        <button
                          type="button"
                          className="text-xs text-primary hover:underline"
                          onClick={() => setVendorPickerOpen(false)}
                        >
                          Use "{vendor}" as new vendor
                        </button>
                      </CommandEmpty>
                      <CommandGroup>
                        {vendorList.map((v) => (
                          <CommandItem
                            key={v}
                            value={v}
                            onSelect={() => {
                              setVendor(v);
                              setVendorPickerOpen(false);
                            }}
                          >
                            <Check className={cn("mr-2 h-3.5 w-3.5", vendor === v ? "opacity-100" : "opacity-0")} />
                            {v}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Amount * (− to deduct)</Label>
              <Input
                type="number"
                step="0.01"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                placeholder="200.00"
                className={!amountStr || amountValid ? "" : "border-destructive"}
              />
            </div>
            <div>
              <Label className="text-xs">Date *</Label>
              <Input type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
            </div>
          </div>

          <div>
            <Label className="text-xs">Source *</Label>
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as VendorCreditSource)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
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
              Resolved to the invoice and deep-linked from the ledger if found.
            </p>
          </div>

          <div>
            <Label className="text-xs">Note (optional)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Credit memo CM-12345 for damaged shipment"
              rows={2}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            Save credit
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
