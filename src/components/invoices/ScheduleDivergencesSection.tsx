/**
 * ScheduleDivergencesSection
 *
 * Read-only audit view that surfaces invoices whose stored invoice_payments
 * rows diverge from what the current terms engine would produce.
 *
 * No "Fix" button — this is visibility only. Acting on a divergence
 * goes through the normal Recalculate flow with Guard 3.
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronDown, ChevronRight, GitCompare, Loader2, RefreshCw, Info } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/supabase-queries";
import { surveyScheduleDivergences, type DivergentInvoice } from "@/lib/divergence-survey";

type SortMode = "magnitude_days_desc" | "magnitude_dollars_desc" | "vendor_asc" | "invoice_asc";

export function ScheduleDivergencesSection() {
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [items, setItems] = useState<DivergentInvoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [vendorFilter, setVendorFilter] = useState<string>("all");
  const [sortMode, setSortMode] = useState<SortMode>("magnitude_days_desc");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const runSurvey = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await surveyScheduleDivergences();
      setItems(result);
      setHasRun(true);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  // Auto-run on first open
  useEffect(() => {
    if (open && !hasRun && !loading) runSurvey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const vendors = useMemo(
    () => Array.from(new Set(items.map((i) => i.vendor))).sort(),
    [items]
  );

  const filtered = useMemo(() => {
    let list = items;
    if (vendorFilter !== "all") list = list.filter((i) => i.vendor === vendorFilter);
    const sorted = [...list];
    switch (sortMode) {
      case "magnitude_days_desc":
        sorted.sort((a, b) => b.magnitude_days - a.magnitude_days);
        break;
      case "magnitude_dollars_desc":
        sorted.sort((a, b) => b.magnitude_dollars - a.magnitude_dollars);
        break;
      case "vendor_asc":
        sorted.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.invoice_number.localeCompare(b.invoice_number));
        break;
      case "invoice_asc":
        sorted.sort((a, b) => a.invoice_number.localeCompare(b.invoice_number));
        break;
    }
    return sorted;
  }, [items, vendorFilter, sortMode]);

  const vendorCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i.vendor, (m.get(i.vendor) ?? 0) + 1);
    return m;
  }, [items]);

  return (
    <div className="rounded-lg border border-border bg-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-4 py-3 hover:bg-muted/30 transition-colors">
          <div className="flex items-center gap-2">
            {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <GitCompare className="h-4 w-4 text-blue-500" />
            <span className="text-sm font-semibold">Schedule Divergences</span>
            {hasRun && (
              <Badge variant="outline" className="text-[10px]">
                {items.length} {items.length === 1 ? "invoice" : "invoices"}
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground ml-1">
              Stored schedules vs. current terms engine output
            </span>
          </div>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </CollapsibleTrigger>

        <CollapsibleContent className="px-4 pb-4 space-y-3">
          {/* Info banner */}
          <div className="flex items-start gap-2 rounded-md bg-blue-500/5 border border-blue-500/20 p-2.5">
            <Info className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0" />
            <p className="text-[11px] text-muted-foreground leading-snug">
              Read-only view. Stored payment rows are the source of truth — divergence is not automatically a bug.
              Skips invoices with paid rows or credit memos. To act on a divergence, use the standard Recalculate flow
              (Guard 3 will fire with typed confirmation).
            </p>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={runSurvey}
              disabled={loading}
              className="text-[11px] h-7"
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
              {hasRun ? "Re-scan" : "Run scan"}
            </Button>

            {hasRun && items.length > 0 && (
              <>
                <Select value={vendorFilter} onValueChange={setVendorFilter}>
                  <SelectTrigger className="w-[180px] h-7 text-[11px]">
                    <SelectValue placeholder="All vendors" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All vendors ({items.length})</SelectItem>
                    {vendors.map((v) => (
                      <SelectItem key={v} value={v}>
                        {v} ({vendorCounts.get(v)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
                  <SelectTrigger className="w-[200px] h-7 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="magnitude_days_desc">Sort: largest date shift</SelectItem>
                    <SelectItem value="magnitude_dollars_desc">Sort: largest $ delta</SelectItem>
                    <SelectItem value="vendor_asc">Sort: vendor A→Z</SelectItem>
                    <SelectItem value="invoice_asc">Sort: invoice # A→Z</SelectItem>
                  </SelectContent>
                </Select>
              </>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-md bg-red-500/10 border border-red-500/20 p-2.5">
              <p className="text-[11px] text-red-500">{error}</p>
            </div>
          )}

          {/* Empty / clean */}
          {hasRun && !loading && items.length === 0 && (
            <div className="rounded-md bg-emerald-500/5 border border-emerald-500/20 p-3 text-center">
              <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                ✓ No schedule divergences found
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                All eligible invoices match current engine output.
              </p>
            </div>
          )}

          {/* Results list */}
          {hasRun && filtered.length > 0 && (
            <div className="space-y-1.5">
              {filtered.map((d) => {
                const isExpanded = expandedId === d.invoice_id;
                return (
                  <div
                    key={d.invoice_id}
                    className="rounded-md border border-border bg-background overflow-hidden"
                  >
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : d.invoice_id)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-left"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                        )}
                        <span className="font-mono text-xs font-semibold">{d.invoice_number}</span>
                        <span className="text-[11px] text-muted-foreground">·</span>
                        <span className="text-[11px] text-muted-foreground truncate">{d.vendor}</span>
                        <span className="text-[11px] text-muted-foreground">·</span>
                        <span className="text-[11px] text-muted-foreground">{formatCurrency(d.total)}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {d.magnitude_days > 0 && (
                          <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600 dark:text-amber-400">
                            ±{d.magnitude_days}d
                          </Badge>
                        )}
                        {d.magnitude_dollars > 0 && (
                          <Badge variant="outline" className="text-[10px] border-red-500/40 text-red-600 dark:text-red-400">
                            ±${d.magnitude_dollars.toFixed(2)}
                          </Badge>
                        )}
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-border bg-muted/20 px-3 py-2.5 space-y-2">
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Summary</p>
                          <p className="text-[11px]">{d.summary}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
                            Invoice context
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Date: {formatDate(d.invoice_date)} · Terms: <span className="font-mono">{d.payment_terms ?? "—"}</span>
                          </p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                              Stored ({d.stored.length})
                            </p>
                            <div className="space-y-0.5">
                              {d.stored.map((r, i) => (
                                <div
                                  key={i}
                                  className="flex justify-between items-center text-[11px] font-mono px-2 py-1 rounded bg-background border border-border/60"
                                >
                                  <span>{r.due_date}</span>
                                  <span className="font-semibold">${r.amount_due.toFixed(2)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                              Engine output ({d.expected.length})
                            </p>
                            <div className="space-y-0.5">
                              {d.expected.map((r, i) => {
                                const stored = d.stored[i];
                                const diff = stored && stored.due_date !== r.due_date;
                                const amtDiff = stored && Math.abs(stored.amount_due - r.amount_due) > 0.01;
                                return (
                                  <div
                                    key={i}
                                    className={`flex justify-between items-center text-[11px] font-mono px-2 py-1 rounded border ${
                                      diff || amtDiff
                                        ? "bg-amber-500/5 border-amber-500/30"
                                        : "bg-background border-border/60"
                                    }`}
                                  >
                                    <span className={diff ? "text-amber-600 dark:text-amber-400 font-semibold" : ""}>
                                      {r.due_date}
                                    </span>
                                    <span className={`font-semibold ${amtDiff ? "text-amber-600 dark:text-amber-400" : ""}`}>
                                      ${r.amount_due.toFixed(2)}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* First-load hint */}
          {!hasRun && !loading && (
            <p className="text-[11px] text-muted-foreground italic">
              Click "Run scan" to compare every confirmed invoice against current engine output.
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
