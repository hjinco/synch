export const MIN_SUPPORTED_OBSIDIAN_PLUGIN_VERSION = "0.0.9";
export const SYNCH_API_MAJOR_VERSION = 1;

export type ObsidianPluginVersionCheckResult =
	| {
			status: "ok";
			minVersion: string;
			apiMajor: number;
	  }
	| {
			status: "update_required";
			minVersion: string;
			apiMajor: number;
			message: string;
	  };

export function checkObsidianPluginVersion(
	currentVersion: string,
	options: {
		minVersion?: string;
		apiMajor?: number;
	} = {},
): ObsidianPluginVersionCheckResult {
	const minVersion = options.minVersion ?? MIN_SUPPORTED_OBSIDIAN_PLUGIN_VERSION;
	const apiMajor = options.apiMajor ?? SYNCH_API_MAJOR_VERSION;

	if (compareStrictSemver(currentVersion, minVersion) < 0) {
		return {
			status: "update_required",
			minVersion,
			apiMajor,
			message:
				"Synch plugin update is required. Sync has been paused until the plugin is updated.",
		};
	}

	return {
		status: "ok",
		minVersion,
		apiMajor,
	};
}

export function compareStrictSemver(left: string, right: string): number {
	const parsedLeft = parseStrictSemver(left);
	const parsedRight = parseStrictSemver(right);
	if (!parsedLeft || !parsedRight) {
		throw new Error("Expected strict x.y.z versions.");
	}

	for (let index = 0; index < parsedLeft.length; index += 1) {
		const difference = parsedLeft[index] - parsedRight[index];
		if (difference !== 0) {
			return difference;
		}
	}

	return 0;
}

export function isStrictSemver(value: string): boolean {
	return parseStrictSemver(value) !== null;
}

function parseStrictSemver(value: string): [number, number, number] | null {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
	if (!match) {
		return null;
	}

	return [Number(match[1]), Number(match[2]), Number(match[3])];
}
