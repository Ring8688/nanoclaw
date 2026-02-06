# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to Telegram, routes messages to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory.

**Performance Optimization**: Main group uses a persistent container (hybrid architecture) that eliminates 3s startup overhead, reducing response time from ~10s to ~6s for simple queries. Complex queries still spawn dedicated containers for isolation.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: Telegram connection, message routing, IPC, intelligent routing |
| `src/config.ts` | Trigger pattern, paths, intervals, persistent container config |
| `src/container-runner.ts` | Spawns agent containers with mounts (traditional mode) |
| `src/main-agent-manager.ts` | Persistent container lifecycle for Main group (hybrid optimization) |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management (Linux):
```bash
sudo systemctl start nanoclaw
sudo systemctl stop nanoclaw
```

## Hybrid Architecture (Performance Optimization)

Main group uses a persistent container to reduce response time by 40%:

- **Simple queries** (~80% of traffic): Routed to persistent container (~6s response)
  - Eliminates 2s container startup + 1s SDK initialization overhead
  - Maintains session state across queries
  - Auto-restarts on crash with exponential backoff

- **Complex queries** (~20% of traffic): Spawn dedicated container (~10s response)
  - File operations, code execution, long prompts (>2000 chars)
  - Full isolation and resource allocation
  - No impact on persistent container stability

- **Other groups**: Traditional on-demand containers (unchanged behavior)

Configuration:
```bash
ENABLE_PERSISTENT_MAIN=true  # Default: enabled
ENABLE_PERSISTENT_MAIN=false # Disable for full rollback
```

Fallback strategy: If persistent container crashes 3+ times, automatically falls back to traditional mode.
