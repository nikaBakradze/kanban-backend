const crypto = require('crypto');
const pool = require('../config/db');
const { emitWorkspaceEvent, emitUserEvent, removeUserFromWorkspace } = require('../realtime/workspaceRealtime');

const validId = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
const types = new Set(['TEAM', 'EDUCATION']);
const roles = new Set(['OWNER', 'ADMIN', 'MEMBER']);
const publicWorkspace = (w) => ({ id: w.id, name: w.name, type: w.type, owner_id: w.owner_id, created_at: w.created_at });
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const validEmail = (value) => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

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
exports.inviteByEmail = async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!validId(req.params.id) || !validEmail(email)) {
    return res.status(400).json({ message: 'A valid email address is required.' });
  }
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [workspaces] = await c.query(
      `SELECT w.id,w.name,wm.role FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id=w.id
       WHERE w.id=? AND wm.user_id=? FOR UPDATE`,
      [req.params.id, req.user.id],
    );
    if (!workspaces.length || (workspaces[0].role !== 'OWNER' && workspaces[0].role !== 'ADMIN')) {
      await c.rollback();
      return res.status(403).json({ message: 'Only workspace owners and admins can invite users.' });
    }

    const [users] = await c.query(
      'SELECT id FROM users WHERE email=?',
      [email],
    );
    if (!users.length) {
      await c.rollback();
      return res.status(404).json({
        message: 'User with this email does not exist. Try inviting them using the workspace link.',
      });
    }
    const invitedUserId = Number(users[0].id);
    const workspaceId = Number(workspaces[0].id);

    const [members] = await c.query(
      'SELECT id FROM workspace_members WHERE workspace_id=? AND user_id=?',
      [workspaceId, invitedUserId],
    );
    if (members.length) {
      await c.rollback();
      return res.status(409).json({ message: 'This user is already a member of this workspace.' });
    }

    const [pending] = await c.query(
      `SELECT id FROM workspace_email_invites
       WHERE workspace_id=? AND invited_user_id=? AND status='PENDING' LIMIT 1`,
      [workspaceId, invitedUserId],
    );
    if (pending.length) {
      await c.rollback();
      return res.status(409).json({ message: 'An invitation has already been sent to this user.' });
    }

    const [result] = await c.query(
      'INSERT INTO workspace_email_invites (workspace_id,invited_user_id,invited_by) VALUES (?,?,?)',
      [workspaceId, invitedUserId, req.user.id],
    );
    const [inviterRows] = await c.query('SELECT full_name FROM users WHERE id=?', [req.user.id]);
    await c.commit();

    const invitation = {
      id: Number(result.insertId),
      workspace_id: workspaceId,
      workspace_name: workspaces[0].name,
      inviter_name: inviterRows[0]?.full_name || 'A workspace admin',
      created_at: new Date().toISOString(),
    };
    emitUserEvent(invitedUserId, 'workspace.invitation.created', invitation);
    return res.status(201).json({ message: 'Invitation sent successfully.', invitation_id: invitation.id });
  } catch (error) {
    await c.rollback();
    console.error(error);
    return res.status(500).json({ message: 'Unable to send workspace invitation.' });
  } finally {
    c.release();
  }
};

exports.pendingEmailInvites = async (req, res) => {
  try {
    const [invitations] = await pool.query(
      `SELECT i.id,i.workspace_id,w.name AS workspace_name,
              inviter.full_name AS inviter_name,i.created_at
       FROM workspace_email_invites i
       JOIN workspaces w ON w.id=i.workspace_id
       JOIN users inviter ON inviter.id=i.invited_by
       WHERE i.invited_user_id=? AND i.status='PENDING'
       ORDER BY i.created_at DESC`,
      [req.user.id],
    );
    return res.json(invitations.map((item) => ({
      id: Number(item.id),
      workspace_id: Number(item.workspace_id),
      workspace_name: item.workspace_name,
      inviter_name: item.inviter_name || 'A workspace admin',
      created_at: item.created_at,
    })));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Unable to load workspace invitations.' });
  }
};

exports.respondToEmailInvite = async (req, res) => {
  const invitationId = req.params.invitationId;
  const action = req.body.action;
  if (!validId(invitationId) || (action !== 'accept' && action !== 'decline')) {
    return res.status(400).json({ message: 'A valid invitation ID and action are required.' });
  }
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [invitations] = await c.query(
      `SELECT id,workspace_id,status FROM workspace_email_invites
       WHERE id=? AND invited_user_id=? FOR UPDATE`,
      [invitationId, req.user.id],
    );
    if (!invitations.length) {
      await c.rollback();
      return res.status(404).json({ message: 'Invitation not found.' });
    }
    if (invitations[0].status !== 'PENDING') {
      await c.rollback();
      return res.status(409).json({ message: 'This invitation is no longer pending.' });
    }

    const workspaceId = Number(invitations[0].workspace_id);
    let joined = false;
    if (action === 'accept') {
      const [existing] = await c.query(
        'SELECT id FROM workspace_members WHERE workspace_id=? AND user_id=?',
        [workspaceId, req.user.id],
      );
      if (!existing.length) {
        await c.query(
          'INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)',
          [workspaceId, req.user.id, 'MEMBER'],
        );
        joined = true;
      }
    }

    const status = action === 'accept' ? 'ACCEPTED' : 'DECLINED';
    const [updated] = await c.query(
      `UPDATE workspace_email_invites SET status=?,responded_at=NOW()
       WHERE id=? AND invited_user_id=? AND status='PENDING'`,
      [status, invitationId, req.user.id],
    );
    if (!updated.affectedRows) {
      await c.rollback();
      return res.status(409).json({ message: 'This invitation is no longer pending.' });
    }
    const [workspaces] = await c.query('SELECT name FROM workspaces WHERE id=?', [workspaceId]);
    await c.commit();

    if (joined) emitWorkspaceEvent(workspaceId, 'member.joined', { user_id: Number(req.user.id), role: 'MEMBER' }, req.user.id);
    emitUserEvent(req.user.id, 'workspace.invitation.updated', {
      invitation_id: Number(invitationId),
      status,
    });
    return res.json({
      invitation_id: Number(invitationId),
      workspace_id: workspaceId,
      workspace_name: workspaces[0]?.name,
      status,
      ...(action === 'accept' ? { role: 'MEMBER' } : {}),
    });
  } catch (error) {
    await c.rollback();
    console.error(error);
    return res.status(500).json({ message: 'Unable to respond to workspace invitation.' });
  } finally {
    c.release();
  }
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
