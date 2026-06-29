// Self-orchestrating server-side backfill for vendor_invoices.delivery_date.
// One client call starts a job. The function runs the entire job in the
// background via EdgeRuntime.waitUntil(), self-chaining its own endpoint
// before hitting the per-invocation wall-clock limit.
//
// HARD CONSTRAINTS:
//  - Writes ONLY vendor_invoices.delivery_date (idempotent: .is delivery_date null).
//  - No amounts, line_items, status, invoice_payments, payment_history,
//    schedule recompute. No other column/table/Guard touched.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const FETCH_TIMEOUT = 90_000;
const CHUNK_SIZE = 5;
const MAX_WALL_MS = 90_000; // self-chain before hitting edge wall-clock cap
const MODEL = "claude-sonnet-4-6";

const DELIVERY_PROMPT = `You are extracting ONE field from a vendor invoice PDF: the DELIVERY / SHIP date of the goods (distinct from the order date and the invoice date). Labels include "Delivery date", "Ship date", "Shipped", "Data consegna", "Data DDT". If an order date and a separate later delivery/ship date both appear, return the delivery/ship date. If none is present, return null — NEVER copy the invoice date. Return ONLY raw JSON of the form {"delivery_date": "YYYY-MM-DD" | null}. No markdown, no code fences, no preamble.`;

// ─── Declared for the edge runtime; falls back to immediate await locally.
// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;

function normalizeInvoiceYear(dateStr: string): string {
  if (!dateStr) return dateStr;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  const year = parseInt(m[1]);
  const currentYear = new Date().getFullYear();
  if (Math.abs(year - currentYear) > 2) {
    const twoDigit = year % 100;
    const corrected = Math.floor(currentYear / 100) * 100 + twoDigit;
    if (Math.abs(corrected - currentYear) <= 2) {
      return `${corrected}-${m[2]}-${m[3]}`;
    }
  }
  return dateStr;
}

function extractJSON(raw: string): any {
  let cleaned = raw
    .replace(/^```json\s*/im, "")
    .replace(/^```\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim();
  if (cleaned.includes("`") || !cleaned.startsWith("{")) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  }
  return JSON.parse(cleaned);
}

async function fetchPdfBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PDF fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function callAnthropic(apiKey: string, base64: string): Promise<{ delivery_date: string | null; retry_after?: number; rate_limited?: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey.replace(/[^\x20-\x7E]/g, "").trim(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        system: DELIVERY_PROMPT,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: "Return only {\"delivery_date\": ...}." },
          ],
        }],
      }),
      signal: controller.signal,
    });
    if (response.status === 429 || response.status === 529) {
      const retryAfter = Number(response.headers.get("retry-after")) || 5;
      return { delivery_date: null, rate_limited: true, retry_after: retryAfter };
    }
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic ${response.status}: ${err.slice(0, 200)}`);
    }
    const result = await response.json();
    const text = result.content?.find((c: any) => c.type === "text")?.text;
    if (!text) throw new Error("No text content");
    const parsed = extractJSON(text);
    return { delivery_date: typeof parsed?.delivery_date === "string" ? parsed.delivery_date : null };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Job helpers ──────────────────────────────────────────────────────────
type JobRow = {
  id: string;
  status: "running" | "paused" | "done" | "failed";
  invoice_ids: string[];
  remaining_ids: string[];
  processed_count: number;
  saved_count: number;
  failure_count: number;
  null_count: number;
  failures: Array<{ id: string; invoice_number: string | null; error: string }>;
  last_remaining: number | null;
};

async function loadJob(supabase: SupabaseClient, jobId: string): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from("delivery_backfill_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  return (data as JobRow | null) ?? null;
}

async function patchJob(supabase: SupabaseClient, jobId: string, patch: Record<string, unknown>) {
  const { error } = await supabase
    .from("delivery_backfill_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) console.error("patchJob failed", error);
}

async function chainSelf(jobId: string) {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const url = `${SUPABASE_URL}/functions/v1/backfill-delivery-dates`;
  try {
    // Fire-and-forget chain. We don't await the body; we only need the
    // request to land so the next invocation picks up the job.
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_KEY}`,
        apikey: SERVICE_KEY,
      },
      body: JSON.stringify({ action: "_continue", job_id: jobId }),
    });
  } catch (e) {
    console.error("chainSelf fetch failed", e);
  }
}

