# Parler protocol v0 proposal

## Purpose

Let explicitly enrolled Codex, Claude Code, and other tool-capable agent sessions exchange questions, task requests, progress, results, and artifact references within the user's private network. The network can include multiple user-owned hosts and multiple sessions per host. Machines may belong to the same tailnet. Communication is asynchronous: a session can send a message while its peer is busy or offline.

This is a proposed application protocol. MCP provides the local tool interface; HTTPS transports messages between machines.

## Required locality

Session message transport and storage stay on user-controlled machines. There is no cloud broker, relay, mailbox, telemetry, or discovery dependency. Local transport can operate without internet access after installation. If an approved private path is unavailable, messages remain queued locally until expiry.

Default deployment: explicitly paired LAN/private routed IP endpoints with pinned TLS certificates generated locally. Bind the network listener to the chosen private interface. Restrict daemon egress at the OS/network layer to the approved private paths and peers, without HTTP proxies or redirects. Address syntax alone is insufficient: a private address can still be routed through an external VPN or relay.

Tailscale can route encrypted packets through cloud DERP relays, including while establishing connections and after a direct path fails. A `tailscale ping` or status check only observes a moment in time; it cannot guarantee the path for subsequent packets. Therefore ordinary Tailscale transport and Tailscale Serve are not the strict-local default. An optional tailnet deployment requires verified network-level prevention of cloud relay use, or an entirely user-controlled private overlay. Its enforcement mechanism remains to be designed and tested; do not claim strict locality based on polling connection status.

Transport locality is separate from model processing. When an agent reads a message through a tool, that content becomes model context. This proposal does not make Codex or Claude Code inference offline or promise that model context remains on the LAN. If the requirement includes model processing, a locally hosted model/runtime is a separate requirement.

## Architecture

- One persistent `parlerd` per machine, with a SQLite inbox and outbox independent of agent process lifetimes.
- One local MCP adapter per session, communicating with the daemon through a Unix socket. A CLI exposes the same operations for sessions with shell access.
- The network API listens on an explicitly chosen private interface with pinned TLS certificates. Local administration stays on a Unix socket.
- Initial discovery uses explicitly configured private peer endpoints and offline pairing. Each peer advertises only sessions enrolled for that pairing; there is no whole-tailnet scan or hosted directory.
- Suggested implementation: TypeScript with the official MCP SDK, an HTTP server, and SQLite. Library versions and client compatibility should be checked when implementation starts.

The local adapter binds a session credential at startup. The model cannot impersonate a different sender by supplying a `from` field.

## Agent interoperability and multiple hosts

The wire protocol does not contain provider-specific tool calls, transcript formats, or native session IDs. The same message can go from Codex to Claude Code, Claude Code to Codex, or between two sessions of the same client. Each session advertises `client_kind` (`codex`, `claude-code`, or `other`), adapter version, protocol versions, supported message kinds, and delivery modes. Client kind is informational; it is not a permission grant or proof of execution capability.

Keep advertised task capabilities such as `code_review` separate from transport capabilities such as `poll` and `push`. Negotiate compatible protocol/message support before sending. Version 0 requires text messages and cooperative polling for both primary clients; optional push delivery cannot be assumed from client kind.

Each daemon keeps a local table mapping paired node IDs to approved private endpoints and credentials. A sender addresses `<node_id>/<session_id>` and the daemon routes directly to that host. Sessions on the same host use local delivery without network forwarding. There is no global broker, transit routing, or gossip in version 0. Listing all peers queries configured reachable hosts and reports unavailable hosts explicitly rather than treating their sessions as gone. Discovery results can be cached with freshness timestamps.

For example, a Codex implementer on host A can request a review from Claude Code on host B and send the resulting commit reference to a test session on host C. Each destination pair needs an approved private route and pairing. Owning all three hosts does not automatically authorize every session to access every other mailbox or workspace.

Native session lifecycle belongs to the local adapter. Resuming a native conversation binds its existing Parler identity; it does not migrate a transcript or a workspace between hosts. Shared artifact references need independently available repository/filesystem access. Multi-host editing should use separate branches/worktrees and a deliberate merge workflow.

## Session identity and lifecycle

A session address is `<node_id>/<session_id>`, both opaque persistent identifiers generated by Parler. A human alias such as `laptop/reviewer` is a display label, not an authorization identity.

