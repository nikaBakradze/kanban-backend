const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/db');

module.exports = async (req, res, next) => {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null;
  if (!match) return res.status(401).json({ message: 'Admin authentication required' });
  try {
    const payload = jwt.verify(match[1], process.env.JWT_SECRET);
    if (payload.purpose !== 'admin_session' || payload.admin !== true) {
      return res.status(403).json({ message: 'Admin 2FA verification required' });
    }
    if (typeof payload.jti !== 'string' || !payload.jti) {
      return res.status(401).json({ message: 'Invalid admin session' });
    }
    const sessionHash = crypto.createHash('sha256').update(payload.jti).digest('hex');
    const [rows] = await pool.query(
      `SELECT u.id, u.email, u.system_role, u.totp_enabled, u.is_active, s.id AS session_id
       FROM users u
       JOIN admin_sessions s ON s.user_id=u.id
       WHERE u.id=? AND s.session_hash=? AND s.revoked_at IS NULL AND s.expires_at>NOW()`,
      [payload.id, sessionHash],
    );
    if (!rows[0] || rows[0].system_role !== 'SUPER_ADMIN' || !rows[0].totp_enabled
      || (rows[0].is_active !== 1 && rows[0].is_active !== true)) {
      return res.status(403).json({ message: 'Super Admin access denied' });
    }
    req.admin = rows[0];
    req.adminSessionId = rows[0].session_id;
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid or expired admin session' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Admin authentication failed' });
  }
};
