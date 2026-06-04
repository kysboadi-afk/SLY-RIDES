// api/send-reservation-email.js
// Vercel serverless function — sends reservation emails via SMTP
//
// Required environment variables (set in Vercel dashboard):
//   SMTP_HOST    — SMTP server hostname  (e.g. smtp.gmail.com)
//   SMTP_PORT    — SMTP port             (587 for TLS, 465 for SSL)
//   SMTP_USER    — sending email address
//   SMTP_PASS    — email password or app password
//   OWNER_EMAIL  — business email that receives all reservation alerts
//                  (defaults to slyservices@supports-info.com)
//   STRIPE_SECRET_KEY — used to look up card last4 from a PaymentIntent (optional)
import nodemailer from "nodemailer";
import Stripe from "stripe";
import { hasOverlap } from "./_availability.js";
import { CARS, PROTECTION_PLAN_BASIC, PROTECTION_PLAN_STANDARD, PROTECTION_PLAN_PREMIUM } from "./_pricing.js";
import { loadPricingSettings, computeBreakdownLinesFromSettings } from "./_settings.js";
import { getVehicleById } from "./_vehicles.js";
import { render, BOOKING_CONFIRMED, MANAGE_BOOKING_ACCESS, BOOKING_ONBOARDING } from "./_sms-templates.js";
import { normalizePhone } from "./_bookings.js";
import { upsertContact, vehicleTag } from "./_contacts.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { persistBooking } from "./_booking-pipeline.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { resolvePickupLocation } from "./_pickup-location.js";
import { generateRentalAgreementPdf, dppTierLiabilityCap } from "./_rental-agreement-pdf.js";
import { normalizeClockTime, deriveReturnTime, formatTime12h, isoDateInLA } from "./_time.js";
import { sendDedupedSms } from "./_sms-log.js";
import { shouldSendBookingLifecycleSms } from "./_sms-rollout.js";
import { markBookingAgreementDelivery } from "./_agreement-automation.js";
import crypto from "crypto";

// Allow larger bodies so the renter's ID photo/PDF and insurance can be attached
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

const OWNER_EMAIL = process.env.OWNER_EMAIL || process.env.SMTP_USER || "slyservices@supports-info.com";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const MAX_OWNER_EMAIL_ATTACHMENT_BYTES = 12 * 1024 * 1024; // keep under common SMTP limits
const DEFAULT_ATTACHMENT_PRIORITY = 100;
const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKED_DATES_PATH  = "booked-dates.json";
const FLEET_STATUS_PATH  = "fleet-status.json";

/**
 * Update booked-dates.json in the GitHub repo to block the reserved dates.
 * Requires GITHUB_TOKEN env var with contents:write permission on the repo.
 * Failures are logged but do not abort the email response.
 */
async function blockBookedDates(_vehicleId, _from, _to) {
  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  console.log("send-reservation-email: blockBookedDates() called but writes are disabled (Phase 4)");
}

/**
 * Mark a vehicle as unavailable in fleet-status.json on GitHub.
 * Called automatically after a confirmed booking so the car card on the
 * website switches to the red "Unavailable / Booked" state immediately.
 * Requires GITHUB_TOKEN env var with contents:write permission on the repo.
 * Failures are logged but do not abort the email response.
 */
async function markVehicleUnavailable(vehicleId) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("GITHUB_TOKEN not set — fleet-status.json will not be updated automatically");
    return;
  }
  if (!vehicleId) return;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function loadFleetStatus() {
    const resp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers });
    if (!resp.ok) {
      if (resp.status === 404) return { data: {}, sha: null };
      const errText = await resp.text().catch(() => "");
      throw new Error(`GitHub GET failed: ${resp.status} ${errText}`);
    }
    const file = await resp.json();
    let data = {};
    try {
      data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    } catch (parseErr) {
      console.error("markVehicleUnavailable: malformed JSON in fleet-status.json, resetting:", parseErr);
      data = {};
    }
    return { data, sha: file.sha };
  }

  async function saveFleetStatus(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content, branch: GITHUB_DATA_BRANCH };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`GitHub PUT (fleet-status): ${resp.status} ${errText}`);
    }
  }

  // Use a sentinel symbol to signal "already unavailable — skip the write"
  // without extra API calls or shared mutable state.
  const ALREADY_UNAVAILABLE = Symbol("already_unavailable");
  try {
    await updateJsonFileWithRetry({
      load:  loadFleetStatus,
      apply: (data) => {
        // If the vehicle is already marked unavailable, bail out immediately.
        // updateJsonFileWithRetry will re-throw non-409 errors, so we catch
        // ALREADY_UNAVAILABLE below and treat it as a no-op.
        if (data[vehicleId] && data[vehicleId].available === false) {
          throw ALREADY_UNAVAILABLE;
        }
        if (!data[vehicleId]) data[vehicleId] = {};
        data[vehicleId].available = false;
      },
      save:    saveFleetStatus,
      message: `Mark ${vehicleId} unavailable after confirmed booking`,
    });
  } catch (err) {
    if (err !== ALREADY_UNAVAILABLE) throw err;
    // Vehicle was already unavailable — no write needed.
  }
}

