import { ALLOWED_ROLES } from "../../utils/roles/role.util.js";

export const requireRole = (allowedRoles = []) => {
  return (req, res, next) => {

    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const role = req.user.role;
    const isAllowed = allowedRoles.includes(role);

    if (!isAllowed) {
      return res.status(403).json({ message: "Forbidden: role not allowed" });
    }

    next();
  };
};
