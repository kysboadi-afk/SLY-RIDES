function normalizeKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function toMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const ACTIVE_RENTAL_STATUSES = new Set(["active", "active_rental", "extended"]);
const OVERDUE_STATUSES = new Set(["overdue"]);
const MANUAL_PICKUP_STATUSES = new Set(["agreement_signed", "pending_manual_payment", "ready_for_pickup"]);
const RESERVATION_STATUSES = new Set([
  "pending",
  "pending_checkout",
  "pending_verification",
  "approved",
  "reserved",
  "reserved_unpaid",
  "booked_paid",
  "identity_pending",
  "identity_verified",
  "agreement_pending",
  "agreement_signed",
  "pending_manual_payment",
  "ready_for_pickup",
]);
const PAYMENT_PLAN_STATUSES = new Set(["active", "defaulted", "past_due", "overdue"]);
const PAYMENT_STATUS_PARTIAL = new Set(["partial", "deposit", "deposit_paid", "partially_paid"]);
const PAYMENT_STATUS_FULL = new Set(["paid", "paid_in_full", "full", "completed", "succeeded"]);

export function deriveBookingPaymentLifecycle(input = {}) {
  const statusKey = normalizeKey(input.status);
  const paymentStatusKey = normalizeKey(input.paymentStatus);
  const categoryKey = normalizeKey(input.category);
  const totalAmount = Math.max(0, toMoney(input.totalAmount));
  const amountPaid = Math.max(0, toMoney(input.amountPaid));
  const remainingBalance = Math.max(0, toMoney(input.remainingBalance));
  const hasOutstandingBalance = remainingBalance > 0;
  const isManualPickupByStatus = MANUAL_PICKUP_STATUSES.has(statusKey);
  const isActiveRental = ACTIVE_RENTAL_STATUSES.has(statusKey);
  const isOverdue = OVERDUE_STATUSES.has(statusKey) || (!!input.paymentPlan?.isOverdue && hasOutstandingBalance);
  const paymentPlanStatus = normalizeKey(input.paymentPlan?.status);
  const hasPaymentPlan = !!input.paymentPlan && PAYMENT_PLAN_STATUSES.has(paymentPlanStatus);
  const hasPartialIndicator = PAYMENT_STATUS_PARTIAL.has(paymentStatusKey);
  const hasFullIndicator = PAYMENT_STATUS_FULL.has(paymentStatusKey);
  const hasPositivePaid = amountPaid > 0;
  const isFullyPaidByBalance = remainingBalance <= 0;
  const isManualPickup = isManualPickupByStatus;
  const isReservationStage = RESERVATION_STATUSES.has(statusKey) || isManualPickup;

  let lifecycleState = "reservation_pending";

  if (isOverdue) {
    lifecycleState = "overdue";
  } else if (hasPaymentPlan && hasOutstandingBalance) {
    lifecycleState = "payment_plan_active";
  } else if (isActiveRental) {
    lifecycleState = "active_rental";
  } else if (isManualPickup && !isFullyPaidByBalance) {
    lifecycleState = "pickup_due";
  } else if (isReservationStage) {
    if (hasOutstandingBalance && hasPositivePaid) {
      lifecycleState = "deposit_paid";
    } else if (hasOutstandingBalance) {
      lifecycleState = "reservation_pending";
    } else if (hasFullIndicator || (!hasPartialIndicator && totalAmount > 0 && amountPaid >= totalAmount)) {
      lifecycleState = "completed";
    } else if (hasPartialIndicator || hasPositivePaid) {
      lifecycleState = "deposit_paid";
    } else {
      lifecycleState = "reservation_pending";
    }
  } else if (isFullyPaidByBalance) {
    lifecycleState = "completed";
  } else if (hasPositivePaid) {
    lifecycleState = "deposit_paid";
  }

  return {
    lifecycleState,
    statusKey,
    paymentStatusKey,
    totalAmount,
    amountPaid,
    remainingBalance,
    hasOutstandingBalance,
    isReservationStage,
    isManualPickup,
    isActiveRental,
    isOverdue,
    hasPaymentPlan,
    canPayRemainingOnline: hasOutstandingBalance && lifecycleState !== "completed",
    isPaidInFull: lifecycleState === "completed",
  };
}
