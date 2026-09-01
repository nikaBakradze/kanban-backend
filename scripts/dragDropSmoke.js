const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const port = 5099;
const baseUrl = `http://127.0.0.1:${port}`;
const suffix = `${Date.now()}_${process.pid}`;
let server;
let pool;
let userId;
const createdUserIds = [];

async function request(path, token, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

async function boardState(boardId) {
  const [rows] = await pool.query(
    `SELECT c.id AS column_id, t.id AS task_id, t.position
     FROM columns c LEFT JOIN tasks t ON t.column_id=c.id
     WHERE c.board_id=? ORDER BY c.id, t.position, t.id`,
    [boardId],
  );
  return rows.reduce((result, row) => {
    if (!result[row.column_id]) result[row.column_id] = [];
    if (row.task_id !== null) result[row.column_id].push({ id: row.task_id, position: row.position });
    return result;
  }, {});
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_) {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Smoke-test server did not start');
}

async function run() {
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
  });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [user] = await connection.query(
      'INSERT INTO users (full_name,email,password_hash) VALUES (?,?,?)',
      [`Drag Drop Smoke ${suffix}`, `drag-drop-smoke-${suffix}@example.test`, 'not-a-login-password'],
    );
    userId = user.insertId;
    createdUserIds.push(userId);
    const [board] = await connection.query('INSERT INTO boards (user_id,title) VALUES (?,?)', [userId, `Drag Drop Smoke ${suffix}`]);
    const [source] = await connection.query('INSERT INTO columns (board_id,title,position) VALUES (?,?,?)', [board.insertId, 'Source', 0]);
    const [target] = await connection.query('INSERT INTO columns (board_id,title,position) VALUES (?,?,?)', [board.insertId, 'Target', 1]);
    const taskIds = {};
    for (const [name, columnId, position] of [
      ['A', source.insertId, 0], ['B', source.insertId, 1], ['C', source.insertId, 2],
      ['D', target.insertId, 0], ['E', target.insertId, 1],
    ]) {
      const [task] = await connection.query(
        'INSERT INTO tasks (column_id,title,position) VALUES (?,?,?)',
        [columnId, name, position],
      );
      taskIds[name] = task.insertId;
    }
    await connection.commit();

    server = spawn(process.execPath, ['server.js'], {
      cwd: __dirname + '/..',
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer();
    const token = jwt.sign({ id: userId, email: `drag-drop-smoke-${suffix}@example.test` }, process.env.JWT_SECRET);

    const move = async (task, columnId, position) => {
      const { response, data } = await request(`/api/tasks/${taskIds[task]}`, token, { column_id: columnId, position });
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.task.id, taskIds[task]);
      return data.task;
    };
    const assertColumn = async (columnId, expectedIds) => {
      const state = await boardState(board.insertId);
      assert.deepEqual(state[columnId].map((task) => task.id), expectedIds);
      assert.deepEqual(state[columnId].map((task) => task.position), expectedIds.map((_, index) => index));
    };

    await move('A', source.insertId, 2);
    await assertColumn(source.insertId, [taskIds.B, taskIds.C, taskIds.A]);
    await move('A', source.insertId, 0);
    await assertColumn(source.insertId, [taskIds.A, taskIds.B, taskIds.C]);
    await move('B', target.insertId, 1);
    await assertColumn(source.insertId, [taskIds.A, taskIds.C]);
    await assertColumn(target.insertId, [taskIds.D, taskIds.B, taskIds.E]);
    await move('C', target.insertId, 0);
    await assertColumn(source.insertId, [taskIds.A]);
    await assertColumn(target.insertId, [taskIds.C, taskIds.D, taskIds.B, taskIds.E]);
    await move('A', target.insertId, 4);
    await assertColumn(source.insertId, []);
    await assertColumn(target.insertId, [taskIds.C, taskIds.D, taskIds.B, taskIds.E, taskIds.A]);

    const [otherUser] = await pool.query(
      'INSERT INTO users (full_name,email,password_hash) VALUES (?,?,?)',
      [`Other Smoke ${suffix}`, `other-drag-drop-smoke-${suffix}@example.test`, 'not-a-login-password'],
    );
    createdUserIds.push(otherUser.insertId);
    const otherToken = jwt.sign({ id: otherUser.insertId, email: `other-drag-drop-smoke-${suffix}@example.test` }, process.env.JWT_SECRET);
    const denied = await request(`/api/tasks/${taskIds.A}`, otherToken, { column_id: target.insertId, position: 0 });
    assert.equal(denied.response.status, 404);
    const crossUserTarget = await pool.query('INSERT INTO boards (user_id,title) VALUES (?,?)', [otherUser.insertId, `Other Board ${suffix}`]);
    const [otherColumn] = await pool.query('INSERT INTO columns (board_id,title,position) VALUES (?,?,?)', [crossUserTarget[0].insertId, 'Other', 0]);
    const deniedColumn = await request(`/api/tasks/${taskIds.A}`, token, { column_id: otherColumn.insertId, position: 0 });
    assert.equal(deniedColumn.response.status, 404);
    console.log('Drag/drop smoke test passed: same-column reorder, cross-column first/middle/last, and ownership.');
  } finally {
    if (connection) connection.release();
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) server.kill();
    if (pool) for (const createdId of createdUserIds) await pool.query('DELETE FROM users WHERE id=?', [createdId]);
    if (pool) await pool.end();
  });
