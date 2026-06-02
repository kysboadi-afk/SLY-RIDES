import { getSupabaseAdmin } from "./_supabase.js";
import { sendError, withAdminAuth } from "./_middleware.js";
import nodemailer from "nodemailer";
import {
  createOperatorDemoActionToken,
  hashOperatorDemoToken,
} from "./_operator-demo-token.js";

const STATUS_INPUT_MAP = {
  new_lead: "new_lead",
  "new lead": "new_lead",
  contacted: "contacted",
  demo_scheduled: "demo_scheduled",
  "demo scheduled": "demo_scheduled",
  onboarding: "onboarding",
  qualified: "onboarding",
  active_operator: "active_operator",
  converted: "active_operator",
  rejected: "rejected",
  closed: "rejected",
};

const WEBSITE_SERVICE_KEY = "website_services";
const WEBSITE_INTEREST_STATUSES = new Set(["not_asked", "interested", "not_interested"]);
const WEBSITE_ACCEPTANCE_STATUSES = new Set(["not_offered", "offered", "accepted", "declined"]);
const WEBSITE_COMPLETION_STATUSES = new Set(["not_started", "in_progress", "completed"]);
const WEBSITE_STATUSES = new Set(["none", "hosted_booking_page", "custom_website", "external_website"]);

const WEBSITE_UPSELL_SELECT = [
  "organization_id",
  "service_key",
  "interest_status",
  "acceptance_status",
  "completion_status",
  "website_status",
  "selected_package_code",
  "package_snapshot",
  "offered_at",
  "accepted_at",
  "completed_at",
  "updated_by",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const FUNNEL_STAGE_ORDER = [
  "lead_submitted",
  "notification_sent",
  "lead_managed",
  "lead_converted",
  "organization_created",
  "owner_account_created",
  "workspace_provisioned",
];

const FUNNEL_STAGE_RANK = Object.fromEntries(
  FUNNEL_STAGE_ORDER.map((stage, index) => [stage, index])
);

const DEMO_STATUSES = new Set([
  "proposed",
  "scheduled",
  "rescheduled",
  "completed",
  "no_show",
  "cancelled",
]);

const DEMO_MEETING_TYPES = new Set(["zoom", "phone", "in_person"]);
const DEMO_COMPLETED_OUTCOMES = new Set([
  "interested",
  "follow_up_needed",
  "needs_website_services",
  "not_qualified",
  "converted",
]);
const DEMO_NOTIFICATION_TYPES = [
  "schedule_confirmation",
  "reminder_24h",
  "reminder_1h",
  "follow_up_2h",
];

function normalizeLifecycleStage(value) {
  const key = String(value || "").trim().toLowerCase();
  return FUNNEL_STAGE_RANK[key] >= 0 ? key : "";
}

function mergeLifecycleStage(currentStage, nextStage) {
  const current = normalizeLifecycleStage(currentStage) || "lead_submitted";
  const next = normalizeLifecycleStage(nextStage);
  if (!next) return current;
  return FUNNEL_STAGE_RANK[next] >= FUNNEL_STAGE_RANK[current] ? next : current;
}

function normalizeProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function setProgressTimestamp(progress, key, value) {
  const next = normalizeProgress(progress);
  const bucket = next.funnel_timestamps && typeof next.funnel_timestamps === "object" && !Array.isArray(next.funnel_timestamps)
    ? { ...next.funnel_timestamps }
    : {};
  if (!bucket[key]) bucket[key] = value;
  next.funnel_timestamps = bucket;
  return next;
}

function setProgressTimestampLatest(progress, key, value) {
  const next = normalizeProgress(progress);
  const bucket = next.funnel_timestamps && typeof next.funnel_timestamps === "object" && !Array.isArray(next.funnel_timestamps)
    ? { ...next.funnel_timestamps }
    : {};
  bucket[key] = value;
  next.funnel_timestamps = bucket;
  return next;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function formatSupabaseError(error) {
  if (!error) return null;
  return {
    code: error.code || null,
    message: error.message || String(error),
    details: error.details || null,
    hint: error.hint || null,
  };
}

function summarizeSupabaseData(data) {
  if (Array.isArray(data)) return { kind: "array", count: data.length };
  if (data && typeof data === "object") {
    const keys = Object.keys(data);
    return {
      kind: "object",
      keys: keys.slice(0, 12),
      keyCount: keys.length,
      id: data.id || null,
    };
  }
  return { kind: typeof data, value: data ?? null };
}

async function logSupabaseCall(label, operation, context = {}) {
  console.log(`[v2-operator-leads] ${label} start`, context);
  try {
    const result = await operation;
    if (result?.error) {
      console.error(`[v2-operator-leads] ${label} failed`, {
        ...context,
        error: formatSupabaseError(result.error),
      });
    } else {
      console.log(`[v2-operator-leads] ${label} success`, {
        ...context,
        status: result?.status ?? null,
        statusText: result?.statusText ?? null,
        count: result?.count ?? null,
        data: summarizeSupabaseData(result?.data),
      });
    }
    return result;
  } catch (error) {
    console.error(`[v2-operator-leads] ${label} threw`, {
      ...context,
      error: formatSupabaseError(error),
    });
    throw error;
  }
}

function normalizeDemoStatus(value, fallback = "scheduled") {
  const status = String(value || fallback).trim().toLowerCase();
  return DEMO_STATUSES.has(status) ? status : fallback;
}

function normalizeMeetingType(value) {
  const meetingType = String(value || "").trim().toLowerCase().replace("-", "_");
  return DEMO_MEETING_TYPES.has(meetingType) ? meetingType : "";
}

function normalizeDemoCompletedOutcome(value) {
  const outcome = String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
  return DEMO_COMPLETED_OUTCOMES.has(outcome) ? outcome : "";
}

function normalizeTimezone(value) {
  const timezone = String(value || "").trim();
  return timezone.slice(0, 100) || "UTC";
}

function normalizeDurationMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 30;
  return Math.min(480, Math.max(15, Math.round(minutes)));
}

function normalizeIsoTimestamp(value) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString();
}

function getBaseUrl(req) {
  const host = String(req?.headers?.host || process.env.VERCEL_URL || "").trim();
  if (!host) return "https://slycarrentals.com";
  if (host.startsWith("http://") || host.startsWith("https://")) return host;
  return `https://${host}`;
}

function normalizeWebsiteInterestStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return WEBSITE_INTEREST_STATUSES.has(status) ? status : "";
}

function normalizeWebsiteAcceptanceStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return WEBSITE_ACCEPTANCE_STATUSES.has(status) ? status : "";
}

function normalizeWebsiteCompletionStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return WEBSITE_COMPLETION_STATUSES.has(status) ? status : "";
}

function normalizeWebsiteStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return WEBSITE_STATUSES.has(status) ? status : "";
}

function normalizeServiceKey(value) {
  const key = String(value || WEBSITE_SERVICE_KEY).trim().toLowerCase();
  return key || WEBSITE_SERVICE_KEY;
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function defaultWebsiteUpsellState(organizationId) {
  return {
    organization_id: organizationId || null,
    service_key: WEBSITE_SERVICE_KEY,
    interest_status: "not_asked",
    acceptance_status: "not_offered",
    completion_status: "not_started",
    website_status: "none",
    selected_package_code: null,
    package_snapshot: null,
    offered_at: null,
    accepted_at: null,
    completed_at: null,
    updated_by: null,
    metadata: {},
    created_at: null,
    updated_at: null,
  };
}

function normalizeWebsiteUpsellState(row, organizationId) {
  const fallback = defaultWebsiteUpsellState(organizationId);
  const source = row && typeof row === "object" ? row : {};
  return {
    ...fallback,
    ...source,
    service_key: normalizeServiceKey(source.service_key || fallback.service_key),
    interest_status: normalizeWebsiteInterestStatus(source.interest_status) || fallback.interest_status,
    acceptance_status: normalizeWebsiteAcceptanceStatus(source.acceptance_status) || fallback.acceptance_status,
    completion_status: normalizeWebsiteCompletionStatus(source.completion_status) || fallback.completion_status,
    website_status: normalizeWebsiteStatus(source.website_status) || fallback.website_status,
    metadata: normalizeMetadata(source.metadata),
  };
}

function deriveWebsiteOnboardingStepStatus(upsell) {
  const completion = normalizeWebsiteCompletionStatus(upsell?.completion_status) || "not_started";
  const acceptance = normalizeWebsiteAcceptanceStatus(upsell?.acceptance_status) || "not_offered";
  const interest = normalizeWebsiteInterestStatus(upsell?.interest_status) || "not_asked";
  if (completion === "completed") return "completed";
  if (completion === "in_progress" || acceptance === "accepted" || acceptance === "offered" || interest === "interested") {
    return "in_progress";
  }
  return "not_started";
}

async function fetchWebsitePackageByCode(supabase, packageCode) {
  const code = String(packageCode || "").trim().toLowerCase();
  if (!code) return null;
  const { data, error } = await supabase
    .from("service_package_catalog")
    .select("service_key, package_code, package_name, deliverables, pricing_metadata, billing_metadata, version, is_active, metadata")
    .eq("service_key", WEBSITE_SERVICE_KEY)
    .eq("package_code", code)
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message || "Failed to load service package.");
  return data || null;
}

