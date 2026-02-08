/**
 * Main Agent Manager - Persistent Container Lifecycle Management
 * Manages a long-running container for Main group to eliminate startup overhead
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import {
  PERSISTENT_HEALTH_CHECK_INTERVAL,
  PERSISTENT_REQUEST_TIMEOUT,
} from './config.js';
import { buildVolumeMounts, buildContainerArgs } from './container-common.js';
import { logger } from './logger.js';
import { RegisteredGroup, PersistentContainerResponse } from './types.js';

interface PendingRequest {
  resolve: (value: QueryResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface QueryResponse {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export class MainAgentManager extends EventEmitter {
  private container: ChildProcess | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private restartAttempts = 0;
  private maxRestartAttempts = 3;
  private isShuttingDown = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private group: RegisteredGroup;
  private outputBuffer = '';

  constructor(group: RegisteredGroup) {
    super();
    this.group = group;
  }

  async start(): Promise<void> {
    if (this.container) {
      logger.warn('Persistent container already running');
      return;
    }

    logger.info('Starting persistent main agent container...');

    try {
      const mounts = this.getVolumeMounts();
      const containerName = `nanoclaw-main-persistent`;
      const containerArgs = this.getContainerArgs(mounts, containerName);

      this.container = spawn('docker', containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Setup event handlers
      this.container.stdout?.on('data', (data) => this.handleStdout(data));
      this.container.stderr?.on('data', (data) => this.handleStderr(data));
      this.container.on('close', (code) => this.handleClose(code));
      this.container.on('error', (err) => this.handleError(err));

      // Start health checks
      this.startHealthChecks();

      logger.info({ containerName }, 'Persistent main agent started');
      this.restartAttempts = 0;
    } catch (err) {
      logger.error({ err }, 'Failed to start persistent container');
      throw err;
    }
  }

  async query(
    prompt: string,
    sessionId: string | undefined,
    chatJid: string
  ): Promise<QueryResponse> {
    if (!this.container || this.isShuttingDown) {
      throw new Error('Persistent container not available');
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, PERSISTENT_REQUEST_TIMEOUT);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      // Send request via stdin
      const request = {
        requestId,
        prompt,
        sessionId,
        groupFolder: this.group.folder,
        chatJid,
        isMain: true,
        command: 'query',
      };

      try {
        this.container!.stdin!.write(JSON.stringify(request) + '\n');
        const sendTime = Date.now() - startTime;
        logger.info({ requestId, sendTime }, 'Query sent to persistent container');
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(new Error(`Failed to send request: ${err}`));
      }
    });
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;
    logger.info('Shutting down persistent main agent...');

    // Stop health checks
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Reject all pending requests
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Container shutting down'));
    }
    this.pendingRequests.clear();

    // Send shutdown command
    if (this.container && this.container.stdin) {
      try {
        const shutdownRequest = {
          requestId: 'shutdown',
          command: 'shutdown',
        };
        this.container.stdin.write(JSON.stringify(shutdownRequest) + '\n');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Force kill if still running
    if (this.container) {
      this.container.kill('SIGTERM');
      this.container = null;
    }

    logger.info('Persistent main agent shut down');
  }

  private getVolumeMounts() {
    return buildVolumeMounts(this.group, true);
  }

  private getContainerArgs(
    mounts: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>,
    containerName: string,
  ): string[] {
    return buildContainerArgs(mounts, containerName, { persistent: true });
  }

  private handleStdout(data: Buffer): void {
    this.outputBuffer += data.toString();

    // Process complete lines
    const lines = this.outputBuffer.split('\n');
    this.outputBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response: PersistentContainerResponse = JSON.parse(line);
        this.handleResponse(response);
      } catch (err) {
        logger.warn({ line }, 'Failed to parse container response');
      }
    }
  }

  private handleStderr(data: Buffer): void {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line) {
        logger.debug({ container: 'main-persistent' }, line);
      }
    }
  }

  private handleResponse(response: PersistentContainerResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) {
      logger.warn({ requestId: response.requestId }, 'Received response for unknown request');
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.requestId);

    // Extract timestamp from requestId (req-TIMESTAMP-random)
    const timestamp = parseInt(response.requestId.split('-')[1]);
    const responseTime = Date.now() - timestamp;

    logger.info({
      requestId: response.requestId,
      responseTime,
      status: response.status
    }, 'Received response from persistent container');

    if (response.status === 'success') {
      pending.resolve({
        status: response.status,
        result: response.result,
        newSessionId: response.newSessionId,
      });
    } else {
      pending.reject(new Error(response.error || 'Unknown error'));
    }
  }

  private handleClose(code: number | null): void {
    logger.warn({ code, restartAttempts: this.restartAttempts }, 'Persistent container closed');

    // Reject all pending requests
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Container crashed'));
    }
    this.pendingRequests.clear();

    this.container = null;

    if (this.isShuttingDown) return;

    // Auto-restart with exponential backoff
    if (this.restartAttempts < this.maxRestartAttempts) {
      const delay = Math.pow(2, this.restartAttempts) * 1000; // 1s, 2s, 4s
      this.restartAttempts++;
      logger.info({ delay, attempt: this.restartAttempts }, 'Restarting persistent container...');
      setTimeout(() => {
        this.start().catch((err) => {
          logger.error({ err }, 'Failed to restart persistent container');
          this.emit('fatal-crash');
        });
      }, delay);
    } else {
      logger.error('Max restart attempts reached');
      this.emit('fatal-crash');
    }
  }

  private handleError(err: Error): void {
    logger.error({ err }, 'Persistent container error');
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(() => {
      if (!this.container || this.isShuttingDown) return;

      const requestId = `health-${Date.now()}`;
      try {
        this.container.stdin!.write(
          JSON.stringify({
            requestId,
            command: 'health',
          }) + '\n'
        );
      } catch (err) {
        logger.warn({ err }, 'Health check failed');
      }
    }, PERSISTENT_HEALTH_CHECK_INTERVAL);
  }
}

// Singleton instance
let mainAgentManager: MainAgentManager | null = null;

export function initMainAgentManager(group: RegisteredGroup): void {
  if (mainAgentManager) {
    logger.warn('Main agent manager already initialized');
    return;
  }

  mainAgentManager = new MainAgentManager(group);
  mainAgentManager.start().catch((err) => {
    logger.error({ err }, 'Failed to start main agent manager');
    mainAgentManager = null;
  });

  mainAgentManager.on('fatal-crash', () => {
    logger.error('Persistent container crashed permanently, falling back to on-demand mode');
    mainAgentManager = null;
  });
}

export function getMainAgentManager(): MainAgentManager | null {
  return mainAgentManager;
}

export async function shutdownMainAgentManager(): Promise<void> {
  if (mainAgentManager) {
    await mainAgentManager.shutdown();
    mainAgentManager = null;
  }
}
