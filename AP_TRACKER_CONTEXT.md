# AP_TRACKER_CONTEXT

_Generated from the current Lovable project files and live database state on 2026-04-24._

## 1. Project Identity

- **App name (from code):** NinetySix Shades Invoice Companion / AP Tracker
- **Live URL:** https://ap96shades.lovable.app
- **Preview URL:** https://id-preview--42eb1ba0-6fdb-4c0b-90f4-601dafdf9315.lovable.app
- **Lovable project ID:** 42eb1ba0-6fdb-4c0b-90f4-601dafdf9315
- **Backend project URL (public, no keys):** https://kobagddemynizuatfdgw.supabase.co
- **Framework:** React 18 + TypeScript 5 + Vite 5 + Tailwind CSS v3 + shadcn/ui
- **Auth status:** Google OAuth not configured in app code. The current app is gated by `src/components/PasswordGate.tsx` using a SHA-256 password hash stored in session storage; no backend user auth flow is wired into `src/App.tsx`.
- **Published state:** published = true, visibility = public, badge hidden = false

## 2. Database Schema

- **Snapshot source:** live public schema via PostgreSQL 17.6 on 2026-04-24 17:13:52.610831+00
- **Tables requested by handoff but not present in current public schema:** static_board_slots, planogram_drafts, mj_canvas_slots, mj_canvas_events, planogram_eligible_frames, frame_review_queue, profiles

### `current_planogram`

- **Row count now:** 1016
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `upc` — `text` (udt `text`), nullable: yes, default: `none`
  - `brand` — `text` (udt `text`), nullable: yes, default: `none`
  - `model_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `is_vendor_discontinued` — `boolean` (udt `bool`), nullable: yes, default: `false`
  - `is_discontinued` — `boolean` (udt `bool`), nullable: yes, default: `false`
  - `frame_source` — `text` (udt `text`), nullable: yes, default: `none`
  - `go_out_location` — `text` (udt `text`), nullable: yes, default: `none`
  - `backstock_location` — `text` (udt `text`), nullable: yes, default: `none`
  - `brand_key` — `text` (udt `text`), nullable: yes, default: `none`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
- **Foreign keys:**
  - none
- **Indexes:**
  - `current_planogram_pkey` — `CREATE UNIQUE INDEX current_planogram_pkey ON public.current_planogram USING btree (id)`
  - `idx_planogram_model` — `CREATE INDEX idx_planogram_model ON public.current_planogram USING btree (model_number)`
  - `idx_planogram_upc` — `CREATE INDEX idx_planogram_upc ON public.current_planogram USING btree (upc)`
- **Constraints / uniques:**
  - `2200_17608_11_not_null` — CHECK (columns: n/a)
  - `2200_17608_1_not_null` — CHECK (columns: n/a)
  - `current_planogram_pkey` — PRIMARY KEY (columns: id)
- **RLS policies:**
  - `Anyone can insert planogram` — INSERT for anon, authenticated; with check true
  - `Anyone can view planogram` — SELECT for anon, authenticated when true

### `final_bill_ledger`

- **Row count now:** 22
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `invoice_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `session_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `vendor` — `text` (udt `text`), nullable: no, default: `none`
  - `invoice_number` — `text` (udt `text`), nullable: no, default: `none`
  - `po_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `invoice_date` — `date` (udt `date`), nullable: yes, default: `none`
  - `original_invoice_total` — `numeric` (udt `numeric`), nullable: no, default: `0`
  - `total_ordered_qty` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `total_received_qty` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `total_not_received_qty` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `credit_due_overbilled` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `qty_mismatch_amount` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `not_on_invoice_amount` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `total_credit_due` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `final_bill_amount` — `numeric` (udt `numeric`), nullable: no, default: `0`
  - `final_bill_status` — `text` (udt `text`), nullable: yes, default: `'pending'::text`
  - `amount_paid_toward_final` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `final_balance_remaining` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `discrepancy_line_count` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `credit_request_sent` — `boolean` (udt `bool`), nullable: yes, default: `false`
  - `credit_request_sent_at` — `timestamp with time zone` (udt `timestamptz`), nullable: yes, default: `none`
  - `credit_approved` — `boolean` (udt `bool`), nullable: yes, default: `false`
  - `credit_approved_amount` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `credit_approved_at` — `timestamp with time zone` (udt `timestamptz`), nullable: yes, default: `none`
  - `notes` — `text` (udt `text`), nullable: yes, default: `none`
  - `approved_by` — `text` (udt `text`), nullable: yes, default: `none`
- **Foreign keys:**
  - none
- **Indexes:**
  - `final_bill_ledger_pkey` — `CREATE UNIQUE INDEX final_bill_ledger_pkey ON public.final_bill_ledger USING btree (id)`
- **Constraints / uniques:**
  - `2200_18083_17_not_null` — CHECK (columns: n/a)
  - `2200_18083_1_not_null` — CHECK (columns: n/a)
  - `2200_18083_2_not_null` — CHECK (columns: n/a)
  - `2200_18083_5_not_null` — CHECK (columns: n/a)
  - `2200_18083_6_not_null` — CHECK (columns: n/a)
  - `2200_18083_9_not_null` — CHECK (columns: n/a)
  - `final_bill_ledger_invoice_id_fkey` — FOREIGN KEY (columns: invoice_id)
  - `final_bill_ledger_pkey` — PRIMARY KEY (columns: id)
  - `final_bill_ledger_session_id_fkey` — FOREIGN KEY (columns: session_id)
- **RLS policies:**
  - `Anyone can delete final_bill_ledger` — DELETE for anon, authenticated when true
  - `Anyone can insert final_bill_ledger` — INSERT for anon, authenticated; with check true
  - `Anyone can update final_bill_ledger` — UPDATE for anon, authenticated when true
  - `Anyone can view final_bill_ledger` — SELECT for anon, authenticated when true

### `inventory_snapshots`

- **Row count now:** 0
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `upc` — `text` (udt `text`), nullable: yes, default: `none`
  - `quantity_on_hand` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `store_id` — `text` (udt `text`), nullable: yes, default: `none`
  - `snapshot_date` — `date` (udt `date`), nullable: yes, default: `CURRENT_DATE`
  - `brand` — `text` (udt `text`), nullable: yes, default: `none`
  - `model_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `item_description` — `text` (udt `text`), nullable: yes, default: `none`
- **Foreign keys:**
  - none
- **Indexes:**
  - `idx_inventory_snapshots_upc` — `CREATE INDEX idx_inventory_snapshots_upc ON public.inventory_snapshots USING btree (upc)`
  - `inventory_snapshots_pkey` — `CREATE UNIQUE INDEX inventory_snapshots_pkey ON public.inventory_snapshots USING btree (id)`
- **Constraints / uniques:**
  - `2200_21789_1_not_null` — CHECK (columns: n/a)
  - `2200_21789_2_not_null` — CHECK (columns: n/a)
  - `inventory_snapshots_pkey` — PRIMARY KEY (columns: id)
- **RLS policies:**
  - `Anyone can delete inventory_snapshots` — DELETE for anon, authenticated when true
  - `Anyone can insert inventory_snapshots` — INSERT for anon, authenticated; with check true
  - `Anyone can update inventory_snapshots` — UPDATE for anon, authenticated when true
  - `Anyone can view inventory_snapshots` — SELECT for anon, authenticated when true

### `invoice_payments`

- **Row count now:** 452
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `invoice_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `vendor` — `text` (udt `text`), nullable: no, default: `none`
  - `invoice_number` — `text` (udt `text`), nullable: no, default: `none`
  - `po_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `invoice_amount` — `numeric` (udt `numeric`), nullable: no, default: `none`
  - `invoice_date` — `date` (udt `date`), nullable: no, default: `none`
  - `terms` — `text` (udt `text`), nullable: yes, default: `none`
  - `installment_label` — `text` (udt `text`), nullable: yes, default: `none`
  - `due_date` — `date` (udt `date`), nullable: no, default: `none`
  - `amount_due` — `numeric` (udt `numeric`), nullable: no, default: `none`
  - `is_paid` — `boolean` (udt `bool`), nullable: no, default: `false`
  - `paid_date` — `date` (udt `date`), nullable: yes, default: `none`
  - `notes` — `text` (udt `text`), nullable: yes, default: `none`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `amount_paid` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `payment_method` — `text` (udt `text`), nullable: yes, default: `none`
  - `check_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `payment_reference` — `text` (udt `text`), nullable: yes, default: `none`
  - `payment_history` — `jsonb` (udt `jsonb`), nullable: yes, default: `'[]'::jsonb`
  - `balance_remaining` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `payment_status` — `text` (udt `text`), nullable: yes, default: `'unpaid'::text`
  - `dispute_reason` — `text` (udt `text`), nullable: yes, default: `none`
  - `void_reason` — `text` (udt `text`), nullable: yes, default: `none`
  - `last_payment_date` — `date` (udt `date`), nullable: yes, default: `none`
  - `recorded_by` — `text` (udt `text`), nullable: yes, default: `none`
