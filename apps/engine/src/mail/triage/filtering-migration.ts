import type { Migration } from '../../db/migrations.ts'

// Provisional until the owner-preferences spec and ADR are agreed.
export const filteringMigration: Migration = {
  version: 23,
  name: 'Learned content filtering (provisional)',
  sql: `
    CREATE TABLE filtered_destination (
      account_id TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
      provider_id TEXT, validity TEXT, mailbox_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('creating', 'ready', 'repair')),
      error TEXT
    ) STRICT;
    ALTER TABLE thread ADD COLUMN filter_suggestion_message_id TEXT;
    ALTER TABLE owner_action ADD COLUMN reason TEXT CHECK (length(reason) <= 500);
    ALTER TABLE message ADD COLUMN list_id TEXT;
    CREATE TABLE triage_prediction (
      id INTEGER PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      message_key TEXT NOT NULL,
      input_revision INTEGER NOT NULL,
      label TEXT NOT NULL,
      confidence TEXT CHECK (confidence IN ('low', 'medium', 'high')),
      version TEXT NOT NULL,
      automatic_action_id TEXT UNIQUE REFERENCES owner_action(id) ON DELETE SET NULL,
      invalidated_at INTEGER,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX triage_prediction_input ON triage_prediction(account_id, message_key, id DESC);
    CREATE TABLE triage_annotation (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL REFERENCES owner_action(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
      thread_id TEXT,
      message_id TEXT,
      message_key TEXT,
      label TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('triage-key', 'thread-action', 'restore-from-filtered', 'undo')),
      prediction_id INTEGER REFERENCES triage_prediction(id) ON DELETE SET NULL,
      error_type TEXT CHECK (error_type IN ('false-positive', 'false-negative')),
      sender_hash TEXT,
      sender_domain TEXT,
      list_id TEXT,
      has_list_unsubscribe INTEGER NOT NULL,
      provider_category TEXT,
      created_at INTEGER NOT NULL,
      superseded_by TEXT
    ) STRICT;
    CREATE INDEX triage_annotations_account ON triage_annotation(account_id, created_at DESC, id DESC);
    CREATE INDEX triage_annotations_message ON triage_annotation(account_id, message_key, created_at DESC);
    CREATE INDEX triage_annotations_action ON triage_annotation(action_id);
  `,
}
