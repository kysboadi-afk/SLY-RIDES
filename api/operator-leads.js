import { getSupabaseAdmin } from "./_supabase.js";
import nodemailer from "nodemailer";
import crypto from "node:crypto";

const EXACT_ALLOWED_ORIGINS = new Set([
  "https://www.slytrans.com",
  "https://slytrans.com",
  "https://slycarrentals.com",
  "https://www.slycarrentals.com",
  "https://admin.slycarrentals.com",
]);

function normalizeText(value, maxLength = 5000) {
  return String(value || "").trim().slice(0, maxLength);
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (EXACT_ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    const host = String(url.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return true;
    return host.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

function setCors(origin, res) {
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function splitLeadName(name) {
  const trimmed = normalizeText(name, 160);
  if (!trimmed) return { firstName: "", lastName: "" };
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "Lead" };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function buildSubmissionHash(parts = []) {
  return crypto.createHash("sha256")
    .update(parts.map((item) => String(item || "")).join("|"))
    .digest("hex");
}

function isMissingColumnError(error, columnName) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes(String(columnName || "").toLowerCase()) || message.includes("schema cache");
}

function normalizeProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function normalizeFunnelTimestamps(progress) {
  const source = progress?.funnel_timestamps;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return { ...source };
}

function withFunnelTimestamp(progress, key, value) {
  const next = normalizeProgress(progress);
  const timestamps = normalizeFunnelTimestamps(next);
  if (!timestamps[key]) timestamps[key] = value;
  next.funnel_timestamps = timestamps;
  return next;
}

function withNotificationSnapshot(progress, details) {
  const next = normalizeProgress(progress);
  next.notification = {
    ...(next.notification && typeof next.notification === "object" ? next.notification : {}),
    ...details,
  };
  return next;
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
  console.log(`[operator-leads] ${label} start`, context);
  try {
    const result = await operation;
    if (result?.error) {
      console.error(`[operator-leads] ${label} failed`, {
        ...context,
        error: formatSupabaseError(result.error),
      });
    } else {
      console.log(`[operator-leads] ${label} success`, {
        ...context,
        status: result?.status ?? null,
        statusText: result?.statusText ?? null,
        count: result?.count ?? null,
        data: summarizeSupabaseData(result?.data),
      });
    }
    return result;
  } catch (error) {
    console.error(`[operator-leads] ${label} threw`, {
      ...context,
      error: formatSupabaseError(error),
    });
    throw error;
  }
}

function buildNotificationTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function dispatchLeadNotification({ leadId, firstName, lastName, email, phone, fleetSize, priority, message, source }) {
  const channel = "email";
  const sentAt = new Date().toISOString();
  const notifyTo = process.env.FLEET_CONTROL_LEAD_NOTIFY_EMAIL || process.env.OWNER_EMAIL || process.env.SMTP_USER || "";
  const transporter = buildNotificationTransport();
  if (!notifyTo || !transporter) {
    return {
      channel,
      status: "failed",
      sentAt: null,
      errorReason: "Notification email transport is not configured.",
    };
  }

  try {
    await transporter.sendMail({
      from: `"Fleet Control Leads" <${process.env.SMTP_USER}>`,
      to: notifyTo,
      subject: `🚘 Fleet Control lead submitted [${leadId}]`,
      replyTo: email,
      text: [
        "New Fleet Control lead submitted.",
        "",
        `Lead ID     : ${leadId}`,
        `Name        : ${[firstName, lastName].filter(Boolean).join(" ") || "Unknown"}`,
        `Email       : ${email}`,
        `Phone       : ${phone}`,
        `Fleet Size  : ${fleetSize}`,
        `Priority    : ${priority}`,
        `Source      : ${source}`,
        `Message     : ${message}`,
      ].join("\n"),
    });
    return {
      channel,
      status: "sent",
      sentAt,
      errorReason: null,
    };
  } catch (err) {
    return {
      channel,
      status: "failed",
      sentAt: null,
      errorReason: String(err?.message || "Unknown notification dispatch error").slice(0, 500),
    };
  }
}

async function writeLeadAuditLog(supabase, { leadId, event, outcome = "success", channel = null, detail = null, metadata = {} }) {
  try {
    const result = await logSupabaseCall("audit_log_insert", supabase
      .from("operator_lead_audit_logs")
      .insert({
        lead_id: leadId,
        event,
        outcome,
        channel,
        detail,
        metadata,
      }), {
      table: "operator_lead_audit_logs",
      leadId,
      event,
      outcome,
    });
    if (result?.error) {
      console.warn("operator-leads audit insert skipped:", result.error.message || result.error);
    }
  } catch (error) {
    console.warn("operator-leads audit insert skipped:", error?.message || error);
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  setCors(origin, res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  console.log("[operator-leads] DIAGNOSTIC START");
  console.log("[operator-leads] COMMIT", process.env.VERCEL_GIT_COMMIT_SHA || null);
  console.log("[operator-leads] URL", process.env.SUPABASE_URL || null);

  const {
    name,
    email,
    phone,
    fleetSize,
    priority,
    message,
    honeypot,
    source,
  } = req.body || {};

  if (honeypot) {
    return res.status(400).json({ error: "Submission rejected." });
  }

  const { firstName, lastName } = splitLeadName(name);
  const normalizedEmail = normalizeText(email, 320).toLowerCase();
  const normalizedPhone = normalizeText(phone, 64);
  const normalizedFleetSize = normalizeText(fleetSize, 64);
  const normalizedPriority = normalizeText(priority, 160);
  const normalizedMessage = normalizeText(message, 4000);
  const normalizedSource = normalizeText(source, 80) || "fleet_control_early_access";

  if (!firstName || !normalizedEmail || !normalizedPhone || !normalizedFleetSize || !normalizedPriority || !normalizedMessage) {
    return res.status(400).json({ error: "Missing required fields: name, email, phone, fleetSize, priority, message." });
  }

  if (!looksLikeEmail(normalizedEmail)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  const supabaseUrlPresent = Boolean(process.env.SUPABASE_URL);
  const supabaseServiceRoleKeyPresent = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.info("operator-leads Supabase env presence", {
    supabaseUrlPresent,
    supabaseServiceRoleKeyPresent,
    appEnv: process.env.APP_ENV || null,
  });

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(503).json({
      error: "Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to your Vercel environment variables.",
    });
  }
  const { data: roleCheckData, error: roleCheckError } = await supabase.rpc("current_role_check");
  console.log("[operator-leads] ROLE CHECK", {
    data: roleCheckData ?? null,
    error: roleCheckError ? formatSupabaseError(roleCheckError) : null,
  });

  const notes = normalizeText(
    [
      `priority=${normalizedPriority}`,
      `message=${normalizedMessage}`,
      `fleet_size_label=${normalizedFleetSize}`,
      `origin=${origin || ""}`,
      `user_agent=${req.headers["user-agent"] || ""}`,
    ].join(" | "),
    4000
  );
  const submissionHash = buildSubmissionHash([
    normalizedEmail,
    normalizedPhone,
    normalizedFleetSize,
    normalizedPriority,
    normalizedMessage,
    normalizedSource,
  ]);
  const leadSubmittedAt = new Date().toISOString();
  const duplicateWindow = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  let duplicateLead = null;
  const duplicateLookup = await logSupabaseCall("duplicate_lookup", supabase
    .from("operator_leads")
    .select("id, status, created_at, funnel_stage, onboarding_progress, notification_status, notification_channel, notification_sent_at, notification_error_reason, notification_attempt_count")
    .eq("submission_hash", submissionHash)
    .gte("created_at", duplicateWindow)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle(), {
    table: "operator_leads",
    submissionHash,
    duplicateWindow,
  });

  if (duplicateLookup.error && !isMissingColumnError(duplicateLookup.error, "submission_hash")) {
    console.error("operator-leads duplicate lookup failed:", duplicateLookup.error.message || duplicateLookup.error);
  } else {
    duplicateLead = duplicateLookup.data || null;
  }

  if (duplicateLead) {
    if (duplicateLead.notification_status === "sent" || duplicateLead.notification_status === "queued") {
      await writeLeadAuditLog(supabase, {
        leadId: duplicateLead.id,
        event: "notification_dispatch_skipped_duplicate",
        outcome: "success",
        channel: duplicateLead.notification_channel || "email",
        detail: "Submission retry detected; duplicate notification avoided.",
        metadata: { submissionHash },
      });
      return res.status(200).json({
        success: true,
        duplicate: true,
        leadId: duplicateLead.id,
        status: duplicateLead.status || "new_lead",
        funnelStage: duplicateLead.funnel_stage || "lead_submitted",
        createdAt: duplicateLead.created_at || null,
        notification: {
          status: duplicateLead.notification_status || "queued",
          channel: duplicateLead.notification_channel || "email",
          sentAt: duplicateLead.notification_sent_at || null,
          errorReason: duplicateLead.notification_error_reason || null,
        },
        message: "Lead already received. Existing notification outcome returned.",
      });
    }

    const retryNotification = await dispatchLeadNotification({
      leadId: duplicateLead.id,
      firstName,
      lastName,
      email: normalizedEmail,
      phone: normalizedPhone,
      fleetSize: normalizedFleetSize,
      priority: normalizedPriority,
      message: normalizedMessage,
      source: normalizedSource,
    });
    const retryAttemptAt = new Date().toISOString();
    const retryProgress = withNotificationSnapshot(
      retryNotification.status === "sent"
        ? withFunnelTimestamp(duplicateLead.onboarding_progress, "notification_sent_at", retryNotification.sentAt)
        : normalizeProgress(duplicateLead.onboarding_progress),
      {
        status: retryNotification.status,
        channel: retryNotification.channel,
        errorReason: retryNotification.errorReason,
        attemptedAt: retryAttemptAt,
        sentAt: retryNotification.sentAt || null,
      }
    );
    const retryPatch = {
      notification_status: retryNotification.status,
      notification_channel: retryNotification.channel,
      notification_last_attempt_at: retryAttemptAt,
      notification_sent_at: retryNotification.sentAt || null,
      notification_error_reason: retryNotification.errorReason,
      notification_attempt_count: Number(duplicateLead.notification_attempt_count || 0) + 1,
      onboarding_progress: retryProgress,
    };
    if (retryNotification.status === "sent") {
      retryPatch.funnel_stage = "notification_sent";
    }
    const { data: retriedLead } = await logSupabaseCall("duplicate_notification_update", supabase
      .from("operator_leads")
      .update(retryPatch)
      .eq("id", duplicateLead.id)
      .select("id, status, created_at, funnel_stage, notification_status, notification_channel, notification_sent_at, notification_error_reason")
      .maybeSingle(), {
      table: "operator_leads",
      leadId: duplicateLead.id,
      patchKeys: Object.keys(retryPatch),
    });
    await writeLeadAuditLog(supabase, {
      leadId: duplicateLead.id,
      event: "notification_dispatch_retry",
      outcome: retryNotification.status === "sent" ? "success" : "failed",
      channel: retryNotification.channel,
      detail: retryNotification.errorReason,
      metadata: { submissionHash, attemptAt: retryAttemptAt },
    });
    const retryResponseLead = retriedLead || duplicateLead;
    return res.status(200).json({
      success: true,
      duplicate: true,
      retried: true,
      leadId: retryResponseLead.id,
      status: retryResponseLead.status || "new_lead",
      funnelStage: retryResponseLead.funnel_stage || "lead_submitted",
      createdAt: retryResponseLead.created_at || null,
      notification: {
        status: retryResponseLead.notification_status || retryNotification.status,
        channel: retryResponseLead.notification_channel || retryNotification.channel || "email",
        sentAt: retryResponseLead.notification_sent_at || retryNotification.sentAt || null,
        errorReason: retryResponseLead.notification_error_reason || retryNotification.errorReason || null,
      },
      message: "Lead already exists. Notification outcome updated.",
    });
  }

  const payload = {
    first_name: firstName,
    last_name: lastName,
    email: normalizedEmail,
    phone: normalizedPhone,
    fleet_size: normalizedFleetSize,
    source: normalizedSource,
    notes,
    submission_hash: submissionHash,
    funnel_stage: "lead_submitted",
    lead_submitted_at: leadSubmittedAt,
    notification_status: "queued",
    notification_channel: "email",
    notification_attempt_count: 0,
    conversion_status: "not_started",
    onboarding_progress: withFunnelTimestamp({}, "lead_submitted_at", leadSubmittedAt),
  };

  const { data, error } = await logSupabaseCall("lead_insert", supabase
    .from("operator_leads")
    .insert(payload)
    .select("id, status, created_at, funnel_stage, onboarding_progress, notification_status, notification_channel, notification_sent_at, notification_error_reason, notification_attempt_count")
    .single(), {
    table: "operator_leads",
    payloadKeys: Object.keys(payload),
    source: normalizedSource,
    submissionHash,
  });

  if (error) {
    console.error("operator-leads insert failed:", {
      code: error.code || null,
      message: error.message || String(error),
      details: error.details || null,
      hint: error.hint || null,
      payloadKeys: Object.keys(payload),
    });
    return res.status(500).json({
      error: "Failed to store operator lead",
      details: error?.message || null,
      code: error?.code || null,
      hint: error?.hint || null,
    });
  }

  await writeLeadAuditLog(supabase, {
    leadId: data.id,
    event: "lead_submitted",
    outcome: "success",
    metadata: {
      source: normalizedSource,
      submissionHash,
    },
  });

  const notification = await dispatchLeadNotification({
    leadId: data.id,
    firstName,
    lastName,
    email: normalizedEmail,
    phone: normalizedPhone,
    fleetSize: normalizedFleetSize,
    priority: normalizedPriority,
    message: normalizedMessage,
    source: normalizedSource,
  });

  const notificationAttemptAt = new Date().toISOString();
  const nextProgress = withNotificationSnapshot(
    notification.status === "sent"
      ? withFunnelTimestamp(data.onboarding_progress, "notification_sent_at", notification.sentAt)
      : normalizeProgress(data.onboarding_progress),
    {
      status: notification.status,
      channel: notification.channel,
      errorReason: notification.errorReason,
      attemptedAt: notificationAttemptAt,
      sentAt: notification.sentAt || null,
    }
  );
  const notificationPatch = {
    notification_status: notification.status,
    notification_channel: notification.channel,
    notification_last_attempt_at: notificationAttemptAt,
    notification_sent_at: notification.sentAt || null,
    notification_error_reason: notification.errorReason,
    notification_attempt_count: Number(data.notification_attempt_count || 0) + 1,
    onboarding_progress: nextProgress,
  };
  if (notification.status === "sent") {
    notificationPatch.funnel_stage = "notification_sent";
  }

  const { data: updatedLead, error: updateError } = await logSupabaseCall("notification_update", supabase
    .from("operator_leads")
    .update(notificationPatch)
    .eq("id", data.id)
    .select("id, status, created_at, funnel_stage, notification_status, notification_channel, notification_sent_at, notification_error_reason")
    .maybeSingle(), {
    table: "operator_leads",
    leadId: data.id,
    patchKeys: Object.keys(notificationPatch),
    notificationStatus: notification.status,
  });

  if (updateError) {
    console.error("operator-leads notification update failed:", updateError.message || updateError);
  }

  await writeLeadAuditLog(supabase, {
    leadId: data.id,
    event: "notification_dispatch",
    outcome: notification.status === "sent" ? "success" : "failed",
    channel: notification.channel,
    detail: notification.errorReason,
    metadata: {
      submissionHash,
      attemptAt: notificationAttemptAt,
    },
  });

  const responseLead = updatedLead || data;
  return res.status(200).json({
    success: true,
    leadId: responseLead?.id || null,
    status: responseLead?.status || "new_lead",
    funnelStage: responseLead?.funnel_stage || "lead_submitted",
    createdAt: responseLead?.created_at || null,
    notification: {
      status: responseLead?.notification_status || notification.status || "queued",
      channel: responseLead?.notification_channel || notification.channel || "email",
      sentAt: responseLead?.notification_sent_at || notification.sentAt || null,
      errorReason: responseLead?.notification_error_reason || notification.errorReason || null,
    },
    message: "Thanks — your request was received. We will reach out shortly with the next step.",
  });
}
