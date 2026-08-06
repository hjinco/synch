import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const assetRoot =
	path.basename(moduleDirectory) === "dist"
		? moduleDirectory
		: path.resolve(moduleDirectory, "../..");

/** Resolves files copied next to the production Node bundle. */
export function resolveNodeAsset(...segments: string[]): string {
	return path.resolve(assetRoot, ...segments);
}
