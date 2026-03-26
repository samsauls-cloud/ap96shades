import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type VendorInvoice = Database["public"]["Tables"]["vendor_invoices"]["Row"];
export type InvoiceStatus = Database["public"]["Enums"]["invoice_status"];

export interface InvoiceFilters {
  vendor?: string;
  status?: InvoiceStatus | "all";
  dateFrom?: string;
  dateTo?: string;
}

export async function fetchInvoices(filters: InvoiceFilters) {
  let query = supabase
    .from("vendor_invoices")
    .select("*")
    .order("invoice_date", { ascending: false });

  if (filters.vendor) {
    query = query.ilike("vendor", `%${filters.vendor}%`);
  }
  if (filters.status && filters.status !== "all") {
    query = query.eq("status", filters.status);
  }
  if (filters.dateFrom) {
    query = query.gte("invoice_date", filters.dateFrom);
  }
  if (filters.dateTo) {
    query = query.lte("invoice_date", filters.dateTo);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function updateInvoiceStatus(
  id: string,
  status: InvoiceStatus,
  paidDate?: string | null
) {
  const update: Record<string, unknown> = { status };
  if (status === "paid") {
    update.paid_date = paidDate || new Date().toISOString().split("T")[0];
  } else {
    update.paid_date = null;
  }

  const { error } = await supabase
    .from("vendor_invoices")
    .update(update)
    .eq("id", id);
  if (error) throw error;
}

export async function fetchDistinctVendors(): Promise<string[]> {
  const { data, error } = await supabase
    .from("vendor_invoices")
    .select("vendor")
    .order("vendor");
  if (error) throw error;
  const unique = [...new Set(data.map((d) => d.vendor))];
  return unique;
}
