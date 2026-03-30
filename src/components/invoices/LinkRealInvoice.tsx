import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link2, Search, Upload, Camera, CheckCircle2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency, formatDate, isProforma, type VendorInvoice } from "@/lib/supabase-queries";
import { insertInvoice, type VendorInvoiceInsert } from "@/lib/supabase-queries";
import { generatePaymentsForInvoice } from "@/lib/payment-queries";
import { isImageFile, imageToBase64, callAnthropicImageAPI } from "@/lib/photo-capture-engine";
import { parsedToInvoice, callAnthropicAPI, fileToBase64 } from "@/lib/reader-engine";
import { checkInvoiceDuplicate } from "@/lib/invoice-dedup";

interface Props {
  proforma: VendorInvoice;
  onLinked: () => void;
}

export function LinkRealInvoice({ proforma, onLinked }: Props) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [linking, setLinking] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Fetch same-vendor invoices (non-proforma) for linking
  const { data: candidates = [] } = useQuery({
    queryKey: ["link_candidates", proforma.vendor, search],
    queryFn: async () => {
      let query = supabase
        .from("vendor_invoices")
        .select("id, vendor, invoice_number, po_number, invoice_date, total, doc_type, status")
        .eq("vendor", proforma.vendor)
        .neq("id", proforma.id)
        .is("linked_proforma_id" as any, null)
        .order("invoice_date", { ascending: false })
        .limit(20);

      if (search) {
        const s = `%${search}%`;
        query = query.or(`invoice_number.ilike.${s},po_number.ilike.${s}`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).filter(d => !isProforma(d));
    },
    enabled: expanded,
  });

  const linkInvoice = async (realInvoiceId: string, realInvoiceNumber: string) => {
    setLinking(true);
    try {
      // Set the link on the real invoice
      const { error: e1 } = await supabase
        .from("vendor_invoices")
        .update({ linked_proforma_id: proforma.id } as any)
        .eq("id", realInvoiceId);
      if (e1) throw e1;

      // Mark proforma as superseded
      const { error: e2 } = await supabase
        .from("vendor_invoices")
        .update({
          proforma_superseded_by: realInvoiceId,
          status: "paid", // Mark as resolved
          notes: `${proforma.notes ? proforma.notes + "\n" : ""}Superseded by real invoice ${realInvoiceNumber}`,
        } as any)
        .eq("id", proforma.id);
      if (e2) throw e2;

      toast.success(`✅ Linked to real invoice ${realInvoiceNumber}`);
      queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
      onLinked();
    } catch (err: any) {
      toast.error(`Failed to link: ${err.message}`);
    } finally {
      setLinking(false);
    }
  };

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const apiKey = localStorage.getItem("anthropic_api_key") || "";
    if (!apiKey) {
      toast.error("Please set your Anthropic API key on the Reader page first");
      return;
    }

    setUploading(true);
    try {
      let parsed: any;

      if (isImageFile(file)) {
        const { base64, mediaType } = await imageToBase64(file);
        parsed = await callAnthropicImageAPI(apiKey, base64, mediaType);
      } else {
        const b64 = await fileToBase64(file);
        parsed = await callAnthropicAPI(apiKey, b64);
      }

      const invoice = parsedToInvoice(parsed, file.name);
      invoice.import_source = isImageFile(file) ? "photo_capture" : "manual";
      invoice.linked_proforma_id = proforma.id as any;

      // Dedup check
      const dedup = await checkInvoiceDuplicate(
        invoice.invoice_number, invoice.vendor, parsed.line_items || [], invoice.total || 0
      );
      if (dedup.type === "true_duplicate") {
        // Link the existing one instead
        await linkInvoice(dedup.existingId!, invoice.invoice_number);
        return;
      }

      const saved = await insertInvoice(invoice);

      // Generate payments for the real invoice
      try {
        await generatePaymentsForInvoice(
          saved.id, invoice.invoice_date, invoice.total || 0,
          invoice.vendor, invoice.invoice_number, invoice.po_number ?? null
        );
      } catch { /* silent */ }

      // Mark proforma superseded
      const { error: e2 } = await supabase
        .from("vendor_invoices")
        .update({
          proforma_superseded_by: saved.id,
          status: "paid",
          notes: `${proforma.notes ? proforma.notes + "\n" : ""}Superseded by real invoice ${invoice.invoice_number}`,
        } as any)
        .eq("id", proforma.id);
      if (e2) throw e2;

      toast.success(`✅ Real invoice uploaded and linked: ${invoice.invoice_number}`);
      queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
      onLinked();
    } catch (err: any) {
      toast.error(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  }, [proforma, queryClient, onLinked]);

  // If already superseded, show that info
  if ((proforma as any).proforma_superseded_by) {
    return (
      <div className="mb-4 p-3 rounded-lg bg-primary/5 border border-primary/20">
        <p className="text-xs text-primary font-medium flex items-center gap-1">
          <CheckCircle2 className="h-3.5 w-3.5" /> Superseded — real invoice linked
        </p>
      </div>
    );
  }

  if (!expanded) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="text-xs h-8 gap-1.5 mb-4 w-full border-dashed border-primary/40 text-primary hover:bg-primary/5"
        onClick={() => setExpanded(true)}
      >
        <Link2 className="h-3.5 w-3.5" /> Link Real Invoice
      </Button>
    );
  }

  return (
    <Card className="mb-4 border-primary/30 bg-primary/5">
      <CardContent className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-primary flex items-center gap-1">
            <Link2 className="h-3.5 w-3.5" /> Link Real Invoice
          </p>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setExpanded(false)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Upload new */}
        <div>
          <label className="text-[10px] text-muted-foreground font-medium mb-1 block">Upload the paper invoice</label>
          <label className="cursor-pointer">
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.heic,.webp"
              className="hidden"
              onChange={handleUpload}
              disabled={uploading}
            />
            <div className="flex items-center gap-2 p-2.5 rounded-lg border border-dashed border-border hover:border-primary/50 hover:bg-primary/5 transition-colors">
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : (
                <Camera className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="text-xs text-muted-foreground">
                {uploading ? "Processing…" : "Snap photo or drop PDF"}
              </span>
            </div>
          </label>
        </div>

        <div className="flex items-center gap-2">
          <Separator className="flex-1" />
          <span className="text-[10px] text-muted-foreground">or pick existing</span>
          <Separator className="flex-1" />
        </div>

        {/* Search existing */}
        <div className="relative">
          <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search by invoice # or PO #…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-7 h-8 text-xs bg-secondary border-border"
          />
        </div>

        <div className="max-h-[200px] overflow-y-auto space-y-1">
          {candidates.length === 0 ? (
            <p className="text-[10px] text-muted-foreground text-center py-2">
              {search ? "No matching invoices found" : "No unlinked invoices from this vendor"}
            </p>
          ) : (
            candidates.map(c => (
              <button
                key={c.id}
                className="w-full flex items-center justify-between p-2 rounded hover:bg-accent/50 transition-colors text-left"
                onClick={() => linkInvoice(c.id, c.invoice_number)}
                disabled={linking}
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{c.invoice_number}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {c.po_number && `PO ${c.po_number} · `}{formatDate(c.invoice_date)}
                  </p>
                </div>
                <span className="text-xs font-medium tabular-nums shrink-0 ml-2">
                  {formatCurrency(c.total)}
                </span>
              </button>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
