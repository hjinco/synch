import { getLanguage } from "obsidian";
import type { VaultPasswordValidation } from "@synch/vault-crypto";

import { messages } from "./messages";
import type { SynchErrorContextKey, SynchLocale, SynchMessageKey } from "./types";

export type { SynchErrorContextKey, SynchLocale, SynchMessageKey } from "./types";

export function getSynchLocale(): SynchLocale {
  const language = getLanguage().toLowerCase();
  if (language === "ko" || language.startsWith("ko-")) return "ko";
  if (language === "ja" || language.startsWith("ja-")) return "ja";
  if (language === "zh-tw" || language === "zh-hk" || language === "zh-hant" || language.startsWith("zh-hant-")) return "zh-tw";
  if (language === "zh" || language === "zh-cn" || language === "zh-sg" || language === "zh-hans" || language.startsWith("zh-hans-")) return "zh-cn";
  return "en";
}

export function t<K extends SynchMessageKey>(
  key: K,
  params?: Parameters<Extract<(typeof messages.en)[K], (...args: never[]) => unknown>>[0],
): string {
  const localeMessages = messages[getSynchLocale()] as Partial<
    Record<SynchMessageKey, (typeof messages.en)[SynchMessageKey]>
  >;
  const value = localeMessages[key] ?? messages.en[key];
  if (typeof value === "function") {
    return value(params as never);
  }
  return value;
}

export function formatErrorNotice(
  error: unknown,
  contextKey: SynchErrorContextKey,
): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "cursor_ahead_of_server"
  ) {
    return t("sync.cursorMismatch");
  }

  const message = error instanceof Error ? error.message : String(error);
  return t("error.detail", { context: t(contextKey), message });
}

export function formatVaultPasswordValidationError(
  validation: Extract<VaultPasswordValidation, { ok: false }>,
): string {
  switch (validation.code) {
    case "required":
      return t("vault.passwordRequired");
    case "outer_spaces":
      return t("vault.passwordNoOuterSpaces");
    case "min_length":
      return t("vault.passwordMinLength", { count: validation.count ?? 0 });
    case "max_length":
      return t("vault.passwordMaxLength", { count: validation.count ?? 0 });
    case "too_weak":
      return t("vault.passwordTooWeak");
    case "repeated_character":
      return t("vault.passwordRepeated");
    case "simple_sequence":
      return t("vault.passwordSequence");
  }
}
