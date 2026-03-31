import { useState, useEffect, useCallback, useRef } from "react";
import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertCircle, Calendar, TrendingUp, Loader2, RefreshCw } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/supabase-queries";
import { fetchPayments, type InvoicePayment } from "@/lib/payment-queries";
import { PaymentStatusBadge } from "@/components/invoices/PaymentStatusBadge";
import { RecordPaymentModal } from "@/components/invoices/RecordPaymentModal";
import { supabase } from "@/integrations/supabase/client";
import { generateAllMissingPayments } from "@/lib/payment-queries";

type Tab = "summary" | "calendar";

// ── Server date hook ──────────────────────────────────
function useServerDate() {
  return useQuery({
    queryKey: ["server_date"],
    queryFn: async (): Promise<string> => {
      const { data, error } = await supabase.rpc("get_server_date");
      if (error) throw error;
      return data as string; // "YYYY-MM-DD"
    },
    staleTime: 30_000, // 30s cache
    refetchInterval: 60_000, // refetch every 60s
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
      endDate: new Date(d.getFullYear(), d.getMonth() + 1, 0), // last day
    };
  });
}

// ── Overdue derived at render time (Fix 4) ────────────
function isOverdueFromServer(p: InvoicePayment, serverDate: string): boolean {
  if (p.payment_status === "paid" || p.payment_status === "overpaid" || p.payment_status === "void") return false;
  if (p.balance_remaining <= 0) return false;
  return p.due_date < serverDate;
}

