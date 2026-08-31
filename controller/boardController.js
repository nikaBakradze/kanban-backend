const pool = require('../config/db');

// მომხმარებლის ყველა დაფის წამოღება
exports.getBoards = async (req, res) => {
  const userId = req.user.id;

  try {
    const [boards] = await pool.query(
      'SELECT * FROM boards WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    res.json(boards);
  } catch (error) {
    console.error('Get Boards Error:', error);
    res.status(500).json({ message: 'დაფების წამოღება ვერ მოხერხდა' });
  }
};

// სრული დაფის წამოღება (სვეტებით, თასქებით და სუბთასქებით) მფლობელობის შემოწმებით
exports.getBoardById = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // 1. ვამოწმებთ ეკუთვნის თუ არა დაფა მიმდინარე მომხმარებელს
    const [boards] = await pool.query('SELECT * FROM boards WHERE id = ? AND user_id = ?', [id, userId]);
    if (boards.length === 0) {
      return res.status(404).json({ message: 'დაფა ვერ მოიძებნა ან წვდომა აკრძალულია' });
    }

    const [columns] = await pool.query(
      'SELECT * FROM columns WHERE board_id = ? ORDER BY position ASC',
      [id]
    );

    const [tasks] = await pool.query(
      `SELECT t.* FROM tasks t 
       JOIN columns c ON t.column_id = c.id 
       WHERE c.board_id = ? 
       ORDER BY t.position ASC`,
      [id]
    );

    const [subtasks] = await pool.query(
      `SELECT s.* FROM subtasks s 
       JOIN tasks t ON s.task_id = t.id 
       JOIN columns c ON t.column_id = c.id 
       WHERE c.board_id = ?`,
      [id]
    );

    const fullBoard = {
      ...boards[0],
      columns: columns.map((col) => ({
        ...col,
        tasks: tasks
          .filter((t) => t.column_id === col.id)
          .map((task) => ({
            ...task,
            subtasks: subtasks.filter((st) => st.task_id === task.id)
          }))
      }))
    };

    res.json(fullBoard);
  } catch (error) {
    console.error('Get Board By ID Error:', error);
    res.status(500).json({ message: 'დაფის სტრუქტურის წამოღება ვერ მოხერხდა' });
  }
};

// ახალი დაფის შექმნა (სვეტებთან ერთად) ტრანზაქციით
exports.createBoard = async (req, res) => {
  const { title, columns } = req.body;
  const userId = req.user.id;

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ message: 'დაფის სათაური სავალდებულოა' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [boardResult] = await connection.query(
      'INSERT INTO boards (title, user_id) VALUES (?, ?)',
      [title.trim(), userId]
    );
    const boardId = boardResult.insertId;

    if (columns && Array.isArray(columns) && columns.length > 0) {
      for (let i = 0; i < columns.length; i++) {
        const colTitle = typeof columns[i] === 'string' ? columns[i] : columns[i].title;
        if (colTitle) {
          await connection.query(
            'INSERT INTO columns (title, board_id, position) VALUES (?, ?, ?)',
            [colTitle.trim(), boardId, i]
          );
        }
      }
    }

    await connection.commit();
    res.status(201).json({ message: 'დაფა წარმატებით შეიქმნა', boardId });
  } catch (error) {
    await connection.rollback();
    console.error('Create Board Error:', error);
    res.status(500).json({ message: 'დაფის შექმნა ვერ მოხერხდა' });
  } finally {
    connection.release();
  }
};

// ახალი სვეტის დამატება არსებულ დაფაზე მფლობელობის შემოწმებით
exports.addColumn = async (req, res) => {
  const { boardId } = req.params;
  const { title } = req.body;
  const userId = req.user.id;

  if (!title || title.trim() === '') {
    return res.status(400).json({ message: 'სვეტის სათაური აუცილებელია' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. ვამოწმებთ ეკუთვნის თუ არა ბორდი მომხმარებელს
    const [boards] = await connection.query('SELECT id FROM boards WHERE id = ? AND user_id = ?', [boardId, userId]);
    if (boards.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: 'დაფა ვერ მოიძებნა ან წვდომა აკრძალულია' });
    }

    // 2. ვითვლით პოზიციას
    const [countResult] = await connection.query(
      'SELECT COUNT(*) as count FROM columns WHERE board_id = ?',
      [boardId]
    );
    const position = countResult[0].count;

    const [result] = await connection.query(
      'INSERT INTO columns (title, board_id, position) VALUES (?, ?, ?)',
      [title.trim(), boardId, position]
    );

    await connection.commit();

    const newColumn = {
      id: result.insertId,
      board_id: Number(boardId),
      title: title.trim(),
      position,
      tasks: []
    };

    res.status(201).json({ message: 'სვეტი წარმატებით დაემატა', column: newColumn });
  } catch (error) {
    await connection.rollback();
    console.error('Add Column Error:', error);
    res.status(500).json({ message: 'სვეტის დამატება ვერ მოხერხდა' });
  } finally {
    connection.release();
  }
};

// დაფის და სვეტების განახლება (Edit Board) ტრანზაქციით და მფლობელობის შემოწმებით
exports.updateBoard = async (req, res) => {
  const { id } = req.params;
  const { title, columns } = req.body;
  const userId = req.user.id;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. ვამოწმებთ მფლობელობას
    const [boards] = await connection.query('SELECT id FROM boards WHERE id = ? AND user_id = ?', [id, userId]);
    if (boards.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: 'დაფა ვერ მოიძებნა ან წვდომა აკრძალულია' });
    }

    // 2. დაფის სათაურის განახლება
    if (title) {
      await connection.query('UPDATE boards SET title = ? WHERE id = ?', [title.trim(), id]);
    }

    // 3. სვეტების სინქრონიზაცია
    if (columns && Array.isArray(columns)) {
      const [existingColumns] = await connection.query('SELECT id FROM columns WHERE board_id = ?', [id]);
      const existingIds = existingColumns.map((col) => col.id);
      const incomingIds = columns.filter((col) => col.id).map((col) => Number(col.id));

      const columnsToDelete = existingIds.filter((dbId) => !incomingIds.includes(dbId));
      if (columnsToDelete.length > 0) {
        for (const colId of columnsToDelete) {
          await connection.query('DELETE FROM columns WHERE id = ?', [colId]);
        }
      }

      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        if (col.id) {
          await connection.query('UPDATE columns SET title = ?, position = ? WHERE id = ?', [col.title.trim(), i, col.id]);
        } else {
          await connection.query('INSERT INTO columns (title, board_id, position) VALUES (?, ?, ?)', [col.title.trim(), id, i]);
        }
      }
    }

    await connection.commit();
    res.json({ message: 'დაფა წარმატებით განახლდა' });
  } catch (error) {
    await connection.rollback();
    console.error('Update Board Error:', error);
    res.status(500).json({ message: 'დაფის განახლება ვერ მოხერხდა' });
  } finally {
    connection.release();
  }
};

// დაფის წაშლა მფლობელობის შემოწმებით
exports.deleteBoard = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const [boards] = await pool.query('SELECT id FROM boards WHERE id = ? AND user_id = ?', [id, userId]);
    if (boards.length === 0) {
      return res.status(404).json({ message: 'დაფა ვერ მოიძებნა ან წვდომა აკრძალულია' });
    }

    await pool.query('DELETE FROM boards WHERE id = ?', [id]);
    res.json({ message: 'დაფა წარმატებით წაიშალა' });
  } catch (error) {
    console.error('Delete Board Error:', error);
    res.status(500).json({ message: 'დაფის წაშლა ვერ მოხერხდა' });
  }
};
