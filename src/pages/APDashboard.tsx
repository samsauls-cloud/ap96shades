import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertCircle, CheckCircle2, Clock, Calendar, TrendingUp, Loader2, RefreshCw } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/supabase-queries";
import { fetchPayments, markPaymentPaid, markPaymentUnpaid, generateAllMissingPayments, type InvoicePayment } from "@/lib/payment-queries";
import { supabase } from "@/integrations/supabase/client";
import { addDays, format, startOfMonth, endOfMonth, addMonths, isBefore, isAfter, isSameMonth } from "date-fns";

type Tab = "summary" | "calendar";

interface AuditData {
  total_invoices: number;
  total_invoiced: number;
  lux_invoices: number;
  lux_total: number;
  has_payments: number;
  missing_payments: number;
  non_lux_vendors: string[];
}

function useAuditData() {
  return useQuery({
    queryKey: ["ap_audit"],
    queryFn: async (): Promise<AuditData> => {
      const { data: invoices } = await supabase
        .from("vendor_invoices")
        .select("id, vendor, total");
      const { data: payments } = await supabase
        .from("invoice_payments")
        .select("invoice_id");

      const allInv = invoices ?? [];
      const paymentInvoiceIds = new Set((payments ?? []).map((p: any) => p.invoice_id));
      const vendors = [...new Set(allInv.map(i => i.vendor))];
      const nonLux = vendors.filter(v => v !== "Luxottica");

      return {
        total_invoices: allInv.length,
        total_invoiced: allInv.reduce((s, i) => s + (i.total || 0), 0),
        lux_invoices: allInv.filter(i => i.vendor === "Luxottica").length,
        lux_total: allInv.filter(i => i.vendor === "Luxottica").reduce((s, i) => s + (i.total || 0), 0),
        has_payments: allInv.filter(i => paymentInvoiceIds.has(i.id)).length,
        missing_payments: allInv.filter(i => !paymentInvoiceIds.has(i.id)).length,
        non_lux_vendors: nonLux,
      };
    },
  });
}

function getUrgencyBucket(dueDate: string, today: Date) {
  const due = new Date(dueDate + "T00:00:00");
  const diffDays = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "overdue";
  if (diffDays <= 7) return "urgent";
  if (diffDays <= 30) return "plan";
  if (diffDays <= 60) return "forecast";
  if (diffDays <= 90) return "radar";
  return "future";
}

const BUCKET_CONFIG = {
  overdue: { label: "OVERDUE", emoji: "🔴", desc: "Pay immediately", color: "text-red-500 bg-red-500/10 border-red-500/20" },
  urgent: { label: "Due within 7 days", emoji: "🟠", desc: "Urgent", color: "text-orange-500 bg-orange-500/10 border-orange-500/20" },
  plan: { label: "Due in 8-30 days", emoji: "🟡", desc: "Plan ahead", color: "text-yellow-500 bg-yellow-500/10 border-yellow-500/20" },
  forecast: { label: "Due in 31-60 days", emoji: "🟢", desc: "Forecast", color: "text-green-500 bg-green-500/10 border-green-500/20" },
  radar: { label: "Due in 61-90 days", emoji: "🔵", desc: "On radar", color: "text-blue-500 bg-blue-500/10 border-blue-500/20" },
};

const MISSING_VENDORS = ["Kering", "Maui Jim", "Marcolin", "Safilo"];

