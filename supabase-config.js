/* Convertly public Supabase configuration.
   The publishable/anon key is intended for browser use.
   NEVER put a service_role/secret key in this file. */
window.CONVERTLY_SUPABASE_URL = 'https://imkmmjsrqqgudzhytpfi.supabase.co';
window.CONVERTLY_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ilAKpJebF0ih1H0rq5dJ7A_OGjJXIU-';

if (window.supabase?.createClient) {
  window.convertlySupabase = window.supabase.createClient(
    window.CONVERTLY_SUPABASE_URL,
    window.CONVERTLY_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
  );
}