async function fetchActiveWebsitePackages(supabase) {
  const { data, error } = await supabase
    .from("service_package_catalog")
    .select("service_key, package_code, package_name, deliverables, pricing_metadata, billing_metadata, version, is_active, metadata")
    .eq("service_key", WEBSITE_SERVICE_KEY)
    .eq("is_active", true)
    .order("package_code", { ascending: true })
    .order("version", { ascending: false });
  if (error) {
    console.warn("v2-operator-leads package catalog load failed:", error.message || error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

async function fetchLinkedOwnerUserIdByEmail(supabase, email) {
  if (!email) return null;
  const { data, error } = await supabase
    .from("organization_users")
    .select("user_id, accepted_at, invited_at")
    .eq("email", email)
    .order("accepted_at", { ascending: false })
    .order("invited_at", { ascending: false })
    .limit(10);
  if (error) {
    console.warn("v2-operator-leads owner membership lookup failed:", error.message || error);
    return null;
  }
  for (const row of data || []) {
    const candidate = normalizeId(row?.user_id);
    if (candidate) return candidate;
  }
  return null;
}

async function findAuthUserIdByEmail(supabase, email) {
  if (!email || !supabase?.auth?.admin?.listUsers) return null;
  const perPage = 200;
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.warn("v2-operator-leads auth user lookup failed:", error.message || error);
      return null;
    }
    const users = Array.isArray(data?.users) ? data.users : [];
    const matchedUser = users.find((user) => String(user?.email || "").trim().toLowerCase() === email);
    if (matchedUser?.id) return normalizeId(matchedUser.id);
    if (users.length < perPage) break;
  }
  return null;
}

async function provisionOwnerAuthUser(supabase, { email, phone, firstName, lastName }) {
  if (!email || !supabase?.auth?.admin?.createUser) return null;
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    phone: String(phone || "").trim() || undefined,
    email_confirm: false,
    user_metadata: {
      first_name: String(firstName || "").trim() || null,
      last_name: String(lastName || "").trim() || null,
      provisioning_source: "operator_lead_conversion",
    },
  });
  if (error) {
    const message = String(error.message || "").toLowerCase();
    if (message.includes("already") || message.includes("exists") || message.includes("registered")) {
      return await findAuthUserIdByEmail(supabase, email);
    }
    throw new Error(error.message || "Failed to provision owner account.");
  }
  return normalizeId(data?.user?.id);
}

async function resolveOwnerUserId(supabase, { lead, authUser }) {
  const leadEmail = String(lead?.email || "").trim().toLowerCase();
  if (!looksLikeEmail(leadEmail)) {
    throw new Error("Conversion failed: lead email is invalid for owner account linkage.");
  }
  const authUserId = normalizeId(authUser?.id);
  const authUserEmail = String(authUser?.email || "").trim().toLowerCase();
  if (authUserId && authUserEmail && authUserEmail === leadEmail) return authUserId;

  const linkedMembershipUserId = await fetchLinkedOwnerUserIdByEmail(supabase, leadEmail);
  if (linkedMembershipUserId) return linkedMembershipUserId;

  const authLookupUserId = await findAuthUserIdByEmail(supabase, leadEmail);
  if (authLookupUserId) return authLookupUserId;

  const provisionedUserId = await provisionOwnerAuthUser(supabase, {
    email: leadEmail,
    phone: lead?.phone,
    firstName: lead?.first_name,
    lastName: lead?.last_name,
  });
  if (provisionedUserId) return provisionedUserId;

  throw new Error("Conversion failed: owner account could not be linked.");
}

function normalizeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildOrganizationSlug(lead) {
  const nameSlug = normalizeSlug(`${lead?.first_name || ""} ${lead?.last_name || ""}`);
  const leadSuffix = normalizeSlug(String(lead?.id || "").slice(0, 8));
  return `${nameSlug || "fleet-operator"}-${leadSuffix || "lead"}`.slice(0, 58);
}

async function insertLeadAuditLog(supabase, payload) {
  try {
    await supabase.from("operator_lead_audit_logs").insert(payload);
  } catch (error) {
    console.warn("v2-operator-leads audit insert skipped:", error?.message || error);
  }
}

async function resolveDemoOwner(supabase, { lead, requestedOwnerUserId, requestedOwnerEmail, requestedOwnerName, now }) {
  const explicitUserId = normalizeId(requestedOwnerUserId);
  const explicitEmail = String(requestedOwnerEmail || "").trim().toLowerCase();
  if (explicitUserId || explicitEmail) {
    return {
      owner_user_id: explicitUserId || null,
      owner_email: explicitEmail || null,
      owner_name: String(requestedOwnerName || "").trim() || null,
      assignment_reason: "manual_assignment",
    };
  }

  const leadMetadata = normalizeMetadata(lead?.metadata);
  const leadOwner = normalizeMetadata(leadMetadata.owner || {});
  const leadOwnerUserId = normalizeId(lead?.demo_owner_user_id || leadOwner.user_id);
  const leadOwnerEmail = String(leadOwner.email || "").trim().toLowerCase();
  const leadOwnerName = String(leadOwner.name || "").trim();
  if (leadOwnerUserId || leadOwnerEmail) {
    return {
      owner_user_id: leadOwnerUserId || null,
      owner_email: leadOwnerEmail || null,
      owner_name: leadOwnerName || null,
      assignment_reason: "lead_owner_default",
    };
  }

  const { data: reps, error } = await supabase
    .from("operator_demo_reps")
    .select("id, user_id, email, display_name")
    .eq("active", true)
    .order("last_assigned_at", { ascending: true })
    .order("assignment_rank", { ascending: true })
    .limit(1);
  if (error) {
    throw new Error(error.message || "Failed to resolve demo owner assignment.");
  }
  const rep = (reps || [])[0];
  if (!rep) {
    return {
      owner_user_id: null,
      owner_email: null,
      owner_name: null,
      assignment_reason: "unassigned",
    };
  }

  await supabase
    .from("operator_demo_reps")
    .update({ last_assigned_at: now, updated_at: now })
    .eq("id", rep.id);

  return {
    owner_user_id: normalizeId(rep.user_id) || null,
    owner_email: String(rep.email || "").trim().toLowerCase() || null,
    owner_name: String(rep.display_name || "").trim() || null,
    assignment_reason: "round_robin_fallback",
  };
}

function buildDemoIcs({ lead, demo }) {
  const uid = `${demo.id || `demo-${lead?.id || "lead"}`}@slyrides`;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const start = new Date(demo.scheduled_start_at || "").toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const end = new Date(demo.scheduled_end_at || "").toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const title = `Fleet Control Demo - ${operatorLeadNameForEmail(lead)}`;
  const description = String(demo.notes || "Fleet Control onboarding demo.").replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SLY RIDES//Fleet Control Demo//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function operatorLeadNameForEmail(lead) {
  const name = [lead?.first_name, lead?.last_name].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
  return name || "Fleet Control Lead";
}

