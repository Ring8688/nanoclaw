---
name: subagent-improvements
description: Subagent result feedback, typing indicators, cancellation, session continuity, and concurrency management
---

# Subagent Improvements

Comprehensive improvements to the subagent system (independent Docker containers spawned by the persistent Main agent via `spawn_subagent` MCP tool).

## Problems Solved

| # | Severity | Problem | Solution |
|---|----------|---------|----------|
| 1 | **HIGH** | Persistent agent can't see subagent results | Results stored in DB with `[Subagent]` sender, auto-injected into next prompt |
| 2 | **HIGH** | No typing indicator during subagent execution | `typing_start`/`typing_stop` events emitted around subagent lifecycle |
| 3 | **HIGH** | Message merge doesn't cancel running subagents | `AbortSignal` propagated to container; `docker stop` on abort |
| 4 | **MED** | Subagent always uses empty session | Now receives group's current session ID |
| 5 | **MED** | Subagent session discarded after completion | `newSessionId` saved via `updateSession()` |
| 6 | **MED** | No concurrency management | `activeSubagents` Map with configurable limit (default: 3) |
| 7 | **LOW** | Subagent results indistinguishable from main agent | `[Subagent]` sender name + `[Task: ...]` content prefix |

## Architecture

### Subagent Call Chain (After Improvements)

```
User message → persistent agent → spawn_subagent MCP tool
  → IPC file written to /workspace/ipc/tasks/
  → persistent agent returns immediately
                    ↓
  IPC watcher (1s poll) picks up file
  → task-manager.ts processTaskIpc 'spawn_subagent'
  → Concurrency check (activeSubagents.size < MAX_CONCURRENT_SUBAGENTS)
  → Create AbortController, register in activeSubagents Map
  → Emit typing_start → index.ts starts typing indicator
  → runContainerAgent(group, input, signal) — new Docker container
  → Container completes
  → Save newSessionId if present
  → Emit subagent_result → index.ts:
      1. sendMessage() to Telegram (with ASSISTANT_NAME prefix)
      2. storeMessage() to DB (sender=[Subagent], content=[Task: ...]\n{result})
  → Emit typing_stop → index.ts stops typing indicator
  → Remove from activeSubagents Map
```

### Result Visibility in Next Prompt

Subagent results are stored in the `messages` table:
- `sender_name`: `[Subagent]`
- `content`: `[Task: {summary}]\n{result_text}` (does NOT start with `Momo:`)

This means:
- `getNewMessages()` excludes them (`AND is_from_me = 0`) — no message loop trigger
- `getMessagesSince()` includes them (content doesn't match `Momo:%`) — visible in next prompt

The persistent agent sees subagent results as:
```xml
<message sender="[Subagent]" time="..." type="text">
  [Task: Update README with installation instructions]
  Successfully updated README.md with new installation section...
</message>
```

### Cancellation Flow

```
User sends new message within 3s merge window
  → handleNewMessage() detects active request
  → abortController.abort() (cancels main agent request)
  → taskManager.cancelSubagentsForChat(chatJid) (cancels all subagents)
      → For each subagent: abortController.abort()
      → AbortSignal listener in container-runner: docker stop <container>
      → Container close handler: resolve with status='error', error='Container aborted'
      → Subagent IIFE: signal.aborted check → skip result emit
      → finally: delete from activeSubagents, emit typing_stop
```

## Files Modified

| File | Changes |
|------|---------|
| `src/types.ts` | Added `subagent_result`, `typing_start`, `typing_stop` to `TaskManagerEvent` |
| `src/task-manager.ts` | `activeSubagents` Map, `cancelSubagentsForChat()`, typing events, session fix, concurrency check |
| `src/index.ts` | Handle `subagent_result` (send + store DB), `typing_start/stop`, cancel on merge |
| `src/db.ts` | `getNewMessages()` adds `AND is_from_me = 0` |
| `src/container-runner.ts` | `runContainerAgent()` accepts `AbortSignal`, stops container on abort |
| `src/config.ts` | `MAX_CONCURRENT_SUBAGENTS` constant |

**Zero container-side changes** — no Docker image rebuild needed.

## Configuration

```bash
# Max concurrent subagents (default: 3)
MAX_CONCURRENT_SUBAGENTS=3

# When limit reached, bot responds:
# "Momo: 当前有 3 个子任务在运行，请稍后再试。"
```

## Verification

```bash
# Build
npm run build

# Restart service
sudo systemctl restart nanoclaw

# Test 1: Result visibility
# Send message that triggers subagent → wait for completion → ask "what did the subagent do?"
# Persistent agent should describe the result (it's in DB context)

# Test 2: Typing indicator
# Trigger subagent → observe typing indicator persists during execution

# Test 3: Cancellation
# Trigger subagent → send new message within 3s
# Logs should show: "Cancelled subagent due to message merge"

# Test 4: Session continuity
# Trigger subagent task → trigger second subagent
# Second should have session context from first

# Test 5: Concurrency limit
# Trigger 4+ subagents rapidly
# 4th should get rejection message
```

## Related Skills

- `/optimize-performance-hybrid` - Persistent container and hybrid architecture setup
- `/debug` - Container troubleshooting
