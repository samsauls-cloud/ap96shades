import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, Calendar, Loader2, RefreshCw, DollarSign } from "lucide-react";
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
  startDate: Date;
  endDate: Date;
}

function getRollingMonths(serverDateStr: string): RollingMonth[] {
  const base = new Date(serverDateStr + "T00:00:00");
  return [0, 1, 2, 3].map(offset => {
    const d = new Date(base.getFullYear(), base.getMonth() + offset, 1);
    return {
      label: d.toLocaleString("default", { month: "long", year: "numeric" }),
      startDate: new Date(d.getFullYear(), d.getMonth(), 1),
      endDate: new Date(d.getFullYear(), d.getMonth() + 1, 0),
    };
  });
}

function isInMonth(dueDate: string, month: RollingMonth): boolean {
  const d = new Date(dueDate + "T00:00:00");
  return d >= month.startDate && d <= month.endDate;
}

export default function APDashboard() {
  const queryClient = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<InvoicePayment | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [vendorFilter, setVendorFilter] = useState<string>("all");
  const midnightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const midnightIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const minuteIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: serverDate } = useServerDate();
  const effectiveDate = serverDate || new Date().toISOString().split("T")[0];

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ["invoice_payments"],
    queryFn: fetchPayments,
  });

  const { data: vendors = [] } = useQuery({
    queryKey: ["distinct_vendors"],
    queryFn: fetchDistinctVendors,
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

  // ── Derived data ──────────────────────────────────────
  const activePayments = payments.filter(p => p.payment_status !== "void");
  const filteredPayments = vendorFilter === "all" ? activePayments : activePayments.filter(p => p.vendor === vendorFilter);

  const outstanding = activePayments.filter(p => p.balance_remaining > 0);
  const totalOutstanding = outstanding.reduce((s, p) => s + p.balance_remaining, 0);
  const overduePayments = filteredPayments.filter(p =>
    p.due_date < effectiveDate && p.balance_remaining > 0 && p.payment_status !== "paid" && p.payment_status !== "overpaid"
  );

  // Per-month summaries
  const monthSummaries = useMemo(() => {
    return calendarMonths.map(m => {
      const mp = filteredPayments.filter(p => isInMonth(p.due_date, m));
      const totalDue = mp.reduce((s, p) => s + p.amount_due, 0);
      const totalPaid = mp.reduce((s, p) => s + p.amount_paid, 0);
      const remaining = mp.reduce((s, p) => s + p.balance_remaining, 0);
      return { month: m, payments: mp, totalDue, totalPaid, remaining, count: mp.length };
    });
  }, [filteredPayments, calendarMonths]);

  const maxMonthDue = Math.max(...monthSummaries.map(m => m.totalDue), 1);

  const handlePaymentClick = (payment: InvoicePayment) => {
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

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">

        {/* Top bar: AP total + vendor filter + generate button */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-3">
            <DollarSign className="h-5 w-5 text-primary" />
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Total Outstanding</p>
              <p className="text-2xl font-bold tabular-nums">{formatCurrency(totalOutstanding)}</p>
            </div>
          </div>
          <div className="sm:ml-auto flex items-center gap-2 flex-wrap">
            <Select value={vendorFilter} onValueChange={setVendorFilter}>
              <SelectTrigger className="h-8 text-xs w-[180px]">
                <SelectValue placeholder="All Vendors" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Vendors</SelectItem>
                {vendors.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleGenerateAll} disabled={generating}>
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
              Generate Missing
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* ── 4-Month Summary Bars ────────────────────────── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {monthSummaries.map((ms, i) => {
                const barPct = maxMonthDue > 0 ? (ms.totalDue / maxMonthDue) * 100 : 0;
                return (
                  <Card key={ms.month.label} className="bg-card border-border overflow-hidden">
                    <CardContent className="p-4 space-y-2">
                      <p className="text-xs font-semibold">{ms.month.label}</p>
                      <p className="text-lg font-bold tabular-nums">{formatCurrency(ms.remaining)}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {ms.count} payment{ms.count !== 1 ? "s" : ""} · {formatCurrency(ms.totalDue)} total due
                      </p>
                      {/* Visual weight bar */}
                      <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary transition-all duration-500"
                          style={{ width: `${barPct}%` }}
                        />
                      </div>
                      {ms.totalPaid > 0 && (
                        <p className="text-[10px] text-green-500">{formatCurrency(ms.totalPaid)} paid</p>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* ── Overdue Panel ────────────────────────────────── */}
            {overduePayments.length > 0 && (
              <Card className="border-red-500/30 bg-red-500/5">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold text-red-500 flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    🔴 OVERDUE ({overduePayments.length} payments · {formatCurrency(overduePayments.reduce((s, p) => s + p.balance_remaining, 0))} outstanding)
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <PaymentTable payments={overduePayments} onRowClick={handlePaymentClick} serverDate={effectiveDate} />
                </CardContent>
              </Card>
            )}

            {/* ── Monthly Sections (grouped by month) ─────────── */}
            {monthSummaries.map((ms, mi) => {
              const monthPayments = ms.payments
                .sort((a, b) => a.due_date.localeCompare(b.due_date));
              if (monthPayments.length === 0) return null;
              return (
                <Card key={ms.month.label} className="bg-card border-border">
                  <CardHeader className="pb-3 sticky top-0 bg-card z-10">
                    <CardTitle className="text-sm font-semibold flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                      <span className="flex items-center gap-2">
                        <Calendar className="h-4 w-4" />
                        {ms.month.label} — {monthPayments.length} payment{monthPayments.length !== 1 ? "s" : ""}
                      </span>
                      <span className="sm:ml-auto text-xs font-normal text-muted-foreground">
                        Paid: <span className="text-green-500 font-medium">{formatCurrency(ms.totalPaid)}</span>
                        {" · "}Remaining: <span className={`font-medium ${ms.remaining > 0 ? "text-destructive" : "text-green-500"}`}>{formatCurrency(ms.remaining)}</span>
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <PaymentTable payments={monthPayments} onRowClick={handlePaymentClick} serverDate={effectiveDate} />
                  </CardContent>
                </Card>
              );
            })}

            {filteredPayments.length === 0 && (
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