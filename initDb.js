const pool = require('./config/db');

async function createTables() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NULL,
      google_id VARCHAR(255) NULL UNIQUE,
      avatar_url VARCHAR(2048) NULL,
      reset_token_hash CHAR(64) NULL,
      reset_token_expires DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS boards (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      title VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT fk_boards_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS columns (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      board_id INT UNSIGNED NOT NULL,
      title VARCHAR(255) NOT NULL,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_columns_board_position (board_id, position),
      CONSTRAINT fk_columns_board FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      column_id INT UNSIGNED NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_tasks_column_position (column_id, position),
      CONSTRAINT fk_tasks_column FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS subtasks (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      task_id INT UNSIGNED NOT NULL,
      title VARCHAR(255) NOT NULL,
      is_completed TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT fk_subtasks_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`
  ];
  try {
    for (const statement of statements) await pool.query(statement);
    console.log('Database tables initialized successfully.');
  } catch (error) {
    console.error('Error initializing database:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

createTables();
