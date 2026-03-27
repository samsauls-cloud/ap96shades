import { supabase } from "@/integrations/supabase/client";

const PAGE_SIZE = 1000;

/**
 * Fetches ALL rows from a Supabase table, paginating automatically
 * to bypass the default 1000-row limit. Supports up to ~100k rows.
 */
export async function fetchAllRows<T = any>(
  table: string,
  options?: {
    select?: string;
    filters?: (query: any) => any;
    orderBy?: string;
    ascending?: boolean;
  }
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const select = options?.select ?? "*";
  const orderBy = options?.orderBy ?? "created_at";
  const ascending = options?.ascending ?? false;

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

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;

    if (from >= 100_000) break;
  }

  return all;
}