- **Foreign keys:**
  - none
- **Indexes:**
  - `idx_invoice_payments_due_date` — `CREATE INDEX idx_invoice_payments_due_date ON public.invoice_payments USING btree (due_date)`
  - `idx_invoice_payments_invoice_id` — `CREATE INDEX idx_invoice_payments_invoice_id ON public.invoice_payments USING btree (invoice_id)`
  - `idx_invoice_payments_invoice_number` — `CREATE INDEX idx_invoice_payments_invoice_number ON public.invoice_payments USING btree (invoice_number)`
  - `idx_invoice_payments_is_paid` — `CREATE INDEX idx_invoice_payments_is_paid ON public.invoice_payments USING btree (is_paid)`
  - `idx_invoice_payments_vendor` — `CREATE INDEX idx_invoice_payments_vendor ON public.invoice_payments USING btree (vendor)`
  - `invoice_payments_pkey` — `CREATE UNIQUE INDEX invoice_payments_pkey ON public.invoice_payments USING btree (id)`
- **Constraints / uniques:**
  - `2200_17737_10_not_null` — CHECK (columns: n/a)
  - `2200_17737_11_not_null` — CHECK (columns: n/a)
  - `2200_17737_12_not_null` — CHECK (columns: n/a)
  - `2200_17737_15_not_null` — CHECK (columns: n/a)
  - `2200_17737_1_not_null` — CHECK (columns: n/a)
  - `2200_17737_3_not_null` — CHECK (columns: n/a)
  - `2200_17737_4_not_null` — CHECK (columns: n/a)
  - `2200_17737_6_not_null` — CHECK (columns: n/a)
  - `2200_17737_7_not_null` — CHECK (columns: n/a)
  - `invoice_payments_invoice_id_fkey` — FOREIGN KEY (columns: invoice_id)
  - `invoice_payments_pkey` — PRIMARY KEY (columns: id)
- **RLS policies:**
  - `Anyone can delete payments` — DELETE for anon, authenticated when true
  - `Anyone can insert payments` — INSERT for anon, authenticated; with check true
  - `Anyone can update payments` — UPDATE for anon, authenticated when true
  - `Anyone can view payments` — SELECT for anon, authenticated when true

### `item_master`

- **Row count now:** 1018
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `upc` — `text` (udt `text`), nullable: yes, default: `none`
  - `brand` — `text` (udt `text`), nullable: yes, default: `none`
  - `model_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `article_name` — `text` (udt `text`), nullable: yes, default: `none`
  - `wholesale_price` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `retail_price` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `gender` — `text` (udt `text`), nullable: yes, default: `none`
  - `frame_shape` — `text` (udt `text`), nullable: yes, default: `none`
  - `size` — `text` (udt `text`), nullable: yes, default: `none`
  - `color` — `text` (udt `text`), nullable: yes, default: `none`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
- **Foreign keys:**
  - none
- **Indexes:**
  - `idx_item_master_model` — `CREATE INDEX idx_item_master_model ON public.item_master USING btree (model_number)`
  - `idx_item_master_upc` — `CREATE INDEX idx_item_master_upc ON public.item_master USING btree (upc)`
  - `item_master_pkey` — `CREATE UNIQUE INDEX item_master_pkey ON public.item_master USING btree (id)`
- **Constraints / uniques:**
  - `2200_17599_12_not_null` — CHECK (columns: n/a)
  - `2200_17599_1_not_null` — CHECK (columns: n/a)
  - `item_master_pkey` — PRIMARY KEY (columns: id)
- **RLS policies:**
  - `Anyone can insert item_master` — INSERT for anon, authenticated; with check true
  - `Anyone can view item_master` — SELECT for anon, authenticated when true

### `lightspeed_receiving`

- **Row count now:** 0
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `upc` — `text` (udt `text`), nullable: yes, default: `none`
  - `manufact_sku` — `text` (udt `text`), nullable: yes, default: `none`
  - `received_qty` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `not_received_qty` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `unit_cost` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `vendor_id` — `text` (udt `text`), nullable: yes, default: `none`
  - `item_description` — `text` (udt `text`), nullable: yes, default: `none`
  - `receiving_status` — `text` (udt `text`), nullable: yes, default: `'pending'::text`
  - `session_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `po_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `invoice_match_status` — `text` (udt `text`), nullable: no, default: `'unmatched'::text`
  - `matched_invoice_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
- **Foreign keys:**
  - none
- **Indexes:**
  - `idx_lightspeed_receiving_manufact_sku` — `CREATE INDEX idx_lightspeed_receiving_manufact_sku ON public.lightspeed_receiving USING btree (manufact_sku)`
  - `idx_lightspeed_receiving_upc` — `CREATE INDEX idx_lightspeed_receiving_upc ON public.lightspeed_receiving USING btree (upc)`
  - `lightspeed_receiving_pkey` — `CREATE UNIQUE INDEX lightspeed_receiving_pkey ON public.lightspeed_receiving USING btree (id)`
- **Constraints / uniques:**
  - `2200_21776_13_not_null` — CHECK (columns: n/a)
  - `2200_21776_1_not_null` — CHECK (columns: n/a)
  - `2200_21776_2_not_null` — CHECK (columns: n/a)
  - `lightspeed_receiving_pkey` — PRIMARY KEY (columns: id)
- **RLS policies:**
  - `Anyone can delete lightspeed_receiving` — DELETE for anon, authenticated when true
  - `Anyone can insert lightspeed_receiving` — INSERT for anon, authenticated; with check true
  - `Anyone can update lightspeed_receiving` — UPDATE for anon, authenticated when true
  - `Anyone can view lightspeed_receiving` — SELECT for anon, authenticated when true

### `master_assortment`

- **Row count now:** 1149
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `system_id` — `text` (udt `text`), nullable: yes, default: `none`
  - `vendor` — `text` (udt `text`), nullable: yes, default: `none`
  - `brand` — `text` (udt `text`), nullable: yes, default: `none`
  - `upc` — `text` (udt `text`), nullable: yes, default: `none`
  - `assortment` — `text` (udt `text`), nullable: yes, default: `none`
  - `go_out_location` — `text` (udt `text`), nullable: yes, default: `none`
  - `backstock_location` — `text` (udt `text`), nullable: yes, default: `none`
  - `title` — `text` (udt `text`), nullable: yes, default: `none`
  - `model` — `text` (udt `text`), nullable: yes, default: `none`
  - `color` — `text` (udt `text`), nullable: yes, default: `none`
  - `size` — `text` (udt `text`), nullable: yes, default: `none`
  - `rxable` — `text` (udt `text`), nullable: yes, default: `none`
  - `wholesale` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `online_price` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `msrp` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `default_price` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `price_rule` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `polarized` — `text` (udt `text`), nullable: yes, default: `none`
  - `lens_height` — `text` (udt `text`), nullable: yes, default: `none`
  - `bridge_size` — `text` (udt `text`), nullable: yes, default: `none`
  - `temple_length` — `text` (udt `text`), nullable: yes, default: `none`
  - `image_url` — `text` (udt `text`), nullable: yes, default: `none`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
- **Foreign keys:**
  - none
- **Indexes:**
  - `idx_master_assortment_assortment` — `CREATE INDEX idx_master_assortment_assortment ON public.master_assortment USING btree (assortment)`
  - `idx_master_assortment_brand` — `CREATE INDEX idx_master_assortment_brand ON public.master_assortment USING btree (brand)`
  - `idx_master_assortment_model` — `CREATE INDEX idx_master_assortment_model ON public.master_assortment USING btree (model)`
  - `idx_master_assortment_upc` — `CREATE INDEX idx_master_assortment_upc ON public.master_assortment USING btree (upc)`
  - `master_assortment_pkey` — `CREATE UNIQUE INDEX master_assortment_pkey ON public.master_assortment USING btree (id)`
- **Constraints / uniques:**
  - `2200_17648_1_not_null` — CHECK (columns: n/a)
  - `2200_17648_24_not_null` — CHECK (columns: n/a)
  - `master_assortment_pkey` — PRIMARY KEY (columns: id)
- **RLS policies:**
  - `Anyone can insert master_assortment` — INSERT for anon, authenticated; with check true
  - `Anyone can view master_assortment` — SELECT for anon, authenticated when true

### `po_receiving_lines`

