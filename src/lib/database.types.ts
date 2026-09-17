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
      appointments: {
        Row: {
          booked_by: string
          client_request_id: string
          created_at: string
          ends_at: string
          google_event_id: string | null
          id: string
          lead_id: string
          note: string | null
          starts_at: string
          status: Database["public"]["Enums"]["appointment_status"]
        }
        Insert: {
          booked_by: string
          client_request_id: string
          created_at?: string
          ends_at: string
          google_event_id?: string | null
          id?: string
          lead_id: string
          note?: string | null
          starts_at: string
          status?: Database["public"]["Enums"]["appointment_status"]
        }
        Update: {
          booked_by?: string
          client_request_id?: string
          created_at?: string
          ends_at?: string
          google_event_id?: string | null
          id?: string
          lead_id?: string
          note?: string | null
          starts_at?: string
          status?: Database["public"]["Enums"]["appointment_status"]
        }
        Relationships: [
          {
            foreignKeyName: "appointments_booked_by_fkey"
            columns: ["booked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_connection: {
        Row: {
          bookable_calendar_id: string | null
          broken_at: string | null
          connected_at: string
          connected_by: string
          google_email: string
          id: boolean
          refresh_token_ciphertext: string
        }
        Insert: {
          bookable_calendar_id?: string | null
          broken_at?: string | null
          connected_at?: string
          connected_by: string
          google_email: string
          id?: boolean
          refresh_token_ciphertext: string
        }
        Update: {
          bookable_calendar_id?: string | null
          broken_at?: string | null
          connected_at?: string
          connected_by?: string
          google_email?: string
          id?: boolean
          refresh_token_ciphertext?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_connection_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
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
      lead_skips: {
        Row: {
          created_at: string
          id: string
          lead_id: string
          note: string | null
          reason: string | null
          resolution: string | null
          resolved_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          lead_id: string
          note?: string | null
          reason?: string | null
          resolution?: string | null
          resolved_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          lead_id?: string
          note?: string | null
          reason?: string | null
          resolution?: string | null
          resolved_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_skips_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_skips_user_id_fkey"
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
          business_type: Database["public"]["Enums"]["business_type"] | null
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
          business_type?: Database["public"]["Enums"]["business_type"] | null
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
          business_type?: Database["public"]["Enums"]["business_type"] | null
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
          deleted_at: string | null
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
          deleted_at?: string | null
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
          deleted_at?: string | null
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
      abandon_appointment: {
        Args: {
          p_id: string
        }
        Returns: undefined
      }
      admin_agent_activity: {
        Args: {
          p_from: string
          p_to: string
          p_user_id: string
        }
        Returns: Json
      }
      admin_agent_delete_check: {
        Args: {
          p_user_id: string
        }
        Returns: Json
      }
      admin_agent_rows: {
        Args: never
        Returns: {
          active: boolean
          appointments_today: number
          assigned_numbers: string[]
          connected_today: number
          daily_call_target: number
          deleted: boolean
          dials_today: number
          email: string
          in_app_calling_enabled: boolean
          interested_today: number
          leads_assigned: number
          name: string
          role: Database["public"]["Enums"]["user_role"]
          talk_seconds_today: number
          timezone: string
          user_id: string
        }[]
      }
      admin_delete_agent: {
        Args: {
          p_user_id: string
        }
        Returns: Json
      }
      admin_phone_number_rows: {
        Args: never
        Returns: {
          active: boolean
          assigned_active: boolean
          assigned_name: string
          assigned_to: string
          calls_today: number
          created_at: string
          e164: string
          id: string
          label: string
          last_used_at: string
          twilio_sid: string
        }[]
      }
      admin_report_agents: {
        Args: {
          p_from: string
          p_to: string
        }
        Returns: {
          active: boolean
          appointments: number
          avg_call_seconds: number
          clients: number
          connect_rate: number
          connected: number
          dials: number
          interested: number
          name: string
          talk_seconds: number
          user_id: string
        }[]
      }
      admin_report_numbers: {
        Args: {
          p_from: string
          p_to: string
        }
        Returns: {
          active: boolean
          answer_rate: number
          answered: number
          dials: number
          e164: string
          label: string
          phone_number_id: string
        }[]
      }
      admin_report_totals: {
        Args: {
          p_from: string
          p_to: string
        }
        Returns: Json
      }
      admin_team_totals: {
        Args: never
        Returns: Json
      }
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
      begin_appointment: {
        Args: {
          p_client_request_id?: string
          p_lead_id: string
          p_note?: string
          p_starts_at: string
        }
        Returns: Database["public"]["Tables"]["appointments"]["Row"]
        SetofOptions: {
          from: "*"
          to: "appointments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      booked_intervals: {
        Args: {
          p_from: string
          p_to: string
        }
        Returns: {
          ends_at: string
          starts_at: string
        }[]
      }
      bulk_assign_leads: {
        Args: {
          p_expected_assigned_to?: string
          p_lead_ids: string[]
          p_match_expected?: boolean
          p_to_user_id: string
        }
        Returns: {
          lead_id: string
          previous_assigned_to: string
          result: string
        }[]
      }
      bulk_complete_follow_ups: {
        Args: {
          p_lead_ids: string[]
        }
        Returns: number
      }
      bulk_delete_leads: {
        Args: {
          p_lead_ids: string[]
        }
        Returns: number
      }
      bulk_schedule_follow_ups: {
        Args: {
          p_due_at: string
          p_lead_ids: string[]
          p_note?: string
          p_set_note?: boolean
        }
        Returns: {
          follow_up_id: string
          lead_id: string
          result: string
        }[]
      }
      bulk_set_business_type: {
        Args: {
          p_lead_ids: string[]
          p_type?: Database["public"]["Enums"]["business_type"]
        }
        Returns: number
      }
      bulk_set_lead_source: {
        Args: {
          p_lead_ids: string[]
          p_source: string
        }
        Returns: number
      }
      bulk_set_lead_status: {
        Args: {
          p_expected_status?: Database["public"]["Enums"]["lead_status"]
          p_lead_ids: string[]
          p_status: Database["public"]["Enums"]["lead_status"]
        }
        Returns: {
          lead_id: string
          previous_status: Database["public"]["Enums"]["lead_status"]
          result: string
        }[]
      }
      can_access_lead: {
        Args: {
          p_lead_id: string
        }
        Returns: boolean
      }
      cancel_appointment: {
        Args: {
          p_id: string
        }
        Returns: undefined
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
      confirm_appointment: {
        Args: {
          p_google_event_id: string
          p_id: string
        }
        Returns: Database["public"]["Tables"]["appointments"]["Row"]
        SetofOptions: {
          from: "*"
          to: "appointments"
          isOneToOne: true
          isSetofReturn: false
        }
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
      export_leads: {
        Args: {
          p_after_created_at?: string
          p_after_id?: string
          p_assigned_to?: string
          p_limit?: number
          p_query?: string
          p_source?: string
          p_statuses?: Database["public"]["Enums"]["lead_status"][]
          p_unassigned?: boolean
        }
        Returns: {
          address: string
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
          notes: string
          phone: string
          state: string
          status: Database["public"]["Enums"]["lead_status"]
          website: string
        }[]
      }
      export_selected_leads: {
        Args: {
          p_after_created_at?: string
          p_after_id?: string
          p_lead_ids: string[]
          p_limit?: number
        }
        Returns: {
          address: string
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
          notes: string
          phone: string
          state: string
          status: Database["public"]["Enums"]["lead_status"]
          website: string
        }[]
      }
      find_duplicate_leads: {
        Args: {
          p_domains: string[]
          p_name_keys: string[]
          p_phones: string[]
        }
        Returns: {
          business_name: string
          city: string
          dedupe_name_key: string
          lead_id: string
          phone: string
          website_domain: string
        }[]
      }
      follow_up_tab_counts: {
        Args: never
        Returns: Json
      }
      get_calendar_status: {
        Args: never
        Returns: {
          bookable_calendar_set: boolean
          broken: boolean
          connected: boolean
          google_email: string
        }[]
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
      get_my_call_days: {
        Args: never
        Returns: {
          day: string
          dials: number
        }[]
      }
      get_my_dashboard: {
        Args: never
        Returns: Json
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
      list_follow_ups: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_tab: string
        }
        Returns: {
          business_name: string
          completed_at: string
          contact_name: string
          due_at: string
          follow_up_id: string
          lead_id: string
          lead_status: Database["public"]["Enums"]["lead_status"]
          note: string
          owner_name: string
          phone: string
          total_count: number
        }[]
      }
      list_lead_sources: {
        Args: never
        Returns: string[]
      }
      list_skipped_leads: {
        Args: {
          p_limit?: number
          p_offset?: number
        }
        Returns: {
          assigned_to: string
          business_name: string
          contact_name: string
          lead_id: string
          lead_status: Database["public"]["Enums"]["lead_status"]
          next_follow_up_at: string
          note: string
          owner_name: string
          phone: string
          reason: string
          skip_id: string
          skipped_at: string
          total_count: number
        }[]
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
      my_caller_id_available: {
        Args: never
        Returns: boolean
      }
      outcome_to_status: {
        Args: {
          p_current: Database["public"]["Enums"]["lead_status"]
          p_outcome: Database["public"]["Enums"]["call_outcome"]
        }
        Returns: Database["public"]["Enums"]["lead_status"]
      }
      pipeline_column: {
        Args: {
          p_assigned_to?: string
          p_limit?: number
          p_offset?: number
          p_statuses: Database["public"]["Enums"]["lead_status"][]
          p_unassigned?: boolean
        }
        Returns: {
          assigned_to: string
          business_name: string
          call_count: number
          contact_name: string
          id: string
          next_follow_up_at: string
          phone: string
          status: Database["public"]["Enums"]["lead_status"]
          total_count: number
          updated_at: string
        }[]
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
      resume_skipped_lead: {
        Args: {
          p_lead_id: string
        }
        Returns: number
      }
      revoke_user_sessions: {
        Args: {
          p_user_id: string
        }
        Returns: number
      }
      search_lead_ids: {
        Args: {
          p_assigned_to?: string
          p_limit?: number
          p_query?: string
          p_source?: string
          p_statuses?: Database["public"]["Enums"]["lead_status"][]
          p_unassigned?: boolean
        }
        Returns: {
          id: string
          total_count: number
        }[]
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
      set_lead_business_type: {
        Args: {
          p_lead_id: string
          p_type?: Database["public"]["Enums"]["business_type"]
        }
        Returns: undefined
      }
      skip_lead: {
        Args: {
          p_lead_id: string
          p_note?: string
          p_reason?: string
        }
        Returns: string
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
      appointment_status: "pending" | "scheduled" | "cancelled"
      business_type: "restaurant" | "cafe_bakery" | "hotel_motel" | "home_services" | "auto" | "retail" | "beauty" | "other"
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
      appointment_status: ["pending", "scheduled", "cancelled"],
      business_type: ["restaurant", "cafe_bakery", "hotel_motel", "home_services", "auto", "retail", "beauty", "other"],
      call_direction: ["OUTBOUND", "INBOUND"],
      call_mode: ["IN_APP", "TEL"],
      call_outcome: ["NO_ANSWER", "VOICEMAIL", "CONNECTED", "INTERESTED", "FOLLOW_UP", "APPOINTMENT", "NOT_INTERESTED", "WRONG_NUMBER"],
      lead_status: ["NEW", "TO_CALL", "NO_ANSWER", "VOICEMAIL", "CONNECTED", "INTERESTED", "FOLLOW_UP", "APPOINTMENT", "PROPOSAL", "CLIENT", "NOT_INTERESTED", "DO_NOT_CONTACT"],
      user_role: ["ADMIN", "AGENT"],
    },
  },
} as const
