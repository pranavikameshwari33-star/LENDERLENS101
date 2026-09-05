/**
 * Report the state of the Supabase database: which migrations have landed,
 * whether the service role can actually read each table, how many rows are
 * present, and when the data was last imported.
 *
 *   npm run db:status
 *
 * Supabase's REST endpoint cannot execute DDL, so migrations are applied by
 * hand in the SQL Editor. This script exists so that "did the migration run?"
 * is a question with a one-command answer instead of a guess.
 *
 * It never prints a credential.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseCredentials } from "./lib/script-env.ts";
import { DATASETS, REFERENCE_SHEET } from "../src/lib/rbi/dataset.ts";

const MIGRATIONS = [
  "0001_baseline_schema",
  "0002_verification_schema",
  "0003_lenderlens_schema",
] as const;

/** Columns introduced by 0002 that prove the migration actually ran. */
const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  registered_nbfc: ["name_core", "cin_normalized", "email_domains", "alternate_names", "source_file"],
  registered_arc: ["name_core", "cin_normalized", "email_domains", "source_file"],
  cancelled_company: ["name_core", "source_file"],
  cancelled_record: ["section", "company_name_core", "source_file"],
  rbi_bank: ["slug", "category", "hostnames", "websites", "source_file"],
};

const RPC_FUNCTIONS = [
  "search_registered_nbfc_by_name",
  "search_registered_arc_by_name",
  "search_cancelled_company_by_name",
  "search_cancelled_record_by_name",
  "search_rbi_bank_by_name",
] as const;

interface TableStatus {
  readonly table: string;
  readonly reachable: boolean;
  readonly rowCount: number | null;
  readonly missingColumns: readonly string[];
  readonly problem: string | null;
  readonly datasetAsOf: string | null;
}

async function checkTable(
  client: SupabaseClient,
  table: string,
  requiredColumns: readonly string[],
): Promise<TableStatus> {
  const { data, error, count } = await client
    .from(table)
    .select("*", { count: "exact" })
    .limit(1);

  if (error) {
    return {
      table,
      reachable: false,
      rowCount: null,
      missingColumns: requiredColumns,
      datasetAsOf: null,
      problem:
        error.code === "42501"
          ? "permission denied — run migration 0002 (it grants access to service_role)"
          : error.code === "PGRST205"
            ? "table does not exist — run migration 0001"
            : `${error.code ?? "error"}: ${error.message}`,
    };
  }

  const sample = data?.[0];
  const presentColumns = sample ? new Set(Object.keys(sample)) : null;
  const missingColumns = presentColumns
    ? requiredColumns.filter((column) => !presentColumns.has(column))
    : [];

  const asOf =
    sample && typeof sample.dataset_as_of === "string" ? sample.dataset_as_of : null;

  return {
    table,
    reachable: true,
    rowCount: count ?? 0,
    missingColumns,
    datasetAsOf: asOf,
    problem:
      (count ?? 0) === 0
        ? "empty — run `npm run import:rbi`"
        : missingColumns.length > 0
          ? "missing columns from migration 0002"
          : null,
  };
}

async function checkRpc(client: SupabaseClient, name: string): Promise<string | null> {
  const { error } = await client.rpc(name, {
    query_normalized: "ZZZ NONEXISTENT ZZZ",
    query_core: "ZZZ NONEXISTENT ZZZ",
    min_similarity: 0.9,
    max_results: 1,
  });
  if (!error) return null;
  if (error.code === "PGRST202") return "not defined — run migration 0002";
  return `${error.code ?? "error"}: ${error.message}`;
}

async function checkMigrations(client: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await client.from("schema_migrations").select("version");
  if (error || !data) return new Set();
  return new Set(
    data
      .map((row) => (typeof row.version === "string" ? row.version : null))
      .filter((version): version is string => version !== null),
  );
}

function symbol(ok: boolean): string {
  return ok ? "OK  " : "FAIL";
}