- **Row count now:** 1861
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `session_id` — `uuid` (udt `uuid`), nullable: no, default: `none`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `system_id` — `text` (udt `text`), nullable: yes, default: `none`
  - `upc` — `text` (udt `text`), nullable: yes, default: `none`
  - `ean` — `text` (udt `text`), nullable: yes, default: `none`
  - `custom_sku` — `text` (udt `text`), nullable: yes, default: `none`
  - `manufact_sku` — `text` (udt `text`), nullable: yes, default: `none`
  - `item_description` — `text` (udt `text`), nullable: yes, default: `none`
  - `vendor_id` — `text` (udt `text`), nullable: yes, default: `none`
  - `order_qty` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `received_qty` — `integer` (udt `int4`), nullable: yes, default: `none`
  - `not_received_qty` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `unit_cost` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `retail_price` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `unit_discount` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `unit_shipping` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `received_cost` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `ordered_cost` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `lightspeed_status` — `text` (udt `text`), nullable: yes, default: `none`
  - `receiving_status` — `text` (udt `text`), nullable: yes, default: `'NO_RECEIVING_DATA'::text`
  - `matched_invoice_line` — `jsonb` (udt `jsonb`), nullable: yes, default: `none`
  - `match_status` — `text` (udt `text`), nullable: yes, default: `none`
  - `billing_discrepancy` — `boolean` (udt `bool`), nullable: yes, default: `false`
  - `discrepancy_type` — `text` (udt `text`), nullable: yes, default: `none`
  - `discrepancy_amount` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `notes` — `text` (udt `text`), nullable: yes, default: `none`
  - `invoice_match_status` — `text` (udt `text`), nullable: no, default: `'unmatched'::text`
  - `matched_invoice_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
- **Foreign keys:**
  - none
- **Indexes:**
  - `po_receiving_lines_pkey` — `CREATE UNIQUE INDEX po_receiving_lines_pkey ON public.po_receiving_lines USING btree (id)`
- **Constraints / uniques:**
  - `2200_17985_1_not_null` — CHECK (columns: n/a)
  - `2200_17985_28_not_null` — CHECK (columns: n/a)
  - `2200_17985_2_not_null` — CHECK (columns: n/a)
  - `2200_17985_3_not_null` — CHECK (columns: n/a)
  - `po_receiving_lines_pkey` — PRIMARY KEY (columns: id)
  - `po_receiving_lines_session_id_fkey` — FOREIGN KEY (columns: session_id)
- **RLS policies:**
  - `Anyone can delete receiving lines` — DELETE for anon, authenticated when true
  - `Anyone can insert receiving lines` — INSERT for anon, authenticated; with check true
  - `Anyone can update receiving lines` — UPDATE for anon, authenticated when true
  - `Anyone can view receiving lines` — SELECT for anon, authenticated when true

### `po_receiving_sessions`

- **Row count now:** 51
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `session_name` — `text` (udt `text`), nullable: no, default: `none`
  - `vendor` — `text` (udt `text`), nullable: no, default: `none`
  - `lightspeed_export_type` — `text` (udt `text`), nullable: yes, default: `none`
  - `raw_filename` — `text` (udt `text`), nullable: yes, default: `none`
  - `total_lines` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `fully_received` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `partially_received` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `not_received` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `total_ordered_qty` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `total_received_qty` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `total_ordered_cost` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `total_received_cost` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `notes` — `text` (udt `text`), nullable: yes, default: `none`
  - `reconciled_invoice_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `reconciliation_status` — `text` (udt `text`), nullable: no, default: `'unreconciled'::text`
  - `parent_session_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `child_session_ids` — `ARRAY` (udt `_uuid`), nullable: yes, default: `'{}'::uuid[]`
- **Foreign keys:**
  - none
- **Indexes:**
  - `po_receiving_sessions_pkey` — `CREATE UNIQUE INDEX po_receiving_sessions_pkey ON public.po_receiving_sessions USING btree (id)`
- **Constraints / uniques:**
  - `2200_17958_17_not_null` — CHECK (columns: n/a)
  - `2200_17958_1_not_null` — CHECK (columns: n/a)
  - `2200_17958_2_not_null` — CHECK (columns: n/a)
  - `2200_17958_3_not_null` — CHECK (columns: n/a)
  - `2200_17958_4_not_null` — CHECK (columns: n/a)
  - `po_receiving_sessions_parent_session_id_fkey` — FOREIGN KEY (columns: parent_session_id)
  - `po_receiving_sessions_pkey` — PRIMARY KEY (columns: id)
  - `po_receiving_sessions_reconciled_invoice_id_fkey` — FOREIGN KEY (columns: reconciled_invoice_id)
- **RLS policies:**
  - `Anyone can delete receiving sessions` — DELETE for anon, authenticated when true
  - `Anyone can insert receiving sessions` — INSERT for anon, authenticated; with check true
  - `Anyone can update receiving sessions` — UPDATE for anon, authenticated when true
  - `Anyone can view receiving sessions` — SELECT for anon, authenticated when true

### `recalc_audit_log`

- **Row count now:** 30
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `invoice_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `invoice_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `vendor` — `text` (udt `text`), nullable: yes, default: `none`
  - `action` — `text` (udt `text`), nullable: no, default: `none`
  - `old_values` — `jsonb` (udt `jsonb`), nullable: yes, default: `'[]'::jsonb`
  - `new_values` — `jsonb` (udt `jsonb`), nullable: yes, default: `'[]'::jsonb`
  - `metadata` — `jsonb` (udt `jsonb`), nullable: yes, default: `'{}'::jsonb`
  - `performed_by` — `text` (udt `text`), nullable: yes, default: `'system'::text`
- **Foreign keys:**
  - none
- **Indexes:**
  - `recalc_audit_log_pkey` — `CREATE UNIQUE INDEX recalc_audit_log_pkey ON public.recalc_audit_log USING btree (id)`
- **Constraints / uniques:**
  - `2200_31692_1_not_null` — CHECK (columns: n/a)
  - `2200_31692_2_not_null` — CHECK (columns: n/a)
  - `2200_31692_6_not_null` — CHECK (columns: n/a)
  - `recalc_audit_log_pkey` — PRIMARY KEY (columns: id)
- **RLS policies:**
  - `Anyone can insert recalc_audit_log` — INSERT for anon, authenticated; with check true
  - `Anyone can view recalc_audit_log` — SELECT for anon, authenticated when true

### `recon_stale_queue`

- **Row count now:** 373
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `triggered_by` — `text` (udt `text`), nullable: no, default: `none`
  - `entity_type` — `text` (udt `text`), nullable: no, default: `none`
  - `entity_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `upc` — `text` (udt `text`), nullable: yes, default: `none`
  - `vendor` — `text` (udt `text`), nullable: yes, default: `none`
  - `brand` — `text` (udt `text`), nullable: yes, default: `none`
  - `prior_recon_run_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `queued_at` — `timestamp with time zone` (udt `timestamptz`), nullable: yes, default: `now()`
  - `processed_at` — `timestamp with time zone` (udt `timestamptz`), nullable: yes, default: `none`
  - `status` — `text` (udt `text`), nullable: yes, default: `'pending'::text`
- **Foreign keys:**
  - none
- **Indexes:**
  - `recon_stale_queue_pkey` — `CREATE UNIQUE INDEX recon_stale_queue_pkey ON public.recon_stale_queue USING btree (id)`
- **Constraints / uniques:**
  - `2200_19381_1_not_null` — CHECK (columns: n/a)
  - `2200_19381_2_not_null` — CHECK (columns: n/a)
  - `2200_19381_3_not_null` — CHECK (columns: n/a)
  - `recon_stale_queue_pkey` — PRIMARY KEY (columns: id)
  - `recon_stale_queue_prior_recon_run_id_fkey` — FOREIGN KEY (columns: prior_recon_run_id)
- **RLS policies:**
  - `Anyone can delete recon_stale_queue` — DELETE for anon, authenticated when true
  - `Anyone can insert recon_stale_queue` — INSERT for anon, authenticated; with check true
  - `Anyone can update recon_stale_queue` — UPDATE for anon, authenticated when true
  - `Anyone can view recon_stale_queue` — SELECT for anon, authenticated when true

### `reconciliation_discrepancies`

- **Row count now:** 8183
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `run_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `discrepancy_type` — `text` (udt `text`), nullable: no, default: `none`
  - `severity` — `text` (udt `text`), nullable: yes, default: `'warning'::text`
  - `vendor` — `text` (udt `text`), nullable: yes, default: `none`
  - `brand` — `text` (udt `text`), nullable: yes, default: `none`
  - `upc` — `text` (udt `text`), nullable: yes, default: `none`
  - `sku` — `text` (udt `text`), nullable: yes, default: `none`
  - `model_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `invoice_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `invoice_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `invoice_date` — `date` (udt `date`), nullable: yes, default: `none`
  - `po_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `ordered_qty` — `integer` (udt `int4`), nullable: yes, default: `none`
  - `invoiced_qty` — `integer` (udt `int4`), nullable: yes, default: `none`
  - `received_qty` — `integer` (udt `int4`), nullable: yes, default: `none`
  - `qty_delta` — `integer` (udt `int4`), nullable: yes, default: `none`
  - `ordered_unit_price` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `invoiced_unit_price` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `price_delta` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `ordered_line_total` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `invoiced_line_total` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `amount_at_risk` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `resolution_status` — `text` (udt `text`), nullable: yes, default: `'open'::text`
  - `resolved_by` — `text` (udt `text`), nullable: yes, default: `none`
  - `resolved_at` — `timestamp with time zone` (udt `timestamptz`), nullable: yes, default: `none`
  - `resolution_notes` — `text` (udt `text`), nullable: yes, default: `none`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: yes, default: `now()`
