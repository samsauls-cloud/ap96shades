import { useState, useCallback, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Upload, CheckCircle2, AlertCircle, Loader2, XCircle, ExternalLink, Copy, RotateCcw, Timer, Zap, Package, FileSpreadsheet, Camera, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Link } from "react-router-dom";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { DocTypeBadge } from "@/components/invoices/Badges";
import { insertInvoice, formatCurrency, type VendorInvoiceInsert, getLineItems } from "@/lib/supabase-queries";
import { checkPendingMatches } from "@/lib/pending-match";
import { generatePaymentsForInvoice } from "@/lib/payment-queries";
import {
  CONCURRENCY, RETRY_CONCURRENCY, STAGGER_DELAY, RETRY_STAGGER_DELAY,
  RETRY_WAITS_429, RETRY_WAITS_OTHER, MAX_RETRIES_429, MAX_RETRIES_OTHER,
  RETRY_COOLDOWN,
  type ProcessedDoc, type DocStatus, type BatchStats, type FileDocPair,
  callAnthropicAPI, parsedToInvoice,
  fileToBase64, batchInsertInvoices, sleep, runRollingQueue, getRetryConfig,
} from "@/lib/reader-engine";
import {
  checkInvoiceDuplicate, mergeExtendedInvoice, updatePOTotalInvoiced, normalizeVendor,
} from "@/lib/invoice-dedup";
import { parseCSVToPOs, fileToText } from "@/lib/csv-po-parser";
import { isImageFile, imageToBase64, callAnthropicImageAPI } from "@/lib/photo-capture-engine";
import { runQuickSKUCheck, type SKUCheckResult } from "@/lib/sku-check-engine";

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
  const fileMapRef = useRef<Map<string, File>>(new Map());
  const [skuResults, setSkuResults] = useState<Map<string, SKUCheckResult>>(new Map());

  const saveApiKey = (key: string) => {
    const cleanKey = key.replace(/[^\x20-\x7E]/g, '').trim();
    setApiKey(cleanKey);
    localStorage.setItem("anthropic_api_key", cleanKey);
  };

  const isAcceptedFile = (f: File) =>
    (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".csv") || f.type === "text/csv") && !isImageFile(f);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter(f => isAcceptedFile(f) || isImageFile(f));
    if (files.length === 0) { toast.error("Only PDF, CSV, and image files are supported"); return; }
    const images = files.filter(isImageFile);
    const others = files.filter(f => !isImageFile(f));
    if (images.length > 0) processPhotoFiles(images);
    if (others.length > 0) setQueue(prev => [...prev, ...others]);
  }, [apiKey]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter(isAcceptedFile);
    if (files.length === 0) return;
    setQueue(prev => [...prev, ...files]);
    e.target.value = "";
  }, []);

  const handlePhotoInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter(isImageFile);
    if (files.length === 0) return;
    processPhotoFiles(files);
    e.target.value = "";
  }, [apiKey]);

  const processPhotoFiles = async (files: File[]) => {
    if (!apiKey) { toast.error("Please enter your Anthropic API key for photo processing"); return; }
    for (const file of files) {
      const docId = crypto.randomUUID();
      setDocs(prev => [...prev, {
        id: docId, filename: file.name, vendor: "", doc_type: "",
        invoice_number: "", total: 0, line_items_count: 0,
        status: "processing" as const, file,
      }]);

      try {
        const { base64, mediaType } = await imageToBase64(file);
        const parsed = await callAnthropicImageAPI(apiKey, base64, mediaType);
        const invoice = parsedToInvoice(parsed, file.name);
        invoice.import_source = "photo_capture";

        const lineItemsCount = (parsed.line_items || []).length;

        // Dedup check
        const dedupResult = await checkInvoiceDuplicate(
          invoice.invoice_number, invoice.vendor, parsed.line_items || [], invoice.total || 0
        );

        if (dedupResult.type === "true_duplicate") {
          updateDoc(docId, {
            status: "duplicate", vendor: invoice.vendor, doc_type: invoice.doc_type,
            invoice_number: invoice.invoice_number, total: invoice.total || 0,
            line_items_count: lineItemsCount, duplicateDbId: dedupResult.existingId,
          });
          continue;
        }

        const saved = await insertInvoice(invoice);
        const needsReview = parsed.needs_review === true;

        updateDoc(docId, {
          status: "done", vendor: invoice.vendor, doc_type: invoice.doc_type,
          invoice_number: invoice.invoice_number, total: invoice.total || 0,
          line_items_count: lineItemsCount, dbId: saved.id,
          extendedInfo: needsReview
            ? "⚠ Some fields may need verification — photo quality affected extraction."
            : undefined,
        });

        // Auto-generate payments
        try {
          await generatePaymentsForInvoice(
            saved.id, invoice.invoice_date, invoice.total || 0, invoice.vendor, invoice.invoice_number, invoice.po_number ?? null
          );
        } catch { /* silent */ }

        // Auto-run SKU check and attach results
        try {
          const skuResult = await runQuickSKUCheck(parsed.line_items || []);
          setSkuResults(prev => new Map(prev).set(docId, skuResult));
        } catch { /* silent */ }

        queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
        queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
        toast.success(`📷 Photo invoice extracted: ${invoice.vendor} — ${invoice.invoice_number}`);
      } catch (err: any) {
        updateDoc(docId, { status: "error", error: err.message || "Photo extraction failed" });
        toast.error(`Photo extraction failed: ${err.message}`);
      }
    }
  };

  const updateDoc = useCallback((docId: string, updates: Partial<ProcessedDoc>) => {
    setDocs(prev => prev.map(d => d.id === docId ? { ...d, ...updates } : d));
  }, []);

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
    let lastError: any = null;
    let attempt = 0;

    const tryCall = async (): Promise<any> => {
      try {
        return await callAnthropicAPI(apiKey, base64);
      } catch (err: any) {
        lastError = err;
        throw err;
      }
    };

    while (true) {
      if (cancelRef.current) return null;

      try {
        if (attempt > 0) {
          const config = getRetryConfig(lastError);
          const waitIdx = Math.min(attempt - 1, config.waits.length - 1);
          const waitMs = config.waits[waitIdx];
          const waitSec = Math.ceil(waitMs / 1000);
          const maxRetries = config.maxRetries;

          const errorLabel = lastError?.isRateLimit ? "Rate limited" :
                           lastError?.isTimeout ? "Timed out" :
                           lastError?.isParseError ? "Parse error" : "Error";

          for (let t = waitSec; t > 0; t--) {
            if (cancelRef.current) return null;
            updateDoc(docId, {
              status: "waiting-retry" as DocStatus,
              retryAttempt: attempt,
              retryCountdown: t,
              error: `⏳ ${file.name} ${errorLabel} — retrying in ${t}s (${attempt}/${maxRetries})`,
            });
            await sleep(1000);
          }
          updateDoc(docId, {
            status: "retrying" as DocStatus,
            retryAttempt: attempt,
            retryCountdown: 0,
            error: `Retrying ${file.name} (attempt ${attempt}/${maxRetries})`,
          });
        }

        const parsed = await tryCall();
        const invoice = parsedToInvoice(parsed, file.name);
        return { invoice, parsed };
      } catch (err: any) {
        lastError = err;
        attempt++;

        const config = getRetryConfig(err);
        if (attempt > config.maxRetries) {
          const label = err.isRateLimit ? `Rate limited after ${config.maxRetries} retries` :
                       err.isTimeout ? `Timed out after ${config.maxRetries} retries` :
                       err.message || "Unknown error";
          throw new Error(label);
        }
        continue;
      }
    }
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
      const lineItems = parsed.line_items || [];

      // Run dedup check
      const dedupResult = await checkInvoiceDuplicate(
        invoice.invoice_number,
        invoice.vendor,
        lineItems,
        invoice.total || 0
      );

      if (dedupResult.type === "true_duplicate") {
        updateDoc(docId, {
          status: "duplicate",
          vendor: invoice.vendor,
          doc_type: invoice.doc_type,
          invoice_number: invoice.invoice_number,
          total: invoice.total || 0,
          line_items_count: lineItemsCount,
          duplicateDbId: dedupResult.existingId,
        });
        return;
      }

      if (dedupResult.type === "extended") {
        if (!isAtomic) {
          await mergeExtendedInvoice(
            dedupResult.existingId,
            dedupResult.newItems,
            dedupResult.combinedTotal,
            invoice.invoice_date,
            file.name
          );
        }
        updateDoc(docId, {
          status: "extended",
          vendor: invoice.vendor,
          doc_type: invoice.doc_type,
          invoice_number: invoice.invoice_number,
          total: invoice.total || 0,
          line_items_count: dedupResult.newItems.length,
          dbId: dedupResult.existingId,
          extendedInfo: `⚡ EXTENDED INVOICE — ${dedupResult.newItems.length} new line items appended to Invoice ${invoice.invoice_number} (was ${dedupResult.oldCount} items, now ${dedupResult.newCount} items)`,
        });

        // Update PO linkage if applicable
        if (invoice.po_number) {
          const poResult = await updatePOTotalInvoiced(invoice.po_number, invoice.vendor);
          if (poResult.count > 1) {
            updateDoc(docId, {
              poLinkInfo: `Linked to PO ${invoice.po_number} (${poResult.count} invoices, total ${formatCurrency(poResult.total)})`,
            });
          }
        }
        return;
      }

      // New record
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

        // Auto-generate payment installments
        try {
          await generatePaymentsForInvoice(
            saved.id, invoice.invoice_date, invoice.total || 0, invoice.vendor, invoice.invoice_number, invoice.po_number ?? null
          );
        } catch { /* silent — payments are secondary */ }

        // Auto-check for pending matches against partially reconciled sessions
        try {
          const pendingMatches = await checkPendingMatches(saved.id, invoice.invoice_number, lineItems);
          if (pendingMatches.length > 0) {
            for (const pm of pendingMatches) {
              toast(`📥 Invoice ${pm.invoiceNumber} matches ${pm.matchedLineCount} unmatched lines from "${pm.sessionName}"`, {
                description: 'Go to Receiving to reconcile',
                duration: 8000,
              });
            }
          }
        } catch { /* silent — pending match is advisory */ }

        // PO linkage
        if (invoice.po_number) {
          const poResult = await updatePOTotalInvoiced(invoice.po_number, invoice.vendor);
          if (poResult.count > 1) {
            updateDoc(docId, {
              poLinkInfo: `✓ Linked to PO ${invoice.po_number} (${poResult.count} invoices against this PO total ${formatCurrency(poResult.total)})`,
            });
          }
        }
      }
    } catch (err: any) {
      updateDoc(docId, { status: "error", error: err.message });
    }
  };

  const processCSVFile = async (file: File) => {
    const csvDocId = crypto.randomUUID();
    setDocs(prev => [...prev, {
      id: csvDocId, filename: file.name, vendor: "", doc_type: "PO",
      invoice_number: "", total: 0, line_items_count: 0,
      status: "processing" as const, file,
    }]);

    try {
      const text = await fileToText(file);
      const result = parseCSVToPOs(text, file.name);

      if (result.invoices.length === 0) {
        updateDoc(csvDocId, { status: "error", error: "No valid PO lines found in CSV" });
        return;
      }

      // Save each vendor PO
      const savedIds: string[] = [];
      for (const invoice of result.invoices) {
        // Dedup check
        const dedupResult = await checkInvoiceDuplicate(
          invoice.invoice_number!, invoice.vendor, invoice.line_items as any, invoice.total || 0
        );

        if (dedupResult.type === "true_duplicate") {
          continue; // skip dupes silently within CSV
        }

        const saved = await insertInvoice(invoice);
        savedIds.push(saved.id);

        // Auto-generate payments
        try {
          await generatePaymentsForInvoice(
            saved.id, invoice.invoice_date, invoice.total || 0,
            invoice.vendor, invoice.invoice_number!, invoice.po_number ?? null
          );
        } catch { /* silent */ }
      }

      const vendorList = Object.entries(result.vendorSummary)
        .map(([v, c]) => `${v} (${c})`)
        .join(", ");
      const discountNote = result.discountApplied ? " · 10% vendor discount applied" : "";

      updateDoc(csvDocId, {
        status: "done",
        vendor: Object.keys(result.vendorSummary).join(", "),
        doc_type: "PO",
        invoice_number: result.invoices.map(i => i.invoice_number).join(", "),
        total: result.invoices.reduce((s, i) => s + (i.total || 0), 0),
        line_items_count: result.totalLines,
        dbId: savedIds[0],
        extendedInfo: `📋 CSV PO — ${result.totalLines} lines across ${result.invoices.length} vendor(s): ${vendorList}${discountNote}`,
      });

      toast.success(`CSV imported: ${result.totalLines} PO lines, ${result.invoices.length} vendor PO(s) created`);
    } catch (err: any) {
      updateDoc(csvDocId, { status: "error", error: err.message });
      toast.error(`CSV error: ${err.message}`);
    }
  };

  const processQueue = async () => {
    if (queue.length === 0) { toast.error("No files in queue"); return; }

    // Separate CSVs from PDFs
    const csvFiles = queue.filter(f => f.name.toLowerCase().endsWith(".csv") || f.type === "text/csv");
    const pdfFiles = queue.filter(f => f.type === "application/pdf");

    // Process CSVs first (no API key needed)
    if (csvFiles.length > 0) {
      setQueue(prev => prev.filter(f => !csvFiles.includes(f)));
      for (const csv of csvFiles) {
        await processCSVFile(csv);
      }
      queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
      queryClient.invalidateQueries({ queryKey: ["distinct_vendors"] });
    }

    // Process PDFs (needs API key)
    if (pdfFiles.length === 0) {
      if (csvFiles.length > 0) {
        setQueue([]);
        return; // CSVs already processed
      }
      toast.error("No files in queue");
      return;
    }

    if (!apiKey) { toast.error("Please enter your Anthropic API key for PDF processing"); return; }

    setProcessing(true);
    cancelRef.current = false;
    startTimeRef.current = Date.now();
    setElapsed(0);

    const filesToProcess = [...pdfFiles];
    setBatchTotal(filesToProcess.length);
    setBatchComplete(0);
    setQueue([]);

    const fileDocPairs: FileDocPair[] = filesToProcess.map(file => ({
      file,
      docId: crypto.randomUUID(),
    }));

    fileDocPairs.forEach(({ file, docId }) => {
      fileMapRef.current.set(docId, file);
    });

    setDocs(prev => [
      ...prev,
      ...fileDocPairs.map(({ file, docId }) => ({
        id: docId, filename: file.name, vendor: "", doc_type: "",
        invoice_number: "", total: 0, line_items_count: 0,
        status: "processing" as const,
        file,
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
      setDocs(prev => prev.map(d =>
        d.status === "processing" && fileDocPairs.some(p => p.docId === d.id)
          ? { ...d, status: "error" as const, error: "Cancelled" }
          : d
      ));
      toast.info(`Batch cancelled. ${completed} of ${filesToProcess.length} processed.`);
    }

    if (atomicMode && !cancelRef.current) {
      await finalizeAtomicBatch(fileDocPairs);
    }

    setProcessing(false);
    setBatchTotal(0);
    queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
    queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
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
      toast.error(`⛔ Batch aborted — ${failed[0].filename} failed. 0 records saved.`);
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
        const extCount = currentDocs.filter(d => d.status === "extended").length;
        toast.success(`✓ Batch complete — ${stagedDocs.length} saved, ${dupCount} duplicates skipped, ${extCount} extended`);
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

    const retryPairs: FileDocPair[] = [];
    for (const d of failedDocs) {
      const file = fileMapRef.current.get(d.id) || d.file;
      if (!file) {
        toast.error(`Cannot retry ${d.filename} — file reference lost. Please re-upload.`);
        return;
      }
      retryPairs.push({ file, docId: d.id });
    }

    setIsRetrying(true);
    cancelRef.current = false;

    for (let t = Math.ceil(RETRY_COOLDOWN / 1000); t > 0; t--) {
      if (cancelRef.current) { setIsRetrying(false); return; }
      setRetryCountdown(t);
      await sleep(1000);
    }
    setRetryCountdown(0);

    setProcessing(true);
    startTimeRef.current = Date.now();
    setElapsed(0);
    setBatchTotal(retryPairs.length);
    setBatchComplete(0);

    retryPairs.forEach(p => {
      updateDoc(p.docId, { status: "processing", error: undefined, retryAttempt: undefined, retryCountdown: undefined });
    });

    let completed = 0;

    await runRollingQueue(
      retryPairs,
      RETRY_CONCURRENCY,
      RETRY_STAGGER_DELAY,
      async (pair) => {
        await processSingleFile(pair.file, pair.docId, false);
        completed++;
        setBatchComplete(completed);
      },
      cancelRef,
    );

    setProcessing(false);
    setIsRetrying(false);
    setBatchTotal(0);
    queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
    queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
    queryClient.invalidateQueries({ queryKey: ["distinct_vendors"] });
    toast.success(`Retry complete. ${completed} file(s) reprocessed.`);
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
    if (d.status === "extended") {
      s.extended++;
      s.lineItems += d.line_items_count;
    }
    if (d.status === "duplicate") s.trueDuplicates++;
    if (d.status === "error") s.failed++;
    if (d.status === "done" || d.status === "duplicate" || d.status === "error" || d.status === "extended") s.processed++;
    if (d.poLinkInfo) s.poLinks++;
    return s;
  }, { processed: 0, saved: 0, trueDuplicates: 0, extended: 0, failed: 0, totalValue: 0, totalUnits: 0, invoices: 0, pos: 0, lineItems: 0, poLinks: 0 });

  const estRemaining = (() => {
    if (batchComplete === 0 || batchTotal === 0) return "";
    const avgMs = elapsed / batchComplete;
    const remaining = (batchTotal - batchComplete) * avgMs;
    return formatElapsed(remaining);
  })();

  const avgTimePerDoc = stats.processed > 0 && elapsed > 0
    ? `${Math.round(elapsed / stats.processed / 1000)}s`
    : "";

  const progressPercent = batchTotal > 0 ? (batchComplete / batchTotal) * 100 : 0;
  const failedCount = docs.filter(d => d.status === "error" && d.error !== "Cancelled").length;

  const statusIcon = (d: ProcessedDoc) => {
    switch (d.status) {
      case "processing": return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
      case "retrying":
      case "waiting-retry": return <Timer className="h-4 w-4 text-amber-500 animate-pulse" />;
      case "done": return <CheckCircle2 className="h-4 w-4 text-status-paid" />;
      case "staged": return <CheckCircle2 className="h-4 w-4 text-amber-500" />;
      case "duplicate": return <Copy className="h-4 w-4 text-muted-foreground" />;
      case "extended": return <Zap className="h-4 w-4 text-blue-500" />;
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
          <CardContent className="p-6 sm:p-8 flex flex-col items-center justify-center text-center">
            <div className="flex items-center gap-3 mb-3">
              <Upload className="h-8 w-8 sm:h-10 sm:w-10 text-muted-foreground" />
              <FileSpreadsheet className="h-6 w-6 sm:h-8 sm:w-8 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium mb-1">Drop PDF invoices or CSV POs here</p>
            <p className="text-xs text-muted-foreground mb-3">PDFs are extracted via AI · CSVs are parsed as Lightspeed POs (Marchon 10% discount auto-applied)</p>
            <label className="w-full sm:w-auto">
              <input type="file" accept=".pdf,.csv" multiple onChange={handleFileInput} className="hidden" />
              <Button variant="outline" size="default" className="text-sm w-full sm:w-auto h-12 sm:h-10" asChild>
                <span>Choose Files</span>
              </Button>
            </label>
            {queue.length > 0 && (
              <div className="mt-4 space-y-1">
                <p className="text-xs font-semibold">{queue.length} file(s) queued:</p>
                {queue.map((f, i) => (
                  <p key={i} className="text-xs text-muted-foreground truncate max-w-[250px]">{f.name}</p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 border-t border-border" />
          <span className="text-xs text-muted-foreground font-medium">or</span>
          <div className="flex-1 border-t border-border" />
        </div>

        {/* Photo Capture Zone */}
        <Card className="bg-card border-border border-dashed">
          <CardContent className="p-6 sm:p-8 flex flex-col items-center justify-center text-center">
            <Camera className="h-10 w-10 sm:h-10 sm:w-10 text-muted-foreground mb-3" />
            <p className="text-sm sm:text-sm font-medium mb-1">📷 Photo Capture</p>
            <p className="text-xs text-muted-foreground mb-4">Take a photo of a printed invoice or upload from photo library</p>
            <div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
              <label className="w-full sm:w-auto">
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoInput}
                  className="hidden"
                />
                <Button variant="default" size="default" className="text-sm gap-2 w-full sm:w-auto h-12 sm:h-10" asChild>
                  <span><Camera className="h-4 w-4" /> Open Camera</span>
                </Button>
              </label>
              <label className="w-full sm:w-auto">
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
                  multiple
                  onChange={handlePhotoInput}
                  className="hidden"
                />
                <Button variant="outline" size="default" className="text-sm gap-2 w-full sm:w-auto h-12 sm:h-10" asChild>
                  <span><ImageIcon className="h-4 w-4" /> Upload Photo</span>
                </Button>
              </label>
            </div>
            <p className="text-[10px] text-muted-foreground mt-3">Supports JPG, PNG, HEIC, WEBP</p>
          </CardContent>
        </Card>


        {(queue.length > 0 || processing) && (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <Button onClick={processQueue} disabled={processing} className="flex-1">
                {processing ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Processing…</>
                ) : (
                  <>Process {queue.length} File(s) ({queue.filter(f => f.type === "application/pdf").length} PDF, {queue.filter(f => f.name.toLowerCase().endsWith(".csv") || f.type === "text/csv").length} CSV)</>
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
                <div className="flex flex-col sm:flex-row justify-between text-xs text-muted-foreground gap-1">
                  <span>
                    {batchComplete} / {batchTotal} — {stats.saved} saved · {stats.extended} merged · {stats.trueDuplicates} dupes · {stats.failed} failed
                  </span>
                  <span>
                    Elapsed: {formatElapsed(elapsed)}{estRemaining && ` · Est: ${estRemaining}`}
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
                  <p className="text-lg font-bold text-blue-500">{stats.extended}</p>
                  <p className="text-[10px] text-muted-foreground">Extended/Merged</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-muted-foreground">{stats.trueDuplicates}</p>
                  <p className="text-[10px] text-muted-foreground">True Duplicates</p>
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
                {stats.poLinks > 0 && (
                  <div>
                    <p className="text-lg font-bold text-primary">{stats.poLinks}</p>
                    <p className="text-[10px] text-muted-foreground">PO Links</p>
                  </div>
                )}
                {!processing && elapsed > 0 && (
                  <div>
                    <p className="text-lg font-bold">{formatElapsed(elapsed)}</p>
                    <p className="text-[10px] text-muted-foreground">Elapsed Time</p>
                  </div>
                )}
                {!processing && avgTimePerDoc && (
                  <div>
                    <p className="text-lg font-bold">{avgTimePerDoc}</p>
                    <p className="text-[10px] text-muted-foreground">Avg Time/Doc</p>
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
                    d.status === "duplicate" ? "border-muted-foreground/20" :
                    d.status === "extended" ? "border-blue-500/30" :
                    d.status === "waiting-retry" || d.status === "retrying" ? "border-amber-500/30" : ""
                  }`}
                >
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 sm:gap-3 min-w-0 flex-1">
                        <div className="mt-0.5 shrink-0">{statusIcon(d)}</div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1 sm:gap-2">
                            <span className="text-sm font-medium truncate max-w-[180px] sm:max-w-none">{d.filename}</span>
                            {(d.status === "done" || d.status === "staged" || d.status === "extended") && <DocTypeBadge docType={d.doc_type} />}
                            {d.status === "staged" && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 font-medium">STAGED</span>
                            )}
                            {d.status === "extended" && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 font-medium">EXTENDED</span>
                            )}
                          </div>
                          {(d.status === "done" || d.status === "staged") && (
                            <p className="text-[10px] text-muted-foreground break-words">
                              {d.vendor} — {d.invoice_number} — {formatCurrency(d.total)} — {d.line_items_count} items
                            </p>
                          )}
                          {d.status === "extended" && d.extendedInfo && (
                            <p className="text-[10px] text-blue-500 break-words">{d.extendedInfo}</p>
                          )}
                          {d.status === "duplicate" && (
                            <p className="text-[10px] text-muted-foreground break-words">
                              ✗ TRUE DUPLICATE SKIPPED — identical line items. Invoice {d.invoice_number} from {d.vendor}
                            </p>
                          )}
                          {(d.status === "retrying" || d.status === "waiting-retry") && (
                            <p className="text-[10px] text-amber-500 break-words">{d.error}</p>
                          )}
                          {d.status === "error" && (
                            <p className="text-[10px] text-status-unpaid break-words">{d.error}</p>
                          )}
                          {d.poLinkInfo && (
                            <p className="text-[10px] text-primary flex items-center gap-1 mt-0.5 break-words">
                              <Package className="h-3 w-3 shrink-0" /> {d.poLinkInfo}
                            </p>
                          )}
                        </div>
                      </div>
                      {(d.status === "done" || d.status === "extended") && d.dbId && (
                        <Link to="/invoices" className="flex items-center gap-1 text-xs text-primary hover:underline shrink-0">
                          View <ExternalLink className="h-3 w-3" />
                        </Link>
                      )}
                    </div>
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
