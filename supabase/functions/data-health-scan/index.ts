// Nightly data health scan. Records a row in data_health_runs with all findings.
// Invoked by cron or manually from the AP Dashboard "Re-run scan" button.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface Finding {
  check: string;
  severity: "ok" | "warn" | "critical";
  count: number;
  description: string;
  sample?: any[];
}

// Fetch every row from a table in pages to avoid PostgREST's 1000-row cap.
async function fetchAll<T = any>(
  sb: ReturnType<typeof createClient>,
  build: (q: any) => any,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  let from = 0;
  // hard ceiling to avoid runaway loops
  for (let i = 0; i < 200; i++) {
    const { data, error } = await build(sb).range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const findings: Finding[] = [];

  // Load every vendor_invoice once; downstream checks filter in-memory.
  // Avoids fragile .in(<400+ uuids>) URLs that silently return no rows.
  const allInvoices = await fetchAll<any>(sb, (s) =>
    s.from("vendor_invoices").select(
      "id, vendor, invoice_number, doc_type, status, terms_status, total",
    ),
  );
  // Load every invoice_payments row once.
  const allPayments = await fetchAll<any>(sb, (s) =>
    s.from("invoice_payments").select(
      "id, invoice_id, invoice_number, invoice_date, due_date, amount_due",
    ),
  );

  const isVoid = (i: any) => (i.status ?? "").toLowerCase() === "void";
  const isCreditMemo = (i: any) =>
    ["credit_memo", "credit memo", "credit"].includes(
      String(i.doc_type ?? "").toLowerCase(),
    );

  // 1. Lowercase / non-canonical doc_type (ignore voided rows — they're frozen historical state)
  {
    const allowed = new Set(["INVOICE", "PO", "proforma", "credit_memo"]);
    const bad = allInvoices.filter(
      (r) => !isVoid(r) && !allowed.has(String(r.doc_type ?? "")),
    );
    findings.push({
      check: "doc_type_noncanonical",
      severity: bad.length === 0 ? "ok" : "critical",
      count: bad.length,
      description:
        "Non-void invoices with a doc_type not in INVOICE/PO/proforma/credit_memo",
      sample: bad.slice(0, 25).map((r) => ({
        id: r.id,
        vendor: r.vendor,
        invoice_number: r.invoice_number,
        doc_type: r.doc_type,
      })),
    });
  }

  // Build set of invoice_ids that have at least one installment.
  const paymentsByInvoice = new Map<string, any[]>();
  for (const p of allPayments) {
    if (!p.invoice_id) continue;
    const arr = paymentsByInvoice.get(p.invoice_id) ?? [];
    arr.push(p);
    paymentsByInvoice.set(p.invoice_id, arr);
  }

  // 2. Confirmed invoices with no payment rows — exclude void + credit memos.
  {
    const eligible = allInvoices.filter(
      (i) =>
        i.terms_status === "confirmed" &&
        i.doc_type === "INVOICE" &&
        Number(i.total) > 0 &&
        !isVoid(i) &&
        !isCreditMemo(i),
    );
    const missing = eligible.filter((i) => !paymentsByInvoice.has(i.id));
    findings.push({
      check: "confirmed_invoice_missing_payments",
      severity: missing.length === 0 ? "ok" : "critical",
      count: missing.length,
      description:
        "Confirmed INVOICE rows (non-void, non-credit-memo) with no installments in invoice_payments",
      sample: missing.slice(0, 25).map((r) => ({
        id: r.id,
        vendor: r.vendor,
        invoice_number: r.invoice_number,
        total: r.total,
      })),
    });
  }

  // 3. Schedule total mismatch — same eligibility filter as #2.
  {
    const eligible = allInvoices.filter(
      (i) =>
        i.terms_status === "confirmed" &&
        i.doc_type === "INVOICE" &&
        Number(i.total) > 0 &&
        !isVoid(i) &&
        !isCreditMemo(i),
    );
    const mismatches = eligible
      .map((i) => {
        const rows = paymentsByInvoice.get(i.id) ?? [];
        const sum = rows.reduce((s, r) => s + (Number(r.amount_due) || 0), 0);
        return { i, sum };
      })
      .filter(({ i, sum }) => sum > 0 && Math.abs(sum - Number(i.total)) > 0.02);
    findings.push({
      check: "schedule_total_mismatch",
      severity: mismatches.length === 0 ? "ok" : "critical",
      count: mismatches.length,
      description:
        "Confirmed invoices where sum(installments) differs from invoice total by > $0.02",
      sample: mismatches.slice(0, 25).map(({ i, sum }) => ({
        invoice_id: i.id,
        vendor: i.vendor,
        invoice_number: i.invoice_number,
        total: i.total,
        sum: Math.round(sum * 100) / 100,
        delta: Math.round((sum - Number(i.total)) * 100) / 100,
      })),
    });
  }

  // 4. Duplicate (vendor, invoice_number) — count only non-void rows.
  //     A pair where every extra copy is voided is a resolved duplicate.
  {
    const seen = new Map<string, string[]>();
    for (const r of allInvoices) {
      if (r.doc_type !== "INVOICE") continue;
      if (isVoid(r)) continue;
      const k = `${(r.vendor || "").toLowerCase()}::${(r.invoice_number || "").toLowerCase()}`;
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k)!.push(r.id);
    }
    const dups = Array.from(seen.entries())
      .filter(([, ids]) => ids.length > 1)
      .map(([k, ids]) => ({ key: k, ids }));
    findings.push({
      check: "duplicate_invoice_number",
      severity: dups.length === 0 ? "ok" : "warn",
      count: dups.length,
      description:
        "Same vendor+invoice_number appears more than once among non-void rows",
      sample: dups.slice(0, 25),
    });
  }

  // 5. invoice_payments with bad dates / amount — ignore rows that belong to voided invoices.
  {
    const voidIds = new Set(allInvoices.filter(isVoid).map((i) => i.id));
    const bad = allPayments.filter((r) => {
      if (r.invoice_id && voidIds.has(r.invoice_id)) return false;
      if (!r.invoice_date || !r.due_date) return true;
      const inv = new Date(r.invoice_date).getTime();
      const due = new Date(r.due_date).getTime();
      if (due < inv) return true;
      if (due - inv > 1096 * 86400000) return true;
      if (!r.amount_due || Number(r.amount_due) <= 0) return true;
      return false;
    });
    findings.push({
      check: "payment_row_bad_dates_or_amount",
      severity: bad.length === 0 ? "ok" : "warn",
      count: bad.length,
      description:
        "invoice_payments rows (excluding voided invoices) with impossible dates or non-positive amount",
      sample: bad.slice(0, 25),
    });
  }

  const worst = findings.reduce<"ok" | "warn" | "critical">((acc, f) => {
    if (f.count === 0) return acc;
    if (f.severity === "critical") return "critical";
    if (f.severity === "warn" && acc !== "critical") return "warn";
    return acc;
  }, "ok");

  const summary = {
    total_findings: findings.reduce((s, f) => s + f.count, 0),
    critical: findings.filter((f) => f.severity === "critical").reduce((s, f) => s + f.count, 0),
    warn: findings.filter((f) => f.severity === "warn").reduce((s, f) => s + f.count, 0),
    checks_run: findings.length,
  };

  const { data: insertRow, error: insErr } = await sb
    .from("data_health_runs")
    .insert({ severity: worst, summary, findings })
    .select()
    .single();

  if (insErr) {
    return new Response(JSON.stringify({ error: insErr.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }

  return new Response(JSON.stringify({ ok: true, run: insertRow }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status: 200,
  });
});
