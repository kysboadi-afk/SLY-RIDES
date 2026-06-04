// api/ledger-backfill.js
// Phase 4.1 — Historical ledger backfill.
//
// Replays financial source tables into renter_balance_ledger for any bookings
// that predate the live ledger wiring (Phase 3).
//
// POST /api/ledger-backfill  (admin secret required)
//
// Body:
//   { secret, action: "preview"|"run", cursor_booking_ref?, limit?, run_id?,
//     booking_ref?, renter_email? }
//
// action:
//   preview – dry-run: returns what WOULD be written without writing anything
//   run     – live writes; idempotent (safe to re-run with same run_id)
//
// Scoping (optional — omit both to process all bookings):
//   booking_ref   – restrict backfill to a single booking (exact match on
//                   booking_id across all three source tables).
//   renter_email  – restrict backfill to all bookings belonging to one renter
//                   (looks up matching booking_ids from the bookings table via
//                   customer_email, then filters all three source tables to
//                   those booking_ids).  Useful for backfilling a renter who
//                   made partial or full payments before ledger wiring.
//
// Source replay order:
//   1. revenue_records  WHERE payment_intent_id IS NOT NULL
//      → addLedgerPayment(source_type='stripe_payment', source_id=pi_id)
//      → preserves revenue_records.created_at as the ledger row's created_at
//   2. charges          WHERE stripe_payment_intent_id IS NOT NULL
//      → addLedgerPayment(source_type='stripe_payment', source_id=pi_id)
//      → uses charges.created_at
//   3. tickets          WHERE payment_intent_id IS NOT NULL
//      → addLedgerPayment(source_type='stripe_payment', source_id=pi_id)
//      → uses tickets.created_at
//
// Idempotency: the ledger has a UNIQUE index on (source_type, source_id) so
// duplicate inserts silently resolve to the existing row.  Re-running with
// the same run_id skips rows already present in ledger_backfill_log.
//
// Resumable cursor: pass cursor_booking_ref to start processing after a given
// booking_ref (alphabetical ordering).  Returns next_cursor for the next call.
// cursor_booking_ref is ignored when booking_ref or renter_email is supplied.