- **Foreign keys:**
  - none
- **Indexes:**
  - `reconciliation_discrepancies_pkey` — `CREATE UNIQUE INDEX reconciliation_discrepancies_pkey ON public.reconciliation_discrepancies USING btree (id)`
- **Constraints / uniques:**
  - `2200_18202_1_not_null` — CHECK (columns: n/a)
  - `2200_18202_3_not_null` — CHECK (columns: n/a)
  - `reconciliation_discrepancies_invoice_id_fkey` — FOREIGN KEY (columns: invoice_id)
  - `reconciliation_discrepancies_pkey` — PRIMARY KEY (columns: id)
  - `reconciliation_discrepancies_run_id_fkey` — FOREIGN KEY (columns: run_id)
- **RLS policies:**
  - `Anyone can delete reconciliation_discrepancies` — DELETE for anon, authenticated when true
  - `Anyone can insert reconciliation_discrepancies` — INSERT for anon, authenticated; with check true
  - `Anyone can update reconciliation_discrepancies` — UPDATE for anon, authenticated when true
  - `Anyone can view reconciliation_discrepancies` — SELECT for anon, authenticated when true

### `reconciliation_runs`

- **Row count now:** 15
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `run_at` — `timestamp with time zone` (udt `timestamptz`), nullable: yes, default: `now()`
  - `run_by` — `text` (udt `text`), nullable: yes, default: `none`
  - `total_invoices_checked` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `total_po_lines_checked` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `total_discrepancies` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `total_amount_at_risk` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `status` — `text` (udt `text`), nullable: yes, default: `'complete'::text`
  - `notes` — `text` (udt `text`), nullable: yes, default: `none`
  - `run_type` — `text` (udt `text`), nullable: yes, default: `'full'::text`
  - `scope_description` — `text` (udt `text`), nullable: yes, default: `none`
- **Foreign keys:**
  - none
- **Indexes:**
  - `reconciliation_runs_pkey` — `CREATE UNIQUE INDEX reconciliation_runs_pkey ON public.reconciliation_runs USING btree (id)`
- **Constraints / uniques:**
  - `2200_18188_1_not_null` — CHECK (columns: n/a)
  - `reconciliation_runs_pkey` — PRIMARY KEY (columns: id)
- **RLS policies:**
  - `Anyone can delete reconciliation_runs` — DELETE for anon, authenticated when true
  - `Anyone can insert reconciliation_runs` — INSERT for anon, authenticated; with check true
  - `Anyone can update reconciliation_runs` — UPDATE for anon, authenticated when true
  - `Anyone can view reconciliation_runs` — SELECT for anon, authenticated when true

### `saved_ledger_checks`

- **Row count now:** 1
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `name` — `text` (udt `text`), nullable: no, default: `none`
  - `source_files` — `ARRAY` (udt `_text`), nullable: no, default: `'{}'::text[]`
  - `row_count` — `integer` (udt `int4`), nullable: no, default: `0`
  - `total_amount` — `numeric` (udt `numeric`), nullable: no, default: `0`
  - `matched_count` — `integer` (udt `int4`), nullable: no, default: `0`
  - `not_uploaded_count` — `integer` (udt `int4`), nullable: no, default: `0`
  - `credit_count` — `integer` (udt `int4`), nullable: no, default: `0`
  - `rows` — `jsonb` (udt `jsonb`), nullable: no, default: `'[]'::jsonb`
- **Foreign keys:**
  - none
- **Indexes:**
  - `saved_ledger_checks_pkey` — `CREATE UNIQUE INDEX saved_ledger_checks_pkey ON public.saved_ledger_checks USING btree (id)`
- **Constraints / uniques:**
  - `2200_21960_10_not_null` — CHECK (columns: n/a)
  - `2200_21960_1_not_null` — CHECK (columns: n/a)
  - `2200_21960_2_not_null` — CHECK (columns: n/a)
  - `2200_21960_3_not_null` — CHECK (columns: n/a)
  - `2200_21960_4_not_null` — CHECK (columns: n/a)
  - `2200_21960_5_not_null` — CHECK (columns: n/a)
  - `2200_21960_6_not_null` — CHECK (columns: n/a)
  - `2200_21960_7_not_null` — CHECK (columns: n/a)
  - `2200_21960_8_not_null` — CHECK (columns: n/a)
  - `2200_21960_9_not_null` — CHECK (columns: n/a)
  - `saved_ledger_checks_pkey` — PRIMARY KEY (columns: id)
- **RLS policies:**
  - `Anyone can delete saved_ledger_checks` — DELETE for anon, authenticated when true
  - `Anyone can insert saved_ledger_checks` — INSERT for anon, authenticated; with check true
  - `Anyone can view saved_ledger_checks` — SELECT for anon, authenticated when true

### `vendor_alias_map`

- **Row count now:** 16
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `vendor_id` — `text` (udt `text`), nullable: no, default: `none`
  - `vendor_name` — `text` (udt `text`), nullable: no, default: `none`
  - `aliases` — `ARRAY` (udt `_text`), nullable: no, default: `'{}'::text[]`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `vendor_type` — `text` (udt `text`), nullable: no, default: `'frame'::text`
- **Foreign keys:**
  - none
- **Indexes:**
  - `vendor_alias_map_pkey` — `CREATE UNIQUE INDEX vendor_alias_map_pkey ON public.vendor_alias_map USING btree (id)`
  - `vendor_alias_map_vendor_id_key` — `CREATE UNIQUE INDEX vendor_alias_map_vendor_id_key ON public.vendor_alias_map USING btree (vendor_id)`
- **Constraints / uniques:**
  - `2200_21882_1_not_null` — CHECK (columns: n/a)
  - `2200_21882_2_not_null` — CHECK (columns: n/a)
  - `2200_21882_3_not_null` — CHECK (columns: n/a)
  - `2200_21882_4_not_null` — CHECK (columns: n/a)
  - `2200_21882_5_not_null` — CHECK (columns: n/a)
  - `2200_21882_6_not_null` — CHECK (columns: n/a)
  - `vendor_alias_map_pkey` — PRIMARY KEY (columns: id)
  - `vendor_alias_map_vendor_id_key` — UNIQUE (columns: vendor_id)
- **RLS policies:**
  - `Anyone can delete vendor_alias_map` — DELETE for anon, authenticated when true
  - `Anyone can insert vendor_alias_map` — INSERT for anon, authenticated; with check true
  - `Anyone can update vendor_alias_map` — UPDATE for anon, authenticated when true
  - `Anyone can view vendor_alias_map` — SELECT for anon, authenticated when true

### `vendor_definitions`

- **Row count now:** 0
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `vendor_name` — `text` (udt `text`), nullable: no, default: `none`
  - `vendor_key` — `text` (udt `text`), nullable: no, default: `none`
  - `customer_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `remit_to_address` — `text` (udt `text`), nullable: yes, default: `none`
  - `default_currency` — `text` (udt `text`), nullable: no, default: `'USD'::text`
  - `created_by` — `text` (udt `text`), nullable: yes, default: `none`
  - `is_active` — `boolean` (udt `bool`), nullable: no, default: `true`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `updated_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
- **Foreign keys:**
  - none
- **Indexes:**
  - `vendor_definitions_pkey` — `CREATE UNIQUE INDEX vendor_definitions_pkey ON public.vendor_definitions USING btree (id)`
  - `vendor_definitions_vendor_key_key` — `CREATE UNIQUE INDEX vendor_definitions_vendor_key_key ON public.vendor_definitions USING btree (vendor_key)`
- **Constraints / uniques:**
  - `2200_28166_10_not_null` — CHECK (columns: n/a)
  - `2200_28166_1_not_null` — CHECK (columns: n/a)
  - `2200_28166_2_not_null` — CHECK (columns: n/a)
  - `2200_28166_3_not_null` — CHECK (columns: n/a)
  - `2200_28166_6_not_null` — CHECK (columns: n/a)
  - `2200_28166_8_not_null` — CHECK (columns: n/a)
  - `2200_28166_9_not_null` — CHECK (columns: n/a)
  - `vendor_definitions_pkey` — PRIMARY KEY (columns: id)
  - `vendor_definitions_vendor_key_key` — UNIQUE (columns: vendor_key)
- **RLS policies:**
  - `Anyone can delete vendor_definitions` — DELETE for public when true
  - `Anyone can insert vendor_definitions` — INSERT for public; with check true
  - `Anyone can update vendor_definitions` — UPDATE for public when true
  - `Anyone can view vendor_definitions` — SELECT for public when true

### `vendor_field_mappings`

