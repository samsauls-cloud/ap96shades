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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const findings: Finding[] = [];

  // 1. Lowercase / non-canonical doc_type
  {
    const { data } = await sb
      .from("vendor_invoices")
      .select("id, vendor, invoice_number, doc_type")
      .not("doc_type", "in", '("INVOICE","PO","proforma","credit_memo")')
      .limit(50);
    findings.push({
      check: "doc_type_noncanonical",
      severity: (data?.length ?? 0) === 0 ? "ok" : "critical",
      count: data?.length ?? 0,
      description: "Invoices with a doc_type not in INVOICE/PO/proforma/credit_memo",
      sample: data ?? [],
    });
  }

  // 2. Confirmed invoices with no payment rows (non-credit, non-proforma)
  {
    const { data: invs } = await sb
      .from("vendor_invoices")
      .select("id, vendor, invoice_number, total, doc_type, terms_status")
      .eq("terms_status", "confirmed")
      .eq("doc_type", "INVOICE")
      .gt("total", 0);
    const ids = (invs ?? []).map((i: any) => i.id);
    let missing: any[] = [];
    if (ids.length) {
      // chunk to avoid URL limits
      const present = new Set<string>();
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const { data: pays } = await sb
          .from("invoice_payments")
          .select("invoice_id")
          .in("invoice_id", chunk);
        (pays ?? []).forEach((p: any) => present.add(p.invoice_id));
      }
      missing = (invs ?? []).filter((i: any) => !present.has(i.id));
    }
    findings.push({
      check: "confirmed_invoice_missing_payments",
      severity: missing.length === 0 ? "ok" : "critical",
      count: missing.length,
      description: "Confirmed INVOICE rows with no installments in invoice_payments",
      sample: missing.slice(0, 25),
    });
  }

  // 3. Schedule total mismatch: sum(invoice_payments.amount_due) ≠ vendor_invoices.total
  {
    const { data: invs } = await sb
      .from("vendor_invoices")
      .select("id, vendor, invoice_number, total")
      .eq("terms_status", "confirmed")
      .eq("doc_type", "INVOICE")
      .gt("total", 0);
    const byId = new Map<string, any>();
    (invs ?? []).forEach((i: any) => byId.set(i.id, { ...i, sum: 0 }));
    const ids = Array.from(byId.keys());
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const { data: pays } = await sb
        .from("invoice_payments")
        .select("invoice_id, amount_due")
        .in("invoice_id", chunk);
      (pays ?? []).forEach((p: any) => {
        const r = byId.get(p.invoice_id);
        if (r) r.sum += Number(p.amount_due) || 0;
      });
    }
    const mismatches = Array.from(byId.values()).filter(
      (r) => r.sum > 0 && Math.abs(r.sum - Number(r.total)) > 0.02,
    );
    findings.push({
      check: "schedule_total_mismatch",
      severity: mismatches.length === 0 ? "ok" : "critical",
      count: mismatches.length,
      description: "Confirmed invoices where sum(installments) differs from invoice total by > $0.02",
      sample: mismatches.slice(0, 25).map((r) => ({
        invoice_id: r.id,
        vendor: r.vendor,
        invoice_number: r.invoice_number,
        total: r.total,
        sum: Math.round(r.sum * 100) / 100,
        delta: Math.round((r.sum - r.total) * 100) / 100,
      })),
    });
  }

  // 4. Duplicate (vendor, invoice_number)
  {
    const { data } = await sb
      .from("vendor_invoices")
      .select("id, vendor, invoice_number")
      .eq("doc_type", "INVOICE");
    const seen = new Map<string, string[]>();
    (data ?? []).forEach((r: any) => {
      const k = `${(r.vendor || "").toLowerCase()}::${(r.invoice_number || "").toLowerCase()}`;
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k)!.push(r.id);
    });
    const dups = Array.from(seen.entries())
      .filter(([, ids]) => ids.length > 1)
      .map(([k, ids]) => ({ key: k, ids }));
    findings.push({
      check: "duplicate_invoice_number",
      severity: dups.length === 0 ? "ok" : "warn",
      count: dups.length,
      description: "Same vendor+invoice_number appears more than once",
      sample: dups.slice(0, 25),
    });
  }

  // 5. invoice_payments with bad dates (should never appear thanks to trigger, but verify legacy rows)
  {
    const { data } = await sb
      .from("invoice_payments")
      .select("id, invoice_number, invoice_date, due_date, amount_due");
    const bad = (data ?? []).filter((r: any) => {
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
      description: "Legacy invoice_payments rows with impossible dates or non-positive amount",
      sample: bad.slice(0, 25),
    });
  }

  const worst = findings.reduce<"ok" | "warn" | "critical">((acc, f) => {
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
