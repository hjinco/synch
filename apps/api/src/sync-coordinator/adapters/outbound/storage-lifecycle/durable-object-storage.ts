import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import * as doSchema from "../../../../db/do";
import doMigrations from "../../../../../drizzle-do/migrations";
import type { CoordinatorStorageLifecycle } from "../../../application/ports/outbound";

export class DurableCoordinatorStorage implements CoordinatorStorageLifecycle {
	constructor(private readonly ctx: DurableObjectState) {}

	async migrate(): Promise<void> {
		const db = drizzle(this.ctx.storage, { schema: doSchema });
		await migrate(db, doMigrations);
	}

	async purgeVaultState(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}
