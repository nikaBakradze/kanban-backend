const crypto = require('crypto');
const pool = require('../config/db');
const { emitWorkspaceEvent, removeUserFromWorkspace } = require('../realtime/workspaceRealtime');

const validId = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
const types = new Set(['TEAM', 'EDUCATION']);
const roles = new Set(['OWNER', 'ADMIN', 'MEMBER']);
const publicWorkspace = (w) => ({ id: w.id, name: w.name, type: w.type, owner_id: w.owner_id, created_at: w.created_at });
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function membership(connection, workspaceId, userId) {
  const [rows] = await connection.query(
    'SELECT wm.*, w.name, w.type, w.owner_id FROM workspace_members wm JOIN workspaces w ON w.id=wm.workspace_id WHERE wm.workspace_id=? AND wm.user_id=?',
    [workspaceId, userId],
  );
  return rows[0];
}
async function manager(connection, workspaceId, userId) {
  const member = await membership(connection, workspaceId, userId);
  return member && (member.role === 'OWNER' || member.role === 'ADMIN') ? member : null;
}
function expiration(value) {
  if (value === null || value === 'never' || value === undefined) return null;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) return NaN;
  return new Date(Date.now() + days * 86400000);
}

exports.createWorkspace = async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const type = typeof req.body.type === 'string' ? req.body.type.toUpperCase() : '';
  if (!name || name.length > 255 || !types.has(type)) return res.status(400).json({ message: 'სწორი name და workspace type აუცილებელია' });
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [workspace] = await c.query('INSERT INTO workspaces (name,type,owner_id) VALUES (?,?,?)', [name, type, req.user.id]);
    await c.query('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)', [workspace.insertId, req.user.id, 'OWNER']);
    await c.commit();
    return res.status(201).json({ ...publicWorkspace({ id: workspace.insertId, name, type, owner_id: req.user.id }), role: 'OWNER' });
  } catch (e) { await c.rollback(); console.error(e); return res.status(500).json({ message: 'Workspace-ის შექმნა ვერ მოხერხდა' }); }
  finally { c.release(); }
};

exports.listWorkspaces = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT w.*, wm.role FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id WHERE wm.user_id=? ORDER BY w.type=\'PERSONAL\' DESC,w.created_at',
      [req.user.id],
    );
    return res.json(rows.map(publicWorkspace).map((w, i) => ({ ...w, role: rows[i].role })));
  } catch (e) { console.error(e); return res.status(500).json({ message: 'Workspaces-ის წამოღება ვერ მოხერხდა' }); }
};

exports.getWorkspace = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: 'არასწორი workspace ID' });
  try {
    const member = await membership(pool, req.params.id, req.user.id);
    if (!member) return res.status(404).json({ message: 'Workspace ვერ მოიძებნა ან წვდომა აკრძალულია' });
    const [members] = await pool.query('SELECT id,user_id,role,created_at FROM workspace_members WHERE workspace_id=? ORDER BY created_at', [req.params.id]);
    return res.json({ ...publicWorkspace(member), role: member.role, members });
  } catch (e) { console.error(e); return res.status(500).json({ message: 'Workspace-ის წამოღება ვერ მოხერხდა' }); }
};
exports.members = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: 'არასწორი workspace ID' });
  try {
    if (!await membership(pool, req.params.id, req.user.id)) return res.status(404).json({ message: 'Workspace ვერ მოიძებნა ან წვდომა აკრძალულია' });
    const [members] = await pool.query(
      `SELECT wm.user_id, wm.role, wm.created_at, u.full_name, u.email, u.avatar_url
       FROM workspace_members wm JOIN users u ON u.id=wm.user_id
       WHERE wm.workspace_id=? ORDER BY wm.created_at`,
      [req.params.id],
    );
    return res.json(members);
  } catch (e) { console.error(e); return res.status(500).json({ message: 'წევრების წამოღება ვერ მოხერხდა' }); }
};

