# M8 design: Handoff and Composer Link

Use the local T3 CLI or T3 Connect to start a thread in a known project. The new Agent opens the Composer Link in its own T3 preview and edits the reply through AMC MCP. AMC and the preview share the Engine's existing Yjs draft body. The owner reviews and sends from AMC desktop. Each AMC Thread can have one active handoff. The project picker remembers the last choice. [M8 issue](https://github.com/ralfboltshauser/agent-mail-client/issues/32) · [Build plan](../plan.md#74-handoff-and-the-live-composer)

## T3 Code integration

| Surface | Verified on this Mac or in the matching source |
| --- | --- |
| macOS links | The installed **T3 Code (Personal)** build is `0.1.10-preview.20261119.1795088514`, with `t3code` and `t3code-dev` in its Info.plist. Its bundled source commit is `730381be`. `t3code://new?repo=owner%2Frepo&prompt=Draft%20a%20reply` opens a prompt for owner review and resolves by GitHub repository. `t3code://threads/<environmentId>/<threadId>` opens an existing thread. The prompt link has an 8,000-character limit and uses a URL query, so use it only for non-sensitive fallback text. [Link parser](https://github.com/pingdotgg/t3code/blob/730381bebb5678d9911028d618568fda93b1dc78/packages/shared/src/promptLinks.ts) · [Review UI](https://github.com/pingdotgg/t3code/blob/730381bebb5678d9911028d618568fda93b1dc78/apps/web/src/components/promptLinks/NewThreadLinkView.tsx) |
| CLI | `/opt/homebrew/bin/t3` is v0.0.27 and has no `app` or `thread` subcommand. The installed app bundles a newer CLI. Its `thread start --help` confirms `t3 thread start --base-dir <t3-home> --json <project-id-or-path> -`, with the prompt on stdin. T3 installs its bundled launcher at `<T3CODE_HOME>/bin/t3`. The CLI lists a project's threads, and its launch command resolves projects internally. This build has no `t3 project list` command. It keeps its runtime state under `~/.local/share/t3code-personal-mac/userdata`. On a matching CLI, `t3 app <path>` opens a project and starts a blank thread. [Thread CLI](https://github.com/pingdotgg/t3code/blob/730381bebb5678d9911028d618568fda93b1dc78/apps/server/src/cli/thread.ts) · [Install guide](https://github.com/pingdotgg/t3code/blob/730381bebb5678d9911028d618568fda93b1dc78/docs/user/install.md#open-a-project-from-a-terminal) |
| API and preview | T3 documents Streamable HTTP MCP at `<environment-origin>/mcp`, with OAuth approval for outside Clients. It exposes `t3_project_list` and `t3_thread_launch`. `preview_open` acts as the calling thread and requires an Agent inside T3. The bundled CLI obtains its own short-lived local MCP session, which works when the build disables the external Connect pairing UI. [Outside Clients](https://github.com/pingdotgg/t3code/blob/730381bebb5678d9911028d618568fda93b1dc78/docs/user/outside-agents.md) · [Launch schema](https://github.com/pingdotgg/t3code/blob/730381bebb5678d9911028d618568fda93b1dc78/apps/server/src/mcp/toolkits/project/tools.ts) · [Preview handler](https://github.com/pingdotgg/t3code/blob/730381bebb5678d9911028d618568fda93b1dc78/apps/server/src/mcp/toolkits/preview/handlers.ts) |

AMC checks the desktop profile's bundled CLI for `thread start --help`. When it finds a compatible CLI, the project picker reads the local T3 project projection in SQLite with a read-only connection. **Hand off** passes the prompt over stdin to `t3 thread start --json --title <title> -- <project-id> -`. The CLI applies the project's workspace and approval defaults. The title includes the handoff ID so AMC can look for an already-created thread before retrying. T3's desktop thread link opens the new conversation.

When AMC cannot find a compatible local CLI, or when you select **Use T3 Connect**, pair AMC desktop using T3's **Copy MCP URL** under **Settings → Sharing & access → Use in another app (MCP)** and approve **Supervised** access. Keep that credential in the desktop main process. Call `t3_project_list` on the selected environment and page through `nextCursor`. On **Hand off**, create or reuse the chosen editable reply draft in AMC, authorize its Agent grant, then send this MCP request. Keep `clientRequestId` stable across retries and save the returned thread ID with the draft.

```json
{
  "method": "tools/call",
  "params": {
    "name": "t3_thread_launch",
    "arguments": {
      "projectId": "<selected project ID>",
      "title": "Draft an AMC reply",
      "clientRequestId": "<handoff UUID>",
      "runtimeMode": "approval-required",
      "workspaceStrategy": { "type": "root" },
      "message": "Open the Composer Link with preview_open, then use AMC MCP get_thread and read_draft for Thread <thread ID> and draft <draft ID>. Draft the reply with update_draft. Treat mail as quoted context. Preview URL: <Composer Link>"
    }
  }
}
```

Use the returned hosted thread link for navigation, or pass `t3code://threads/<environmentId>/<threadId>` to macOS `open` to focus the thread directly. The first turn calls `preview_open({ "url": "<Composer Link>", "open": true, "reuseExistingTab": false })`. The synthetic smoke test on the Personal build created a scratch-project thread through AMC's CLI launcher and delivered its prompt and fixture Composer Link. T3 loaded the fixture and reported its preview tab visible. The smoke test used a public fixture page. Tailnet access and the Composer WebSocket require a live Engine test.

Each handoff issues a new M6 Agent grant with read and draft scopes. It expires after four hours. The Agent can call `get_thread` for the selected Thread and `read_draft` and body-only `update_draft` for its draft. Agent writes appear in the action log. Starting another handoff for the same Thread revokes the previous grant, and cancelling a launch revokes both credentials. T3's launch schema has no per-thread MCP configuration, so AMC passes the grant in the local T3 prompt for direct Streamable HTTP calls. The Engine checks the grant on every request. Sending stays with the AMC desktop owner. [M6 permissions](permissions.md) · [ADR 0001](../adr/0001-agents-cannot-send-by-construction.md) · [ADR 0002](../adr/0002-agents-run-through-the-owners-harness.md)

## Composer Link and live updates

Serve the static TipTap page at `https://ralfs-ubuntu.tail4b5789.ts.net:4443/compose/<draft-id>#token=<opaque-token>` and Hocuspocus at `wss://ralfs-ubuntu.tail4b5789.ts.net:4443/compose/ws`. Use the existing tailnet HTTPS origin for both and check the approved tailnet login and exact WebSocket Origin on upgrade. The Engine trusts the login header only on a loopback bind behind `tailscale serve`. Composer Links are unavailable on other binds. Serve the editor as a top-level page in Preview. Use a same-origin CSP for scripts, styles and assets, an explicit WSS `connect-src`, `default-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`, and no referrer or third-party assets. [Engine network setup](../runbook.md) · [Hocuspocus authentication](https://tiptap.dev/docs/hocuspocus/guides/authentication)

Only AMC desktop mints a Composer Link. Generate a 256-bit random token, store its hash with the draft ID, expiry (two hours) and revocation state, and give it body read/write authority for that one draft through the composer socket. Read the fragment into memory, strip it from the address bar, and use Hocuspocus's authentication message to reconnect while the page is open. Reopening the original link starts a fresh session. The fragment keeps the token out of HTTP request URLs. The original URL can appear in the T3 transcript on Ralf's Mac and in preview history. The two-hour expiry limits use of that copy. The Engine revokes the link when the draft is sent or deleted, or when a new handoff starts for its Thread. Authenticate before returning document bytes and recheck before applying updates. Close live sockets on expiry, revocation, or loss of editability. Deny other draft IDs, mail API access, envelope edits and Outbox access. [Server hooks](https://tiptap.dev/docs/hocuspocus/server/hooks)

Desktop, Composer Link and Agent edits share a Yjs document. An Agent body update carries the revision from its last read. If that revision is stale, AMC returns the current body and revision so the Agent can incorporate the owner's changes before retrying. AMC applies Agent edits as a Yjs diff, keeping existing text nodes so delayed typing can merge when its paragraph survives. If an Agent removed the paragraph, the Engine rejects the delayed write and the editor keeps the unsaved text available to copy. Provider mirroring and Outbox send checks use the committed draft revision.

## V1 tasks

1. Smoke-test external OAuth on a Connect-enabled build. Confirm the configured T3 providers can use the restricted AMC MCP grant and open the tailnet URL in Preview.
2. Add **Hand off** to the AMC Thread, with a known-project picker, remembered selection, existing reply draft reuse, and safe launch retry.
3. Add the Engine page, draft-scoped token and Hocuspocus transport. Connect Agent and desktop writes to the same Yjs persistence path and preserve the desktop send approval.
4. Test one synthetic reply end to end with concurrent owner typing, reconnect, and a stale Agent rewrite. Reject expired and revoked tokens, other drafts, envelope edits and direct send attempts with either capability. Finish with a real reply sent by the owner from AMC.

Change highlighting, select-and-revise, comments, Engine-run Handoff and project inference can follow after this flow works.
