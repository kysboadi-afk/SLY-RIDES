// api/_sms-scoring.js
// Dynamic SMS scoring engine.
//
// Replaces the fixed-priority cooldown gate for P3+ messages with a
// multi-factor composite score that reflects real-time booking context.
//
// SCORE COMPONENTS (approximate range: −30 to 95)
//   URGENCY        (0–50)  How operationally critical is this message type?
//   TIME_PROXIMITY (0–25)  How close is the booking to a key event?
//   CONTEXT        (0–20)  How directly is this message tied to current booking state?
//   ANTI_SPAM      (−30–0) Penalty for recent sends to the same booking.
//                          Not applied to RETURN_RELATED_KEYS when near return.
//
// SEND DECISION
//   computeSmsScore()            → number (or CRITICAL_SCORE for CRITICAL messages)
//   computeSmsScoreWithBreakdown() → { score, breakdown } for logging/debugging
//   computeEffectiveThreshold()  → dynamic threshold based on minutesToReturn
//   selectTopCandidate()         → picks highest-scoring candidate above threshold
//   isSuppressedByProximity()    → true when a non-return message fires < 60 min from return
//
// CONTEXT BUILDING
//   fetchRecentSmsLogs()  — one Supabase query per booking; returns last-24h rows
//   buildSmsContext()     — pure function; merges sms_logs rows + base context

import { PRIORITY, getSmsPriority, TIME_CRITICAL_KEYS } from "./_sms-priority.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** A candidate must score strictly above this threshold to be sent. */
export const SCORE_THRESHOLD = 40;

/**
 * Score assigned to CRITICAL messages (TIME_CRITICAL_KEYS or PRIORITY.CRITICAL).
 * A finite high value instead of Infinity keeps logs and serialised metadata
 * readable while still guaranteeing these messages always override the threshold.
 * `selectTopCandidate` treats any score ≥ CRITICAL_SCORE as critical.
 */
export const CRITICAL_SCORE = 100;

/**
 * When minutes_to_return is below this value, only return-related messages
 * (RETURN_RELATED_KEYS) are allowed — all others are suppressed so that
 * operational return messages always take precedence.
 */
export const PROXIMITY_SUPPRESS_MIN = 60;

/**
 * Per-booking daily SMS cap.  When a booking has received this many messages
 * in the past 24 h, the anti-spam penalty reaches its maximum value of −30.
 */
export const DAILY_SMS_CAP = 3;

/** Lookback window for recent sms_logs queries and anti-spam context (24 h in ms). */
export const LOOKBACK_WINDOW_MS = 24 * 3_600_000;

/**
 * Messages directly tied to the return event.  These are exempt from the
 * proximity-suppression rule and must never be blocked when the renter is
 * close to their return time.
 */
export const RETURN_RELATED_KEYS = new Set([
  "late_at_return",
  "late_warning_30min",
  "late_grace_expired",
  "late_fee_pending",
  "active_rental_1h_before_end",  // extension invite fires at 45–60 min before return
]);

// ── Urgency scores (0–50) ─────────────────────────────────────────────────────
// How operationally critical is this message type, independent of context?

const URGENCY_SCORE = {
  // P1 — Critical financial / safety
  late_fee_pending:                   50,
  late_grace_expired:                 50,

  // P2 — Critical operational
  late_at_return:                     45,
  maint_oil_urgent:                   45,
  maint_oil_escalate:                 45,
  late_warning_30min:                 42,
  maint_brakes_urgent:                42,
  maint_brakes_escalate:              42,
  OIL_CHECK_FINAL:                    42,
  MAINTENANCE_REQUIRED:               40,
  maint_tires_urgent:                 40,
  maint_tires_escalate:               40,
  MAINTENANCE_AVAILABILITY_URGENT:    40,
  MAINTENANCE_AVAILABILITY_ESCALATION: 40,
  OIL_CHECK_REMINDER:                 40,

  // P3 — Standard operational
  unpaid_final:                       38,
  active_rental_1h_before_end:        36,
  active_rental_mid:                  34,  // same-day reminder, ~7–8 h before return
  return_reminder_24h:                34,  // 24h-before-return reminder
  return_expectations:                34,  // 24h expectations reminder
  pickup_24h:                         35,
  unpaid_2h:                          33,
  OIL_CHECK_MERGED:                   33,
  maint_oil_warn:                     32,
  OIL_CHECK_REQUEST:                  32,
  MAINTENANCE_AVAILABILITY_REQUEST:   30,
  maint_brakes_warn:                  30,
  OIL_CHECK_RISK:                     30,
  maint_tires_warn:                   28,
  HIGH_DAILY_MILEAGE:                 26,

  // P4 — Marketing
  post_thank_you:                     15,
  retention_7d:                        8,
};

