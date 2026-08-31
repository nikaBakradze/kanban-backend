const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

exports.register = async (req, res) => {
  const { full_name, email, password } = req.body;
  
  if (!full_name || !email || !password) {
    return res.status(400).json({ message: 'ყველა ველი სავალდებულოა' });
  }

  try {
    const [existing] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ message: 'მომხმარებელი ამ ელ-ფოსტით უკვე არსებობს' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)',
      [full_name, email, hashedPassword]
    );

    const token = jwt.sign({ id: result.insertId, email }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'რეგისტრაცია წარმატებულია',
      token,
      user: { id: result.insertId, full_name, email }
    });
  } catch (error) {
    console.error('Register Error:', error);
    res.status(500).json({ message: 'სერვერის შეცდომა' });
  }
};

exports.login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'შეიყვანეთ ელ-ფოსტა და პაროლი' });
  }

  try {
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(400).json({ message: 'არასწორი ელ-ფოსტა ან პაროლი' });
    }

    const user = users[0];
    if (!user.password_hash) {
      return res.status(400).json({ message: 'გთხოვთ გაიაროთ ავტორიზაცია Google-ით' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ message: 'არასწორი ელ-ფოსტა ან პაროლი' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.status(200).json({
      message: 'ავტორიზაცია წარმატებულია',
      token,
      user: { id: user.id, full_name: user.full_name, email: user.email, avatar_url: user.avatar_url }
    });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ message: 'სერვერის შეცდომა' });
  }
};

exports.googleLogin = async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ message: 'Google credential აუცილებელია' });
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { sub: google_id, email, name: full_name, picture: avatar_url } = payload;

    const [existingUsers] = await pool.query('SELECT * FROM users WHERE email = ? OR google_id = ?', [email, google_id]);

    let user;

    if (existingUsers.length > 0) {
      user = existingUsers[0];

      if (!user.google_id) {
        await pool.query('UPDATE users SET google_id = ?, avatar_url = ? WHERE id = ?', [google_id, avatar_url, user.id]);
        user.google_id = google_id;
        user.avatar_url = avatar_url;
      }
    } else {
      const [result] = await pool.query(
        'INSERT INTO users (full_name, email, google_id, avatar_url) VALUES (?, ?, ?, ?)',
        [full_name, email, google_id, avatar_url]
      );

      const [newUser] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
      user = newUser[0];
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({
      message: 'Google ავტორიზაცია წარმატებულია',
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        avatar_url: user.avatar_url,
      },
    });
  } catch (error) {
    console.error('Google Auth Error:', error);
    res.status(500).json({ message: 'Google-ით ავტორიზაციის შეცდომა' });
  }
};

exports.forgotPassword = async (req, res) => {
  const { email } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(404).json({ message: 'User with this email was not found.' });
    }

    const user = users[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expires = new Date(Date.now() + 3600000); // 1 საათი

    await pool.query(
      'UPDATE users SET reset_token_hash = ?, reset_token_expires = ? WHERE id = ?',
      [resetTokenHash, expires, user.id]
    );

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

    res.status(200).json({
      message: 'Reset link generated successfully.',
      resetLink,
      to_email: user.email,
      to_name: user.full_name
    });
  } catch (error) {
    console.error('Forgot Password Error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

exports.resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;
  
  if (!token || !newPassword) {
    return res.status(400).json({ message: 'Token and new password are required.' });
  }

  try {
    const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const [users] = await pool.query(
      'SELECT * FROM users WHERE reset_token_hash = ? AND reset_token_expires > NOW()',
      [resetTokenHash]
    );

    if (users.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired token.' });
    }

    const user = users[0];
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query(
      'UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?',
      [hashedPassword, user.id]
    );

    res.status(200).json({ message: 'Password updated successfully.' });
  } catch (error) {
    console.error('Reset Password Error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};