function getDemoTransporter() {
  const host = process.env.EMAIL_HOST;
  const port = Number(process.env.EMAIL_PORT || 587);
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function upsertDemoNotifications(supabase, { leadId, demo, now }) {
  const startMs = new Date(demo.scheduled_start_at || "").getTime();
  const endMs = new Date(demo.scheduled_end_at || "").getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
  const schedule = [
    { type: "schedule_confirmation", at: now },
    { type: "reminder_24h", at: new Date(startMs - (24 * 60 * 60 * 1000)).toISOString() },
    { type: "reminder_1h", at: new Date(startMs - (60 * 60 * 1000)).toISOString() },
    { type: "follow_up_2h", at: new Date(endMs + (2 * 60 * 60 * 1000)).toISOString() },
  ];
  for (const item of schedule) {
    await supabase
      .from("operator_lead_demo_notifications")
      .upsert({
        demo_id: demo.id,
        lead_id: leadId,
        notification_type: item.type,
        channel: "email",
        target: demo.owner_email || null,
        status: "pending",
        attempt_count: 0,
        next_attempt_at: item.at,
        metadata: {
          timezone: demo.timezone,
          scheduled_start_at: demo.scheduled_start_at,
        },
      }, { onConflict: "demo_id,notification_type,channel" });
  }
}

function buildDemoActionLinks({ req, demo, lead, notificationType }) {
  const baseUrl = getBaseUrl(req);
  const actionTtl = notificationType === "follow_up_2h" ? 5 * 24 * 60 * 60 * 1000 : 72 * 60 * 60 * 1000;
  const actions = ["confirm", "reschedule", "cancel"];
  const links = {};
  const hashes = {};
  for (const action of actions) {
    const token = createOperatorDemoActionToken({
      action,
      demoId: demo.id,
      leadId: lead.id,
      type: notificationType,
    }, actionTtl);
    links[action] = `${baseUrl}/api/operator-lead-demo-action?action=${encodeURIComponent(action)}&token=${encodeURIComponent(token)}`;
    hashes[action] = hashOperatorDemoToken(token);
  }
  return { links, hashes };
}

async function processDueDemoNotifications({ supabase, req, limit = 50 }) {
  const now = new Date().toISOString();
  const transporter = getDemoTransporter();
  const { data: pendingRows, error } = await supabase
    .from("operator_lead_demo_notifications")
    .select("id, demo_id, lead_id, notification_type, channel, target, status, attempt_count, metadata")
    .in("status", ["pending", "retry"])
    .lte("next_attempt_at", now)
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message || "Failed to load due demo notifications.");

  const results = [];
  for (const row of pendingRows || []) {
    const { data: demo } = await supabase
      .from("operator_lead_demo_events")
      .select("id, lead_id, owner_email, owner_name, scheduled_start_at, scheduled_end_at, timezone, duration_minutes, meeting_type, notes, lifecycle_status, demo_outcome, demo_outcome_recorded_at")
      .eq("id", row.demo_id)
      .maybeSingle();
    const { data: lead } = await supabase
      .from("operator_leads")
      .select("id, first_name, last_name, email")
      .eq("id", row.lead_id)
      .maybeSingle();
    if (!demo || !lead) continue;

    const targetEmail = String(row.target || demo.owner_email || lead.email || "").trim().toLowerCase();
    if (!targetEmail || !transporter) {
      const nextAttempt = new Date(Date.now() + ((Number(row.attempt_count || 0) + 1) * 15 * 60 * 1000)).toISOString();
      await supabase
        .from("operator_lead_demo_notifications")
        .update({
          status: Number(row.attempt_count || 0) >= 2 ? "failed" : "retry",
          attempt_count: Number(row.attempt_count || 0) + 1,
          last_attempt_at: now,
          next_attempt_at: nextAttempt,
          error_reason: transporter ? "Missing notification target email." : "Email transport not configured.",
          updated_at: now,
        })
        .eq("id", row.id);
      await insertLeadAuditLog(supabase, {
        lead_id: lead.id,
        event: "demo_notification_attempt_failed",
        outcome: "failed",
        metadata: {
          demoId: demo.id,
          notificationType: row.notification_type,
          reason: transporter ? "missing_target" : "missing_transport",
        },
      });
      continue;
    }

    const { links, hashes } = buildDemoActionLinks({ req, demo, lead, notificationType: row.notification_type });
    const humanStart = formatOperatorLeadDateForEmail(demo.scheduled_start_at, demo.timezone);
    const subject = row.notification_type === "follow_up_2h"
      ? `Demo outcome needed - ${operatorLeadNameForEmail(lead)}`
      : `Fleet Control demo ${row.notification_type === "schedule_confirmation" ? "scheduled" : "reminder"} - ${operatorLeadNameForEmail(lead)}`;
    const text = [
      `Lead: ${operatorLeadNameForEmail(lead)}`,
      `Meeting type: ${demo.meeting_type}`,
      `When: ${humanStart} (${demo.timezone || "UTC"})`,
      `Duration: ${demo.duration_minutes} minutes`,
      "",
      `Confirm: ${links.confirm}`,
      `Reschedule: ${links.reschedule}`,
      `Cancel: ${links.cancel}`,
    ].join("\n");

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: targetEmail,
        subject,
        text,
        attachments: row.notification_type === "schedule_confirmation"
          ? [{
            filename: `fleet-control-demo-${demo.id}.ics`,
            content: buildDemoIcs({ lead, demo }),
            contentType: "text/calendar; charset=utf-8; method=REQUEST",
          }]
          : [],
      });

      const eventPatch = {
        notification_status: "sent",
        notification_last_attempt_at: now,
        notification_attempt_count: Number(demo.notification_attempt_count || 0) + 1,
        updated_at: now,
      };
      if (row.notification_type === "schedule_confirmation") eventPatch.confirmation_sent_at = now;
      if (row.notification_type === "reminder_24h") eventPatch.reminder_24h_sent_at = now;
      if (row.notification_type === "reminder_1h") eventPatch.reminder_1h_sent_at = now;
      if (row.notification_type === "follow_up_2h") eventPatch.follow_up_sent_at = now;
      await supabase.from("operator_lead_demo_events").update(eventPatch).eq("id", demo.id);

      await supabase
        .from("operator_lead_demo_notifications")
        .update({
          status: "sent",
          sent_at: now,
          last_attempt_at: now,
          attempt_count: Number(row.attempt_count || 0) + 1,
          error_reason: null,
          token_hash: hashes.confirm,
          token_expires_at: new Date(Date.now() + (72 * 60 * 60 * 1000)).toISOString(),
          metadata: {
            ...(normalizeMetadata(row.metadata)),
            action_token_hashes: hashes,
          },
          updated_at: now,
        })
        .eq("id", row.id);

      await insertLeadAuditLog(supabase, {
        lead_id: lead.id,
        event: "demo_notification_sent",
        outcome: "success",
        metadata: {
          demoId: demo.id,
          notificationType: row.notification_type,
          target: targetEmail,
        },
      });
      results.push({ id: row.id, status: "sent" });
    } catch (sendErrorValue) {
      const attemptCount = Number(row.attempt_count || 0) + 1;
      const status = attemptCount >= 3 ? "failed" : "retry";
      const nextAttempt = new Date(Date.now() + (attemptCount * 15 * 60 * 1000)).toISOString();
      const reason = String(sendErrorValue?.message || "Notification send failed.").slice(0, 300);
      await supabase
        .from("operator_lead_demo_notifications")
        .update({
          status,
          attempt_count: attemptCount,
          last_attempt_at: now,
          next_attempt_at: nextAttempt,
          error_reason: reason,
          updated_at: now,
        })
        .eq("id", row.id);
      await supabase
        .from("operator_lead_demo_events")
        .update({
          notification_status: "failed",
          notification_error_reason: reason,
          notification_last_attempt_at: now,
          notification_attempt_count: Number(demo.notification_attempt_count || 0) + 1,
          updated_at: now,
        })
        .eq("id", demo.id);
      await insertLeadAuditLog(supabase, {
        lead_id: lead.id,
        event: "demo_notification_attempt_failed",
        outcome: "failed",
        detail: reason,
        metadata: {
          demoId: demo.id,
          notificationType: row.notification_type,
          target: targetEmail,
        },
      });
      results.push({ id: row.id, status });
    }
  }
  return results;
}

function formatOperatorLeadDateForEmail(value, timezone) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "TBD";
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone || "UTC",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function leadManagementStatusToStage(status, fallback) {
  if (status === "active_operator") return "lead_converted";
  if (status === "rejected") return fallback || "lead_managed";
  if (status === "contacted" || status === "demo_scheduled" || status === "onboarding") {
    return "lead_managed";
  }
  return fallback || "lead_submitted";
}

function normalizeId(value) {
  return String(value || "").trim().slice(0, 128);
}

function normalizeNotes(value) {
  return String(value || "").trim().slice(0, 4000);
}

function normalizeStatus(value) {
  const key = String(value || "").trim().toLowerCase();
  return STATUS_INPUT_MAP[key] || "";
}

async function ensureWebsiteUpsellState(supabase, { organizationId, actorId, now, source }) {
  const { data: existingState, error: existingError } = await supabase
    .from("organization_service_upsells")
    .select(WEBSITE_UPSELL_SELECT)
    .eq("organization_id", organizationId)
    .eq("service_key", WEBSITE_SERVICE_KEY)
    .maybeSingle();
  if (existingError) {
    throw new Error(existingError.message || "Failed to load website services upsell state.");
  }
  if (existingState) {
    return normalizeWebsiteUpsellState(existingState, organizationId);
  }

  const seedPayload = {
    organization_id: organizationId,
    service_key: WEBSITE_SERVICE_KEY,
    interest_status: "not_asked",
    acceptance_status: "not_offered",
    completion_status: "not_started",
    website_status: "none",
    updated_by: actorId || "legacy_admin",
    metadata: {
      seed_source: source || "operator_lead_conversion",
      seeded_at: now,
    },
  };

  const { error: upsertError } = await supabase
    .from("organization_service_upsells")
    .upsert(seedPayload, { onConflict: "organization_id,service_key" });
  if (upsertError) {
    throw new Error(upsertError.message || "Failed to seed website services upsell state.");
  }

  return normalizeWebsiteUpsellState(seedPayload, organizationId);
}

async function syncOrganizationWebsiteOnboardingStep(supabase, { organizationId, leadId, upsell, now, source }) {
  const { data: orgSettingsRow, error: settingsReadError } = await supabase
    .from("organization_settings")
    .select("settings")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (settingsReadError) {
    throw new Error(settingsReadError.message || "Failed to read organization settings.");
  }
  const currentSettings = normalizeMetadata(orgSettingsRow?.settings);
  const currentOnboarding = normalizeMetadata(currentSettings.onboarding);
  const currentSteps = normalizeMetadata(currentOnboarding.steps);
  const currentWebsiteStep = normalizeMetadata(currentSteps[WEBSITE_SERVICE_KEY]);
  const stepStatus = deriveWebsiteOnboardingStepStatus(upsell);

  const nextSettings = {
    ...currentSettings,
    onboarding: {
      ...currentOnboarding,
      bootstrap_state: currentOnboarding.bootstrap_state || "workspace_provisioned",
      source: currentOnboarding.source || source || "operator_lead_conversion",
      lead_id: currentOnboarding.lead_id || leadId || null,
      initialized_at: currentOnboarding.initialized_at || now,
      steps: {
        ...currentSteps,
        [WEBSITE_SERVICE_KEY]: {
          ...currentWebsiteStep,
          service_key: WEBSITE_SERVICE_KEY,
          status: stepStatus,
          tracked_at: currentWebsiteStep.tracked_at || now,
          updated_at: now,
          interest_status: upsell.interest_status,
          acceptance_status: upsell.acceptance_status,
          completion_status: upsell.completion_status,
          website_status: upsell.website_status,
          selected_package_code: upsell.selected_package_code || null,
        },
      },
    },
  };

  const { error: settingsWriteError } = await supabase
    .from("organization_settings")
    .upsert({
      organization_id: organizationId,
      settings: nextSettings,
    }, { onConflict: "organization_id" });
  if (settingsWriteError) {
    throw new Error(settingsWriteError.message || "Failed to update organization onboarding settings.");
  }
  return nextSettings;
}

