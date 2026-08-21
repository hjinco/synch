import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const apiDir = path.join(repositoryDir, "apps", "api");
const apiPackagePath = path.join(apiDir, "package.json");
const apiLockfilePath = path.join(apiDir, "pnpm-lock.yaml");
const checkOnly = process.argv[2] === "--check";

if (process.argv.length > (checkOnly ? 3 : 2)) {
	throw new Error("Usage: node scripts/sync-api-lockfile.mjs [--check]");
}

const apiPackage = JSON.parse(readFileSync(apiPackagePath, "utf8"));
const importerSections = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
];
const expectedSpecifiers = new Map();

for (const section of importerSections) {
	for (const [name, specifier] of Object.entries(apiPackage[section] ?? {})) {
		if (typeof specifier !== "string") {
			throw new Error(
				`Expected ${section}.${name} to be a string dependency specifier.`,
			);
		}
		expectedSpecifiers.set(`${section}:${name}`, specifier);
	}
}

const temporaryDirectory = mkdtempSync(
	path.join(tmpdir(), "synch-api-lockfile-"),
);

try {
	const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
	const result = spawnSync(
		pnpmCommand,
		[
			"--config.inject-workspace-packages=true",
			"--filter",
			"@synch/api",
			"deploy",
			temporaryDirectory,
			"--reporter=append-only",
		],
		{
			cwd: repositoryDir,
			stdio: "inherit",
		},
	);

	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`pnpm deploy exited with status ${result.status}.`);
	}

	const generatedLockfilePath = path.join(
		temporaryDirectory,
		"pnpm-lock.yaml",
	);
	const normalizedLockfile = normalizeImporterSpecifiers(
		readFileSync(generatedLockfilePath, "utf8"),
		expectedSpecifiers,
	);

	if (checkOnly) {
		let existingLockfile;
		try {
			existingLockfile = readFileSync(apiLockfilePath, "utf8");
		} catch (error) {
			if (error?.code === "ENOENT") {
				throw new Error(
					`${path.relative(repositoryDir, apiLockfilePath)} is missing. Run pnpm sync:api-lockfile.`,
				);
			}
			throw error;
		}

		if (existingLockfile !== normalizedLockfile) {
			throw new Error(
				`${path.relative(repositoryDir, apiLockfilePath)} is out of date. Run pnpm sync:api-lockfile.`,
			);
		}

		console.log(`${path.relative(repositoryDir, apiLockfilePath)} is up to date.`);
	} else {
		writeFileSync(apiLockfilePath, normalizedLockfile);
		console.log(`Updated ${path.relative(repositoryDir, apiLockfilePath)}.`);
	}
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}

function normalizeImporterSpecifiers(lockfile, specifiers) {
	const lines = lockfile.split("\n");
	let inRootImporter = false;
	let importerSection = null;
	let currentPackage = null;
	const seen = new Set();

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];

		if (!inRootImporter) {
			if (line === "  .:") {
				inRootImporter = true;
			}
			continue;
		}

		if (line === "packages:") {
			break;
		}

		const importerField = line.match(/^    ([^ ].*):$/);
		if (importerField) {
			importerSection = importerSections.includes(importerField[1])
				? importerField[1]
				: null;
			currentPackage = null;
			continue;
		}

		if (!importerSection) {
			continue;
		}

		const packageField = parsePackageField(line);
		if (packageField) {
			currentPackage = packageField;
			continue;
		}

		const specifierMatch = line.match(/^        specifier:.*$/);
		if (!specifierMatch || !currentPackage) {
			continue;
		}

		const key = `${importerSection}:${currentPackage}`;
		const specifier = specifiers.get(key);
		if (specifier === undefined) {
			throw new Error(
				`Generated lockfile contains an unexpected ${key} importer.`,
			);
		}

		lines[index] = `        specifier: ${formatYamlScalar(specifier)}`;
		seen.add(key);
	}

	for (const key of specifiers.keys()) {
		if (!seen.has(key)) {
			throw new Error(`Generated lockfile is missing the ${key} importer.`);
		}
	}

	return lines.join("\n");
}

function parsePackageField(line) {
	const match = line.match(
		/^      (?:'((?:[^']|'')+)'|"([^"]+)"|([^:]+)):\s*$/,
	);
	if (!match) {
		return null;
	}

	return (match[1] ?? match[2] ?? match[3]).replaceAll("''", "'").trim();
}

function formatYamlScalar(value) {
	return /^[A-Za-z0-9@._+*^~<>/=|?!,-]+$/.test(value)
		? value
		: JSON.stringify(value);
}
