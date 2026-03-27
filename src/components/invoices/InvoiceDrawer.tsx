import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Trash2, Copy, Download, DollarSign, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { StatusBadge, DocTypeBadge } from "./Badges";
import { MatchReportSection } from "./MatchReportSection";
import { TagInput } from "./TagInput";
import type { VendorInvoice, InvoiceStatus } from "@/lib/supabase-queries";
import { formatCurrency, formatDate, getLineItems, getTotalUnits, lineItemsToCSV, updateInvoiceStatus, updateInvoiceNotes, updateInvoiceTags, fetchDistinctTags, deleteInvoice } from "@/lib/supabase-queries";
import { generatePaymentsForInvoice, fetchPaymentsForInvoice } from "@/lib/payment-queries";
import { hasTermsEngine } from "@/lib/payment-terms";
import { supabase } from "@/integrations/supabase/client";

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
    try {
      await updateInvoiceStatus(inv.id, status);
      toast.success(`Status updated to ${status}`);
      onUpdate();
    } catch { toast.error("Failed to update status"); }
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

        {/* Status editor */}
        <div className="flex gap-2 mb-4">
          {statuses.map(s => (
            <Button
              key={s}
              size="sm"
              variant={inv.status === s ? "default" : "outline"}
              className="text-xs h-7 capitalize"
              onClick={() => handleStatusChange(s)}
            >
              {s}
            </Button>
          ))}
        </div>

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

        {/* Line items */}
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-muted-foreground mb-2">Line Items ({lineItems.length})</h3>
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
        </div>

        {/* Match Report */}
        <MatchReportSection invoice={inv} />

        {/* Reconciliation Status */}
        <ReconSection
          invoiceId={inv.id}
          reconStatus={(inv as any).recon_status}
          lastReconciled={(inv as any).last_reconciled_at}
          isStale={(inv as any).recon_stale === true}
          staleReason={(inv as any).recon_stale_reason}
          enteredAfterRecon={(inv as any).entered_after_recon === true}
        />
        {/* Payment schedule */}
        {hasTermsEngine(inv.vendor) && (
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
                      queryClient.invalidateQueries({ queryKey: ["ap_audit"] });
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

function ReconSection({ invoiceId, reconStatus, lastReconciled, isStale, staleReason, enteredAfterRecon }: {
  invoiceId: string; reconStatus?: string; lastReconciled?: string;
  isStale?: boolean; staleReason?: string | null; enteredAfterRecon?: boolean;
}) {
  const navigate = useNavigate();
  const { data: discrepancies = [] } = useQuery({
    queryKey: ["invoice_recon_discrepancies", invoiceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reconciliation_discrepancies")
        .select("*, reconciliation_runs!reconciliation_discrepancies_run_id_fkey(run_at, run_type, scope_description)")
        .eq("invoice_id", invoiceId)
        .order("created_at", { ascending: false });
      if (error) {
        // Fallback if join fails
        const { data: d2 } = await supabase
          .from("reconciliation_discrepancies")
          .select("*")
          .eq("invoice_id", invoiceId)
          .order("created_at", { ascending: false });
        return d2 ?? [];
      }
      return data ?? [];
    },
  });

  // Fetch recon run history for this invoice
  const { data: reconRuns = [] } = useQuery({
    queryKey: ["invoice_recon_runs", invoiceId],
    queryFn: async () => {
      // Get all run_ids this invoice was part of
      const { data: runIds } = await supabase
        .from("reconciliation_discrepancies")
        .select("run_id")
        .eq("invoice_id", invoiceId);
      const uniqueRunIds = [...new Set((runIds ?? []).map(r => r.run_id).filter(Boolean))];

      if (uniqueRunIds.length === 0) return [];

      const { data: runs } = await supabase
        .from("reconciliation_runs")
        .select("*")
        .in("id", uniqueRunIds)
        .order("run_at", { ascending: false });
      return runs ?? [];
    },
  });

  if (!reconStatus || reconStatus === "pending") return null;

  return (
    <div className="mb-4">
      <Separator className="mb-4" />
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-muted-foreground">Reconciliation Status</h3>
        {lastReconciled && <span className="text-[9px] text-muted-foreground">Last: {formatDate(lastReconciled)}</span>}
      </div>

      {/* Stale warning */}
      {isStale && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 mb-2">
          <p className="text-xs text-amber-700 font-medium">⟳ Stale — {staleReason ?? "Data changed since last reconciliation"}</p>
        </div>
      )}

      {/* Entered after recon warning */}
      {enteredAfterRecon && (
        <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 mb-2">
          <p className="text-xs text-blue-600 font-medium">⚠️ Entered after reconciliation run{lastReconciled ? ` on ${formatDate(lastReconciled)}` : ""}</p>
        </div>
      )}

      {reconStatus === "clean" && !isStale ? (
        <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
          <p className="text-xs text-emerald-600 font-medium">✅ Clean — no discrepancies found</p>
        </div>
      ) : discrepancies.length > 0 ? (
        <div className="space-y-1">
          {discrepancies.slice(0, 5).map(d => (
            <div key={d.id} className="flex items-center justify-between text-[10px] p-2 rounded border border-border">
              <span className="font-mono">{(d.discrepancy_type ?? "").replace(/_/g, " ")}</span>
              <span className={d.severity === "critical" ? "text-destructive font-bold" : "text-amber-600"}>
                {d.severity}
              </span>
              <span className="text-muted-foreground">{d.resolution_status}</span>
            </div>
          ))}
          {discrepancies.length > 5 && (
            <p className="text-[9px] text-muted-foreground">+ {discrepancies.length - 5} more</p>
          )}
          <Button variant="outline" size="sm" className="text-xs h-7 w-full mt-1" onClick={() => navigate(`/reconciliation?invoice=${invoiceId}`)}>
            View All in Reconciliation Center
          </Button>
        </div>
      ) : (
        <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
          <p className="text-xs text-destructive font-medium">⚠ Discrepancies found</p>
        </div>
      )}

      {/* Reconciliation Timeline */}
      {reconRuns.length > 0 && (
        <div className="mt-3">
          <h4 className="text-[10px] font-semibold text-muted-foreground mb-1.5">Reconciliation Timeline</h4>
          <div className="space-y-1">
            {reconRuns.slice(0, 5).map(run => {
              const runDiscrepancies = discrepancies.filter(d => d.run_id === run.id);
              const hasIssues = runDiscrepancies.some(d => d.resolution_status === "open");
              return (
                <div key={run.id} className="flex items-center justify-between text-[10px] p-2 rounded border border-border">
                  <span>{formatDate(run.run_at)}</span>
                  <Badge variant="outline" className="text-[8px]">
                    {(run as any).run_type === "full" ? "Full" : (run as any).run_type ?? "Full"}
                  </Badge>
                  <span className={hasIssues ? "text-destructive font-medium" : "text-emerald-600 font-medium"}>
                    {hasIssues ? `⚠ ${runDiscrepancies.length} issues` : "✅ Clean"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
