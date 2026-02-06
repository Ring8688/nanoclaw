---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, configure Telegram bot, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run all commands automatically. Only pause when user action is required (e.g., creating a bot token).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text. This integrates with Claude's built-in question/answer system for a better experience.

## 1. Install Dependencies

```bash
npm install
```

## 2. Verify Docker

Check Docker is available:

```bash
docker info >/dev/null 2>&1 && echo "Docker: installed and running" || echo "Docker: not installed or not running"
```

If Docker is not running, tell the user:
> Docker is required for running agents in isolated containers.
>
> Install from: https://docker.com/products/docker-desktop
> On Linux: `sudo apt install docker.io && sudo systemctl start docker`
>
> Let me know when Docker is ready.

## 3. Configure Claude Authentication

Ask the user:
> Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

### Option 1: Claude Subscription (Recommended)

Tell the user:
> Open another terminal window and run:
> ```
> claude setup-token
> ```
> A browser window will open for you to log in. Once authenticated, the token will be displayed in your terminal. Either:
> 1. Paste it here and I'll add it to `.env` for you, or
> 2. Add it to `.env` yourself as `CLAUDE_CODE_OAUTH_TOKEN=<your-token>`

If they give you the token, add it to `.env`:

```bash
echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" > .env
```

### Option 2: API Key

Ask if they have an existing key to copy or need to create one.

**Create new:**
```bash
echo 'ANTHROPIC_API_KEY=' > .env
```

Tell the user to add their key from https://console.anthropic.com/

**Verify:**
```bash
KEY=$(grep "^ANTHROPIC_API_KEY=" .env | cut -d= -f2)
[ -n "$KEY" ] && echo "API key configured: ${KEY:0:10}...${KEY: -4}" || echo "Missing"
```

## 4. Configure Telegram Bot

**USER ACTION REQUIRED**

Tell the user:
> You need a Telegram bot token from BotFather:
>
> 1. Open Telegram and search for **@BotFather**
> 2. Send `/newbot` and follow the prompts
> 3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
> 4. Paste the token here

Once they provide the token, add it to `.env`:

```bash
echo "TELEGRAM_BOT_TOKEN=<token>" >> .env
```

Tell the user:
> Also, configure your bot's privacy settings so it can read group messages:
>
> 1. In BotFather, send `/mybots`
> 2. Select your bot → **Bot Settings** → **Group Privacy** → **Turn off**
>
> This allows the bot to see all messages in groups it's added to.

## 5. Build Container Image

Build the NanoClaw agent container:

```bash
./container/build.sh
```

This creates the `nanoclaw-agent:latest` image with Node.js, Chromium, Claude Code CLI, and agent-browser.

Verify the build:

```bash
echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
```

## 6. Configure Assistant Name

Ask the user:
> What trigger word do you want to use? (default: `Andy`)
>
> Messages starting with `@TriggerWord` will be sent to Claude.

If they choose something other than `Andy`, update it in these places:
1. `groups/CLAUDE.md` - Change "# Andy" and "You are Andy" to the new name
2. `groups/main/CLAUDE.md` - Same changes at the top
3. `data/registered_groups.json` - Use `@NewName` as the trigger when registering groups

Store their choice - you'll use it when creating the registered_groups.json and when telling them how to test.

## 7. Understand the Security Model

Before registering your main channel, you need to understand an important security concept.

**Use the AskUserQuestion tool** to present this:

> **Important: Your "main" channel is your admin control portal.**
>
> The main channel has elevated privileges:
> - Can see messages from ALL other registered groups
> - Can manage and delete tasks across all groups
> - Can write to global memory that all groups can read
> - Has read-write access to the entire NanoClaw project
>
> **Recommendation:** Use a private chat with the bot as your main channel. This ensures only you have admin control.
>
> **Question:** Which setup will you use for your main channel?
>
> Options:
> 1. Private chat with bot (just you and the bot) - Recommended
> 2. Telegram group (I understand the security implications)

If they choose a group, ask a follow-up about security implications.

## 8. Register Main Channel

Tell the user:
> Send any message to the bot in a private chat (or in the Telegram group you want to use as your main channel).

Start the app briefly to capture the message:

```bash
timeout 10 npm run dev || true
```

Then find the chat ID from the database:

```bash
sqlite3 store/messages.db "SELECT jid, name, last_message_time FROM chats ORDER BY last_message_time DESC LIMIT 5"
```

Create/update `data/registered_groups.json` using the chat ID from above and the assistant name from step 6:
```json
{
  "CHAT_ID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP"
  }
}
```

Ensure the groups folder exists:
```bash
mkdir -p groups/main/logs
```

## 9. Configure External Directory Access (Mount Allowlist)

Ask the user:
> Do you want the agent to be able to access any directories **outside** the NanoClaw project?
>
> Examples: Git repositories, project folders, documents you want Claude to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

If **no**, create an empty allowlist:

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
```

If **yes**, collect directory paths and create the allowlist JSON accordingly.

## 10. Configure systemd Service (Linux) or launchd (macOS)

Build first:

```bash
npm run build
mkdir -p logs
```

### Linux (systemd)

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)

sudo tee /etc/systemd/system/nanoclaw.service << EOF
[Unit]
Description=NanoClaw Personal Assistant
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=${PROJECT_PATH}
ExecStart=${NODE_PATH} ${PROJECT_PATH}/dist/index.js
Restart=always
RestartSec=10
Environment=HOME=$HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin

StandardOutput=append:${PROJECT_PATH}/logs/nanoclaw.log
StandardError=append:${PROJECT_PATH}/logs/nanoclaw.error.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable nanoclaw
sudo systemctl start nanoclaw
```

### macOS (launchd)

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

cat > ~/Library/LaunchAgents/com.nanoclaw.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_PATH}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${HOME_PATH}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.error.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Verify it's running:
```bash
# Linux
sudo systemctl status nanoclaw

# macOS
launchctl list | grep nanoclaw
```

## 11. Test

Tell the user (using the assistant name they configured):
> Send `@ASSISTANT_NAME hello` in your registered chat.

Check the logs:
```bash
tail -f logs/nanoclaw.log
```

The user should receive a response in Telegram.

## Troubleshooting

**Service not starting**: Check `logs/nanoclaw.error.log`

**Container agent fails with "Claude Code process exited with code 1"**:
- Ensure Docker is running: `docker info`
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

**No response to messages**:
- Verify the trigger pattern matches (e.g., `@AssistantName` at start of message)
- Check that the chat ID is in `data/registered_groups.json`
- Check `logs/nanoclaw.log` for errors

**Bot not receiving group messages**:
- Ensure Group Privacy is turned OFF in BotFather settings
- Make sure the bot is added to the group as a member
