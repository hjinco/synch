import {
  isPathUnderFolders,
  pathHasHiddenSegment,
  shouldSyncPath,
  type SyncFileRules,
} from "./file-rules";
import { classifySyncPath } from "./reserved-paths";
import {
  isDeniedVaultConfigPath,
  shouldSyncVaultConfigPath,
  type VaultConfigSyncRules,
} from "./vault-config-rules";

export type VaultPathPolicyDecision =
  | { kind: "sync" }
  | { kind: "ignore-local" }
  | { kind: "forbidden" };

export interface VaultPathPolicyRules {
  fileRules: SyncFileRules;
  vaultConfigRules: VaultConfigSyncRules;
  configDir: string;
}

export function decideVaultPathSync(
  path: string,
  rules: VaultPathPolicyRules,
): VaultPathPolicyDecision {
  if (isForbiddenVaultPath(path, rules.configDir)) {
    return { kind: "forbidden" };
  }

  if (classifySyncPath(path, rules.configDir) === "reserved-config-managed") {
    return shouldSyncVaultConfigPath(path, rules.vaultConfigRules, rules.configDir)
      ? { kind: "sync" }
      : { kind: "ignore-local" };
  }

  if (shouldSyncPath(path, rules.fileRules, rules.configDir)) {
    return { kind: "sync" };
  }

  return { kind: "ignore-local" };
}

export function shouldApplyRemoteVaultPath(
  path: string,
  rules: VaultPathPolicyRules,
): boolean {
  if (isForbiddenVaultPath(path, rules.configDir)) {
    return false;
  }

  if (classifySyncPath(path, rules.configDir) === "reserved-config-managed") {
    return shouldSyncVaultConfigPath(
      path,
      rules.vaultConfigRules,
      rules.configDir,
    );
  }

  if (pathHasHiddenSegment(path)) {
    return isPathUnderFolders(path, rules.fileRules.includedHiddenFolders);
  }

  return true;
}

export function shouldUseLatestRemoteVaultConfig(
  path: string,
  rules: Pick<VaultPathPolicyRules, "vaultConfigRules" | "configDir">,
): boolean {
  return (
    classifySyncPath(path, rules.configDir) === "reserved-config-managed" &&
    shouldSyncVaultConfigPath(path, rules.vaultConfigRules, rules.configDir)
  );
}

export function isForbiddenVaultPath(path: string, configDir: string): boolean {
  return (
    classifySyncPath(path, configDir) === "reserved-never-sync" ||
    isDeniedVaultConfigPath(path, configDir)
  );
}
