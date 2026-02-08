/**
 * Task Manager - Container orchestration, IPC handling, agent routing, task scheduling.
 * No Telegram bot instance. Emits events for main process to execute Telegram actions.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  ENABLE_PERSISTENT_MAIN,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  MAX_CONCURRENT_SUBAGENTS,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  AvailableGroup,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  createTask,
  deleteTask,
  getAllChats,
  getAllTasks,
  getDueTasks,
  getMessagesSince,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { logger } from './logger.js';
import {
  initMainAgentManager,
  getMainAgentManager,
  shutdownMainAgentManager,
} from './main-agent-manager.js';
import {
  AgentRequest,
  AgentResult,
  RegisteredGroup,
  ScheduledTask,
  TaskManagerEvent,
} from './types.js';
import { escapeXml, saveJson } from './utils.js';

export interface TaskManagerDeps {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  updateSession: (folder: string, sessionId: string) => void;
}

export declare interface TaskManager {
  on(event: 'action', listener: (evt: TaskManagerEvent) => void): this;
  emit(event: 'action', evt: TaskManagerEvent): boolean;
}

export class TaskManager extends EventEmitter {
  private deps: TaskManagerDeps;
  private schedulerRunning = false;
  private activeSubagents = new Map<string, {
    chatJid: string;
    abortController: AbortController;
  }>();

  constructor(deps: TaskManagerDeps) {
    super();
    this.deps = deps;
  }

  // --- Public: persistent container lifecycle ---

  initPersistentAgent(group: RegisteredGroup): void {
    if (ENABLE_PERSISTENT_MAIN) {
      logger.info('Initializing persistent main agent...');
      initMainAgentManager(group);
    }
  }

  // --- Public: agent request processing ---

  async processAgentRequest(
    req: AgentRequest,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    // Prepare snapshots for container
    const tasks = getAllTasks();
    writeTasksSnapshot(
      req.group.folder,
      req.isMain,
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

    const availableGroups = this.getAvailableGroups();
    const registeredGroups = this.deps.getRegisteredGroups();
    writeGroupsSnapshot(
      req.group.folder,
      req.isMain,
      availableGroups,
      new Set(Object.keys(registeredGroups)),
    );

    // Check abort before running
    if (signal?.aborted) {
      return { response: null };
    }

    // Main group with persistent container
    if (req.isMain && ENABLE_PERSISTENT_MAIN) {
      const manager = getMainAgentManager();
      if (manager) {
        try {
          logger.info('Routing to persistent main agent');
          const response = await manager.query(req.prompt, req.sessionId, req.chatJid);

          if (signal?.aborted) return { response: null };

          if (response.newSessionId) {
            this.deps.updateSession(req.group.folder, response.newSessionId);
          }
          return { response: response.result, newSessionId: response.newSessionId };
        } catch (err) {
          logger.error({ err }, 'Persistent agent failed, falling back to on-demand container');
        }
      }
    }

    // Check abort before spawning on-demand container
    if (signal?.aborted) {
      return { response: null };
    }

    // On-demand container
    try {
      const output = await runContainerAgent(req.group, {
        prompt: req.prompt,
        sessionId: req.sessionId,
        groupFolder: req.group.folder,
        chatJid: req.chatJid,
        isMain: req.isMain,
      });

      if (signal?.aborted) return { response: null };

      if (output.newSessionId) {
        this.deps.updateSession(req.group.folder, output.newSessionId);
      }

      if (output.status === 'error') {
        logger.error({ group: req.group.name, error: output.error }, 'Container agent error');
        return { response: null };
      }

      return { response: output.result, newSessionId: output.newSessionId };
    } catch (err) {
      logger.error({ group: req.group.name, err }, 'Agent error');
      return { response: null };
    }
  }

  // --- Public: IPC watcher ---

  startIpcWatcher(): void {
    const ipcBaseDir = path.join(DATA_DIR, 'ipc');
    fs.mkdirSync(ipcBaseDir, { recursive: true });

    const processIpcFiles = async () => {
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

        // Process messages
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
                  const registeredGroups = this.deps.getRegisteredGroups();
                  const targetGroup = registeredGroups[data.chatJid];
                  if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                    this.emit('action', {
                      type: 'send_message',
                      chatJid: data.chatJid,
                      text: `${ASSISTANT_NAME}: ${data.text}`,
                    });
                    logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message dispatched');
                  } else {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup },
                      'Unauthorized IPC message attempt blocked',
                    );
                  }
                }
                fs.unlinkSync(filePath);
              } catch (err) {
                logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
              }
            }
          }
        } catch (err) {
          logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
        }

        // Process tasks
        try {
          if (fs.existsSync(tasksDir)) {
            const taskFiles = fs
              .readdirSync(tasksDir)
              .filter((f) => f.endsWith('.json'));
            for (const file of taskFiles) {
              const filePath = path.join(tasksDir, file);
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                await this.processTaskIpc(data, sourceGroup, isMain);
                fs.unlinkSync(filePath);
              } catch (err) {
                logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
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

  // --- Public: scheduler ---

  startScheduler(): void {
    if (this.schedulerRunning) {
      logger.debug('Scheduler loop already running, skipping duplicate start');
      return;
    }
    this.schedulerRunning = true;
    logger.info('Scheduler loop started');

    const loop = async () => {
      try {
        const dueTasks = getDueTasks();
        if (dueTasks.length > 0) {
          logger.info({ count: dueTasks.length }, 'Found due tasks');
        }

        for (const task of dueTasks) {
          const currentTask = getTaskById(task.id);
          if (!currentTask || currentTask.status !== 'active') continue;
          await this.runScheduledTask(currentTask);
        }
      } catch (err) {
        logger.error({ err }, 'Error in scheduler loop');
      }

      setTimeout(loop, SCHEDULER_POLL_INTERVAL);
    };

    loop();
  }

  // --- Public: shutdown ---

  async shutdown(): Promise<void> {
    await shutdownMainAgentManager();
  }

  cancelSubagentsForChat(chatJid: string): void {
    for (const [id, sub] of this.activeSubagents) {
      if (sub.chatJid === chatJid) {
        sub.abortController.abort();
        this.activeSubagents.delete(id);
        logger.info({ subagentId: id, chatJid }, 'Cancelled subagent due to message merge');
      }
    }
  }

  // --- Private helpers ---

  private getAvailableGroups(): AvailableGroup[] {
    const chats = getAllChats();
    const registeredGroups = this.deps.getRegisteredGroups();
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

  private async runScheduledTask(task: ScheduledTask): Promise<void> {
    const startTime = Date.now();
    const groupDir = path.join(GROUPS_DIR, task.group_folder);
    fs.mkdirSync(groupDir, { recursive: true });

    logger.info({ taskId: task.id, group: task.group_folder }, 'Running scheduled task');

    const groups = this.deps.getRegisteredGroups();
    const group = Object.values(groups).find((g) => g.folder === task.group_folder);

    if (!group) {
      logger.error({ taskId: task.id, groupFolder: task.group_folder }, 'Group not found for task');
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'error',
        result: null,
        error: `Group not found: ${task.group_folder}`,
      });
      return;
    }

    const isMain = task.group_folder === MAIN_GROUP_FOLDER;

    // Update tasks snapshot
    const tasks = getAllTasks();
    writeTasksSnapshot(
      task.group_folder,
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

    let result: string | null = null;
    let error: string | null = null;

    const sessions = this.deps.getSessions();
    const sessionId =
      task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

    try {
      const output = await runContainerAgent(group, {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
      });

      if (output.status === 'error') {
        error = output.error || 'Unknown error';
      } else {
        result = output.result;
      }

      logger.info({ taskId: task.id, durationMs: Date.now() - startTime }, 'Task completed');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error({ taskId: task.id, error }, 'Task failed');
    }

    const durationMs = Date.now() - startTime;

    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: error ? 'error' : 'success',
      result,
      error,
    });

    let nextRun: string | null = null;
    if (task.schedule_type === 'cron') {
      const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
      nextRun = interval.next().toISOString();
    } else if (task.schedule_type === 'interval') {
      const ms = parseInt(task.schedule_value, 10);
      nextRun = new Date(Date.now() + ms).toISOString();
    }

    const resultSummary = error
      ? `Error: ${error}`
      : result
        ? result.slice(0, 200)
        : 'Completed';
    updateTaskAfterRun(task.id, nextRun, resultSummary);
  }

  private async processTaskIpc(
    data: {
      type: string;
      taskId?: string;
      prompt?: string;
      schedule_type?: string;
      schedule_value?: string;
      context_mode?: string;
      groupFolder?: string;
      chatJid?: string;
      jid?: string;
      name?: string;
      folder?: string;
      trigger?: string;
      containerConfig?: RegisteredGroup['containerConfig'];
      task?: string;
      includeContext?: boolean;
    },
    sourceGroup: string,
    isMain: boolean,
  ): Promise<void> {
    switch (data.type) {
      case 'schedule_task':
        if (data.prompt && data.schedule_type && data.schedule_value && data.groupFolder) {
          const targetGroup = data.groupFolder;
          if (!isMain && targetGroup !== sourceGroup) {
            logger.warn({ sourceGroup, targetGroup }, 'Unauthorized schedule_task attempt blocked');
            break;
          }

          const registeredGroups = this.deps.getRegisteredGroups();
          const targetJid = Object.entries(registeredGroups).find(
            ([, group]) => group.folder === targetGroup,
          )?.[0];

          if (!targetJid) {
            logger.warn({ targetGroup }, 'Cannot schedule task: target group not registered');
            break;
          }

          const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

          let nextRun: string | null = null;
          if (scheduleType === 'cron') {
            try {
              const interval = CronExpressionParser.parse(data.schedule_value, { tz: TIMEZONE });
              nextRun = interval.next().toISOString();
            } catch {
              logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
              break;
            }
          } else if (scheduleType === 'interval') {
            const ms = parseInt(data.schedule_value, 10);
            if (isNaN(ms) || ms <= 0) {
              logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
              break;
            }
            nextRun = new Date(Date.now() + ms).toISOString();
          } else if (scheduleType === 'once') {
            const scheduled = new Date(data.schedule_value);
            if (isNaN(scheduled.getTime())) {
              logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
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
          logger.info({ taskId, sourceGroup, targetGroup, contextMode }, 'Task created via IPC');
        }
        break;

      case 'pause_task':
        if (data.taskId) {
          const task = getTaskById(data.taskId);
          if (task && (isMain || task.group_folder === sourceGroup)) {
            updateTask(data.taskId, { status: 'paused' });
            logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
          } else {
            logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task pause attempt');
          }
        }
        break;

      case 'resume_task':
        if (data.taskId) {
          const task = getTaskById(data.taskId);
          if (task && (isMain || task.group_folder === sourceGroup)) {
            updateTask(data.taskId, { status: 'active' });
            logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
          } else {
            logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task resume attempt');
          }
        }
        break;

      case 'cancel_task':
        if (data.taskId) {
          const task = getTaskById(data.taskId);
          if (task && (isMain || task.group_folder === sourceGroup)) {
            deleteTask(data.taskId);
            logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
          } else {
            logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task cancel attempt');
          }
        }
        break;

      case 'refresh_groups':
        if (isMain) {
          logger.info(
            { sourceGroup },
            'Group refresh requested (no-op for Telegram, groups discovered via messages)',
          );
          const availableGroups = this.getAvailableGroups();
          const registeredGroups = this.deps.getRegisteredGroups();
          writeGroupsSnapshot(
            sourceGroup,
            true,
            availableGroups,
            new Set(Object.keys(registeredGroups)),
          );
        } else {
          logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
        }
        break;

      case 'register_group':
        if (!isMain) {
          logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
          break;
        }
        if (data.jid && data.name && data.folder && data.trigger) {
          this.emit('action', {
            type: 'register_group',
            jid: data.jid,
            name: data.name,
            folder: data.folder,
            trigger: data.trigger,
            containerConfig: data.containerConfig,
          });
        } else {
          logger.warn({ data }, 'Invalid register_group request - missing required fields');
        }
        break;

      case 'spawn_subagent':
        if (!isMain) {
          logger.warn({ sourceGroup }, 'Unauthorized spawn_subagent attempt blocked');
          break;
        }
        if (data.task && data.chatJid) {
          const chatJid = data.chatJid;
          const taskStr = data.task;

          if (this.activeSubagents.size >= MAX_CONCURRENT_SUBAGENTS) {
            logger.warn({ active: this.activeSubagents.size, max: MAX_CONCURRENT_SUBAGENTS }, 'Subagent concurrency limit reached');
            this.emit('action', {
              type: 'send_message',
              chatJid,
              text: `${ASSISTANT_NAME}: 当前有 ${this.activeSubagents.size} 个子任务在运行，请稍后再试。`,
            });
            break;
          }

          logger.info({ task: taskStr.slice(0, 100) }, 'Spawning subagent from main agent request');

          const registeredGroups = this.deps.getRegisteredGroups();
          const targetGroup = registeredGroups[chatJid];
          if (!targetGroup) {
            logger.warn({ chatJid }, 'Cannot spawn subagent: group not found');
            break;
          }

          let subagentPrompt = taskStr;
          if (data.includeContext) {
            const recentMessages = getMessagesSince(
              chatJid,
              new Date(Date.now() - 30 * 60 * 1000).toISOString(),
              ASSISTANT_NAME,
            ).slice(-10);

            if (recentMessages.length > 0) {
              const contextLines = recentMessages.map((m) =>
                `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
              );
              subagentPrompt = `<recent_context>\n${contextLines.join('\n')}\n</recent_context>\n\n${taskStr}`;
            }
          }

          // Spawn in background with tracking for cancellation
          const subAc = new AbortController();
          const subId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          this.activeSubagents.set(subId, { chatJid, abortController: subAc });

          (async () => {
            this.emit('action', { type: 'typing_start', chatJid });
            try {
              const output = await runContainerAgent(targetGroup, {
                prompt: subagentPrompt,
                sessionId: this.deps.getSessions()[targetGroup.folder],
                groupFolder: targetGroup.folder,
                chatJid,
                isMain: true,
              }, subAc.signal);

              if (subAc.signal.aborted) return;

              if (output.newSessionId) {
                this.deps.updateSession(targetGroup.folder, output.newSessionId);
              }

              if (output.status === 'success' && output.result) {
                this.emit('action', {
                  type: 'subagent_result',
                  chatJid,
                  text: output.result,
                  task: taskStr.slice(0, 200),
                });
                logger.info('Subagent completed and result dispatched');
              } else if (!subAc.signal.aborted) {
                logger.error({ error: output.error }, 'Subagent failed');
                this.emit('action', {
                  type: 'subagent_result',
                  chatJid,
                  text: `Subagent encountered an error: ${output.error || 'Unknown error'}`,
                  task: taskStr.slice(0, 200),
                });
              }
            } catch (err) {
              if (!subAc.signal.aborted) {
                logger.error({ err }, 'Error running subagent');
                this.emit('action', {
                  type: 'subagent_result',
                  chatJid,
                  text: `Failed to run subagent: ${err instanceof Error ? err.message : String(err)}`,
                  task: taskStr.slice(0, 200),
                });
              }
            } finally {
              this.activeSubagents.delete(subId);
              this.emit('action', { type: 'typing_stop', chatJid });
            }
          })();

          logger.info('Subagent task queued (running in background)');
        } else {
          logger.warn({ data }, 'Invalid spawn_subagent request - missing task or chatJid');
        }
        break;

      default:
        logger.warn({ type: data.type }, 'Unknown IPC task type');
    }
  }
}
