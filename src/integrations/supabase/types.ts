export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      current_planogram: {
        Row: {
          backstock_location: string | null
          brand: string | null
          brand_key: string | null
          created_at: string
          frame_source: string | null
          go_out_location: string | null
          id: string
          is_discontinued: boolean | null
          is_vendor_discontinued: boolean | null
          model_number: string | null
          upc: string | null
        }
        Insert: {
          backstock_location?: string | null
          brand?: string | null
          brand_key?: string | null
          created_at?: string
          frame_source?: string | null
          go_out_location?: string | null
          id?: string
          is_discontinued?: boolean | null
          is_vendor_discontinued?: boolean | null
          model_number?: string | null
          upc?: string | null
        }
        Update: {
          backstock_location?: string | null
          brand?: string | null
          brand_key?: string | null
          created_at?: string
          frame_source?: string | null
          go_out_location?: string | null
          id?: string
          is_discontinued?: boolean | null
          is_vendor_discontinued?: boolean | null
          model_number?: string | null
          upc?: string | null
        }
        Relationships: []
      }
      final_bill_ledger: {
        Row: {
          amount_paid_toward_final: number | null
          approved_by: string | null
          created_at: string
          credit_approved: boolean | null
          credit_approved_amount: number | null
          credit_approved_at: string | null
          credit_due_overbilled: number | null
          credit_request_sent: boolean | null
          credit_request_sent_at: string | null
          discrepancy_line_count: number | null
          final_balance_remaining: number | null
          final_bill_amount: number
          final_bill_status: string | null
          id: string
          invoice_date: string | null
          invoice_id: string | null
          invoice_number: string
          not_on_invoice_amount: number | null
          notes: string | null
          original_invoice_total: number
          po_number: string | null
          qty_mismatch_amount: number | null
          session_id: string | null
          total_credit_due: number | null
          total_not_received_qty: number | null
          total_ordered_qty: number | null
          total_received_qty: number | null
          vendor: string
        }
        Insert: {
          amount_paid_toward_final?: number | null
          approved_by?: string | null
          created_at?: string
          credit_approved?: boolean | null
          credit_approved_amount?: number | null
          credit_approved_at?: string | null
          credit_due_overbilled?: number | null
          credit_request_sent?: boolean | null
          credit_request_sent_at?: string | null
          discrepancy_line_count?: number | null
          final_balance_remaining?: number | null
          final_bill_amount?: number
          final_bill_status?: string | null
          id?: string
          invoice_date?: string | null
          invoice_id?: string | null
          invoice_number: string
          not_on_invoice_amount?: number | null
          notes?: string | null
          original_invoice_total?: number
          po_number?: string | null
          qty_mismatch_amount?: number | null
          session_id?: string | null
          total_credit_due?: number | null
          total_not_received_qty?: number | null
          total_ordered_qty?: number | null
          total_received_qty?: number | null
          vendor: string
        }
        Update: {
          amount_paid_toward_final?: number | null
          approved_by?: string | null
          created_at?: string
          credit_approved?: boolean | null
          credit_approved_amount?: number | null
          credit_approved_at?: string | null
          credit_due_overbilled?: number | null
          credit_request_sent?: boolean | null
          credit_request_sent_at?: string | null
          discrepancy_line_count?: number | null
          final_balance_remaining?: number | null
          final_bill_amount?: number
          final_bill_status?: string | null
          id?: string
          invoice_date?: string | null
          invoice_id?: string | null
          invoice_number?: string
          not_on_invoice_amount?: number | null
          notes?: string | null
          original_invoice_total?: number
          po_number?: string | null
          qty_mismatch_amount?: number | null
          session_id?: string | null
          total_credit_due?: number | null
          total_not_received_qty?: number | null
          total_ordered_qty?: number | null
          total_received_qty?: number | null
          vendor?: string
        }
        Relationships: [
          {
            foreignKeyName: "final_bill_ledger_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "vendor_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "final_bill_ledger_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "po_receiving_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_snapshots: {
        Row: {
          brand: string | null
          created_at: string
          id: string
          item_description: string | null
          model_number: string | null
          quantity_on_hand: number | null
          snapshot_date: string | null
          store_id: string | null
          upc: string | null
        }
        Insert: {
          brand?: string | null
          created_at?: string
          id?: string
          item_description?: string | null
          model_number?: string | null
          quantity_on_hand?: number | null
          snapshot_date?: string | null
          store_id?: string | null
          upc?: string | null
        }
        Update: {
          brand?: string | null
          created_at?: string
          id?: string
          item_description?: string | null
          model_number?: string | null
          quantity_on_hand?: number | null
          snapshot_date?: string | null
          store_id?: string | null
          upc?: string | null
        }
        Relationships: []
      }
      invoice_payments: {
        Row: {
          amount_due: number
          amount_paid: number | null
          balance_remaining: number | null
          check_number: string | null
          created_at: string
          dispute_reason: string | null
          due_date: string
          id: string
          installment_label: string | null
          invoice_amount: number
          invoice_date: string
          invoice_id: string | null
          invoice_number: string
          is_paid: boolean
          last_payment_date: string | null
          notes: string | null
          paid_date: string | null
          payment_history: Json | null
          payment_method: string | null
          payment_reference: string | null
          payment_status: string | null
          po_number: string | null
          recorded_by: string | null
          terms: string | null
          vendor: string
          void_reason: string | null
        }
        Insert: {
          amount_due: number
          amount_paid?: number | null
          balance_remaining?: number | null
          check_number?: string | null
          created_at?: string
          dispute_reason?: string | null
          due_date: string
          id?: string
          installment_label?: string | null
          invoice_amount: number
          invoice_date: string
          invoice_id?: string | null
          invoice_number: string
          is_paid?: boolean
          last_payment_date?: string | null
          notes?: string | null
          paid_date?: string | null
          payment_history?: Json | null
          payment_method?: string | null
          payment_reference?: string | null
          payment_status?: string | null
          po_number?: string | null
          recorded_by?: string | null
          terms?: string | null
          vendor: string
          void_reason?: string | null
        }
        Update: {
          amount_due?: number
          amount_paid?: number | null
          balance_remaining?: number | null
          check_number?: string | null
          created_at?: string
          dispute_reason?: string | null
          due_date?: string
          id?: string
          installment_label?: string | null
          invoice_amount?: number
          invoice_date?: string
          invoice_id?: string | null
          invoice_number?: string
          is_paid?: boolean
          last_payment_date?: string | null
          notes?: string | null
          paid_date?: string | null
          payment_history?: Json | null
          payment_method?: string | null
          payment_reference?: string | null
          payment_status?: string | null
          po_number?: string | null
          recorded_by?: string | null
          terms?: string | null
          vendor?: string
          void_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "vendor_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      item_master: {
        Row: {
          article_name: string | null
          brand: string | null
          color: string | null
          created_at: string
          frame_shape: string | null
          gender: string | null
          id: string
          model_number: string | null
          retail_price: number | null
          size: string | null
          upc: string | null
          wholesale_price: number | null
        }
        Insert: {
          article_name?: string | null
          brand?: string | null
          color?: string | null
          created_at?: string
          frame_shape?: string | null
          gender?: string | null
          id?: string
          model_number?: string | null
          retail_price?: number | null
          size?: string | null
          upc?: string | null
          wholesale_price?: number | null
        }
        Update: {
          article_name?: string | null
          brand?: string | null
          color?: string | null
          created_at?: string
          frame_shape?: string | null
          gender?: string | null
          id?: string
          model_number?: string | null
          retail_price?: number | null
          size?: string | null
          upc?: string | null
          wholesale_price?: number | null
        }
        Relationships: []
      }
      lightspeed_receiving: {
        Row: {
          created_at: string
          id: string
          invoice_match_status: string
          item_description: string | null
          manufact_sku: string | null
          matched_invoice_id: string | null
          not_received_qty: number | null
          po_number: string | null
          received_qty: number | null
          receiving_status: string | null
          session_id: string | null
          unit_cost: number | null
          upc: string | null
          vendor_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          invoice_match_status?: string
          item_description?: string | null
          manufact_sku?: string | null
          matched_invoice_id?: string | null
          not_received_qty?: number | null
          po_number?: string | null
          received_qty?: number | null
          receiving_status?: string | null
          session_id?: string | null
          unit_cost?: number | null
          upc?: string | null
          vendor_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          invoice_match_status?: string
          item_description?: string | null
          manufact_sku?: string | null
          matched_invoice_id?: string | null
          not_received_qty?: number | null
          po_number?: string | null
          received_qty?: number | null
          receiving_status?: string | null
          session_id?: string | null
          unit_cost?: number | null
          upc?: string | null
          vendor_id?: string | null
        }
        Relationships: []
      }
      master_assortment: {
        Row: {
          assortment: string | null
          backstock_location: string | null
          brand: string | null
          bridge_size: string | null
          color: string | null
          created_at: string
          default_price: number | null
          go_out_location: string | null
          id: string
          image_url: string | null
          lens_height: string | null
          model: string | null
          msrp: number | null
          online_price: number | null
          polarized: string | null
          price_rule: number | null
          rxable: string | null
          size: string | null
          system_id: string | null
          temple_length: string | null
          title: string | null
          upc: string | null
          vendor: string | null
          wholesale: number | null
        }
        Insert: {
          assortment?: string | null
          backstock_location?: string | null
          brand?: string | null
          bridge_size?: string | null
          color?: string | null
          created_at?: string
          default_price?: number | null
          go_out_location?: string | null
          id?: string
          image_url?: string | null
          lens_height?: string | null
          model?: string | null
          msrp?: number | null
          online_price?: number | null
          polarized?: string | null
          price_rule?: number | null
          rxable?: string | null
          size?: string | null
          system_id?: string | null
          temple_length?: string | null
          title?: string | null
          upc?: string | null
          vendor?: string | null
          wholesale?: number | null
        }
        Update: {
          assortment?: string | null
          backstock_location?: string | null
          brand?: string | null
          bridge_size?: string | null
          color?: string | null
          created_at?: string
          default_price?: number | null
          go_out_location?: string | null
          id?: string
          image_url?: string | null
          lens_height?: string | null
          model?: string | null
          msrp?: number | null
          online_price?: number | null
          polarized?: string | null
          price_rule?: number | null
          rxable?: string | null
          size?: string | null
          system_id?: string | null
          temple_length?: string | null
          title?: string | null
          upc?: string | null
          vendor?: string | null
          wholesale?: number | null
        }
        Relationships: []
      }
      po_receiving_lines: {
        Row: {
          billing_discrepancy: boolean | null
          created_at: string
          custom_sku: string | null
          discrepancy_amount: number | null
          discrepancy_type: string | null
          ean: string | null
          id: string
          invoice_match_status: string
          item_description: string | null
          lightspeed_status: string | null
          manufact_sku: string | null
          match_status: string | null
          matched_invoice_id: string | null
          matched_invoice_line: Json | null
          not_received_qty: number | null
          notes: string | null
          order_qty: number | null
          ordered_cost: number | null
          received_cost: number | null
          received_qty: number | null
          receiving_status: string | null
          retail_price: number | null
          session_id: string
          system_id: string | null
          unit_cost: number | null
          unit_discount: number | null
          unit_shipping: number | null
          upc: string | null
          vendor_id: string | null
        }
        Insert: {
          billing_discrepancy?: boolean | null
          created_at?: string
          custom_sku?: string | null
          discrepancy_amount?: number | null
          discrepancy_type?: string | null
          ean?: string | null
          id?: string
          invoice_match_status?: string
          item_description?: string | null
          lightspeed_status?: string | null
          manufact_sku?: string | null
          match_status?: string | null
          matched_invoice_id?: string | null
          matched_invoice_line?: Json | null
          not_received_qty?: number | null
          notes?: string | null
          order_qty?: number | null
          ordered_cost?: number | null
          received_cost?: number | null
          received_qty?: number | null
          receiving_status?: string | null
          retail_price?: number | null
          session_id: string
          system_id?: string | null
          unit_cost?: number | null
          unit_discount?: number | null
          unit_shipping?: number | null
          upc?: string | null
          vendor_id?: string | null
        }
        Update: {
          billing_discrepancy?: boolean | null
          created_at?: string
          custom_sku?: string | null
          discrepancy_amount?: number | null
          discrepancy_type?: string | null
          ean?: string | null
          id?: string
          invoice_match_status?: string
          item_description?: string | null
          lightspeed_status?: string | null
          manufact_sku?: string | null
          match_status?: string | null
          matched_invoice_id?: string | null
          matched_invoice_line?: Json | null
          not_received_qty?: number | null
          notes?: string | null
          order_qty?: number | null
          ordered_cost?: number | null
          received_cost?: number | null
          received_qty?: number | null
          receiving_status?: string | null
          retail_price?: number | null
          session_id?: string
          system_id?: string | null
          unit_cost?: number | null
          unit_discount?: number | null
          unit_shipping?: number | null
          upc?: string | null
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "po_receiving_lines_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "po_receiving_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      po_receiving_sessions: {
        Row: {
          child_session_ids: string[] | null
          created_at: string
          fully_received: number | null
          id: string
          lightspeed_export_type: string | null
          not_received: number | null
          notes: string | null
          parent_session_id: string | null
          partially_received: number | null
          raw_filename: string | null
          reconciled_invoice_id: string | null
          reconciliation_status: string
          session_name: string
          total_lines: number | null
          total_ordered_cost: number | null
          total_ordered_qty: number | null
          total_received_cost: number | null
          total_received_qty: number | null
          vendor: string
        }
        Insert: {
          child_session_ids?: string[] | null
          created_at?: string
          fully_received?: number | null
          id?: string
          lightspeed_export_type?: string | null
          not_received?: number | null
          notes?: string | null
          parent_session_id?: string | null
          partially_received?: number | null
          raw_filename?: string | null
          reconciled_invoice_id?: string | null
          reconciliation_status?: string
          session_name: string
          total_lines?: number | null
          total_ordered_cost?: number | null
          total_ordered_qty?: number | null
          total_received_cost?: number | null
          total_received_qty?: number | null
          vendor: string
        }
        Update: {
          child_session_ids?: string[] | null
          created_at?: string
          fully_received?: number | null
          id?: string
          lightspeed_export_type?: string | null
          not_received?: number | null
          notes?: string | null
          parent_session_id?: string | null
          partially_received?: number | null
          raw_filename?: string | null
          reconciled_invoice_id?: string | null
          reconciliation_status?: string
          session_name?: string
          total_lines?: number | null
          total_ordered_cost?: number | null
          total_ordered_qty?: number | null
          total_received_cost?: number | null
          total_received_qty?: number | null
          vendor?: string
        }
        Relationships: [
          {
            foreignKeyName: "po_receiving_sessions_parent_session_id_fkey"
            columns: ["parent_session_id"]
            isOneToOne: false
            referencedRelation: "po_receiving_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_receiving_sessions_reconciled_invoice_id_fkey"
            columns: ["reconciled_invoice_id"]
            isOneToOne: false
            referencedRelation: "vendor_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      recon_stale_queue: {
        Row: {
          brand: string | null
          entity_id: string | null
          entity_type: string
          id: string
          prior_recon_run_id: string | null
          processed_at: string | null
          queued_at: string | null
          status: string | null
          triggered_by: string
          upc: string | null
          vendor: string | null
        }
        Insert: {
          brand?: string | null
          entity_id?: string | null
          entity_type: string
          id?: string
          prior_recon_run_id?: string | null
          processed_at?: string | null
          queued_at?: string | null
          status?: string | null
          triggered_by: string
          upc?: string | null
          vendor?: string | null
        }
        Update: {
          brand?: string | null
          entity_id?: string | null
          entity_type?: string
          id?: string
          prior_recon_run_id?: string | null
          processed_at?: string | null
          queued_at?: string | null
          status?: string | null
          triggered_by?: string
          upc?: string | null
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recon_stale_queue_prior_recon_run_id_fkey"
            columns: ["prior_recon_run_id"]
            isOneToOne: false
            referencedRelation: "reconciliation_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciliation_discrepancies: {
        Row: {
          amount_at_risk: number | null
          brand: string | null
          created_at: string | null
          discrepancy_type: string
          id: string
          invoice_date: string | null
          invoice_id: string | null
          invoice_number: string | null
          invoiced_line_total: number | null
          invoiced_qty: number | null
          invoiced_unit_price: number | null
          model_number: string | null
          ordered_line_total: number | null
          ordered_qty: number | null
          ordered_unit_price: number | null
          po_number: string | null
          price_delta: number | null
          qty_delta: number | null
          received_qty: number | null
          resolution_notes: string | null
          resolution_status: string | null
          resolved_at: string | null
          resolved_by: string | null
          run_id: string | null
          severity: string | null
          sku: string | null
          upc: string | null
          vendor: string | null
        }
        Insert: {
          amount_at_risk?: number | null
          brand?: string | null
          created_at?: string | null
          discrepancy_type: string
          id?: string
          invoice_date?: string | null
          invoice_id?: string | null
          invoice_number?: string | null
          invoiced_line_total?: number | null
          invoiced_qty?: number | null
          invoiced_unit_price?: number | null
          model_number?: string | null
          ordered_line_total?: number | null
          ordered_qty?: number | null
          ordered_unit_price?: number | null
          po_number?: string | null
          price_delta?: number | null
          qty_delta?: number | null
          received_qty?: number | null
          resolution_notes?: string | null
          resolution_status?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          run_id?: string | null
          severity?: string | null
          sku?: string | null
          upc?: string | null
          vendor?: string | null
        }
        Update: {
          amount_at_risk?: number | null
          brand?: string | null
          created_at?: string | null
          discrepancy_type?: string
          id?: string
          invoice_date?: string | null
          invoice_id?: string | null
          invoice_number?: string | null
          invoiced_line_total?: number | null
          invoiced_qty?: number | null
          invoiced_unit_price?: number | null
          model_number?: string | null
          ordered_line_total?: number | null
          ordered_qty?: number | null
          ordered_unit_price?: number | null
          po_number?: string | null
          price_delta?: number | null
          qty_delta?: number | null
          received_qty?: number | null
          resolution_notes?: string | null
          resolution_status?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          run_id?: string | null
          severity?: string | null
          sku?: string | null
          upc?: string | null
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_discrepancies_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "vendor_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_discrepancies_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "reconciliation_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciliation_runs: {
        Row: {
          id: string
          notes: string | null
          run_at: string | null
          run_by: string | null
          run_type: string | null
          scope_description: string | null
          status: string | null
          total_amount_at_risk: number | null
          total_discrepancies: number | null
          total_invoices_checked: number | null
          total_po_lines_checked: number | null
        }
        Insert: {
          id?: string
          notes?: string | null
          run_at?: string | null
          run_by?: string | null
          run_type?: string | null
          scope_description?: string | null
          status?: string | null
          total_amount_at_risk?: number | null
          total_discrepancies?: number | null
          total_invoices_checked?: number | null
          total_po_lines_checked?: number | null
        }
        Update: {
          id?: string
          notes?: string | null
          run_at?: string | null
          run_by?: string | null
          run_type?: string | null
          scope_description?: string | null
          status?: string | null
          total_amount_at_risk?: number | null
          total_discrepancies?: number | null
          total_invoices_checked?: number | null
          total_po_lines_checked?: number | null
        }
        Relationships: []
      }
      vendor_alias_map: {
        Row: {
          aliases: string[]
          created_at: string
          id: string
          vendor_id: string
          vendor_name: string
          vendor_type: string
        }
        Insert: {
          aliases?: string[]
          created_at?: string
          id?: string
          vendor_id: string
          vendor_name: string
          vendor_type?: string
        }
        Update: {
          aliases?: string[]
          created_at?: string
          id?: string
          vendor_id?: string
          vendor_name?: string
          vendor_type?: string
        }
        Relationships: []
      }
      vendor_invoices: {
        Row: {
          account_number: string | null
          carrier: string | null
          created_at: string
          credit_due: number | null
          currency: string
          doc_type: string
          entered_after_recon: boolean | null
          filename: string | null
          final_bill_amount: number | null
          freight: number | null
          has_discrepancy: boolean | null
          id: string
          import_source: string | null
          imported_at: string
          imported_by: string | null
          invoice_date: string
          invoice_number: string
          invoice_received_at: string | null
          is_multi_shipment: boolean
          last_reconciled_at: string | null
          last_shipment_date: string | null
          last_shipment_file: string | null
          lightspeed_po_number: string | null
          line_items: Json
          linked_proforma_id: string | null
          match_confidence: string | null
          match_notes: string | null
          match_status: string
          matched_session_ids: string[] | null
          notes: string | null
          payment_terms: string | null
          payment_terms_extracted: Json | null
          payment_terms_source: string | null
          po_number: string | null
          po_total_invoiced: number | null
          proforma_superseded_by: string | null
          received_date: string | null
          recon_notes: string | null
          recon_run_id: string | null
          recon_stale: boolean | null
          recon_stale_reason: string | null
          recon_status: string | null
          reconciled_at: string | null
          reconciled_session_id: string | null
          reconciliation_status: string | null
          ship_to: string | null
          shipment_count: number
          shipping_terms: string | null
          status: string
          subtotal: number | null
          tags: string[] | null
          tax: number | null
          terms_confidence: string | null
          terms_status: string
          total: number
          vendor: string
          vendor_brands: string[] | null
        }
        Insert: {
          account_number?: string | null
          carrier?: string | null
          created_at?: string
          credit_due?: number | null
          currency?: string
          doc_type?: string
          entered_after_recon?: boolean | null
          filename?: string | null
          final_bill_amount?: number | null
          freight?: number | null
          has_discrepancy?: boolean | null
          id?: string
          import_source?: string | null
          imported_at?: string
          imported_by?: string | null
          invoice_date: string
          invoice_number: string
          invoice_received_at?: string | null
          is_multi_shipment?: boolean
          last_reconciled_at?: string | null
          last_shipment_date?: string | null
          last_shipment_file?: string | null
          lightspeed_po_number?: string | null
          line_items?: Json
          linked_proforma_id?: string | null
          match_confidence?: string | null
          match_notes?: string | null
          match_status?: string
          matched_session_ids?: string[] | null
          notes?: string | null
          payment_terms?: string | null
          payment_terms_extracted?: Json | null
          payment_terms_source?: string | null
          po_number?: string | null
          po_total_invoiced?: number | null
          proforma_superseded_by?: string | null
          received_date?: string | null
          recon_notes?: string | null
          recon_run_id?: string | null
          recon_stale?: boolean | null
          recon_stale_reason?: string | null
          recon_status?: string | null
          reconciled_at?: string | null
          reconciled_session_id?: string | null
          reconciliation_status?: string | null
          ship_to?: string | null
          shipment_count?: number
          shipping_terms?: string | null
          status?: string
          subtotal?: number | null
          tags?: string[] | null
          tax?: number | null
          terms_confidence?: string | null
          terms_status?: string
          total?: number
          vendor: string
          vendor_brands?: string[] | null
        }
        Update: {
          account_number?: string | null
          carrier?: string | null
          created_at?: string
          credit_due?: number | null
          currency?: string
          doc_type?: string
          entered_after_recon?: boolean | null
          filename?: string | null
          final_bill_amount?: number | null
          freight?: number | null
          has_discrepancy?: boolean | null
          id?: string
          import_source?: string | null
          imported_at?: string
          imported_by?: string | null
          invoice_date?: string
          invoice_number?: string
          invoice_received_at?: string | null
          is_multi_shipment?: boolean
          last_reconciled_at?: string | null
          last_shipment_date?: string | null
          last_shipment_file?: string | null
          lightspeed_po_number?: string | null
          line_items?: Json
          linked_proforma_id?: string | null
          match_confidence?: string | null
          match_notes?: string | null
          match_status?: string
          matched_session_ids?: string[] | null
          notes?: string | null
          payment_terms?: string | null
          payment_terms_extracted?: Json | null
          payment_terms_source?: string | null
          po_number?: string | null
          po_total_invoiced?: number | null
          proforma_superseded_by?: string | null
          received_date?: string | null
          recon_notes?: string | null
          recon_run_id?: string | null
          recon_stale?: boolean | null
          recon_stale_reason?: string | null
          recon_status?: string | null
          reconciled_at?: string | null
          reconciled_session_id?: string | null
          reconciliation_status?: string | null
          ship_to?: string | null
          shipment_count?: number
          shipping_terms?: string | null
          status?: string
          subtotal?: number | null
          tags?: string[] | null
          tax?: number | null
          terms_confidence?: string | null
          terms_status?: string
          total?: number
          vendor?: string
          vendor_brands?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "vendor_invoices_linked_proforma_id_fkey"
            columns: ["linked_proforma_id"]
            isOneToOne: false
            referencedRelation: "vendor_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_invoices_proforma_superseded_by_fkey"
            columns: ["proforma_superseded_by"]
            isOneToOne: false
            referencedRelation: "vendor_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_invoices_reconciled_session_id_fkey"
            columns: ["reconciled_session_id"]
            isOneToOne: false
            referencedRelation: "po_receiving_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_invoice_stats: {
        Args: {
          p_date_from?: string
          p_date_to?: string
          p_doc_type?: string
          p_max_total?: number
          p_min_total?: number
          p_search?: string
          p_status?: string
          p_tag?: string
          p_vendor?: string
        }
        Returns: Json
      }
      get_server_date: { Args: never; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
