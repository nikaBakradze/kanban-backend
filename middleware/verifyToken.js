const jwt = require('jsonwebtoken');
const pool = require('../config/db');

module.exports = async (req, res, next) => {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null;
  if (!match) return res.status(401).json({ message: 'წვდომა უარყოფილია, ტოკენი არ არის' });
  try {
    req.user = jwt.verify(match[1], process.env.JWT_SECRET);
    const [rows] = await pool.query('SELECT email_verified FROM users WHERE id=?', [req.user.id]);
    if (!rows[0]) return res.status(401).json({ message: 'მომხმარებელი ვერ მოიძებნა' });
    if (rows[0].email_verified !== 1 && rows[0].email_verified !== true) {
      return res.status(403).json({ message: 'Email verification required' });
    }
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      return res.status(error.name === 'TokenExpiredError' ? 401 : 403).json({ message: 'არავალიდური ტოკენი' });
    }
    console.error(error);
    return res.status(500).json({ message: 'სერვერის შეცდომა' });
  }
};
