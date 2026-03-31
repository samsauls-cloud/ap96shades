import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertTriangle, CheckCircle2, XCircle, ChevronDown, ChevronRight,
  ShieldCheck, Link2, Package, CreditCard,
} from "lucide-react";
import { useState } from "react";
import { formatCurrency, formatDate, getLineItems } from "@/lib/supabase-queries";
import { buildLSMatchResults, getVendorAliases } from "@/lib/ls-match-engine";

/* ── Types ── */
type StatusLevel = "clean" | "warning" | "error";

function StatusBadge({ level }: { level: StatusLevel }) {
  if (level === "clean") return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-[9px]">✅ CLEAN</Badge>;
  if (level === "warning") return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 text-[9px]">⚠ WARNING</Badge>;
  return <Badge className="bg-destructive/15 text-destructive border-destructive/30 text-[9px]">🚨 ERROR</Badge>;
}

function AuditSection({ title, icon: Icon, status, defaultOpen, children }: {
  title: string; icon: any; status: StatusLevel; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex items-center gap-2 w-full text-left px-3 py-2.5 hover:bg-accent/30 rounded-lg transition-colors border border-border">
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <Icon className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold flex-1">{title}</span>
          <StatusBadge level={status} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-4 pr-2 space-y-3 pb-4 pt-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/* ── Main Component ── */
interface Props {
  invoices: any[];
  payments: any[];
  recSessions: any[];
  recLines: any[];
}

export function ReconciliationAuditPanel({ invoices, payments, recSessions, recLines }: Props) {
  const inv = useMemo(() => invoices.filter(i => i.doc_type === "INVOICE"), [invoices]);

  /* ═══ AUDIT 1: Reconciliation Engine Accuracy ═══ */
  const audit1 = useMemo(() => {
    // Check 1: Cross-vendor mismatches
    const crossVendor: { invoiceVendor: string; invoiceNumber: string; sessionVendor: string; sessionName: string }[] = [];
    for (const i of inv) {
      if (!i.reconciled_session_id) continue;
      const s = recSessions.find((s: any) => s.id === i.reconciled_session_id);
      if (!s) continue;
      // Allow known aliases
      const aliases = getVendorAliases(i.vendor);
      if (i.vendor !== s.vendor && !aliases.includes(s.vendor)) {
        crossVendor.push({ invoiceVendor: i.vendor, invoiceNumber: i.invoice_number, sessionVendor: s.vendor, sessionName: s.session_name });
      }
    }

    // Check 2: Sessions linked to >1 invoice
    const sessionInvMap = new Map<string, string[]>();
    for (const i of inv) {
      if (!i.reconciled_session_id) continue;
      const arr = sessionInvMap.get(i.reconciled_session_id) ?? [];
      arr.push(i.invoice_number);
      sessionInvMap.set(i.reconciled_session_id, arr);
    }
    const doubleLinked = Array.from(sessionInvMap.entries())
      .filter(([, nums]) => nums.length > 1)
      .map(([sid, nums]) => {
        const s = recSessions.find((s: any) => s.id === sid);
        return { sessionName: s?.session_name ?? sid, vendor: s?.vendor ?? "?", invoices: nums };
      });

    // Check 3: Qty variance (via LS match engine)
    const lsResults = buildLSMatchResults(invoices, recSessions, recLines);
    const qtyVariances = lsResults.filter(r => r.status === "partial" && r.qtyVariance > 0);

    // Check 4: Match summary by vendor
    const vendorSummary = new Map<string, { total: number; matched: number; unmatched: number }>();
    for (const r of lsResults) {
      const cur = vendorSummary.get(r.vendor) ?? { total: 0, matched: 0, unmatched: 0 };
      cur.total++;
      if (r.status !== "not_found") cur.matched++; else cur.unmatched++;
      vendorSummary.set(r.vendor, cur);
    }

    const status: StatusLevel = crossVendor.length > 0 ? "error"
      : (doubleLinked.length > 0 || qtyVariances.length > 0) ? "warning" : "clean";

    const summary = crossVendor.length > 0
      ? `${crossVendor.length} cross-vendor mismatch${crossVendor.length !== 1 ? "es" : ""} found`
      : doubleLinked.length > 0
      ? `${doubleLinked.length} session(s) linked to multiple invoices`
      : qtyVariances.length > 0
      ? `${qtyVariances.length} invoice(s) with qty variances`
      : "All invoice→session links verified";

    return { crossVendor, doubleLinked, qtyVariances, vendorSummary: Array.from(vendorSummary.entries()).sort((a, b) => b[1].total - a[1].total), status, lsResults, summary };
  }, [inv, invoices, recSessions, recLines]);

  /* ═══ AUDIT 2: Missing Lightspeed POs ═══ */
  const audit2 = useMemo(() => {
    const unmatched = audit1.lsResults.filter(r => r.status === "not_found");
    // Group by vendor
    const byVendor = new Map<string, { invoices: typeof unmatched; totalValue: number }>();
    for (const r of unmatched) {
      const cur = byVendor.get(r.vendor) ?? { invoices: [], totalValue: 0 };
      cur.invoices.push(r);
      cur.totalValue += r.invoiceTotal;
      byVendor.set(r.vendor, cur);
    }

    // Get PO numbers for unmatched invoices
    const unmatchedWithPO = unmatched.map(r => {
      const i = inv.find((i: any) => i.id === r.invoiceId);
      return { ...r, poNumber: i?.po_number ?? "—", invoiceDate: i?.invoice_date ?? "", lineCount: getLineItems(i).length };
    });

    // Unknown vendor lines
    // Derive known vendor IDs dynamically from receiving sessions
    const knownVendorIds = new Set(
      (recSessions as any[]).map((s: any) => s.vendor).filter(Boolean)
    );
    // Also include vendor_ids actually referenced in recLines
    for (const l of recLines as any[]) {
      if (l.vendor_id) knownVendorIds.add(l.vendor_id);
    }
    // Filter to lines whose vendor_id doesn't map to any session vendor
    const sessionVendorIds = new Set((recSessions as any[]).flatMap((s: any) => {
      // Collect vendor_ids from lines belonging to this session
      return (recLines as any[]).filter((l: any) => l.session_id === s.id).map((l: any) => l.vendor_id).filter(Boolean);
    }));
    const unknownLines = (recLines as any[]).filter(l =>
      !l.vendor_id || !sessionVendorIds.has(l.vendor_id)
    );
    const unknownByVendorId = new Map<string, any[]>();
    for (const l of unknownLines) {
      const vid = l.vendor_id ?? "NULL";
      const arr = unknownByVendorId.get(vid) ?? [];
      arr.push(l);
      unknownByVendorId.set(vid, arr);
    }

    const status: StatusLevel = unmatched.length > 10 ? "error" : unmatched.length > 0 ? "warning" : "clean";
    return { byVendor: Array.from(byVendor.entries()).sort((a, b) => b[1].totalValue - a[1].totalValue), unmatchedWithPO, unknownByVendorId, unknownLines, status };
  }, [audit1.lsResults, inv, recLines]);

  /* ═══ AUDIT 3: Payment Schedule Completeness ═══ */
  const audit3 = useMemo(() => {
    const payByInvoice = new Map<string, { rows: number; totalScheduled: number }>();
    for (const p of payments as any[]) {
      if (!p.invoice_id) continue;
      const cur = payByInvoice.get(p.invoice_id) ?? { rows: 0, totalScheduled: 0 };
      cur.rows++;
      cur.totalScheduled += Number(p.amount_due) || 0;
      payByInvoice.set(p.invoice_id, cur);
    }

    const issues: { vendor: string; invoiceNumber: string; total: number; paymentRows: number; scheduledTotal: number; gap: number; type: string }[] = [];
    for (const i of inv) {
      const pay = payByInvoice.get(i.id);
      const rows = pay?.rows ?? 0;
      const scheduled = pay?.totalScheduled ?? 0;
      const gap = Number(i.total) - scheduled;
      if (rows === 0) {
        issues.push({ vendor: i.vendor, invoiceNumber: i.invoice_number, total: Number(i.total), paymentRows: 0, scheduledTotal: 0, gap, type: "MISSING PAYMENTS" });
      } else if (Math.abs(gap) > 0.01) {
        issues.push({ vendor: i.vendor, invoiceNumber: i.invoice_number, total: Number(i.total), paymentRows: rows, scheduledTotal: scheduled, gap, type: "PAYMENT SUM MISMATCH" });
      }
    }
    issues.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

    const status: StatusLevel = issues.some(i => i.type === "MISSING PAYMENTS") ? "error"
      : issues.length > 0 ? "warning" : "clean";
    return { issues, status };
  }, [inv, payments]);

  /* ═══ Health Score ═══ */
  const passing = [audit1.status === "clean", audit2.status === "clean", audit3.status === "clean"].filter(Boolean).length;

  return (
    <div className="space-y-4">
      {/* Health Score */}
      <Card className={`border-2 ${passing === 3 ? "border-emerald-500/40 bg-emerald-500/5" : passing >= 2 ? "border-amber-500/40 bg-amber-500/5" : "border-destructive/40 bg-destructive/5"}`}>
        <CardContent className="p-4 flex items-center gap-3">
          <ShieldCheck className={`h-6 w-6 ${passing === 3 ? "text-emerald-500" : passing >= 2 ? "text-amber-500" : "text-destructive"}`} />
          <div>
            <p className="text-sm font-bold">
              Reconciliation Health: {passing}/3 checks passing
            </p>
            <p className="text-[10px] text-muted-foreground">
              {passing === 3 ? "All reconciliation checks are clean" : `${3 - passing} check(s) need attention`}
            </p>
          </div>
          <div className="ml-auto flex gap-1.5">
            <StatusBadge level={audit1.status} />
            <StatusBadge level={audit2.status} />
            <StatusBadge level={audit3.status} />
          </div>
        </CardContent>
      </Card>

      {/* ── AUDIT 1: Engine Accuracy ── */}
      <AuditSection title="Audit 1 — Reconciliation Engine Accuracy" icon={ShieldCheck} status={audit1.status} defaultOpen>
        {/* Cross-vendor mismatches */}
        <Card className={`bg-card ${audit1.crossVendor.length > 0 ? "border-destructive/30" : "border-emerald-500/30"}`}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              {audit1.crossVendor.length > 0 ? <XCircle className="h-4 w-4 text-destructive" /> : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
              <span className="text-xs font-semibold">Cross-Vendor Mismatches</span>
              <Badge variant="outline" className="text-[9px] ml-auto">{audit1.crossVendor.length} found</Badge>
            </div>
            {audit1.crossVendor.length === 0 ? (
              <p className="text-[10px] text-emerald-500">✅ No cross-vendor mismatches — all invoice→session links match expected vendors</p>
            ) : (
              <div className="overflow-auto max-h-[200px]">
                <Table>
                  <TableHeader><TableRow className="border-border">
                    <TableHead className="text-[10px]">Invoice</TableHead>
                    <TableHead className="text-[10px]">Invoice Vendor</TableHead>
                    <TableHead className="text-[10px]">Session Vendor</TableHead>
                    <TableHead className="text-[10px]">Session</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {audit1.crossVendor.map((m, i) => (
                      <TableRow key={i} className="border-border bg-destructive/5">
                        <TableCell className="text-[10px] font-mono">{m.invoiceNumber}</TableCell>
                        <TableCell className="text-[10px]">{m.invoiceVendor}</TableCell>
                        <TableCell className="text-[10px] text-destructive font-semibold">{m.sessionVendor}</TableCell>
                        <TableCell className="text-[10px] text-muted-foreground">{m.sessionName}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Double-linked sessions */}
        <Card className={`bg-card ${audit1.doubleLinked.length > 0 ? "border-amber-500/30" : "border-emerald-500/30"}`}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              {audit1.doubleLinked.length > 0 ? <Link2 className="h-4 w-4 text-amber-500" /> : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
              <span className="text-xs font-semibold">Sessions Linked to Multiple Invoices</span>
              <Badge variant="outline" className="text-[9px] ml-auto">{audit1.doubleLinked.length} found</Badge>
            </div>
            {audit1.doubleLinked.length === 0 ? (
              <p className="text-[10px] text-emerald-500">✅ No double-counting risk — each session links to at most 1 invoice</p>
            ) : (
              <div className="space-y-1.5">
                {audit1.doubleLinked.map((d, i) => (
                  <div key={i} className="rounded border border-amber-500/20 p-2 text-[10px]">
                    <p className="font-semibold">{d.sessionName} <span className="text-muted-foreground">({d.vendor})</span></p>
                    <p className="text-amber-500">⚠ Linked to {d.invoices.length} invoices: <span className="font-mono">{d.invoices.join(", ")}</span></p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Match summary by vendor */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2"><CardTitle className="text-xs font-semibold">Match Summary by Vendor</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader><TableRow className="border-border">
                <TableHead className="text-[10px]">Vendor</TableHead>
                <TableHead className="text-[10px] text-right">Invoices</TableHead>
                <TableHead className="text-[10px] text-right">Matched</TableHead>
                <TableHead className="text-[10px] text-right">Unmatched</TableHead>
                <TableHead className="text-[10px] text-right">Match %</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {audit1.vendorSummary.map(([v, d]) => (
                  <TableRow key={v} className="border-border">
                    <TableCell className="text-xs font-medium">{v}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{d.total}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums text-emerald-500">{d.matched}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums text-destructive">{d.unmatched}</TableCell>
                    <TableCell className={`text-xs text-right tabular-nums font-semibold ${d.matched / d.total >= 1 ? "text-emerald-500" : d.matched / d.total >= 0.5 ? "text-amber-500" : "text-destructive"}`}>
                      {(d.matched / d.total * 100).toFixed(1)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </AuditSection>

      {/* ── AUDIT 2: Missing Lightspeed POs ── */}
      <AuditSection title="Audit 2 — Missing Lightspeed POs (Export Pull List)" icon={Package} status={audit2.status} defaultOpen>
        {audit2.byVendor.map(([vendor, data]) => (
          <Card key={vendor} className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold flex items-center justify-between">
                <span>📋 {vendor}</span>
                <span className="text-[10px] text-muted-foreground font-normal">{data.invoices.length} unmatched · {formatCurrency(data.totalValue)}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-[250px] overflow-auto">
                <Table>
                  <TableHeader><TableRow className="border-border">
                    <TableHead className="text-[10px]">Invoice #</TableHead>
                    <TableHead className="text-[10px]">PO Number</TableHead>
                    <TableHead className="text-[10px]">Date</TableHead>
                    <TableHead className="text-[10px] text-right">Total</TableHead>
                    <TableHead className="text-[10px] text-right">Lines</TableHead>
                    <TableHead className="text-[10px] text-right">Qty</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {audit2.unmatchedWithPO.filter(r => r.vendor === vendor).map(r => (
                      <TableRow key={r.invoiceId} className="border-border">
                        <TableCell className="text-[10px] font-mono">{r.invoiceNumber}</TableCell>
                        <TableCell className="text-[10px] font-mono text-primary">{r.poNumber}</TableCell>
                        <TableCell className="text-[10px]">{formatDate(r.invoiceDate)}</TableCell>
                        <TableCell className="text-[10px] text-right tabular-nums">{formatCurrency(r.invoiceTotal)}</TableCell>
                        <TableCell className="text-[10px] text-right tabular-nums">{r.lineCount}</TableCell>
                        <TableCell className="text-[10px] text-right tabular-nums">{r.invoiceQtyShipped}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ))}

        {/* PO pull list summary */}
        {audit2.byVendor.length > 0 && (
          <Card className="bg-primary/5 border-primary/30">
            <CardContent className="p-4">
              <p className="text-xs font-semibold mb-2">📥 PO Numbers to Export from Lightspeed:</p>
              {audit2.byVendor.map(([vendor, data]) => {
                const poNumbers = [...new Set(audit2.unmatchedWithPO.filter(r => r.vendor === vendor).map(r => r.poNumber).filter(p => p !== "—"))];
                return (
                  <div key={vendor} className="mb-2">
                    <p className="text-[10px] font-semibold text-foreground">{vendor} ({data.invoices.length} invoices, {formatCurrency(data.totalValue)}):</p>
                    <p className="text-[10px] font-mono text-primary break-all">{poNumbers.length > 0 ? poNumbers.join(", ") : "No PO numbers on file"}</p>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        {/* Unknown vendor lines */}
        {audit2.unknownLines.length > 0 && (
          <Card className="bg-card border-amber-500/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold text-amber-500">
                🔍 Unknown Vendor ID Lines ({audit2.unknownLines.length} lines)
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0 space-y-3">
              {Array.from(audit2.unknownByVendorId.entries()).map(([vid, lines]) => {
                // Identify likely vendor from descriptions
                const sampleDescs = lines.slice(0, 3).map(l => l.item_description ?? "—");
                const likelyVendor = sampleDescs[0]?.includes("MAUI JIM") ? "Maui Jim"
                  : sampleDescs[0]?.includes("COSTA") ? "Luxottica (Costa)"
                  : sampleDescs[0]?.includes("OAKLEY") ? "Luxottica (Oakley)"
                  : sampleDescs[0]?.includes("LACOSTE") || sampleDescs[0]?.includes("NIKE") || sampleDescs[0]?.includes("COLUMBIA") ? "Marchon"
                  : sampleDescs[0]?.includes("CHANEL") ? "Luxottica (Chanel)"
                  : "Unknown";
                const totalQty = lines.reduce((s: number, l: any) => s + (Number(l.received_qty) || 0), 0);
                const totalCost = lines.reduce((s: number, l: any) => s + ((Number(l.received_qty) || 0) * (Number(l.unit_cost) || 0)), 0);
                return (
                  <div key={vid}>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[10px] font-semibold">
                        vendor_id = <span className="font-mono text-amber-500">{vid}</span>
                        <span className="text-muted-foreground ml-2">→ Likely: <span className="text-foreground font-semibold">{likelyVendor}</span></span>
                      </p>
                      <p className="text-[10px] text-muted-foreground">{lines.length} lines · {totalQty} units · {formatCurrency(totalCost)}</p>
                    </div>
                    <div className="max-h-[120px] overflow-auto rounded border border-border">
                      <Table>
                        <TableHeader><TableRow className="border-border">
                          <TableHead className="text-[9px]">Description</TableHead>
                          <TableHead className="text-[9px]">UPC</TableHead>
                          <TableHead className="text-[9px] text-right">Qty</TableHead>
                          <TableHead className="text-[9px] text-right">Cost</TableHead>
                        </TableRow></TableHeader>
                        <TableBody>
                          {lines.slice(0, 8).map((l: any, i: number) => (
                            <TableRow key={i} className="border-border">
                              <TableCell className="text-[9px] max-w-[300px] truncate">{l.item_description}</TableCell>
                              <TableCell className="text-[9px] font-mono">{l.upc}</TableCell>
                              <TableCell className="text-[9px] text-right tabular-nums">{l.received_qty}</TableCell>
                              <TableCell className="text-[9px] text-right tabular-nums">{formatCurrency(Number(l.unit_cost) || 0)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </AuditSection>

      {/* ── AUDIT 3: Payment Schedule Completeness ── */}
      <AuditSection title="Audit 3 — Payment Schedule Completeness" icon={CreditCard} status={audit3.status} defaultOpen>
        {audit3.issues.length === 0 ? (
          <div className="flex items-center gap-2 text-emerald-500 py-2">
            <CheckCircle2 className="h-5 w-5" />
            <p className="text-sm font-medium">All {inv.length} invoices have complete payment schedules ✅</p>
          </div>
        ) : (
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold">{audit3.issues.length} Invoice(s) with Payment Schedule Issues</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-[300px] overflow-auto">
                <Table>
                  <TableHeader><TableRow className="border-border">
                    <TableHead className="text-[10px]">Status</TableHead>
                    <TableHead className="text-[10px]">Invoice #</TableHead>
                    <TableHead className="text-[10px]">Vendor</TableHead>
                    <TableHead className="text-[10px] text-right">Invoice Total</TableHead>
                    <TableHead className="text-[10px] text-right">Rows</TableHead>
                    <TableHead className="text-[10px] text-right">Scheduled</TableHead>
                    <TableHead className="text-[10px] text-right">Gap</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {audit3.issues.map((issue, i) => (
                      <TableRow key={i} className={`border-border ${issue.type === "MISSING PAYMENTS" ? "bg-destructive/5" : "bg-amber-500/5"}`}>
                        <TableCell>
                          <Badge variant="outline" className={`text-[8px] ${issue.type === "MISSING PAYMENTS" ? "text-destructive border-destructive/30" : "text-amber-600 border-amber-500/30"}`}>
                            ⚠ {issue.type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-[10px] font-mono">{issue.invoiceNumber}</TableCell>
                        <TableCell className="text-[10px]">{issue.vendor}</TableCell>
                        <TableCell className="text-[10px] text-right tabular-nums">{formatCurrency(issue.total)}</TableCell>
                        <TableCell className="text-[10px] text-right tabular-nums">{issue.paymentRows}</TableCell>
                        <TableCell className="text-[10px] text-right tabular-nums">{formatCurrency(issue.scheduledTotal)}</TableCell>
                        <TableCell className="text-[10px] text-right tabular-nums font-semibold text-destructive">{formatCurrency(issue.gap)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}
      </AuditSection>
    </div>
  );
}
