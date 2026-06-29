// Server-side backfill for vendor_invoices.delivery_date.
// Processes a chunk of EOM-based invoices with delivery_date IS NULL and a PDF,
// re-runs Claude extraction, and writes ONLY vendor_invoices.delivery_date.
// HARD CONSTRAINTS: writes nothing else. No amounts, line_items, status,
// invoice_payments, payment_history, or schedule recompute.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const FETCH_TIMEOUT = 90_000;
const DEFAULT_CHUNK = 5;
const MODEL = "claude-sonnet-4-6";

const DELIVERY_PROMPT = `You are extracting ONE field from a vendor invoice PDF: the DELIVERY / SHIP date of the goods (distinct from the order date and the invoice date). Labels include "Delivery date", "Ship date", "Shipped", "Data consegna", "Data DDT". If an order date and a separate later delivery/ship date both appear, return the delivery/ship date. If none is present, return null — NEVER copy the invoice date. Return ONLY raw JSON of the form {"delivery_date": "YYYY-MM-DD" | null}. No markdown, no code fences, no preamble.`;

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

async function callAnthropic(apiKey: string, base64: string): Promise<any> {
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
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic ${response.status}: ${err.slice(0, 200)}`);
    }
    const result = await response.json();
    const text = result.content?.find((c: any) => c.type === "text")?.text;
    if (!text) throw new Error("No text content");
    return extractJSON(text);
  } finally {
    clearTimeout(timer);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "Missing ANTHROPIC_API_KEY secret" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return new Response(JSON.stringify({ error: "Missing Supabase env" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let body: any = {};
    try { body = await req.json(); } catch { /* GET / no body */ }
    const chunkSize = Math.max(1, Math.min(15, Number(body?.chunk_size) || DEFAULT_CHUNK));
    const countOnly = !!body?.count_only;
    const invoiceIds: string[] | null = Array.isArray(body?.invoice_ids) && body.invoice_ids.length > 0
      ? body.invoice_ids.filter((x: any) => typeof x === "string")
      : null;

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // Preferred path: the UI passes the exact eligible ID list it renders, so the
    // function operates on the SAME set the user sees (the UI's eligibility uses
    // the payment_terms TEXT column / live computation that doesn't always
    // populate payment_terms_extracted.eom_based). Fallback to the structured
    // filter only if no IDs are passed.
    let query = supabase
      .from("vendor_invoices")
      .select("id, invoice_number, vendor, pdf_url, payment_terms_extracted, delivery_date, doc_type")
      .is("delivery_date", null)
      .not("pdf_url", "is", null);
    if (invoiceIds && invoiceIds.length > 0) {
      // Chunk the .in() to avoid URL-length limits if a very large list is sent.
      query = query.in("id", invoiceIds.slice(0, 1000));
    } else {
      query = query.eq("doc_type", "INVOICE").order("invoice_date", { ascending: false }).limit(2000);
    }
    const { data: candidates, error: qErr } = await query;
    if (qErr) throw qErr;

    // When the UI passes invoice_ids, trust its eligibility judgment (it uses
    // the payment_terms TEXT column for EOM detection). Otherwise fall back to
    // the structured eom_based marker.
    const eligible = (candidates ?? []).filter((r: any) => {
      if (!r.pdf_url || r.delivery_date) return false;
      if (invoiceIds) return true;
      return r.payment_terms_extracted?.eom_based === true;
    });

    if (countOnly) {
      return new Response(JSON.stringify({ remaining: eligible.length }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const batch = eligible.slice(0, chunkSize);
    let processed = 0;
    let saved = 0;
    let nullFound = 0;
    const failures: Array<{ id: string; invoice_number: string | null; error: string }> = [];

    for (const row of batch) {
      try {
        const base64 = await fetchPdfBase64(row.pdf_url!);
        const parsed = await callAnthropic(ANTHROPIC_API_KEY, base64);
        const raw = parsed?.delivery_date;
        if (!raw || typeof raw !== "string") {
          nullFound++;
        } else {
          const norm = normalizeInvoiceYear(raw);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(norm)) {
            failures.push({ id: row.id, invoice_number: row.invoice_number, error: `Bad date: ${raw}` });
          } else {
            // Idempotent re-check + write ONLY delivery_date.
            const { error: upErr } = await supabase
              .from("vendor_invoices")
              .update({ delivery_date: norm })
              .eq("id", row.id)
              .is("delivery_date", null);
            if (upErr) throw upErr;
            saved++;
          }
        }
        processed++;
      } catch (e: any) {
        const msg = e?.message || String(e);
        console.error("backfill row failed", row.id, msg);
        failures.push({ id: row.id, invoice_number: row.invoice_number, error: msg });
        processed++;
      }
    }

    const remaining = Math.max(0, eligible.length - saved - nullFound);

    return new Response(
      JSON.stringify({
        processed,
        saved,
        null_found: nullFound,
        failures,
        remaining,
        chunk_size: chunkSize,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("backfill-delivery-dates fatal:", err);
    return new Response(JSON.stringify({ error: err?.message || "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
