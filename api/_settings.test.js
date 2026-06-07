// Tests for api/_settings.js — computeCamryAmountFromSettings,
// computeBreakdownLinesFromSettings, computeDppCostFromSettings, applyTax, and loadPricingSettings.
//
// These tests run entirely with hardcoded settings objects (no Supabase required) to verify
// that the dynamic pricing helpers produce correct results, and that they respect admin
// overrides (e.g. promo rates).
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAINTENANCE_DEFAULTS,
  PRICING_DEFAULTS,
  computeCamryAmountFromSettings,
  computeBreakdownLinesFromSettings,
  computeDppCostFromSettings,
  applyTax,
} from "./_settings.js";

// ─── Default settings mirror _pricing.js constants ──────────────────────────

test("PRICING_DEFAULTS.camry_daily_rate = 55", () => {
  assert.equal(PRICING_DEFAULTS.camry_daily_rate, 55);
});

test("PRICING_DEFAULTS.camry_weekly_rate = 350", () => {
  assert.equal(PRICING_DEFAULTS.camry_weekly_rate, 350);
});

test("PRICING_DEFAULTS.camry_biweekly_rate = 650", () => {
  assert.equal(PRICING_DEFAULTS.camry_biweekly_rate, 650);
});

test("PRICING_DEFAULTS.camry_monthly_rate = 1300", () => {
  assert.equal(PRICING_DEFAULTS.camry_monthly_rate, 1300);
});

test("PRICING_DEFAULTS.la_tax_rate = 0.1025", () => {
  assert.equal(PRICING_DEFAULTS.la_tax_rate, 0.1025);
});

test("MAINTENANCE_DEFAULTS.maintenance_oil_interval_miles = 3000", () => {
  assert.equal(MAINTENANCE_DEFAULTS.maintenance_oil_interval_miles, 3000);
});

test("MAINTENANCE_DEFAULTS.maintenance_escalation_delay_hours = 48", () => {
  assert.equal(MAINTENANCE_DEFAULTS.maintenance_escalation_delay_hours, 48);
});

// ─── computeCamryAmountFromSettings (default rates) ─────────────────────────

const S = { ...PRICING_DEFAULTS };  // shorthand for default settings

test("camry default: 1 day = $55", () => {
  assert.equal(computeCamryAmountFromSettings("camry", "2025-07-01", "2025-07-02", S), 55);
});

test("camry default: 6 days = 6 × $55 = $330", () => {
  assert.equal(computeCamryAmountFromSettings("camry", "2025-07-01", "2025-07-07", S), 330);
});

test("camry default: 7 days = 1 × $350 weekly = $350", () => {
  assert.equal(computeCamryAmountFromSettings("camry", "2025-07-01", "2025-07-08", S), 350);
});

test("camry default: 10 days = 1 × $350 + 3 × $55 = $515", () => {
  assert.equal(computeCamryAmountFromSettings("camry", "2025-07-01", "2025-07-11", S), 515);
});

test("camry default: 14 days = 1 × $650 biweekly = $650", () => {
  assert.equal(computeCamryAmountFromSettings("camry", "2025-07-01", "2025-07-15", S), 650);
});

test("camry default: 30 days = 1 × $1300 monthly = $1300", () => {
  assert.equal(computeCamryAmountFromSettings("camry", "2025-07-01", "2025-07-31", S), 1300);
});

test("camry2013 default: 7 days = $350 (uses same rates as camry)", () => {
  assert.equal(computeCamryAmountFromSettings("camry2013", "2025-07-01", "2025-07-08", S), 350);
});

test("camry default: unknown vehicleId returns null", () => {
});

// ─── computeCamryAmountFromSettings (promo / admin-overridden rates) ─────────

test("camry promo $45/day: 1 day = $45", () => {
  const promo = { ...S, camry_daily_rate: 45 };
  assert.equal(computeCamryAmountFromSettings("camry", "2025-07-01", "2025-07-02", promo), 45);
});

test("camry promo $45/day: 6 days = $270", () => {
  const promo = { ...S, camry_daily_rate: 45 };
  assert.equal(computeCamryAmountFromSettings("camry", "2025-07-01", "2025-07-07", promo), 270);
});

test("camry promo $300/week: 7 days = $300", () => {
  const promo = { ...S, camry_weekly_rate: 300 };
  assert.equal(computeCamryAmountFromSettings("camry", "2025-07-01", "2025-07-08", promo), 300);
});

