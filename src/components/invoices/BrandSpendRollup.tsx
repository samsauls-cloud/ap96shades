/**
 * BrandSpendRollup — read-only purchased / paid / owed rollup by vendor → brand.
 *
 * READ-ONLY: this component only reads vendor_invoices, invoice_payments, and
 * the vendor_credit_balances view (via useVendorCreditBalanceMap). It never
 * writes to vendor_invoices, invoice_payments, or vendor_credits.
 *
 * Two variants:
 *   - "full"    → full panel with expandable brand sub-rows, header toggle for
 *                 "Net of vendor credits", and a refresh button.
 *   - "compact" → small card for the Reports page: 3 grand-total tiles + top-6
 *                 vendor table, remainder collapsed into "Other (N)".
 *
 * Net-of-credits model (header toggle, full variant):
 *   - Purchased and Paid never change with the toggle.
 *   - Only Still Owed changes, and only at the vendor / grand-total level
 *     (credits are an on-account balance per vendor, not per brand).
 *   - Net Owed (vendor) = max(Owed - AvailableCredit, 0).
 *   - Grand Net Owed = Σ per-vendor net owed (NOT grandOwed - Σcredits),
 *     so one vendor's credit surplus never cancels another vendor's debt.
 *   - Brand sub-rows always render gross owed.
 */
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, RefreshCw, ExternalLink, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { fetchAllRows } from "@/lib/supabase-fetch-all";
import { formatCurrency, getLineItems, isProforma, type VendorInvoice } from "@/lib/supabase-queries";
import { fetchPayments, type InvoicePayment } from "@/lib/payment-queries";
import { normalizeVendor } from "@/lib/invoice-dedup";
import { useVendorCreditBalanceMap } from "@/components/invoices/VendorCreditDrawer";
import { useQueryClient } from "@tanstack/react-query";

type Variant = "full" | "compact";

interface Props {
  variant?: Variant;
  defaultNetOfCredits?: boolean;
}

interface BrandBucket {
  brand: string;
  purchased: number;
  paid: number;
  owed: number;
}

interface UnscheduledInvoice {
  id: string;
  invoice_number: string | null;
  total: number;
}

interface VendorBucket {
  name: string; // canonical (normalizeVendor) display name
  purchased: number;
  paid: number;
  owed: number;
  brands: BrandBucket[];
  unscheduled: UnscheduledInvoice[];
}

const YEAR = new Date().getFullYear();
const SCHEDULE_TOLERANCE = 1; // dollars

function lineExtended(li: ReturnType<typeof getLineItems>[number]): number {
  if (typeof li.line_total === "number" && li.line_total) return li.line_total;
  const qty = (li.qty_shipped ?? li.qty_ordered ?? li.qty ?? 0) as number;
  const unit = (li.unit_price ?? 0) as number;
  return Number(qty) * Number(unit);
}

