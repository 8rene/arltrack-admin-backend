import { timingSafeEqual } from "node:crypto";
import { runMidnightFlush } from "../../jobs/midinghtFlush.job.js";
import { runExpireSessions } from "../../jobs/expireSessions.job.js";
import { runScheduledRefundsJob } from "../../jobs/scheduledRefunds.job.js";

// Vercel Cron hits this over HTTP on schedule (see vercel.json) — it can't
// call runMidnightFlush() directly, since jobs/ files aren't routes.
// Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on every
// cron request when CRON_SECRET is set in the project's env vars. This
// REQUIRES it: if CRON_SECRET is not set, every request is refused (503) so
// the endpoints can never be triggered by just hitting the URL.
// Set CRON_SECRET in Vercel → Settings → Environment Variables BEFORE
// deploying this, or the scheduled jobs will fail.
const verifyCronRequest = (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[CRON] CRON_SECRET is not set — refusing request.");
    return res.status(503).json({ message: "Cron is not configured." });
  }
  const given = Buffer.from(String(req.headers["authorization"] || ""));
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return res.status(401).json({ message: "Unauthorized." });
  }
  next();
};

export const registerCronRoutes = (app) => {
  app.get("/api/cron/midnight-flush", verifyCronRequest, async (req, res) => {
    try {
      const result = await runMidnightFlush();
      return res.status(200).json({ success: true, result: result || null });
    } catch (err) {
      console.error("[CRON] midnight-flush route error:", err.message);
      return res.status(200).json({ success: false, message: err.message });
    }
  });

  app.get("/api/cron/expire-sessions", verifyCronRequest, async (req, res) => {
    try {
      const result = await runExpireSessions();
      return res.status(200).json({ success: true, result: result || null });
    } catch (err) {
      console.error("[CRON] expire-sessions route error:", err.message);
      return res.status(200).json({ success: false, message: err.message });
    }
  });

  app.get("/api/cron/scheduled-refunds", verifyCronRequest, async (req, res) => {
    try {
      const result = await runScheduledRefundsJob();
      return res.status(200).json({ success: true, result });
    } catch (err) {
      console.error("[CRON] scheduled-refunds route error:", err.message);
      return res.status(200).json({ success: false, message: err.message });
    }
  });
};