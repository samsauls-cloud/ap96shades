import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { generatePaymentsForInvoice } from "@/lib/payment-queries";
import {
  type TermType,
  type ExtractedTerms,
  type VendorTermsDefault,
  getVendorDefaultTerms,
  parsePaymentTermsText,
  calculateInstallmentsFromTerms,
  termsToLabel,
} from "@/lib/payment-terms";
import { getVendorLockedTerms, type VendorTermsRule } from "@/lib/vendor-terms-registry";
import { normalizeVendor } from "@/lib/invoice-dedup";
import { VendorRuleDialog } from "@/components/invoices/VendorRuleDialog";
import { formatCurrency, formatDate, type VendorInvoice } from "@/lib/supabase-queries";
import { useQueryClient } from "@tanstack/react-query";

interface Props {
  invoice: VendorInvoice;
  onConfirmed: () => void;
}

const TERM_TYPES: { value: TermType; label: string }[] = [
  { value: "net_single", label: "Net Single Payment" },
  { value: "eom_single", label: "EOM Single" },
  { value: "eom_split", label: "EOM Split" },
  { value: "net_split", label: "Net Split" },
  { value: "early_pay", label: "Early Pay Discount" },
  { value: "cod", label: "COD" },
];

export function TermsConfirmationPanel({ invoice, onConfirmed }: Props) {
  const queryClient = useQueryClient();
  const vendorDefault = getVendorDefaultTerms(invoice.vendor);

  // Parse existing payment_terms text
  const extracted = useMemo(
    () => parsePaymentTermsText(invoice.payment_terms),
    [invoice.payment_terms],
  );

  const [termType, setTermType] = useState<TermType>(
    extracted.type !== "unknown" ? extracted.type : vendorDefault?.type ?? "net_single",
  );
  const [daysInput, setDaysInput] = useState(
    extracted.days.length > 0 ? extracted.days.join(", ") : vendorDefault?.days.join(", ") ?? "30",
  );
  const [eomBased, setEomBased] = useState(
    extracted.type !== "unknown" ? extracted.eom_based : vendorDefault?.eom_based ?? false,
  );
  const [discountPct, setDiscountPct] = useState(extracted.discount_pct ?? 2);
  const [discountDays, setDiscountDays] = useState(extracted.discount_days ?? 10);
  const [netDays, setNetDays] = useState(extracted.net_days ?? 30);
  const [confirming, setConfirming] = useState(false);

  // Parse days from input
  const days = useMemo(() => {
    if (termType === "cod") return [0];
    if (termType === "early_pay") return [netDays];
    return daysInput
      .split(/[,/\s]+/)
      .map(s => parseInt(s.trim()))
      .filter(n => !isNaN(n) && n >= 0);
  }, [daysInput, termType, netDays]);

  const installments = termType === "cod" || termType === "early_pay" || termType === "net_single" || termType === "eom_single"
    ? 1
    : days.length;

  // Build terms object for preview
  const previewTerms: ExtractedTerms = useMemo(() => ({
    raw_text: invoice.payment_terms,
    type: termType,
    days,
    installments,
    eom_based: termType === "eom_single" || termType === "eom_split" ? true : eomBased,
    discount_pct: termType === "early_pay" ? discountPct : null,
    discount_days: termType === "early_pay" ? discountDays : null,
    net_days: termType === "early_pay" ? netDays : null,
    confidence: "high",
    shipping_terms: null,
    extraction_notes: "Manually confirmed",
  }), [termType, days, installments, eomBased, discountPct, discountDays, netDays, invoice.payment_terms]);

  // Preview installments
  const previewInstallments = useMemo(() => {
    if (days.length === 0) return [];
    return calculateInstallmentsFromTerms(
      invoice.invoice_date,
      invoice.total,
      invoice.vendor,
      invoice.invoice_number,
      invoice.po_number,
      previewTerms,
    );
  }, [previewTerms, invoice]);

  // ── Vendor rule enforcement (Revo = Net 90, etc.) ────────────────────
  const lockedRule = useMemo(
    () => getVendorLockedTerms(normalizeVendor(invoice.vendor)),
    [invoice.vendor]
  );

  // Human label for the locked rule (e.g. "Net 90")
  const lockedLabel = useMemo(() => {
    if (!lockedRule) return "";
    const { terms_type, offsets, eom_baseline_offset, due_offset } = lockedRule;
    if (terms_type === "net_single" && offsets.length) return `Net ${offsets[0]}`;
    if (terms_type === "days_split") return `Net ${offsets.join("/")}`;
    if (terms_type === "eom_single") {
      const base = eom_baseline_offset ? `EOM+${eom_baseline_offset}` : "EOM";
      return due_offset ? `${base}+${due_offset}` : base;
    }
    if (terms_type === "eom_split") return `EOM ${offsets.join("/")}`;
    return lockedRule.description;
  }, [lockedRule]);

  // Does the current extracted/chosen terms match the locked rule?
  const matchesLockedRule = useMemo(() => {
    if (!lockedRule) return true;
    const expectedType: TermType =
      lockedRule.terms_type === "net_single" ? "net_single" :
      lockedRule.terms_type === "days_split" ? "net_split" :
      lockedRule.terms_type === "eom_single" ? "eom_single" :
      lockedRule.terms_type === "eom_split"  ? "eom_split"  :
      "unknown" as TermType;
    if (extracted.type !== expectedType) return false;
    const expectedDays = lockedRule.offsets;
    if (expectedDays.length !== extracted.days.length) return false;
    for (let i = 0; i < expectedDays.length; i++) {
      if (expectedDays[i] !== extracted.days[i]) return false;
    }
    return true;
  }, [lockedRule, extracted]);

  // Dialog state — fire on mount if vendor is locked and terms don't match.
  // `dialogDismissed` ensures we don't re-fire after the user closes it.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDismissed, setDialogDismissed] = useState(false);
  const [applyingLock, setApplyingLock] = useState(false);

  useEffect(() => {
    if (lockedRule && !matchesLockedRule && !dialogDismissed) {
      setDialogOpen(true);
    }
  }, [lockedRule, matchesLockedRule, dialogDismissed]);

  const handleApplyLockedRule = async () => {
    if (!lockedRule) return;
    setApplyingLock(true);

    // Build ExtractedTerms that reflect the locked rule
    const ruleType: TermType =
      lockedRule.terms_type === "net_single" ? "net_single" :
      lockedRule.terms_type === "days_split" ? "net_split" :
      lockedRule.terms_type === "eom_single" ? "eom_single" :
      lockedRule.terms_type === "eom_split"  ? "eom_split"  :
      "net_single" as TermType;
    const eomBased = ruleType === "eom_single" || ruleType === "eom_split";
    const ruleDays = lockedRule.offsets.length ? lockedRule.offsets : [30];
    const ruleInstallments = ruleType === "net_single" || ruleType === "eom_single" ? 1 : ruleDays.length;

    const ruleTerms: ExtractedTerms = {
      raw_text: invoice.payment_terms,
      type: ruleType,
      days: ruleDays,
      installments: ruleInstallments,
      eom_based: eomBased,
      discount_pct: null,
      discount_days: null,
      net_days: null,
      confidence: "high",
      shipping_terms: null,
      extraction_notes: `Applied vendor rule: ${lockedRule.description}`,
    };

    try {
      // 1. Save to invoice
      const { error: updateErr } = await supabase
        .from("vendor_invoices")
        .update({
          terms_status: "confirmed",
          terms_confidence: "high",
          payment_terms: termsToLabel(ruleTerms),
          payment_terms_extracted: ruleTerms as any,
          payment_terms_source: "vendor_rule",
        } as any)
        .eq("id", invoice.id);
      if (updateErr) throw updateErr;

      // 2. Clear existing payment rows
      await supabase.from("invoice_payments").delete().eq("invoice_id", invoice.id);

      // 3. Generate new payments from the rule
      const ruleInstallmentsPreview = calculateInstallmentsFromTerms(
        invoice.invoice_date, invoice.total, invoice.vendor,
        invoice.invoice_number, invoice.po_number, ruleTerms,
      );
      const rows = ruleInstallmentsPreview.map((inst) => ({
        invoice_id: invoice.id,
        vendor: inst.vendor,
        invoice_number: inst.invoice_number,
        po_number: inst.po_number,
        invoice_amount: inst.invoice_amount,
        invoice_date: inst.invoice_date,
        terms: inst.terms,
        installment_label: inst.installment_label,
        due_date: inst.due_date,
        amount_due: inst.amount_due,
        amount_paid: 0,
        balance_remaining: inst.amount_due,
        payment_status: "unpaid",
      }));
      if (rows.length > 0) {
        const { error: insErr } = await supabase.from("invoice_payments").insert(rows);
        if (insErr) throw insErr;
      }

      // 4. Invalidate queries
      queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_payments_detail", invoice.id] });
      queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
      queryClient.invalidateQueries({ queryKey: ["ap_full_audit"] });
      queryClient.invalidateQueries({ queryKey: ["needs_review_invoices"] });

      toast.success(`✅ Applied ${normalizeVendor(invoice.vendor)} rule: ${lockedLabel} — ${rows.length} payment${rows.length !== 1 ? "s" : ""} created`);
      setDialogOpen(false);
      onConfirmed();
    } catch (e: any) {
      toast.error(`Failed to apply vendor rule: ${e.message}`);
    } finally {
      setApplyingLock(false);
    }
  };

  const handleReviewManually = () => {
    setDialogOpen(false);
    setDialogDismissed(true);
  };

  const handleConfirm = async () => {
    if (days.length === 0) {
      toast.error("Please enter at least one day value");
      return;
    }
    setConfirming(true);
    try {
      // 1. Save terms to invoice
      const { error: updateErr } = await supabase
        .from("vendor_invoices")
        .update({
          terms_status: "confirmed",
          terms_confidence: "high",
          payment_terms: termsToLabel(previewTerms),
          payment_terms_extracted: previewTerms as any,
          payment_terms_source: "manual",
        } as any)
        .eq("id", invoice.id);
      if (updateErr) throw updateErr;
      // 2. Delete any existing payment rows
      await supabase.from("invoice_payments").delete().eq("invoice_id", invoice.id);

      // 3. Generate new payment rows from confirmed terms
      const rows = previewInstallments.map(inst => ({
        invoice_id: invoice.id,
        vendor: inst.vendor,
        invoice_number: inst.invoice_number,
        po_number: inst.po_number,
        invoice_amount: inst.invoice_amount,
        invoice_date: inst.invoice_date,
        terms: inst.terms,
        installment_label: inst.installment_label,
        due_date: inst.due_date,
        amount_due: inst.amount_due,
        amount_paid: 0,
        balance_remaining: inst.amount_due,
        payment_status: "unpaid",
      }));

      if (rows.length > 0) {
        const { error: insErr } = await supabase.from("invoice_payments").insert(rows);
        if (insErr) throw insErr;
      }

      // 4. Invalidate queries
      queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_payments_detail", invoice.id] });
      queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
      queryClient.invalidateQueries({ queryKey: ["ap_full_audit"] });
      queryClient.invalidateQueries({ queryKey: ["needs_review_invoices"] });

      toast.success(`✅ Terms confirmed — ${rows.length} payment installment${rows.length !== 1 ? "s" : ""} created for ${invoice.invoice_number}`);
      onConfirmed();
    } catch (e: any) {
      toast.error(`Failed: ${e.message}`);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <>
      {lockedRule && (
        <VendorRuleDialog
          open={dialogOpen}
          onOpenChange={(v) => {
            if (!v) setDialogDismissed(true);
            setDialogOpen(v);
          }}
          vendor={normalizeVendor(invoice.vendor)}
          extractedTermsText={invoice.payment_terms}
          lockedRule={lockedRule}
          lockedLabel={lockedLabel}
          applying={applyingLock}
          onApply={handleApplyLockedRule}
          onReviewManually={handleReviewManually}
        />
      )}
    <div className="mb-4 p-4 rounded-lg border-2 border-amber-500/40 bg-amber-500/5 space-y-4">
      <div className="flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-amber-700">Payment Terms Need Confirmation</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            This invoice is excluded from AP totals until terms are verified.
          </p>
        </div>
      </div>

      {/* Extracted text */}
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Extracted from invoice:</Label>
        <p className="text-xs font-mono bg-muted/50 p-2 rounded">
          "{invoice.payment_terms || "Nothing found"}"
        </p>
      </div>

      {/* Vendor default hint */}
      {vendorDefault && (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Vendor usual terms (reference only):</Label>
          <p className="text-xs text-muted-foreground/70 italic">{vendorDefault.label}</p>
        </div>
      )}

      {/* Term type selector */}
      <div className="space-y-2">
        <Label className="text-xs font-semibold">Select Term Type</Label>
        <RadioGroup
          value={termType}
          onValueChange={v => {
            const t = v as TermType;
            setTermType(t);
            if (t === "eom_single" || t === "eom_split") setEomBased(true);
            if (t === "net_single" || t === "net_split") setEomBased(false);
          }}
          className="grid grid-cols-2 gap-1"
        >
          {TERM_TYPES.map(tt => (
            <div key={tt.value} className="flex items-center space-x-2">
              <RadioGroupItem value={tt.value} id={`tt-${tt.value}`} />
              <Label htmlFor={`tt-${tt.value}`} className="text-xs cursor-pointer">{tt.label}</Label>
            </div>
          ))}
        </RadioGroup>
      </div>

      {/* Days input */}
      {termType !== "cod" && termType !== "early_pay" && (
        <div className="space-y-1">
          <Label className="text-xs">Days (comma or slash separated)</Label>
          <Input
            value={daysInput}
            onChange={e => setDaysInput(e.target.value)}
            placeholder="30, 60, 90"
            className="h-8 text-xs"
          />
        </div>
      )}

      {/* Early pay fields */}
      {termType === "early_pay" && (
        <div className="grid grid-cols-3 gap-2">
          <div>
            <Label className="text-xs">Discount %</Label>
            <Input type="number" value={discountPct} onChange={e => setDiscountPct(Number(e.target.value))} className="h-8 text-xs" />
          </div>
          <div>
            <Label className="text-xs">Discount Days</Label>
            <Input type="number" value={discountDays} onChange={e => setDiscountDays(Number(e.target.value))} className="h-8 text-xs" />
          </div>
          <div>
            <Label className="text-xs">Net Days</Label>
            <Input type="number" value={netDays} onChange={e => setNetDays(Number(e.target.value))} className="h-8 text-xs" />
          </div>
        </div>
      )}

      {/* EOM toggle (for net types) */}
      {(termType === "net_single" || termType === "net_split") && (
        <div className="flex items-center gap-2">
          <Switch checked={eomBased} onCheckedChange={setEomBased} />
          <Label className="text-xs">EOM Based</Label>
        </div>
      )}

      {/* Preview */}
      {previewInstallments.length > 0 && (
        <div className="space-y-1">
          <Label className="text-xs font-semibold">Preview Due Dates</Label>
          <div className="space-y-1">
            {previewInstallments.map((inst, i) => (
              <div key={i} className="flex items-center justify-between text-xs p-2 rounded border border-border bg-card">
                <span className="text-muted-foreground">
                  {inst.installment_label ? `Installment ${inst.installment_label}` : "Payment"}
                </span>
                <span className="font-medium tabular-nums">{formatCurrency(inst.amount_due)}</span>
                <span className="text-muted-foreground">{formatDate(inst.due_date)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Button
        onClick={handleConfirm}
        disabled={confirming || days.length === 0}
        className="w-full"
        size="sm"
      >
        {confirming ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Check className="h-3 w-3 mr-1" />}
        Confirm Terms & Generate Payments
      </Button>
    </div>
    </>
  );
}
