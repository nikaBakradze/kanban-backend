const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const pool = require('../config/db');

const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const CHALLENGE_MINUTES = 5;
const SESSION_MINUTES = 15;
const recoveryCodeCount = 10;

function encryptionKey() {
  if (!process.env.ADMIN_TOTP_ENCRYPTION_KEY) throw new Error('ADMIN_TOTP_ENCRYPTION_KEY is not configured');
  return crypto.createHash('sha256').update(process.env.ADMIN_TOTP_ENCRYPTION_KEY).digest();
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}
function decrypt(value) {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = value.replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid TOTP secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, '0');
}
function validTotp(secret, code) {
  if (!/^\d{6}$/.test(code || '')) return false;
  for (const offset of [-30000, 0, 30000]) {
    if (crypto.timingSafeEqual(Buffer.from(totp(secret, Date.now() + offset)), Buffer.from(code))) return true;
  }
  return false;
}
function createSecret() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  for (let i = 0; i < 32; i += 1) secret += alphabet[crypto.randomInt(alphabet.length)];
  return secret;
}
function recoveryCodes() {
  return Array.from({ length: recoveryCodeCount }, () => `${crypto.randomBytes(5).toString('hex')}-${crypto.randomBytes(5).toString('hex')}`);
}
function normalizeRecoveryCode(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
async function superAdmin(userId) {
  const [rows] = await pool.query(
    'SELECT id,email,full_name,system_role,is_active,totp_enabled,totp_secret_encrypted,totp_setup_expires,totp_failed_attempts,totp_locked_until FROM users WHERE id=?',
    [userId],
  );
  return rows[0];
}
async function logAction(actorId, action, targetType, targetId, metadata = null) {
  await pool.query(
    'INSERT INTO admin_activity_logs (actor_user_id,action,target_type,target_id,metadata) VALUES (?,?,?,?,?)',
    [actorId, action, targetType, targetId, metadata ? JSON.stringify(metadata) : null],
  );
}
async function createAdminSession(userId) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MINUTES * 60000);
  const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
  await pool.query(
    'INSERT INTO admin_sessions (user_id,session_hash,expires_at) VALUES (?,?,?)',
    [userId, sessionHash, expiresAt],
  );
  return jwt.sign(
    { id: userId, jti: sessionId, purpose: 'admin_session', admin: true },
    process.env.JWT_SECRET,
    { expiresIn: `${SESSION_MINUTES}m` },
  );
}
function challengeToken(userId) {
  return jwt.sign(
    { id: userId, purpose: 'admin_2fa_challenge' },
    process.env.JWT_SECRET,
    { expiresIn: `${CHALLENGE_MINUTES}m` },
  );
}
function getChallenge(req) {
  const value = typeof req.body.challenge_token === 'string' ? req.body.challenge_token : '';
  return jwt.verify(value, process.env.JWT_SECRET);
}
async function requireSuperAdmin(req, res) {
  const user = await superAdmin(req.user.id);
  if (!user || user.system_role !== 'SUPER_ADMIN'
    || (user.is_active !== 1 && user.is_active !== true)) {
    res.status(403).json({ message: 'Super Admin access denied' });
    return null;
  }
  return user;
}