const DEFAULT_URGENCY_SCORE = 25;

// ── Context relevance scores (0–20) ───────────────────────────────────────────
// How directly is this message tied to the current booking state?
// Raised cap (15 → 20) to give context stronger relative weight against urgency.

const CONTEXT_SCORE = {
  // Directly tied to current critical booking state (top tier: 17–20)
  late_fee_pending:                   20,
  late_grace_expired:                 20,
  late_at_return:                     20,
  maint_oil_urgent:                   18,
  maint_oil_escalate:                 18,
  OIL_CHECK_FINAL:                    18,
  late_warning_30min:                 17,
  maint_brakes_urgent:                17,
  maint_brakes_escalate:              17,
  OIL_CHECK_REMINDER:                 17,
  MAINTENANCE_REQUIRED:               16,
  unpaid_final:                       17,
  maint_tires_urgent:                 16,
  maint_tires_escalate:               16,
  MAINTENANCE_AVAILABILITY_URGENT:    16,
  MAINTENANCE_AVAILABILITY_ESCALATION: 16,

  // Tied to booking timeline (mid tier: 12–16)
  active_rental_1h_before_end:        16,
  active_rental_mid:                  15,  // same-day reminder, ~7–8 h before return
  return_reminder_24h:                14,  // 24h-before-return reminder
  return_expectations:                14,  // 24h expectations reminder
  OIL_CHECK_MERGED:                   15,
  pickup_24h:                         14,
  unpaid_2h:                          14,
  maint_oil_warn:                     14,
  OIL_CHECK_REQUEST:                  14,
  MAINTENANCE_AVAILABILITY_REQUEST:   13,
  maint_brakes_warn:                  13,
  OIL_CHECK_RISK:                     13,
  maint_tires_warn:                   12,
  HIGH_DAILY_MILEAGE:                 10,

  // Low direct relevance to current state (low tier: 4–8)
  post_thank_you:                      8,
  retention_7d:                        4,
};

const DEFAULT_CONTEXT_SCORE = 12;

// ── Scoring component functions ───────────────────────────────────────────────

/**
 * Urgency component (0–50).
 * Reflects the inherent operational importance of the message type.
 * @param {string} templateKey
 * @returns {number}
 */
export function computeUrgencyScore(templateKey) {
  return URGENCY_SCORE[templateKey] ?? DEFAULT_URGENCY_SCORE;
}

/**
 * Context relevance component (0–20).
 * Reflects how directly this message is tied to the current booking state.
 * @param {string} templateKey
 * @returns {number}
 */
export function computeContextScore(templateKey) {
  return CONTEXT_SCORE[templateKey] ?? DEFAULT_CONTEXT_SCORE;
}

/**
 * Time-proximity component (0–25).
 *
 * minutesToReturn scoring:
 *   < 0   (overdue)   → 25
 *   ≤  60 (within 1h) → 20
 *   ≤ 120 (within 2h) → 15
 *   ≤ 240 (within 4h) → 10
 *   ≤1440 (within 24h)→  5
 *   >1440             →  0
 *   undefined         →  0
 *
 * A small +3 recency bonus applies when no SMS has been sent in the past 8 h,
 * signalling that the renter has been quiet and may be more receptive.
 *
 * @param {object} ctx
 * @param {number} [ctx.minutesToReturn]     - signed; negative means overdue
 * @param {number} [ctx.minutesSinceLastSms] - minutes since any SMS was sent
 * @returns {number}
 */
export function computeTimeProximityScore(ctx = {}) {
  const { minutesToReturn, minutesSinceLastSms } = ctx;
  let score = 0;

  if (minutesToReturn !== undefined) {
    if      (minutesToReturn < 0)     score += 25;
    else if (minutesToReturn <=   60) score += 20;
    else if (minutesToReturn <=  120) score += 15;
    else if (minutesToReturn <=  240) score += 10;
    else if (minutesToReturn <= 1440) score +=  5;
  }

  // Recency signal: no message for 8+ h → small engagement nudge
  if (minutesSinceLastSms !== undefined && minutesSinceLastSms >= 480) {
    score += 3;
  }

  return Math.min(25, score);
}

/**
 * Anti-spam penalty (−30 to 0).
 *
 * Three overlapping signals:
 *   recentSmsCount24h         — volume penalty for today's send count
 *   minutesSinceLastSms       — burst penalty when last message was < 30 min ago
 *   sameTemplateRecentMinutes — heavy repeat penalty for the same template
 *
 * @param {object} ctx
 * @param {number} [ctx.recentSmsCount24h=0]
 * @param {number} [ctx.minutesSinceLastSms]
 * @param {number} [ctx.sameTemplateRecentMinutes]
 * @returns {number}
 */