exports.createInvite = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: 'არასწორი workspace ID' });
  const expires = expiration(req.body.expires_in_days);
  if (Number.isNaN(expires)) return res.status(400).json({ message: 'ვადის მნიშვნელობა არასწორია' });
  try {
    if (!await manager(pool, req.params.id, req.user.id)) return res.status(403).json({ message: 'წვდომა აკრძალულია' });
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('INSERT INTO workspace_invites (workspace_id,token_hash,expires_at,created_by) VALUES (?,?,?,?)', [req.params.id, hashToken(token), expires, req.user.id]);
    emitWorkspaceEvent(req.params.id, 'invite.created', { expires_at: expires }, req.user.id);
    return res.status(201).json({ token, invite_url: `/invite/${token}`, expires_at: expires });
  } catch (e) { console.error(e); return res.status(500).json({ message: 'მოსაწვევის შექმნა ვერ მოხერხდა' }); }
};
exports.validateInvite = async (req, res) => {
  if (typeof req.params.token !== 'string' || !req.params.token) return res.status(400).json({ message: 'არასწორი invite token' });
  try {
    const [rows] = await pool.query('SELECT w.id,w.name,w.type FROM workspace_invites i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_hash=? AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at>NOW())', [hashToken(req.params.token)]);
    return rows[0] ? res.json({ valid: true, workspace: rows[0] }) : res.status(404).json({ valid: false, message: 'მოსაწვევი არავალიდური ან ვადაგასულია' });
  } catch (e) { console.error(e); return res.status(500).json({ message: 'მოსაწვევის შემოწმება ვერ მოხერხდა' }); }
};
exports.acceptInvite = async (req, res) => {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [rows] = await c.query('SELECT workspace_id FROM workspace_invites WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW()) FOR UPDATE', [hashToken(req.params.token)]);
    if (!rows.length) { await c.rollback(); return res.status(404).json({ message: 'მოსაწვევი არავალიდური ან ვადაგასულია' }); }
    const [existing] = await c.query('SELECT id FROM workspace_members WHERE workspace_id=? AND user_id=?', [rows[0].workspace_id, req.user.id]);
    if (existing.length) { await c.rollback(); return res.status(409).json({ message: 'მომხმარებელი უკვე არის workspace-ის წევრი' }); }
    await c.query('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)', [rows[0].workspace_id, req.user.id, 'MEMBER']);
    await c.commit();
    emitWorkspaceEvent(rows[0].workspace_id, 'member.joined', { user_id: Number(req.user.id), role: 'MEMBER' }, req.user.id);
    return res.status(201).json({ message: 'Workspace-ში გაწევრიანება წარმატებულია', workspace_id: rows[0].workspace_id, role: 'MEMBER' });
  } catch (e) { await c.rollback(); console.error(e); return res.status(500).json({ message: 'Workspace-ში გაწევრიანება ვერ მოხერხდა' }); }
  finally { c.release(); }
};
exports.revokeInvite = async (req, res) => {
  try {
    const [invite] = await pool.query('SELECT workspace_id FROM workspace_invites WHERE token_hash=? AND revoked_at IS NULL', [hashToken(req.params.token)]);
    if (!invite.length) return res.status(404).json({ message: 'მოსაწვევი ვერ მოიძებნა' });
    const actor = await membership(pool, invite[0].workspace_id, req.user.id);
    if (!actor) return res.status(404).json({ message: 'Workspace ვერ მოიძებნა ან წვდომა აკრძალულია' });
    if (actor.role !== 'OWNER' && actor.role !== 'ADMIN') return res.status(403).json({ message: 'მოსაწვევის გაუქმება აკრძალულია' });
    const [result] = await pool.query('UPDATE workspace_invites SET revoked_at=NOW() WHERE token_hash=? AND revoked_at IS NULL', [hashToken(req.params.token)]);
    if (!result.affectedRows) return res.status(404).json({ message: 'მოსაწვევი ვერ მოიძებნა ან წვდომა აკრძალულია' });
    emitWorkspaceEvent(invite[0].workspace_id, 'invite.revoked', {}, req.user.id);
    return res.json({ message: 'მოსაწვევი გაუქმებულია' });
  } catch (e) { console.error(e); return res.status(500).json({ message: 'მოსაწვევის გაუქმება ვერ მოხერხდა' }); }
};
exports.leaveWorkspace = async (req, res) => {
  try {
    const member = await membership(pool, req.params.id, req.user.id);
    if (!member) return res.status(404).json({ message: 'წევრობა ვერ მოიძებნა' });
    if (member.role === 'OWNER' || member.type === 'PERSONAL') return res.status(400).json({ message: 'Owner ვერ დატოვებს workspace-ს' });
    const [result] = await pool.query('DELETE FROM workspace_members WHERE id=?', [member.id]);
    if (result.affectedRows) {
      emitWorkspaceEvent(req.params.id, 'member.removed', { user_id: Number(req.user.id) }, req.user.id);
      await removeUserFromWorkspace(req.params.id, req.user.id);
    }
    return res.json({ message: 'Workspace დატოვებულია' });
  } catch (e) { console.error(e); return res.status(500).json({ message: 'Workspace-ის დატოვება ვერ მოხერხდა' }); }
};
exports.updateMember = async (req, res) => {
  if (!validId(req.params.id) || !validId(req.params.memberId) || !roles.has(req.body.role)) return res.status(400).json({ message: 'მონაცემები არასწორია' });
  try {
    const actor = await manager(pool, req.params.id, req.user.id);
    if (!actor) return res.status(403).json({ message: 'წვდომა აკრძალულია' });
    const [target] = await pool.query('SELECT user_id, role FROM workspace_members WHERE id=? AND workspace_id=?', [req.params.memberId, req.params.id]);
    if (!target.length || target[0].role === 'OWNER' || req.body.role === 'OWNER') return res.status(400).json({ message: 'Owner-ის როლი ვერ შეიცვლება' });
    const [result] = await pool.query('UPDATE workspace_members SET role=? WHERE id=? AND workspace_id=?', [req.body.role, req.params.memberId, req.params.id]);
    if (result.affectedRows) {
      emitWorkspaceEvent(req.params.id, 'member.role.updated', {
        member_id: Number(req.params.memberId),
        user_id: Number(target[0].user_id),
        role: req.body.role,
      }, req.user.id);
    }
    return res.json({ member_id: Number(req.params.memberId), role: req.body.role });
  } catch (e) { console.error(e); return res.status(500).json({ message: 'წევრის როლის შეცვლა ვერ მოხერხდა' }); }
};
exports.removeMember = async (req, res) => {
  if (!validId(req.params.id) || !validId(req.params.memberId)) return res.status(400).json({ message: 'არასწორი ID' });
  try {
    if (!await manager(pool, req.params.id, req.user.id)) return res.status(403).json({ message: 'წვდომა აკრძალულია' });
    const [target] = await pool.query('SELECT user_id, role FROM workspace_members WHERE id=? AND workspace_id=?', [req.params.memberId, req.params.id]);
    if (!target.length || target[0].role === 'OWNER') return res.status(400).json({ message: 'Owner-ის წაშლა შეუძლებელია' });
    const [result] = await pool.query('DELETE FROM workspace_members WHERE id=? AND workspace_id=?', [req.params.memberId, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'წევრი ვერ მოიძებნა' });
    emitWorkspaceEvent(req.params.id, 'member.removed', { user_id: Number(target[0].user_id) }, req.user.id);
    await removeUserFromWorkspace(req.params.id, target[0].user_id);
    return res.json({ message: 'წევრი წაიშალა' });
  } catch (e) { console.error(e); return res.status(500).json({ message: 'წევრის წაშლა ვერ მოხერხდა' }); }
};
