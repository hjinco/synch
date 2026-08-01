import { mkdirSync } from "node:fs";
import path from "node:path";

import { openExclusiveSqliteConnection } from "../sync/coordinator/store/sqlite-storage-handle";
import type { CoordinatorStub } from "../sync/coordinator/proxy-repository";
import { createNodeCoordinatorRuntime, type NodeCoordinatorSharedDeps } from "./node-coordinator";
import type { NodeCoordinatorRuntime } from "./node-coordinator";

const VAULT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * In-process stand-in for a `DurableObjectNamespace`: one SQLite-backed
 * coordinator runtime per vault, created lazily on first access and kept
 * alive for the life of the process (there's no DO-style eviction/hibernation
 * here - a self-hosted deployment is expected to hold far fewer vaults than
 * a multi-tenant Cloudflare account). Satisfies the same `getByName()` shape
 * `CoordinatorProxyRepository` already depends on, so nothing above it
 * (`proxy-routes.ts`, `routes.ts`) needs to change.
 */
export class NodeCoordinatorNamespace {
	private readonly runtimes = new Map<string, NodeCoordinatorRuntime>();

	constructor(
		private readonly dataDir: string,
		private readonly sharedDeps: NodeCoordinatorSharedDeps,
	) {}

	getByName(vaultId: string): CoordinatorStub {
		return {
			fetch: async (request: Request) => {
				const runtime = this.getOrCreateRuntime(vaultId);
				await runtime.ready;
				return await runtime.app.fetch(request);
			},
		};
	}

	getOrCreateRuntime(vaultId: string): NodeCoordinatorRuntime {
		let runtime = this.runtimes.get(vaultId);
		if (!runtime) {
			const filePath = this.vaultFilePath(vaultId);
			mkdirSync(path.dirname(filePath), { recursive: true });
			const sqlite = openExclusiveSqliteConnection(filePath);
			runtime = createNodeCoordinatorRuntime(vaultId, sqlite, this.sharedDeps);
			this.runtimes.set(vaultId, runtime);
		}
		return runtime;
	}

	closeAll(): void {
		for (const runtime of this.runtimes.values()) {
			runtime.close();
		}
		this.runtimes.clear();
	}

	private vaultFilePath(vaultId: string): string {
		if (!VAULT_ID_PATTERN.test(vaultId)) {
			throw new Error(`refusing to derive a filesystem path from vault id: ${vaultId}`);
		}
		return path.join(this.dataDir, "vaults", `${vaultId}.sqlite`);
	}
}