- **Row count now:** 0
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `vendor_id` — `uuid` (udt `uuid`), nullable: no, default: `none`
  - `field_name` — `text` (udt `text`), nullable: no, default: `none`
  - `source_note` — `text` (udt `text`), nullable: yes, default: `none`
  - `confirmed_by` — `text` (udt `text`), nullable: yes, default: `none`
  - `confirmed_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
- **Foreign keys:**
  - none
- **Indexes:**
  - `vendor_field_mappings_pkey` — `CREATE UNIQUE INDEX vendor_field_mappings_pkey ON public.vendor_field_mappings USING btree (id)`
- **Constraints / uniques:**
  - `2200_28208_1_not_null` — CHECK (columns: n/a)
  - `2200_28208_2_not_null` — CHECK (columns: n/a)
  - `2200_28208_3_not_null` — CHECK (columns: n/a)
  - `2200_28208_6_not_null` — CHECK (columns: n/a)
  - `2200_28208_7_not_null` — CHECK (columns: n/a)
  - `vendor_field_mappings_pkey` — PRIMARY KEY (columns: id)
  - `vendor_field_mappings_vendor_id_fkey` — FOREIGN KEY (columns: vendor_id)
- **RLS policies:**
  - `Anyone can delete vendor_field_mappings` — DELETE for public when true
  - `Anyone can insert vendor_field_mappings` — INSERT for public; with check true
  - `Anyone can update vendor_field_mappings` — UPDATE for public when true
  - `Anyone can view vendor_field_mappings` — SELECT for public when true

### `vendor_invoices`

- **Row count now:** 191
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `vendor` — `text` (udt `text`), nullable: no, default: `none`
  - `doc_type` — `text` (udt `text`), nullable: no, default: `'INVOICE'::text`
  - `invoice_number` — `text` (udt `text`), nullable: no, default: `none`
  - `invoice_date` — `date` (udt `date`), nullable: no, default: `none`
  - `po_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `account_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `ship_to` — `text` (udt `text`), nullable: yes, default: `none`
  - `carrier` — `text` (udt `text`), nullable: yes, default: `none`
  - `payment_terms` — `text` (udt `text`), nullable: yes, default: `none`
  - `subtotal` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `tax` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `freight` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `total` — `numeric` (udt `numeric`), nullable: no, default: `0`
  - `currency` — `text` (udt `text`), nullable: no, default: `'USD'::text`
  - `vendor_brands` — `ARRAY` (udt `_text`), nullable: yes, default: `none`
  - `status` — `text` (udt `text`), nullable: no, default: `'unpaid'::text`
  - `notes` — `text` (udt `text`), nullable: yes, default: `none`
  - `filename` — `text` (udt `text`), nullable: yes, default: `none`
  - `line_items` — `jsonb` (udt `jsonb`), nullable: no, default: `'[]'::jsonb`
  - `imported_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `imported_by` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `is_multi_shipment` — `boolean` (udt `bool`), nullable: no, default: `false`
  - `shipment_count` — `integer` (udt `int4`), nullable: no, default: `1`
  - `last_shipment_date` — `date` (udt `date`), nullable: yes, default: `none`
  - `last_shipment_file` — `text` (udt `text`), nullable: yes, default: `none`
  - `po_total_invoiced` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `tags` — `ARRAY` (udt `_text`), nullable: yes, default: `'{}'::text[]`
  - `reconciliation_status` — `text` (udt `text`), nullable: yes, default: `'unreconciled'::text`
  - `credit_due` — `numeric` (udt `numeric`), nullable: yes, default: `0`
  - `final_bill_amount` — `numeric` (udt `numeric`), nullable: yes, default: `none`
  - `reconciled_at` — `timestamp with time zone` (udt `timestamptz`), nullable: yes, default: `none`
  - `reconciled_session_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `recon_status` — `text` (udt `text`), nullable: yes, default: `'pending'::text`
  - `recon_run_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `recon_notes` — `text` (udt `text`), nullable: yes, default: `none`
  - `has_discrepancy` — `boolean` (udt `bool`), nullable: yes, default: `false`
  - `last_reconciled_at` — `timestamp with time zone` (udt `timestamptz`), nullable: yes, default: `none`
  - `entered_after_recon` — `boolean` (udt `bool`), nullable: yes, default: `false`
  - `recon_stale` — `boolean` (udt `bool`), nullable: yes, default: `false`
  - `recon_stale_reason` — `text` (udt `text`), nullable: yes, default: `none`
  - `import_source` — `text` (udt `text`), nullable: yes, default: `'manual'::text`
  - `lightspeed_po_number` — `text` (udt `text`), nullable: yes, default: `none`
  - `received_date` — `date` (udt `date`), nullable: yes, default: `none`
  - `invoice_received_at` — `timestamp with time zone` (udt `timestamptz`), nullable: yes, default: `now()`
  - `linked_proforma_id` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `proforma_superseded_by` — `uuid` (udt `uuid`), nullable: yes, default: `none`
  - `terms_status` — `text` (udt `text`), nullable: no, default: `'needs_review'::text`
  - `terms_confidence` — `text` (udt `text`), nullable: yes, default: `none`
  - `payment_terms_extracted` — `jsonb` (udt `jsonb`), nullable: yes, default: `none`
  - `payment_terms_source` — `text` (udt `text`), nullable: yes, default: `none`
  - `shipping_terms` — `text` (udt `text`), nullable: yes, default: `none`
  - `match_status` — `text` (udt `text`), nullable: no, default: `'unmatched'::text`
  - `matched_session_ids` — `ARRAY` (udt `_uuid`), nullable: yes, default: `'{}'::uuid[]`
  - `match_confidence` — `text` (udt `text`), nullable: yes, default: `none`
  - `match_notes` — `text` (udt `text`), nullable: yes, default: `none`
  - `special_order_received` — `boolean` (udt `bool`), nullable: yes, default: `false`
  - `special_order_received_at` — `timestamp with time zone` (udt `timestamptz`), nullable: yes, default: `none`
  - `special_order_received_by` — `text` (udt `text`), nullable: yes, default: `none`
  - `pdf_url` — `text` (udt `text`), nullable: yes, default: `none`
  - `due_date` — `date` (udt `date`), nullable: yes, default: `none`
  - `extracted_terms_preset` — `text` (udt `text`), nullable: yes, default: `none`
  - `extracted_terms_confidence` — `text` (udt `text`), nullable: yes, default: `none`
  - `extracted_terms_source_text` — `text` (udt `text`), nullable: yes, default: `none`
  - `final_terms_preset` — `text` (udt `text`), nullable: yes, default: `none`
- **Foreign keys:**
  - none
- **Indexes:**
  - `idx_vi_doc_type` — `CREATE INDEX idx_vi_doc_type ON public.vendor_invoices USING btree (doc_type)`
  - `idx_vi_invoice_date` — `CREATE INDEX idx_vi_invoice_date ON public.vendor_invoices USING btree (invoice_date)`
  - `idx_vi_invoice_number` — `CREATE INDEX idx_vi_invoice_number ON public.vendor_invoices USING btree (invoice_number)`
  - `idx_vi_po_number` — `CREATE INDEX idx_vi_po_number ON public.vendor_invoices USING btree (po_number)`
  - `idx_vi_search` — `CREATE INDEX idx_vi_search ON public.vendor_invoices USING gin (to_tsvector('english'::regconfig, ((((((((((COALESCE(invoice_number, ''::text) || ' '::text) || COALESCE(po_number, ''::text)) || ' '::text) || COALESCE(account_number, ''::text)) || ' '::text) || COALESCE(vendor, ''::text)) || ' '::text) || COALESCE(notes, ''::text)) || ' '::text) || COALESCE(filename, ''::text))))`
  - `idx_vi_status` — `CREATE INDEX idx_vi_status ON public.vendor_invoices USING btree (status)`
  - `idx_vi_vendor` — `CREATE INDEX idx_vi_vendor ON public.vendor_invoices USING btree (vendor)`
  - `vendor_invoices_pkey` — `CREATE UNIQUE INDEX vendor_invoices_pkey ON public.vendor_invoices USING btree (id)`
- **Constraints / uniques:**
  - `2200_17554_15_not_null` — CHECK (columns: n/a)
  - `2200_17554_16_not_null` — CHECK (columns: n/a)
  - `2200_17554_18_not_null` — CHECK (columns: n/a)
  - `2200_17554_1_not_null` — CHECK (columns: n/a)
  - `2200_17554_21_not_null` — CHECK (columns: n/a)
  - `2200_17554_22_not_null` — CHECK (columns: n/a)
  - `2200_17554_24_not_null` — CHECK (columns: n/a)
  - `2200_17554_25_not_null` — CHECK (columns: n/a)
  - `2200_17554_2_not_null` — CHECK (columns: n/a)
  - `2200_17554_3_not_null` — CHECK (columns: n/a)
  - `2200_17554_49_not_null` — CHECK (columns: n/a)
  - `2200_17554_4_not_null` — CHECK (columns: n/a)
  - `2200_17554_54_not_null` — CHECK (columns: n/a)
  - `2200_17554_5_not_null` — CHECK (columns: n/a)
  - `2200_17554_6_not_null` — CHECK (columns: n/a)
  - `vendor_invoices_imported_by_fkey` — FOREIGN KEY (columns: imported_by)
  - `vendor_invoices_linked_proforma_id_fkey` — FOREIGN KEY (columns: linked_proforma_id)
  - `vendor_invoices_pkey` — PRIMARY KEY (columns: id)
  - `vendor_invoices_proforma_superseded_by_fkey` — FOREIGN KEY (columns: proforma_superseded_by)
  - `vendor_invoices_reconciled_session_id_fkey` — FOREIGN KEY (columns: reconciled_session_id)
