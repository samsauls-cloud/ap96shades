import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Trash2, Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { StatusBadge, DocTypeBadge } from "./Badges";
import { MatchReportSection } from "./MatchReportSection";
import { TagInput } from "./TagInput";
import type { VendorInvoice, InvoiceStatus } from "@/lib/supabase-queries";
import { formatCurrency, formatDate, getLineItems, getTotalUnits, lineItemsToCSV, updateInvoiceStatus, updateInvoiceNotes, updateInvoiceTags, fetchDistinctTags, deleteInvoice } from "@/lib/supabase-queries";

interface Props {
  invoice: VendorInvoice | null;
  open: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

export function InvoiceDrawer({ invoice, open, onClose, onUpdate }: Props) {
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const inv = invoice;

  const { data: allTags = [] } = useQuery({
    queryKey: ["distinct_tags"],
    queryFn: fetchDistinctTags,
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
