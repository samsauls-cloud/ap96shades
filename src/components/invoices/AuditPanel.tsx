import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, XCircle, Loader2, RefreshCw, ShieldCheck, ShieldAlert } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/supabase-queries";
import { generatePaymentsForInvoice, recalculatePaymentsForInvoice, type AuditResult } from "@/lib/payment-queries";
import { toast } from "sonner";

type AuditStatus = "clean" | "warning" | "error";

function getAuditStatus(audit: AuditResult): AuditStatus {
  if (audit.mathDiscrepancies.length > 0) return "error";
  if (audit.missingPayments.length > 0 || audit.unknownVendors.length > 0 || audit.duplicateInvoices.length > 0) return "warning";
  return "clean";
}

function getIssueCount(audit: AuditResult): number {
  return audit.missingPayments.length + audit.mathDiscrepancies.length + audit.unknownVendors.length + audit.duplicateInvoices.length;
}

interface Props {
  audit: AuditResult | null;
  onRefresh: () => void;
  isLoading: boolean;
  totalInvoices: number;
}

export function AuditBanner({ audit, totalInvoices }: { audit: AuditResult | null; totalInvoices: number }) {
  if (!audit) return null;
  const status = getAuditStatus(audit);
  const issues = getIssueCount(audit);
  const time = new Date(audit.lastAuditTime).toLocaleTimeString();

  if (status === "clean") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-500/10 border border-green-500/20">
        <ShieldCheck className="h-4 w-4 text-green-500 shrink-0" />
        <p className="text-xs font-medium text-green-600 dark:text-green-400">
          ✓ All {totalInvoices} invoices verified · All payment schedules generated · Math verified · Last audit: {time}
        </p>
      </div>
    );
  }

  if (status === "error") {
    const errorDetails: string[] = [];
    if (audit.mathDiscrepancies.length > 0)
      errorDetails.push(`${audit.mathDiscrepancies.length} math discrepanc${audit.mathDiscrepancies.length !== 1 ? "ies" : "y"} (${audit.mathDiscrepancies.map(d => d.invoice_number).slice(0, 3).join(", ")}${audit.mathDiscrepancies.length > 3 ? "…" : ""})`);
    if (audit.missingPayments.length > 0)
      errorDetails.push(`${audit.missingPayments.length} missing payment schedule${audit.missingPayments.length !== 1 ? "s" : ""}`);
    if (audit.duplicateInvoices.length > 0)
      errorDetails.push(`${audit.duplicateInvoices.length} duplicate${audit.duplicateInvoices.length !== 1 ? "s" : ""}`);
    if (audit.unknownVendors.length > 0)
      errorDetails.push(`${audit.unknownVendors.length} unknown vendor${audit.unknownVendors.length !== 1 ? "s" : ""}`);
    return (
      <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
        <ShieldAlert className="h-4 w-4 text-red-500 shrink-0" />
        <p className="text-xs font-medium text-red-600 dark:text-red-400">
          🚨 {errorDetails.join(" · ")}
        </p>
      </div>
    );
  }

  const details: string[] = [];
  if (audit.missingPayments.length > 0)
    details.push(`${audit.missingPayments.length} missing payment schedule${audit.missingPayments.length !== 1 ? "s" : ""}`);
  if (audit.mathDiscrepancies.length > 0)
    details.push(`${audit.mathDiscrepancies.length} math discrepanc${audit.mathDiscrepancies.length !== 1 ? "ies" : "y"}`);
  if (audit.unknownVendors.length > 0)
    details.push(`${audit.unknownVendors.length} unknown vendor${audit.unknownVendors.length !== 1 ? "s" : ""}`);
  if (audit.duplicateInvoices.length > 0)
    details.push(`${audit.duplicateInvoices.length} duplicate invoice${audit.duplicateInvoices.length !== 1 ? "s" : ""}`);

  return (
    <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
      <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
      <p className="text-xs font-medium text-yellow-600 dark:text-yellow-400">
        ⚠ {details.join(" · ")}
      </p>
    </div>
  );
}

