---
name: change-assistant-name
description: Change the assistant's name and trigger word. Use when user wants to rename the assistant or change how to invoke it.
---

# Change Assistant Name

Change NanoClaw's assistant name and trigger word from the default "Andy" to your preferred name.

## Quick Change

To change from "Andy" to another name (e.g., "Momo"):

### 1. Set Environment Variable

Add to `.env`:
```bash
echo "ASSISTANT_NAME=Momo" >> .env
```

This changes:
- The trigger pattern: `@Andy` → `@Momo`
- The assistant's identity in all groups

### 2. Update CLAUDE.md Files

**Global instructions** (`groups/global/CLAUDE.md`):
```markdown
# Momo

You are Momo, a personal assistant...
```

**Main group** (`groups/main/CLAUDE.md`):
```markdown
# Momo

You are Momo, a personal assistant...
```

**Other groups**: Update `groups/{folder}/CLAUDE.md` for each registered group.

### 3. Update README Examples

In `README.md`, replace examples:
```markdown
@Momo send an overview...
@Momo list all scheduled tasks...
```

### 4. Rebuild Container

The container image includes CLAUDE.md files, so rebuild:
```bash
./container/build.sh
```

### 5. Restart Service

**Linux (systemd)**:
```bash
sudo systemctl restart nanoclaw
```

**macOS (launchd)**:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Development mode**:
```bash
# Kill existing process (Ctrl+C if running in terminal)
npm run dev
```

## Verification

### 1. Check Environment

```bash
# Should show your new name
grep ASSISTANT_NAME .env
```

### 2. Check Trigger Pattern

```bash
# Start the service and check logs
tail -f logs/app.log | grep "trigger"
```

### 3. Test in Telegram

Send a message with the new trigger:
```
@Momo hello
```

The bot should respond. Old trigger (`@Andy`) should no longer work.

## Files That Need Updates

| File | What to Change | Example |
|------|----------------|---------|
| `.env` | `ASSISTANT_NAME=Momo` | Environment variable |
| `groups/global/CLAUDE.md` | `# Momo`<br>`You are Momo` | Header and identity |
| `groups/main/CLAUDE.md` | `# Momo`<br>`You are Momo`<br>`@Momo examples` | Header, identity, examples |
| `groups/{folder}/CLAUDE.md` | Same as above for each group | Per-group instructions |
| `README.md` | `@Momo` in examples | Documentation |

**Important**: After changing CLAUDE.md files, you MUST rebuild the container (`./container/build.sh`) because these files are copied into the container image at build time.

## How It Works

### Trigger Pattern

The trigger pattern is a regex generated from `ASSISTANT_NAME`:

```typescript
// src/config.ts
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i'
);
```

This means:
- `ASSISTANT_NAME=Andy` → Trigger: `^@Andy\b` (case-insensitive)
- `ASSISTANT_NAME=Momo` → Trigger: `^@Momo\b` (case-insensitive)
- `@momo`, `@Momo`, `@MOMO` all work (case-insensitive)
- `@Momosaurus` does NOT match (`\b` = word boundary)

### Message Routing

When a message arrives:

1. **Check trigger**: `if (TRIGGER_PATTERN.test(messageText))`
2. **Strip trigger**: Remove `@Name` from start of message
3. **Route to container**: Send to appropriate agent container
4. **Agent sees**: The message without the trigger prefix

### Agent Identity

The agent's identity comes from the CLAUDE.md header:

```markdown
# Momo

You are Momo, a personal assistant.
```

**Important**: The instruction says "speak naturally without prefixing your messages" - this prevents the agent from signing every message with its name.

If you see the agent prefixing every response with "Momo:", check the CLAUDE.md file for this instruction:

```markdown
**Important**: When responding, speak naturally without prefixing your messages with "Momo:" or your name.
```

## Troubleshooting

### Bot Responds to Old Name

**Symptom**: `@Andy` still works after changing to Momo

**Cause**: Service not restarted, still using old environment

