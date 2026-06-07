// api/_sms-priority.js
// Shared SMS priority table and cross-cron cooldown gate.
//
// Every outbound SMS template key is assigned a numeric priority level
// (lower number = higher priority).  The priority table and the cross-cron
// cooldown function are shared by all SMS cron jobs:
//
//   scheduled-reminders.js  — return-window, unpaid, pickup, and completed SMS
//   maintenance-alerts.js   — vehicle service alerts
//   oil-check-cron.js       — oil-check compliance workflow
//
// PRIORITY LEVELS
//
//   1 (CRITICAL)  — Safety / financial alerts; always deliver
//                   late_fee_pending, late_grace_expired
//   2 (IMPORTANT) — Operational messages the renter needs right now
//                   late_at_return, late_warning_30min, urgent maintenance
//   3 (STANDARD)  — Scheduled reminders with flexible timing
//                   extension invites, oil checks, maintenance warns, pickup reminders
//   4 (MARKETING) — Retention / optional messages
//                   post-rental thank-you, retention campaigns
//
// ANTI-SPAM RULE (cross-cron)
//
//   Before sending any P2-P4 message, checkSmsCooldown queries sms_logs for any
//   equal-or-higher-priority SMS sent to the same booking within the priority's
//   cooldown window.  If one is found the message is blocked.
//
//   Time-critical keys (narrow return-window messages) always bypass the global
//   cooldown — they can only fire once in their ≤15-min window anyway, and their
//   triggers already carry their own smsSentAt + sms_logs deduplication.

export const PRIORITY = {
  CRITICAL:  1,
  IMPORTANT: 2,
  STANDARD:  3,
  MARKETING: 4,
};

// ─── Priority table ───────────────────────────────────────────────────────────
// Maps every SMS template key to a priority level.
// Keys not listed here default to PRIORITY.STANDARD (3).

export const SMS_PRIORITY = {
  // ── P1 — Critical ──────────────────────────────────────────────────────────
  late_fee_pending:                PRIORITY.CRITICAL,   // late fee assessment
  late_grace_expired:              PRIORITY.CRITICAL,   // renter 1 h overdue

  // ── P2 — Important ─────────────────────────────────────────────────────────
  late_at_return:                  PRIORITY.IMPORTANT,  // return time passed
  late_warning_30min:              PRIORITY.IMPORTANT,  // 30 min return warning
  maint_oil_urgent:                PRIORITY.IMPORTANT,  // oil overdue (100%+)
  maint_brakes_urgent:             PRIORITY.IMPORTANT,  // brakes overdue
  maint_tires_urgent:              PRIORITY.IMPORTANT,  // tires overdue
  maint_oil_escalate:              PRIORITY.IMPORTANT,  // oil escalation after no response
  maint_brakes_escalate:           PRIORITY.IMPORTANT,  // brakes escalation after no response
  maint_tires_escalate:            PRIORITY.IMPORTANT,  // tires escalation after no response
  MAINTENANCE_AVAILABILITY_URGENT: PRIORITY.IMPORTANT,  // generic urgent maintenance
  MAINTENANCE_AVAILABILITY_ESCALATION: PRIORITY.IMPORTANT, // final maintenance follow-up
  OIL_CHECK_FINAL:                 PRIORITY.IMPORTANT,  // final oil-check escalation
  OIL_CHECK_REMINDER:              PRIORITY.IMPORTANT,  // oil-check 24h escalation

  // ── P3 — Standard ──────────────────────────────────────────────────────────
  active_rental_1h_before_end:     PRIORITY.STANDARD,   // extension invitation
  active_rental_mid:               PRIORITY.STANDARD,   // same-day reminder (7–8 h before return)
  return_reminder_24h:             PRIORITY.STANDARD,   // 24h before return reminder
  return_expectations:             PRIORITY.STANDARD,   // 24h expectations reminder
  pickup_24h:                      PRIORITY.STANDARD,   // pickup reminder
  booking_onboarding:              PRIORITY.STANDARD,   // immediate onboarding
  extension_education:             PRIORITY.STANDARD,   // post-confirmation extension education
  payment_education:               PRIORITY.STANDARD,   // next-morning payment education
  unpaid_2h:                       PRIORITY.STANDARD,   // unpaid payment reminder
  unpaid_final:                    PRIORITY.STANDARD,   // final unpaid reminder
  maint_oil_warn:                  PRIORITY.STANDARD,   // oil due soon (80–100%)
  maint_brakes_warn:               PRIORITY.STANDARD,   // brakes due soon
  maint_tires_warn:                PRIORITY.STANDARD,   // tires due soon
  MAINTENANCE_AVAILABILITY_REQUEST: PRIORITY.STANDARD,  // generic maintenance warn
  OIL_CHECK_REQUEST:               PRIORITY.STANDARD,   // initial oil-check request
  OIL_CHECK_MERGED:                PRIORITY.STANDARD,   // merged oil-check + service
  OIL_CHECK_RISK:                  PRIORITY.STANDARD,   // avgMilesPerDay >= 150
  MAINTENANCE_REQUIRED:            PRIORITY.IMPORTANT,  // avgMilesPerDay >= 250
  HIGH_DAILY_MILEAGE:              PRIORITY.STANDARD,   // driver mileage alert (owner)

  // ── P4 — Marketing ─────────────────────────────────────────────────────────
  post_thank_you:                  PRIORITY.MARKETING,  // post-rental thank-you
  retention_7d:                    PRIORITY.MARKETING,  // day-7 retention
};

