const pool = require('../config/db');
const { emitWorkspaceEvent } = require('../realtime/workspaceRealtime');
const validId = v => Number.isInteger(Number(v)) && Number(v) > 0;
const validTitle = v => typeof v === 'string' && v.trim() && v.trim().length <= 255;
const validDescription = v => v === null || v === undefined || (typeof v === 'string' && v.length <= 10000);
const validCompleted = v => v === true || v === false || v === 0 || v === 1;
const normalPosition = v => v === undefined || v === null ? null : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : NaN;
async function getTask(c, taskId, userId, lock) {
  const [rows] = await c.query(`SELECT t.* FROM tasks t JOIN columns col ON col.id=t.column_id JOIN boards b ON b.id=col.board_id WHERE t.id=? AND ((b.workspace_id IS NULL AND b.user_id=?) OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=b.workspace_id AND wm.user_id=?))${lock ? ' FOR UPDATE' : ''}`, [taskId,userId,userId]);
  if (!rows.length) return null;
  const [subs] = await c.query('SELECT * FROM subtasks WHERE task_id=? ORDER BY id',[taskId]);
  const [assignees] = await c.query('SELECT user_id FROM task_assignees WHERE task_id=?', [taskId]);
  return {
    ...rows[0],
    subtasks: subs.map((subtask) => ({ ...subtask, is_completed: Boolean(subtask.is_completed) })),
    assignee_ids: assignees.map((assignee) => Number(assignee.user_id)),
  };
}
async function taskBoardInfo(connection, task) {
  const [rows] = await connection.query(
    'SELECT b.id AS board_id, b.workspace_id FROM columns c JOIN boards b ON b.id=c.board_id WHERE c.id=?',
    [task.column_id],
  );
  return rows[0];
}
function emitTask(workspaceId, event, boardId, task, actorId) {
  emitWorkspaceEvent(workspaceId, event, { board_id: Number(boardId), task }, actorId);
}
async function syncSubtasks(c, taskId, items) {
  if (!Array.isArray(items)) return;
  const [existing] = await c.query('SELECT id FROM subtasks WHERE task_id=?',[taskId]); const ids=existing.map(x=>x.id); const seen=[];
  for (const item of items) {
    if (!item || typeof item !== 'object' || !validTitle(item.title) || (item.is_completed !== undefined && !validCompleted(item.is_completed))) throw Object.assign(new Error('Invalid subtask'),{status:400});
    const sid=item.id === undefined ? null : Number(item.id); if (sid !== null && (!ids.includes(sid)||seen.includes(sid))) throw Object.assign(new Error('Invalid subtask ownership'),{status:400});
    const completed = item.is_completed === true || item.is_completed === 1;
    if (sid) { seen.push(sid); await c.query('UPDATE subtasks SET title=?,is_completed=? WHERE id=? AND task_id=?',[item.title.trim(),completed?1:0,sid,taskId]); }
    else await c.query('INSERT INTO subtasks (task_id,title,is_completed) VALUES (?,?,?)',[taskId,item.title.trim(),completed?1:0]);
  }
  for (const old of ids) if (!seen.includes(old)) await c.query('DELETE FROM subtasks WHERE id=? AND task_id=?',[old,taskId]);
}
async function normalizeColumn(c, columnId) {
  const [rows] = await c.query('SELECT id FROM tasks WHERE column_id=? ORDER BY position,id', [columnId]);
  for (let i = 0; i < rows.length; i++) {
    await c.query('UPDATE tasks SET position=? WHERE id=?', [i, rows[i].id]);
  }
}
exports.createTask = async (req, res) => {
  const { title, description, column_id, subtasks } = req.body;
  const pos = normalPosition(req.body.position);
  if (!validTitle(title) || !validDescription(description) || !validId(column_id) || Number.isNaN(pos) || (subtasks !== undefined && !Array.isArray(subtasks))) {
    return res.status(400).json({ message: 'მონაცემები არასწორია' });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [columns] = await connection.query(
      `SELECT col.id, b.id AS board_id, b.workspace_id FROM columns col
       JOIN boards b ON b.id=col.board_id
       WHERE col.id=? AND ((b.workspace_id IS NULL AND b.user_id=?) OR EXISTS
         (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=b.workspace_id AND wm.user_id=?)) FOR UPDATE`,
      [column_id, req.user.id, req.user.id],
    );
    if (!columns.length) {
      await connection.rollback();
      return res.status(404).json({ message: 'სვეტი ვერ მოიძებნა ან წვდომა აკრძალულია' });
    }
    const [count] = await connection.query('SELECT COUNT(*) count FROM tasks WHERE column_id=?', [column_id]);
    const position = pos === null ? Number(count[0].count) : Math.min(pos, Number(count[0].count));
    await connection.query('UPDATE tasks SET position=position+1 WHERE column_id=? AND position>=?', [column_id, position]);
    const [result] = await connection.query(
      'INSERT INTO tasks(title,description,column_id,position) VALUES(?,?,?,?)',
      [title.trim(), description === undefined ? null : description, column_id, position],
    );
    await syncSubtasks(connection, result.insertId, subtasks || []);
    await normalizeColumn(connection, column_id);
    const task = await getTask(connection, result.insertId, req.user.id, false);
    await connection.commit();
    emitTask(columns[0].workspace_id, 'task.created', columns[0].board_id, task, req.user.id);
    return res.status(201).json({ message: 'Task created successfully', task });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    return res.status(error.status || 500).json({ message: error.status ? error.message : 'ამოცანის შექმნა ვერ მოხერხდა' });
  } finally {
    connection.release();
  }
};
exports.updateTask = async (req,res) => {
  if (
    !validId(req.params.id) ||
    (req.body.title !== undefined && !validTitle(req.body.title)) ||
    (req.body.description !== undefined && !validDescription(req.body.description)) ||
    (req.body.column_id !== undefined && !validId(req.body.column_id)) ||
    (req.body.position !== undefined && Number.isNaN(normalPosition(req.body.position))) ||
    (req.body.subtasks !== undefined && !Array.isArray(req.body.subtasks))
  ) return res.status(400).json({message:'მონაცემები არასწორია'});

  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const current = await getTask(c, req.params.id, req.user.id, true);
    if (!current) {
      await c.rollback();
      return res.status(404).json({message:'ამოცანა ვერ მოიძებნა ან წვდომა აკრძალულია'});
    }
    const previousLocation = await taskBoardInfo(c, current);

    const target = req.body.column_id === undefined ? current.column_id : Number(req.body.column_id);
    const columnIds = [...new Set([current.column_id, target])].sort((a, b) => a - b);
    const placeholders = columnIds.map(() => '?').join(',');
    const [columns] = await c.query(
      `SELECT col.id FROM columns col JOIN boards b ON b.id=col.board_id
       WHERE col.id IN (${placeholders}) AND ((b.workspace_id IS NULL AND b.user_id=?) OR EXISTS
       (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=b.workspace_id AND wm.user_id=?))
       ORDER BY col.id FOR UPDATE`,
      [...columnIds, req.user.id, req.user.id],
    );
    if (columns.length !== columnIds.length) {
      await c.rollback();
      return res.status(404).json({message:'სვეტი ვერ მოიძებნა ან წვდომა აკრძალულია'});
    }

    const p = normalPosition(req.body.position);
    if (target !== current.column_id || p !== null) {
      if (target === current.column_id) {
        const [siblings] = await c.query(
          'SELECT id FROM tasks WHERE column_id=? AND id<>? ORDER BY position,id',
          [current.column_id, current.id],
        );
        const position = Math.min(p === null ? siblings.length : p, siblings.length);
        if (position !== current.position) {
          await c.query(
            'UPDATE tasks SET position=position-1 WHERE column_id=? AND position>?',
            [current.column_id, current.position],
          );
          await c.query(
            'UPDATE tasks SET position=position+1 WHERE column_id=? AND position>=? AND id<>?',
            [target, position, current.id],
          );
          await c.query('UPDATE tasks SET position=? WHERE id=?', [position, current.id]);
        }
      } else {
        await c.query(
          'UPDATE tasks SET position=position-1 WHERE column_id=? AND position>?',
          [current.column_id, current.position],
        );
        const [siblings] = await c.query(
          'SELECT id FROM tasks WHERE column_id=? ORDER BY position,id',
          [target],
        );
        const position = Math.min(p === null ? siblings.length : p, siblings.length);
        await c.query(
          'UPDATE tasks SET position=position+1 WHERE column_id=? AND position>=?',
          [target, position],
        );
        await c.query('UPDATE tasks SET column_id=?,position=? WHERE id=?', [target, position, current.id]);
      }
    }

    await c.query(
      'UPDATE tasks SET title=COALESCE(?,title),description=? WHERE id=?',
      [req.body.title === undefined ? null : req.body.title.trim(), req.body.description === undefined ? current.description : req.body.description, current.id],
    );
    await syncSubtasks(c, current.id, req.body.subtasks);
    await normalizeColumn(c, current.column_id);
    if (target !== current.column_id) await normalizeColumn(c, target);
    const result = await getTask(c, current.id, req.user.id, false);
    const location = await taskBoardInfo(c, result);
    await c.commit();
    if (previousLocation.board_id !== location.board_id) {
      emitWorkspaceEvent(previousLocation.workspace_id, 'task.deleted', {
        board_id: Number(previousLocation.board_id),
        task_id: Number(result.id),
      }, req.user.id);
      emitTask(location.workspace_id, 'task.created', location.board_id, result, req.user.id);
    } else {
      emitTask(location.workspace_id, 'task.updated', location.board_id, result, req.user.id);
    }
    return res.json({message:'Task updated successfully',task:result});
  } catch (e) {
    await c.rollback();
    console.error(e);
    return res.status(e.status || 500).json({message:e.status ? e.message : 'ამოცანის განახლება ვერ მოხერხდა'});
  } finally {
    c.release();
  }
};
exports.toggleSubtask = async (req, res) => {
  if (!validId(req.params.id) || !validCompleted(req.body.is_completed)) return res.status(400).json({ message: 'მონაცემები არასწორია' });
  try {
    const [updated] = await pool.query(
      `UPDATE subtasks s JOIN tasks t ON t.id=s.task_id JOIN columns col ON col.id=t.column_id JOIN boards b ON b.id=col.board_id
       SET s.is_completed=? WHERE s.id=? AND ((b.workspace_id IS NULL AND b.user_id=?) OR EXISTS
         (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=b.workspace_id AND wm.user_id=?))`,
      [req.body.is_completed === true || req.body.is_completed === 1 ? 1 : 0, req.params.id, req.user.id, req.user.id],
    );
    if (!updated.affectedRows) return res.status(404).json({ message: 'სუბთასქი ვერ მოიძებნა ან წვდომა აკრძალულია' });
    const [rows] = await pool.query(
      `SELECT s.id,s.task_id,s.title,s.is_completed,t.column_id,b.id AS board_id,b.workspace_id
       FROM subtasks s JOIN tasks t ON t.id=s.task_id JOIN columns c ON c.id=t.column_id JOIN boards b ON b.id=c.board_id
       WHERE s.id=?`,
      [req.params.id],
    );
    const subtask = { id: rows[0].id, task_id: rows[0].task_id, title: rows[0].title, is_completed: Boolean(rows[0].is_completed) };
    emitWorkspaceEvent(rows[0].workspace_id, 'subtask.updated', {
      board_id: Number(rows[0].board_id),
      task_id: Number(rows[0].task_id),
      subtask,
    }, req.user.id);
    return res.json({ message: 'Subtask updated successfully', subtask });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'სტატუსის შეცვლა ვერ მოხერხდა' });
  }
};
exports.deleteTask = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: 'არასწორი ID' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const task = await getTask(connection, req.params.id, req.user.id, true);
    if (!task) {
      await connection.rollback();
      return res.status(404).json({ message: 'ამოცანა ვერ მოიძებნა ან წვდომა აკრძალულია' });
    }
    const location = await taskBoardInfo(connection, task);
    if (location.workspace_id) {
      const [membership] = await connection.query(
        `SELECT wm.role, w.type FROM workspace_members wm
         JOIN workspaces w ON w.id=wm.workspace_id
         WHERE wm.workspace_id=? AND wm.user_id=?`,
        [location.workspace_id, req.user.id],
      );
      if (membership.length && membership[0].type !== 'PERSONAL'
        && membership[0].role !== 'OWNER' && membership[0].role !== 'ADMIN') {
        await connection.rollback();
        return res.status(403).json({ message: 'Workspace-ის ამოცანის წაშლა აკრძალულია' });
      }
    }
    await connection.query('DELETE FROM tasks WHERE id=?', [req.params.id]);
    await normalizeColumn(connection, task.column_id);
    await connection.commit();
    emitWorkspaceEvent(location.workspace_id, 'task.deleted', {
      board_id: Number(location.board_id),
      task_id: Number(req.params.id),
    }, req.user.id);
    return res.json({ message: 'ამოცანა წაიშალა' });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    return res.status(500).json({ message: 'ამოცანის წაშლა ვერ მოხერხდა' });
  } finally {
    connection.release();
  }
};
exports.assignTask = async (req, res) => {
  if (!validId(req.params.id) || !Array.isArray(req.body.user_ids)) return res.status(400).json({ message: 'სწორი task ID და user_ids აუცილებელია' });
  const ids = req.body.user_ids.map(Number);
  if (ids.some((value) => !Number.isInteger(value) || value <= 0) || ids.length !== new Set(ids).size) return res.status(400).json({ message: 'user_ids არასწორია' });
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [taskRows] = await c.query(
      `SELECT t.id, b.workspace_id FROM tasks t
       JOIN columns col ON col.id=t.column_id JOIN boards b ON b.id=col.board_id
       JOIN workspace_members manager ON manager.workspace_id=b.workspace_id AND manager.user_id=? AND manager.role IN ('OWNER','ADMIN')
       WHERE t.id=? FOR UPDATE`,
      [req.user.id, req.params.id],
    );
    if (!taskRows.length || !taskRows[0].workspace_id) { await c.rollback(); return res.status(403).json({ message: 'Task assignment is available only in workspaces for owners/admins' }); }
    if (ids.length) {
      const [members] = await c.query(
        `SELECT user_id FROM workspace_members WHERE workspace_id=? AND user_id IN (${ids.map(() => '?').join(',')})`,
        [taskRows[0].workspace_id, ...ids],
      );
      if (members.length !== ids.length) { await c.rollback(); return res.status(400).json({ message: 'ყველა assignee workspace-ის წევრი უნდა იყოს' }); }
    }
    await c.query('DELETE FROM task_assignees WHERE task_id=?', [req.params.id]);
    for (const userId of ids) await c.query('INSERT INTO task_assignees (task_id,user_id) VALUES (?,?)', [req.params.id, userId]);
    const task = await getTask(c, req.params.id, req.user.id, false);
    const location = await taskBoardInfo(c, task);
    await c.commit();
    emitTask(location.workspace_id, 'task.assignees.updated', location.board_id, task, req.user.id);
    return res.json({ task_id: Number(req.params.id), user_ids: ids });
  } catch (e) { await c.rollback(); console.error(e); return res.status(500).json({ message: 'Task assignee-ების განახლება ვერ მოხერხდა' }); }
  finally { c.release(); }
};
