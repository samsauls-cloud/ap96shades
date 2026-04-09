import { useState, useCallback } from "react";
import { toast } from "sonner";
import { Upload, Loader2, ChevronRight, ChevronLeft, CheckCircle2, AlertCircle, ImageIcon, Eye, Edit2, Building2, FileText, DollarSign, ShoppingCart, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fileToBase64 } from "@/lib/reader-engine";
import { isImageFile, imageToBase64 } from "@/lib/photo-capture-engine";
import { supabase } from "@/integrations/supabase/client";
import { parsedToInvoice, batchInsertInvoices, uploadPDFToStorage } from "@/lib/reader-engine";

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

type WizardStep = "upload" | "extracting" | "confirm" | "terms" | "saving" | "done";

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

const KNOWN_TERM_TYPES = [
  { value: "eom_split", label: "EOM Split (e.g. EOM 30/60/90)" },
  { value: "eom_single", label: "EOM Single (e.g. 60 Days EOM)" },
  { value: "days_split", label: "Days Split from Invoice Date (e.g. 60/90/120/150)" },
  { value: "net_single", label: "Net Single (e.g. Net 30)" },
  { value: "custom", label: "Define new term…" },
];

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

function toVendorKey(name: string): string {
  return (name || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function endOfMonth(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const eom = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return eom.toISOString().split("T")[0];
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
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);

  // Terms step state
  const [termType, setTermType] = useState("eom_split");
  const [offsetType, setOffsetType] = useState<"from_eom" | "from_invoice_date">("from_eom");
  const [dayIntervalsStr, setDayIntervalsStr] = useState("30,60,90");
  const [paymentCount, setPaymentCount] = useState("3");

  // Done step state
  const [savedVendorName, setSavedVendorName] = useState("");
  const [savedInvoiceNumber, setSavedInvoiceNumber] = useState("");
  // Track original extracted vendor name (before user edits)
  const [originalExtractedVendorName, setOriginalExtractedVendorName] = useState<string | null>(null);

  const handleFileUpload = useCallback(async (file: File) => {
    if (!apiKey) {
      toast.error("Please set your Anthropic API key first");
      return;
    }

    setStep("extracting");
    setExtracting(true);
    setError(null);
    setUploadedFile(file);

    const url = URL.createObjectURL(file);
    setPreviewUrl(url);

    try {
      let rawResult: any;

      if (isImageFile(file)) {
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
        if (!response.ok) throw new Error(`API error ${response.status}: ${await response.text()}`);
        const result = await response.json();
        const text = result.content?.find((c: any) => c.type === "text")?.text;
        if (!text) throw new Error("No text content in response");
        rawResult = extractJSON(text);
      } else {
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
        if (!response.ok) throw new Error(`API error ${response.status}: ${await response.text()}`);
        const result = await response.json();
        const text = result.content?.find((c: any) => c.type === "text")?.text;
        if (!text) throw new Error("No text content in response");
        rawResult = extractJSON(text);
      }

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
      setOriginalExtractedVendorName(String(normalized.vendor_name?.value || ""));
      setStep("confirm");

      // Pre-populate terms step from extraction
      const rawTerms = String(normalized.payment_terms?.value || "");
      if (rawTerms) {
        // Try to detect intervals from the raw terms string
        const nums = rawTerms.match(/\d+/g);
        if (nums && nums.length > 1) {
          setDayIntervalsStr(nums.join(","));
          setPaymentCount(String(nums.length));
        } else if (nums && nums.length === 1) {
          setDayIntervalsStr(nums[0]);
          setPaymentCount("1");
          setTermType("net_single");
        }
        // Detect EOM
        if (/eom|end.of.month/i.test(rawTerms)) {
          setOffsetType("from_eom");
          if (nums && nums.length > 1) setTermType("eom_split");
          else setTermType("eom_single");
        } else {
          setOffsetType("from_invoice_date");
          if (nums && nums.length > 1) setTermType("days_split");
          else setTermType("net_single");
        }
      }

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
    setUploadedFile(null);
  }, []);

  // ── Save handler: writes to all 3 tables + imports invoice ──
  const handleSave = useCallback(async () => {
    if (!data) return;
    setStep("saving");

    try {
      const vendorName = String(data.vendor_name?.value || "Unknown Vendor");
      const vendorKey = toVendorKey(vendorName);
      const invoiceNumber = String(data.invoice_number?.value || "");
      const intervals = dayIntervalsStr.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));

      // 1. Insert vendor_definitions
      const { data: vendorRow, error: vErr } = await supabase
        .from("vendor_definitions" as any)
        .insert({
          vendor_name: vendorName,
          vendor_key: vendorKey,
          customer_number: data.customer_number?.value || null,
          remit_to_address: data.remit_to_address?.value || null,
          default_currency: data.currency?.value || "USD",
          is_active: true,
        } as any)
        .select()
        .single();

      if (vErr) throw new Error(`Vendor save failed: ${vErr.message}`);
      const vendorId = (vendorRow as any).id;

      // 2. Insert vendor_term_definitions
      const { error: tErr } = await supabase
        .from("vendor_term_definitions" as any)
        .insert({
          vendor_id: vendorId,
          term_label: data.payment_terms?.value || null,
          term_type: termType === "custom" ? "unknown" : termType,
          payment_count: parseInt(paymentCount) || 1,
          offset_type: offsetType,
          day_intervals: intervals,
          is_default: true,
        } as any);

      if (tErr) throw new Error(`Term save failed: ${tErr.message}`);

      // 3. Insert vendor_field_mappings — one row per confirmed field
      const allFields = [
        ...VENDOR_IDENTITY_FIELDS,
        ...INVOICE_DETAIL_FIELDS,
        ...PAYMENT_FIELDS,
        ...FINANCIAL_FIELDS,
        "ship_to", "bill_to", "carrier", "doc_type",
      ];
      const fieldRows = allFields
        .map(fieldName => {
          const f = data[fieldName as keyof ExtractionResult] as ExtractedField;
          if (!f || f.value == null) return null;
          return {
            vendor_id: vendorId,
            field_name: fieldName,
            source_note: f.source_note || null,
            confirmed_at: new Date().toISOString(),
          };
        })
        .filter(Boolean);

      if (fieldRows.length > 0) {
        const { error: fErr } = await supabase
          .from("vendor_field_mappings" as any)
          .insert(fieldRows as any);
        if (fErr) throw new Error(`Field mappings save failed: ${fErr.message}`);
      }

      // 4. Also insert into vendor_alias_map so normalizeVendor can find this vendor
      await supabase
        .from("vendor_alias_map")
        .insert({
          vendor_name: vendorName,
          vendor_id: vendorKey,
          aliases: [vendorName.toLowerCase(), vendorKey],
          vendor_type: "frame",
        });

      // 5. Import the invoice itself into vendor_invoices
      let pdfUrl: string | null = null;
      if (uploadedFile) {
        pdfUrl = await uploadPDFToStorage(uploadedFile, vendorName, invoiceNumber);
      }

      const flatParsed = {
        vendor: vendorName,
        doc_type: data.doc_type?.value || "INVOICE",
        invoice_number: invoiceNumber,
        invoice_date: data.invoice_date?.value || new Date().toISOString().split("T")[0],
        po_number: data.po_number?.value || null,
        account_number: data.customer_number?.value || null,
        ship_to: data.ship_to?.value || null,
        carrier: data.carrier?.value || null,
        payment_terms: data.payment_terms?.value || null,
        subtotal: parseFloat(data.subtotal?.value) || null,
        tax: parseFloat(data.tax?.value) || null,
        freight: parseFloat(data.freight?.value) || null,
        total: parseFloat(data.total?.value) || 0,
        currency: data.currency?.value || "USD",
        vendor_brands: [],
        notes: "Imported via Define New Vendor wizard",
        line_items: data.line_items.map(li => ({
          upc: li.upc?.value || null,
          sku: li.sku?.value || null,
          description: li.description?.value || null,
          brand: li.brand?.value || null,
          model: li.model?.value || null,
          color_desc: li.color?.value || null,
          qty: parseInt(li.qty?.value) || 0,
          unit_price: parseFloat(li.unit_price?.value) || 0,
          line_total: parseFloat(li.line_total?.value) || 0,
        })),
        payment_terms_extracted: null,
      };

      const invoiceInsert = parsedToInvoice(flatParsed, uploadedFile?.name || "new-vendor-import.pdf", pdfUrl);
      await batchInsertInvoices([invoiceInsert]);

      setSavedVendorName(vendorName);
      setSavedInvoiceNumber(invoiceNumber);
      setStep("done");
      toast.success(`Vendor "${vendorName}" defined and invoice imported!`);
    } catch (err: any) {
      toast.error(`Save failed: ${err.message}`);
      setStep("terms"); // go back to terms step
    }
  }, [data, termType, offsetType, dayIntervalsStr, paymentCount, uploadedFile]);

  // Compute preview schedule
  const computeSchedule = useCallback((): { label: string; dueDate: string }[] => {
    if (!data) return [];
    const invoiceDate = String(data.invoice_date?.value || new Date().toISOString().split("T")[0]);
    const intervals = dayIntervalsStr.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const count = intervals.length || 1;
    const eom = endOfMonth(invoiceDate);

    return intervals.map((days, i) => {
      const baseline = offsetType === "from_eom" ? eom : invoiceDate;
      const due = addDays(baseline, days);
      return {
        label: count > 1 ? `Tranche ${i + 1} of ${count}` : "Single payment",
        dueDate: due,
      };
    });
  }, [data, offsetType, dayIntervalsStr]);

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

  const stepLabels = ["Upload", "Extract", "Confirm", "Terms", "Save"];
  const stepKeys: WizardStep[] = ["upload", "extracting", "confirm", "terms", "saving"];
  const currentStepIdx = step === "done" ? 4 : stepKeys.indexOf(step);

  return (
    <Card className="bg-card border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            <CardTitle className="text-sm text-primary">DEFINE NEW VENDOR / Invoices</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {step !== "upload" && step !== "done" && (
              <Button variant="ghost" size="sm" onClick={handleReset} className="text-xs">
                <ChevronLeft className="h-3 w-3 mr-1" /> Start Over
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => { setExpanded(false); handleReset(); }} className="text-xs text-muted-foreground">
              Close
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2">
          {stepLabels.map((label, i) => {
            const active = currentStepIdx >= i;
            return (
              <div key={label} className="flex items-center gap-1">
                <div className={`h-2 w-2 rounded-full ${active ? "bg-primary" : "bg-muted"}`} />
                <span className={`text-[10px] ${active ? "text-primary font-medium" : "text-muted-foreground"}`}>{label}</span>
                {i < stepLabels.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
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
              <div className="mt-4 flex items-center gap-2 text-destructive">
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
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
              <div className="space-y-4 max-h-[640px] overflow-y-auto pr-1">
                <FieldSection title="Vendor Identity" icon={<Building2 className="h-3.5 w-3.5" />} fields={VENDOR_IDENTITY_FIELDS} data={data} editingField={editingField} onEditStart={setEditingField} onEditEnd={() => setEditingField(null)} onChange={updateFieldValue} />
                <FieldSection title="Invoice Details" icon={<FileText className="h-3.5 w-3.5" />} fields={INVOICE_DETAIL_FIELDS} data={data} editingField={editingField} onEditStart={setEditingField} onEditEnd={() => setEditingField(null)} onChange={updateFieldValue} />
                <FieldSection title="Payment Terms" icon={<DollarSign className="h-3.5 w-3.5" />} fields={PAYMENT_FIELDS} data={data} editingField={editingField} onEditStart={setEditingField} onEditEnd={() => setEditingField(null)} onChange={updateFieldValue} />
                <FieldSection title="Financials" icon={<DollarSign className="h-3.5 w-3.5" />} fields={FINANCIAL_FIELDS} data={data} editingField={editingField} onEditStart={setEditingField} onEditEnd={() => setEditingField(null)} onChange={updateFieldValue} />
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
                          {f.source_note && <p className="text-[9px] text-muted-foreground mt-0.5">Found in: {f.source_note}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {data.line_items.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <ShoppingCart className="h-3.5 w-3.5 text-muted-foreground" />
                  <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Line Items ({data.line_items.length})</h4>
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
                          <td className="py-1.5 px-2"><EditableCell value={String(li.upc?.value || li.sku?.value || "")} onChange={val => updateLineItemField(idx, li.upc?.value ? "upc" : "sku", val)} /></td>
                          <td className="py-1.5 px-2 max-w-[200px] truncate"><EditableCell value={String(li.description?.value || "")} onChange={val => updateLineItemField(idx, "description", val)} /></td>
                          <td className="py-1.5 px-2"><EditableCell value={String(li.brand?.value || "")} onChange={val => updateLineItemField(idx, "brand", val)} /></td>
                          <td className="py-1.5 px-2"><EditableCell value={String(li.model?.value || "")} onChange={val => updateLineItemField(idx, "model", val)} /></td>
                          <td className="py-1.5 px-2"><EditableCell value={String(li.color?.value || "")} onChange={val => updateLineItemField(idx, "color", val)} /></td>
                          <td className="py-1.5 px-2 text-right"><EditableCell value={String(li.qty?.value ?? "")} onChange={val => updateLineItemField(idx, "qty", val)} /></td>
                          <td className="py-1.5 px-2 text-right"><EditableCell value={String(li.unit_price?.value ?? "")} onChange={val => updateLineItemField(idx, "unit_price", val)} /></td>
                          <td className="py-1.5 px-2 text-right font-medium"><EditableCell value={String(li.line_total?.value ?? "")} onChange={val => updateLineItemField(idx, "line_total", val)} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <Button variant="ghost" size="sm" onClick={handleReset} className="text-xs">
                <ChevronLeft className="h-3 w-3 mr-1" /> Start Over
              </Button>
              <Button size="sm" className="text-xs gap-1.5" onClick={() => setStep("terms")}>
                <CheckCircle2 className="h-3.5 w-3.5" /> Confirm Fields → Terms Setup
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 4: Terms Mapping ── */}
        {step === "terms" && data && (
          <div className="space-y-5">
            <div>
              <h3 className="text-sm font-semibold mb-1">Payment Terms Setup</h3>
              <p className="text-xs text-muted-foreground">Configure how this vendor's payment schedule works</p>
            </div>

            {/* Raw terms from invoice */}
            <div className="bg-secondary/50 rounded-lg p-3">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Extracted Terms String</p>
              <p className="text-sm font-mono">{String(data.payment_terms?.value || "—")}</p>
              {data.payment_terms?.source_note && (
                <p className="text-[9px] text-muted-foreground mt-1">Found in: {data.payment_terms.source_note}</p>
              )}
            </div>

            {/* Term type selector */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Term Type</label>
                <Select value={termType} onValueChange={setTermType}>
                  <SelectTrigger className="mt-1 text-xs h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KNOWN_TERM_TYPES.map(t => (
                      <SelectItem key={t.value} value={t.value} className="text-xs">{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Offset From</label>
                <Select value={offsetType} onValueChange={v => setOffsetType(v as any)}>
                  <SelectTrigger className="mt-1 text-xs h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="from_eom" className="text-xs">End of Month (EOM)</SelectItem>
                    <SelectItem value="from_invoice_date" className="text-xs">Invoice Date</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Day Intervals (comma-separated)</label>
                <Input
                  value={dayIntervalsStr}
                  onChange={e => {
                    setDayIntervalsStr(e.target.value);
                    const nums = e.target.value.split(",").filter(s => s.trim() && !isNaN(parseInt(s.trim())));
                    setPaymentCount(String(nums.length || 1));
                  }}
                  className="mt-1 text-xs h-8"
                  placeholder="e.g. 30,60,90"
                />
              </div>

              <div>
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Number of Payments</label>
                <Input value={paymentCount} onChange={e => setPaymentCount(e.target.value)} className="mt-1 text-xs h-8" />
              </div>
            </div>

            {/* Schedule preview */}
            <div className="bg-secondary/50 rounded-lg p-3">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Calculated Payment Schedule</p>
              <p className="text-[9px] text-muted-foreground mb-2">
                Based on invoice date: {String(data.invoice_date?.value || "—")} | Offset: {offsetType === "from_eom" ? "End of Month" : "Invoice Date"}
              </p>
              <div className="space-y-1">
                {computeSchedule().map((s, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span>{s.label}</span>
                    <span className="font-mono">{s.dueDate}</span>
                  </div>
                ))}
                {computeSchedule().length === 0 && (
                  <p className="text-xs text-muted-foreground italic">Enter valid day intervals to see schedule</p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <Button variant="ghost" size="sm" onClick={() => setStep("confirm")} className="text-xs">
                <ChevronLeft className="h-3 w-3 mr-1" /> Back to Fields
              </Button>
              <Button size="sm" className="text-xs gap-1.5" onClick={handleSave}>
                <Save className="h-3.5 w-3.5" /> Save Vendor & Import Invoice
              </Button>
            </div>
          </div>
        )}

        {/* ── Saving ── */}
        {step === "saving" && (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-3" />
            <p className="text-sm font-medium">Saving vendor definition & importing invoice…</p>
          </div>
        )}

        {/* ── Done ── */}
        {step === "done" && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CheckCircle2 className="h-12 w-12 text-primary mb-4" />
            <h3 className="text-lg font-semibold mb-1">Vendor Defined</h3>
            <p className="text-sm text-muted-foreground mb-1">
              <span className="font-medium text-foreground">{savedVendorName}</span> has been added to the system.
            </p>
            <p className="text-sm text-muted-foreground mb-6">
              Invoice <span className="font-mono font-medium text-foreground">{savedInvoiceNumber}</span> imported.
            </p>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => { setExpanded(false); handleReset(); }}>
              Done
            </Button>
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
                      onBlur={e => { onChange(key, e.target.value); onEditEnd(); }}
                      onKeyDown={e => {
                        if (e.key === "Enter") { onChange(key, (e.target as HTMLInputElement).value); onEditEnd(); }
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
                      <button onClick={() => onEditStart(key)} className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <Edit2 className="h-3 w-3 text-muted-foreground hover:text-primary" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {field.source_note && (
                <p className="text-[9px] text-muted-foreground mt-0.5 pl-32">Found in: {field.source_note}</p>
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
    <span className="cursor-pointer hover:text-primary transition-colors" onClick={() => setEditing(true)} title="Click to edit">
      {value || <span className="text-muted-foreground">—</span>}
    </span>
  );
}