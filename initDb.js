const pool = require('./config/db');
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();

const schemaForeignKeys = [
  ['boards', 'fk_boards_user', 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'],
  ['boards', 'fk_boards_workspace', 'FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE'],
  ['columns', 'fk_columns_board', 'FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE'],
  ['tasks', 'fk_tasks_column', 'FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE'],
  ['subtasks', 'fk_subtasks_task', 'FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE'],
  ['workspaces', 'fk_workspaces_owner', 'FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE'],
  ['workspace_members', 'fk_workspace_members_workspace', 'FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE'],
  ['workspace_members', 'fk_workspace_members_user', 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'],
  ['workspace_invites', 'fk_workspace_invites_workspace', 'FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE'],
  ['workspace_invites', 'fk_workspace_invites_creator', 'FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE'],
  ['workspace_email_invites', 'fk_workspace_email_invites_workspace', 'FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE'],
  ['workspace_email_invites', 'fk_workspace_email_invites_user', 'FOREIGN KEY (invited_user_id) REFERENCES users(id) ON DELETE CASCADE'],
  ['workspace_email_invites', 'fk_workspace_email_invites_inviter', 'FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE'],
  ['task_assignees', 'fk_task_assignees_task', 'FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE'],
  ['task_assignees', 'fk_task_assignees_user', 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'],
  ['admin_recovery_codes', 'fk_admin_recovery_codes_user', 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'],
  ['admin_sessions', 'fk_admin_sessions_user', 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'],
  ['admin_activity_logs', 'fk_admin_activity_logs_actor', 'FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE'],
];

const quoteIdentifier = (value) => `\`${value.replace(/`/g, '``')}\``;

async function repairForeignKeyTypes() {
  for (const [table, constraint] of schemaForeignKeys) {
    const [rows] = await pool.query(
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=? AND CONSTRAINT_TYPE='FOREIGN KEY'`,
      [table, constraint],
    );
    if (rows.length) {
      await pool.query(`ALTER TABLE ${quoteIdentifier(table)} DROP FOREIGN KEY ${quoteIdentifier(constraint)}`);
    }
  }

  const columnDefinitions = [
    ['users', 'id', 'INT UNSIGNED NOT NULL AUTO_INCREMENT'],
    ['boards', 'id', 'INT UNSIGNED NOT NULL AUTO_INCREMENT'],
    ['boards', 'user_id', 'INT UNSIGNED NOT NULL'],
    ['boards', 'workspace_id', 'INT UNSIGNED NULL'],
    ['columns', 'id', 'INT UNSIGNED NOT NULL AUTO_INCREMENT'],
    ['columns', 'board_id', 'INT UNSIGNED NOT NULL'],
    ['tasks', 'id', 'INT UNSIGNED NOT NULL AUTO_INCREMENT'],
    ['tasks', 'column_id', 'INT UNSIGNED NOT NULL'],
    ['subtasks', 'id', 'INT UNSIGNED NOT NULL AUTO_INCREMENT'],
    ['subtasks', 'task_id', 'INT UNSIGNED NOT NULL'],
    ['workspaces', 'id', 'INT UNSIGNED NOT NULL AUTO_INCREMENT'],
    ['workspaces', 'owner_id', 'INT UNSIGNED NOT NULL'],
    ['workspace_members', 'id', 'INT UNSIGNED NOT NULL AUTO_INCREMENT'],
    ['workspace_members', 'workspace_id', 'INT UNSIGNED NOT NULL'],
    ['workspace_members', 'user_id', 'INT UNSIGNED NOT NULL'],
    ['workspace_invites', 'id', 'INT UNSIGNED NOT NULL AUTO_INCREMENT'],
    ['workspace_invites', 'workspace_id', 'INT UNSIGNED NOT NULL'],
    ['workspace_invites', 'created_by', 'INT UNSIGNED NOT NULL'],
    ['workspace_email_invites', 'id', 'INT UNSIGNED NOT NULL AUTO_INCREMENT'],
    ['workspace_email_invites', 'workspace_id', 'INT UNSIGNED NOT NULL'],
    ['workspace_email_invites', 'invited_user_id', 'INT UNSIGNED NOT NULL'],
    ['workspace_email_invites', 'invited_by', 'INT UNSIGNED NOT NULL'],
    ['task_assignees', 'task_id', 'INT UNSIGNED NOT NULL'],
    ['task_assignees', 'user_id', 'INT UNSIGNED NOT NULL'],
    ['admin_recovery_codes', 'user_id', 'INT UNSIGNED NOT NULL'],
    ['admin_sessions', 'user_id', 'INT UNSIGNED NOT NULL'],
    ['admin_activity_logs', 'actor_user_id', 'INT UNSIGNED NOT NULL'],
  ];
  for (const [table, column, definition] of columnDefinitions) {
    await pool.query(`ALTER TABLE ${quoteIdentifier(table)} MODIFY COLUMN ${quoteIdentifier(column)} ${definition}`);
  }

  for (const [table, constraint, definition] of schemaForeignKeys) {
    const [rows] = await pool.query(
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=? AND CONSTRAINT_TYPE='FOREIGN KEY'`,
      [table, constraint],
    );
    if (!rows.length) {
      await pool.query(`ALTER TABLE ${quoteIdentifier(table)} ADD CONSTRAINT ${quoteIdentifier(constraint)} ${definition}`);
    }
  }
}

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
      workspace_id INT UNSIGNED NULL,
      title VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS columns (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      board_id INT UNSIGNED NOT NULL,
      title VARCHAR(255) NOT NULL,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_columns_board_position (board_id, position)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      column_id INT UNSIGNED NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_tasks_column_position (column_id, position)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS subtasks (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      task_id INT UNSIGNED NOT NULL,
      title VARCHAR(255) NOT NULL,
      is_completed TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS workspaces (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      type ENUM('PERSONAL','TEAM','EDUCATION') NOT NULL,
      owner_id INT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_workspaces_owner (owner_id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS workspace_members (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      workspace_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      role ENUM('OWNER','ADMIN','MEMBER') NOT NULL DEFAULT 'MEMBER',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_workspace_member (workspace_id,user_id),
      KEY idx_workspace_members_user (user_id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS workspace_invites (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      workspace_id INT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at DATETIME NULL,
      revoked_at DATETIME NULL,
      created_by INT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_workspace_invites_workspace (workspace_id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS workspace_email_invites (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      workspace_id INT UNSIGNED NOT NULL,
      invited_user_id INT UNSIGNED NOT NULL,
      invited_by INT UNSIGNED NOT NULL,
      status ENUM('PENDING','ACCEPTED','DECLINED') NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      responded_at TIMESTAMP NULL,
      PRIMARY KEY (id),
      KEY idx_workspace_email_invites_pending (workspace_id,invited_user_id,status),
      KEY idx_workspace_email_invites_user (invited_user_id,status)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS task_assignees (
      task_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      PRIMARY KEY (task_id,user_id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS admin_recovery_codes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      code_hash VARCHAR(255) NOT NULL,
      used_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_admin_recovery_codes_user (user_id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS admin_sessions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      session_hash CHAR(64) NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_admin_sessions_user (user_id),
      KEY idx_admin_sessions_active (session_hash, revoked_at, expires_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS admin_activity_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      actor_user_id INT UNSIGNED NOT NULL,
      action VARCHAR(100) NOT NULL,
      target_type VARCHAR(50) NULL,
      target_id INT UNSIGNED NULL,
      metadata JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_admin_activity_logs_created (created_at),
      KEY idx_admin_activity_logs_actor (actor_user_id)
    ) ENGINE=InnoDB`
  ];
  try {
    for (const statement of statements) await pool.query(statement);
    await repairForeignKeyTypes();
    const [userColumns] = await pool.query(
      `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'users'
         AND COLUMN_NAME IN ('reset_token_hash', 'reset_token_expires', 'email_verified', 'verification_code', 'verification_code_expires',
           'system_role', 'totp_secret_encrypted', 'totp_setup_expires', 'totp_enabled', 'totp_failed_attempts', 'totp_locked_until', 'is_active')`,
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
    if (!existingColumns.has('system_role')) {
      await pool.query("ALTER TABLE users ADD COLUMN system_role VARCHAR(32) NOT NULL DEFAULT 'USER'");
    }
    if (!existingColumns.has('totp_secret_encrypted')) {
      await pool.query('ALTER TABLE users ADD COLUMN totp_secret_encrypted TEXT NULL');
    }
    if (!existingColumns.has('totp_setup_expires')) {
      await pool.query('ALTER TABLE users ADD COLUMN totp_setup_expires DATETIME NULL');
    }
    if (!existingColumns.has('totp_enabled')) {
      await pool.query('ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    }
    if (!existingColumns.has('totp_failed_attempts')) {
      await pool.query('ALTER TABLE users ADD COLUMN totp_failed_attempts INT UNSIGNED NOT NULL DEFAULT 0');
    }
    if (!existingColumns.has('totp_locked_until')) {
      await pool.query('ALTER TABLE users ADD COLUMN totp_locked_until DATETIME NULL');
    }
    if (!existingColumns.has('is_active')) {
      await pool.query('ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE');
    }
    if (SUPER_ADMIN_EMAIL) {
      await pool.query(
        "UPDATE users SET system_role='SUPER_ADMIN' WHERE email=? AND system_role='USER'",
        [SUPER_ADMIN_EMAIL],
      );
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
