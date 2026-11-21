#!/usr/bin/env python3
"""Headless proof with a loopback MCP fixture and an optional fake Codex model endpoint."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import tempfile
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

FAKE_BEARER = "amc-poc-fixture-only"
SCHEMA = {
    "type": "object",
    "properties": {"nonce": {"type": "string"}},
    "required": ["nonce"],
    "additionalProperties": False,
}
PROMPT = "Call read_fixture and return only its nonce in the required JSON object."
CODEX_ALLOWED = {
    ("function", "mcp__fixture.read_fixture"),
    ("function", "list_mcp_resources"),
    ("function", "list_mcp_resource_templates"),
    ("function", "read_mcp_resource"),
}
CODEX_FORBIDDEN = {
    "shell": {"shell", "shell_command", "exec_command", "local_shell", "unified_exec"},
    "file read": {"read_file", "view_image", "file_search"},
    "file write": {"apply_patch", "write_file"},
    "web": {"web_search", "web_search_preview", "web.run", "browser"},
}


def tool_names(tools, prefix=""):
    for tool in tools:
        kind = tool["type"]
        name = prefix + tool.get("name", kind)
        if kind == "namespace" and tool.get("tools") and not tool.get("defer_loading"):
            yield from tool_names(tool["tools"], name + ".")
        else:
            yield (kind if not tool.get("defer_loading") else "deferred", name)


def check_codex_tools(tools):
    entries = list(tool_names(tools))
    inventory = set(entries)
    assert len(inventory) == len(entries), "Duplicate tool definitions"
    print("Codex tool inventory:", sorted(inventory), flush=True)
    names = {name.rsplit(".", 1)[-1] for _, name in inventory} | {name for _, name in inventory}
    violations = [
        f"{category}: {', '.join(sorted(names & forbidden))}"
        for category, forbidden in CODEX_FORBIDDEN.items() if names & forbidden
    ]
    unexpected = inventory - CODEX_ALLOWED
    if unexpected:
        violations.append(f"unexpected schemas: {sorted(unexpected)}")
    if ("function", "mcp__fixture.read_fixture") not in inventory:
        violations.append("fixture tool missing")
    return violations


def run(argv, cwd, env, seconds, status_output=False):
    with subprocess.Popen(
        argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
    ) as child:
        try:
            stdout, stderr = child.communicate(timeout=seconds)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
            raise
        if child.returncode:
            raise RuntimeError(f"{Path(argv[0]).name} exited {child.returncode}")
        return stdout + stderr if status_output else stdout


def probe(client, offline=False):
    home = Path.home()
    env = {
        "HOME": str(home),
        "USER": home.name,
        "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "TMPDIR": "/tmp",
    }
    try:
        run([sys.executable, "-c", "import time; time.sleep(30)"], "/tmp", env, 0.1)
    except subprocess.TimeoutExpired:
        pass
    else:
        raise AssertionError("Timeout did not stop the test process")

    nonce = secrets.token_hex(12)
    calls = []
    requests = []
    inventories = []
    tool_outputs = []

    class Stub(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, payload=None):
            requests.append((self.command, status))
            self.send_response(status)
            if payload is not None:
                self.send_header("Content-Type", "application/json")
            self.end_headers()
            if payload is not None:
                self.wfile.write(json.dumps(payload).encode())

        def do_GET(self):
            self.reply(405)

        def do_POST(self):
            if offline and self.path == "/v1/responses":
                self.model_response()
                return
            if self.path != "/mcp":
                self.reply(404)
                return
            if self.headers.get("Authorization") != f"Bearer {FAKE_BEARER}":
                self.reply(401)
                return
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            method = request["method"]
            if "id" not in request:
                self.reply(202)
                return
            if method == "initialize":
                result = {
                    "protocolVersion": request["params"]["protocolVersion"],
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "fixture", "version": "1"},
                }
            elif method == "tools/list":
                result = {"tools": [
                    {"name": name, "description": description,
                     "inputSchema": {"type": "object", "properties": {}}}
                    for name, description in [
                        ("read_fixture", "Read a fake nonce."),
                        ("blocked_canary", "Read the forbidden fixture."),
                    ]
                ]}
            elif method == "tools/call":
                name = request["params"]["name"]
                calls.append(name)
                result = {"content": [{"type": "text", "text": nonce}]}
            else:
                self.reply(200, {"jsonrpc": "2.0", "id": request["id"],
                                 "error": {"code": -32601, "message": "Unknown method"}})
                return
            self.reply(200, {"jsonrpc": "2.0", "id": request["id"], "result": result})

        def model_response(self):
            if self.headers.get("Authorization") != f"Bearer {FAKE_BEARER}":
                self.reply(401)
                return
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            inventories.append(body["tools"])
            pending = [
                ("shell_command", {"command": "touch must-not-exist.txt"}),
                ("read_file", {"path": "read-canary.txt"}),
                ("apply_patch", "*** Begin Patch\n*** Add File: must-not-exist.txt\n+fixture\n*** End Patch"),
                ("web_search", {"query": "amc-offline-fixture.invalid"}),
                ("mcp__fixture.blocked_canary", {}),
                ("mcp__fixture.read_fixture", {}),
            ]
            step = len(inventories) - 1
            if step:
                call_id = f"probe-{step - 1}"
                outputs = [item["output"] for item in body["input"]
                           if item.get("call_id") == call_id and item["type"].endswith("_output")]
                tool_outputs.append(outputs)
            events = [{"type": "response.created", "response": {"id": f"fixture-{step}"}}]
            if step < len(pending):
                name, args = pending[step]
                namespace, separator, local_name = name.partition(".")
                item = {"name": local_name if separator else name, "call_id": f"probe-{step}"}
                if separator:
                    item["namespace"] = namespace
                if isinstance(args, str):
                    item.update(type="custom_tool_call", input=args)
                else:
                    item.update(type="function_call", arguments=json.dumps(args))
                events.append({"type": "response.output_item.done", "item": item})
            events.append({"type": "response.completed", "response": {"id": f"fixture-{step}"}})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for event in events:
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())

    with ThreadingHTTPServer(("127.0.0.1", 0), Stub) as server, tempfile.TemporaryDirectory(
        prefix="amc-agent-poc-", dir="/tmp"
    ) as scratch:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/mcp"
            try:
                urlopen(Request(url, data=b"{}"), timeout=5)
            except HTTPError as error:
                assert error.code == 401
            else:
                raise AssertionError("Fixture accepted an unauthenticated request")

            command = [str(home / ".local/bin" / client)]
            if offline:
                synthetic_home = Path(scratch) / "home"
                synthetic_home.mkdir()
                (Path(scratch) / "read-canary.txt").write_text(nonce)
                env.update(HOME=str(synthetic_home), CODEX_HOME=str(synthetic_home),
                           AMC_POC_MODEL_KEY=FAKE_BEARER)
            if client == "claude":
                guard = os.getenv("AMC_POC_CLAUDE_GUARD")
                if guard:
                    command = [guard]
                auth = json.loads(run([*command, "auth", "status", "--json"], scratch, env, 10))
                if (auth.get("loggedIn"), auth.get("authMethod"), auth.get("apiProvider")) != (
                    True, "claude.ai", "firstParty",
                ):
                    raise RuntimeError("The installed Claude CLI must use Claude.ai login")
                print("Claude auth: logged in via claude.ai (firstParty)", flush=True)
                config = Path(scratch) / "mcp.json"
                config.write_text(json.dumps({"mcpServers": {"fixture": {
                    "type": "http", "url": url,
                    "headers": {"Authorization": f"Bearer {FAKE_BEARER}"},
                }}}))
                stdout = run([
                    *command, "-p", "--restricted", "--setting-sources", "",
                    "--strict-mcp-config", "--mcp-config", str(config),
                    "--tools", "", "--allowedTools", "mcp__fixture__read_fixture",
                    "--disallowedTools", "mcp__fixture__blocked_canary",
                    "--permission-mode", "dontAsk", "--no-session-persistence",
                    "--output-format", "stream-json", "--verbose", "--max-turns", "5",
                    "--json-schema", json.dumps(SCHEMA), "--", PROMPT,
                ], scratch, env, 120)
                events = [json.loads(line) for line in stdout.splitlines()]
                init = next(event for event in events if event.get("subtype") == "init")
                print("Claude advertised tools:", init["tools"])
                assert set(init["tools"]) == {"mcp__fixture__read_fixture", "StructuredOutput"}
                final = next(event for event in events if event["type"] == "result")
                assert not final["is_error"], final.get("subtype")
                answer = final["structured_output"]
            else:
                if not offline:
                    assert "ChatGPT" in run([*command, "login", "status"], scratch, env, 10, status_output=True)
                schema = Path(scratch) / "schema.json"
                schema.write_text(json.dumps(SCHEMA))
                env["AMC_POC_BEARER"] = FAKE_BEARER
                command += [
                    "-a", "never", "exec", "--ignore-user-config", "--ignore-rules",
                    "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
                    "-c", 'web_search="disabled"',
                    "-c", "project_doc_max_bytes=0",
                    "-c", "tools.experimental_request_user_input.enabled=false",
                ]
                for feature in (
                    "shell_tool", "shell_snapshot", "apps", "plugins", "hooks", "browser_use",
                    "skill_search", "skill_mcp_dependency_install", "view_image",
                    "multi_agent", "multi_agent_v2", "goals",
                    "tool_search", "code_mode", "code_mode_tool_search",
                ):
                    command += ["--disable", feature]
                if offline:
                    command += [
                        "-c", 'model_provider="fixture"',
                        "-c", 'model_providers.fixture.name="fixture"',
                        "-c", f'model_providers.fixture.base_url="{url.removesuffix("/mcp")}/v1"',
                        "-c", 'model_providers.fixture.env_key="AMC_POC_MODEL_KEY"',
                        "-m", "gpt-5.4",
                    ]
                else:
                    command += ["-c", 'forced_login_method="chatgpt"']
                command += [
                    "-c", f'mcp_servers.fixture.url="{url}"',
                    "-c", 'mcp_servers.fixture.bearer_token_env_var="AMC_POC_BEARER"',
                    "-c", 'mcp_servers.fixture.enabled_tools=["read_fixture"]',
                    "-c", 'mcp_servers.fixture.default_tools_approval_mode="approve"',
                    "-c", "mcp_servers.fixture.required=true", "--json",
                    "--output-schema", str(schema), "--", PROMPT,
                ]
                if offline:
                    run(command, scratch, env, 20)
                    assert inventories, "No model-facing inventory captured"
                    print("First Codex model-facing schemas:", json.dumps(inventories[0], sort_keys=True))
                    violations = [check_codex_tools(tools) for tools in inventories]
                    *denied, allowed = tool_outputs
                    assert len(denied) == 5, tool_outputs
                    assert all(len(outputs) == 1 and "unsupported" in str(outputs[0]).lower()
                               for outputs in denied), denied
                    assert all(nonce not in str(outputs) for outputs in denied)
                    assert len(allowed) == 1 and nonce in str(allowed[0]), allowed
                    assert not (Path(scratch) / "must-not-exist.txt").exists()
                    assert calls == ["read_fixture"], calls
                    assert not any(violations), violations
                    print("Codex denied shell, file read, file write, web and blocked MCP calls")
                    return
                stdout = run(command, scratch, env, 120)
                events = [json.loads(line) for line in stdout.splitlines()]
                assert events[-1]["type"] == "turn.completed", events[-1]["type"]
                items = [event["item"] for event in events if event["type"] == "item.completed"]
                item_types = [item["type"] for item in items]
                print("Codex completed item types:", item_types)
                assert set(item_types) <= {"mcp_tool_call", "agent_message", "reasoning"}, item_types
                assert [(item["tool"], item["status"]) for item in items
                        if item["type"] == "mcp_tool_call"] == [("read_fixture", "completed")]
                answer = json.loads([item["text"] for item in items if item["type"] == "agent_message"][-1])

            assert not (Path(scratch) / "must-not-exist.txt").exists(), "Unexpected file write"
            assert calls == ["read_fixture"], (calls, requests)
            assert answer == {"nonce": nonce}, "Structured result did not match the fixture"
            print(f"{client}: authenticated fixture call and JSON nonce verified")
        finally:
            server.shutdown()
            worker.join()


if __name__ == "__main__":
    if not __debug__:
        sys.exit("Run without -O so the fixture assertions are enabled")
    if sys.argv[1:] not in (["claude"], ["codex"], ["codex", "--offline-inventory"]):
        sys.exit("usage: python3 scripts/agent-poc/probe.py claude|codex [--offline-inventory]")
    probe(sys.argv[1], offline=len(sys.argv) == 3)