import { getSupabaseAdmin } from "./_supabase.js";
import { addLedgerPayment } from "./_renter-balance-ledger.js";
import { isAdminAuthorized } from "./_admin-auth.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const body = req.body || {};
  const { secret, action = "preview", cursor_booking_ref, limit, run_id: inputRunId, booking_ref, renter_email } = body;

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!["preview", "run"].includes(action)) {
    return res.status(400).json({ error: 'action must be "preview" or "run"' });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database unavailable. Please try again." });
  }

  const isDryRun = action === "preview";
  const batchLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  // Stable run_id — callers may supply one for idempotent resume behaviour.
  const runId = String(inputRunId || `backfill-${Date.now()}`).trim().slice(0, 80);

  // ── Renter / booking scoping ─────────────────────────────────────────────────
  // When booking_ref is supplied, restrict all source queries to that one booking.
  // When renter_email is supplied, look up all booking_ids for that renter first.
  let scopeBookingIds = null; // null = no restriction (process all)

  if (booking_ref && typeof booking_ref === "string" && booking_ref.trim()) {
    scopeBookingIds = [booking_ref.trim()];
  } else if (renter_email && typeof renter_email === "string" && renter_email.trim()) {
    const email = renter_email.trim().toLowerCase();
    const { data: bkRows, error: bkErr } = await sb
      .from("bookings")
      .select("booking_ref")
      .ilike("customer_email", email);

    if (bkErr) {
      return res.status(500).json({ error: `Could not look up renter bookings: ${bkErr.message}` });
    }

    if (!bkRows || bkRows.length === 0) {
      return res.status(200).json({ ok: true, message: "No bookings found for renter_email", renter_email: email, written: 0, skipped: 0, errors: 0 });
    }

    scopeBookingIds = bkRows.map((r) => r.booking_ref).filter(Boolean);
  }

  const stats = {
    run_id: runId,
    action,
    dry_run: isDryRun,
    scope: scopeBookingIds ? { booking_ids: scopeBookingIds } : null,
    previewed: 0,
    written: 0,
    skipped: 0,
    errors: 0,
    next_cursor: null,
    sources: {
      revenue_records: { previewed: 0, written: 0, skipped: 0, errors: 0 },
      charges:         { previewed: 0, written: 0, skipped: 0, errors: 0 },
      tickets:         { previewed: 0, written: 0, skipped: 0, errors: 0 },
    },
  };

  // ── 1. revenue_records ──────────────────────────────────────────────────────
  try {
    let rrQuery = sb
      .from("revenue_records")
      .select("id, booking_id, payment_intent_id, gross_amount, created_at, type")
      .not("payment_intent_id", "is", null)
      .order("booking_id", { ascending: true });

    if (scopeBookingIds) {
      rrQuery = rrQuery.in("booking_id", scopeBookingIds);
    } else {
      rrQuery = rrQuery.limit(batchLimit);
      if (cursor_booking_ref) {
        rrQuery = rrQuery.gt("booking_id", cursor_booking_ref);
      }
    }

    const { data: rrRows, error: rrErr } = await rrQuery;
    if (rrErr) throw new Error(`revenue_records query: ${rrErr.message}`);

    for (const row of rrRows || []) {
      stats.previewed++;
      stats.sources.revenue_records.previewed++;

      if (!row.payment_intent_id || !row.booking_id || !row.gross_amount) {
        stats.skipped++;
        stats.sources.revenue_records.skipped++;
        if (!isDryRun) {
          await safeLogBackfill(sb, runId, "revenue_records", row.id, row.booking_id, "skip", null, "missing payment_intent_id, booking_id, or gross_amount");
        }
        continue;
      }

      if (!isDryRun) {
        await processLedgerPayment(sb, {
          runId,
          sourceTable: "revenue_records",
          sourceRecordId: String(row.id),
          bookingId: row.booking_id,
          paymentIntentId: row.payment_intent_id,
          amount: Number(row.gross_amount),
          transactionType: mapRevenueType(row.type),
          createdAt: row.created_at,
          stats: stats.sources.revenue_records,
          overallStats: stats,
        });
      } else {
        stats.sources.revenue_records.written++;
        stats.written++;
      }
    }

    if ((rrRows || []).length > 0 && !scopeBookingIds) {
      stats.next_cursor = rrRows[rrRows.length - 1].booking_id;
    }
  } catch (err) {
    console.error("[ledger-backfill] revenue_records error:", err.message);
    stats.errors++;
  }

  // ── 2. charges ─────────────────────────────────────────────────────────────
  try {
    let cQuery = sb
      .from("charges")
      .select("id, booking_id, stripe_payment_intent_id, amount, created_at, charge_type")
      .not("stripe_payment_intent_id", "is", null)
      .order("booking_id", { ascending: true });

    if (scopeBookingIds) {
      cQuery = cQuery.in("booking_id", scopeBookingIds);
    } else {
      cQuery = cQuery.limit(batchLimit);
      if (cursor_booking_ref) {
        cQuery = cQuery.gt("booking_id", cursor_booking_ref);
      }
    }

    const { data: cRows, error: cErr } = await cQuery;
    if (cErr) throw new Error(`charges query: ${cErr.message}`);

    for (const row of cRows || []) {
      stats.previewed++;
      stats.sources.charges.previewed++;

      if (!row.stripe_payment_intent_id || !row.booking_id || !row.amount) {
        stats.skipped++;
        stats.sources.charges.skipped++;
        if (!isDryRun) {
          await safeLogBackfill(sb, runId, "charges", row.id, row.booking_id, "skip", null, "missing stripe_payment_intent_id, booking_id, or amount");
        }
        continue;
      }

      if (!isDryRun) {
        await processLedgerPayment(sb, {
          runId,
          sourceTable: "charges",
          sourceRecordId: String(row.id),
          bookingId: row.booking_id,
          paymentIntentId: row.stripe_payment_intent_id,
          amount: Number(row.amount),
          transactionType: "payment",
          createdAt: row.created_at,
          stats: stats.sources.charges,
          overallStats: stats,
        });
      } else {
        stats.sources.charges.written++;
        stats.written++;
      }
    }
  } catch (err) {
    console.error("[ledger-backfill] charges error:", err.message);
    stats.errors++;
  }

  // ── 3. tickets ──────────────────────────────────────────────────────────────
  try {
    let tQuery = sb
      .from("tickets")
      .select("id, booking_id, payment_intent_id, amount, created_at")
      .not("payment_intent_id", "is", null)
      .order("booking_id", { ascending: true });

    if (scopeBookingIds) {
      tQuery = tQuery.in("booking_id", scopeBookingIds);
    } else {
      tQuery = tQuery.limit(batchLimit);
      if (cursor_booking_ref) {
        tQuery = tQuery.gt("booking_id", cursor_booking_ref);
      }
    }

    const { data: tRows, error: tErr } = await tQuery;
    if (tErr) throw new Error(`tickets query: ${tErr.message}`);

    for (const row of tRows || []) {
      stats.previewed++;
      stats.sources.tickets.previewed++;

      if (!row.payment_intent_id || !row.booking_id || !row.amount) {
        stats.skipped++;
        stats.sources.tickets.skipped++;
        if (!isDryRun) {
          await safeLogBackfill(sb, runId, "tickets", row.id, row.booking_id, "skip", null, "missing payment_intent_id, booking_id, or amount");
        }
        continue;
      }

      if (!isDryRun) {
        await processLedgerPayment(sb, {
          runId,
          sourceTable: "tickets",
          sourceRecordId: String(row.id),
          bookingId: row.booking_id,
          paymentIntentId: row.payment_intent_id,
          amount: Number(row.amount),
          transactionType: "payment",
          createdAt: row.created_at,
          stats: stats.sources.tickets,
          overallStats: stats,
        });
      } else {
        stats.sources.tickets.written++;
        stats.written++;
      }
    }
  } catch (err) {
    console.error("[ledger-backfill] tickets error:", err.message);
    stats.errors++;
  }

  return res.status(200).json({ ok: true, ...stats });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function mapRevenueType(_type) {
  // All replayed revenue_records map to "payment" — extensions and other subtypes
  // are stored as the same transaction_type in the ledger.
  return "payment";
}

