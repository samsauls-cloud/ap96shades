import { useState, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  Upload, FileText, CheckCircle2, AlertTriangle, XCircle, Minus, Package,
  ArrowRight, Download, Eye, Filter, ChevronDown, ChevronUp, Info, ShieldCheck,
  Send, CheckCheck, FileDown, DollarSign
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  detectFormat, formatLabel, parseCSV, parseLines, computeSessionStats,
  vendorFromLightspeed, createSession, insertReceivingLines, fetchSessions,
  fetchSessionLines, matchReceivingToInvoice, calcDiscrepancy,
  updateSessionReconciliation, updateLineReconciliation, exportReconciliationCSV,
  checkReceivingDuplicate, mergeReceivingUpdate, resolveEOLVendor,
  type ExportFormat, type ParsedLine, type ReceivingStatus, type ReceivingDedupAction, type EOLResolution
} from "@/lib/receiving-engine";
import { getLineItems, formatCurrency } from "@/lib/supabase-queries";
import { suggestMatchingInvoices, matchStrengthBadge, type InvoiceSuggestion } from "@/lib/invoice-suggestions";
import { computeReconciliationTotals, verifyReconciliationMath, type MathCheck, type ReconciliationTotals } from "@/lib/reconciliation-math";
import {
  upsertFinalBillEntry, updateInvoiceReconciliation, applyCreditToPayments,
  fetchFinalBillLedger, markCreditRequestSent, confirmCreditReceived,
  generateCreditRequestCSV, type FinalBillLedgerEntry
} from "@/lib/final-bill-queries";

// ── Receiving-to-Invoice Vendor Mapping ──
const RECEIVING_TO_INVOICE_VENDOR: Record<string, string[]> = {
  'EOL':       ['Luxottica', 'Kering', 'Maui Jim', 'Safilo', 'Marcolin'], // EOL can be any real vendor
  'Luxottica': ['Luxottica'],
  'Kering':    ['Kering'],
  'Marcolin':  ['Marcolin'],
  'Marchon':   ['Safilo', 'Marcolin'],
  'Safilo':    ['Safilo'],
  'Maui Jim':  ['Maui Jim'],
};

const VENDOR_TOOLTIPS: Record<string, string> = {
  'EOL': 'EOL is a discount classification — these frames belong to real vendors (Luxottica, Kering, etc.). The system auto-resolves the real vendor from item descriptions.',
  'Marchon': 'Marchon frames may appear on Safilo or Marcolin invoices.',
};

// ── Status Badge ──
function ReceivingStatusBadge({ status, ordered, received }: { status: ReceivingStatus; ordered?: number; received?: number | null }) {
  switch (status) {
    case 'FULLY_RECEIVED':
      return <Badge className="bg-emerald-600 text-white text-xs gap-1"><CheckCircle2 className="h-3 w-3" />Received {received}/{ordered}</Badge>;
    case 'PARTIALLY_RECEIVED':
      return <Badge className="bg-blue-600 text-white text-xs gap-1"><Package className="h-3 w-3" />Partial {received}/{ordered}</Badge>;
    case 'NOT_RECEIVED':
      return <Badge variant="destructive" className="text-xs gap-1"><XCircle className="h-3 w-3" />Not Received 0/{ordered}</Badge>;
    default:
      return <Badge variant="secondary" className="text-xs gap-1"><Minus className="h-3 w-3" />No Data</Badge>;
  }
}

function MatchBadge({ status }: { status?: string }) {
  if (!status) return null;
  const colors: Record<string, string> = {
    MATCHED: 'bg-emerald-600 text-white',
    UPC_ONLY: 'bg-emerald-500 text-white',
    SKU_ONLY: 'bg-amber-500 text-white',
    NO_MATCH: 'bg-red-500 text-white',
  };
  return <Badge className={`text-xs ${colors[status] ?? ''}`}>{status.replace('_', ' ')}</Badge>;
}

function DiscrepancyBadge({ type }: { type?: string }) {
  if (!type) return null;
  const colors: Record<string, string> = {
    OVERBILLED: 'bg-red-600 text-white',
    UNDERBILLED: 'bg-amber-600 text-white',
    QTY_MISMATCH: 'bg-amber-500 text-white',
    PRICE_MISMATCH: 'bg-orange-500 text-white',
    NOT_ON_INVOICE: 'bg-gray-500 text-white',
  };
  return <Badge className={`text-xs ${colors[type] ?? ''}`}>{type.replace(/_/g, ' ')}</Badge>;
}