export function computeAntiSpamPenalty(ctx = {}) {
  const {
    recentSmsCount24h       = 0,
    minutesSinceLastSms,
    sameTemplateRecentMinutes,
  } = ctx;

  let penalty = 0;

  // Volume penalty (daily cap is DAILY_SMS_CAP)
  if      (recentSmsCount24h >= DAILY_SMS_CAP) penalty -= 30;
  else if (recentSmsCount24h === 2)            penalty -= 15;
  else if (recentSmsCount24h === 1)            penalty -=  5;

  // Burst penalty: cross-template send within 30 min
  if (minutesSinceLastSms !== undefined && minutesSinceLastSms < 30) {
    penalty -= 15;
  }

  // Same-template repeat penalty
  if (sameTemplateRecentMinutes !== undefined) {
    if      (sameTemplateRecentMinutes <  60) penalty -= 30;
    else if (sameTemplateRecentMinutes < 240) penalty -= 20;
    else if (sameTemplateRecentMinutes < 480) penalty -= 10;
  }

  return Math.max(-30, penalty);
}

// ── Composite score ───────────────────────────────────────────────────────────

/**
 * Compute the full composite score and a component breakdown for a candidate
 * message.  Prefer this over computeSmsScore() when the breakdown is needed
 * for logging or debugging — the score field is identical to computeSmsScore().
 *
 * CRITICAL messages return `{ score: CRITICAL_SCORE, breakdown: { isCritical: true, … } }`.
 * Using a finite capped value instead of Infinity keeps sms_logs.metadata readable.
 *
 * Anti-spam safety: the spam penalty is zeroed for RETURN_RELATED_KEYS when the
 * booking is near its return time (minutesToReturn < PROXIMITY_SUPPRESS_MIN).
 * CRITICAL messages and return-related messages must never be suppressed by spam volume.
 *
 * @param {string} templateKey
 * @param {object} ctx          - context from buildSmsContext() + caller-supplied fields
 * @returns {{ score: number, breakdown: { urgency: number, proximity: number, context: number, spam: number, isCritical: boolean } }}
 */
export function computeSmsScoreWithBreakdown(templateKey, ctx = {}) {
  const isCritical = TIME_CRITICAL_KEYS.has(templateKey) ||
    getSmsPriority(templateKey) === PRIORITY.CRITICAL;

  if (isCritical) {
    return {
      score:     CRITICAL_SCORE,
      breakdown: { urgency: CRITICAL_SCORE, proximity: 0, context: 0, spam: 0, isCritical: true },
    };
  }

  const urgency   = computeUrgencyScore(templateKey);
  const proximity = computeTimeProximityScore(ctx);
  const context   = computeContextScore(templateKey);

  // Anti-spam must not suppress return-related messages when the booking is
  // close to its return time — those messages must always remain eligible.
  const isNearReturn = ctx.minutesToReturn !== undefined &&
    ctx.minutesToReturn < PROXIMITY_SUPPRESS_MIN;
  const spam = (RETURN_RELATED_KEYS.has(templateKey) && isNearReturn)
    ? 0
    : computeAntiSpamPenalty(ctx);

  const score = urgency + proximity + context + spam;
  return { score, breakdown: { urgency, proximity, context, spam, isCritical: false } };
}

/**
 * Compute the composite score for a candidate message.
 * For per-decision logging with component details, use computeSmsScoreWithBreakdown().
 *
 * @param {string} templateKey
 * @param {object} ctx          - context from buildSmsContext() + caller-supplied fields
 * @returns {number}            - composite score, or CRITICAL_SCORE for CRITICAL messages
 */
export function computeSmsScore(templateKey, ctx = {}) {
  return computeSmsScoreWithBreakdown(templateKey, ctx).score;
}

/**
 * Compute the effective send threshold for a booking based on its time context.
 *
 * A lower threshold is used when the booking is near its return time (increasing
 * the chance of relevant messages getting through), while an early-rental booking
 * uses a stricter threshold to reduce non-urgent sends.
 *
 * minutesToReturn thresholds:
 *   < 60 min (near return)      → 30
 *   < 120 min (approaching)     → 35
 *   < 1440 min (active rental)  → 40  (default SCORE_THRESHOLD)
 *   ≥ 1440 min (early rental)   → 50
 *   undefined                   → 40  (default SCORE_THRESHOLD)
 *
 * @param {object} ctx
 * @param {number} [ctx.minutesToReturn]
 * @returns {number}
 */
export function computeEffectiveThreshold(ctx = {}) {
  const { minutesToReturn } = ctx;
  if (minutesToReturn === undefined) return SCORE_THRESHOLD;
  if (minutesToReturn <   60)        return 30;
  if (minutesToReturn <  120)        return 35;
  if (minutesToReturn < 1440)        return SCORE_THRESHOLD;
  return 50; // early rental — stricter gate
}

