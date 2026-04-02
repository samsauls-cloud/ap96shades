/**
 * supabase-fetch-all.ts
 *
 * Centralized Supabase reading utilities with full pagination support.
 * Supabase default limit = 1000 rows. Any query that could return more
 * MUST use these utilities or explicitly paginate itself.
 *
 * Row capacity: up to 500,000 rows per fetch (configurable).
 * All functions log a warning if they approach the cap.
 */

import { supabase } from "@/integrations/supabase/client";

// ─── Configuration ────────────────────────────────────────────────
const PAGE_SIZE = 1000;           // rows per Supabase request
const DEFAULT_MAX_ROWS = 500_000; // hard cap — raise if needed
const WARN_THRESHOLD = 0.8;       // warn when 80% of cap is reached

// ─── Types ────────────────────────────────────────────────────────
export interface FetchOptions {
  select?: string;
  orderBy?: string;
  ascending?: boolean;
  filters?: (query: any) => any;
  maxRows?: number;   // override per-call cap
  label?: string;     // for logging/debugging
}

export interface FetchResult<T> {
  data: T[];
  totalFetched: number;
  hitCap: boolean;     // true if maxRows was reached
  capWarning: boolean; // true if > 80% of cap was fetched
}

// ─── Core: fetchAllRows ────────────────────────────────────────────

/**
 * Fetches ALL rows from a table with automatic pagination.
 * Handles Supabase's 1000-row default limit transparently.
 * Supports up to 500,000 rows by default.
 */
export async function fetchAllRows<T = any>(
  table: string,
  options?: FetchOptions
): Promise<T[]> {
  const result = await fetchAllRowsWithMeta<T>(table, options);
  return result.data;
}

/**
 * Same as fetchAllRows but returns metadata about the fetch.
 * Use when you need to know if the cap was hit.
 */
export async function fetchAllRowsWithMeta<T = any>(
  table: string,
  options?: FetchOptions
): Promise<FetchResult<T>> {
  const all: T[] = [];
  let from = 0;
  const select    = options?.select    ?? "*";
  const orderBy   = options?.orderBy   ?? "created_at";
  const ascending = options?.ascending ?? false;
  const maxRows   = options?.maxRows   ?? DEFAULT_MAX_ROWS;
  const label     = options?.label     ?? table;

  while (true) {
    let query = (supabase as any)
      .from(table)
      .select(select)
      .order(orderBy, { ascending })
      .range(from, from + PAGE_SIZE - 1);

    if (options?.filters) {
      query = options.filters(query);
    }

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;

    all.push(...(data as T[]));
    from += data.length;

    if (data.length < PAGE_SIZE) break; // last page

    if (from >= maxRows) {
      console.warn(
        `[fetchAllRows] "${label}" hit the ${maxRows.toLocaleString()}-row cap. ` +
        `There may be more data. Increase maxRows if needed.`
      );
      return {
        data: all,
        totalFetched: all.length,
        hitCap: true,
        capWarning: true,
      };
    }
  }

  const capWarning = all.length >= maxRows * WARN_THRESHOLD;
  if (capWarning) {
    console.warn(
      `[fetchAllRows] "${label}" returned ${all.length.toLocaleString()} rows ` +
      `(${Math.round(all.length / maxRows * 100)}% of ${maxRows.toLocaleString()}-row cap). ` +
      `Monitor growth.`
    );
  }

  return {
    data: all,
    totalFetched: all.length,
    hitCap: false,
    capWarning,
  };
}

// ─── Targeted: fetchByIds ──────────────────────────────────────────

/**
 * Fetches rows by an array of IDs, batching to avoid URL length limits.
 * Supabase .in() breaks above ~200 values — this batches automatically.
 */
export async function fetchByIds<T = any>(
  table: string,
  column: string,
  ids: string[],
  select = "*"
): Promise<T[]> {
  if (ids.length === 0) return [];
  const BATCH = 200;
  const all: T[] = [];

  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const { data, error } = await (supabase as any)
      .from(table)
      .select(select)
      .in(column, chunk);
    if (error) throw error;
    if (data) all.push(...(data as T[]));
  }

  return all;
}

// ─── Counted: fetchWithCount ───────────────────────────────────────

/**
 * Returns both the data AND the total row count from Supabase.
 * Use for paginated UI where you need to show "X of Y results".
 */
