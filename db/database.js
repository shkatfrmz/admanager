const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'ad-cache.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL'); // better concurrent read/write performance

// Idempotent migration helper
function addColumnIfMissing(table, column, definition) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = info.some(col => col.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] Added column ${column} to ${table}`);
  }
}

// Migration: add install_args if missing and backfill defaults
addColumnIfMissing('deployment_files', 'install_args', 'TEXT');
const backfill = db.prepare(`UPDATE deployment_files SET install_args = ? WHERE install_args IS NULL AND file_type = ?`);
backfill.run('/S', '.exe');
backfill.run('/qn /norestart /l*v "C:\\Windows\\Temp\\admgr-install.log"', '.msi');

// ════════════════════════════════════════════════════════════════════════════
// SCHEMA
// ════════════════════════════════════════════════════════════════════════════

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    dn                 TEXT PRIMARY KEY,
    sAMAccountName      TEXT,
    userPrincipalName   TEXT,
    displayName         TEXT,
    givenName           TEXT,
    sn                  TEXT,
    mail                TEXT,
    department          TEXT,
    title               TEXT,
    telephoneNumber     TEXT,
    userAccountControl  INTEGER,
    whenCreated         TEXT,
    lastLogon           TEXT,
    last_synced_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS groups (
    dn                  TEXT PRIMARY KEY,
    cn                  TEXT,
    description         TEXT,
    last_synced_at       TEXT
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_dn            TEXT,
    user_dn              TEXT,
    PRIMARY KEY (group_dn, user_dn)
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_type            TEXT,
    status                TEXT,
    records_synced        INTEGER,
    error_message          TEXT,
    started_at             TEXT,
    finished_at             TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_users_sam ON users(sAMAccountName);
  CREATE INDEX IF NOT EXISTS idx_users_upn ON users(userPrincipalName);
  CREATE INDEX IF NOT EXISTS idx_users_mail ON users(mail);
  CREATE INDEX IF NOT EXISTS idx_users_displayname ON users(displayName);
  CREATE INDEX IF NOT EXISTS idx_users_department ON users(department);
  CREATE INDEX IF NOT EXISTS idx_groups_cn ON groups(cn);
  CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_dn);
  CREATE INDEX IF NOT EXISTS idx_sync_log_status ON sync_log(status);

  CREATE TABLE IF NOT EXISTS computers (
    dn                  TEXT PRIMARY KEY,
    cn                  TEXT,
    sAMAccountName      TEXT,
    dNSHostName         TEXT,
    operatingSystem     TEXT,
    operatingSystemVersion TEXT,
    userAccountControl  INTEGER,
    description         TEXT,
    whenCreated         TEXT,
    lastLogon           TEXT,
    last_synced_at      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_computers_cn ON computers(cn);
  CREATE INDEX IF NOT EXISTS idx_computers_sam ON computers(sAMAccountName);
  CREATE INDEX IF NOT EXISTS idx_computers_dns ON computers(dNSHostName);
  CREATE INDEX IF NOT EXISTS idx_computers_os ON computers(operatingSystem);

  CREATE TABLE IF NOT EXISTS scheduled_access (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_dn               TEXT NOT NULL,
    group_dn              TEXT NOT NULL,
    user_name             TEXT,
    group_name             TEXT,
    start_time             TEXT NOT NULL,
    end_time               TEXT NOT NULL,
    status                 TEXT DEFAULT 'active',
    created_at             TEXT DEFAULT (datetime('now')),
    removed_at             TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sched_access_status ON scheduled_access(status);
  CREATE INDEX IF NOT EXISTS idx_sched_access_end ON scheduled_access(end_time);

  CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp    TEXT NOT NULL DEFAULT (datetime('now')),
    action       TEXT NOT NULL,
    target_type  TEXT NOT NULL,
    target_name  TEXT,
    target_dn    TEXT,
    performed_by TEXT,
    details      TEXT,
    result       TEXT DEFAULT 'success'
  );

  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
  CREATE INDEX IF NOT EXISTS idx_audit_target_type ON audit_log(target_type);

  -- RBAC Tables
  CREATE TABLE IF NOT EXISTS roles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    description   TEXT,
    permissions   TEXT NOT NULL DEFAULT '[]',
    is_system     INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_roles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL,
    role_id       INTEGER NOT NULL REFERENCES roles(id),
    granted_by    TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(username, role_id)
  );

  CREATE INDEX IF NOT EXISTS idx_admin_roles_username ON admin_roles(username);
  CREATE INDEX IF NOT EXISTS idx_roles_name ON roles(name);

  -- Endpoint Management Tables
  CREATE TABLE IF NOT EXISTS endpoints (
    id                  TEXT PRIMARY KEY,
    hostname             TEXT NOT NULL,
    ip_address           TEXT,
    os_version           TEXT,
    os_arch              TEXT,
    cpu_model             TEXT,
    cpu_cores             INTEGER,
    total_ram_gb          REAL,
    domain                TEXT,
    agent_version         TEXT,
    status                TEXT DEFAULT 'offline',
    last_heartbeat        TEXT,
    registered_at         TEXT DEFAULT (datetime('now')),
    notes                 TEXT
  );

  CREATE TABLE IF NOT EXISTS deployment_files (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    description          TEXT,
    original_name         TEXT NOT NULL,
    stored_path           TEXT NOT NULL,
    file_size              INTEGER,
    file_type              TEXT,
    install_args           TEXT,
    created_at             TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deployments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id               INTEGER REFERENCES deployment_files(id),
    endpoint_id           TEXT NOT NULL REFERENCES endpoints(id),
    status                TEXT DEFAULT 'pending',
    attempt_count          INTEGER DEFAULT 0,
    error_message          TEXT,
    started_at             TEXT,
    completed_at           TEXT,
    created_at             TEXT DEFAULT (datetime('now')),
    created_by             TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_deployments_endpoint ON deployments(endpoint_id);
  CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
  CREATE INDEX IF NOT EXISTS idx_endpoints_status ON endpoints(status);

  -- WinRM deployment tracking
  CREATE TABLE IF NOT EXISTS winrm_deployments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id             INTEGER REFERENCES deployment_files(id),
    hostname            TEXT NOT NULL,
    ip_address          TEXT,
    status              TEXT DEFAULT 'pending',
    attempt_count       INTEGER DEFAULT 0,
    error_message       TEXT,
    output_log          TEXT,
    started_at          TEXT,
    completed_at        TEXT,
    created_at          TEXT DEFAULT (datetime('now')),
    created_by          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_winrm_deployments_status ON winrm_deployments(status);
  CREATE INDEX IF NOT EXISTS idx_winrm_deployments_hostname ON winrm_deployments(hostname);
`);

module.exports = db;
