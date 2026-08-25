import { runMidnightFlush } from "../../jobs/midinghtFlush.job.js";
import { runExpireSessions } from "../../jobs/expireSessions.job.js";

// Vercel Cron hits this over HTTP on schedule (see vercel.json) — it can't
// call runMidnightFlush() directly, since jobs/ files aren't routes. If
// CRON_SECRET is set in your Vercel project's env vars, Vercel automatically
// sends it as `Authorization: Bearer <CRON_SECRET>` on every cron request;
// this checks it so nobody else can trigger a flush by just hitting the URL.
// If you haven't set CRON_SECRET yet, this check is skipped (no-op) rather
// than blocking everything — set it in Vercel → Settings → Environment
// Variables when you're ready to lock this down.
const verifyCronRequest = (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return next(); // not configured yet — allow through
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${secret}`) {
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
};