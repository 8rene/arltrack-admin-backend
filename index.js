import "dotenv/config";
import express from "express";
import cors from "cors";
import { registerAuthRoutes }                from "./routes/auth/auth.routes.js";
import { registerDashboardRoutes }           from "./routes/dashboard/dashboard.routes.js";
import { registerAnalyticsRoutes }          from "./routes/analytics/analytics.routes.js";//
import { registerBookingRoutes }             from "./routes/booking/booking.routes.js";
import { registerUserRoutes }                from "./routes/user/user.routes.js";
import { registerAuditLogsRoutes }           from "./routes/auditLogs/auditLogs.routes.js";
import { registerUserLogsRoutes }            from "./routes/userLogs/userLogs.routes.js";
import { registerGpsRoutes }                 from "./routes/gps/gps.routes.js";
import { registerReportsRoutes }             from "./routes/reports/reports.routes.js"; //
import { registerPaymentsRoutes }          from "./routes/payments/payments.routes.js";//
import { registerTransactionLogsRoutes }     from "./routes/transactionLogs/transactionLogs.routes.js";
import { registerInventoryRoutes }           from "./routes/inventory/inventory.routes.js";
import { registerVehicleDocsRoutes }         from "./routes/vehicleDocumentation/vehicleDocumentation.routes.js";
import { registerFleetRoutes }               from "./routes/fleet/fleet.routes.js"; // ← NEW
import { registerRefundRequestRoutes }       from "./routes/refundRequest/refundRequest.routes.js"; // ← NEW
import { registerLocationRoutes }            from "./routes/location/location.routes.js"; // ← NEW
import { startBookingWatcher }               from "./watchers/bookingWatcher.js";
import { startUserWatcher }                  from "./watchers/userWatcher.js";
import { registerUserLogArchiveRoutes }        from "./routes/archives/userLogArchiveRoutes.js";
import { registerPaymentsArchiveRoutes }       from "./routes/archives/paymentsArchiveRoutes.js";
import { registerBookingArchiveRoutes }        from "./routes/archives/bookingArchiveRoutes.js";
import { registerTransactionLogArchiveRoutes } from "./routes/archives/transactionLogArchiveRoutes.js";
import { registerAuditLogsArchiveRoutes }      from "./routes/archives/auditLogsArchiveRoutes.js";
import { registerReviewsArchiveRoutes }        from "./routes/archives/reviewsArchiveRoutes.js";
import { registerBookingSessionArchiveRoutes } from "./routes/archives/bookingSessionArchiveRoutes.js";
import { registerCronRoutes }                  from "./routes/cron/cron.routes.js";
import { registerMaintenanceRoutes }           from "./routes/maintenance/maintenance.routes.js"; // ← NEW
import { registerCarPartsRoutes }              from "./routes/carParts/carParts.routes.js"; // ← NEW
import { registerProfileRequestsRoutes }       from "./routes/profileRequests/profileRequests.routes.js"; // ← NEW
import { registerDriverDispatchRoutes }        from "./routes/driverDispatch/driverDispatch.routes.js"; // ← NEW
import { registerSystemSettingsRoutes }       from "./routes/systemSettings/systemSettings.routes.js"; // ← NEW
import { registerLocationOptionsRoutes }       from "./routes/locationOptions/locationOptions.routes.js"; // ← NEW
import { seedCacheFromFirestore }            from "./services/gps/gps.service.js";

const app = express();

app.use(cors({
  origin: [
    'https://arltrack-admin-frontend.vercel.app',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());

// ── ROUTES ────────────────────────────────────────────────────
registerAuthRoutes(app);
registerDashboardRoutes(app);
registerAnalyticsRoutes(app);
registerBookingRoutes(app);
registerUserRoutes(app);
registerAuditLogsRoutes(app);
registerUserLogsRoutes(app);
registerTransactionLogsRoutes(app);
registerPaymentsRoutes(app);
registerReportsRoutes(app);
registerGpsRoutes(app);
registerLocationRoutes(app);
registerInventoryRoutes(app);
registerVehicleDocsRoutes(app);
registerFleetRoutes(app);              // ← NEW
registerRefundRequestRoutes(app);      // ← NEW
registerUserLogArchiveRoutes(app);
registerPaymentsArchiveRoutes(app);
registerBookingArchiveRoutes(app);
registerTransactionLogArchiveRoutes(app);
registerAuditLogsArchiveRoutes(app);
registerReviewsArchiveRoutes(app);
registerBookingSessionArchiveRoutes(app);  // ← NEW
registerCronRoutes(app);              // ← NEW
registerMaintenanceRoutes(app);       // ← NEW
registerCarPartsRoutes(app);          // ← NEW
registerProfileRequestsRoutes(app);   // ← NEW
registerDriverDispatchRoutes(app);    // ← NEW
registerSystemSettingsRoutes(app);   // ← NEW
registerLocationOptionsRoutes(app);   // ← NEW

const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await seedCacheFromFirestore();
  startBookingWatcher();
  startUserWatcher();
});

export default app;