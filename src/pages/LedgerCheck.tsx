import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { fetchDistinctVendors } from "@/lib/supabase-queries";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Upload, CheckCircle2, AlertTriangle, CreditCard, ChevronDown, X, Download, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

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
  status: "matched" | "not_uploaded" | "credit";
  matchedInvoiceId?: string;
}

/** Batch .in() queries to avoid Supabase limits */
async function batchMatchInvoices(docNumbers: string[]): Promise<Map<string, string>> {
  const BATCH = 200;
  const matchMap = new Map<string, string>();
  for (let i = 0; i < docNumbers.length; i += BATCH) {
    const chunk = docNumbers.slice(i, i + BATCH);
    const { data } = await supabase
      .from("vendor_invoices")
      .select("id, invoice_number")
      .in("invoice_number", chunk);
    (data ?? []).forEach(m => matchMap.set(m.invoice_number, m.id));
  }
  return matchMap;
}

export default function LedgerCheckPage() {
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [processing, setProcessing] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();

  const { data: vendors = [] } = useQuery({
    queryKey: ["distinct_vendors"],
    queryFn: fetchDistinctVendors,
  });

  const { data: savedChecks = [] } = useQuery({
    queryKey: ["saved_ledger_checks"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("saved_ledger_checks" as any)
        .select("id, name, created_at, row_count, matched_count, not_uploaded_count, credit_count, total_amount, source_files")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const toggleVendor = (v: string) => {
    setSelectedVendors(prev =>
      prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]
    );
  };

  const processRows = useCallback(async (parsed: Omit<LedgerRow, "status" | "matchedInvoiceId">[]) => {
    const docNumbers = parsed.map(p => p.documentNumber).filter(Boolean);
    const matchMap = await batchMatchInvoices(docNumbers);

    return parsed.map(p => {
      const isCredit = p.amount < 0;
      const found = matchMap.get(p.documentNumber);
      return {
        ...p,
        status: (isCredit ? "credit" : found ? "matched" : "not_uploaded") as LedgerRow["status"],
        matchedInvoiceId: found,
      };
    });
  }, []);

  const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setFileName(files.map(f => f.name).join(", "));
    setProcessing(true);

    try {
      const allParsed = await Promise.all(files.map(async (file) => {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
        const dataRows = raw.slice(1).filter(r => r[0] != null && String(r[0]).trim() !== "");
        return dataRows.map(r => ({
          account: String(r[0] ?? ""),
          documentNumber: typeof r[1] === "number" ? String(Math.trunc(r[1])) : String(r[1] ?? "").trim(),
          docDate: r[2] ? formatExcelDate(r[2]) : "",
          dueDate: r[3] ? formatExcelDate(r[3]) : "",
          terms: String(r[4] ?? ""),
          amount: typeof r[5] === "number" ? r[5] : parseFloat(String(r[5] ?? "0").replace(/[,$]/g, "")) || 0,
          memo: String(r[6] ?? ""),
          poReference: String(r[7] ?? ""),
          sourceFile: file.name,
        }));
      }));

      // Deduplicate by document number
      const seen = new Set<string>();
      const parsed = allParsed.flat().filter(p => {
        if (seen.has(p.documentNumber)) return false;
        seen.add(p.documentNumber);
        return true;
      });

      const results = await processRows(parsed);
      setLedgerRows(results);
    } catch (err) {
      console.error("Excel parse error:", err);
      toast.error("Failed to parse Excel file(s)");
    } finally {
      setProcessing(false);
      e.target.value = "";
    }
  }, [processRows]);

  const handleSave = useCallback(async () => {
    const name = saveName.trim();
    if (!name || ledgerRows.length === 0) return;
    setSaving(true);
    try {
      const stats = computeStats(ledgerRows);
      const sourceFiles = [...new Set(ledgerRows.map(r => r.sourceFile).filter(Boolean))];
      const { error } = await supabase.from("saved_ledger_checks" as any).insert({
        name,
        source_files: sourceFiles,
        row_count: stats.total,
        total_amount: stats.totalAmount,
        matched_count: stats.matched,
        not_uploaded_count: stats.notUploaded,
        credit_count: stats.credits,
        rows: ledgerRows,
      } as any);
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

  const handleLoadSaved = useCallback(async (id: string) => {
    try {
      const { data, error } = await supabase
        .from("saved_ledger_checks" as any)
        .select("name, rows, source_files")
        .eq("id", id)
        .single();
      if (error) throw error;
      const saved = data as any;
      // Re-run matching against current DB state
      const rawRows = (saved.rows as any[]).map(r => ({
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
  }, [processRows]);

  const handleDeleteSaved = useCallback(async (id: string) => {
    const { error } = await supabase.from("saved_ledger_checks" as any).delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["saved_ledger_checks"] });
    toast.success("Deleted");
  }, [queryClient]);

  const filtered = useMemo(() => {
    return ledgerRows;
  }, [ledgerRows]);

  const stats = useMemo(() => computeStats(filtered), [filtered]);

  const handleDownloadCSV = useCallback(() => {
    const header = "Status,Document #,Account,Doc Date,Due Date,Amount,Memo,PO Ref,Source File";
    const rows = filtered.map(r =>
      [r.status, r.documentNumber, r.account, r.docDate, r.dueDate,
        r.amount.toFixed(2), r.memo, r.poReference, r.sourceFile ?? ""]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
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
            Upload a vendor open-item statement to compare against your invoice database
          </p>
        </div>

        {/* Controls row */}
        <div className="flex flex-wrap items-end gap-4">
          {/* Saved ledger checks dropdown */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Saved Checks</label>
            <div className="flex items-center gap-1">
              <Select onValueChange={handleLoadSaved}>
                <SelectTrigger className="min-w-[200px] text-sm h-9">
                  <SelectValue placeholder="Load saved…" />
                </SelectTrigger>
                <SelectContent>
                  {savedChecks.length === 0 && (
                    <SelectItem value="_none" disabled>No saved checks</SelectItem>
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
                    <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[250px] p-2" align="start">
                    <p className="text-xs text-muted-foreground mb-2">Delete a saved check:</p>
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

          {/* Vendor multi-select */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Vendor Filter</label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="min-w-[200px] justify-between text-sm h-9">
                  {selectedVendors.length === 0
                    ? "All vendors"
                    : `${selectedVendors.length} selected`}
                  <ChevronDown className="h-3.5 w-3.5 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[280px] max-h-[300px] overflow-auto p-2" align="start">
                {vendors.map(v => (
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
            <label className="text-xs font-medium text-muted-foreground">Ledger File</label>
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
                    onClick={() => { setFileName(""); setLedgerRows([]); }}
                  />
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Summary bar + actions */}
        {ledgerRows.length > 0 && (
          <div className="flex flex-wrap items-center gap-4 p-3 rounded-lg border bg-card text-sm">
            <span className="font-medium">{stats.total} items</span>
            <span className="text-muted-foreground">
              Total: <span className="font-medium text-foreground">${stats.totalAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
            </span>
            <span className="flex items-center gap-1 text-green-600">
              <CheckCircle2 className="h-3.5 w-3.5" /> {stats.matched} matched
            </span>
            <span className="flex items-center gap-1 text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5" /> {stats.notUploaded} not uploaded
            </span>
            <span className="flex items-center gap-1 text-blue-600">
              <CreditCard className="h-3.5 w-3.5" /> {stats.credits} credits
            </span>

            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleDownloadCSV} className="gap-1.5 text-xs">
                <Download className="h-3.5 w-3.5" /> CSV
              </Button>
              <div className="flex items-center gap-1">
                <Input
                  placeholder="Save as…"
                  value={saveName}
                  onChange={e => setSaveName(e.target.value)}
                  className="h-8 w-[160px] text-xs"
                  onKeyDown={e => e.key === "Enter" && handleSave()}
                />
                <Button size="sm" onClick={handleSave} disabled={!saveName.trim() || saving} className="gap-1 text-xs h-8">
                  <Save className="h-3.5 w-3.5" /> Save
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Results table */}
        {ledgerRows.length > 0 && (
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Status</TableHead>
                  <TableHead>Document #</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Doc Date</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Memo</TableHead>
                  <TableHead>PO Ref</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <StatusBadge status={row.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.documentNumber}</TableCell>
                    <TableCell className="text-xs">{row.account}</TableCell>
                    <TableCell className="text-xs">{row.docDate}</TableCell>
                    <TableCell className="text-xs">{row.dueDate}</TableCell>
                    <TableCell className={`text-right font-mono text-xs ${row.amount < 0 ? "text-blue-600" : ""}`}>
                      ${row.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-xs max-w-[200px] truncate">{row.memo}</TableCell>
                    <TableCell className="text-xs">{row.poReference}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {ledgerRows.length === 0 && !processing && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground text-sm gap-2">
            <Upload className="h-10 w-10 opacity-30" />
            <p>Upload a vendor ledger Excel to begin</p>
          </div>
        )}
      </div>
    </div>
  );
}

function computeStats(rows: LedgerRow[]) {
  return {
    total: rows.length,
    totalAmount: rows.reduce((s, r) => s + r.amount, 0),
    notUploaded: rows.filter(r => r.status === "not_uploaded").length,
    matched: rows.filter(r => r.status === "matched").length,
    credits: rows.filter(r => r.status === "credit").length,
  };
}

function StatusBadge({ status }: { status: LedgerRow["status"] }) {
  switch (status) {
    case "matched":
      return <Badge variant="outline" className="text-green-600 border-green-300 bg-green-50 text-[10px]"><CheckCircle2 className="h-3 w-3 mr-1" />Matched</Badge>;
    case "not_uploaded":
      return <Badge variant="outline" className="text-amber-600 border-amber-300 bg-amber-50 text-[10px]"><AlertTriangle className="h-3 w-3 mr-1" />Not Uploaded</Badge>;
    case "credit":
      return <Badge variant="outline" className="text-blue-600 border-blue-300 bg-blue-50 text-[10px]"><CreditCard className="h-3 w-3 mr-1" />Credit</Badge>;
  }
}

function formatExcelDate(v: any): string {
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.m}/${d.d}/${d.y}`;
  }
  if (typeof v === "string") return v;
  return String(v);
}
