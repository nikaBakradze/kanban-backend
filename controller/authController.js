const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const emailOk = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const passwordOk = (v) => typeof v === 'string' && v.length >= 8;
const shape = (u) => ({ id: u.id, full_name: u.full_name, email: u.email, avatar_url: u.avatar_url || null });
const sign = (u) => jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '7d' });

exports.register = async (req, res) => {
  const full_name = typeof req.body.full_name === 'string' ? req.body.full_name.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!full_name || full_name.length > 255 || !emailOk(email) || !passwordOk(req.body.password)) return res.status(400).json({ message: 'სახელი, სწორი ელ-ფოსტა და მინიმუმ 8 სიმბოლოს პაროლი აუცილებელია' });
  try {
    const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (rows.length) return res.status(409).json({ message: 'მომხმარებელი ამ ელ-ფოსტით უკვე არსებობს' });
    const [result] = await pool.query('INSERT INTO users (full_name,email,password_hash) VALUES (?,?,?)', [full_name, email, await bcrypt.hash(req.body.password, 12)]);
    const user = { id: result.insertId, full_name, email, avatar_url: null };
    return res.status(201).json({ message: 'რეგისტრაცია წარმატებულია', token: sign(user), user });
  } catch (e) { console.error(e); return res.status(e.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: 'სერვერის შეცდომა' }); }
};
exports.login = async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!emailOk(email) || !passwordOk(req.body.password)) return res.status(400).json({ message: 'სწორი ელ-ფოსტა და პაროლი აუცილებელია' });
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows[0] || !rows[0].password_hash || !(await bcrypt.compare(req.body.password, rows[0].password_hash))) return res.status(401).json({ message: 'არასწორი ელ-ფოსტა ან პაროლი' });
    return res.json({ message: 'ავტორიზაცია წარმატებულია', token: sign(rows[0]), user: shape(rows[0]) });
  } catch (e) { console.error(e); return res.status(500).json({ message: 'სერვერის შეცდომა' }); }
};
exports.googleLogin = async (req, res) => {
  if (typeof req.body.credential !== 'string' || !req.body.credential) return res.status(400).json({ message: 'Google credential აუცილებელია' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: req.body.credential, audience: process.env.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p || !p.sub || !p.email || p.email_verified !== true) return res.status(401).json({ message: 'Google ანგარიში არავალიდურია' });
    const email = p.email.toLowerCase();
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ? OR google_id = ?', [email, p.sub]);
    let user = rows[0];
    if (user) {
      user = { ...user, full_name: p.name || user.full_name, avatar_url: p.picture || user.avatar_url, google_id: p.sub };
      await pool.query('UPDATE users SET google_id=?, full_name=?, avatar_url=? WHERE id=?', [p.sub, user.full_name, user.avatar_url, user.id]);
    } else {
      const [r] = await pool.query('INSERT INTO users (full_name,email,google_id,avatar_url) VALUES (?,?,?,?)', [p.name || email, email, p.sub, p.picture || null]);
      user = { id: r.insertId, full_name: p.name || email, email, avatar_url: p.picture || null };
    }
    return res.json({ message: 'Google ავტორიზაცია წარმატებულია', token: sign(user), user: shape(user) });
  } catch (e) { console.error(e); return res.status(401).json({ message: 'Google-ით ავტორიზაცია ვერ მოხერხდა' }); }
};
exports.forgotPassword = async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!emailOk(email)) return res.status(400).json({ message: 'სწორი ელ-ფოსტა აუცილებელია' });
  const c = await pool.getConnection();
  try {
    await c.beginTransaction(); const [rows] = await c.query('SELECT * FROM users WHERE email=? FOR UPDATE', [email]);
    if (!rows.length) { await c.rollback(); return res.status(404).json({ message: 'User with this email was not found.' }); }
    const raw = crypto.randomBytes(32).toString('hex'); const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await c.query('UPDATE users SET reset_token_hash=?, reset_token_expires=DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE id=?', [hash, rows[0].id]); await c.commit();
    return res.json({ message: 'Reset link generated successfully.', resetLink: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${raw}`, to_email: email, to_name: rows[0].full_name });
  } catch (e) { await c.rollback(); console.error(e); return res.status(500).json({ message: 'Server error.' }); } finally { c.release(); }
};
exports.resetPassword = async (req, res) => {
  if (typeof req.body.token !== 'string' || !passwordOk(req.body.newPassword)) return res.status(400).json({ message: 'Token and a password of at least 8 characters are required.' });
  const c = await pool.getConnection();
  try {
    await c.beginTransaction(); const hash = crypto.createHash('sha256').update(req.body.token).digest('hex');
    const [rows] = await c.query('SELECT id FROM users WHERE reset_token_hash=? AND reset_token_expires>NOW() FOR UPDATE', [hash]);
    if (!rows.length) { await c.rollback(); return res.status(400).json({ message: 'Invalid or expired token.' }); }
    const [r] = await c.query('UPDATE users SET password_hash=?, reset_token_hash=NULL, reset_token_expires=NULL WHERE id=? AND reset_token_hash=?', [await bcrypt.hash(req.body.newPassword, 12), rows[0].id, hash]);
    if (r.affectedRows !== 1) { await c.rollback(); return res.status(400).json({ message: 'Invalid or expired token.' }); }
    await c.commit(); return res.json({ message: 'Password updated successfully.' });
  } catch (e) { await c.rollback(); console.error(e); return res.status(500).json({ message: 'Server error.' }); } finally { c.release(); }
};
