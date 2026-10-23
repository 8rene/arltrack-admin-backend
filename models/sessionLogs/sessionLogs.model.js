// sessionLogs/{sessionLogsID}
//
// One row per login attempt, from BOTH apps: a successful login opens a row that is closed on logout; a blocked login
// (locked / inactive account) writes a standalone row that never opens a session. Renamed from the old userLogs
// collection (routes: /api/sessionLogs, formerly /api/user-logs).
//
// Written by services/sessionLogs/sessionLogs.service.js here (platform "admin_web") and by utils/sessionLogs/
// sessionLogs.util.js in the customer backend (platform "customer_web"). Archived to sessionLogArchives.
export const SessionLog = {
  sessionLogsID: "",     // Firestore doc ID
  uID: null,             // userID that logged in; null on a blocked attempt by an unknown user
  username: "",
  platform: "",          // "admin_web" | "customer_web"
  status: "",            // "active" | "logged_out" | "blocked"
  closedReason: null,    // "manual" (user logged out) | "revoked" (account locked / deleted / role changed while logged in); null while open
  loginDateTime: null,   // server timestamp; null on a blocked attempt
  logoutDateTime: null,  // set when the session is closed
  sessionDuration: 0,    // seconds, set when the session is closed
  // Blocked attempts only:
  attemptedAt: null,
  blockedReason: "",     // written by the admin backend on every row ("" when not blocked); the customer backend leaves it out
};