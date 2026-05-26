import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";

export type VendorInvoice = Database["public"]["Tables"]["vendor_invoices"]["Row"];
export type VendorInvoiceInsert = Database["public"]["Tables"]["vendor_invoices"]["Insert"];
export type InvoiceStatus = "unpaid" | "paid" | "partial" | "disputed";
export type DocType = "INVOICE" | "PO" | "proforma" | "credit_memo";

/** Returns true if this invoice is a proforma (not a payable document) */
export function isProforma(inv: { doc_type: string }): boolean {
  const dt = (inv.doc_type || "").toLowerCase();
  return dt === "proforma" || dt === "pro-forma" || dt === "pro forma";
}

/** Returns true if this document is a credit memo */
export function isCreditMemo(inv: { doc_type: string }): boolean {
  return (inv.doc_type || "").toLowerCase() === "credit_memo";
}

export interface LineItem {
  upc?: string;
  item_number?: string;
  sku?: string;
  description?: string;
  brand?: string;
  model?: string;
  color_code?: string;
  color_desc?: string;
  size?: string;
  temple?: string;
  qty_ordered?: number;
  qty_shipped?: number;
  qty?: number;
  unit_price?: number;
  line_total?: number;
}

export interface InvoiceFilters {
  search?: string;
  vendor?: string;
  docType?: string;
  status?: string;
  tag?: string;
  dateFrom?: string;
  dateTo?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  minTotal?: number;
  maxTotal?: number;
  sortField?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  perPage?: number;
  source?: string;
}

export function getLineItems(inv: VendorInvoice): LineItem[] {
  if (!inv.line_items) return [];
  if (Array.isArray(inv.line_items)) return inv.line_items as unknown as LineItem[];
  return [];
}

export function getTotalUnits(inv: VendorInvoice): number {
  const items = getLineItems(inv);
  return items.reduce((sum, li) => {
    const val = li.qty_shipped || li.qty_ordered || li.qty;
    return sum + (typeof val === "number" ? val : Number(val) || 0);
  }, 0);
}

export async function fetchInvoices(filters: InvoiceFilters) {
  const page = filters.page ?? 1;
  const perPage = filters.perPage ?? 25;
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  let query = supabase
    .from("vendor_invoices")
    .select("*", { count: "exact" });

  if (filters.search) {
    const s = `%${filters.search}%`;
    query = query.or(
      `invoice_number.ilike.${s},po_number.ilike.${s},account_number.ilike.${s},vendor.ilike.${s},notes.ilike.${s},filename.ilike.${s}`
    );
  }
  if (filters.vendor) query = query.eq("vendor", filters.vendor);
  if (filters.docType) query = query.eq("doc_type", filters.docType);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.tag) query = query.contains("tags" as any, [filters.tag]);
  if (filters.dateFrom) query = query.gte("invoice_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("invoice_date", filters.dateTo);
  if (filters.dueDateFrom) query = query.gte("due_date", filters.dueDateFrom);
  if (filters.dueDateTo) query = query.lte("due_date", filters.dueDateTo);
  if (filters.minTotal !== undefined) query = query.gte("total", filters.minTotal);
  if (filters.maxTotal !== undefined) query = query.lte("total", filters.maxTotal);
  if (filters.source) query = query.eq("import_source", filters.source);

  const sortField = filters.sortField || "invoice_date";
  const sortDir = filters.sortDir === "asc" ? true : false;
  query = query.order(sortField, { ascending: sortDir }).range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  return { data: data ?? [], count: count ?? 0 };
}

