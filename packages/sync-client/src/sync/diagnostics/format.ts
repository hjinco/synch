import type {
  SyncDiagnosticError,
  SyncDiagnosticEvent,
} from "./types";

export type SyncDiagnosticLevel = "info" | "warn" | "error";
type SyncDiagnosticValue = boolean | number | string;

const MAX_SAFE_ERROR_MESSAGE_LENGTH = 300;
const REDACTED_DIAGNOSTIC_VALUE = "<redacted>";
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "DataError",
  "InvalidAccessError",
  "NotSupportedError",
  "OperationError",
  "QuotaExceededError",
  "ApiRequestError",
  "RemoteVaultUnavailableError",
  "SyncBlobUploadError",
  "SyncRealtimeConnectionError",
  "SyncRealtimeError",
]);
const SAFE_ERROR_CODES = new Set([
  "bad_request",
  "blob_not_found",
  "blob_not_staged",
  "conflict",
  "cursor_ahead_of_server",
  "duplicate_mutation_id",
  "forbidden",
  "invalid_cursor_range",
  "local_vault_replaced",
  "no_history",
  "not_deleted",
  "not_found",
  "quota_exceeded",
  "restore_commit_pending",
  "size_mismatch",
  "sync_paused",
  "stale_revision",
  "unauthorized",
  "unavailable",
  "version_mismatch",
]);

export interface SyncDiagnosticRecord {
  timestamp: string;
  level: SyncDiagnosticLevel;
  event: string;
  details: Record<string, SyncDiagnosticValue>;
}

export function formatDiagnosticEvent(
  event: SyncDiagnosticEvent,
  timestamp: string,
): SyncDiagnosticRecord {
  switch (event.type) {
    case "sync_started":
      return createRecord(timestamp, "info", event.type, {
        source: event.source,
      });
    case "sync_reconciled":
      return createRecord(timestamp, "info", event.type, {
        source: event.source,
        filesScanned: event.filesScanned,
        filesQueuedForUpsert: event.filesQueuedForUpsert,
        filesQueuedForDelete: event.filesQueuedForDelete,
      });
    case "sync_completed":
      return createRecord(timestamp, "info", event.type, {
        source: event.source,
      });
    case "connection_state_changed":
      return createRecord(timestamp, "info", event.type, {
        state: event.state,
      });
    case "work_scheduled":
      return createRecord(timestamp, "info", event.type, {
        mode: event.mode,
      });
    case "retry_scheduled":
      return createRecord(timestamp, "warn", event.type, {
        attempt: event.attempt,
        delayMs: event.delayMs,
      });
    case "remote_vault_unavailable":
      return createRecord(timestamp, "error", event.type, {
        reason: event.reason,
      });
    case "storage_quota_exceeded":
      return createRecord(timestamp, "error", event.type, {});
    case "rollback_rejected":
      return createRecord(timestamp, "warn", event.type, {
        localRevision: event.localRevision,
        remoteRevision: event.remoteRevision,
      });
    case "local_file_queued":
      return createRecord(timestamp, "info", event.type, {
        operation: event.operation,
        path: event.path,
        ...(event.oldPath ? { oldPath: event.oldPath } : {}),
      });
    case "file_sync_started":
      return createRecord(timestamp, "info", event.type, {
        direction: event.direction,
        operation: event.operation,
        path: event.path,
      });
    case "file_sync_completed":
      return createRecord(timestamp, "info", event.type, {
        direction: event.direction,
        operation: event.operation,
        path: event.path,
        ...(event.revision !== undefined ? { revision: event.revision } : {}),
      });
    case "file_sync_failed":
      return createRecord(timestamp, "error", event.type, {
        direction: event.direction,
        operation: event.operation,
        path: event.path,
        ...(event.oldPath ? { oldPath: event.oldPath } : {}),
        reason: event.reason,
      });
  }
}

export function formatDiagnosticError(
  input: SyncDiagnosticError,
  timestamp: string,
): SyncDiagnosticRecord {
  const details = getErrorDetails(input.error);
  return {
    timestamp,
    level: input.classification === "offline" ? "warn" : "error",
    event: "sync_error",
    details: {
      phase: input.phase,
      ...(input.classification
        ? { classification: input.classification }
        : {}),
      ...(details.name ? { name: details.name } : {}),
      ...(details.message ? { message: details.message } : {}),
      ...(details.code ? { code: details.code } : {}),
      ...(details.status !== undefined ? { status: details.status } : {}),
    },
  };
}

export function formatDiagnosticRecord(record: SyncDiagnosticRecord): string {
  const details = Object.entries(record.details)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
  const suffix = details ? ` ${details}` : "";
  return `[${record.timestamp}] ${record.level.toUpperCase()} ${record.event}${suffix}`;
}

export function formatDiagnosticText(
  pluginVersion: string,
  records: readonly SyncDiagnosticRecord[],
): string {
  const header = [
    "Synch sync diagnostics",
    `pluginVersion=${formatValue(pluginVersion)}`,
    `entries=${records.length}`,
  ].join("\n");
  if (records.length === 0) {
    return header;
  }

  return `${header}\n\n${records.map(formatDiagnosticRecord).join("\n")}`;
}

function createRecord(
  timestamp: string,
  level: SyncDiagnosticLevel,
  event: string,
  details: Record<string, SyncDiagnosticValue>,
): SyncDiagnosticRecord {
  return { timestamp, level, event, details };
}

function getErrorDetails(error: unknown): {
  name: string;
  message: string;
  code: string;
  status: number | undefined;
} {
  const record = isRecord(error) ? error : null;
  const name =
    error instanceof Error
      ? error.name
      : typeof record?.name === "string"
        ? record.name
        : "Error";
  const rawCode = typeof record?.code === "string" ? record.code : "";
  const status = typeof record?.status === "number" ? record.status : undefined;
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : typeof error === "string"
          ? error
          : "";

  return {
    name: SAFE_ERROR_NAMES.has(name) ? name : "Error",
    message: sanitizeErrorMessage(rawMessage),
    code: getSafeErrorCode(rawCode),
    status,
  };
}

function sanitizeErrorMessage(message: string): string {
  const redacted = message
    .replace(
      /\b(authorization)(\s*[:=]\s*)[^\r\n]*/gi,
      (_match, label: string, separator: string) =>
        `${label}${separator}${REDACTED_DIAGNOSTIC_VALUE}`,
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED_DIAGNOSTIC_VALUE}`)
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|api[_-]?key|vault[_-]?key|password)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      (_match, label: string, separator: string) =>
        `${label}${separator}${REDACTED_DIAGNOSTIC_VALUE}`,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      REDACTED_DIAGNOSTIC_VALUE,
    );

  const normalized = Array.from(redacted, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  })
    .join("")
    .trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= MAX_SAFE_ERROR_MESSAGE_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_SAFE_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function getSafeErrorCode(code: string): string {
  if (SAFE_ERROR_CODES.has(code) || /^http_\d{3}$/.test(code)) {
    return code;
  }
  return "";
}

function formatValue(value: SyncDiagnosticValue): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
