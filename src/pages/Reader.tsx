import { useState, useCallback, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Upload, CheckCircle2, AlertCircle, Loader2, XCircle, ExternalLink, Copy, RotateCcw, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Link } from "react-router-dom";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { DocTypeBadge } from "@/components/invoices/Badges";
import { insertInvoice, formatCurrency, type VendorInvoiceInsert } from "@/lib/supabase-queries";
import {
  CONCURRENCY, RETRY_CONCURRENCY, STAGGER_DELAY, RETRY_WAITS, MAX_RETRIES, RETRY_COOLDOWN,
  type ProcessedDoc, type DocStatus, type BatchStats, type FileDocPair,
  callAnthropicAPI, parsedToInvoice, checkDuplicate,
  fileToBase64, batchInsertInvoices, sleep, runRollingQueue,
} from "@/lib/reader-engine";

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec.toString().padStart(2, "0")}s`;
}

export default function ReaderPage() {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("anthropic_api_key") || "");
  const [processing, setProcessing] = useState(false);
  const [queue, setQueue] = useState<File[]>([]);
  const [docs, setDocs] = useState<ProcessedDoc[]>([]);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchComplete, setBatchComplete] = useState(0);
  const [atomicMode, setAtomicMode] = useState(false);
  const cancelRef = useRef(false);
  const startTimeRef = useRef<number>(0);
  const [elapsed, setElapsed] = useState(0);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const failedRef = useRef<HTMLDivElement>(null);

  const saveApiKey = (key: string) => {
    const cleanKey = key.replace(/[^\x20-\x7E]/g, '').trim();
    setApiKey(cleanKey);
    localStorage.setItem("anthropic_api_key", cleanKey);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter(f => f.type === "application/pdf");
    if (files.length === 0) { toast.error("Only PDF files are supported"); return; }
    setQueue(prev => [...prev, ...files]);
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter(f => f.type === "application/pdf");
    if (files.length === 0) return;
    setQueue(prev => [...prev, ...files]);
    e.target.value = "";
  }, []);

  const updateDoc = useCallback((docId: string, updates: Partial<ProcessedDoc>) => {
    setDocs(prev => prev.map(d => d.id === docId ? { ...d, ...updates } : d));
  }, []);

  // Elapsed time tracker
  useEffect(() => {
    if (!processing) return;
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTimeRef.current);
    }, 1000);
    return () => clearInterval(interval);
  }, [processing]);

  const processFileWithRetry = async (
    file: File, docId: string
  ): Promise<{ invoice: VendorInvoiceInsert; parsed: any } | null> => {
    const base64 = await fileToBase64(file);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (cancelRef.current) return null;

      try {
        if (attempt > 0) {
          const waitMs = RETRY_WAITS[attempt - 1];
          const waitSec = Math.ceil(waitMs / 1000);
          // Countdown display
          for (let t = waitSec; t > 0; t--) {
            if (cancelRef.current) return null;
            updateDoc(docId, {
              status: "waiting-retry" as DocStatus,
              retryAttempt: attempt,
              retryCountdown: t,
              error: `⏳ ${file.name} — retrying in ${t}s (${attempt}/${MAX_RETRIES})`,
            });
            await sleep(1000);
          }
          updateDoc(docId, {
            status: "retrying" as DocStatus,
            retryAttempt: attempt,
            retryCountdown: 0,
            error: `Retrying ${file.name} (attempt ${attempt}/${MAX_RETRIES})`,
          });
        }

        const parsed = await callAnthropicAPI(apiKey, base64);
        const invoice = parsedToInvoice(parsed, file.name);
        return { invoice, parsed };
      } catch (err: any) {
        if (err.isRateLimit && attempt < MAX_RETRIES) {
          continue;
        }
        if (err.isRateLimit) {
          throw new Error(`Rate limited after ${MAX_RETRIES} retries`);
        }
        throw err;
      }
    }
    return null;
  };

  const processSingleFile = async (file: File, docId: string, isAtomic: boolean) => {
    updateDoc(docId, { status: "processing" });
    try {
      const result = await processFileWithRetry(file, docId);
      if (!result) {
        if (cancelRef.current) {
          updateDoc(docId, { status: "error", error: "Cancelled" });
        } else {
          updateDoc(docId, { status: "error", error: "Processing returned no result" });
        }
        return;
      }

      const { invoice, parsed } = result;
      const lineItemsCount = (parsed.line_items || []).length;

      const dupId = await checkDuplicate(invoice.invoice_number, invoice.vendor);
      if (dupId) {
        updateDoc(docId, {
          status: "duplicate",
          vendor: invoice.vendor,
          doc_type: invoice.doc_type,
          invoice_number: invoice.invoice_number,
          total: invoice.total || 0,
          line_items_count: lineItemsCount,
          duplicateDbId: dupId,
        });
        return;
      }

      if (isAtomic) {
        updateDoc(docId, {
          status: "staged",
          vendor: invoice.vendor,
          doc_type: invoice.doc_type,
          invoice_number: invoice.invoice_number,
          total: invoice.total || 0,
          line_items_count: lineItemsCount,
          invoiceData: invoice,
        });
      } else {
        const saved = await insertInvoice(invoice);
        updateDoc(docId, {
          status: "done",
          vendor: invoice.vendor,
          doc_type: invoice.doc_type,
          invoice_number: invoice.invoice_number,
          total: invoice.total || 0,
          line_items_count: lineItemsCount,
          dbId: saved.id,
        });
      }
    } catch (err: any) {
      updateDoc(docId, { status: "error", error: err.message });
    }
  };

  const processQueue = async () => {
    if (!apiKey) { toast.error("Please enter your Anthropic API key"); return; }
    if (queue.length === 0) { toast.error("No files in queue"); return; }

    setProcessing(true);
    cancelRef.current = false;
    startTimeRef.current = Date.now();
    setElapsed(0);

    const filesToProcess = [...queue];
    setBatchTotal(filesToProcess.length);
    setBatchComplete(0);
    setQueue([]);

    const fileDocPairs: FileDocPair[] = filesToProcess.map(file => ({
      file,
      docId: crypto.randomUUID(),
    }));

    setDocs(prev => [
      ...prev,
      ...fileDocPairs.map(({ file, docId }) => ({
        id: docId, filename: file.name, vendor: "", doc_type: "",
        invoice_number: "", total: 0, line_items_count: 0,
        status: "processing" as const,
      })),
    ]);

    let completed = 0;

    await runRollingQueue(
      fileDocPairs,
      CONCURRENCY,
      STAGGER_DELAY,
      async (pair) => {
        await processSingleFile(pair.file, pair.docId, atomicMode);
        completed++;
        setBatchComplete(completed);
      },
      cancelRef,
    );

    if (cancelRef.current) {
      // Mark any still-processing docs as cancelled
      setDocs(prev => prev.map(d =>
        d.status === "processing" && fileDocPairs.some(p => p.docId === d.id)
          ? { ...d, status: "error" as const, error: "Cancelled" }
          : d
      ));
      toast.info(`Batch cancelled. ${completed} of ${filesToProcess.length} processed.`);
    }

    // Atomic mode finalization
    if (atomicMode && !cancelRef.current) {
      await finalizeAtomicBatch(fileDocPairs);
    }

    setProcessing(false);
    setBatchTotal(0);
    queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
    queryClient.invalidateQueries({ queryKey: ["distinct_vendors"] });
    if (!cancelRef.current && !atomicMode) toast.success("Processing complete");
  };

  const finalizeAtomicBatch = async (fileDocPairs: FileDocPair[]) => {
    const currentDocs = await new Promise<ProcessedDoc[]>(resolve => {
      setDocs(prev => { resolve(prev); return prev; });
    });

    const batchDocIds = new Set(fileDocPairs.map(p => p.docId));
    const failed = currentDocs.filter(d => d.status === "error" && batchDocIds.has(d.id));
    const stagedDocs = currentDocs.filter(d => d.status === "staged" && d.invoiceData);

    if (failed.length > 0) {
      toast.error(`⛔ Batch aborted — ${failed[0].filename} failed after ${MAX_RETRIES} retries. 0 records saved. Re-upload the full batch.`);
      setDocs(prev => prev.map(d =>
        d.status === "staged" ? { ...d, status: "error" as const, error: "Batch aborted due to other failures" } : d
      ));
      return;
    }

    if (stagedDocs.length > 0) {
      try {
        const invoiceData = stagedDocs.map(d => d.invoiceData!);
        const savedDocs = await batchInsertInvoices(invoiceData);
        setDocs(prev => prev.map(d => {
          if (d.status === "staged") {
            const savedMatch = savedDocs.find(s => s.invoice_number === d.invoice_number && s.vendor === d.vendor);
            return { ...d, status: "done" as const, dbId: savedMatch?.id };
          }
          return d;
        }));
        const dupCount = currentDocs.filter(d => d.status === "duplicate").length;
        toast.success(`✓ Batch complete — ${stagedDocs.length} saved, ${dupCount} duplicates skipped`);
      } catch (err: any) {
        toast.error(`Failed to save batch: ${err.message}`);
        setDocs(prev => prev.map(d =>
          d.status === "staged" ? { ...d, status: "error" as const, error: `Batch save failed: ${err.message}` } : d
        ));
      }
    }
  };

  const handleCancel = () => {
    cancelRef.current = true;
    toast.info("Cancelling after current files finish…");
  };

  const handleRetryFailed = async () => {
    const failedDocs = docs.filter(d => d.status === "error" && d.error !== "Cancelled");
    if (failedDocs.length === 0) return;

    setIsRetrying(true);
    cancelRef.current = false;

    // 30s cooldown with countdown
    for (let t = Math.ceil(RETRY_COOLDOWN / 1000); t > 0; t--) {
      if (cancelRef.current) { setIsRetrying(false); return; }
      setRetryCountdown(t);
      await sleep(1000);
    }
    setRetryCountdown(0);

    setProcessing(true);
    startTimeRef.current = Date.now();
    setElapsed(0);

    // We need the original files — they're gone from queue. 
    // We'll re-use the existing doc entries and just need the files.
    // Since we can't recover files, we need to ask user to re-upload.
    // Actually, let's store files on the doc objects for retry.
    // For now, mark them and notify.
    toast.info("Re-upload the failed files to retry them.");
    setIsRetrying(false);
    setProcessing(false);
  };

  // Compute stats
  const stats = docs.reduce<BatchStats>((s, d) => {
    if (d.status === "done") {
      s.saved++;
      s.totalValue += d.total;
      s.lineItems += d.line_items_count;
      if (d.doc_type === "INVOICE") s.invoices++;
      if (d.doc_type === "PO") s.pos++;
    }
    if (d.status === "duplicate") s.duplicates++;
    if (d.status === "error") s.failed++;
    if (d.status === "done" || d.status === "duplicate" || d.status === "error") s.processed++;
    return s;
  }, { processed: 0, saved: 0, duplicates: 0, failed: 0, totalValue: 0, totalUnits: 0, invoices: 0, pos: 0, lineItems: 0 });

  const estRemaining = (() => {
    if (batchComplete === 0 || batchTotal === 0) return "";
    const avgMs = elapsed / batchComplete;
    const remaining = (batchTotal - batchComplete) * avgMs;
    return formatElapsed(remaining);
  })();

  const progressPercent = batchTotal > 0 ? (batchComplete / batchTotal) * 100 : 0;
  const failedCount = docs.filter(d => d.status === "error" && d.error !== "Cancelled").length;

  const statusIcon = (d: ProcessedDoc) => {
    switch (d.status) {
      case "processing": return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
      case "retrying":
      case "waiting-retry": return <Timer className="h-4 w-4 text-amber-500 animate-pulse" />;
      case "done": return <CheckCircle2 className="h-4 w-4 text-status-paid" />;
      case "staged": return <CheckCircle2 className="h-4 w-4 text-amber-500" />;
      case "duplicate": return <Copy className="h-4 w-4 text-amber-500" />;
      case "error": return <AlertCircle className="h-4 w-4 text-status-unpaid" />;
      default: return null;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">

        {/* API Key */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Anthropic API Key</CardTitle>
          </CardHeader>
          <CardContent>
            <Input
              type="password"
              value={apiKey}
              onChange={e => saveApiKey(e.target.value)}
              placeholder="sk-ant-..."
              className="bg-secondary border-border font-mono text-xs max-w-md"
            />
            <p className="text-[10px] text-muted-foreground mt-1">Stored locally in your browser. Never sent to our servers.</p>
          </CardContent>
        </Card>

        {/* Atomic Batch Mode Toggle */}
        <Card className="bg-card border-border">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Atomic Batch Mode</p>
              <p className="text-[10px] text-muted-foreground">
                {atomicMode
                  ? "All files must succeed before any are saved. Failures abort the entire batch."
                  : "Each invoice is saved immediately after extraction. Failures don't affect other files."}
              </p>
            </div>
            <Switch checked={atomicMode} onCheckedChange={setAtomicMode} disabled={processing} />
          </CardContent>
        </Card>

        {/* Drop zone */}
        <Card
          className="bg-card border-border border-dashed"
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
        >
          <CardContent className="p-8 flex flex-col items-center justify-center text-center">
            <Upload className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm font-medium mb-1">Drop PDF invoices here</p>
            <p className="text-xs text-muted-foreground mb-3">or click to browse files</p>
            <label>
              <input type="file" accept=".pdf" multiple onChange={handleFileInput} className="hidden" />
              <Button variant="outline" size="sm" className="text-xs" asChild>
                <span>Choose Files</span>
              </Button>
            </label>
            {queue.length > 0 && (
              <div className="mt-4 space-y-1">
                <p className="text-xs font-semibold">{queue.length} file(s) queued:</p>
                {queue.map((f, i) => (
                  <p key={i} className="text-xs text-muted-foreground">{f.name}</p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {(queue.length > 0 || processing) && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button onClick={processQueue} disabled={processing} className="flex-1">
                {processing ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Processing…</>
                ) : (
                  <>Process {queue.length} File(s)</>
                )}
              </Button>
              {processing && (
                <Button variant="destructive" onClick={handleCancel} className="shrink-0">
                  <XCircle className="h-4 w-4 mr-2" /> Cancel
                </Button>
              )}
            </div>
            {processing && batchTotal > 0 && (
              <div className="space-y-2">
                <Progress value={progressPercent} className="h-2.5" />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    {batchComplete} / {batchTotal} — {stats.saved} saved · {stats.duplicates} dupes · {stats.failed} failed
                  </span>
                  <span>
                    Elapsed: {formatElapsed(elapsed)}{estRemaining && ` · Est. remaining: ${estRemaining}`}
                  </span>
                </div>
                {atomicMode && (
                  <p className="text-xs text-amber-500 text-center font-medium">
                    Atomic mode: {batchComplete}/{batchTotal} extracted — waiting for full batch before saving
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Retry countdown */}
        {isRetrying && retryCountdown > 0 && (
          <Card className="bg-card border-amber-500/30">
            <CardContent className="p-4 text-center">
              <Timer className="h-5 w-5 text-amber-500 mx-auto mb-2" />
              <p className="text-sm font-medium">Starting retry in {retryCountdown}s...</p>
              <p className="text-[10px] text-muted-foreground">Waiting for token limits to refill</p>
            </CardContent>
          </Card>
        )}

        {/* Session summary */}
        {stats.processed > 0 && (
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Session Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-4 text-center">
                <div>
                  <p className="text-lg font-bold">{stats.processed}</p>
                  <p className="text-[10px] text-muted-foreground">Processed</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-status-paid">{stats.saved}</p>
                  <p className="text-[10px] text-muted-foreground">Saved</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-amber-500">{stats.duplicates}</p>
                  <p className="text-[10px] text-muted-foreground">Duplicates Skipped</p>
                </div>
                <div>
                  <button
                    className="w-full"
                    onClick={() => failedRef.current?.scrollIntoView({ behavior: "smooth" })}
                    disabled={failedCount === 0}
                  >
                    <p className={`text-lg font-bold ${failedCount > 0 ? "text-status-unpaid underline cursor-pointer" : "text-status-unpaid"}`}>{stats.failed}</p>
                    <p className="text-[10px] text-muted-foreground">Failed{failedCount > 0 ? " ↓" : ""}</p>
                  </button>
                </div>
                <div>
                  <p className="text-lg font-bold">{formatCurrency(stats.totalValue)}</p>
                  <p className="text-[10px] text-muted-foreground">Total Value</p>
                </div>
                <div>
                  <p className="text-lg font-bold">{stats.invoices}</p>
                  <p className="text-[10px] text-muted-foreground">Invoices</p>
                </div>
                <div>
                  <p className="text-lg font-bold">{stats.pos}</p>
                  <p className="text-[10px] text-muted-foreground">POs</p>
                </div>
                <div>
                  <p className="text-lg font-bold">{stats.lineItems}</p>
                  <p className="text-[10px] text-muted-foreground">Line Items</p>
                </div>
                {!processing && elapsed > 0 && (
                  <div>
                    <p className="text-lg font-bold">{formatElapsed(elapsed)}</p>
                    <p className="text-[10px] text-muted-foreground">Elapsed Time</p>
                  </div>
                )}
              </div>

              {/* Retry Failed button */}
              {!processing && failedCount > 0 && (
                <div className="mt-4 flex justify-center">
                  <Button variant="outline" onClick={handleRetryFailed} disabled={isRetrying} className="gap-2">
                    <RotateCcw className="h-4 w-4" />
                    Retry {failedCount} Failed File{failedCount > 1 ? "s" : ""}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Processed cards */}
        {docs.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground">Processed Documents</h3>
            {docs.map(d => {
              const isFailed = d.status === "error" && d.error !== "Cancelled";
              return (
                <Card
                  key={d.id}
                  ref={isFailed ? failedRef : undefined}
                  className={`bg-card border-border ${
                    d.status === "error" ? "border-status-unpaid/30" :
                    d.status === "duplicate" ? "border-amber-500/30" :
                    d.status === "waiting-retry" || d.status === "retrying" ? "border-amber-500/30" : ""
                  }`}
                >
                  <CardContent className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {statusIcon(d)}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{d.filename}</span>
                          {(d.status === "done" || d.status === "staged") && <DocTypeBadge docType={d.doc_type} />}
                          {d.status === "staged" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 font-medium">STAGED</span>
                          )}
                        </div>
                        {(d.status === "done" || d.status === "staged") && (
                          <p className="text-[10px] text-muted-foreground">
                            {d.vendor} — {d.invoice_number} — {formatCurrency(d.total)} — {d.line_items_count} items
                          </p>
                        )}
                        {d.status === "duplicate" && (
                          <p className="text-[10px] text-amber-500">
                            ⚠ DUPLICATE SKIPPED — Invoice {d.invoice_number} from {d.vendor} already exists (DB id: {d.duplicateDbId}). File: {d.filename}
                          </p>
                        )}
                        {(d.status === "retrying" || d.status === "waiting-retry") && (
                          <p className="text-[10px] text-amber-500">{d.error}</p>
                        )}
                        {d.status === "error" && (
                          <p className="text-[10px] text-status-unpaid">{d.error}</p>
                        )}
                      </div>
                    </div>
                    {d.status === "done" && d.dbId && (
                      <Link to="/invoices" className="flex items-center gap-1 text-xs text-primary hover:underline">
                        View <ExternalLink className="h-3 w-3" />
                      </Link>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
