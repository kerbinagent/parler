# Initial module contracts

Implementation uses dependency-free ESM on Node 24+, `node:sqlite`, local Unix-socket HTTP, and private HTTPS. Secrets/state live under the selected state directory (0700); socket and credential files are 0600. Public HTTP JSON uses snake_case. Module functions use the signatures below. Errors use `AppError(code, message, status, retryable)` from `src/common.mjs`.

## Storage (`src/store.mjs`)

Export `Store`, constructed with `{ stateDir, nodeId, limits = LIMITS, now = () => Date.now() }`. It owns `stateDir/store.sqlite`, `stateDir/blobs`, and `stateDir/staging`. Methods are synchronous unless explicitly stated otherwise. Session IDs are UUIDs; public session records have `address`, `session_id`, `client_kind`, title/task/project/tags, presence/activity/timestamps/capabilities. `token`, `native_id`, and `workspace` are local only.

- `registerSession({client_kind,native_id,workspace, ...sessionPatch})` returns a local record including `token`; native-kind/id registration is idempotent.
- `authenticateSession(token)` returns its local record or throws 401.
- `getSession(sessionId)`, `updateSession(sessionId, patch)`, `touchSession(sessionId,event)`, `closeSession(sessionId)`.
- `listLocalSessions(peerId?)` returns public records, respecting `visible_peers` when peerId is given.
- `createSnapshot(peerId)` returns `{node_id,revision,published_at,sessions}` with persisted monotonically increasing revision.
- `applySnapshot(peerId,snapshot)` validates owner/records/revision and persists cache; returns `{applied:boolean}`.
- `listSessions({query?,peer?,client_kind?,project?,limit?})` returns `{sessions, truncated}` with freshness and match metadata.
- `reserveBytes(sessionId,totalBytes)` returns a reservation ID; `releaseReservation(id)` releases it.
- `putMessage({direction,envelope,stagedAttachments=[],reservationId})` durably promotes private staging paths and commits metadata; returns `{id,status,attachment_ids,...}`. Direction is `outbox` or `inbox`. Ownership is sender/recipient respectively. Incoming duplicates are idempotent on sender+id and conflicting envelopes throw 409. Each staged attachment is its manifest descriptor plus `path` within store staging. Only receive-ready messages are committed. Host/session storage quotas include reservations and logical retained attachments respectively.
- `receive(sessionId,{limit=20,leaseSeconds=60})` returns `{messages:[{...envelope,delivery_token,retain_until}],...}`.
- `ack(sessionId,messageId,deliveryToken)` returns receipt; valid acknowledgments are idempotent.
- `messageStatus(sessionId,messageId)` returns local message status/attachment metadata without leaking another session's data.
- `getReceipt(peerId,messageId)` returns inbox receipt only for messages sent by that peer.
- `attachment(sessionId,messageId,attachmentId)` returns authorized descriptor plus daemon-local blob `path`, integrity checked. No filesystem paths go in normal network JSON.
- `pendingNotice(sessionId,{event,stop_hook_active=false})` atomically marks previously unannounced pending IDs and returns `{message_ids,attachment_count}`. PostToolUse notifications throttled; Stop no more than one continuation per active hook chain. Notices contain no message text.
- `dueOutbox(limit=20)` returns complete envelopes with `attempts`, `next_attempt_at`, and `status`; queued/retry and persisted_remote records needing receipt reconciliation are included.
- `setDeliveryResult(messageId,{status,error?,retryAt?})` updates own outbox, including attempts/backoff and acknowledgment retention.
- `maintenance()` expires messages, expires delivery leases, cleans orphaned/stale staging and unreferenced blobs after retention. `close()` closes DB.

## Transport (`src/transport.mjs`)

- `readJson(stream, maxBytes)` returns parsed object, enforcing streaming byte limit.
- `readMultipart(stream, contentType, {stagingDir,limits,reserve})` streams envelope first then binary `attachment:<id>` parts, returning `{envelope, stagedAttachments, reservationId}`. `reserve(envelope)` called after validated manifest and before attachment bodies. Enforce envelope/header/part/count/hash/size limits; delete owned staging paths on any error. `reserve` may return a reservation ID; daemon releases reservations on error.
- `multipartBody(envelope, attachments)` returns `{contentType,body}` where body is an async iterable of bounded chunks. Attachments are manifest descriptors plus file `path`.
- `requestPeer(peer,{method='GET',path,body?,contentType?,nodeId,timeoutMs=10000,maxResponseBytes=LIMITS.snapshotBytes})` returns parsed JSON or throws AppError with status/retryability. Peer is `{node_id,endpoint,certificate,token}`. Reject non-private endpoints and redirects; verify exact pinned TLS certificate before writing request body; no proxies. Body may be object or async iterable. Authentication headers `Authorization: Bearer TOKEN`, `X-Parler-Node: NODEID`. Request path fixed by daemon. Never log secrets/body.

