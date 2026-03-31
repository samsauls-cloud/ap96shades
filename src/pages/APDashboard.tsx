import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertCircle, Calendar, Loader2, RefreshCw, DollarSign, ChevronDown, ChevronUp } from "lucide-react";
import { formatCurrency, formatDate, fetchDistinctVendors } from "@/lib/supabase-queries";
import { fetchPayments, type InvoicePayment, generateAllMissingPayments } from "@/lib/payment-queries";
import { PaymentStatusBadge } from "@/components/invoices/PaymentStatusBadge";
import { RecordPaymentModal } from "@/components/invoices/RecordPaymentModal";
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
  const navigate = useNavigate();
  const [generating, setGenerating] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<InvoicePayment | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [expandedMonth, setExpandedMonth] = useState<string | null>(null);
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

  // ── Overdue payments ─────────────────────────────────
  const overduePayments = activePayments.filter(p =>
    p.due_date < effectiveDate && p.balance_remaining > 0 && p.payment_status !== "paid" && p.payment_status !== "overpaid"
  );

  const handlePaymentClick = (payment: InvoicePayment) => {
    if (payment.invoice_id) {
      navigate(`/invoices?open=${payment.invoice_id}`);
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
                      {calendarMonths.map((m, i) => (
                        <TableHead
                          key={m.label}
                          colSpan={2}
                          className={`text-center text-xs font-bold ${monthHeaderColors[i]} border-l border-white/20`}
                        >
                          {m.label}
                        </TableHead>
                      ))}
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

            {/* ── Expanded month panel ──────────────────── */}
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
                    <PaymentTable payments={monthPayments} onRowClick={handlePaymentClick} onRecordPayment={handleRecordPayment} serverDate={effectiveDate} />
                  </CardContent>
                </Card>
              );
            })()}

            {/* ── Overdue Panel ────────────────────────────── */}
            {overduePayments.length > 0 && (
              <Card className="border-red-500/30 bg-red-500/5">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold text-red-500 flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    🔴 OVERDUE ({overduePayments.length} payments · {formatCurrency(overduePayments.reduce((s, p) => s + p.balance_remaining, 0))} outstanding)
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <PaymentTable payments={overduePayments} onRowClick={handlePaymentClick} onRecordPayment={handleRecordPayment} serverDate={effectiveDate} />
                </CardContent>
              </Card>
            )}

            {/* ── Monthly payment detail sections (hidden when a month is expanded) ── */}
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
                    <PaymentTable payments={monthPayments} onRowClick={handlePaymentClick} onRecordPayment={handleRecordPayment} serverDate={effectiveDate} />
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
          </div>
        )}
      </div>

      <RecordPaymentModal
        payment={selectedPayment}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onComplete={() => refreshAll()}
      />
    </div>
  );
}

function PaymentTable({ payments, onRowClick, serverDate }: { payments: InvoicePayment[]; onRowClick: (p: InvoicePayment) => void; serverDate: string }) {
  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-border bg-muted/30">
              <TableHead className="text-xs font-semibold">Vendor</TableHead>
              <TableHead className="text-xs font-semibold">Invoice #</TableHead>
              <TableHead className="text-xs font-semibold">PO Ref</TableHead>
              <TableHead className="text-xs font-semibold text-right">Amount Due</TableHead>
              <TableHead className="text-xs font-semibold">Due Date</TableHead>
              <TableHead className="text-xs font-semibold">Terms</TableHead>
              <TableHead className="text-xs font-semibold text-center">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.map(p => {
              const overdue = p.due_date < serverDate && p.balance_remaining > 0 && p.payment_status !== "paid" && p.payment_status !== "void";
              const rowColor =
                p.payment_status === "paid" || p.payment_status === "overpaid" ? "bg-green-500/8 hover:bg-green-500/12" :
                p.payment_status === "partial" ? "bg-blue-500/8 hover:bg-blue-500/12" :
                p.payment_status === "disputed" ? "bg-orange-500/8 hover:bg-orange-500/12" :
                overdue ? "bg-red-500/8 hover:bg-red-500/12" :
                "hover:bg-muted/40";

              return (
                <TableRow key={p.id} className={`border-border transition-colors cursor-pointer ${rowColor}`} onClick={() => onRowClick(p)}>
                  <TableCell className="text-xs">{p.vendor}</TableCell>
                  <TableCell className="text-xs font-mono">{p.invoice_number}</TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">{p.po_number ?? "—"}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-semibold">{formatCurrency(p.balance_remaining > 0 ? p.balance_remaining : p.amount_due)}</TableCell>
                  <TableCell className="text-xs">{formatDate(p.due_date)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.terms ?? "—"}{p.installment_label ? ` (${p.installment_label})` : ""}</TableCell>
                  <TableCell className="text-center">
                    <PaymentStatusBadge payment={p} compact />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {/* Mobile card layout */}
      <div className="md:hidden space-y-2 p-3">
        {payments.map(p => {
          const overdue = p.due_date < serverDate && p.balance_remaining > 0 && p.payment_status !== "paid" && p.payment_status !== "void";
          const cardBorder =
            p.payment_status === "paid" || p.payment_status === "overpaid" ? "border-green-500/30" :
            p.payment_status === "partial" ? "border-blue-500/30" :
            p.payment_status === "disputed" ? "border-orange-500/30" :
            overdue ? "border-red-500/30" : "border-border";

          return (
            <div
              key={p.id}
              className={`rounded-lg border p-3 cursor-pointer active:bg-accent/70 transition-colors ${cardBorder}`}
              onClick={() => onRowClick(p)}
            >
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{p.vendor}</p>
                  <p className="text-[10px] font-mono text-muted-foreground truncate">{p.invoice_number}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`text-sm font-semibold tabular-nums ${p.balance_remaining > 0 ? "" : "text-green-500"}`}>{formatCurrency(p.balance_remaining)}</p>
                  <PaymentStatusBadge payment={p} compact />
                </div>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
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
