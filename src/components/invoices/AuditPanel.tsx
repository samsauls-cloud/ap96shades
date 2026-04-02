import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, XCircle, Loader2, RefreshCw, ShieldCheck, ShieldAlert, ChevronDown, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatCurrency, formatDate } from "@/lib/supabase-queries";
import { generatePaymentsForInvoice, recalculatePaymentsForInvoice, fixStaleInstallments, type AuditResult } from "@/lib/payment-queries";
import { toast } from "sonner";

type AuditStatus = "clean" | "warning" | "error";
type IssueCategory = "missingPayments" | "mathDiscrepancies" | "unknownVendors" | "duplicateInvoices" | "staleInstallments";

function getAuditStatus(audit: AuditResult): AuditStatus {
  if (audit.mathDiscrepancies.length > 0) return "error";
  if (audit.missingPayments.length > 0 || audit.unknownVendors.length > 0 || audit.duplicateInvoices.length > 0 || audit.staleInstallments.length > 0) return "warning";
  return "clean";
}

function getIssueCount(audit: AuditResult): number {
  return audit.missingPayments.length + audit.mathDiscrepancies.length + audit.unknownVendors.length + audit.duplicateInvoices.length + audit.staleInstallments.length;
}

interface IssueDef {
  key: IssueCategory;
  count: number;
  label: string;
  color: string;
  bgColor: string;
}

function getIssueChips(audit: AuditResult): IssueDef[] {
  const chips: IssueDef[] = [];
  if (audit.mathDiscrepancies.length > 0)
    chips.push({ key: "mathDiscrepancies", count: audit.mathDiscrepancies.length, label: "Math Discrepancies", color: "text-red-600 dark:text-red-400", bgColor: "bg-red-500/10 hover:bg-red-500/20 border-red-500/30" });
  if (audit.missingPayments.length > 0)
    chips.push({ key: "missingPayments", count: audit.missingPayments.length, label: "Missing Payments", color: "text-yellow-600 dark:text-yellow-400", bgColor: "bg-yellow-500/10 hover:bg-yellow-500/20 border-yellow-500/30" });
  if (audit.unknownVendors.length > 0)
    chips.push({ key: "unknownVendors", count: audit.unknownVendors.length, label: "Unknown Vendors", color: "text-orange-600 dark:text-orange-400", bgColor: "bg-orange-500/10 hover:bg-orange-500/20 border-orange-500/30" });
  if (audit.duplicateInvoices.length > 0)
    chips.push({ key: "duplicateInvoices", count: audit.duplicateInvoices.length, label: "Duplicates", color: "text-red-600 dark:text-red-400", bgColor: "bg-red-500/10 hover:bg-red-500/20 border-red-500/30" });
  if (audit.staleInstallments.length > 0)
    chips.push({ key: "staleInstallments", count: audit.staleInstallments.length, label: "Stale Installments", color: "text-purple-600 dark:text-purple-400", bgColor: "bg-purple-500/10 hover:bg-purple-500/20 border-purple-500/30" });
  return chips;
}

interface Props {
  audit: AuditResult | null;
  onRefresh: () => void;
  isLoading: boolean;
  totalInvoices: number;
}

