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
    res.status(500).json({ message: 'დაფების წამოღება ვერ მოხერხდა', error: error.message });
  }
};

// სრული დაფის წამოღება (სვეტებით, თასქებით და სუბთასქებით)
exports.getBoardById = async (req, res) => {
  const { id } = req.params;

  try {
    const [boards] = await pool.query('SELECT * FROM boards WHERE id = ?', [id]);
    if (boards.length === 0) {
      return res.status(404).json({ message: 'დაფა ვერ მოიძებნა' });
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
    res.status(500).json({ message: 'დაფის სტრუქტურის წამოღება ვერ მოხერხდა', error: error.message });
  }
};

// ახალი დაფის შექმნა (სვეტებთან ერთად)
exports.createBoard = async (req, res) => {
  const { title, columns } = req.body; // columns: ["Todo", "Doing", "Done"]
  const userId = req.user.id;

  try {
    const [boardResult] = await pool.query(
      'INSERT INTO boards (title, user_id) VALUES (?, ?)',
      [title, userId]
    );
    const boardId = boardResult.insertId;

    if (columns && Array.isArray(columns) && columns.length > 0) {
      for (let i = 0; i < columns.length; i++) {
        await pool.query(
          'INSERT INTO columns (title, board_id, position) VALUES (?, ?, ?)',
          [columns[i], boardId, i]
        );
      }
    }

    res.status(201).json({ message: 'დაფა წარმატებით შეიქმნა', boardId });
  } catch (error) {
    res.status(500).json({ message: 'დაფის შექმნა ვერ მოხერხდა', error: error.message });
  }
};

// ახალი სვეტის დამატება არსებულ დაფაზე
exports.addColumn = async (req, res) => {
  const { board_id, title } = req.body;

  try {
    if (!title || !board_id) {
      return res.status(400).json({ message: 'board_id და title აუცილებელია' });
    }

    // ვითვლით მიმდინარე სვეტების რაოდენობას position-ისთვის
    const [countResult] = await pool.query(
      'SELECT COUNT(*) as count FROM columns WHERE board_id = ?',
      [board_id]
    );
    const position = countResult[0].count;

    const [result] = await pool.query(
      'INSERT INTO columns (title, board_id, position) VALUES (?, ?, ?)',
      [title, board_id, position]
    );

    const newColumn = {
      id: result.insertId,
      board_id: Number(board_id),
      title,
      position,
      tasks: []
    };

    res.status(201).json({ message: 'სვეტი წარმატებით დაემატა', column: newColumn });
  } catch (error) {
    console.error('Add Column Error:', error);
    res.status(500).json({ message: 'სვეტის დამატება ვერ მოხერხდა', error: error.message });
  }
};

// დაფის და სვეტების განახლება (Edit Board)
exports.updateBoard = async (req, res) => {
  const { id } = req.params;
  const { title, columns } = req.body;

  try {
    // 1. დაფის სათაურის განახლება
    if (title) {
      await pool.query('UPDATE boards SET title = ? WHERE id = ?', [title, id]);
    }

    // 2. სვეტების სინქრონიზაცია
    if (columns && Array.isArray(columns)) {
      const [existingColumns] = await pool.query('SELECT id FROM columns WHERE board_id = ?', [id]);
      const existingIds = existingColumns.map((col) => col.id);
      const incomingIds = columns.filter((col) => col.id).map((col) => Number(col.id));

      // წაშლა იმ სვეტების, რომლებიც მომხმარებელმა ამოიშალა
      const columnsToDelete = existingIds.filter((dbId) => !incomingIds.includes(dbId));
      if (columnsToDelete.length > 0) {
        for (const colId of columnsToDelete) {
          await pool.query('DELETE FROM columns WHERE id = ?', [colId]);
        }
      }

      // განახლება ან ახლების დამატება
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        if (col.id) {
          await pool.query('UPDATE columns SET title = ?, position = ? WHERE id = ?', [col.title, i, col.id]);
        } else {
          await pool.query('INSERT INTO columns (title, board_id, position) VALUES (?, ?, ?)', [col.title, id, i]);
        }
      }
    }

    res.json({ message: 'დაფა წარმატებით განახლდა' });
  } catch (error) {
    console.error('Update Board Error:', error);
    res.status(500).json({ message: 'დაფის განახლება ვერ მოხერხდა', error: error.message });
  }
};

// დაფის წაშლა
exports.deleteBoard = async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query('DELETE FROM boards WHERE id = ?', [id]);
    res.json({ message: 'დაფა წარმატებით წაიშალა' });
  } catch (error) {
    res.status(500).json({ message: 'დაფის წაშლა ვერ მოხერხდა', error: error.message });
  }
};