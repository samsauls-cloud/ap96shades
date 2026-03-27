import React, { useState, useCallback, useMemo } from "react";
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
  Send, CheckCheck, FileDown, DollarSign, Split, Layers
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  detectFormat, formatLabel, parseCSV, parseLines, computeSessionStats,
  vendorFromLightspeed, createSession, insertReceivingLines, fetchSessions,
  fetchSessionLines, matchReceivingToInvoice, calcDiscrepancy,
  updateSessionReconciliation, updateLineReconciliation, exportReconciliationCSV,
  checkReceivingDuplicate, mergeReceivingUpdate, resolveEOLVendor,
  multiInvoiceMatch, detectPOGroups, splitSessionByPO,
  checkReceivingLineDuplicates, checkInvoiceLineCoverage,
  type ExportFormat, type ParsedLine, type ReceivingStatus, type ReceivingDedupAction, type EOLResolution,
  type MultiInvoiceGroup, type MultiInvoiceMatchResult, type POGroup, type InvoiceCoverageResult
} from "@/lib/receiving-engine";
import { getLineItems, formatCurrency } from "@/lib/supabase-queries";
import { suggestMatchingInvoices, matchStrengthBadge, type InvoiceSuggestion } from "@/lib/invoice-suggestions";
import { computeReconciliationTotals, verifyReconciliationMath, checkVariance, type MathCheck, type ReconciliationTotals } from "@/lib/reconciliation-math";
import {
  upsertFinalBillEntry, updateInvoiceReconciliation, applyCreditToPayments,
  fetchFinalBillLedger, markCreditRequestSent, confirmCreditReceived,
  generateCreditRequestCSV, type FinalBillLedgerEntry
} from "@/lib/final-bill-queries";

// ── Receiving-to-Invoice Vendor Mapping ──
const RECEIVING_TO_INVOICE_VENDOR: Record<string, string[]> = {
  'EOL':       ['Luxottica', 'Kering', 'Maui Jim', 'Safilo', 'Marcolin'],
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

type ReconMode = 'SINGLE' | 'MULTI';

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
    INVOICE_NOT_UPLOADED: 'bg-gray-500 text-white',
  };
  return <Badge className={`text-xs ${colors[status] ?? ''}`}>{status.replace(/_/g, ' ')}</Badge>;
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

function FinalBillStatusBadge({ status, creditDue, creditApproved }: { status: string; creditDue: number; creditApproved: boolean }) {
  if (creditDue === 0) return <Badge className="bg-emerald-600 text-white text-[10px]">Clean ✓</Badge>;
  if (creditApproved) return <Badge className="bg-blue-600 text-white text-[10px]">Credit Approved</Badge>;
  if (status === 'credit_requested') return <Badge className="bg-amber-500 text-white text-[10px]">📤 Credit Requested</Badge>;
  if (status === 'paid') return <Badge className="bg-muted text-muted-foreground text-[10px]">💰 Paid</Badge>;
  return <Badge className="bg-amber-500/80 text-white text-[10px]">⚠ Credit Pending</Badge>;
}

