export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath: string; // Path inside container (under /workspace/extra/)
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  env?: Record<string, string>;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
}

export interface Session {
  [folder: string]: string;
}

export interface MessageAttachment {
  type: string;
  filePath: string;
  fileName?: string;
  fileSize?: number;
  caption?: string;
  mimeType?: string;
}

export interface QuotedMessage {
  messageId: string;
  senderName: string;
  content: string;
  timestamp: string;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  message_type?: string;
  attachments?: string; // JSON string in DB
  quoted_message?: string; // JSON string in DB
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface PersistentContainerRequest {
  requestId: string;
  prompt?: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  command?: 'query' | 'shutdown' | 'health' | 'spawn_subagent';
  // For spawn_subagent command
  subagentTask?: string;
  includeContext?: boolean;
}

export interface PersistentContainerResponse {
  requestId: string;
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// --- Task Manager types ---

/** Events emitted by TaskManager for main process to execute */
export type TaskManagerEvent =
  | { type: 'send_message'; chatJid: string; text: string }
  | { type: 'subagent_result'; chatJid: string; text: string; task: string }
  | { type: 'typing_start'; chatJid: string }
  | { type: 'typing_stop'; chatJid: string }
  | { type: 'update_session'; folder: string; sessionId: string }
  | { type: 'register_group'; jid: string; name: string; folder: string; trigger: string; containerConfig?: ContainerConfig };

/** Request from main process to task-manager */
export interface AgentRequest {
  group: RegisteredGroup;
  prompt: string;
  sessionId?: string;
  chatJid: string;
  isMain: boolean;
}

/** Result returned from task-manager to main process */
export interface AgentResult {
  response: string | null;
  newSessionId?: string;
}

/** File download info passed from main process to file-handler */
export interface TelegramFileInfo {
  file_id: string;
  file_unique_id: string;
  file_path?: string;
  file_size?: number;
}

/** Result of a file download */
export interface DownloadResult {
  localPath: string;
  fileName: string;
}
