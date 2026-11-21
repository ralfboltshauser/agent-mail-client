# Confine the Agent runner on the Host

M6 will use the installed Harnesses under the owner’s Unix identity inside a system-managed, per-run filesystem and network boundary. Keep the Engine running as `amc`. Share the minimum working Harness login state under ADR 0002 and let the installed CLIs handle refresh. A run receives its own time-limited, scoped Engine token. The Engine authorizes every mail action.

The owner’s identity is needed to reuse the existing login. A separate login would break the shared-login decision. A Unix user boundary alone leaves the runner with the owner’s files and network access. CLI tool settings reduce what the model can invoke. OS confinement limits what the CLI and its descendants can reach if those settings fail. External Clients remain subject to Engine authorization and the Host caveat in ADR 0003.

Enable an adapter after it passes the Host service-context checks, including refresh with the shared login and blocked access to unrelated credentials and destinations. If shared login and confinement cannot both work, leave that adapter disabled pending a revision of ADR 0002. [Sandbox design](../agents/sandbox.md) · [Permission model](../agents/permissions.md)