Registration records an alias, optional project label, client kind, adapter/protocol versions, advertised capabilities, delivery modes, and a private adapter credential. Native Codex thread IDs and Claude Code session IDs remain local adapter metadata.

Adapters heartbeat a renewable lease. Presence is `online`, `stale`, or `closed`; presence does not imply that the model is currently thinking or available to reply. Messages to stale sessions can be queued until expiry. Closed sessions reject new messages. Resuming a session uses its existing credential and address; a new conversation gets a new address.

## Shared tools available to agents

| Tool | Purpose |
| --- | --- |
| `parler_sessions(peer?)` | List enrolled sessions and their presence/capabilities. |
| `parler_send(to, kind, body, conversation_id?, reply_to?, ttl_seconds?)` | Persist a message locally and return its ID and delivery status. |
| `parler_receive(limit?, wait_seconds?)` | Fetch pending messages for the adapter's bound session with temporary delivery leases; bounded long polling, at most 30 seconds. |
| `parler_ack(message_id, delivery_token)` | Acknowledge a received message after its contents have been handled or retained in session context. |
| `parler_status(message_id)` | Inspect local persistence, remote persistence, acknowledgment, or expiry. |

The launcher performs registration and credential binding. Peer pairing and permissions are operator configuration. A CLI might use `parler send`, `parler receive`, and `parler ack`; these are proposed commands, not installed commands.

Example workflow: A discovers `desktop/reviewer`, sends a `request` describing a review, and keeps working. B receives it, acknowledges receipt, and replies with `kind: result` and `reply_to` referencing the request. A receives the result at its next inbox check.

## Message envelope

```json
{
  "protocol": "parler/0",
  "id": "018f-example-message-id",
  "conversation_id": "review-42",
  "from": "node-a/session-a",
  "to": "node-b/session-b",
  "kind": "request",
  "reply_to": null,
  "created_at": "2026-10-02T02:00:00Z",
  "expires_at": "2026-10-02T03:00:00Z",
  "body": { "text": "Review commit abc123 for concurrency bugs." }
}
```

Message and conversation IDs are UUIDs in the implementation; the example uses readable placeholders. Supported kinds are `message`, `request`, `progress`, `result`, and `error`. A request describes proposed work; it does not automatically authorize execution. A reply references an existing message in the same conversation.

The daemon supplies sender identity, IDs, and timestamps. Maximum encoded envelope size: 64 KiB. Version 0 accepts text plus optional artifact references, such as a repository URL, commit SHA, path, and content hash. Artifact references do not transfer files or guarantee that the other machine has access. Raw transcripts and file transfer are outside the first milestone.

## Network endpoints and delivery

- `GET /v0/sessions`: advertised sessions visible to the authenticated peer.
- `POST /v0/messages`: accept a validated message addressed to a local enrolled session; return a durable receipt.
- `GET /v0/messages/{id}/receipt`: let an authorized sender reconcile remote acceptance, acknowledgment, or expiry.
- `GET /v0/info`: version and feature negotiation for authenticated peers.

Sending first commits an outbox row. Background forwarding retries with exponential backoff and jitter until the recipient persists the message or its TTL expires. HTTP receipt means the recipient committed the inbox row, not that Codex read or completed the request.

Use at-least-once transport with deduplication on authenticated sender and message ID. Reusing an ID with different content is a conflict. Persist deduplication records through message expiry plus a retention margin. Delivery leases prevent simultaneous receivers from routinely consuming the same message; unacknowledged messages become available again after the lease expires. Acknowledgment is idempotent. Successful handling of a request is a separate `result` message.

Track `queued`, `persisted_remote`, `acknowledged`, `expired`, and `rejected` separately. Assign a recipient-local sequence for inbox ordering; do not claim global ordering or exactly-once execution. Requests with side effects need their own idempotency keys at the application layer. Network timeouts leave delivery uncertain and trigger reconciliation/retry, not a false failure report. Both daemons need reasonably synchronized clocks for TTL enforcement.

## Authentication and permissions

Pair daemons with separate directional bearer credentials stored outside Git and model-visible messages. Each credential is bound to a peer node and an explicit set of allowed source/destination sessions. Validate that the authenticated peer owns the claimed sender address. Local session credentials are separate from network peer credentials.

