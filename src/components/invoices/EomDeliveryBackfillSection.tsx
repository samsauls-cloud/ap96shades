import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, Play, Pause, RotateCcw, Loader2, CheckCircle2, XCircle, AlertCircle, FileText } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import {
  previewInvoice,
  applyInvoiceBackfill,
  type InvoicePreview,
  BACKFILL_AUDIT_ACTION,
} from "@/lib/delivery-backfill-recompute";

type Row = {
  id: string;
  invoice_number: string | null;
  vendor: string | null;
  invoice_date: string | null;
  status: string | null;
  pdf_url: string | null;
};

type RowState =
  | { kind: "pending" }
  | { kind: "running" }
  | { kind: "success"; date: string }
  | { kind: "null" }
  | { kind: "error"; message: string };

const CHUNK_SIZE = 5;

async function fetchTargets(): Promise<Row[]> {
  const { data, error } = await supabase
    .from("vendor_invoices")
    .select("id, invoice_number, vendor, invoice_date, status, pdf_url, payment_terms, payment_terms_extracted, doc_type, delivery_date")
    .is("delivery_date", null)
    .eq("doc_type", "INVOICE")
    .order("invoice_date", { ascending: false })
    .limit(2000);
  if (error) throw error;
  return (data ?? [])
    .filter((r: any) => {
      // Eligibility: EOM marker either in structured field OR in the raw
      // payment_terms TEXT (where most legacy rows actually live).
      if (r.payment_terms_extracted?.eom_based === true) return true;
      const txt = String(r.payment_terms ?? "").toUpperCase();
      return /\bEOM\b|\bEM\b|END OF MONTH/.test(txt);
    })
    .map((r: any) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      vendor: r.vendor,
      invoice_date: r.invoice_date,
      status: r.status,
      pdf_url: r.pdf_url,
    }));
}

type JobSnapshot = {
  id: string;
  status: "running" | "paused" | "done" | "failed";
  invoice_ids: string[];
  remaining_ids: string[];
  processed_count: number;
  saved_count: number;
  failure_count: number;
  null_count: number;
  failures: Array<{ id: string; invoice_number: string | null; error: string }>;
  stop_reason: string | null;
};

async function startJob(invoiceIds: string[]): Promise<{ job_id: string; total: number }> {
  const { data, error } = await supabase.functions.invoke("backfill-delivery-dates", {
    body: { action: "start", invoice_ids: invoiceIds },
  });
  if (error) throw error;
  return data as { job_id: string; total: number };
}

async function callJobAction(action: "pause" | "resume" | "status", jobId: string) {
  const { data, error } = await supabase.functions.invoke("backfill-delivery-dates", {
    body: { action, job_id: jobId },
  });
  if (error) throw error;
  return data;
}

