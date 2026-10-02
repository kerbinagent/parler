# Attachment delivery v0

The v0 implementation is included in this repository. Use the [README](../README.md) for runnable examples and current deployment limitations. Only main sessions coordinate Parler; subagents return work to their parent.

## Research request and result

A session on host A requests research from a session on host B. B writes `research.md` with findings and sources, then sends a `result` message replying to the request with that file attached. B's daemon stores its own immutable copy before accepting the send. A's daemon receives the message and attachment, verifies and stores both, and makes the complete result available locally. A can export the Markdown into its workspace and acknowledge the message after handling it.

This works across Codex and Claude Code through the same CLI and hook workflow. It does not depend on a shared filesystem, a hosted file service, B remaining online after delivery, or the source file remaining unchanged after staging.

```mermaid
sequenceDiagram
    participant A as Requesting session
    participant DA as Daemon A
    participant DB as Daemon B
    participant B as Research session
    A->>DA: Send research request
    DA->>DB: Deliver request
    B->>DB: Receive request
    B->>DB: Send result with research.md bytes
    DB->>DB: Persist immutable copy + outbox
    DB->>DA: Transfer result + attachment
    DA->>DA: Verify bytes; commit complete inbox entry
    DA-->>DB: Durable receipt for message + attachments
    A->>DA: Receive result; export research.md
    A->>DA: Acknowledge handling
```

## Attachment manifest

The envelope's optional `attachments` array contains metadata only. File bytes travel separately in the same multipart transfer. Each descriptor contains:

```json
{
  "id": "attachment-uuid",
  "filename": "research.md",
  "media_type": "text/markdown; charset=utf-8",
  "size_bytes": 18342,
  "sha256": "<64 lowercase hexadecimal characters>"
}
```

The ID is unique within its message. The hash covers the exact stored bytes. The example contains placeholders; production values are validated. The attachment name is a basename/display label, never a sender filesystem path. The sender daemon generates IDs and derives sizes/hashes from the staged bytes rather than trusting caller-supplied metadata. Once queued, a message's manifest and bytes are immutable. An updated document is a new message, optionally replying to the previous result.

Markdown in UTF-8 is the first required deliverable format. The store and transfer format accept regular file bytes with declared media types, so other deliverables can be added without changing routing. Media type is descriptive, not proof that content is safe or executable. No automatic execution, archive extraction, or loading remote resources from Markdown.

Default configurable limits:

| Limit | Default |
| --- | --- |
| Single attachment | 10 MiB |
| Combined attachment bytes in one message | 32 MiB |
| Attachment count per message | 8 |
| Message envelope, including attachment metadata | 64 KiB |
| Host attachment store, including reserved/staging bytes | 1 GiB |
| Retained attachment references per local session | 256 MiB |

The host cap accounts for physical blob and staging storage, including concurrent capacity reservations. The session cap accounts for logical attachment bytes across that session's retained incoming/outgoing messages; physical deduplication must not bypass it. Exported workspace copies are outside daemon storage and quotas. Advertise effective transfer limits in `/v0/info`; expose local storage usage through the CLI. Reject unsupported attachments or exceeded limits before admission. Never silently omit an attachment and deliver only the result text.

## CLI workflow and local ownership

These CLI commands are implemented; see the [README](../README.md) for installation and explicit session binding. Assume the CLI is bound to the calling session and the displayed addresses/IDs have been resolved from discovery:

```sh
parler send --to host-b/researcher --kind request \
  --text 'Research this question and return a Markdown report with sources.'

parler send --to host-a/requester --kind result --reply-to REQUEST_ID \
  --text 'Research complete; findings and sources are attached.' \
  --attach ./research.md

parler attachments list --message RESULT_ID
parler attachments export --message RESULT_ID --attachment ATTACHMENT_ID \
  --output ./deliverables/research.md
parler ack --message RESULT_ID --delivery-token DELIVERY_TOKEN
```

`--attach` is repeatable. The CLI opens a regular file using the session's own filesystem permissions and streams bytes to its local daemon; the network protocol never asks a remote daemon to open a supplied path. The daemon stages the bytes, enforces limits, computes the hash, and stores an immutable copy. Changes to or deletion of the source after a successful send do not affect delivery. The CLI reports failure if staging or durable persistence fails. The sender should finish writing the deliverable before attaching it; the daemon guarantees the captured bytes, not an instantaneous snapshot of a file being edited concurrently.

Local storage consists of SQLite message/attachment metadata plus a daemon-owned blob directory. Blobs may be content-addressed and deduplicated within a host, but all access is through authorized message IDs and attachment IDs. Knowing a hash does not grant access to another session's bytes. There is no public raw-blob endpoint or global content-existence query.

