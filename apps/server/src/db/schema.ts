// SQLite 12 张核心表 + 顺序迁移表 schema_migrations。
// 依赖 Node 24 内置 node:sqlite（SQLite 3.49+，原生支持 GENERATED ALWAYS AS VIRTUAL 与部分唯一索引）。

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "001_initial_selfhosted_schema",
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  is_managed INTEGER NOT NULL DEFAULT 0 CHECK (is_managed IN (0, 1)),
  member_user_id TEXT REFERENCES users(id),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  profile_json TEXT NOT NULL,
  age TEXT GENERATED ALWAYS AS (json_extract(profile_json, '$.age')) VIRTUAL,
  stage TEXT GENERATED ALWAYS AS (json_extract(profile_json, '$.stage')) VIRTUAL,
  product TEXT GENERATED ALWAYS AS (json_extract(profile_json, '$.product')) VIRTUAL,
  version INTEGER NOT NULL DEFAULT 1,
  has_conflict INTEGER NOT NULL DEFAULT 0 CHECK (has_conflict IN (0, 1)),
  conflict_json TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_profiles_owner ON profiles(owner_user_id);
CREATE INDEX idx_profiles_member ON profiles(member_user_id);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'mobile_account', 'mobile_bound')),
  bound_profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX idx_auth_sessions_bound ON auth_sessions(bound_profile_id);

CREATE TABLE pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pairing_codes_profile ON pairing_codes(profile_id);

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL,
  segment INTEGER NOT NULL,
  week INTEGER NOT NULL,
  day TEXT NOT NULL,
  half INTEGER NOT NULL DEFAULT 0 CHECK (half IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'invalidated', 'archived')),
  invalidated_reason TEXT,
  archived_segment INTEGER,
  legacy_path TEXT,
  course_json TEXT NOT NULL,
  follow_json TEXT NOT NULL DEFAULT '[]',
  notes_json TEXT NOT NULL DEFAULT '[]',
  template_version TEXT NOT NULL DEFAULT '',
  template_hash TEXT NOT NULL DEFAULT '',
  motion_hashes_json TEXT NOT NULL DEFAULT '{}',
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_courses_active_unique
  ON courses(profile_id, segment, week, day, half)
  WHERE status = 'active';
CREATE INDEX idx_courses_profile_status ON courses(profile_id, status);

CREATE TABLE workout_sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_record_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
  course_id TEXT NOT NULL,
  course_snapshot_hash TEXT,
  idempotency_key TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  has_symptoms INTEGER NOT NULL DEFAULT 0 CHECK (has_symptoms IN (0, 1)),
  edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
  stale_course INTEGER NOT NULL DEFAULT 0 CHECK (stale_course IN (0, 1)),
  archived_segment INTEGER,
  legacy_path TEXT,
  session_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, course_id, started_at)
);
CREATE UNIQUE INDEX idx_sessions_idempotency
  ON workout_sessions(profile_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_sessions_legacy_path
  ON workout_sessions(profile_id, legacy_path)
  WHERE legacy_path IS NOT NULL;
CREATE INDEX idx_sessions_profile_started ON workout_sessions(profile_id, started_at);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  segment INTEGER NOT NULL,
  week INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  archived_segment INTEGER,
  legacy_json_path TEXT,
  legacy_md_path TEXT,
  review_json TEXT NOT NULL,
  review_md TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, segment, week, start_date)
);
CREATE INDEX idx_reviews_profile ON reviews(profile_id);

CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  assess_date TEXT NOT NULL,
  logical_path TEXT NOT NULL,
  archived_segment INTEGER,
  assessment_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(profile_id, logical_path)
);
CREATE INDEX idx_assessments_profile ON assessments(profile_id, assess_date);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('plan', 'menu', 'monthly_summary')),
  title TEXT NOT NULL,
  segment INTEGER,
  week INTEGER,
  week_start TEXT,
  archived_segment INTEGER,
  legacy_path TEXT NOT NULL,
  readonly_legacy INTEGER NOT NULL DEFAULT 0 CHECK (readonly_legacy IN (0, 1)),
  content_md TEXT NOT NULL,
  template_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, legacy_path)
);
CREATE INDEX idx_documents_profile_type ON documents(profile_id, doc_type);

CREATE TABLE agent_threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '新对话',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_threads_user_profile ON agent_threads(user_id, profile_id, updated_at);

CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_messages_thread ON agent_messages(thread_id, created_at);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_session_id TEXT,
  profile_id TEXT,
  action TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '[]',
  rule_or_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_logs_profile ON audit_logs(profile_id, created_at);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL,
  iv TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '',
  is_secret INTEGER NOT NULL DEFAULT 0 CHECK (is_secret IN (0, 1)),
  updated_at TEXT NOT NULL
);
`,
  },
];