export function EomDeliveryBackfillSection() {
  const qc = useQueryClient();
  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ["delivery_backfill_targets"],
    queryFn: fetchTargets,
    // Poll while a job is in-flight so the progress bar reflects server-side
    // writes even when the tab was backgrounded.
    refetchInterval: (q) => {
      const r = (q.state.data as Row[] | undefined)?.filter(x => !!x.pdf_url).length ?? 0;
      return r > 0 ? 4000 : false;
    },
  });

  // Phase 1 state
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const initialRemainingRef = useRef<number | null>(null);

  const running = job?.status === "running";
  const paused = job?.status === "paused";
  const serverProgress = {
    savedThisSession: job?.saved_count ?? 0,
    failuresThisSession: job?.failure_count ?? 0,
  };

  // Phase 2 state
  const [previews, setPreviews] = useState<Record<string, InvoicePreview>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyDone, setApplyDone] = useState(0);
  const [applyTotal, setApplyTotal] = useState(0);

  const eligible = useMemo(() => rows.filter(r => !!r.pdf_url), [rows]);
  const total = initialRemainingRef.current ?? eligible.length;
  const completed = Math.max(0, total - eligible.length);

  // Poll the job snapshot while a job is active.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let lastTerminalStatus: string | null = null;
    const tick = async () => {
      try {
        const data = await callJobAction("status", jobId);
        if (cancelled) return;
        const snap = (data as any)?.job as JobSnapshot | null;
        if (snap) {
          setJob(snap);
          if (snap.failures?.length) {
            setStates(prev => {
              const next = { ...prev };
              for (const f of snap.failures) next[f.id] = { kind: "error", message: f.error };
              return next;
            });
          }
          if ((snap.status === "done" || snap.status === "failed") && lastTerminalStatus !== snap.status) {
            lastTerminalStatus = snap.status;
            toast({
              title: snap.status === "done" ? "Backfill complete" : "Backfill stopped",
              description: snap.status === "done"
                ? `Saved ${snap.saved_count} · ${snap.null_count} not found · ${snap.failure_count} failed.`
                : (snap.stop_reason ?? "Worker stopped."),
              variant: snap.status === "failed" ? "destructive" : undefined,
            });
            qc.invalidateQueries({ queryKey: ["invoice_stats"] });
          }
        }
        await refetch();
      } catch (e) {
        console.error("status poll failed", e);
      }
    };
    void tick();
    const iv = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [jobId, qc, refetch]);

  const handleStart = async () => {
    if (eligible.length === 0) return;
    initialRemainingRef.current = eligible.length;
    try {
      const { job_id } = await startJob(eligible.map(r => r.id));
      setJobId(job_id);
      setJob({
        id: job_id, status: "running",
        invoice_ids: eligible.map(r => r.id),
        remaining_ids: eligible.map(r => r.id),
        processed_count: 0, saved_count: 0, failure_count: 0, null_count: 0,
        failures: [], stop_reason: null,
      });
      toast({ title: "Backfill started", description: `Server is processing ${eligible.length} invoice(s).` });
    } catch (e: any) {
      toast({ title: "Failed to start", description: e?.message || String(e), variant: "destructive" });
    }
  };
  const handlePause = async () => {
    if (!jobId) return;
    try { await callJobAction("pause", jobId); setJob(j => j ? { ...j, status: "paused" } : j); }
    catch (e: any) { toast({ title: "Pause failed", description: e?.message, variant: "destructive" }); }
  };
  const handleResume = async () => {
    if (!jobId) return;
    try { await callJobAction("resume", jobId); setJob(j => j ? { ...j, status: "running" } : j); }
    catch (e: any) { toast({ title: "Resume failed", description: e?.message, variant: "destructive" }); }
  };
  const handleReset = () => {
    setStates({});
    setJobId(null);
    setJob(null);
    initialRemainingRef.current = null;
  };

  const setManual = async (row: Row, date: Date) => {
    const iso = format(date, "yyyy-MM-dd");
    const { error } = await supabase.from("vendor_invoices").update({ delivery_date: iso } as any).eq("id", row.id);
    if (error) { toast({ title: "Save failed", description: error.message, variant: "destructive" }); return; }
    setStates(prev => ({ ...prev, [row.id]: { kind: "success", date: iso } }));
    toast({ title: "Delivery date saved" });
    refetch();
  };

  // ── Phase 2 handlers
  const eligibleForRecompute = useMemo(
    () => rows.filter(r => states[r.id]?.kind === "success").map(r => r.id),
    [rows, states],
  );

  const handlePreview = async () => {
    if (eligibleForRecompute.length === 0) {
      toast({ title: "Nothing to preview", description: "Run Phase 1 first or set a delivery date manually." });
      return;
    }
    setPreviewing(true);
    const out: Record<string, InvoicePreview> = {};
    const sel: Record<string, boolean> = {};
    for (const id of eligibleForRecompute) {
      try {
        const pv = await previewInvoice(id);
        if (pv) { out[id] = pv; sel[id] = !pv.blocked && pv.movableCount > 0; }
      } catch (e: any) { console.error("preview failed", id, e); }
    }
    setPreviews(out);
    setSelected(sel);
    setPreviewing(false);
  };

  const handleApply = async () => {
    const ids = Object.keys(selected).filter(id => selected[id] && previews[id] && !previews[id].blocked && previews[id].movableCount > 0);
    if (ids.length === 0) { toast({ title: "Nothing selected" }); return; }
    setApplying(true);
    setApplyTotal(ids.length);
    setApplyDone(0);
    let totalMoved = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const { updated } = await applyInvoiceBackfill(previews[id]);
        totalMoved += updated;
      } catch (e: any) {
        failed++;
        console.error("apply failed", id, e);
      }
      setApplyDone(n => n + 1);
    }
    setApplying(false);
    toast({
      title: "Recompute complete",
      description: `${totalMoved} installment(s) moved across ${ids.length - failed} invoice(s)${failed ? ` · ${failed} failed` : ""}.`,
    });
    qc.invalidateQueries({ queryKey: ["invoice_payments"] });
    qc.invalidateQueries({ queryKey: ["invoice_stats"] });
    qc.invalidateQueries({ queryKey: ["ap_full_audit"] });
    qc.invalidateQueries({ queryKey: ["vendor_invoices"] });
  };

  const previewList = eligibleForRecompute.map(id => previews[id]).filter(Boolean);
  const movableTotal = previewList.reduce((s, pv) => s + (pv.movableCount ?? 0), 0);
  const selectedCount = Object.values(selected).filter(Boolean).length;

  return (
    <div className="space-y-4">
      {/* Phase 1 header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-bold">Phase 1 — Extract delivery_date from PDFs</h3>
          <p className="text-xs text-muted-foreground">
            EOM invoices missing <code>delivery_date</code>. Re-runs Reader extraction; writes only <code>delivery_date</code>.
          </p>
        </div>
        <div className="flex gap-2">
          {!running && <Button size="sm" onClick={handleStart} disabled={total === 0}><Play className="h-4 w-4" />Re-read batch</Button>}
          {running && !paused && <Button size="sm" onClick={handlePause} variant="secondary"><Pause className="h-4 w-4" />Pause</Button>}
          {running && paused && <Button size="sm" onClick={handleResume}><Play className="h-4 w-4" />Resume</Button>}
          <Button size="sm" onClick={handleReset} variant="outline"><RotateCcw className="h-4 w-4" />Reset</Button>
        </div>
      </div>

      <div className="border border-border rounded-md p-3 bg-card">
        <div className="flex items-center justify-between text-xs mb-2">
          <span>
            {completed} / {total} processed
            {running && <span className="ml-2 text-muted-foreground">(saved this session: {serverProgress.savedThisSession}{serverProgress.failuresThisSession ? ` · ${serverProgress.failuresThisSession} failures` : ""})</span>}
          </span>
          <span className="text-muted-foreground">Eligible w/ PDF: {eligible.length} · Without PDF: {rows.length - eligible.length}</span>
        </div>
        <Progress value={total > 0 ? (completed / total) * 100 : 0} />
      </div>


      <div className="border border-border rounded-md bg-card overflow-auto max-h-[500px]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Invoice #</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Invoice Date</TableHead>
              <TableHead>Paid?</TableHead>
              <TableHead>PDF</TableHead>
              <TableHead>Delivery Date</TableHead>
              <TableHead>Manual</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={8} className="text-center py-6 text-muted-foreground">Loading…</TableCell></TableRow>}
            {!isLoading && rows.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center py-6 text-muted-foreground">No EOM invoices missing delivery dates. 🎉</TableCell></TableRow>
            )}
            {rows.map(row => {
              const st = states[row.id];
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    {!st && <Badge variant="outline">Pending</Badge>}
                    {st?.kind === "running" && <Badge variant="secondary"><Loader2 className="h-3 w-3 animate-spin mr-1" />Running</Badge>}
                    {st?.kind === "success" && <Badge className="bg-emerald-600 text-white"><CheckCircle2 className="h-3 w-3 mr-1" />Saved</Badge>}
                    {st?.kind === "null" && <Badge className="bg-amber-500 text-white"><AlertCircle className="h-3 w-3 mr-1" />Not found</Badge>}
                    {st?.kind === "error" && <Badge variant="destructive" title={st.message}><XCircle className="h-3 w-3 mr-1" />Error</Badge>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.invoice_number ?? "—"}</TableCell>
                  <TableCell>{row.vendor ?? "—"}</TableCell>
                  <TableCell>{row.invoice_date ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn(
                      row.status === "paid" && "border-emerald-500 text-emerald-600",
                      row.status === "unpaid" && "border-red-500 text-red-600",
                      row.status === "partial" && "border-blue-500 text-blue-600",
                    )}>{row.status ?? "—"}</Badge>
                  </TableCell>
                  <TableCell>
                    {row.pdf_url
                      ? <a href={row.pdf_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline text-xs"><FileText className="h-3 w-3" />Open</a>
                      : <span className="text-xs text-muted-foreground">none</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{st?.kind === "success" ? st.date : "—"}</TableCell>
                  <TableCell>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className="h-7 text-xs"><CalendarIcon className="h-3 w-3" />Pick</Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="end">
                        <Calendar mode="single" onSelect={(d) => d && setManual(row, d)} className={cn("p-3 pointer-events-auto")} />
                      </PopoverContent>
                    </Popover>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Phase 2 */}
      <div className="border border-border rounded-md bg-card p-4 space-y-3 mt-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-bold">Phase 2 — Recompute schedules (dry-run)</h3>
            <p className="text-xs text-muted-foreground">
              Re-anchor EOM installments on the backfilled <code>delivery_date</code>. Only UNPAID rows move. Audit tag: <code>{BACKFILL_AUDIT_ACTION}</code>.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={handlePreview} disabled={previewing || applying} variant="outline" size="sm">
              {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Preview ({eligibleForRecompute.length})
            </Button>
            <Button onClick={handleApply} disabled={applying || previewList.length === 0 || selectedCount === 0} size="sm">
              {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Confirm & apply ({selectedCount})
            </Button>
          </div>
        </div>

        {applying && (
          <div>
            <div className="text-xs mb-1">{applyDone} / {applyTotal}</div>
            <Progress value={applyTotal > 0 ? (applyDone / applyTotal) * 100 : 0} />
          </div>
        )}

        {previewList.length > 0 && (
          <div className="text-xs text-muted-foreground">
            {previewList.length} invoice(s) previewed · {movableTotal} movable installment(s) · {previewList.filter(pv => pv.blocked).length} blocked by guards
          </div>
        )}

        <div className="overflow-auto max-h-[500px]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10"></TableHead>
                <TableHead>Invoice #</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Delivery</TableHead>
                <TableHead>Guard</TableHead>
                <TableHead>Old → New due dates</TableHead>
                <TableHead className="text-right">Moves</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {previewList.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground text-sm">No previews yet. Run Phase 1, then click Preview.</TableCell></TableRow>
              )}
              {previewList.map(pv => {
                const blocked = pv.blocked;
                return (
                  <TableRow key={pv.invoiceId}>
                    <TableCell>
                      <Checkbox
                        checked={!!selected[pv.invoiceId]}
                        disabled={blocked || pv.movableCount === 0}
                        onCheckedChange={(v) => setSelected(s => ({ ...s, [pv.invoiceId]: !!v }))}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{pv.invoiceNumber ?? "—"}</TableCell>
                    <TableCell className="text-xs">{pv.vendor ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{pv.deliveryDate}</TableCell>
                    <TableCell>
                      {pv.guard === "clean" && <Badge variant="outline" className="border-emerald-500 text-emerald-600">clean</Badge>}
                      {pv.guard === "manual_correction" && <Badge variant="outline" className="border-amber-500 text-amber-600">diverged</Badge>}
                      {pv.guard === "paid_rows" && <Badge variant="outline" className="border-red-500 text-red-600">paid rows</Badge>}
                      {pv.guard === "credit_memo" && <Badge variant="outline" className="border-red-500 text-red-600">credit memo</Badge>}
                      {pv.guard === "no_terms" && <Badge variant="outline" className="border-muted-foreground text-muted-foreground">no terms</Badge>}
                      {pv.guard === "no_existing" && <Badge variant="outline" className="border-muted-foreground text-muted-foreground">no rows</Badge>}
                    </TableCell>
                    <TableCell className="text-xs space-y-0.5">
                      {pv.diffs.length === 0 && <span className="text-muted-foreground">{pv.message ?? "—"}</span>}
                      {pv.diffs.map((d, i) => {
                        const old = d.existing.due_date;
                        const nw = d.proposed?.due_date ?? "—";
                        return (
                          <div key={i} className={cn("font-mono", d.willMove ? "text-foreground" : "text-muted-foreground")}>
                            <span>{d.existing.installment_label ?? "single"}: </span>
                            <span>{old}</span>
                            <span> → </span>
                            <span className={d.willMove ? "font-semibold text-emerald-600" : ""}>{nw}</span>
                            {!d.willMove && d.skipReason && <span className="ml-2 text-[10px] italic">({d.skipReason})</span>}
                          </div>
                        );
                      })}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{pv.movableCount}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