/* ═══ Banner ═══ */
export function AuditBanner({ audit, totalInvoices, onScrollTo }: { audit: AuditResult | null; totalInvoices: number; onScrollTo?: (category: IssueCategory) => void }) {
  if (!audit) return null;
  const status = getAuditStatus(audit);
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

  const chips = getIssueChips(audit);

  return (
    <div className={`flex flex-wrap items-center gap-2 px-4 py-2.5 rounded-lg border ${status === "error" ? "bg-red-500/10 border-red-500/20" : "bg-yellow-500/10 border-yellow-500/20"}`}>
      {status === "error" ? (
        <ShieldAlert className="h-4 w-4 text-red-500 shrink-0" />
      ) : (
        <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
      )}
      <span className={`text-xs font-medium ${status === "error" ? "text-red-600 dark:text-red-400" : "text-yellow-600 dark:text-yellow-400"}`}>
        {status === "error" ? "🚨" : "⚠"} Issues found:
      </span>
      {chips.map(chip => (
        <button
          key={chip.key}
          onClick={() => onScrollTo?.(chip.key)}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold transition-colors cursor-pointer ${chip.bgColor} ${chip.color}`}
        >
          {chip.count} {chip.label}
        </button>
      ))}
    </div>
  );
}

/* ═══ Panel ═══ */
export function AuditPanel({ audit, onRefresh, isLoading, totalInvoices, highlightSection }: Props & { highlightSection?: IssueCategory | null }) {
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [recalcId, setRecalcId] = useState<string | null>(null);
  const [confirmRecalc, setConfirmRecalc] = useState<{ id: string; invoiceNumber: string; vendor: string; total: number; invoiceDate: string; poNumber: string | null; paymentTerms: string | null } | null>(null);
  const [sortField, setSortField] = useState<string>("vendor");
  const [fixingStaleId, setFixingStaleId] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  if (!audit) return null;
  const issues = getIssueCount(audit);

  const handleGenerateSingle = async (inv: AuditResult["missingPayments"][0]) => {
    setGeneratingId(inv.id);
    try {
      const count = await generatePaymentsForInvoice(inv.id, inv.invoice_date, inv.total, inv.vendor, inv.invoice_number, inv.po_number, inv.payment_terms);
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
        confirmRecalc.vendor, confirmRecalc.invoiceNumber, confirmRecalc.poNumber,
        confirmRecalc.paymentTerms
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

  // Sortable helper
  const sortItems = <T extends Record<string, any>>(items: T[], field: string): T[] => {
    return [...items].sort((a, b) => {
      const av = a[field], bv = b[field];
      if (typeof av === "number" && typeof bv === "number") return sortDir === "asc" ? av - bv : bv - av;
      return sortDir === "asc" ? String(av ?? "").localeCompare(String(bv ?? "")) : String(bv ?? "").localeCompare(String(av ?? ""));
    });
  };

  const toggleSort = (field: string) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); }
  };

  const SortHeader = ({ field, children, className }: { field: string; children: React.ReactNode; className?: string }) => (
    <TableHead className={`text-[10px] cursor-pointer select-none hover:text-foreground transition-colors ${className ?? ""}`} onClick={() => toggleSort(field)}>
      <span className="inline-flex items-center gap-0.5">
        {children}
        {sortField === field && <span className="text-[8px]">{sortDir === "asc" ? "▲" : "▼"}</span>}
      </span>
    </TableHead>
  );

  const isHighlighted = (cat: IssueCategory) => highlightSection === cat;

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
          <div id="audit-missingPayments" className={`rounded-lg p-3 transition-colors ${isHighlighted("missingPayments") ? "ring-2 ring-yellow-500/50 bg-yellow-500/5" : ""}`}>
            <p className="text-xs font-semibold mb-2 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
              Invoices Without Payment Schedules ({audit.missingPayments.length})
            </p>
            {/* Desktop */}
            <div className="hidden md:block overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border">
                    <SortHeader field="invoice_number">Invoice #</SortHeader>
                    <SortHeader field="vendor">Vendor</SortHeader>
                    <SortHeader field="total" className="text-right">Total</SortHeader>
                    <SortHeader field="invoice_date">Date</SortHeader>
                    <TableHead className="text-[10px] text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortItems(audit.missingPayments, sortField).map(inv => (
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
          <div id="audit-mathDiscrepancies" className={`rounded-lg p-3 transition-colors ${isHighlighted("mathDiscrepancies") ? "ring-2 ring-red-500/50 bg-red-500/5" : ""}`}>
            <p className="text-xs font-semibold mb-2 flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5 text-red-500" />
              Payment Math Discrepancies ({audit.mathDiscrepancies.length})
            </p>
            <div className="hidden md:block overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border">
                    <SortHeader field="invoice_number">Invoice #</SortHeader>
                    <SortHeader field="vendor">Vendor</SortHeader>
                    <SortHeader field="total" className="text-right">Invoice Total</SortHeader>
                    <SortHeader field="installmentsSum" className="text-right">Installments Sum</SortHeader>
                    <SortHeader field="discrepancy" className="text-right">Discrepancy</SortHeader>
                    <TableHead className="text-[10px] text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortItems(audit.mathDiscrepancies, sortField).map(d => (
                    <TableRow key={d.id} className="border-border bg-red-500/5">
                      <TableCell className="text-xs font-mono">{d.invoice_number}</TableCell>
                      <TableCell className="text-xs">{d.vendor}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{formatCurrency(d.total)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{formatCurrency(d.installmentsSum)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums font-semibold text-red-500">{formatCurrency(d.discrepancy)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" className="text-[10px] h-6" onClick={() => setConfirmRecalc({
                          id: d.id, invoiceNumber: d.invoice_number, vendor: d.vendor,
                          total: d.total, invoiceDate: d.invoice_date, poNumber: d.po_number, paymentTerms: d.payment_terms,
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
          <div id="audit-unknownVendors" className={`rounded-lg p-3 transition-colors ${isHighlighted("unknownVendors") ? "ring-2 ring-orange-500/50 bg-orange-500/5" : ""}`}>
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
          <div id="audit-duplicateInvoices" className={`rounded-lg p-3 transition-colors ${isHighlighted("duplicateInvoices") ? "ring-2 ring-red-500/50 bg-red-500/5" : ""}`}>
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

        {/* 5. Stale Installments */}
        {audit.staleInstallments.length > 0 && (
          <div id="audit-staleInstallments" className={`rounded-lg p-3 transition-colors ${isHighlighted("staleInstallments") ? "ring-2 ring-purple-500/50 bg-purple-500/5" : ""}`}>
            <p className="text-xs font-semibold mb-2 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-purple-500" />
              Stale Paid Installments ({audit.staleInstallments.length})
            </p>
            <p className="text-[10px] text-muted-foreground mb-2">
              These invoices have paid installments after an unpaid one — likely a data artifact from marking the wrong tranche.
            </p>
            <div className="space-y-2">
              {audit.staleInstallments.map(si => (
                <div key={si.invoice_id} className="rounded border border-purple-500/20 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-mono truncate">{si.invoice_number}</p>
                      <p className="text-[10px] text-muted-foreground">{si.vendor} · {formatCurrency(si.total)}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-[10px] h-6 shrink-0"
                      onClick={async () => {
                        setFixingStaleId(si.invoice_id);
                        try {
                          const count = await fixStaleInstallments(si.invoice_id);
                          toast.success(`Reset ${count} stale installment${count !== 1 ? "s" : ""} for ${si.invoice_number}`);
                          onRefresh();
                        } catch (e: any) {
                          toast.error(e.message);
                        } finally {
                          setFixingStaleId(null);
                        }
                      }}
                      disabled={fixingStaleId === si.invoice_id}
                    >
                      {fixingStaleId === si.invoice_id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Fix"}
                    </Button>
                  </div>
                  <div className="mt-1.5 space-y-0.5">
                    {si.staleRows.map(r => (
                      <div key={r.id} className="flex items-center justify-between text-[10px] text-purple-600 dark:text-purple-400">
                        <span>{r.installment_label ?? r.due_date} — due {formatDate(r.due_date)}</span>
                        <span className="font-semibold">{formatCurrency(r.amount_due)} ← stale paid</span>
                      </div>
                    ))}
                  </div>
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
