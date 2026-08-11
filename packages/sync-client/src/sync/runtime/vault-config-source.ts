import type { SyncVaultFile } from "../vault/ports";

export interface SyncVaultConfigSource {
  listFiles(): Promise<SyncVaultFile[]>;
}