// ── Main Page ──
export default function ReceivingPage() {
  const qc = useQueryClient();
  const [sessionName, setSessionName] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<{ format: ExportFormat; headers: string[]; rows: string[][]; lines: ParsedLine[]; vendor: string; filename: string; eolResolution?: EOLResolution } | null>(null);
  const [dedupResult, setDedupResult] = useState<ReceivingDedupAction | null>(null);
  const [checkingDedup, setCheckingDedup] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [discrepancyOnly, setDiscrepancyOnly] = useState(false);
  const [historyVendor, setHistoryVendor] = useState<string>('all');
  const [historyStatus, setHistoryStatus] = useState<string>('all');
  const [reconciling, setReconciling] = useState<string | null>(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>('');
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [mathChecks, setMathChecks] = useState<MathCheck[] | null>(null);
  const [reconTotals, setReconTotals] = useState<ReconciliationTotals | null>(null);
  const [activeTab, setActiveTab] = useState<'receiving' | 'final-bill'>('receiving');
  const [creditConfirmOpen, setCreditConfirmOpen] = useState<string | null>(null);
  const [creditAmount, setCreditAmount] = useState('');
  const [creditApprover, setCreditApprover] = useState('');

  // ── Queries ──
  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['receiving-sessions'],
    queryFn: () => fetchSessions(),
  });

  const { data: sessionLines = [], isLoading: linesLoading } = useQuery({
    queryKey: ['receiving-lines', selectedSessionId],
    queryFn: () => fetchSessionLines(selectedSessionId!),
    enabled: !!selectedSessionId,
  });

  const selectedSession = sessions.find(s => s.id === selectedSessionId);

  const { data: vendorInvoices = [] } = useQuery({
    queryKey: ['vendor-invoices-for-recon'],
    queryFn: async () => {
      const { data } = await supabase
        .from('vendor_invoices')
        .select('*')
        .order('invoice_date', { ascending: false });
      return data ?? [];
    },
    enabled: !!reconciling,
  });

  // ── Final Bill Ledger Query ──
  const { data: finalBillEntries = [], isLoading: finalBillLoading } = useQuery({
    queryKey: ['final-bill-ledger'],
    queryFn: fetchFinalBillLedger,
  });
  // ── Invoice filtering by vendor mapping ──
  // For EOL sessions, resolve real vendors from session lines instead of using static map
  const reconSession = reconciling ? sessions.find(s => s.id === reconciling) : null;
  const isEOLSession = reconSession?.vendor === 'EOL';
  const eolSessionResolution = useMemo(() => {
    if (!isEOLSession || sessionLines.length === 0) return null;
    return resolveEOLVendor(sessionLines as any[]);
  }, [isEOLSession, sessionLines]);

  const allowedVendors = useMemo(() => {
    if (!reconSession) return null;
    if (isEOLSession && eolSessionResolution) {
      // Use only the resolved real vendors for EOL
      return eolSessionResolution.realVendors.length > 0 ? eolSessionResolution.realVendors : ['Luxottica'];
    }
    return RECEIVING_TO_INVOICE_VENDOR[reconSession.vendor] ?? null;
  }, [reconSession, isEOLSession, eolSessionResolution]);

  const vendorFilteredInvoices = useMemo(() => {
    return allowedVendors
      ? vendorInvoices.filter(inv => allowedVendors.some(v => inv.vendor?.toLowerCase() === v.toLowerCase()))
      : vendorInvoices;
  }, [vendorInvoices, allowedVendors]);

  // ── Auto-suggestions ──
  const invoiceSuggestions = useMemo((): InvoiceSuggestion[] => {
    if (!reconSession || vendorFilteredInvoices.length === 0 || sessionLines.length === 0) return [];
    return suggestMatchingInvoices(
      sessionLines,
      Number(reconSession.total_ordered_cost || 0),
      reconSession.raw_filename || '',
      reconSession.session_name || '',
      vendorFilteredInvoices
    );
  }, [reconSession, vendorFilteredInvoices, sessionLines]);

  const filteredInvoices = useMemo(() => {
    let list = vendorFilteredInvoices;
    if (invoiceSearch.trim()) {
      const q = invoiceSearch.toLowerCase().trim();
      list = list.filter(inv =>
        inv.invoice_number?.toLowerCase().includes(q) ||
        inv.po_number?.toLowerCase().includes(q) ||
        inv.vendor?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [vendorFilteredInvoices, invoiceSearch]);

  // ── File Handler ──
  const handleFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers, rows } = parseCSV(text);
      const format = detectFormat(headers);
      if (format === 'UNKNOWN') {
        toast.error('Could not detect Lightspeed export format. Check column headers.');
        return;
      }
      const lines = parseLines(headers, rows, format);
      // Detect vendor from first line with a vendor_id
      const firstVendorId = lines.find(l => l.vendor_id)?.vendor_id ?? '';
      const firstDesc = lines[0]?.item_description ?? '';
      const vendor = vendorFromLightspeed(firstVendorId, firstDesc);

      // EOL resolution: determine real vendor(s) from item descriptions
      let eolResolution: EOLResolution | undefined;
      if (vendor === 'EOL') {
        eolResolution = resolveEOLVendor(lines);
        const displayVendor = eolResolution.isMultiVendor
          ? `EOL — Multi-vendor (${eolResolution.realVendors.join(', ')})`
          : `EOL — ${eolResolution.realVendor} End-of-Line Frames`;
        const autoName = `${displayVendor} ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} Batch`;
        if (!sessionName) setSessionName(autoName);
      } else {
        const autoName = `${vendor} ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} Batch`;
        if (!sessionName) setSessionName(autoName);
      }
      setPreview({ format, headers, rows, lines, vendor, filename: file.name, eolResolution });
    };
    reader.readAsText(file);
  }, [sessionName]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // ── Pre-Import Dedup Check ──
  const runDedupCheck = async () => {
    if (!preview) return;
    setCheckingDedup(true);
    try {
      const result = await checkReceivingDuplicate(preview.vendor, preview.filename, preview.lines);
      setDedupResult(result);
      if (result.type === 'exact_duplicate') {
        toast.warning('This exact CSV has already been imported — no changes needed.');
      } else if (result.type === 'update_available') {
        toast.info(`Updated CSV detected: ${result.changedLines} changed, ${result.newLines} new lines. Review below.`);
      }
    } catch (err: any) {
      toast.error(err.message || 'Dedup check failed');
      setDedupResult({ type: 'new' }); // fallback to allow import
    } finally {
      setCheckingDedup(false);
    }
  };

  // ── Import (new session) ──
  const doImport = async () => {
    if (!preview) return;
    setImporting(true);
    try {
      const stats = computeSessionStats(preview.lines);
      const session = await createSession({
        session_name: sessionName || 'Untitled Session',
        vendor: preview.vendor,
        lightspeed_export_type: preview.format,
        raw_filename: preview.filename,
        stats,
      });
      await insertReceivingLines(session.id, preview.lines);
      toast.success(`Imported ${preview.lines.length} lines`);
      setPreview(null);
      setSessionName('');
      setDedupResult(null);
      setSelectedSessionId(session.id);
      qc.invalidateQueries({ queryKey: ['receiving-sessions'] });
    } catch (err: any) {
      toast.error(err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  // ── Merge Update (existing session) ──
  const doMergeUpdate = async () => {
    if (!preview || !dedupResult || dedupResult.type !== 'update_available') return;
    setImporting(true);
    try {
      const { updatedCount, insertedCount } = await mergeReceivingUpdate(
        dedupResult.existingSessionId,
        preview.lines
      );
      toast.success(`Merged: ${updatedCount} lines updated, ${insertedCount} new lines added. Unchanged lines were preserved.`);
      setPreview(null);
      setSessionName('');
      setDedupResult(null);
      setSelectedSessionId(dedupResult.existingSessionId);
      qc.invalidateQueries({ queryKey: ['receiving-sessions'] });
      qc.invalidateQueries({ queryKey: ['receiving-lines', dedupResult.existingSessionId] });
    } catch (err: any) {
      toast.error(err.message || 'Merge failed');
    } finally {
      setImporting(false);
    }
  };

  // ── Reconciliation ──
  const runReconciliation = async () => {
    if (!selectedSessionId || !selectedInvoiceId) return;
    try {
      const invoice = vendorInvoices.find(v => v.id === selectedInvoiceId);
      if (!invoice) return;
      const invoiceLines = getLineItems(invoice);
      const results = matchReceivingToInvoice(sessionLines, invoiceLines);

      const skipPriceCheck = selectedSession?.vendor === 'EOL';
      let hasDiscrepancy = false;
      for (const r of results) {
        const disc = calcDiscrepancy(r.line, r.matched_invoice_line, skipPriceCheck);
        const update: any = {
          matched_invoice_line: r.matched_invoice_line as any,
          match_status: r.match_status,
          billing_discrepancy: !!disc,
          discrepancy_type: disc?.type ?? null,
          discrepancy_amount: disc?.amount ?? 0,
        };
        if (disc) hasDiscrepancy = true;
        await updateLineReconciliation(r.line.id, update);
      }

      const status = hasDiscrepancy ? 'discrepancy' : 'reconciled';
      await updateSessionReconciliation(selectedSessionId, selectedInvoiceId, status);

      // ── Refresh lines to get updated discrepancy data ──
      const { data: updatedLines } = await supabase
        .from('po_receiving_lines')
        .select('*')
        .eq('session_id', selectedSessionId);
      const freshLines = updatedLines ?? sessionLines;

      // ── Compute reconciliation totals ──
      const totals = computeReconciliationTotals(freshLines, invoice.total);
      setReconTotals(totals);

      // ── Math verification ──
      const checks = verifyReconciliationMath(
        freshLines,
        Number(selectedSession?.total_ordered_cost || 0),
        Number(selectedSession?.total_ordered_qty || 0),
        invoice.total,
        totals
      );
      setMathChecks(checks);

      // ── Update vendor_invoices with reconciliation data ──
      const reconStatus = totals.totalCreditDue > 0 ? 'credit_pending' : 'reconciled';
      await updateInvoiceReconciliation(
        selectedInvoiceId,
        selectedSessionId,
        totals.totalCreditDue,
        totals.finalBillAmount,
        reconStatus
      );

      // ── Create/update final bill ledger entry ──
      await upsertFinalBillEntry(
        selectedInvoiceId,
        selectedSessionId,
        invoice,
        {
          total_ordered_qty: Number(selectedSession?.total_ordered_qty || 0),
          total_received_qty: Number(selectedSession?.total_received_qty || 0),
        },
        totals
      );

      // ── Apply credits to payment installments ──
      if (totals.totalCreditDue > 0) {
        await applyCreditToPayments(selectedInvoiceId, totals.totalCreditDue);
      }

      const allPassed = checks.every(c => c.pass);
      toast.success(allPassed
        ? 'Reconciliation complete — all math checks passed ✓'
        : 'Reconciliation complete — ⚠ math discrepancies detected'
      );
      setReconciling(null);
      qc.invalidateQueries({ queryKey: ['receiving-lines', selectedSessionId] });
      qc.invalidateQueries({ queryKey: ['receiving-sessions'] });
      qc.invalidateQueries({ queryKey: ['final-bill-ledger'] });
      qc.invalidateQueries({ queryKey: ['vendor-invoices-for-recon'] });
      qc.invalidateQueries({ queryKey: ['invoice_payments'] });
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  // ── Filtered Lines ──
  const filteredLines = useMemo(() => {
    let lines = sessionLines;
    if (statusFilter !== 'all') lines = lines.filter((l: any) => l.receiving_status === statusFilter);
    if (discrepancyOnly) lines = lines.filter((l: any) => l.billing_discrepancy);
    return lines;
  }, [sessionLines, statusFilter, discrepancyOnly]);

  // ── Filtered History ──
  const filteredSessions = useMemo(() => {
    let s = sessions;
    if (historyVendor !== 'all') s = s.filter(x => x.vendor === historyVendor);
    if (historyStatus !== 'all') s = s.filter(x => x.reconciliation_status === historyStatus);
    return s;
  }, [sessions, historyVendor, historyStatus]);

  // ── Recon Summary ──
  const reconSummary = useMemo(() => {
    if (!selectedSession || !sessionLines.length) return null;
    const invoiceTotal = (selectedSession as any).reconciled_invoice_id
      ? vendorInvoices.find(v => v.id === (selectedSession as any).reconciled_invoice_id)?.total ?? 0
      : 0;
    const receivedCost = sessionLines.reduce((s: number, l: any) => s + Number(l.received_cost || 0), 0);
    const notReceivedCost = sessionLines.reduce((s: number, l: any) => s + (Number(l.ordered_cost || 0) - Number(l.received_cost || 0)), 0);
    const overbilled = sessionLines.filter((l: any) => l.discrepancy_type === 'OVERBILLED');
    const qtyMismatch = sessionLines.filter((l: any) => l.discrepancy_type === 'QTY_MISMATCH');
    const priceMismatch = sessionLines.filter((l: any) => l.discrepancy_type === 'PRICE_MISMATCH');
    const notOnInvoice = sessionLines.filter((l: any) => l.discrepancy_type === 'NOT_ON_INVOICE');
    const cleanMatches = sessionLines.filter((l: any) => l.match_status && !l.billing_discrepancy);
    return { invoiceTotal, receivedCost, notReceivedCost, variance: Number(invoiceTotal) - receivedCost, overbilled, qtyMismatch, priceMismatch, notOnInvoice, cleanMatches };
  }, [selectedSession, sessionLines, vendorInvoices]);

  const exportCSV = () => {
    const csv = exportReconciliationCSV(sessionLines);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconciliation-${selectedSession?.session_name || 'export'}.csv`;
    a.click();
  };

  const reconStatusColor = (s: string) => {
    switch (s) {
      case 'reconciled': return 'bg-emerald-600 text-white';
      case 'discrepancy': return 'bg-amber-500 text-white';
      case 'reviewed': return 'bg-blue-600 text-white';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <InvoiceNav />
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold">PO Receiving & Reconciliation</h1>
          <p className="text-sm text-muted-foreground">Import Lightspeed PO exports to track receiving vs billing</p>
        </div>

        {/* ── Tabs ── */}
        <div className="flex gap-2">
          <Button size="sm" variant={activeTab === 'receiving' ? 'default' : 'outline'} className="text-xs h-8" onClick={() => setActiveTab('receiving')}>
            <Package className="h-3.5 w-3.5 mr-1" />Receiving
          </Button>
          <Button size="sm" variant={activeTab === 'final-bill' ? 'default' : 'outline'} className="text-xs h-8" onClick={() => setActiveTab('final-bill')}>
            <DollarSign className="h-3.5 w-3.5 mr-1" />Final Bill Ledger
            {finalBillEntries.filter(e => e.total_credit_due > 0 && !e.credit_approved).length > 0 && (
              <span className="ml-1 px-1 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-600">
                {finalBillEntries.filter(e => e.total_credit_due > 0 && !e.credit_approved).length}
              </span>
            )}
          </Button>
        </div>

        {activeTab === 'receiving' ? (<>


        {/* ── Import Section ── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Import Lightspeed Export</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              placeholder="Session name (e.g. Luxottica March Batch)"
              value={sessionName}
              onChange={e => setSessionName(e.target.value)}
              className="max-w-md"
            />
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
                dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
              }`}
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.csv';
                input.onchange = (e: any) => { const f = e.target.files?.[0]; if (f) handleFile(f); };
                input.click();
              }}
            >
              <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">Drop Lightspeed PO export CSV here or click to browse</p>
            </div>

            {/* Preview */}
            {preview && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  {preview.format === 'ITEMS_C_NO_RECEIVING' ? (
                    <Badge variant="secondary" className="gap-1 text-amber-600"><AlertTriangle className="h-3 w-3" />Format: {formatLabel(preview.format)}</Badge>
                  ) : (
                    <Badge className="bg-emerald-600 text-white gap-1"><CheckCircle2 className="h-3 w-3" />Format: {formatLabel(preview.format)}</Badge>
                  )}
                  <Badge variant="outline">{preview.vendor}</Badge>
                  {preview.eolResolution && (
                    <>
                      <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30" variant="outline">EOL</Badge>
                      <Badge variant="outline">{preview.eolResolution.realVendor}</Badge>
                      {preview.eolResolution.isMultiVendor && (
                        <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30" variant="outline">
                          ⚠ Multi-vendor: {preview.eolResolution.realVendors.join(', ')}
                        </Badge>
                      )}
                    </>
                  )}
                  <Badge variant="outline">{preview.lines.length} rows</Badge>
                  <span className="text-xs text-muted-foreground">{preview.filename}</span>
                </div>
                {preview.format === 'ITEMS_C_NO_RECEIVING' && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 text-sm text-amber-700 dark:text-amber-400">
                    ⚠ This export has no receiving data — it shows what was ordered but not what arrived. Use a Check-In export for receiving reconciliation.
                  </div>
                )}
                {/* Preview table: first 5 rows */}
                <div className="overflow-auto max-h-48 border rounded-md">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">UPC</TableHead>
                        <TableHead className="text-xs">SKU</TableHead>
                        <TableHead className="text-xs">Description</TableHead>
                        <TableHead className="text-xs text-right">Ordered</TableHead>
                        <TableHead className="text-xs text-right">Received</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.lines.slice(0, 5).map((l, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs font-mono">{l.upc || '—'}</TableCell>
                          <TableCell className="text-xs font-mono">{l.manufact_sku || '—'}</TableCell>
                          <TableCell className="text-xs max-w-[200px] truncate">{l.item_description}</TableCell>
                          <TableCell className="text-xs text-right">{l.order_qty}</TableCell>
                          <TableCell className="text-xs text-right">{l.received_qty ?? '—'}</TableCell>
                          <TableCell><ReceivingStatusBadge status={l.receiving_status} ordered={l.order_qty} received={l.received_qty} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {/* Dedup Check + Import Buttons */}
                {!dedupResult && (
                  <Button onClick={runDedupCheck} disabled={checkingDedup}>
                    {checkingDedup ? 'Checking for duplicates…' : `Check & Import ${preview.lines.length} rows`}
                  </Button>
                )}

                {dedupResult?.type === 'exact_duplicate' && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                        Exact duplicate — this CSV was already imported as "{dedupResult.sessionName}"
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground">All lines match the existing session. No import needed.</p>
                    <Button size="sm" variant="outline" onClick={() => { setPreview(null); setDedupResult(null); }}>
                      Dismiss
                    </Button>
                  </div>
                )}

                {dedupResult?.type === 'update_available' && (
                  <div className="bg-blue-500/10 border border-blue-500/30 rounded-md p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Package className="h-4 w-4 text-blue-600" />
                      <p className="text-sm font-medium text-blue-700 dark:text-blue-400">
                        Updated CSV detected — merging into "{dedupResult.sessionName}"
                      </p>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="bg-background rounded p-2">
                        <p className="text-lg font-bold text-blue-600">{dedupResult.changedLines}</p>
                        <p className="text-[10px] text-muted-foreground">Lines Changed</p>
                      </div>
                      <div className="bg-background rounded p-2">
                        <p className="text-lg font-bold text-emerald-600">{dedupResult.newLines}</p>
                        <p className="text-[10px] text-muted-foreground">New Lines</p>
                      </div>
                      <div className="bg-background rounded p-2">
                        <p className="text-lg font-bold text-muted-foreground">{dedupResult.unchangedLines}</p>
                        <p className="text-[10px] text-muted-foreground">Unchanged (kept)</p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">Only changed and new lines will be updated. Previously received items stay untouched.</p>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={doMergeUpdate} disabled={importing}>
                        {importing ? 'Merging…' : 'Merge Updates'}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { setPreview(null); setDedupResult(null); }}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {dedupResult?.type === 'new' && (
                  <div className="flex items-center gap-3">
                    <Badge className="bg-emerald-600 text-white gap-1"><CheckCircle2 className="h-3 w-3" />No duplicates found</Badge>
                    <Button onClick={doImport} disabled={importing}>
                      {importing ? 'Importing…' : `Import ${preview.lines.length} rows`}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Selected Session Detail ── */}
        {selectedSession && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{selectedSession.session_name}</CardTitle>
                  <CardDescription className="text-xs flex items-center gap-1">
                    {selectedSession.raw_filename} · {selectedSession.vendor}
                    {VENDOR_TOOLTIPS[selectedSession.vendor] && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3 w-3 text-amber-500 cursor-help inline" />
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-xs">{VENDOR_TOOLTIPS[selectedSession.vendor]}</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {' '}· {new Date(selectedSession.created_at).toLocaleDateString()}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={reconStatusColor(selectedSession.reconciliation_status)}>
                    {selectedSession.reconciliation_status}
                  </Badge>
                  {selectedSession.reconciliation_status === 'unreconciled' && (
                    <Button size="sm" variant="outline" onClick={() => setReconciling(selectedSessionId)} className="gap-1">
                      <ArrowRight className="h-3 w-3" />Reconcile
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={exportCSV} className="gap-1">
                    <Download className="h-3 w-3" />CSV
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-muted/50 rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground">Ordered</p>
                  <p className="text-lg font-bold">{selectedSession.total_ordered_qty}</p>
                  <p className="text-xs text-muted-foreground">{formatCurrency(Number(selectedSession.total_ordered_cost))}</p>
                </div>
                <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground">Received</p>
                  <p className="text-lg font-bold text-emerald-600">{selectedSession.total_received_qty}</p>
                  <p className="text-xs text-emerald-600">{formatCurrency(Number(selectedSession.total_received_cost))}</p>
                </div>
                <div className="bg-blue-500/10 rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground">Partial</p>
                  <p className="text-lg font-bold text-blue-600">{selectedSession.partially_received}</p>
                  <p className="text-xs text-muted-foreground">{selectedSession.partially_received} lines</p>
                </div>
                <div className="bg-red-500/10 rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground">Not Received</p>
                  <p className="text-lg font-bold text-red-600">{selectedSession.not_received}</p>
                  <p className="text-xs text-muted-foreground">{selectedSession.not_received} lines</p>
                </div>
              </div>

              {/* Reconciliation Summary */}
              {reconSummary && selectedSession.reconciliation_status !== 'unreconciled' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="border rounded-lg p-3 text-center">
                      <p className="text-xs text-muted-foreground">Invoice Total</p>
                      <p className="text-sm font-bold">{formatCurrency(reconSummary.invoiceTotal)}</p>
                    </div>
                    <div className="border rounded-lg p-3 text-center">
                      <p className="text-xs text-muted-foreground">Received $</p>
                      <p className="text-sm font-bold text-emerald-600">{formatCurrency(reconSummary.receivedCost)}</p>
                    </div>
                    <div className="border rounded-lg p-3 text-center">
                      <p className="text-xs text-muted-foreground">Not Received $</p>
                      <p className="text-sm font-bold text-red-600">{formatCurrency(reconSummary.notReceivedCost)}</p>
                    </div>
                    <div className="border rounded-lg p-3 text-center">
                      <p className="text-xs text-muted-foreground">Variance</p>
                      <p className={`text-sm font-bold ${reconSummary.variance > 0.5 ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {formatCurrency(reconSummary.variance)}
                      </p>
                    </div>
                  </div>

                  {/* Discrepancy panels */}
                  {reconSummary.overbilled.length > 0 && (
                    <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                      <p className="text-sm font-semibold text-red-600 mb-1">🔴 OVERBILLED — charged for items not received ({reconSummary.overbilled.length})</p>
                      <p className="text-xs text-muted-foreground">Total: {formatCurrency(reconSummary.overbilled.reduce((s: number, l: any) => s + Number(l.discrepancy_amount || 0), 0))}</p>
                    </div>
                  )}
                  {reconSummary.priceMismatch.length > 0 && (
                    <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-3">
                      <p className="text-sm font-semibold text-orange-600 mb-1">🟠 PRICE MISMATCH ({reconSummary.priceMismatch.length})</p>
                    </div>
                  )}
                  {reconSummary.notOnInvoice.length > 0 && (
                    <div className="bg-muted border rounded-lg p-3">
                      <p className="text-sm font-semibold text-muted-foreground mb-1">⚪ NOT ON INVOICE ({reconSummary.notOnInvoice.length})</p>
                    </div>
                  )}
                  {reconSummary.cleanMatches.length > 0 && (
                    <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                      <p className="text-sm font-semibold text-emerald-600">✅ CLEAN MATCHES — {reconSummary.cleanMatches.length} of {sessionLines.length} lines</p>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={exportCSV} className="gap-1"><Download className="h-3 w-3" />Export Reconciliation CSV</Button>
                    {selectedSession.reconciliation_status !== 'reviewed' && (
                      <Button size="sm" variant="outline" onClick={async () => {
                        await updateSessionReconciliation(selectedSessionId!, (selectedSession as any).reconciled_invoice_id, 'reviewed');
                        toast.success('Marked as reviewed');
                        qc.invalidateQueries({ queryKey: ['receiving-sessions'] });
                      }}>Mark as Reviewed</Button>
                    )}
                  </div>
                </div>
              )}

              {/* Reconcile Modal */}
              {reconciling === selectedSessionId && (
                <div className="border rounded-lg p-4 bg-muted/30 space-y-3">
                  <p className="text-sm font-medium">Select the invoice this PO receiving belongs to:</p>
                  {isEOLSession && eolSessionResolution ? (
                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2 text-xs text-amber-700 dark:text-amber-400 space-y-1">
                      <div className="flex items-center gap-1.5">
                        <Info className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          <strong>EOL Session</strong> — End-of-Line discount frames. Real vendor{eolSessionResolution.isMultiVendor ? 's' : ''}:{' '}
                          <strong>{eolSessionResolution.realVendors.join(', ')}</strong>
                        </span>
                      </div>
                      {eolSessionResolution.isMultiVendor && (
                        <p className="text-[11px]">⚠ Multi-vendor EOL session — contains frames from {eolSessionResolution.realVendors.map(v =>
                          `${v} (${eolSessionResolution.vendorCounts[v]} items)`
                        ).join(', ')}. You may need to reconcile against multiple invoices.</p>
                      )}
                      <p className="text-[11px]">Price differences between EOL cost and invoice price are expected and will not be flagged.</p>
                    </div>
                  ) : (() => {
                    const allowed = allowedVendors;
                    const vendorName = selectedSession.vendor;
                    return allowed && allowed.join(', ') !== vendorName ? (
                      <div className="bg-blue-500/10 border border-blue-500/20 rounded-md px-3 py-2 text-xs text-blue-700 dark:text-blue-400 flex items-center gap-1.5">
                        <Info className="h-3.5 w-3.5 shrink-0" />
                        Showing invoices from: <strong>{allowed.join(', ')}</strong> (mapped from {vendorName})
                      </div>
                    ) : null;
                  })()}

                  {/* ── Auto-Suggestions ── */}
                  {invoiceSuggestions.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        🔍 Suggested matches based on UPC overlap:
                      </p>
                      {invoiceSuggestions.map((s, i) => {
                        const badge = matchStrengthBadge(s.matchPercent, s.poMatch);
                        const isBest = i === 0;
                        return (
                          <button
                            key={s.invoice.id}
                            onClick={() => setSelectedInvoiceId(s.invoice.id)}
                            className={`w-full text-left rounded-md border p-3 transition-colors ${
                              selectedInvoiceId === s.invoice.id
                                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                : isBest
                                ? 'border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/10'
                                : 'border-border hover:bg-accent/50'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                {isBest && <span className="text-xs">⭐</span>}
                                <Badge className={`text-[10px] ${badge.className}`}>{badge.label}</Badge>
                                <span className="text-xs font-semibold">
                                  {s.matchPercent > 0 ? `${s.matchPercent}% UPC overlap` : `Score: ${s.score}`}
                                </span>
                              </div>
                              <span className="text-xs font-semibold tabular-nums">{formatCurrency(s.invoice.total)}</span>
                            </div>
                            <div className="flex items-center gap-1 text-xs">
                              <span className="text-muted-foreground">{s.invoice.vendor}</span>
                              <span className="text-muted-foreground">·</span>
                              <span className="font-mono font-medium">Invoice {s.invoice.invoice_number}</span>
                            </div>
                            <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                              {s.invoice.po_number && <span>PO: {s.invoice.po_number}</span>}
                              <span>{s.invoice.invoice_date}</span>
                              {s.upcMatches > 0 && <span>· {s.upcMatches} UPCs matched</span>}
                              {s.skuMatches > 0 && <span>· {s.skuMatches} SKUs matched</span>}
                            </div>
                            {selectedInvoiceId !== s.invoice.id && (
                              <p className="text-[10px] text-primary mt-1">Select This Invoice</p>
                            )}
                          </button>
                        );
                      })}
                      <p className="text-[10px] text-muted-foreground">Or search manually below ↓</p>
                    </div>
                  ) : vendorFilteredInvoices.length > 0 ? (
                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>No invoice UPC matches found for this CSV. This may be a PO not yet invoiced, or the invoice hasn't been uploaded yet. Search manually or upload the invoice PDF first.</span>
                    </div>
                  ) : null}

                  <Input
                    placeholder="Search by invoice #, PO #, or vendor…"
                    value={invoiceSearch}
                    onChange={e => setInvoiceSearch(e.target.value)}
                    className="max-w-md"
                  />
                  <div className="max-h-48 overflow-auto border rounded-md bg-background">
                    {filteredInvoices.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-4">
                        {vendorInvoices.length === 0 ? 'No invoices found in system' : 'No invoices match your search'}
                      </p>
                    ) : (
                      filteredInvoices.map(inv => (
                        <button
                          key={inv.id}
                          className={`w-full text-left px-3 py-2 text-xs border-b last:border-b-0 transition-colors hover:bg-accent/50 ${
                            selectedInvoiceId === inv.id ? 'bg-accent' : ''
                          }`}
                          onClick={() => setSelectedInvoiceId(inv.id)}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono font-medium">{inv.invoice_number}</span>
                            <span className="font-semibold tabular-nums">{formatCurrency(inv.total)}</span>
                          </div>
                          <div className="flex items-center gap-2 text-muted-foreground mt-0.5">
                            <span>{inv.vendor}</span>
                            {inv.po_number && <span>· PO {inv.po_number}</span>}
                            <span>· {inv.invoice_date}</span>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                  {selectedInvoiceId && (
                    <p className="text-xs text-muted-foreground">
                      Selected: <span className="font-mono font-medium text-foreground">{vendorInvoices.find(v => v.id === selectedInvoiceId)?.invoice_number}</span>
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" onClick={runReconciliation} disabled={!selectedInvoiceId}>Run Reconciliation</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setReconciling(null); setInvoiceSearch(''); }}>Cancel</Button>
                  </div>
                </div>
              )}

              {/* Filters */}
              <div className="flex flex-wrap items-center gap-2">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[180px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="FULLY_RECEIVED">Fully Received</SelectItem>
                    <SelectItem value="PARTIALLY_RECEIVED">Partial</SelectItem>
                    <SelectItem value="NOT_RECEIVED">Not Received</SelectItem>
                    <SelectItem value="NO_RECEIVING_DATA">No Data</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm" variant={discrepancyOnly ? 'default' : 'outline'}
                  onClick={() => setDiscrepancyOnly(!discrepancyOnly)}
                  className="h-8 text-xs gap-1"
                >
                  <AlertTriangle className="h-3 w-3" />Discrepancies Only
                </Button>
                <span className="text-xs text-muted-foreground ml-auto">{filteredLines.length} lines</span>
              </div>

              {/* Line Items Table */}
              <div className="overflow-auto border rounded-md">
                {/* Desktop table */}
                <Table className="hidden md:table">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs w-8">#</TableHead>
                      <TableHead className="text-xs">UPC</TableHead>
                      <TableHead className="text-xs">MFR SKU</TableHead>
                      <TableHead className="text-xs">Description</TableHead>
                      <TableHead className="text-xs text-right">Ordered</TableHead>
                      <TableHead className="text-xs text-right">Received</TableHead>
                      <TableHead className="text-xs text-right">Not Recv'd</TableHead>
                      <TableHead className="text-xs text-right">Unit Cost</TableHead>
                      <TableHead className="text-xs text-right">Ordered $</TableHead>
                      <TableHead className="text-xs text-right">Received $</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                      <TableHead className="text-xs">Match</TableHead>
                      <TableHead className="text-xs">Discrepancy</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredLines.map((l: any, i: number) => (
                      <TableRow key={l.id} className={l.billing_discrepancy ? 'bg-amber-500/5' : ''}>
                        <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                        <TableCell className="text-xs font-mono">{l.upc || '—'}</TableCell>
                        <TableCell className="text-xs font-mono">{l.manufact_sku || '—'}</TableCell>
                        <TableCell className="text-xs max-w-[180px] truncate">{l.item_description}</TableCell>
                        <TableCell className="text-xs text-right">{l.order_qty}</TableCell>
                        <TableCell className="text-xs text-right">{l.received_qty ?? '—'}</TableCell>
                        <TableCell className="text-xs text-right">{l.not_received_qty}</TableCell>
                        <TableCell className="text-xs text-right">{formatCurrency(Number(l.unit_cost))}</TableCell>
                        <TableCell className="text-xs text-right">{formatCurrency(Number(l.ordered_cost))}</TableCell>
                        <TableCell className="text-xs text-right">{formatCurrency(Number(l.received_cost))}</TableCell>
                        <TableCell><ReceivingStatusBadge status={l.receiving_status} ordered={l.order_qty} received={l.received_qty} /></TableCell>
                        <TableCell><MatchBadge status={l.match_status} /></TableCell>
                        <TableCell>
                          {l.billing_discrepancy && <DiscrepancyBadge type={l.discrepancy_type} />}
                          {l.discrepancy_amount > 0 && <span className="text-xs ml-1">{formatCurrency(Number(l.discrepancy_amount))}</span>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {/* Mobile cards */}
                <div className="md:hidden divide-y">
                  {filteredLines.map((l: any, i: number) => (
                    <div key={l.id} className={`p-3 space-y-1 ${l.billing_discrepancy ? 'bg-amber-500/5' : ''}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono">{l.upc || l.manufact_sku || '—'}</span>
                        <ReceivingStatusBadge status={l.receiving_status} ordered={l.order_qty} received={l.received_qty} />
                      </div>
                      <p className="text-xs truncate">{l.item_description}</p>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>Ord: {l.order_qty}</span>
                        <span>Recv: {l.received_qty ?? '—'}</span>
                        <span>{formatCurrency(Number(l.unit_cost))}/ea</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <MatchBadge status={l.match_status} />
                        {l.billing_discrepancy && <DiscrepancyBadge type={l.discrepancy_type} />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {linesLoading && <p className="text-sm text-muted-foreground text-center py-4">Loading lines…</p>}
            </CardContent>
          </Card>
        )}

        {/* ── Receiving History ── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <CardTitle className="text-base">Receiving History</CardTitle>
              <div className="flex items-center gap-2">
                <Select value={historyVendor} onValueChange={setHistoryVendor}>
                  <SelectTrigger className="w-[140px] h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Vendors</SelectItem>
                    <SelectItem value="Luxottica">Luxottica</SelectItem>
                    <SelectItem value="Kering">Kering</SelectItem>
                    <SelectItem value="Maui Jim">Maui Jim</SelectItem>
                    <SelectItem value="Safilo">Safilo</SelectItem>
                    <SelectItem value="Marcolin">Marcolin</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={historyStatus} onValueChange={setHistoryStatus}>
                  <SelectTrigger className="w-[150px] h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="unreconciled">Unreconciled</SelectItem>
                    <SelectItem value="reconciled">Reconciled</SelectItem>
                    <SelectItem value="discrepancy">Discrepancy</SelectItem>
                    <SelectItem value="reviewed">Reviewed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {sessionsLoading ? (
              <p className="text-sm text-muted-foreground text-center py-4">Loading…</p>
            ) : filteredSessions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No receiving sessions yet</p>
            ) : (
              <>
                {/* Desktop table */}
                <Table className="hidden md:table">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Session</TableHead>
                      <TableHead className="text-xs">Vendor</TableHead>
                      <TableHead className="text-xs">Date</TableHead>
                      <TableHead className="text-xs text-right">Lines</TableHead>
                      <TableHead className="text-xs text-right">Recv'd %</TableHead>
                      <TableHead className="text-xs text-right">Value</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                      <TableHead className="text-xs w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSessions.map(s => {
                      const pct = s.total_ordered_qty ? Math.round((Number(s.total_received_qty) / Number(s.total_ordered_qty)) * 100) : 0;
                      return (
                        <TableRow key={s.id} className={selectedSessionId === s.id ? 'bg-accent' : 'cursor-pointer hover:bg-muted/50'} onClick={() => setSelectedSessionId(s.id)}>
                          <TableCell className="text-xs font-medium">{s.session_name}</TableCell>
                          <TableCell className="text-xs flex items-center gap-1">
                            {s.vendor}
                            {VENDOR_TOOLTIPS[s.vendor] && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Info className="h-3 w-3 text-amber-500 cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-xs text-xs">{VENDOR_TOOLTIPS[s.vendor]}</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">{new Date(s.created_at).toLocaleDateString()}</TableCell>
                          <TableCell className="text-xs text-right">{s.total_lines}</TableCell>
                          <TableCell className="text-xs text-right">{pct}%</TableCell>
                          <TableCell className="text-xs text-right">{formatCurrency(Number(s.total_ordered_cost))}</TableCell>
                          <TableCell><Badge className={`text-xs ${reconStatusColor(s.reconciliation_status)}`}>{s.reconciliation_status}</Badge></TableCell>
                          <TableCell><Eye className="h-3.5 w-3.5 text-muted-foreground" /></TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>

                {/* Mobile cards */}
                <div className="md:hidden divide-y">
                  {filteredSessions.map(s => {
                    const pct = s.total_ordered_qty ? Math.round((Number(s.total_received_qty) / Number(s.total_ordered_qty)) * 100) : 0;
                    return (
                      <div key={s.id} className={`p-3 space-y-1 cursor-pointer ${selectedSessionId === s.id ? 'bg-accent' : ''}`} onClick={() => setSelectedSessionId(s.id)}>
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">{s.session_name}</span>
                          <Badge className={`text-xs ${reconStatusColor(s.reconciliation_status)}`}>{s.reconciliation_status}</Badge>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span>{s.vendor}</span>
                          <span>{s.total_lines} lines</span>
                          <span>{pct}% received</span>
                          <span>{formatCurrency(Number(s.total_ordered_cost))}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
