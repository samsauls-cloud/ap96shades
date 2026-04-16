import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { CheckCircle2, AlertCircle, AlertTriangle, Loader2, X } from "lucide-react";
import { formatCurrency, isCreditMemo } from "@/lib/supabase-queries";
import { resolvePaymentSchedule } from "@/lib/payment-terms-engine";
import { getVendorTermsRule } from "@/lib/vendor-terms-registry";
import type { ProcessedDoc } from "@/lib/reader-engine";

interface Props {
  doc: ProcessedDoc;
  onApprove: (docId: string, confirmedTerms: string) => Promise<void>;
  onDiscard: (docId: string) => void;
}

export function InvoiceReviewCard({ doc, onApprove, onDiscard }: Props) {
  const [terms, setTerms] = useState(doc.reviewTerms ?? "");
  const [saving, setSaving] = useState(false);

  const vendor = doc.vendor || doc.parsedData?.vendor || "";
  const invoiceNumber = doc.invoice_number || doc.parsedData?.invoice_number || "";
  const invoiceDate = doc.invoiceData?.invoice_date || doc.parsedData?.invoice_date || "";
  const total = doc.total || doc.invoiceData?.total || 0;
  const termsConfidence = doc.parsedData?.payment_terms_extracted?.confidence ?? "low";
  const isNewVendor = getVendorTermsRule(vendor) === null;
  const isCredit = isCreditMemo({ doc_type: doc.doc_type || doc.parsedData?.doc_type || "" });

  // Marcolin dual-terms detection
  const isMarcolinVendor = /marcolin|tom ford|guess|swarovski|montblanc/i.test(vendor);
  const marcolinPreset = doc.parsedData?.terms_preset as string | undefined;
  const marcolinSourceText = doc.parsedData?.terms_source_text as string | undefined;
  const marcolinUncertain = isMarcolinVendor && (!marcolinPreset || marcolinPreset === "uncertain" || termsConfidence === "low");

  // Marcolin preset dropdown state
  const [selectedMarcolinPreset, setSelectedMarcolinPreset] = useState<string>(
    marcolinPreset === "check_20_eom" ? "Check 20 EoM"
      : marcolinPreset === "eom_50_80_110" ? "EOM 50/80/110"
      : ""
  );

  // When Marcolin preset changes, sync the terms text field
  const effectiveTerms = isMarcolinVendor && selectedMarcolinPreset
    ? selectedMarcolinPreset
    : terms;

  const previewInstallments = useMemo(() => {
    if (isCredit || !effectiveTerms.trim() || !invoiceDate) return [];
    try {
      const schedule = resolvePaymentSchedule(
        vendor,
        "Procurement",
        new Date(invoiceDate),
        total,
        effectiveTerms
      );
      return schedule.tranches.map((t) => ({
        label: t.tranche_label,
        dueDate: t.due_date.toLocaleDateString("en-US", {
          month: "short", day: "numeric", year: "numeric",
        }),
        amount: total * t.amount_fraction,
      }));
    } catch {
      return [];
    }
  }, [effectiveTerms, invoiceDate, vendor, total, isCredit]);

  const handleApprove = async () => {
    setSaving(true);
    try {
      const finalTerms = isCredit ? "credit_memo" : effectiveTerms;
      await onApprove(doc.id, finalTerms);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className={`bg-card border-2 ${isCredit ? "border-emerald-500/40" : "border-primary/30"}`}>
      <CardContent className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${isCredit ? "bg-emerald-500" : "bg-primary"} animate-pulse`} />
          <span className="text-sm font-semibold">
            {isCredit ? "Credit Memo — Review Before Saving" : "Review Before Saving"}
          </span>
          <span className="text-xs text-muted-foreground ml-auto truncate max-w-[180px]">{doc.filename}</span>
        </div>

        {/* Vendor + Invoice info — read only */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-muted-foreground mb-0.5">Vendor</p>
            <p className="font-medium">{vendor}</p>
          </div>
          <div>
            <p className="text-muted-foreground mb-0.5">{isCredit ? "Credit #" : "Invoice #"}</p>
            <p className="font-medium font-mono">{invoiceNumber}</p>
          </div>
          <div>
            <p className="text-muted-foreground mb-0.5">{isCredit ? "Credit Date" : "Invoice Date"}</p>
            <p className="font-medium">{invoiceDate}</p>
          </div>
          <div>
            <p className="text-muted-foreground mb-0.5">Total</p>
            <p className={`font-bold text-base ${isCredit ? "text-emerald-600" : ""}`}>
              {isCredit ? `–${formatCurrency(Math.abs(total))}` : formatCurrency(total)}
            </p>
          </div>
        </div>

        {/* Credit memo info banner */}
        {isCredit && (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
            <p className="text-[10px] text-emerald-600 font-medium mb-1">
              💳 Credit Memo
            </p>
            <p className="text-[10px] text-muted-foreground">
              This credit will be saved with confirmed terms and a single "Credit" payment row. 
              The negative balance will automatically offset the vendor's AP total.
            </p>
          </div>
        )}

        {/* PAYMENT TERMS — editable (hidden for credit memos) */}
        {!isCredit && (
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Payment Terms
            </label>
            <Input
              value={terms}
              onChange={e => setTerms(e.target.value)}
              placeholder="e.g. EOM +30 Days, Net 30, 30/60/90"
              className="text-sm"
            />
            {termsConfidence === "low" && (
              <p className="text-[10px] text-amber-500 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Terms were not clearly stated on this invoice — please confirm or enter manually.
              </p>
            )}
            {termsConfidence === "medium" && (
              <p className="text-[10px] text-amber-400 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                Terms were interpreted from context — please verify they are correct.
              </p>
            )}
            {termsConfidence === "high" && (
              <p className="text-[10px] text-emerald-500 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Terms clearly stated on invoice.
              </p>
            )}
          </div>
        )}

        {/* PAYMENT SCHEDULE PREVIEW (hidden for credit memos) */}
        {!isCredit && terms.trim() && (
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Payment Schedule Preview
            </label>
            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
              {previewInstallments.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">
                  Could not compute schedule from these terms. Try a format like "Net 30", "EOM 30/60/90", etc.
                </p>
              ) : (
                previewInstallments.map((inst, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{inst.label}</span>
                    <span className="font-mono">{inst.dueDate}</span>
                    <span className="font-semibold tabular-nums">
                      {formatCurrency(inst.amount)}
                    </span>
                  </div>
                ))
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">
              Computed from invoice date ({invoiceDate}) and the terms above.
            </p>
          </div>
        )}

        {/* NEW VENDOR NOTE (hidden for credit memos) */}
        {!isCredit && isNewVendor && (
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
            <p className="text-[10px] text-blue-400 font-medium mb-1">
              📋 New Vendor — {vendor}
            </p>
            <p className="text-[10px] text-muted-foreground">
              This vendor is not yet in the terms registry. The payment schedule
              will be generated using the terms you confirm above.
            </p>
          </div>
        )}

        {/* ACTION BUTTONS */}
        <div className="flex gap-2 pt-1">
          <Button
            className={`flex-1 gap-1.5 ${isCredit ? "bg-emerald-600 hover:bg-emerald-700" : ""}`}
            onClick={handleApprove}
            disabled={(!isCredit && !terms.trim()) || saving}
          >
            {saving ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</>
            ) : (
              <><CheckCircle2 className="h-3.5 w-3.5" /> {isCredit ? "Approve Credit" : "Approve & Save"}</>
            )}
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="gap-1.5 text-muted-foreground"
                disabled={saving}
              >
                <X className="h-3.5 w-3.5" /> Discard
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Discard this invoice?</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to discard this invoice? It will not be saved.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onDiscard(doc.id)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Discard
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}
