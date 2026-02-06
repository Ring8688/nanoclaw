<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  My personal Claude assistant that runs securely in containers. Lightweight and built to be understood and customized for your own needs.
</p>

> **Note**: This is a fork of [gavrielc/nanoclaw](https://github.com/gavrielc/nanoclaw) with performance optimizations and enhanced documentation. See [What's Different](#whats-different-in-this-fork) below.

## Why I Built This

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project with a great vision. But I can't sleep well running software I don't understand with access to my life. OpenClaw has 52+ modules, 8 config management files, 45+ dependencies, and abstractions for 15 channel providers. Security is application-level (allowlists, pairing codes) rather than OS isolation. Everything runs in one Node process with shared memory.

NanoClaw gives you the same core functionality in a codebase you can understand in 8 minutes. One process. A handful of files. Agents run in actual Linux containers with filesystem isolation, not behind permission checks.

## Quick Start

```bash
git clone https://github.com/Ring8688/nanoclaw.git
cd nanoclaw
claude
```

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup, service configuration.

**Prefer the upstream version?** Use `https://github.com/gavrielc/nanoclaw.git` instead.

## Philosophy

**Small enough to understand.** One process, a few source files. No microservices, no message queues, no abstraction layers. Have Claude Code walk you through it.

**Secure by isolation.** Agents run in Docker containers. They can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for one user.** This isn't a framework. It's working software that fits my exact needs. You fork it and have Claude Code make it match your exact needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that this is safe.

**AI-native.** No installation wizard; Claude Code guides setup. No monitoring dashboard; ask Claude what's happening. No debugging tools; describe the problem, Claude fixes it.

**Skills over features.** Contributors shouldn't add features (e.g. support for Telegram) to the codebase. Instead, they contribute [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** This runs on Claude Agent SDK, which means you're running Claude Code directly. The harness matters. A bad harness makes even smart models seem dumb, a good harness gives them superpowers. Claude Code is (IMO) the best harness available.

## What's Different in This Fork

This fork includes performance optimizations and enhanced documentation:

### Performance Enhancements

**Hybrid Architecture** - Main group uses a persistent container that eliminates 3s startup overhead:
- **Simple queries**: ~6s response time (40% faster than standard ~10s)
- **Complex queries**: Still use dedicated containers for safety and isolation
- **AI-driven routing**: Claude autonomously decides when to use persistent vs dedicated containers
- **Automatic fallback**: Crashes trigger exponential backoff, then fallback to traditional mode
- **One-line rollback**: `ENABLE_PERSISTENT_MAIN=false` in `.env` to disable

See `/optimize-performance-hybrid` skill for configuration and troubleshooting.

### Enhanced Documentation

**New Skills**:
- `/optimize-performance-hybrid` - Configure and troubleshoot the hybrid architecture
- `/telegram-integration` - Comprehensive Telegram implementation reference

**Contributions**:
- Performance optimization implementation (persistent containers, AI-driven subagent spawning)
- Architecture documentation improvements
- Troubleshooting guides

All enhancements maintain backward compatibility. The fork stays synchronized with upstream security fixes and core improvements.

## What It Supports

- **Telegram I/O** - Message Claude from any Telegram client
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted
- **Main channel** - Your private chat with the bot for admin control; every other group is completely isolated
- **Hybrid architecture** - Main group uses persistent container for 40% faster responses (~6s vs ~10s), complex queries still get dedicated containers
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content
- **Container isolation** - Agents sandboxed in Docker containers
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (private chat with bot), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

There are no configuration files to learn. Just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Slack support, don't create a PR that adds Slack alongside Telegram. Instead, contribute a skill file (`.claude/skills/add-slack/SKILL.md`) that teaches Claude Code how to transform a NanoClaw installation to use Slack.

Users then run `/add-slack` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd love to see:

**Communication Channels**
- `/add-whatsapp` - Add WhatsApp as channel (replace or add alongside Telegram)
- `/add-slack` - Add Slack
- `/add-discord` - Add Discord

**Platform Support**
- `/setup-windows` - Windows via WSL2 + Docker

**Session Management**
- `/add-clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session). Requires figuring out how to trigger compaction programmatically via the Claude Agent SDK.

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Docker](https://docker.com/products/docker-desktop)

## Architecture

```
Telegram (telegraf) --> SQLite --> Polling loop --> Intelligent Router
                                                           ↓
                                               ┌───────────┴────────────┐
                                               ↓                        ↓
                                    Persistent Container      Dedicated Container
                                    (Main group, simple)      (Complex queries)
                                               ↓                        ↓
                                    Claude Agent SDK --> Response
```

Single Node.js process. Agents execute in isolated Linux containers with mounted directories. IPC via filesystem. No daemons, no queues, no complexity.

**Hybrid Architecture** (Main group only):
- Persistent container handles simple queries (~6s)
- Dedicated containers for complex operations (~10s)
- AI decides routing based on query complexity
- Other groups use traditional on-demand containers

Key files:
- `src/index.ts` - Main app: Telegram bot, routing, IPC, intelligent routing
- `src/main-agent-manager.ts` - Persistent container lifecycle manager
- `src/container-runner.ts` - Spawns dedicated agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**Why Telegram?**

It's easy to set up (just a bot token from BotFather), works on all platforms, and has a great API. Fork it and run a skill to change it to another platform if you prefer.

**Why Docker?**

Docker provides lightweight, portable container isolation that works on macOS and Linux. Agents run inside containers with only explicitly mounted directories visible.

**Can I run this on Linux?**

Yes. Docker is the container runtime and works on both macOS and Linux. Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize it to so that the code matches exactly what they want rather than configuring a generic system. If you like having config files, tell Claude to add them.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach.

**Why isn't the setup working for me?**

I don't know. Run `claude`, then run `/debug`. If claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Security fixes, bug fixes, and clear improvements to the base configuration. That's it.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## License

MIT