// Long-running worker: processes chunks until done, paused, or wall-clock
// exhausted. On wall-clock, self-chains to a fresh invocation.
async function runWorker(supabase: SupabaseClient, apiKey: string, jobId: string) {
  const startedAt = Date.now();
  while (true) {
    const job = await loadJob(supabase, jobId);
    if (!job) { console.error("worker: job vanished", jobId); return; }
    if (job.status === "paused") { console.log("worker: paused", jobId); return; }
    if (job.status === "done" || job.status === "failed") return;

    if (!job.remaining_ids || job.remaining_ids.length === 0) {
      await patchJob(supabase, jobId, { status: "done" });
      return;
    }

    // Wall-clock check BEFORE doing another chunk.
    if (Date.now() - startedAt > MAX_WALL_MS) {
      // No-progress guard: if remaining hasn't decreased since last chain hop, abort.
      const remainingNow = job.remaining_ids.length;
      if (job.last_remaining !== null && remainingNow >= job.last_remaining) {
        await patchJob(supabase, jobId, {
          status: "failed",
          stop_reason: `No progress across self-chain (remaining stuck at ${remainingNow}).`,
        });
        console.error("worker: no-progress guard tripped", jobId, remainingNow);
        return;
      }
      await patchJob(supabase, jobId, { last_remaining: remainingNow });
      await chainSelf(jobId);
      return;
    }

    const chunk = job.remaining_ids.slice(0, CHUNK_SIZE);
    const newFailures: Array<{ id: string; invoice_number: string | null; error: string }> = [];
    let chunkSaved = 0;
    let chunkNull = 0;
    let chunkProcessed = 0;

    // Fetch invoice rows for this chunk.
    const { data: invoices, error: qErr } = await supabase
      .from("vendor_invoices")
      .select("id, invoice_number, pdf_url, delivery_date")
      .in("id", chunk);
    if (qErr) {
      console.error("worker: chunk query failed", qErr);
      // Drop this chunk so we don't infinite loop on it.
      const nextRemaining = job.remaining_ids.slice(CHUNK_SIZE);
      await patchJob(supabase, jobId, {
        remaining_ids: nextRemaining,
        failures: [...job.failures, ...chunk.map(id => ({ id, invoice_number: null, error: qErr.message }))],
        failure_count: job.failure_count + chunk.length,
        processed_count: job.processed_count + chunk.length,
      });
      continue;
    }

    const byId = new Map((invoices ?? []).map((r: any) => [r.id, r]));

    for (const id of chunk) {
      const row: any = byId.get(id);
      if (!row) {
        newFailures.push({ id, invoice_number: null, error: "Invoice not found" });
        chunkProcessed++;
        continue;
      }
      if (row.delivery_date) {
        // Already filled by a parallel writer; treat as a skip.
        chunkProcessed++;
        continue;
      }
      if (!row.pdf_url) {
        newFailures.push({ id, invoice_number: row.invoice_number, error: "No PDF URL" });
        chunkProcessed++;
        continue;
      }
      try {
        const base64 = await fetchPdfBase64(row.pdf_url);
        let parsed = await callAnthropic(apiKey, base64);
        if (parsed.rate_limited) {
          const wait = Math.min(30, parsed.retry_after ?? 5);
          console.warn("rate limited, backing off", wait, "s");
          await new Promise(r => setTimeout(r, wait * 1000));
          parsed = await callAnthropic(apiKey, base64);
          if (parsed.rate_limited) {
            newFailures.push({ id, invoice_number: row.invoice_number, error: "Rate limited" });
            chunkProcessed++;
            continue;
          }
        }
        const raw = parsed.delivery_date;
        if (!raw) {
          chunkNull++;
        } else {
          const norm = normalizeInvoiceYear(raw);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(norm)) {
            newFailures.push({ id, invoice_number: row.invoice_number, error: `Bad date: ${raw}` });
          } else {
            const { error: upErr } = await supabase
              .from("vendor_invoices")
              .update({ delivery_date: norm })
              .eq("id", id)
              .is("delivery_date", null); // idempotent guard
            if (upErr) {
              newFailures.push({ id, invoice_number: row.invoice_number, error: upErr.message });
            } else {
              chunkSaved++;
            }
          }
        }
        chunkProcessed++;
      } catch (e: any) {
        const msg = e?.message || String(e);
        console.error("worker: row failed", id, msg);
        newFailures.push({ id, invoice_number: row.invoice_number, error: msg });
        chunkProcessed++;
      }
    }

    // Persist progress for this chunk.
    const nextRemaining = job.remaining_ids.slice(CHUNK_SIZE);
    await patchJob(supabase, jobId, {
      remaining_ids: nextRemaining,
      processed_count: job.processed_count + chunkProcessed,
      saved_count: job.saved_count + chunkSaved,
      failure_count: job.failure_count + newFailures.length,
      null_count: job.null_count + chunkNull,
      failures: [...job.failures, ...newFailures].slice(-500),
      last_progress_at: new Date().toISOString(),
    });

    if (nextRemaining.length === 0) {
      await patchJob(supabase, jobId, { status: "done" });
      return;
    }
  }
}

