/**
 * PendingMigrationSection
 *
 * Audit Panel section that surfaces a pre-flight impact report for an
 * Option B engine-change migration. Read-only by default — the migration
 * runs ONLY when Josh clicks "Approve Migration" after reviewing.
 *
 * Currently scoped to the Maui Jim "Split Payment EOM" backfill.
 * Phase 2 (Kering addMonthsFromEom) is NOT wired here — separate report
 * to be added after Phase 1 verification.
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, Database, Loader2, RefreshCw, AlertTriangle, ShieldAlert, CheckCircle2, Ban, Calendar } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/supabase-queries";
import { buildMauiEomMigrationReport, executeMigration, type MigrationCandidate, type MigrationImpactReport, type MigrationExecutionResult } from "@/lib/engine-migrations";
import { toast } from "sonner";

interface Props {
  onCompleted?: () => void;
  defaultOpen?: boolean;
}

export function PendingMigrationSection({ onCompleted, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [report, setReport] = useState<MigrationImpactReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState("");
  const [executing, setExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<MigrationExecutionResult | null>(null);

  const buildReport = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await buildMauiEomMigrationReport();
      setReport(r);
      setHasRun(true);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && !hasRun && !loading) buildReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const eligible = useMemo(
    () => (report?.candidates ?? []).filter((c) => !c.blocked_by_guard1_credit && !c.blocked_by_guard2_paid),
    [report]
  );
  const blocked = useMemo(
    () => (report?.candidates ?? []).filter((c) => c.blocked_by_guard1_credit || c.blocked_by_guard2_paid),
    [report]
  );

  const counts = useMemo(() => {
    if (!report) return { total: 0, p1: 0, p2: 0, large: 0, past: 0 };
    return {
      total: report.candidates.length,
      p1: report.candidates.filter((c) => c.pattern === "pattern_1_plain_addDays").length,
      p2: report.candidates.filter((c) => c.pattern === "pattern_2_eom_no_round").length,
      large: report.candidates.filter((c) => c.has_large_shift).length,
      past: report.candidates.filter((c) => c.has_past_due).length,
    };
  }, [report]);

  const handleApprove = async () => {
    if (!report) return;
    setExecuting(true);
    setExecutionResult(null);
    try {
      const res = await executeMigration(report);
      setExecutionResult(res);
      if (res.migrated > 0) toast.success(`Migrated ${res.migrated} invoices`);
      if (res.errors.length > 0) toast.error(`${res.errors.length} errors during migration`);
      onCompleted?.();
      // Clear the report — re-scan to confirm 0 remaining
      await buildReport();
    } catch (e: any) {
      toast.error(`Migration failed: ${e?.message ?? e}`);
    } finally {
      setExecuting(false);
      setConfirmOpen(false);
      setTypedConfirm("");
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-4 py-3 hover:bg-amber-500/10 transition-colors">
          <div className="flex items-center gap-2">
            {open ? <ChevronDown className="h-4 w-4 text-amber-600" /> : <ChevronRight className="h-4 w-4 text-amber-600" />}
            <Database className="h-4 w-4 text-amber-600" />
            <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">Pending Migration</span>
            {hasRun && report && (
              <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-400">
                {report.candidates.length} invoice{report.candidates.length === 1 ? "" : "s"}
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground ml-1">
              Phase 1: Maui Jim "Split Payment EOM" backfill (Option B)
            </span>
          </div>
          {(loading || executing) && <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" />}
        </CollapsibleTrigger>

        <CollapsibleContent className="px-4 pb-4 space-y-3">
          {/* Header: scope + audit tag */}
          {report && (
            <div className="rounded-md bg-background border border-border p-3 space-y-1">
              <p className="text-[11px] text-muted-foreground">
                <span className="font-semibold text-foreground">Scope:</span> {report.scope_label}
              </p>
              <p className="text-[11px] text-muted-foreground">
                <span className="font-semibold text-foreground">Audit tag:</span>{" "}
                <code className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded">{report.audit_action}</code>
              </p>
            </div>
          )}

          {/* Summary counts */}
          {hasRun && report && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <SummaryStat label="Total" value={counts.total} />
              <SummaryStat label="Pattern 1 (addDays)" value={counts.p1} />
              <SummaryStat label="Pattern 2 (EOM no-round)" value={counts.p2} />
              <SummaryStat label="≥7d shift" value={counts.large} accent="amber" />
              <SummaryStat label="Past-due rows" value={counts.past} accent="red" />
            </div>
          )}

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={buildReport} disabled={loading || executing} className="text-[11px] h-7">
              {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
              {hasRun ? "Re-build report" : "Build impact report"}
            </Button>
            {hasRun && eligible.length > 0 && !executionResult && (
              <Button
                size="sm"
                onClick={() => setConfirmOpen(true)}
                disabled={executing}
                className="text-[11px] h-7 bg-amber-600 hover:bg-amber-700 text-white"
              >
                Approve Migration ({eligible.length} invoice{eligible.length === 1 ? "" : "s"})
              </Button>
            )}
          </div>

          {/* Confirmation dialog */}
          {confirmOpen && (
            <div className="rounded-md bg-destructive/10 border border-destructive/30 p-3 space-y-2">
              <p className="text-xs font-semibold text-destructive flex items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5" /> Confirm Migration
              </p>
              <p className="text-[11px] text-destructive/80">
                This will regenerate <strong>{eligible.length}</strong> invoice{eligible.length === 1 ? "" : "s"} and write{" "}
                <strong>{eligible.length}</strong> entries to <code className="font-mono">recalc_audit_log</code> tagged{" "}
                <code className="font-mono">{report?.audit_action}</code>. Snapshots of all old rows are preserved in the audit log.
              </p>
              <p className="text-[10px] text-muted-foreground">
                To confirm, type <span className="font-mono font-bold">MIGRATE</span> below:
              </p>
              <Input
                value={typedConfirm}
                onChange={(e) => setTypedConfirm(e.target.value)}
                placeholder="Type MIGRATE to confirm"
                className="h-7 text-xs font-mono border-destructive/30"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  className="text-xs h-7"
                  onClick={handleApprove}
                  disabled={executing || typedConfirm !== "MIGRATE"}
                >
                  {executing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                  Run Migration
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs h-7"
                  onClick={() => {
                    setConfirmOpen(false);
                    setTypedConfirm("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Execution result */}
          {executionResult && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-1">
              <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" /> Migration Complete
              </p>
              <p className="text-[11px]">✓ {executionResult.migrated} migrated</p>
              {executionResult.skipped_credit.length > 0 && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  ⚠ {executionResult.skipped_credit.length} skipped (Guard 1 credit memo): {executionResult.skipped_credit.map((s) => s.invoice_number).join(", ")}
                </p>
              )}
              {executionResult.skipped_paid.length > 0 && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  ⚠ {executionResult.skipped_paid.length} skipped (Guard 2 paid rows): {executionResult.skipped_paid.map((s) => s.invoice_number).join(", ")}
                </p>
              )}
              {executionResult.errors.length > 0 && (
                <div className="text-[11px] text-destructive">
                  ✗ {executionResult.errors.length} errors:
                  <ul className="ml-3 list-disc">
                    {executionResult.errors.map((e, i) => (
                      <li key={i}>
                        <span className="font-mono">{e.invoice_number}</span>: {e.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-md bg-red-500/10 border border-red-500/20 p-2.5">
              <p className="text-[11px] text-red-500">{error}</p>
            </div>
          )}

          {/* Empty / clean */}
          {hasRun && !loading && report && report.candidates.length === 0 && !executionResult && (
            <div className="rounded-md bg-emerald-500/5 border border-emerald-500/20 p-3 text-center">
              <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                ✓ No pending migration — all Maui Jim invoices match current engine output.
              </p>
            </div>
          )}

          {/* Blocked list */}
          {blocked.length > 0 && (
            <div className="rounded-md border border-border bg-background p-2.5 space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                <Ban className="h-3 w-3" /> Will be skipped ({blocked.length})
              </p>
              {blocked.map((b) => (
                <div key={b.invoice_id} className="text-[11px] flex items-center gap-2">
                  <span className="font-mono">{b.invoice_number}</span>
                  {b.blocked_by_guard1_credit && (
                    <Badge variant="outline" className="text-[9px] border-red-500/40 text-red-600">Guard 1 credit</Badge>
                  )}
                  {b.blocked_by_guard2_paid && (
                    <Badge variant="outline" className="text-[9px] border-red-500/40 text-red-600">Guard 2 paid</Badge>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Eligible list — full impact rows */}
          {eligible.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Eligible for migration ({eligible.length})
              </p>
              {eligible.map((c) => (
                <CandidateRow
                  key={c.invoice_id}
                  candidate={c}
                  expanded={expandedId === c.invoice_id}
                  onToggle={() => setExpandedId(expandedId === c.invoice_id ? null : c.invoice_id)}
                />
              ))}
            </div>
          )}

          {!hasRun && !loading && (
            <p className="text-[11px] text-muted-foreground italic">
              Click "Build impact report" to compute the per-invoice diff and review before approving.
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function SummaryStat({ label, value, accent }: { label: string; value: number; accent?: "amber" | "red" }) {
  const accentClass =
    accent === "amber"
      ? "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
      : accent === "red"
      ? "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-400"
      : "border-border bg-background text-foreground";
  return (
    <div className={`rounded-md border ${accentClass} px-2 py-1.5`}>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function CandidateRow({
  candidate: c,
  expanded,
  onToggle,
}: {
  candidate: MigrationCandidate;
  expanded: boolean;
  onToggle: () => void;
}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <div className="rounded-md border border-border bg-background overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
          <span className="font-mono text-xs font-semibold">{c.invoice_number}</span>
          <span className="text-[11px] text-muted-foreground">·</span>
          <span className="text-[11px] text-muted-foreground">{formatDate(c.invoice_date)}</span>
          <span className="text-[11px] text-muted-foreground">·</span>
          <span className="text-[11px] text-muted-foreground">{formatCurrency(c.total)}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="outline" className="text-[9px]">
            {c.pattern === "pattern_1_plain_addDays" ? "P1" : "P2"}
          </Badge>
          {c.max_day_shift > 0 && (
            <Badge
              variant="outline"
              className={`text-[10px] ${c.has_large_shift ? "border-amber-500/40 text-amber-700 dark:text-amber-400" : "border-border text-muted-foreground"}`}
            >
              ±{c.max_day_shift}d
            </Badge>
          )}
          {c.has_past_due && (
            <Badge variant="outline" className="text-[10px] border-red-500/40 text-red-700 dark:text-red-400 flex items-center gap-1">
              <Calendar className="h-2.5 w-2.5" /> past
            </Badge>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border bg-muted/20 px-3 py-2.5 space-y-2">
          {c.has_large_shift && (
            <div className="rounded bg-amber-500/10 border border-amber-500/30 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3" />
              Large shift ({c.max_day_shift} days) — verify against any externally-scheduled payments
            </div>
          )}
          {c.has_past_due && (
            <div className="rounded bg-red-500/10 border border-red-500/30 px-2 py-1.5 text-[11px] text-red-700 dark:text-red-400 flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3" />
              Stored schedule has past-due dates — Josh may have acted on the old date externally
            </div>
          )}
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Context</p>
            <p className="text-[11px] text-muted-foreground">
              Vendor: <span className="font-mono">{c.vendor}</span> · Terms:{" "}
              <span className="font-mono">{c.payment_terms ?? "—"}</span>
              {c.corrected_terms_label && (
                <>
                  {" · "}New label: <span className="font-mono text-amber-700 dark:text-amber-400">{c.corrected_terms_label}</span>
                </>
              )}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Stored ({c.stored_rows.length})</p>
              <div className="space-y-0.5">
                {c.stored_rows.map((r: any, i: number) => {
                  const isPast = new Date(r.due_date + "T00:00:00") < today;
                  return (
                    <div
                      key={i}
                      className={`flex justify-between items-center text-[11px] font-mono px-2 py-1 rounded border ${
                        isPast ? "bg-red-500/5 border-red-500/30" : "bg-background border-border/60"
                      }`}
                    >
                      <span className={isPast ? "text-red-600 dark:text-red-400" : ""}>{r.due_date}</span>
                      <span className="font-semibold">${Number(r.amount_due).toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Engine output ({c.proposed.length})</p>
              <div className="space-y-0.5">
                {c.proposed.map((r, i) => {
                  const stored = c.stored_rows[i];
                  const dateChanged = stored && stored.due_date !== r.due_date;
                  const amtChanged = stored && Math.abs(Number(stored.amount_due) - r.amount_due) > 0.01;
                  const dayDelta = c.day_deltas[i];
                  return (
                    <div
                      key={i}
                      className={`flex justify-between items-center text-[11px] font-mono px-2 py-1 rounded border ${
                        dateChanged || amtChanged ? "bg-emerald-500/5 border-emerald-500/30" : "bg-background border-border/60"
                      }`}
                    >
                      <span className={dateChanged ? "text-emerald-700 dark:text-emerald-400 font-semibold" : ""}>
                        {r.due_date}
                        {dateChanged && dayDelta !== undefined && (
                          <span className="ml-1 text-[10px] text-muted-foreground">({dayDelta > 0 ? "−" : "+"}{Math.abs(dayDelta)}d)</span>
                        )}
                      </span>
                      <span className={`font-semibold ${amtChanged ? "text-emerald-700 dark:text-emerald-400" : ""}`}>
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
}