export async function updateInvoiceStatus(id: string, status: InvoiceStatus) {
  // 1. Update vendor_invoices
  const { error } = await supabase
    .from("vendor_invoices")
    .update({ status })
    .eq("id", id);
  if (error) throw error;

  const today = new Date().toISOString().split("T")[0];

  if (status === "paid") {
    // Mark ALL payment rows as paid
    const { data: rows } = await supabase
      .from("invoice_payments")
      .select("id, amount_due, payment_history")
      .eq("invoice_id", id);

    for (const row of rows ?? []) {
      // 2026-05-25: append a checkmark-trail history entry per row so cascade
      // recovery can always distinguish intentional from accidental.
      const existingHistory = Array.isArray((row as any).payment_history) ? (row as any).payment_history : [];
      const historyEntry = {
        date: today,
        amount: Number(row.amount_due) || 0,
        method: "Invoice Status Change",
        reference: "",
        note: "Marked paid via invoice drawer status dropdown",
        recorded_by: "Staff",
        timestamp: new Date().toISOString(),
      };
      await supabase
        .from("invoice_payments")
        .update({
          is_paid: true,
          paid_date: today,
          amount_paid: Number(row.amount_due) || 0,
          balance_remaining: 0,
          payment_status: "paid",
          last_payment_date: today,
          payment_history: [...existingHistory, historyEntry],
        } as any)
        .eq("id", row.id);
    }
  } else if (status === "unpaid" || status === "partial" || status === "disputed") {
    // Reset ALL payment rows back to unpaid
    const { data: rows } = await supabase
      .from("invoice_payments")
      .select("id, amount_due, payment_history")
      .eq("invoice_id", id);

    for (const row of rows ?? []) {
      const existingHistory = Array.isArray((row as any).payment_history) ? (row as any).payment_history : [];
      const historyEntry = {
        date: today,
        amount: 0,
        method: "Invoice Status Change",
        reference: "",
        note: `Status changed to ${status} via invoice drawer dropdown`,
        recorded_by: "Staff",
        timestamp: new Date().toISOString(),
      };
      await supabase
        .from("invoice_payments")
        .update({
          is_paid: false,
          paid_date: null,
          amount_paid: 0,
          balance_remaining: Number(row.amount_due) || 0,
          payment_status: status === "disputed" ? "disputed" : "unpaid",
          last_payment_date: null,
          payment_history: [...existingHistory, historyEntry],
        } as any)
        .eq("id", row.id);
    }
  }
}

export async function updateInvoiceNotes(id: string, notes: string) {
  const { error } = await supabase
    .from("vendor_invoices")
    .update({ notes })
    .eq("id", id);
  if (error) throw error;
}

export async function updateInvoiceTags(id: string, tags: string[]) {
  const { error } = await supabase
    .from("vendor_invoices")
    .update({ tags } as any)
    .eq("id", id);
  if (error) throw error;
}

export async function fetchDistinctTags(): Promise<string[]> {
  const { data, error } = await supabase
    .from("vendor_invoices")
    .select("tags")
    .not("tags", "eq", "{}");
  if (error) throw error;
  const all = (data ?? []).flatMap((d: any) => d.tags ?? []);
  return [...new Set(all)].sort();
}

