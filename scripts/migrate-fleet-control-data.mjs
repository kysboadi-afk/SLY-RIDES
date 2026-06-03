#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const SOURCE_PROJECT_REF = "xuqqjdifuyzqopypyov";
const TARGET_PROJECT_REF = "kdobrxffhtsigyiwnahs";
const PAGE_SIZE = 1000;
const INSERT_BATCH_SIZE = 200;
const LOG_DIR = "/tmp/fleet-control-migration";
const SERVICE_KEY = "website_services";
const SCOPED_TABLES = [
  "organizations",
  "organization_users",
  "organization_settings",
  "operator_leads",
  "operator_lead_audit_logs",
  "operator_demo_reps",
  "operator_lead_demo_events",
  "operator_lead_demo_notifications",
  "organization_service_upsells",
];

const COUNT_TABLES = [
  "organizations",
  "organization_users",
  "organization_settings",
  "operator_leads",
  "operator_lead_audit_logs",
  "operator_demo_reps",
  "operator_lead_demo_events",
  "operator_lead_demo_notifications",
  "organization_service_upsells",
];

const OPTIONAL_SEED_TABLE = "service_package_catalog";
const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const confirmedFreeze = args.has("--maintenance-confirmed") || process.env.FLEET_CONTROL_MAINTENANCE_CONFIRMED === "true";

function getProjectRef(url) {
  try {
    return new URL(url).host.split(".")[0];
  } catch {
    return null;
  }
}