function buildWebsiteUpsellKpis(leads) {
  const list = Array.isArray(leads) ? leads : [];
  let offered = 0;
  let accepted = 0;
  let declined = 0;
  let completed = 0;
  let interested = 0;

  for (const lead of list) {
    const state = normalizeWebsiteUpsellState(lead?.website_services, lead?.organization_id || null);
    if (state.interest_status === "interested") interested += 1;
    if (state.acceptance_status === "offered") offered += 1;
    if (state.acceptance_status === "accepted") accepted += 1;
    if (state.acceptance_status === "declined") declined += 1;
    if (state.completion_status === "completed") completed += 1;
  }

  return {
    total: list.length,
    interested,
    offered,
    accepted,
    declined,
    completed,
  };
}

export default withAdminAuth(async function handler(req, res) {
  const { action = "list", scope } = req.body || {};
  const supabase = getSupabaseAdmin();
  const supabaseUrlHost = (() => {
    try {
      return new URL(process.env.SUPABASE_URL || "").host || null;
    } catch {
      return null;
    }
  })();

  console.log("[v2-operator-leads] request context", {
    action,
    scope,
    supabaseUrlHost,
    supabaseUrlPresent: Boolean(process.env.SUPABASE_URL),
    supabaseServiceRoleKeyPresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  });
  console.log("[v2-operator-leads] action", action);
  console.log("[v2-operator-leads] scope", scope);

  if (action === "list") {
    if (!supabase) return res.status(200).json({ leads: [] });
    const { data, error } = await logSupabaseCall("lead_list", supabase
      .from("operator_leads")
      .select("id, first_name, last_name, email, phone, fleet_size, status, notes, created_at, updated_at, funnel_stage, lead_submitted_at, notification_status, notification_channel, notification_sent_at, notification_last_attempt_at, notification_error_reason, lead_managed_at, lead_converted_at, organization_id, organization_created_at, owner_account_created_at, workspace_provisioned_at, conversion_status, conversion_error_reason, demo_first_scheduled_at, demo_last_scheduled_at, demo_completed_at, demo_completed_outcome, demo_no_show_at, demo_follow_up_due_at, demo_owner_user_id, demo_owner_reason")
      .order("created_at", { ascending: false })
      .limit(500), {
      table: "operator_leads",
      limit: 500,
      supabaseUrlHost,
    });
    if (error) {
      console.error("v2-operator-leads list failed:", error.message || error);
      return sendError(res, 500, "Failed to load operator leads.");
    }
    const leads = Array.isArray(data) ? data : [];
    console.log("[v2-operator-leads] query result count", leads?.length);
    console.log("[v2-operator-leads] first row", leads?.[0]);
    const organizationIds = [...new Set(leads.map((lead) => lead?.organization_id).filter(Boolean))];
    const websiteStateByOrg = new Map();
    if (organizationIds.length) {
      const { data: upsellRows, error: upsellError } = await logSupabaseCall("website_upsell_list", supabase
        .from("organization_service_upsells")
        .select(WEBSITE_UPSELL_SELECT)
        .eq("service_key", WEBSITE_SERVICE_KEY)
        .in("organization_id", organizationIds), {
        table: "organization_service_upsells",
        organizationCount: organizationIds.length,
        serviceKey: WEBSITE_SERVICE_KEY,
        supabaseUrlHost,
      });
      if (upsellError) {
        console.warn("v2-operator-leads list website upsell load failed:", upsellError.message || upsellError);
      } else {
        for (const row of upsellRows || []) {
          if (!row?.organization_id) continue;
          websiteStateByOrg.set(
            row.organization_id,
            normalizeWebsiteUpsellState(row, row.organization_id)
          );
        }
      }
    }

    const leadsWithWebsite = leads.map((lead) => ({
      ...lead,
      website_services: websiteStateByOrg.get(lead?.organization_id) || defaultWebsiteUpsellState(lead?.organization_id || null),
    }));

    return res.status(200).json({
      leads: leadsWithWebsite,
      websiteServicesKpis: buildWebsiteUpsellKpis(leadsWithWebsite),
    });
  }

  if (action === "update") {
    const id = normalizeId(req.body?.id);
    if (!id) return sendError(res, 400, "Missing lead id.");

    const updates = {};
    if ("status" in (req.body || {})) {
      const normalizedStatus = normalizeStatus(req.body?.status);
      if (!normalizedStatus) return sendError(res, 400, "Invalid lead status.");
      updates.status = normalizedStatus;
      const currentStage = normalizeLifecycleStage(req.body?.currentFunnelStage);
      const nextStage = leadManagementStatusToStage(normalizedStatus, currentStage);
      updates.funnel_stage = mergeLifecycleStage(currentStage || "lead_submitted", nextStage);
      if (nextStage === "lead_managed") {
        updates.lead_managed_at = new Date().toISOString();
      }
    }
    if ("notes" in (req.body || {})) {
      updates.notes = normalizeNotes(req.body?.notes);
    }
    if (!Object.keys(updates).length) {
      return sendError(res, 400, "Nothing to update.");
    }
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");

    const { data, error } = await supabase
      .from("operator_leads")
      .update(updates)
      .eq("id", id)
      .select("id, status, notes, updated_at, funnel_stage, lead_managed_at, demo_first_scheduled_at, demo_last_scheduled_at, demo_completed_at, demo_completed_outcome, demo_no_show_at, demo_follow_up_due_at, demo_owner_user_id, demo_owner_reason")
      .maybeSingle();
    if (error) {
      console.error("v2-operator-leads update failed:", error.message || error);
      return sendError(res, 500, "Failed to update operator lead.");
    }
    if (!data) return sendError(res, 404, "Lead not found.");
    await insertLeadAuditLog(supabase, {
      lead_id: data.id,
      event: "lead_management_update",
      outcome: "success",
      metadata: {
        updatedFields: Object.keys(updates),
      },
    });
    return res.status(200).json({ success: true, lead: data });
  }

  if (action === "demo_schedule") {
    const leadId = normalizeId(req.body?.id);
    if (!leadId) return sendError(res, 400, "Missing lead id.");
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");

    const meetingType = normalizeMeetingType(req.body?.meetingType);
    if (!meetingType) return sendError(res, 400, "Invalid meeting type.");
    const timezone = normalizeTimezone(req.body?.timezone);
    const scheduledStartAt = normalizeIsoTimestamp(req.body?.scheduledAt || req.body?.startAt || req.body?.dateTime);
    if (!scheduledStartAt) return sendError(res, 400, "Invalid demo date/time.");
    const durationMinutes = normalizeDurationMinutes(req.body?.durationMinutes || req.body?.duration);
    const scheduledEndAt = new Date(new Date(scheduledStartAt).getTime() + durationMinutes * 60 * 1000).toISOString();
    const notes = normalizeNotes(req.body?.notes);
    const now = new Date().toISOString();
    const requestedStatus = normalizeDemoStatus(req.body?.lifecycleStatus, "scheduled");
    const lifecycleStatus = requestedStatus === "proposed" ? "proposed" : "scheduled";

    const { data: lead, error: leadError } = await supabase
      .from("operator_leads")
      .select("id, first_name, last_name, email, status, funnel_stage, onboarding_progress, metadata, lead_managed_at, demo_first_scheduled_at, demo_last_scheduled_at, demo_completed_at, demo_completed_outcome, demo_no_show_at, demo_follow_up_due_at, demo_owner_user_id")
      .eq("id", leadId)
      .maybeSingle();
    if (leadError) return sendError(res, 500, "Failed to load operator lead.");
    if (!lead) return sendError(res, 404, "Lead not found.");

    const ownerAssignment = await resolveDemoOwner(supabase, {
      lead,
      requestedOwnerUserId: req.body?.ownerUserId || req.body?.owner_user_id,
      requestedOwnerEmail: req.body?.ownerEmail || req.body?.owner_email,
      requestedOwnerName: req.body?.ownerName || req.body?.owner_name,
      now,
    });

    const { data: demoRow, error: demoInsertError } = await supabase
      .from("operator_lead_demo_events")
      .insert({
        lead_id: leadId,
        owner_user_id: ownerAssignment.owner_user_id,
        owner_email: ownerAssignment.owner_email,
        owner_name: ownerAssignment.owner_name,
        assigned_reason: ownerAssignment.assignment_reason,
        scheduled_start_at: scheduledStartAt,
        scheduled_end_at: scheduledEndAt,
        timezone,
        duration_minutes: durationMinutes,
        meeting_type: meetingType,
        notes,
        lifecycle_status: lifecycleStatus,
        proposed_at: lifecycleStatus === "proposed" ? now : null,
        scheduled_at: lifecycleStatus === "proposed" ? null : now,
        notification_status: "pending",
        created_by: req.authUser?.id || "legacy_admin",
        updated_by: req.authUser?.id || "legacy_admin",
        metadata: {
          source: "operator_lead_detail_schedule_demo",
          requested_status: requestedStatus,
        },
      })
      .select("id, lead_id, owner_user_id, owner_email, owner_name, assigned_reason, scheduled_start_at, scheduled_end_at, timezone, duration_minutes, meeting_type, notes, lifecycle_status, demo_outcome, demo_outcome_recorded_at, scheduled_at, proposed_at, last_rescheduled_at, completed_at, no_show_at, cancelled_at, follow_up_due_at, notification_status, notification_attempt_count, notification_last_attempt_at, notification_error_reason, metadata, created_at, updated_at")
      .maybeSingle();
    if (demoInsertError) {
      return sendError(res, 500, "Failed to schedule demo.", { reason: String(demoInsertError.message || demoInsertError) });
    }

    await upsertDemoNotifications(supabase, { leadId, demo: demoRow, now });
    const progress = normalizeProgress(lead.onboarding_progress);
    let nextProgress = setProgressTimestamp(progress, "demo_first_scheduled_at", lead.demo_first_scheduled_at || scheduledStartAt);
    nextProgress = setProgressTimestampLatest(nextProgress, "demo_last_scheduled_at", scheduledStartAt);
    const currentStage = normalizeLifecycleStage(lead.funnel_stage) || "lead_submitted";
    const nextStage = mergeLifecycleStage(currentStage, "lead_managed");
    const leadPatch = {
      status: lead.status === "active_operator" ? lead.status : "demo_scheduled",
      funnel_stage: nextStage,
      lead_managed_at: lead.lead_managed_at || now,
      demo_first_scheduled_at: lead.demo_first_scheduled_at || scheduledStartAt,
      demo_last_scheduled_at: scheduledStartAt,
      demo_owner_user_id: ownerAssignment.owner_user_id || lead.demo_owner_user_id || null,
      demo_owner_reason: ownerAssignment.assignment_reason,
      onboarding_progress: nextProgress,
      metadata: {
        ...normalizeMetadata(lead.metadata),
        demo: {
          latest_demo_id: demoRow.id,
          latest_demo_status: demoRow.lifecycle_status,
          latest_demo_owner: {
            user_id: ownerAssignment.owner_user_id || null,
            email: ownerAssignment.owner_email || null,
            name: ownerAssignment.owner_name || null,
          },
        },
      },
    };

    const { data: updatedLead, error: leadUpdateError } = await supabase
      .from("operator_leads")
      .update(leadPatch)
      .eq("id", leadId)
      .select("id, status, notes, updated_at, funnel_stage, lead_managed_at, demo_first_scheduled_at, demo_last_scheduled_at, demo_completed_at, demo_completed_outcome, demo_no_show_at, demo_follow_up_due_at, demo_owner_user_id, demo_owner_reason")
      .maybeSingle();
    if (leadUpdateError) {
      return sendError(res, 500, "Demo created but lead update failed.", { reason: String(leadUpdateError.message || leadUpdateError) });
    }

    await insertLeadAuditLog(supabase, {
      lead_id: leadId,
      event: "demo_scheduled",
      outcome: "success",
      metadata: {
        demoId: demoRow.id,
        lifecycleStatus: demoRow.lifecycle_status,
        ownerUserId: ownerAssignment.owner_user_id || null,
        ownerEmail: ownerAssignment.owner_email || null,
        assignmentReason: ownerAssignment.assignment_reason,
        scheduledStartAt,
        scheduledEndAt,
        timezone,
        durationMinutes,
        meetingType,
      },
    });

    return res.status(200).json({ success: true, lead: updatedLead, demo: demoRow });
  }

  if (action === "demo_reschedule") {
    const leadId = normalizeId(req.body?.id);
    const demoId = normalizeId(req.body?.demoId || req.body?.demo_id);
    if (!leadId || !demoId) return sendError(res, 400, "Missing lead id or demo id.");
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");
    const nextStartAt = normalizeIsoTimestamp(req.body?.scheduledAt || req.body?.startAt || req.body?.dateTime);
    if (!nextStartAt) return sendError(res, 400, "Invalid reschedule date/time.");
    const durationMinutes = normalizeDurationMinutes(req.body?.durationMinutes || req.body?.duration);
    const nextEndAt = new Date(new Date(nextStartAt).getTime() + durationMinutes * 60 * 1000).toISOString();
    const timezone = normalizeTimezone(req.body?.timezone);
    const notes = normalizeNotes(req.body?.notes);
    const now = new Date().toISOString();

    const { data: demo, error: demoReadError } = await supabase
      .from("operator_lead_demo_events")
      .select("id, lead_id, owner_user_id, owner_email, owner_name, lifecycle_status")
      .eq("id", demoId)
      .eq("lead_id", leadId)
      .maybeSingle();
    if (demoReadError) return sendError(res, 500, "Failed to load demo event.");
    if (!demo) return sendError(res, 404, "Demo not found.");

    const { data: updatedDemo, error: demoUpdateError } = await supabase
      .from("operator_lead_demo_events")
      .update({
        scheduled_start_at: nextStartAt,
        scheduled_end_at: nextEndAt,
        duration_minutes: durationMinutes,
        timezone,
        notes,
        lifecycle_status: "rescheduled",
        last_rescheduled_at: now,
        scheduled_at: now,
        updated_by: req.authUser?.id || "legacy_admin",
        updated_at: now,
      })
      .eq("id", demoId)
      .eq("lead_id", leadId)
      .select("id, lead_id, owner_user_id, owner_email, owner_name, assigned_reason, scheduled_start_at, scheduled_end_at, timezone, duration_minutes, meeting_type, notes, lifecycle_status, demo_outcome, demo_outcome_recorded_at, scheduled_at, proposed_at, last_rescheduled_at, completed_at, no_show_at, cancelled_at, follow_up_due_at, notification_status, notification_attempt_count, notification_last_attempt_at, notification_error_reason, metadata, created_at, updated_at")
      .maybeSingle();
    if (demoUpdateError) return sendError(res, 500, "Failed to reschedule demo.");

    await upsertDemoNotifications(supabase, { leadId, demo: updatedDemo, now });
    const { data: lead } = await supabase
      .from("operator_leads")
      .select("id, onboarding_progress")
      .eq("id", leadId)
      .maybeSingle();
    const nextProgress = setProgressTimestampLatest(normalizeProgress(lead?.onboarding_progress), "demo_last_scheduled_at", nextStartAt);
    const { data: updatedLead, error: leadUpdateError } = await supabase
      .from("operator_leads")
      .update({
        demo_last_scheduled_at: nextStartAt,
        onboarding_progress: nextProgress,
      })
      .eq("id", leadId)
      .select("id, status, funnel_stage, demo_first_scheduled_at, demo_last_scheduled_at, demo_completed_at, demo_completed_outcome, demo_no_show_at, demo_follow_up_due_at, demo_owner_user_id, demo_owner_reason")
      .maybeSingle();
    if (leadUpdateError) return sendError(res, 500, "Demo rescheduled but lead update failed.");

    await insertLeadAuditLog(supabase, {
      lead_id: leadId,
      event: "demo_rescheduled",
      outcome: "success",
      metadata: {
        demoId,
        previousStatus: demo.lifecycle_status,
        scheduledStartAt: nextStartAt,
        scheduledEndAt: nextEndAt,
      },
    });
    return res.status(200).json({ success: true, lead: updatedLead, demo: updatedDemo });
  }

  if (action === "demo_update_outcome") {
    const leadId = normalizeId(req.body?.id);
    const demoId = normalizeId(req.body?.demoId || req.body?.demo_id);
    const outcome = normalizeDemoStatus(req.body?.outcome, "");
    if (!leadId || !demoId || !outcome) return sendError(res, 400, "Missing lead id, demo id, or outcome.");
    if (!["completed", "no_show", "cancelled"].includes(outcome)) {
      return sendError(res, 400, "Outcome must be completed, no_show, or cancelled.");
    }
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");

    const now = new Date().toISOString();
    const completedDemoOutcome = normalizeDemoCompletedOutcome(req.body?.demoOutcome || req.body?.demo_outcome);
    if (outcome === "completed" && !completedDemoOutcome) {
      return sendError(res, 400, "Demo completed outcome is required.");
    }
    const followUpDueAt = normalizeIsoTimestamp(req.body?.followUpDueAt) || new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString();
    const { data: lead, error: leadReadError } = await supabase
      .from("operator_leads")
      .select("id, status, funnel_stage, onboarding_progress, metadata, conversion_status, demo_completed_outcome")
      .eq("id", leadId)
      .maybeSingle();
    if (leadReadError) return sendError(res, 500, "Failed to load lead.");
    if (!lead) return sendError(res, 404, "Lead not found.");

    const demoPatch = {
      lifecycle_status: outcome,
      lifecycle_detail: normalizeNotes(req.body?.detail),
      follow_up_due_at: outcome === "completed" ? null : followUpDueAt,
      updated_by: req.authUser?.id || "legacy_admin",
      updated_at: now,
    };
    if (outcome === "completed") {
      demoPatch.completed_at = now;
      demoPatch.demo_outcome = completedDemoOutcome;
      demoPatch.demo_outcome_recorded_at = now;
    }
    if (outcome === "no_show") demoPatch.no_show_at = now;
    if (outcome === "cancelled") demoPatch.cancelled_at = now;
    const { data: updatedDemo, error: demoUpdateError } = await supabase
      .from("operator_lead_demo_events")
      .update(demoPatch)
      .eq("id", demoId)
      .eq("lead_id", leadId)
      .select("id, lead_id, owner_user_id, owner_email, owner_name, assigned_reason, scheduled_start_at, scheduled_end_at, timezone, duration_minutes, meeting_type, notes, lifecycle_status, demo_outcome, demo_outcome_recorded_at, scheduled_at, proposed_at, last_rescheduled_at, completed_at, no_show_at, cancelled_at, follow_up_due_at, notification_status, notification_attempt_count, notification_last_attempt_at, notification_error_reason, metadata, created_at, updated_at")
      .maybeSingle();
    if (demoUpdateError) return sendError(res, 500, "Failed to update demo outcome.");
    if (!updatedDemo) return sendError(res, 404, "Demo not found.");

    let nextProgress = normalizeProgress(lead.onboarding_progress);
    if (outcome === "completed") {
      nextProgress = setProgressTimestamp(nextProgress, "demo_completed_at", now);
    } else if (outcome === "no_show") {
      nextProgress = setProgressTimestamp(nextProgress, "demo_no_show_at", now);
    }
    const leadPatch = {
      demo_follow_up_due_at: outcome === "completed" ? null : followUpDueAt,
      onboarding_progress: nextProgress,
      metadata: {
        ...normalizeMetadata(lead.metadata),
        demo: {
          ...normalizeMetadata(normalizeMetadata(lead.metadata).demo),
          latest_demo_id: demoId,
          latest_demo_status: outcome,
          latest_demo_completed_outcome: outcome === "completed" ? completedDemoOutcome : lead.demo_completed_outcome || null,
          follow_up_due_at: outcome === "completed" ? null : followUpDueAt,
        },
      },
    };
    if (outcome === "completed") {
      leadPatch.status = lead.status === "active_operator" ? "active_operator" : "onboarding";
      leadPatch.demo_completed_at = now;
      leadPatch.demo_completed_outcome = completedDemoOutcome;
      leadPatch.demo_no_show_at = null;
      leadPatch.demo_follow_up_due_at = null;
    }
    if (outcome === "no_show") {
      leadPatch.status = lead.status === "active_operator" ? lead.status : "demo_scheduled";
      leadPatch.demo_no_show_at = now;
    }
    if (outcome === "cancelled") {
      leadPatch.status = lead.status === "active_operator" ? lead.status : "demo_scheduled";
    }

    const { data: updatedLead, error: leadUpdateError } = await supabase
      .from("operator_leads")
      .update(leadPatch)
      .eq("id", leadId)
      .select("id, status, notes, updated_at, funnel_stage, lead_managed_at, demo_first_scheduled_at, demo_last_scheduled_at, demo_completed_at, demo_completed_outcome, demo_no_show_at, demo_follow_up_due_at, demo_owner_user_id, demo_owner_reason")
      .maybeSingle();
    if (leadUpdateError) return sendError(res, 500, "Demo outcome updated but lead update failed.");

    await insertLeadAuditLog(supabase, {
      lead_id: leadId,
      event: `demo_${outcome}`,
      outcome: "success",
      metadata: {
        demoId,
        demoCompletedOutcome: outcome === "completed" ? completedDemoOutcome : null,
        followUpDueAt: outcome === "completed" ? null : followUpDueAt,
      },
    });
    return res.status(200).json({ success: true, lead: updatedLead, demo: updatedDemo });
  }

  if (action === "demo_reassign_owner") {
    const leadId = normalizeId(req.body?.id);
    const demoId = normalizeId(req.body?.demoId || req.body?.demo_id);
    const reason = normalizeNotes(req.body?.reason);
    if (!leadId || !demoId) return sendError(res, 400, "Missing lead id or demo id.");
    if (!reason) return sendError(res, 400, "Reassignment reason is required.");
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");
    const now = new Date().toISOString();
    const ownerAssignment = await resolveDemoOwner(supabase, {
      lead: {},
      requestedOwnerUserId: req.body?.ownerUserId || req.body?.owner_user_id,
      requestedOwnerEmail: req.body?.ownerEmail || req.body?.owner_email,
      requestedOwnerName: req.body?.ownerName || req.body?.owner_name,
      now,
    });
    if (!ownerAssignment.owner_user_id && !ownerAssignment.owner_email) {
      return sendError(res, 400, "A valid owner assignment is required.");
    }

    const { data: updatedDemo, error: demoUpdateError } = await supabase
      .from("operator_lead_demo_events")
      .update({
        owner_user_id: ownerAssignment.owner_user_id,
        owner_email: ownerAssignment.owner_email,
        owner_name: ownerAssignment.owner_name,
        assigned_reason: reason,
        updated_by: req.authUser?.id || "legacy_admin",
        updated_at: now,
      })
      .eq("id", demoId)
      .eq("lead_id", leadId)
      .select("id, lead_id, owner_user_id, owner_email, owner_name, assigned_reason, scheduled_start_at, scheduled_end_at, timezone, duration_minutes, meeting_type, notes, lifecycle_status, scheduled_at, proposed_at, last_rescheduled_at, completed_at, no_show_at, cancelled_at, follow_up_due_at, notification_status, notification_attempt_count, notification_last_attempt_at, notification_error_reason, metadata, created_at, updated_at")
      .maybeSingle();
    if (demoUpdateError) return sendError(res, 500, "Failed to reassign demo owner.");
    if (!updatedDemo) return sendError(res, 404, "Demo not found.");

    const { data: updatedLead, error: leadUpdateError } = await supabase
      .from("operator_leads")
      .update({
        demo_owner_user_id: ownerAssignment.owner_user_id,
        demo_owner_reason: reason,
      })
      .eq("id", leadId)
      .select("id, status, notes, updated_at, funnel_stage, lead_managed_at, demo_first_scheduled_at, demo_last_scheduled_at, demo_completed_at, demo_no_show_at, demo_follow_up_due_at, demo_owner_user_id, demo_owner_reason")
      .maybeSingle();
    if (leadUpdateError) return sendError(res, 500, "Owner reassigned but lead update failed.");

    await insertLeadAuditLog(supabase, {
      lead_id: leadId,
      event: "demo_owner_reassigned",
      outcome: "success",
      metadata: {
        demoId,
        ownerUserId: ownerAssignment.owner_user_id || null,
        ownerEmail: ownerAssignment.owner_email || null,
        reason,
      },
    });
    return res.status(200).json({ success: true, lead: updatedLead, demo: updatedDemo });
  }

  if (action === "demo_list") {
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");
    const now = new Date().toISOString();
    const ownerUserId = normalizeId(req.body?.ownerUserId || req.body?.owner_user_id);
    const showUpcomingOnly = Boolean(req.body?.upcomingOnly);
    const overdueHours = Math.max(1, Number(req.body?.overdueHours || 24));
    let query = supabase
      .from("operator_lead_demo_events")
      .select("id, lead_id, owner_user_id, owner_email, owner_name, assigned_reason, scheduled_start_at, scheduled_end_at, timezone, duration_minutes, meeting_type, notes, lifecycle_status, demo_outcome, demo_outcome_recorded_at, scheduled_at, proposed_at, last_rescheduled_at, completed_at, no_show_at, cancelled_at, follow_up_due_at, notification_status, notification_attempt_count, notification_last_attempt_at, notification_error_reason, metadata, created_at, updated_at")
      .order("scheduled_start_at", { ascending: true })
      .limit(500);
    if (ownerUserId) query = query.eq("owner_user_id", ownerUserId);
    if (showUpcomingOnly) {
      query = query.in("lifecycle_status", ["scheduled", "rescheduled"]).gte("scheduled_start_at", now);
    }
    const { data, error } = await query;
    if (error) return sendError(res, 500, "Failed to load scheduled demos.");
    const demos = Array.isArray(data) ? data : [];
    const overdueThresholdMs = Date.now() - (overdueHours * 60 * 60 * 1000);
    const overdueOutcome = demos.filter((demo) => {
      if (!["scheduled", "rescheduled"].includes(String(demo.lifecycle_status || "").toLowerCase())) return false;
      const endMs = new Date(demo.scheduled_end_at || demo.scheduled_start_at || "").getTime();
      return Number.isFinite(endMs) && endMs <= overdueThresholdMs;
    });
    return res.status(200).json({
      success: true,
      demos,
      dashboard: {
        total: demos.length,
        upcoming: demos.filter((demo) => ["scheduled", "rescheduled"].includes(String(demo.lifecycle_status || "").toLowerCase())).length,
        overdueOutcome: overdueOutcome.length,
      },
      overdueOutcome,
    });
  }

  if (action === "demo_reporting") {
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");
    const { data: leads, error } = await supabase
      .from("operator_leads")
      .select("id, status, conversion_status, demo_first_scheduled_at, demo_completed_at, demo_completed_outcome")
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) return sendError(res, 500, "Failed to load demo reporting metrics.");
    const list = Array.isArray(leads) ? leads : [];
    const totalLeads = list.length;
    const demoScheduledCount = list.filter((lead) => !!lead?.demo_first_scheduled_at).length;
    const demoCompletedCount = list.filter((lead) => !!lead?.demo_completed_at).length;
    const convertedAfterDemoCount = list.filter((lead) => (
      !!lead?.demo_completed_at
      && (
        String(lead?.status || "").toLowerCase() === "active_operator"
        || String(lead?.conversion_status || "").toLowerCase() === "succeeded"
        || String(lead?.demo_completed_outcome || "").toLowerCase() === "converted"
      )
    )).length;
    const outcomes = list.reduce((acc, lead) => {
      const key = String(lead?.demo_completed_outcome || "").trim().toLowerCase();
      if (!key) return acc;
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {});

    return res.status(200).json({
      success: true,
      metrics: {
        totalLeads,
        demoScheduledCount,
        demoCompletedCount,
        convertedAfterDemoCount,
        leadToDemoScheduledRate: totalLeads ? demoScheduledCount / totalLeads : 0,
        demoScheduledToCompletedRate: demoScheduledCount ? demoCompletedCount / demoScheduledCount : 0,
        demoCompletedToConvertedRate: demoCompletedCount ? convertedAfterDemoCount / demoCompletedCount : 0,
        completedOutcomes: outcomes,
      },
    });
  }

  if (action === "demo_process_notifications") {
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");
    try {
      const results = await processDueDemoNotifications({
        supabase,
        req,
        limit: Math.max(1, Math.min(100, Number(req.body?.limit || 50))),
      });
      return res.status(200).json({ success: true, processed: results.length, results });
    } catch (error) {
      return sendError(res, 500, "Failed to process demo notifications.", { reason: String(error?.message || error) });
    }
  }

  if (action === "convert") {
    const id = normalizeId(req.body?.id);
    if (!id) return sendError(res, 400, "Missing lead id.");
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");

    const now = new Date().toISOString();
    const { data: lead, error: leadError } = await supabase
      .from("operator_leads")
      .select("id, first_name, last_name, email, phone, fleet_size, source, status, notes, funnel_stage, onboarding_progress, metadata, organization_id, lead_submitted_at, notification_status, notification_sent_at, lead_managed_at, lead_converted_at, organization_created_at, owner_account_created_at, workspace_provisioned_at, conversion_status, conversion_error_reason, demo_first_scheduled_at, demo_last_scheduled_at, demo_completed_at, demo_completed_outcome, demo_no_show_at, demo_follow_up_due_at, demo_owner_user_id, demo_owner_reason")
      .eq("id", id)
      .maybeSingle();

    if (leadError) {
      console.error("v2-operator-leads convert lead lookup failed:", leadError.message || leadError);
      return sendError(res, 500, "Failed to load operator lead.");
    }
    if (!lead) return sendError(res, 404, "Lead not found.");

    if (lead.workspace_provisioned_at && lead.conversion_status === "succeeded") {
      return res.status(200).json({
        success: true,
        idempotent: true,
        lead,
      });
    }

    const progress = normalizeProgress(lead.onboarding_progress);
    const metadata = normalizeMetadata(lead.metadata);
    const conversionMeta = normalizeMetadata(metadata.conversion);
    const ownerUserId = await resolveOwnerUserId(supabase, {
      lead,
      authUser: req.authUser,
    });

    let currentStage = mergeLifecycleStage(lead.funnel_stage || "lead_submitted", "lead_converted");
    let workingProgress = setProgressTimestamp(progress, "lead_converted_at", lead.lead_converted_at || now);
    const patch = {
      status: "active_operator",
      funnel_stage: currentStage,
      lead_converted_at: lead.lead_converted_at || now,
      conversion_status: "in_progress",
      conversion_error_reason: null,
      onboarding_progress: workingProgress,
      metadata: {
        ...metadata,
        conversion: {
          ...conversionMeta,
          startedAt: conversionMeta.startedAt || now,
          startedBy: conversionMeta.startedBy || req.authUser?.id || "legacy_admin",
        },
      },
    };

    await supabase
      .from("operator_leads")
      .update(patch)
      .eq("id", id);

    try {
      let organizationId = lead.organization_id || null;
      let organizationCreatedAt = lead.organization_created_at || null;

      if (!organizationId) {
        const { data: existingOrg, error: existingOrgError } = await supabase
          .from("organizations")
          .select("id, created_at")
          .eq("owner_email", lead.email)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existingOrgError) {
          console.error("v2-operator-leads convert org lookup failed:", existingOrgError.message || existingOrgError);
        }
        if (existingOrg?.id) {
          organizationId = existingOrg.id;
          organizationCreatedAt = existingOrg.created_at || now;
        }
      }

      if (!organizationId) {
        const slug = buildOrganizationSlug(lead);
        const orgPayload = {
          slug,
          name: `${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Fleet Operator"} Organization`,
          owner_email: lead.email,
          phone: lead.phone,
          status: "active",
          plan: "starter",
          metadata: {
            lead_id: lead.id,
            provisioning_source: "operator_lead_conversion",
          },
        };
        const { data: insertedOrg, error: insertOrgError } = await supabase
          .from("organizations")
          .insert(orgPayload)
          .select("id, created_at")
          .maybeSingle();

        if (insertOrgError) {
          const { data: slugOrg } = await supabase
            .from("organizations")
            .select("id, created_at")
            .eq("slug", slug)
            .maybeSingle();
          if (!slugOrg?.id) {
            throw new Error(insertOrgError.message || "Failed to create organization.");
          }
          organizationId = slugOrg.id;
          organizationCreatedAt = slugOrg.created_at || now;
        } else {
          organizationId = insertedOrg?.id || null;
          organizationCreatedAt = insertedOrg?.created_at || now;
        }
      }

      if (!organizationId) {
        throw new Error("Conversion failed: organization could not be resolved.");
      }

      currentStage = mergeLifecycleStage(currentStage, "organization_created");
      workingProgress = setProgressTimestamp(workingProgress, "organization_created_at", organizationCreatedAt || now);

      const ownerMembershipPayload = {
        organization_id: organizationId,
        email: lead.email,
        user_id: ownerUserId,
        role: "owner",
        status: "active",
        accepted_at: now,
        invited_at: lead.lead_submitted_at || now,
      };
      const { error: ownerError } = await supabase
        .from("organization_users")
        .upsert(ownerMembershipPayload, { onConflict: "organization_id,email" });
      if (ownerError) {
        throw new Error(ownerError.message || "Failed to create owner membership.");
      }

      currentStage = mergeLifecycleStage(currentStage, "owner_account_created");
      workingProgress = setProgressTimestamp(workingProgress, "owner_account_created_at", lead.owner_account_created_at || now);

      const workspacePayload = {
        organization_id: organizationId,
        settings: {
          notifications: {
            leadLifecycleEnabled: true,
          },
          onboarding: {
            bootstrap_state: "workspace_provisioned",
            source: "operator_lead_conversion",
            lead_id: lead.id,
            initialized_at: now,
            steps: {
              [WEBSITE_SERVICE_KEY]: {
                service_key: WEBSITE_SERVICE_KEY,
                status: "not_started",
                tracked_at: now,
                updated_at: now,
                interest_status: "not_asked",
                acceptance_status: "not_offered",
                completion_status: "not_started",
                website_status: "none",
                selected_package_code: null,
              },
            },
          },
          operational: {
            timezone: "America/Los_Angeles",
          },
        },
      };
      const { error: workspaceError } = await supabase
        .from("organization_settings")
        .upsert(workspacePayload, { onConflict: "organization_id" });
      if (workspaceError) {
        throw new Error(workspaceError.message || "Failed to provision workspace defaults.");
      }

      currentStage = mergeLifecycleStage(currentStage, "workspace_provisioned");
      workingProgress = setProgressTimestamp(workingProgress, "workspace_provisioned_at", lead.workspace_provisioned_at || now);
      workingProgress = setProgressTimestamp(workingProgress, "website_services_seeded_at", now);

      const seededUpsell = await ensureWebsiteUpsellState(supabase, {
        organizationId,
        actorId: req.authUser?.id || "legacy_admin",
        now,
        source: "operator_lead_conversion",
      });
      await syncOrganizationWebsiteOnboardingStep(supabase, {
        organizationId,
        leadId: lead.id,
        upsell: seededUpsell,
        now,
        source: "operator_lead_conversion",
      });

      const finalPatch = {
        status: "active_operator",
        organization_id: organizationId,
        funnel_stage: currentStage,
        lead_converted_at: lead.lead_converted_at || now,
        organization_created_at: lead.organization_created_at || organizationCreatedAt || now,
        owner_account_created_at: lead.owner_account_created_at || now,
        workspace_provisioned_at: lead.workspace_provisioned_at || now,
        conversion_status: "succeeded",
        conversion_error_reason: null,
        onboarding_progress: workingProgress,
        metadata: {
          ...metadata,
          conversion: {
            ...conversionMeta,
            startedAt: conversionMeta.startedAt || now,
            completedAt: now,
            completedBy: req.authUser?.id || "legacy_admin",
            organizationId,
          },
        },
      };
      const { data: updatedLead, error: updateError } = await supabase
        .from("operator_leads")
        .update(finalPatch)
        .eq("id", id)
        .select("id, status, notes, updated_at, funnel_stage, lead_submitted_at, notification_status, notification_sent_at, lead_managed_at, lead_converted_at, organization_id, organization_created_at, owner_account_created_at, workspace_provisioned_at, conversion_status, conversion_error_reason, demo_first_scheduled_at, demo_last_scheduled_at, demo_completed_at, demo_completed_outcome, demo_no_show_at, demo_follow_up_due_at, demo_owner_user_id, demo_owner_reason")
        .maybeSingle();

      if (updateError) {
        throw new Error(updateError.message || "Failed to finalize converted lead.");
      }
      await insertLeadAuditLog(supabase, {
        lead_id: id,
        event: "lead_conversion_completed",
        outcome: "success",
        metadata: {
          organizationId,
          funnelStage: currentStage,
          websiteUpsellSeeded: true,
        },
      });
      return res.status(200).json({
        success: true,
        lead: updatedLead,
      });
    } catch (error) {
      const failureReason = String(error?.message || "Lead conversion failed.").slice(0, 500);
      await supabase
        .from("operator_leads")
        .update({
          conversion_status: "failed",
          conversion_error_reason: failureReason,
        })
        .eq("id", id);
      await insertLeadAuditLog(supabase, {
        lead_id: id,
        event: "lead_conversion_failed",
        outcome: "failed",
        detail: failureReason,
        metadata: {
          requestedBy: req.authUser?.id || "legacy_admin",
        },
      });
      return sendError(res, 500, "Lead conversion failed.", { reason: failureReason });
    }
  }

  if (
    action === "website_services_get_state"
    || action === "website_services_interest"
    || action === "website_services_offer"
    || action === "website_services_accept"
    || action === "website_services_decline"
    || action === "website_services_status"
    || action === "website_services_completion"
  ) {
    const id = normalizeId(req.body?.id);
    if (!id) return sendError(res, 400, "Missing lead id.");
    if (!supabase) return sendError(res, 503, "Supabase is not configured.");

    const { data: lead, error: leadError } = await supabase
      .from("operator_leads")
      .select("id, organization_id, funnel_stage, conversion_status, onboarding_progress, status, demo_first_scheduled_at, demo_last_scheduled_at, demo_completed_at, demo_completed_outcome, demo_no_show_at, demo_follow_up_due_at, demo_owner_user_id, metadata")
      .eq("id", id)
      .maybeSingle();
    if (leadError) {
      console.error("v2-operator-leads website state lead lookup failed:", leadError.message || leadError);
      return sendError(res, 500, "Failed to load operator lead.");
    }
    if (!lead) return sendError(res, 404, "Lead not found.");
    if (!lead.organization_id) {
      return sendError(res, 400, "Website Services onboarding is available after workspace provisioning.");
    }

    const now = new Date().toISOString();
    const actorId = req.authUser?.id || "legacy_admin";
    let upsellState;
    try {
      upsellState = await ensureWebsiteUpsellState(supabase, {
        organizationId: lead.organization_id,
        actorId,
        now,
        source: "post_conversion_onboarding",
      });
    } catch (error) {
      return sendError(res, 500, "Failed to load Website Services state.", { reason: String(error?.message || error) });
    }

    if (action === "website_services_get_state") {
      try {
        const onboardingSettings = await syncOrganizationWebsiteOnboardingStep(supabase, {
          organizationId: lead.organization_id,
          leadId: lead.id,
          upsell: upsellState,
          now,
          source: "post_conversion_onboarding",
        });
        const packages = await fetchActiveWebsitePackages(supabase);
        return res.status(200).json({
          success: true,
          leadId: lead.id,
          organizationId: lead.organization_id,
          website_services: upsellState,
          onboarding: onboardingSettings?.onboarding || {},
          packages,
        });
      } catch (error) {
        return sendError(res, 500, "Failed to load onboarding state.", { reason: String(error?.message || error) });
      }
    }

    const updatePatch = {
      updated_by: actorId,
    };
    const metadataPatch = normalizeMetadata(upsellState.metadata);
    let auditEvent = "";

    if (action === "website_services_interest") {
      const nextInterestStatus = normalizeWebsiteInterestStatus(req.body?.interestStatus);
      if (!nextInterestStatus) return sendError(res, 400, "Invalid website interest status.");
      updatePatch.interest_status = nextInterestStatus;
      metadataPatch.interest_updated_at = now;
      metadataPatch.interest_updated_by = actorId;
      auditEvent = "website_services_interest_recorded";
    }

    if (action === "website_services_offer") {
      const currentAcceptance = normalizeWebsiteAcceptanceStatus(upsellState.acceptance_status) || "not_offered";
      if (currentAcceptance === "accepted") {
        return sendError(res, 409, "Cannot offer a new package after acceptance.");
      }
      if ((normalizeWebsiteInterestStatus(upsellState.interest_status) || "not_asked") === "not_interested") {
        return sendError(res, 409, "Cannot offer package when lead is marked not interested.");
      }
      const requestedPackageCode = String(req.body?.packageCode || "").trim().toLowerCase();
      if (requestedPackageCode) {
        try {
          const selectedPackage = await fetchWebsitePackageByCode(supabase, requestedPackageCode);
          if (!selectedPackage) return sendError(res, 404, "Package code not found.");
        } catch (error) {
          return sendError(res, 500, "Failed to validate package.", { reason: String(error?.message || error) });
        }
        updatePatch.selected_package_code = requestedPackageCode;
      }
      updatePatch.acceptance_status = "offered";
      updatePatch.offered_at = upsellState.offered_at || now;
      metadataPatch.offered_at = upsellState.offered_at || now;
      metadataPatch.offered_by = actorId;
      auditEvent = "website_services_package_offered";
    }

    if (action === "website_services_accept") {
      const currentAcceptance = normalizeWebsiteAcceptanceStatus(upsellState.acceptance_status) || "not_offered";
      if (currentAcceptance !== "offered" && currentAcceptance !== "accepted") {
        return sendError(res, 409, "Cannot accept package before it is offered.");
      }
      const packageCode = String(req.body?.packageCode || upsellState.selected_package_code || "").trim().toLowerCase();
      if (!packageCode) return sendError(res, 400, "Package code is required for acceptance.");
      let selectedPackage = null;
      try {
        selectedPackage = await fetchWebsitePackageByCode(supabase, packageCode);
      } catch (error) {
        return sendError(res, 500, "Failed to load package for acceptance.", { reason: String(error?.message || error) });
      }
      if (!selectedPackage) return sendError(res, 404, "Selected package is not active.");

      const acceptedAt = upsellState.accepted_at || now;
      updatePatch.acceptance_status = "accepted";
      updatePatch.selected_package_code = packageCode;
      updatePatch.accepted_at = acceptedAt;
      updatePatch.package_snapshot = {
        service_key: selectedPackage.service_key,
        package_code: selectedPackage.package_code,
        package_name: selectedPackage.package_name,
        deliverables: selectedPackage.deliverables,
        pricing_metadata: selectedPackage.pricing_metadata,
        billing_metadata: selectedPackage.billing_metadata,
        version: selectedPackage.version,
        captured_at: acceptedAt,
      };
      metadataPatch.accepted_at = acceptedAt;
      metadataPatch.accepted_by = actorId;
      auditEvent = "website_services_package_accepted";
    }

    if (action === "website_services_decline") {
      const currentAcceptance = normalizeWebsiteAcceptanceStatus(upsellState.acceptance_status) || "not_offered";
      if (currentAcceptance === "accepted") {
        return sendError(res, 409, "Cannot decline after package acceptance.");
      }
      updatePatch.acceptance_status = "declined";
      updatePatch.package_snapshot = null;
      metadataPatch.declined_at = now;
      metadataPatch.declined_by = actorId;
      auditEvent = "website_services_package_declined";
    }

    if (action === "website_services_status") {
      const nextWebsiteStatus = normalizeWebsiteStatus(req.body?.websiteStatus);
      if (!nextWebsiteStatus) return sendError(res, 400, "Invalid website status.");
      updatePatch.website_status = nextWebsiteStatus;
      metadataPatch.website_status_updated_at = now;
      metadataPatch.website_status_updated_by = actorId;
      auditEvent = "website_services_status_updated";
    }

    if (action === "website_services_completion") {
      const nextCompletionStatus = normalizeWebsiteCompletionStatus(req.body?.completionStatus || "completed");
      if (!nextCompletionStatus) return sendError(res, 400, "Invalid completion status.");
      const currentAcceptance = normalizeWebsiteAcceptanceStatus(upsellState.acceptance_status) || "not_offered";
      if (nextCompletionStatus === "completed" && currentAcceptance !== "accepted") {
        return sendError(res, 409, "Cannot mark Website Services complete before package acceptance.");
      }
      updatePatch.completion_status = nextCompletionStatus;
      if (nextCompletionStatus === "completed") {
        const completedAt = upsellState.completed_at || now;
        updatePatch.completed_at = completedAt;
        metadataPatch.completed_at = completedAt;
        metadataPatch.completed_by = actorId;
      } else {
        updatePatch.completed_at = null;
      }
      auditEvent = "website_services_completion_updated";
    }

    updatePatch.metadata = metadataPatch;
    const { data: updatedStateRaw, error: updateError } = await supabase
      .from("organization_service_upsells")
      .update(updatePatch)
      .eq("organization_id", lead.organization_id)
      .eq("service_key", WEBSITE_SERVICE_KEY)
      .select(WEBSITE_UPSELL_SELECT)
      .maybeSingle();
    if (updateError) {
      console.error("v2-operator-leads website state update failed:", updateError.message || updateError);
      return sendError(res, 500, "Failed to update Website Services state.");
    }

    const updatedState = normalizeWebsiteUpsellState(updatedStateRaw, lead.organization_id);
    let onboardingSettings = {};
    try {
      onboardingSettings = await syncOrganizationWebsiteOnboardingStep(supabase, {
        organizationId: lead.organization_id,
        leadId: lead.id,
        upsell: updatedState,
        now,
        source: "post_conversion_onboarding",
      });
    } catch (error) {
      return sendError(res, 500, "Website Services updated but onboarding sync failed.", { reason: String(error?.message || error) });
    }

    await insertLeadAuditLog(supabase, {
      lead_id: lead.id,
      event: auditEvent || "website_services_updated",
      outcome: "success",
      metadata: {
        organizationId: lead.organization_id,
        serviceKey: WEBSITE_SERVICE_KEY,
        interestStatus: updatedState.interest_status,
        acceptanceStatus: updatedState.acceptance_status,
        completionStatus: updatedState.completion_status,
        websiteStatus: updatedState.website_status,
        selectedPackageCode: updatedState.selected_package_code || null,
        actorId,
      },
    });

    return res.status(200).json({
      success: true,
      leadId: lead.id,
      organizationId: lead.organization_id,
      website_services: updatedState,
      onboarding: onboardingSettings?.onboarding || {},
    });
  }

  return sendError(res, 400, "Unsupported action.");
});
