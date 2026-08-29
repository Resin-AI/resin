import type { DaemonConfig, RedactedDaemonConfig } from "../config.js";
import type {
  ConfigReloadResult,
  DaemonDiagnosticsReport,
  DaemonHealthReport,
  ModuleStatusReport,
} from "../supervisor.js";

export type IpcMethod =
  | "ping"
  | "getHealth"
  | "getModuleStatus"
  | "reloadConfig"
  | "getDiagnostics"
  | "gracefulShutdown";

export interface IpcRequest<TParams = unknown> {
  id: string;
  token?: string;
  method: IpcMethod | string;
  params?: TParams;
}

export interface IpcError {
  code: string;
  message: string;
  details?: unknown;
}

export interface IpcResponse<TResult = unknown> {
  id: string;
  result?: TResult;
  error?: IpcError;
}

// Method-specific parameter and result definitions
export interface PingParams {
  nonce?: string;
}

export interface PingResult {
  pong: true;
  nonce?: string;
  timestamp: number;
}

export interface GetModuleStatusParams {
  moduleId?: string;
}

export interface ReloadConfigParams {
  config?: Partial<DaemonConfig>;
}

export interface GracefulShutdownParams {
  timeoutMs?: number;
  reason?: string;
}

export interface GracefulShutdownResult {
  accepted: boolean;
  message: string;
}

export const IPC_ERROR_CODES = {
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_REQUEST: "INVALID_REQUEST",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SHUTDOWN_IN_PROGRESS: "SHUTDOWN_IN_PROGRESS",
  TIMEOUT: "TIMEOUT",
  CONNECTION_CLOSED: "CONNECTION_CLOSED",
} as const;
