const pool = require('../config/db');
const { emitWorkspaceEvent } = require('../realtime/workspaceRealtime');
const id = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
const title = (v) => typeof v === 'string' && v.trim() && v.trim().length <= 255;
async function board(connection, boardId, userId) {
  const [b] = await connection.query(
    `SELECT b.* FROM boards b
     WHERE b.id=? AND ((b.workspace_id IS NULL AND b.user_id=?) OR EXISTS
       (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=b.workspace_id AND wm.user_id=?))`,
    [boardId, userId, userId],
  );
  if (!b.length) return null;
  const [cols] = await connection.query('SELECT * FROM columns WHERE board_id=? ORDER BY position,id', [boardId]);
  const [tasks] = await connection.query('SELECT t.* FROM tasks t JOIN columns c ON c.id=t.column_id WHERE c.board_id=? ORDER BY t.position,t.id', [boardId]);
  const [subs] = await connection.query('SELECT s.* FROM subtasks s JOIN tasks t ON t.id=s.task_id JOIN columns c ON c.id=t.column_id WHERE c.board_id=? ORDER BY s.id', [boardId]);
  const [assignees] = await connection.query(
    'SELECT ta.task_id, ta.user_id FROM task_assignees ta JOIN tasks t ON t.id=ta.task_id JOIN columns c ON c.id=t.column_id WHERE c.board_id=?',
    [boardId],
  );
  return {
    ...b[0],
    columns: cols.map((column) => ({
      ...column,
      tasks: tasks.filter((task) => task.column_id === column.id).map((task) => ({
        ...task,
        subtasks: subs.filter((subtask) => subtask.task_id === task.id).map((subtask) => ({
          ...subtask,
          is_completed: Boolean(subtask.is_completed),
        })),
        assignee_ids: assignees.filter((assignee) => assignee.task_id === task.id).map((assignee) => Number(assignee.user_id)),
      })),
    })),
  };
}
exports.getBoards = async (req, res) => { try { const [rows] = await pool.query(`SELECT DISTINCT b.* FROM boards b LEFT JOIN workspace_members wm ON wm.workspace_id=b.workspace_id AND wm.user_id=? WHERE (b.workspace_id IS NULL AND b.user_id=?) OR wm.user_id=? ORDER BY b.created_at DESC`, [req.user.id, req.user.id, req.user.id]); return res.json(rows); } catch (e) { console.error(e); return res.status(500).json({ message: 'დაფების წამოღება ვერ მოხერხდა' }); } };
exports.getBoardById = async (req, res) => { if (!id(req.params.id)) return res.status(400).json({ message: 'არასწორი დაფის ID' }); try { const b = await board(pool, req.params.id, req.user.id); return b ? res.json(b) : res.status(404).json({ message: 'დაფა ვერ მოიძებნა ან წვდომა აკრძალულია' }); } catch (e) { console.error(e); return res.status(500).json({ message: 'დაფის სტრუქტურის წამოღება ვერ მოხერხდა' }); } };
exports.createBoard = async (req, res) => {
  if (!title(req.body.title) || (req.body.columns !== undefined && !Array.isArray(req.body.columns))) return res.status(400).json({ message: 'სწორი title და columns აუცილებელია' });
  const cols = req.body.columns || []; if (cols.some(c => !title(typeof c === 'string' ? c : c && c.title))) return res.status(400).json({ message: 'სვეტის სათაური არასწორია' });
  const c = await pool.getConnection(); try { await c.beginTransaction();
    let workspaceId = null;
    if (req.body.workspace_id !== undefined) {
      if (!id(req.body.workspace_id)) { await c.rollback(); return res.status(400).json({ message: 'workspace_id არასწორია' }); }
      const [member] = await c.query(
        `SELECT wm.role, w.type FROM workspace_members wm
         JOIN workspaces w ON w.id=wm.workspace_id
         WHERE wm.workspace_id=? AND wm.user_id=?`,
        [req.body.workspace_id, req.user.id],
      );
      if (!member.length) { await c.rollback(); return res.status(403).json({ message: 'Workspace-ში გაწევრიანება აუცილებელია' }); }
      if (member[0].type !== 'PERSONAL' && member[0].role !== 'OWNER' && member[0].role !== 'ADMIN') {
        await c.rollback();
        return res.status(403).json({ message: 'Workspace-ის დაფების მართვა აკრძალულია' });
      }
      workspaceId = Number(req.body.workspace_id);
    }
    const [r] = await c.query('INSERT INTO boards (user_id,workspace_id,title) VALUES (?,?,?)', [req.user.id, workspaceId, req.body.title.trim()]);
    for (let i=0;i<cols.length;i++) await c.query('INSERT INTO columns (board_id,title,position) VALUES (?,?,?)', [r.insertId, (typeof cols[i] === 'string' ? cols[i] : cols[i].title).trim(), i]);
    const result = await board(c, r.insertId, req.user.id);
    await c.commit();
    emitWorkspaceEvent(result.workspace_id, 'board.created', result, req.user.id);
    return res.status(201).json(result);
  } catch(e) { await c.rollback(); console.error(e); return res.status(500).json({ message: 'დაფის შექმნა ვერ მოხერხდა' }); } finally { c.release(); }
};
exports.addColumn = async (req, res) => {
  if (!id(req.params.boardId) || !title(req.body.title)) return res.status(400).json({ message: 'სწორი boardId და title აუცილებელია' });
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [boards] = await c.query(
      `SELECT b.id, b.workspace_id, wm.role, w.type FROM boards b
       LEFT JOIN workspace_members wm ON wm.workspace_id=b.workspace_id AND wm.user_id=?
       LEFT JOIN workspaces w ON w.id=b.workspace_id
       WHERE b.id=? AND ((b.workspace_id IS NULL AND b.user_id=?) OR wm.user_id=?) FOR UPDATE`,
      [req.user.id, req.params.boardId, req.user.id, req.user.id],
    );
    if (!boards.length) {
      await c.rollback();
      return res.status(404).json({ message: 'დაფა ვერ მოიძებნა ან წვდომა აკრძალულია' });
    }
    if (boards[0].workspace_id && boards[0].type !== 'PERSONAL'
      && boards[0].role !== 'OWNER' && boards[0].role !== 'ADMIN') {
      await c.rollback();
      return res.status(403).json({ message: 'Workspace-ის სვეტების მართვა აკრძალულია' });
    }
    const [nextPosition] = await c.query('SELECT COALESCE(MAX(position)+1,0) position FROM columns WHERE board_id=?', [req.params.boardId]);
    const [result] = await c.query('INSERT INTO columns (board_id,title,position) VALUES (?,?,?)', [req.params.boardId, req.body.title.trim(), nextPosition[0].position]);
    const column = {
      id: result.insertId,
      board_id: Number(req.params.boardId),
      title: req.body.title.trim(),
      position: nextPosition[0].position,
      tasks: [],
    };
    await c.commit();
    emitWorkspaceEvent(boards[0].workspace_id, 'column.created', column, req.user.id);
    return res.status(201).json(column);
  } catch (error) {
    await c.rollback();
    console.error(error);
    return res.status(500).json({ message: 'სვეტის დამატება ვერ მოხერხდა' });
  } finally {
    c.release();
  }
};
exports.updateBoard = async (req, res) => {
  if (!id(req.params.id) || (req.body.title !== undefined && !title(req.body.title)) || (req.body.columns !== undefined && !Array.isArray(req.body.columns))) return res.status(400).json({message:'მონაცემები არასწორია'});
  const c=await pool.getConnection(); try { await c.beginTransaction(); const [b]=await c.query(`SELECT b.id, b.workspace_id, wm.role, w.type FROM boards b LEFT JOIN workspace_members wm ON wm.workspace_id=b.workspace_id AND wm.user_id=? LEFT JOIN workspaces w ON w.id=b.workspace_id WHERE b.id=? AND ((b.workspace_id IS NULL AND b.user_id=?) OR wm.user_id=?) FOR UPDATE`,[req.user.id,req.params.id,req.user.id,req.user.id]);   if(!b.length){await c.rollback();return res.status(404).json({message:'დაფა ვერ მოიძებნა ან წვდომა აკრძალულია'});} if(b[0].workspace_id && b[0].type !== 'PERSONAL' && b[0].role !== 'OWNER' && b[0].role !== 'ADMIN'){await c.rollback();return res.status(403).json({message:'Workspace-ის დაფების მართვა აკრძალულია'});} if(req.body.title!==undefined) await c.query('UPDATE boards SET title=? WHERE id=?',[req.body.title.trim(),req.params.id]);
    if(req.body.columns!==undefined){const [existing]=await c.query('SELECT id FROM columns WHERE board_id=?',[req.params.id]); const incoming=req.body.columns; if(incoming.some(x=>!title(x&&x.title))||incoming.some(x=>x.id!==undefined&&!id(x.id))){await c.rollback();return res.status(400).json({message:'სვეტები არასწორია'});} const keep=incoming.filter(x=>x.id).map(x=>Number(x.id)); if(keep.length!==new Set(keep).size){await c.rollback();return res.status(400).json({message:'დუბლირებული სვეტი'});} for(const x of existing) if(!keep.includes(x.id)) await c.query('DELETE FROM columns WHERE id=? AND board_id=?',[x.id,req.params.id]); for(let i=0;i<incoming.length;i++){const x=incoming[i]; if(x.id){const [ok]=await c.query('SELECT id FROM columns WHERE id=? AND board_id=?',[x.id,req.params.id]); if(!ok.length){await c.rollback();return res.status(400).json({message:'სვეტი ამ დაფას არ ეკუთვნის'});} await c.query('UPDATE columns SET title=?,position=? WHERE id=?',[x.title.trim(),i,x.id]);}else await c.query('INSERT INTO columns (board_id,title,position) VALUES (?,?,?)',[req.params.id,x.title.trim(),i]);}}
    const result=await board(c,req.params.id,req.user.id); await c.commit();
    emitWorkspaceEvent(b[0].workspace_id, 'board.updated', result, req.user.id);
    return res.json(result);
  }catch(e){await c.rollback();console.error(e);return res.status(500).json({message:'დაფის განახლება ვერ მოხერხდა'});}finally{c.release();}
};
exports.deleteBoard = async (req,res) => {
  if (!id(req.params.id)) return res.status(400).json({ message: 'არასწორი ID' });
  try {
    const [boards] = await pool.query(
      `SELECT b.workspace_id, w.type, wm.role FROM boards b
       LEFT JOIN workspaces w ON w.id=b.workspace_id
       LEFT JOIN workspace_members wm ON wm.workspace_id=b.workspace_id AND wm.user_id=?
       WHERE b.id=?
       AND ((b.workspace_id IS NULL AND b.user_id=?) OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=b.workspace_id AND wm.user_id=?))`,
      [req.user.id, req.params.id, req.user.id, req.user.id],
    );
    if (!boards.length) return res.status(404).json({ message: 'დაფა ვერ მოიძებნა ან წვდომა აკრძალულია' });
    if (boards[0].workspace_id && boards[0].type !== 'PERSONAL'
      && boards[0].role !== 'OWNER' && boards[0].role !== 'ADMIN') {
      return res.status(403).json({ message: 'Workspace-ის დაფების მართვა აკრძალულია' });
    }
    const [result] = await pool.query(
      `DELETE b FROM boards b WHERE b.id=?
       AND ((b.workspace_id IS NULL AND b.user_id=?) OR EXISTS (
         SELECT 1 FROM workspace_members wm JOIN workspaces w ON w.id=wm.workspace_id
         WHERE wm.workspace_id=b.workspace_id AND wm.user_id=?
           AND (w.type='PERSONAL' OR wm.role IN ('OWNER','ADMIN'))
       ))`,
      [req.params.id, req.user.id, req.user.id],
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'დაფა ვერ მოიძებნა ან წვდომა აკრძალულია' });
    emitWorkspaceEvent(boards[0].workspace_id, 'board.deleted', { board_id: Number(req.params.id) }, req.user.id);
    return res.json({ message: 'დაფა წარმატებით წაიშალა' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'დაფის წაშლა ვერ მოხერხდა' });
  }
};
