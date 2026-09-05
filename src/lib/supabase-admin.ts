import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client using the service-role key.
 *
 * `server-only` makes importing this file from a Client Component a build
 * error, which is the guardrail that keeps the service-role credential out of
 * the browser bundle. Every database read in this application goes through a
 * Route Handler or a Server Component, never through the client.
 *
 * The client is created lazily so that a missing environment variable surfaces
 * as a handled error on the request that needs it, rather than crashing the
 * whole build at module-evaluation time.
 */

let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  const missing: string[] = [];
  if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !serviceRoleKey) {
    throw new Error(
      `Supabase is not configured. Missing: ${missing.join(", ")}. ` +
        "Add the values to .env.local (see .env.example).",
    );
  }

  client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return client;
}

/** Whether the credentials are present, without attempting a connection. */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
      process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}
