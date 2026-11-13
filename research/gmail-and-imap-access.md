# How should the Engine access Gmail and generic IMAP accounts?

Research for [#3](https://github.com/ralfboltshauser/agent-mail-client/issues/3). Sources checked 2026-11-13.

## Short answer

1. **Gmail accounts use the Gmail API**, not IMAP. Sync uses `history.list` deltas. Push comes from `users.watch` into a Cloud Pub/Sub **pull** subscription, so the Host needs no public endpoint. Requested scope: **`gmail.modify`**, which covers read, labels, drafts and `messages.send`. Avoid `https://mail.google.com/`.
2. **Every self-hoster brings their own Google Cloud OAuth client.** The client's audience is set to External with status **"In production"** and is **never submitted for verification**. The owner clicks through Google's "unverified app" screen once per account. Google explicitly exempts personal use with fewer than 100 users from verification. Do **not** leave the project in "Testing", because refresh tokens there die after 7 days. A Workspace admin can instead mark the project "Internal" for accounts in their own org.
3. **AMC never ships a shared, project-owned Google client ID.** Restricted Gmail scopes plus server-side storage of the data mean restricted-scope verification and an **annual CASA security assessment**. Until that passes, the app also has a **lifetime cap of 100 users**. That is incompatible with "every user self-hosts."
4. **Generic IMAP accounts use `imapflow`** (TypeScript, MIT): IDLE, CONDSTORE and QRESYNC. Sending uses **Nodemailer** over SMTP submission, then an APPEND to Sent where the server doesn't save a copy itself. Watch INBOX with one IDLE connection and poll the other folders with cheap CONDSTORE/STATUS checks. Use NOTIFY (RFC 5465) only if a server advertises it.
5. **Fallback for consumer Gmail:** IMAP plus an **app password**, with no Google Cloud project at all. This is a "quick start" path, not the default. Google says app passwords are "not recommended", and they are often unavailable on Workspace or Advanced Protection accounts. It also loses Gmail-native thread and label semantics, unless the X-GM extensions are used.

## Details

### Gmail API vs IMAP+X-GM for Gmail

| | Gmail API | IMAP + X-GM-EXT-1 |
|---|---|---|
| OAuth scope needed | `gmail.modify` (restricted) suffices for read, labels, send ([scopes][scopes], [messages.send][send]) | **`https://mail.google.com/`**, the broadest restricted scope, is mandatory for IMAP/SMTP XOAUTH2 ([xoauth2][xoauth2]) |
| Incremental sync | `history.list` from a stored `historyId` at 2 quota units per call. History is "usually" kept ≥1 week; a 404 means a full resync ([sync][sync], [quota][quota]) | CONDSTORE per folder. Gmail does not advertise QRESYNC (community reports: [Mozilla bug 912216][bz912216]), so deletions need UID-set diffs |
| Push | `users.watch` → Pub/Sub topic. Supports **push or pull** subscriptions; renew at least every 7 days (Google recommends daily); max 1 notification/sec per user ([push][push]) | IDLE, one mailbox per connection |
| Labels vs folders | Native labels and thread IDs | Labels exposed as folders; `X-GM-LABELS`, `X-GM-THRID` and `X-GM-MSGID` fill the gap ([imap-ext][imapext]) |
| Limits | 1,200,000 units/min per project, 6,000 units/min per user. `messages.get` full costs 60, `messages.send` 100, `watch` 100 ([quota][quota]) | 2,500 MB/day download and 500 MB/day upload per user ([bandwidth][bandwidth]) |

The API is better on every axis. It also needs a **narrower** scope than IMAP, because IMAP on Gmail forces `mail.google.com`. The OAuth burden is equal or lower, so nothing argues for IMAP on Gmail except the no-GCP app-password path.

**Pub/Sub details for a Tailscale-only Host.** Use a **pull** (streaming pull) subscription, which the Gmail push guide explicitly allows ([push][push]). The Engine then connects outbound and needs no public HTTPS webhook. The Pub/Sub topic must grant `publish` to `gmail-api-push@system.gserviceaccount.com` ([push][push]). Pub/Sub's first 10 GiB/month is free, but **a billing account must be linked to the project** to use it ([Pub/Sub pricing][pubsubprice], [free tier][freetier]). Gmail notification volume is tiny and will never leave the free tier, but the self-hoster still has to attach a card. For users who refuse, a degraded mode polls `history.list` every ~10–20 s: 2 units per call, far under 6,000/user/min. The Engine reading the subscription needs its own credential, such as a service-account key in the same project with `roles/pubsub.subscriber`. That is separate from the user's Gmail OAuth token.

**Recommended Gmail sync loop:** initial full sync via `messages.list` plus batched `messages.get` (`format=raw` once, then `minimal` for label refreshes). Store the newest `historyId`. On each Pub/Sub message, or each poll tick, call `history.list(startHistoryId)`. On a 404, run a full resync. Run `watch` daily. ([sync][sync])

### OAuth for a self-hosted OSS app

Facts from Google:

- **All useful Gmail scopes are restricted.** That covers `mail.google.com`, `gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.insert` and `gmail.metadata`. Only `gmail.send` is merely "sensitive" ([scopes][scopes]). Storing or transmitting restricted-scope data on servers requires a security assessment ([scopes][scopes]).
- **CASA** is required for restricted-scope apps, at assurance level AL1 or AL2. "All applications must be revalidated every year." ([security assessment][casa])
- **Verification is not needed** for an app that is "for your personal use (fewer than 100 users)". It is also not needed for development, testing or staging apps, internal Workspace or Cloud Identity apps, or admin-trusted apps ([when not needed][notneeded]).
- **Unverified apps** show the unverified-app warning. Projects requesting unapproved sensitive or restricted scopes have a user cap of 100 new users over the project's lifetime ([audience][audience], [unverified][unverified]).
- **Testing status:** up to 100 listed test users, and "Authorizations by a test user will expire seven days from the time of consent", including refresh tokens ([audience][audience], [oauth2 expiration][oauth2]).
- **Other refresh-token killers:** 6 months unused. A password change, for tokens with Gmail scopes. Revocation. More than 100 refresh tokens per account per client, where the oldest is silently invalidated ([oauth2][oauth2]).

What this means for AMC:

- **Per-owner OAuth client, "In production", unverified.** This fits the personal-use exemption exactly: one human and a handful of their own accounts. Tokens are long-lived, unlike Testing mode. The setup cost is a one-time ~15-minute Google Cloud Console walkthrough, which the onboarding docs must cover: create the project, enable the Gmail and Pub/Sub APIs, configure the consent screen, create a "Web" or "Desktop" OAuth client, publish, link billing, and create the topic, subscription and service account. A `amc setup google` CLI can automate the gcloud-able parts.
- **Consent from a Tailscale-only Host.** Use a loopback redirect, with the OAuth flow run from the desktop app or CLI and the tokens handed to the Engine. Alternatively use a `http://localhost` redirect through an SSH tunnel. Google's OOB flow is long gone, so plan for this in onboarding.
- **Workspace accounts:** if the owner administers the Workspace, set the project's user type to **Internal**. There is then no unverified screen and no cap, but only accounts in that org can authorize. A project can't be Internal and also serve consumer `@gmail.com` accounts, so mixed owners use one External project for everything. Workspace admins can also **block unverified third-party apps** in their API Controls. A self-hoster who is not the admin of their work domain may be stuck: the admin must trust that client ID.
- **Shared AMC client: no.** It would mean verification plus annual CASA, a 100-user lifetime cap until then, and AMC maintainers would be custodians of a credential every self-hoster depends on. Borrowing another client's ID, such as Thunderbird's, is a ToS violation and is not an option.

### Generic IMAP/SMTP

- **Protocols:** IMAP4rev1/rev2 ([RFC 3501][rfc3501], [RFC 9051][rfc9051]). IDLE ([RFC 2177][rfc2177]) is one mailbox per connection; re-issue it before ~29 min. CONDSTORE/QRESYNC ([RFC 7162][rfc7162]) give MODSEQ-based flag deltas, and QRESYNC adds `VANISHED` expunge reporting. NOTIFY ([RFC 5465][rfc5465]) can watch several mailboxes on one connection, but server support is spotty. OAuth over SASL uses XOAUTH2 (Google, Microsoft) or OAUTHBEARER ([RFC 7628][rfc7628]).
- **Multi-folder strategy:**
  - One persistent IDLE connection on INBOX.
  - A second connection that polls the remaining subscribed folders every 1–5 min with `STATUS (HIGHESTMODSEQ UIDNEXT MESSAGES)`, fetching changes only where something moved.
  - QRESYNC when the server offers it; otherwise UID-set diffs for expunges.
  - Stay under typical per-account connection caps by using 2–3 connections, not one per folder.
  - At account add time, record each server's CAPABILITY so the Engine picks its strategy per account.
- **SMTP send:** submission on port 587 with STARTTLS, or 465 implicit TLS. Then IMAP `APPEND` to the Sent special-use folder ([RFC 6154][rfc6154]) unless the provider auto-saves. Gmail does auto-save. Nodemailer handles SMTP submission, including XOAUTH2 auth.

### Libraries

| Language | IMAP | SMTP / MIME | Notes |
|---|---|---|---|
| **TypeScript/Node** | **[imapflow][imapflow]**: MIT, v2.11.0 (2026-11-06), now written in TS. IDLE, CONDSTORE, QRESYNC, COMPRESS, X-GM-EXT-1, XOAUTH2 and OAUTHBEARER (`src/commands/authenticate.ts`) | **[Nodemailer][nodemailer]** (MIT-style), [mailparser][mailparser] | Same author (Postal Systems); actively maintained |
| Node, Gmail API | [`googleapis` / `@googleapis/gmail`][googleapis] (Apache-2.0), [`@google-cloud/pubsub`][pubsubnode] | — | First-party |
| Go | [emersion/go-imap][goimap] (MIT): v2 still beta (`v2.0.0-beta.8`), v1 stable but old | go-message, go-smtp | |
| Rust | [async-imap][asyncimap] (Apache-2.0/MIT, maintained by chatmail/Delta Chat) | lettre, [mail-parser][mailparserrs] | |
| Python | [imapclient][imapclient] | stdlib smtplib/email | |

**EmailEngine is not OSS.** It is "source available" under a commercial license with a 14-day trial, then a paid subscription ([emailengine][emailengine]). It solves exactly this problem: Gmail API, IMAP and Graph behind one REST API with webhooks. But an MIT project can't depend on it, and every self-hoster would need a licence. Use it as a design reference only.

If the Engine is TypeScript, the stack is: **imapflow + Nodemailer + mailparser + googleapis + @google-cloud/pubsub**.

## Open risks

- **Billing-account friction:** Pub/Sub needs a billing-linked project. Mitigation: a `history.list` polling mode at roughly 10–20 s of latency.
- **Google can tighten policy.** The personal-use exemption is a help-center sentence, not a contract. Google has tightened related policy steadily: less-secure-app and basic auth were turned off for Workspace in 2025 ([LSA transition][lsa]). Keep the IMAP and app-password path working as a hedge.
- **Unverified-app screen UX** is scary for new OSS users, so onboarding docs must explain it.
- **Workspace admin blocks:** a non-admin Workspace user may be unable to authorize an unverified client. The only workaround is IMAP with an app password, which is also often disabled there.
- **History window:** "usually ≥1 week". An Engine offline for longer triggers a full resync, so design for it to be cheap (keep raw by message ID).
- **Gmail lacks QRESYNC,** per community reports and unverified against a live CAPABILITY, which I couldn't probe from the research sandbox. This only matters for the app-password IMAP fallback.
- **Generic IMAP servers vary.** Probe the owner's two IMAP servers' CAPABILITY before cutting build tickets.

## Citations

- Gmail API push notifications: https://developers.google.com/workspace/gmail/api/guides/push
- Gmail API sync guide: https://developers.google.com/workspace/gmail/api/guides/sync
- Gmail API quota: https://developers.google.com/workspace/gmail/api/reference/quota
- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- messages.send scopes: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
- Gmail IMAP extensions: https://developers.google.com/workspace/gmail/imap/imap-extensions
- Gmail XOAUTH2: https://developers.google.com/workspace/gmail/imap/xoauth2-protocol
- Gmail bandwidth limits: https://knowledge.workspace.google.com/admin/gmail/gmail-bandwidth-limits
- OAuth 2.0 refresh token expiration: https://developers.google.com/identity/protocols/oauth2
- Manage app audience (Testing vs In production, user cap): https://support.google.com/cloud/answer/15549945
- Unverified apps: https://support.google.com/cloud/answer/7454865
- When verification is not needed: https://support.google.com/cloud/answer/13464323
- Security assessment (CASA): https://support.google.com/cloud/answer/13465431
- App passwords: https://support.google.com/accounts/answer/185833
- LSA to OAuth transition: https://knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth
- Pub/Sub pricing: https://cloud.google.com/pubsub/pricing ; free tier: https://cloud.google.com/free/docs/free-cloud-features
- RFC 3501, 9051, 2177, 7162, 5465, 6154, 7628 (rfc-editor.org)
- Mozilla bug 912216 (Gmail lacks QRESYNC): https://bugzilla.mozilla.org/show_bug.cgi?id=912216
- imapflow https://github.com/postalsys/imapflow · Nodemailer https://github.com/nodemailer/nodemailer · mailparser https://github.com/nodemailer/mailparser · EmailEngine https://github.com/postalsys/emailengine · googleapis https://github.com/googleapis/google-api-nodejs-client · go-imap https://github.com/emersion/go-imap · async-imap https://github.com/chatmail/async-imap · mail-parser https://github.com/stalwartlabs/mail-parser · imapclient https://github.com/mjs/imapclient

[push]: https://developers.google.com/workspace/gmail/api/guides/push
[sync]: https://developers.google.com/workspace/gmail/api/guides/sync
[quota]: https://developers.google.com/workspace/gmail/api/reference/quota
[scopes]: https://developers.google.com/workspace/gmail/api/auth/scopes
[send]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
[imapext]: https://developers.google.com/workspace/gmail/imap/imap-extensions
[xoauth2]: https://developers.google.com/workspace/gmail/imap/xoauth2-protocol
[bandwidth]: https://knowledge.workspace.google.com/admin/gmail/gmail-bandwidth-limits
[oauth2]: https://developers.google.com/identity/protocols/oauth2
[audience]: https://support.google.com/cloud/answer/15549945
[unverified]: https://support.google.com/cloud/answer/7454865
[notneeded]: https://support.google.com/cloud/answer/13464323
[casa]: https://support.google.com/cloud/answer/13465431
[lsa]: https://knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth
[pubsubprice]: https://cloud.google.com/pubsub/pricing
[freetier]: https://cloud.google.com/free/docs/free-cloud-features
[bz912216]: https://bugzilla.mozilla.org/show_bug.cgi?id=912216
[rfc3501]: https://www.rfc-editor.org/rfc/rfc3501
[rfc9051]: https://www.rfc-editor.org/rfc/rfc9051
[rfc2177]: https://www.rfc-editor.org/rfc/rfc2177
[rfc7162]: https://www.rfc-editor.org/rfc/rfc7162
[rfc5465]: https://www.rfc-editor.org/rfc/rfc5465
[rfc6154]: https://www.rfc-editor.org/rfc/rfc6154
[rfc7628]: https://www.rfc-editor.org/rfc/rfc7628
[imapflow]: https://github.com/postalsys/imapflow
[nodemailer]: https://github.com/nodemailer/nodemailer
[mailparser]: https://github.com/nodemailer/mailparser
[emailengine]: https://github.com/postalsys/emailengine
[googleapis]: https://github.com/googleapis/google-api-nodejs-client
[pubsubnode]: https://github.com/googleapis/nodejs-pubsub
[goimap]: https://github.com/emersion/go-imap
[asyncimap]: https://github.com/chatmail/async-imap
[mailparserrs]: https://github.com/stalwartlabs/mail-parser
[imapclient]: https://github.com/mjs/imapclient
