import { useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Upload, FileText, ExternalLink, CheckCircle2, AlertCircle, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Link } from "react-router-dom";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { DocTypeBadge, StatusBadge } from "@/components/invoices/Badges";
import { insertInvoice, formatCurrency, type VendorInvoiceInsert } from "@/lib/supabase-queries";

const CONCURRENCY = 5;

interface ProcessedDoc {
  id: string;
  filename: string;
  vendor: string;
  doc_type: string;
  invoice_number: string;
  total: number;
  line_items_count: number;
  status: "processing" | "done" | "error";
  error?: string;
  dbId?: string;
}

const SYSTEM_PROMPT = `You are a document data extractor for an optical retail business (NinetySix Shades). Extract data from vendor invoices AND purchase orders from: Maui Jim, Kering (Gucci, Saint Laurent, Balenciaga, Bottega Veneta, Alexander McQueen), Safilo (Carrera, Fossil, Hugo Boss, Jimmy Choo), Marcolin (Tom Ford, Guess, Swarovski, Montblanc), Luxottica (Ray-Ban, Oakley, Prada, Versace, Persol, Coach, DKNY, Dolce & Gabbana, Emporio Armani, Giorgio Armani, Burberry, Michael Kors, Tiffany, Vogue). Luxottica POs use fields: Order Number, Account Number, Carrier, Terms, Item Number, Color Code, Temple, Quantity Ordered, Quantity Shipped, Unit Cost, Extended Cost. Detect INVOICE vs PO. Return ONLY valid JSON: { doc_type, vendor, vendor_brands[], invoice_number, invoice_date (YYYY-MM-DD), po_number, account_number, ship_to, carrier, payment_terms, subtotal, tax, freight, total, currency, line_items[{upc, item_number, sku, description, brand, model, color_code, color_desc, size, temple, qty_ordered, qty_shipped, qty, unit_price, line_total}], notes }`;

