import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openExclusiveSqliteConnection } from "./sqlite-storage-handle";

describe("openExclusiveSqliteConnection", () => {
	let dir: string;

	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lets a second process-local connection through the OS file lock only after the first closes", () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-sqlite-lock-"));
		const filePath = path.join(dir, "vault.sqlite");

		const first = openExclusiveSqliteConnection(filePath);
		expect(first.pragma("journal_mode", { simple: true })).toBe("wal");

		expect(() => openExclusiveSqliteConnection(filePath)).toThrow(
			/failed to acquire exclusive lock/,
		);

		first.close();
		const second = openExclusiveSqliteConnection(filePath);
		second.close();
	});
});
