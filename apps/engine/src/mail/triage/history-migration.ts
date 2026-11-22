import type { Migration } from '../../db/migrations.ts'

export const historyMigration: Migration = {
  version: 24,
  name: 'Owner triage history and erasure',
  sql: `
    ALTER TABLE owner_action ADD COLUMN legacy_candidate INTEGER NOT NULL DEFAULT 1;
    CREATE TRIGGER legacy_action_cutoff AFTER INSERT ON owner_action
    BEGIN UPDATE owner_action SET legacy_candidate = 0 WHERE id = NEW.id; END;
    CREATE INDEX legacy_action_history ON owner_action(created_at, id) WHERE legacy_candidate = 1
      AND kind IN ('sender:decision', 'sender:restore', 'bucket:review', 'bucket:manual');
    CREATE INDEX legacy_sender_rule_action ON sender_rule(account_id, action_id);
    CREATE INDEX legacy_sender_undo ON owner_action(account_id, undo_token_id, undo_requested_at)
      WHERE kind = 'sender:decision' AND undo_requested_at IS NOT NULL;
    CREATE TABLE triage_bridge (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      cursor_at INTEGER,
      cursor_id TEXT,
      imported INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      complete INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    INSERT INTO triage_bridge (slot) VALUES (1);
    CREATE TABLE triage_forgotten (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE triage_forgotten_action (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE triage_privacy_store (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      ledger_id TEXT NOT NULL,
      purge_pending INTEGER NOT NULL DEFAULT 0,
      receipt_epoch TEXT
    ) STRICT;
  `,
}
