import { eq, lte } from "drizzle-orm";
import { syncAccessRevocations } from "../../../../db/do";
import type {
	SyncAccessStore,
	SyncAccessRevocation,
} from "../../../application/ports/outbound/sync-access-store";
import type { CoordinatorStorageHandle } from "./storage-handle";

export class SqliteSyncAccessStore implements SyncAccessStore {
	constructor(private readonly handle: CoordinatorStorageHandle) {}

	readRevocations(): SyncAccessRevocation[] {
		return this.handle.db.select().from(syncAccessRevocations).all();
	}

	writeRevocation(entry: SyncAccessRevocation): void {
		this.handle.db.insert(syncAccessRevocations).values(entry)
			.onConflictDoUpdate({ target: syncAccessRevocations.key, set: entry }).run();
	}

	deleteRevocation(key: string): void {
		this.handle.db.delete(syncAccessRevocations).where(eq(syncAccessRevocations.key, key)).run();
	}

	prune(now: number): void {
		this.handle.db.delete(syncAccessRevocations).where(lte(syncAccessRevocations.expiresAt, now)).run();
	}
}
