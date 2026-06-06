import { ROLES } from "../../utils/roles/role.util.js";

/**
 * requireRole middleware
 *
 * Usage: requireRole([ROLES.ADMIN, ROLES.SUPERVISOR])
 *
 * Checks req.user.role (set by verifyToken) against the allowed roles array.
 * Returns 403 if the role is not permitted.
 */
export const requireRole = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized. Please log in." });
    }

    const role = req.user.role;

    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        message: `Access denied. Your role (${role}) does not have permission to perform this action.`,
      });
    }

    next();
  };
};

// Pre-built role sets for convenience
export const roles = ROLES;