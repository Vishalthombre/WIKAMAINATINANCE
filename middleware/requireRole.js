// middleware/requireRole.js
module.exports = function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    // Check if JWT middleware has set req.user
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized: No user found in request' });
    }

    const userRole = req.user.role || req.user.department;

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ message: '❌ Access Denied: Insufficient role' });
    }

    next();
  };
};