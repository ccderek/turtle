/**
 * Schema migrations. Each entry upgrades `PRAGMA user_version` by one.
 * See docs/phase0-spec.md §7.
 */
export const MIGRATIONS: readonly string[] = [
  /* v1 */ `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE branches (
  id                  TEXT PRIMARY KEY,
  name                TEXT,
  ref                 TEXT NOT NULL UNIQUE,
  root_node_id        TEXT NOT NULL,
  forked_from_node_id TEXT,
  head_node_id        TEXT,
  workspace_path      TEXT,
  status              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE agents (
  id             TEXT PRIMARY KEY,
  branch_id      TEXT NOT NULL REFERENCES branches(id),
  adapter        TEXT NOT NULL,
  adapter_level  INTEGER NOT NULL,
  model          TEXT,
  sandbox        TEXT NOT NULL,
  session_id     TEXT,
  prompt         TEXT NOT NULL,
  status         TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  total_cost_usd REAL,
  num_turns      INTEGER,
  pid            INTEGER
);
CREATE INDEX agents_branch ON agents(branch_id);
CREATE INDEX agents_status ON agents(status);

CREATE TABLE nodes (
  id                   TEXT PRIMARY KEY,
  branch_id            TEXT NOT NULL REFERENCES branches(id),
  agent_id             TEXT REFERENCES agents(id),
  kind                 TEXT NOT NULL CHECK (kind IN ('root','micro','semantic','human_edit','merge')),
  commit_sha           TEXT NOT NULL,
  tree_sha             TEXT NOT NULL,
  intent               TEXT,
  summary              TEXT,
  summary_source       TEXT CHECK (summary_source IN ('agent_declared','rule_auto','human')),
  status               TEXT NOT NULL,
  trigger              TEXT,
  session_id           TEXT,
  resume_tool_use_id   TEXT,
  resume_message_uuid  TEXT,
  tests                TEXT CHECK (tests IN ('pass','fail','none')),
  files_changed        INTEGER,
  lines_added          INTEGER,
  lines_deleted        INTEGER,
  tokens_input         INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read    INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write   INTEGER NOT NULL DEFAULT 0,
  tokens_output        INTEGER NOT NULL DEFAULT 0,
  cost_usd_est         REAL    NOT NULL DEFAULT 0,
  tags                 TEXT    NOT NULL DEFAULT '[]',
  exploration_group_id TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX nodes_branch ON nodes(branch_id, created_at);
CREATE INDEX nodes_commit ON nodes(commit_sha);
CREATE INDEX nodes_status ON nodes(status) WHERE kind = 'semantic';
CREATE INDEX nodes_resume ON nodes(agent_id, resume_tool_use_id) WHERE resume_message_uuid IS NULL;

CREATE TABLE node_parents (
  node_id   TEXT NOT NULL REFERENCES nodes(id),
  parent_id TEXT NOT NULL REFERENCES nodes(id),
  ord       INTEGER NOT NULL,
  PRIMARY KEY (node_id, ord)
);
CREATE INDEX node_parents_parent ON node_parents(parent_id);

CREATE TABLE artifacts (
  id       TEXT PRIMARY KEY,
  node_id  TEXT NOT NULL REFERENCES nodes(id),
  label    TEXT,
  path     TEXT,
  blob_sha TEXT NOT NULL,
  mime     TEXT,
  size     INTEGER
);
CREATE INDEX artifacts_node ON artifacts(node_id);

CREATE TABLE messages (
  agent_id           TEXT NOT NULL REFERENCES agents(id),
  seq                INTEGER NOT NULL,
  session_id         TEXT,
  uuid               TEXT,
  type               TEXT NOT NULL,
  parent_tool_use_id TEXT,
  node_id            TEXT,
  json               TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq)
);
CREATE INDEX messages_uuid ON messages(session_id, uuid);

CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  at         TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id   TEXT,
  type       TEXT NOT NULL,
  branch_id  TEXT,
  node_id    TEXT,
  agent_id   TEXT,
  payload    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX events_agent ON events(agent_id, seq);

CREATE TABLE snapshots (
  name       TEXT PRIMARY KEY,
  node_id    TEXT NOT NULL REFERENCES nodes(id),
  created_at TEXT NOT NULL
);
`,
];
