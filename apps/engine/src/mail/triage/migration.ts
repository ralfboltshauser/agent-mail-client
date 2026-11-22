import type { Migration } from '../../db/migrations.ts'

export const triageMigration: Migration = {
  version: 22,
  name: 'Triage confidence and owner corrections',
  sql: `
    ALTER TABLE thread ADD COLUMN bucket_revision TEXT;
    ALTER TABLE thread ADD COLUMN bucket_confidence TEXT CHECK (bucket_confidence IN ('low', 'medium', 'high'));
    ALTER TABLE thread ADD COLUMN bucket_input_revision INTEGER;
    ALTER TABLE thread ADD COLUMN bucket_input_message_id TEXT;
    ALTER TABLE thread ADD COLUMN bucket_producer TEXT;

    -- All Bucket writers, including IMAP reconciliation, invalidate old result metadata.
    CREATE TRIGGER bucket_changed AFTER UPDATE OF bucket ON thread BEGIN
      UPDATE thread SET bucket_revision = lower(hex(randomblob(16))), bucket_confidence = NULL,
        bucket_input_revision = NULL, bucket_input_message_id = NULL, bucket_producer = NULL
      WHERE id = NEW.id;
    END;

    CREATE TABLE triage_correction (
      action_id TEXT PRIMARY KEY REFERENCES owner_action(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      input_revision INTEGER NOT NULL,
      applied_revision TEXT NOT NULL,
      previous TEXT NOT NULL,
      chosen TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      undo_status TEXT CHECK (undo_status IN ('applied', 'superseded'))
    ) STRICT;
    CREATE INDEX triage_examples ON triage_correction(account_id, created_at DESC, action_id DESC)
      WHERE undo_status IS NULL;
    CREATE INDEX thread_triage_low ON thread(account_id, last_message_at DESC, id DESC)
      WHERE in_inbox = 1 AND bucket_confidence = 'low';
  `,
}
