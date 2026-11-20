export interface Migration {
  version: number
  name: string
  sql: string
}

/**
 * Append-only. Never edit a migration that has shipped; add a new one.
 * The schema version is kept in SQLite's `user_version`.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'auth and settings',
    sql: `
      CREATE TABLE token (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('desktop', 'cli', 'agent', 'composer')),
        name         TEXT NOT NULL,
        scopes       TEXT NOT NULL,           -- JSON array of scopes
        subject      TEXT,                    -- composer tokens: the one draft they may edit
        hash         TEXT NOT NULL UNIQUE,    -- sha256 of the secret; the secret itself is never stored
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at   INTEGER,
        revoked_at   INTEGER
      ) STRICT;

      CREATE TABLE pairing_code (
        hash        TEXT PRIMARY KEY,
        kind        TEXT NOT NULL CHECK (kind IN ('desktop', 'cli')),
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        used_at     INTEGER
      ) STRICT;

      CREATE TABLE setting (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL                   -- JSON
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: 'mail store, change log and search',
    sql: `
      -- Every change to a synced entity gets the next modseq. Clients sync by asking for
      -- "changes since modseq X" (plan §5).
      CREATE TABLE change_log (
        modseq    INTEGER PRIMARY KEY AUTOINCREMENT,
        entity    TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        op        TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
        at        INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX change_log_entity ON change_log (entity, entity_id);

      CREATE TABLE account (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL CHECK (kind IN ('gmail', 'imap')),
        address       TEXT NOT NULL UNIQUE,
        display_name  TEXT,
        credentials   BLOB NOT NULL,          -- AES-256-GCM sealed JSON (crypto.ts)
        cursor        TEXT NOT NULL DEFAULT '{}',   -- provider sync state, JSON
        status        TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new', 'backfilling', 'ready', 'error', 'auth_expired')),
        backfill      TEXT NOT NULL DEFAULT '{}',   -- backfill progress, JSON
        last_sync_at  INTEGER,
        last_error    TEXT,
        created_at    INTEGER NOT NULL,
        modseq        INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE TABLE label (
        id           TEXT PRIMARY KEY,        -- <account>:<provider id>
        account_id   TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
        provider_id  TEXT NOT NULL,
        name         TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('system', 'user')),
        color        TEXT,
        modseq       INTEGER NOT NULL DEFAULT 0,
        UNIQUE (account_id, provider_id)
      ) STRICT;

      CREATE TABLE thread (
        id                 TEXT PRIMARY KEY,  -- <account>:<provider thread id>
        account_id         TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
        provider_thread_id TEXT NOT NULL,
        subject            TEXT NOT NULL DEFAULT '',
        snippet            TEXT NOT NULL DEFAULT '',
        participants       TEXT NOT NULL DEFAULT '[]',  -- JSON [{name, address}]
        message_count      INTEGER NOT NULL DEFAULT 0,
        unread_count       INTEGER NOT NULL DEFAULT 0,
        starred            INTEGER NOT NULL DEFAULT 0,
        in_inbox           INTEGER NOT NULL DEFAULT 0,
        has_attachments    INTEGER NOT NULL DEFAULT 0,
        label_ids          TEXT NOT NULL DEFAULT '[]',  -- JSON, union over messages
        last_message_at    INTEGER NOT NULL DEFAULT 0,
        modseq             INTEGER NOT NULL DEFAULT 0,
        UNIQUE (account_id, provider_thread_id)
      ) STRICT;
      CREATE INDEX thread_recent ON thread (last_message_at DESC);
      CREATE INDEX thread_inbox ON thread (in_inbox, last_message_at DESC);

      CREATE TABLE message (
        id               TEXT PRIMARY KEY,    -- <account>:<provider message id>
        account_id       TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
        thread_id        TEXT NOT NULL REFERENCES thread (id) ON DELETE CASCADE,
        provider_id      TEXT NOT NULL,
        rfc_message_id   TEXT,
        in_reply_to      TEXT,
        refs             TEXT,
        from_json        TEXT NOT NULL DEFAULT 'null',
        to_json          TEXT NOT NULL DEFAULT '[]',
        cc_json          TEXT NOT NULL DEFAULT '[]',
        bcc_json         TEXT NOT NULL DEFAULT '[]',
        reply_to_json    TEXT NOT NULL DEFAULT '[]',
        subject          TEXT NOT NULL DEFAULT '',
        snippet          TEXT NOT NULL DEFAULT '',
        body_text        TEXT NOT NULL DEFAULT '',
        html_blob        TEXT,                -- sha256 into the blob store
        sent_at          INTEGER NOT NULL,
        size             INTEGER NOT NULL DEFAULT 0,
        label_ids        TEXT NOT NULL DEFAULT '[]',
        unread           INTEGER NOT NULL DEFAULT 0,
        starred          INTEGER NOT NULL DEFAULT 0,
        list_unsubscribe TEXT,
        modseq           INTEGER NOT NULL DEFAULT 0,
        UNIQUE (account_id, provider_id)
      ) STRICT;
      CREATE INDEX message_thread ON message (thread_id, sent_at);
      CREATE INDEX message_rfc_id ON message (rfc_message_id);

      CREATE TABLE attachment (
        id                  TEXT PRIMARY KEY,
        message_id          TEXT NOT NULL REFERENCES message (id) ON DELETE CASCADE,
        provider_attachment TEXT,             -- Gmail attachmentId, fetched lazily
        filename            TEXT NOT NULL DEFAULT '',
        mime_type           TEXT NOT NULL DEFAULT 'application/octet-stream',
        size                INTEGER NOT NULL DEFAULT 0,
        content_id          TEXT,
        inline              INTEGER NOT NULL DEFAULT 0,
        blob                TEXT              -- sha256 once fetched
      ) STRICT;
      CREATE INDEX attachment_message ON attachment (message_id);

      CREATE TABLE contact (
        address        TEXT PRIMARY KEY,      -- lower-cased
        name           TEXT,
        last_seen_at   INTEGER NOT NULL,
        received_count INTEGER NOT NULL DEFAULT 0,
        sent_count     INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE TABLE oauth_pending (
        state         TEXT PRIMARY KEY,
        provider      TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        redirect_uri  TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      ) STRICT;

      -- Full-text search over the entire history. Kept in step with message by triggers.
      CREATE VIRTUAL TABLE message_fts USING fts5 (
        subject, people, body, attachments,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER message_fts_insert AFTER INSERT ON message BEGIN
        INSERT INTO message_fts (rowid, subject, people, body, attachments)
        VALUES (new.rowid, new.subject, new.from_json || ' ' || new.to_json || ' ' || new.cc_json, new.body_text, '');
      END;
      CREATE TRIGGER message_fts_update AFTER UPDATE OF subject, body_text, from_json, to_json, cc_json ON message BEGIN
        DELETE FROM message_fts WHERE rowid = old.rowid;
        INSERT INTO message_fts (rowid, subject, people, body, attachments)
        VALUES (new.rowid, new.subject, new.from_json || ' ' || new.to_json || ' ' || new.cc_json, new.body_text, '');
      END;
      CREATE TRIGGER message_fts_delete AFTER DELETE ON message BEGIN
        DELETE FROM message_fts WHERE rowid = old.rowid;
      END;
    `,
  },
  {
    version: 3,
    name: 'drafts',
    sql: `
      -- AMC's own drafts. M1b mirrors each one to a provider draft so it shows up in Gmail;
      -- M4/M8 make the text a live Yjs document.
      CREATE TABLE draft (
        id                  TEXT PRIMARY KEY,
        account_id          TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
        thread_id           TEXT,             -- the Thread it replies to, if any
        provider_draft_id   TEXT,
        provider_message_id TEXT,
        to_json             TEXT NOT NULL DEFAULT '[]',
        cc_json             TEXT NOT NULL DEFAULT '[]',
        bcc_json            TEXT NOT NULL DEFAULT '[]',
        subject             TEXT NOT NULL DEFAULT '',
        body_text           TEXT NOT NULL DEFAULT '',
        in_reply_to         TEXT,
        refs                TEXT,
        last_author         TEXT NOT NULL,    -- 'owner' or the agent token's name
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        modseq              INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX draft_thread ON draft (thread_id);
    `,
  },
]
