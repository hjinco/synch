import { checkObsidianPluginVersion } from "../../domain/policy";
import type { PluginVersionCheckDto } from "../dto/plugin-version-check";
import type { CheckPluginVersion } from "../ports/inbound/check-plugin-version";

export class CheckPluginVersionUseCase implements CheckPluginVersion {
	execute(currentVersion: string): PluginVersionCheckDto {
		return checkObsidianPluginVersion(currentVersion);
	}
}
