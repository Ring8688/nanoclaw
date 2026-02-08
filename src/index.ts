import 'dotenv/config';
import { execSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';

import { Telegraf } from 'telegraf';
import type { Message } from 'telegraf/types';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  ENABLE_PERSISTENT_MAIN,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_LOCAL_API_URL,
  TRIGGER_PATTERN,
} from './config.js';
import {
  getMessagesSince,
  getNewMessages,
  initDatabase,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { downloadFile } from './file-handler.js';
import { logger } from './logger.js';
import { TaskManager } from './task-manager.js';
import { NewMessage, RegisteredGroup, Session, TelegramFileInfo } from './types.js';
import { escapeXml, loadJson, saveJson } from './utils.js';

// --- State ---

let bot: Telegraf;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let typingIntervals: Record<string, ReturnType<typeof setInterval>> = {};
let taskManager: TaskManager;

// --- Message merge queue ---

const MERGE_WINDOW = 3000; // 3s interrupt-merge window

interface ActiveRequest {
  chatJid: string;
  group: RegisteredGroup;
  messages: NewMessage[];
  abortController: AbortController;
  startedAt: number;
}

const activeRequests = new Map<string, ActiveRequest>();

// --- Typing indicator ---

async function setTyping(chatId: string, isTyping: boolean): Promise<void> {
  try {
    if (isTyping) {
      await bot.telegram.sendChatAction(chatId, 'typing');
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

// --- Message sending ---

async function sendMessage(chatId: string, text: string): Promise<void> {
  try {
    const MAX_LEN = 4096;
    if (text.length <= MAX_LEN) {
      await bot.telegram.sendMessage(chatId, text);
    } else {
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

// --- State persistence ---

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
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
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

// --- Prompt building ---

function buildPrompt(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    const msgType = m.message_type || 'text';
    let messageXml = `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}" type="${msgType}">`;

    if (m.quoted_message) {
      try {
        const quoted = JSON.parse(m.quoted_message);
        messageXml += `\n  <quoted sender="${escapeXml(quoted.senderName)}">${escapeXml(quoted.content)}</quoted>`;
      } catch {
        // Ignore malformed quoted message
      }
    }

    if (m.attachments) {
      try {
        const attachments = JSON.parse(m.attachments);
        for (const att of attachments) {
          messageXml += `\n  <${att.type} path="${escapeXml(att.filePath)}"`;
          if (att.fileName) messageXml += ` fileName="${escapeXml(att.fileName)}"`;
          if (att.fileSize) messageXml += ` fileSize="${att.fileSize}"`;
          if (att.mimeType) messageXml += ` mimeType="${escapeXml(att.mimeType)}"`;
          messageXml += ` />`;
        }
      } catch {
        // Ignore malformed attachments
      }
    }

    if (m.content) {
      messageXml += `\n  ${escapeXml(m.content)}`;
    }

    messageXml += '\n</message>';
    return messageXml;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

// --- Message processing with merge queue ---

async function handleNewMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;

  const key = msg.chat_jid;
  const existing = activeRequests.get(key);

  if (existing && Date.now() - existing.startedAt < MERGE_WINDOW) {
    // Within merge window → abort current request + subagents, merge messages
    logger.info({ chatJid: key, mergedCount: existing.messages.length + 1 }, 'Merging message into active request');
    existing.abortController.abort();
    taskManager.cancelSubagentsForChat(key);
    existing.messages.push(msg);
    startAgentRequest(key, group, existing.messages);
  } else {
    // No active request or past merge window → start new request
    startAgentRequest(key, group, [msg]);
  }
}

function startAgentRequest(
  chatJid: string,
  group: RegisteredGroup,
  messages: NewMessage[],
): void {
  const abortController = new AbortController();
  activeRequests.set(chatJid, {
    chatJid,
    group,
    messages,
    abortController,
    startedAt: Date.now(),
  });

  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const startTime = Date.now();

  // Fire and forget - errors handled internally
  (async () => {
    try {
      // Get all messages since last agent interaction for full context
      const latestMsg = messages[messages.length - 1];
      const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
      const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

      if (missedMessages.length === 0) return;

      const prompt = buildPrompt(missedMessages);
      if (!prompt) return;

      const prepTime = Date.now() - startTime;
      logger.info(
        { group: group.name, messageCount: missedMessages.length, prepTime },
        'Processing message',
      );

      await setTyping(chatJid, true);
      const agentStartTime = Date.now();

      const result = await taskManager.processAgentRequest(
        {
          group,
          prompt,
          sessionId: sessions[group.folder],
          chatJid,
          isMain,
        },
        abortController.signal,
      );

      if (!abortController.signal.aborted) {
        const agentTime = Date.now() - agentStartTime;
        if (result.response) {
          lastAgentTimestamp[chatJid] = latestMsg.timestamp;
          const totalTime = Date.now() - startTime;
          logger.info({ agentTime, totalTime }, 'Message processing complete');
          await sendMessage(chatJid, `${ASSISTANT_NAME}: ${result.response}`);
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        logger.error({ err, chatJid }, 'Error in agent request');
      }
    } finally {
      if (!abortController.signal.aborted) {
        activeRequests.delete(chatJid);
        await setTyping(chatJid, false);
        saveState();
      }
    }
  })();
}

// --- File download helper (uses bot for getFile, then delegates to file-handler) ---

async function downloadTelegramFile(
  fileId: string,
  chatId: string,
  type: string,
): Promise<string> {
  const file = await bot.telegram.getFile(fileId);
  const fileInfo: TelegramFileInfo = {
    file_id: file.file_id,
    file_unique_id: file.file_unique_id,
    file_path: file.file_path,
  };
  const result = await downloadFile(fileInfo, chatId, type);
  return result.localPath;
}

// --- Telegram connection ---

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

  const agent = new https.Agent({ family: 4 });
  const telegramOpts: { agent: https.Agent; apiRoot?: string } = { agent };
  if (TELEGRAM_LOCAL_API_URL) {
    telegramOpts.apiRoot = TELEGRAM_LOCAL_API_URL;
    logger.info({ apiRoot: TELEGRAM_LOCAL_API_URL }, 'Using local Telegram Bot API server');
  }
  bot = new Telegraf(TELEGRAM_BOT_TOKEN, { telegram: telegramOpts });

  // /start command
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
      await ctx.reply('This chat is not registered. Use the main group to register new chats.');
    }
  });

  // Handle all message types
  bot.on('message', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const msgId = String(ctx.message.message_id);
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const isFromMe = ctx.message.from?.id === ctx.botInfo.id;

    const from = ctx.message.from;
    const sender = from ? String(from.id) : chatId;
    const senderName = from?.first_name || from?.username || sender;

    let chatName: string;
    if (ctx.chat.type === 'private') {
      chatName = (ctx.chat as any).first_name || (ctx.chat as any).username || chatId;
    } else {
      chatName = (ctx.chat as any).title || chatId;
    }

    storeChatMetadata(chatId, timestamp, chatName);

    let messageType = 'text';
    let content = '';
    let attachments: Array<{
      type: string;
      filePath: string;
      fileName?: string;
      fileSize?: number;
      mimeType?: string;
    }> = [];
    let quotedMessage: {
      messageId: string;
      senderName: string;
      content: string;
      timestamp: string;
    } | undefined;

    const msg = ctx.message as Message;

    // Handle quoted/replied messages
    if ('reply_to_message' in msg && msg.reply_to_message) {
      const replyMsg = msg.reply_to_message;
      const replyFrom = 'from' in replyMsg ? replyMsg.from : undefined;
      const replySender = replyFrom?.first_name || replyFrom?.username || 'Unknown';
      let replyContent = '';

      if ('text' in replyMsg) {
        replyContent = replyMsg.text || '';
      } else if ('caption' in replyMsg) {
        replyContent = replyMsg.caption || '';
      } else {
        replyContent = '[Media message]';
      }

      quotedMessage = {
        messageId: String(replyMsg.message_id),
        senderName: replySender,
        content: replyContent,
        timestamp: new Date(replyMsg.date * 1000).toISOString(),
      };
    }

    // Process different message types
    try {
      const MAX_FILE_SIZE = TELEGRAM_LOCAL_API_URL
        ? 2000 * 1024 * 1024
        : 20 * 1024 * 1024;

      if ('photo' in msg && msg.photo) {
        messageType = 'photo';
        content = ('caption' in msg && msg.caption) || '';
        const largestPhoto = msg.photo[msg.photo.length - 1];
        if (largestPhoto.file_size && largestPhoto.file_size <= MAX_FILE_SIZE) {
          try {
            const filePath = await downloadTelegramFile(largestPhoto.file_id, chatId, 'photo');
            attachments.push({ type: 'photo', filePath, fileSize: largestPhoto.file_size });
          } catch (err) {
            logger.error({ err, msgId }, 'Failed to download photo');
            content = '[Failed to download photo]\n' + content;
          }
        }
      } else if ('document' in msg && msg.document) {
        messageType = 'document';
        content = ('caption' in msg && msg.caption) || '';
        if (msg.document.file_size && msg.document.file_size <= MAX_FILE_SIZE) {
          try {
            const filePath = await downloadTelegramFile(msg.document.file_id, chatId, 'document');
            attachments.push({
              type: 'document',
              filePath,
              fileName: msg.document.file_name,
              fileSize: msg.document.file_size,
              mimeType: msg.document.mime_type,
            });
          } catch (err) {
            logger.error({ err, msgId }, 'Failed to download document');
            content = '[Failed to download document]\n' + content;
          }
        }
      } else if ('video' in msg && msg.video) {
        messageType = 'video';
        content = ('caption' in msg && msg.caption) || '';
        if (msg.video.file_size && msg.video.file_size <= MAX_FILE_SIZE) {
          try {
            const filePath = await downloadTelegramFile(msg.video.file_id, chatId, 'video');
            attachments.push({
              type: 'video',
              filePath,
              fileSize: msg.video.file_size,
              mimeType: msg.video.mime_type,
            });
          } catch (err) {
            logger.error({ err, msgId }, 'Failed to download video');
            content = '[Failed to download video]\n' + content;
          }
        }
      } else if ('audio' in msg && msg.audio) {
        messageType = 'audio';
        content = ('caption' in msg && msg.caption) || '';
        if (msg.audio.file_size && msg.audio.file_size <= MAX_FILE_SIZE) {
          try {
            const filePath = await downloadTelegramFile(msg.audio.file_id, chatId, 'audio');
            attachments.push({
              type: 'audio',
              filePath,
              fileName: msg.audio.file_name,
              fileSize: msg.audio.file_size,
              mimeType: msg.audio.mime_type,
            });
          } catch (err) {
            logger.error({ err, msgId }, 'Failed to download audio');
            content = '[Failed to download audio]\n' + content;
          }
        }
      } else if ('voice' in msg && msg.voice) {
        messageType = 'voice';
        content = ('caption' in msg && msg.caption) || '';
        if (msg.voice.file_size && msg.voice.file_size <= MAX_FILE_SIZE) {
          try {
            const filePath = await downloadTelegramFile(msg.voice.file_id, chatId, 'voice');
            attachments.push({
              type: 'voice',
              filePath,
              fileSize: msg.voice.file_size,
              mimeType: msg.voice.mime_type,
            });
          } catch (err) {
            logger.error({ err, msgId }, 'Failed to download voice');
            content = '[Failed to download voice]\n' + content;
          }
        }
      } else if ('sticker' in msg && msg.sticker) {
        messageType = 'sticker';
        content = msg.sticker.emoji || '[Sticker]';
      } else if ('text' in msg) {
        messageType = 'text';
        content = msg.text || '';
      } else {
        logger.debug({ msgId, messageKeys: Object.keys(msg) }, 'Unknown message type');
        return;
      }
    } catch (err) {
      logger.error({ err, msgId }, 'Error processing message');
      content = content || '[Error processing message]';
    }

    if (registeredGroups[chatId]) {
      storeMessage(
        msgId,
        chatId,
        sender,
        senderName,
        content,
        timestamp,
        isFromMe,
        messageType,
        attachments.length > 0 ? attachments : undefined,
        quotedMessage,
      );
    }
  });

  // Graceful shutdown
  const stop = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    await taskManager.shutdown();
    bot.stop(signal);
    process.exit(0);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  // Launch bot
  logger.info('Connecting to Telegram...');
  bot.botInfo = await bot.telegram.getMe();
  logger.info({ id: bot.botInfo.id, username: bot.botInfo.username }, 'Bot identity confirmed');

  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  logger.info('Webhook cleared');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bot as any).startPolling();
  logger.info('Connected to Telegram (polling started)');

  // Start subsystems
  taskManager.startIpcWatcher();
  taskManager.startScheduler();
  startMessageLoop();
}

// --- Message loop ---

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
          await handleNewMessage(msg);
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error({ err, msg: msg.id }, 'Error processing message, will retry');
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

// --- Docker check ---

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
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
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

// --- Main ---

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ensureDockerRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Initialize task manager
  taskManager = new TaskManager({
    getRegisteredGroups: () => registeredGroups,
    getSessions: () => sessions,
    updateSession: (folder, sessionId) => {
      sessions[folder] = sessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    },
  });

  // Listen for task-manager actions → execute on Telegram
  taskManager.on('action', async (event) => {
    switch (event.type) {
      case 'send_message':
        await sendMessage(event.chatJid, event.text);
        break;
      case 'update_session':
        sessions[event.folder] = event.sessionId;
        saveState();
        break;
      case 'typing_start':
        await setTyping(event.chatJid, true);
        break;
      case 'typing_stop':
        await setTyping(event.chatJid, false);
        break;
      case 'subagent_result': {
        const fullText = `${ASSISTANT_NAME}: ${event.text}`;
        await sendMessage(event.chatJid, fullText);
        // Store in DB with [Subagent] sender — content does NOT start with "Momo:"
        // so it will appear in getMessagesSince() for the persistent agent's next prompt
        storeMessage(
          `subagent-${Date.now()}`,
          event.chatJid,
          'bot-subagent',
          '[Subagent]',
          `[Task: ${event.task}]\n${event.text}`,
          new Date().toISOString(),
          true,
          'text',
        );
        break;
      }
      case 'register_group':
        registerGroup(event.jid, {
          name: event.name,
          folder: event.folder,
          trigger: event.trigger,
          added_at: new Date().toISOString(),
          containerConfig: event.containerConfig,
        });
        break;
    }
  });

  // Initialize persistent main agent if configured
  const mainGroupJid = Object.entries(registeredGroups).find(
    ([, group]) => group.folder === MAIN_GROUP_FOLDER,
  )?.[0];

  if (mainGroupJid && ENABLE_PERSISTENT_MAIN) {
    taskManager.initPersistentAgent(registeredGroups[mainGroupJid]);
  }

  await connectTelegram();
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
