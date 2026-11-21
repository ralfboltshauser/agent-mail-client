# Headless Harness proof

## Headless proof on the Mac

On 2026-11-21, Claude Code **2.1.329** and standalone Codex **0.170.0** each ran unattended with the saved subscription login, authenticated to a loopback Streamable HTTP MCP fixture, called its allowed tool and returned the fixture’s random nonce as schema-valid JSON. The fixture recorded only `read_fixture`. Claude reported its initial tool inventory. The Codex subscription run recorded executed calls. The offline probe below captures the model-facing schemas and tests direct dispatch.

This is the Mac portion of [#7](https://github.com/ralfboltshauser/agent-mail-client/issues/7) for [M6](https://github.com/ralfboltshauser/agent-mail-client/issues/30). See the [Host proof](#headless-proof-on-the-host) below.

### Reproduce on the Mac

Run from the checkout with Python 3. The [probe](../../scripts/agent-poc/probe.py) creates and removes its own scratch directory and never contacts the Engine. It binds to a random port on `127.0.0.1`, expects a fixture-only bearer on each POST, verifies an unauthenticated POST gets 401, and advertises `read_fixture` and `blocked_canary`. Only the stub knows the nonce. Both CLIs get a scrubbed environment and closed stdin. A parent enforces 120 seconds using a new process group and kills the group on timeout. The probe tests this timeout with a sleeping child. [Streamable HTTP protocol](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

```sh
export PATH=/opt/homebrew/bin:$HOME/Library/pnpm:$PATH
unset -f node
"$HOME/.local/bin/claude" --version
"$HOME/.local/bin/codex" --version
python3 scripts/agent-poc/probe.py claude
python3 scripts/agent-poc/probe.py codex
python3 scripts/agent-poc/probe.py codex --offline-inventory
```

On this Mac, the `codex` pnpm launcher earlier on PATH failed with `ENOENT` for its 0.125.0 native binary. The proof used `~/.local/bin/codex`, which reported `codex-cli 0.170.0` and `Logged in using ChatGPT`. Claude’s clean-environment `auth status --json` reported `claude.ai` and `firstParty`. Pointing `CLAUDE_CONFIG_DIR` at a fresh directory returned logged out. The approved Claude probe uses the installed path with the existing login and an audited, fixture-only `--mcp-config` file.

#### Claude Code

The exact launch arguments follow. The probe creates `$config` with `{"mcpServers":{"fixture":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer amc-poc-fixture-only"}}}}`. The schema requires one string field called `nonce`. Run the probe for the scrubbed environment and watchdog.

```sh
"$HOME/.local/bin/claude" -p --restricted --setting-sources "" \
  --strict-mcp-config --mcp-config "$config" --tools "" \
  --allowedTools mcp__fixture__read_fixture \
  --disallowedTools mcp__fixture__blocked_canary \
  --permission-mode dontAsk --no-session-persistence \
  --output-format stream-json --verbose --max-turns 5 \
  --json-schema "$schema_json" -- "$prompt"
```

The `init.tools` event contained exactly `StructuredOutput` and `mcp__fixture__read_fixture`. The `result.structured_output` object matched the nonce. `--tools ""` removes default built-ins. `--allowedTools` handles approval, so the denied MCP tool is explicit via `--disallowedTools`. In production, register only permitted tools at the Engine and use `dontAsk` with the per-run allow-list. Managed policy still needs to be checked. SDK target options are `pathToClaudeCodeExecutable`, `settingSources: []`, `strictMcpConfig: true`, `mcpServers`, `tools: []`, `allowedTools`, `permissionMode: "dontAsk"`, `persistSession: false` and `outputFormat`. The SDK mapping needs a separate test on the Host. [Claude CLI flags](https://code.claude.com/docs/en/cli-reference) · [Agent SDK options](https://code.claude.com/docs/en/agent-sdk/typescript)

#### Codex

Set `AMC_POC_BEARER=amc-poc-fixture-only` in the child environment. The fixture’s URL is `$url` and the JSON Schema file is `$schema`.

```sh
"$HOME/.local/bin/codex" -a never exec --ignore-user-config --ignore-rules \
  --ephemeral --skip-git-repo-check --sandbox read-only \
  -c 'forced_login_method="chatgpt"' -c 'web_search="disabled"' \
  -c project_doc_max_bytes=0 -c tools.experimental_request_user_input.enabled=false \
  --disable shell_tool --disable shell_snapshot --disable apps --disable plugins \
  --disable hooks --disable browser_use --disable skill_search \
  --disable skill_mcp_dependency_install --disable view_image \
  --disable multi_agent --disable multi_agent_v2 --disable goals \
  --disable tool_search --disable code_mode --disable code_mode_tool_search \
  -c "mcp_servers.fixture.url=\"$url\"" \
  -c 'mcp_servers.fixture.bearer_token_env_var="AMC_POC_BEARER"' \
  -c 'mcp_servers.fixture.enabled_tools=["read_fixture"]' \
  -c 'mcp_servers.fixture.default_tools_approval_mode="approve"' \
  -c mcp_servers.fixture.required=true --json --output-schema "$schema" -- "$prompt"
```

The JSONL stream contained one completed `mcp_tool_call` for `read_fixture`, text events and `turn.completed`. The last `agent_message` held the nonce object. Without the per-server approval option, the tool was discovered but its call failed under `-a never`. `--ignore-user-config` skips the user’s `config.toml` while preserving shared auth. `--ignore-rules` skips user and project exec rules. Project instruction discovery is separately disabled for this invocation. Use a controlled filesystem view for global instructions, skills and managed policy. [Codex noninteractive mode](https://developers.openai.com/codex/noninteractive/) · [Codex config reference](https://developers.openai.com/codex/config-reference/)

#### Offline Codex result

The loopback model endpoint captures the actual Responses tool schemas and scripts direct shell, file read, `apply_patch`, web and excluded MCP calls. Each must return an unsupported-call result. The read canary must stay out of tool outputs and the write canary must stay absent. An allowed MCP call must return the random nonce.

Codex 0.170.0 passed with `gpt-5.4`, an empty synthetic HOME and a fixture-only key. Each request contained the approved fixture tool and the three MCP resource helpers (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`). No `apply_patch` or deferred discovery appeared in this profile. Patch registration depends on the model. The Host proof below uses the subscription and exercises fixture calls. Model-facing inventory still needs to be checked for the deployed adapter. [Codex 0.170.0 tool registration](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/core/src/tools/spec_plan.rs)

## Headless proof on the Host

On 2026-11-21, both CLIs passed on `ralfs-ubuntu` (Ubuntu 26.04 LTS, x86_64) as Unix user `ralf`, over SSH without a TTY and in a transient systemd user service. Each run made exactly one authenticated `read_fixture` call to a loopback MCP stub and returned its random nonce as valid JSON. The probe verified that the stub rejected a request without its fixture bearer. Claude's init inventory contained only `StructuredOutput` and `mcp__fixture__read_fixture`. Codex recorded the completed fixture call and turn.

| Harness | Version and installed entry point | Auth |
| --- | --- | --- |
| Claude Code | 2.1.329 at `/home/ralf/.local/bin/claude`, symlink to the npm installation's `@anthropic-ai/claude-code/bin/claude.exe` | Saved Claude.ai login. The CLI reported `loggedIn: true`, `authMethod: claude.ai` and `apiProvider: firstParty`. |
| Codex | 0.171.0 at `/home/ralf/.local/bin/codex`, symlink to the standalone installation under `~/.codex/packages/standalone` | Saved ChatGPT login. The CLI reported `Logged in using ChatGPT` and the run forced ChatGPT login. |

Both runs used an allow-listed environment with zero provider API keys. The Claude guard rebuilt that environment before invoking the installed CLI. No Engine endpoint, real mail or AMC token was used. The Host already had both subscriptions set up and systemd user lingering enabled for `ralf` (`Linger=yes`). These runs establish unattended inference with the saved login. Refresh under a narrow credential mount and the production service confinement still need proof.

### Reproduce on the Host

Run from the checkout on the Mac. The commands use the existing Linux installations and Python 3. The proof code is streamed to the Host over SSH. The temporary Claude guard is for this fixture only. The probe checks Claude.ai first-party auth before inference and generates the fixture-only MCP config. The shell removes the mode-0700 temporary directory and guard on exit.

```sh
export PATH=/opt/homebrew/bin:$HOME/Library/pnpm:$PATH
unset -f node 2>/dev/null || true

ssh -T -o BatchMode=yes ralf@ralfs-ubuntu '
  export PATH=/opt/homebrew/bin:$HOME/Library/pnpm:$PATH
  unset -f node 2>/dev/null || true
  "$HOME/.local/bin/codex" --version
  env -i HOME="$HOME" PATH=/usr/bin:/bin "$HOME/.local/bin/codex" login status
'
ssh -T -o BatchMode=yes ralf@ralfs-ubuntu '
  export PATH=/opt/homebrew/bin:$HOME/Library/pnpm:$PATH
  unset -f node 2>/dev/null || true
  python3 - codex
' < scripts/agent-poc/probe.py
ssh -T -o BatchMode=yes ralf@ralfs-ubuntu '
  export PATH=/opt/homebrew/bin:$HOME/Library/pnpm:$PATH
  unset -f node 2>/dev/null || true
  systemd-run --user --pipe --wait --collect /usr/bin/python3 - codex
' < scripts/agent-poc/probe.py

host_probe=$(mktemp -t amc-host-probe)
cat > "$host_probe" <<'HOST'
export PATH=/opt/homebrew/bin:$HOME/Library/pnpm:$PATH
unset -f node 2>/dev/null || true
set -eu
umask 077
proof_dir=$(mktemp -d /tmp/amc-claude-proof.XXXXXX)
trap 'rm -rf -- "$proof_dir"' EXIT
cat > "$proof_dir/probe.py"
cat > "$proof_dir/claude" <<'GUARD'
#!/bin/sh
set -eu
case "${1-}" in
  --version|auth|-p) ;;
  *) exit 64 ;;
esac
exec /usr/bin/env -i HOME="$HOME" USER=ralf LOGNAME=ralf \
  PATH=/usr/bin:/bin TMPDIR=/tmp "$HOME/.local/bin/claude" "$@"
GUARD
chmod 700 "$proof_dir/claude"
"$proof_dir/claude" --version
export AMC_POC_CLAUDE_GUARD="$proof_dir/claude"
python3 "$proof_dir/probe.py" claude
systemd-run --user --pipe --wait --collect \
  --setenv="AMC_POC_CLAUDE_GUARD=$AMC_POC_CLAUDE_GUARD" \
  /usr/bin/python3 "$proof_dir/probe.py" claude
HOST
ssh -T -o BatchMode=yes ralf@ralfs-ubuntu "$(cat "$host_probe")" < scripts/agent-poc/probe.py
rm -f "$host_probe"
```

### What blocks scheduled triage

Keep scheduled triage off. [ADR 0002](../adr/0002-agents-run-through-the-owners-harness.md) requires the owner's existing login, so the Harness runs as `ralf`. The separate service identity in [ADR 0004](../adr/0004-confine-the-agent-runner-on-the-host.md) holds the Engine grant outside that worker. The [Mac triage CLI](../../apps/cli/src/triage.ts) mints a five-minute, Account-limited `read` and `organize` grant using an owner token, runs the forwarder in that same process and starts Claude under the same Unix user. The [current grant endpoint](../../apps/engine/src/http/tokens.ts) requires owner admin and accepts an Account ceiling, with no job or Thread target fields. A service or timer around the CLI would leave those boundaries missing. The [M6 v1 plan](../plan.md#10-milestones) defers the Host launcher, internal grant minting and trusted forwarder.

No owner sign-in is needed today. If a subscription expires or is revoked, the owner signs in again as `ralf` on the Host. For Claude, open `~/.local/bin/claude` through an approved subscription guard and select Claude.ai login. For Codex, use `~/.local/bin/codex login` and complete ChatGPT sign-in. Rerun the synthetic probe for that CLI after login.

Before enabling scheduled triage, the supervisor needs to provision the per-run PID, filesystem and network isolation and the separate-identity forwarder described in the [Host sandbox design](sandbox.md). The Engine must issue a fresh, short-lived grant for the approved Account and job-selected Threads, with only `read` and `organize`, then revoke it when the job ends. Verify refresh, effective tool inventory and the [service-context canaries](sandbox.md#before-enabling-either-adapter) before adding a timer or releasing any mail to a worker.

## Adapter activation

Both adapters start disabled. Test the deployed binary, model and managed settings from the real Host service. Start each session with a synthetic turn and keep the mail prompt and MCP data blocked until its inventory matches the adapter's approved tool set below. Require the [Host canaries](sandbox.md#before-enabling-either-adapter) before activation. A binary, model or policy change invalidates the prior result.

- **Claude Agent SDK:** launch the installed subscription CLI with empty built-ins, strict MCP config and explicit permissions. Require the SDK init inventory to match the job MCP tools plus `StructuredOutput`. Reject hidden or deferred discovery and any missing or unexpected entry. Close the session on mismatch.
- **Codex app-server:** use a sanitized config, read-only command sandbox and explicit tool overrides. Require a complete model-facing inventory from the instrumented launch before releasing mail, including nested and deferred schemas. Disable deferred discovery and fail the check if the Harness exposes a discovery or code execution mechanism, `apply_patch`, or another unexpected capability. Permit the three observed MCP resource helpers only with the sole run forwarder as MCP server and with all `resources/*` requests denied by that forwarder. The adapter stays off if it cannot obtain a complete inventory for the deployed profile.