- **RLS policies:**
  - `Anyone can delete invoices` — DELETE for anon, authenticated when true
  - `Anyone can insert invoices` — INSERT for anon, authenticated; with check true
  - `Anyone can update invoices` — UPDATE for anon, authenticated when true
  - `Anyone can view invoices` — SELECT for anon, authenticated when true

### `vendor_term_definitions`

- **Row count now:** 0
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `vendor_id` — `uuid` (udt `uuid`), nullable: no, default: `none`
  - `term_label` — `text` (udt `text`), nullable: yes, default: `none`
  - `term_type` — `text` (udt `text`), nullable: no, default: `'unknown'::text`
  - `payment_count` — `integer` (udt `int4`), nullable: no, default: `1`
  - `offset_type` — `text` (udt `text`), nullable: no, default: `'from_invoice_date'::text`
  - `day_intervals` — `ARRAY` (udt `_int4`), nullable: no, default: `'{}'::integer[]`
  - `is_default` — `boolean` (udt `bool`), nullable: no, default: `true`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `updated_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
- **Foreign keys:**
  - none
- **Indexes:**
  - `vendor_term_definitions_pkey` — `CREATE UNIQUE INDEX vendor_term_definitions_pkey ON public.vendor_term_definitions USING btree (id)`
- **Constraints / uniques:**
  - `2200_28184_10_not_null` — CHECK (columns: n/a)
  - `2200_28184_1_not_null` — CHECK (columns: n/a)
  - `2200_28184_2_not_null` — CHECK (columns: n/a)
  - `2200_28184_4_not_null` — CHECK (columns: n/a)
  - `2200_28184_5_not_null` — CHECK (columns: n/a)
  - `2200_28184_6_not_null` — CHECK (columns: n/a)
  - `2200_28184_7_not_null` — CHECK (columns: n/a)
  - `2200_28184_8_not_null` — CHECK (columns: n/a)
  - `2200_28184_9_not_null` — CHECK (columns: n/a)
  - `vendor_term_definitions_pkey` — PRIMARY KEY (columns: id)
  - `vendor_term_definitions_vendor_id_fkey` — FOREIGN KEY (columns: vendor_id)
- **RLS policies:**
  - `Anyone can delete vendor_term_definitions` — DELETE for public when true
  - `Anyone can insert vendor_term_definitions` — INSERT for public; with check true
  - `Anyone can update vendor_term_definitions` — UPDATE for public when true
  - `Anyone can view vendor_term_definitions` — SELECT for public when true

### `vendor_terms_config`

- **Row count now:** 2
- **Columns:**
  - `id` — `uuid` (udt `uuid`), nullable: no, default: `gen_random_uuid()`
  - `vendor_name` — `text` (udt `text`), nullable: no, default: `none`
  - `terms_type` — `text` (udt `text`), nullable: no, default: `'unknown'::text`
  - `offsets` — `ARRAY` (udt `_int4`), nullable: no, default: `'{}'::integer[]`
  - `eom_based` — `boolean` (udt `bool`), nullable: no, default: `false`
  - `eom_baseline_offset` — `integer` (udt `int4`), nullable: yes, default: `0`
  - `due_offset` — `integer` (udt `int4`), nullable: yes, default: `none`
  - `description` — `text` (udt `text`), nullable: no, default: `''::text`
  - `vendor_match_strings` — `ARRAY` (udt `_text`), nullable: no, default: `'{}'::text[]`
  - `is_active` — `boolean` (udt `bool`), nullable: no, default: `true`
  - `created_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
  - `updated_at` — `timestamp with time zone` (udt `timestamptz`), nullable: no, default: `now()`
- **Foreign keys:**
  - none
- **Indexes:**
  - `vendor_terms_config_pkey` — `CREATE UNIQUE INDEX vendor_terms_config_pkey ON public.vendor_terms_config USING btree (id)`
- **Constraints / uniques:**
  - `2200_28143_10_not_null` — CHECK (columns: n/a)
  - `2200_28143_11_not_null` — CHECK (columns: n/a)
  - `2200_28143_12_not_null` — CHECK (columns: n/a)
  - `2200_28143_1_not_null` — CHECK (columns: n/a)
  - `2200_28143_2_not_null` — CHECK (columns: n/a)
  - `2200_28143_3_not_null` — CHECK (columns: n/a)
  - `2200_28143_4_not_null` — CHECK (columns: n/a)
  - `2200_28143_5_not_null` — CHECK (columns: n/a)
  - `2200_28143_8_not_null` — CHECK (columns: n/a)
  - `2200_28143_9_not_null` — CHECK (columns: n/a)
  - `vendor_terms_config_pkey` — PRIMARY KEY (columns: id)
- **RLS policies:**
  - `Anyone can delete vendor_terms_config` — DELETE for anon, authenticated when true
  - `Anyone can insert vendor_terms_config` — INSERT for anon, authenticated; with check true
  - `Anyone can update vendor_terms_config` — UPDATE for anon, authenticated when true
  - `Anyone can view vendor_terms_config` — SELECT for anon, authenticated when true

## 3. File Tree

```text
src/
  App.css
  App.tsx — top-level router and global providers.
  index.css — global design tokens and base styling.
  main.tsx — Vite/React entry point.
  tailwind.config.lov.json
  vite-env.d.ts
  components/
    NavLink.tsx
    PasswordGate.tsx — session-storage password gate that wraps the whole app.
    invoices/
      AuditPanel.tsx — audit banner, recalculation guard UI, and audit actions.
      Badges.tsx — shared invoice/document type badges.
      InvoiceDrawer.tsx — detail drawer for a single invoice record.
      InvoiceFiltersBar.tsx — search/filter controls for invoice list view.
      InvoiceFlags.tsx — compact invoice status and integrity flags.
      InvoiceNav.tsx — primary app navigation for AP pages.
      InvoiceReviewCard.tsx — mandatory pre-save review for extracted invoices/POs.
      InvoiceTable.tsx — paginated invoice list table.
      LinkRealInvoice.tsx — proforma-to-real-invoice linking UI.
      MatchReportSection.tsx — embedded match-report summary/actions.
      MatchStatusPanel.tsx — invoice matching health panel.
      NeedsReviewQueue.tsx — queue of extracted invoices blocked for review.
      NewVendorWizard.tsx — guided setup for new vendors and terms metadata.
      POView.tsx — purchase-order focused invoice page mode.
      PaymentStatusBadge.tsx — AP payment state badge renderer.
      PendingMigrationSection.tsx — older Maui migration UI retained alongside ScheduleHealthPanel.
      ReconciliationAuditPanel.tsx — reconciliation audit metrics/details.
      RecordPaymentModal.tsx — modal for recording installment payments.
      SKUCheckTab.tsx — four-way SKU/inventory verification UI.
      ScheduleDivergencesSection.tsx — legacy divergence list for schedule drift.
      ScheduleHealthPanel.tsx — consolidated schedule migration/divergence control center.
      StaleQueuePanel.tsx — stale reconciliation queue monitor.
      StatsBar.tsx — invoice stats summary row.
      TagInput.tsx — editable invoice tag entry control.
      TermsConfirmationPanel.tsx — terms confirmation and vendor-rule enforcement UI.
      VendorCoveragePanel.tsx — audit view of vendor mapping/coverage.
      VendorRuleDialog.tsx — strict vendor terms override dialog.
    ui/
      accordion.tsx
      alert-dialog.tsx
      alert.tsx
      aspect-ratio.tsx
      avatar.tsx
      badge.tsx
      breadcrumb.tsx
      button.tsx
      calendar.tsx
      card.tsx
      carousel.tsx
      chart.tsx
      checkbox.tsx
      collapsible.tsx
      command.tsx
      context-menu.tsx
      dialog.tsx
      drawer.tsx
      dropdown-menu.tsx
      form.tsx
      hover-card.tsx
      input-otp.tsx
      input.tsx
      label.tsx
      menubar.tsx
      navigation-menu.tsx
      pagination.tsx
      popover.tsx
      progress.tsx
      radio-group.tsx
      resizable.tsx
      scroll-area.tsx
      select.tsx
      separator.tsx
      sheet.tsx
      sidebar.tsx
      skeleton.tsx
      slider.tsx
      sonner.tsx
      switch.tsx
      table.tsx
      tabs.tsx
      textarea.tsx
      toast.tsx
      toaster.tsx
      toggle-group.tsx
      toggle.tsx
      tooltip.tsx
      use-toast.ts
  hooks/
    use-mobile.tsx
    use-toast.ts
  integrations/
    supabase/
      client.ts — generated Lovable Cloud client bootstrap using VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.
      types.ts — generated database types snapshot (read-only).
  lib/
    csv-po-parser.ts — CSV PO parsing helpers.
    divergence-survey.ts — detects material vs cosmetic payment schedule divergence.
    dynamic-vendor-lookup.ts — runtime vendor alias/terms lookup from database tables.
    engine-migrations.ts — builds and executes payment schedule engine migrations.
    final-bill-queries.ts — final-bill ledger data access and credit workflows.
    invoice-dedup.ts — canonical vendor normalization and invoice deduplication engine.
    invoice-suggestions.ts — receiving-to-invoice suggestion ranking.
    ls-match-engine.ts — Lightspeed-to-invoice matching engine.
    match-engine.ts — invoice/item matching utilities.
    match-utils.ts — match report orchestration and CSV export helpers.
    payment-queries.ts — payment CRUD, generation, audit, and guard logic.
    payment-terms-engine.ts — high-level payment schedule resolver.
    payment-terms.ts — payment term parsing, vendor defaults, and installment calculation.
    pending-match.ts — post-save pending match checks.
    photo-capture-engine.ts — image compression and direct photo extraction via Anthropic.
    reader-engine.ts — invoice reader extraction pipeline, upload helpers, and batch queue utilities.
    receiving-engine.ts — receiving import, dedup, reconciliation, and export helpers.
    reconciliation-engine.ts — full reconciliation runner.
    reconciliation-math.ts — reconciliation math verification helpers.
    sku-check-engine.ts — real-time SKU validation engine.
    stale-queue-queries.ts — stale reconciliation queue queries.
    supabase-fetch-all.ts — paginated fetch helpers for large tables and audit scale checks.
    supabase-queries.ts — shared invoice query/update helpers and formatters.
    targeted-reconciliation.ts — filtered reconciliation runs.
    utils.ts
    vendor-pricing-rules.ts — standing vendor discount adjustments.
    vendor-terms-registry.ts — source-of-truth registry for vendor terms rules and strict enforcement.
  pages/
    APDashboard.tsx
    Audit.tsx
    Index.tsx
    Invoices.tsx
    LedgerCheck.tsx
    LightspeedImport.tsx
    MatchReport.tsx
    NotFound.tsx
    Reader.tsx
    Receiving.tsx
    Reconciliation.tsx — currently not routed from App.tsx but still present in src/pages.
    Reports.tsx
  test/
    example.test.ts
    setup.ts
```

