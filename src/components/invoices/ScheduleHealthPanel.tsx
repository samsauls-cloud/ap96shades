/**
 * ScheduleHealthPanel
 *
 * Consolidated replacement for PendingMigrationSection + ScheduleDivergencesSection.
 *
 * Classifies data from buildMauiEomMigrationReport + surveyScheduleDivergences
 * into three buckets:
 *   - Action Needed: eligible migration candidates + material divergences (≥7d OR ≥$5)
 *   - Locked:       candidates blocked by Guard 1 (credit) or Guard 2 (paid)
 *   - Drift:        cosmetic divergences (<7d AND <$5), not in candidates
 *
 * Hides entirely when all three buckets are empty.
 * Amber chrome only when Action Needed > 0.
 *
 * Execution logic (executeMigration + confirmation flow) unchanged — lifted
 * from PendingMigrationSection.
 */

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity, ChevronDown, ChevronRight, Loader2, ShieldAlert, CheckCircle2,
  AlertTriangle, Lock, Info, Calendar,
} from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/supabase-queries";
import {
  executeMigration,
  type MigrationCandidate, type MigrationImpactReport, type MigrationExecutionResult,
} from "@/lib/engine-migrations";
import type { DivergentInvoice } from "@/lib/divergence-survey";
import { toast } from "sonner";

// Thresholds — below both = "cosmetic drift, don't bother"
const DRIFT_DAYS = 7;
const DRIFT_DOLLARS = 5;

interface Props {
  report: MigrationImpactReport | null;
  divergences: DivergentInvoice[] | null;
  onCompleted?: () => void;
}

