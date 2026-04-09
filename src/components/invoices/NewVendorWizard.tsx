import { useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Upload, Loader2, ChevronRight, ChevronLeft, CheckCircle2, AlertCircle, Camera, ImageIcon, Eye, Edit2, Building2, FileText, DollarSign, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { fileToBase64, callAnthropicAPI } from "@/lib/reader-engine";
import { isImageFile, imageToBase64, callAnthropicImageAPI } from "@/lib/photo-capture-engine";

// ── Enhanced system prompt for new vendor extraction ──
const NEW_VENDOR_SYSTEM_PROMPT = `You are extracting EVERY possible field from a vendor invoice for an optical retail business. This is a NEW, UNKNOWN vendor — extract everything you can find.

For EVERY field you extract, also provide a "source_note" — a plain English description of exactly where on the invoice that value came from (e.g. "top-right header block", "line item table row 1", "footer installment schedule").

Return ONLY valid JSON with this structure:
{
  "vendor_name": { "value": "...", "source_note": "..." },
  "customer_number": { "value": "...", "source_note": "..." },
  "remit_to_address": { "value": "...", "source_note": "..." },
  "invoice_number": { "value": "...", "source_note": "..." },
  "invoice_date": { "value": "YYYY-MM-DD", "source_note": "..." },
  "po_number": { "value": "...", "source_note": "..." },
  "order_number": { "value": "...", "source_note": "..." },
  "order_date": { "value": "...", "source_note": "..." },
  "payment_terms": { "value": "...", "source_note": "..." },
  "due_date": { "value": "YYYY-MM-DD or null", "source_note": "..." },
  "installment_schedule": { "value": [{"label":"...","amount":0,"due_date":"YYYY-MM-DD"}], "source_note": "..." },
  "subtotal": { "value": 0, "source_note": "..." },
  "freight": { "value": 0, "source_note": "..." },
  "tax": { "value": 0, "source_note": "..." },
  "total": { "value": 0, "source_note": "..." },
  "currency": { "value": "USD", "source_note": "..." },
  "ship_to": { "value": "...", "source_note": "..." },
  "bill_to": { "value": "...", "source_note": "..." },
  "carrier": { "value": "...", "source_note": "..." },
  "doc_type": { "value": "INVOICE", "source_note": "..." },
  "line_items": [
    {
      "upc": { "value": "...", "source_note": "..." },
      "sku": { "value": "...", "source_note": "..." },
      "description": { "value": "...", "source_note": "..." },
      "brand": { "value": "...", "source_note": "..." },
      "model": { "value": "...", "source_note": "..." },
      "color": { "value": "...", "source_note": "..." },
      "qty": { "value": 0, "source_note": "..." },
      "unit_price": { "value": 0, "source_note": "..." },
      "line_total": { "value": 0, "source_note": "..." }
    }
  ],
  "other_fields": [
    { "label": "...", "value": "...", "source_note": "..." }
  ]
}

Set any field to null if not found. Do NOT guess values — only extract what's printed.
CRITICAL: Return ONLY raw JSON. No markdown, no code fences, no backticks, no preamble.
Your response must start with { and end with }. Nothing before {. Nothing after }.`;

// ── Types ──
interface ExtractedField {
  value: any;
  source_note: string | null;
  edited?: boolean;
}

interface ExtractedLineItem {
  upc: ExtractedField;
  sku: ExtractedField;
  description: ExtractedField;
  brand: ExtractedField;
  model: ExtractedField;
  color: ExtractedField;
  qty: ExtractedField;
  unit_price: ExtractedField;
  line_total: ExtractedField;
}

interface ExtractionResult {
  vendor_name: ExtractedField;
  customer_number: ExtractedField;
  remit_to_address: ExtractedField;
  invoice_number: ExtractedField;
  invoice_date: ExtractedField;
  po_number: ExtractedField;
  order_number: ExtractedField;
  order_date: ExtractedField;
  payment_terms: ExtractedField;
  due_date: ExtractedField;
  installment_schedule: ExtractedField;
  subtotal: ExtractedField;
  freight: ExtractedField;
  tax: ExtractedField;
  total: ExtractedField;
  currency: ExtractedField;
  ship_to: ExtractedField;
  bill_to: ExtractedField;
  carrier: ExtractedField;
  doc_type: ExtractedField;
  line_items: ExtractedLineItem[];
  other_fields: { label: string; value: string; source_note: string }[];
}

type WizardStep = "upload" | "extracting" | "confirm";

// ── Field config for sections ──
const VENDOR_IDENTITY_FIELDS = ["vendor_name", "customer_number", "remit_to_address"] as const;
const INVOICE_DETAIL_FIELDS = ["invoice_number", "invoice_date", "po_number", "order_number", "order_date"] as const;
const PAYMENT_FIELDS = ["payment_terms", "due_date", "installment_schedule"] as const;
const FINANCIAL_FIELDS = ["subtotal", "freight", "tax", "total", "currency"] as const;

const FIELD_LABELS: Record<string, string> = {
  vendor_name: "Vendor Name",
  customer_number: "Customer / Account Number",
  remit_to_address: "Remit-To Address",
  invoice_number: "Invoice Number",
  invoice_date: "Invoice Date",
  po_number: "PO Number",
  order_number: "Order Number",
  order_date: "Order Date",
  payment_terms: "Terms of Payment",
  due_date: "Due Date",
  installment_schedule: "Installment Schedule",
  subtotal: "Subtotal",
  freight: "Freight / Shipping",
  tax: "Tax",
  total: "Total",
  currency: "Currency",
  ship_to: "Ship-To Address",
  bill_to: "Bill-To Address",
  carrier: "Carrier",
  doc_type: "Document Type",
};

// ── Helpers ──
function extractJSON(raw: string): any {
  let cleaned = raw
    .replace(/^```json\s*/im, "")
    .replace(/^```\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim();
  if (cleaned.includes("`") || !cleaned.startsWith("{")) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  }
  return JSON.parse(cleaned);
}

function normalizeField(val: any): ExtractedField {
  if (val && typeof val === "object" && "value" in val) {
    return { value: val.value, source_note: val.source_note || null };
  }
  return { value: val ?? null, source_note: null };
}

// ── Component ──
interface NewVendorWizardProps {
  apiKey: string;
  onComplete?: (data: ExtractionResult) => void;
}

export function NewVendorWizard({ apiKey, onComplete }: NewVendorWizardProps) {
  const [expanded, setExpanded] = useState(false);
  const [step, setStep] = useState<WizardStep>("upload");
  const [extracting, setExtracting] = useState(false);
  const [data, setData] = useState<ExtractionResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);

  const handleFileUpload = useCallback(async (file: File) => {
    if (!apiKey) {
      toast.error("Please set your Anthropic API key first");
      return;
    }

    setStep("extracting");
    setExtracting(true);
    setError(null);

    // Create preview URL
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);

    try {
      let rawResult: any;

      if (isImageFile(file)) {
        // Photo upload
        const { base64, mediaType } = await imageToBase64(file);
        const cleanKey = apiKey.replace(/[^\x20-\x7E]/g, "").trim();
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
            max_tokens: 8192,
            system: NEW_VENDOR_SYSTEM_PROMPT,
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
                { type: "text", text: "Extract all fields from this new vendor invoice. Return structured JSON with source_note for each field." },
              ],
            }],
          }),
        });

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`API error ${response.status}: ${err}`);
        }
        const result = await response.json();
        const text = result.content?.find((c: any) => c.type === "text")?.text;
        if (!text) throw new Error("No text content in response");
        rawResult = extractJSON(text);
      } else {
        // PDF upload
        const base64 = await fileToBase64(file);
        const cleanKey = apiKey.replace(/[^\x20-\x7E]/g, "").trim();
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
            max_tokens: 8192,
            system: NEW_VENDOR_SYSTEM_PROMPT,
            messages: [{
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
                { type: "text", text: "Extract all fields from this new vendor invoice. Return structured JSON with source_note for each field." },
              ],
            }],
          }),
        });

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`API error ${response.status}: ${err}`);
        }
        const result = await response.json();
        const text = result.content?.find((c: any) => c.type === "text")?.text;
        if (!text) throw new Error("No text content in response");
        rawResult = extractJSON(text);
      }

      // Normalize the extraction result
      const normalized: ExtractionResult = {
        vendor_name: normalizeField(rawResult.vendor_name),
        customer_number: normalizeField(rawResult.customer_number),
        remit_to_address: normalizeField(rawResult.remit_to_address),
        invoice_number: normalizeField(rawResult.invoice_number),
        invoice_date: normalizeField(rawResult.invoice_date),
        po_number: normalizeField(rawResult.po_number),
        order_number: normalizeField(rawResult.order_number),
        order_date: normalizeField(rawResult.order_date),
        payment_terms: normalizeField(rawResult.payment_terms),
        due_date: normalizeField(rawResult.due_date),
        installment_schedule: normalizeField(rawResult.installment_schedule),
        subtotal: normalizeField(rawResult.subtotal),
        freight: normalizeField(rawResult.freight),
        tax: normalizeField(rawResult.tax),
        total: normalizeField(rawResult.total),
        currency: normalizeField(rawResult.currency),
        ship_to: normalizeField(rawResult.ship_to),
        bill_to: normalizeField(rawResult.bill_to),
        carrier: normalizeField(rawResult.carrier),
        doc_type: normalizeField(rawResult.doc_type),
        line_items: (rawResult.line_items || []).map((li: any) => ({
          upc: normalizeField(li.upc),
          sku: normalizeField(li.sku),
          description: normalizeField(li.description),
          brand: normalizeField(li.brand),
          model: normalizeField(li.model),
          color: normalizeField(li.color),
          qty: normalizeField(li.qty),
          unit_price: normalizeField(li.unit_price),
          line_total: normalizeField(li.line_total),
        })),
        other_fields: (rawResult.other_fields || []).map((f: any) => ({
          label: f.label || "Unknown",
          value: f.value ?? "",
          source_note: f.source_note || "",
        })),
      };

      setData(normalized);
      setStep("confirm");
      toast.success("Invoice extracted — review fields below");
    } catch (err: any) {
      setError(err.message || "Extraction failed");
      setStep("upload");
      toast.error(`Extraction failed: ${err.message}`);
    } finally {
      setExtracting(false);
    }
  }, [apiKey]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFileUpload(files[0]);
  }, [handleFileUpload]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) handleFileUpload(files[0]);
  }, [handleFileUpload]);

  const updateFieldValue = useCallback((key: string, newValue: string) => {
    setData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        [key]: { ...prev[key as keyof ExtractionResult] as ExtractedField, value: newValue, edited: true },
      };
    });
  }, []);

  const updateLineItemField = useCallback((rowIdx: number, field: string, newValue: string) => {
    setData(prev => {
      if (!prev) return prev;
      const newItems = [...prev.line_items];
      newItems[rowIdx] = {
        ...newItems[rowIdx],
        [field]: { ...(newItems[rowIdx] as any)[field], value: newValue, edited: true },
      };
      return { ...prev, line_items: newItems };
    });
  }, []);

  const handleReset = useCallback(() => {
    setStep("upload");
    setData(null);
    setPreviewUrl(null);
    setError(null);
    setEditingField(null);
  }, []);

  if (!expanded) {
    return (
      <Card className="bg-card border-primary/30 border-dashed">
        <CardContent className="p-4">
          <button
            onClick={() => setExpanded(true)}
            className="w-full flex items-center justify-between group"
          >
            <div className="flex items-center gap-3">
              <Building2 className="h-5 w-5 text-primary" />
              <div className="text-left">
                <p className="text-sm font-semibold text-primary">DEFINE NEW VENDOR / Invoices</p>
                <p className="text-[10px] text-muted-foreground">Import a new vendor's invoice to set up their profile and payment terms</p>
              </div>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
          </button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            <CardTitle className="text-sm text-primary">DEFINE NEW VENDOR / Invoices</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {step !== "upload" && (
              <Button variant="ghost" size="sm" onClick={handleReset} className="text-xs">
                <ChevronLeft className="h-3 w-3 mr-1" /> Start Over
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => { setExpanded(false); handleReset(); }} className="text-xs text-muted-foreground">
              Close
            </Button>
          </div>
        </div>
        {/* Step indicator */}
        <div className="flex items-center gap-2 mt-2">
          {["Upload", "Extract", "Confirm"].map((label, i) => {
            const stepNames: WizardStep[] = ["upload", "extracting", "confirm"];
            const active = stepNames.indexOf(step) >= i;
            return (
              <div key={label} className="flex items-center gap-1">
                <div className={`h-2 w-2 rounded-full ${active ? "bg-primary" : "bg-muted"}`} />
                <span className={`text-[10px] ${active ? "text-primary font-medium" : "text-muted-foreground"}`}>{label}</span>
                {i < 2 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
              </div>
            );
          })}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── Step 1: Upload ── */}
        {step === "upload" && (
          <div
            className="border-2 border-dashed border-border rounded-lg p-8 flex flex-col items-center justify-center text-center cursor-pointer hover:border-primary/50 transition-colors"
            onDragOver={e => e.preventDefault()}
            onDrop={handleDrop}
          >
            <Upload className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm font-medium mb-1">Drop a vendor invoice here</p>
            <p className="text-xs text-muted-foreground mb-4">PDF, JPG, or PNG — we'll extract every field we can find</p>
            <div className="flex gap-2">
              <label>
                <input type="file" accept=".pdf" onChange={handleInputChange} className="hidden" />
                <Button variant="outline" size="sm" className="text-xs gap-1.5" asChild>
                  <span><FileText className="h-3.5 w-3.5" /> Upload PDF</span>
                </Button>
              </label>
              <label>
                <input type="file" accept="image/jpeg,image/png,image/heic,image/heif,image/webp" onChange={handleInputChange} className="hidden" />
                <Button variant="outline" size="sm" className="text-xs gap-1.5" asChild>
                  <span><ImageIcon className="h-3.5 w-3.5" /> Upload Photo</span>
                </Button>
              </label>
            </div>
            {error && (
              <div className="mt-4 flex items-center gap-2 text-status-unpaid">
                <AlertCircle className="h-4 w-4" />
                <p className="text-xs">{error}</p>
              </div>
            )}
          </div>
        )}

        {/* ── Step 2: Extracting ── */}
        {step === "extracting" && (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-3" />
            <p className="text-sm font-medium">Extracting invoice fields…</p>
            <p className="text-xs text-muted-foreground mt-1">This may take 15-30 seconds</p>
          </div>
        )}

        {/* ── Step 3: Field Confirmation ── */}
        {step === "confirm" && data && (
          <div className="space-y-6">
            {/* Two-column: Preview + Fields */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Left: Invoice Preview */}
              {previewUrl && (
                <div className="border border-border rounded-lg overflow-hidden bg-secondary/30">
                  <div className="px-3 py-2 border-b border-border flex items-center gap-2">
                    <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-[10px] font-medium text-muted-foreground">Original Invoice</span>
                  </div>
                  <div className="max-h-[600px] overflow-auto">
                    {previewUrl.includes("image") || previewUrl.endsWith(".jpg") || previewUrl.endsWith(".png") ? (
                      <img src={previewUrl} alt="Invoice preview" className="w-full" />
                    ) : (
                      <iframe src={previewUrl} className="w-full h-[580px]" title="Invoice PDF" />
                    )}
                  </div>
                </div>
              )}

              {/* Right: Extracted Fields */}
              <div className="space-y-4 max-h-[640px] overflow-y-auto pr-1">
                {/* Vendor Identity */}
                <FieldSection
                  title="Vendor Identity"
                  icon={<Building2 className="h-3.5 w-3.5" />}
                  fields={VENDOR_IDENTITY_FIELDS}
                  data={data}
                  editingField={editingField}
                  onEditStart={setEditingField}
                  onEditEnd={() => setEditingField(null)}
                  onChange={updateFieldValue}
                />

                {/* Invoice Details */}
                <FieldSection
                  title="Invoice Details"
                  icon={<FileText className="h-3.5 w-3.5" />}
                  fields={INVOICE_DETAIL_FIELDS}
                  data={data}
                  editingField={editingField}
                  onEditStart={setEditingField}
                  onEditEnd={() => setEditingField(null)}
                  onChange={updateFieldValue}
                />

                {/* Payment Terms */}
                <FieldSection
                  title="Payment Terms"
                  icon={<DollarSign className="h-3.5 w-3.5" />}
                  fields={PAYMENT_FIELDS}
                  data={data}
                  editingField={editingField}
                  onEditStart={setEditingField}
                  onEditEnd={() => setEditingField(null)}
                  onChange={updateFieldValue}
                />

                {/* Financials */}
                <FieldSection
                  title="Financials"
                  icon={<DollarSign className="h-3.5 w-3.5" />}
                  fields={FINANCIAL_FIELDS}
                  data={data}
                  editingField={editingField}
                  onEditStart={setEditingField}
                  onEditEnd={() => setEditingField(null)}
                  onChange={updateFieldValue}
                />

                {/* Other Fields */}
                {data.other_fields.length > 0 && (
                  <div>
                    <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Other Fields Found</h4>
                    <div className="space-y-1.5">
                      {data.other_fields.map((f, i) => (
                        <div key={i} className="bg-secondary/50 rounded p-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium">{f.label}</span>
                            <span className="text-xs">{String(f.value)}</span>
                          </div>
                          {f.source_note && (
                            <p className="text-[9px] text-muted-foreground mt-0.5">Found in: {f.source_note}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Line Items */}
            {data.line_items.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <ShoppingCart className="h-3.5 w-3.5 text-muted-foreground" />
                  <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Line Items ({data.line_items.length})
                  </h4>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">UPC/SKU</th>
                        <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Description</th>
                        <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Brand</th>
                        <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Model</th>
                        <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Color</th>
                        <th className="text-right py-1.5 px-2 font-medium text-muted-foreground">Qty</th>
                        <th className="text-right py-1.5 px-2 font-medium text-muted-foreground">Unit $</th>
                        <th className="text-right py-1.5 px-2 font-medium text-muted-foreground">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.line_items.map((li, idx) => (
                        <tr key={idx} className="border-b border-border/50 hover:bg-secondary/30">
                          <td className="py-1.5 px-2">
                            <EditableCell
                              value={String(li.upc?.value || li.sku?.value || "")}
                              onChange={val => updateLineItemField(idx, li.upc?.value ? "upc" : "sku", val)}
                            />
                          </td>
                          <td className="py-1.5 px-2 max-w-[200px] truncate">
                            <EditableCell value={String(li.description?.value || "")} onChange={val => updateLineItemField(idx, "description", val)} />
                          </td>
                          <td className="py-1.5 px-2">
                            <EditableCell value={String(li.brand?.value || "")} onChange={val => updateLineItemField(idx, "brand", val)} />
                          </td>
                          <td className="py-1.5 px-2">
                            <EditableCell value={String(li.model?.value || "")} onChange={val => updateLineItemField(idx, "model", val)} />
                          </td>
                          <td className="py-1.5 px-2">
                            <EditableCell value={String(li.color?.value || "")} onChange={val => updateLineItemField(idx, "color", val)} />
                          </td>
                          <td className="py-1.5 px-2 text-right">
                            <EditableCell value={String(li.qty?.value ?? "")} onChange={val => updateLineItemField(idx, "qty", val)} />
                          </td>
                          <td className="py-1.5 px-2 text-right">
                            <EditableCell value={String(li.unit_price?.value ?? "")} onChange={val => updateLineItemField(idx, "unit_price", val)} />
                          </td>
                          <td className="py-1.5 px-2 text-right font-medium">
                            <EditableCell value={String(li.line_total?.value ?? "")} onChange={val => updateLineItemField(idx, "line_total", val)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <Button variant="ghost" size="sm" onClick={handleReset} className="text-xs">
                <ChevronLeft className="h-3 w-3 mr-1" /> Start Over
              </Button>
              <div className="flex items-center gap-2">
                <p className="text-[10px] text-muted-foreground">Steps 3-4 (Terms mapping + Vendor save) coming next</p>
                <Button
                  size="sm"
                  className="text-xs gap-1.5"
                  onClick={() => {
                    if (onComplete) onComplete(data);
                    toast.success("Fields confirmed — Terms mapping coming in next update");
                  }}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" /> Confirm Fields
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Field Section component ──
function FieldSection({
  title, icon, fields, data, editingField, onEditStart, onEditEnd, onChange,
}: {
  title: string;
  icon: React.ReactNode;
  fields: readonly string[];
  data: ExtractionResult;
  editingField: string | null;
  onEditStart: (key: string) => void;
  onEditEnd: () => void;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        {icon}
        <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{title}</h4>
      </div>
      <div className="space-y-1.5">
        {fields.map(key => {
          const field = data[key as keyof ExtractionResult] as ExtractedField;
          if (!field) return null;

          const displayValue = key === "installment_schedule" && Array.isArray(field.value)
            ? field.value.map((i: any) => `${i.label}: $${i.amount} due ${i.due_date}`).join(" · ")
            : String(field.value ?? "—");

          const isEditing = editingField === key;

          return (
            <div key={key} className="bg-secondary/50 rounded p-2 group">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium text-muted-foreground shrink-0 w-32">
                  {FIELD_LABELS[key] || key}
                </span>
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <Input
                      autoFocus
                      defaultValue={displayValue === "—" ? "" : displayValue}
                      onBlur={e => {
                        onChange(key, e.target.value);
                        onEditEnd();
                      }}
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          onChange(key, (e.target as HTMLInputElement).value);
                          onEditEnd();
                        }
                        if (e.key === "Escape") onEditEnd();
                      }}
                      className="h-6 text-xs bg-background"
                    />
                  ) : (
                    <div className="flex items-center gap-1">
                      <span className={`text-xs truncate ${field.value ? "" : "text-muted-foreground italic"}`}>
                        {displayValue}
                      </span>
                      {(field as any).edited && (
                        <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 shrink-0">edited</Badge>
                      )}
                      <button
                        onClick={() => onEditStart(key)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      >
                        <Edit2 className="h-3 w-3 text-muted-foreground hover:text-primary" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {field.source_note && (
                <p className="text-[9px] text-muted-foreground mt-0.5 pl-32">
                  Found in: {field.source_note}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Editable cell for line items table ──
function EditableCell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <Input
        autoFocus
        defaultValue={value}
        onBlur={e => { onChange(e.target.value); setEditing(false); }}
        onKeyDown={e => {
          if (e.key === "Enter") { onChange((e.target as HTMLInputElement).value); setEditing(false); }
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-5 text-[10px] bg-background px-1 py-0 w-full min-w-[60px]"
      />
    );
  }

  return (
    <span
      className="cursor-pointer hover:text-primary transition-colors"
      onClick={() => setEditing(true)}
      title="Click to edit"
    >
      {value || <span className="text-muted-foreground">—</span>}
    </span>
  );
}