function buildRollup(invoices: VendorInvoice[], payments: InvoicePayment[]) {
  // YTD invoices, payable docs only — exclude voided invoices (no installment
  // schedule, so Paid/Owed would never reconcile against Purchased).
  const ytd = invoices.filter(i => {
    if (!i.invoice_date) return false;
    if (!String(i.invoice_date).startsWith(String(YEAR))) return false;
    if (isProforma(i as any)) return false;
    if (String((i as any).status || "").toLowerCase() === "void") return false;
    const dt = (i.doc_type || "").toUpperCase();
    return dt === "INVOICE";
  });

  // Per-invoice paid + schedule total from active (non-void) payments.
  // Owed is derived from the invoice header (Purchased - Paid), NOT from the
  // installment schedule — so the identity Purchased = Paid + Owed holds even
  // when an invoice was confirmed without a payment schedule.
  const paidByInvoice = new Map<string, number>();
  const scheduleByInvoice = new Map<string, number>();
  for (const p of payments) {
    if (p.payment_status === "void") continue;
    paidByInvoice.set(p.invoice_id, (paidByInvoice.get(p.invoice_id) ?? 0) + Number(p.amount_paid ?? 0));
    const inst = Number(p.amount_paid ?? 0) + Number(p.balance_remaining ?? 0);
    scheduleByInvoice.set(p.invoice_id, (scheduleByInvoice.get(p.invoice_id) ?? 0) + inst);
  }

  // group invoices by canonical vendor
  const vendorMap = new Map<string, {
    invoices: VendorInvoice[];
    purchased: number;
    paid: number;
    brandPurchased: Map<string, number>;
    unscheduled: UnscheduledInvoice[];
  }>();

  for (const inv of ytd) {
    const v = normalizeVendor(inv.vendor) || (inv.vendor ?? "Unknown");
    let bucket = vendorMap.get(v);
    if (!bucket) {
      bucket = { invoices: [], purchased: 0, paid: 0, brandPurchased: new Map(), unscheduled: [] };
      vendorMap.set(v, bucket);
    }
    bucket.invoices.push(inv);
    const invTotal = Number(inv.total ?? 0);
    const rawPaid = paidByInvoice.get(inv.id) ?? 0;
    // Clamp paid into [0, invTotal] so Owed = Purchased - Paid stays ≥ 0
    // even on edge cases (overpay, negative totals).
    const invPaid = Math.max(0, Math.min(rawPaid, Math.max(invTotal, 0)));
    bucket.purchased += invTotal;
    bucket.paid += invPaid;

    // Data-gap detection: no schedule rows, or schedule total drifts from header.
    const sched = scheduleByInvoice.get(inv.id);
    const hasSchedule = sched !== undefined && sched > 0;
    const drift = hasSchedule ? Math.abs((sched ?? 0) - invTotal) : invTotal;
    if (!hasSchedule || drift > SCHEDULE_TOLERANCE) {
      bucket.unscheduled.push({
        id: inv.id,
        invoice_number: (inv as any).invoice_number ?? null,
        total: invTotal,
      });
    }

    // Allocate this invoice's `total` across brands by line-item share, so
    // brand sub-rows sum exactly to the vendor's `total`-based purchased row.
    const items = getLineItems(inv);
    const perBrandRaw = new Map<string, number>();
    let rawSum = 0;
    for (const li of items) {
      const brand = (li.brand ?? "").trim() || "(unspecified)";
      const amt = lineExtended(li);
      if (!Number.isFinite(amt) || amt === 0) continue;
      perBrandRaw.set(brand, (perBrandRaw.get(brand) ?? 0) + amt);
      rawSum += amt;
    }
    if (rawSum > 0 && invTotal !== 0) {
      for (const [brand, raw] of perBrandRaw) {
        const share = (raw / rawSum) * invTotal;
        bucket.brandPurchased.set(brand, (bucket.brandPurchased.get(brand) ?? 0) + share);
      }
    } else if (perBrandRaw.size === 0 && invTotal !== 0) {
      // No line items — put the whole invoice under (unspecified) so the
      // brand rows still sum to the vendor total.
      bucket.brandPurchased.set("(unspecified)", (bucket.brandPurchased.get("(unspecified)") ?? 0) + invTotal);
    }
  }

  const vendors: VendorBucket[] = [];
  for (const [name, b] of vendorMap.entries()) {
    const paid = b.paid;
    const owed = Math.max(b.purchased - paid, 0);
    const brandsRaw = Array.from(b.brandPurchased.entries())
      .map(([brand, purchased]) => ({ brand, purchased }))
      .sort((a, z) => z.purchased - a.purchased);
    const sumLines = brandsRaw.reduce((s, x) => s + x.purchased, 0);
    const brands: BrandBucket[] = brandsRaw.map(x => {
      const share = sumLines > 0 ? x.purchased / sumLines : 0;
      const brandPaid = paid * share;
      return {
        brand: x.brand,
        purchased: x.purchased,
        paid: brandPaid,
        owed: Math.max(x.purchased - brandPaid, 0),
      };
    });
    vendors.push({ name, purchased: b.purchased, paid, owed, brands, unscheduled: b.unscheduled });
  }

  vendors.sort((a, z) => z.purchased - a.purchased);
  const grand = vendors.reduce(
    (s, v) => ({ purchased: s.purchased + v.purchased, paid: s.paid + v.paid, owed: s.owed + v.owed }),
    { purchased: 0, paid: 0, owed: 0 },
  );
  const unscheduledAll = vendors.flatMap(v => v.unscheduled);
  return { vendors, grand, unscheduledAll };
}