// ─── HTTP handler ─────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
      return new Response(JSON.stringify({ error: "Missing env" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    let body: any = {};
    try { body = await req.json(); } catch { /* no-op */ }
    const action: string = body?.action ?? (Array.isArray(body?.invoice_ids) ? "start" : "status");

    // ── start: create job + kick off background worker
    if (action === "start") {
      const ids: string[] = Array.isArray(body?.invoice_ids)
        ? body.invoice_ids.filter((x: any) => typeof x === "string")
        : [];
      if (ids.length === 0) {
        return new Response(JSON.stringify({ error: "invoice_ids required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: jobRow, error: insErr } = await supabase
        .from("delivery_backfill_jobs")
        .insert({
          status: "running",
          invoice_ids: ids,
          remaining_ids: ids,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      const jobId = jobRow!.id as string;

      const work = runWorker(supabase, ANTHROPIC_API_KEY, jobId)
        .catch(async (e) => {
          console.error("worker crashed", e);
          await patchJob(supabase, jobId, { status: "failed", stop_reason: e?.message || String(e) });
        });
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
        EdgeRuntime.waitUntil(work);
      } else {
        // Local dev fallback: don't block response.
        work;
      }

      return new Response(JSON.stringify({ job_id: jobId, total: ids.length }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── _continue: internal self-chain entry. Resumes worker on this invocation.
    if (action === "_continue") {
      const jobId: string = body?.job_id;
      if (!jobId) return new Response(JSON.stringify({ error: "job_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      const job = await loadJob(supabase, jobId);
      if (!job) return new Response(JSON.stringify({ error: "job not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      if (job.status === "paused" || job.status === "done" || job.status === "failed") {
        return new Response(JSON.stringify({ ok: true, status: job.status }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const work = runWorker(supabase, ANTHROPIC_API_KEY, jobId)
        .catch(async (e) => {
          console.error("worker (chained) crashed", e);
          await patchJob(supabase, jobId, { status: "failed", stop_reason: e?.message || String(e) });
        });
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
        EdgeRuntime.waitUntil(work);
      } else {
        work;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── pause: flip flag; running worker checks each loop iteration.
    if (action === "pause") {
      const jobId: string = body?.job_id;
      if (!jobId) return new Response(JSON.stringify({ error: "job_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      await patchJob(supabase, jobId, { status: "paused" });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── resume: flip flag back to running + kick off worker again.
    if (action === "resume") {
      const jobId: string = body?.job_id;
      if (!jobId) return new Response(JSON.stringify({ error: "job_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      await patchJob(supabase, jobId, { status: "running", last_remaining: null });
      const work = runWorker(supabase, ANTHROPIC_API_KEY, jobId)
        .catch(async (e) => {
          await patchJob(supabase, jobId, { status: "failed", stop_reason: e?.message || String(e) });
        });
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
        EdgeRuntime.waitUntil(work);
      } else {
        work;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── status: return job row snapshot.
    if (action === "status") {
      const jobId: string = body?.job_id;
      if (!jobId) return new Response(JSON.stringify({ error: "job_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      const job = await loadJob(supabase, jobId);
      return new Response(JSON.stringify({ job }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("backfill-delivery-dates fatal:", err);
    return new Response(JSON.stringify({ error: err?.message || "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