function getUrgencyBucket(dueDate: string, serverDate: string) {
  const due = new Date(dueDate + "T00:00:00");
  const server = new Date(serverDate + "T00:00:00");
  const diffDays = Math.ceil((due.getTime() - server.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "overdue";
  if (diffDays <= 7) return "urgent";
  if (diffDays <= 30) return "plan";
  if (diffDays <= 60) return "forecast";
  if (diffDays <= 90) return "radar";
  return "future";
}

function daysOverdue(dueDate: string, serverDate: string): number {
  const due = new Date(dueDate + "T00:00:00");
  const server = new Date(serverDate + "T00:00:00");
  return Math.max(0, Math.ceil((server.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)));
}

function isInMonth(dueDate: string, month: RollingMonth): boolean {
  const d = new Date(dueDate + "T00:00:00");
  return d >= month.startDate && d <= month.endDate;
}


const BUCKET_CONFIG = {
  overdue: { label: "OVERDUE", emoji: "🔴", desc: "Pay immediately", color: "text-red-500 bg-red-500/10 border-red-500/20" },
  urgent: { label: "Due within 7 days", emoji: "🟠", desc: "Urgent", color: "text-orange-500 bg-orange-500/10 border-orange-500/20" },
  plan: { label: "Due in 8-30 days", emoji: "🟡", desc: "Plan ahead", color: "text-yellow-500 bg-yellow-500/10 border-yellow-500/20" },
  forecast: { label: "Due in 31-60 days", emoji: "🟢", desc: "Forecast", color: "text-green-500 bg-green-500/10 border-green-500/20" },
  radar: { label: "Due in 61-90 days", emoji: "🔵", desc: "On radar", color: "text-blue-500 bg-blue-500/10 border-blue-500/20" },
};



export default function APDashboard() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("summary");
  const [generating, setGenerating] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<InvoicePayment | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
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
    queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
    
    queryClient.invalidateQueries({ queryKey: ["server_date"] });
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

  // ── Fix 2: Midnight refresh + 60s overdue refresh ──
  useEffect(() => {
    // 60-second interval for overdue/urgency recalc
    minuteIntervalRef.current = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["server_date"] });
    }, 60_000);

    // Midnight refresh
    function msUntilMidnight() {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
      return midnight.getTime() - now.getTime();
    }

    midnightTimerRef.current = setTimeout(() => {
      refreshAll();
      midnightIntervalRef.current = setInterval(() => {
        refreshAll();
      }, 24 * 60 * 60 * 1000);
    }, msUntilMidnight());

    return () => {
      if (midnightTimerRef.current) clearTimeout(midnightTimerRef.current);
      if (midnightIntervalRef.current) clearInterval(midnightIntervalRef.current);
      if (minuteIntervalRef.current) clearInterval(minuteIntervalRef.current);
    };
  }, [refreshAll, queryClient]);

  // ── Fix 3: Rolling months from server date ─────────
  const calendarMonths = getRollingMonths(effectiveDate);

  // ── Derived data using server date ──────────────────
  const activePayments = payments.filter(p => p.payment_status !== "void");
  const outstanding = activePayments.filter(p => p.balance_remaining > 0);
  const totalOutstanding = outstanding.reduce((s, p) => s + p.balance_remaining, 0);

  const overduePayments = activePayments.filter(p => isOverdueFromServer(p, effectiveDate));

  // Vendor summary
  const vendorSummary = (() => {
    const map = new Map<string, { totalInvoiced: number; totalPaid: number; outstanding: number; overdue: number; partial: number; due30: number; due31_90: number }>();
    for (const p of activePayments) {
      if (!map.has(p.vendor)) map.set(p.vendor, { totalInvoiced: 0, totalPaid: 0, outstanding: 0, overdue: 0, partial: 0, due30: 0, due31_90: 0 });
      const v = map.get(p.vendor)!;
      v.totalInvoiced += p.amount_due;
      v.totalPaid += p.amount_paid;
      if (p.balance_remaining > 0) {
        v.outstanding += p.balance_remaining;
        if (p.payment_status === "partial") v.partial += p.balance_remaining;
        const bucket = getUrgencyBucket(p.due_date, effectiveDate);
        if (bucket === "overdue") v.overdue += p.balance_remaining;
        else if (bucket === "urgent" || bucket === "plan") v.due30 += p.balance_remaining;
        else v.due31_90 += p.balance_remaining;
      }
    }
    return map;
  })();

  // Urgency buckets using balance_remaining
  const buckets = (() => {
    const result: Record<string, { amount: number; count: number }> = {};
    for (const key of Object.keys(BUCKET_CONFIG)) result[key] = { amount: 0, count: 0 };
    for (const p of outstanding) {
      const bucket = getUrgencyBucket(p.due_date, effectiveDate);
      if (result[bucket]) {
        result[bucket].amount += p.balance_remaining;
        result[bucket].count++;
      }
    }
    return result;
  })();

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


  const totalInvoiceCount = payments.length > 0 ? [...new Set(payments.map(p => p.invoice_id))].length : 0;

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">


        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant={activeTab === "summary" ? "default" : "outline"} className="text-xs h-8 flex-1 sm:flex-none" onClick={() => setActiveTab("summary")}>
            <TrendingUp className="h-3.5 w-3.5 mr-1" /> AP Summary
          </Button>
          <Button size="sm" variant={activeTab === "calendar" ? "default" : "outline"} className="text-xs h-8 flex-1 sm:flex-none" onClick={() => setActiveTab("calendar")}>
            <Calendar className="h-3.5 w-3.5 mr-1" /> 4-Month View
          </Button>
          <Button size="sm" variant={activeTab === "audit" ? "default" : "outline"} className="text-xs h-8 flex-1 sm:flex-none" onClick={() => setActiveTab("audit")}>
            <ShieldCheck className="h-3.5 w-3.5 mr-1" /> Audit
            {audit && (audit.missingPayments.length + audit.mathDiscrepancies.length + audit.unknownVendors.length + audit.duplicateInvoices.length) > 0 && (
              <span className="ml-1 px-1 py-0.5 text-[10px] rounded bg-yellow-500/20 text-yellow-600">
                {audit.missingPayments.length + audit.mathDiscrepancies.length + audit.unknownVendors.length + audit.duplicateInvoices.length}
              </span>
            )}
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : activeTab === "summary" ? (
          <div className="space-y-6">
            {/* Vendor Summary - Desktop table */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-3"><CardTitle className="text-sm font-semibold">Vendor Summary</CardTitle></CardHeader>
              <CardContent className="p-0">
                {/* Desktop */}
                <div className="hidden md:block overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border">
                        <TableHead className="text-xs font-semibold">Vendor</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Total Invoiced</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Total Paid</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Outstanding</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Overdue</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Partial</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Due ≤30d</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Due 31-90d</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...vendorSummary.entries()].map(([vendor, v]) => (
                        <TableRow key={vendor} className="border-border">
                          <TableCell className="text-xs font-medium">{vendor}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums">{formatCurrency(v.totalInvoiced)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums text-green-500">{formatCurrency(v.totalPaid)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums font-medium">{formatCurrency(v.outstanding)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums text-red-500 font-medium">{formatCurrency(v.overdue)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums text-blue-500">{formatCurrency(v.partial)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums">{formatCurrency(v.due30)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums">{formatCurrency(v.due31_90)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="border-border bg-muted/50 font-semibold">
                        <TableCell className="text-xs">GRAND TOTAL</TableCell>
                        {["totalInvoiced", "totalPaid", "outstanding", "overdue", "partial", "due30", "due31_90"].map(key => (
                          <TableCell key={key} className={`text-xs text-right tabular-nums ${key === "totalPaid" ? "text-green-500" : key === "overdue" ? "text-red-500" : key === "partial" ? "text-blue-500" : ""}`}>
                            {formatCurrency([...vendorSummary.values()].reduce((s, v) => s + (v as any)[key], 0))}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
                {/* Mobile cards */}
                <div className="md:hidden space-y-2 p-3">
                  {[...vendorSummary.entries()].map(([vendor, v]) => (
                    <div key={vendor} className="rounded-lg border border-border p-3 space-y-2">
                      <p className="text-sm font-semibold">{vendor}</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <span className="text-muted-foreground">Total Invoiced</span>
                        <span className="text-right tabular-nums">{formatCurrency(v.totalInvoiced)}</span>
                        <span className="text-muted-foreground">Total Paid</span>
                        <span className="text-right tabular-nums text-green-500">{formatCurrency(v.totalPaid)}</span>
                        <span className="text-muted-foreground">Outstanding</span>
                        <span className="text-right tabular-nums font-medium">{formatCurrency(v.outstanding)}</span>
                        <span className="text-muted-foreground">Overdue</span>
                        <span className="text-right tabular-nums text-red-500 font-medium">{formatCurrency(v.overdue)}</span>
                        <span className="text-muted-foreground">Due ≤30d</span>
                        <span className="text-right tabular-nums">{formatCurrency(v.due30)}</span>
                        <span className="text-muted-foreground">Due 31-90d</span>
                        <span className="text-right tabular-nums">{formatCurrency(v.due31_90)}</span>
                      </div>
                    </div>
                  ))}
                  <div className="rounded-lg border border-border bg-muted/50 p-3">
                    <p className="text-sm font-bold mb-1">GRAND TOTAL</p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-semibold">
                      <span className="text-muted-foreground">Outstanding</span>
                      <span className="text-right tabular-nums">{formatCurrency([...vendorSummary.values()].reduce((s, v) => s + v.outstanding, 0))}</span>
                      <span className="text-muted-foreground">Overdue</span>
                      <span className="text-right tabular-nums text-red-500">{formatCurrency([...vendorSummary.values()].reduce((s, v) => s + v.overdue, 0))}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {(Object.entries(BUCKET_CONFIG) as [string, typeof BUCKET_CONFIG["overdue"]][]).map(([key, cfg]) => {
                const b = buckets[key];
                const pct = totalOutstanding > 0 ? ((b.amount / totalOutstanding) * 100).toFixed(1) : "0.0";
                return (
                  <Card key={key} className={`border ${cfg.color}`}>
                    <CardContent className="p-4">
                      <p className="text-lg font-bold">{cfg.emoji}</p>
                      <p className="text-xs font-semibold mt-1">{cfg.label}</p>
                      <p className="text-[10px] text-muted-foreground">{cfg.desc}</p>
                      <Separator className="my-2" />
                      <p className="text-sm font-bold tabular-nums">{formatCurrency(b.amount)}</p>
                      <p className="text-[10px] text-muted-foreground">{b.count} payments · {pct}%</p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        ) : activeTab === "calendar" ? (
          <div className="space-y-6">
            {/* 4-Month Summary Grid */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-3"><CardTitle className="text-sm font-semibold">4-Month Rolling Summary</CardTitle></CardHeader>
              <CardContent className="p-0">
                <div className="overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border">
                        <TableHead className="text-xs font-semibold">Vendor</TableHead>
                        {calendarMonths.map(m => (
                          <TableHead key={m.label} className="text-xs font-semibold text-center" colSpan={3}>{m.label}</TableHead>
                        ))}
                        <TableHead className="text-xs font-semibold text-right">4-Mo Total</TableHead>
                      </TableRow>
                      <TableRow className="border-border">
                        <TableHead className="text-[10px]"></TableHead>
                        {calendarMonths.map(m => (
                          <React.Fragment key={m.label + "-sub"}>
                            <TableHead className="text-[10px] text-right">Due</TableHead>
                            <TableHead className="text-[10px] text-right">Paid</TableHead>
                            <TableHead className="text-[10px] text-right">Remaining</TableHead>
                          </React.Fragment>
                        ))}
                        <TableHead className="text-[10px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(() => {
                        const vendors = [...new Set(activePayments.map(p => p.vendor))];
                        return [...vendors, "ALL VENDORS"].map(vendor => {
                          const isTotal = vendor === "ALL VENDORS";
                          const vp = isTotal ? activePayments : activePayments.filter(p => p.vendor === vendor);
                          let fourMonthTotal = 0;
                          return (
                            <TableRow key={vendor} className={`border-border ${isTotal ? "bg-muted/50 font-semibold" : ""}`}>
                              <TableCell className="text-xs">{vendor}</TableCell>
                              {calendarMonths.map(m => {
                                const mp = vp.filter(p => isInMonth(p.due_date, m));
                                const totalDue = mp.reduce((s, p) => s + p.amount_due, 0);
                                const totalPaid = mp.reduce((s, p) => s + p.amount_paid, 0);
                                const remaining = mp.reduce((s, p) => s + p.balance_remaining, 0);
                                fourMonthTotal += totalDue;
                                return (
                                  <React.Fragment key={m.label}>
                                    <TableCell className="text-xs text-right tabular-nums">{formatCurrency(totalDue)}</TableCell>
                                    <TableCell className="text-xs text-right tabular-nums text-green-500">{formatCurrency(totalPaid)}</TableCell>
                                    <TableCell className={`text-xs text-right tabular-nums font-semibold ${remaining > 0 ? "" : "text-green-500"}`}>{formatCurrency(remaining)}</TableCell>
                                  </React.Fragment>
                                );
                              })}
                              <TableCell className="text-xs text-right tabular-nums font-bold">{formatCurrency(fourMonthTotal)}</TableCell>
                            </TableRow>
                          );
                        });
                      })()}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

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
                  <PaymentTable payments={overduePayments} onRowClick={handlePaymentClick} serverDate={effectiveDate} />
                </CardContent>
              </Card>
            )}

            {/* Monthly sections */}
            {calendarMonths.map((m, mi) => {
              const monthPayments = activePayments.filter(p => isInMonth(p.due_date, m))
                .sort((a, b) => a.due_date.localeCompare(b.due_date));
              if (monthPayments.length === 0) return null;
              const monthPaid = monthPayments.reduce((s, p) => s + p.amount_paid, 0);
              const monthRemaining = monthPayments.reduce((s, p) => s + p.balance_remaining, 0);
              return (
                <Card key={m.label} className="bg-card border-border">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-semibold flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                      <span className="flex items-center gap-2">
                        <Calendar className="h-4 w-4" />
                        {m.label} — month {mi + 1} of 4 ({monthPayments.length} payments)
                      </span>
                      <span className="sm:ml-auto text-xs font-normal text-muted-foreground">
                        Paid: <span className="text-green-500 font-medium">{formatCurrency(monthPaid)}</span>
                        {" · "}Remaining: <span className={`font-medium ${monthRemaining > 0 ? "text-destructive" : "text-green-500"}`}>{formatCurrency(monthRemaining)}</span>
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <PaymentTable payments={monthPayments} onRowClick={handlePaymentClick} serverDate={effectiveDate} />
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : activeTab === "audit" ? (
          <AuditPanel
            audit={audit ?? null}
            onRefresh={refreshAll}
            isLoading={auditLoading}
            totalInvoices={totalInvoiceCount}
          />
        ) : null}
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
              <TableHead className="text-xs font-semibold">PO #</TableHead>
              <TableHead className="text-xs font-semibold text-right">Amount Due</TableHead>
              <TableHead className="text-xs font-semibold text-right">Paid</TableHead>
              <TableHead className="text-xs font-semibold text-right">Balance</TableHead>
              <TableHead className="text-xs font-semibold">Installment</TableHead>
              <TableHead className="text-xs font-semibold">Due Date</TableHead>
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
                p.payment_status === "void" ? "bg-muted/30 opacity-60" :
                overdue ? "bg-red-500/8 hover:bg-red-500/12" :
                "hover:bg-muted/40";

              return (
                <TableRow key={p.id} className={`border-border transition-colors cursor-pointer ${rowColor}`} onClick={() => onRowClick(p)}>
                  <TableCell className="text-xs">{p.vendor}</TableCell>
                  <TableCell className="text-xs font-mono">{p.invoice_number}</TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">{p.po_number ?? "—"}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">{formatCurrency(p.amount_due)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums text-green-500">{formatCurrency(p.amount_paid)}</TableCell>
                  <TableCell className={`text-xs text-right tabular-nums font-semibold ${p.balance_remaining > 0 ? "" : "text-green-500"}`}>
                    {formatCurrency(p.balance_remaining)}
                  </TableCell>
                  <TableCell className="text-xs">{p.installment_label ?? "—"}</TableCell>
                  <TableCell className="text-xs">{formatDate(p.due_date)}</TableCell>
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
                {p.installment_label && <span>{p.installment_label}</span>}
                <span>Paid: <span className="text-green-500">{formatCurrency(p.amount_paid)}</span></span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