## Local daemon routes

Unix socket at `stateDir/daemon.sock`. CLI reads `stateDir/admin.token` for admin calls and `stateDir/bindings/*.json` for a bound session token. All body responses JSON, errors `{error:{code,message,retryable}}` with appropriate status.

Admin token routes:
- `GET /local/info`: public node info `{node_id,label,endpoint,certificate,limits,version}`.
- `POST /local/sessions/register`: native registration input; returns local session including token/workspace.
- `POST /local/peers/export`: `{for_node_id}` returns private invitation `{node_id,label,endpoint,certificate,for_node_id,token}`. Save to file 0600, do not print token.
- `POST /local/peers/import`: invitation object; returns public peer info without token.
- `GET /local/peers`: configured public peers.

Session Bearer token routes:
- `GET /local/session`: current local session.
- `PATCH /local/session`: title/task/project/tags patch.
- `POST /local/session/touch`: `{event}`; observe lifecycle.
- `POST /local/session/close`.
- `GET /local/sessions?query=&client_kind=&project=&peer=&refresh=1`: search/refresh discovery.
- `POST /local/messages`: JSON or multipart. Local envelope input `{to,kind,body:{text},attachments?,reply_to?,conversation_id?,ttl_seconds?}`. Daemon supplies sender/IDs/timestamps; rewrites attachment IDs after upload. Returns queued receipt.
- `GET /local/messages?limit=&wait_seconds=`: lease inbox messages.
- `GET /local/messages/:id`: status.
- `POST /local/messages/:id/ack`: `{delivery_token}`.
- `GET /local/messages/:id/attachments`: authorized manifest/retention.
- `GET /local/messages/:id/attachments/:attachmentId`: verified raw bytes (export via CLI).
- `POST /local/notices`: `{event,stop_hook_active}` returns IDs/count only.

## CLI (`src/cli.mjs`, `src/local-client.mjs`, `bin/parler.mjs`)

Root options `--state` (or PARLER_STATE, default `.parler`), `--session`, `--client`, `--format json` may appear before/after subcommand. `--session` accepts address or native ID; session bindings under `stateDir/bindings` store 0600 JSON records. Resolve explicit binding, PARLER_SESSION, CODEX_THREAD_ID for Codex, CLAUDE_SESSION_ID for Claude Code, or exactly one binding; reject ambiguity. Never print tokens. CLI copies sender file bytes through multipart local API, not daemon-side arbitrary path opening. Full envelope input can be `--json FILE` or JSON stdin; `--text` convenience supports UTF-8 text. Attachment export uses session workspace as allowed root, rejects traversal/symlink/overwrite, and writes exclusively with current process permissions.

Commands: `init [--label --listen --port]`; `daemon [--worker-interval-ms]`; `info`; `peer export --for NODEID --output FILE`; `peer import FILE`; `peer list`; `session register --client KIND --native-id ID [--workspace DIR --title --project-label]`; `session update --title --task-summary --project-label --tag` (repeatable); `session show`; `session close`; `sessions [--query --client-kind --project --peer --refresh]`; `send --to ADDRESS --kind --text [--reply-to --conversation-id --ttl-seconds --attach FILE...]`; `receive [--limit --wait-seconds]`; `ack --message ID --delivery-token TOKEN`; `status --message ID`; `attachments list --message ID`; `attachments export --message ID --attachment ID --output FILE`.

CLI/init invokes root `initState({stateDir,label,listen,port})` from config.mjs. `daemon` invokes `startDaemon({stateDir,workerIntervalMs})` from daemon.mjs. startDaemon returns `{close,networkAddress,socketPath}` and keeps services alive. Main daemon wrapper handles signals.

## Hooks (`src/hooks.mjs`, `bin/parler-hook.mjs`)

Read one bounded JSON object stdin. `--client codex|claude-code` required; `--state`/PARLER_STATE selects daemon. Use local-client exports `localRequest(stateDir,{method,path,body?,token?,timeoutMs=2000})`, `saveBinding(stateDir,session)`, `resolveBinding(stateDir,{session?,client?,cwd?})`, `adminToken(stateDir)`. SessionStart registers/saves binding from hook native ID/cwd; all events touch and get notices. Fixed model guidance includes concrete CLI state/session flags. Include only validated IDs/count in context; no external title/body interpolated. PostToolUse throttles at daemon. Stop decision block with fixed read-inbox reason if fresh IDs and stop_hook_active false. Ignore unknown events. If daemon unavailable/invalid input, exit success with no control output; warnings stderr at most. SessionEnd best-effort closes. Sample configs live in examples/hooks, not restricted .codex/.agents paths. No user/global installation or bypassing hook trust.
