/**
 * Environment loading for standalone scripts.
 *
 * `next dev` reads `.env.local` automatically, but a plain `tsx scripts/...`
 * process does not. Node 20.12+ ships `process.loadEnvFile`, so no dotenv
 * dependency is needed.
 *
 * Nothing in this file ever prints a secret value.
 */
import { existsSync } from "node:fs";
import path from "node:path";

let loaded = false;

export function loadLocalEnv(projectRoot: string = process.cwd()): void {
  if (loaded) return;

  // Later files win, matching Next.js' own precedence for local overrides.
  for (const file of [".env", ".env.local"]) {
    const fullPath = path.join(projectRoot, file);
    if (existsSync(fullPath)) process.loadEnvFile(fullPath);
  }

  loaded = true;
}

export interface SupabaseCredentials {
  readonly url: string;
  readonly serviceRoleKey: string;
}

/**
 * Read the Supabase credentials, failing with an actionable message rather
 * than a stack trace when they are absent.
 */
export function requireSupabaseCredentials(): SupabaseCredentials {
  loadLocalEnv();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  const missing: string[] = [];
  if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length > 0 || !url || !serviceRoleKey) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Add them to .env.local (see .env.example).",
    );
  }

  return { url, serviceRoleKey };
}
