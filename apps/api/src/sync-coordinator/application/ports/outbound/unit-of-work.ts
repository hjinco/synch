import type { EntryStore, EntryVersionStore } from "./entry-store";
import type { BlobStore, BlobReferenceStore } from "./blob-store";
import type { CoordinatorStateStore } from "./coordinator-state-store";
import type { LocalVaultConnectionStore } from "./local-vault-connection-store";
import type { BlobGcQueries } from "./blob-gc-queries";

export interface CoordinatorStores {
	entries: EntryStore;
	versions: EntryVersionStore;
	blobs: BlobStore;
	blobReferences: BlobReferenceStore;
	state: CoordinatorStateStore;
	connections: LocalVaultConnectionStore;
	gc: BlobGcQueries;
}
/** Transaction callbacks must be synchronous; object storage I/O belongs outside them. */
export interface CoordinatorUnitOfWork<
	K extends keyof CoordinatorStores = keyof CoordinatorStores,
> {
	readonly stores: Pick<CoordinatorStores, K>;
	run<T>(
		operation: (
			stores: Pick<CoordinatorStores, K>,
		) => T extends PromiseLike<unknown> ? never : T,
	): T;
}
