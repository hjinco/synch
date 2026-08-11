export interface ConflictFileWriter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary(path: string, content: Uint8Array): Promise<void>;
}

export async function writeConflictCopy(
  writer: ConflictFileWriter,
  path: string,
  bytes: Uint8Array,
  now = Date.now,
): Promise<string> {
  const conflictPath = await getAvailableConflictCopyPath(writer, path, now);
  await ensureParentDirectories(writer, conflictPath);
  await writer.writeBinary(conflictPath, bytes);
  return conflictPath;
}

export async function getAvailableConflictCopyPath(
  writer: Pick<ConflictFileWriter, "exists">,
  path: string,
  now = Date.now,
): Promise<string> {
  const timestamp = formatConflictTimestamp(now());
  let attempt = 0;
  let conflictPath = buildConflictCopyPath(path, timestamp, attempt);
  while (await writer.exists(conflictPath)) {
    attempt += 1;
    conflictPath = buildConflictCopyPath(path, timestamp, attempt);
  }

  return conflictPath;
}

async function ensureParentDirectories(
  writer: Pick<ConflictFileWriter, "exists" | "mkdir">,
  path: string,
): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    if (!part) {
      continue;
    }

    current = current ? `${current}/${part}` : part;
    if (!(await writer.exists(current))) {
      await writer.mkdir(current);
    }
  }
}

function buildConflictCopyPath(
  path: string,
  timestamp: string,
  attempt: number,
): string {
  const slashIndex = path.lastIndexOf("/");
  const parent = slashIndex >= 0 ? path.slice(0, slashIndex) : "";
  const fileName = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const dotIndex = fileName.lastIndexOf(".");
  const hasExtension = dotIndex > 0;
  const stem = hasExtension ? fileName.slice(0, dotIndex) : fileName;
  const extension = hasExtension ? fileName.slice(dotIndex) : "";
  const prefix = parent ? `${parent}/` : "";
  const baseName = `${prefix}${stem}.sync-conflict-${timestamp}`;
  if (attempt === 0) {
    return `${baseName}${extension}`;
  }

  return `${baseName}-${attempt + 1}${extension}`;
}

function formatConflictTimestamp(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}
