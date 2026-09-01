const pool = require('../config/db');
const validId = v => Number.isInteger(Number(v)) && Number(v) > 0;
const validTitle = v => typeof v === 'string' && v.trim() && v.trim().length <= 255;
const validDescription = v => v === null || v === undefined || (typeof v === 'string' && v.length <= 10000);
const validCompleted = v => v === true || v === false || v === 0 || v === 1;
const normalPosition = v => v === undefined || v === null ? null : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : NaN;
async function getTask(c, taskId, userId, lock) {
  const [rows] = await c.query(`SELECT t.* FROM tasks t JOIN columns col ON col.id=t.column_id JOIN boards b ON b.id=col.board_id WHERE t.id=? AND b.user_id=?${lock ? ' FOR UPDATE' : ''}`, [taskId,userId]);
  if (!rows.length) return null;
  const [subs] = await c.query('SELECT * FROM subtasks WHERE task_id=? ORDER BY id',[taskId]);
  return {...rows[0], subtasks:subs.map(s => ({...s, is_completed:Boolean(s.is_completed)}))};
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
exports.createTask = async (req,res) => {
  const {title,description,column_id,subtasks}=req.body; const pos=normalPosition(req.body.position);
  if(!validTitle(title)||!validDescription(description)||!validId(column_id)||(Number.isNaN(pos))||(subtasks!==undefined&&!Array.isArray(subtasks)))return res.status(400).json({message:'მონაცემები არასწორია'});
  const c=await pool.getConnection(); try{await c.beginTransaction(); const [col]=await c.query('SELECT col.id FROM columns col JOIN boards b ON b.id=col.board_id WHERE col.id=? AND b.user_id=? FOR UPDATE',[column_id,req.user.id]);if(!col.length){await c.rollback();return res.status(404).json({message:'სვეტი ვერ მოიძებნა ან წვდომა აკრძალულია'});} const [n]=await c.query('SELECT COUNT(*) count FROM tasks WHERE column_id=?',[column_id]); const position=pos===null?Number(n[0].count):Math.min(pos,Number(n[0].count)); await c.query('UPDATE tasks SET position=position+1 WHERE column_id=? AND position>=?',[column_id,position]); const [r]=await c.query('INSERT INTO tasks(title,description,column_id,position) VALUES(?,?,?,?)',[title.trim(),description===undefined?null:description,column_id,position]); await syncSubtasks(c,r.insertId,subtasks||[]); await normalizeColumn(c,column_id); const task=await getTask(c,r.insertId,req.user.id,false); await c.commit();return res.status(201).json({message:'Task created successfully',task});}catch(e){await c.rollback();console.error(e);return res.status(e.status||500).json({message:e.status?e.message:'ამოცანის შექმნა ვერ მოხერხდა'});}finally{c.release();}
};
exports.updateTask = async (req,res) => {
  if(!validId(req.params.id)|| (req.body.title!==undefined&&!validTitle(req.body.title)) || (req.body.description!==undefined&&!validDescription(req.body.description)) || (req.body.column_id!==undefined&&!validId(req.body.column_id)) || (req.body.position!==undefined&&Number.isNaN(normalPosition(req.body.position))) || (req.body.subtasks!==undefined&&!Array.isArray(req.body.subtasks)))return res.status(400).json({message:'მონაცემები არასწორია'});
  const c=await pool.getConnection(); try{await c.beginTransaction();const current=await getTask(c,req.params.id,req.user.id,true);if(!current){await c.rollback();return res.status(404).json({message:'ამოცანა ვერ მოიძებნა ან წვდომა აკრძალულია'});}const target=req.body.column_id===undefined?current.column_id:Number(req.body.column_id);const [col]=await c.query('SELECT col.id FROM columns col JOIN boards b ON b.id=col.board_id WHERE col.id=? AND b.user_id=?',[target,req.user.id]);if(!col.length){await c.rollback();return res.status(404).json({message:'სვეტი ვერ მოიძებნა ან წვდომა აკრძალულია'});}const p=normalPosition(req.body.position);if(target!==current.column_id||p!==null){await c.query('UPDATE tasks SET position=position-1 WHERE column_id=? AND position>?',[current.column_id,current.position]);const [n]=await c.query('SELECT COUNT(*) count FROM tasks WHERE column_id=? AND id<>?',[target,current.id]);const position=Math.min(p===null?Number(n[0].count):p,Number(n[0].count));await c.query('UPDATE tasks SET position=position+1 WHERE column_id=? AND position>=? AND id<>?',[target,position,current.id]);await c.query('UPDATE tasks SET column_id=?,position=? WHERE id=?',[target,position,current.id]);}await c.query('UPDATE tasks SET title=COALESCE(?,title),description=? WHERE id=?',[req.body.title===undefined?null:req.body.title.trim(),req.body.description===undefined?current.description:req.body.description,current.id]);await syncSubtasks(c,current.id,req.body.subtasks);  await normalizeColumn(c, current.column_id);
  if (target !== current.column_id) await normalizeColumn(c, target);
  const result=await getTask(c,current.id,req.user.id,false);await c.commit();return res.json({message:'Task updated successfully',task:result});}catch(e){await c.rollback();console.error(e);return res.status(e.status||500).json({message:e.status?e.message:'ამოცანის განახლება ვერ მოხერხდა'});}finally{c.release();}
};
exports.toggleSubtask=async(req,res)=>{if(!validId(req.params.id)||!validCompleted(req.body.is_completed))return res.status(400).json({message:'მონაცემები არასწორია'});try{const [r]=await pool.query('UPDATE subtasks s JOIN tasks t ON t.id=s.task_id JOIN columns col ON col.id=t.column_id JOIN boards b ON b.id=col.board_id SET s.is_completed=? WHERE s.id=? AND b.user_id=?',[req.body.is_completed===true||req.body.is_completed===1?1:0,req.params.id,req.user.id]);if(!r.affectedRows)return res.status(404).json({message:'სუბთასქი ვერ მოიძებნა ან წვდომა აკრძალულია'});const [rows]=await pool.query('SELECT id,task_id,title,is_completed FROM subtasks WHERE id=?',[req.params.id]);const subtask={...rows[0],is_completed:Boolean(rows[0].is_completed)};return res.json({message:'Subtask updated successfully',subtask});}catch(e){console.error(e);return res.status(500).json({message:'სტატუსის შეცვლა ვერ მოხერხდა'});}};
exports.deleteTask=async(req,res)=>{if(!validId(req.params.id))return res.status(400).json({message:'არასწორი ID'});const c=await pool.getConnection();try{await c.beginTransaction();const task=await getTask(c,req.params.id,req.user.id,true);if(!task){await c.rollback();return res.status(404).json({message:'ამოცანა ვერ მოიძებნა ან წვდომა აკრძალულია'});}await c.query('DELETE FROM tasks WHERE id=?',[req.params.id]);await normalizeColumn(c, task.column_id);await c.commit();return res.json({message:'ამოცანა წაიშალა'});}catch(e){await c.rollback();console.error(e);return res.status(500).json({message:'ამოცანის წაშლა ვერ მოხერხდა'});}finally{c.release();}};
