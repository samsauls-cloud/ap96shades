import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";

export type VendorInvoice = Database["public"]["Tables"]["vendor_invoices"]["Row"];
export type VendorInvoiceInsert = Database["public"]["Tables"]["vendor_invoices"]["Insert"];
export type InvoiceStatus = "unpaid" | "paid" | "partial" | "disputed";
export type DocType = "INVOICE" | "PO" | "proforma";

/** Returns true if this invoice is a proforma (not a payable document) */
export function isProforma(inv: { doc_type: string }): boolean {
  const dt = (inv.doc_type || "").toLowerCase();
  return dt === "proforma" || dt === "pro-forma" || dt === "pro forma";
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

  // 2. If reverting away from paid, reset all invoice_payments rows
  if (status === "unpaid" || status === "partial" || status === "disputed") {
    const { data: installments } = await supabase
      .from("invoice_payments")
      .select("id, amount_due")
      .eq("invoice_id", id);

    if (installments && installments.length > 0) {
      for (const inst of installments) {
        await supabase
          .from("invoice_payments")
          .update({
            is_paid: false,
            paid_date: null,
            amount_paid: 0,
            balance_remaining: Number(inst.amount_due) || 0,
            payment_status: status === "disputed" ? "disputed" : "unpaid",
            last_payment_date: null,
          } as any)
          .eq("id", inst.id);
      }
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
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