/**
 * Attempt to insert a ledger payment for one source event.
 * Skips rows already present in ledger_backfill_log for this run_id.
 */
async function processLedgerPayment(sb, opts) {
  const { runId, sourceTable, sourceRecordId, bookingId, paymentIntentId, amount, transactionType, createdAt, stats, overallStats } = opts;

  // Check if this source record was already processed in this run.
  const { data: existing } = await sb
    .from("ledger_backfill_log")
    .select("id, status")
    .eq("run_id", runId)
    .eq("source_table", sourceTable)
    .eq("source_id", sourceRecordId)
    .maybeSingle();

  if (existing) {
    stats.skipped++;
    overallStats.skipped++;
    return;
  }

  try {
    const result = await addLedgerPayment(sb, {
      bookingId,
      transactionType,
      amount,
      source_type: "stripe_payment",
      source_id: paymentIntentId,
      stripe_payment_intent_id: paymentIntentId,
      created_at: createdAt,
      notes: `Backfilled from ${sourceTable}`,
      created_by: "backfill",
    });

    const ledgerTxId = result.transaction ? result.transaction.id : null;
    await safeLogBackfill(sb, runId, sourceTable, sourceRecordId, bookingId, "ok", ledgerTxId, null);
    stats.written++;
    overallStats.written++;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[ledger-backfill] ${sourceTable}/${sourceRecordId}:`, msg);
    await safeLogBackfill(sb, runId, sourceTable, sourceRecordId, bookingId, "error", null, msg.slice(0, 500));
    stats.errors++;
    overallStats.errors++;
  }
}

async function safeLogBackfill(sb, runId, sourceTable, sourceId, bookingId, status, ledgerTxId, errorMessage) {
  try {
    await sb.from("ledger_backfill_log").upsert({
      run_id: runId,
      source_table: sourceTable,
      source_id: String(sourceId),
      booking_id: bookingId || null,
      status,
      ledger_tx_id: ledgerTxId || null,
      error_message: errorMessage || null,
    }, { onConflict: "run_id,source_table,source_id" });
  } catch (logErr) {
    console.warn("[ledger-backfill] log write failed (non-fatal):", logErr.message);
  }
}