export default function ReaderPage() {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("anthropic_api_key") || "");
  const [processing, setProcessing] = useState(false);
  const [queue, setQueue] = useState<File[]>([]);
  const [docs, setDocs] = useState<ProcessedDoc[]>([]);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchComplete, setBatchComplete] = useState(0);
  const cancelRef = useRef(false);

  const saveApiKey = (key: string) => {
    const cleanKey = key.replace(/[^\x20-\x7E]/g, '').trim();
    setApiKey(cleanKey);
    localStorage.setItem("anthropic_api_key", cleanKey);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter(f => f.type === "application/pdf");
    if (files.length === 0) { toast.error("Only PDF files are supported"); return; }
    setQueue(prev => [...prev, ...files]);
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter(f => f.type === "application/pdf");
    if (files.length === 0) return;
    setQueue(prev => [...prev, ...files]);
    e.target.value = "";
  }, []);

  const processFile = async (file: File, docId: string) => {
    const buffer = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

    const cleanKey = apiKey.replace(/[^\x20-\x7E]/g, '').trim();
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cleanKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [{
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          }, {
            type: "text",
            text: "Extract all invoice/PO data from this document. Return only valid JSON.",
          }],
        }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`API error ${response.status}: ${err}`);
    }

    const result = await response.json();
    const textContent = result.content?.find((c: any) => c.type === "text")?.text;
    if (!textContent) throw new Error("No text content in response");

    let jsonStr = textContent;
    const match = textContent.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) jsonStr = match[1];
    const parsed = JSON.parse(jsonStr.trim());

    const invoice: VendorInvoiceInsert = {
      vendor: parsed.vendor || "Unknown",
      doc_type: parsed.doc_type || "INVOICE",
      invoice_number: parsed.invoice_number || file.name,
      invoice_date: parsed.invoice_date || new Date().toISOString().split("T")[0],
      po_number: parsed.po_number,
      account_number: parsed.account_number,
      ship_to: parsed.ship_to,
      carrier: parsed.carrier,
      payment_terms: parsed.payment_terms,
      subtotal: parsed.subtotal,
      tax: parsed.tax,
      freight: parsed.freight,
      total: parsed.total || 0,
      currency: parsed.currency || "USD",
      vendor_brands: parsed.vendor_brands,
      notes: parsed.notes,
      filename: file.name,
      line_items: parsed.line_items || [],
    };

    const saved = await insertInvoice(invoice);

    setDocs(prev => prev.map(d => d.id === docId ? {
      ...d, status: "done" as const, vendor: invoice.vendor, doc_type: invoice.doc_type,
      invoice_number: invoice.invoice_number, total: invoice.total,
      line_items_count: (parsed.line_items || []).length, dbId: saved.id,
    } : d));
  };

  const processQueue = async () => {
    if (!apiKey) { toast.error("Please enter your Anthropic API key"); return; }
    if (queue.length === 0) { toast.error("No files in queue"); return; }

    setProcessing(true);
    cancelRef.current = false;
    const filesToProcess = [...queue];
    setBatchTotal(filesToProcess.length);
    setBatchComplete(0);
    setQueue([]);

    // Pre-create all doc entries as "processing"
    const fileDocPairs = filesToProcess.map(file => ({
      file,
      docId: crypto.randomUUID(),
    }));

    setDocs(prev => [
      ...prev,
      ...fileDocPairs.map(({ file, docId }) => ({
        id: docId,
        filename: file.name,
        vendor: "",
        doc_type: "",
        invoice_number: "",
        total: 0,
        line_items_count: 0,
        status: "processing" as const,
      })),
    ]);

    let completed = 0;

    for (let i = 0; i < fileDocPairs.length; i += CONCURRENCY) {
      if (cancelRef.current) {
        // Mark remaining as error
        const remaining = fileDocPairs.slice(i);
        setDocs(prev => prev.map(d =>
          remaining.some(r => r.docId === d.id) && d.status === "processing"
            ? { ...d, status: "error" as const, error: "Cancelled" }
            : d
        ));
        toast.info(`Batch cancelled. ${completed} of ${filesToProcess.length} processed.`);
        break;
      }

      const chunk = fileDocPairs.slice(i, i + CONCURRENCY);

      await Promise.all(
        chunk.map(async ({ file, docId }) => {
          try {
            await processFile(file, docId);
          } catch (err: any) {
            setDocs(prev => prev.map(d => d.id === docId
              ? { ...d, status: "error" as const, error: err.message }
              : d
            ));
          }
        })
      );

      completed += chunk.length;
      setBatchComplete(completed);
    }

    setProcessing(false);
    setBatchTotal(0);
    queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
    queryClient.invalidateQueries({ queryKey: ["distinct_vendors"] });
    if (!cancelRef.current) toast.success("Processing complete");
  };

  const handleCancel = () => {
    cancelRef.current = true;
    toast.info("Cancelling after current chunk finishes…");
  };

  // Session summary
  const doneDocs = docs.filter(d => d.status === "done");
  const totalValue = doneDocs.reduce((s, d) => s + d.total, 0);
  const totalLineItems = doneDocs.reduce((s, d) => s + d.line_items_count, 0);
  const invoiceCount = doneDocs.filter(d => d.doc_type === "INVOICE").length;
  const poCount = doneDocs.filter(d => d.doc_type === "PO").length;

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">

        {/* API Key */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Anthropic API Key</CardTitle>
          </CardHeader>
          <CardContent>
            <Input
              type="password"
              value={apiKey}
              onChange={e => saveApiKey(e.target.value)}
              placeholder="sk-ant-..."
              className="bg-secondary border-border font-mono text-xs max-w-md"
            />
            <p className="text-[10px] text-muted-foreground mt-1">Stored locally in your browser. Never sent to our servers.</p>
          </CardContent>
        </Card>

        {/* Drop zone */}
        <Card
          className="bg-card border-border border-dashed"
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
        >
          <CardContent className="p-8 flex flex-col items-center justify-center text-center">
            <Upload className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm font-medium mb-1">Drop PDF invoices here</p>
            <p className="text-xs text-muted-foreground mb-3">or click to browse files</p>
            <label>
              <input type="file" accept=".pdf" multiple onChange={handleFileInput} className="hidden" />
              <Button variant="outline" size="sm" className="text-xs" asChild>
                <span>Choose Files</span>
              </Button>
            </label>
            {queue.length > 0 && (
              <div className="mt-4 space-y-1">
                <p className="text-xs font-semibold">{queue.length} file(s) queued:</p>
                {queue.map((f, i) => (
                  <p key={i} className="text-xs text-muted-foreground">{f.name}</p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {(queue.length > 0 || processing) && (
          <Button onClick={processQueue} disabled={processing} className="w-full">
            {processing ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Processing…</>
            ) : (
              <>Process {queue.length} File(s)</>
            )}
          </Button>
        )}

        {/* Session summary */}
        {doneDocs.length > 0 && (
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Session Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-center">
                <div>
                  <p className="text-lg font-bold">{doneDocs.length}</p>
                  <p className="text-[10px] text-muted-foreground">Docs Processed</p>
                </div>
                <div>
                  <p className="text-lg font-bold">{formatCurrency(totalValue)}</p>
                  <p className="text-[10px] text-muted-foreground">Total Value</p>
                </div>
                <div>
                  <p className="text-lg font-bold">{invoiceCount}</p>
                  <p className="text-[10px] text-muted-foreground">Invoices</p>
                </div>
                <div>
                  <p className="text-lg font-bold">{poCount}</p>
                  <p className="text-[10px] text-muted-foreground">POs</p>
                </div>
                <div>
                  <p className="text-lg font-bold">{totalLineItems}</p>
                  <p className="text-[10px] text-muted-foreground">Line Items</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Processed cards */}
        {docs.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground">Processed Documents</h3>
            {docs.map(d => (
              <Card key={d.id} className={`bg-card border-border ${d.status === "error" ? "border-status-unpaid/30" : ""}`}>
                <CardContent className="p-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {d.status === "processing" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                    {d.status === "done" && <CheckCircle2 className="h-4 w-4 text-status-paid" />}
                    {d.status === "error" && <AlertCircle className="h-4 w-4 text-status-unpaid" />}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{d.filename}</span>
                        {d.status === "done" && <DocTypeBadge docType={d.doc_type} />}
                      </div>
                      {d.status === "done" && (
                        <p className="text-[10px] text-muted-foreground">
                          {d.vendor} — {d.invoice_number} — {formatCurrency(d.total)} — {d.line_items_count} items
                        </p>
                      )}
                      {d.status === "error" && (
                        <p className="text-[10px] text-status-unpaid">{d.error}</p>
                      )}
                    </div>
                  </div>
                  {d.status === "done" && d.dbId && (
                    <Link to="/invoices" className="flex items-center gap-1 text-xs text-primary hover:underline">
                      View in Database <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
