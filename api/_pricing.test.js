// Tests for api/_pricing.js — computeAmount, computeProtectionPlanCost, and computeBreakdownLines
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAmount,
  computeProtectionPlanCost,
  computeBreakdownLines,
  CAMRY_BOOKING_DEPOSIT,
  computeAmountFromPricing,
  computeLateFeeDays,
  computeLateFeeAmount,
} from "./_pricing.js";

// ─── Camry daily ────────────────────────────────────────────────────────────

test("camry: 1 day = $55", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-02"), 55);
});

test("camry: 6 days = 6 × $55 = $330", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-07"), 330);
});

// ─── Camry weekly ($350/week) ────────────────────────────────────────────────

test("camry: 7 days = 1 × $350 weekly = $350", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-08"), 350);
});

test("camry: 10 days = 1 × $350 + 3 × $55 = $515", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-11"), 515);
});

test("camry: 13 days = 1 × $350 + 6 × $55 = $680", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-14"), 680);
});

// ─── Camry biweekly ($650/2 weeks) ───────────────────────────────────────────

test("camry: 14 days = 1 × $650 biweekly = $650", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-15"), 650);
});

test("camry: 16 days = 1 × $650 + 2 × $55 = $760", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-17"), 760);
});

test("camry: 28 days = 2 × $650 biweekly = $1300", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-29"), 1300);
});

test("camry: 29 days = 2 × $650 + 1 × $55 = $1355", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-30"), 1355);
});

// ─── Camry monthly ($1300/month) ─────────────────────────────────────────────

test("camry: 30 days = 1 × $1300 monthly = $1300", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-31"), 1300);
});

test("camry: 31 days = 1 × $1300 + 1 × $55 = $1355", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-08-01"), 1355);
});

test("camry: 37 days = 1 × $1300 + 1 × $350 weekly = $1650", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-08-07"), 1650);
});

test("camry: 60 days = 2 × $1300 monthly = $2600", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-08-30"), 2600);
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

test("same-day (0-day gap) treated as 1 day minimum", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-01"), 55);
});

test("unknown vehicleId returns null", () => {
  assert.equal(computeAmount("unknown", "2025-07-01", "2025-07-05"), null);
});

// ─── Camry 2013 SE daily ─────────────────────────────────────────────────────

test("camry2013: 1 day = $55", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-02"), 55);
});

test("camry2013: 6 days = 6 × $55 = $330", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-07"), 330);
});

// ─── Camry 2013 SE weekly ($350/week) ────────────────────────────────────────

test("camry2013: 7 days = 1 × $350 weekly = $350", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-08"), 350);
});

test("camry2013: 10 days = 1 × $350 + 3 × $55 = $515", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-11"), 515);
});

// ─── Camry 2013 SE biweekly ($650/2 weeks) ───────────────────────────────────

test("camry2013: 14 days = 1 × $650 biweekly = $650", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-15"), 650);
});

test("camry2013: 16 days = 1 × $650 + 2 × $55 = $760", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-17"), 760);
});

// ─── Camry 2013 SE monthly ($1300/month) ─────────────────────────────────────

test("camry2013: 30 days = 1 × $1300 monthly = $1300", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-31"), 1300);
});

test("camry2013: 31 days = 1 × $1300 + 1 × $55 = $1355", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-08-01"), 1355);
});

test("camry2013: 37 days = 1 × $1300 + 1 × $350 weekly = $1650", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-08-07"), 1650);
});

// ─── Damage Protection Plan cost ─────────────────────────────────────────────
// Rates: $13/day (derived) · $85/week · $150/2-week · $295/month

test("protection plan: 1 day = $13", () => {
  assert.equal(computeProtectionPlanCost(1), 13);
});

test("protection plan: 6 days = 6 × $13 = $78", () => {
  assert.equal(computeProtectionPlanCost(6), 78);
});

test("protection plan: 7 days = 1 × $85 weekly = $85", () => {
  assert.equal(computeProtectionPlanCost(7), 85);
});