**Fix**:
```bash
# 1. Verify .env has new name
grep ASSISTANT_NAME .env

# 2. Restart service
sudo systemctl restart nanoclaw  # Linux
# OR
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS

# 3. Check logs for new trigger
tail -20 logs/app.log
```

### Bot Doesn't Respond to New Name

**Symptom**: `@Momo` doesn't trigger response

**Cause**: Container not rebuilt, old CLAUDE.md inside

**Fix**:
```bash
# 1. Rebuild container
./container/build.sh

# 2. Restart service
sudo systemctl restart nanoclaw

# 3. Test again
# Send "@Momo test" in Telegram
```

### Bot Signs Every Message with Name

**Symptom**: Every response starts with "Momo:" or ends with "- Momo"

**Cause**: CLAUDE.md missing the instruction to not prefix messages

**Fix**:

Edit `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md`:

```markdown
# Momo

You are Momo, a personal assistant. You help with tasks, answer questions, and can schedule reminders.

**Important**: When responding, speak naturally without prefixing your messages with "Momo:" or your name.
```

Then rebuild and restart:
```bash
./container/build.sh
sudo systemctl restart nanoclaw
```

### Different Names Per Group

**Symptom**: Want different identity in different groups

**Solution**: Edit each group's CLAUDE.md individually:

```bash
# Work group uses professional name
groups/work/CLAUDE.md:
# Alex
You are Alex, a professional assistant focused on productivity...

# Family group uses friendly name
groups/family/CLAUDE.md:
# Momo
You are Momo, a helpful family assistant...
```

The trigger word (`@Momo`) stays the same across all groups - only the agent's personality/identity changes.

## Advanced: Custom Trigger Pattern

If you want a different trigger format (not `@Name`), edit `src/config.ts`:

```typescript
// Custom trigger: respond to "hey bot"
export const TRIGGER_PATTERN = /^hey bot\b/i;

// Custom trigger: respond to any message with "?"
export const TRIGGER_PATTERN = /\?/;

// Custom trigger: respond to all messages (no trigger)
export const TRIGGER_PATTERN = /.*/;
```

**Warning**: Changing `TRIGGER_PATTERN` directly means `ASSISTANT_NAME` won't affect the trigger. You'll need to manually update the regex when you want to change it.

## Alternative: Registered Groups Trigger

Instead of using `ASSISTANT_NAME`, you can set per-group triggers in `data/registered_groups.json`:

```json
{
  "chat_id_here": {
    "name": "Main",
    "folder": "main",
    "trigger": "all",  // Respond to all messages
    "added_at": "..."
  },
  "another_chat_id": {
    "name": "Work",
    "folder": "work",
    "trigger": "@Momo",  // Only respond to @Momo
    "added_at": "..."
  }
}
```

**Trigger options**:
- `"all"` - Respond to every message (ignores TRIGGER_PATTERN)
- `"@Name"` - Respond only to messages starting with @Name
- Custom regex pattern

## Related Files

| File | Purpose | When to Edit |
|------|---------|--------------|
| `src/config.ts` | Defines ASSISTANT_NAME and TRIGGER_PATTERN | If changing trigger logic |
| `.env` | Sets ASSISTANT_NAME environment variable | Every name change |
| `groups/*/CLAUDE.md` | Agent instructions and identity | Every name change |
| `data/registered_groups.json` | Per-group trigger overrides | If want different triggers per group |
| `container/Dockerfile` | Copies CLAUDE.md into container | Never edit manually |
| `README.md` | Documentation examples | Optional, for clarity |

## Summary

**Minimum steps to change name**:
1. Add `ASSISTANT_NAME=NewName` to `.env`
2. Update `groups/global/CLAUDE.md` and `groups/main/CLAUDE.md` headers
3. Rebuild container: `./container/build.sh`
4. Restart service: `sudo systemctl restart nanoclaw`
5. Test: `@NewName hello` in Telegram

**Total time**: ~2 minutes

---

**Note**: The name change affects ALL groups. If you want different names per group, edit each group's CLAUDE.md independently (the identity) while keeping the same trigger word.