export default function APDashboard() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("summary");
  const [generating, setGenerating] = useState(false);

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ["invoice_payments"],
    queryFn: fetchPayments,
  });

  const { data: audit } = useAuditData();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const unpaid = payments.filter(p => !p.is_paid);
  const totalOutstanding = unpaid.reduce((s, p) => s + Number(p.amount_due), 0);

  // Vendor summary
  const vendorSummary = (() => {
    const map = new Map<string, { totalInvoiced: number; totalPaid: number; outstanding: number; overdue: number; due30: number; due31_90: number }>();
    for (const p of payments) {
      if (!map.has(p.vendor)) map.set(p.vendor, { totalInvoiced: 0, totalPaid: 0, outstanding: 0, overdue: 0, due30: 0, due31_90: 0 });
      const v = map.get(p.vendor)!;
      v.totalInvoiced += Number(p.amount_due);
      if (p.is_paid) {
        v.totalPaid += Number(p.amount_due);
      } else {
        v.outstanding += Number(p.amount_due);
        const bucket = getUrgencyBucket(p.due_date, today);
        if (bucket === "overdue") v.overdue += Number(p.amount_due);
        else if (bucket === "urgent" || bucket === "plan") v.due30 += Number(p.amount_due);
        else v.due31_90 += Number(p.amount_due);
      }
    }
    return map;
  })();

  // Urgency buckets
  const buckets = (() => {
    const result: Record<string, { amount: number; count: number }> = {};
    for (const key of Object.keys(BUCKET_CONFIG)) {
      result[key] = { amount: 0, count: 0 };
    }
    for (const p of unpaid) {
      const bucket = getUrgencyBucket(p.due_date, today);
      if (result[bucket]) {
        result[bucket].amount += Number(p.amount_due);
        result[bucket].count++;
      }
    }
    return result;
  })();

  // 4-month calendar
  const calendarMonths = [0, 1, 2, 3].map(offset => {
    const monthStart = startOfMonth(addMonths(today, offset));
    const monthEnd = endOfMonth(monthStart);
    return { start: monthStart, end: monthEnd, label: format(monthStart, "MMMM yyyy") };
  });

  const overduePayments = unpaid.filter(p => isBefore(new Date(p.due_date + "T00:00:00"), today));

  const handleTogglePaid = async (payment: InvoicePayment) => {
    try {
      if (payment.is_paid) {
        await markPaymentUnpaid(payment.id);
        toast.success(`Unmarked — ${payment.invoice_number} installment ${payment.installment_label}`);
      } else {
        await markPaymentPaid(payment.id);
        toast.success(`✓ Marked paid — ${payment.invoice_number} installment ${payment.installment_label} — ${formatCurrency(Number(payment.amount_due))}`);
      }
      queryClient.invalidateQueries({ queryKey: ["invoice_payments"] });
      queryClient.invalidateQueries({ queryKey: ["ap_audit"] });
    } catch {
      toast.error("Failed to update payment");
    }
  };

  const handleGenerateAll = async () => {
    setGenerating(true);
    try {
      const result = await generateAllMissingPayments();
      toast.success(`Generated ${result.generated} payments for ${result.invoices} invoices`);
      queryClient.invalidateQueries({ queryKey: ["invoice_payments"] });
      queryClient.invalidateQueries({ queryKey: ["ap_audit"] });
    } catch (e: any) {
      toast.error(`Failed: ${e.message}`);
    } finally {
      setGenerating(false);
    }
  };

  // Check which vendors in system have invoices
  const vendorsInSystem = [...new Set(payments.map(p => p.vendor))];
  const missingVendors = MISSING_VENDORS.filter(v => !vendorsInSystem.includes(v));

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">

        {/* Data gap warning */}
        {missingVendors.length > 0 && (
          <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
            <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
              ⚠ Dashboard reflects Luxottica invoices only. {missingVendors.join(", ")} invoices have not been uploaded yet. Totals are incomplete. Upload remaining vendor invoices to see full AP picture.
            </p>
          </div>
        )}

        {/* Audit panel */}
        {audit && (
          <Card className="bg-card border-border">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">
                📊 <span className="font-medium text-foreground">Data Audit:</span>{" "}
                {audit.total_invoices} invoices in system · {formatCurrency(audit.total_invoiced)} total value
                · {audit.has_payments} have payment schedules · {audit.missing_payments} missing payment schedules
                {audit.non_lux_vendors.length === 0
                  ? " · ⚠ Non-Lux vendors: 0 invoices — upload needed"
                  : ` · Other vendors: ${audit.non_lux_vendors.join(", ")}`
                }
              </p>
              {audit.missing_payments > 0 && (
                <Button size="sm" variant="outline" className="mt-2 text-xs h-7" onClick={handleGenerateAll} disabled={generating}>
                  {generating ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                  Generate All Missing Payments
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* Tabs */}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={activeTab === "summary" ? "default" : "outline"}
            className="text-xs h-8"
            onClick={() => setActiveTab("summary")}
          >
            <TrendingUp className="h-3.5 w-3.5 mr-1" /> AP Summary
          </Button>
          <Button
            size="sm"
            variant={activeTab === "calendar" ? "default" : "outline"}
            className="text-xs h-8"
            onClick={() => setActiveTab("calendar")}
          >
            <Calendar className="h-3.5 w-3.5 mr-1" /> 4-Month View
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : activeTab === "summary" ? (
          <div className="space-y-6">
            {/* Vendor Summary Table */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Vendor Summary</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border">
                        <TableHead className="text-xs font-semibold">Vendor</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Total Invoiced</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Total Paid</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Outstanding</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Overdue</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Due ≤30d</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Due 31-90d</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...vendorSummary.entries()].map(([vendor, v]) => (
                        <TableRow key={vendor} className="border-border">
                          <TableCell className="text-xs font-medium">{vendor}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums">{formatCurrency(v.totalInvoiced)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums">{formatCurrency(v.totalPaid)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums font-medium">{formatCurrency(v.outstanding)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums text-red-500 font-medium">{formatCurrency(v.overdue)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums">{formatCurrency(v.due30)}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums">{formatCurrency(v.due31_90)}</TableCell>
                        </TableRow>
                      ))}
                      {/* Grand total */}
                      <TableRow className="border-border bg-muted/50 font-semibold">
                        <TableCell className="text-xs">GRAND TOTAL</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          {formatCurrency([...vendorSummary.values()].reduce((s, v) => s + v.totalInvoiced, 0))}
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          {formatCurrency([...vendorSummary.values()].reduce((s, v) => s + v.totalPaid, 0))}
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          {formatCurrency([...vendorSummary.values()].reduce((s, v) => s + v.outstanding, 0))}
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums text-red-500">
                          {formatCurrency([...vendorSummary.values()].reduce((s, v) => s + v.overdue, 0))}
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          {formatCurrency([...vendorSummary.values()].reduce((s, v) => s + v.due30, 0))}
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          {formatCurrency([...vendorSummary.values()].reduce((s, v) => s + v.due31_90, 0))}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* Urgency Buckets */}
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
        ) : (
          /* 4-Month Calendar View */
          <div className="space-y-6">

            {/* Summary Grid */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">4-Month Rolling Summary</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border">
                        <TableHead className="text-xs font-semibold">Vendor</TableHead>
                        {calendarMonths.map(m => (
                          <TableHead key={m.label} className="text-xs font-semibold text-center" colSpan={2}>
                            {m.label}
                          </TableHead>
                        ))}
                        <TableHead className="text-xs font-semibold text-right">4-Mo Total</TableHead>
                      </TableRow>
                      <TableRow className="border-border">
                        <TableHead className="text-[10px]"></TableHead>
                        {calendarMonths.map(m => (
                          <>
                            <TableHead key={m.label + "-due"} className="text-[10px] text-right">Total Due</TableHead>
                            <TableHead key={m.label + "-rem"} className="text-[10px] text-right">Remaining</TableHead>
                          </>
                        ))}
                        <TableHead className="text-[10px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(() => {
                        const vendors = [...new Set(payments.map(p => p.vendor))];
                        return [...vendors, "ALL VENDORS"].map(vendor => {
                          const isTotal = vendor === "ALL VENDORS";
                          const vPayments = isTotal ? payments : payments.filter(p => p.vendor === vendor);
                          let fourMonthTotal = 0;
                          return (
                            <TableRow key={vendor} className={`border-border ${isTotal ? "bg-muted/50 font-semibold" : ""}`}>
                              <TableCell className="text-xs">{vendor}</TableCell>
                              {calendarMonths.map(m => {
                                const monthPayments = vPayments.filter(p => {
                                  const d = new Date(p.due_date + "T00:00:00");
                                  return isSameMonth(d, m.start);
                                });
                                const totalDue = monthPayments.reduce((s, p) => s + Number(p.amount_due), 0);
                                const remaining = monthPayments.filter(p => !p.is_paid).reduce((s, p) => s + Number(p.amount_due), 0);
                                fourMonthTotal += totalDue;
                                return (
                                  <>
                                    <TableCell key={m.label + "-due"} className="text-xs text-right tabular-nums">{formatCurrency(totalDue)}</TableCell>
                                    <TableCell key={m.label + "-rem"} className={`text-xs text-right tabular-nums font-semibold ${remaining > 0 ? "" : "text-green-600 dark:text-green-400"}`}>{formatCurrency(remaining)}</TableCell>
                                  </>
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
                    🔴 OVERDUE — UNPAID PAST DUE ({overduePayments.length} payments)
                  </CardTitle>
                  <p className="text-[10px] text-muted-foreground">These roll over until marked paid.</p>
                </CardHeader>
                <CardContent className="p-0">
                  <PaymentTable payments={overduePayments} onToggle={handleTogglePaid} />
                </CardContent>
              </Card>
            )}

            {/* Monthly sections */}
            {calendarMonths.map((m, mi) => {
              const monthPayments = payments.filter(p => {
                const d = new Date(p.due_date + "T00:00:00");
                return isSameMonth(d, m.start);
              }).sort((a, b) => a.due_date.localeCompare(b.due_date));

              if (monthPayments.length === 0) return null;
              return (
                <Card key={m.label} className="bg-card border-border">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Calendar className="h-4 w-4" />
                      {m.label} — rolling month {mi + 1} of 4 ({monthPayments.length} payments)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <PaymentTable payments={monthPayments} onToggle={handleTogglePaid} />
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PaymentTable({ payments, onToggle }: { payments: InvoicePayment[]; onToggle: (p: InvoicePayment) => void }) {
  return (
    <div className="overflow-auto">
      <Table>
        <TableHeader>
          <TableRow className="border-border bg-muted/30">
            <TableHead className="text-xs font-semibold">Vendor</TableHead>
            <TableHead className="text-xs font-semibold">Invoice #</TableHead>
            <TableHead className="text-xs font-semibold">PO #</TableHead>
            <TableHead className="text-xs font-semibold text-right">Invoice Amt</TableHead>
            <TableHead className="text-xs font-semibold">Terms</TableHead>
            <TableHead className="text-xs font-semibold">Installment</TableHead>
            <TableHead className="text-xs font-semibold">Due Date</TableHead>
            <TableHead className="text-xs font-semibold text-right">Amt Due</TableHead>
            <TableHead className="text-xs font-semibold text-center">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.map(p => (
            <TableRow
              key={p.id}
              className={`border-border transition-colors ${
                p.is_paid
                  ? "bg-green-500/8 hover:bg-green-500/12"
                  : "hover:bg-muted/40"
              }`}
            >
              <TableCell className="text-xs">{p.vendor}</TableCell>
              <TableCell className="text-xs font-mono">{p.invoice_number}</TableCell>
              <TableCell className="text-xs font-mono text-muted-foreground">{p.po_number ?? "—"}</TableCell>
              <TableCell className="text-xs text-right tabular-nums">{formatCurrency(Number(p.invoice_amount))}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{p.terms ?? "—"}</TableCell>
              <TableCell className="text-xs">{p.installment_label ?? "—"}</TableCell>
              <TableCell className="text-xs">{formatDate(p.due_date)}</TableCell>
              <TableCell className={`text-xs text-right tabular-nums font-semibold ${p.is_paid ? "line-through text-muted-foreground" : ""}`}>
                {formatCurrency(Number(p.amount_due))}
              </TableCell>
              <TableCell className="text-center">
                <button
                  onClick={() => onToggle(p)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all cursor-pointer border ${
                    p.is_paid
                      ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30 hover:bg-green-500/25"
                      : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {p.is_paid ? (
                    <><CheckCircle2 className="h-3.5 w-3.5" /> Paid</>
                  ) : (
                    <><Clock className="h-3.5 w-3.5" /> Unpaid</>
                  )}
                </button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
