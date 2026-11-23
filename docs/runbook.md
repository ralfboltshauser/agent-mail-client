# Runbook: the Engine on the Host

## Mac desktop app

On an Apple silicon Mac, run `pnpm install` from the repository root. Run
`scripts/create-signing-identity.sh` once to create **AMC Local Code Signing** in
your login Keychain. Then run `pnpm desktop:install` and open
`~/Applications/AMC.app`. To update, quit AMC with ⌘Q, update the checkout, and
rerun `pnpm install` and `pnpm desktop:install`.

If macOS asks whether `codesign` can use **AMC Local Code Signing** during a build,
choose **Allow** for that signing operation. Keep this approval per use because
any process running as your user can invoke `codesign`. The self-signed
certificate works without adding a Keychain trust exception. Keep the same
identity for future builds.

`pnpm --filter @amc/desktop package` builds both `apps/desktop/dist/mac-arm64/AMC.app`
and `apps/desktop/dist/AMC-<version>-arm64.dmg`. Packaging uses the local identity
when present and prints a warning when it falls back to ad hoc signing.
If Finder blocks a copy you built, right-click AMC and choose **Open**
if Finder offers the confirmation. On newer macOS versions, try opening AMC,
then use **Open Anyway** under **System Settings → Privacy & Security**.
[Apple's Gatekeeper instructions](https://support.apple.com/en-us/102445)

The installed app uses the profile at
`~/Library/Application Support/@amc/desktop`. The desktop stores its Engine token
in `credentials/pairing.json`, using the same file
permissions as the CLI (mode `0600` in a `0700` directory). Code running as your
Mac user can read these credentials.

On upgrade, AMC renames an encrypted `pairing.json` in the profile root to
`pairing.json.legacy` and opens the pairing screen. Use the same Engine URL to
keep the local replica. For an unattended first launch or re-pair, quit AMC,
generate a one-time code with `sudo amc-engine pair --desktop` on the Host, and
launch the installed app from the Mac:

```sh
open -a "$HOME/Applications/AMC.app" --args \
  --engine-url=https://your-engine.example:4443 --pairing-code=YOUR-CODE
```

Closing the window keeps sync running in the menu bar. **Pause Sync** persists
across restarts. **Launch at Login** is enabled on first run. If macOS requests
approval, use the AMC menu to open Login Items settings or cancel the pending
registration. Desktop upgrades move the previous app bundle to the Trash.

### Mail triage

In the desktop Inbox, press **T** or choose **Triage Inbox** in the command
palette. Review starts with new Senders and continues with low-confidence
Threads. **Esc** keeps your place for this pairing and Account. **U** undoes
the latest reversible review action. Open **Action history** for queued or
partial writeback and retries. **R** opens the composer and returns to
review when you close it. Hand off uses **Shift+T**.

Desktop review requires an Engine with per-card queue validation. With an
older Engine, the review window shows an upgrade message and offers a retry.
The paired CLI can inspect the same queue with `amc triage queue --json`.

Automatic desktop triage selects unbucketed Inbox threads whose latest
provider-recorded delivery is within 24 hours. It uses Gmail's internalDate
and IMAP's INTERNALDATE. Messages with no recorded delivery time do not count.
Use `amc triage --recent` for the same selection on the CLI.

The desktop and CLI share one Engine lease. A second client skips a run while
the lease is held. The client releases the lease when it finishes, and the
Engine expires leases after ten minutes if release fails.

Desktop main revokes the run's grant by name after the worker exits, including
on crash or timeout. On quit it stops the worker and allows up to three
seconds for cleanup. If revocation cannot reach the Engine, the grant expires
five minutes after minting.

## Development profiles

T3 starts new independent AMC threads in worktrees based on `main` and installs
dependencies from the frozen lockfile before the first turn. If you create a
checkout manually, run `pnpm install --frozen-lockfile`.

Start the desktop app with `pnpm --filter @amc/desktop dev` or the **Desktop dev**
action in T3. Unpackaged builds keep their replica, credentials, feedback, and
logs in `apps/desktop/.amc-dev/` in that checkout. To test an installed build
with a disposable profile, pass an explicit `--user-data-dir=<absolute path>`.
For synthetic mail without pairing, use the [renderer harness](../test/renderer/README.md).

To run a local Engine, create a separate config with a loopback listener on an
unused port and `dataDir`, `blobDir`, `secretsDir`, and `backupDir` under a
dedicated local test directory. Create the secrets directory with mode `0700`
and generate a local encryption key with `(umask 077; openssl rand 32 > /path/to/dev-secrets/key)`.
Run `AMC_CONFIG=/absolute/path/to/dev-config.json pnpm --filter @amc/engine dev`.
Use provider fakes for mail operations.

## Layout

| Path | What | Owner |
|---|---|---|
| `/opt/amc/current` | the running release (symlink into `/opt/amc/releases/<sha>`) | root |
| `/opt/amc/node` | the Engine's pinned Node runtime | root |
| `/etc/amc/config.json` | Engine config | `amc`, 600 |
| `/etc/amc/google-oauth-client.json` | Google OAuth client | `amc`, 600 |
| `/etc/amc/gmail-pubsub-subscriber.json` | Optional Pub/Sub subscriber credential | `amc`, 600 |
| `/srv/amc/db/amc.db` | the database | `amc`, 700 dir |
| `/srv/amc/blobs` | raw mail and attachments (a cache) | `amc`, 700 dir |
| `/srv/amc/backups` | pre-migration and nightly backups | `amc`, 700 dir |

Keep the database, blobs, and backups on the data disk under `/srv/amc`, with systemd unit files and small runtime state allowed on the root disk.

The Engine runs as the `amc` system user so that nothing running as the owner, including coding agents, can read its credentials ([ADR 0003](adr/0003-engine-runs-as-its-own-user.md)).

## Everyday commands

```sh
scripts/provision-host.sh          # from the Mac: set up or repair the Host (idempotent)
pnpm deploy:host                   # from the Mac: check, build, ship, migrate, restart, roll back on failure

sudo amc-engine pair               # on the Host: one-time code for the amc CLI
sudo amc-engine pair --desktop     # on the Host: one-time code for the desktop app
amc pair <code> --engine https://ralfs-ubuntu.tail4b5789.ts.net:4443
amc status

systemctl status amc-engine
journalctl -u amc-engine -f -o cat # local Engine service output
```


For Desktop startup verification, find the latest live marker in the current local
log after launching the new build.

```sh
grep -F 'Engine sync phase: live' "$HOME/Library/Logs/AMC/main.log" | tail -n 1
```

Check that its `ts` follows the launch. If the active file rotated, search
`main.log.1` through `main.log.4`. This replaces the old userData `startup.log`
check. A launch with a separate `--user-data-dir` writes to `logs/main.log` inside
that profile. See the [local observability spec](specs/observability.md#storage-and-retention)
for the Engine journal retention policy and rollout.

## Network

The Engine listens on `127.0.0.1:4410`. `tailscale serve` publishes it on the tailnet only at `https://<host>.<tailnet>.ts.net:4443`. It is never on Funnel. Requests through `tailscale serve` must come from a login listed in `allowedTailscaleLogins`.

Snooze is enabled by default. Set `features.snooze` to `false` to disable it. The Engine keeps the schedule in its database and uses the Account’s archive and Inbox operations. IMAP Accounts need a server-designated Archive folder.

## Gmail notifications

1. From an authenticated machine with permissions on `amc-mail-x097y3`, run
   `scripts/setup-gmail-pubsub.sh`. For manual setup in Google Cloud Console,
   enable the Pub/Sub and IAM APIs, create the `amc-gmail` topic, and grant
   `roles/pubsub.publisher` on that topic to
   `gmail-api-push@system.gserviceaccount.com`. Create a pull subscription named
   `amc-gmail-host` for that topic with expiration set to Never. Create the
   `amc-gmail-subscriber` service account and grant it `roles/pubsub.subscriber`
   on that subscription.
2. The supervisor provisions the subscriber service account's JSON credential
   through the Host secrets workflow as `/etc/amc/gmail-pubsub-subscriber.json`
   (owner `amc:amc`, mode `0600`). The setup script creates only Cloud resources
   and IAM bindings. Gmail's existing mailbox OAuth scope authorizes the watch.
   The subscriber credential authorizes pull and acknowledge independently, so
   existing users keep their Gmail sign-in. In Google Cloud Console, select the
   topic's project and check that the existing Desktop OAuth client ID from
   `/etc/amc/google-oauth-client.json` is listed under **Google Auth Platform →
   Clients**. Gmail requires the watch topic and the OAuth client to belong to
   the same project. [Gmail watch reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch)
3. Add `"gmailPubSubProject": "amc-mail-x097y3"` to `/etc/amc/config.json` and
   restart the Engine. The Host opens outbound HTTPS connections to Pub/Sub.
   Check Engine logs for watch or pull failures. While both are healthy, incremental
   sync runs on notifications with a 60-second fallback for missed notifications.
   On a watch or pull failure, the fallback is 15 seconds.
4. Run `amc status` and confirm that Gmail Pub/Sub is pulling and the Gmail
   Account shows a future watch expiry and a 60-second poll interval. With the
   Account caught up, send a test message from another Account. Verify that
   the receiving Account's last notification time advances and the message
   appears in AMC before the next scheduled poll. Repeat during a fresh poll
   interval if the first delivery coincides with a poll.

To roll back, remove `gmailPubSubProject` and restart the Engine. This restores
15-second polling on restart and stops watch renewal. Gmail can continue to
publish to the topic until the existing remote watch expires.
[Gmail watch expiration](https://developers.google.com/workspace/gmail/api/guides/push#stop_mailbox_updates)

## T3 Handoff

1. Set `composerOrigin` in the Engine config to the exact tailnet HTTPS origin, including
   its port and without a trailing slash. Bind the Engine to loopback behind `tailscale serve`
   and list the permitted logins in `allowedTailscaleLogins`. A loopback HTTP origin is
   available for local development.
2. In AMC, open a Thread and choose **Hand off** or press **T**. On first use, paste the
   MCP URL from T3's **Settings → Environments** and approve **Supervised** access.
   Choose the T3 project and launch the handoff.

T3 credentials use the same private directory in `credentials/t3-pairing.json`.
When AMC next looks up the T3 connection, it moves a legacy encrypted file to
`t3-pairing.json.legacy` in the profile root. Sign in to T3 again to use Handoff.

The launched T3 thread gets a four-hour Agent grant to read the selected Thread and edit
its reply body. The Composer Link in the prompt lasts up to two hours. A new handoff for
the same Thread revokes both previous credentials. Sending or deleting the draft also
revokes its Composer Link. Review and send the reply from AMC desktop.

To work with an open Thread in an existing T3 conversation, choose **Copy thread reference**
in the reader or command palette, or press **⌘⇧C**. Paste the copied command into the
T3 conversation and ask the Agent to run it. It has the form
`amc thread --json -- '<thread-id>'` and contains only the canonical Thread ID.
The T3 environment must have `amc` on its PATH, configured for the same Engine
with existing permission to read that Thread.

## IMAP Draft replacements

AMC reconnects a clean draft to a new UID in the same Drafts folder when
exactly one replacement has the same full message bytes. This also works
after a UIDVALIDITY reset. When the bytes differ or several copies match,
AMC imports the new copies separately and flags the previous draft so you
can compare them.

AMC keeps edits to imported IMAP drafts on the Host. AMC attempts to remove
the original server copy when the owner discards it from the desktop, or
when the composer can faithfully represent the draft and SMTP confirms
acceptance for every recipient. A Sent-folder lookup can confirm that a
message was sent, but provides no per-recipient acceptance evidence.
Removal requires a matching UIDVALIDITY, UID, Draft flag, and full message
hash, plus server support for UID EXPUNGE.

## Rolling back

`pnpm deploy:host` rolls back by itself when the new release fails to migrate or
to become healthy.

Before switching to a release that predates the M9 `backup` command, disable
`amc-backup.timer` and let any running `amc-backup.service` finish:

```sh
sudo systemctl disable --now amc-backup.timer
systemctl is-active amc-backup.service
```

Wait until the backup service is inactive before changing the release. To
switch releases by hand:

```sh
ls -1t /opt/amc/releases
sudo ln -sfn /opt/amc/releases/<sha> /opt/amc/current && sudo systemctl restart amc-engine
```

After the Engine is healthy on an M9-compatible release, run
`sudo systemctl enable --now amc-backup.timer` and check
`systemctl list-timers amc-backup.timer`. On older Engines, `amc doctor` reports
that backup status is unavailable.

A migration that already ran is not undone by a rollback. Restore the `pre-migrate-*.db` copy from `/srv/amc/backups` with the Engine stopped.

## Recovering an unreleased Organise preview database

The unreleased Organise preview at `8926c99` recorded Organise as schema v4.
Released history uses v4 for IMAP message locations. A preview database without
`imap_location` cannot apply the current v5 migration.

Stop the preview Engine and preserve its database and any matching `-wal` and
`-shm` files together. Run this against a copy:

```sh
sqlite3 -readonly /path/to/preview-copy.db <<'SQL'
PRAGMA user_version;
SELECT name FROM sqlite_schema
WHERE type = 'table' AND name IN ('mutation', 'mutation_message', 'imap_location');
SQL
```

A schema version of `4`, with `mutation` and `mutation_message` present and
`imap_location` absent, identifies this preview. If `schema_migration` exists,
its v4 entry is `organise`. A released v4 database has `imap_location`.

Start the current Engine with a fresh database in a separate data directory,
reconnect the provider Accounts and let them sync. Provider-side changes that
already landed will come back through sync. To save preview-only draft text and
envelopes, export them from the copy and recreate those drafts manually:

```sh
(
  umask 077
  export_dir=$(mktemp -d "./amc-preview.XXXXXXXX") || exit 1
  sqlite3 -readonly -json /path/to/preview-copy.db \
    'SELECT account_id, thread_id, to_json, cc_json, bcc_json, subject, body_text FROM draft' \
    > "$export_dir/preview-drafts.json" &&
    printf '%s\n' "$export_dir/preview-drafts.json"
)
```

Keep the original and the export private. Pending mutations and Engine-only
Organise state need to be reapplied by hand. Leave the preview's schema version
and migration records intact.

## Backups and restore

`amc-backup.timer` runs at 03:00 UTC and catches up after downtime. The job
verifies each SQLite snapshot before publishing it as
`/srv/amc/backups/amc-YYYYMMDD.db`. It keeps the 14 newest nightly copies and
the newest remaining copy in each of the eight most recent weeks with a backup
(weeks start on Monday). Pre-migration backups stay in place.

```sh
amc doctor
systemctl list-timers amc-backup.timer
journalctl -u amc-backup.service -n 30
sudo systemctl start amc-backup.service  # make a verified copy now
```

Restore on the Host. Choose the backup by date and wait for any running backup
to finish after stopping the timer.

```sh
sudo systemctl stop amc-backup.timer amc-engine.service
sudo amc-engine restore /srv/amc/backups/amc-YYYYMMDD.db
sudo systemctl start amc-engine.service amc-backup.timer
amc status
```

Restore checks SQLite integrity before replacing the database. It prints the
path of the previous database in `/srv/amc/db` if one existed. Keep that file
until you've checked the restored data. If SQLite cannot close a damaged live
journal, keep the Engine stopped and move `amc.db` and any `amc.db-wal` and
`amc.db-shm` files together to a recovery directory on `/srv/amc`, then retry.
After restoring an older copy, unpair and re-pair the desktop to rebuild its
replica. Unpairing clears pending desktop changes. Pair the CLI again if its
token was issued after the backup. Restored queued and dispatching sends are
marked as uncertain for review in the Outbox because they may already have been
sent or cancelled. Check Sent before retrying them.

Blobs are content-addressed and append-only and stay in `/srv/amc/blobs`. For a
future offsite copy, rsync `/srv/amc` to protected storage and use a verified
backup file for recovery. Keep a separate protected copy of the encryption key
in `/etc/amc/key` so restored credentials can be decrypted.

### Engine diagnostics and journal

Use an owner Client to read `GET /v1/diagnostics`. The snapshot reports
process-local outcomes and counters. A restart resets those observations.
The migration check records its result during startup, and queue depths
are read from SQLite. The journal retains outcomes across restarts. Repeating
failures are coalesced in one-minute windows. The first failure and the
recovery are recorded, and diagnostics counters include coalesced failures.

On the dedicated Host, query the Engine, nightly backups and deploy migration
records locally with `journalctl -u amc-engine.service -u amc-backup.service`
and `journalctl -t amc-migration`. For JSON lines add `-o cat`. Filter the
JSON records by `requestId` or `runId` from the Client Details. Interactive
`amc-engine pair`, `restore`, `backup` and `migrate` commands write their
results to your terminal. Keep pairing codes private.

Provisioning installs `/etc/systemd/journald.conf.d/90-amc-journal.conf`.
The journal is persistent with a 14-day retention limit, daily file rotation
and a 250 MiB system journal limit. The size limit can shorten history.
Expiry removes whole files. Inspect the effective settings using
`systemd-analyze cat-config systemd/journald.conf`. Check that the forwarding
settings are disabled and that only authorized local users have journal access
through root, systemd-journal or distribution-specific ACLs. Check disk use
with `journalctl --disk-usage`.
