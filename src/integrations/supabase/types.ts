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
          item_description: string | null
          lightspeed_status: string | null
          manufact_sku: string | null
          match_status: string | null
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
          item_description?: string | null
          lightspeed_status?: string | null
          manufact_sku?: string | null
          match_status?: string | null
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
          item_description?: string | null
          lightspeed_status?: string | null
          manufact_sku?: string | null
          match_status?: string | null
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
          created_at: string
          fully_received: number | null
          id: string
          lightspeed_export_type: string | null
          not_received: number | null
          notes: string | null
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
          created_at?: string
          fully_received?: number | null
          id?: string
          lightspeed_export_type?: string | null
          not_received?: number | null
          notes?: string | null
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
          created_at?: string
          fully_received?: number | null
          id?: string
          lightspeed_export_type?: string | null
          not_received?: number | null
          notes?: string | null
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
            foreignKeyName: "po_receiving_sessions_reconciled_invoice_id_fkey"
            columns: ["reconciled_invoice_id"]
            isOneToOne: false
            referencedRelation: "vendor_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_invoices: {
        Row: {
          account_number: string | null
          carrier: string | null
          created_at: string
          currency: string
          doc_type: string
          filename: string | null
          freight: number | null
          id: string
          imported_at: string
          imported_by: string | null
          invoice_date: string
          invoice_number: string
          is_multi_shipment: boolean
          last_shipment_date: string | null
          last_shipment_file: string | null
          line_items: Json
          notes: string | null
          payment_terms: string | null
          po_number: string | null
          po_total_invoiced: number | null
          ship_to: string | null
          shipment_count: number
          status: string
          subtotal: number | null
          tags: string[] | null
          tax: number | null
          total: number
          vendor: string
          vendor_brands: string[] | null
        }
        Insert: {
          account_number?: string | null
          carrier?: string | null
          created_at?: string
          currency?: string
          doc_type?: string
          filename?: string | null
          freight?: number | null
          id?: string
          imported_at?: string
          imported_by?: string | null
          invoice_date: string
          invoice_number: string
          is_multi_shipment?: boolean
          last_shipment_date?: string | null
          last_shipment_file?: string | null
          line_items?: Json
          notes?: string | null
          payment_terms?: string | null
          po_number?: string | null
          po_total_invoiced?: number | null
          ship_to?: string | null
          shipment_count?: number
          status?: string
          subtotal?: number | null
          tags?: string[] | null
          tax?: number | null
          total?: number
          vendor: string
          vendor_brands?: string[] | null
        }
        Update: {
          account_number?: string | null
          carrier?: string | null
          created_at?: string
          currency?: string
          doc_type?: string
          filename?: string | null
          freight?: number | null
          id?: string
          imported_at?: string
          imported_by?: string | null
          invoice_date?: string
          invoice_number?: string
          is_multi_shipment?: boolean
          last_shipment_date?: string | null
          last_shipment_file?: string | null
          line_items?: Json
          notes?: string | null
          payment_terms?: string | null
          po_number?: string | null
          po_total_invoiced?: number | null
          ship_to?: string | null
          shipment_count?: number
          status?: string
          subtotal?: number | null
          tags?: string[] | null
          tax?: number | null
          total?: number
          vendor?: string
          vendor_brands?: string[] | null
        }
        Relationships: []
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
