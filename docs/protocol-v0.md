# Parler protocol v0

## Purpose

Let explicitly enrolled Codex, Claude Code, and other tool-capable agent sessions exchange questions, task requests, progress, results, deliverable attachments, and artifact references within the user's private network. The network can include multiple user-owned hosts and multiple sessions per host. Machines may belong to the same tailnet. Communication is asynchronous: a session can send a message while its peer is busy or offline.

The repository implements the daemon, CLI, private HTTPS transport, discovery, attachments, and Codex/Claude Code hooks described here. See the [README](../README.md) for runnable setup. MCP and push controllers remain future extensions. An explicit `tailscale` network mode permits encrypted Tailscale relay fallback; the default `private` mode retains the no-cloud-transport policy. Tests use separate daemon instances on loopback; live client installation and deployment across physical hosts require operator verification.

## Required locality

The default private mode keeps session message transport and storage on user-controlled machines with no cloud broker, relay, mailbox, telemetry, or discovery dependency. Explicit Tailscale mode permits encrypted transport through Tailscale relays while retaining local mailbox/storage and Parler peer authentication. Local transport can operate without internet access after installation. If an approved private path is unavailable, messages remain queued locally until expiry.

Default deployment: explicitly paired LAN/private routed IP endpoints with pinned TLS certificates generated locally. Bind the network listener to the chosen private interface. Restrict daemon egress at the OS/network layer to the approved private paths and peers, without HTTP proxies or redirects. Address syntax alone is insufficient: a private address can still be routed through an external VPN or relay.

Tailscale can route encrypted packets through cloud DERP relays, including while establishing connections and after a direct path fails. A `tailscale ping` or status check only observes a moment in time; it cannot guarantee the path for subsequent packets. Therefore ordinary Tailscale transport and Tailscale Serve are not the strict-local default. A strict-local tailnet deployment would require verified network-level prevention of cloud relay use, or an entirely user-controlled private overlay. Its enforcement mechanism remains to be designed and tested; do not claim strict locality based on polling connection status. The implemented `--network-mode tailscale` option instead accepts relay use explicitly and must not be described as strict-local transport.

Transport locality is separate from model processing. When an agent reads a message through a tool, that content becomes model context. Parler does not make Codex or Claude Code inference offline or promise that model context remains on the LAN. If the requirement includes model processing, a locally hosted model/runtime is a separate requirement.

## Architecture

- One persistent `parlerd` per machine, with a SQLite inbox/outbox and a local immutable attachment store independent of agent process lifetimes. Same-host delivery uses its local Unix socket and store, without Tailscale or peer pairing. An unavailable configured IP does not block local startup; the daemon retries that network listener while local messages remain usable.
- Client-specific command hooks and a shared CLI communicate with the daemon through a Unix socket. A later local MCP adapter can expose the same operations.
- The network API listens on an explicitly chosen private interface with pinned TLS certificates. Local administration stays on a Unix socket.
- Host discovery uses explicitly configured private peer endpoints and offline pairing. Session discovery uses title/task/presence advertisements broadcast directly to authorized paired peers, backed by a local searchable cache; there is no whole-tailnet scan or hosted directory.
- Implementation: dependency-free Node.js 24 ES modules, HTTP/HTTPS servers, and built-in SQLite. Attachment export currently requires Linux with `/proc`. An MCP adapter is not implemented.

The local adapter binds a session credential at startup. The model cannot impersonate a different sender by supplying a `from` field. Hook and CLI invocations resolve a local credential binding keyed by client kind and native session ID; native IDs alone are not credentials. Concurrent sessions in one project must have distinct bindings. Bindings use client kind and native ID explicitly; ambiguous CLI binding selection is rejected. Processes sharing an operating-system account can still read that account's credentials.

## Agent interoperability and multiple hosts

The wire protocol does not contain provider-specific tool calls, transcript formats, or native session IDs. The same message can go from Codex to Claude Code, Claude Code to Codex, or between two sessions of the same client. Each session advertises `client_kind` (`codex`, `claude-code`, or `other`), adapter version, protocol versions, supported message kinds, and delivery modes. Client kind is informational; it is not a permission grant or proof of execution capability.

Keep advertised task capabilities such as `code_review` separate from transport capabilities such as `hook_poll`, `poll`, `push`, and `attachments_v0`. Negotiate compatible protocol/message support and attachment limits before sending. Version 0 requires text messages, Markdown attachment delivery, and hook-triggered inbox checks for both primary clients; optional push delivery cannot be assumed from client kind.