// Escape special HTML characters to prevent XSS in email templates
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function estimateBase64Bytes(base64Value) {
  if (!base64Value || typeof base64Value !== "string") return 0;
  const normalized = base64Value.replace(/\s+/g, "").replace(/^data:.*;base64,/, "");
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : (normalized.endsWith("=") ? 1 : 0);
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function estimateAttachmentBytes(att) {
  if (!att) return 0;
  if (Buffer.isBuffer(att.content)) return att.content.length;
  if (typeof att.content === "string") {
    if (att.encoding === "base64") return estimateBase64Bytes(att.content);
    return Buffer.byteLength(att.content, "utf8");
  }
  return 0;
}

function selectOwnerEmailAttachments(candidates, maxBytes) {
  const ordered = (Array.isArray(candidates) ? candidates : [])
    .map((c, idx) => {
      const p = Number.isFinite(Number(c?.priority)) ? Number(c.priority) : DEFAULT_ATTACHMENT_PRIORITY;
      return { ...c, _idx: idx, _priority: p };
    })
    .sort((a, b) => (a._priority - b._priority) || (a._idx - b._idx));
  const attachments = [];
  const omitted = [];
  let totalBytes = 0;
  for (const c of ordered) {
    const sizeBytes = estimateAttachmentBytes(c.attachment);
    if (totalBytes + sizeBytes > maxBytes) {
      omitted.push(c.label || c.attachment?.filename || "attachment");
      continue;
    }
    totalBytes += sizeBytes;
    attachments.push(c.attachment);
  }
  return { attachments, omitted, totalBytes };
}

function isLikelyAttachmentDeliveryError(err) {
  const responseCode = Number(err?.responseCode);
  if (responseCode === 552 || responseCode === 554) return true;
  const message = String(err?.message || err || "").toLowerCase();
  return /attachment|message too large|size limit|content too large|exceed|mime/.test(message);
}

/**
 * Build a self-contained HTML document representing the signed rental agreement.
 * This is generated server-side from the verified booking data so it can be
 * attached to the owner confirmation email as a permanent record.
 *
 * @param {object} body - the validated request body from the email handler
 * @returns {string} complete HTML document as a string
 */
function generateRentalAgreementHtml(body) {
  const {
    vehicleId, car, vehicleMake, vehicleModel, vehicleYear, vehicleVin, vehicleColor,
    name, email, phone,
    pickup, pickupTime, returnDate, returnTime,
    total, deposit, days, protectionPlan, protectionPlanTier, signature,
    fullRentalCost, balanceAtPickup,
  } = body;

  const signedAt = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "long", timeStyle: "short" });

  // Economy car tier label
  const tierLabel = protectionPlanTier === "basic" ? "Basic ($15/day)"
    : protectionPlanTier === "premium" ? "Premium ($50/day)"
    : "Standard ($30/day)";
  // Economy car tier liability cap (Basic: $2,500 / Standard: $1,000 / Premium: $500)
  const tierLiabilityCap = dppTierLiabilityCap(protectionPlanTier);

  const dppDetail = protectionPlan
    ? `<strong>Damage Protection Plan &mdash; ${tierLabel}:</strong> selected &mdash; reduces your damage liability based on chosen plan`
    : `<strong>Damage Protection Plan:</strong> not selected (renter provided personal rental car insurance)`;
  const depositSection = `
    <p>No security deposit is required for this vehicle.</p>
    <p>${dppDetail}</p>
  `;

  const insuranceSummary = protectionPlan
    ? `Damage Protection Plan selected — ${tierLabel}`
    : "Renter provided personal rental car insurance";

  const durationLine = days ? `${esc(String(days))} day${Number(days) !== 1 ? "s" : ""}` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Signed Rental Agreement — SLY Car Rentals LLC</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 14px; color: #111; margin: 40px; line-height: 1.6; }
    h2 { text-align: center; border-bottom: 2px solid #111; padding-bottom: 8px; }
    h4 { margin-top: 20px; margin-bottom: 4px; border-bottom: 1px solid #ccc; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    td, th { padding: 7px 10px; border: 1px solid #999; }
    th { background: #f0f0f0; text-align: left; width: 40%; }
    .sig-block { background: #f9f9f9; border: 2px solid #111; padding: 16px 20px; margin-top: 30px; }
    .sig-name { font-size: 22px; font-style: italic; font-family: Georgia, serif; border-bottom: 1px solid #555; padding-bottom: 4px; margin: 10px 0 4px; }
    .watermark { color: green; font-size: 13px; font-weight: bold; }
    ul { margin: 4px 0 4px 20px; }
    p { margin: 6px 0; }
  </style>
</head>
<body>
  <h2>SLY CAR RENTALS — CAR RENTAL AGREEMENT</h2>
  <p style="text-align:center;font-size:13px;color:#555">Generated: ${esc(signedAt)} (Pacific Time)</p>

  <h4>PARTIES</h4>
  <p><strong>Owner:</strong> Sly Car Rentals &mdash; (844) 511-4059 &mdash; info@slytrans.com</p>
  <p><strong>Renter:</strong> ${esc(name || "Not provided")}</p>

  <h4>RENTER INFORMATION</h4>
  <table>
    <tr><th>Full Name</th><td>${esc(name || "Not provided")}</td></tr>
    <tr><th>Email</th><td>${esc(email || "Not provided")}</td></tr>
    <tr><th>Phone</th><td>${esc(phone || "Not provided")}</td></tr>
  </table>

  <h4>VEHICLE INFORMATION</h4>
  <table>
    <tr><th>Vehicle</th><td>${esc(car || "")}</td></tr>
    ${vehicleMake  ? `<tr><th>Make</th><td>${esc(vehicleMake)}</td></tr>`  : ""}
    ${vehicleModel ? `<tr><th>Model</th><td>${esc(vehicleModel)}</td></tr>` : ""}
    ${vehicleYear  ? `<tr><th>Year</th><td>${esc(String(vehicleYear))}</td></tr>` : ""}
    ${vehicleVin   ? `<tr><th>VIN / Plate</th><td>${esc(vehicleVin)}</td></tr>` : ""}
    ${vehicleColor ? `<tr><th>Color</th><td>${esc(vehicleColor)}</td></tr>` : ""}
  </table>
  <p>Fuel Level at Pickup: Full &nbsp;&nbsp; Half &nbsp;&nbsp; Quarter &nbsp;&nbsp;&nbsp; Condition Photos Attached: Yes</p>

  <h4>RENTAL PERIOD</h4>
  <table>
    <tr><th>Pickup Date</th><td>${esc(pickup || "")}</td></tr>
    <tr><th>Pickup Time</th><td>${esc(formatTime12h(pickupTime) || "Not specified")}</td></tr>
    <tr><th>Return Date</th><td>${esc(returnDate || "")}</td></tr>
    <tr><th>Return Time</th><td>${esc(formatTime12h(returnTime) || "Not specified")}</td></tr>
    ${durationLine ? `<tr><th>Duration</th><td>${durationLine}</td></tr>` : ""}
    <tr><th>Total Charged</th><td><strong>$${esc(total || "TBD")}</strong></td></tr>
    ${balanceAtPickup ? `<tr><th>Balance Due at Pickup</th><td><strong>$${esc(balanceAtPickup)}</strong></td></tr>` : ""}
    <tr><th>Insurance / Protection</th><td>${esc(insuranceSummary)}</td></tr>
  </table>
  <p><strong>Late Fee:</strong> $50/day after a 2-hour grace period.</p>

  <h4>MILEAGE, GEOGRAPHIC USE &amp; FUEL</h4>
  <p><strong>Mileage &amp; Geographic Limit:</strong> Unlimited miles are included within a designated local area only. All vehicle use must remain within <strong>Los Angeles County</strong> or within a <strong>50-mile radius of Los Angeles</strong>, unless otherwise approved in writing by the host. Travel outside this area — including trips to San Diego, San Francisco, Las Vegas, or any out-of-state destination — is not allowed without prior written authorization. Unauthorized use outside the approved area will result in a <strong>$500 penalty fee</strong> and may lead to early termination of the rental without refund. The vehicle is equipped with a GPS tracking system for security and compliance; by renting, you consent to location monitoring during the rental period.</p>
  <p><strong>Fuel Policy:</strong> Return the vehicle with the same fuel level as at pickup, or pay a $5/gallon replacement fee.</p>

  ${depositSection}

  <h4>INSURANCE &amp; LIABILITY</h4>
  <p>Renter must provide <strong>one of the following</strong> prior to vehicle release:</p>
  <ul>
    <li>Valid personal auto insurance covering rental vehicles (proof required), <strong>OR</strong></li>
    <li>Purchase of Sly Car Rentals Damage Protection Plan</li>
  </ul>
  <p><strong>Damage Protection Plan (Optional):</strong> Basic &mdash; $${PROTECTION_PLAN_BASIC}/day &bull; Standard &mdash; $${PROTECTION_PLAN_STANDARD}/day &bull; Premium &mdash; $${PROTECTION_PLAN_PREMIUM}/day</p>
  <p>Liability cap depends on plan selected: Basic &mdash; $2,500 &bull; Standard &mdash; $1,000 &bull; Premium &mdash; $500 per incident.</p>
  <p><strong>Without Protection Plan:</strong> Renter is fully responsible for all damages and associated costs, including but not limited to:</p>
  <ul>
    <li>Full cost of vehicle repair or replacement</li>
    <li>Loss of use (rental downtime)</li>
    <li>Diminished value</li>
    <li>Administrative, towing, and storage fees</li>
  </ul>
  <p><strong>With Protection Plan:</strong> Renter's maximum liability for covered vehicle damage is limited to <strong>${tierLiabilityCap} per incident</strong>. Any damage costs exceeding this cap are covered by the plan, provided all terms of this agreement are followed.</p>
  <p><strong>Exclusions (Protection Plan Void If):</strong></p>
  <ul>
    <li>Driver is under the influence of drugs or alcohol</li>
    <li>Unauthorized driver operates the vehicle</li>
    <li>Reckless, illegal, or negligent use</li>
    <li>Off-road or prohibited use</li>
    <li>Failure to report damage within 24 hours</li>
    <li>Violation of rental agreement terms</li>
  </ul>
  <p><strong>Third-Party Liability:</strong> Renter is solely responsible for any third-party claims, including bodily injury, property damage, or death. Sly Car Rentals is not liable for renter negligence. Renter agrees to indemnify and hold harmless Sly Car Rentals from any claims, losses, or expenses arising from vehicle use.</p>

  <h4>USE RESTRICTIONS</h4>
  <p>Renter agrees to all of the following restrictions:</p>
  <p>No smoking &nbsp; No pets &nbsp; No off-road use &nbsp; No subleasing</p>
  <p>Approved drivers only &nbsp; No racing or towing &nbsp; No commercial hauling</p>

  <h4>CONDITION INSPECTION</h4>
  <p>Vehicle is inspected and accepted as-is at time of pickup. Condition photos are taken at pickup. Renter must report any pre-existing damage within 24 hours of pickup.</p>

  <h4>TERMINATION</h4>
  <p>Sly Car Rentals may terminate this agreement immediately for breach of terms, unpaid fees, unlawful use, or safety violations. Renter is liable for all costs to recover the vehicle.</p>

  <h4>PAYMENT TERMS</h4>
  <p>All fees are due at pickup. Late payments accrue interest at 1.5% per month. NSF (returned check) fee: $35.</p>
  <p>&#9888; <strong>No-Refund Policy:</strong> All payments are final once a booking is confirmed. Cancellations or no-shows after booking are not eligible for a refund. Refunds may be issued only if Sly Car Rentals cancels or cannot fulfill the rental.</p>

  <h4>PAYMENT AUTHORIZATION &amp; CHARGEBACK POLICY</h4>
  <p>By signing this agreement, renter expressly authorizes Sly Car Rentals to charge the payment method on file for all amounts owed under this agreement, including but not limited to:</p>
  <ul>
    <li>Rental charges and extensions</li>
    <li>Security deposit and any applicable deductions</li>
    <li>Vehicle damage, repair, or replacement costs</li>
    <li>Loss of use and diminished value</li>
    <li>Fuel, cleaning, smoking, or excess wear fees</li>
    <li>Towing, storage, tickets, tolls, and administrative fees</li>
  </ul>
  <p>Renter agrees that these charges may be processed after the rental period if additional costs are identified upon inspection or later discovery.</p>
  <p>Renter acknowledges that all charges are valid, agreed upon, and authorized under this contract. Renter agrees not to dispute, reverse, or initiate a chargeback for any legitimate charge incurred in accordance with this agreement.</p>
  <p><strong>In the event of a payment dispute or chargeback, renter agrees that:</strong></p>
  <ul>
    <li>This signed agreement serves as binding proof of authorization</li>
    <li>Sly Car Rentals may submit this agreement, along with rental records, photos, inspection reports, and communication logs, as evidence to the payment processor</li>
    <li>Renter remains financially responsible for all charges, including any fees resulting from the dispute</li>
  </ul>
  <p>If a chargeback is initiated without valid cause, Sly Car Rentals reserves the right to pursue collection, legal action, and recovery of all associated costs, including reasonable attorney's fees where permitted by law.</p>

  <h4>GOVERNING LAW</h4>
  <p>This agreement is governed by the laws of the State of California. Disputes shall be resolved in the courts of Los Angeles County. By signing, the renter acknowledges they have read, understood, and agreed to all terms above.</p>

  <div class="sig-block">
    <p><strong>ELECTRONIC SIGNATURE</strong></p>
    <p>By typing their name below, the renter agrees to all terms of this Rental Agreement. This electronic signature is legally binding. By signing, the renter confirms they are <strong>21 years of age or older</strong> and have full legal capacity to enter into this agreement.</p>
    <p class="sig-name">${esc(signature || "")}</p>
    <p class="watermark">&#10003; Digitally Signed</p>
    <p style="font-size:13px;color:#555">Signed: ${esc(signedAt)} (Pacific Time)</p>
    <p style="font-size:13px;color:#555">Renter: ${esc(name || "Not provided")} &nbsp;|&nbsp; Email: ${esc(email || "Not provided")} &nbsp;|&nbsp; Phone: ${esc(phone || "Not provided")}</p>
  </div>
</body>
</html>`;
}

/**
 * Retrieve the last 4 digits of the card used for a PaymentIntent via Stripe API.
 * Returns null if the key is missing, the lookup fails, or no card data is available.
 *
 * @param {string} paymentIntentId
 * @returns {Promise<string|null>}
 */
async function fetchCardLast4(paymentIntentId) {
  if (!paymentIntentId || !process.env.STRIPE_SECRET_KEY) return null;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["payment_method"],
    });
    return pi.payment_method?.card?.last4 || null;
  } catch (err) {
    console.warn("fetchCardLast4: failed to retrieve payment method:", err.message);
    return null;
  }
}

async function fetchPaymentIntentStatus(paymentIntentId) {
  if (!paymentIntentId || !process.env.STRIPE_SECRET_KEY) return null;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    return pi?.status || null;
  } catch (err) {
    console.warn(`fetchPaymentIntentStatus: failed for PI ${paymentIntentId}:`, err.message);
    return null;
  }
}

function isNullOrEmptyString(v) {
  return v == null || (typeof v === "string" && !v.trim());
}

function inferInsuranceCoverageChoice(insuranceStatus, tier) {
  if (insuranceStatus === "own_insurance_provided") return "yes";
  if (insuranceStatus === "no_insurance_no_dpp" || insuranceStatus === "no_insurance_dpp") return "no";
  return tier ? "no" : "";
}

const RECOVERABLE_BOOKING_FIELDS = [
  "vehicleId",
  "bookingId",
  "car",
  "name",
  "phone",
  "email",
  "pickup",
  "pickupTime",
  "returnDate",
  "returnTime",
  "total",
  "fullRentalCost",
  "balanceAtPickup",
  "paymentType",
  "paymentStatus",
  "paymentIntentId",
  "protectionPlanTier",
  "protectionPlan",
  "insuranceCoverageChoice",
];

/**
 * Recover a minimal booking payload from Stripe PaymentIntent metadata.
 * Used when success.html lost sessionStorage but still has paymentIntentId.
 *
 * @param {string} paymentIntentId
 * @returns {Promise<object|null>}
 */
async function hydrateBookingBodyFromPaymentIntent(paymentIntentId) {
  if (!paymentIntentId || !process.env.STRIPE_SECRET_KEY) return null;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== "succeeded") {
      console.warn(`hydrateBookingBodyFromPaymentIntent: PI ${paymentIntentId} is not succeeded (status=${pi.status})`);
      return null;
    }

    const meta = pi.metadata || {};
    const vehicleId = meta.vehicle_id || "";
    const pickup = meta.pickup_date || "";
    const returnDate = meta.return_date || "";
    const pickupTime = normalizeClockTime(meta.pickup_time);
    const metaReturnTime = normalizeClockTime(meta.return_time);
    const returnTime = deriveReturnTime(pickup, pickupTime, metaReturnTime);

    if (!vehicleId || !pickup || !returnDate || !pickupTime) {
      console.warn(
        `hydrateBookingBodyFromPaymentIntent: missing metadata for PI ${paymentIntentId}` +
        ` vehicle_id=${vehicleId || "<missing>"} pickup_date=${pickup || "<missing>"}` +
        ` return_date=${returnDate || "<missing>"} pickup_time=${pickupTime || "<missing>"}`
      );
      return null;
    }

    const amountDollars = Number((Number(pi.amount_received || pi.amount || 0) / 100).toFixed(2));
    const paymentType = meta.payment_type || "full_payment";
    const tier = meta.protection_plan_tier || "";
    const insuranceStatus = String(meta.insurance_status || "").toLowerCase();
    const inferredInsuranceChoice = inferInsuranceCoverageChoice(insuranceStatus, tier);

    return {
      vehicleId,
      bookingId: meta.booking_id || "",
      car: meta.vehicle_name || (CARS[vehicleId] && CARS[vehicleId].name) || vehicleId,
      name: meta.renter_name || "",
      phone: meta.renter_phone || "",
      email: meta.email || "",
      pickup,
      pickupTime,
      returnDate,
      returnTime,
      total: amountDollars ? amountDollars.toFixed(2) : "0.00",
      fullRentalCost: meta.full_rental_amount || "",
      balanceAtPickup: meta.balance_at_pickup || meta.remaining_balance || "",
      paymentType,
      paymentStatus: "confirmed",
      paymentIntentId,
      protectionPlanTier: tier || undefined,
      protectionPlan: !!tier,
      insuranceCoverageChoice: inferredInsuranceChoice || undefined,
    };
  } catch (err) {
    console.warn(`hydrateBookingBodyFromPaymentIntent: failed for PI ${paymentIntentId}:`, err.message);
    return null;
  }
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_PORT === "465",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function roundToDollarAmount(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

/**
 * Build the core booking record for persistBooking() from request body fields.
 * Shared between the SMTP-missing early fallback and the normal confirmation flow.
 *
 * @param {object} fields  - destructured req.body fields
 * @param {string} [paymentLink] - optional balance-pay URL (not yet computed in early path)
 * @returns {object}
 */
function buildBookingRecord(fields, paymentLink = "") {
  const {
    vehicleId, bookingId, car, name, phone, email,
    pickup, pickupTime, returnDate, returnTime,
    total, fullRentalCost, paymentIntentId,
  } = fields;
  const amountPaid = roundToDollarAmount(total);
  const totalPrice = fullRentalCost ? roundToDollarAmount(fullRentalCost) : amountPaid;
  const hasBalanceDue = totalPrice > amountPaid;
  return {
    bookingId,
    vehicleId,
    vehicleName:     car || (CARS[vehicleId] && CARS[vehicleId].name) || vehicleId,
    name:            name || "",
    phone:           phone || "",
    email:           email || "",
    pickupDate:      pickup || "",
    pickupTime:      pickupTime || "",
    returnDate:      returnDate || "",
    returnTime:      returnTime || "",
    location:        resolvePickupLocation({ vehicleId, vehicleName: car }),
    status:          hasBalanceDue ? "reserved" : "booked_paid",
    amountPaid,
    totalPrice,
    paymentIntentId: paymentIntentId || "",
    paymentLink,
    paymentMethod:   "stripe",
    source:          "public_booking",
  };
}

async function verifyBookingAndRevenueForEmail(bookingRef, paymentIntentId, opts = {}) {
  const requireRevenuePaymentIntentMatch = opts.requireRevenuePaymentIntentMatch !== false;
  const sb = getSupabaseAdmin();
  if (!bookingRef || !paymentIntentId) {
    return { ok: false, reason: "missing booking ref or payment intent id" };
  }
  if (!sb) {
    // Supabase is unavailable in some local/test environments; skip strict DB
    // verification there, but keep strict checks when Supabase is configured.
    return { ok: true, skipped: true };
  }

  const bookingQuery = sb
      .from("bookings")
      .select("booking_ref,payment_intent_id")
      .eq("booking_ref", bookingRef)
      .maybeSingle();
  const revenueQuery = sb
      .from("revenue_records")
      .select("booking_id,payment_intent_id")
      .eq("booking_id", bookingRef)
      .maybeSingle();
  if (requireRevenuePaymentIntentMatch) {
    bookingQuery.eq("payment_intent_id", paymentIntentId);
    revenueQuery.eq("payment_intent_id", paymentIntentId);
  }

  const [{ data: bookingRow, error: bookingErr }, { data: revenueRow, error: revenueErr }] = await Promise.all([
    bookingQuery,
    revenueQuery,
  ]);

  if (bookingErr || !bookingRow) {
    return { ok: false, reason: bookingErr?.message || "booking record not found in Supabase" };
  }
  if (revenueErr || !revenueRow) {
    return { ok: false, reason: revenueErr?.message || "revenue record not found in Supabase" };
  }

  return { ok: true };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Parse body first so the booking can always be persisted, even when SMTP
  // credentials are missing.  A misconfigured email server must never cause a
  // paid booking to be silently lost.
  const requestBody = (req.body && typeof req.body === "object" && !Array.isArray(req.body))
    ? { ...req.body }
    : {};
  const requestPaymentIntentId = typeof requestBody.paymentIntentId === "string"
    ? requestBody.paymentIntentId.trim()
    : "";
  const requestPickupTime = normalizeClockTime(requestBody.pickupTime);
  const isTestMode = !!process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith("sk_test_");
  if (isTestMode) {
    console.log("[send-reservation-email] TEST MODE → do NOT create bookings, block dates, or update availability");
  }
  // Recovery mode is inferred when success.html can provide paymentIntentId but
  // lost the form payload in sessionStorage (so pickupTime is absent).
  const usedRecoveryPath = !requestPickupTime && !!requestPaymentIntentId;
  let hydratedBody = { ...requestBody };

  // Recovery path: if success.html lost sessionStorage, it can still call this
  // endpoint with only paymentIntentId. Hydrate required fields from Stripe metadata.
  if (usedRecoveryPath) {
    const recovered = await hydrateBookingBodyFromPaymentIntent(requestPaymentIntentId);
    if (recovered) {
      for (const key of RECOVERABLE_BOOKING_FIELDS) {
        const value = recovered[key];
        if (isNullOrEmptyString(hydratedBody[key])) hydratedBody[key] = value;
      }
    }
  }

  if (!hydratedBody.vehicleVin && hydratedBody.vehicleId) {
    hydratedBody.vehicleVin = (CARS[hydratedBody.vehicleId] && CARS[hydratedBody.vehicleId].vin) || "";
    if (!hydratedBody.vehicleVin) {
      try {
        const vehicleData = await getVehicleById(hydratedBody.vehicleId);
        hydratedBody.vehicleVin = vehicleData?.vin || "";
      } catch (vinLookupErr) {
        console.warn("[send-reservation-email] VIN lookup failed (non-fatal):", vinLookupErr.message);
      }
    }
  }

  const { vehicleId, bookingId, car, vehicleMake, vehicleModel, vehicleYear, vehicleVin, vehicleColor, name, pickup, pickupTime: rawPickupTime, returnDate, returnTime: rawReturnTime, email, phone, total, pricePerDay, pricePerWeek, pricePerBiWeekly, pricePerMonthly, deposit, days, idBase64, idFileName, idMimeType, idBackBase64, idBackFileName, idBackMimeType, insuranceBase64, insuranceFileName, insuranceMimeType, protectionPlan, protectionPlanTier, signature, paymentStatus, fullRentalCost, balanceAtPickup, paymentType, paymentIntentId, insuranceCoverageChoice } = hydratedBody;
  const normalizedPaymentStatus = typeof paymentStatus === "string" ? paymentStatus.trim().toLowerCase() : "";

  const pickupTime = normalizeClockTime(rawPickupTime);
  if (!pickupTime) {
    return res.status(400).json({
      error: usedRecoveryPath
        ? "Unable to process booking confirmation automatically. Please contact support with your payment confirmation."
        : "Pickup time is required. Please select a pickup time before proceeding.",
    });
  }
  const returnTime = deriveReturnTime(pickup, pickupTime, rawReturnTime);
  if (!returnTime) {
    return res.status(400).json({
      error: usedRecoveryPath
        ? "Missing required return time. Please contact support with your payment confirmation to complete the booking."
        : "Return time is required. Please select a return time before proceeding.",
    });
  }
  const bookingBody = { ...hydratedBody, pickupTime, returnTime };

  // Guard: fail fast if SMTP credentials are missing — but persist the booking
  // first so a paid booking is never lost due to email misconfiguration.
  // Convention (matching line ~854): absent paymentStatus is treated as "confirmed"
  // because success.html always sends "confirmed" for successful payments and omits
  // the field otherwise — an absent value here is always a confirmed payment.
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.error("Missing SMTP environment variables (SMTP_HOST, SMTP_USER, SMTP_PASS). Add them in your Vercel project → Settings → Environment Variables.");
    const isConfirmedPayment  = normalizedPaymentStatus === "confirmed";
    const isBalancePaymentReq = paymentType === "balance_payment";
    if (!isTestMode && isConfirmedPayment && !isBalancePaymentReq && vehicleId && (email || phone)) {
      try {
        await persistBooking(buildBookingRecord(bookingBody));
        console.log("[send-reservation-email] SMTP not configured — booking persisted via early fallback");
      } catch (pipelineErr) {
        console.error("[send-reservation-email] SMTP missing and early booking persist also failed:", pipelineErr.message);
      }
    }
    return res.status(500).json({ error: "Server configuration error: SMTP credentials are not set." });
  }

  // Extract the customer's IP address from reverse-proxy headers (Vercel sets x-forwarded-for).
  const customerIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || null;

  // Compute server-side pricing breakdown lines for daily/weekly rentals using
  // live admin-configurable rates from system_settings.
  const pricingSettings = (vehicleId && pickup && returnDate)
    ? await loadPricingSettings()
    : null;
  // For vehicles not in the hardcoded economy list, fetch live vehicle data so
  // computeBreakdownLinesFromSettings can use the vehicle's own stored rates.
  const isKnownEconomy = (vehicleId === "camry" || vehicleId === "camry2013");
  const vehicleDataForBreakdown = (pricingSettings && !isKnownEconomy && vehicleId)
    ? await getVehicleById(vehicleId).catch(() => null)
    : null;
  const breakdownLines = pricingSettings
    ? computeBreakdownLinesFromSettings(vehicleId, pickup, returnDate, pricingSettings, !!protectionPlan, protectionPlanTier || null, vehicleDataForBreakdown)
    : null;
  const breakdownText = breakdownLines ? breakdownLines.join("\n") : null;
  const breakdownHtml = breakdownLines
    ? `<table style="border-collapse:collapse;width:100%;margin-top:4px">
        ${breakdownLines.map(line => {
          const isTotal = line.startsWith("Total:");
          return `<tr><td style="padding:6px 8px;border:1px solid #ddd${isTotal ? ";font-weight:bold" : ""}">${esc(line)}</td></tr>`;
        }).join("")}
      </table>`
    : null;

  if (normalizedPaymentStatus !== "confirmed") {
    console.log(`[send-reservation-email] skipping email send: paymentStatus=${normalizedPaymentStatus}`);
    return res.status(200).json({ success: true, emailSkipped: true, reason: "payment_not_confirmed" });
  }
  const normalizedPaymentIntentId = typeof paymentIntentId === "string" ? paymentIntentId.trim() : "";
  if (!normalizedPaymentIntentId) {
    console.warn("[send-reservation-email] skipping email send: missing payment_intent_id");
    return res.status(200).json({ success: true, emailSkipped: true, reason: "missing_payment_intent_id" });
  }
  const paymentIntentStatus = await fetchPaymentIntentStatus(normalizedPaymentIntentId);
  if (paymentIntentStatus !== "succeeded") {
    console.warn(`[send-reservation-email] skipping email send: PI ${normalizedPaymentIntentId} status=${paymentIntentStatus || "unknown"}`);
    return res.status(200).json({ success: true, emailSkipped: true, reason: "payment_not_succeeded" });
  }

  // Emails and attachments are sent only for succeeded Stripe payments.
  const isConfirmed = true;

  // isBalancePayment: true when the renter is paying the remaining balance after
  // having already paid the $50 reservation deposit.
  const isBalancePayment = paymentType === "balance_payment";

  // For deposit bookings, build a "Pay Balance Online" URL so the renter can
  // complete their final payment without re-filling the form.
  // The link encodes only booking params — amounts are always recomputed server-side.
  let balancePayUrl = null;
  if (isConfirmed && !isBalancePayment && fullRentalCost && vehicleId && pickup && returnDate && email) {
    const bpParts = [
      ["v",   vehicleId],
      ["p",   pickup],
      ["r",   returnDate],
      ["pp",  protectionPlan ? "1" : "0"],
      ...(name      ? [["n",   name]]      : []),
      ...(email     ? [["e",   email]]     : []),
      ...(phone     ? [["ph",  phone]]     : []),
      ...(pickupTime  ? [["pt", pickupTime]]  : []),
      ...(returnTime  ? [["rt", returnTime]]  : []),
      ...(car       ? [["car", car]]       : []),
    ];
    balancePayUrl = "https://slycarrentals.com/balance.html?" +
      bpParts.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  }

  const totalChargedLabel = isBalancePayment
    ? "Balance Paid"
    : (fullRentalCost ? "Booking Deposit Charged" : "Total Charged");
  const ownerSubject = isBalancePayment
    ? `🎉 Balance Paid – Booking Fully Paid: ${esc(car)}`
    : `💰 Payment Confirmed – New Booking: ${esc(car)}`;
  const statusLabel  = "✅ CONFIRMED";
  const statusColor  = "green";
  const introText    = isBalancePayment
    ? "The renter has paid the remaining balance online. The booking is now fully paid."
    : "A customer has completed payment. Their rental details are below.";
  const footerText   = isBalancePayment
    ? "The remaining balance has been received. The booking is now fully paid — no further action required."
    : "Payment has been received. Please contact the customer to confirm rental details.";

  try {
    // Fetch card last4 from Stripe when a PaymentIntent ID was provided.
    // This is non-blocking — a lookup failure does not abort the email flow.
    const cardLast4 = isConfirmed && paymentIntentId ? await fetchCardLast4(paymentIntentId) : null;

    // Build attachment list for the owner email
    const ownerAttachmentCandidates = [];
    if (idBase64 && idFileName) {
      ownerAttachmentCandidates.push({
        label: `ID front (${idFileName})`,
        priority: 10,
        attachment: {
        filename: idFileName,
        content: idBase64,
        encoding: "base64",
        contentType: idMimeType || "application/octet-stream",
        },
      });
    }
    if (idBackBase64 && idBackFileName) {
      ownerAttachmentCandidates.push({
        label: `ID back (${idBackFileName})`,
        priority: 20,
        attachment: {
        filename: idBackFileName,
        content: idBackBase64,
        encoding: "base64",
        contentType: idBackMimeType || "application/octet-stream",
        },
      });
    }
    if (insuranceBase64 && insuranceFileName) {
      ownerAttachmentCandidates.push({
        label: `Insurance (${insuranceFileName})`,
        priority: 40,
        attachment: {
        filename: insuranceFileName,
        content: insuranceBase64,
        encoding: "base64",
        contentType: insuranceMimeType || "application/octet-stream",
        },
      });
    }
    // Generate a signed PDF rental agreement for confirmed payments with a signature.
    // The PDF is attached to both the owner and the renter emails.
    let agreementPdfBuffer = null;
    let agreementPdfFilename = null;
    if (isConfirmed && signature) {
      const safeName = (name || "renter").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
      const safeDate = (pickup || isoDateInLA()).replace(/[^0-9-]/g, "");
      agreementPdfFilename = `rental-agreement-${safeName}-${safeDate}.pdf`;
      agreementPdfBuffer = await generateRentalAgreementPdf(bookingBody, customerIp, cardLast4);
      ownerAttachmentCandidates.push({
        label: `Rental agreement (${agreementPdfFilename})`,
        priority: 30,
        attachment: {
          filename: agreementPdfFilename,
          content: agreementPdfBuffer,
          contentType: "application/pdf",
        },
      });
    }
    const { attachments, omitted: omittedAttachmentNotes } = selectOwnerEmailAttachments(
      ownerAttachmentCandidates,
      MAX_OWNER_EMAIL_ATTACHMENT_BYTES
    );
    const attachedOwnerFiles = new Set(attachments.map((a) => a.filename));
    const idFrontAttached = !!(idBase64 && idFileName && attachedOwnerFiles.has(idFileName));
    const idBackAttached = !!(idBackBase64 && idBackFileName && attachedOwnerFiles.has(idBackFileName));
    const insuranceAttached = !!(insuranceBase64 && insuranceFileName && attachedOwnerFiles.has(insuranceFileName));
    const agreementAttached = !!(agreementPdfBuffer && agreementPdfFilename && attachedOwnerFiles.has(agreementPdfFilename));

    // --- Notify owner ---
    // Skip the owner email when the Stripe webhook already sent the full
    // confirmation (with agreement PDF + ID + insurance) to avoid duplicates.
    let webhookAlreadySentOwnerEmail = false;
    if (isConfirmed && !isBalancePayment && bookingId) {
      try {
        const sb = getSupabaseAdmin();
        if (sb) {
          const { data: docsRow } = await sb
            .from("pending_booking_docs")
            .select("email_sent")
            .eq("booking_id", bookingId)
            .maybeSingle();
          webhookAlreadySentOwnerEmail = !!(docsRow && docsRow.email_sent === true);
        }
      } catch (docsCheckErr) {
        // Non-fatal — if the check fails, send the email anyway
        console.warn("[send-reservation-email] pending_booking_docs check failed (non-fatal):", docsCheckErr.message);
      }
    }

    let ownerEmailErr = null;
    let ownerEmailSent = false;
    let customerEmailSent = false;
    if (webhookAlreadySentOwnerEmail) {
      console.log(`[send-reservation-email] webhook already sent owner email for booking ${bookingId} — skipping duplicate owner email`);
    } else {
    console.log(`[send-reservation-email] entering owner email block — to=${OWNER_EMAIL} SMTP_HOST=${process.env.SMTP_HOST || "(not set)"} booking=${bookingId || "(no id)"} attachments=${attachments.length} files=[${attachments.map(a => a.filename).join(", ") || "none"}]`);
    const ownerEmailOpts = {
      from: `"Sly Car Rentals LLC Bookings" <${process.env.SMTP_USER}>`,
      to: OWNER_EMAIL,
      subject: ownerSubject,
      attachments,
      ...(email ? { replyTo: email } : {}),
      text: [
        isConfirmed ? "Payment Confirmed – New Booking" : "Payment Failed – Booking Attempt",
        "",
        `Payment Status : ${isConfirmed ? "CONFIRMED" : "FAILED"}`,
        `Vehicle        : ${car || ""}`,
        vehicleMake  ? `Make           : ${vehicleMake}`  : "",
        vehicleModel ? `Model          : ${vehicleModel}` : "",
        vehicleYear  ? `Year           : ${vehicleYear}`  : "",
        vehicleVin   ? `VIN / Plate    : ${vehicleVin}`   : "",
        vehicleColor ? `Color          : ${vehicleColor}` : "",
        `Renter Name    : ${name || "Not provided"}`,
        `Pickup Date    : ${pickup || ""}`,
        `Pickup Time    : ${formatTime12h(pickupTime) || "Not specified"}`,
        `Return Date    : ${returnDate || ""}`,
        `Return Time    : ${formatTime12h(returnTime) || "Not specified"}`,
        `Customer Email : ${email || "Not provided"}`,
        `Phone          : ${phone || "Not provided"}`,
        `Number of Days : ${days || "N/A"}`,
        `Daily Rate     : ${pricePerDay != null ? "$" + pricePerDay + " / day" : "N/A"}`,
        pricePerWeek     ? `Weekly Rate    : $${pricePerWeek} / week`       : "",
        pricePerBiWeekly ? `Bi-Weekly Rate : $${pricePerBiWeekly} / 2 weeks` : "",
        pricePerMonthly  ? `Monthly Rate   : $${pricePerMonthly} / month`    : "",
        `Deposit        : ${deposit != null && deposit > 0 ? "$" + deposit : "None"}`,
        `${totalChargedLabel.padEnd(15)}: $${total || "TBD"}`,
        fullRentalCost   ? `Full Rental Cost: $${fullRentalCost}` : "",
        balanceAtPickup ? `Balance at Pickup: $${balanceAtPickup}` : "",
        (protectionPlan != null ? `Insurance      : ${protectionPlan ? "Damage Protection Plan (no personal coverage)" : (insuranceBase64 && insuranceFileName ? "Own insurance (proof uploaded)" : "Own insurance (no proof on file — verify at pickup)")}` : ""),
        signature ? `Digital Signature: ${signature}` : "",
        breakdownText ? "\nPrice Breakdown:\n" + breakdownText : "",
        "",
        idFrontAttached ? `ID (front) attached: ${idFileName}` : (idBase64 && idFileName ? `ID (front) omitted from email due to attachment size limit: ${idFileName}` : "No ID front was uploaded by the renter."),
        idBackAttached ? `ID (back) attached: ${idBackFileName}` : (idBackBase64 && idBackFileName ? `ID (back) omitted from email due to attachment size limit: ${idBackFileName}` : "No ID back was uploaded by the renter."),
        (insuranceAttached
          ? `Insurance attached: ${insuranceFileName}`
          : (insuranceBase64 && insuranceFileName
              ? `Insurance omitted from email due to attachment size limit: ${insuranceFileName}`
              : (protectionPlan ? "No insurance upload (renter chose Damage Protection Plan)." : "No insurance document was uploaded by the renter."))),
        agreementAttached ? `Signed Rental Agreement: attached (${agreementPdfFilename})` : (isConfirmed && signature && agreementPdfFilename ? `Signed Rental Agreement omitted from email due to attachment size limit: ${agreementPdfFilename}` : ""),
        omittedAttachmentNotes.length ? `Attachments omitted due to email size limit: ${omittedAttachmentNotes.join(", ")}` : "",
        omittedAttachmentNotes.length ? "Documents are still stored server-side and can be resent from admin." : "",
        "",
        footerText,
      ].filter((line) => line !== undefined).join("\n"),
      html: `
        <h2>${ownerSubject}</h2>
        <p>${introText}</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #ddd;color:${statusColor}"><strong>${statusLabel}</strong></td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(car)}</td></tr>
          ${vehicleMake  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Make</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleMake)}</td></tr>`  : ""}
          ${vehicleModel ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Model</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleModel)}</td></tr>` : ""}
          ${vehicleYear  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Year</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(String(vehicleYear))}</td></tr>`  : ""}
          ${vehicleVin   ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>VIN / Plate</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleVin)}</td></tr>`   : ""}
          ${vehicleColor ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Color</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleColor)}</td></tr>` : ""}
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Renter Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(name || "Not provided")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickup)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Time</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(formatTime12h(pickupTime)) || "Not specified"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Time</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(formatTime12h(returnTime)) || "Not specified"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Customer Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(email) || "Not provided"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(phone) || "Not provided"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Number of Days</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(String(days || "N/A"))}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Daily Rate</strong></td><td style="padding:8px;border:1px solid #ddd">${pricePerDay != null ? "$" + esc(String(pricePerDay)) + " / day" : "N/A"}</td></tr>
          ${pricePerWeek     ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Weekly Rate</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(pricePerWeek))} / week</td></tr>` : ""}
          ${pricePerBiWeekly ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Bi-Weekly Rate</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(pricePerBiWeekly))} / 2 weeks</td></tr>` : ""}
          ${pricePerMonthly  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Monthly Rate</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(pricePerMonthly))} / month</td></tr>` : ""}
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Deposit</strong></td><td style="padding:8px;border:1px solid #ddd">${deposit != null && deposit > 0 ? "$" + esc(String(deposit)) : "None"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalChargedLabel)}</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>$${esc(total) || "TBD"}</strong></td></tr>
          ${fullRentalCost ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Full Rental Cost</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(fullRentalCost)}</td></tr>` : ""}
          ${balanceAtPickup ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Balance Due at Pickup</strong></td><td style="padding:8px;border:1px solid #ddd;color:#ff9800"><strong>$${esc(balanceAtPickup)}</strong></td></tr>` : ""}
          ${protectionPlan != null ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Insurance Coverage</strong></td><td style="padding:8px;border:1px solid #ddd">${protectionPlan ? "⚠️ Damage Protection Plan (no personal coverage)" : (insuranceBase64 && insuranceFileName ? "✅ Own insurance (proof uploaded)" : "⚠️ Own insurance (no proof uploaded — verify at pickup)")}</td></tr>` : ""}
          ${signature ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Digital Signature</strong></td><td style="padding:8px;border:1px solid #ddd;font-style:italic">${esc(signature)}</td></tr>` : ""}
        </table>
        ${breakdownHtml ? `<h3 style="margin-top:16px">📊 Price Breakdown</h3>${breakdownHtml}` : ""}
        ${idFrontAttached ? `<p>📎 <strong>Renter's ID (front) is attached</strong> to this email (${esc(idFileName)}).</p>` : (idBase64 && idFileName ? `<p>⚠️ Renter's ID (front) was uploaded but omitted from this email due to attachment size limit (${esc(idFileName)}).</p>` : `<p>⚠️ No ID front was uploaded by the renter.</p>`)}
        ${idBackAttached ? `<p>📎 <strong>Renter's ID (back) is attached</strong> to this email (${esc(idBackFileName)}).</p>` : (idBackBase64 && idBackFileName ? `<p>⚠️ Renter's ID (back) was uploaded but omitted from this email due to attachment size limit (${esc(idBackFileName)}).</p>` : `<p>⚠️ No ID back was uploaded by the renter.</p>`)}
        ${insuranceAttached
          ? `<p>🛡️ <strong>Renter's insurance document is attached</strong> to this email (${esc(insuranceFileName)}).</p>`
          : (insuranceBase64 && insuranceFileName
              ? `<p>⚠️ Renter's insurance document was uploaded but omitted from this email due to attachment size limit (${esc(insuranceFileName)}).</p>`
              : (protectionPlan
              ? `<p>ℹ️ Renter chose the Damage Protection Plan — no personal insurance was uploaded.</p>`
              : `<p>⚠️ Renter declared own insurance but did not upload proof — <strong>verify insurance at pickup before releasing the vehicle</strong>.</p>`))
        }
        ${agreementAttached ? `<p>📄 <strong>Signed Rental Agreement is attached</strong> to this email as a PDF file.</p>` : (isConfirmed && signature && agreementPdfFilename ? `<p>⚠️ Signed Rental Agreement was generated but omitted from this email due to attachment size limit (${esc(agreementPdfFilename)}).</p>` : "")}
        ${omittedAttachmentNotes.length ? `<p>⚠️ The following attachments were omitted due to email size limit: ${esc(omittedAttachmentNotes.join(", "))}. Documents remain stored server-side and can be resent from admin tools.</p>` : ""}
        <p>${footerText}</p>
        ${isConfirmed && vehicleId && pickup && returnDate ? `
        <hr style="margin:24px 0;border:none;border-top:1px solid #ddd">
        <p style="font-size:13px;color:#555">
          <strong>📅 Calendar update:</strong> These dates are being automatically marked as unavailable on the booking calendar.
          If the calendar is not updated within a few minutes, use the
          <a href="https://admin.slycarrentals.com/admin-v2/?vehicle=${encodeURIComponent(vehicleId)}&from=${encodeURIComponent(pickup)}&to=${encodeURIComponent(returnDate)}" style="color:#1a73e8">Admin Calendar Page</a>
          to block them manually.
        </p>` : ""}
      `,
    };

    // ── PHASE 3 FIX: Persist booking to database BEFORE sending any emails ────
    // This ensures we never send confirmation emails for bookings that were not
    // saved.  The pipeline logs every step (start, DB attempt, DB result) so
    // there are NO silent failures.
    let persistedBooking = null;
    let persistedBookingId = bookingId || null;
    let pipelineResult = null;
    let attemptedBookingPersistence = false;
    if (!isTestMode && isConfirmed && !isBalancePayment && vehicleId && (email || phone)) {
      attemptedBookingPersistence = true;
      console.log(`[send-reservation-email] booking_pipeline_start vehicleId=${vehicleId} pickup=${pickup} return=${returnDate} amount=${total}`);
      pipelineResult = await persistBooking(buildBookingRecord(bookingBody, balancePayUrl || ""));
      persistedBooking = pipelineResult.booking;
      persistedBookingId = pipelineResult.bookingId || persistedBookingId;
      if (!pipelineResult.ok) {
        console.error(`[send-reservation-email] booking_persist_failed bookingId=${pipelineResult.bookingId} errors=${JSON.stringify(pipelineResult.errors)}`);
      } else {
        console.log(`[send-reservation-email] booking_persisted bookingId=${pipelineResult.bookingId} supabaseOk=${pipelineResult.supabaseOk}`);
      }
    }

    if (!isTestMode && !isBalancePayment && vehicleId) {
      // Emails are allowed only after a non-balance booking attempt actually ran
      // persistence and produced a verified booking + revenue record.
      const persistenceIssues = [];
      if (!attemptedBookingPersistence) persistenceIssues.push("booking_persistence_not_attempted");
      if (!pipelineResult?.ok) persistenceIssues.push("booking_pipeline_failed");
      if (!pipelineResult?.supabaseOk) persistenceIssues.push("booking_pipeline_supabase_not_ok");
      if (!persistedBookingId) persistenceIssues.push("missing_booking_id");
      if (persistenceIssues.length > 0) {
        console.warn(`[send-reservation-email] skipping email send: ${persistenceIssues.join(", ")}`);
        return res.status(200).json({ success: true, emailSkipped: true, reason: persistenceIssues[0] });
      }
      const verification = await verifyBookingAndRevenueForEmail(persistedBookingId, normalizedPaymentIntentId);
      if (!verification.ok) {
        console.warn(`[send-reservation-email] skipping email send: ${verification.reason}`);
        return res.status(200).json({ success: true, emailSkipped: true, reason: "booking_or_revenue_not_verified" });
      }
    } else if (isBalancePayment && vehicleId) {
      // Balance payments are tied to an existing booking created at deposit time.
      // Verify booking/revenue existence by booking_ref while still requiring a
      // succeeded PaymentIntent for this balance payment attempt.
      if (!bookingId) {
        console.warn("[send-reservation-email] skipping email send: missing booking_id for balance payment verification");
        return res.status(200).json({ success: true, emailSkipped: true, reason: "missing_booking_id_for_balance_payment" });
      }
      const verification = await verifyBookingAndRevenueForEmail(bookingId, normalizedPaymentIntentId, {
        requireRevenuePaymentIntentMatch: false,
      });
      if (!verification.ok) {
        console.warn(`[send-reservation-email] skipping email send: ${verification.reason}`);
        return res.status(200).json({ success: true, emailSkipped: true, reason: "booking_or_revenue_not_verified" });
      }
    }

    try {
      await transporter.sendMail(ownerEmailOpts);
      ownerEmailSent = true;
    } catch (ownerErr) {
      console.error("Owner notification email failed:", ownerErr);
      if (attachments.length > 0 && isLikelyAttachmentDeliveryError(ownerErr)) {
        try {
          await transporter.sendMail({
            ...ownerEmailOpts,
            attachments: [],
            text: [
              ownerEmailOpts.text,
              "",
              "⚠️ Documents could not be attached to this email due to an attachment delivery error.",
              "The booking is still confirmed and documents remain stored server-side.",
            ].join("\n"),
            html: `
              ${ownerEmailOpts.html}
              <p>⚠️ Documents could not be attached to this email due to an attachment delivery error. The booking is still confirmed and documents remain stored server-side.</p>
            `,
          });
          ownerEmailSent = true;
          console.warn("Owner notification email sent without attachments after attachment delivery failure.");
        } catch (retryErr) {
          console.error("Owner notification email retry without attachments failed:", retryErr);
          ownerEmailErr = retryErr;
        }
      } else {
        ownerEmailErr = ownerErr;
      }
    }
    } // end: else (!webhookAlreadySentOwnerEmail)

    // Mark pending docs as sent when this endpoint successfully sends the owner
    // confirmation, so a later Stripe webhook can safely skip duplicate sends.
    if (isConfirmed && !isBalancePayment && bookingId && !webhookAlreadySentOwnerEmail && ownerEmailSent) {
      try {
        const sb = getSupabaseAdmin();
        if (sb) {
          await sb
            .from("pending_booking_docs")
            .upsert({ booking_id: bookingId, email_sent: true }, { onConflict: "booking_id" });
        }
      } catch (markErr) {
        console.warn("[send-reservation-email] could not mark pending_booking_docs email_sent (non-fatal):", markErr.message);
      }
    }

    // --- Confirmation to customer (only for successful payments) ---
    let customerEmailErr = null;
    const webhookAlreadyHandledCustomerEmail = !!(webhookAlreadySentOwnerEmail && isConfirmed && !isBalancePayment);
    if (webhookAlreadyHandledCustomerEmail) {
      console.log(`[send-reservation-email] webhook already handled confirmation emails for booking ${bookingId} — skipping duplicate customer email`);
    } else if (isConfirmed && email) {
      const customerSubject = isBalancePayment
        ? "🎉 Balance Paid – Your Rental is Fully Confirmed"
        : "Rental Agreement Confirmation – Sly Car Rentals";
      const customerIntro = isBalancePayment
        ? "Great news! Your final balance payment has been received. Your rental is now fully paid and confirmed."
        : "Your booking is confirmed. Attached is your signed rental agreement.";
      const customerAttachments = (agreementPdfBuffer && agreementPdfFilename)
        ? [{
            filename: agreementPdfFilename,
            content: agreementPdfBuffer,
            contentType: "application/pdf",
          }]
        : [];
      const customerEmailOpts = {
        from: `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
        to: email,
        subject: customerSubject,
        ...(customerAttachments.length ? { attachments: customerAttachments } : {}),
        text: [
          isBalancePayment ? "Balance Paid – Sly Car Rentals LLC" : "Payment Confirmed – Sly Car Rentals LLC",
          "",
          customerIntro,
          "Here are your booking details:",
          "",
          `Payment Status : CONFIRMED`,
          bookingId ? `Booking ID     : ${bookingId}` : "",
          `Vehicle        : ${car || ""}`,
          vehicleMake  ? `Make           : ${vehicleMake}`  : "",
          vehicleModel ? `Model          : ${vehicleModel}` : "",
          vehicleYear  ? `Year           : ${vehicleYear}`  : "",
          vehicleVin   ? `VIN / Plate    : ${vehicleVin}`   : "",
          vehicleColor ? `Color          : ${vehicleColor}` : "",
          `Pickup Date    : ${pickup || ""}`,
          `Pickup Time    : ${formatTime12h(pickupTime) || "Not specified"}`,
          `Return Date    : ${returnDate || ""}`,
          `Return Time    : ${formatTime12h(returnTime) || "Not specified"}`,
          isBalancePayment
            ? `Balance Paid   : $${total || "TBD"} (final payment — booking fully paid)`
            : `Total Charged  : $${total || "TBD"}`,
          !isBalancePayment && fullRentalCost  ? `Full Rental Cost: $${fullRentalCost}` : "",
          !isBalancePayment && balanceAtPickup ? `Balance at Pickup: $${balanceAtPickup}` : "",
          breakdownText ? "\nPrice Breakdown:\n" + breakdownText : "",
          "",
          "Manage your booking at: https://slycarrentals.com/manage-booking.html",
          "Use your phone number, email, or Booking ID to access it.",
          "",
          "We will be in touch shortly to confirm your rental pick-up details.",
          `If you have any questions, reply to this email or reach us at ${OWNER_EMAIL}.`,
          "",
          "Sly Car Rentals LLC Team",
        ].filter(line => line !== undefined).join("\n"),
        html: `
          <h2>${isBalancePayment ? "🎉 Balance Paid – Sly Car Rentals LLC" : "✅ Payment Confirmed – Sly Car Rentals LLC"}</h2>
          <p>${esc(customerIntro)} Here are your booking details:</p>
          <table style="border-collapse:collapse;width:100%">
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #ddd;color:green"><strong>✅ CONFIRMED</strong></td></tr>
            ${bookingId ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #ddd"><code>${esc(bookingId)}</code></td></tr>` : ""}
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(car)}</td></tr>
            ${vehicleMake  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Make</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleMake)}</td></tr>`  : ""}
            ${vehicleModel ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Model</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleModel)}</td></tr>` : ""}
            ${vehicleYear  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Year</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(String(vehicleYear))}</td></tr>`  : ""}
            ${vehicleVin   ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>VIN / Plate</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleVin)}</td></tr>`   : ""}
            ${vehicleColor ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Color</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleColor)}</td></tr>` : ""}
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickup)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Time</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(formatTime12h(pickupTime)) || "Not specified"}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Time</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(formatTime12h(returnTime)) || "Not specified"}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalChargedLabel)}</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>$${esc(total) || "TBD"}</strong>${isBalancePayment ? " <em style='font-size:12px;color:#888'>(final payment — fully paid)</em>" : ""}</td></tr>
            ${!isBalancePayment && fullRentalCost  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Full Rental Cost</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(fullRentalCost)}</td></tr>` : ""}
            ${!isBalancePayment && balanceAtPickup ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Balance Due at Pickup</strong></td><td style="padding:8px;border:1px solid #ddd;color:#ff9800"><strong>$${esc(balanceAtPickup)}</strong></td></tr>` : ""}
          </table>
          ${breakdownHtml ? `<h3 style="margin-top:16px">📊 Price Breakdown</h3>${breakdownHtml}` : ""}
          <p>You can <a href="https://slycarrentals.com/manage-booking.html">view and manage your booking</a> using your phone number, email, or Booking ID.</p>
          <p>We will be in touch shortly to confirm your rental pick-up details. If you have any questions, reply to this email or reach us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a>.</p>
          <p><strong>Sly Car Rentals LLC Team 🚗</strong></p>
        `,
      };
      try {
        await transporter.sendMail(customerEmailOpts);
        customerEmailSent = true;
      } catch (custErr) {
        console.error("Customer confirmation email failed:", custErr);
        if (customerAttachments.length > 0 && isLikelyAttachmentDeliveryError(custErr)) {
          try {
            await transporter.sendMail({
              ...customerEmailOpts,
              attachments: [],
              text: [
                customerEmailOpts.text,
                "",
                "⚠️ Your agreement PDF could not be attached due to an attachment delivery error.",
                "Your booking is still confirmed.",
              ].join("\n"),
              html: `
                ${customerEmailOpts.html}
                <p>⚠️ Your agreement PDF could not be attached due to an attachment delivery error. Your booking is still confirmed.</p>
              `,
            });
            customerEmailSent = true;
            console.warn("Customer confirmation email sent without agreement attachment after attachment delivery failure.");
          } catch (retryErr) {
            console.error("Customer confirmation email retry without attachment failed:", retryErr);
            customerEmailErr = retryErr;
          }
        } else {
          customerEmailErr = custErr;
        }
      }
    }

    if (isConfirmed && bookingId) {
      try {
        const sbDelivery = getSupabaseAdmin();
        if (sbDelivery) {
          await markBookingAgreementDelivery({
            sb: sbDelivery,
            bookingRef: bookingId,
            ownerDeliveryStatus: webhookAlreadySentOwnerEmail
              ? "sent"
              : (ownerEmailSent ? "sent" : "failed"),
            renterDeliveryStatus: email
              ? (customerEmailSent ? "sent" : "failed")
              : "skipped",
            sentAt: ownerEmailSent || customerEmailSent || webhookAlreadySentOwnerEmail
              ? new Date().toISOString()
              : null,
            createdBy: "api/send-reservation-email",
          });
        }
      } catch (deliveryErr) {
        console.warn("[send-reservation-email] agreement delivery tracking skipped (non-fatal):", deliveryErr?.message || deliveryErr);
      }
    }

    // Block the reserved dates in booked-dates.json and mark the vehicle
    // unavailable in fleet-status.json BEFORE sending the response and BEFORE
    // checking for email errors.  This ensures availability is always updated
    // for confirmed bookings even when the owner notification email fails.
    // Vercel terminates the serverless function as soon as res.json() is called,
    // so any async work scheduled after that is not guaranteed to run.
    // Failures are non-fatal (emails already sent) and only logged.
    if (!isTestMode && isConfirmed && !isBalancePayment && vehicleId && pickup && returnDate) {
      try {
        await blockBookedDates(vehicleId, pickup, returnDate);
      } catch (err) {
        console.error("Failed to update booked-dates.json:", err.message);
      }
      try {
        await markVehicleUnavailable(vehicleId);
      } catch (err) {
        console.error("Failed to update fleet-status.json:", err.message);
      }
    }

    // Owner email is critical — surface a 500 so the operator knows.
    // Customer email failure is non-fatal: it is already logged above and the
    // owner received the booking alert so the booking is not lost.
    if (ownerEmailErr) {
      return res.status(500).json({ error: "Reservation owner notification email failed. Please contact slyservices@supports-info.com to confirm your booking." });
    }

    // ── Booking record was already persisted above (BEFORE emails) ───────────
    // persistedBooking holds the saved record; nothing more to do here.
    // This comment replaces the old save block to make the ordering clear.

    // ── Booking confirmation SMS ──────────────────────────────────────────────
    if (
      isConfirmed &&
      shouldSendBookingLifecycleSms("send_reservation_email") &&
      !fullRentalCost &&
      phone &&
      process.env.TEXTMAGIC_USERNAME &&
      process.env.TEXTMAGIC_API_KEY
    ) {
      // Send confirmation only for fully-paid bookings (not deposit-only reservations)
      try {
        const bookingConfirmedSent = await sendDedupedSms({
          bookingId: persistedBookingId || normalizedPaymentIntentId,
          templateKey: "booking_confirmed",
          phone,
          body: render(BOOKING_CONFIRMED, {
            vehicle:       car || (CARS[vehicleId] && CARS[vehicleId].name) || vehicleId || "",
            customer_name: (name || "").split(" ")[0] || name || "Customer",
            pickup_date:   pickup ? new Date(pickup + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "long", day: "numeric" }) : "",
            pickup_time:   formatTime12h(pickupTime) || pickupTime || "",
            return_date:   returnDate ? new Date(returnDate + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "long", day: "numeric" }) : "",
            return_time_line: returnTime ? ` at ${formatTime12h(returnTime) || returnTime}\n` : "\n",
            location:      resolvePickupLocation({
              vehicleId,
              vehicleName: car || (CARS[vehicleId] && CARS[vehicleId].name) || vehicleId || "",
            }),
          }),
          returnDateAtSend: returnDate || undefined,
          metadata: {
            source: "send_reservation_email:full_payment",
            payment_state: "paid",
          },
        });
        if (bookingConfirmedSent) {
          await sendDedupedSms({
            bookingId: persistedBookingId || normalizedPaymentIntentId,
            templateKey: "manage_booking_access",
            phone,
            body: render(MANAGE_BOOKING_ACCESS, {
              customer_name: (name || "").split(" ")[0] || name || "Customer",
              booking_id: persistedBookingId || normalizedPaymentIntentId || "",
              manage_link: "https://slycarrentals.com/manage-booking.html",
            }),
            returnDateAtSend: returnDate || undefined,
            metadata: {
              source: "send_reservation_email:full_payment",
              payment_state: "paid",
            },
          });
        }
        if (bookingConfirmedSent && pickup !== returnDate) {
          await sendDedupedSms({
            bookingId: persistedBookingId || normalizedPaymentIntentId,
            templateKey: "booking_onboarding",
            phone,
            body: render(BOOKING_ONBOARDING, {
              customer_name: (name || "").split(" ")[0] || name || "Customer",
              booking_id: persistedBookingId || normalizedPaymentIntentId || "",
              manage_link: "https://slycarrentals.com/manage-booking.html",
            }),
            returnDateAtSend: returnDate || undefined,
            metadata: {
              source: "send_reservation_email:full_payment",
              payment_state: "paid",
            },
          });
        }
      } catch (smsErr) {
        console.error("Booking confirmation SMS failed:", smsErr);
      }
    }

    // ── TextMagic contact upsert ──────────────────────────────────────────────
    if (isConfirmed && !isBalancePayment && phone && vehicleId) {
      try {
        const addTags = ["booked"];
        const vTag = vehicleTag(vehicleId);
        if (vTag) addTags.push(vTag);
        await upsertContact(normalizePhone(phone), name || "", { addTags });
      } catch (contactErr) {
        console.error("TextMagic contact upsert (booking) failed:", contactErr);
      }
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Email sending failed" });
  }
}
