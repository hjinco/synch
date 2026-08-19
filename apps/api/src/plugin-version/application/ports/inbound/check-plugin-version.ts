import type { PluginVersionCheckDto } from "../../dto/plugin-version-check";

export interface CheckPluginVersion {
	execute(currentVersion: string): PluginVersionCheckDto;
}
