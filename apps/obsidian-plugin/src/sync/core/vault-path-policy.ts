import { shouldSyncPath, type SyncFileRules } from "./file-rules";
import { classifySyncPath } from "./reserved-paths";
import {
  isDeniedVaultConfigPath,
  shouldSyncVaultConfigPath,
  type VaultConfigSyncRules,
} from "./vault-config-rules";

const DEFAULT_OBSIDIAN_CONFIG_DIR = ".obsidian";

export type VaultPathPolicyDecision =
  | { kind: "sync" }
  | { kind: "ignore-local" }
  | { kind: "forbidden" };

export interface VaultPathPolicyRules {
  fileRules: SyncFileRules;
  vaultConfigRules: VaultConfigSyncRules;
}

export function decideVaultPathSync(
  path: string,
  rules: VaultPathPolicyRules,
): VaultPathPolicyDecision {
  const safetyClass = classifySyncPath(path, rules.vaultConfigRules.configDir);
  if (
    safetyClass === "reserved-never-sync" ||
    isDeniedVaultConfigPath(path, rules.vaultConfigRules.configDir) ||
    isProtectedDefaultConfigPath(path, rules.vaultConfigRules.configDir)
  ) {
    return { kind: "forbidden" };
  }

  if (safetyClass === "reserved-config-managed") {
    return shouldSyncVaultConfigPath(path, rules.vaultConfigRules)
      ? { kind: "sync" }
      : { kind: "ignore-local" };
  }

  if (shouldSyncPath(path, rules.fileRules)) {
    return { kind: "sync" };
  }

  return { kind: "ignore-local" };
}

export function shouldApplyRemoteVaultPath(
  path: string,
  rules: Pick<VaultPathPolicyRules, "vaultConfigRules">,
): boolean {
  const safetyClass = classifySyncPath(path, rules.vaultConfigRules.configDir);
  if (safetyClass === "reserved-never-sync") {
    return false;
  }

  if (
    isDeniedVaultConfigPath(path, rules.vaultConfigRules.configDir) ||
    isProtectedDefaultConfigPath(path, rules.vaultConfigRules.configDir)
  ) {
    return false;
  }

  if (safetyClass === "reserved-config-managed") {
    return shouldSyncVaultConfigPath(path, rules.vaultConfigRules);
  }

  return true;
}

export function isForbiddenVaultPath(
  path: string,
  vaultConfigRules: Pick<VaultConfigSyncRules, "configDir">,
): boolean {
  return (
    classifySyncPath(path, vaultConfigRules.configDir) ===
      "reserved-never-sync" ||
    isDeniedVaultConfigPath(path, vaultConfigRules.configDir) ||
    isProtectedDefaultConfigPath(path, vaultConfigRules.configDir)
  );
}

function isProtectedDefaultConfigPath(path: string, configDir: string): boolean {
  if (configDir === DEFAULT_OBSIDIAN_CONFIG_DIR) {
    return false;
  }

  return classifySyncPath(path, DEFAULT_OBSIDIAN_CONFIG_DIR) !== "normal";
}
