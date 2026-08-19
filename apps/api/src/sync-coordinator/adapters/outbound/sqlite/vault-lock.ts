/**
 * Serializes async work per vault within a single process.
 *
 * A Durable Object gets this for free: exactly one instance ever handles a
 * given vault, and JS run-to-completion means nothing else touches its
 * storage between an `await` in one request and the next. A self-hosted
 * Node process has neither guarantee — one process can hold many vaults,
 * and two requests for the same vault can genuinely interleave across an
 * `await` (e.g. a blob upload confirmation between a stage and a commit).
 * `VaultLockRegistry` re-creates the DO's serialization by queuing callers
 * per vault ID; unrelated vaults never block each other.
 *
 * This is separate from the process-level exclusive SQLite lock
 * (`openExclusiveSqliteConnection`), which guards against a second *process*
 * touching the same database file. This lock only protects against races
 * *within* one running process.
 */
export class VaultLockRegistry {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(vaultId: string, fn: () => Promise<T> | T): Promise<T> {
		const previousTail = this.tails.get(vaultId) ?? Promise.resolve();
		let releaseNext: () => void = () => {};
		const ourTail = previousTail.then(
			() =>
				new Promise<void>((resolve) => {
					releaseNext = resolve;
				}),
		);
		this.tails.set(vaultId, ourTail);

		await previousTail;
		try {
			return await fn();
		} finally {
			releaseNext();
			if (this.tails.get(vaultId) === ourTail) {
				this.tails.delete(vaultId);
			}
		}
	}
}
