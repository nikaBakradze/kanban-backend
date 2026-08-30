const pool = require('../config/db');

// ახალი ამოცანის შექმნა (სუბთასქებთან ერთად)
exports.createTask = async (req, res) => {
  const { title, description, column_id, subtasks } = req.body;

  try {
    const [countResult] = await pool.query(
      'SELECT COUNT(*) as count FROM tasks WHERE column_id = ?',
      [column_id]
    );
    const position = countResult[0].count;

    const [taskResult] = await pool.query(
      'INSERT INTO tasks (title, description, column_id, position) VALUES (?, ?, ?, ?)',
      [title, description || null, column_id, position]
    );
    const taskId = taskResult.insertId;

    if (subtasks && Array.isArray(subtasks) && subtasks.length > 0) {
      for (const st of subtasks) {
        const subtaskTitle = typeof st === 'object' ? st.title : st;
        const isComp = typeof st === 'object' && (st.is_completed === 1 || st.is_completed === true) ? 1 : 0;
        
        if (subtaskTitle) {
          await pool.query(
            'INSERT INTO subtasks (title, task_id, is_completed) VALUES (?, ?, ?)',
            [subtaskTitle, taskId, isComp]
          );
        }
      }
    }

    res.status(201).json({ message: 'ამოცანა წარმატებით შეიქმნა', taskId });
  } catch (error) {
    res.status(500).json({ message: 'ამოცანის შექმნა ვერ მოხერხდა', error: error.message });
  }
};

// ამოცანის განახლება (სვეტის, ტექსტის, პოზიციის და სუბთასქების)
exports.updateTask = async (req, res) => {
  const taskId = Number(req.params.id);
  const { title, description, column_id, position, subtasks } = req.body;

  try {
    // 1. შევამოწმოთ არსებობს თუ არა თასქი
    const [existingTasks] = await pool.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
    
    if (existingTasks.length === 0) {
      return res.status(404).json({ message: 'ამოცანა ვერ მოიძებნა' });
    }

    const currentTask = existingTasks[0];

    const updatedTitle = title !== undefined ? title : currentTask.title;
    const updatedDescription = description !== undefined ? description : currentTask.description;
    const updatedColumnId = column_id !== undefined ? Number(column_id) : currentTask.column_id;
    const updatedPosition = position !== undefined && position !== null ? Number(position) : currentTask.position;

    // 2. განვაახლოთ მთავარი თასქი
    await pool.query(
      'UPDATE tasks SET title = ?, description = ?, column_id = ?, position = ? WHERE id = ?',
      [updatedTitle, updatedDescription, updatedColumnId, updatedPosition, taskId]
    );

    // 3. სუბთასქების უსაფრთხო განახლება (try/catch-ით, რომ სერვერი არ გაითიშოს)
    if (subtasks && Array.isArray(subtasks)) {
      for (const st of subtasks) {
        const subtaskId = Number(st.id || st._id);
        const isComp = (st.is_completed === 1 || st.is_completed === true) ? 1 : 0;

        if (subtaskId && !isNaN(subtaskId)) {
          try {
            await pool.query(
              'UPDATE subtasks SET is_completed = ? WHERE id = ?',
              [isComp, subtaskId]
            );
          } catch (stErr) {
            console.error(`Subtask update error for ID ${subtaskId}:`, stErr.message);
          }
        } else if (st.title) {
          try {
            await pool.query(
              'INSERT INTO subtasks (title, task_id, is_completed) VALUES (?, ?, ?)',
              [st.title, taskId, isComp]
            );
          } catch (stErr) {
            console.error('Subtask insert error:', stErr.message);
          }
        }
      }
    }

    res.json({ message: 'ამოცანა წარმატებით განახლდა' });
  } catch (error) {
    console.error('Update Task Error:', error);
    res.status(500).json({ message: 'ამოცანის განახლება ვერ მოხერხდა', error: error.message });
  }
};

// Subtask-ის სტატუსის შეცვლა (Completed / Pending)
exports.toggleSubtask = async (req, res) => {
  const { id } = req.params;
  const { is_completed } = req.body;

  try {
    const isComp = (is_completed === 1 || is_completed === true) ? 1 : 0;

    await pool.query(
      'UPDATE subtasks SET is_completed = ? WHERE id = ?',
      [isComp, id]
    );
    res.json({ message: 'სუბთასქის სტატუსი განახლდა' });
  } catch (error) {
    res.status(500).json({ message: 'სტატუსის შეცვლა ვერ მოხერხდა', error: error.message });
  }
};

// ამოცანის წაშლა
exports.deleteTask = async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query('DELETE FROM subtasks WHERE task_id = ?', [id]);
    await pool.query('DELETE FROM tasks WHERE id = ?', [id]);

    res.json({ message: 'ამოცანა წაიშალა' });
  } catch (error) {
    res.status(500).json({ message: 'ამოცანის წაშლა ვერ მოხერხდა', error: error.message });
  }
};