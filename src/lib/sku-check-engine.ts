import { supabase } from "@/integrations/supabase/client";

export type SKUStatus = "have_it" | "on_floor" | "received_not_shelved" | "billed_not_received" | "not_in_system" | "discontinued";

export interface SKUSummary {
  total: number;
  inSystem: number;
  onFloor: number;
  haveIt: number;
  billedNotReceived: number;
  notInSystem: number;
  receivedNotShelved: number;
  discontinued: number;
}

export interface SKUCheckResult {
  summary: SKUSummary;
  billedNotReceivedCount: number;
}

interface LineItemInput {
  upc?: string | null;
  item_number?: string | null;
  sku?: string | null;
}

export async function runQuickSKUCheck(lineItems: LineItemInput[]): Promise<SKUCheckResult> {
  if (lineItems.length === 0) {
    return {
      summary: { total: 0, inSystem: 0, onFloor: 0, haveIt: 0, billedNotReceived: 0, notInSystem: 0, receivedNotShelved: 0, discontinued: 0 },
      billedNotReceivedCount: 0,
    };
  }

  const upcs = lineItems.map(li => li.upc).filter(Boolean) as string[];
  const skus = lineItems.map(li => li.item_number || li.sku).filter(Boolean) as string[];
  const allCodes = [...new Set([...upcs, ...skus])];

  if (allCodes.length === 0) {
    return {
      summary: { total: lineItems.length, inSystem: 0, onFloor: 0, haveIt: 0, billedNotReceived: 0, notInSystem: lineItems.length, receivedNotShelved: 0, discontinued: 0 },
      billedNotReceivedCount: 0,
    };
  }

  const orFilter = allCodes.map(c => `upc.eq.${c}`).join(",");

  const [itemMasterRes, planogramRes, receivingRes, inventoryRes] = await Promise.all([
    supabase.from("item_master").select("upc, model_number, wholesale_price").or(orFilter),
    supabase.from("current_planogram").select("upc, model_number, go_out_location, is_vendor_discontinued, is_discontinued").or(orFilter),
    supabase.from("lightspeed_receiving").select("upc, manufact_sku, received_qty, not_received_qty").or(orFilter),
    supabase.from("inventory_snapshots").select("upc, quantity_on_hand").or(orFilter),
  ]);

  const itemMasterMap = new Map<string, any>();
  (itemMasterRes.data ?? []).forEach(r => { if (r.upc) itemMasterMap.set(r.upc, r); if (r.model_number) itemMasterMap.set(r.model_number, r); });

  const planogramMap = new Map<string, any>();
  (planogramRes.data ?? []).forEach(r => { if (r.upc) planogramMap.set(r.upc, r); if (r.model_number) planogramMap.set(r.model_number, r); });

  const receivingMap = new Map<string, any>();
  (receivingRes.data ?? []).forEach(r => { if (r.upc) receivingMap.set(r.upc, r); if (r.manufact_sku) receivingMap.set(r.manufact_sku, r); });

  const inventoryMap = new Map<string, any>();
  (inventoryRes.data ?? []).forEach(r => { if (r.upc) inventoryMap.set(r.upc, r); });

  const summary: SKUSummary = { total: lineItems.length, inSystem: 0, onFloor: 0, haveIt: 0, billedNotReceived: 0, notInSystem: 0, receivedNotShelved: 0, discontinued: 0 };

  for (const li of lineItems) {
    const keys = [li.upc, li.item_number || li.sku].filter(Boolean) as string[];
    const itemMaster = keys.reduce<any>((f, k) => f || itemMasterMap.get(k), null);
    const planogram = keys.reduce<any>((f, k) => f || planogramMap.get(k), null);
    const receiving = keys.reduce<any>((f, k) => f || receivingMap.get(k), null);
    const inventory = keys.reduce<any>((f, k) => f || inventoryMap.get(k), null);

    let status: SKUStatus = "not_in_system";
    const qtyOnHand = inventory?.quantity_on_hand ?? 0;

    if (planogram && (planogram.is_vendor_discontinued || planogram.is_discontinued)) {
      status = "discontinued";
    } else if (inventory && qtyOnHand > 0) {
      status = "have_it";
    } else if (planogram && planogram.go_out_location) {
      status = "on_floor";
    } else if (receiving && (receiving.received_qty || 0) > 0 && !planogram) {
      status = "received_not_shelved";
    } else if (itemMaster && !receiving) {
      status = "billed_not_received";
    } else if (receiving && (receiving.not_received_qty || 0) > 0) {
      status = "billed_not_received";
    }

    if (itemMaster || planogram || receiving || inventory) summary.inSystem++;

    switch (status) {
      case "have_it": summary.haveIt++; break;
      case "on_floor": summary.onFloor++; break;
      case "billed_not_received": summary.billedNotReceived++; break;
      case "not_in_system": summary.notInSystem++; break;
      case "received_not_shelved": summary.receivedNotShelved++; break;
      case "discontinued": summary.discontinued++; break;
    }
  }

  return { summary, billedNotReceivedCount: summary.billedNotReceived };
}
