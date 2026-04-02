import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "sonner";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { InvoiceDrawer } from "@/components/invoices/InvoiceDrawer";
import type { VendorInvoice } from "@/lib/supabase-queries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertCircle, Calendar, Loader2, RefreshCw, DollarSign, ChevronDown, ChevronUp, ChevronsUpDown, Check, CheckCircle2, Search } from "lucide-react";
import { formatCurrency, formatDate, fetchDistinctVendors, updateInvoiceStatus, type InvoiceStatus } from "@/lib/supabase-queries";
import { fetchPayments, type InvoicePayment, generateAllMissingPayments, generatePaymentsForInvoice, markInstallmentPaid } from "@/lib/payment-queries";
import { PaymentStatusBadge } from "@/components/invoices/PaymentStatusBadge";
import { RecordPaymentModal } from "@/components/invoices/RecordPaymentModal";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";

// ── Server date hook ──────────────────────────────────
function useServerDate() {
  return useQuery({
    queryKey: ["server_date"],
    queryFn: async (): Promise<string> => {
      const { data, error } = await supabase.rpc("get_server_date");
      if (error) throw error;
      return data as string;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// ── Rolling months from server date ───────────────────
interface RollingMonth {
  label: string;
  shortLabel: string;
  startDate: Date;
  endDate: Date;
}

function getRollingMonths(serverDateStr: string): RollingMonth[] {
  const base = new Date(serverDateStr + "T00:00:00");
  return [0, 1, 2, 3].map(offset => {
    const d = new Date(base.getFullYear(), base.getMonth() + offset, 1);
    return {
      label: d.toLocaleString("default", { month: "long", year: "numeric" }),
      shortLabel: d.toLocaleString("default", { month: "short", year: "numeric" }),
      startDate: new Date(d.getFullYear(), d.getMonth(), 1),
      endDate: new Date(d.getFullYear(), d.getMonth() + 1, 0),
    };
  });
}

function isInMonth(dueDate: string, month: RollingMonth): boolean {
  const d = new Date(dueDate + "T00:00:00");
  return d >= month.startDate && d <= month.endDate;
}

// ── Vendor color map ──────────────────────────────────
const VENDOR_COLORS: Record<string, string> = {
  "Kering": "bg-red-600",
  "Luxottica": "bg-amber-600",
  "Marcolin": "bg-teal-600",
  "Maui Jim": "bg-yellow-500",
  "Safilo": "bg-green-600",
};

function getVendorColor(vendor: string): string {
  return VENDOR_COLORS[vendor] || "bg-primary";
}

export default function APDashboard() {
  const queryClient = useQueryClient();
  
  const [generating, setGenerating] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<InvoicePayment | null>(null);
  const [drawerInvoice, setDrawerInvoice] = useState<VendorInvoice | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [expandedMonth, setExpandedMonth] = useState<string | null>(null);
  const [fixingKering, setFixingKering] = useState(false);
  const [fixingLuxottica, setFixingLuxottica] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dashTab, setDashTab] = useState<'outstanding' | 'history'>('outstanding');
  const [historySearch, setHistorySearch] = useState("");
  const [historyVendor, setHistoryVendor] = useState("all");
  const midnightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const midnightIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const minuteIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: serverDate } = useServerDate();
  const effectiveDate = serverDate || new Date().toISOString().split("T")[0];

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ["invoice_payments"],
    queryFn: fetchPayments,
  });

  // ── Realtime subscriptions ──────────────────────────
  const refreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["invoice_payments"] });
    queryClient.invalidateQueries({ queryKey: ["server_date"] });
    queryClient.invalidateQueries({ queryKey: ["distinct_vendors"] });
  }, [queryClient]);

  useEffect(() => {
    const channel = supabase
      .channel("ap-dashboard-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "vendor_invoices" }, (payload) => {
        refreshAll();
        const vendor = (payload.new as any)?.vendor || "Unknown";
        const invNum = (payload.new as any)?.invoice_number || "";
        if (payload.eventType === "INSERT") {
          toast("📊 Dashboard updated", { description: `${vendor} ${invNum} added`, duration: 3000 });
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "invoice_payments" }, () => {
        refreshAll();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [refreshAll]);

  // ── Midnight refresh + 60s overdue refresh ──
  useEffect(() => {
    minuteIntervalRef.current = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["server_date"] });
    }, 60_000);

    function msUntilMidnight() {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
      return midnight.getTime() - now.getTime();
    }

    midnightTimerRef.current = setTimeout(() => {
      refreshAll();
      midnightIntervalRef.current = setInterval(() => { refreshAll(); }, 24 * 60 * 60 * 1000);
    }, msUntilMidnight());

    return () => {
      if (midnightTimerRef.current) clearTimeout(midnightTimerRef.current);
      if (midnightIntervalRef.current) clearInterval(midnightIntervalRef.current);
      if (minuteIntervalRef.current) clearInterval(minuteIntervalRef.current);
    };
  }, [refreshAll, queryClient]);

  const calendarMonths = getRollingMonths(effectiveDate);
  const activePayments = payments.filter(p => p.payment_status !== "void");

  // ── Vendor × Month grid data ─────────────────────────
  const { vendorGrid, allVendorTotals, grandTotal } = useMemo(() => {
    const vendorMap = new Map<string, Map<number, { totalDue: number; remaining: number }>>();

    for (const p of activePayments) {
      if (!vendorMap.has(p.vendor)) {
        vendorMap.set(p.vendor, new Map());
      }
      const vm = vendorMap.get(p.vendor)!;
      for (let mi = 0; mi < calendarMonths.length; mi++) {
        if (!vm.has(mi)) vm.set(mi, { totalDue: 0, remaining: 0 });
        if (isInMonth(p.due_date, calendarMonths[mi])) {
          const cell = vm.get(mi)!;
          cell.totalDue += p.amount_due;
          cell.remaining += p.balance_remaining;
        }
      }
    }

    // Sort vendors alphabetically
    const sortedVendors = Array.from(vendorMap.keys()).sort();

    const grid = sortedVendors.map(vendor => {
      const vm = vendorMap.get(vendor)!;
      const months = calendarMonths.map((_, mi) => vm.get(mi) || { totalDue: 0, remaining: 0 });
      const fourMonthTotal = months.reduce((s, m) => s + m.remaining, 0);
      return { vendor, months, fourMonthTotal };
    });

    // All vendors totals row
    const allVendorTotals = calendarMonths.map((_, mi) => {
      return grid.reduce((acc, row) => ({
        totalDue: acc.totalDue + row.months[mi].totalDue,
        remaining: acc.remaining + row.months[mi].remaining,
      }), { totalDue: 0, remaining: 0 });
    });

    const grandTotal = allVendorTotals.reduce((s, m) => s + m.remaining, 0);

    return { vendorGrid: grid, allVendorTotals, grandTotal };
  }, [activePayments, calendarMonths]);

  // ── Paid payments (for history tab) ──────────────────
  const paidPayments = useMemo(() =>
    payments.filter(p => p.is_paid || p.payment_status === "paid" || p.balance_remaining === 0),
    [payments]
  );

  const historyVendors = useMemo(() =>
    [...new Set(paidPayments.map(p => p.vendor))].sort(),
    [paidPayments]
  );

  const filteredHistory = useMemo(() => {
    let h = paidPayments;
    if (historyVendor !== "all") h = h.filter(p => p.vendor === historyVendor);
    if (historySearch.trim()) {
      const q = historySearch.toLowerCase();
      h = h.filter(p =>
        p.invoice_number?.toLowerCase().includes(q) ||
        p.vendor?.toLowerCase().includes(q) ||
        (p.po_number ?? "").toLowerCase().includes(q)
      );
    }
    return h.sort((a, b) => (b.paid_date ?? "").localeCompare(a.paid_date ?? ""));
  }, [paidPayments, historyVendor, historySearch]);

  // ── Overdue payments ─────────────────────────────────
  const overduePayments = activePayments.filter(p =>
    p.due_date < effectiveDate && p.balance_remaining > 0 && p.payment_status !== "paid" && p.payment_status !== "overpaid"
  );

  const handleOpenInvoice = useCallback(async (invoiceId: string | null | undefined) => {
    if (!invoiceId) return;
    try {
      const { data } = await supabase
        .from('vendor_invoices')
        .select('*')
        .eq('id', invoiceId)
        .maybeSingle();
      if (data) {
        setDrawerInvoice(data as unknown as VendorInvoice);
        setDrawerOpen(true);
      } else {
        toast.error('Invoice not found');
      }
    } catch (err) {
      console.error('Failed to load invoice:', err);
      toast.error('Could not load invoice');
    }
  }, []);

  const handlePaymentClick = (payment: InvoicePayment) => {
    if (payment.invoice_id) {
      handleOpenInvoice(payment.invoice_id);
    } else {
      setSelectedPayment(payment);
      setModalOpen(true);
    }
  };

  const handleRecordPayment = (payment: InvoicePayment) => {
    setSelectedPayment(payment);
    setModalOpen(true);
  };

  const handleGenerateAll = async () => {
    setGenerating(true);
    try {
      const result = await generateAllMissingPayments();
      toast.success(`Generated ${result.generated} payments for ${result.invoices} invoices`);
      refreshAll();
    } catch (e: any) {
      toast.error(`Failed: ${e.message}`);
    } finally {
      setGenerating(false);
    }
  };

  // ── Selection logic ──────────────────────────────────
  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectedTotal = useMemo(() => {
    return [...selectedIds].reduce((sum, id) => {
      const p = activePayments.find(p => p.id === id);
      return sum + (p?.balance_remaining ?? 0);
    }, 0);
  }, [selectedIds, activePayments]);

  // ── Quick pay (inline toggle — per installment) ───
  const handleQuickPay = async (payment: InvoicePayment) => {
    const currentlyPaid = payment.is_paid || payment.payment_status === "paid";
    try {
      await markInstallmentPaid(payment.id, !currentlyPaid);
      toast.success(
        !currentlyPaid
          ? `${payment.installment_label || payment.invoice_number} marked paid`
          : `${payment.installment_label || payment.invoice_number} marked unpaid`
      );
      refreshAll();
    } catch (e: any) {
      toast.error(`Failed: ${e.message}`);
    }
  };

  // ── Bulk mark paid ───────────────────────────────────
  const handleMarkSelectedPaid = async () => {
    const ids = [...selectedIds];
    let success = 0;
    for (const paymentId of ids) {
      const p = activePayments.find(p => p.id === paymentId);
      if (p?.invoice_id) {
        await updateInvoiceStatus(p.invoice_id, "paid");
        success++;
      }
    }
    toast.success(`${success} invoices marked as paid`);
    setSelectedIds(new Set());
    refreshAll();
  };

  // ── Fix Kering Terms ─────────────────────────────────
  const handleFixKeringTerms = async () => {
    setFixingKering(true);
    try {
      const { data: keringInvoices } = await supabase
        .from("vendor_invoices")
        .select("id, vendor, invoice_date, payment_terms, total, invoice_number, po_number")
        .or("vendor.ilike.%kering%,vendor.ilike.%gucci%,vendor.ilike.%saint laurent%,vendor.ilike.%bottega%,vendor.ilike.%cartier%");

      let fixed = 0;
      for (const inv of keringInvoices ?? []) {
        await supabase.from("invoice_payments").delete().eq("invoice_id", inv.id);
        await generatePaymentsForInvoice(inv.id, inv.invoice_date, inv.total, inv.vendor, inv.invoice_number, inv.po_number, inv.payment_terms);
        fixed++;
      }
      toast.success(`Fixed ${fixed} Kering invoices — EOM terms applied`);
      refreshAll();
    } catch (e: any) {
      toast.error(`Failed: ${e.message}`);
    } finally {
      setFixingKering(false);
    }
  };

  // ── Fix Luxottica Terms ──────────────────────────────
  const handleFixLuxotticaTerms = async () => {
    setFixingLuxottica(true);
    try {
      const { data: luxInvoices } = await supabase
        .from("vendor_invoices")
        .select("id, vendor, invoice_date, payment_terms, total, invoice_number, po_number")
        .or("vendor.ilike.%luxottica%,vendor.ilike.%ray-ban%,vendor.ilike.%oakley%,vendor.ilike.%costa%,vendor.ilike.%prada%,vendor.ilike.%versace%,vendor.ilike.%coach%,vendor.ilike.%burberry%,vendor.ilike.%michael kors%,vendor.ilike.%persol%,vendor.ilike.%oliver peoples%");

      let fixed = 0;
      for (const inv of luxInvoices ?? []) {
        await supabase.from("invoice_payments").delete().eq("invoice_id", inv.id);
        await generatePaymentsForInvoice(inv.id, inv.invoice_date, inv.total, inv.vendor, inv.invoice_number, inv.po_number, inv.payment_terms);
        fixed++;
      }
      toast.success(`Fixed ${fixed} Luxottica invoices — EOM+30 / split terms applied`);
      refreshAll();
    } catch (e: any) {
      toast.error(`Failed: ${e.message}`);
    } finally {
      setFixingLuxottica(false);
    }
  };

  // Month column header colors
  const monthHeaderColors = [
    "bg-slate-700 text-white",
    "bg-slate-600 text-white",
    "bg-slate-500 text-white",
    "bg-slate-400 text-white",
  ];

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">

        {/* ── Header ───────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-3">
            <Calendar className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-lg font-bold tracking-tight">ROLLING 4-MONTH PAYMENT CALENDAR</h1>
              <p className="text-[10px] text-muted-foreground">
                Months auto-advance · All data pulls live from <span className="font-mono">PAYMENTS</span> · Summary grid + full detail below
              </p>
            </div>
          </div>
          <div className="sm:ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleFixLuxotticaTerms} disabled={fixingLuxottica}>
              {fixingLuxottica ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
              Fix Luxottica Terms
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleFixKeringTerms} disabled={fixingKering}>
              {fixingKering ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
              Fix Kering Terms
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleGenerateAll} disabled={generating}>
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
              Generate Missing
            </Button>
          </div>
        </div>

        {/* ── Month date labels ────────────────────────── */}
        <div className="hidden md:grid grid-cols-[140px_repeat(4,1fr)_100px] gap-0 text-center text-[10px] text-muted-foreground font-mono">
          <div />
          {calendarMonths.map(m => (
            <div key={m.label}>
              {m.startDate.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "2-digit" })}
            </div>
          ))}
          <div />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* ── Vendor × Month Summary Grid ────────────── */}
            <Card className="bg-card border-border overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-none">
                      <TableHead className="bg-slate-800 text-white text-xs font-bold w-[140px] sticky left-0 z-10">
                        VENDOR
                      </TableHead>
                      {calendarMonths.map((m, i) => {
                        const isExpanded = expandedMonth === m.label;
                        return (
                          <TableHead
                            key={m.label}
                            colSpan={2}
                            className={`text-center text-xs font-bold cursor-pointer select-none transition-colors ${monthHeaderColors[i]} border-l border-white/20 ${isExpanded ? "ring-2 ring-primary ring-inset" : "hover:brightness-110"}`}
                            onClick={() => setExpandedMonth(isExpanded ? null : m.label)}
                          >
                            <span className="inline-flex items-center gap-1">
                              {m.label}
                              {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                            </span>
                          </TableHead>
                        );
                      })}
                      <TableHead className="bg-amber-700 text-white text-xs font-bold text-center border-l border-white/20">
                        4-MONTH<br />TOTAL
                      </TableHead>
                    </TableRow>
                    <TableRow className="border-none">
                      <TableHead className="bg-slate-800 text-white text-[10px] sticky left-0 z-10" />
                      {calendarMonths.map((m) => (
                        <React.Fragment key={m.label + "-sub"}>
                          <TableHead className="bg-slate-800/80 text-white/80 text-[10px] text-right font-semibold border-l border-white/10 px-2">
                            TOTAL DUE
                          </TableHead>
                          <TableHead className="bg-slate-800/80 text-white/80 text-[10px] text-right font-semibold px-2">
                            REMAINING ↓
                          </TableHead>
                        </React.Fragment>
                      ))}
                      <TableHead className="bg-amber-700/80 text-white/80 text-[10px] text-right font-semibold border-l border-white/10 px-2" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {vendorGrid.map((row) => (
                      <TableRow key={row.vendor} className="border-border hover:bg-muted/30 transition-colors">
                        <TableCell className="sticky left-0 bg-card z-10">
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-4 rounded-sm ${getVendorColor(row.vendor)}`} />
                            <span className="text-xs font-bold">{row.vendor}</span>
                          </div>
                        </TableCell>
                        {row.months.map((cell, mi) => (
                          <React.Fragment key={mi}>
                            <TableCell className="text-xs text-right tabular-nums px-2 border-l border-border/40">
                              {formatCurrency(cell.totalDue)}
                            </TableCell>
                            <TableCell className={`text-xs text-right tabular-nums px-2 font-semibold ${cell.remaining > 0 ? "text-foreground" : "text-green-500"}`}>
                              {formatCurrency(cell.remaining)}
                            </TableCell>
                          </React.Fragment>
                        ))}
                        <TableCell className="text-xs text-right tabular-nums px-2 font-bold border-l border-border/40">
                          {formatCurrency(row.fourMonthTotal)}
                        </TableCell>
                      </TableRow>
                    ))}
                    {/* ALL VENDORS total row */}
                    <TableRow className="border-t-2 border-primary bg-muted/50 font-bold">
                      <TableCell className="sticky left-0 bg-muted/50 z-10 text-xs font-bold">
                        ALL VENDORS
                      </TableCell>
                      {allVendorTotals.map((cell, mi) => (
                        <React.Fragment key={mi}>
                          <TableCell className="text-xs text-right tabular-nums px-2 font-bold border-l border-border/40">
                            {formatCurrency(cell.totalDue)}
                          </TableCell>
                          <TableCell className={`text-xs text-right tabular-nums px-2 font-bold ${cell.remaining > 0 ? "text-foreground" : "text-green-500"}`}>
                            {formatCurrency(cell.remaining)}
                          </TableCell>
                        </React.Fragment>
                      ))}
                      <TableCell className="text-xs text-right tabular-nums px-2 font-extrabold border-l border-border/40">
                        {formatCurrency(grandTotal)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </Card>

            {/* ── Tab bar ──────────────────────────────── */}
            <div className="flex gap-1 border-b border-border">
              <button
                onClick={() => setDashTab('outstanding')}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  dashTab === 'outstanding'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                Outstanding
              </button>
              <button
                onClick={() => setDashTab('history')}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  dashTab === 'history'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                Payment History
                {paidPayments.length > 0 && (
                  <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-muted">
                    {paidPayments.length}
                  </span>
                )}
              </button>
            </div>

            {/* ── Outstanding tab ──────────────────────── */}
            {dashTab === 'outstanding' && (
              <>
                {/* Expanded month panel */}
                {expandedMonth && (() => {
                  const month = calendarMonths.find(m => m.label === expandedMonth);
                  if (!month) return null;
                  const monthPayments = activePayments
                    .filter(p => isInMonth(p.due_date, month))
                    .sort((a, b) => a.due_date.localeCompare(b.due_date));
                  const monthRemaining = monthPayments.reduce((s, p) => s + p.balance_remaining, 0);
                  const monthPaid = monthPayments.reduce((s, p) => s + p.amount_paid, 0);
                  return (
                    <Card className="bg-card border-primary/30 border-l-4 border-l-primary animate-in slide-in-from-top-2 duration-200">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-semibold flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                          <span className="flex items-center gap-2">
                            <Calendar className="h-4 w-4" />
                            {month.label} — {monthPayments.length} payment{monthPayments.length !== 1 ? "s" : ""}
                          </span>
                          <span className="sm:ml-auto text-xs font-normal text-muted-foreground">
                            Paid: <span className="text-green-500 font-medium">{formatCurrency(monthPaid)}</span>
                            {" · "}Remaining: <span className={`font-medium ${monthRemaining > 0 ? "text-destructive" : "text-green-500"}`}>{formatCurrency(monthRemaining)}</span>
                          </span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="p-0">
                        <PaymentTable payments={monthPayments} onRowClick={handlePaymentClick} onRecordPayment={handleRecordPayment} serverDate={effectiveDate} selectedIds={selectedIds} onToggleSelected={toggleSelected} onQuickPay={handleQuickPay} onOpenInvoice={handleOpenInvoice} />
                      </CardContent>
                    </Card>
                  );
                })()}

                {/* Overdue Panel */}
                {overduePayments.length > 0 && (
                  <Card className="border-red-500/30 bg-red-500/5">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-semibold text-red-500 flex items-center gap-2">
                        <AlertCircle className="h-4 w-4" />
                        🔴 OVERDUE ({overduePayments.length} payments · {formatCurrency(overduePayments.reduce((s, p) => s + p.balance_remaining, 0))} outstanding)
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <PaymentTable payments={overduePayments} onRowClick={handlePaymentClick} onRecordPayment={handleRecordPayment} serverDate={effectiveDate} selectedIds={selectedIds} onToggleSelected={toggleSelected} onQuickPay={handleQuickPay} onOpenInvoice={handleOpenInvoice} />
                    </CardContent>
                  </Card>
                )}

                {/* Monthly payment detail sections */}
                {!expandedMonth && calendarMonths.map((month) => {
                  const monthPayments = activePayments
                    .filter(p => isInMonth(p.due_date, month))
                    .sort((a, b) => a.due_date.localeCompare(b.due_date));
                  if (monthPayments.length === 0) return null;
                  const monthRemaining = monthPayments.reduce((s, p) => s + p.balance_remaining, 0);
                  const monthPaid = monthPayments.reduce((s, p) => s + p.amount_paid, 0);
                  return (
                    <Card key={month.label} className="bg-card border-border">
                      <CardHeader className="pb-3 sticky top-0 bg-card z-10">
                        <CardTitle className="text-sm font-semibold flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                          <span className="flex items-center gap-2">
                            <Calendar className="h-4 w-4" />
                            {month.label} — {monthPayments.length} payment{monthPayments.length !== 1 ? "s" : ""}
                          </span>
                          <span className="sm:ml-auto text-xs font-normal text-muted-foreground">
                            Paid: <span className="text-green-500 font-medium">{formatCurrency(monthPaid)}</span>
                            {" · "}Remaining: <span className={`font-medium ${monthRemaining > 0 ? "text-destructive" : "text-green-500"}`}>{formatCurrency(monthRemaining)}</span>
                          </span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="p-0">
                        <PaymentTable payments={monthPayments} onRowClick={handlePaymentClick} onRecordPayment={handleRecordPayment} serverDate={effectiveDate} selectedIds={selectedIds} onToggleSelected={toggleSelected} onQuickPay={handleQuickPay} onOpenInvoice={handleOpenInvoice} />
                      </CardContent>
                    </Card>
                  );
                })}

                {activePayments.length === 0 && (
                  <Card className="bg-card border-border">
                    <CardContent className="p-8 text-center text-muted-foreground text-sm">
                      No payment schedules found. Upload invoices and click "Generate Missing" to create payment schedules.
                    </CardContent>
                  </Card>
                )}
              </>
            )}

            {/* ── Payment History tab ─────────────────── */}
            {dashTab === 'history' && (
              <Card className="bg-card border-border">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    Payment History — Paid Invoices
                    <span className="ml-auto text-xs font-normal text-muted-foreground">
                      {formatCurrency(paidPayments.reduce((s, p) => s + p.amount_paid, 0))} total paid
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="flex gap-2 p-3 border-b border-border">
                    <div className="relative flex-1">
                      <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        placeholder="Search paid invoices…"
                        value={historySearch}
                        onChange={e => setHistorySearch(e.target.value)}
                        className="pl-8 h-8 text-xs"
                      />
                    </div>
                    <Select value={historyVendor} onValueChange={setHistoryVendor}>
                      <SelectTrigger className="h-8 text-xs w-[160px]">
                        <SelectValue placeholder="All Vendors" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Vendors</SelectItem>
                        {historyVendors.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {filteredHistory.length > 0 ? (
                    <PaymentTable
                      payments={filteredHistory}
                      onRowClick={p => handleOpenInvoice(p.invoice_id)}
                      onRecordPayment={() => {}}
                      serverDate={effectiveDate}
                      selectedIds={new Set()}
                      onToggleSelected={() => {}}
                      onQuickPay={handleQuickPay}
                      onOpenInvoice={handleOpenInvoice}
                    />
                  ) : (
                    <div className="p-8 text-center text-muted-foreground text-sm">
                      No paid invoices found.
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>

      {/* ── Floating selection bar ────────────────────── */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 px-5 py-3 rounded-xl bg-card border border-border shadow-2xl">
          <span className="text-xs text-muted-foreground">
            {selectedIds.size} installment{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <span className="text-lg font-bold tabular-nums text-primary">
            {formatCurrency(selectedTotal)} remaining
          </span>
          {selectedTotal === 0 && selectedIds.size > 0 && (
            <span className="text-[10px] text-muted-foreground">
              All selected installments are already paid
            </span>
          )}
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => setSelectedIds(new Set())}>
            Clear
          </Button>
          <Button size="sm" className="text-xs h-7 gap-1.5" onClick={handleMarkSelectedPaid}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            Mark {selectedIds.size} Paid
          </Button>
        </div>
      )}

      <RecordPaymentModal
        payment={selectedPayment}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onComplete={() => refreshAll()}
      />

      {/* Invoice Drawer — opens on dashboard without navigating away */}
      <InvoiceDrawer
        invoice={drawerInvoice}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setDrawerInvoice(null);
        }}
        onUpdate={() => {
          refreshAll();
        }}
      />
    </div>
  );
}

function PaymentTable({ payments, onRowClick, onRecordPayment, serverDate, selectedIds, onToggleSelected, onQuickPay, onOpenInvoice }: {
  payments: InvoicePayment[];
  onRowClick: (p: InvoicePayment) => void;
  onRecordPayment?: (p: InvoicePayment) => void;
  serverDate: string;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onQuickPay: (payment: InvoicePayment) => Promise<void>;
  onOpenInvoice: (invoiceId: string | null | undefined) => void;
}) {
  const [sortField, setSortField] = useState<string>("due_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const handleSort = (field: string) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); }
  };

  const sortedPayments = [...payments].sort((a, b) => {
    let av: any, bv: any;
    if (sortField === "amount") { av = a.balance_remaining; bv = b.balance_remaining; }
    else if (sortField === "due_date") { av = a.due_date; bv = b.due_date; }
    else if (sortField === "vendor") { av = a.vendor; bv = b.vendor; }
    else if (sortField === "invoice_number") { av = a.invoice_number; bv = b.invoice_number; }
    else { av = (a as any)[sortField] ?? ""; bv = (b as any)[sortField] ?? ""; }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === "asc" ? cmp : -cmp;
  });

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field) return <ChevronsUpDown className="h-3 w-3 opacity-30" />;
    return sortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />;
  };

  const columns = [
    { field: "vendor", label: "Vendor" },
    { field: "invoice_number", label: "Invoice #" },
    { field: "po_number", label: "PO Ref" },
    { field: "amount", label: "Amount Due", align: "right" as const },
    { field: "due_date", label: "Due Date" },
    { field: "terms", label: "Terms" },
  ];

  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-border bg-muted/20">
              <TableHead className="w-8" />
              {columns.map(col => (
                <TableHead
                  key={col.field}
                  className={`text-xs font-semibold cursor-pointer select-none hover:text-foreground transition-colors ${col.align === "right" ? "text-right" : ""}`}
                  onClick={() => handleSort(col.field)}
                >
                  <span className="flex items-center gap-1">
                    {col.label}
                    <SortIcon field={col.field} />
                  </span>
                </TableHead>
              ))}
              <TableHead className="text-center text-xs font-semibold">Status</TableHead>
              {onRecordPayment && <TableHead className="text-xs font-semibold text-right w-[100px]" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedPayments.map(p => {
              const effectiveStatus = p.invoice_payment_status ?? p.payment_status;
              const overdue = p.due_date < serverDate && p.balance_remaining > 0 && p.payment_status !== "paid" && p.payment_status !== "void";
              const isPaid = effectiveStatus === "paid" || effectiveStatus === "overpaid";
              const isPartial = effectiveStatus === "partial";
              const rowColor =
                isPaid ? "bg-green-500/8 hover:bg-green-500/12" :
                isPartial ? "bg-blue-500/8 hover:bg-blue-500/12" :
                p.payment_status === "disputed" ? "bg-orange-500/8 hover:bg-orange-500/12" :
                overdue ? "bg-red-500/8 hover:bg-red-500/12" :
                "hover:bg-muted/40";
              const siblings = p.sibling_count ?? 1;

              return (
                <TableRow key={p.id} className={`border-border transition-colors ${rowColor}`}>
                  <TableCell onClick={e => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(p.id)}
                      onCheckedChange={() => onToggleSelected(p.id)}
                      className="h-3.5 w-3.5"
                    />
                  </TableCell>
                  <TableCell className="text-xs">{p.vendor}</TableCell>
                  <TableCell
                    className="text-xs font-mono text-primary cursor-pointer hover:underline underline-offset-2 whitespace-nowrap"
                    onClick={e => { e.stopPropagation(); onOpenInvoice(p.invoice_id); }}
                  >
                    {p.invoice_number}
                  </TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">{p.po_number ?? "—"}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-semibold">{formatCurrency(p.balance_remaining > 0 ? p.balance_remaining : p.amount_due)}</TableCell>
                  <TableCell className="text-xs">{formatDate(p.due_date)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.terms ?? "—"}{p.installment_label ? ` (${p.installment_label})` : ""}</TableCell>
                  <TableCell className="text-center" onClick={e => e.stopPropagation()}>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => onQuickPay(p)}
                            className={`h-6 w-6 rounded-full border-2 flex items-center justify-center transition-all ${
                              isPaid
                                ? "bg-green-500 border-green-500 text-white"
                                : isPartial
                                ? "bg-blue-500/20 border-blue-500 text-blue-500"
                                : "border-border hover:border-green-500 hover:bg-green-500/10"
                            }`}
                          >
                            {isPaid && <Check className="h-3.5 w-3.5" />}
                            {isPartial && <span className="text-[8px] font-bold">½</span>}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs max-w-[200px]">
                          {p.payment_status === "paid" ? "Mark this installment unpaid" : `Mark installment ${p.installment_label ?? ""} paid`}
                          {siblings > 1 && (
                            <p className="text-muted-foreground mt-0.5">
                              To mark all installments paid, open the invoice drawer.
                            </p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </TableCell>
                  {onRecordPayment && (
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-[10px] h-6 opacity-0 group-hover:opacity-100 hover:opacity-100 focus:opacity-100"
                        onClick={(e) => { e.stopPropagation(); onRecordPayment(p); }}
                      >
                        <DollarSign className="h-3 w-3 mr-0.5" /> Record
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {/* Mobile card layout */}
      <div className="md:hidden space-y-2 p-3">
        {sortedPayments.map(p => {
          const effectiveStatus = p.invoice_payment_status ?? p.payment_status;
          const overdue = p.due_date < serverDate && p.balance_remaining > 0 && p.payment_status !== "paid" && p.payment_status !== "void";
          const isPaid = effectiveStatus === "paid" || effectiveStatus === "overpaid";
          const isPartial = effectiveStatus === "partial";
          const cardBorder =
            isPaid ? "border-green-500/30" :
            isPartial ? "border-blue-500/30" :
            p.payment_status === "disputed" ? "border-orange-500/30" :
            overdue ? "border-red-500/30" : "border-border";

          return (
            <div
              key={p.id}
              className={`rounded-lg border p-3 transition-colors ${cardBorder}`}
            >
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <Checkbox
                    checked={selectedIds.has(p.id)}
                    onCheckedChange={() => onToggleSelected(p.id)}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{p.vendor}</p>
                    <p
                      className="text-[10px] font-mono text-primary cursor-pointer hover:underline truncate"
                      onClick={e => { e.stopPropagation(); onOpenInvoice(p.invoice_id); }}
                    >
                      {p.invoice_number}
                    </p>
                  </div>
                </div>
                <div className="text-right shrink-0 flex items-center gap-2">
                  <div>
                    <p className={`text-sm font-semibold tabular-nums ${p.balance_remaining > 0 ? "" : "text-green-500"}`}>{formatCurrency(p.balance_remaining)}</p>
                  </div>
                  <button
                    onClick={() => onQuickPay(p)}
                    className={`h-6 w-6 rounded-full border-2 flex items-center justify-center transition-all shrink-0 ${
                      isPaid
                        ? "bg-green-500 border-green-500 text-white"
                        : isPartial
                        ? "bg-blue-500/20 border-blue-500 text-blue-500"
                        : "border-border hover:border-green-500 hover:bg-green-500/10"
                    }`}
                  >
                    {isPaid && <Check className="h-3.5 w-3.5" />}
                    {isPartial && <span className="text-[8px] font-bold">½</span>}
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground pl-6">
                <span>Due: {formatDate(p.due_date)}</span>
                <span>{p.terms ?? "—"}{p.installment_label ? ` (${p.installment_label})` : ""}</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
