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
      email_verified BOOLEAN DEFAULT FALSE,
      verification_code VARCHAR(255) NULL,
      verification_code_expires DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS boards (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      workspace_id INT NULL,
      title VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT fk_boards_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS columns (
      id INT NOT NULL AUTO_INCREMENT,
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
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS workspaces (
      id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      type ENUM('PERSONAL','TEAM','EDUCATION') NOT NULL,
      owner_id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_workspaces_owner (owner_id),
      CONSTRAINT fk_workspaces_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS workspace_members (
      id INT NOT NULL AUTO_INCREMENT,
      workspace_id INT NOT NULL,
      user_id INT NOT NULL,
      role ENUM('OWNER','ADMIN','MEMBER') NOT NULL DEFAULT 'MEMBER',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_workspace_member (workspace_id,user_id),
      KEY idx_workspace_members_user (user_id),
      CONSTRAINT fk_workspace_members_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_workspace_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS workspace_invites (
      id INT NOT NULL AUTO_INCREMENT,
      workspace_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at DATETIME NULL,
      revoked_at DATETIME NULL,
      created_by INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_workspace_invites_workspace (workspace_id),
      CONSTRAINT fk_workspace_invites_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_workspace_invites_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS workspace_email_invites (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      workspace_id INT NOT NULL,
      invited_user_id INT UNSIGNED NOT NULL,
      invited_by INT UNSIGNED NOT NULL,
      status ENUM('PENDING','ACCEPTED','DECLINED') NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      responded_at TIMESTAMP NULL,
      PRIMARY KEY (id),
      KEY idx_workspace_email_invites_pending (workspace_id,invited_user_id,status),
      KEY idx_workspace_email_invites_user (invited_user_id,status),
      CONSTRAINT fk_workspace_email_invites_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_workspace_email_invites_user FOREIGN KEY (invited_user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_workspace_email_invites_inviter FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS task_assignees (
      task_id INT NOT NULL,
      user_id INT NOT NULL,
      PRIMARY KEY (task_id,user_id),
      CONSTRAINT fk_task_assignees_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      CONSTRAINT fk_task_assignees_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`
  ];
  try {
    for (const statement of statements) await pool.query(statement);
    const [userColumns] = await pool.query(
      `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'users'
         AND COLUMN_NAME IN ('reset_token_hash', 'reset_token_expires', 'email_verified', 'verification_code', 'verification_code_expires')`,
    );
    const existingColumns = new Set(userColumns.map(({ COLUMN_NAME }) => COLUMN_NAME));
    const [boardColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='boards' AND COLUMN_NAME='workspace_id'`,
    );
    if (!boardColumns.length) {
      await pool.query('ALTER TABLE boards ADD COLUMN workspace_id INT UNSIGNED NULL, ADD KEY idx_boards_workspace (workspace_id)');
    }
    const [workspaceConstraint] = await pool.query(
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='boards' AND CONSTRAINT_NAME='fk_boards_workspace'`,
    );
    if (!workspaceConstraint.length) {
      await pool.query('ALTER TABLE boards ADD CONSTRAINT fk_boards_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE');
    }
    if (!existingColumns.has('reset_token_hash')) {
      await pool.query('ALTER TABLE users ADD COLUMN reset_token_hash CHAR(64) NULL');
    }
    if (!existingColumns.has('reset_token_expires')) {
      await pool.query('ALTER TABLE users ADD COLUMN reset_token_expires DATETIME NULL');
    }
    if (!existingColumns.has('email_verified')) {
      await pool.query('ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT FALSE');
    }
    if (!existingColumns.has('verification_code')) {
      await pool.query('ALTER TABLE users ADD COLUMN verification_code VARCHAR(255) NULL');
    }
    if (!existingColumns.has('verification_code_expires')) {
      await pool.query('ALTER TABLE users ADD COLUMN verification_code_expires DATETIME NULL');
    }
    await pool.query(
      `INSERT INTO workspaces (name,type,owner_id)
       SELECT CONCAT(full_name, '''s Personal Workspace'),'PERSONAL',u.id FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id=u.id AND w.type='PERSONAL')`,
    );
    await pool.query(
      `INSERT IGNORE INTO workspace_members (workspace_id,user_id,role)
       SELECT id,owner_id,'OWNER' FROM workspaces WHERE type='PERSONAL'`,
    );
    console.log('Database tables initialized successfully.');
  } catch (error) {
    console.error('Error initializing database:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

createTables();
