import 'dotenv/config';
import dns from 'dns';
import { execSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';

import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  ENABLE_PERSISTENT_MAIN,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TELEGRAM_BOT_TOKEN,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  AvailableGroup,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  initDatabase,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { NewMessage, RegisteredGroup, Session } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';
import {
  initMainAgentManager,
  getMainAgentManager,
  shutdownMainAgentManager,
} from './main-agent-manager.js';

let bot: Telegraf;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let typingIntervals: Record<string, ReturnType<typeof setInterval>> = {};

async function setTyping(chatId: string, isTyping: boolean): Promise<void> {
  try {
    if (isTyping) {
      // Send typing action immediately
      await bot.telegram.sendChatAction(chatId, 'typing');
      // Refresh every 4 seconds (Telegram typing indicator lasts ~5s)
      typingIntervals[chatId] = setInterval(async () => {
        try {
          await bot.telegram.sendChatAction(chatId, 'typing');
        } catch {
          // Ignore errors during refresh
        }
      }, 4000);
    } else {
      if (typingIntervals[chatId]) {
        clearInterval(typingIntervals[chatId]);
        delete typingIntervals[chatId];
      }
    }
  } catch (err) {
    logger.debug({ chatId, err }, 'Failed to update typing status');
  }
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(
    path.join(DATA_DIR, 'registered_groups.json'),
    {},
  );
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
    last_agent_timestamp: lastAgentTimestamp,
  });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__')
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