export default function BrandSpendRollup({ variant = "full", defaultNetOfCredits = false }: Props) {
  const qc = useQueryClient();
  const [netOfCredits, setNetOfCredits] = useState(defaultNetOfCredits);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: invoices = [], isLoading: loadingInv } = useQuery({
    queryKey: ["brand_spend_invoices"],
    queryFn: () => fetchAllRows<VendorInvoice>("vendor_invoices", { label: "brand_spend_invoices" }),
  });
  const { data: payments = [], isLoading: loadingPay } = useQuery({
    queryKey: ["invoice_payments"],
    queryFn: fetchPayments,
  });
  const getCreditBalance = useVendorCreditBalanceMap();

  const { vendors, grand, unscheduledAll } = useMemo(() => buildRollup(invoices, payments), [invoices, payments]);
  const unscheduledTotal = unscheduledAll.reduce((s, u) => s + u.total, 0);

  const availFor = (vendorName: string) => getCreditBalance(vendorName);
  const owedDisplay = (vendorName: string, grossOwed: number) =>
    netOfCredits ? Math.max(grossOwed - availFor(vendorName), 0) : grossOwed;
  const grandNetOwed = netOfCredits
    ? vendors.reduce((s, v) => s + Math.max(v.owed - availFor(v.name), 0), 0)
    : grand.owed;

  const loading = loadingInv || loadingPay;

  /* ── COMPACT VARIANT ─────────────────────────────────── */
  if (variant === "compact") {
    const TOP = 6;
    const shown = vendors.slice(0, TOP);
    const rest = vendors.slice(TOP);
    const other = rest.reduce(
      (a, v) => ({ purchased: a.purchased + v.purchased, paid: a.paid + v.paid, owed: a.owed + v.owed, n: a.n + 1 }),
      { purchased: 0, paid: 0, owed: 0, n: 0 },
    );
    return (
      <Card className="bg-card border-border">
        <CardHeader className="pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold">Purchased by Brand — {YEAR} YTD</CardTitle>
          <Link to="/invoices/dashboard" className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            View full <ExternalLink className="h-3 w-3" />
          </Link>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Purchased" value={grand.purchased} />
                <Stat label="Paid" value={grand.paid} tone="emerald" />
                <Stat label="Still Owed" value={grand.owed} tone="amber" />
              </div>
              <div className="overflow-hidden rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-semibold">Vendor</th>
                      <th className="text-right px-2 py-1.5 font-semibold">Purchased</th>
                      <th className="text-right px-2 py-1.5 font-semibold">Paid</th>
                      <th className="text-right px-2 py-1.5 font-semibold">Owed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(v => (
                      <tr key={v.name} className="border-t border-border">
                        <td className="px-2 py-1.5 font-medium">{v.name}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(v.purchased)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-emerald-500">{formatCurrency(v.paid)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-amber-500">{formatCurrency(v.owed)}</td>
                      </tr>
                    ))}
                    {rest.length > 0 && (
                      <tr className="border-t border-border text-muted-foreground">
                        <td className="px-2 py-1.5 italic">Other ({other.n})</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(other.purchased)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(other.paid)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(other.owed)}</td>
                      </tr>
                    )}
                    <tr className="border-t border-border bg-muted/30 font-semibold">
                      <td className="px-2 py-1.5">Total</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(grand.purchased)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-emerald-500">{formatCurrency(grand.paid)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-amber-500">{formatCurrency(grand.owed)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  /* ── FULL VARIANT ────────────────────────────────────── */
  const toggle = (name: string) => {
    const next = new Set(expanded);
    next.has(name) ? next.delete(name) : next.add(name);
    setExpanded(next);
  };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["brand_spend_invoices"] });
    qc.invalidateQueries({ queryKey: ["invoice_payments"] });
    qc.invalidateQueries({ queryKey: ["vendor_credit_balances"] });
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <CardTitle className="text-sm font-semibold">Purchased by Brand — {YEAR} YTD</CardTitle>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-emerald-500"
              checked={netOfCredits}
              onChange={(e) => setNetOfCredits(e.target.checked)}
            />
            Net of vendor credits
          </label>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={refresh}>
            <RefreshCw className="h-3 w-3 mr-1" /> Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : vendors.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">No {YEAR} invoices yet.</div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr className="border-b border-border">
                  <th className="text-left px-3 py-2 font-semibold w-8" />
                  <th className="text-left px-3 py-2 font-semibold">Vendor / Brand</th>
                  <th className="text-right px-3 py-2 font-semibold">Purchased</th>
                  <th className="text-right px-3 py-2 font-semibold">Paid</th>
                  <th className="text-right px-3 py-2 font-semibold">Still Owed</th>
                </tr>
              </thead>
              <tbody>
                {vendors.map(v => {
                  const open = expanded.has(v.name);
                  const credit = availFor(v.name);
                  const owedShown = owedDisplay(v.name, v.owed);
                  const creditRemaining = netOfCredits ? Math.max(credit - v.owed, 0) : 0;
                  return (
                    <Fragment key={v.name}>
                      <tr className="border-b border-border hover:bg-muted/20">
                        <td className="px-3 py-2 align-top">
                          <button
                            type="button"
                            onClick={() => toggle(v.name)}
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={open ? "Collapse" : "Expand"}
                          >
                            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                        </td>
                        <td className="px-3 py-2 font-medium">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span>{v.name}</span>
                            {credit > 0 && (
                              <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-emerald-500/40 text-emerald-400 bg-emerald-500/10">
                                Credit: {formatCurrency(credit)}
                              </Badge>
                            )}
                            {v.unscheduled.length > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[10px] h-4 px-1.5 border-amber-500/40 text-amber-400 bg-amber-500/10"
                                title={`Unscheduled invoice${v.unscheduled.length > 1 ? "s" : ""}: ${v.unscheduled.map(u => u.invoice_number || u.id.slice(0, 8)).join(", ")}`}
                              >
                                unscheduled{v.unscheduled.length > 1 ? ` ×${v.unscheduled.length}` : ""}
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(v.purchased)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-emerald-500">{formatCurrency(v.paid)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-amber-500">
                          {formatCurrency(owedShown)}
                          {netOfCredits && creditRemaining > 0 && (
                            <div className="text-[10px] text-emerald-400 font-normal">
                              +{formatCurrency(creditRemaining)} credit remaining
                            </div>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <>
                          <tr className="bg-muted/10">
                            <td />
                            <td colSpan={4} className="px-3 py-1.5 text-[10px] italic text-muted-foreground">
                              Credit applies at the vendor level; brand rows are gross.
                            </td>
                          </tr>
                          {v.brands.map(b => (
                            <tr key={`${v.name}::${b.brand}`} className="bg-muted/5 border-b border-border/60">
                              <td />
                              <td className="px-3 py-1.5 pl-8 text-muted-foreground">{b.brand}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(b.purchased)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-emerald-500/80">{formatCurrency(b.paid)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-amber-500/80">{formatCurrency(b.owed)}</td>
                            </tr>
                          ))}
                        </>
                      )}
                    </Fragment>
                  );
                })}
                <tr className="bg-muted/40 font-semibold border-t border-border">
                  <td />
                  <td className="px-3 py-2">Grand Total</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(grand.purchased)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-500">{formatCurrency(grand.paid)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-500">{formatCurrency(grandNetOwed)}</td>
                </tr>
              </tbody>
            </table>
            {unscheduledAll.length > 0 && (
              <div className="px-3 py-2 text-[11px] text-amber-400/90 border-t border-border bg-amber-500/5">
                {unscheduledAll.length} invoice{unscheduledAll.length === 1 ? "" : "s"} totaling {formatCurrency(unscheduledTotal)} are confirmed without a payment schedule and won't appear on the payment calendar.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "emerald" | "amber" }) {
  const toneCls = tone === "emerald" ? "text-emerald-500" : tone === "amber" ? "text-amber-500" : "";
  return (
    <div className="rounded border border-border bg-muted/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${toneCls}`}>{formatCurrency(value)}</div>
    </div>
  );
}
