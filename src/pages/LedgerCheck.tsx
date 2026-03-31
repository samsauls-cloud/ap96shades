import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { InvoiceDrawer } from "@/components/invoices/InvoiceDrawer";
import { fetchDistinctVendors } from "@/lib/supabase-queries";
import type { VendorInvoice } from "@/lib/supabase-queries";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Upload, CheckCircle2, AlertTriangle, CreditCard, ChevronDown, X,
  Download, Save, Trash2, Search, ShoppingBag, Package, Tag,
  AlertCircle,
  PackageCheck, DollarSign,
} from "lucide-react";
import { toast } from "sonner";
import { resolvePaymentSchedule, type PaymentSchedule } from "@/lib/payment-terms-engine";
import { Calendar } from "lucide-react";

/* ─── types ─── */

type Category = "Procurement" | "Special Order" | "Credit";

interface LedgerRow {
  account: string;
  documentNumber: string;
  docDate: string;
  dueDate: string;
  terms: string;
  amount: number;
  memo: string;
  poReference: string;
  sourceFile?: string;
  category: Category;
  status: "matched" | "not_uploaded" | "credit";
  matchedInvoiceId?: string;
  matchedTags?: string[];
  specialOrderReceived?: boolean;
  matchedStatus?: string;
  schedule?: PaymentSchedule;
}

/* ─── helpers ─── */

function categorise(poRef: string, amount: number): Category {
  if (amount < 0) return "Credit";
  const ref = poRef.trim();
  if (ref.toUpperCase().startsWith("LUX-") || ref.toUpperCase().startsWith("PO "))
    return "Procurement";
  return "Special Order";
}

const STATUS_ORDER: Record<LedgerRow["status"], number> = {
  not_uploaded: 0,
  matched: 1,
  credit: 2,
};

/** Batch .in() queries to avoid Supabase limits */
async function batchMatchInvoices(
  docNumbers: string[]
): Promise<Map<string, { id: string; tags: string[]; specialOrderReceived: boolean; status: string }>> {
  const BATCH = 200;
  const matchMap = new Map<string, { id: string; tags: string[]; specialOrderReceived: boolean; status: string }>();
  for (let i = 0; i < docNumbers.length; i += BATCH) {
    const chunk = docNumbers.slice(i, i + BATCH);
    const { data } = await supabase
      .from("vendor_invoices")
      .select("id, invoice_number, tags, special_order_received, status")
      .in("invoice_number", chunk);
    (data ?? []).forEach((m) =>
      matchMap.set(m.invoice_number, {
        id: m.id,
        tags: m.tags ?? [],
        specialOrderReceived: m.special_order_received ?? false,
        status: m.status,
      })
    );
  }
  return matchMap;
}

