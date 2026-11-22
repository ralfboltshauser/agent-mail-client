import type { Migration } from '../../db/migrations.ts'

export const filteringMigration: Migration = {
  version: 23,
  name: 'Owner triage decision log',
  sql: `
    CREATE TABLE filtered_destination (
      account_id TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
      provider_id TEXT, validity TEXT, mailbox_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('creating', 'ready', 'repair')),
      error TEXT
    ) STRICT;
    ALTER TABLE thread ADD COLUMN filter_suggestion_message_id TEXT;
    ALTER TABLE message ADD COLUMN list_id TEXT;
    ALTER TABLE imap_location ADD COLUMN arrival_key TEXT;
    UPDATE imap_location SET arrival_key = lower(hex(randomblob(16)));
    CREATE TRIGGER imap_location_arrival AFTER INSERT ON imap_location
    WHEN NEW.arrival_key IS NULL BEGIN
      UPDATE imap_location SET arrival_key = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
    END;
    ALTER TABLE account ADD COLUMN mailbox_generation INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE thread ADD COLUMN filter_suggestion_event_id TEXT;
    ALTER TABLE screening_work ADD COLUMN prediction_id TEXT;
    CREATE UNIQUE INDEX screening_prediction_message ON screening_work(prediction_id, message_id);
    CREATE TABLE triage_key (
      version INTEGER PRIMARY KEY, secret BLOB NOT NULL CHECK(length(secret) = 32)
    ) STRICT;
    INSERT INTO triage_key VALUES (1, randomblob(32));
    CREATE TABLE triage_event (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      account_generation INTEGER NOT NULL,
      axis TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      arrival_key TEXT,
      input_revision INTEGER,
      kind TEXT NOT NULL CHECK (kind IN
        ('prediction','decision','undo','reason_revised','review_observed')),
      source TEXT NOT NULL,
      taxonomy_version INTEGER NOT NULL,
      label_id TEXT,
      created_at INTEGER NOT NULL,
      action_id TEXT,
      run_id TEXT,
      target_event_id TEXT,
      prediction_id TEXT,
      confidence TEXT CHECK (confidence IN ('low','medium','high')),
      policy_version_id TEXT,
      matched_rule_revision_id TEXT,
      harness_id TEXT,
      model_id TEXT,
      adapter_version TEXT,
      prompt_version TEXT,
      features_json TEXT NOT NULL CHECK (json_valid(features_json)),
      detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
      dedupe_key TEXT NOT NULL UNIQUE,
      CHECK (axis IN ('bucket', 'filter', 'sender', 'attention')),
      CHECK (kind != 'prediction' OR (run_id IS NOT NULL AND arrival_key IS NOT NULL
        AND input_revision IS NOT NULL AND target_event_id IS NULL AND action_id IS NULL)),
      CHECK (kind != 'decision' OR (label_id IS NOT NULL AND action_id IS NOT NULL)),
      CHECK (kind NOT IN ('undo', 'reason_revised', 'review_observed') OR
        (target_event_id IS NOT NULL AND label_id IS NULL))
    ) STRICT;

    -- Content-bearing data is separately erasable. One row per event at most.
    CREATE TABLE triage_owner_reason (
      event_id TEXT PRIMARY KEY REFERENCES triage_event(id),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500)
    ) STRICT;

    CREATE INDEX triage_subject ON triage_event
      (account_id, account_generation, axis, subject_key, seq DESC);
    CREATE INDEX triage_replay ON triage_event (account_id, kind, created_at, seq);
    CREATE INDEX triage_action ON triage_event (action_id);
    CREATE INDEX triage_target ON triage_event (target_event_id);
    CREATE INDEX triage_prediction_reference ON triage_event (prediction_id);
    CREATE TABLE triage_request_fingerprint (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER triage_event_no_update BEFORE UPDATE ON triage_event
    BEGIN SELECT RAISE(ABORT, 'Triage events are immutable'); END;
    CREATE INDEX triage_event_examples ON triage_event
      (account_id, account_generation, kind, axis, seq DESC);
    CREATE INDEX triage_feature_sender ON triage_event
      (account_id, account_generation, (features_json ->> 'senderHash')) WHERE kind = 'decision';
    CREATE INDEX triage_feature_list ON triage_event
      (account_id, account_generation, (features_json ->> 'listId')) WHERE kind = 'decision';
    CREATE INDEX triage_feature_domain ON triage_event
      (account_id, account_generation, (features_json ->> 'domain')) WHERE kind = 'decision';
    CREATE INDEX triage_run ON triage_event (run_id, arrival_key, seq) WHERE kind = 'prediction';
  `,
}
