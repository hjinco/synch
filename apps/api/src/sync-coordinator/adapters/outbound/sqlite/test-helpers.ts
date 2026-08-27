import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CoordinatorBlobStore } from "./blob-store";
import { CoordinatorBlobGcStore } from "./blob-gc-store";
import { CoordinatorStaleStagedBlobStore } from "./stale-staged-blob-store";
import { CoordinatorCursorStore } from "./cursor-store";
import { CoordinatorEntryStore } from "./entry-store";
import { CoordinatorHealthStore } from "./health-store";
import { CoordinatorHistoryStore } from "./history-store";
import { CoordinatorMutationStore } from "./mutation-store";
import { MutationService } from "../../../application/services/mutation-service";
import {
	openExclusiveSqliteConnection,
	SqliteCoordinatorStorageHandle,
} from "./storage-handle";
import { SqliteCoordinatorStorage } from "./storage-lifecycle";
import type { SocketSession, VaultStateLimits } from "../../../application/dto/types";

export const DEFAULT_TEST_LIMITS: VaultStateLimits = {
	storageLimitBytes: 1_000_000_000,
	maxFileSizeBytes: 10_000_000,
	versionHistoryRetentionDays: 1,
};

const openConnections: Array<{ sqlite: Database.Database; dir: string }> = [];

/**
 * Backed by a real file with the same `journal_mode = WAL` +
 * `locking_mode = EXCLUSIVE` pragmas the production connection uses (see
 * `openExclusiveSqliteConnection`), not `:memory:` — an in-memory DB can't
 * run WAL at all, so it would never exercise the configuration this backend
 * actually ships with. Call `closeAllTestSqliteCoordinators()` in an
 * `afterEach` to release the file handle and temp directory.
 */
export async function createSqliteCoordinator(
	vaultId = "vault-1",
	limits: VaultStateLimits = DEFAULT_TEST_LIMITS,
) {
	const dir = mkdtempSync(path.join(tmpdir(), "synch-sqlite-test-"));
	const filePath = path.join(dir, "vault.sqlite");
	const sqlite = openExclusiveSqliteConnection(filePath);
	openConnections.push({ sqlite, dir });

	const lifecycle = new SqliteCoordinatorStorage(sqlite);
	await lifecycle.migrate();

	const handle = new SqliteCoordinatorStorageHandle(sqlite);
	const cursorStore = new CoordinatorCursorStore(handle);
	cursorStore.ensureVaultState(vaultId, limits);
	const blobStore = new CoordinatorBlobStore(handle);
	const blobGcStore = new CoordinatorBlobGcStore(handle);
	const staleStagedBlobStore = new CoordinatorStaleStagedBlobStore(handle);
	const mutationStoreAdapter = new CoordinatorMutationStore(handle);
	const mutationService = new MutationService(
		mutationStoreAdapter,
		{ scheduleNext: async () => null },
		cursorStore,
		{
			exists: async () => true,
			delete: async () => {},
			deleteMany: async () => ({ failedKeys: [] }),
			deleteByPrefix: async () => {},
		},
		{
			blobObjectKey: (id: string, blobId: string) => `${id}/${blobId}`,
			blobObjectKeyPrefix: (id: string) => `${id}/`,
		},
		30 * 60 * 1000,
		{ scheduleSummaryFlush: async () => {} },
	);
	const mutationStore = {
		commitMutations: (
			session: Parameters<MutationService["commitMutations"]>[0],
			message: Parameters<MutationService["commitMutations"]>[1],
			options?: Parameters<MutationService["commitMutations"]>[2],
		) => mutationService.commitMutations(session, message, options),
		commitMutation: (
			session: Parameters<MutationService["commitMutation"]>[0],
			message: Parameters<MutationService["commitMutation"]>[1],
			options?: Parameters<MutationService["commitMutation"]>[2],
		) => mutationService.commitMutation(session, message, options),
	};

	return {
		vaultId,
		sqlite,
		handle,
		lifecycle,
		cursorStore,
		blobStore,
		blobGcStore,
		staleStagedBlobStore,
		entryStore: new CoordinatorEntryStore(handle),
		historyStore: new CoordinatorHistoryStore(handle),
		mutationStore,
		mutationStoreAdapter,
		healthStore: new CoordinatorHealthStore(handle, { count: () => 0 }),
	};
}

export function closeAllTestSqliteCoordinators(): void {
	while (openConnections.length > 0) {
		const connection = openConnections.pop();
		if (!connection) {
			continue;
		}
		try {
			connection.sqlite.close();
		} catch {
			// already closed by the test itself; ignore
		}
		rmSync(connection.dir, { recursive: true, force: true });
	}
}

export function testSession(overrides: Partial<SocketSession> = {}): SocketSession {
	return {
		userId: "user-1",
		vaultId: "vault-1",
		localVaultId: "local-vault-1",
		displayName: "User",
		wantsStorageStatus: false,
		wantsPresence: false,
		presenceEntryId: null,
		presenceWatchEntryIds: [],
		...overrides,
	};
}
