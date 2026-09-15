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
    PostgrestVersion: "12"
  }
  public: {
    Tables: {
      calls: {
        Row: {
          call_status: string | null
          client_request_id: string | null
          created_at: string
          direction: Database["public"]["Enums"]["call_direction"]
          duration_seconds: number | null
          handled_at: string | null
          id: string
          lead_id: string | null
          mode: Database["public"]["Enums"]["call_mode"]
          notes: string | null
          outcome: Database["public"]["Enums"]["call_outcome"] | null
          phone_number_id: string | null
          provider_call_sid: string | null
          remote_e164: string | null
          user_id: string | null
          voicemail_duration_seconds: number | null
          voicemail_recording_sid: string | null
        }
        Insert: {
          call_status?: string | null
          client_request_id?: string | null
          created_at?: string
          direction: Database["public"]["Enums"]["call_direction"]
          duration_seconds?: number | null
          handled_at?: string | null
          id?: string
          lead_id?: string | null
          mode: Database["public"]["Enums"]["call_mode"]
          notes?: string | null
          outcome?: Database["public"]["Enums"]["call_outcome"] | null
          phone_number_id?: string | null
          provider_call_sid?: string | null
          remote_e164?: string | null
          user_id?: string | null
          voicemail_duration_seconds?: number | null
          voicemail_recording_sid?: string | null
        }
        Update: {
          call_status?: string | null
          client_request_id?: string | null
          created_at?: string
          direction?: Database["public"]["Enums"]["call_direction"]
          duration_seconds?: number | null
          handled_at?: string | null
          id?: string
          lead_id?: string | null
          mode?: Database["public"]["Enums"]["call_mode"]
          notes?: string | null
          outcome?: Database["public"]["Enums"]["call_outcome"] | null
          phone_number_id?: string | null
          provider_call_sid?: string | null
          remote_e164?: string | null
          user_id?: string | null
          voicemail_duration_seconds?: number | null
          voicemail_recording_sid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "calls_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      follow_ups: {
        Row: {
          completed_at: string | null
          created_at: string
          due_at: string
          id: string
          lead_id: string
          note: string | null
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          due_at: string
          id?: string
          lead_id: string
          note?: string | null
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          due_at?: string
          id?: string
          lead_id?: string
          note?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "follow_ups_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          address: string | null
          assigned_to: string | null
          business_name: string
          call_count: number
          city: string | null
          contact_name: string | null
          country: string | null
          created_at: string
          dedupe_name_key: string | null
          email: string | null
          id: string
          last_contacted_at: string | null
          next_follow_up_at: string | null
          notes: string | null
          phone: string
          phone_raw: string | null
          source: string | null
          state: string | null
          status: Database["public"]["Enums"]["lead_status"]
          updated_at: string
          website: string | null
          website_domain: string | null
        }
        Insert: {
          address?: string | null
          assigned_to?: string | null
          business_name: string
          call_count?: number
          city?: string | null
          contact_name?: string | null
          country?: string | null
          created_at?: string
          dedupe_name_key?: never
          email?: string | null
          id?: string
          last_contacted_at?: string | null
          next_follow_up_at?: string | null
          notes?: string | null
          phone: string
          phone_raw?: string | null
          source?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["lead_status"]
          updated_at?: string
          website?: string | null
          website_domain?: string | null
        }
        Update: {
          address?: string | null
          assigned_to?: string | null
          business_name?: string
          call_count?: number
          city?: string | null
          contact_name?: string | null
          country?: string | null
          created_at?: string
          dedupe_name_key?: never
          email?: string | null
          id?: string
          last_contacted_at?: string | null
          next_follow_up_at?: string | null
          notes?: string | null
          phone?: string
          phone_raw?: string | null
          source?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["lead_status"]
          updated_at?: string
          website?: string | null
          website_domain?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      phone_numbers: {
        Row: {
          active: boolean
          assigned_to: string | null
          created_at: string
          e164: string
          id: string
          label: string | null
          last_used_at: string | null
          twilio_sid: string
        }
        Insert: {
          active?: boolean
          assigned_to?: string | null
          created_at?: string
          e164: string
          id?: string
          label?: string | null
          last_used_at?: string | null
          twilio_sid: string
        }
        Update: {
          active?: boolean
          assigned_to?: string | null
          created_at?: string
          e164?: string
          id?: string
          label?: string | null
          last_used_at?: string | null
          twilio_sid?: string
        }
        Relationships: [
          {
            foreignKeyName: "phone_numbers_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean
          created_at: string
          daily_call_target: number
          device_seen_at: string | null
          email: string
          id: string
          in_app_calling_enabled: boolean
          name: string
          role: Database["public"]["Enums"]["user_role"]
          timezone: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          daily_call_target?: number
          device_seen_at?: string | null
          email: string
          id: string
          in_app_calling_enabled?: boolean
          name?: string
          role?: Database["public"]["Enums"]["user_role"]
          timezone?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          daily_call_target?: number
          device_seen_at?: string | null
          email?: string
          id?: string
          in_app_calling_enabled?: boolean
          name?: string
          role?: Database["public"]["Enums"]["user_role"]
          timezone?: string
        }
        Relationships: []
      }
      rate_limit_hits: {
        Row: {
          bucket: string
          created_at: string
          id: number
          user_id: string
        }
        Insert: {
          bucket: string
          created_at?: string
          id?: never
          user_id: string
        }
        Update: {
          bucket?: string
          created_at?: string
          id?: never
          user_id?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          company_name: string
          default_daily_target: number
          default_timezone: string
          id: boolean
          updated_at: string
          voicemail_greeting: string
        }
        Insert: {
          company_name?: string
          default_daily_target?: number
          default_timezone?: string
          id?: boolean
          updated_at?: string
          voicemail_greeting?: string
        }
        Update: {
          company_name?: string
          default_daily_target?: number
          default_timezone?: string
          id?: boolean
          updated_at?: string
          voicemail_greeting?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_call_status: {
        Args: {
          p_call_sid: string
          p_duration?: number
          p_status: string
        }
        Returns: boolean
      }
      apply_rate_limit: {
        Args: {
          p_bucket: string
          p_user_id: string
        }
        Returns: boolean
      }
      can_access_lead: {
        Args: {
          p_lead_id: string
        }
        Returns: boolean
      }
      claim_caller_id: {
        Args: {
          p_user_id: string
        }
        Returns: {
          e164: string
          phone_number_id: string
        }[]
      }
      consume_rate_limit: {
        Args: {
          p_bucket: string
        }
        Returns: boolean
      }
      create_outbound_call: {
        Args: {
          p_lead_id: string
        }
        Returns: string
      }
      get_company_name: {
        Args: never
        Returns: string
      }
      get_lead_call_history: {
        Args: {
          p_lead_id: string
        }
        Returns: {
          call_status: string
          caller_id_e164: string
          caller_name: string
          created_at: string
          direction: Database["public"]["Enums"]["call_direction"]
          duration_seconds: number
          handled_at: string
          has_voicemail: boolean
          id: string
          is_mine: boolean
          mode: Database["public"]["Enums"]["call_mode"]
          notes: string
          outcome: Database["public"]["Enums"]["call_outcome"]
          voicemail_duration_seconds: number
        }[]
      }
      get_next_lead: {
        Args: {
          p_exclude_ids?: string[]
        }
        Returns: {
          business_name: string
          call_count: number
          city: string
          contact_name: string
          last_contacted_at: string
          lead_id: string
          next_follow_up_at: string
          phone: string
          reason: string
          state: string
          status: Database["public"]["Enums"]["lead_status"]
        }[]
      }
      get_voicemail_recording: {
        Args: {
          p_call_id: string
          p_user_id: string
        }
        Returns: string
      }
      is_active_user: {
        Args: never
        Returns: boolean
      }
      is_admin: {
        Args: never
        Returns: boolean
      }
      is_privileged_role: {
        Args: never
        Returns: boolean
      }
      lead_earliest_open_follow_up: {
        Args: {
          p_lead_id: string
        }
        Returns: string
      }
      list_lead_sources: {
        Args: never
        Returns: string[]
      }
      list_voicemails: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_unheard_only?: boolean
        }
        Returns: {
          business_name: string
          call_id: string
          contact_name: string
          created_at: string
          handled_at: string
          lead_id: string
          lead_status: Database["public"]["Enums"]["lead_status"]
          phone: string
          total_count: number
          voicemail_duration_seconds: number
        }[]
      }
      log_call: {
        Args: {
          p_call_id?: string
          p_duration_seconds?: number
          p_follow_up_at?: string
          p_follow_up_note?: string
          p_lead_id?: string
          p_notes?: string
          p_outcome: Database["public"]["Enums"]["call_outcome"]
        }
        Returns: Json
      }
      mark_voicemail_heard: {
        Args: {
          p_call_id: string
        }
        Returns: boolean
      }
      outcome_to_status: {
        Args: {
          p_current: Database["public"]["Enums"]["lead_status"]
          p_outcome: Database["public"]["Enums"]["call_outcome"]
        }
        Returns: Database["public"]["Enums"]["lead_status"]
      }
      reassign_leads: {
        Args: {
          p_lead_ids: string[]
          p_to_user_id: string
        }
        Returns: number
      }
      record_voicemail: {
        Args: {
          p_call_sid: string
          p_duration: number
          p_recording_sid: string
        }
        Returns: boolean
      }
      search_leads: {
        Args: {
          p_assigned_to?: string
          p_dir?: string
          p_limit?: number
          p_offset?: number
          p_query?: string
          p_sort?: string
          p_source?: string
          p_statuses?: Database["public"]["Enums"]["lead_status"][]
          p_unassigned?: boolean
        }
        Returns: {
          assigned_to: string
          business_name: string
          call_count: number
          city: string
          contact_name: string
          country: string
          created_at: string
          email: string
          id: string
          last_contacted_at: string
          next_follow_up_at: string
          phone: string
          source: string
          state: string
          status: Database["public"]["Enums"]["lead_status"]
          total_count: number
          website: string
        }[]
      }
      touch_device_presence: {
        Args: never
        Returns: undefined
      }
      unheard_voicemail_count: {
        Args: never
        Returns: number
      }
    }
    Enums: {
      call_direction: "OUTBOUND" | "INBOUND"
      call_mode: "IN_APP" | "TEL"
      call_outcome: "NO_ANSWER" | "VOICEMAIL" | "CONNECTED" | "INTERESTED" | "FOLLOW_UP" | "APPOINTMENT" | "NOT_INTERESTED" | "WRONG_NUMBER"
      lead_status: "NEW" | "TO_CALL" | "NO_ANSWER" | "VOICEMAIL" | "CONNECTED" | "INTERESTED" | "FOLLOW_UP" | "APPOINTMENT" | "PROPOSAL" | "CLIENT" | "NOT_INTERESTED" | "DO_NOT_CONTACT"
      user_role: "ADMIN" | "AGENT"
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
    Enums: {
      call_direction: ["OUTBOUND", "INBOUND"],
      call_mode: ["IN_APP", "TEL"],
      call_outcome: ["NO_ANSWER", "VOICEMAIL", "CONNECTED", "INTERESTED", "FOLLOW_UP", "APPOINTMENT", "NOT_INTERESTED", "WRONG_NUMBER"],
      lead_status: ["NEW", "TO_CALL", "NO_ANSWER", "VOICEMAIL", "CONNECTED", "INTERESTED", "FOLLOW_UP", "APPOINTMENT", "PROPOSAL", "CLIENT", "NOT_INTERESTED", "DO_NOT_CONTACT"],
      user_role: ["ADMIN", "AGENT"],
    },
  },
} as const
