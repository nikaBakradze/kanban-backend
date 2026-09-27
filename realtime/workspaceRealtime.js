const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

let io;

const roomFor = (workspaceId) => `workspace:${Number(workspaceId)}`;
const userRoomFor = (userId) => `user:${Number(userId)}`;

function initializeWorkspaceRealtime(server, pool, allowedOrigins) {
  io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        const normalized = origin && (() => {
          try {
            const url = new URL(origin);
            return `${url.protocol}//${url.host}`.toLowerCase();
          } catch {
            return null;
          }
        })();
        const preview = typeof normalized === 'string'
          && /^https:\/\/kanban-[a-z0-9]+-nikabakradze\.vercel\.app$/.test(normalized);
        callback(null, !origin || allowedOrigins.includes(normalized) || preview);
      },
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (typeof token !== 'string' || !token) return next(new Error('Authentication required'));
    try {
      const user = jwt.verify(token, process.env.JWT_SECRET);
      const [rows] = await pool.query('SELECT email_verified FROM users WHERE id=?', [user.id]);
      if (!rows[0] || (rows[0].email_verified !== 1 && rows[0].email_verified !== true)) {
        return next(new Error('Authentication required'));
      }
      socket.data.userId = Number(user.id);
      return next();
    } catch {
      return next(new Error('Authentication required'));
    }
  });

  io.on('connection', (socket) => {
    void socket.join(userRoomFor(socket.data.userId));

    socket.on('workspace:join', async (workspaceId, acknowledge) => {
      const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
      if (!Number.isInteger(Number(workspaceId)) || Number(workspaceId) <= 0) {
        reply({ ok: false });
        return;
      }
      const requestedWorkspaceId = Number(workspaceId);
      socket.data.requestedWorkspaceId = requestedWorkspaceId;
      try {
        const [members] = await pool.query(
          'SELECT id FROM workspace_members WHERE workspace_id=? AND user_id=?',
          [requestedWorkspaceId, socket.data.userId],
        );
        if (!members.length || socket.data.requestedWorkspaceId !== requestedWorkspaceId) {
          reply({ ok: false });
          return;
        }
        if (socket.data.workspaceId) await socket.leave(roomFor(socket.data.workspaceId));
        socket.data.workspaceId = requestedWorkspaceId;
        await socket.join(roomFor(requestedWorkspaceId));
        reply({ ok: true });
      } catch (error) {
        console.error('Workspace socket authorization failed:', error);
        reply({ ok: false });
      }
    });

    socket.on('workspace:leave', async (workspaceId) => {
      const id = Number(workspaceId);
      if (id === socket.data.requestedWorkspaceId) delete socket.data.requestedWorkspaceId;
      if (id === socket.data.workspaceId) {
        await socket.leave(roomFor(id));
        delete socket.data.workspaceId;
      }
    });
  });

  return io;
}

function emitWorkspaceEvent(workspaceId, event, payload, actorId) {
  if (!io || !workspaceId) return;
  io.to(roomFor(workspaceId)).emit('workspace:event', {
    event,
    workspace_id: Number(workspaceId),
    actor_id: Number(actorId),
    payload,
  });
}

function emitUserEvent(userId, event, payload) {
  if (!io || !userId) return;
  io.to(userRoomFor(userId)).emit('user:notification', { event, payload });
}

async function removeUserFromWorkspace(workspaceId, userId) {
  if (!io || !workspaceId) return;
  const room = io.sockets.adapter.rooms.get(roomFor(workspaceId));
  if (!room) return;
  for (const socketId of room) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket && socket.data.userId === Number(userId)) {
      await socket.leave(roomFor(workspaceId));
      delete socket.data.workspaceId;
    }
  }
}

module.exports = { initializeWorkspaceRealtime, emitWorkspaceEvent, emitUserEvent, removeUserFromWorkspace };
