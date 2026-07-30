import { drizzle } from "drizzle-orm/durable-sqlite";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import * as doSchema from "../../../db/do";

/**
 * Driver-agnostic drizzle handle. `drizzle-orm/durable-sqlite` and
 * `drizzle-orm/better-sqlite3` both produce a `BaseSQLiteDatabase<'sync', ...>`,
 * so store code that only uses select/insert/update/delete/transaction stays
 * portable across backends.
 */
// TRunResult is `unknown` because no store code reads a `.run()` return value;
// this stays safe as long as that holds across backends.
export type CoordinatorDb = BaseSQLiteDatabase<"sync", unknown, typeof doSchema>;

export interface CoordinatorSqlCursor<T> {
	toArray(): T[];
	one(): T;
}

/** Column value types a portable SQL row can hold, independent of any Workers global. */
export type CoordinatorSqlValue = ArrayBuffer | string | number | null;

/**
 * Storage seam the coordinator store classes are built on. `exec` mirrors
 * `DurableObjectStorage["sql"]["exec"]` and must share its connection with
 * `db`, since store code interleaves raw `exec` calls inside `db.transaction`.
 */
export interface CoordinatorStorageHandle {
	readonly db: CoordinatorDb;
	exec<T extends Record<string, CoordinatorSqlValue> = Record<string, CoordinatorSqlValue>>(
		query: string,
		...bindings: unknown[]
	): CoordinatorSqlCursor<T>;
}

export class DurableObjectCoordinatorStorageHandle implements CoordinatorStorageHandle {
	readonly db: CoordinatorDb;

	constructor(private readonly storage: DurableObjectStorage) {
		this.db = drizzle(storage, { schema: doSchema });
	}

	exec<T extends Record<string, CoordinatorSqlValue> = Record<string, CoordinatorSqlValue>>(
		query: string,
		...bindings: unknown[]
	): CoordinatorSqlCursor<T> {
		return this.storage.sql.exec<T>(query, ...bindings);
	}
}