async function processMessage(msg: NewMessage): Promise<void> {
  const startTime = Date.now();
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Main group responds to all messages; other groups require trigger prefix
  if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(
    msg.chat_jid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  const lines = missedMessages.map((m) => {
    // Escape XML special characters in content
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  const prepTime = Date.now() - startTime;
  logger.info(
    { group: group.name, messageCount: missedMessages.length, prepTime },
    'Processing message',
  );

  await setTyping(msg.chat_jid, true);
  const agentStartTime = Date.now();
  const response = await runAgent(group, prompt, msg.chat_jid);
  const agentTime = Date.now() - agentStartTime;
  await setTyping(msg.chat_jid, false);

  if (response) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    const totalTime = Date.now() - startTime;
    logger.info({ agentTime, totalTime }, 'Message processing complete');
    await sendMessage(msg.chat_jid, `${ASSISTANT_NAME}: ${response}`);
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
): Promise<string | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Main group: always route to persistent container (AI decides if subagent needed)
  if (isMain && ENABLE_PERSISTENT_MAIN) {
    const manager = getMainAgentManager();

    if (manager) {
      try {
        logger.info('Routing to persistent main agent');
        const response = await manager.query(prompt, sessionId, chatJid);

        if (response.newSessionId) {
          sessions[group.folder] = response.newSessionId;
          saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
        }

        return response.result;
      } catch (err) {
        logger.error(
          { err },
          'Persistent agent failed, falling back to on-demand container'
        );
        // Fall through to on-demand container
      }
    }
  }

  // On-demand container mode (fallback or non-main groups)
  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return null;
  }
}

async function sendMessage(chatId: string, text: string): Promise<void> {
  try {
    // Telegram has a 4096 character limit per message
    const MAX_LEN = 4096;
    if (text.length <= MAX_LEN) {
      await bot.telegram.sendMessage(chatId, text);
    } else {
      // Split into chunks at newline boundaries when possible
      let remaining = text;
      while (remaining.length > 0) {
        let chunk: string;
        if (remaining.length <= MAX_LEN) {
          chunk = remaining;
          remaining = '';
        } else {
          const splitIdx = remaining.lastIndexOf('\n', MAX_LEN);
          if (splitIdx > MAX_LEN / 2) {
            chunk = remaining.slice(0, splitIdx);
            remaining = remaining.slice(splitIdx + 1);
          } else {
            chunk = remaining.slice(0, MAX_LEN);
            remaining = remaining.slice(MAX_LEN);
          }
        }
        await bot.telegram.sendMessage(chatId, chunk);
      }
    }
    logger.info({ chatId, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send message');
  }
}

function startIpcWatcher(): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await sendMessage(
                    data.chatJid,
                    `${ASSISTANT_NAME}: ${data.text}`,
                  );
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For spawn_subagent
    task?: string;
    includeContext?: boolean;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
): Promise<void> {
  // Import db functions dynamically to avoid circular deps
  const {
    createTask,
    updateTask,
    deleteTask,
    getTaskById: getTask,
  } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.groupFolder
      ) {
        // Authorization: non-main groups can only schedule for themselves
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetGroup },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        // Resolve the correct JID for the target group (don't trust IPC payload)
        const targetJid = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup,
        )?.[0];

        if (!targetJid) {
          logger.warn(
            { targetGroup },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetGroup, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // No-op for Telegram - groups are discovered via incoming messages
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group refresh requested (no-op for Telegram, groups discovered via messages)',
        );
        const availableGroups = getAvailableGroups();
        const { writeGroupsSnapshot: writeGroups } =
          await import('./container-runner.js');
        writeGroups(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'spawn_subagent':
      // Only main group can spawn subagents
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized spawn_subagent attempt blocked',
        );
        break;
      }
      if (data.task && data.chatJid) {
        const chatJid = data.chatJid; // Type narrowing
        const task = data.task;
        logger.info({ task: task.slice(0, 100) }, 'Spawning subagent from main agent request');

        // Get group info
        const targetGroup = registeredGroups[chatJid];
        if (!targetGroup) {
          logger.warn({ chatJid }, 'Cannot spawn subagent: group not found');
          break;
        }

        // Build prompt for subagent
        let subagentPrompt = task;
        if (data.includeContext) {
          // Get recent messages for context
          const recentMessages = getMessagesSince(
            chatJid,
            new Date(Date.now() - 30 * 60 * 1000).toISOString(), // Last 30 minutes
            ASSISTANT_NAME,
          ).slice(-10); // Last 10 messages

          if (recentMessages.length > 0) {
            const escapeXml = (s: string) =>
              s
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');

            const contextLines = recentMessages.map((m) =>
              `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`
            );
            subagentPrompt = `<recent_context>\n${contextLines.join('\n')}\n</recent_context>\n\n${data.task}`;
          }
        }

        // Spawn dedicated container (background, non-blocking)
        (async () => {
          try {
            const output = await runContainerAgent(targetGroup, {
              prompt: subagentPrompt,
              sessionId: undefined, // Fresh session for subagent
              groupFolder: targetGroup.folder,
              chatJid,
              isMain: true,
            });

            // Send result back via Telegram
            if (output.status === 'success' && output.result) {
              await sendMessage(chatJid, `${ASSISTANT_NAME}: ${output.result}`);
              logger.info('Subagent completed and result sent');
            } else {
              logger.error({ error: output.error }, 'Subagent failed');
              await sendMessage(
                chatJid,
                `${ASSISTANT_NAME}: Subagent encountered an error: ${output.error || 'Unknown error'}`
              );
            }
          } catch (err) {
            logger.error({ err }, 'Error running subagent');
            await sendMessage(
              chatJid,
              `${ASSISTANT_NAME}: Failed to run subagent: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })();

        logger.info('Subagent task queued (running in background)');
      } else {
        logger.warn(
          { data },
          'Invalid spawn_subagent request - missing task or chatJid',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function connectTelegram(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN is not set. Add it to your .env file.');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: TELEGRAM_BOT_TOKEN is not set                        ║',
    );
    console.error(
      '║                                                              ║',
    );
    console.error(
      '║  1. Talk to @BotFather on Telegram to create a bot           ║',
    );
    console.error(
      '║  2. Add TELEGRAM_BOT_TOKEN=<your-token> to .env              ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                         ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    process.exit(1);
  }

  // Force IPv4 to avoid IPv6 connectivity issues with Telegram API
  const agent = new https.Agent({ family: 4 });
  bot = new Telegraf(TELEGRAM_BOT_TOKEN, {
    telegram: { agent },
  });

  // /start command - register the current chat as the main group if none exists
  bot.command('start', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const chatName =
      ctx.chat.type === 'private'
        ? (ctx.chat as any).first_name || (ctx.chat as any).username || chatId
        : (ctx.chat as any).title || chatId;

    if (Object.keys(registeredGroups).length === 0) {
      registerGroup(chatId, {
        name: chatName,
        folder: MAIN_GROUP_FOLDER,
        trigger: 'all',
        added_at: new Date().toISOString(),
      });
      await ctx.reply(
        `Registered this chat as the main group "${chatName}".\n\nI'll respond to all messages here. Send me a message to get started!`,
      );
      logger.info({ chatId, chatName }, 'Main group registered via /start');
    } else if (registeredGroups[chatId]) {
      await ctx.reply('This chat is already registered.');
    } else {
      await ctx.reply(
        `This chat is not registered. Use the main group to register new chats.`,
      );
    }
  });

  // Handle text messages
  bot.on(message('text'), async (ctx) => {
    const chatId = String(ctx.chat.id);
    const msgId = String(ctx.message.message_id);
    const text = ctx.message.text;
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const isFromMe = ctx.message.from?.id === ctx.botInfo.id;

    // Determine sender info
    const from = ctx.message.from;
    const sender = from ? String(from.id) : chatId;
    const senderName =
      from?.first_name ||
      from?.username ||
      sender;

    // Determine chat name
    let chatName: string;
    if (ctx.chat.type === 'private') {
      chatName =
        (ctx.chat as any).first_name ||
        (ctx.chat as any).username ||
        chatId;
    } else {
      chatName = (ctx.chat as any).title || chatId;
    }

    // Store chat metadata for group discovery
    storeChatMetadata(chatId, timestamp, chatName);

    // Store full message for registered groups
    if (registeredGroups[chatId]) {
      storeMessage(
        msgId,
        chatId,
        sender,
        senderName,
        text,
        timestamp,
        isFromMe,
      );
    }
  });

  // Graceful shutdown
  const stop = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    await shutdownMainAgentManager();
    bot.stop(signal);
    process.exit(0);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  // Launch the bot step by step (bot.launch() hangs on some environments)
  logger.info('Connecting to Telegram...');
  bot.botInfo = await bot.telegram.getMe();
  logger.info({ id: bot.botInfo.id, username: bot.botInfo.username }, 'Bot identity confirmed');

  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  logger.info('Webhook cleared');

  // Start polling directly - accessing private method to avoid launch() hanging
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bot as any).startPolling();
  logger.info('Connected to Telegram (polling started)');

  // Start subsystems
  startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
  });
  startIpcWatcher();
  startMessageLoop();
}