test("protection plan: 8 days = 1 × $85 + 1 × $13 = $98", () => {
  assert.equal(computeProtectionPlanCost(8), 98);
});

test("protection plan: 14 days = 1 × $150 biweekly = $150", () => {
  assert.equal(computeProtectionPlanCost(14), 150);
});

test("protection plan: 15 days = 1 × $150 + 1 × $13 = $163", () => {
  assert.equal(computeProtectionPlanCost(15), 163);
});

test("protection plan: 30 days = 1 × $295 monthly = $295", () => {
  assert.equal(computeProtectionPlanCost(30), 295);
});

test("protection plan: 31 days = 1 × $295 + 1 × $13 = $308", () => {
  assert.equal(computeProtectionPlanCost(31), 308);
});

test("protection plan: 37 days = 1 × $295 + 1 × $85 weekly = $380", () => {
  assert.equal(computeProtectionPlanCost(37), 380);
});

// ─── computeBreakdownLines ────────────────────────────────────────────────────

test("breakdown: camry 1 day has daily line + sales tax line + total", () => {
  const lines = computeBreakdownLines("camry", "2025-07-01", "2025-07-02");
  assert.ok(lines.some(l => l.includes("1 × Daily")), "should have a daily line");
  assert.ok(lines.some(l => l.startsWith("Sales Tax")), "should have a sales tax line");
  assert.ok(lines.some(l => l.startsWith("Total:")), "should have a total line");
});

test("breakdown: camry 7 days has weekly line", () => {
  const lines = computeBreakdownLines("camry", "2025-07-01", "2025-07-08");
  assert.ok(lines.some(l => l.includes("1 × Weekly")), "should have a weekly line");
  assert.ok(!lines.some(l => l.includes("Daily")), "should not have a daily line for exactly 7 days");
});

test("breakdown: camry 10 days has weekly + daily lines", () => {
  const lines = computeBreakdownLines("camry", "2025-07-01", "2025-07-11");
  assert.ok(lines.some(l => l.includes("1 × Weekly")));
  assert.ok(lines.some(l => l.includes("3 × Daily")));
});

test("breakdown: camry 30 days has monthly line", () => {
  const lines = computeBreakdownLines("camry", "2025-07-01", "2025-07-31");
  assert.ok(lines.some(l => l.includes("1 × Monthly")));
});

test("breakdown: camry with DPP includes DPP line", () => {
  const lines = computeBreakdownLines("camry", "2025-07-01", "2025-07-08", true);
  assert.ok(lines.some(l => l.includes("Damage Protection Plan")));
});

test("breakdown: camry without DPP has no DPP line", () => {
  const lines = computeBreakdownLines("camry", "2025-07-01", "2025-07-08", false);
  assert.ok(!lines.some(l => l.includes("Damage Protection Plan")));
});

test("breakdown: unknown vehicleId returns null", () => {
  assert.equal(computeBreakdownLines("unknown", "2025-07-01", "2025-07-05"), null);
});

// ─── CAMRY_BOOKING_DEPOSIT constant ──────────────────────────────────────────

test("CAMRY_BOOKING_DEPOSIT equals $50", () => {
  assert.equal(CAMRY_BOOKING_DEPOSIT, 50);
});

test("Camry 1-week rental minus deposit = balance at pickup in Reserve mode", () => {
  // 1-week Camry = $350; minus $50 deposit = $300 balance due at pickup
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-08") - CAMRY_BOOKING_DEPOSIT, 300);
});

test("Camry 30-day rental minus deposit = balance at pickup in Reserve mode", () => {
  // 30-day Camry = $1300; minus $50 deposit = $1250 balance due at pickup
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-31") - CAMRY_BOOKING_DEPOSIT, 1250);
});

// ─── computeAmountFromPricing — new-vehicle payment hardening ────────────────

test("computeAmountFromPricing: basic daily pricing, 3 days", () => {
  const pricing = { daily_price: 60, weekly_price: null, biweekly_price: null, monthly_price: null };
  assert.equal(computeAmountFromPricing(pricing, 3), 180);
});

