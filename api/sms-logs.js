// api/sms-logs.js
// Vercel serverless function — returns the 100 most recent SMS delivery log
// entries from the sms_delivery_logs table.  Admin-protected.
//
// GET /api/sms-logs?secret=<ADMIN_SECRET>&booking_ref=bk-123&phone=5550101001&message_type=booking
// Response: { "logs": [ { id, booking_ref, vehicle_id, renter_phone,
//                          message_type, message_body, status, error,
//                          provider_id, created_at }, … ] }

import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized, isAdminConfigured, extractAdminSecret } from "./_admin-auth.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "DELETE") return res.status(405).send("Method Not Allowed");

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  if (!isAdminAuthorized(extractAdminSecret(req))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(500).json({ error: "Supabase not configured." });
  }

  // DELETE — clear all SMS delivery logs
  if (req.method === "DELETE") {
    try {
      const { error } = await sb
        .from("sms_delivery_logs")
        .delete()
        .not("id", "is", null); // delete all rows

      if (error) {
        console.error("[sms-logs] Delete error:", error.message);
        return res.status(500).json({ error: "Failed to clear SMS logs: " + error.message });
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[sms-logs] Unexpected delete error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // GET — return last 100 log entries
  try {
    const bookingRefFilter = String(req.query?.booking_ref || req.query?.bookingRef || "").trim();
    const phoneFilter = String(req.query?.phone || req.query?.renter_phone || "").trim();
    const messageTypeFilter = String(req.query?.message_type || req.query?.messageType || "").trim();

    let query = sb
      .from("sms_delivery_logs")
      .select("id, booking_ref, vehicle_id, renter_phone, message_type, message_body, status, error, provider_id, created_at")
      .order("created_at", { ascending: false });

    if (bookingRefFilter) {
      query = query.ilike("booking_ref", `%${bookingRefFilter}%`);
    }
    if (phoneFilter) {
      query = query.ilike("renter_phone", `%${phoneFilter}%`);
    }
    if (messageTypeFilter) {
      query = query.ilike("message_type", `%${messageTypeFilter}%`);
    }

    const { data, error } = await query.limit(100);

    if (error) {
      console.error("[sms-logs] Supabase query error:", error.message);
      return res.status(500).json({ error: "Failed to fetch SMS logs: " + error.message });
    }

    return res.status(200).json({ logs: data || [] });
  } catch (err) {
    console.error("[sms-logs] Unexpected error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
