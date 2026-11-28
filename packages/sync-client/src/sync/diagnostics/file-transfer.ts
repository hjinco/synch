import type { SyncDiagnostics, SyncDiagnosticFileDirection, TransferStage } from "./types";

let nextOperation = 0;
const CHECKPOINT_BYTES = 8 * 1024 ** 2;

/** A transfer keeps the same local ID across preparation, network and vault writes. */
export class FileTransferLog {
  private readonly operationId = ++nextOperation;
  private sizeChanged = false;

  constructor(
    private readonly diagnostics: SyncDiagnostics | undefined,
    private readonly direction: SyncDiagnosticFileDirection,
    private readonly path: string,
    private sizeBytes: number | null,
  ) {}

  observeFileSize(bytes: number): void {
    if (bytes !== this.sizeBytes) {
      this.sizeBytes = bytes;
      this.sizeChanged = true;
    }
  }

  async start(stage: TransferStage): Promise<void> {
    this.emit(stage, "started");
    if (this.sizeBytes === null || this.sizeBytes >= CHECKPOINT_BYTES) {
      await this.diagnostics?.flush?.();
    }
  }

  end(stage: TransferStage, success: boolean): void {
    this.emit(stage, success ? "completed" : "failed");
  }

  async run<T>(stage: TransferStage, work: () => Promise<T>, succeeded?: (result: T) => boolean): Promise<T> {
    if (!this.diagnostics) return work();
    await this.start(stage);
    try {
      const result = await work();
      this.end(stage, succeeded?.(result) ?? true);
      return result;
    } catch (error) {
      this.end(stage, false);
      throw error;
    }
  }

  private emit(stage: TransferStage, status: "started" | "completed" | "failed"): void {
    this.diagnostics?.record({
      type: "file_transfer_stage",
      direction: this.direction,
      operationId: this.operationId,
      stage,
      status,
      ...(status === "started" ? { path: this.path } : {}),
      ...(status === "started" || this.sizeChanged ? { sizeBytes: this.sizeBytes } : {}),
    });
    this.sizeChanged = false;
  }
}