## 4. Routes

- `/` → `src/pages/Index.tsx` — Redirects root traffic to the AP dashboard.
- `/invoices` → `src/pages/Invoices.tsx` — Primary invoice workspace with filters, audit banner, review queue, migration health, and invoice drawer.
- `/invoices/reader` → `src/pages/Reader.tsx` — PDF/photo/CSV intake flow for extracting invoices and purchase orders before review and save.
- `/invoices/match` → `src/pages/MatchReport.tsx` — Runs invoice line-item matching against item master and exports match reports.
- `/invoices/dashboard` → `src/pages/APDashboard.tsx` — Rolling AP payment dashboard with vendor/month cash view, overdue totals, and payment actions.
- `/invoices/reports` → `src/pages/Reports.tsx` — Operational reporting hub for aging, payment history, outstanding AP, cash flow, fulfillment, vendor spend, and backorders.
- `/invoices/receiving` → `src/pages/Receiving.tsx` — PO receiving, invoice matching, reconciliation math, and final bill workflow.
- `/import/lightspeed` → `src/pages/LightspeedImport.tsx` — Imports Lightspeed CSV data and compares it against invoice lines before saving.
- `/audit` → `src/pages/Audit.tsx` — Cross-system audit page for invoice, payment, vendor coverage, and reconciliation health checks.
- `/invoices/ledger-check` → `src/pages/LedgerCheck.tsx` — Spreadsheet-based ledger check and invoice matching workspace.
- `*` → `src/pages/NotFound.tsx` — Fallback 404 page for unmatched routes.
- `/invoices/reconciliation` — not present in `src/App.tsx`; `src/pages/Reconciliation.tsx` exists but is currently unrouted.

## 5. Environment Variables

### Supabase / Lovable Cloud
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_URL`
- `VITE_SUPABASE_PROJECT_ID`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_SUPABASE_URL`
- Managed backend secrets visible in project context: `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`

### Anthropic API
- No Anthropic env var is used in app code.
- Anthropic keys are currently entered manually by the user in the UI and stored client-side in localStorage (`anthropic_api_key`) for Reader/New Vendor Wizard/photo extraction flows.

### Third-party APIs
- none present as environment variables in the current codebase

### Feature flags / misc
- `LOVABLE_API_KEY` (managed secret present in project secrets)
- No additional feature-flag env vars found in current source scan.

## 6. Edge Functions & API Endpoints

### Lovable Cloud backend functions
- `extract-invoice` (`supabase/functions/extract-invoice/index.ts`) — HTTP function invoked by `supabase.functions.invoke("extract-invoice")` from `src/lib/reader-engine.ts`; purpose: proxy PDF invoice extraction to Anthropic and return parsed JSON. Trigger: HTTP.

### External API calls found in code
- `https://api.anthropic.com/v1/messages` — called from `supabase/functions/extract-invoice/index.ts` for PDF extraction.
- `https://api.anthropic.com/v1/messages` — called directly from browser code in `src/lib/photo-capture-engine.ts` for image/photo extraction.
- `https://api.anthropic.com/v1/messages` — called directly from `src/components/invoices/NewVendorWizard.tsx` for extracting fields from new vendor sample invoices/images.
- Lovable Cloud database and storage APIs are used throughout via the generated client in `src/integrations/supabase/client.ts`.
- No cron triggers found in `supabase/config.toml`; only `[functions.extract-invoice] verify_jwt = false` is configured.

## 7. Key Business Rules Embedded in Code

### `KNOWN_VENDORS` (`src/lib/invoice-dedup.ts`)

- `Luxottica`
- `Kering`
- `Maui Jim`
- `Safilo`
- `Marcolin`
- `Marchon`
- `Smith Optics`
- `Revo`

### `VENDOR_MAP` canonical mappings (`src/lib/invoice-dedup.ts`)

- `luxottica` → `Luxottica`
- `luxottica of america` → `Luxottica`
- `luxottica of america inc` → `Luxottica`
- `luxottica of america inc.` → `Luxottica`
- `luxottica usa` → `Luxottica`
- `essilor luxottica` → `Luxottica`
- `essilorluxottica` → `Luxottica`
- `kering` → `Kering`
- `kering eyewear` → `Kering`
- `kering eyewear usa` → `Kering`
- `kering eyewear usa inc` → `Kering`
- `kering eyewear usa, inc.` → `Kering`
- `kering eyewear usa, inc` → `Kering`
- `kering eyewear usa inc.` → `Kering`
- `maui jim` → `Maui Jim`
- `maui jim inc` → `Maui Jim`
- `maui jim inc.` → `Maui Jim`
- `maui jim, inc.` → `Maui Jim`
- `maui jim usa` → `Maui Jim`
- `maui jim usa inc` → `Maui Jim`
- `maui jim usa, inc.` → `Maui Jim`
- `maui jim usa, inc` → `Maui Jim`
- `safilo` → `Safilo`
- `safilo usa` → `Safilo`
- `safilo usa inc` → `Safilo`
- `safilo usa inc.` → `Safilo`
- `safilo usa, inc.` → `Safilo`
- `safilo usa, inc` → `Safilo`
- `safilo s.p.a.` → `Safilo`
- `safilo spa` → `Safilo`
- `safilo group` → `Safilo`
- `marcolin` → `Marcolin`
- `marcolin usa` → `Marcolin`
- `marcolin usa inc` → `Marcolin`
- `marcolin usa inc.` → `Marcolin`
- `marcolin usa, inc.` → `Marcolin`
- `marcolin s.p.a.` → `Marcolin`
- `marcolin spa` → `Marcolin`
- `marchon` → `Marchon`
- `marchon eyewear` → `Marchon`
- `marchon eyewear inc` → `Marchon`
- `marchon eyewear inc.` → `Marchon`
- `marchon eyewear, inc.` → `Marchon`
- `marchon eyewear, inc` → `Marchon`
- `marchon italia` → `Marchon`
- `marchon usa` → `Marchon`
- `marchon usa inc` → `Marchon`
- `marchon usa inc.` → `Marchon`
- `marchon nyc` → `Marchon`
- `smith optics` → `Smith Optics`
- `smith optics inc` → `Smith Optics`
- `smith optics inc.` → `Smith Optics`
- `smith optics, inc.` → `Smith Optics`
- `smith sport optics` → `Smith Optics`
- `smith sport optics inc` → `Smith Optics`
- `smith sport optics inc.` → `Smith Optics`
- `smith sport optics, inc.` → `Smith Optics`
- `smith` → `Smith Optics`
- `revo` → `Revo`
- `b robinson` → `Revo`
- `b. robinson` → `Revo`
- `b robinson llc` → `Revo`
- `b. robinson llc` → `Revo`
- `b robinson llc / revo` → `Revo`
- `b. robinson llc / revo` → `Revo`
- `b robinson / revo` → `Revo`
- `chanel` → `Chanel`
- `costa del mar` → `Costa`
- `costa` → `Costa`
- `oliver peoples` → `Oliver Peoples`
- `cartier` → `Cartier`

