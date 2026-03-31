import { useState, useEffect } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Trash2, Copy, Download, DollarSign, Loader2, ScanSearch, FileCheck, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { StatusBadge, DocTypeBadge } from "./Badges";
import { MatchReportSection } from "./MatchReportSection";
import { TagInput } from "./TagInput";
import { SKUCheckTab } from "./SKUCheckTab";
import { TermsConfirmationPanel } from "./TermsConfirmationPanel";
import type { VendorInvoice, InvoiceStatus } from "@/lib/supabase-queries";
import { formatCurrency, formatDate, getLineItems, getTotalUnits, lineItemsToCSV, updateInvoiceStatus, updateInvoiceNotes, updateInvoiceTags, fetchDistinctTags, deleteInvoice, isProforma } from "@/lib/supabase-queries";
import { generatePaymentsForInvoice, fetchPaymentsForInvoice } from "@/lib/payment-queries";
import { supabase } from "@/integrations/supabase/client";
import { LinkRealInvoice } from "./LinkRealInvoice";

interface Props {
  invoice: VendorInvoice | null;
  open: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

export function InvoiceDrawer({ invoice, open, onClose, onUpdate }: Props) {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [generatingPayments, setGeneratingPayments] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<InvoiceStatus | null>(null);
  const inv = invoice;

  const { data: allTags = [] } = useQuery({
    queryKey: ["distinct_tags"],
    queryFn: fetchDistinctTags,
  });

  const { data: existingPayments = [] } = useQuery({
    queryKey: ["invoice_payments_detail", inv?.id],
    queryFn: () => fetchPaymentsForInvoice(inv!.id),
    enabled: !!inv,
  });

  useEffect(() => {
    if (inv) {
      setNotes(inv.notes || "");
      setTags((inv as any).tags ?? []);
    }
  }, [inv]);

  if (!inv) return null;

  const lineItems = getLineItems(inv);
  const statuses: InvoiceStatus[] = ["unpaid", "paid", "partial", "disputed"];

  const handleStatusChange = async (status: InvoiceStatus) => {
    // Confirm when changing FROM paid to something else
    if (inv.status === 'paid' && status !== 'paid') {
      setPendingStatus(status);
      return;
    }
    await applyStatusChange(status);
  };

  const applyStatusChange = async (status: InvoiceStatus) => {
    try {
      await updateInvoiceStatus(inv.id, status);
      toast.success(`Status updated to ${status}`);
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_payments_detail", inv.id] });
      onUpdate();
    } catch { toast.error("Failed to update status"); }
    finally { setPendingStatus(null); }
  };

  const handleNotesBlur = async () => {
    if (notes !== (inv.notes || "")) {
      try {
        await updateInvoiceNotes(inv.id, notes);
        toast.success("Notes saved");
        onUpdate();
      } catch { toast.error("Failed to save notes"); }
    }
  };

  const handleDelete = async () => {
    try {
      await deleteInvoice(inv.id);
      toast.success("Invoice deleted");
      onClose();
      onUpdate();
    } catch { toast.error("Failed to delete"); }
  };

  const copyJSON = () => {
    navigator.clipboard.writeText(JSON.stringify(inv, null, 2));
    toast.success("JSON copied to clipboard");
  };

  const copyLineItemsCSV = () => {
    navigator.clipboard.writeText(lineItemsToCSV(inv));
    toast.success("Line items CSV copied to clipboard");
  };

  const meta = [
    { label: "Vendor", value: inv.vendor },
    { label: "Doc Type", value: inv.doc_type },
    { label: "Invoice #", value: inv.invoice_number },
    { label: "PO #", value: inv.po_number ?? "—" },
    { label: "Account #", value: inv.account_number ?? "—" },
    { label: "Date", value: formatDate(inv.invoice_date) },
    { label: "Ship To", value: inv.ship_to ?? "—" },
    { label: "Carrier", value: inv.carrier ?? "—" },
    { label: "Terms", value: inv.payment_terms ?? "—" },
    { label: "Currency", value: inv.currency },
    { label: "Subtotal", value: formatCurrency(inv.subtotal) },
    { label: "Tax", value: formatCurrency(inv.tax) },
    { label: "Freight", value: formatCurrency(inv.freight) },
    { label: "Total", value: formatCurrency(inv.total) },
    { label: "Units", value: getTotalUnits(inv).toString() },
    { label: "Brands", value: inv.vendor_brands?.join(", ") ?? "—" },
    { label: "Filename", value: inv.filename ?? "—" },
    { label: "Imported", value: formatDate(inv.imported_at) },
  ];

  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto bg-card border-border">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2">
            <DocTypeBadge docType={inv.doc_type} />
            <span>{inv.vendor} — {inv.invoice_number}</span>
          </SheetTitle>
        </SheetHeader>

        {/* Proforma banner + link action */}
        {isProforma(inv) && (
          <>
            <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/30">
              <p className="text-sm font-semibold text-destructive flex items-center gap-2">
                🚫 PROFORMA — NOT INCLUDED IN AP TOTALS
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Real invoice expected. When received, upload the financial invoice to replace this.
              </p>
            </div>
            <LinkRealInvoice proforma={inv} onLinked={onUpdate} />
          </>
        )}

        {/* Linked proforma banner (shown on real invoices) */}
        {(inv as any).linked_proforma_id && (
          <div className="mb-4 p-3 rounded-lg bg-primary/5 border border-primary/20">
            <p className="text-xs text-primary font-medium flex items-center gap-1.5">
              <FileCheck className="h-3.5 w-3.5" /> Proforma on file: {inv.po_number || inv.invoice_number}
            </p>
          </div>
        )}

        {/* Status editor */}
        <div className="flex gap-2 mb-4">
          {statuses.map(s => (
            <Button
              key={s}
              size="sm"
              variant={inv.status === s ? "default" : "outline"}
              className="text-xs h-7 capitalize"
              onClick={() => handleStatusChange(s)}
              disabled={isProforma(inv)}
            >
              {s}
            </Button>
          ))}
        </div>

        {/* Confirm revert from paid */}
        <AlertDialog open={!!pendingStatus} onOpenChange={(o) => !o && setPendingStatus(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Change status from Paid?</AlertDialogTitle>
              <AlertDialogDescription>
                Mark this invoice as <span className="font-semibold capitalize">{pendingStatus}</span>? This will revert its paid status.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => pendingStatus && applyStatusChange(pendingStatus)}>
                Confirm
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Separator className="mb-4" />

        {/* Metadata grid */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 mb-4 text-sm">
          {meta.map(m => (
            <div key={m.label} className="flex justify-between">
              <span className="text-muted-foreground text-xs">{m.label}</span>
              <span className="font-medium text-xs text-right">{m.value}</span>
            </div>
          ))}
        </div>

        <Separator className="mb-4" />

        {/* Multi-shipment banner */}
        {(inv as any).is_multi_shipment && (
          <div className="mb-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <p className="text-sm font-medium text-blue-500 flex items-center gap-2">
              📦 Multi-Shipment Invoice — {(inv as any).shipment_count || 2} shipments
              {(inv as any).last_shipment_date && (
                <span className="text-[10px] text-muted-foreground font-normal">
                  · Last received: {formatDate((inv as any).last_shipment_date)}
                  {(inv as any).last_shipment_file && ` from ${(inv as any).last_shipment_file}`}
                </span>
              )}
            </p>
          </div>
        )}

        {/* PO total invoiced */}
        {(inv as any).po_total_invoiced && inv.po_number && (
          <div className="mb-4 p-3 rounded-lg bg-primary/5 border border-primary/20">
            <p className="text-[10px] text-primary font-medium">
              PO {inv.po_number} — Total invoiced: {formatCurrency((inv as any).po_total_invoiced)}
            </p>
          </div>
        )}

        <Separator className="mb-4" />

        {/* Notes */}
        <div className="mb-4">
          <label className="text-xs font-semibold text-muted-foreground mb-1 block">Notes</label>
          <Textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
            className="bg-secondary border-border text-sm min-h-[60px]"
            placeholder="Add notes…"
          />
        </div>

        {/* Tags */}
        <div className="mb-4">
          <label className="text-xs font-semibold text-muted-foreground mb-1 block">Tags</label>
          <TagInput
            tags={tags}
            onChange={async (newTags) => {
              setTags(newTags);
              try {
                await updateInvoiceTags(inv.id, newTags);
                toast.success("Tags saved");
                onUpdate();
              } catch { toast.error("Failed to save tags"); }
            }}
            suggestions={allTags}
          />
        </div>

        <Separator className="mb-4" />

        {/* Line Items / SKU Check Tabs */}
        <Tabs defaultValue="line-items" className="mb-4">
          <TabsList className="h-8">
            <TabsTrigger value="line-items" className="text-xs h-6">Line Items ({lineItems.length})</TabsTrigger>
            <TabsTrigger value="sku-check" className="text-xs h-6 gap-1">
              <ScanSearch className="h-3 w-3" /> SKU Check
            </TabsTrigger>
          </TabsList>
          <TabsContent value="line-items">
            {lineItems.length > 0 ? (
              <div className="rounded border border-border overflow-auto max-h-[400px]">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border text-[10px]">
                      <TableHead className="text-[10px] font-semibold">UPC</TableHead>
                      <TableHead className="text-[10px] font-semibold">Item #</TableHead>
                      <TableHead className="text-[10px] font-semibold">Brand</TableHead>
                      <TableHead className="text-[10px] font-semibold">Model</TableHead>
                      <TableHead className="text-[10px] font-semibold">Color</TableHead>
                      <TableHead className="text-[10px] font-semibold">Color Desc</TableHead>
                      <TableHead className="text-[10px] font-semibold">Size</TableHead>
                      <TableHead className="text-[10px] font-semibold">Temple</TableHead>
                      <TableHead className="text-[10px] font-semibold text-right">Ord</TableHead>
                      <TableHead className="text-[10px] font-semibold text-right">Ship</TableHead>
                      <TableHead className="text-[10px] font-semibold text-right">Price</TableHead>
                      <TableHead className="text-[10px] font-semibold text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lineItems.map((li, i) => {
                      const shortShip = (li.qty_shipped != null && li.qty_ordered != null && li.qty_shipped < li.qty_ordered);
                      return (
                        <TableRow key={i} className="border-border">
                          <TableCell className="text-[10px] font-mono">{li.upc ?? "—"}</TableCell>
                          <TableCell className="text-[10px] font-mono">{li.item_number ?? "—"}</TableCell>
                          <TableCell className="text-[10px]">{li.brand ?? "—"}</TableCell>
                          <TableCell className="text-[10px]">{li.model ?? "—"}</TableCell>
                          <TableCell className="text-[10px] font-mono">{li.color_code ?? "—"}</TableCell>
                          <TableCell className="text-[10px]">{li.color_desc ?? "—"}</TableCell>
                          <TableCell className="text-[10px]">{li.size ?? "—"}</TableCell>
                          <TableCell className="text-[10px]">{li.temple ?? "—"}</TableCell>
                          <TableCell className="text-[10px] text-right tabular-nums">{li.qty_ordered ?? "—"}</TableCell>
                          <TableCell className={`text-[10px] text-right tabular-nums ${shortShip ? "text-status-unpaid font-bold" : ""}`}>
                            {li.qty_shipped ?? "—"}
                          </TableCell>
                          <TableCell className="text-[10px] text-right tabular-nums">{formatCurrency(li.unit_price)}</TableCell>
                          <TableCell className="text-[10px] text-right tabular-nums font-medium">{formatCurrency(li.line_total)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No line items</p>
            )}
          </TabsContent>
          <TabsContent value="sku-check">
            <SKUCheckTab invoice={inv} />
          </TabsContent>
        </Tabs>

        {/* Match Report */}
        <MatchReportSection invoice={inv} />

        {/* Terms Confirmation Panel — show when needs_review */}
        {!isProforma(inv) && (inv as any).terms_status === "needs_review" && (
          <TermsConfirmationPanel invoice={inv} onConfirmed={onUpdate} />
        )}

        {/* Medium confidence banner */}
        {!isProforma(inv) && (inv as any).terms_confidence === "medium" && (inv as any).terms_status === "confirmed" && (
          <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <p className="text-xs text-amber-700 font-medium flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5" /> Terms interpreted — verify before payment
            </p>
          </div>
        )}

        {/* Payment schedule — show for confirmed or when payments exist */}
        {!isProforma(inv) && ((inv as any).terms_status === "confirmed" || existingPayments.length > 0) && (
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-muted-foreground">Payment Schedule</h3>
              {existingPayments.length === 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7"
                  disabled={generatingPayments}
                  onClick={async () => {
                    setGeneratingPayments(true);
                    try {
                      const count = await generatePaymentsForInvoice(
                        inv.id, inv.invoice_date, inv.total, inv.vendor, inv.invoice_number, inv.po_number
                      );
                      toast.success(`Generated ${count} payment installments`);
                      queryClient.invalidateQueries({ queryKey: ["invoice_payments_detail", inv.id] });
                      queryClient.invalidateQueries({ queryKey: ["invoice_payments"] });
                      queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
                      queryClient.invalidateQueries({ queryKey: ["ap_full_audit"] });
                    } catch { toast.error("Failed to generate payments"); }
                    finally { setGeneratingPayments(false); }
                  }}
                >
                  {generatingPayments ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <DollarSign className="h-3 w-3 mr-1" />}
                  Generate Payments
                </Button>
              )}
            </div>
            {existingPayments.length > 0 ? (
              <div className="space-y-1">
                {existingPayments.map(p => (
                  <div key={p.id} className={`flex items-center justify-between text-[10px] p-2 rounded border border-border ${p.is_paid ? "opacity-50" : ""}`}>
                    <span>{p.installment_label} — Due {formatDate(p.due_date)}</span>
                    <span className="font-medium tabular-nums">{formatCurrency(Number(p.amount_due))}</span>
                    <span className={p.is_paid ? "text-green-500" : "text-muted-foreground"}>
                      {p.is_paid ? "✓ Paid" : "Unpaid"}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground">No payment schedule generated yet.</p>
            )}
          </div>
        )}

        <Separator className="my-4" />

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={copyJSON}>
            <Copy className="h-3 w-3 mr-1" /> Copy JSON
          </Button>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={copyLineItemsCSV}>
            <Download className="h-3 w-3 mr-1" /> Copy Line Items CSV
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="text-xs h-7 ml-auto">
                <Trash2 className="h-3 w-3 mr-1" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="bg-card border-border">
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this invoice?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete {inv.vendor} — {inv.invoice_number}. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </SheetContent>
    </Sheet>
  );
}

