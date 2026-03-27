import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Circle, XCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { supabase } from "@/integrations/supabase/client";
import { applyVendorDiscount } from "@/lib/vendor-pricing-rules";

interface ParsedRow {
  order_qty: number;
  unit_cost: number;
  system_id: string;
  vendor_id: string;
  upc: string;
  ean: string;
  custom_sku: string;
  manufacturer_sku: string;
  description: string;
  price: number;
  matchStatus: "matched" | "qty_mismatch" | "price_mismatch" | "new" | "not_found";
  matchDetail?: string;
  raw: Record<string, string>;
}

const VENDORS = [
  "Marchon", "Luxottica", "Safilo", "Marcolin", "Kering",
  "Maui Jim", "Chanel", "Costa del Mar",
];

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    const vals = line.match(/("([^"]|"")*"|[^,]*)/g) ?? [];
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (vals[i] ?? "").replace(/^"|"$/g, "").replace(/""/g, '"').trim();
    });
    return row;
  });
}

export default function LightspeedImportPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [vendor, setVendor] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);

  // Fetch existing invoice line items for match checking
  const { data: existingInvoices = [] } = useQuery({
    queryKey: ["all_invoice_lines_for_match"],
    queryFn: async () => {
      const { data } = await supabase
        .from("vendor_invoices")
        .select("id, vendor, line_items, invoice_number")
        .order("invoice_date", { ascending: false });
      return data ?? [];
    },
  });

  const existingUPCMap = useMemo(() => {
    const map = new Map<string, { qty: number; price: number; invoice_number: string }>();
    for (const inv of existingInvoices) {
      const items = Array.isArray(inv.line_items) ? inv.line_items : [];
      for (const li of items as any[]) {
        const upc = li.upc?.trim();
        if (!upc) continue;
        map.set(upc, {
          qty: li.qty_shipped ?? li.qty_ordered ?? li.qty ?? 0,
          price: li.unit_price ?? 0,
          invoice_number: inv.invoice_number,
        });
      }
    }
    return map;
  }, [existingInvoices]);

  const handleFile = useCallback(async (f: File) => {
    setFile(f);
    setImported(false);
    const text = await f.text();
    const parsed = parseCSV(text);

    // Auto-detect PO number from filename
    const fnMatch = f.name.match(/PO[_-]?(\d+)/i);
    if (fnMatch) setPoNumber(fnMatch[1]);

    const mappedRows: ParsedRow[] = parsed.map(raw => {
      const upc = (raw["UPC"] || raw["upc"] || "").trim();
      const order_qty = parseInt(raw["Order Qty"] || raw["order_qty"] || "0") || 0;
      const unit_cost = parseFloat(raw["Unit Cost"] || raw["unit_cost"] || "0") || 0;
      const price = parseFloat(raw["Price"] || raw["price"] || "0") || 0;

      // Check match status
      let matchStatus: ParsedRow["matchStatus"] = "new";
      let matchDetail = "";

      if (upc) {
        const existing = existingUPCMap.get(upc);
        if (existing) {
          if (existing.qty === order_qty && Math.abs(existing.price - unit_cost) <= 0.50) {
            matchStatus = "matched";
            matchDetail = `Matches invoice ${existing.invoice_number}`;
          } else if (existing.qty !== order_qty) {
            matchStatus = "qty_mismatch";
            matchDetail = `Invoice has ${existing.qty}, PO has ${order_qty}`;
          } else {
            matchStatus = "price_mismatch";
            matchDetail = `Invoice: $${existing.price.toFixed(2)}, PO: $${unit_cost.toFixed(2)}`;
          }
        } else {
          matchStatus = "new";
          matchDetail = "UPC not yet in any invoice";
        }
      } else {
        matchStatus = "not_found";
        matchDetail = "No UPC";
      }

      return {
        order_qty,
        unit_cost,
        system_id: raw["System ID"] || raw["system_id"] || "",
        vendor_id: raw["Vendor ID"] || raw["vendor_id"] || "",
        upc,
        ean: raw["EAN"] || raw["ean"] || "",
        custom_sku: raw["Custom SKU"] || raw["custom_sku"] || "",
        manufacturer_sku: raw["Manufacturer SKU"] || raw["manufacturer_sku"] || raw["Manufact. SKU"] || "",
        description: raw["Description"] || raw["description"] || "",
        price,
        matchStatus,
        matchDetail,
        raw,
      };
    });

    setRows(mappedRows);
  }, [existingUPCMap]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith(".csv")) handleFile(f);
    else toast.error("Please upload a CSV file");
  };

  const stats = useMemo(() => ({
    total: rows.length,
    matched: rows.filter(r => r.matchStatus === "matched").length,
    qtyMismatch: rows.filter(r => r.matchStatus === "qty_mismatch").length,
    priceMismatch: rows.filter(r => r.matchStatus === "price_mismatch").length,
    newItems: rows.filter(r => r.matchStatus === "new").length,
    notFound: rows.filter(r => r.matchStatus === "not_found").length,
  }), [rows]);

  const handleImport = async () => {
    if (!vendor) { toast.error("Please select a vendor"); return; }
    if (rows.length === 0) { toast.error("No rows to import"); return; }

    setImporting(true);
    try {
      // Build line items
      let lineItems = rows.map(r => ({
        upc: r.upc,
        item_number: r.manufacturer_sku || r.system_id,
        description: r.description,
        qty_ordered: r.order_qty,
        qty_shipped: r.order_qty,
        unit_price: r.unit_cost,
        line_total: r.order_qty * r.unit_cost,
        model: r.description,
        brand: "",
      }));

      const subtotal = lineItems.reduce((s, li) => s + li.line_total, 0);
      let total = subtotal;

      // Apply vendor discount if applicable
      const discountResult = applyVendorDiscount(vendor, lineItems, subtotal, total);
      if (discountResult.discountApplied) {
        lineItems = discountResult.lineItems;
        total = discountResult.total ?? total;
      }

      const { error } = await supabase.from("vendor_invoices").insert({
        vendor,
        doc_type: "PO",
        invoice_number: poNumber || `LS-${Date.now()}`,
        invoice_date: new Date().toISOString().split("T")[0],
        subtotal: discountResult.subtotal ?? subtotal,
        total,
        line_items: lineItems as any,
        import_source: "lightspeed_csv",
        lightspeed_po_number: poNumber || null,
        status: "unpaid",
        notes: discountResult.discountApplied
          ? `Lightspeed CSV import. ${discountResult.discountPercent}% vendor discount applied automatically.`
          : "Lightspeed CSV import.",
        filename: file?.name,
      } as any);

      if (error) throw error;

      toast.success(
        `${rows.length} rows imported · ${stats.qtyMismatch} qty mismatches · ${stats.priceMismatch} price mismatches flagged`
      );
      setImported(true);
    } catch (err: any) {
      toast.error(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  };

  const statusIcon = (status: ParsedRow["matchStatus"]) => {
    switch (status) {
      case "matched": return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
      case "qty_mismatch": return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
      case "price_mismatch": return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
      case "new": return <Circle className="h-3.5 w-3.5 text-blue-500" />;
      case "not_found": return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    }
  };

  const statusLabel: Record<string, string> = {
    matched: "✅ MATCHED",
    qty_mismatch: "⚠️ QTY MISMATCH",
    price_mismatch: "⚠️ PRICE MISMATCH",
    new: "🔵 NEW",
    not_found: "❌ NOT FOUND",
  };

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Lightspeed PO Import</h1>
          <p className="text-xs text-muted-foreground">
            Import Lightspeed CSV purchase order exports. Match status is checked live against existing invoices.
          </p>
        </div>

        {/* Vendor & PO selection */}
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="text-xs font-semibold text-muted-foreground mb-1 block">Vendor</label>
            <Select value={vendor} onValueChange={setVendor}>
              <SelectTrigger className="h-8 w-[200px] text-xs"><SelectValue placeholder="Select vendor…" /></SelectTrigger>
              <SelectContent>
                {VENDORS.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-semibold text-muted-foreground mb-1 block">PO Number</label>
            <Input
              className="h-8 w-[200px] text-xs"
              placeholder="e.g. PO-12345"
              value={poNumber}
              onChange={e => setPoNumber(e.target.value)}
            />
          </div>
        </div>

        {/* Drop zone */}
        {rows.length === 0 && (
          <div
            className="border-2 border-dashed border-border rounded-lg p-12 text-center cursor-pointer hover:border-primary/50 transition-colors"
            onDragOver={e => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = ".csv";
              input.onchange = e => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) handleFile(f);
              };
              input.click();
            }}
          >
            <Upload className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm font-medium">Drop Lightspeed CSV here</p>
            <p className="text-xs text-muted-foreground mt-1">or click to browse</p>
          </div>
        )}

        {/* Preview stats */}
        {rows.length > 0 && (
          <>
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{file?.name}</span>
              <Badge variant="outline" className="text-[10px]">{rows.length} rows</Badge>
              <Button variant="ghost" size="sm" className="h-7 text-xs ml-auto" onClick={() => { setRows([]); setFile(null); setImported(false); }}>
                Clear
              </Button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: "Matched", count: stats.matched, color: "text-emerald-600 bg-emerald-500/10 border-emerald-500/20" },
                { label: "Qty Mismatch", count: stats.qtyMismatch, color: "text-amber-600 bg-amber-500/10 border-amber-500/20" },
                { label: "Price Mismatch", count: stats.priceMismatch, color: "text-amber-600 bg-amber-500/10 border-amber-500/20" },
                { label: "New (PO ahead)", count: stats.newItems, color: "text-blue-600 bg-blue-500/10 border-blue-500/20" },
                { label: "Not Found", count: stats.notFound, color: "text-destructive bg-destructive/10 border-destructive/20" },
              ].map(s => (
                <Card key={s.label} className={`border ${s.color}`}>
                  <CardContent className="p-3 flex items-center justify-between">
                    <span className="text-xs font-medium">{s.label}</span>
                    <span className="text-lg font-bold tabular-nums">{s.count}</span>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Preview table */}
            <div className="rounded-lg border border-border bg-card overflow-auto max-h-[500px]">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-[10px] font-semibold">Match</TableHead>
                    <TableHead className="text-[10px] font-semibold">UPC</TableHead>
                    <TableHead className="text-[10px] font-semibold">Description</TableHead>
                    <TableHead className="text-[10px] font-semibold">Mfr SKU</TableHead>
                    <TableHead className="text-[10px] font-semibold text-right">Order Qty</TableHead>
                    <TableHead className="text-[10px] font-semibold text-right">Unit Cost</TableHead>
                    <TableHead className="text-[10px] font-semibold text-right">Price</TableHead>
                    <TableHead className="text-[10px] font-semibold">Custom SKU</TableHead>
                    <TableHead className="text-[10px] font-semibold">Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={i} className="border-border">
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {statusIcon(r.matchStatus)}
                          <span className="text-[9px] font-medium">{statusLabel[r.matchStatus]}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-[10px] font-mono">{r.upc || "—"}</TableCell>
                      <TableCell className="text-[10px] max-w-[200px] truncate">{r.description || "—"}</TableCell>
                      <TableCell className="text-[10px] font-mono">{r.manufacturer_sku || "—"}</TableCell>
                      <TableCell className="text-[10px] text-right tabular-nums">{r.order_qty}</TableCell>
                      <TableCell className="text-[10px] text-right tabular-nums">${r.unit_cost.toFixed(2)}</TableCell>
                      <TableCell className="text-[10px] text-right tabular-nums">${r.price.toFixed(2)}</TableCell>
                      <TableCell className="text-[10px] font-mono">{r.custom_sku || "—"}</TableCell>
                      <TableCell className="text-[10px] text-muted-foreground max-w-[200px] truncate">{r.matchDetail}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Import button */}
            <div className="flex gap-3">
              <Button
                className="gap-1.5"
                disabled={importing || imported || !vendor}
                onClick={handleImport}
              >
                {importing && <Loader2 className="h-4 w-4 animate-spin" />}
                {imported ? "✅ Imported" : importing ? "Importing…" : `Import ${rows.length} Rows`}
              </Button>
              {imported && (
                <Button variant="outline" onClick={() => navigate("/invoices")}>
                  View in Invoice Database
                </Button>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