export async function deleteInvoice(id: string) {
  // Clear references that use NO ACTION foreign keys before deleting
  const [r1, r2, r3, r4] = await Promise.all([
    supabase.from("po_receiving_sessions").update({ reconciled_invoice_id: null } as any).eq("reconciled_invoice_id", id),
    supabase.from("reconciliation_discrepancies").update({ invoice_id: null } as any).eq("invoice_id", id),
    supabase.from("vendor_invoices").update({ linked_proforma_id: null } as any).eq("linked_proforma_id", id),
    supabase.from("vendor_invoices").update({ proforma_superseded_by: null } as any).eq("proforma_superseded_by", id),
  ]);
  for (const r of [r1, r2, r3, r4]) {
    if (r.error) throw r.error;
  }

  const { error } = await supabase
    .from("vendor_invoices")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

export async function insertInvoice(invoice: VendorInvoiceInsert) {
  const { data, error } = await supabase
    .from("vendor_invoices")
    .insert(invoice)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function fetchDistinctVendors(): Promise<string[]> {
  const { data, error } = await supabase
    .from("vendor_invoices")
    .select("vendor")
    .order("vendor");
  if (error) throw error;
  return [...new Set(data.map((d) => d.vendor))];
}

export interface InvoiceStats {
  total_documents: number;
  total_invoices: number;
  total_pos: number;
  total_ap_value: number;
  total_units: number;
  unpaid_balance: number;
  needs_review_count: number;
  needs_review_value: number;
}

export async function fetchInvoiceStats(filters: InvoiceFilters): Promise<InvoiceStats> {
  const { data, error } = await supabase.rpc("get_invoice_stats", {
    p_vendor: filters.vendor || null,
    p_doc_type: filters.docType || null,
    p_status: filters.status || null,
    p_date_from: filters.dateFrom || null,
    p_date_to: filters.dateTo || null,
    p_search: filters.search || null,
    p_tag: filters.tag || null,
    p_min_total: filters.minTotal ?? null,
    p_max_total: filters.maxTotal ?? null,
  });
  if (error) throw error;
  return data as unknown as InvoiceStats;
}

export function formatCurrency(n: number | null | undefined) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

export function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function invoiceToCSVRow(inv: VendorInvoice): string {
  return [
    inv.doc_type, inv.vendor, inv.invoice_number, inv.po_number ?? "",
    inv.account_number ?? "", inv.invoice_date, getTotalUnits(inv),
    inv.total, inv.payment_terms ?? "", inv.status
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",");
}

export function lineItemsToCSV(inv: VendorInvoice): string {
  const items = getLineItems(inv);
  const header = "Invoice #,Vendor,UPC,Item #,Brand,Model,Color Code,Color Desc,Size,Temple,Qty Ordered,Qty Shipped,Unit Price,Line Total";
  const rows = items.map(li =>
    [inv.invoice_number, inv.vendor, li.upc ?? "", li.item_number ?? "", li.brand ?? "", li.model ?? "",
     li.color_code ?? "", li.color_desc ?? "", li.size ?? "", li.temple ?? "",
     li.qty_ordered ?? "", li.qty_shipped ?? "", li.unit_price ?? "", li.line_total ?? ""]
      .map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")
  );
  return [header, ...rows].join("\n");
}

// ── User terms approval / override (Pre-Save Review audit trail) ──
import type { OverridePayload } from "@/components/invoices/InvoiceReviewOverridePanel";

type ProcessedDocLike = {
  id: string;
  vendor?: string;
  invoice_number?: string;
  invoice_date?: string;
  total?: number;
  parsedData?: any;
  invoiceData?: any;
};

/** Audit-only writer for the approve-as-is path. Does NOT change vendor_invoices. */
export async function recordTermsApprovedAsIs(args: {
  docId: string;
  invoiceId: string | null;
  confirmedTerms: string;
  docs: ProcessedDocLike[];
}): Promise<void> {
  const { docId, invoiceId, confirmedTerms, docs } = args;
  const doc = docs.find((d) => d.id === docId);
  if (!doc) return;
  const aiPreset = doc.parsedData?.terms_preset ?? doc.parsedData?.payment_terms_extracted?.type ?? null;
  const aiSource = doc.parsedData?.terms_source_text ?? doc.parsedData?.payment_terms_extracted?.raw_text ?? confirmedTerms;
  // Stamp the invoice row so the table/drawer can render the "User Approved" badge
  // without an extra audit-log lookup.
  if (invoiceId) {
    try {
      await supabase
        .from("vendor_invoices")
        .update({ terms_confidence: "user_approved" })
        .eq("id", invoiceId);
    } catch (err) {
      console.warn("recordTermsApprovedAsIs: invoice stamp failed (non-fatal):", err);
    }
  }
  try {
    await supabase.from("recalc_audit_log").insert({
      invoice_id: invoiceId,
      invoice_number: doc.invoice_number ?? doc.parsedData?.invoice_number ?? null,
      vendor: doc.vendor ?? doc.parsedData?.vendor ?? null,
      action: "user_terms_approval",
      metadata: {
        kind: "approved_as_is",
        doc_id: docId,
        vendor: doc.vendor ?? doc.parsedData?.vendor ?? null,
        ai_extracted_preset: aiPreset,
        ai_extracted_source_text: aiSource,
        final_preset: aiPreset,
        confirmed_terms: confirmedTerms,
        ai_installments: doc.parsedData?.installments ?? [],
        final_installments: doc.parsedData?.installments ?? [],
      },
    });
  } catch (err) {
    console.warn("recordTermsApprovedAsIs failed (non-fatal):", err);
  }
}

/**
 * Override writer — user's typed dates/amounts win.
 * Replaces the auto-generated invoice_payments rows with the override installments,
 * updates vendor_invoices.final_terms_preset + terms_status, writes audit log entry.
 * Called AFTER the standard insertInvoice + generatePaymentsForInvoice path.
 */
export async function applyUserTermsOverride(args: {
  docId: string;
  invoiceId: string;
  confirmedTerms: string;
  override: OverridePayload;
  docs: ProcessedDocLike[];
}): Promise<void> {
  const { docId, invoiceId, confirmedTerms, override, docs } = args;
  const doc = docs.find((d) => d.id === docId);

  // 1) Update vendor_invoices header
  const headerDue = [...override.installments.map((r) => r.due_date)].sort()[0] ?? null;
  const total = override.installments.reduce((s, r) => s + (Number.isFinite(r.amount_due) ? r.amount_due : 0), 0);
  const { error: updErr } = await supabase
    .from("vendor_invoices")
    .update({
      vendor: override.vendor || (doc?.vendor ?? undefined),
      final_terms_preset: override.finalPreset,
      terms_status: "confirmed",
      terms_confidence: "user_overridden",
      payment_terms: confirmedTerms,
      due_date: headerDue,
    })
    .eq("id", invoiceId);
  if (updErr) throw updErr;

  // 2) Replace invoice_payments rows
  const { error: delErr } = await supabase
    .from("invoice_payments")
    .delete()
    .eq("invoice_id", invoiceId);
  if (delErr) throw delErr;

  const invoiceNumber = doc?.invoice_number ?? doc?.parsedData?.invoice_number ?? "";
  const invoiceDate = doc?.invoice_date ?? doc?.invoiceData?.invoice_date ?? doc?.parsedData?.invoice_date ?? null;
  const rows = override.installments.map((r) => ({
    invoice_id: invoiceId,
    vendor: override.vendor,
    invoice_number: invoiceNumber,
    invoice_amount: total,
    invoice_date: invoiceDate,
    amount_due: r.amount_due,
    balance_remaining: r.amount_due,
    amount_paid: 0,
    is_paid: false,
    payment_status: "unpaid",
    terms: override.finalPreset,
    installment_label: r.installment_label,
    due_date: r.due_date,
  }));
  const { error: insErr } = await supabase.from("invoice_payments").insert(rows);
  if (insErr) throw insErr;

  // 3) Audit log entry
  const aiPreset = doc?.parsedData?.terms_preset ?? doc?.parsedData?.payment_terms_extracted?.type ?? null;
  const aiSource = doc?.parsedData?.terms_source_text ?? doc?.parsedData?.payment_terms_extracted?.raw_text ?? confirmedTerms;
  try {
    await supabase.from("recalc_audit_log").insert({
      invoice_id: invoiceId,
      invoice_number: invoiceNumber || null,
      vendor: override.vendor,
      action: "user_terms_approval",
      metadata: {
        kind: "user_overridden",
        doc_id: docId,
        ai_extracted_preset: aiPreset,
        ai_extracted_source_text: aiSource,
        final_preset: override.finalPreset,
        ai_installments: doc?.parsedData?.installments ?? null,
        final_installments: override.installments,
        notes: override.notes ?? null,
      },
    });
  } catch (err) {
    console.warn("applyUserTermsOverride audit insert failed (non-fatal):", err);
  }
}

// ── Existing-invoice approval / override (Drop 2) ──
//
// Schema note: this project's `recalc_audit_log` uses columns `action` (text)
// and `metadata` (jsonb), NOT `action_tag`/`details`. The drop spec used the
// alt names — we map to the real schema while preserving the documented
// `kind` taxonomy ("approved_existing_as_is" / "user_overridden_existing").

/**
 * Approve-existing: stamps `terms_confidence = "user_approved"` on an
 * already-saved invoice and writes an audit-log entry. Use when the user
 * opens an existing invoice and confirms the parser's original output.
 */
export async function approveExistingInvoiceTerms(args: {
  invoiceId: string;
}): Promise<void> {
  const { invoiceId } = args;

  // Snapshot current state for the audit row.
  const { data: header } = await supabase
    .from("vendor_invoices")
    .select(
      "id, vendor, invoice_number, extracted_terms_preset, extracted_terms_source_text, final_terms_preset, terms_confidence, due_date",
    )
    .eq("id", invoiceId)
    .maybeSingle();

  const { data: rows } = await supabase
    .from("invoice_payments")
    .select("due_date, amount_due, installment_label")
    .eq("invoice_id", invoiceId)
    .order("due_date", { ascending: true });

  const { error: updErr } = await supabase
    .from("vendor_invoices")
    .update({ terms_confidence: "user_approved" })
    .eq("id", invoiceId);
  if (updErr) throw updErr;

  try {
    await supabase.from("recalc_audit_log").insert({
      invoice_id: invoiceId,
      invoice_number: (header as any)?.invoice_number ?? null,
      vendor: (header as any)?.vendor ?? null,
      action: "user_terms_approval",
      metadata: {
        kind: "approved_existing_as_is",
        invoice_id: invoiceId,
        vendor: (header as any)?.vendor ?? null,
        ai_extracted_preset: (header as any)?.extracted_terms_preset ?? null,
        ai_extracted_source_text: (header as any)?.extracted_terms_source_text ?? null,
        final_preset:
          (header as any)?.final_terms_preset ??
          (header as any)?.extracted_terms_preset ??
          null,
        ai_installments: rows ?? [],
        final_installments: rows ?? [],
      },
    });
  } catch (err) {
    console.warn("approveExistingInvoiceTerms audit insert failed (non-fatal):", err);
  }
}

/**
 * Override-existing: re-runs Guard 1 (credit memo) and Guard 2 (any payment
 * recorded) against fresh DB state, then deletes existing `invoice_payments`
 * for this invoice and replaces them with the user's typed installments.
 * Updates header `due_date` / `final_terms_preset` /
 * `terms_confidence = "user_overridden"` and writes an audit entry.
 *
 * THROWS if any Guard trips. Caller MUST surface the error via toast.
 */
export async function applyUserTermsOverrideToExisting(args: {
  invoiceId: string;
  override: import("@/components/invoices/InvoiceReviewOverridePanel").OverridePayload;
  reason?: string;
}): Promise<void> {
  const { invoiceId, override, reason } = args;

  // 1) Header (for audit + vendor) and CURRENT payment rows for guard checks.
  const { data: header, error: headerErr } = await supabase
    .from("vendor_invoices")
    .select(
      "id, vendor, invoice_number, doc_type, extracted_terms_preset, extracted_terms_source_text, final_terms_preset",
    )
    .eq("id", invoiceId)
    .maybeSingle();
  if (headerErr || !header) {
    throw new Error(
      `Cannot fetch invoice ${invoiceId}: ${headerErr?.message ?? "not found"}`,
    );
  }

  const { data: existingRows, error: rowsErr } = await supabase
    .from("invoice_payments")
    .select(
      "id, due_date, amount_due, amount_paid, is_paid, payment_status, installment_label, terms, dispute_reason, void_reason",
    )
    .eq("invoice_id", invoiceId);
  if (rowsErr) throw rowsErr;
  const rows = existingRows ?? [];

  // 2) Guard 1 — credit-memo invoice OR credit-memo rows.
  const docType = String((header as any).doc_type ?? "").toLowerCase();
  if (docType.includes("credit") || docType === "credit_memo") {
    throw new Error(
      "Guard 1: this is a credit memo. Override is not allowed on credit memos.",
    );
  }
  const guard1Trips = rows.some(
    (r: any) =>
      r.terms === "credit_memo" ||
      r.installment_label === "Credit" ||
      Number(r.amount_due ?? 0) < 0,
  );
  if (guard1Trips) {
    throw new Error(
      "Guard 1: this invoice has credit-memo rows. Resolve those before overriding terms.",
    );
  }

  // 3) Guard 2 — any payment recorded.
  const guard2Trips = rows.some(
    (r: any) =>
      r.is_paid === true ||
      r.payment_status === "paid" ||
      r.payment_status === "partial" ||
      Number(r.amount_paid ?? 0) > 0,
  );
  if (guard2Trips) {
    throw new Error(
      "Guard 2: this invoice has paid installments. Reverse those before overriding terms.",
    );
  }

  // 4) Delete existing rows (all unpaid, per Guard 2).
  const idsToDelete = rows.map((r: any) => r.id).filter(Boolean);
  if (idsToDelete.length > 0) {
    const { error: delErr } = await supabase
      .from("invoice_payments")
      .delete()
      .in("id", idsToDelete);
    if (delErr) throw delErr;
  }

  // 5) Insert user's installments. Populate ALL not-null columns so the
  //    insert satisfies the schema (vendor / invoice_number / invoice_amount
  //    / invoice_date are NOT NULL on invoice_payments).
  const invoiceNumber = (header as any).invoice_number ?? "";
  const vendorName = override.vendor || (header as any).vendor || "";
  const newTotal = override.installments.reduce(
    (s, r) => s + (Number.isFinite(r.amount_due) ? r.amount_due : 0),
    0,
  );
  // We need the invoice_date for invoice_payments NOT NULL — fetch it cheap.
  const { data: dateRow } = await supabase
    .from("vendor_invoices")
    .select("invoice_date")
    .eq("id", invoiceId)
    .maybeSingle();
  const invoiceDate = (dateRow as any)?.invoice_date ?? null;

  const newRows = override.installments.map((r) => ({
    invoice_id: invoiceId,
    vendor: vendorName,
    invoice_number: invoiceNumber,
    invoice_amount: newTotal,
    invoice_date: invoiceDate,
    due_date: r.due_date,
    amount_due: r.amount_due,
    balance_remaining: r.amount_due,
    amount_paid: 0,
    is_paid: false,
    payment_status: "unpaid",
    terms: override.finalPreset,
    installment_label: r.installment_label,
  }));
  const { error: insErr } = await supabase
    .from("invoice_payments")
    .insert(newRows);
  if (insErr) throw insErr;

  // 6) Update header.
  const headerDue =
    [...override.installments.map((r) => r.due_date)].sort()[0] ?? null;
  const { error: updErr } = await supabase
    .from("vendor_invoices")
    .update({
      vendor: vendorName,
      due_date: headerDue,
      final_terms_preset: override.finalPreset,
      terms_status: "confirmed",
      terms_confidence: "user_overridden",
    })
    .eq("id", invoiceId);
  if (updErr) throw updErr;

  // 7) Audit.
  try {
    await supabase.from("recalc_audit_log").insert({
      invoice_id: invoiceId,
      invoice_number: invoiceNumber || null,
      vendor: vendorName || null,
      action: "user_terms_approval",
      metadata: {
        kind: "user_overridden_existing",
        invoice_id: invoiceId,
        vendor: vendorName || null,
        ai_extracted_preset: (header as any).extracted_terms_preset ?? null,
        ai_extracted_source_text: (header as any).extracted_terms_source_text ?? null,
        final_preset: override.finalPreset,
        ai_installments: rows.map((r: any) => ({
          due_date: r.due_date,
          amount_due: r.amount_due,
          installment_label: r.installment_label,
        })),
        final_installments: override.installments,
        notes: override.notes ?? reason ?? null,
      },
    });
  } catch (err) {
    console.warn("applyUserTermsOverrideToExisting audit insert failed (non-fatal):", err);
  }
}