async function main(): Promise<void> {
  const { url, serviceRoleKey } = requireSupabaseCredentials();
  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log("LenderLens :: database status");
  console.log(`  project: ${new URL(url).host}`);
  console.log("");

  const applied = await checkMigrations(client);
  console.log("Migrations");
  for (const migration of MIGRATIONS) {
    const ok = applied.has(migration);
    console.log(`  ${symbol(ok)}  ${migration}${ok ? "" : "  <- not recorded as applied"}`);
  }

  console.log("\nTables");
  const statuses: TableStatus[] = [];
  for (const dataset of DATASETS) {
    const status = await checkTable(
      client,
      dataset.table,
      REQUIRED_COLUMNS[dataset.table] ?? [],
    );
    statuses.push(status);

    const ok = status.reachable && status.problem === null;
    const count = status.rowCount === null ? "?" : status.rowCount.toLocaleString("en-IN");
    console.log(`  ${symbol(ok)}  ${dataset.table.padEnd(20)} rows: ${count.padStart(8)}` +
      (status.datasetAsOf ? `   as of ${status.datasetAsOf}` : ""));
    if (status.problem) console.log(`        ${status.problem}`);
    if (status.missingColumns.length > 0) {
      console.log(`        missing: ${status.missingColumns.join(", ")}`);
    }
  }

  // Tables added by 0003, checked the same way as the workbook tables.
  for (const table of ["rbi_bank"]) {
    const status = await checkTable(client, table, REQUIRED_COLUMNS[table] ?? []);
    statuses.push(status);
    const ok = status.reachable && status.problem === null;
    const count = status.rowCount === null ? "?" : status.rowCount.toLocaleString("en-IN");
    console.log(
      `  ${symbol(ok)}  ${table.padEnd(20)} rows: ${count.padStart(8)}` +
        (status.datasetAsOf ? `   fetched ${status.datasetAsOf}` : ""),
    );
    if (status.problem) console.log(`        ${status.problem}`);
    if (status.missingColumns.length > 0) {
      console.log(`        missing: ${status.missingColumns.join(", ")}`);
    }
  }

  for (const table of [REFERENCE_SHEET.table, "import_runs", "ml_model", "verification_event"]) {
    const status = await checkTable(client, table, []);
    const ok = status.reachable;
    const count = status.rowCount === null ? "?" : status.rowCount.toLocaleString("en-IN");
    console.log(`  ${symbol(ok)}  ${table.padEnd(20)} rows: ${count.padStart(8)}`);
    if (status.problem && !status.problem.startsWith("empty")) {
      console.log(`        ${status.problem}`);
    }
  }

  console.log("\nSearch functions");
  let rpcOk = true;
  for (const name of RPC_FUNCTIONS) {
    const problem = await checkRpc(client, name);
    if (problem) rpcOk = false;
    console.log(`  ${symbol(problem === null)}  ${name}`);
    if (problem) console.log(`        ${problem}`);
  }

  const everythingReady =
    applied.size === MIGRATIONS.length &&
    rpcOk &&
    statuses.every((status) => status.reachable && status.problem === null);

  console.log("");
  if (everythingReady) {
    console.log("Ready. Run `npm run dev` and open http://localhost:3000");
  } else {
    console.log("Not ready yet. Next steps:");
    if (applied.size < MIGRATIONS.length || !rpcOk) {
      console.log("  1. Open the Supabase dashboard -> SQL Editor");
      console.log("  2. Run supabase/migrations/0001_baseline_schema.sql");
      console.log("  3. Run supabase/migrations/0002_verification_schema.sql");
      console.log("  4. Run supabase/migrations/0003_lenderlens_schema.sql");
    }
    if (statuses.some((status) => (status.rowCount ?? 0) === 0)) {
      console.log("  5. Run `npm run import:rbi`  (needs `npm run build:data` first)");
      console.log("  6. Run `npm run ml:publish`  (needs `npm run ml:all` first)");
    }
  }

  process.exitCode = everythingReady ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error("db:status failed");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
