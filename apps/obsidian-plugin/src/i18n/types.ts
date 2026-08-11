import type { messages } from "./messages";

export type SynchLocale = keyof typeof messages;
export type SynchMessageKey = keyof typeof messages.en;
export type SynchErrorContextKey =
  | "error.autoSync"
  | "error.autoSyncInitialization"
  | "error.autoSyncResume"
  | "error.hiddenFolderScan"
  | "error.localSyncStateReset"
  | "error.localSyncStoreInitialization"
  | "error.pluginSettingsInitialization"
  | "error.syncEventHandling"
  | "error.syncFileRuleUpdate"
  | "error.vaultConnection"
  | "error.vaultCreation"
  | "error.vaultDisconnect"
  | "error.vaultRestore";