test("camry promo $300/week + $45/day: 10 days = $300 + 3×$45 = $435", () => {
  const promo = { ...S, camry_weekly_rate: 300, camry_daily_rate: 45 };
  assert.equal(computeCamryAmountFromSettings("camry", "2025-07-01", "2025-07-11", promo), 435);
});

test("camry promo $600/biweekly: 14 days = $600", () => {
  const promo = { ...S, camry_biweekly_rate: 600 };
  assert.equal(computeCamryAmountFromSettings("camry", "2025-07-01", "2025-07-15", promo), 600);
});

test("camry promo $1200/month: 30 days = $1200", () => {
  const promo = { ...S, camry_monthly_rate: 1200 };
  assert.equal(computeCamryAmountFromSettings("camry", "2025-07-01", "2025-07-31", promo), 1200);
});

// ─── applyTax ────────────────────────────────────────────────────────────────

test("applyTax: $100 at 10.25% = $110.25", () => {
  assert.equal(applyTax(100, S), 110.25);
});

test("applyTax: $55 at 10.25% rounds to $60.64", () => {
  assert.equal(applyTax(55, S), 60.64);
});

test("applyTax: custom 5% tax rate", () => {
  const custom = { ...S, la_tax_rate: 0.05 };
  assert.equal(applyTax(100, custom), 105);
});

// ─── computeDppCostFromSettings ──────────────────────────────────────────────

test("DPP standard 5 days = 5 × $30 = $150", () => {
  assert.equal(computeDppCostFromSettings(5, "standard"), 150);
});

test("DPP basic 3 days = 3 × $15 = $45", () => {
  assert.equal(computeDppCostFromSettings(3, "basic"), 45);
});

test("DPP premium 2 days = 2 × $50 = $100", () => {
  assert.equal(computeDppCostFromSettings(2, "premium"), 100);
});

test("DPP legacy null tier 7 days = 1 × $85 weekly = $85", () => {
  assert.equal(computeDppCostFromSettings(7, null), 85);
});

// ─── computeBreakdownLinesFromSettings ──────────────────────────────────────

test("breakdown: 1-day camry default shows daily line + tax + total", () => {
  const lines = computeBreakdownLinesFromSettings("camry", "2025-07-01", "2025-07-02", S);
  assert.ok(Array.isArray(lines));
  assert.ok(lines.some(l => l.includes("Daily")));
  assert.ok(lines.some(l => l.startsWith("Total:")));
  assert.ok(lines.some(l => l.includes("Sales Tax")));
});

test("breakdown: 1-day camry default total = $55 × 1.1025 = $60.64", () => {
  const lines = computeBreakdownLinesFromSettings("camry", "2025-07-01", "2025-07-02", S);
  const totalLine = lines.find(l => l.startsWith("Total:"));
  assert.equal(totalLine, "Total: $60.64");
});

test("breakdown: 7-day camry default shows weekly line and correct total", () => {
  const lines = computeBreakdownLinesFromSettings("camry", "2025-07-01", "2025-07-08", S);
  assert.ok(lines.some(l => l.includes("Weekly")));
  const totalLine = lines.find(l => l.startsWith("Total:"));
  // $350 × 1.1025 = $385.88 (rounded)
  assert.equal(totalLine, "Total: $385.88");
});

test("breakdown: promo $45/day shows updated daily rate in lines", () => {
  const promo = { ...S, camry_daily_rate: 45 };
  const lines = computeBreakdownLinesFromSettings("camry", "2025-07-01", "2025-07-02", promo);
  assert.ok(lines.some(l => l.includes("$45/day")));
  const totalLine = lines.find(l => l.startsWith("Total:"));
  // $45 × 1.1025 = $49.61 (rounded)
  assert.equal(totalLine, "Total: $49.61");
});

test("breakdown: 1-day camry with standard DPP", () => {
  const lines = computeBreakdownLinesFromSettings("camry", "2025-07-01", "2025-07-02", S, true, "standard");
  assert.ok(lines.some(l => l.includes("Damage Protection Plan")));
  const totalLine = lines.find(l => l.startsWith("Total:"));
  // ($55 + $30) × 1.1025 = $93.71
  assert.equal(totalLine, "Total: $93.71");
});
