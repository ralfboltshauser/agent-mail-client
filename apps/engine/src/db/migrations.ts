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
  {
    version: 4,
    name: 'IMAP message locations and threading',
    sql: `
      ALTER TABLE message ADD COLUMN imap_fingerprint TEXT;
      CREATE UNIQUE INDEX message_imap_content
        ON message (account_id, rfc_message_id, imap_fingerprint) WHERE imap_fingerprint IS NOT NULL;

      CREATE TABLE imap_location (
        account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
        path_key TEXT NOT NULL,
        validity TEXT NOT NULL,
        uid INTEGER NOT NULL,
        message_id TEXT NOT NULL REFERENCES message (id) ON DELETE CASCADE,
        label_id TEXT NOT NULL,
        unread INTEGER NOT NULL,
        starred INTEGER NOT NULL,
        verified INTEGER NOT NULL DEFAULT 1,
        source_blob TEXT,
        PRIMARY KEY (account_id, path_key, validity, uid)
      ) STRICT;
      CREATE INDEX imap_location_folder_message ON imap_location (account_id, path_key, message_id);
      CREATE INDEX imap_location_message ON imap_location (message_id);

      -- Existing IMAP provider IDs are encoded-path:UIDVALIDITY:UID.
      WITH paths AS (
        SELECT m.*, instr(m.provider_id, ':') AS separator
        FROM message m JOIN account a ON a.id = m.account_id WHERE a.kind = 'imap'
      ), parts AS (
        SELECT *, substr(provider_id, separator + 1) AS suffix FROM paths
      )
      INSERT INTO imap_location (account_id, path_key, validity, uid, message_id, label_id, unread, starred, verified)
        SELECT account_id, substr(provider_id, 1, separator - 1),
          substr(suffix, 1, instr(suffix, ':') - 1), CAST(substr(suffix, instr(suffix, ':') + 1) AS INTEGER),
          id, json_extract(label_ids, '$[0]'), unread, starred, 0 FROM parts;

      CREATE TABLE imap_thread_alias (
        account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
        rfc_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES thread (id) ON DELETE CASCADE,
        PRIMARY KEY (account_id, rfc_id)
      ) STRICT;
      CREATE INDEX imap_thread_alias_thread ON imap_thread_alias (thread_id);
      CREATE TABLE imap_thread_subject (
        message_id TEXT PRIMARY KEY REFERENCES message (id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        reply INTEGER NOT NULL,
        has_parent INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX imap_thread_subject_lookup ON imap_thread_subject (account_id, subject, sent_at);
    `,
  },
  {
    version: 5,
    name: 'Index IMAP body prefixes and refresh legacy previews',
    sql: `
      ALTER TABLE message ADD COLUMN body_search_limit INTEGER;

      DROP TRIGGER message_fts_insert;
      DROP TRIGGER message_fts_update;
      CREATE TRIGGER message_fts_insert AFTER INSERT ON message BEGIN
        INSERT INTO message_fts (rowid, subject, people, body, attachments)
        VALUES (new.rowid, new.subject, new.from_json || ' ' || new.to_json || ' ' || new.cc_json,
          coalesce(substr(new.body_text, 1, new.body_search_limit), new.body_text), '');
      END;
      CREATE TRIGGER message_fts_update
        AFTER UPDATE OF subject, body_text, body_search_limit, from_json, to_json, cc_json ON message BEGIN
        DELETE FROM message_fts WHERE rowid = old.rowid;
        INSERT INTO message_fts (rowid, subject, people, body, attachments)
        VALUES (new.rowid, new.subject, new.from_json || ' ' || new.to_json || ' ' || new.cc_json,
          coalesce(substr(new.body_text, 1, new.body_search_limit), new.body_text), '');
      END;

      -- Re-download v4 preview-only locations at the next reconciliation, in place.
      UPDATE message SET imap_fingerprint = NULL WHERE id IN
        (SELECT message_id FROM imap_location WHERE source_blob IS NULL);
      UPDATE imap_location SET verified = 0 WHERE source_blob IS NULL;
    `,
  },
  {
    version: 6,
    name: 'Verify IMAP message and mailbox identity',
    sql: `
      ALTER TABLE imap_location ADD COLUMN envelope TEXT;
      ALTER TABLE imap_location ADD COLUMN rfc822_size INTEGER;

      -- Reprocess each UID independently. A single legacy header fingerprint
      -- may have combined locations that refer to different raw sources.
      UPDATE imap_location SET verified = 0 WHERE message_id IN
        (SELECT id FROM message WHERE imap_fingerprint GLOB 'headers:*');
    `,
  },
  {
    version: 7,
    name: 'Retire IMAP metadata fingerprints',
    sql: `
      ALTER TABLE imap_location DROP COLUMN envelope;
      ALTER TABLE imap_location DROP COLUMN rfc822_size;

      -- Download each UID again because an older EMAILID match may have joined
      -- locations with different sources into the same cached message.
      UPDATE imap_location SET verified = 0 WHERE message_id IN
        (SELECT id FROM message WHERE imap_fingerprint GLOB 'email-id:*');
    `,
  },
  {
    version: 8,
    name: 'organise',
    sql: `
      ALTER TABLE message ADD COLUMN provider_label_ids TEXT;
      ALTER TABLE message ADD COLUMN provider_history_id TEXT;
      ALTER TABLE message ADD COLUMN provider_delivery_history_id TEXT;
      ALTER TABLE message ADD COLUMN first_seen_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE thread ADD COLUMN snoozed_until INTEGER;
      ALTER TABLE thread ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE thread ADD COLUMN snooze_no_reply INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE thread ADD COLUMN snooze_started_at INTEGER;
      ALTER TABLE thread ADD COLUMN organise_state TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE account ADD COLUMN write_epoch INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX thread_snooze ON thread (snoozed_until) WHERE snoozed_until IS NOT NULL;
      CREATE INDEX thread_muted ON thread (muted) WHERE muted = 1;

      CREATE TABLE organise_intent (
        id                 TEXT PRIMARY KEY,
        account_id         TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
        history_id         TEXT NOT NULL,
        checked_history_id TEXT NOT NULL,
        marker_id          TEXT,
        status             TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'done', 'superseded'))
      ) STRICT;
      CREATE TABLE organise_intent_message (
        intent_id  TEXT NOT NULL REFERENCES organise_intent (id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        work       TEXT NOT NULL CHECK (work IN ('suppress', 'wake')),
        status     TEXT NOT NULL CHECK (status IN ('pending', 'done', 'superseded')),
        PRIMARY KEY (intent_id, message_id, work)
      ) STRICT;

      CREATE TABLE mutation (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        id            TEXT NOT NULL UNIQUE,
        principal     TEXT NOT NULL,
        account_id    TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
        thread_id     TEXT NOT NULL,
        request       TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'applied', 'partial', 'failed')),
        error         TEXT,
        modseq        INTEGER NOT NULL DEFAULT 0,
        attempts      INTEGER NOT NULL DEFAULT 0,
        next_attempt  INTEGER NOT NULL DEFAULT 0,
        progress      INTEGER NOT NULL DEFAULT 0,
        prepared      INTEGER NOT NULL DEFAULT 0,
        write_journal TEXT,
        state_patch   TEXT NOT NULL DEFAULT '{}',
        state_before  TEXT NOT NULL DEFAULT '{}',
        intent_id     TEXT REFERENCES organise_intent (id),
        undo_of       TEXT REFERENCES mutation (id)
      ) STRICT;
      CREATE INDEX mutation_intent ON mutation (intent_id);
      CREATE INDEX mutation_pending ON mutation (account_id, seq) WHERE status = 'pending';
      CREATE INDEX mutation_thread_queue ON mutation (thread_id, status, seq);
      CREATE INDEX mutation_undo ON mutation (principal, thread_id, seq);
      CREATE INDEX mutation_failures ON mutation (principal, modseq) WHERE status IN ('failed', 'partial');
      CREATE UNIQUE INDEX mutation_undo_once ON mutation (undo_of) WHERE status != 'failed';
      CREATE TABLE mutation_message (
        mutation_id TEXT NOT NULL REFERENCES mutation (id) ON DELETE CASCADE,
        message_id  TEXT NOT NULL,
        patch       TEXT NOT NULL,
        before      TEXT NOT NULL,
        revisions   TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (mutation_id, message_id)
      ) STRICT;
      CREATE INDEX mutation_message_by_message ON mutation_message (message_id, mutation_id);
    `,
  },
  {
    version: 9,
    name: 'Compose documents and durable outbox',
    sql: `
      ALTER TABLE draft ADD COLUMN yjs BLOB;
      ALTER TABLE draft ADD COLUMN signature TEXT NOT NULL DEFAULT '';
      ALTER TABLE draft ADD COLUMN quote TEXT NOT NULL DEFAULT '';
      ALTER TABLE draft ADD COLUMN mirror_error INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE draft ADD COLUMN mirror_hash TEXT;
      ALTER TABLE draft ADD COLUMN mirror_conflict INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE draft ADD COLUMN queued_send_id TEXT;
      ALTER TABLE draft ADD COLUMN mirror_dirty INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE account ADD COLUMN signature TEXT NOT NULL DEFAULT '';

      CREATE INDEX draft_provider ON draft (account_id, provider_draft_id);

      CREATE TABLE draft_attachment (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES draft (id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        blob TEXT NOT NULL,
        content_id TEXT,
        active INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE INDEX draft_attachment_draft ON draft_attachment (draft_id, active);

      CREATE TABLE draft_mirror_removal (
        account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
        provider_draft_id TEXT NOT NULL,
        mirror_hash TEXT,
        draft_id TEXT NOT NULL,
        PRIMARY KEY (account_id, provider_draft_id)
      ) STRICT;

      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        rfc_id TEXT NOT NULL UNIQUE,
        snapshot TEXT,
        subject TEXT NOT NULL,
        to_json TEXT NOT NULL,
        released_at INTEGER,
        send_at INTEGER NOT NULL,
        undo_until INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','dispatching','sent','cancelled','uncertain','failed')),
        next_at INTEGER NOT NULL,
        reconciles INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        provider_id TEXT,
        thread_id TEXT,
        detail TEXT
      ) STRICT;
      CREATE INDEX outbox_due ON outbox (status, next_at);
      CREATE UNIQUE INDEX outbox_active_draft ON outbox (draft_id)
        WHERE status IN ('queued','dispatching','uncertain','sent') AND released_at IS NULL;
    `,
  },
  {
    version: 10,
    name: 'agent grants and action log',
    sql: `
      ALTER TABLE token ADD COLUMN account_id TEXT;
      ALTER TABLE token ADD COLUMN mutation_minute INTEGER NOT NULL DEFAULT -1;
      ALTER TABLE token ADD COLUMN mutation_count INTEGER NOT NULL DEFAULT 0;
      UPDATE token SET revoked_at = unixepoch() * 1000
        WHERE kind = 'agent' AND revoked_at IS NULL;

      CREATE TABLE agent_action (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        token_id TEXT NOT NULL,
        token_name TEXT NOT NULL,
        tool TEXT NOT NULL,
        threads TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'rejected')),
        error TEXT,
        draft_id TEXT
      ) STRICT;
      ALTER TABLE mutation ADD COLUMN agent_action_id TEXT REFERENCES agent_action (id);
      ALTER TABLE mutation ADD COLUMN agent_message_ids TEXT NOT NULL DEFAULT '[]';
      CREATE INDEX mutation_agent_action ON mutation (agent_action_id) WHERE agent_action_id IS NOT NULL;
    `,
  },
  {
    version: 11,
    name: 'IMAP body blobs',
    sql: 'ALTER TABLE message ADD COLUMN body_parts TEXT',
  },
  {
    version: 12,
    name: 'Thread Buckets',
    sql: `
      ALTER TABLE thread ADD COLUMN bucket TEXT;
      ALTER TABLE thread ADD COLUMN bucket_reason TEXT;
      ALTER TABLE thread ADD COLUMN bucket_set_by TEXT;
      ALTER TABLE thread ADD COLUMN bucket_set_at INTEGER;

      CREATE TABLE imap_bucket_reimport (
        account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
        path_key TEXT NOT NULL,
        identity TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        bucket TEXT NOT NULL,
        bucket_reason TEXT,
        bucket_set_by TEXT,
        bucket_set_at INTEGER,
        PRIMARY KEY (account_id, path_key, identity)
      ) STRICT;
      CREATE INDEX imap_bucket_reimport_thread ON imap_bucket_reimport (account_id, path_key, thread_key);
    `,
  },
  {
    version: 13,
    name: 'IMAP draft content preservation',
    sql: `
      ALTER TABLE draft ADD COLUMN imap_content TEXT;
      ALTER TABLE draft ADD COLUMN mirror_left INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE draft_attachment ADD COLUMN disposition TEXT;
      ALTER TABLE outbox ADD COLUMN original_draft_left INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 14,
    name: 'T3 handoff and Composer Links',
    sql: `
      ALTER TABLE token ADD COLUMN thread_id TEXT;
      CREATE TABLE handoff (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES draft(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES token(id),
        composer_id TEXT NOT NULL REFERENCES token(id),
        t3_thread_id TEXT
      ) STRICT;
      CREATE INDEX handoff_thread ON handoff (thread_id);
      CREATE TRIGGER revoke_removed_handoff BEFORE DELETE ON handoff BEGIN
        UPDATE token SET revoked_at = unixepoch() * 1000
        WHERE id IN (OLD.agent_id, OLD.composer_id) AND revoked_at IS NULL;
      END;
      CREATE TRIGGER revoke_deleted_draft_links BEFORE DELETE ON draft BEGIN
        UPDATE token SET revoked_at = unixepoch() * 1000
        WHERE kind = 'composer' AND subject = OLD.id AND revoked_at IS NULL;
      END;
    `,
  },
]
