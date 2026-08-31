const pool = require('../config/db');

// დამხმარე ფუნქცია: ვამოწმებთ ეკუთვნის თუ არა თასქი ავტორიზებულ მომხმარებელს
const verifyTaskOwnership = async (connection, taskId, userId) => {
  const [tasks] = await connection.query(
    `SELECT t.id FROM tasks t
     JOIN columns c ON t.column_id = c.id
     JOIN boards b ON c.board_id = b.id
     WHERE t.id = ? AND b.user_id = ?`,
    [taskId, userId]
  );
  return tasks.length > 0;
};

// დამხმარე ფუნქცია: ვამოწმებთ ეკუთვნის თუ არა კოლონა ავტორიზებულ მომხმარებელს
const verifyColumnOwnership = async (connection, columnId, userId) => {
  const [columns] = await connection.query(
    `SELECT c.id FROM columns c
     JOIN boards b ON c.board_id = b.id
     WHERE c.id = ? AND b.user_id = ?`,
    [columnId, userId]
  );
  return columns.length > 0;
};

// ახალი ამოცანის შექმნა (სუბთასქებთან ერთად) ტრანზაქციით
exports.createTask = async (req, res) => {
  const { title, description, column_id, subtasks } = req.body;
  const userId = req.user.id;

  if (!title || !column_id) {
    return res.status(400).json({ message: 'სათაური და column_id სავალდებულოა' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. მფლობელობის შემოწმება
    const isOwner = await verifyColumnOwnership(connection, column_id, userId);
    if (!isOwner) {
      await connection.rollback();
      return res.status(403).json({ message: 'წვდომა აკრძალულია' });
    }

    // 2. პოზიციის გამოთვლა
    const [countResult] = await connection.query(
      'SELECT COUNT(*) as count FROM tasks WHERE column_id = ?',
      [column_id]
    );
    const position = countResult[0].count;

    const [taskResult] = await connection.query(
      'INSERT INTO tasks (title, description, column_id, position) VALUES (?, ?, ?, ?)',
      [title.trim(), description || null, column_id, position]
    );
    const taskId = taskResult.insertId;

    // 3. სუბთასქების დამატება
    if (subtasks && Array.isArray(subtasks) && subtasks.length > 0) {
      for (const st of subtasks) {
        const subtaskTitle = typeof st === 'object' ? st.title : st;
        const isComp = typeof st === 'object' && (st.is_completed === 1 || st.is_completed === true) ? 1 : 0;
        
        if (subtaskTitle && subtaskTitle.trim() !== '') {
          await connection.query(
            'INSERT INTO subtasks (title, task_id, is_completed) VALUES (?, ?, ?)',
            [subtaskTitle.trim(), taskId, isComp]
          );
        }
      }
    }

    await connection.commit();
    res.status(201).json({ message: 'ამოცანა წარმატებით შეიქმნა', taskId });
  } catch (error) {
    await connection.rollback();
    console.error('Create Task Error:', error);
    res.status(500).json({ message: 'ამოცანის შექმნა ვერ მოხერხდა' });
  } finally {
    connection.release();
  }
};

// ამოცანის განახლება (სვეტის, ტექსტის, პოზიციის, სუბთასქების სინქრონიზაცია) ტრანზაქციით
exports.updateTask = async (req, res) => {
  const taskId = Number(req.params.id);
  const { title, description, column_id, position, subtasks } = req.body;
  const userId = req.user.id;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. მფლობელობის შემოწმება
    const isOwner = await verifyTaskOwnership(connection, taskId, userId);
    if (!isOwner) {
      await connection.rollback();
      return res.status(404).json({ message: 'ამოცანა ვერ მოიძებნა ან წვდომა აკრძალულია' });
    }

    const [existingTasks] = await connection.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
    const currentTask = existingTasks[0];

    const updatedTitle = title !== undefined ? title.trim() : currentTask.title;
    const updatedDescription = description !== undefined ? description : currentTask.description;
    const updatedColumnId = column_id !== undefined ? Number(column_id) : currentTask.column_id;
    const updatedPosition = position !== undefined && position !== null ? Number(position) : currentTask.position;

    // თუ სვეტი იცვლება, ახალი სვეტის მფლობელობაც ვამოწმოთ
    if (column_id !== undefined && Number(column_id) !== currentTask.column_id) {
      const isNewColOwner = await verifyColumnOwnership(connection, updatedColumnId, userId);
      if (!isNewColOwner) {
        await connection.rollback();
        return res.status(403).json({ message: 'მიზნობრივი სვეტი არ გეკუთვნით' });
      }
    }

    // 2. თასქის განახლება
    await connection.query(
      'UPDATE tasks SET title = ?, description = ?, column_id = ?, position = ? WHERE id = ?',
      [updatedTitle, updatedDescription, updatedColumnId, updatedPosition, taskId]
    );

    // 3. სუბთასქების სინქრონიზაცია (წაშლილების ამოშლა და ახლების/განახლებების მართვა)
    if (subtasks && Array.isArray(subtasks)) {
      const [existingSubtasks] = await connection.query('SELECT id FROM subtasks WHERE task_id = ?', [taskId]);
      const existingSubIds = existingSubtasks.map((st) => st.id);
      const incomingSubIds = subtasks.filter((st) => st.id || st._id).map((st) => Number(st.id || st._id));

      // წაშლა იმ სუბთასქების, რომლებიც ფრონტენდმა ამოშალა
      const subtasksToDelete = existingSubIds.filter((dbId) => !incomingSubIds.includes(dbId));
      if (subtasksToDelete.length > 0) {
        for (const subId of subtasksToDelete) {
          await connection.query('DELETE FROM subtasks WHERE id = ?', [subId]);
        }
      }

      // დამატება ან განახლება
      for (const st of subtasks) {
        const subId = Number(st.id || st._id);
        const subTitle = st.title ? st.title.trim() : '';
        const isComp = (st.is_completed === 1 || st.is_completed === true) ? 1 : 0;

        if (subId && existingSubIds.includes(subId)) {
          await connection.query(
            'UPDATE subtasks SET title = ?, is_completed = ? WHERE id = ?',
            [subTitle, isComp, subId]
          );
        } else if (subTitle) {
          await connection.query(
            'INSERT INTO subtasks (title, task_id, is_completed) VALUES (?, ?, ?)',
            [subTitle, taskId, isComp]
          );
        }
      }
    }

    await connection.commit();
    res.json({ message: 'ამოცანა წარმატებით განახლდა' });
  } catch (error) {
    await connection.rollback();
    console.error('Update Task Error:', error);
    res.status(500).json({ message: 'ამოცანის განახლება ვერ მოხერხდა' });
  } finally {
    connection.release();
  }
};

// Subtask-ის სტატუსის შეცვლა მფლობელობის შემოწმებით
exports.toggleSubtask = async (req, res) => {
  const { id } = req.params;
  const { is_completed } = req.body;
  const userId = req.user.id;

  try {
    // ვამოწმებთ სუბთასქის მფლობელობას
    const [subtasks] = await pool.query(
      `SELECT s.id FROM subtasks s
       JOIN tasks t ON s.task_id = t.id
       JOIN columns c ON t.column_id = c.id
       JOIN boards b ON c.board_id = b.id
       WHERE s.id = ? AND b.user_id = ?`,
      [id, userId]
    );

    if (subtasks.length === 0) {
      return res.status(404).json({ message: 'სუბთასქი ვერ მოიძებნა ან წვდომა აკრძალულია' });
    }

    const isComp = (is_completed === 1 || is_completed === true) ? 1 : 0;

    await pool.query(
      'UPDATE subtasks SET is_completed = ? WHERE id = ?',
      [isComp, id]
    );
    res.json({ message: 'სუბთასქის სტატუსი განახლდა' });
  } catch (error) {
    console.error('Toggle Subtask Error:', error);
    res.status(500).json({ message: 'სტატუსის შეცვლა ვერ მოხერხდა' });
  }
};

// ამოცანის წაშლა მფლობელობის შემოწმებით
exports.deleteTask = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const isOwner = await verifyTaskOwnership(connection, id, userId);
    if (!isOwner) {
      await connection.rollback();
      return res.status(404).json({ message: 'ამოცანა ვერ მოიძებნა ან წვდომა აკრძალულია' });
    }

    await connection.query('DELETE FROM subtasks WHERE task_id = ?', [id]);
    await connection.query('DELETE FROM tasks WHERE id = ?', [id]);

    await connection.commit();
    res.json({ message: 'ამოცანა წაიშალა' });
  } catch (error) {
    await connection.rollback();
    console.error('Delete Task Error:', error);
    res.status(500).json({ message: 'ამოცანის წაშლა ვერ მოხერხდა' });
  } finally {
    connection.release();
  }
};