function formatExcelDate(v: any): string {
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.m}/${d.d}/${d.y}`;
  }
  if (typeof v === "string") return v;
  return String(v);
}

function computeStats(rows: LedgerRow[]) {
  return {
    total: rows.length,
    totalAmount: rows.reduce((s, r) => s + r.amount, 0),
    notUploaded: rows.filter((r) => r.status === "not_uploaded").length,
    notUploadedAmount: rows
      .filter((r) => r.status === "not_uploaded")
      .reduce((s, r) => s + r.amount, 0),
    matched: rows.filter((r) => r.status === "matched").length,
    credits: rows.filter((r) => r.status === "credit").length,
    procurement: rows.filter((r) => r.category === "Procurement").length,
    procurementAmount: rows
      .filter((r) => r.category === "Procurement")
      .reduce((s, r) => s + r.amount, 0),
    specialOrder: rows.filter((r) => r.category === "Special Order").length,
    specialOrderAmount: rows
      .filter((r) => r.category === "Special Order")
      .reduce((s, r) => s + r.amount, 0),
    creditAmount: rows
      .filter((r) => r.category === "Credit")
      .reduce((s, r) => s + r.amount, 0),
  };
}

/* ─── main component ─── */

export default function LedgerCheckPage() {
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [processing, setProcessing] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [drawerInvoice, setDrawerInvoice] = useState<VendorInvoice | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: vendors = [] } = useQuery({
    queryKey: ["distinct_vendors"],
    queryFn: fetchDistinctVendors,
  });

  const { data: savedChecks = [] } = useQuery({
    queryKey: ["saved_ledger_checks"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("saved_ledger_checks")
        .select("id, name, created_at, row_count, matched_count, not_uploaded_count, credit_count, total_amount, source_files")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const toggleVendor = (v: string) =>
    setSelectedVendors((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]
    );

  const processRows = useCallback(
    async (parsed: Omit<LedgerRow, "status" | "matchedInvoiceId" | "matchedTags" | "category">[]) => {
      const docNumbers = parsed.map((p) => p.documentNumber).filter(Boolean);
      const matchMap = await batchMatchInvoices(docNumbers);

      return parsed.map((p) => {
        const cat = categorise(p.poReference, p.amount);
        const isCredit = p.amount < 0;
        const found = matchMap.get(p.documentNumber);
        return {
          ...p,
          category: cat,
          status: (isCredit
            ? "credit"
            : found
            ? "matched"
            : "not_uploaded") as LedgerRow["status"],
          matchedInvoiceId: found?.id,
          matchedTags: found?.tags,
          specialOrderReceived: found?.specialOrderReceived,
          matchedStatus: found?.status,
          schedule: resolvePaymentSchedule(
            'Luxottica',
            cat,
            new Date(p.docDate),
            p.amount,
            null
          ),
        };
      });
    },
    []
  );

  const handleFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (!files.length) return;
      setFileName(files.map((f) => f.name).join(", "));
      setProcessing(true);

      try {
        const allParsed = await Promise.all(
          files.map(async (file) => {
            const buf = await file.arrayBuffer();
            const wb = XLSX.read(buf, { type: "array" });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
            const dataRows = raw
              .slice(1)
              .filter((r) => r[0] != null && String(r[0]).trim() !== "");
            return dataRows.map((r) => ({
              account: String(r[0] ?? ""),
              documentNumber:
                typeof r[1] === "number"
                  ? String(Math.trunc(r[1]))
                  : String(r[1] ?? "").trim(),
              docDate: r[2] ? formatExcelDate(r[2]) : "",
              dueDate: r[3] ? formatExcelDate(r[3]) : "",
              terms: String(r[4] ?? ""),
              amount:
                typeof r[5] === "number"
                  ? r[5]
                  : parseFloat(String(r[5] ?? "0").replace(/[,$]/g, "")) || 0,
              memo: String(r[6] ?? ""),
              poReference: String(r[7] ?? ""),
              sourceFile: file.name,
            }));
          })
        );

        // Deduplicate by composite key
        const seen = new Set<string>();
        const parsed = allParsed.flat().filter((p) => {
          const key = `${p.documentNumber}|${p.account}|${p.amount}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const results = await processRows(parsed);
        setLedgerRows(results);
        toast.success(`Found ${results.length} line items — check complete`);
      } catch (err) {
        console.error("Excel parse error:", err);
        toast.error("Failed to parse Excel file(s)");
      } finally {
        setProcessing(false);
        e.target.value = "";
      }
    },
    [processRows]
  );

  const handleSave = useCallback(async () => {
    const name = saveName.trim();
    if (!name || ledgerRows.length === 0) return;
    setSaving(true);
    try {
      const stats = computeStats(ledgerRows);
      const sourceFiles = [
        ...new Set(ledgerRows.map((r) => r.sourceFile).filter(Boolean)),
      ];
      const { error } = await supabase.from("saved_ledger_checks").insert({
        name,
        source_files: sourceFiles,
        row_count: stats.total,
        total_amount: stats.totalAmount,
        matched_count: stats.matched,
        not_uploaded_count: stats.notUploaded,
        credit_count: stats.credits,
        rows: ledgerRows as any,
      });
      if (error) throw error;
      toast.success(`Saved "${name}"`);
      setSaveName("");
      queryClient.invalidateQueries({ queryKey: ["saved_ledger_checks"] });
    } catch (err: any) {
      toast.error(err.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }, [saveName, ledgerRows, queryClient]);

  const handleLoadSaved = useCallback(
    async (id: string) => {
      try {
        const { data, error } = await supabase
          .from("saved_ledger_checks")
          .select("name, rows, source_files")
          .eq("id", id)
          .maybeSingle();
        if (error) throw error;
        if (!data) { toast.error("Not found"); return; }
        const saved = data as any;
        const rawRows = (saved.rows as any[]).map((r: any) => ({
          account: r.account,
          documentNumber: r.documentNumber,
          docDate: r.docDate,
          dueDate: r.dueDate,
          terms: r.terms,
          amount: r.amount,
          memo: r.memo,
          poReference: r.poReference,
          sourceFile: r.sourceFile,
        }));
        setProcessing(true);
        const results = await processRows(rawRows);
        setLedgerRows(results);
        setFileName(saved.source_files?.join(", ") || saved.name);
      } catch (err: any) {
        toast.error(err.message || "Failed to load");
      } finally {
        setProcessing(false);
      }
    },
    [processRows]
  );

  const handleDeleteSaved = useCallback(
    async (id: string) => {
      const { error } = await supabase
        .from("saved_ledger_checks")
        .delete()
        .eq("id", id);
      if (error) {
        toast.error(error.message);
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["saved_ledger_checks"] });
      toast.success("Deleted");
    },
    [queryClient]
  );

  const handleOpenInvoice = useCallback(async (invoiceId: string) => {
    const { data } = await supabase
      .from("vendor_invoices")
      .select("*")
      .eq("id", invoiceId)
      .maybeSingle();
    if (data) {
      setDrawerInvoice(data as unknown as VendorInvoice);
      setDrawerOpen(true);
    }
  }, []);

  const qc = useQueryClient();

  const handleMarkReceived = useCallback(async (row: LedgerRow) => {
    if (!row.matchedInvoiceId) {
      toast.error("Invoice must be uploaded first");
      return;
    }
    const { error } = await supabase
      .from("vendor_invoices")
      .update({
        special_order_received: true,
        special_order_received_at: new Date().toISOString(),
        special_order_received_by: "manual",
      } as any)
      .eq("id", row.matchedInvoiceId);
    if (error) {
      toast.error(error.message);
      return;
    }
    setLedgerRows((prev) =>
      prev.map((r) =>
        r.matchedInvoiceId === row.matchedInvoiceId
          ? { ...r, specialOrderReceived: true }
          : r
      )
    );
    qc.invalidateQueries({ queryKey: ["vendor_invoices"] });
    qc.invalidateQueries({ queryKey: ["invoice_stats"] });
    toast.success(`Marked "${row.documentNumber}" as received`);
  }, [qc]);


  const handleMarkPaid = useCallback(async (row: LedgerRow) => {
    if (!row.matchedInvoiceId) return;

    // 1. Update vendor_invoices status
    const { error } = await supabase
      .from("vendor_invoices")
      .update({ status: "paid" } as any)
      .eq("id", row.matchedInvoiceId);
    if (error) {
      toast.error(error.message);
      return;
    }

    // 2. Mark all payment installments as paid
    const today = new Date().toISOString().split("T")[0];
    const { data: installments } = await supabase
      .from("invoice_payments")
      .select("id, amount_due")
      .eq("invoice_id", row.matchedInvoiceId);

    if (installments && installments.length > 0) {
      for (const inst of installments) {
        await supabase
          .from("invoice_payments")
          .update({
            is_paid: true,
            paid_date: today,
            amount_paid: Number(inst.amount_due) || 0,
            balance_remaining: 0,
            payment_status: "paid",
            last_payment_date: today,
          } as any)
          .eq("id", inst.id);
      }
    }

    // 3. Update local state
    setLedgerRows((prev) =>
      prev.map((r) =>
        r.matchedInvoiceId === row.matchedInvoiceId
          ? { ...r, matchedStatus: "paid" }
          : r
      )
    );

    // 4. Invalidate all relevant queries
    qc.invalidateQueries({ queryKey: ["invoice_payments"] });
    qc.invalidateQueries({ queryKey: ["invoice_stats"] });
    qc.invalidateQueries({ queryKey: ["ap_full_audit"] });
    qc.invalidateQueries({ queryKey: ["audit_payments"] });
    qc.invalidateQueries({ queryKey: ["vendor_invoices"] });

    toast.success(`Marked "${row.documentNumber}" as paid`);
  }, [qc]);

  /* ─── filtered + sorted rows ─── */

  const filtered = useMemo(() => {
    let rows = ledgerRows;

    // Tab filter
    if (activeTab === "procurement")
      rows = rows.filter((r) => r.category === "Procurement");
    else if (activeTab === "special")
      rows = rows.filter((r) => r.category === "Special Order");
    else if (activeTab === "credits")
      rows = rows.filter((r) => r.category === "Credit");

    // Search
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.documentNumber.toLowerCase().includes(q) ||
          r.poReference.toLowerCase().includes(q) ||
          r.memo.toLowerCase().includes(q)
      );
    }

    // Sort: not_uploaded first, then matched, then credit
    return [...rows].sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    );
  }, [ledgerRows, activeTab, searchTerm]);

  const stats = useMemo(() => computeStats(ledgerRows), [ledgerRows]);

  const handleDownloadCSV = useCallback(() => {
    const header =
      "Status,Category,Document #,Account,Doc Date,Due Date,Amount,PO Ref,Memo,Source File";
    const rows = filtered.map((r) =>
      [
        r.status,
        r.category,
        r.documentNumber,
        r.account,
        r.docDate,
        r.dueDate,
        r.amount.toFixed(2),
        r.poReference,
        r.memo,
        r.sourceFile ?? "",
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ledger-check-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Ledger Check</h1>
          <p className="text-sm text-muted-foreground">
            Upload a vendor open-item statement to compare against your invoice
            database
          </p>
        </div>

        {/* Controls row */}
        <div className="flex flex-wrap items-end gap-4">
          {/* Saved checks */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Saved Checks
            </label>
            <div className="flex items-center gap-1">
              <Select onValueChange={handleLoadSaved}>
                <SelectTrigger className="min-w-[200px] text-sm h-9">
                  <SelectValue placeholder="Load saved…" />
                </SelectTrigger>
                <SelectContent>
                  {savedChecks.length === 0 && (
                    <SelectItem value="_none" disabled>
                      No saved checks
                    </SelectItem>
                  )}
                  {savedChecks.map((sc: any) => (
                    <SelectItem key={sc.id} value={sc.id}>
                      {sc.name} ({sc.row_count} rows)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {savedChecks.length > 0 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[250px] p-2" align="start">
                    <p className="text-xs text-muted-foreground mb-2">
                      Delete a saved check:
                    </p>
                    {savedChecks.map((sc: any) => (
                      <button
                        key={sc.id}
                        onClick={() => handleDeleteSaved(sc.id)}
                        className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-destructive/10 hover:text-destructive flex justify-between"
                      >
                        {sc.name}
                        <Trash2 className="h-3 w-3" />
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </div>

          {/* Vendor filter */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Vendor Filter
            </label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="min-w-[200px] justify-between text-sm h-9"
                >
                  {selectedVendors.length === 0
                    ? "All vendors"
                    : `${selectedVendors.length} selected`}
                  <ChevronDown className="h-3.5 w-3.5 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-[280px] max-h-[300px] overflow-auto p-2"
                align="start"
              >
                {vendors.map((v) => (
                  <label
                    key={v}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer text-sm"
                  >
                    <Checkbox
                      checked={selectedVendors.includes(v)}
                      onCheckedChange={() => toggleVendor(v)}
                    />
                    {v}
                  </label>
                ))}
              </PopoverContent>
            </Popover>
          </div>

          {/* File upload */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Ledger File
            </label>
            <div className="flex items-center gap-2">
              <label className="cursor-pointer">
                <Input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  multiple
                  onChange={handleFile}
                  className="hidden"
                />
                <Button variant="outline" size="sm" asChild disabled={processing}>
                  <span>
                    <Upload className="h-3.5 w-3.5 mr-1.5" />
                    {processing ? "Processing…" : "Upload Excel"}
                  </span>
                </Button>
              </label>
              {fileName && (
                <span className="text-xs text-muted-foreground flex items-center gap-1 max-w-[300px] truncate">
                  {fileName}
                  <X
                    className="h-3 w-3 shrink-0 cursor-pointer hover:text-foreground"
                    onClick={() => {
                      setFileName("");
                      setLedgerRows([]);
                    }}
                  />
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Summary tiles */}
        {ledgerRows.length > 0 && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryTile
                label="Total Lines"
                count={stats.total}
                amount={stats.totalAmount}
                icon={<Package className="h-4 w-4" />}
                className="border-border"
              />
              <SummaryTile
                label="Procurement"
                count={stats.procurement}
                amount={stats.procurementAmount}
                icon={<ShoppingBag className="h-4 w-4" />}
                className="border-blue-300 dark:border-blue-700"
                textClass="text-blue-600 dark:text-blue-400"
              />
              <SummaryTile
                label="Special Orders"
                count={stats.specialOrder}
                amount={stats.specialOrderAmount}
                icon={<Tag className="h-4 w-4" />}
                className="border-amber-300 dark:border-amber-700"
                textClass="text-amber-600 dark:text-amber-400"
              />
              <SummaryTile
                label="Credits"
                count={stats.credits}
                amount={stats.creditAmount}
                icon={<CreditCard className="h-4 w-4" />}
                className="border-border"
                textClass="text-muted-foreground"
              />
            </div>

            {/* Callout bar */}
            {stats.notUploaded > 0 ? (
              <div className="flex items-center gap-2 p-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 text-sm">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                <span className="text-amber-800 dark:text-amber-300 font-medium">
                  {stats.notUploaded} documents not uploaded — $
                  {Math.abs(stats.notUploadedAmount).toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                  })}{" "}
                  needs attention
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 p-3 rounded-lg border border-green-300 bg-green-50 dark:bg-green-950/30 dark:border-green-800 text-sm">
                <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                <span className="text-green-800 dark:text-green-300 font-medium">
                  All documents matched ✓
                </span>
              </div>
            )}

            {/* Next payment callout */}
            {(() => {
              const procRows = ledgerRows.filter(
                (r) => r.category === "Procurement" && r.schedule?.next_due
              );
              if (procRows.length === 0) return null;
              const earliest = procRows.reduce((best, r) => {
                const d = r.schedule!.next_due!.due_date.getTime();
                const b = best.schedule!.next_due!.due_date.getTime();
                return d < b ? r : best;
              });
              const nextDue = earliest.schedule!.next_due!;
              const trancheAmount = procRows
                .filter(
                  (r) =>
                    r.schedule!.next_due!.due_date.getTime() ===
                    nextDue.due_date.getTime()
                )
                .reduce(
                  (s, r) =>
                    s + r.amount * r.schedule!.next_due!.amount_fraction,
                  0
                );
              const fmt = nextDue.due_date.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              });
              return (
                <div className="flex items-center gap-2 p-3 rounded-lg border border-blue-300 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 text-sm">
                  <Calendar className="h-4 w-4 text-blue-600 shrink-0" />
                  <span className="text-blue-800 dark:text-blue-300 font-medium">
                    Next payment due: {fmt} — $
                    {Math.abs(trancheAmount).toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                    })}
                  </span>
                </div>
              );
            })()}

            {/* Tabs + search + actions */}
            <div className="flex flex-wrap items-center gap-3">
              <Tabs
                value={activeTab}
                onValueChange={setActiveTab}
                className="flex-1"
              >
                <TabsList>
                  <TabsTrigger value="all">
                    All <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">{stats.total}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="procurement">
                    Procurement <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">{stats.procurement}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="special">
                    Special Orders <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">{stats.specialOrder}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="credits">
                    Credits <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">{stats.credits}</Badge>
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search doc # or PO ref…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8 h-9 w-[200px] text-sm"
                />
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadCSV}
                className="gap-1.5 text-xs"
              >
                <Download className="h-3.5 w-3.5" /> CSV
              </Button>

              <div className="flex items-center gap-1">
                <Input
                  placeholder="Save as…"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  className="h-8 w-[160px] text-xs"
                  onKeyDown={(e) => e.key === "Enter" && handleSave()}
                />
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!saveName.trim() || saving}
                  className="gap-1 text-xs h-8"
                >
                  <Save className="h-3.5 w-3.5" /> Save
                </Button>
              </div>
            </div>

            {/* Results table */}
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[110px]">Status</TableHead>
                    <TableHead className="w-[110px]">Category</TableHead>
                    <TableHead>Document #</TableHead>
                    <TableHead>Doc Date</TableHead>
                    <TableHead>Due Date</TableHead>
                    <TableHead className="w-[120px]">Next Due</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>PO Reference</TableHead>
                    <TableHead>Memo</TableHead>
                    <TableHead className="w-[140px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <StatusBadge row={row} />
                      </TableCell>
                      <TableCell>
                        <CategoryBadge row={row} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.matchedInvoiceId ? (
                          <button
                            onClick={() =>
                              handleOpenInvoice(row.matchedInvoiceId!)
                            }
                            className="text-primary underline underline-offset-2 hover:text-primary/80"
                          >
                            {row.documentNumber}
                          </button>
                        ) : (
                          row.documentNumber
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{row.docDate}</TableCell>
                      <TableCell className="text-xs">{row.dueDate}</TableCell>
                      <TableCell>
                        <NextDueCell row={row} />
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono text-xs ${
                          row.amount < 0 ? "text-blue-600 dark:text-blue-400" : ""
                        }`}
                      >
                        $
                        {row.amount.toLocaleString("en-US", {
                          minimumFractionDigits: 2,
                        })}
                      </TableCell>
                      <TableCell className="text-xs">{row.poReference}</TableCell>
                      <TableCell className="text-xs max-w-[200px] truncate">
                        {row.memo}
                        <SpecialOrderIndicator row={row} />
                      </TableCell>
                      <TableCell>
                        <SpecialOrderActions
                          row={row}
                          onMarkReceived={handleMarkReceived}
                          onMarkPaid={handleMarkPaid}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}

        {ledgerRows.length === 0 && !processing && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground text-sm gap-2">
            <Upload className="h-10 w-10 opacity-30" />
            <p className="font-medium">No statement uploaded yet</p>
            <p className="text-xs">
              Upload your vendor open-item AP export above to compare against
              invoices in the system.
            </p>
          </div>
        )}
      </div>

      {/* Invoice Drawer */}
      <InvoiceDrawer
        invoice={drawerInvoice}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setDrawerInvoice(null);
        }}
        onUpdate={() =>
          queryClient.invalidateQueries({ queryKey: ["saved_ledger_checks"] })
        }
      />
    </div>
  );
}

/* ─── sub-components ─── */

function SummaryTile({
  label,
  count,
  amount,
  icon,
  className = "",
  textClass = "",
}: {
  label: string;
  count: number;
  amount: number;
  icon: React.ReactNode;
  className?: string;
  textClass?: string;
}) {
  return (
    <div className={`rounded-lg border p-3 bg-card ${className}`}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        {icon}
        {label}
      </div>
      <div className={`text-xl font-bold ${textClass}`}>{count}</div>
      <div className="text-xs text-muted-foreground">
        $
        {Math.abs(amount).toLocaleString("en-US", {
          minimumFractionDigits: 2,
        })}
      </div>
    </div>
  );
}

function StatusBadge({ row }: { row: LedgerRow }) {
  switch (row.status) {
    case "matched":
      return (
        <Badge
          variant="outline"
          className="text-green-600 border-green-300 bg-green-50 dark:bg-green-950/30 text-[10px]"
        >
          <CheckCircle2 className="h-3 w-3 mr-1" />
          Matched
        </Badge>
      );
    case "not_uploaded":
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Badge
                  variant="outline"
                  className="text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/30 text-[10px] cursor-help"
                >
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Not Uploaded
                </Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-[280px] text-xs space-y-1">
              <p className="font-semibold">Document not found in system</p>
              <p><span className="text-muted-foreground">Doc #:</span> {row.documentNumber}</p>
              <p><span className="text-muted-foreground">Amount:</span> ${Math.abs(row.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</p>
              {row.poReference && <p><span className="text-muted-foreground">PO Ref:</span> {row.poReference}</p>}
              {row.memo && <p><span className="text-muted-foreground">Memo:</span> {row.memo}</p>}
              <p className="text-amber-500 pt-1">Upload this invoice via the Reader to resolve.</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    case "credit":
      return (
        <Badge
          variant="outline"
          className="text-blue-600 border-blue-300 bg-blue-50 dark:bg-blue-950/30 text-[10px]"
        >
          <CreditCard className="h-3 w-3 mr-1" />
          Credit
        </Badge>
      );
  }
}

function CategoryBadge({ row }: { row: LedgerRow }) {
  switch (row.category) {
    case "Procurement":
      return (
        <Badge variant="secondary" className="text-[10px]">
          <ShoppingBag className="h-3 w-3 mr-1" />
          Procurement
        </Badge>
      );
    case "Special Order":
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Badge
                  variant="outline"
                  className="text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/30 text-[10px] cursor-help"
                >
                  <Tag className="h-3 w-3 mr-1" />
                  Special Order
                </Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-[280px] text-xs space-y-1">
              <p className="font-semibold">Special Order — not a standard PO</p>
              <p><span className="text-muted-foreground">Doc #:</span> {row.documentNumber}</p>
              <p><span className="text-muted-foreground">PO Ref:</span> {row.poReference || "—"}</p>
              {row.status === "not_uploaded" && (
                <p className="text-amber-500 pt-1">Upload via Reader and add the 'special-order' tag.</p>
              )}
              {row.status === "matched" && !(row.matchedTags ?? []).includes("special-order") && (
                <p className="text-amber-500 pt-1">Uploaded but missing 'special-order' tag — open to add it.</p>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    case "Credit":
      return (
        <Badge variant="outline" className="text-muted-foreground text-[10px]">
          <CreditCard className="h-3 w-3 mr-1" />
          Credit
        </Badge>
      );
  }
}

function SpecialOrderIndicator({ row }: { row: LedgerRow }) {
  if (row.category !== "Special Order") return null;

  if (row.status === "not_uploaded") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-1.5 inline-flex items-center text-[10px] text-amber-600 cursor-help">
              <Tag className="h-3 w-3" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[220px] text-xs">
            When you upload this invoice via the Reader, add the
            &apos;special-order&apos; tag before saving.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (
    row.status === "matched" &&
    !(row.matchedTags ?? []).includes("special-order")
  ) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-1.5 inline-flex items-center">
              <AlertCircle className="h-3 w-3 text-amber-500" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[220px] text-xs">
            Invoice uploaded but not tagged as Special Order yet — open it to
            add the tag.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return null;
}

function SpecialOrderActions({
  row,
  onMarkReceived,
  onMarkPaid,
}: {
  row: LedgerRow;
  onMarkReceived: (row: LedgerRow) => void;
  onMarkPaid: (row: LedgerRow) => void;
}) {
  // Only show for special orders and one-offs (non-procurement, non-credit)
  if (row.category !== "Special Order") return null;

  // Not uploaded yet — prompt to upload first
  if (row.status === "not_uploaded") {
    return (
      <span className="text-[10px] text-muted-foreground italic">
        Upload first
      </span>
    );
  }

  // Already paid
  if (row.matchedStatus === "paid") {
    return (
      <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30">
        <CheckCircle2 className="h-3 w-3 mr-1" />
        Paid
      </Badge>
    );
  }

  // Received but not yet paid — show Mark Paid
  if (row.specialOrderReceived) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-[10px] gap-1 text-emerald-600 border-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
        onClick={() => onMarkPaid(row)}
      >
        <DollarSign className="h-3 w-3" />
        Mark Paid
      </Button>
    );
  }

  // Matched but not received — show Mark Received
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 text-[10px] gap-1 text-blue-600 border-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30"
      onClick={() => onMarkReceived(row)}
    >
      <PackageCheck className="h-3 w-3" />
      Came In
    </Button>
  );
}

function NextDueCell({ row }: { row: LedgerRow }) {
  const schedule = row.schedule;
  if (!schedule || row.category === "Credit") {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  if (schedule.vendor_terms_type === "unknown") {
    return (
      <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/30">
        Review
      </Badge>
    );
  }
  if (schedule.is_fully_overdue) {
    return <span className="text-[10px] font-semibold text-destructive">Overdue</span>;
  }
  const next = schedule.next_due;
  if (!next) return <span className="text-xs text-muted-foreground">—</span>;

  const fmt = next.due_date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const days = next.days_until_due;

  let dueBadge: React.ReactNode;
  if (days < 0) {
    dueBadge = <Badge variant="outline" className="text-[9px] ml-1 text-destructive border-destructive/30 bg-destructive/10">Overdue</Badge>;
  } else if (days <= 14) {
    dueBadge = <Badge variant="outline" className="text-[9px] ml-1 text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/30">Due soon</Badge>;
  } else {
    dueBadge = <Badge variant="outline" className="text-[9px] ml-1 text-emerald-600 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30">in {days}d</Badge>;
  }

  // Build tooltip content
  const trancheLines = schedule.tranches.map((t) => {
    const tFmt = t.due_date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const tAmt = (schedule.total_amount * t.amount_fraction).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const label = t.ledger_code ? `${t.tranche_label} (${t.ledger_code})` : t.tranche_label;
    return `${label} — ${tFmt} — $${tAmt}`;
  });
  const baselineFmt = schedule.baseline_date
    ? schedule.baseline_date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center text-xs cursor-help">
            {fmt}
            {dueBadge}
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-[300px] text-xs space-y-1">
          <p className="font-semibold">{schedule.human_label}</p>
          {trancheLines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
          {baselineFmt && (
            <p className="text-muted-foreground pt-1">Baseline: {baselineFmt}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
