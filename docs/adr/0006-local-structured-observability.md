---
status: accepted
---

# Keep structured observability on the machine that produced it

AMC writes typed JSON lines with stable events and request and run IDs. The Engine
writes to stdout for local systemd journald retention. Desktop and Mac CLI clients
use private rotating files under `~/Library/Logs/AMC`. The owner can correlate a
failure across machines using its ID. AMC operates without telemetry services or
network log shipping.

The event registry allows only explicit operational metadata. Error serialization
retains recognized classes and codes, fixed messages, and registered own stack
frames. Owner diagnostics expose a separate status projection. Feedback carries a
local path to a bounded sanitized excerpt. Existing Agent permissions and send
restrictions apply. [ADR 0001](0001-agents-cannot-send-by-construction.md)

## Considered options

- Engine-managed rotating files would duplicate systemd rotation, access control
  and service lifecycle integration. The journal already collects service output.
- A shared telemetry service would simplify cross-machine queries and would create
  a second destination for sensitive operational data. IDs support local
  correlation without that transfer.
- Redacting arbitrary string fields would keep more provider wording. Unmarked
  mail text and credentials cannot reliably be recognized by pattern, so errors
  expose curated metadata and messages.

[Observability spec and rollout](../specs/observability.md)