Private-interface binding and firewall rules restrict which devices can reach the service; pinned TLS authenticates peer endpoints; application credentials restrict which sessions they may address. Certificates and credentials are provisioned locally without a public certificate service. Registration and credential administration remain on the local Unix socket. A separately verified tailnet deployment can add tailnet access rules but must still enforce the locality requirement.

Treat peer content as external data. A message cannot override the receiving session's instructions, grant filesystem access, approve commands, or expand the user's authorized task. Logs record routing IDs and status by default, excluding credentials and message bodies. Enforce payload limits, rate limits, and bounded queues.

## How messages reach a thinking session

The first milestone supports cooperative inbox checks: the agent calls `parler_receive` at task boundaries or while waiting for a response. An `AGENTS.md` snippet for Codex and a `CLAUDE.md` snippet for Claude Code can establish the same workflow. Both clients support local stdio MCP servers, so they can share the same tool adapter. Per-session credential binding is required even if MCP configuration is shared across projects. An ordinary MCP tool connection alone is not a promise of unsolicited messages appearing in model context or waking an idle session.

For automatic delivery, add a launcher/controller that owns a Codex app-server session. Official app-server interfaces provide thread start/resume and turn start/steer. Deliver labeled peer data through a tool-output path where supported. Queue while busy by default; any steering mode requires an explicit policy and preserves the external-data boundary. The controller must implement approval handling and normal turn/event lifecycle management.

This adapter is a separate milestone. Do not assume that opening another app-server process can safely attach to and steer an arbitrary session already running in the desktop app, IDE, or terminal. Compatibility with the user's chosen Codex surface must be verified first. Crash recovery at the app-server handoff may redeliver a message, so preserve message IDs in context and retain the at-least-once guarantee.

Claude Code offers two potential automatic-delivery adapters. A custom local channel can push events into an opted-in running session; channels are currently a research preview with availability and allowlist restrictions, so verify the installed client's support before enabling this mode. Alternatively, a controller can own a Claude Agent SDK session, feed queued inputs through its supported input interface, and resume stored sessions by native ID. These SDK features do not imply safe injection into an arbitrary independently running terminal session.

Both adapters read exclusively from their local daemon. A Claude channel for Parler connects to the private mailbox, with no Telegram, Discord, hosted webhook, or cloud session intermediary. Preserve peer identity, message ID, and the external-data boundary in every delivered event. Native push receipt still does not mean work completed. When a controller owns generation, use explicit message-to-turn correlation, one active consumer per session, and bounded reply/wakeup budgets.

## Implementation milestones

1. Local daemon and CLI: session identity, SQLite persistence, inbox leases, acknowledgments, and two-process messaging on one machine.
2. Direct private transport: explicit pairing, pinned HTTPS forwarding, retries, deduplication, expiry, and restart recovery. Validate on two machines with external network access blocked for the daemons. Any optional tailnet mode requires an additional verified relay-exclusion design.
3. MCP tools: session-bound adapters and documented cooperative inbox workflows for Codex and Claude Code. Demonstrate Codex-to-Claude Code and Claude Code-to-Codex request/result exchanges, plus routing across three user-owned hosts.
4. Optional client-specific delivery adapters: Codex app-server, Claude Code channels where available, and/or a Claude Agent SDK controller. Use bounded wakeups and request budgets to prevent automatic reply loops.

Meaningful acceptance checks include lost HTTP responses after persistence, duplicate retransmission, receiver restart, expired leases, sender spoofing, cross-session access denial, and a complete request/result exchange. Verify direct private routing with packet capture, successful transport while daemon internet access is blocked, and local queueing when the private route fails. A tailnet deployment must also prove that no message is sent through DERP during startup or after direct connectivity fails. Automatic wakeup is not part of the initial acceptance criteria.

## Primary references

- [Official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): local stdio and HTTP MCP configuration.
- [Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server): thread and turn lifecycle interfaces for integrations.
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp): local stdio MCP integration.
- [Claude Code channels documentation](https://code.claude.com/docs/en/channels): push delivery to opted-in sessions and research-preview restrictions.
- [Claude Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) and [session management](https://code.claude.com/docs/en/agent-sdk/sessions): controller-owned input and session resumption.
- [Tailscale connection types](https://tailscale.com/docs/reference/connection-types): direct paths, DERP relays, and fallback behavior explaining why tailnet membership does not guarantee local transport.
