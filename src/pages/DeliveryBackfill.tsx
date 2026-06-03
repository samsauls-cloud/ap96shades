import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, Play, Pause, RotateCcw, Loader2, CheckCircle2, XCircle, AlertCircle, FileText } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { callAnthropicAPI, normalizeInvoiceYear } from "@/lib/reader-engine";

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

const BATCH_SIZE = 5;

async function fetchTargets(): Promise<Row[]> {
  const { data, error } = await supabase
    .from("vendor_invoices")
    .select("id, invoice_number, vendor, invoice_date, status, pdf_url, payment_terms_extracted, doc_type, delivery_date")
    .is("delivery_date", null)
    .eq("doc_type", "INVOICE")
    .order("invoice_date", { ascending: false })
    .limit(2000);
  if (error) throw error;
  return (data ?? [])
    .filter((r: any) => r.payment_terms_extracted?.eom_based === true)
    .map((r: any) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      vendor: r.vendor,
      invoice_date: r.invoice_date,
      status: r.status,
      pdf_url: r.pdf_url,
    }));
}

async function urlToBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch PDF failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default function DeliveryBackfillPage() {
  const qc = useQueryClient();
  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ["delivery_backfill_targets"],
    queryFn: fetchTargets,
  });

  const [states, setStates] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("anthropic_api_key") || "");
  const [showKeyPrompt, setShowKeyPrompt] = useState(false);
  const [keyInput, setKeyInput] = useState("");

  const eligible = useMemo(() => rows.filter(r => !!r.pdf_url), [rows]);
  const completed = Object.values(states).filter(s => s.kind === "success" || s.kind === "null" || s.kind === "error").length;
  const total = eligible.length;

  useEffect(() => {
    if (!running || paused) return;
    if (cursor >= eligible.length) {
      setRunning(false);
      toast({ title: "Batch complete", description: `Processed ${cursor} invoices.` });
      refetch();
      qc.invalidateQueries({ queryKey: ["invoice_stats"] });
      return;
    }
    const batch = eligible.slice(cursor, cursor + BATCH_SIZE);
    let cancelled = false;

    (async () => {
      await Promise.all(
        batch.map(async (row) => {
          setStates(prev => ({ ...prev, [row.id]: { kind: "running" } }));
          try {
            const base64 = await urlToBase64(row.pdf_url!);
            const parsed = await callAnthropicAPI(apiKey, base64);
            const rawDate = parsed?.delivery_date;
            if (!rawDate || typeof rawDate !== "string") {
              setStates(prev => ({ ...prev, [row.id]: { kind: "null" } }));
              return;
            }
            const normalized = normalizeInvoiceYear(rawDate);
            const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!m) {
              setStates(prev => ({ ...prev, [row.id]: { kind: "error", message: "Bad date format" } }));
              return;
            }
            const { error } = await supabase
              .from("vendor_invoices")
              .update({ delivery_date: normalized } as any)
              .eq("id", row.id);
            if (error) throw error;
            setStates(prev => ({ ...prev, [row.id]: { kind: "success", date: normalized } }));
          } catch (e: any) {
            const msg = e?.message || String(e);
            setStates(prev => ({ ...prev, [row.id]: { kind: "error", message: msg } }));
          }
        })
      );
      if (!cancelled) setCursor(c => c + batch.length);
    })();

    return () => { cancelled = true; };
  }, [running, paused, cursor, eligible, apiKey, qc, refetch]);

  const handleStart = () => {
    if (!apiKey) {
      setShowKeyPrompt(true);
      return;
    }
    const remaining = eligible.findIndex(r => !states[r.id] || states[r.id].kind === "pending" || states[r.id].kind === "error");
    setCursor(remaining === -1 ? eligible.length : remaining);
    setPaused(false);
    setRunning(true);
  };

  const handlePause = () => setPaused(true);
  const handleResume = () => setPaused(false);
  const handleReset = () => { setStates({}); setCursor(0); setRunning(false); setPaused(false); };

  const saveKey = () => {
    const clean = keyInput.replace(/[^\x20-\x7E]/g, "").trim();
    if (!clean) return;
    localStorage.setItem("anthropic_api_key", clean);
    setApiKey(clean);
    setShowKeyPrompt(false);
    setKeyInput("");
  };

  const setManual = async (row: Row, date: Date) => {
    const iso = format(date, "yyyy-MM-dd");
    const { error } = await supabase.from("vendor_invoices").update({ delivery_date: iso } as any).eq("id", row.id);
    if (error) {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
      return;
    }
    setStates(prev => ({ ...prev, [row.id]: { kind: "success", date: iso } }));
    toast({ title: "Delivery date saved" });
  };

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold">Delivery Date Backfill</h1>
            <p className="text-sm text-muted-foreground">
              EOM-based invoices missing a delivery date. Re-runs Reader extraction to populate <code>delivery_date</code> only.
            </p>
          </div>
          <div className="flex gap-2">
            {!running && <Button onClick={handleStart} disabled={total === 0}><Play className="h-4 w-4" /> Re-read batch</Button>}
            {running && !paused && <Button onClick={handlePause} variant="secondary"><Pause className="h-4 w-4" /> Pause</Button>}
            {running && paused && <Button onClick={handleResume}><Play className="h-4 w-4" /> Resume</Button>}
            <Button onClick={handleReset} variant="outline"><RotateCcw className="h-4 w-4" /> Reset</Button>
          </div>
        </div>

        {showKeyPrompt && (
          <div className="border border-border rounded-md p-4 bg-card space-y-2">
            <div className="text-sm font-medium">Anthropic API key required</div>
            <div className="flex gap-2">
              <Input type="password" placeholder="sk-ant-..." value={keyInput} onChange={e => setKeyInput(e.target.value)} />
              <Button onClick={saveKey}>Save</Button>
            </div>
          </div>
        )}

        <div className="border border-border rounded-md p-3 bg-card">
          <div className="flex items-center justify-between text-xs mb-2">
            <span>{completed} / {total} processed</span>
            <span className="text-muted-foreground">
              Eligible w/ PDF: {total} · Without PDF: {rows.length - total}
            </span>
          </div>
          <Progress value={total > 0 ? (completed / total) * 100 : 0} />
        </div>

        <div className="border border-border rounded-md bg-card overflow-hidden">
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
                    <TableCell className="font-mono text-xs">
                      {st?.kind === "success" ? st.date : "—"}
                    </TableCell>
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
      </main>
    </div>
  );
}