export function ScheduleHealthPanel({ report, divergences, onCompleted }: Props) {
  // ── Classification ─────────────────────────────────────────────────────
  const { eligibleCandidates, materialDivergences, locked, drift } = useMemo(() => {
    const candidates = report?.candidates ?? [];
    const divs = divergences ?? [];
    const candidateIds = new Set(candidates.map((c) => c.invoice_id));

    const eligibleCandidates = candidates.filter(
      (c) => !c.blocked_by_guard1_credit && !c.blocked_by_guard2_paid
    );
    const locked = candidates.filter(
      (c) => c.blocked_by_guard1_credit || c.blocked_by_guard2_paid
    );
    // Material divergences not already surfaced as migration candidates
    const materialDivergences = divs.filter(
      (d) =>
        (d.magnitude_days >= DRIFT_DAYS || d.magnitude_dollars >= DRIFT_DOLLARS) &&
        !candidateIds.has(d.invoice_id)
    );
    // Cosmetic drift — sub-threshold and not already a candidate
    const drift = divs.filter(
      (d) =>
        d.magnitude_days < DRIFT_DAYS &&
        d.magnitude_dollars < DRIFT_DOLLARS &&
        !candidateIds.has(d.invoice_id)
    );

    return { eligibleCandidates, materialDivergences, locked, drift };
  }, [report, divergences]);

  const actionCount = eligibleCandidates.length + materialDivergences.length;
  const lockedCount = locked.length;
  const driftCount = drift.length;
  const totalCount = actionCount + lockedCount + driftCount;

  const hasAction = actionCount > 0;

  // Default tab: Action if items, else Locked
  const [tab, setTab] = useState<"action" | "locked" | "drift">(
    hasAction ? "action" : lockedCount > 0 ? "locked" : "drift"
  );
  // Default open: only when there's action
  const [open, setOpen] = useState(hasAction);

  // ── Migration execution state (lifted from PendingMigrationSection) ────
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState("");
  const [executing, setExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<MigrationExecutionResult | null>(null);

  const handleApprove = async () => {
    if (!report) return;
    setExecuting(true);
    setExecutionResult(null);
    try {
      const res = await executeMigration(report);
      setExecutionResult(res);
      if (res.migrated > 0) toast.success(`Updated ${res.migrated} schedule${res.migrated === 1 ? "" : "s"}`);
      if (res.errors.length > 0) toast.error(`${res.errors.length} error${res.errors.length === 1 ? "" : "s"} during update`);
      onCompleted?.();
    } catch (e: any) {
      toast.error(`Update failed: ${e?.message ?? e}`);
    } finally {
      setExecuting(false);
      setConfirmOpen(false);
      setTypedConfirm("");
    }
  };

  // ── Hide entirely when nothing to show ─────────────────────────────────
  if (totalCount === 0) return null;

  // ── Header status line ──────────────────────────────────────────────────
  const statusLine = buildStatusLine({ actionCount, lockedCount, driftCount });

  const containerClass = hasAction
    ? "rounded-lg border border-amber-500/40 bg-amber-500/5"
    : "rounded-lg border border-border bg-card";
  const iconClass = hasAction ? "text-amber-600" : "text-muted-foreground";
  const labelClass = hasAction
    ? "text-sm font-semibold text-amber-700 dark:text-amber-400"
    : "text-sm font-semibold text-foreground";

  return (
    <div className={containerClass}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className={`flex w-full items-center justify-between gap-2 px-4 py-3 transition-colors ${
            hasAction ? "hover:bg-amber-500/10" : "hover:bg-muted/30"
          }`}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {open ? <ChevronDown className={`h-4 w-4 shrink-0 ${iconClass}`} /> : <ChevronRight className={`h-4 w-4 shrink-0 ${iconClass}`} />}
            <Activity className={`h-4 w-4 shrink-0 ${iconClass}`} />
            <span className={labelClass}>Schedule Health</span>
            <span className="text-[11px] text-muted-foreground ml-1 truncate">{statusLine}</span>
          </div>
          {executing && <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600 shrink-0" />}
        </CollapsibleTrigger>

        <CollapsibleContent className="px-4 pb-4 space-y-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
            <TabsList className="h-8 p-0.5 bg-muted">
              <TabsTrigger value="action" className="text-[11px] h-7 px-3 gap-1.5" disabled={actionCount === 0}>
                Action Needed
                <Badge
                  variant="outline"
                  className={`text-[9px] h-4 px-1 ${
                    actionCount > 0
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {actionCount}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="locked" className="text-[11px] h-7 px-3 gap-1.5" disabled={lockedCount === 0}>
                Locked
                <Badge variant="outline" className="text-[9px] h-4 px-1 border-border text-muted-foreground">
                  {lockedCount}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="drift" className="text-[11px] h-7 px-3 gap-1.5" disabled={driftCount === 0}>
                Drift
                <Badge variant="outline" className="text-[9px] h-4 px-1 border-border text-muted-foreground">
                  {driftCount}
                </Badge>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="action" className="space-y-3 mt-3">
              <ActionNeededTab
                report={report}
                eligibleCandidates={eligibleCandidates}
                materialDivergences={materialDivergences}
                confirmOpen={confirmOpen}
                setConfirmOpen={setConfirmOpen}
                typedConfirm={typedConfirm}
                setTypedConfirm={setTypedConfirm}
                executing={executing}
                executionResult={executionResult}
                onApprove={handleApprove}
              />
            </TabsContent>

            <TabsContent value="locked" className="space-y-3 mt-3">
              <LockedTab locked={locked} />
            </TabsContent>

            <TabsContent value="drift" className="space-y-3 mt-3">
              <DriftTab drift={drift} />
            </TabsContent>
          </Tabs>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ── Status line builder ──────────────────────────────────────────────────

function buildStatusLine({
  actionCount, lockedCount, driftCount,
}: { actionCount: number; lockedCount: number; driftCount: number }): string {
  const parts: string[] = [];
  if (actionCount > 0) parts.push(`${actionCount} ready to update`);
  if (lockedCount > 0) parts.push(`${lockedCount} locked`);
  if (driftCount > 0) parts.push(`${driftCount} minor drift`);
  const joined = parts.join(" · ");
  if (actionCount > 0) return `⚠ ${joined}`;
  return `ℹ ${joined} — no action needed`;
}

// ── Action Needed tab ────────────────────────────────────────────────────

interface ActionNeededProps {
  report: MigrationImpactReport | null;
  eligibleCandidates: MigrationCandidate[];
  materialDivergences: DivergentInvoice[];
  confirmOpen: boolean;
  setConfirmOpen: (v: boolean) => void;
  typedConfirm: string;
  setTypedConfirm: (v: string) => void;
  executing: boolean;
  executionResult: MigrationExecutionResult | null;
  onApprove: () => void;
}

function ActionNeededTab({
  report, eligibleCandidates, materialDivergences,
  confirmOpen, setConfirmOpen, typedConfirm, setTypedConfirm,
  executing, executionResult, onApprove,
}: ActionNeededProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <>
      {/* Scope header */}
      {report && eligibleCandidates.length > 0 && (
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

      {/* Update button */}
      {eligibleCandidates.length > 0 && !executionResult && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={executing}
            className="text-[11px] h-7 bg-amber-600 hover:bg-amber-700 text-white"
          >
            Update {eligibleCandidates.length} Schedule{eligibleCandidates.length === 1 ? "" : "s"}
          </Button>
        </div>
      )}

      {/* Confirmation */}
      {confirmOpen && (
        <div className="rounded-md bg-destructive/10 border border-destructive/30 p-3 space-y-2">
          <p className="text-xs font-semibold text-destructive flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5" /> Confirm Update
          </p>
          <p className="text-[11px] text-destructive/80">
            This will regenerate <strong>{eligibleCandidates.length}</strong> schedule{eligibleCandidates.length === 1 ? "" : "s"} and write{" "}
            <strong>{eligibleCandidates.length}</strong> entries to{" "}
            <code className="font-mono">recalc_audit_log</code> tagged{" "}
            <code className="font-mono">{report?.audit_action}</code>. Snapshots of old rows are preserved.
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
              onClick={onApprove}
              disabled={executing || typedConfirm !== "MIGRATE"}
            >
              {executing && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              Run Update
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs h-7"
              onClick={() => { setConfirmOpen(false); setTypedConfirm(""); }}
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
            <CheckCircle2 className="h-3.5 w-3.5" /> Update Complete
          </p>
          <p className="text-[11px]">✓ {executionResult.migrated} updated</p>
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
                  <li key={i}><span className="font-mono">{e.invoice_number}</span>: {e.error}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Eligible candidates list */}
      {eligibleCandidates.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Ready to apply ({eligibleCandidates.length})
          </p>
          {eligibleCandidates.map((c) => (
            <CandidateRow
              key={c.invoice_id}
              candidate={c}
              expanded={expandedId === c.invoice_id}
              onToggle={() => setExpandedId(expandedId === c.invoice_id ? null : c.invoice_id)}
            />
          ))}
        </div>
      )}

      {/* Material divergences — not auto-fixable, just surfaced */}
      {materialDivergences.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Material divergences ({materialDivergences.length}) — review manually
          </p>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            These diverge by {DRIFT_DAYS}+ days or ${DRIFT_DOLLARS}+ and fall outside any automated migration scope.
            Use the standard Recalculate flow on the invoice if a fix is needed.
          </p>
          {materialDivergences.map((d) => (
            <DivergenceRow key={d.invoice_id} divergence={d} tone="amber" />
          ))}
        </div>
      )}
    </>
  );
}

// ── Locked tab ───────────────────────────────────────────────────────────

function LockedTab({ locked }: { locked: MigrationCandidate[] }) {
  return (
    <>
      <div className="flex items-start gap-2 rounded-md bg-muted/30 border border-border p-2.5">
        <Lock className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
        <p className="text-[11px] text-muted-foreground leading-snug">
          These invoices have paid installments or credit memos. The engine won't rewrite them —
          existing due dates stay as recorded. They fall out of scope automatically once fully paid.
        </p>
      </div>
      <div className="space-y-1.5">
        {locked.map((b) => (
          <LockedRow key={b.invoice_id} candidate={b} />
        ))}
      </div>
    </>
  );
}

function LockedRow({ candidate: b }: { candidate: MigrationCandidate }) {
  const [expanded, setExpanded] = useState(false);

  const paidRows = (b.stored_rows ?? []).filter(
    (r: any) => r.is_paid === true || r.payment_status === "paid" || Number(r.amount_paid ?? 0) > 0
  );
  const creditRows = (b.stored_rows ?? []).filter(
    (r: any) => r.terms === "credit_memo" || r.installment_label === "Credit" || Number(r.amount_due) < 0
  );
  const remaining = b.stored_rows.length - paidRows.length;

  // Compact one-line reason
  const reason = b.blocked_by_guard2_paid && paidRows.length > 0
    ? `🔒 Paid ${paidRows[0]?.paid_date ? formatDate(paidRows[0].paid_date) : ""} · clears after ${remaining} more installment${remaining === 1 ? "" : "s"}`
    : b.blocked_by_guard1_credit
    ? `🔒 Credit memo · unchanged`
    : `🔒 Locked`;

  return (
    <div className="rounded-md border border-border bg-background overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
          {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
          <span className="font-mono text-xs font-semibold">{b.invoice_number}</span>
          <span className="text-[11px] text-muted-foreground">·</span>
          <span className="text-[11px] text-muted-foreground">{formatDate(b.invoice_date)}</span>
          <span className="text-[11px] text-muted-foreground">·</span>
          <span className="text-[11px] text-muted-foreground">{formatCurrency(b.total)}</span>
          <span className="text-[11px] text-muted-foreground">·</span>
          <span className="text-[11px] text-muted-foreground">{reason}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border bg-muted/20 px-3 py-2.5 space-y-2">
          {b.blocked_by_guard2_paid && paidRows.length > 0 && (
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Why skipped:</strong>{" "}
              {paidRows.length} of {b.stored_rows.length} installment{b.stored_rows.length === 1 ? "" : "s"} already paid
              {paidRows[0]?.installment_label ? ` (${paidRows.map((r: any) => r.installment_label).join(", ")})` : ""}
              {paidRows[0]?.paid_date ? ` on ${formatDate(paidRows[0].paid_date)}` : ""}.
              Rewriting the schedule would corrupt payment history.{" "}
              <strong className="text-foreground">Effect:</strong> due dates stay as recorded
              {b.max_day_shift > 0 ? ` (~${b.max_day_shift} day${b.max_day_shift === 1 ? "" : "s"} off the new EOM-rounded ideal — cosmetic, not financial)` : ""}.
              Once all installments clear, this invoice falls out of scope automatically.
            </p>
          )}
          {b.blocked_by_guard1_credit && creditRows.length > 0 && (
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Why skipped:</strong> contains a credit memo or negative-amount row
              {creditRows[0]?.installment_label ? ` ("${creditRows[0].installment_label}")` : ""}.
              Credits don't follow standard payment-term math, so the engine leaves them untouched.{" "}
              <strong className="text-foreground">Effect:</strong> existing schedule and due dates remain as-is.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Drift tab ────────────────────────────────────────────────────────────

function DriftTab({ drift }: { drift: DivergentInvoice[] }) {
  return (
    <>
      <div className="flex items-start gap-2 rounded-md bg-blue-500/5 border border-blue-500/20 p-2.5">
        <Info className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0" />
        <p className="text-[11px] text-muted-foreground leading-snug">
          Stored schedules differ from current engine output by less than {DRIFT_DAYS} days and less than ${DRIFT_DOLLARS}.
          Likely old rounding or prior engine version — not a bug and not worth fixing automatically.
        </p>
      </div>
      <div className="space-y-1.5">
        {drift.map((d) => (
          <DivergenceRow key={d.invoice_id} divergence={d} tone="neutral" />
        ))}
      </div>
    </>
  );
}

// ── Shared divergence row (used by Drift and Material) ──────────────────

function DivergenceRow({ divergence: d, tone }: { divergence: DivergentInvoice; tone: "amber" | "neutral" }) {
  const [expanded, setExpanded] = useState(false);

  const daysBadgeClass = tone === "amber"
    ? "border-amber-500/40 text-amber-700 dark:text-amber-400"
    : "border-border text-muted-foreground";

  return (
    <div className="rounded-md border border-border bg-background overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
          <span className="font-mono text-xs font-semibold">{d.invoice_number}</span>
          <span className="text-[11px] text-muted-foreground">·</span>
          <span className="text-[11px] text-muted-foreground truncate">{d.vendor}</span>
          <span className="text-[11px] text-muted-foreground">·</span>
          <span className="text-[11px] text-muted-foreground">{formatCurrency(d.total)}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {d.magnitude_days > 0 && (
            <Badge variant="outline" className={`text-[10px] ${daysBadgeClass}`}>±{d.magnitude_days}d</Badge>
          )}
          {d.magnitude_dollars > 0 && (
            <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
              ±${d.magnitude_dollars.toFixed(2)}
            </Badge>
          )}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border bg-muted/20 px-3 py-2.5 space-y-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Summary</p>
            <p className="text-[11px]">{d.summary}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Invoice context</p>
            <p className="text-[11px] text-muted-foreground">
              Date: {formatDate(d.invoice_date)} · Terms: <span className="font-mono">{d.payment_terms ?? "—"}</span>
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Stored ({d.stored.length})</p>
              <div className="space-y-0.5">
                {d.stored.map((r, i) => (
                  <div key={i} className="flex justify-between items-center text-[11px] font-mono px-2 py-1 rounded bg-background border border-border/60">
                    <span>{r.due_date}</span>
                    <span className="font-semibold">${r.amount_due.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Engine output ({d.expected.length})</p>
              <div className="space-y-0.5">
                {d.expected.map((r, i) => {
                  const stored = d.stored[i];
                  const dateDiff = stored && stored.due_date !== r.due_date;
                  const amtDiff = stored && Math.abs(stored.amount_due - r.amount_due) > 0.01;
                  return (
                    <div key={i} className={`flex justify-between items-center text-[11px] font-mono px-2 py-1 rounded border ${
                      dateDiff || amtDiff ? "bg-amber-500/5 border-amber-500/30" : "bg-background border-border/60"
                    }`}>
                      <span className={dateDiff ? "text-amber-600 dark:text-amber-400 font-semibold" : ""}>{r.due_date}</span>
                      <span className={`font-semibold ${amtDiff ? "text-amber-600 dark:text-amber-400" : ""}`}>${r.amount_due.toFixed(2)}</span>
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

// ── Migration candidate row (eligible, in Action Needed tab) ────────────
// Reused near-verbatim from old PendingMigrationSection — unchanged shape.

function CandidateRow({
  candidate: c, expanded, onToggle,
}: { candidate: MigrationCandidate; expanded: boolean; onToggle: () => void }) {
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
              Stored schedule has past-due dates — you may have acted on the old date externally
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
                    <div key={i} className={`flex justify-between items-center text-[11px] font-mono px-2 py-1 rounded border ${
                      isPast ? "bg-red-500/5 border-red-500/30" : "bg-background border-border/60"
                    }`}>
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
                    <div key={i} className={`flex justify-between items-center text-[11px] font-mono px-2 py-1 rounded border ${
                      dateChanged || amtChanged ? "bg-emerald-500/5 border-emerald-500/30" : "bg-background border-border/60"
                    }`}>
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