export async function fetchWithCount<T = any>(
  table: string,
  options?: {
    select?: string;
    filters?: (query: any) => any;
    orderBy?: string;
    ascending?: boolean;
    page?: number;
    perPage?: number;
  }
): Promise<{ data: T[]; count: number }> {
  const page    = options?.page    ?? 1;
  const perPage = options?.perPage ?? 25;
  const from    = (page - 1) * perPage;
  const to      = from + perPage - 1;
  const select  = options?.select  ?? "*";
  const orderBy = options?.orderBy ?? "created_at";
  const ascending = options?.ascending ?? false;

  let query = (supabase as any)
    .from(table)
    .select(select, { count: "exact" })
    .order(orderBy, { ascending })
    .range(from, to);

  if (options?.filters) {
    query = options.filters(query);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return { data: data ?? [], count: count ?? 0 };
}

// ─── Streaming: fetchInBatches ─────────────────────────────────────

/**
 * Fetches rows in batches and calls onBatch() for each batch.
 * Use for large datasets where you want progressive rendering.
 */
export async function fetchInBatches<T = any>(
  table: string,
  onBatch: (batch: T[], batchNumber: number, totalSoFar: number) => void,
  options?: FetchOptions
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  let batchNumber = 0;
  const select    = options?.select    ?? "*";
  const orderBy   = options?.orderBy   ?? "created_at";
  const ascending = options?.ascending ?? false;
  const maxRows   = options?.maxRows   ?? DEFAULT_MAX_ROWS;

  while (from < maxRows) {
    let query = (supabase as any)
      .from(table)
      .select(select)
      .order(orderBy, { ascending })
      .range(from, from + PAGE_SIZE - 1);

    if (options?.filters) {
      query = options.filters(query);
    }

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;

    all.push(...(data as T[]));
    batchNumber++;
    onBatch(data as T[], batchNumber, all.length);
    from += data.length;

    if (data.length < PAGE_SIZE) break;
  }

  return all;
}

// ─── Safe single: fetchOneSafe ─────────────────────────────────────

/**
 * Fetches a single row safely. Returns null if not found.
 * Never throws on "not found" — only throws on real errors.
 */
export async function fetchOneSafe<T = any>(
  table: string,
  column: string,
  value: string | number,
  select = "*"
): Promise<T | null> {
  const { data, error } = await (supabase as any)
    .from(table)
    .select(select)
    .eq(column, value)
    .maybeSingle();
  if (error) throw error;
  return (data as T) ?? null;
}

// ─── Aggregate: fetchCount ─────────────────────────────────────────

/**
 * Returns just the count of rows matching a filter.
 * Much faster than fetching all rows when you only need the number.
 */
export async function fetchCount(
  table: string,
  filters?: (query: any) => any
): Promise<number> {
  let query = (supabase as any)
    .from(table)
    .select("*", { count: "exact", head: true });

  if (filters) query = filters(query);

  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

// ─── Multi-table: fetchParallel ────────────────────────────────────

/**
 * Fetches multiple tables in parallel. Much faster than sequential awaits.
 * Returns an array of results in the same order as the input array.
 */
export async function fetchParallel<T extends any[]>(
  queries: { table: string; options?: FetchOptions }[]
): Promise<{ [K in keyof T]: any[] }> {
  const results = await Promise.all(
    queries.map(q => fetchAllRows(q.table, q.options))
  );
  return results as any;
}

// ─── AP-specific helpers ───────────────────────────────────────────

/**
 * Fetches ALL invoice_payments rows. Used by dashboard + audit.
 * Ordered by due_date ascending so tranches are always in sequence.
 */
export async function fetchAllPayments() {
  return fetchAllRows<any>("invoice_payments", {
    orderBy: "due_date",
    ascending: true,
    label: "invoice_payments",
  });
}

/**
 * Fetches ALL vendor_invoices rows. Used by reconciliation + audit.
 */
export async function fetchAllInvoices() {
  return fetchAllRows<any>("vendor_invoices", {
    orderBy: "invoice_date",
    ascending: false,
    label: "vendor_invoices",
  });
}

/**
 * Fetches all payment rows for a specific invoice, ordered by due_date.
 * The due_date ordering is critical for tranche logic (T1, T2, T3).
 */
export async function fetchInstallmentsForInvoice(invoiceId: string) {
  const { data, error } = await supabase
    .from("invoice_payments")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("due_date", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * Fetches vendor_invoices for a specific vendor with all installments.
 * Used by "Fix Vendor Terms" buttons.
 */
export async function fetchVendorInvoicesForRegen(vendorPatterns: string[]) {
  const orFilter = vendorPatterns
    .map(p => `vendor.ilike.%${p}%`)
    .join(",");

  const { data, error } = await supabase
    .from("vendor_invoices")
    .select("id, vendor, invoice_date, payment_terms, total, invoice_number, po_number, due_date, status")
    .or(orFilter);

  if (error) throw error;
  return data ?? [];
}

// ─── Database Scale Health ─────────────────────────────────────────

/**
 * Checks row counts on key tables and warns about scaling issues.
 */
export async function auditDatabaseScale(): Promise<{
  tables: { name: string; count: number; status: 'ok' | 'warn' | 'critical' }[];
  overallStatus: 'clean' | 'warning' | 'error';
}> {
  const tableConfigs = [
    { name: 'vendor_invoices',              warnAt: 400,  critAt: 900  },
    { name: 'invoice_payments',             warnAt: 1000, critAt: 4500 },
    { name: 'po_receiving_lines',           warnAt: 800,  critAt: 4500 },
    { name: 'reconciliation_discrepancies', warnAt: 400,  critAt: 900  },
  ];

  const results = await Promise.all(
    tableConfigs.map(async t => {
      const count = await fetchCount(t.name);
      const status: 'ok' | 'warn' | 'critical' = count >= t.critAt ? 'critical'
        : count >= t.warnAt ? 'warn'
        : 'ok';
      return { name: t.name, count, status };
    })
  );

  const overallStatus: 'clean' | 'warning' | 'error' = results.some(r => r.status === 'critical') ? 'error'
    : results.some(r => r.status === 'warn') ? 'warning'
    : 'clean';

  return { tables: results, overallStatus };
}
