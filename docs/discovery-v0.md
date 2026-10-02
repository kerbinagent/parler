# Session discovery v0 proposal

## Find a session by its work

The user can say “talk to the session working on database migration.” The calling agent queries its local daemon for that phrase. The daemon searches enrolled local and remote sessions by title, task description, project label, alias, and tags, and returns addresses and matching metadata. The agent sends to a resolved stable address, not a title interpreted as a routing identity.

This directory includes Codex and Claude Code sessions across explicitly paired user-owned hosts. Multiple sessions may share a host, project, client kind, or title. Titles are descriptions, not unique identifiers or permissions.

## Session advertisement

Each record includes:

| Field | Meaning |
| --- | --- |
| `address` | Stable `<node_id>/<session_id>` routing identity. |
| `alias` | Optional human-readable local alias. |
| `title` | Short description such as “Database migration research”. |
| `task_summary` | Brief current assignment, such as “Compare migration approaches and return a Markdown report”. |
| `client_kind` | `codex`, `claude-code`, or `other`. |
| `project_label`, `tags` | Optional searchable context chosen for sharing. |
| `presence`, `activity` | Session liveness and last observed state, kept separate. |
| `last_seen_at`, `updated_at` | Activity and metadata freshness timestamps. |
| `capabilities` | Supported protocol, attachment limits, message kinds, and delivery modes. |

Presence is `online`, `stale`, or `closed`; activity is `working`, `idle`, or `unknown`. Hook events provide observations, not guarantees that the model is currently generating. A fresh daemon advertisement does not make an old session observation fresh. Hook-only sessions become stale when no new local liveness evidence is available, even if the daemon is reachable.

Proposed metadata caps: title 80 characters, task summary 240, project label 128, and up to 8 tags of 32 characters each. Validate text and reject control characters; cap the encoded record at 4 KiB. Metadata is shared descriptive data and must not contain credentials, full prompts, transcripts, source files, or private absolute workspace paths.

## Registration and title updates

`SessionStart` registers the native conversation under its client-specific binding and publishes a default title based on an explicitly configured project label plus client kind. Supported adapters may import a native title, but discovery must work without that feature. Native title extraction from unstable transcript files is not a requirement.

Hook guidance tells the agent to set a concise Parler title and task summary when it starts work or changes assignments. Updates are explicit through the CLI, so it can summarize the task instead of broadcasting the user's whole prompt. They persist across resume and trigger advertisements. This metadata describes the intended assignment and can become stale; it is not inferred continuously from all assistant text.

Proposed commands, not installed commands:

```sh
parler session update --title 'Database migration research' \
  --task-summary 'Compare migration approaches and return a Markdown report' \
  --project-label parler --tag research --tag database

parler sessions --query 'database migration' --format json
parler sessions --client-kind claude-code --project parler --format json
parler sessions --refresh --query 'database migration' --format json
```

Session updates can only change the calling session's metadata. Native IDs remain local to the adapter. Discovery advertisements are limited to enrolled projects/sessions and paired peers that may see them; an installed CLI does not publish every conversation on the machine.

## Broadcast over paired private connections

“Broadcast” means authenticated unicast fanout to configured, authorized peers over the same approved private HTTPS paths as message delivery. It does not mean LAN UDP broadcast, a public registry, or scanning the tailnet. This works across private routed subnets without relying on multicast availability.

After registration, title/task changes, presence changes, and detach, publish a fresh visibility-filtered snapshot of this node's enrolled sessions. Also publish periodic snapshots; proposed interval 30 seconds. Each snapshot includes the owning node ID, a persistently increasing revision, publication time, and the records visible to that recipient. Never forward another node's advertisements. The daemon may coalesce rapid updates and enforce rate/size limits.

The recipient authenticates the paired node, verifies ownership of every advertised address, and accepts only increasing revisions. Each revision must describe one consistent snapshot; content changes allocate a new revision. Persist the revision counter across daemon restart. A complete filtered snapshot replaces that peer's previous visible records, including withdrawals. A changed visibility policy emits a fresh revision. Initial pairing, cache loss, or reconnect can recover with `GET /v0/sessions`; polling is also a fallback if an announcement fails.

Bound snapshots to at most 256 advertised records and 1 MiB of encoded metadata per peer in v0, with a lower effective deployment cap allowed. Reject partial/oversized snapshots rather than silently withdrawing sessions from incomplete data. Pagination and larger host fleets can be negotiated in a later version.

Proposed cache freshness deadline: 120 seconds from publication, subject to the protocol's clock synchronization assumption. Lost announcements or an offline host make its cache stale; retain the records for display with explicit stale status. Duplicate/delayed announcements cannot renew freshness using their arrival time. Periodic broadcasts renew directory availability, while session `last_seen_at` remains based on genuine local observations. Closure/withdrawal should be pushed promptly, with cache expiry covering missed updates.

Host endpoints and pairing still require initial operator configuration. The session directory answers “what is working where?” after pairing; it does not solve automatic discovery of every machine the user owns.

## Matching and selecting a recipient

Search locally with deterministic token/substring matching and rank exact aliases/titles, title matches, task matches, and tags/project matches. This requires no cloud embedding or search service. Return all relevant candidates with match fields, host label, client kind, freshness, and full routing address; include a truncation marker if the result limit is reached.

For “the session working on X,” prefer fresh sessions observed working on the matching task. If one clear candidate exists, the agent can resolve its address and send. If multiple plausible candidates exist, present those candidates for clarification before sending. If only stale/idle matches exist, describe their status rather than assuming they are actively working. The user can explicitly choose a stale session and queue a message for it; hook-only delivery may wait until its next event.

Before sending, validate the current destination and permissions with the owning daemon when reachable. If it is unreachable, a previously authorized destination can remain locally queued under the existing TTL, without claiming current presence. Fresh discovery is not an acknowledgment or authorization grant. Titles/task text remain untrusted peer metadata; they never become commands or instructions that override the receiving agent's task.

## Acceptance checks

- Enroll Codex and Claude Code sessions on multiple hosts and find both by task/title.
- Change a title or task; propagate the update while preserving the session's address.
- Search two sessions with the same title; return both without silently choosing a recipient.
- Search a long-idle or disconnected session; expose stale observation/cache state.
- Reorder or duplicate snapshots; old revisions cannot overwrite metadata or extend freshness.
- Withdraw a session or remove discovery visibility; the next complete snapshot removes it from fresh listings.
- Spoof another node's session address; reject the announcement.
- Restart a daemon; preserve identity/revision and recover cached discovery with an authoritative snapshot.
- Fail network broadcast; normal user work proceeds, with bounded retries and refresh fallback.
- Verify titles, summaries, and capabilities reach only allowed peers, with no raw prompts or transcripts.
