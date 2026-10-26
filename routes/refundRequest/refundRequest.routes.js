import { listRefundRequests, listDiscountRefunds, listDepositReturns, approveRefund, rejectRefund, manualRefundIssued, failedRefundHandedBack, autoApproveRefund, retryScheduledRefundSend } from "../../controllers/refundRequest/refundRequest.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";
import { timingSafeEqual } from "node:crypto";

// Server-to-server only: the customer backend calls this with the shared secret (INTERNAL_API_SECRET, same value on both
// backends). Refused with 503 when the secret is not set, so the endpoint can never be opened by accident.
const verifyInternalRequest = (req, res, next) => {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return res.status(503).json({ message: "Internal API is not configured." });
  const given = Buffer.from(String(req.headers["x-internal-secret"] || ""));
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return res.status(401).json({ message: "Unauthorized." });
  next();
};

// Visible to: Supervisor, Admin, Owner — same access level as Payments
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerRefundRequestRoutes = (app) => {
  app.get("/api/refund-requests",              verifyToken, requireRole(allowed), listRefundRequests);
  // Discount refunds (money a staff discount sent back), shown next to the requests on the Refunds page.
  app.get("/api/refund-requests/discount-refunds", verifyToken, requireRole(allowed), listDiscountRefunds);
  // Security-deposit returns sent through PayMongo (pending / failed / refunded), same tabs.
  app.get("/api/refund-requests/deposit-returns", verifyToken, requireRole(allowed), listDepositReturns);
  app.patch("/api/refund-requests/:id/approve", verifyToken, requireRole(allowed), approveRefund);
  app.patch("/api/refund-requests/:id/reject",  verifyToken, requireRole(allowed), rejectRefund);
  // Staff confirm the in-person part of a refund (the balance PayMongo can't return) was handed back.
  app.patch("/api/refund-requests/:id/manual-issued", verifyToken, requireRole(allowed), manualRefundIssued);
  // Staff paid back, themselves, the part(s) PayMongo refused on a Failed request (cash / GCash / Maya / bank transfer).
  app.patch("/api/refund-requests/:id/failed-handback", verifyToken, requireRole(allowed), failedRefundHandedBack);
  // Grace-window requests (made within 2 hours of paying) are approved by the system, called by the customer backend.
  app.post("/api/internal/refund-requests/:id/auto-approve", verifyInternalRequest, autoApproveRefund);
  // Staff re-send of a scheduled (same-day) refund whose automatic attempts failed.
  app.patch("/api/refund-requests/:id/retry-scheduled", verifyToken, requireRole(allowed), retryScheduledRefundSend);
  // NOTE: a car's upcoming bookings are now force-refunded/cancelled as one
  // batch, entirely server-side, inside PATCH /api/fleet/cars/:carID/status
  // (fleet.controller.js's changeCarStatus) — there's no standalone
  // "refund this one booking right now" endpoint anymore; firing outside
  // that one gated, OTP-verified batch would bypass the whole point of it.
};