function createAdminClient(url, key, label) {
  if (!url || !key) {
    throw new Error(`Missing ${label} Supabase credentials.`);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchPaged(buildQuery) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await buildQuery().range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = Array.isArray(data) ? data : [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

function chunk(array, size) {
  const list = [];
  for (let i = 0; i < array.length; i += size) list.push(array.slice(i, i + size));
  return list;
}

async function countRows(client, table, filter) {
  let query = client.from(table).select("id", { count: "exact", head: true });
  if (typeof filter === "function") query = filter(query);
  const { count, error } = await query;
  if (error) throw error;
  return Number(count || 0);
}

async function selectByIds(client, table, column, ids) {
  if (!ids.length) return [];
  const result = [];
  for (const idsChunk of chunk(ids, 500)) {
    const rows = await fetchPaged(() => client.from(table).select("*").in(column, idsChunk));
    result.push(...rows);
  }
  return result;
}

async function assertNoIdConflicts(client, table, ids) {
  if (!ids.length) return;
  for (const idsChunk of chunk(ids, 500)) {
    const { data, error } = await client.from(table).select("id").in("id", idsChunk).limit(1);
    if (error) throw error;
    if (data?.length) throw new Error(`Target already has scoped rows in ${table}. Stop and reconcile before copying.`);
  }
}

async function insertRows(client, table, rows) {
  if (!rows.length) return;
  for (const rowsChunk of chunk(rows, INSERT_BATCH_SIZE)) {
    const { error } = await client.from(table).insert(rowsChunk);
    if (error) {
      throw new Error(`Insert failed for ${table}: ${error.message || error}`);
    }
  }
}

async function validateRequiredTables(client) {
  const checks = await Promise.all(
    SCOPED_TABLES.map(async (table) => {
      const { error } = await client.from(table).select("id", { count: "exact", head: true }).limit(1);
      return {
        table,
        ok: !error,
        error: error?.message || null,
      };
    })
  );
  return {
    allAccessible: checks.every((check) => check.ok),
    checks,
  };
}

async function fetchWebsiteServicePackages(client) {
  const { data, error } = await client
    .from(OPTIONAL_SEED_TABLE)
    .select("service_key,package_code,version,is_active")
    .eq("service_key", SERVICE_KEY)
    .order("package_code", { ascending: true })
    .order("version", { ascending: true });
  if (error) throw error;
  return data || [];
}

function writeMigrationLog(payload) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `migration-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

async function main() {
  const sourceUrl = process.env.SOURCE_SUPABASE_URL;
  const sourceKey = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY;
  const targetUrl = process.env.TARGET_SUPABASE_URL || process.env.SUPABASE_URL;
  const targetKey = process.env.TARGET_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  const sourceRef = getProjectRef(sourceUrl || "");
  const targetRef = getProjectRef(targetUrl || "");
  if (sourceRef !== SOURCE_PROJECT_REF) throw new Error(`Expected source project ${SOURCE_PROJECT_REF}; got ${sourceRef || "unknown"}.`);
  if (targetRef !== TARGET_PROJECT_REF) throw new Error(`Expected target project ${TARGET_PROJECT_REF}; got ${targetRef || "unknown"}.`);

  const source = createAdminClient(sourceUrl, sourceKey, "source");
  const target = createAdminClient(targetUrl, targetKey, "target");

  const log = {
    mode: execute ? "execute" : "preflight",
    sourceProjectRef: sourceRef,
    targetProjectRef: targetRef,
    maintenanceConfirmed: confirmedFreeze,
    schemaValidationMode: "public_table_access",
    preflight: {},
    migration: {},
    validation: {},
  };

  if (!confirmedFreeze) {
    throw new Error("Maintenance freeze not confirmed. Re-run with --maintenance-confirmed or FLEET_CONTROL_MAINTENANCE_CONFIRMED=true.");
  }

  const [sourceTableValidation, targetTableValidation] = await Promise.all([
    validateRequiredTables(source),
    validateRequiredTables(target),
  ]);
  log.preflight.sourceRequiredTables = sourceTableValidation.checks;
  log.preflight.targetRequiredTables = targetTableValidation.checks;
  log.preflight.requiredTablesAccessible = sourceTableValidation.allAccessible && targetTableValidation.allAccessible;

  if (!log.preflight.requiredTablesAccessible) {
    throw new Error("Required public tables are not accessible in source/target. Stop before migration.");
  }

  const [sourcePackages, targetPackages] = await Promise.all([
    fetchWebsiteServicePackages(source),
    fetchWebsiteServicePackages(target),
  ]);
  log.preflight.sourceWebsiteServicePackages = sourcePackages;
  log.preflight.targetWebsiteServicePackages = targetPackages;

  const beforeCountsSource = {};
  const beforeCountsTarget = {};
  for (const table of COUNT_TABLES) {
    beforeCountsSource[table] = await countRows(source, table);
    beforeCountsTarget[table] = await countRows(target, table);
  }
  log.preflight.beforeCountsSource = beforeCountsSource;
  log.preflight.beforeCountsTarget = beforeCountsTarget;

  const activeLeadsInTarget = await countRows(target, "operator_leads");
  log.preflight.activeFleetControlLeadsInTarget = activeLeadsInTarget;
  if (activeLeadsInTarget > 0) {
    throw new Error("Target operator_leads already has rows. Stop and reconcile IDs/slugs/emails before copying.");
  }

  const sourceLeads = await fetchPaged(() => source.from("operator_leads").select("*"));
  if (!sourceLeads.length) throw new Error("No source operator leads found.");
  const leadIds = [...new Set(sourceLeads.map((row) => row.id).filter(Boolean))];
  const orgIds = [...new Set(sourceLeads.map((row) => row.organization_id).filter(Boolean))];
  if (!orgIds.length) throw new Error("No source organizations referenced by operator leads.");

  const [
    sourceOrgs,
    sourceOrgUsers,
    sourceOrgSettings,
    sourceDemoReps,
    sourceAuditLogs,
    sourceDemoEvents,
    sourceOrgUpsells,
  ] = await Promise.all([
    selectByIds(source, "organizations", "id", orgIds),
    selectByIds(source, "organization_users", "organization_id", orgIds),
    selectByIds(source, "organization_settings", "organization_id", orgIds),
    fetchPaged(() => source.from("operator_demo_reps").select("*")),
    selectByIds(source, "operator_lead_audit_logs", "lead_id", leadIds),
    selectByIds(source, "operator_lead_demo_events", "lead_id", leadIds),
    selectByIds(source, "organization_service_upsells", "organization_id", orgIds),
  ]);
  const demoEventIds = [...new Set(sourceDemoEvents.map((row) => row.id).filter(Boolean))];
  const sourceDemoNotifications = demoEventIds.length
    ? await selectByIds(source, "operator_lead_demo_notifications", "demo_id", demoEventIds)
    : [];

  const referencedOrgsInTarget = await countRows(
    target,
    "organizations",
    (query) => query.in("id", orgIds)
  );
  log.preflight.referencedOrgsInTarget = referencedOrgsInTarget;

  const scopedRows = {
    organizations: sourceOrgs,
    organization_users: sourceOrgUsers,
    organization_settings: sourceOrgSettings,
    operator_leads: sourceLeads,
    operator_demo_reps: sourceDemoReps,
    operator_lead_audit_logs: sourceAuditLogs,
    operator_lead_demo_events: sourceDemoEvents,
    operator_lead_demo_notifications: sourceDemoNotifications,
    organization_service_upsells: sourceOrgUpsells,
  };
  log.preflight.sourceScopeCounts = Object.fromEntries(
    Object.entries(scopedRows).map(([table, rows]) => [table, rows.length])
  );

  for (const [table, rows] of Object.entries(scopedRows)) {
    const ids = rows.map((row) => row.id).filter(Boolean);
    await assertNoIdConflicts(target, table, ids);
  }

  if (!execute) {
    const logFile = writeMigrationLog(log);
    console.log(`Preflight complete. Log: ${logFile}`);
    console.log("No writes performed (run with --execute to migrate).");
    return;
  }

  await insertRows(target, "organizations", sourceOrgs);
  await insertRows(target, "organization_users", sourceOrgUsers);
  await insertRows(target, "organization_settings", sourceOrgSettings);
  await insertRows(target, "operator_leads", sourceLeads);
  await insertRows(target, "operator_demo_reps", sourceDemoReps);
  await insertRows(target, "operator_lead_audit_logs", sourceAuditLogs);
  await insertRows(target, "operator_lead_demo_events", sourceDemoEvents);
  await insertRows(target, "operator_lead_demo_notifications", sourceDemoNotifications);
  await insertRows(target, "organization_service_upsells", sourceOrgUpsells);

  const afterCountsTarget = {};
  for (const table of COUNT_TABLES) afterCountsTarget[table] = await countRows(target, table);
  log.validation.afterCountsTarget = afterCountsTarget;

  const [targetLeads, targetOrgs, targetDemoEvents, targetDemoNotifications] = await Promise.all([
    fetchPaged(() => target.from("operator_leads").select("id,organization_id")),
    fetchPaged(() => target.from("organizations").select("id")),
    fetchPaged(() => target.from("operator_lead_demo_events").select("id,lead_id")),
    fetchPaged(() => target.from("operator_lead_demo_notifications").select("id,demo_id")),
  ]);
  const orgSet = new Set(targetOrgs.map((row) => row.id));
  const leadSet = new Set(targetLeads.map((row) => row.id));
  const demoEventSet = new Set(targetDemoEvents.map((row) => row.id));
  log.validation.orphanLeads = targetLeads.filter((row) => row.organization_id && !orgSet.has(row.organization_id)).length;
  log.validation.orphanDemoEvents = targetDemoEvents.filter((row) => row.lead_id && !leadSet.has(row.lead_id)).length;
  log.validation.orphanDemoNotifications = targetDemoNotifications.filter((row) => row.demo_id && !demoEventSet.has(row.demo_id)).length;

  const logFile = writeMigrationLog(log);
  console.log(`Migration complete. Log: ${logFile}`);
}

main().catch((error) => {
  console.error("[fleet-control-migration] failed:", error?.message || error);
  process.exitCode = 1;
});
