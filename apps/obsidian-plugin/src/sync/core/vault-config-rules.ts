export interface VaultConfigSyncRules {
  enabled: boolean;
  configDir: string;
  mainSettings: boolean;
  appearance: boolean;
  themesAndSnippets: boolean;
  hotkeys: boolean;
  corePluginList: boolean;
  corePluginData: boolean;
  communityPluginList: boolean;
  communityPluginFiles: boolean;
  communityPluginData: boolean;
}

export const DEFAULT_VAULT_CONFIG_SYNC_RULES: VaultConfigSyncRules = {
  enabled: false,
  configDir: ".obsidian",
  mainSettings: true,
  appearance: true,
  themesAndSnippets: true,
  hotkeys: true,
  corePluginList: true,
  corePluginData: true,
  communityPluginList: false,
  communityPluginFiles: false,
  communityPluginData: false,
};

const SYNCH_PLUGIN_CONFIG_PREFIX = "plugins/synch/";
const DEVICE_LOCAL_CONFIG_PATHS = new Set([
  "workspace.json",
  "workspace-mobile.json",
]);

export function normalizeVaultConfigSyncRules(
  value: unknown,
): VaultConfigSyncRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_VAULT_CONFIG_SYNC_RULES };
  }

  const record = value as Record<string, unknown>;
  return {
    enabled: asBoolean(record.enabled, DEFAULT_VAULT_CONFIG_SYNC_RULES.enabled),
    configDir: normalizeConfigDir(record.configDir),
    mainSettings: asBoolean(
      record.mainSettings,
      DEFAULT_VAULT_CONFIG_SYNC_RULES.mainSettings,
    ),
    appearance: asBoolean(
      record.appearance,
      DEFAULT_VAULT_CONFIG_SYNC_RULES.appearance,
    ),
    themesAndSnippets: asBoolean(
      record.themesAndSnippets,
      DEFAULT_VAULT_CONFIG_SYNC_RULES.themesAndSnippets,
    ),
    hotkeys: asBoolean(record.hotkeys, DEFAULT_VAULT_CONFIG_SYNC_RULES.hotkeys),
    corePluginList: asBoolean(
      record.corePluginList,
      DEFAULT_VAULT_CONFIG_SYNC_RULES.corePluginList,
    ),
    corePluginData: asBoolean(
      record.corePluginData,
      DEFAULT_VAULT_CONFIG_SYNC_RULES.corePluginData,
    ),
    communityPluginList: asBoolean(
      record.communityPluginList,
      DEFAULT_VAULT_CONFIG_SYNC_RULES.communityPluginList,
    ),
    communityPluginFiles: asBoolean(
      record.communityPluginFiles,
      DEFAULT_VAULT_CONFIG_SYNC_RULES.communityPluginFiles,
    ),
    communityPluginData: asBoolean(
      record.communityPluginData,
      DEFAULT_VAULT_CONFIG_SYNC_RULES.communityPluginData,
    ),
  };
}

export function shouldSyncVaultConfigPath(
  path: string,
  rules: VaultConfigSyncRules,
): boolean {
  if (!rules.enabled) {
    return false;
  }

  const relativePath = getConfigRelativePath(path, rules.configDir);
  if (!relativePath || isDeniedConfigRelativePath(relativePath)) {
    return false;
  }

  if (rules.mainSettings && relativePath === "app.json") {
    return true;
  }
  if (rules.appearance && relativePath === "appearance.json") {
    return true;
  }
  if (rules.hotkeys && relativePath === "hotkeys.json") {
    return true;
  }
  if (
    rules.corePluginList &&
    (relativePath === "core-plugins.json" ||
      relativePath === "core-plugins-migration.json")
  ) {
    return true;
  }
  if (rules.communityPluginList && relativePath === "community-plugins.json") {
    return true;
  }
  if (
    rules.themesAndSnippets &&
    (relativePath.startsWith("themes/") ||
      relativePath.startsWith("snippets/"))
  ) {
    return true;
  }
  if (rules.corePluginData && isRootConfigJson(relativePath)) {
    return true;
  }
  if (rules.communityPluginFiles && isCommunityPluginFile(relativePath)) {
    return true;
  }
  if (rules.communityPluginData && isCommunityPluginData(relativePath)) {
    return true;
  }

  return false;
}

export function isDeniedVaultConfigPath(
  path: string,
  configDir: string,
): boolean {
  const relativePath = getConfigRelativePath(path, configDir);
  return relativePath !== null && isDeniedConfigRelativePath(relativePath);
}

function getConfigRelativePath(path: string, configDir: string): string | null {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedConfigDir = normalizeConfigDir(configDir);
  if (normalizedPath === normalizedConfigDir) {
    return "";
  }
  if (!normalizedPath.startsWith(`${normalizedConfigDir}/`)) {
    return null;
  }

  return normalizedPath.slice(normalizedConfigDir.length + 1);
}

function isDeniedConfigRelativePath(relativePath: string): boolean {
  return (
    DEVICE_LOCAL_CONFIG_PATHS.has(relativePath) ||
    relativePath.startsWith(SYNCH_PLUGIN_CONFIG_PREFIX) ||
    relativePath.includes(".sync-conflict-")
  );
}

function isCommunityPluginFile(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return (
    parts.length === 3 &&
    parts[0] === "plugins" &&
    ["manifest.json", "main.js", "styles.css"].includes(parts[2] ?? "")
  );
}

function isRootConfigJson(relativePath: string): boolean {
  return (
    !relativePath.includes("/") &&
    relativePath.endsWith(".json") &&
    ![
      "app.json",
      "appearance.json",
      "hotkeys.json",
      "core-plugins.json",
      "core-plugins-migration.json",
      "community-plugins.json",
    ].includes(relativePath)
  );
}

function isCommunityPluginData(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return parts.length === 3 && parts[0] === "plugins" && parts[2] === "data.json";
}

function normalizeConfigDir(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_VAULT_CONFIG_SYNC_RULES.configDir;
  }

  const normalized = normalizeVaultPath(value);
  if (!normalized.startsWith(".") || normalized.includes("/")) {
    return DEFAULT_VAULT_CONFIG_SYNC_RULES.configDir;
  }

  return normalized;
}

function normalizeVaultPath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