/**
 * Returns the priority level for a template key.
 * Defaults to PRIORITY.STANDARD for unknown keys.
 * @param {string} templateKey
 * @returns {number}
 */
export function getSmsPriority(templateKey) {
  return SMS_PRIORITY[templateKey] ?? PRIORITY.STANDARD;
}

// ─── Time-critical keys ───────────────────────────────────────────────────────
// These fire within narrow time windows (≤ 15 min) and must never be blocked
// by the global cross-cron cooldown.  They carry their own smsSentAt /
// sms_logs deduplication that prevents double-sends within the same window.
export const TIME_CRITICAL_KEYS = new Set([
  "late_at_return",
  "late_warning_30min",
  "late_grace_expired",
  "late_fee_pending",
]);

// ─── Cooldown windows per priority level ─────────────────────────────────────
// How long to wait after an equal-or-higher-priority send before allowing
// another message to the same booking.
const COOLDOWN_BY_PRIORITY = {
  [PRIORITY.CRITICAL]:  6  * 3_600_000,  //  6 h
  [PRIORITY.IMPORTANT]: 4  * 3_600_000,  //  4 h
  [PRIORITY.STANDARD]:  8  * 3_600_000,  //  8 h
  [PRIORITY.MARKETING]: 48 * 3_600_000,  // 48 h
};

// ─── Cross-cron cooldown check ────────────────────────────────────────────────

/**
 * Determine whether the global cross-cron SMS cooldown allows sending
 * `templateKey` to `bookingId` right now.
 *
 * Algorithm:
 *   1. If the key is TIME_CRITICAL, always allow (return-window messages must
 *      never be suppressed by cross-cron activity).
 *   2. Determine the incoming priority and the corresponding cooldown window.
 *   3. Query sms_logs for any row in that window for this booking.
 *   4. For each recent row, read the stored priority (from metadata.priority
 *      if present, else infer from the row's template_key).
 *   5. If any recent row has priority ≤ incomingPriority (equal or higher
 *      priority was already sent recently), block the send.
 *
 * Fails open: when Supabase is unavailable, always returns { allowed: true }.
 *
 * @param {object|null} sb            - Supabase admin client
 * @param {string}      bookingId     - booking_ref (bk-...) or equivalent
 * @param {string}      templateKey   - template key being evaluated
 * @returns {Promise<{ allowed: boolean, reason?: string }>}
 */
export async function checkSmsCooldown(sb, bookingId, templateKey) {
  // Time-critical return-window messages always bypass the global cooldown.
  if (TIME_CRITICAL_KEYS.has(templateKey)) {
    return { allowed: true };
  }

  if (!sb || !bookingId) return { allowed: true };

  const incomingPriority = getSmsPriority(templateKey);
  const cooldownMs       = COOLDOWN_BY_PRIORITY[incomingPriority]
    ?? COOLDOWN_BY_PRIORITY[PRIORITY.STANDARD];
  const since            = new Date(Date.now() - cooldownMs).toISOString();

  try {
    const { data: rows, error } = await sb
      .from("sms_logs")
      .select("template_key, sent_at, metadata")
      .eq("booking_id", bookingId)
      .gte("sent_at", since)
      .order("sent_at", { ascending: false });

    if (error) {
      console.warn("checkSmsCooldown: sms_logs query failed (non-fatal):", error.message);
      return { allowed: true };
    }

    for (const row of rows || []) {
      // Prefer the stored priority in metadata; fall back to inferring it from
      // the template key so older rows (before priority logging was added) still
      // participate in cooldown enforcement.
      let sentPriority;
      if (typeof row.metadata?.priority === "number") {
        sentPriority = row.metadata.priority;
      } else {
        sentPriority = getSmsPriority(row.template_key);
        if (process.env.DEBUG_SMS_PRIORITY) {
          console.debug(
            `checkSmsCooldown: inferred priority ${sentPriority} from template_key` +
            ` "${row.template_key}" (no metadata.priority on legacy row sent at ${row.sent_at})`
          );
        }
      }

      if (sentPriority <= incomingPriority) {
        const cooldownHours = Math.round(cooldownMs / 3_600_000);
        return {
          allowed: false,
          reason:  `${row.template_key} (P${sentPriority}) sent at ${row.sent_at} is within the ${cooldownHours}h cooldown for P${incomingPriority} messages`,
        };
      }
    }

    return { allowed: true };
  } catch (err) {
    console.warn("checkSmsCooldown: unexpected error (non-fatal):", err.message);
    return { allowed: true };
  }
}