export function AuditPanel({ audit, onRefresh, isLoading, totalInvoices }: Props) {
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [recalcId, setRecalcId] = useState<string | null>(null);
  const [confirmRecalc, setConfirmRecalc] = useState<{ id: string; invoiceNumber: string; vendor: string; total: number; invoiceDate: string; poNumber: string | null } | null>(null);

  if (!audit) return null;
  const issues = getIssueCount(audit);

  const handleGenerateSingle = async (inv: AuditResult["missingPayments"][0]) => {
    setGeneratingId(inv.id);
    try {
      const count = await generatePaymentsForInvoice(inv.id, inv.invoice_date, inv.total, inv.vendor, inv.invoice_number, null);
      toast.success(`Generated ${count} payments for ${inv.invoice_number}`);
      onRefresh();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setGeneratingId(null);
    }
  };

  const handleRecalcConfirm = async () => {
    if (!confirmRecalc) return;
    setRecalcId(confirmRecalc.id);
    try {
      const count = await recalculatePaymentsForInvoice(
        confirmRecalc.id, confirmRecalc.invoiceDate, confirmRecalc.total,
        confirmRecalc.vendor, confirmRecalc.invoiceNumber, confirmRecalc.poNumber
      );
      toast.success(`Recalculated: ${count} new installments for ${confirmRecalc.invoiceNumber}`);
      setConfirmRecalc(null);
      onRefresh();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRecalcId(null);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex flex-col sm:flex-row sm:items-center gap-2">
          <span className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Cross-Vendor Audit
            {issues === 0 ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600">ALL CLEAR</span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-600">{issues} ISSUE{issues !== 1 ? "S" : ""}</span>
            )}
          </span>
          <Button size="sm" variant="ghost" className="sm:ml-auto text-xs h-7" onClick={onRefresh} disabled={isLoading}>
            {isLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
            Re-run Audit
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Recalc confirmation dialog */}
        {confirmRecalc && (
          <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 space-y-2">
            <p className="text-xs font-medium text-destructive">
              This will delete existing payment records for invoice <span className="font-mono">{confirmRecalc.invoiceNumber}</span> and regenerate them. Any recorded payment history will be lost.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" className="text-xs h-7" onClick={handleRecalcConfirm} disabled={!!recalcId}>
                {recalcId ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null} Confirm Recalculate
              </Button>
              <Button size="sm" variant="ghost" className="text-xs h-7" onClick={() => setConfirmRecalc(null)}>Cancel</Button>
            </div>
          </div>
        )}

        {/* 1. Missing Payments */}
        {audit.missingPayments.length > 0 && (
          <div>
            <p className="text-xs font-semibold mb-2 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
              Invoices Without Payment Schedules ({audit.missingPayments.length})
            </p>
            {/* Desktop */}
            <div className="hidden md:block overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border">
                    <TableHead className="text-[10px]">Invoice #</TableHead>
                    <TableHead className="text-[10px]">Vendor</TableHead>
                    <TableHead className="text-[10px] text-right">Total</TableHead>
                    <TableHead className="text-[10px]">Date</TableHead>
                    <TableHead className="text-[10px] text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {audit.missingPayments.map(inv => (
                    <TableRow key={inv.id} className="border-border">
                      <TableCell className="text-xs font-mono">{inv.invoice_number}</TableCell>
                      <TableCell className="text-xs">{inv.vendor}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{formatCurrency(inv.total)}</TableCell>
                      <TableCell className="text-xs">{formatDate(inv.invoice_date)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" className="text-[10px] h-6" onClick={() => handleGenerateSingle(inv)} disabled={generatingId === inv.id}>
                          {generatingId === inv.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Generate"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {/* Mobile */}
            <div className="md:hidden space-y-2">
              {audit.missingPayments.map(inv => (
                <div key={inv.id} className="rounded-lg border border-yellow-500/20 p-2.5 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-mono truncate">{inv.invoice_number}</p>
                    <p className="text-[10px] text-muted-foreground">{inv.vendor} · {formatCurrency(inv.total)}</p>
                  </div>
                  <Button size="sm" variant="outline" className="text-[10px] h-6 shrink-0" onClick={() => handleGenerateSingle(inv)} disabled={generatingId === inv.id}>
                    {generatingId === inv.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Generate"}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 2. Math Discrepancies */}
        {audit.mathDiscrepancies.length > 0 && (
          <div>
            <p className="text-xs font-semibold mb-2 flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5 text-red-500" />
              Payment Math Discrepancies ({audit.mathDiscrepancies.length})
            </p>
            <div className="hidden md:block overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border">
                    <TableHead className="text-[10px]">Invoice #</TableHead>
                    <TableHead className="text-[10px]">Vendor</TableHead>
                    <TableHead className="text-[10px] text-right">Invoice Total</TableHead>
                    <TableHead className="text-[10px] text-right">Installments Sum</TableHead>
                    <TableHead className="text-[10px] text-right">Discrepancy</TableHead>
                    <TableHead className="text-[10px] text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {audit.mathDiscrepancies.map(d => (
                    <TableRow key={d.id} className="border-border bg-red-500/5">
                      <TableCell className="text-xs font-mono">{d.invoice_number}</TableCell>
                      <TableCell className="text-xs">{d.vendor}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{formatCurrency(d.total)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{formatCurrency(d.installmentsSum)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums font-semibold text-red-500">{formatCurrency(d.discrepancy)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" className="text-[10px] h-6" onClick={() => setConfirmRecalc({
                          id: d.id, invoiceNumber: d.invoice_number, vendor: d.vendor,
                          total: d.total, invoiceDate: "", poNumber: null,
                        })}>
                          Fix
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="md:hidden space-y-2">
              {audit.mathDiscrepancies.map(d => (
                <div key={d.id} className="rounded-lg border border-red-500/20 p-2.5">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="text-xs font-mono">{d.invoice_number}</p>
                      <p className="text-[10px] text-muted-foreground">{d.vendor}</p>
                    </div>
                    <span className="text-xs font-semibold text-red-500 tabular-nums">{formatCurrency(d.discrepancy)}</span>
                  </div>
                  <div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
                    <span>Total: {formatCurrency(d.total)}</span>
                    <span>Sum: {formatCurrency(d.installmentsSum)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 3. Unknown Vendors */}
        {audit.unknownVendors.length > 0 && (
          <div>
            <p className="text-xs font-semibold mb-2 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-orange-500" />
              Unknown Vendors ({audit.unknownVendors.length})
            </p>
            <div className="space-y-1">
              {audit.unknownVendors.map(inv => (
                <div key={inv.id} className="flex items-center justify-between rounded border border-orange-500/20 p-2 text-xs">
                  <span className="font-mono truncate mr-2">{inv.invoice_number}</span>
                  <span className="px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-600 text-[10px] font-medium shrink-0">⚠ {inv.vendor}</span>
                  <span className="text-right tabular-nums ml-2">{formatCurrency(inv.total)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 4. Duplicate Invoices */}
        {audit.duplicateInvoices.length > 0 && (
          <div>
            <p className="text-xs font-semibold mb-2 flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5 text-red-500" />
              Duplicate Invoices ({audit.duplicateInvoices.length})
            </p>
            <div className="space-y-1">
              {audit.duplicateInvoices.map((d, i) => (
                <div key={i} className="flex items-center justify-between rounded border border-red-500/20 p-2 text-xs">
                  <span className="font-mono">{d.invoice_number}</span>
                  <span>{d.vendor}</span>
                  <span className="font-semibold text-red-500">{d.count}× duplicates</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* All clear */}
        {issues === 0 && (
          <div className="flex items-center justify-center gap-2 py-4 text-green-500">
            <CheckCircle2 className="h-5 w-5" />
            <p className="text-sm font-medium">All {totalInvoices} invoices verified — no issues found</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