test("computeAmountFromPricing: weekly tier used when exactly 7 days", () => {
  const pricing = { daily_price: 60, weekly_price: 350, biweekly_price: null, monthly_price: null };
  assert.equal(computeAmountFromPricing(pricing, 7), 350);
});

test("computeAmountFromPricing: biweekly tier used when exactly 14 days", () => {
  const pricing = { daily_price: 60, weekly_price: 350, biweekly_price: 650, monthly_price: null };
  assert.equal(computeAmountFromPricing(pricing, 14), 650);
});

test("computeAmountFromPricing: monthly tier used when 28 or more days", () => {
  const pricing = { daily_price: 60, weekly_price: 350, biweekly_price: 650, monthly_price: 1300 };
  assert.equal(computeAmountFromPricing(pricing, 28), 1300);
  assert.equal(computeAmountFromPricing(pricing, 30), 1300);
});

test("computeAmountFromPricing: zero weekly_price is NOT used — falls through to daily × days", () => {
  // Admin sets weekly_price=0 meaning "we don't offer a weekly flat rate".
  // A $0 tier must NOT be treated as free — daily × 7 should be charged instead.
  const pricing = { daily_price: 60, weekly_price: 0, biweekly_price: null, monthly_price: null };
  assert.equal(computeAmountFromPricing(pricing, 7), 60 * 7);
});

test("computeAmountFromPricing: zero biweekly_price is NOT used — falls through to weekly", () => {
  // When biweekly=0 but weekly=350, greedy uses 2 × weekly ($700) not daily × 14 ($840).
  const pricing = { daily_price: 60, weekly_price: 350, biweekly_price: 0, monthly_price: null };
  assert.equal(computeAmountFromPricing(pricing, 14), 350 * 2);
});

test("computeAmountFromPricing: zero biweekly_price and zero weekly_price — falls through to daily × days", () => {
  const pricing = { daily_price: 60, weekly_price: 0, biweekly_price: 0, monthly_price: null };
  assert.equal(computeAmountFromPricing(pricing, 14), 60 * 14);
});

test("computeAmountFromPricing: zero monthly_price is NOT used — falls through to biweekly", () => {
  // When monthly=0 but biweekly=650, greedy uses 2 × biweekly ($1300) not daily × 28 ($1680).
  const pricing = { daily_price: 60, weekly_price: 350, biweekly_price: 650, monthly_price: 0 };
  assert.equal(computeAmountFromPricing(pricing, 28), 650 * 2);
});

test("computeAmountFromPricing: zero monthly_price, zero biweekly_price — falls through to weekly", () => {
  const pricing = { daily_price: 60, weekly_price: 350, biweekly_price: 0, monthly_price: 0 };
  assert.equal(computeAmountFromPricing(pricing, 28), 350 * 4);
});

test("computeAmountFromPricing: zero monthly_price, zero biweekly_price, zero weekly_price — falls through to daily × days", () => {
  const pricing = { daily_price: 60, weekly_price: 0, biweekly_price: 0, monthly_price: 0 };
  assert.equal(computeAmountFromPricing(pricing, 28), 60 * 28);
});

// ─── Greedy (non-boundary) day counts ──────────────────────────────────────
// These cases differ from flat-tier and verify Stripe matches the booking page.

test("computeAmountFromPricing: 8 days = 1 week + 1 day (greedy)", () => {
  const pricing = { daily_price: 55, weekly_price: 350, biweekly_price: 650, monthly_price: 1300 };
  assert.equal(computeAmountFromPricing(pricing, 8), 350 + 55);
});

test("computeAmountFromPricing: 10 days = 1 week + 3 days (greedy)", () => {
  const pricing = { daily_price: 55, weekly_price: 350, biweekly_price: 650, monthly_price: 1300 };
  assert.equal(computeAmountFromPricing(pricing, 10), 350 + 55 * 3);
});

test("computeAmountFromPricing: 15 days = 1 biweekly + 1 day (greedy)", () => {
  const pricing = { daily_price: 55, weekly_price: 350, biweekly_price: 650, monthly_price: 1300 };
  assert.equal(computeAmountFromPricing(pricing, 15), 650 + 55);
});