### `VENDOR_DEFAULTS` (`src/lib/payment-terms.ts`)

- `Luxottica` — type `eom_split`, days [30, 60, 90], installments 3, eom_based `true`, label `EOM 30 / 60 / 90`
- `Kering` — type `eom_split`, days [30, 60, 90], installments 3, eom_based `true`, label `EOM 30 / 60 / 90`
- `Maui Jim` — type `net_split`, days [60, 90, 120, 150], installments 4, eom_based `false`, label `Days 60 / 90 / 120 / 150`
- `Marcolin` — type `eom_split`, days [50, 80, 110], installments 3, eom_based `true`, label `EOM 50 / 80 / 110`
- `Safilo` — type `eom_single`, days [60], installments 1, eom_based `true`, label `EOM 60`
- `Marchon` — type `net_single`, days [30], installments 1, eom_based `false`, label `Net 30`
- `Revo` — type `net_single`, days [90], installments 1, eom_based `false`, label `Net 90`

### `VENDOR_TERMS_REGISTRY` (`src/lib/vendor-terms-registry.ts`)

- vendor_match: ['marcolin', 'tom ford', 'guess', 'swarovski', 'montblanc']; terms_type: eom_split; offsets: [50, 80, 110]; description: EOM 50/80/110 — 3 equal tranches; strict: false
- vendor_match: ['maui jim', 'maui']; terms_type: days_split; offsets: [60, 90, 120, 150]; description: Days 60/90/120/150 — 4 equal tranches from invoice date (default; overridden by 'Split Payment EOM' when present); strict: false
- vendor_match: ['kering', 'gucci', 'saint laurent', 'balenciaga', 'bottega veneta', 'alexander mcqueen', 'cartier']; terms_type: eom_split; offsets: [30, 60, 90]; description: EOM 30/60/90 — 3 equal tranches; strict: false
- vendor_match: ['safilo', 'jimmy choo', 'dior', 'fendi', 'hugo boss', 'kate spade', 'liz claiborne', 'fossil']; terms_type: eom_single; offsets: []; eom_baseline_offset: 0; due_offset: 60; description: 60 Days EOM — Single payment; strict: false
- vendor_match: ['luxottica', 'ray-ban', 'rayban', 'oakley', 'costa', 'chanel', 'prada', 'versace', 'coach', 'burberry', 'michael kors', 'persol', 'miu miu', 'oliver peoples', 'ralph']; terms_type: eom_single; offsets: []; eom_baseline_offset: 30; due_offset: 30; description: EOM +30 — Single payment; strict: false
- vendor_match: ['smith optics', 'smith sport optics', 'smith']; terms_type: use_invoice; offsets: []; description: Read terms from invoice — no standing terms configured yet; strict: false
- vendor_match: ['revo', 'b robinson', 'b. robinson', 'b robinson llc']; terms_type: net_single; offsets: [90]; description: Net 90 — Single payment (standing rule, never varies); strict: true

### `VENDOR_COLORS` (`src/pages/APDashboard.tsx`)

- `Kering` → `bg-red-600`
- `Luxottica` → `bg-amber-600`
- `Marcolin` → `bg-teal-600`
- `Maui Jim` → `bg-yellow-500`
- `Safilo` → `bg-green-600`
- Fallback in code: `getVendorColor(vendor) || "bg-primary"`

### LLM `SYSTEM_PROMPT` vendor list (`src/lib/reader-engine.ts` / edge function mirror)

- Maui Jim; Kering (Gucci, Saint Laurent, Balenciaga, Bottega Veneta, Alexander McQueen); Safilo (Carrera, Fossil, Hugo Boss, Jimmy Choo); Marcolin (Tom Ford, Guess, Swarovski, Montblanc); Luxottica (Ray-Ban, Oakley, Prada, Versace, Persol, Coach, DKNY, Dolce & Gabbana, Emporio Armani, Giorgio Armani, Burberry, Michael Kors, Tiffany, Vogue); Marchon (Nike, Columbia, Dragon, Flexon, Calvin Klein, Donna Karan, Lacoste, Salvatore Ferragamo, MCM, Nautica, Nine West, Skaga); Smith Optics; Revo (distributed by B Robinson LLC).

### Schedule drift thresholds (`src/components/invoices/ScheduleHealthPanel.tsx`)

- `DRIFT_DAYS = 7`
- `DRIFT_DOLLARS = 5`

## 8. Guard Logic

### Guard 1 — credit memos

Exact code (`src/lib/engine-migrations.ts`):
```ts
const blocked_by_guard1_credit = rows.some(
  (r) => r.terms === "credit_memo" || r.installment_label === "Credit" || Number(r.amount_due) < 0
);
```
This treats any negative-due or credit-labeled payment schedule as non-migratable.

### Guard 2 — paid installments

Exact code (`src/lib/engine-migrations.ts`):
```ts
const blocked_by_guard2_paid = rows.some(
  (r) => r.is_paid === true || r.payment_status === "paid" || Number(r.amount_paid ?? 0) > 0
);
```
This blocks migrations if any installment already has payment history.

### Guard 3 — typed `MIGRATE` confirmation

Exact code (`src/components/invoices/ScheduleHealthPanel.tsx`):
```tsx
<Input
  value={typedConfirm}
  onChange={(e) => setTypedConfirm(e.target.value)}
  placeholder="Type MIGRATE to confirm"
  className="h-7 text-xs font-mono border-destructive/30"
/>

<Button
  size="sm"
  variant="destructive"
  className="text-xs h-7"
  onClick={onApprove}
  disabled={executing || typedConfirm !== "MIGRATE"}
>
  {executing && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
  Run Update
</Button>
```
The UI does not allow schedule migration execution until the typed text matches `MIGRATE` exactly.

## 9. Migration Audit Tags

Query used:
```sql
SELECT action, COUNT(*), MIN(created_at) as first_seen, MAX(created_at) as last_seen
FROM recalc_audit_log
GROUP BY action
ORDER BY last_seen DESC;
```

| action | count | first_seen | last_seen |
| --- | ---: | --- | --- |
| `engine_migration_maui_eom_round` | 28 | 2026-04-23 15:09:24.198023+00 | 2026-04-23 15:09:51.621374+00 |
| `recalculate_payments_with_manual_override` | 2 | 2026-04-16 16:53:09.029621+00 | 2026-04-16 16:57:10.560373+00 |

## 10. Known Open Issues

### Source comments (`TODO` / `FIXME` / `NOTE`)

- No `TODO` or `FIXME` comments were found in the current `src/` or `supabase/` scan.
- `src/lib/vendor-terms-registry.ts:77` — NOTE: Luxottica standing single-payment rule is overridden to `eom_split [30,60,90]` when invoice terms contain `30/60/90`.
- `src/pages/APDashboard.tsx:86` — NOTE: historical “Fix Kering / Fix Luxottica” state was removed after terms were considered verified on 2026-04-02.
- `src/lib/payment-terms.ts:500` — NOTE: legacy Maui Jim invoices with `Split Payment EOM` are specially handled.
- `src/lib/payment-terms-engine.ts:361` — NOTE: legacy Maui Jim `Split Payment EOM` handling also exists in the newer resolver path.
- `src/components/invoices/InvoiceFlags.tsx:60` — NOTE: `recon_status = discrepancy` flag removed because it over-flagged most invoices.
- `src/components/invoices/InvoiceReviewCard.tsx:251` — JSX comment noting a new-vendor note block hidden for credit memos.

### Recent chat-history issues referenced in current session

- Published site was reported to lag behind preview updates until a publish update is pushed.
- Invoice date parsing regressions were discussed for dates like `4/2/26` incorrectly appearing as `2026-02-04`.
- Payment schedule regressions were discussed for vendor-specific tranche dates (including 30/60/90 schedules and Maui Jim EOM handling).
- These issue notes come from recent conversation context, not from code comments.

## 11. Last Deploy

- **Current publish status:** public and published.
- **Last publish timestamp:** not present in the accessible project/code/database metadata gathered for this snapshot.
- **Pending uncommitted changes in editor:** none detected via `git status --short` at generation time.

