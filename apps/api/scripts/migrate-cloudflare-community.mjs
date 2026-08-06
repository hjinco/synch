// Applies app DB migrations for the community edition deployed on Cloudflare.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const databaseName = process.env.SYNCH_D1_DATABASE_NAME ?? "synch-db";
const bindingName = "DB";

function runWrangler(args, options = {}) {
	const result = spawnSync("wrangler", args, {
		cwd: projectDir,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		if (options.capture) {
			process.stderr.write(result.stderr);
			process.stdout.write(result.stdout);
		}
		process.exit(result.status ?? 1);
	}

	return result.stdout;
}

function parseJsonOutput(output) {
	const start = output.search(/[\[{]/);
	if (start === -1) {
		throw new Error("Wrangler did not return JSON output.");
	}
	return JSON.parse(output.slice(start));
}

function getDatabaseId() {
	if (process.env.CLOUDFLARE_D1_DATABASE_ID) {
		return process.env.CLOUDFLARE_D1_DATABASE_ID;
	}

	const output = runWrangler(["d1", "list", "--json"], { capture: true });
	const parsed = parseJsonOutput(output);
	const databases = Array.isArray(parsed) ? parsed : (parsed.databases ?? parsed.result ?? []);
	if (!Array.isArray(databases)) {
		throw new Error("Wrangler returned an unexpected D1 list response.");
	}
	const database = databases.find((entry) => entry.name === databaseName);

	if (!database) {
		throw new Error(
			`Could not find D1 database "${databaseName}". Deploy first so Wrangler can provision it, or set CLOUDFLARE_D1_DATABASE_ID.`,
		);
	}

	return database.uuid ?? database.id ?? database.database_id;
}

const databaseId = getDatabaseId();
if (!databaseId) {
	throw new Error(`D1 database "${databaseName}" did not include an id in Wrangler output.`);
}

const tempDir = mkdtempSync(path.join(tmpdir(), "synch-api-migrate-"));
const tempConfigPath = path.join(tempDir, "wrangler.json");

try {
	writeFileSync(
		tempConfigPath,
		JSON.stringify(
			{
				name: "synch-api",
				compatibility_date: "2026-04-14",
				d1_databases: [
					{
						binding: bindingName,
						database_name: databaseName,
						database_id: databaseId,
						migrations_dir: path.join(projectDir, "drizzle"),
					},
				],
			},
			null,
			2,
		),
	);

	runWrangler([
		"d1",
		"migrations",
		"apply",
		databaseName,
		"--remote",
		"--config",
		tempConfigPath,
	]);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
