const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Resend } = require('resend');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const resend = new Resend(process.env.RESEND_API_KEY);
const emailOk = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const passwordOk = (v) => typeof v === 'string' && v.length >= 8;
const shape = (u) => ({ id: u.id, full_name: u.full_name, email: u.email, avatar_url: u.avatar_url || null });
const sign = (u) => jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
const generateVerificationCode = () => crypto.randomInt(1000, 10000).toString();
const sendVerificationCode = async (email, code) => {
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to: [email],
    subject: 'Your email verification code',
    html: `
      <p>Your email verification code is <strong>${code}</strong>.</p>
      <p>This code expires in 5 minutes.</p>
    `
  });

  if (error) throw error;
};

exports.register = async (req, res) => {
  const full_name = typeof req.body.full_name === 'string' ? req.body.full_name.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!full_name || full_name.length > 255 || !emailOk(email) || !passwordOk(req.body.password)) return res.status(400).json({ message: 'სახელი, სწორი ელ-ფოსტა და მინიმუმ 8 სიმბოლოს პაროლი აუცილებელია' });
  let stage = 'check_email';
  let connection;
  try {
    const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (rows.length) return res.status(409).json({ message: 'მომხმარებელი ამ ელ-ფოსტით უკვე არსებობს' });
    stage = 'generate_and_hash_otp';
    const verificationCode = generateVerificationCode();
    const verificationCodeHash = await bcrypt.hash(verificationCode, 12);
    const passwordHash = await bcrypt.hash(req.body.password, 12);
    stage = 'send_verification_email';
    await sendVerificationCode(email, verificationCode);
    stage = 'persist_user';
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO users
       (full_name, email, password_hash, email_verified, verification_code, verification_code_expires)
       VALUES (?, ?, ?, FALSE, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))`,
      [full_name, email, passwordHash, verificationCodeHash]
    );
    const user = { id: result.insertId, full_name, email, avatar_url: null };
    stage = 'generate_jwt';
    const token = sign(user);
    stage = 'commit_user';
    await connection.commit();
    connection.release();
    connection = null;
    return res.status(201).json({ message: 'რეგისტრაცია წარმატებულია', token, user });
  } catch (e) {
    if (connection) {
      try { await connection.rollback(); } catch (rollbackError) { console.error('Registration rollback failed:', rollbackError.code || rollbackError.name || 'unknown_error'); }
      connection.release();
    }
    console.error('Registration failed:', {
      stage,
      code: e.code || null,
      errno: e.errno || null,
      sqlState: e.sqlState || null,
      name: e.name || null,
      status: e.status || e.statusCode || null
    });
    return res.status(e.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: e.code === 'ER_DUP_ENTRY' ? 'მომხმარებელი ამ ელ-ფოსტით უკვე არსებობს' : 'Server Error' });
  }
};
exports.verifyEmail = async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
  if (!emailOk(email) || !/^\d{4}$/.test(code)) return res.status(400).json({ message: 'სწორი ელ-ფოსტა და 4-ნიშნა კოდი აუცილებელია' });
  try {
    const [rows] = await pool.query('SELECT id, email_verified, verification_code, verification_code_expires FROM users WHERE email=?', [email]);
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'მომხმარებელი ამ ელ-ფოსტით ვერ მოიძებნა' });
    if (user.email_verified) return res.status(400).json({ message: 'ელ-ფოსტა უკვე დადასტურებულია' });
    if (!user.verification_code || !user.verification_code_expires || new Date(user.verification_code_expires) <= new Date()) {
      return res.status(400).json({ message: 'კოდი არასწორია ან ვადა გაუვიდა' });
    }
    if (!(await bcrypt.compare(code, user.verification_code))) return res.status(400).json({ message: 'კოდი არასწორია ან ვადა გაუვიდა' });
    await pool.query(
      'UPDATE users SET email_verified=true, verification_code=NULL, verification_code_expires=NULL WHERE id=? AND email_verified=false',
      [user.id]
    );
    return res.json({ message: 'ელ-ფოსტა წარმატებით დადასტურდა' });
  } catch (e) { console.error(e); return res.status(500).json({ message: 'სერვერის შეცდომა' }); }
};
exports.resendCode = async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!emailOk(email)) return res.status(400).json({ message: 'სწორი ელ-ფოსტა აუცილებელია' });
  try {
    const [rows] = await pool.query('SELECT id, email_verified FROM users WHERE email=?', [email]);
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'მომხმარებელი ამ ელ-ფოსტით ვერ მოიძებნა' });
    if (user.email_verified) return res.status(400).json({ message: 'ელ-ფოსტა უკვე დადასტურებულია' });
    const verificationCode = generateVerificationCode();
    await pool.query(
      'UPDATE users SET verification_code=?, verification_code_expires=DATE_ADD(NOW(), INTERVAL 5 MINUTE) WHERE id=?',
      [await bcrypt.hash(verificationCode, 12), user.id]
    );
    await sendVerificationCode(email, verificationCode);
    return res.json({ message: 'დადასტურების კოდი გაიგზავნა' });
  } catch (e) { console.error(e); return res.status(500).json({ message: 'სერვერის შეცდომა' }); }
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
      await pool.query('UPDATE users SET google_id=?, full_name=?, avatar_url=?, email_verified=true WHERE id=?', [p.sub, user.full_name, user.avatar_url, user.id]);
    } else {
      const [r] = await pool.query('INSERT INTO users (full_name,email,google_id,avatar_url,email_verified) VALUES (?,?,?,?,true)', [p.name || email, email, p.sub, p.picture || null]);
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