Each daemon keeps a local table mapping paired node IDs to approved private endpoints and credentials. A sender addresses `<node_id>/<session_id>` and the daemon routes directly to that host. Sessions on the same host use local delivery without network forwarding. There is no global broker, transit routing, or multi-hop gossip in version 0. Daemons broadcast their own enrolled session advertisements to authorized paired peers and can refresh through peer listing queries. Listing searches this local cache and reports unavailable/stale hosts explicitly rather than treating their sessions as gone. See [session discovery](discovery-v0.md) for titles, matching, freshness, and announcement semantics.

For example, a Codex implementer on host A can request a review from Claude Code on host B and send the resulting commit reference to a test session on host C. Each destination pair needs an approved private route and pairing. Owning all three hosts does not automatically authorize every session to access every other mailbox or workspace.

Native session lifecycle belongs to the local adapter. Resuming a native conversation binds its existing Parler identity; it does not migrate a transcript or a workspace between hosts. Shared artifact references need independently available repository/filesystem access. Multi-host editing should use separate branches/worktrees and a deliberate merge workflow.

## Session identity and lifecycle

A session address is `<node_id>/<session_id>`, both opaque persistent identifiers generated by Parler. A human alias such as `laptop/reviewer` is a display label, not an authorization identity.

Registration records an alias, session title, short task description, optional project label/tags, client kind, adapter/protocol versions, advertised capabilities, delivery modes, and a private adapter credential. Native Codex thread IDs and Claude Code session IDs remain local adapter metadata. A session's address remains stable when its title or task changes; updates trigger a fresh authorized advertisement.

Adapters heartbeat a renewable lease. Presence is `online`, `stale`, or `closed`; presence does not imply that the model is currently thinking or available to reply. Messages to stale sessions can be queued until expiry. Closed sessions reject new messages. Resuming a session uses its existing credential and address; a new conversation gets a new address. Enrollment is bounded to 256 retained bindings by default. At capacity, an explicitly closed binding with no retained mail or active reservation may be retired; its next native resume enrolls a new address.

## Shared operations available to agents

Expose these operations through the CLI first and optionally through MCP using the tool names below. CLI input should support structured JSON on stdin or a file argument to avoid shell-escaping message bodies.

| Tool | Purpose |
| --- | --- |
| `parler_sessions(peer?, query?, client_kind?, project?)` | Search enrolled sessions by title/task/tags and list candidates with addresses, client type, presence, freshness, and capabilities. |
| `parler_session_update(title?, task_summary?, project_label?, tags?)` | Update the calling session's discovery metadata and advertise it to allowed peers. |
| `parler_send(to, kind, body, attachments?, conversation_id?, reply_to?, ttl_seconds?)` | Persist a message and immutable attachment copies locally; return its ID and delivery status. |
| `parler_receive(limit?, wait_seconds?)` | Fetch pending messages for the adapter's bound session with temporary delivery leases; bounded long polling, at most 30 seconds. |
| `parler_ack(message_id, delivery_token)` | Acknowledge a received message after its contents have been handled or retained in session context. |
| `parler_status(message_id)` | Inspect local persistence, remote persistence, acknowledgment, or expiry. |
| `parler_attachment_list(message_id)` | List attachment IDs, names, types, sizes, hashes, and retention deadlines for an authorized message. |
| `parler_attachment_export(message_id, attachment_id, destination)` | Export a verified local copy into the session's permitted workspace without overwriting existing files. |

SessionStart hooks or explicit CLI registration perform registration and credential binding. Peer pairing and permissions are operator configuration. The CLI provides `parler send`, `parler receive`, and `parler ack`; use `node bin/parler.mjs` directly or install the optional executable links as described in the README. The tool names above describe the operation mapping; no MCP tools are installed.

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

The daemon supplies sender identity, IDs, and timestamps. Maximum encoded envelope size: 64 KiB, including attachment metadata but excluding attachment bytes. Version 0 supports attachments through an optional `attachments` manifest as defined in [attachment delivery](attachments-v0.md). An attachment is a daemon-owned copy delivered with its message. Optional artifact references, such as repository URLs and commit SHAs, remain references and do not transfer bytes. Raw transcript replication and shared mutable files are outside the first milestone.

## Network endpoints and delivery

- `GET /v0/sessions`: authoritative snapshot of advertised sessions visible to the authenticated peer.
- `POST /v0/announcements`: receive an authenticated owner's session snapshot and update the discovery cache as defined in [session discovery](discovery-v0.md).
- `POST /v0/messages`: accept a validated message addressed to a local enrolled session; use JSON for messages without attachments or the multipart format defined in [attachment delivery](attachments-v0.md). Return a durable receipt only after the message and all attachment bytes are stored and verified.
- `GET /v0/messages/{id}/receipt`: let an authorized sender reconcile remote acceptance, acknowledgment, or expiry.
- `GET /v0/info`: version and feature negotiation for authenticated peers.