exports.start = async (req, res) => {
  try {
    const user = await requireSuperAdmin(req, res);
    if (!user) return;
    if (!user.totp_enabled) return res.json({ setupRequired: true });
    return res.json({ setupRequired: false, challengeToken: challengeToken(user.id) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Unable to start admin authentication' });
  }
};

exports.setup = async (req, res) => {
  try {
    const user = await requireSuperAdmin(req, res);
    if (!user) return;
    if (user.totp_enabled) return res.status(409).json({ message: '2FA is already enabled' });
    const secret = createSecret();
    const label = encodeURIComponent(`Kanban Admin:${user.email}`);
    const issuer = encodeURIComponent('Kanban');
    const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
    await pool.query(
      'UPDATE users SET totp_secret_encrypted=?,totp_setup_expires=?,totp_failed_attempts=0,totp_locked_until=NULL WHERE id=?',
      [encrypt(secret), new Date(Date.now() + CHALLENGE_MINUTES * 60000), user.id],
    );
    const qrCode = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    return res.json({ qrCode, expiresInMinutes: CHALLENGE_MINUTES });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Unable to initialize 2FA setup' });
  }
};

exports.completeSetup = async (req, res) => {
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ message: 'A valid 6-digit code is required' });
  try {
    const user = await requireSuperAdmin(req, res);
    if (!user) return;
    if (user.totp_enabled || !user.totp_secret_encrypted || !user.totp_setup_expires || new Date(user.totp_setup_expires) <= new Date()) {
      return res.status(409).json({ message: '2FA setup is missing or expired' });
    }
    if (!validTotp(decrypt(user.totp_secret_encrypted), code)) return res.status(401).json({ message: 'Invalid authenticator code' });
    const codes = recoveryCodes();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('UPDATE users SET totp_enabled=true,totp_setup_expires=NULL,totp_failed_attempts=0,totp_locked_until=NULL WHERE id=?', [user.id]);
      await connection.query('DELETE FROM admin_recovery_codes WHERE user_id=?', [user.id]);
      for (const recoveryCode of codes) {
        await connection.query('INSERT INTO admin_recovery_codes (user_id,code_hash) VALUES (?,?)', [user.id, await bcrypt.hash(recoveryCode, 12)]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await logAction(user.id, '2FA_ENABLED', 'USER', user.id);
    return res.json({ message: '2FA enabled', recoveryCodes: codes });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Unable to complete 2FA setup' });
  }
};

exports.verify = async (req, res) => {
  let challenge;
  try {
    challenge = getChallenge(req);
    if (challenge.purpose !== 'admin_2fa_challenge') throw new Error('Invalid challenge');
  } catch {
    return res.status(401).json({ message: 'Invalid or expired admin challenge' });
  }
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
  const recoveryCode = normalizeRecoveryCode(req.body.recovery_code);
  try {
    const user = await superAdmin(challenge.id);
    if (!user || user.system_role !== 'SUPER_ADMIN'
      || (user.is_active !== 1 && user.is_active !== true)
      || !user.totp_enabled || !user.totp_secret_encrypted) {
      return res.status(403).json({ message: 'Super Admin access denied' });
    }
    if (user.totp_locked_until && new Date(user.totp_locked_until) > new Date()) {
      return res.status(429).json({ message: '2FA temporarily locked. Try again later.' });
    }
    let verified = false;
    let recoveryId = null;
    if (recoveryCode) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [codes] = await connection.query(
          'SELECT id,code_hash FROM admin_recovery_codes WHERE user_id=? AND used_at IS NULL FOR UPDATE',
          [user.id],
        );
        for (const candidate of codes) {
          if (await bcrypt.compare(recoveryCode, candidate.code_hash)) {
            const [claimed] = await connection.query(
              'UPDATE admin_recovery_codes SET used_at=NOW() WHERE id=? AND used_at IS NULL',
              [candidate.id],
            );
            if (claimed.affectedRows === 1) {
              verified = true;
              recoveryId = candidate.id;
            }
            break;
          }
        }
        if (!verified) {
          const attempts = Number(user.totp_failed_attempts || 0) + 1;
          await connection.query(
            'UPDATE users SET totp_failed_attempts=?,totp_locked_until=? WHERE id=?',
            [attempts, attempts >= LOCKOUT_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60000) : null, user.id],
          );
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    } else {
      verified = validTotp(decrypt(user.totp_secret_encrypted), code);
    }
    if (!verified && !recoveryCode) {
      const attempts = Number(user.totp_failed_attempts || 0) + 1;
      await pool.query(
        'UPDATE users SET totp_failed_attempts=?,totp_locked_until=? WHERE id=?',
        [attempts, attempts >= LOCKOUT_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60000) : null, user.id],
      );
      return res.status(401).json({ message: 'Invalid 2FA code' });
    }
    if (!verified) return res.status(401).json({ message: 'Invalid 2FA code' });
    await pool.query('UPDATE users SET totp_failed_attempts=0,totp_locked_until=NULL WHERE id=?', [user.id]);
    await logAction(user.id, recoveryId ? 'ADMIN_LOGIN_RECOVERY_CODE' : 'ADMIN_LOGIN_2FA', 'USER', user.id);
    return res.json({ token: await createAdminSession(user.id), user: { id: user.id, email: user.email, full_name: user.full_name } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Unable to verify admin authentication' });
  }
};

exports.logout = async (req, res) => {
  try {
    const [result] = await pool.query(
      'UPDATE admin_sessions SET revoked_at=NOW() WHERE id=? AND revoked_at IS NULL',
      [req.adminSessionId],
    );
    if (result.affectedRows) await logAction(req.admin.id, 'ADMIN_LOGOUT', 'USER', req.admin.id);
    return res.json({ message: 'Admin session revoked' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Unable to revoke admin session' });
  }
};

exports.overview = async (req, res) => {
  try {
    const [[users]] = await pool.query('SELECT COUNT(*) AS count FROM users');
    const [[workspaces]] = await pool.query('SELECT COUNT(*) AS count FROM workspaces');
    const [[boards]] = await pool.query('SELECT COUNT(*) AS count FROM boards');
    const [[tasks]] = await pool.query('SELECT COUNT(*) AS count FROM tasks');
    return res.json({ users: users.count, workspaces: workspaces.count, boards: boards.count, tasks: tasks.count });
  } catch (error) { console.error(error); return res.status(500).json({ message: 'Unable to load overview' }); }
};
const ANALYTICS_INTERVALS = new Set(['day', 'week', 'month']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UTC_CREATED_AT = "CONVERT_TZ(created_at, @@session.time_zone, '+00:00')";
const GROUP_EXPRESSIONS = {
  day: `DATE_FORMAT(${UTC_CREATED_AT}, '%Y-%m-%d')`,
  week: `DATE_FORMAT(DATE_SUB(DATE(${UTC_CREATED_AT}), INTERVAL WEEKDAY(DATE(${UTC_CREATED_AT})) DAY), '%Y-%m-%d')`,
  month: `DATE_FORMAT(${UTC_CREATED_AT}, '%Y-%m-01')`,
};

function parseAnalyticsDate(value) {
  if (!DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function utcDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function analyticsRange(query) {
  const hasFrom = query.from !== undefined;
  const hasTo = query.to !== undefined;
  if (hasFrom !== hasTo) return { error: 'from and to must be provided together' };
  const interval = query.interval === undefined ? 'day' : query.interval;
  if (typeof interval !== 'string' || !ANALYTICS_INTERVALS.has(interval)) return { error: 'interval must be day, week, or month' };

  let from;
  let toExclusive;
  if (!hasFrom) {
    toExclusive = new Date();
    toExclusive.setUTCHours(0, 0, 0, 0);
    toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
    from = new Date(toExclusive);
    from.setUTCDate(from.getUTCDate() - 30);
  } else {
    if (typeof query.from !== 'string' || typeof query.to !== 'string') return { error: 'from and to must be YYYY-MM-DD dates' };
    from = parseAnalyticsDate(query.from);
    const to = parseAnalyticsDate(query.to);
    if (!from || !to) return { error: 'from and to must be valid YYYY-MM-DD dates' };
    toExclusive = new Date(to);
    toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  }
  const days = (toExclusive.getTime() - from.getTime()) / 86400000;
  if (days <= 0) return { error: 'to must be on or after from' };
  if (days > 365) return { error: 'date range cannot exceed 365 days' };
  return {
    from,
    toExclusive,
    fromLabel: from.toISOString().slice(0, 10),
    toLabel: new Date(toExclusive.getTime() - 86400000).toISOString().slice(0, 10),
    interval,
  };
}

exports.analytics = async (req, res) => {
  const range = analyticsRange(req.query);
  if (range.error) return res.status(400).json({ message: range.error });
  const params = [utcDateTime(range.from), utcDateTime(range.toExclusive)];
  const growth = (table) => pool.query(
    `SELECT ${GROUP_EXPRESSIONS[range.interval]} AS period, COUNT(*) AS count
     FROM ${table}
     WHERE ${UTC_CREATED_AT} >= ? AND ${UTC_CREATED_AT} < ?
     GROUP BY period ORDER BY period`,
    params,
  );
  try {
    const [
      [summaryUsers],
      [summaryWorkspaces],
      [summaryBoards],
      [summaryTasks],
      [userStatus],
      [userGrowth],
      [workspaceTypes],
      [workspaceGrowth],
      [averageMembers],
      [boardTypes],
      [boardGrowth],
      [taskGrowth],
      [subtaskStatus],
      [activityGrowth],
      [activityActions],
      [newToday],
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) AS count FROM users'),
      pool.query('SELECT COUNT(*) AS count FROM workspaces'),
      pool.query('SELECT COUNT(*) AS count FROM boards'),
      pool.query('SELECT COUNT(*) AS count FROM tasks'),
      pool.query(
        `SELECT
          SUM(is_active = TRUE) AS active,
          SUM(is_active = FALSE) AS inactive,
          SUM(email_verified = TRUE) AS verified,
          SUM(email_verified = FALSE) AS unverified
         FROM users`,
      ),
      growth('users'),
      pool.query('SELECT type, COUNT(*) AS count FROM workspaces GROUP BY type ORDER BY type'),
      growth('workspaces'),
      pool.query(
        `SELECT COALESCE(AVG(member_count), 0) AS average_members
         FROM (
           SELECT w.id, COUNT(wm.user_id) AS member_count
           FROM workspaces w
           LEFT JOIN workspace_members wm ON wm.workspace_id=w.id
           GROUP BY w.id
         ) workspace_counts`,
      ),
      pool.query(
        `SELECT CASE WHEN workspace_id IS NULL THEN 'PERSONAL' ELSE 'WORKSPACE' END AS board_type,
                COUNT(*) AS count
         FROM boards GROUP BY board_type ORDER BY board_type`,
      ),
      growth('boards'),
      growth('tasks'),
      pool.query('SELECT is_completed, COUNT(*) AS count FROM subtasks GROUP BY is_completed ORDER BY is_completed'),
      growth('admin_activity_logs'),
      pool.query(
        `SELECT action, COUNT(*) AS count
         FROM admin_activity_logs
         WHERE ${UTC_CREATED_AT} >= ? AND ${UTC_CREATED_AT} < ?
         GROUP BY action ORDER BY count DESC, action`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM users
         WHERE ${UTC_CREATED_AT} >= ? AND ${UTC_CREATED_AT} < ?`,
        [utcDateTime(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()))), utcDateTime(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)))],
      ),
    ]);
    const subtasks = Object.fromEntries(subtaskStatus.map((row) => [row.is_completed ? 'completed' : 'incomplete', Number(row.count)]));
    const totalSubtasks = Number(subtasks.completed || 0) + Number(subtasks.incomplete || 0);
    return res.json({
      range: { from: range.fromLabel, to: range.toLabel, interval: range.interval, timezone: 'UTC' },
      summary: {
        users: Number(summaryUsers[0].count),
        workspaces: Number(summaryWorkspaces[0].count),
        boards: Number(summaryBoards[0].count),
        tasks: Number(summaryTasks[0].count),
      },
      users: {
        newToday: Number(newToday[0].count),
        active: Number(userStatus[0].active || 0),
        inactive: Number(userStatus[0].inactive || 0),
        verified: Number(userStatus[0].verified || 0),
        unverified: Number(userStatus[0].unverified || 0),
        growth: userGrowth.map((row) => ({ period: row.period, count: Number(row.count) })),
      },
      workspaces: {
        byType: workspaceTypes.map((row) => ({ type: row.type, count: Number(row.count) })),
        growth: workspaceGrowth.map((row) => ({ period: row.period, count: Number(row.count) })),
        averageMembers: Number(Number(averageMembers[0].average_members).toFixed(2)),
      },
      boards: {
        personal: Number(boardTypes.find((row) => row.board_type === 'PERSONAL')?.count || 0),
        workspace: Number(boardTypes.find((row) => row.board_type === 'WORKSPACE')?.count || 0),
        growth: boardGrowth.map((row) => ({ period: row.period, count: Number(row.count) })),
      },
      tasks: {
        growth: taskGrowth.map((row) => ({ period: row.period, count: Number(row.count) })),
        subtasks: {
          total: totalSubtasks,
          completed: Number(subtasks.completed || 0),
          incomplete: Number(subtasks.incomplete || 0),
          completionRate: totalSubtasks ? Number(((Number(subtasks.completed || 0) / totalSubtasks) * 100).toFixed(2)) : 0,
        },
      },
      adminActivity: {
        growth: activityGrowth.map((row) => ({ period: row.period, count: Number(row.count) })),
        byAction: activityActions.map((row) => ({ action: row.action, count: Number(row.count) })),
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Unable to load analytics' });
  }
};
exports.users = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id,full_name,email,system_role,email_verified,is_active,totp_enabled,created_at FROM users ORDER BY created_at DESC LIMIT 500');
    return res.json(rows);
  } catch (error) { console.error(error); return res.status(500).json({ message: 'Unable to load users' }); }
};
exports.workspaces = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT w.id,w.name,w.type,w.owner_id,w.created_at,u.email AS owner_email,
        (SELECT COUNT(*) FROM workspace_members wm WHERE wm.workspace_id=w.id) AS member_count
       FROM workspaces w JOIN users u ON u.id=w.owner_id ORDER BY w.created_at DESC LIMIT 500`,
    );
    return res.json(rows);
  } catch (error) { console.error(error); return res.status(500).json({ message: 'Unable to load workspaces' }); }
};
exports.boards = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.id,b.title,b.workspace_id,b.created_at,w.name AS workspace_name,
        (SELECT COUNT(*) FROM columns c WHERE c.board_id=b.id) AS column_count
       FROM boards b LEFT JOIN workspaces w ON w.id=b.workspace_id ORDER BY b.created_at DESC LIMIT 500`,
    );
    return res.json(rows);
  } catch (error) { console.error(error); return res.status(500).json({ message: 'Unable to load boards' }); }
};
exports.activity = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT l.id,l.action,l.target_type,l.target_id,l.metadata,l.created_at,u.email AS actor_email
       FROM admin_activity_logs l JOIN users u ON u.id=l.actor_user_id
       ORDER BY l.created_at DESC LIMIT 500`,
    );
    return res.json(rows);
  } catch (error) { console.error(error); return res.status(500).json({ message: 'Unable to load activity logs' }); }
};
exports.health = async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ database: 'ok', checkedAt: new Date().toISOString() });
  } catch (error) { console.error(error); return res.status(503).json({ database: 'unavailable' }); }
};
exports.security = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id,email,totp_enabled,totp_locked_until FROM users WHERE id=?', [req.admin.id]);
    return res.json({ twoFactorEnabled: Boolean(rows[0]?.totp_enabled), lockedUntil: rows[0]?.totp_locked_until || null });
  } catch (error) { console.error(error); return res.status(500).json({ message: 'Unable to load security settings' }); }
};
exports.updateUserStatus = async (req, res) => {
  const active = req.body.active;
  if (typeof active !== 'boolean') return res.status(400).json({ message: 'active must be boolean' });
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0 || targetId === req.admin.id) return res.status(400).json({ message: 'This user cannot be modified' });
  try {
    const [result] = await pool.query('UPDATE users SET is_active=? WHERE id=? AND system_role <> \'SUPER_ADMIN\'', [active, targetId]);
    if (!result.affectedRows) return res.status(404).json({ message: 'User not found or protected' });
    await logAction(req.admin.id, active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', 'USER', targetId);
    return res.json({ message: active ? 'User activated' : 'User deactivated' });
  } catch (error) { console.error(error); return res.status(500).json({ message: 'Unable to update user status' }); }
};
exports.deleteUser = async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0 || targetId === req.admin.id) return res.status(400).json({ message: 'This user cannot be deleted' });
  try {
    const [result] = await pool.query('DELETE FROM users WHERE id=? AND system_role <> \'SUPER_ADMIN\'', [targetId]);
    if (!result.affectedRows) return res.status(404).json({ message: 'User not found or protected' });
    await logAction(req.admin.id, 'USER_DELETED', 'USER', targetId);
    return res.json({ message: 'User deleted' });
  } catch (error) { console.error(error); return res.status(500).json({ message: 'Unable to delete user' }); }
};