async function startMessageLoop(): Promise<void> {
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0)
        logger.info({ count: messages.length, jids: jids.length, lastTimestamp }, 'New messages found');
      for (const msg of messages) {
        try {
          logger.info({ chatJid: msg.chat_jid, content: msg.content.slice(0, 50), id: msg.id }, 'Processing message');
          await processMessage(msg);
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error(
            { err, msg: msg.id },
            'Error processing message, will retry',
          );
          // Stop processing this batch - failed message will be retried next loop
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Docker is not running                                ║',
    );
    console.error(
      '║                                                              ║',
    );
    console.error(
      '║  Agents cannot run without Docker. To fix:                   ║',
    );
    console.error(
      '║  Linux: sudo systemctl start docker                          ║',
    );
    console.error(
      '║                                                              ║',
    );
    console.error(
      '║  Install from: https://docker.com/products/docker-desktop    ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Docker is required but not running');
  }

  // Clean up stopped NanoClaw containers from previous runs
  try {
    const output = execSync(
      'docker ps -a --filter "name=nanoclaw-" --format "{{.Names}}"',
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const stale = output
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.startsWith('nanoclaw-'));
    if (stale.length > 0) {
      execSync(`docker rm ${stale.join(' ')}`, { stdio: 'pipe' });
      logger.info({ count: stale.length }, 'Cleaned up stopped containers');
    }
  } catch {
    // No stopped containers
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ensureDockerRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Initialize persistent main agent if configured
  const mainGroupJid = Object.entries(registeredGroups).find(
    ([, group]) => group.folder === MAIN_GROUP_FOLDER
  )?.[0];

  if (mainGroupJid && ENABLE_PERSISTENT_MAIN) {
    logger.info('Initializing persistent main agent...');
    initMainAgentManager(registeredGroups[mainGroupJid]);
  }

  await connectTelegram();
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