Sending first persists any attachment copies and commits an outbox row. Background forwarding retries with bounded exponential backoff until the recipient persists the complete message or its TTL expires. HTTP receipt means the recipient committed the inbox row and all verified attachments, not that the agent read or completed the request. Hooks announce only fully committed messages.

Use at-least-once transport with deduplication on authenticated sender and message ID. Reusing an ID with different content is a conflict. Persist deduplication records through message expiry plus a retention margin. Delivery leases prevent simultaneous receivers from routinely consuming the same message; unacknowledged messages become available again after the lease expires. Acknowledgment is idempotent. Successful handling of a request is a separate `result` message.

Track `queued`, `persisted_remote`, `acknowledged`, `expired`, and `rejected` separately. Assign a recipient-local sequence for inbox ordering; do not claim global ordering or exactly-once execution. Requests with side effects need their own idempotency keys at the application layer. Network timeouts leave delivery uncertain and trigger reconciliation/retry, not a false failure report. Both daemons need reasonably synchronized clocks for TTL enforcement. New messages may not be created more than 60 seconds in the future or expire beyond the configured maximum TTL plus that clock allowance, measured at admission.

## Authentication and permissions

Pair daemons with separate directional bearer credentials stored outside Git and model-visible messages. Each credential is bound to a peer node and an explicit set of allowed source/destination sessions. Validate that the authenticated peer owns the claimed sender address. Local session credentials are separate from network peer credentials.

Private-interface binding and firewall rules restrict which devices can reach the service; pinned TLS authenticates peer endpoints; application credentials restrict which sessions they may address. Certificates and credentials are provisioned locally without a public certificate service. Registration and credential administration remain on the local Unix socket. An explicit Tailscale deployment adds tailnet access rules and permits encrypted relay transport; private mode retains the locality requirement.

Treat peer content as external data. A message cannot override the receiving session's instructions, grant filesystem access, approve commands, or expand the user's authorized task. Logs record routing IDs and status by default, excluding credentials and message bodies. Enforce payload limits, rate limits, and bounded queues.

## Hook-first session integration

Only the main agent enrolls and coordinates through Parler. Subagents return delegated work to their parent, which discovers peers, sends requests, receives results, and attaches deliverables. Hooks ignore child identity/role markers; registration rejects explicit child sessions. This workflow rule does not provide operating-system isolation between processes sharing one account.

Hooks integrate ordinary Codex and Claude Code sessions without a controller owning the entire conversation. Their configuration and output serializers are client-specific; the daemon, mailbox protocol, and CLI are shared.

| Lifecycle event | Parler behavior |
| --- | --- |
| `SessionStart` | Register/resume the local binding, publish discovery metadata, and provide fixed CLI usage guidance and an inbox notice. |
| `UserPromptSubmit` | Check locally for new pending messages and add a bounded notice. |
| `PostToolUse` | Check locally while the agent works, throttled to avoid a read after every tool call. |
| `Stop` | If unannounced pending messages exist, request at most one additional pass to inspect them. |
| `SessionEnd` | Best-effort adapter detach; missed cleanup is handled by presence expiry. |

Hooks perform quick local checks only; background forwarding handles the network. Daemon unavailability must not block the user's normal work. Use short explicit hook timeouts, bounded notices, and no inbox draining or acknowledgment inside the hook. The agent fetches message bodies through CLI tool output and acknowledges them after handling. A notice records that a message was announced, not that it was read or completed.

Hook context contains only fixed local guidance and validated routing metadata/message IDs. Do not interpolate peer bodies into developer/system context or Stop continuation prompts. Peer text stays external data retrieved through tool output. Sending/replying is explicit through the CLI; do not broadcast every assistant response or parse transcript text to infer recipients.

Both documented runtimes support context-producing hooks and Stop continuation decisions, but their output behavior differs. In particular, Codex Stop continuation uses `decision: block` with a reason. The serializer must use each installed client's supported format. Honor `stop_hook_active`, track announced message IDs, and enforce an independent continuation budget so pending/unacknowledged mail cannot create an endless loop. Concurrent hook invocations require atomic notice bookkeeping in the daemon.

Hooks run when lifecycle events occur. They do not by themselves guarantee wakeup after a session is already idle. Messages received then remain in the local inbox until the next event or a separately enabled push/controller adapter delivers them. This limitation is an explicit acceptance criterion for the hook-first version.

Before installation, verify the target client's version and hook support, and follow its normal hook trust/configuration flow. Codex requires review/trust of non-managed hook definitions. The repository does not install or enable hooks automatically.

## Optional MCP and automatic delivery

