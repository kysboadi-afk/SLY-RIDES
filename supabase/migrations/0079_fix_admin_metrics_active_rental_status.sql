-- Migration 0079: fix admin_metrics_v2 to recognise 'active_rental' booking status
--
-- Root cause: migration 0064_standardize_active_rental_status.sql rewrote every
-- bookings row that had status='active' to status='active_rental'.  Migration 0078
-- (admin_metrics_v2) was written before that change was applied and therefore only
-- checks for status IN ('active', 'overdue').  After 0064 runs on a database, no
-- booking can ever match 'active' again, which causes:
--
--   • *_active_rentals  → always 0   (view misses all active bookings)
--   • *_returns_today   → always 0
--   • available_vehicles count wrong (NOT IN subquery uses same bad filter)
--
-- Fix: add 'active_rental' wherever 'active' is checked in the booking-status
-- filters.  The original 'active' value is kept so the view still works on
-- databases where 0064 has not yet been applied (safe to run in either order).
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW admin_metrics_v2 AS
WITH
  -- ── Vehicle type lookup (vehicle vs car) ──────────────────────────────────
  vt AS (
    SELECT vehicle_id, COALESCE(vehicle_type, '') AS vehicle_type
    FROM   vehicles
  ),

  -- ── Revenue records joined with vehicle type ────────────────────────────────
  rev AS (
    SELECT r.*, COALESCE(vt.vehicle_type, '') AS vehicle_type
    FROM   revenue_reporting_base r
    LEFT JOIN vt ON vt.vehicle_id = r.vehicle_id
  ),

  -- ── Supplemental charges not yet reflected in revenue_records ───────────────
  -- Excludes charges whose Stripe PI is already present in revenue_records to
  -- prevent double-counting (mirrors the JS dedup logic in v2-dashboard.js).
  charges_net AS (
    SELECT
      c.booking_id,
      c.amount,
      c.created_at::date            AS charge_date,
      b.vehicle_id,
      COALESCE(v.vehicle_type, '')  AS vehicle_type
    FROM   charges c
    JOIN   bookings b ON b.booking_ref = c.booking_id
    LEFT JOIN vt v    ON v.vehicle_id  = b.vehicle_id
    WHERE  c.status = 'succeeded'
      AND (
        c.stripe_payment_intent_id IS NULL
        OR c.stripe_payment_intent_id NOT IN (
          SELECT payment_intent_id
          FROM   revenue_records
          WHERE  payment_intent_id IS NOT NULL
        )
      )
  ),

  -- ── Combined revenue: revenue_records + supplemental charges ────────────────
  fin_all AS (
    SELECT
      vehicle_type,
      gross_amount,
      stripe_fee,
      stripe_net,
      refund_amount,
      COALESCE(is_cancelled, false) AS is_cancelled,
      COALESCE(is_no_show,   false) AS is_no_show,
      TRUE                          AS from_rr
    FROM rev
    UNION ALL
    SELECT
      vehicle_type,
      amount AS gross_amount,
      NULL,
      NULL,
      NULL,
      FALSE,
      FALSE,
      FALSE
    FROM charges_net
  ),

  -- ── Financial aggregates (scope-aware) ──────────────────────────────────────
  fin AS (
    SELECT
      -- Total (all vehicles)
      COALESCE(SUM(CASE WHEN NOT is_cancelled AND NOT is_no_show
        THEN gross_amount ELSE 0 END), 0)
                                                                        AS total_revenue,
      COALESCE(SUM(CASE WHEN from_rr AND NOT is_cancelled AND NOT is_no_show
        THEN COALESCE(stripe_fee, 0) ELSE 0 END), 0)
                                                                        AS total_stripe_fees,
      COALESCE(SUM(CASE WHEN NOT is_cancelled AND NOT is_no_show
        THEN CASE WHEN from_rr
               THEN COALESCE(stripe_net, gross_amount - COALESCE(stripe_fee, 0))
                    - COALESCE(refund_amount, 0)
               ELSE gross_amount
             END
        ELSE 0 END), 0)                                                AS total_net_revenue,
      COUNT(*) FILTER (
        WHERE from_rr AND stripe_fee IS NOT NULL
          AND NOT is_cancelled AND NOT is_no_show)                     AS total_reconciled_count,

      -- Car (vehicle_type != 'vehicle')
      COALESCE(SUM(CASE WHEN vehicle_type != 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN gross_amount ELSE 0 END), 0)                              AS car_revenue,
      COALESCE(SUM(CASE WHEN vehicle_type != 'vehicle'
        AND from_rr AND NOT is_cancelled AND NOT is_no_show
        THEN COALESCE(stripe_fee, 0) ELSE 0 END), 0)                  AS car_stripe_fees,
      COALESCE(SUM(CASE WHEN vehicle_type != 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN CASE WHEN from_rr
               THEN COALESCE(stripe_net, gross_amount - COALESCE(stripe_fee, 0))
                    - COALESCE(refund_amount, 0)
               ELSE gross_amount
             END
        ELSE 0 END), 0)                                                AS car_net_revenue,
      COUNT(*) FILTER (
        WHERE vehicle_type != 'vehicle' AND from_rr AND stripe_fee IS NOT NULL
          AND NOT is_cancelled AND NOT is_no_show)                     AS car_reconciled_count,

      -- Vehicle (vehicle_type = 'vehicle')
      COALESCE(SUM(CASE WHEN vehicle_type = 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN gross_amount ELSE 0 END), 0)                              AS vehicle_revenue,
      COALESCE(SUM(CASE WHEN vehicle_type = 'vehicle'
        AND from_rr AND NOT is_cancelled AND NOT is_no_show
        THEN COALESCE(stripe_fee, 0) ELSE 0 END), 0)                  AS vehicle_stripe_fees,
      COALESCE(SUM(CASE WHEN vehicle_type = 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN CASE WHEN from_rr
               THEN COALESCE(stripe_net, gross_amount - COALESCE(stripe_fee, 0))
                    - COALESCE(refund_amount, 0)
               ELSE gross_amount
             END
        ELSE 0 END), 0)                                                AS vehicle_net_revenue,
      COUNT(*) FILTER (
        WHERE vehicle_type = 'vehicle' AND from_rr AND stripe_fee IS NOT NULL
          AND NOT is_cancelled AND NOT is_no_show)                     AS vehicle_reconciled_count
    FROM fin_all
  ),

  -- ── Expense aggregates (scope-aware) ────────────────────────────────────────
  exp AS (
    SELECT
      COALESCE(SUM(e.amount), 0)                                       AS total_expenses,
      COALESCE(SUM(CASE WHEN COALESCE(vt.vehicle_type, '') != 'vehicle'
        THEN e.amount ELSE 0 END), 0)                                  AS car_expenses,
      COALESCE(SUM(CASE WHEN vt.vehicle_type = 'vehicle'
        THEN e.amount ELSE 0 END), 0)                                  AS vehicle_expenses
    FROM   expenses e
    LEFT JOIN vt ON vt.vehicle_id = e.vehicle_id
  ),

  -- ── Booking status counts (scope-aware, timezone-aware) ─────────────────────
  -- IMPORTANT: 'active_rental' is the canonical active-booking status after
  -- migration 0064.  The legacy value 'active' is kept alongside it so this
  -- view works correctly on databases where 0064 has not yet been applied.
  bk AS (
    SELECT
      -- Total
      COUNT(*) FILTER (WHERE b.status IN ('active', 'active_rental', 'overdue'))
                                                                        AS total_active_rentals,
      COUNT(*) FILTER (
        WHERE b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS total_pending_approvals,
      COUNT(*) FILTER (WHERE b.status = 'overdue')                     AS total_overdue_count,
      COUNT(*) FILTER (
        WHERE b.return_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('active', 'active_rental', 'overdue'))      AS total_returns_today,
      COUNT(*) FILTER (
        WHERE b.pickup_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('pending', 'reserved', 'pending_verification',
                           'approved', 'booked_paid'))                 AS total_pickups_today,
      -- Car
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.status IN ('active', 'active_rental', 'overdue'))      AS car_active_rentals,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS car_pending_approvals,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.status = 'overdue')                                    AS car_overdue_count,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.return_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('active', 'active_rental', 'overdue'))      AS car_returns_today,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.pickup_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('pending', 'reserved', 'pending_verification',
                           'approved', 'booked_paid'))                 AS car_pickups_today,
      -- Vehicle
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.status IN ('active', 'active_rental', 'overdue'))      AS vehicle_active_rentals,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS vehicle_pending_approvals,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.status = 'overdue')                                     AS vehicle_overdue_count,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.return_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('active', 'active_rental', 'overdue'))      AS vehicle_returns_today,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.pickup_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('pending', 'reserved', 'pending_verification',
                           'approved', 'booked_paid'))                 AS vehicle_pickups_today
    FROM   bookings b
    LEFT JOIN vt ON vt.vehicle_id = b.vehicle_id
    WHERE  b.status NOT IN ('completed', 'completed_rental', 'cancelled', 'cancelled_rental')
  ),

  -- ── Available vehicles (scope-aware) ────────────────────────────────────────
  avail AS (
    SELECT
      COUNT(*) FILTER (
        WHERE (v.data ->> 'status') = 'active'
          AND v.vehicle_id NOT IN (
            SELECT DISTINCT vehicle_id FROM bookings
            WHERE  status IN ('active', 'active_rental', 'overdue')
          ))                                                           AS total_available_vehicles,
      COUNT(*) FILTER (
        WHERE (v.data ->> 'status') = 'active'
          AND COALESCE(v.vehicle_type, '') != 'vehicle'
          AND v.vehicle_id NOT IN (
            SELECT DISTINCT vehicle_id FROM bookings
            WHERE  status IN ('active', 'active_rental', 'overdue')
          ))                                                           AS car_available_vehicles,
      COUNT(*) FILTER (
        WHERE (v.data ->> 'status') = 'active'
          AND v.vehicle_type = 'vehicle'
          AND v.vehicle_id NOT IN (
            SELECT DISTINCT vehicle_id FROM bookings
            WHERE  status IN ('active', 'active_rental', 'overdue')
          ))                                                           AS vehicle_available_vehicles
    FROM vehicles v
  ),

  -- ── Per-vehicle revenue (revenue_records + charges) for vehicleStats ────────
  veh_rev AS (
    SELECT vehicle_id, SUM(gross) AS gross, SUM(net) AS net, SUM(cnt) AS cnt
    FROM (
      SELECT
        r.vehicle_id,
        SUM(CASE WHEN NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                              AS gross,
        SUM(CASE WHEN NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN COALESCE(r.stripe_net, r.gross_amount - COALESCE(r.stripe_fee, 0))
               - COALESCE(r.refund_amount, 0)
          ELSE 0 END)                                                  AS net,
        COUNT(*) FILTER (
          WHERE NOT COALESCE(r.is_cancelled, false)
            AND NOT COALESCE(r.is_no_show, false))                    AS cnt
      FROM revenue_reporting_base r
      GROUP BY r.vehicle_id
      UNION ALL
      SELECT vehicle_id, SUM(amount) AS gross, SUM(amount) AS net, 0 AS cnt
      FROM   charges_net
      GROUP BY vehicle_id
    ) combined
    GROUP BY vehicle_id
  ),

  -- ── Monthly revenue data for the chart (last 12 months) ─────────────────────
  monthly AS (
    SELECT mo, SUM(total_amt) AS total_amt, SUM(car_amt) AS car_amt, SUM(vehicle_amt) AS vehicle_amt
    FROM (
      -- From revenue_records
      SELECT
        LEFT(r.pickup_date::text, 7) AS mo,
        SUM(CASE WHEN NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                              AS total_amt,
        SUM(CASE WHEN r.vehicle_type != 'vehicle'
                  AND NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                              AS car_amt,
        SUM(CASE WHEN r.vehicle_type = 'vehicle'
                  AND NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                              AS vehicle_amt
      FROM rev r
      WHERE r.pickup_date IS NOT NULL
      GROUP BY LEFT(r.pickup_date::text, 7)
      UNION ALL
      -- From supplemental charges
      SELECT
        LEFT(c.charge_date::text, 7) AS mo,
        SUM(c.amount)                                                  AS total_amt,
        SUM(CASE WHEN c.vehicle_type != 'vehicle' THEN c.amount ELSE 0 END) AS car_amt,
        SUM(CASE WHEN c.vehicle_type  = 'vehicle' THEN c.amount ELSE 0 END) AS vehicle_amt
      FROM charges_net c
      GROUP BY LEFT(c.charge_date::text, 7)
    ) combined
    GROUP BY mo
  )

SELECT
  -- ── Financial KPIs — Total ────────────────────────────────────────────────
  f.total_revenue,
  f.total_stripe_fees,
  f.total_net_revenue,
  f.total_reconciled_count,
  e.total_expenses,
  (f.total_net_revenue - e.total_expenses)::numeric                    AS total_net_profit,
  CASE WHEN e.total_expenses > 0
    THEN ROUND(((f.total_net_revenue - e.total_expenses)
                / e.total_expenses * 100)::numeric, 2)
    ELSE NULL END                                                       AS total_operational_roi,

  -- ── Financial KPIs — Car ─────────────────────────────────────────────────
  f.car_revenue,
  f.car_stripe_fees,
  f.car_net_revenue,
  f.car_reconciled_count,
  e.car_expenses,
  (f.car_net_revenue - e.car_expenses)::numeric                        AS car_net_profit,
  CASE WHEN e.car_expenses > 0
    THEN ROUND(((f.car_net_revenue - e.car_expenses)
                / e.car_expenses * 100)::numeric, 2)
    ELSE NULL END                                                       AS car_operational_roi,

  -- ── Financial KPIs — Vehicle ───────────────────────────────────────────
  f.vehicle_revenue,
  f.vehicle_stripe_fees,
  f.vehicle_net_revenue,
  f.vehicle_reconciled_count,
  e.vehicle_expenses,
  (f.vehicle_net_revenue - e.vehicle_expenses)::numeric            AS vehicle_net_profit,
  CASE WHEN e.vehicle_expenses > 0
    THEN ROUND(((f.vehicle_net_revenue - e.vehicle_expenses)
                / e.vehicle_expenses * 100)::numeric, 2)
    ELSE NULL END                                                       AS vehicle_operational_roi,

  -- ── Booking counts — Total ───────────────────────────────────────────────
  bk.total_active_rentals,
  bk.total_pending_approvals,
  bk.total_overdue_count,
  bk.total_returns_today,
  bk.total_pickups_today,

  -- ── Booking counts — Car ─────────────────────────────────────────────────
  bk.car_active_rentals,
  bk.car_pending_approvals,
  bk.car_overdue_count,
  bk.car_returns_today,
  bk.car_pickups_today,

  -- ── Booking counts — Vehicle ───────────────────────────────────────────
  bk.vehicle_active_rentals,
  bk.vehicle_pending_approvals,
  bk.vehicle_overdue_count,
  bk.vehicle_returns_today,
  bk.vehicle_pickups_today,

  -- ── Available vehicles ───────────────────────────────────────────────────
  av.total_available_vehicles,
  av.car_available_vehicles,
  av.vehicle_available_vehicles,

  -- ── Per-vehicle revenue JSONB (keyed by vehicle_id) ─────────────────────
  -- Used by v2-dashboard.js to populate rrByVehicle for vehicleStats computation.
  (
    SELECT COALESCE(
      json_object_agg(
        vehicle_id,
        json_build_object(
          'gross', ROUND(COALESCE(gross, 0)::numeric, 2),
          'net',   ROUND(COALESCE(net,   0)::numeric, 2),
          'count', COALESCE(cnt, 0)
        )
      ),
      '{}'::json
    )
    FROM veh_rev
  )                                                                     AS vehicle_revenue_json,

  -- ── Monthly revenue charts (last 12 months, chronological order) ────────
  -- Inner subquery takes the 12 most-recent months; json_agg re-sorts them ASC.
  (
    SELECT COALESCE(
      json_agg(
        json_build_object('month', mo, 'amount', ROUND(total_amt::numeric, 2))
        ORDER BY mo
      ),
      '[]'::json
    )
    FROM (
      SELECT mo, total_amt FROM monthly
      WHERE  total_amt > 0
      ORDER BY mo DESC LIMIT 12
    ) sub
  )                                                                     AS total_revenue_chart,
  (
    SELECT COALESCE(
      json_agg(
        json_build_object('month', mo, 'amount', ROUND(car_amt::numeric, 2))
        ORDER BY mo
      ),
      '[]'::json
    )
    FROM (
      SELECT mo, car_amt FROM monthly
      WHERE  car_amt > 0
      ORDER BY mo DESC LIMIT 12
    ) sub
  )                                                                     AS car_revenue_chart,
  (
    SELECT COALESCE(
      json_agg(
        json_build_object('month', mo, 'amount', ROUND(vehicle_amt::numeric, 2))
        ORDER BY mo
      ),
      '[]'::json
    )
    FROM (
      SELECT mo, vehicle_amt FROM monthly
      WHERE  vehicle_amt > 0
      ORDER BY mo DESC LIMIT 12
    ) sub
  )                                                                     AS vehicle_revenue_chart

FROM fin f, exp e, bk, avail av;
