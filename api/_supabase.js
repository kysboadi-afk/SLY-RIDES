// api/_supabase.js
// Server-side Supabase client factory.
// Uses the SERVICE_ROLE key — only import this in Vercel serverless functions,
// never in client-side code.

import { createClient } from "@supabase/supabase-js";

/**
 * Returns a fresh Supabase admin client (service role) on every call.
 * Stateless — no singleton caching — so Vercel serverless functions always
 * get a clean connection and are not affected by stale module-level state.
 * Returns null when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set,
 * so callers can gracefully fall back to default values.
 */
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error("❌ Supabase env vars missing");
    return null;
  }

  try {
    const client = createClient(url, key, {
      auth: {
        persistSession: false,
      },
    });

    return client;
  } catch (err) {
    console.error("❌ Supabase client init failed:", err);
    return null;
  }
}
