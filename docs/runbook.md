# Runbook: the Engine on the Host

## Mac desktop app

On an Apple silicon Mac, run `pnpm install` and `pnpm desktop:install` from the
repository root, then open `~/Applications/AMC.app` in Finder. To update, quit AMC
from the menu bar or with ⌘Q, update the checkout, and rerun those commands. Quit
the electron-vite dev instance before switching to the installed app. Both builds
use the same pairing and SQLite replica in
`~/Library/Application Support/@amc/desktop`.

`pnpm --filter @amc/desktop package` builds both `apps/desktop/dist/mac-arm64/AMC.app`
and `apps/desktop/dist/AMC-<version>-arm64.dmg`. The bundle is signed ad hoc for
local use. If Finder blocks a copy you built, right-click AMC and choose **Open**
if Finder offers the confirmation. On newer macOS versions, try opening AMC,
then use **Open Anyway** under **System Settings → Privacy & Security**.
[Apple's Gatekeeper instructions](https://support.apple.com/en-us/102445)

Both builds use the `@amc/desktop Safe Storage` service. macOS Keychain may ask
whether the new build can use the existing entry. Allow access to carry over the
pairing. If AMC cannot decrypt the saved token, use the pair screen to pair again.
Pairing to the same Engine URL keeps the replica.

Closing the window keeps sync running in the menu bar. **Pause Sync** persists
across restarts. **Launch at Login** is enabled on first run. If macOS requests
approval, use the AMC menu to open Login Items settings or cancel the pending
registration. Desktop upgrades move the previous app bundle to the Trash.

## Layout

| Path | What | Owner |
|---|---|---|
| `/opt/amc/current` | the running release (symlink into `/opt/amc/releases/<sha>`) | root |
| `/opt/amc/node` | the Engine's pinned Node runtime | root |
| `/etc/amc/config.json` | Engine config | `amc`, 600 |
| `/etc/amc/google-oauth-client.json` | Google OAuth client | `amc`, 600 |
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
journalctl -u amc-engine -f        # JSON logs; pipe through `npx pino-pretty` to read
```

## Network

The Engine listens on `127.0.0.1:4410`. `tailscale serve` publishes it on the tailnet only at `https://<host>.<tailnet>.ts.net:4443`. It is never on Funnel. Requests through `tailscale serve` must come from a login listed in `allowedTailscaleLogins`.

M3 ships with Snooze disabled. The Engine reads `features.snooze` from its config at startup. The default is `false`.

## T3 Handoff

1. Set `composerOrigin` in the Engine config to the exact tailnet HTTPS origin, including
   its port and without a trailing slash. Bind the Engine to loopback behind `tailscale serve`
   and list the permitted logins in `allowedTailscaleLogins`. A loopback HTTP origin is
   available for local development.
2. In AMC, open a Thread and choose **Hand off** or press **T**. On first use, paste the
   MCP URL from T3's **Settings → Environments** and approve **Supervised** access.
   Choose the T3 project and launch the handoff.

The launched T3 thread gets a four-hour Agent grant to read the selected Thread and edit
its reply body. The Composer Link in the prompt lasts up to two hours. A new handoff for
the same Thread revokes both previous credentials. Sending or deleting the draft also
revokes its Composer Link. Review and send the reply from AMC desktop.

## Rolling back

`pnpm deploy:host` rolls back by itself when the new release fails to migrate or to become healthy. To go back by hand:

```sh
ls -1t /opt/amc/releases
sudo ln -sfn /opt/amc/releases/<sha> /opt/amc/current && sudo systemctl restart amc-engine
```

A migration that already ran is not undone by a rollback. Restore the `pre-migrate-*.db` copy from `/srv/amc/backups` with the Engine stopped.

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
