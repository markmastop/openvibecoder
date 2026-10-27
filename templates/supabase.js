import { createClient } from '@supabase/supabase-js';

let client;
export function isSupabaseConfigured() {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
}
export function getSupabase() {
  if (!isSupabaseConfigured()) throw new Error("Configure Supabase in Connections in Open Vibe Coder first.");
  client ??= createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
  return client;
}
