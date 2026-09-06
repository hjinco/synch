import type {
	CoordinatorStores,
	CoordinatorUnitOfWork,
} from "../../../application/ports/outbound/unit-of-work";
import { CoordinatorBlobStore } from "./blob-store";
import { CoordinatorBlobGcQueries } from "./blob-gc-queries";
import { CoordinatorStateStore } from "./coordinator-state-store";
import { CoordinatorEntryStore } from "./entry-store";
import { CoordinatorEntryVersionStore } from "./entry-version-store";
import { CoordinatorLocalVaultConnectionStore } from "./local-vault-connection-store";
import { readBlobReferenceFacts } from "./blob-reference-facts";
import type { CoordinatorStorageHandle } from "./storage-handle";

export class SqliteCoordinatorUnitOfWork implements CoordinatorUnitOfWork {
	readonly stores: CoordinatorStores;
	constructor(private readonly handle: CoordinatorStorageHandle) {
		this.stores = createStores(handle);
	}
	run<T>(
		operation: (
			stores: CoordinatorStores,
		) => T extends PromiseLike<unknown> ? never : T,
	): T {
		return this.handle.db.transaction((tx) => {
			// Raw queries use the same physical connection and therefore the same transaction.
			const stores = createStores({
				db: tx,
				exec: this.handle.exec.bind(this.handle),
			});
			const result = operation(stores);
			if (
				result !== null &&
				(typeof result === "object" || typeof result === "function") &&
				"then" in result
			) {
				throw new TypeError("coordinator transactions must be synchronous");
			}
			return result;
		});
	}
}
function createStores(handle: CoordinatorStorageHandle): CoordinatorStores {
	return {
		entries: new CoordinatorEntryStore(handle),
		versions: new CoordinatorEntryVersionStore(handle),
		blobs: new CoordinatorBlobStore(handle),
		state: new CoordinatorStateStore(handle),
		connections: new CoordinatorLocalVaultConnectionStore(handle),
		gc: new CoordinatorBlobGcQueries(handle),
		blobReferences: {
			read: (blobId, now) => readBlobReferenceFacts(handle.db, blobId, now),
		},
	};
}