The CLI returns attachment metadata on receive, not all contents in model context. Export validates access to the parent message, rechecks integrity, and creates the destination exclusively inside a session-permitted directory. Reject traversal, invalid basenames, symlink destinations/ancestor escapes, and overwrite attempts. The daemon does not write arbitrary paths with its own privileges: workspace materialization is performed by the session-side CLI with its allowed access. Exports are ordinary independent local copies, with provenance containing message ID, attachment ID, and hash available in structured CLI output. The agent then reads the exported document through its usual file tool.

## Network transfer and atomic visibility

Use the existing authenticated `POST /v0/messages` endpoint. Without attachments it accepts JSON. With attachments it accepts `multipart/form-data`: one `envelope` JSON part and one binary part named `attachment:<id>` for each descriptor. Ignore client path headers. Reject missing, extra, duplicate, or mismatched parts. Authenticate and authorize the source/destination before processing payload bytes.

Sender steps: stream staged attachment copies to their final blob locations, sync them durably, then commit the manifest/outbox reference in SQLite. Return `queued` only after those steps succeed. A crash can leave an unreferenced blob, which garbage collection may remove; it must never leave a deliverable message referring to missing bytes.

Recipient steps: reserve quota, stream incoming bytes into private staging, enforce limits while reading, and verify every size/hash. Move complete blobs into durable storage and sync them before committing one transaction containing the inbox message and all attachment references. Only after that commit may the message be received, announced by a hook, or given a durable network receipt. Interrupted transfers and failed verification remain invisible to the agent. All bytes and metadata use the configured private endpoint policy. Private mode has no cloud fallback; explicit Tailscale mode permits encrypted relay fallback.

An HTTP timeout after recipient commit is uncertain delivery. Retry the same immutable message ID and manifest. The recipient deduplicates by authenticated sender and message ID, returns its existing durable receipt for an identical message, and rejects conflicting content. The equality check includes all attachment metadata and byte hashes. Same-host delivery applies the same visibility and authorization contract while avoiding network transfer.

Version 0 retries the complete transfer; it does not need chunk-resume complexity for small Markdown deliverables. Streaming prevents large in-memory buffering. A later version may negotiate resumable transfers for larger files. A peer that lacks attachment support causes an explicit send/delivery error, with no text-only downgrade.

## Receipt, acknowledgment, and retention

`queued` means the sender daemon owns complete local copies. `persisted_remote` means the recipient owns a verified, durable message plus all attachments. `acknowledged` means the recipient session handled the message; exporting an attachment alone does not acknowledge it. Research completion is represented by the correlated result message, independently of acknowledgment. Receipt/status reports include committed attachment IDs and expose per-message retention information.

Default policy: keep blobs referenced by queued or pending messages until acknowledgment or message expiry. Then retain the message and its attachment references for 7 additional days, separately on each host; return the effective retention deadline through the CLI. An expired message is no longer presented as new work, but an authorized historical read/export remains possible during retention. An acknowledgment does not immediately delete the daemon's only copy. Exported workspace files are not removed by daemon garbage collection.

After the retention deadline, remove references and reclaim blobs only when no retained message or active transfer/export references them. Delete abandoned staging files after a bounded recovery window, accounting for live transfers. Garbage collection and concurrent transfers require atomic reference/lease bookkeeping. Deduplication tombstones can outlive blob retention; reject expired retransmissions rather than recreating deleted work. Explicit future retention extensions or pins must remain subject to quotas and permissions.

Use bounded host, peer, and session quotas, including staging/reserved space, to prevent disk exhaustion. Reserve capacity before admission and release it on failure. Disk-full and quota errors produce no durable receipt or visible partial message. Sender retries transient capacity errors until TTL; structural violations are rejected. Status distinguishes temporary transfer errors from terminal rejection/expiry. Queue limits and retention must be visible to the operator; never evict pending attachment bytes silently to satisfy quota.

## Acceptance checks

- Deliver a Markdown research result across hosts and export identical bytes/hash on the recipient.
- Remove or modify the source after successful queueing; subsequent delivery remains identical.
- Stop the sender after durable remote receipt; the recipient can still export its local copy.
- Interrupt a transfer or corrupt a part; no message becomes visible until a complete valid retry.
- Lose the HTTP receipt after recipient commit; retry creates one inbox message and one authorized set of attachments.
- Restart either daemon at each staging/commit boundary; recover committed references and clean orphaned bytes.
- Reject oversized payloads, conflicting retry manifests, and missing/extra multipart parts.
- Deny reads by unrelated sessions, including when they know a blob's hash.
- Reject unsafe destination paths and overwrites; export with the receiving session's permissions.
- Exhaust disk/quota; leave no visible partial deliverable and report a retryable error where appropriate.
- Acknowledge and expire messages; retain copies for the published grace period, then reclaim only unreferenced bytes.