// ── Safety check ──────────────────────────────────────────────────────────────

/**
 * Returns true when a message should be suppressed because the booking is
 * within PROXIMITY_SUPPRESS_MIN minutes of its return time.
 *
 * Exempt:
 *   - Messages with no minutesToReturn context (undefined)
 *   - Messages at or beyond the proximity window (≥ PROXIMITY_SUPPRESS_MIN)
 *   - All TIME_CRITICAL_KEYS
 *   - All RETURN_RELATED_KEYS (extension invite, return-time alerts)
 *
 * @param {string} templateKey
 * @param {object} ctx
 * @param {number} [ctx.minutesToReturn]
 * @returns {boolean}
 */
export function isSuppressedByProximity(templateKey, ctx = {}) {
  const { minutesToReturn } = ctx;
  if (minutesToReturn === undefined) return false;
  if (minutesToReturn >= PROXIMITY_SUPPRESS_MIN) return false;
  if (TIME_CRITICAL_KEYS.has(templateKey)) return false;
  if (RETURN_RELATED_KEYS.has(templateKey)) return false;
  return true;
}

// ── Candidate selection ───────────────────────────────────────────────────────

/**
 * Given a list of scored candidates, return the single best one to send.
 *
 * Rules:
 *   1. CRITICAL candidates (score ≥ CRITICAL_SCORE) always win regardless of others.
 *   2. Among non-critical candidates, the highest score wins if score > threshold.
 *   3. Returns null when no candidate passes the threshold.
 *
 * The `threshold` parameter is optional and defaults to SCORE_THRESHOLD.
 * Pass the result of computeEffectiveThreshold(ctx) for context-aware filtering.
 *
 * @param {Array<{templateKey: string, score: number, [key: string]: *}>} candidates
 * @param {number} [threshold=SCORE_THRESHOLD]
 * @returns {{ templateKey: string, score: number } | null}
 */
export function selectTopCandidate(candidates, threshold = SCORE_THRESHOLD) {
  if (!candidates || candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => b.score - a.score);

  const top = sorted[0];
  if (top.score >= CRITICAL_SCORE || top.score > threshold) return top;
  return null;
}

// ── Context helpers ───────────────────────────────────────────────────────────

/**
 * Build the scoring context for a single candidate template by merging
 * the caller-supplied base context with anti-spam signals derived from
 * a pre-fetched sms_logs result set.
 *
 * This is a pure function — no I/O.  Call fetchRecentSmsLogs() once per
 * booking and then call buildSmsContext() for each candidate template.
 *
 * @param {string} templateKey  - the candidate template being evaluated
 * @param {Array}  recentRows   - rows from sms_logs for the past 24 h
 *                                each: { template_key: string, sent_at: string }
 * @param {object} baseCtx      - caller-provided signals, e.g.:
 *                                { minutesToReturn, daysSincePickup }
 * @returns {object}            - full scoring context ready for computeSmsScore()
 */
export function buildSmsContext(templateKey, recentRows, baseCtx = {}) {
  const now  = Date.now();
  const rows = recentRows || [];

  const recentSmsCount24h = rows.length;

  let minutesSinceLastSms;
  if (rows.length > 0) {
    minutesSinceLastSms = (now - new Date(rows[0].sent_at).getTime()) / 60_000;
  }

  let sameTemplateRecentMinutes;
  const sameRow = rows.find((r) => r.template_key === templateKey);
  if (sameRow) {
    sameTemplateRecentMinutes = (now - new Date(sameRow.sent_at).getTime()) / 60_000;
  }

  return {
    ...baseCtx,
    recentSmsCount24h,
    minutesSinceLastSms,
    sameTemplateRecentMinutes,
  };
}

/**
 * Fetch the last 24 h of sms_logs rows for a booking.
 *
 * Returns an empty array on any Supabase error so scoring always falls back
 * to an optimistic (spam-free) context rather than blocking the send.
 * One query covers all candidate templates for the booking.
 *
 * @param {object|null} sb        - Supabase admin client
 * @param {string}      bookingId - booking_ref (bk-...)
 * @returns {Promise<Array<{template_key: string, sent_at: string}>>}
 */
export async function fetchRecentSmsLogs(sb, bookingId) {
  if (!sb || !bookingId) return [];
  try {
    const since24h = new Date(Date.now() - LOOKBACK_WINDOW_MS).toISOString();
    const { data, error } = await sb
      .from("sms_logs")
      .select("template_key, sent_at")
      .eq("booking_id", bookingId)
      .gte("sent_at", since24h)
      .order("sent_at", { ascending: false });

    if (error) {
      console.warn("fetchRecentSmsLogs: sms_logs query failed (non-fatal):", error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.warn("fetchRecentSmsLogs: unexpected error (non-fatal):", err.message);
    return [];
  }
}