test("computeAmountFromPricing: 21 days = 1 biweekly + 1 weekly (greedy)", () => {
  // Greedy: biweekly tier applied first ($650 for 14 days), then weekly ($350 for 7 days) = $1000.
  // This is cheaper for the renter than 3 × weekly ($1050), confirming greedy is correct.
  const pricing = { daily_price: 55, weekly_price: 350, biweekly_price: 650, monthly_price: 1300 };
  assert.equal(computeAmountFromPricing(pricing, 21), 650 + 350);
});

test("computeAmountFromPricing: 31 days = 1 monthly + 1 day (greedy)", () => {
  const pricing = { daily_price: 55, weekly_price: 350, biweekly_price: 650, monthly_price: 1300 };
  assert.equal(computeAmountFromPricing(pricing, 31), 1300 + 55);
});

test("computeAmountFromPricing: string prices are coerced to numbers", () => {
  // Supabase TEXT columns can return strings instead of numbers.
  const pricing = { daily_price: "60", weekly_price: "350", biweekly_price: null, monthly_price: null };
  assert.equal(computeAmountFromPricing(pricing, 7), 350);
  assert.equal(computeAmountFromPricing(pricing, 3), 180);
});

test("computeAmountFromPricing: null daily_price with weekly_price derives daily from weekly", () => {
  // Vehicle created with only a weekly rate — daily is derived as weeklyPrice / 7.
  const pricing = { daily_price: null, weekly_price: 350, biweekly_price: null, monthly_price: null };
  // 5-day rental falls through to derived daily: round(350/7 * 100)/100 = 50, total = 250
  assert.equal(computeAmountFromPricing(pricing, 5), Math.round(350 / 7 * 5 * 100) / 100);
});

test("computeAmountFromPricing: all null prices returns null", () => {
  const pricing = { daily_price: null, weekly_price: null, biweekly_price: null, monthly_price: null };
  assert.equal(computeAmountFromPricing(pricing, 3), null);
});

test("computeAmountFromPricing: zero daily_price is NOT used — derives from weekly_price instead", () => {
  // Reproduces the Ford Fusion bug: admin saved daily_price=0 but weekly_price=350.
  // The $0 daily should be treated as "not configured", not as a free rental.
  const pricing = { daily_price: 0, weekly_price: 350, biweekly_price: null, monthly_price: null };
  assert.equal(computeAmountFromPricing(pricing, 7), 350);
  assert.equal(computeAmountFromPricing(pricing, 5), Math.round(350 / 7 * 5 * 100) / 100);
});

test("computeAmountFromPricing: all-zero prices returns null (not $0)", () => {
  // All prices 0 means the vehicle is misconfigured — should return null so
  // the booking endpoint can reject the request with a helpful error instead of
  // sending a $0 amount to Stripe (which Stripe rejects with a cryptic error).
  const pricing = { daily_price: 0, weekly_price: 0, biweekly_price: 0, monthly_price: 0 };
  assert.equal(computeAmountFromPricing(pricing, 5), null);
  assert.equal(computeAmountFromPricing(pricing, 7), null);
});

test("computeLateFeeDays: returns 0 before the 30-minute grace window ends", () => {
  assert.equal(
    computeLateFeeDays("2026-05-01", "5:00 PM", "2026-05-01T17:20:00-07:00"),
    0
  );
});

test("computeLateFeeAmount: charges $25 for the first overdue day after grace period expires", () => {
  assert.equal(
    computeLateFeeAmount("2026-05-01", "5:00 PM", "2026-05-01T17:31:00-07:00"),
    25
  );
});

test("computeLateFeeAmount: charges $25 per overdue day", () => {
  assert.equal(
    computeLateFeeDays("2026-05-01", "5:00 PM", "2026-05-03T17:31:00-07:00"),
    3
  );
  assert.equal(
    computeLateFeeAmount("2026-05-01", "5:00 PM", "2026-05-03T17:31:00-07:00"),
    75
  );
});
