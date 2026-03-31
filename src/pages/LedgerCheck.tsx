import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Upload, CheckCircle2, AlertTriangle, CreditCard, ChevronDown, X } from "lucide-react";

interface LedgerRow {
  account: string;
  documentNumber: string;
  docDate: string;
  dueDate: string;
  terms: string;
  amount: number;
  memo: string;
  poReference: string;
  status: "matched" | "not_uploaded" | "credit";
  matchedInvoiceId?: string;
}

export default function LedgerCheckPage() {
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [processing, setProcessing] = useState(false);

  const { data: vendors = [] } = useQuery({
    queryKey: ["distinct_vendors"],
    queryFn: fetchDistinctVendors,
  });

  const toggleVendor = (v: string) => {
    setSelectedVendors(prev =>
      prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]
    );
  };

  const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setProcessing(true);

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

      // Skip header row, filter blanks in col A
      const dataRows = raw.slice(1).filter(r => r[0] != null && String(r[0]).trim() !== "");

      const parsed = dataRows.map(r => ({
        account: String(r[0] ?? ""),
        documentNumber: typeof r[1] === "number" ? String(Math.trunc(r[1])) : String(r[1] ?? "").trim(),
        docDate: r[2] ? formatExcelDate(r[2]) : "",
        dueDate: r[3] ? formatExcelDate(r[3]) : "",
        terms: String(r[4] ?? ""),
        amount: typeof r[5] === "number" ? r[5] : parseFloat(String(r[5] ?? "0").replace(/[,$]/g, "")) || 0,
        memo: String(r[6] ?? ""),
        poReference: String(r[7] ?? ""),
      }));

      // Fetch all invoice numbers for comparison
      const docNumbers = parsed.map(p => p.documentNumber).filter(Boolean);
      const { data: matches } = await supabase
        .from("vendor_invoices")
        .select("id, invoice_number")
        .in("invoice_number", docNumbers);

      const matchMap = new Map((matches ?? []).map(m => [m.invoice_number, m.id]));

      const results: LedgerRow[] = parsed.map(p => {
        const isCredit = p.amount < 0;
        const found = matchMap.get(p.documentNumber);
        return {
          ...p,
          status: isCredit ? "credit" : found ? "matched" : "not_uploaded",
          matchedInvoiceId: found,
        };
      });

      setLedgerRows(results);
    } catch (err) {
      console.error("Excel parse error:", err);
    } finally {
      setProcessing(false);
      e.target.value = "";
    }
  }, []);

  const filtered = useMemo(() => {
    if (selectedVendors.length === 0) return ledgerRows;
    // Filter by account field matching selected vendors (case-insensitive partial)
    return ledgerRows;
  }, [ledgerRows, selectedVendors]);

  const stats = useMemo(() => {
    const total = filtered.length;
    const totalAmount = filtered.reduce((s, r) => s + r.amount, 0);
    const notUploaded = filtered.filter(r => r.status === "not_uploaded").length;
    const matched = filtered.filter(r => r.status === "matched").length;
    const credits = filtered.filter(r => r.status === "credit").length;
    return { total, totalAmount, notUploaded, matched, credits };
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

        {/* Controls */}
        <div className="flex flex-wrap items-end gap-4">
          {/* Vendor multi-select */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Vendor Filter</label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="min-w-[220px] justify-between text-sm">
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
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  {fileName}
                  <X
                    className="h-3 w-3 cursor-pointer hover:text-foreground"
                    onClick={() => { setFileName(""); setLedgerRows([]); }}
                  />
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Summary bar */}
        {ledgerRows.length > 0 && (
          <div className="flex flex-wrap gap-4 p-3 rounded-lg border bg-card text-sm">
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
