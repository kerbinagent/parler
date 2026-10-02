# Codex and Claude Code hooks

Parler hooks enroll a main session, announce new inbox messages, and give the main agent explicit CLI commands. They never read peer message bodies or attachments into lifecycle context. Only the main agent coordinates Parler communication: subagents do assigned work and return their results to the parent. Subagents must not enroll, discover recipients, send messages, or consume the parent's inbox.

Use Node 24 or later, initialize a private state directory, and keep its daemon running before enabling hooks. The examples are templates, with absolute paths that must be replaced for your machine:

- [Codex config](../examples/hooks/codex.json)
- [Claude Code config](../examples/hooks/claude-code.json)

Replace `/ABSOLUTE/PATH/TO/node`, `/ABSOLUTE/PATH/TO/parler`, and `/ABSOLUTE/PATH/TO/private-parler-state` in every handler. Use an absolute state directory shared by your main sessions on that host. Each session still receives its own binding and mailbox. Keeping state outside a project lets sessions in different projects find the same daemon. Shell-quote any special characters in your real paths; the templates use double quotes suitable for ordinary paths with spaces.

For Codex, merge the template into your chosen supported `hooks.json` config layer, such as the project's `.codex/hooks.json`. Open `/hooks` to inspect and trust the exact definitions. Project hooks also require project trust. Review changed definitions again when needed. This repository does not install hooks or bypass trust. See the [official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks).

For Claude Code, merge the template's `hooks` object into your selected project `.claude/settings.json` or local `.claude/settings.local.json`, preserving your other settings. Inspect the definitions through the normal Claude Code hook/configuration flow. Check that your installed version supports the configured events and JSON output before enabling them. See the [official Claude Code hooks reference](https://code.claude.com/docs/en/hooks).

| Event | Behavior |
| --- | --- |
| `SessionStart` | Register or resume the main native session, save its credential binding, and provide CLI guidance. |
| `UserPromptSubmit` | Touch presence and announce previously unannounced inbox IDs. |
| `PostToolUse` | Touch presence and request a daemon-throttled notice. |
| `Stop` | Request one additional inbox pass for newly announced mail, using a fixed reason. |
| `SessionEnd` | Best-effort close; retain the credential binding so the same native session can resume. |

Both adapters use event-specific JSON context. Stop uses `decision: "block"` and a fixed reason with a concrete `receive` command. If `stop_hook_active` is true, the adapter touches presence without requesting another notice or continuation. The daemon also enforces a continuation budget and tracks announcement atomically. A notice is not an acknowledgment: the agent must receive messages and acknowledge each one after handling it. No lifecycle hook automatically sends a reply or exposes the transcript.

The main agent should publish a helpful title and task summary using the supplied `session update` command, search `sessions --query 'research topic' --refresh`, select the intended stable address, then send an explicit request. A result can include `--attach research.md`; the peer exports that copied file through the CLI. Peer text and deliverables remain external data, subject to the user's task and instructions.

Supported main-session startup sources are startup, resume, clear, compact, and fork. Subagent events and inputs carrying a child agent ID, child transcript, parent session ID, or explicit subagent marker are ignored before any daemon call or binding write. The examples do not subscribe to subagent events. Native session IDs in input are validated and always resolved explicitly with the client kind; the hook never falls back to another project's sole binding. Separate native session IDs therefore remain separate even when two main agents use the same workspace.

These checks support main-only coordination in normal agent workflows. Processes running as the same operating-system user can access that user's local credentials, so hooks do not provide hard isolation against a malicious subagent or arbitrary process using the CLI directly. Use separate operating-system accounts if that isolation is required.

Hooks use the local Unix socket only. Stdin is limited to 64 KiB and read for at most 500 ms, each local request has a 600 ms timeout, and the command has a 2.8 second outer deadline. Malformed input, missing bindings, or daemon downtime exit successfully without control output. Configured handlers use a three-second timeout. Pending mail persists until a later event when the daemon is available. Mail arriving after the session is already idle waits for the next lifecycle event; this adapter does not wake idle clients.

To disable the adapter, remove its handlers from the chosen client configuration. This does not delete stored mail or attachment copies. An unobserved shutdown falls back to daemon presence expiry.
