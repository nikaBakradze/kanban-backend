const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null;
  if (!match) return res.status(401).json({ message: 'წვდომა უარყოფილია, ტოკენი არ არის' });
  try {
    req.user = jwt.verify(match[1], process.env.JWT_SECRET);
    return next();
  } catch (error) {
    return res.status(error.name === 'TokenExpiredError' ? 401 : 403).json({ message: 'არავალიდური ტოკენი' });
  }
};