An optional MCP interface lets an agent call `parler_receive` at task boundaries or while waiting for a response. An `AGENTS.md` snippet for Codex and a `CLAUDE.md` snippet for Claude Code can establish the same workflow. Both clients support local stdio MCP servers, so they can share the same tool adapter. Per-session credential binding is required even if MCP configuration is shared across projects. An ordinary MCP tool connection alone is not a promise of unsolicited messages appearing in model context or waking an idle session.

For automatic delivery, add a launcher/controller that owns a Codex app-server session. Official app-server interfaces provide thread start/resume and turn start/steer. Deliver labeled peer data through a tool-output path where supported. Queue while busy by default; any steering mode requires an explicit policy and preserves the external-data boundary. The controller must implement approval handling and normal turn/event lifecycle management.

This adapter is a separate milestone. Do not assume that opening another app-server process can safely attach to and steer an arbitrary session already running in the desktop app, IDE, or terminal. Compatibility with the user's chosen Codex surface must be verified first. Crash recovery at the app-server handoff may redeliver a message, so preserve message IDs in context and retain the at-least-once guarantee.

Claude Code offers two potential automatic-delivery adapters. A custom local channel can push events into an opted-in running session; channels are currently a research preview with availability and allowlist restrictions, so verify the installed client's support before enabling this mode. Alternatively, a controller can own a Claude Agent SDK session, feed queued inputs through its supported input interface, and resume stored sessions by native ID. These SDK features do not imply safe injection into an arbitrary independently running terminal session.

Both adapters read exclusively from their local daemon. A Claude channel for Parler connects to the private mailbox, with no Telegram, Discord, hosted webhook, or cloud session intermediary. Preserve peer identity, message ID, and the external-data boundary in every delivered event. Native push receipt still does not mean work completed. When a controller owns generation, use explicit message-to-turn correlation, one active consumer per session, and bounded reply/wakeup budgets.

## Implementation milestones

Milestones 1–3 have an implementation and automated coverage using local daemon instances. Physical multi-host routing/firewall validation and live client hook setup remain deployment checks. Milestone 4 is future work.

1. Local daemon and CLI: session identity, SQLite persistence, attachment staging/storage/export, inbox leases, acknowledgments, and two-process messaging on one machine.
2. Direct private transport: explicit pairing, pinned HTTPS forwarding with attachments, retries, deduplication, expiry, and restart recovery. Validate on two machines with external network access blocked for the daemons. Strict-local tailnet operation would require an additional verified relay-exclusion design; explicit Tailscale mode permits relay fallback.
3. Hooks and CLI integration: session-bound adapters, title/task advertisements, searchable discovery, and documented inbox workflows for Codex and Claude Code. Demonstrate title-based recipient discovery followed by a research request with an attached Markdown result in both client directions, concurrent sessions in one project, context separation, bounded Stop continuation, and routing across three user-owned hosts.
4. Optional MCP tools and client-specific push adapters: Codex app-server, Claude Code channels where available, and/or a Claude Agent SDK controller. Use bounded wakeups and request budgets to prevent automatic reply loops.

Meaningful acceptance checks include lost HTTP responses after persistence, duplicate retransmission, receiver restart, expired leases, sender spoofing, cross-session access denial, and a complete request/result exchange. Verify direct private routing with packet capture, successful transport while daemon internet access is blocked, and local queueing when the private route fails. A deployment claiming strict-local tailnet operation would also need proof that no message is sent through DERP during startup or after direct connectivity fails; explicit Tailscale mode does not make that claim. Automatic wakeup is not part of the initial acceptance criteria.

Attachment acceptance checks additionally cover sender source-file removal after queueing, truncated/corrupt transfers, lost receipts, atomic message visibility, quota exhaustion, export path/overwrite rejection, session access isolation, retention, and crash recovery. See [attachment delivery](attachments-v0.md) for the detailed contract.

Discovery acceptance checks cover multiple matching titles, title changes with stable addresses, stale host/session data, reordered announcements, visibility filtering, false owner claims, and daemon restart. See [session discovery](discovery-v0.md).

## Primary references

- [Official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): local stdio and HTTP MCP configuration.
- [Official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks) and [Claude Code hooks reference](https://code.claude.com/docs/en/hooks): lifecycle context, Stop continuation, and client-specific hook behavior.
- [Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server): thread and turn lifecycle interfaces for integrations.
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp): local stdio MCP integration.
- [Claude Code channels documentation](https://code.claude.com/docs/en/channels): push delivery to opted-in sessions and research-preview restrictions.
- [Claude Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) and [session management](https://code.claude.com/docs/en/agent-sdk/sessions): controller-owned input and session resumption.
- [Tailscale connection types](https://tailscale.com/docs/reference/connection-types): direct paths, DERP relays, and fallback behavior explaining why tailnet membership does not guarantee local transport.