function MathVerificationBlock({ checks, varianceOverride }: { checks: MathCheck[]; varianceOverride?: { skipped: boolean; reason?: string } }) {
  const allPassed = checks.every(c => c.pass);
  return (
    <div className={`border rounded-lg p-3 space-y-2 ${allPassed ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
      <div className="flex items-center gap-2">
        <ShieldCheck className={`h-4 w-4 ${allPassed ? 'text-emerald-600' : 'text-red-600'}`} />
        <p className={`text-sm font-semibold ${allPassed ? 'text-emerald-600' : 'text-red-600'}`}>
          {allPassed ? '✓ All math checks passed' : '✗ Math discrepancies detected'}
        </p>
      </div>
      <div className="space-y-1">
        {checks.map((c, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className={c.pass ? 'text-emerald-600' : 'text-red-600'}>{c.pass ? '✓' : '✗'}</span>
            <span className="text-muted-foreground">{c.name}</span>
            {!c.pass && (
              <span className="text-red-600 font-mono">— expected {formatCurrency(c.expected)}, got {formatCurrency(c.actual)}</span>
            )}
          </div>
        ))}
        {varianceOverride?.skipped && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-blue-600">⊘</span>
            <span className="text-blue-600">{varianceOverride.reason}</span>
          </div>
        )}
      </div>
    </div>
  );
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
  const [varianceOverride, setVarianceOverride] = useState<{ skipped: boolean; reason?: string } | null>(null);
  const [invoiceCoverage, setInvoiceCoverage] = useState<InvoiceCoverageResult | null>(null);
  const [activeTab, setActiveTab] = useState<'receiving' | 'final-bill'>('receiving');
  const [creditConfirmOpen, setCreditConfirmOpen] = useState<string | null>(null);
  const [creditAmount, setCreditAmount] = useState('');
  const [creditApprover, setCreditApprover] = useState('');

  // Multi-invoice reconciliation state
  const [reconMode, setReconMode] = useState<ReconMode>('SINGLE');
  const [multiMatchResult, setMultiMatchResult] = useState<MultiInvoiceMatchResult | null>(null);
  const [multiReconRunning, setMultiReconRunning] = useState(false);

  // PO split state
  const [poGroups, setPOGroups] = useState<POGroup[] | null>(null);
  const [splitting, setSplitting] = useState(false);

  // Reconcile All state
  const [reconAllRunning, setReconAllRunning] = useState(false);
  const [reconAllProgress, setReconAllProgress] = useState<{ done: number; total: number; current: string } | null>(null);

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

  // ── Invoice filtering ──
  const reconSession = reconciling ? sessions.find(s => s.id === reconciling) : null;
  const isEOLSession = reconSession?.vendor === 'EOL';
  const eolSessionResolution = useMemo(() => {
    if (!isEOLSession || sessionLines.length === 0) return null;
    return resolveEOLVendor(sessionLines as any[]);
  }, [isEOLSession, sessionLines]);

  const allowedVendors = useMemo(() => {
    if (!reconSession) return null;
    if (isEOLSession && eolSessionResolution) {
      return eolSessionResolution.realVendors.length > 0 ? eolSessionResolution.realVendors : ['Luxottica'];
    }
    return RECEIVING_TO_INVOICE_VENDOR[reconSession.vendor] ?? null;
  }, [reconSession, isEOLSession, eolSessionResolution]);

  const vendorFilteredInvoices = useMemo(() => {
    return allowedVendors
      ? vendorInvoices.filter(inv => allowedVendors.some(v => inv.vendor?.toLowerCase() === v.toLowerCase()))
      : vendorInvoices;
  }, [vendorInvoices, allowedVendors]);

  // ── Should offer multi-invoice mode? ──
  const shouldOfferMultiMode = useMemo(() => {
    if (!reconSession) return false;
    if (isEOLSession) return true;
    // If session total > 1.5x any single invoice
    if (vendorFilteredInvoices.length > 0) {
      const maxInv = Math.max(...vendorFilteredInvoices.map(i => i.total));
      return Number(reconSession.total_ordered_cost || 0) > maxInv * 1.5;
    }
    return false;
  }, [reconSession, isEOLSession, vendorFilteredInvoices]);

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
      const firstVendorId = lines.find(l => l.vendor_id)?.vendor_id ?? '';
      const firstDesc = lines[0]?.item_description ?? '';
      const vendor = vendorFromLightspeed(firstVendorId, firstDesc);

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
      setDedupResult({ type: 'new' });
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
      toast.success(`Merged: ${updatedCount} lines updated, ${insertedCount} new lines added.`);
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

  // ── Single Invoice Reconciliation ──
  const runReconciliation = async () => {
    if (!selectedSessionId || !selectedInvoiceId) return;
    try {
      const invoice = vendorInvoices.find(v => v.id === selectedInvoiceId);
      if (!invoice) return;
      const invoiceLines = getLineItems(invoice);

      // Pre-reconciliation: check for duplicate UPCs in receiving lines
      const dupCheck = checkReceivingLineDuplicates(sessionLines);
      if (dupCheck.hasDuplicates) {
        console.warn(`⚠ Receiving lines contain ${dupCheck.duplicateUPCs.length} duplicate UPC(s) — matching will consume invoice lines in order`);
      }

      const results = matchReceivingToInvoice(sessionLines, invoiceLines);

      // Post-match: check invoice line coverage
      const coverage = checkInvoiceLineCoverage(results, invoiceLines);
      setInvoiceCoverage(coverage);

      const skipPriceCheck = selectedSession?.vendor === 'EOL';
      let hasDiscrepancy = false;
      for (const r of results) {
        const disc = calcDiscrepancy(r.line, r.matched_invoice_line, skipPriceCheck);
        const matchStatusVal = r.match_status === 'NO_MATCH' && isEOLSession
          ? 'INVOICE_NOT_UPLOADED' : r.match_status;
        const update: any = {
          matched_invoice_line: r.matched_invoice_line as any,
          match_status: matchStatusVal,
          billing_discrepancy: !!disc && matchStatusVal !== 'INVOICE_NOT_UPLOADED',
          discrepancy_type: matchStatusVal === 'INVOICE_NOT_UPLOADED' ? null : (disc?.type ?? null),
          discrepancy_amount: matchStatusVal === 'INVOICE_NOT_UPLOADED' ? 0 : (disc?.amount ?? 0),
        };
        if (disc && matchStatusVal !== 'INVOICE_NOT_UPLOADED') hasDiscrepancy = true;
        await updateLineReconciliation(r.line.id, update);
      }

      const status = hasDiscrepancy ? 'discrepancy' : 'reconciled';
      await updateSessionReconciliation(selectedSessionId, selectedInvoiceId, status);

      // Refresh lines
      const { data: updatedLines } = await supabase
        .from('po_receiving_lines')
        .select('*')
        .eq('session_id', selectedSessionId);
      const freshLines = updatedLines ?? sessionLines;

      // Only compute totals on matched lines (exclude INVOICE_NOT_UPLOADED)
      const matchedLines = freshLines.filter((l: any) => l.match_status !== 'INVOICE_NOT_UPLOADED');
      const totals = computeReconciliationTotals(matchedLines, invoice.total);
      setReconTotals(totals);

      // Math verification with EOL variance override
      const checks = verifyReconciliationMath(
        matchedLines,
        matchedLines.reduce((s: number, l: any) => s + Number(l.ordered_cost || 0), 0),
        matchedLines.reduce((s: number, l: any) => s + Number(l.order_qty || 0), 0),
        invoice.total,
        totals
      );

      // Override variance check for EOL single mode
      const vCheck = checkVariance(
        Number(selectedSession?.total_ordered_cost || 0),
        invoice.total,
        isEOLSession,
        'SINGLE'
      );
      if (vCheck.skipped) {
        const varIdx = checks.findIndex(c => c.name === 'Variance within tolerance');
        if (varIdx >= 0) checks[varIdx] = { ...checks[varIdx], pass: true };
        setVarianceOverride({ skipped: true, reason: vCheck.reason });
      } else {
        setVarianceOverride(null);
      }
      setMathChecks(checks);

      // Update vendor_invoices
      const reconStatus = totals.totalCreditDue > 0 ? 'credit_pending' : 'reconciled';
      await updateInvoiceReconciliation(selectedInvoiceId, selectedSessionId, totals.totalCreditDue, totals.finalBillAmount, reconStatus);

      // Create final bill ledger entry
      await upsertFinalBillEntry(
        selectedInvoiceId, selectedSessionId, invoice,
        {
          total_ordered_qty: matchedLines.reduce((s: number, l: any) => s + Number(l.order_qty || 0), 0),
          total_received_qty: matchedLines.reduce((s: number, l: any) => s + Number(l.received_qty ?? 0), 0),
        },
        totals
      );

      // Apply credits
      if (totals.totalCreditDue > 0) {
        await applyCreditToPayments(selectedInvoiceId, totals.totalCreditDue);
      }

      const unmatchedCount = freshLines.filter((l: any) => l.match_status === 'INVOICE_NOT_UPLOADED').length;
      const allPassed = checks.every(c => c.pass);
      let msg = allPassed ? 'Reconciliation complete — all math checks passed ✓' : 'Reconciliation complete — ⚠ math discrepancies detected';
      if (unmatchedCount > 0) msg += ` · ${unmatchedCount} receiving lines unmatched`;
      if (coverage.unmatchedInvoiceLines.length > 0) {
        msg += ` · ⚠ ${coverage.unmatchedInvoiceLines.length} invoice line(s) not found in receiving data`;
      }
      if (coverage.coveragePct === 100 && allPassed) {
        msg += ' · 📋 100% invoice coverage';
      }
      toast.success(msg);

      setReconciling(null);
      setReconMode('SINGLE');
      setMultiMatchResult(null);
      qc.invalidateQueries({ queryKey: ['receiving-lines', selectedSessionId] });
      qc.invalidateQueries({ queryKey: ['receiving-sessions'] });
      qc.invalidateQueries({ queryKey: ['final-bill-ledger'] });
      qc.invalidateQueries({ queryKey: ['vendor-invoices-for-recon'] });
      qc.invalidateQueries({ queryKey: ['invoice_payments'] });
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  // ── Multi-Invoice Reconciliation ──
  const runMultiInvoicePreview = () => {
    if (vendorFilteredInvoices.length === 0 || sessionLines.length === 0) return;
    const result = multiInvoiceMatch(sessionLines, vendorFilteredInvoices, getLineItems);
    setMultiMatchResult(result);
  };

  const runMultiInvoiceReconciliation = async () => {
    if (!multiMatchResult || !selectedSessionId || !selectedSession) return;
    setMultiReconRunning(true);
    try {
      const skipPriceCheck = selectedSession.vendor === 'EOL';

      // CREDIT ISOLATION GUARD: Each invoice group is processed independently.
      // Credits from Invoice A's lines NEVER bleed to Invoice B or C.
      // Each group gets its own computeReconciliationTotals, its own final_bill_ledger entry,
      // and its own applyCreditToPayments call — completely isolated.
      for (const group of multiMatchResult.groups) {
        const invoice = vendorInvoices.find(v => v.id === group.invoiceId);
        if (!invoice) continue;

        const invoiceLines = getLineItems(invoice);

        // Match and reconcile each line in this group — ONLY against this group's invoice
        let hasDiscrepancy = false;
        for (const line of group.lines) {
          const lineUpc = line.upc ? String(line.upc).replace(/\D/g, '') : '';
          const lineSku = line.manufact_sku ? line.manufact_sku.toLowerCase().replace(/[\s\-]/g, '') : '';

          let matchedInvLine = invoiceLines.find(il => il.upc && lineUpc && String(il.upc).replace(/\D/g, '') === lineUpc);
          if (!matchedInvLine) matchedInvLine = invoiceLines.find(il => il.model && lineSku && il.model.toLowerCase().replace(/[\s\-]/g, '') === lineSku) || null;

          const disc = calcDiscrepancy(line, matchedInvLine, skipPriceCheck);
          await updateLineReconciliation(line.id, {
            matched_invoice_line: matchedInvLine as any,
            match_status: matchedInvLine ? 'MATCHED' : 'NO_MATCH',
            billing_discrepancy: !!disc,
            discrepancy_type: disc?.type ?? null,
            discrepancy_amount: disc?.amount ?? 0,
          });
          if (disc) hasDiscrepancy = true;
        }

        // Compute totals ONLY for this invoice group's lines — isolated credit calculation
        const { data: freshGroupLines } = await supabase
          .from('po_receiving_lines')
          .select('*')
          .in('id', group.lines.map((l: any) => l.id));
        const gLines = freshGroupLines ?? group.lines;
        const totals = computeReconciliationTotals(gLines, invoice.total);

        // This credit applies ONLY to this invoice — never aggregate across invoices
        const reconStatus = totals.totalCreditDue > 0 ? 'credit_pending' : 'reconciled';
        await updateInvoiceReconciliation(group.invoiceId, selectedSessionId, totals.totalCreditDue, totals.finalBillAmount, reconStatus);

        // Create independent final bill ledger entry per invoice
        await upsertFinalBillEntry(
          group.invoiceId, selectedSessionId, invoice,
          {
            total_ordered_qty: gLines.reduce((s: number, l: any) => s + Number(l.order_qty || 0), 0),
            total_received_qty: gLines.reduce((s: number, l: any) => s + Number(l.received_qty ?? 0), 0),
          },
          totals
        );

        // Apply credits independently per invoice — isolated from other invoice groups
        if (totals.totalCreditDue > 0) {
          await applyCreditToPayments(group.invoiceId, totals.totalCreditDue);
        }
      }

      // Mark unmatched lines
      for (const line of multiMatchResult.unmatchedLines) {
        await updateLineReconciliation(line.id, {
          match_status: 'INVOICE_NOT_UPLOADED',
          billing_discrepancy: false,
          discrepancy_type: null,
          discrepancy_amount: 0,
        });
      }

      // Update session
      const mainInvoiceId = multiMatchResult.groups[0]?.invoiceId || '';
      const status = multiMatchResult.unmatchedLines.length > 0 ? 'partial_reconciled' : 'reconciled';
      await updateSessionReconciliation(selectedSessionId, mainInvoiceId, status);

      toast.success(`Multi-invoice reconciliation complete — ${multiMatchResult.groups.length} invoices matched, ${multiMatchResult.unmatchedLines.length} lines unmatched`);

      setReconciling(null);
      setReconMode('SINGLE');
      setMultiMatchResult(null);
      qc.invalidateQueries({ queryKey: ['receiving-lines', selectedSessionId] });
      qc.invalidateQueries({ queryKey: ['receiving-sessions'] });
      qc.invalidateQueries({ queryKey: ['final-bill-ledger'] });
      qc.invalidateQueries({ queryKey: ['vendor-invoices-for-recon'] });
      qc.invalidateQueries({ queryKey: ['invoice_payments'] });
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setMultiReconRunning(false);
    }
  };

  // ── PO Split ──
  const detectPOSplit = () => {
    if (sessionLines.length === 0) return;
    const groups = detectPOGroups(sessionLines);
    if (groups.length > 1) {
      setPOGroups(groups);
    } else {
      toast.info('All lines belong to the same brand group — no split needed.');
    }
  };

  const doSplitSession = async () => {
    if (!poGroups || !selectedSessionId || !selectedSession) return;
    setSplitting(true);
    try {
      const childIds = await splitSessionByPO(selectedSessionId, selectedSession, poGroups);
      toast.success(`Split into ${childIds.length} sub-sessions`);
      setPOGroups(null);
      setSelectedSessionId(null);
      qc.invalidateQueries({ queryKey: ['receiving-sessions'] });
      qc.invalidateQueries({ queryKey: ['receiving-lines'] });
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSplitting(false);
    }
  };

  // ── Reconcile All — includes unreconciled, partial, and discrepancy sessions ──
  const reconAllEligible = useMemo(() => {
    return sessions.filter(s =>
      ['unreconciled', 'partial_reconciled', 'discrepancy'].includes(s.reconciliation_status) &&
      !((s as any).child_session_ids?.length > 0) // exclude parent split sessions
    );
  }, [sessions]);

  const runReconcileAll = async () => {
    if (reconAllEligible.length === 0) {
      toast.info('No unreconciled sessions to process.');
      return;
    }
    setReconAllRunning(true);
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    try {
      setReconAllProgress({ done: 0, total: reconAllEligible.length, current: '' });

      for (let i = 0; i < reconAllEligible.length; i++) {
        const session = reconAllEligible[i];
        setReconAllProgress({ done: i, total: reconAllEligible.length, current: session.session_name });

        try {
          // Fetch session lines
          const lines = await fetchSessionLines(session.id);
          if (lines.length === 0) { skipped++; continue; }

          // Determine allowed vendors
          const isEOL = session.vendor === 'EOL';
          let allowedV: string[];
          if (isEOL) {
            const eolRes = resolveEOLVendor(lines as any[]);
            allowedV = eolRes.realVendors.length > 0 ? eolRes.realVendors : ['Luxottica'];
          } else {
            allowedV = RECEIVING_TO_INVOICE_VENDOR[session.vendor] ?? [session.vendor];
          }

          // Filter invoices to this vendor
          const candidateInvs = vendorInvoices.filter(inv =>
            allowedV.some(v => inv.vendor?.toLowerCase() === v.toLowerCase())
          );
          if (candidateInvs.length === 0) { skipped++; continue; }

          // Get best suggestion
          const suggestions = suggestMatchingInvoices(
            lines as any[],
            Number(session.total_ordered_cost || 0),
            session.raw_filename || '',
            session.session_name || '',
            candidateInvs
          );

          if (suggestions.length === 0 || suggestions[0].score < 3) {
            skipped++;
            continue;
          }

          const bestInvoice = suggestions[0].invoice;
          const invoiceLines = getLineItems(bestInvoice);
          const results = matchReceivingToInvoice(lines, invoiceLines);

          // Check coverage — skip if < 20% UPC match (likely wrong invoice)
          const coverage = checkInvoiceLineCoverage(results, invoiceLines);
          const matchedReceivingCount = results.filter(r => r.match_status === 'MATCHED' || r.match_status === 'SKU_ONLY').length;
          if (matchedReceivingCount === 0) { skipped++; continue; }

          const skipPriceCheck = isEOL;
          let hasDiscrepancy = false;
          for (const r of results) {
            const disc = calcDiscrepancy(r.line, r.matched_invoice_line, skipPriceCheck);
            const matchStatusVal = r.match_status === 'NO_MATCH' && isEOL
              ? 'INVOICE_NOT_UPLOADED' : r.match_status;
            await updateLineReconciliation(r.line.id, {
              matched_invoice_line: r.matched_invoice_line as any,
              match_status: matchStatusVal,
              billing_discrepancy: !!disc && matchStatusVal !== 'INVOICE_NOT_UPLOADED',
              discrepancy_type: matchStatusVal === 'INVOICE_NOT_UPLOADED' ? null : (disc?.type ?? null),
              discrepancy_amount: matchStatusVal === 'INVOICE_NOT_UPLOADED' ? 0 : (disc?.amount ?? 0),
            });
            if (disc && matchStatusVal !== 'INVOICE_NOT_UPLOADED') hasDiscrepancy = true;
          }

          const status = hasDiscrepancy ? 'discrepancy' : 'reconciled';
          await updateSessionReconciliation(session.id, bestInvoice.id, status);

          // Compute totals on matched lines only
          const { data: freshLines } = await supabase
            .from('po_receiving_lines')
            .select('*')
            .eq('session_id', session.id);
          const matchedLines = (freshLines ?? []).filter((l: any) => l.match_status !== 'INVOICE_NOT_UPLOADED');
          const totals = computeReconciliationTotals(matchedLines, bestInvoice.total);

          const reconStatus = totals.totalCreditDue > 0 ? 'credit_pending' : 'reconciled';
          await updateInvoiceReconciliation(bestInvoice.id, session.id, totals.totalCreditDue, totals.finalBillAmount, reconStatus);

          await upsertFinalBillEntry(
            bestInvoice.id, session.id, bestInvoice,
            {
              total_ordered_qty: matchedLines.reduce((s: number, l: any) => s + Number(l.order_qty || 0), 0),
              total_received_qty: matchedLines.reduce((s: number, l: any) => s + Number(l.received_qty ?? 0), 0),
            },
            totals
          );

          if (totals.totalCreditDue > 0) {
            await applyCreditToPayments(bestInvoice.id, totals.totalCreditDue);
          }

          succeeded++;
        } catch (err: any) {
          console.error(`Reconcile All: failed on ${session.session_name}:`, err);
          failed++;
        }
      }

      setReconAllProgress({ done: reconAllEligible.length, total: reconAllEligible.length, current: 'Complete' });

      let msg = `Reconcile All complete: ${succeeded} reconciled`;
      if (skipped > 0) msg += `, ${skipped} skipped (no match)`;
      if (failed > 0) msg += `, ${failed} failed`;
      toast.success(msg);

      qc.invalidateQueries({ queryKey: ['receiving-sessions'] });
      qc.invalidateQueries({ queryKey: ['final-bill-ledger'] });
      qc.invalidateQueries({ queryKey: ['vendor-invoices-for-recon'] });
      qc.invalidateQueries({ queryKey: ['invoice_payments'] });
    } catch (err: any) {
      toast.error(`Reconcile All failed: ${err.message}`);
    } finally {
      setReconAllRunning(false);
      setTimeout(() => setReconAllProgress(null), 3000);
    }
  };

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
    const invoiceNotUploaded = sessionLines.filter((l: any) => l.match_status === 'INVOICE_NOT_UPLOADED');
    const cleanMatches = sessionLines.filter((l: any) => l.match_status && !l.billing_discrepancy && l.match_status !== 'INVOICE_NOT_UPLOADED');
    return { invoiceTotal, receivedCost, notReceivedCost, variance: Number(invoiceTotal) - receivedCost, overbilled, qtyMismatch, priceMismatch, notOnInvoice, invoiceNotUploaded, cleanMatches };
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
      case 'partial_reconciled': return 'bg-blue-600 text-white';
      case 'discrepancy': return 'bg-amber-500 text-white';
      case 'reviewed': return 'bg-blue-600 text-white';
      case 'split': return 'bg-purple-600 text-white';
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
                    ⚠ This export has no receiving data — it shows what was ordered but not what arrived.
                  </div>
                )}
                <div className="overflow-auto max-h-[420px] border rounded-md">
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
                      {preview.lines.slice(0, 20).map((l, i) => (
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
                    <Button size="sm" variant="outline" onClick={() => { setPreview(null); setDedupResult(null); }}>Dismiss</Button>
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
                        <p className="text-[10px] text-muted-foreground">Unchanged</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={doMergeUpdate} disabled={importing}>{importing ? 'Merging…' : 'Merge Updates'}</Button>
                      <Button size="sm" variant="outline" onClick={() => { setPreview(null); setDedupResult(null); }}>Cancel</Button>
                    </div>
                  </div>
                )}
                {dedupResult?.type === 'new' && (
                  <div className="flex items-center gap-3">
                    <Badge className="bg-emerald-600 text-white gap-1"><CheckCircle2 className="h-3 w-3" />No duplicates found</Badge>
                    <Button onClick={doImport} disabled={importing}>{importing ? 'Importing…' : `Import ${preview.lines.length} rows`}</Button>
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
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className={reconStatusColor(selectedSession.reconciliation_status)}>
                    {selectedSession.reconciliation_status === 'partial_reconciled' ? '⚠ Partially Reconciled' : selectedSession.reconciliation_status}
                  </Badge>
                  {selectedSession.reconciliation_status === 'partial_reconciled' && (() => {
                    const totalLines = Number(selectedSession.total_lines || 0);
                    const unmatchedCount = sessionLines.filter((l: any) => l.match_status === 'INVOICE_NOT_UPLOADED').length;
                    const matchedCount = totalLines - unmatchedCount;
                    const pctReconciled = totalLines > 0 ? Math.round((matchedCount / totalLines) * 100) : 0;
                    return (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-amber-600">{matchedCount} of {totalLines} lines reconciled ({pctReconciled}%)</span>
                        <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${pctReconciled}%` }} />
                        </div>
                      </div>
                    );
                  })()}
                  {selectedSession.reconciliation_status === 'unreconciled' && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setReconciling(selectedSessionId)} className="gap-1">
                        <ArrowRight className="h-3 w-3" />Reconcile
                      </Button>
                      {selectedSession.vendor === 'EOL' && (
                        <Button size="sm" variant="outline" onClick={detectPOSplit} className="gap-1">
                          <Split className="h-3 w-3" />Split by Brand
                        </Button>
                      )}
                    </>
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

              {/* ── PO Split Panel ── */}
              {poGroups && poGroups.length > 1 && (
                <div className="border border-purple-500/30 bg-purple-500/5 rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Split className="h-4 w-4 text-purple-600" />
                    <p className="text-sm font-semibold text-purple-700 dark:text-purple-400">
                      Detected {poGroups.length} brand groups — split into separate sessions?
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {poGroups.map((g, i) => (
                      <div key={i} className="bg-background border rounded-md p-3">
                        <div className="flex items-center justify-between mb-1">
                          <Badge variant="outline" className="text-xs">{g.poRef}</Badge>
                          <span className="text-xs font-semibold tabular-nums">{formatCurrency(g.orderedValue)}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">{g.lineCount} lines</p>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Splitting creates independent sessions per brand group for cleaner per-invoice reconciliation.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={doSplitSession} disabled={splitting} className="gap-1">
                      <Split className="h-3 w-3" />{splitting ? 'Splitting…' : `Split into ${poGroups.length} Sessions`}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setPOGroups(null)}>Keep as One Session</Button>
                  </div>
                </div>
              )}

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
                  {/* Unmatched / Invoice Not Uploaded */}
                  {reconSummary.invoiceNotUploaded && reconSummary.invoiceNotUploaded.length > 0 && (
                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 space-y-2">
                      <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                        ⚠ {reconSummary.invoiceNotUploaded.length} lines ({formatCurrency(reconSummary.invoiceNotUploaded.reduce((s: number, l: any) => s + Number(l.ordered_cost || 0), 0))}) could not be matched to any invoice in the system
                      </p>
                      <p className="text-xs text-muted-foreground">
                        These frames may belong to invoices not yet uploaded via the PDF Reader.
                      </p>
                      <div className="max-h-32 overflow-auto text-xs space-y-1">
                        {reconSummary.invoiceNotUploaded.slice(0, 10).map((l: any, i: number) => (
                          <div key={i} className="flex items-center gap-2 text-muted-foreground">
                            <span className="font-mono">{l.upc || '—'}</span>
                            <span className="truncate max-w-[200px]">{l.item_description}</span>
                            <span>×{l.order_qty}</span>
                          </div>
                        ))}
                        {reconSummary.invoiceNotUploaded.length > 10 && (
                          <p className="text-muted-foreground">… and {reconSummary.invoiceNotUploaded.length - 10} more</p>
                        )}
                      </div>
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

                  {reconTotals && selectedSession.reconciliation_status !== 'unreconciled' && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <div className="border rounded-lg p-3 text-center">
                        <p className="text-xs text-muted-foreground">Credit Due (Overbilled)</p>
                        <p className={`text-sm font-bold ${reconTotals.totalCreditDue > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                          {reconTotals.totalCreditDue > 0 ? `-${formatCurrency(reconTotals.totalCreditDue)}` : '$0.00'}
                        </p>
                      </div>
                      <div className="border rounded-lg p-3 text-center">
                        <p className="text-xs text-muted-foreground">Final Bill</p>
                        <p className="text-sm font-bold">{formatCurrency(reconTotals.finalBillAmount)}</p>
                      </div>
                      <div className="border rounded-lg p-3 text-center">
                        <p className="text-xs text-muted-foreground">Discrepancy Lines</p>
                        <p className="text-sm font-bold">{reconTotals.discrepancyLineCount}</p>
                      </div>
                    </div>
                  )}

                  {mathChecks && <MathVerificationBlock checks={mathChecks} varianceOverride={varianceOverride || undefined} />}

                  {/* Invoice Line Coverage Check */}
                  {invoiceCoverage && (
                    <div className={`border rounded-lg p-3 space-y-2 ${
                      invoiceCoverage.coveragePct === 100
                        ? 'bg-emerald-500/5 border-emerald-500/20'
                        : 'bg-amber-500/5 border-amber-500/20'
                    }`}>
                      <div className="flex items-center gap-2">
                        {invoiceCoverage.coveragePct === 100
                          ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                          : <AlertTriangle className="h-4 w-4 text-amber-600" />
                        }
                        <p className={`text-sm font-semibold ${invoiceCoverage.coveragePct === 100 ? 'text-emerald-600' : 'text-amber-600'}`}>
                          {invoiceCoverage.coveragePct === 100
                            ? `✓ All ${invoiceCoverage.totalInvoiceLines} invoice lines matched in receiving data`
                            : `⚠ ${invoiceCoverage.unmatchedInvoiceLines.length} of ${invoiceCoverage.totalInvoiceLines} invoice lines not found in receiving data (${invoiceCoverage.coveragePct}% coverage)`
                          }
                        </p>
                      </div>
                      {invoiceCoverage.unmatchedInvoiceLines.length > 0 && (
                        <div className="space-y-1 ml-6">
                          <p className="text-[10px] text-amber-600 font-medium">Items billed but missing from PO receiving:</p>
                          {invoiceCoverage.unmatchedInvoiceLines.slice(0, 10).map((il, i) => (
                            <div key={i} className="flex items-center gap-3 text-xs text-muted-foreground">
                              <span className="font-mono">{il.upc || '—'}</span>
                              <span>{il.model || il.item_number || '—'}</span>
                              <span className="tabular-nums">{il.description || ''}</span>
                              <span className="font-semibold tabular-nums">{formatCurrency(Number(il.unit_price || 0))}</span>
                            </div>
                          ))}
                          {invoiceCoverage.unmatchedInvoiceLines.length > 10 && (
                            <p className="text-[10px] text-muted-foreground">…and {invoiceCoverage.unmatchedInvoiceLines.length - 10} more</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Reconcile Panel ── */}
              {reconciling === selectedSessionId && (
                <div className="border rounded-lg p-4 bg-muted/30 space-y-3">
                  {/* EOL Info Banner */}
                  {isEOLSession && eolSessionResolution ? (
                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2 text-xs text-amber-700 dark:text-amber-400 space-y-1">
                      <div className="flex items-center gap-1.5">
                        <Info className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          <strong>EOL Session</strong> — Real vendor{eolSessionResolution.isMultiVendor ? 's' : ''}:{' '}
                          <strong>{eolSessionResolution.realVendors.join(', ')}</strong>
                        </span>
                      </div>
                      {eolSessionResolution.isMultiVendor && (
                        <p className="text-[11px]">⚠ Multi-vendor EOL — contains {eolSessionResolution.realVendors.map(v =>
                          `${v} (${eolSessionResolution.vendorCounts[v]} items)`
                        ).join(', ')}.</p>
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

                  {/* ── Mode Selector ── */}
                  {shouldOfferMultiMode && (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => { setReconMode('SINGLE'); setMultiMatchResult(null); }}
                        className={`rounded-md border p-3 text-left transition-colors ${
                          reconMode === 'SINGLE' ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:bg-accent/50'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <FileText className="h-4 w-4" />
                          <span className="text-sm font-semibold">Single Invoice</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground">Reconcile only lines matching one invoice. Unmatched lines stay for later.</p>
                      </button>
                      <button
                        onClick={() => { setReconMode('MULTI'); runMultiInvoicePreview(); }}
                        className={`rounded-md border p-3 text-left transition-colors ${
                          reconMode === 'MULTI' ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:bg-accent/50'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <Layers className="h-4 w-4" />
                          <span className="text-sm font-semibold">Multi-Invoice</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground">Match all lines across multiple invoices simultaneously.</p>
                      </button>
                    </div>
                  )}

                  {/* ── MULTI-INVOICE MODE ── */}
                  {reconMode === 'MULTI' && multiMatchResult && (
                    <div className="space-y-3">
                      <p className="text-sm font-medium flex items-center gap-2">
                        <Layers className="h-4 w-4" />
                        Multi-Invoice Match Results
                      </p>

                      {/* Matched Groups */}
                      {multiMatchResult.groups.map((group, i) => (
                        <div key={group.invoiceId} className="border border-emerald-500/30 bg-emerald-500/5 rounded-md p-3 space-y-1">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Badge className="bg-emerald-600 text-white text-[10px]">Group {i + 1}</Badge>
                              <span className="text-xs font-mono font-medium">Invoice {group.invoiceNumber}</span>
                              <span className="text-xs text-muted-foreground">{group.vendor}</span>
                            </div>
                            <span className="text-xs font-semibold tabular-nums">{formatCurrency(group.invoiceTotal)}</span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span>{group.matchedLineCount} lines</span>
                            <span>Ordered: {formatCurrency(group.orderedValue)}</span>
                            <span>Received: {formatCurrency(group.receivedValue)}</span>
                            {group.poNumber && <span>PO: {group.poNumber}</span>}
                          </div>
                        </div>
                      ))}

                      {/* Unmatched Lines */}
                      {multiMatchResult.unmatchedLines.length > 0 && (
                        <div className="border border-amber-500/30 bg-amber-500/5 rounded-md p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                              ⚠ Unmatched Lines ({multiMatchResult.unmatchedLines.length})
                            </p>
                            <span className="text-xs font-semibold tabular-nums text-amber-600">
                              {formatCurrency(multiMatchResult.unmatchedValue)}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            UPCs not found in any uploaded invoice. These may belong to invoices not yet uploaded via the PDF Reader.
                          </p>
                          <div className="max-h-32 overflow-auto text-xs space-y-1">
                            {multiMatchResult.unmatchedLines.slice(0, 8).map((l: any, i: number) => (
                              <div key={i} className="flex items-center gap-2 text-muted-foreground">
                                <span className="font-mono">{l.upc || '—'}</span>
                                <span className="truncate max-w-[200px]">{l.item_description}</span>
                                <span>×{l.order_qty}</span>
                                <span>{formatCurrency(Number(l.ordered_cost || 0))}</span>
                              </div>
                            ))}
                            {multiMatchResult.unmatchedLines.length > 8 && (
                              <p className="text-muted-foreground">… and {multiMatchResult.unmatchedLines.length - 8} more</p>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Summary */}
                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-background border rounded-md p-2 text-center">
                          <p className="text-xs text-muted-foreground">Invoices Matched</p>
                          <p className="text-lg font-bold text-emerald-600">{multiMatchResult.groups.length}</p>
                        </div>
                        <div className="bg-background border rounded-md p-2 text-center">
                          <p className="text-xs text-muted-foreground">Lines Matched</p>
                          <p className="text-lg font-bold">{multiMatchResult.groups.reduce((s, g) => s + g.matchedLineCount, 0)}</p>
                        </div>
                        <div className="bg-background border rounded-md p-2 text-center">
                          <p className="text-xs text-muted-foreground">Unmatched</p>
                          <p className="text-lg font-bold text-amber-600">{multiMatchResult.unmatchedLines.length}</p>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Button size="sm" onClick={runMultiInvoiceReconciliation} disabled={multiReconRunning || multiMatchResult.groups.length === 0}>
                          {multiReconRunning ? 'Reconciling…' : `Reconcile ${multiMatchResult.groups.length} Invoice Groups`}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => runMultiInvoicePreview()}>
                          Refresh Matching
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => { setReconciling(null); setReconMode('SINGLE'); setMultiMatchResult(null); }}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* ── SINGLE INVOICE MODE ── */}
                  {reconMode === 'SINGLE' && (
                    <>
                      <p className="text-sm font-medium">Select the invoice this PO receiving belongs to:</p>

                      {/* Auto-Suggestions */}
                      {invoiceSuggestions.length > 0 ? (
                        <div className="space-y-2">
                          <p className="text-xs text-muted-foreground flex items-center gap-1">🔍 Suggested matches based on UPC overlap:</p>
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
                          <span>No invoice UPC matches found. Search manually or upload the invoice PDF first.</span>
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
                            {vendorInvoices.length === 0 ? 'No invoices found' : 'No invoices match your search'}
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
                        <Button size="sm" variant="ghost" onClick={() => { setReconciling(null); setInvoiceSearch(''); setReconMode('SINGLE'); setMultiMatchResult(null); }}>Cancel</Button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Filters */}
              <div className="flex flex-wrap items-center gap-2">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[180px] h-8 text-xs"><SelectValue /></SelectTrigger>
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
                      <TableRow key={l.id} className={l.billing_discrepancy ? 'bg-amber-500/5' : l.match_status === 'INVOICE_NOT_UPLOADED' ? 'bg-gray-500/5' : ''}>
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
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">Receiving History</CardTitle>
                {reconAllEligible.length > 0 && (
                  <Badge className="bg-primary/10 text-primary text-[10px]">{reconAllEligible.length} pending</Badge>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {reconAllEligible.length > 0 && (
                  <Button
                    size="sm"
                    variant="default"
                    className="h-8 text-xs gap-1"
                    disabled={reconAllRunning}
                    onClick={runReconcileAll}
                  >
                    {reconAllRunning ? (
                      <>
                        <div className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        Reconciling {reconAllProgress?.done ?? 0}/{reconAllProgress?.total ?? 0}…
                      </>
                    ) : (
                      <>
                        <Layers className="h-3 w-3" />
                        Reconcile All ({reconAllEligible.length})
                      </>
                    )}
                  </Button>
                )}
                <Select value={historyVendor} onValueChange={setHistoryVendor}>
                  <SelectTrigger className="w-[140px] h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Vendors</SelectItem>
                    <SelectItem value="Luxottica">Luxottica</SelectItem>
                    <SelectItem value="Kering">Kering</SelectItem>
                    <SelectItem value="Maui Jim">Maui Jim</SelectItem>
                    <SelectItem value="Safilo">Safilo</SelectItem>
                    <SelectItem value="Marcolin">Marcolin</SelectItem>
                    <SelectItem value="EOL">EOL</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={historyStatus} onValueChange={setHistoryStatus}>
                  <SelectTrigger className="w-[150px] h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="unreconciled">Unreconciled</SelectItem>
                    <SelectItem value="reconciled">Reconciled</SelectItem>
                    <SelectItem value="partial_reconciled">Partial</SelectItem>
                    <SelectItem value="discrepancy">Discrepancy</SelectItem>
                    <SelectItem value="split">Split</SelectItem>
                    <SelectItem value="reviewed">Reviewed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {/* Reconcile All Progress Bar */}
            {reconAllProgress && (
              <div className="mt-2 space-y-1">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{reconAllProgress.current}</span>
                  <span>{reconAllProgress.done}/{reconAllProgress.total}</span>
                </div>
                <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${reconAllProgress.total > 0 ? (reconAllProgress.done / reconAllProgress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {sessionsLoading ? (
              <p className="text-sm text-muted-foreground text-center py-4">Loading…</p>
            ) : filteredSessions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No receiving sessions yet</p>
            ) : (
              <>
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
                      const isParent = s.reconciliation_status === 'split';
                      const isChild = !!(s as any).parent_session_id;
                      const childSessions = isParent
                        ? filteredSessions.filter(c => (c as any).parent_session_id === s.id)
                        : [];

                      return (
                        <React.Fragment key={s.id}>
                          <TableRow
                            className={`${selectedSessionId === s.id ? 'bg-accent' : 'cursor-pointer hover:bg-muted/50'} ${isChild ? 'bg-muted/20' : ''}`}
                            onClick={() => setSelectedSessionId(s.id)}
                          >
                            <TableCell className="text-xs font-medium">
                              <div className="flex items-center gap-1">
                                {isChild && <span className="text-muted-foreground">└</span>}
                                {isParent && <span>📦</span>}
                                {s.session_name}
                              </div>
                            </TableCell>
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
                            <TableCell>
                              <div className="flex flex-col gap-1">
                                <Badge className={`text-xs ${reconStatusColor(s.reconciliation_status)}`}>
                                  {s.reconciliation_status === 'partial_reconciled' ? '⚠ Partial' : s.reconciliation_status}
                                </Badge>
                                {s.reconciliation_status === 'partial_reconciled' && (
                                  <span className="text-[10px] text-amber-600">Upload missing invoices</span>
                                )}
                                {isParent && childSessions.length > 0 && (
                                  <span className="text-[10px] text-muted-foreground">{childSessions.length} sub-sessions</span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell><Eye className="h-3.5 w-3.5 text-muted-foreground" /></TableCell>
                          </TableRow>
                        </React.Fragment>
                      );
                    })}
                  </TableBody>
                </Table>

                <div className="md:hidden divide-y">
                  {filteredSessions.map(s => {
                    const pct = s.total_ordered_qty ? Math.round((Number(s.total_received_qty) / Number(s.total_ordered_qty)) * 100) : 0;
                    const isChild = !!(s as any).parent_session_id;
                    return (
                      <div key={s.id} className={`p-3 space-y-1 cursor-pointer ${selectedSessionId === s.id ? 'bg-accent' : ''} ${isChild ? 'pl-6' : ''}`} onClick={() => setSelectedSessionId(s.id)}>
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">
                            {isChild && <span className="text-muted-foreground mr-1">└</span>}
                            {s.session_name}
                          </span>
                          <Badge className={`text-xs ${reconStatusColor(s.reconciliation_status)}`}>
                            {s.reconciliation_status === 'partial_reconciled' ? '⚠ Partial' : s.reconciliation_status}
                          </Badge>
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
        </>) : (
          /* ── FINAL BILL LEDGER TAB ── */
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Card className="bg-card border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-xs text-muted-foreground">TOTAL INVOICED</p>
                  <p className="text-xl font-bold tabular-nums">{formatCurrency(finalBillEntries.reduce((s, e) => s + e.original_invoice_total, 0))}</p>
                </CardContent>
              </Card>
              <Card className="bg-red-500/5 border-red-500/20">
                <CardContent className="p-4 text-center">
                  <p className="text-xs text-muted-foreground">TOTAL CREDITS DUE BACK</p>
                  <p className="text-xl font-bold tabular-nums text-red-600">-{formatCurrency(finalBillEntries.reduce((s, e) => s + e.total_credit_due, 0))}</p>
                </CardContent>
              </Card>
              <Card className="bg-emerald-500/5 border-emerald-500/20">
                <CardContent className="p-4 text-center">
                  <p className="text-xs text-muted-foreground">TOTAL ACTUALLY OWED</p>
                  <p className="text-xl font-bold tabular-nums text-emerald-600">{formatCurrency(finalBillEntries.reduce((s, e) => s + e.final_bill_amount, 0))}</p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Final Bill Ledger</CardTitle>
                <CardDescription className="text-xs">Reconciled invoices with credit adjustments</CardDescription>
              </CardHeader>
              <CardContent>
                {finalBillLoading ? (
                  <p className="text-sm text-muted-foreground text-center py-4">Loading…</p>
                ) : finalBillEntries.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No reconciled invoices yet. Reconcile a receiving session to create ledger entries.</p>
                ) : (
                  <div className="overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Vendor</TableHead>
                          <TableHead className="text-xs">Invoice #</TableHead>
                          <TableHead className="text-xs">PO #</TableHead>
                          <TableHead className="text-xs">Date</TableHead>
                          <TableHead className="text-xs text-right">Original Bill</TableHead>
                          <TableHead className="text-xs text-right">Credit Due</TableHead>
                          <TableHead className="text-xs text-right">Final Bill</TableHead>
                          <TableHead className="text-xs">Status</TableHead>
                          <TableHead className="text-xs">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {finalBillEntries.map(entry => (
                          <TableRow key={entry.id}>
                            <TableCell className="text-xs font-medium">{entry.vendor}</TableCell>
                            <TableCell className="text-xs font-mono">{entry.invoice_number}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{entry.po_number || '—'}</TableCell>
                            <TableCell className="text-xs">{entry.invoice_date}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{formatCurrency(entry.original_invoice_total)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">
                              {entry.total_credit_due > 0 ? (
                                <span className="text-red-600">-{formatCurrency(entry.total_credit_due)}</span>
                              ) : (
                                <span className="text-muted-foreground">$0.00</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-right tabular-nums font-semibold">{formatCurrency(entry.final_bill_amount)}</TableCell>
                            <TableCell>
                              <FinalBillStatusBadge status={entry.final_bill_status} creditDue={entry.total_credit_due} creditApproved={entry.credit_approved} />
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                {entry.total_credit_due > 0 && !entry.credit_request_sent && (
                                  <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1" onClick={async () => {
                                    await markCreditRequestSent(entry.id);
                                    toast.success('Credit request marked as sent');
                                    qc.invalidateQueries({ queryKey: ['final-bill-ledger'] });
                                  }}>
                                    <Send className="h-3 w-3" />Send Credit Request
                                  </Button>
                                )}
                                {entry.credit_request_sent && !entry.credit_approved && (
                                  <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1" onClick={() => {
                                    setCreditConfirmOpen(entry.id);
                                    setCreditAmount(entry.total_credit_due.toFixed(2));
                                  }}>
                                    <CheckCheck className="h-3 w-3" />Confirm Credit
                                  </Button>
                                )}
                                <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1" onClick={() => {
                                  const csv = generateCreditRequestCSV(entry, []);
                                  const blob = new Blob([csv], { type: 'text/csv' });
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement('a');
                                  a.href = url;
                                  a.download = `credit-request-${entry.invoice_number}.csv`;
                                  a.click();
                                }}>
                                  <FileDown className="h-3 w-3" />CSV
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            {creditConfirmOpen && (
              <Card className="border-primary">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Confirm Credit Received</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-2">
                    <label className="text-xs font-medium">Credit Amount Confirmed by Vendor</label>
                    <Input type="number" step="0.01" value={creditAmount} onChange={e => setCreditAmount(e.target.value)} className="max-w-xs" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium">Approved By</label>
                    <Input value={creditApprover} onChange={e => setCreditApprover(e.target.value)} placeholder="Your name" className="max-w-xs" />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={async () => {
                      const entry = finalBillEntries.find(e => e.id === creditConfirmOpen);
                      if (!entry) return;
                      try {
                        await confirmCreditReceived(creditConfirmOpen, entry.invoice_id, parseFloat(creditAmount), creditApprover);
                        toast.success('Credit confirmed and applied to payment schedule');
                        setCreditConfirmOpen(null);
                        setCreditAmount('');
                        setCreditApprover('');
                        qc.invalidateQueries({ queryKey: ['final-bill-ledger'] });
                        qc.invalidateQueries({ queryKey: ['invoice_payments'] });
                      } catch (err: any) {
                        toast.error(err.message);
                      }
                    }}>Confirm Credit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setCreditConfirmOpen(null)}>Cancel</Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
