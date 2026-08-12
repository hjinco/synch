import { describe, expect, it } from "vitest";

import { validateVaultPassword } from "./password-policy";

describe("vault password policy", () => {
  it("accepts long passphrases", () => {
    expect(validateVaultPassword("correct horse battery staple")).toEqual({ ok: true });
  });

  it("accepts passphrases at the minimum length", () => {
    expect(validateVaultPassword("twelve chars")).toEqual({ ok: true });
  });

  it("rejects short passwords", () => {
    expect(validateVaultPassword("short word")).toEqual({
      ok: false,
      code: "min_length",
      count: 12,
      message: "Password must be at least 12 characters.",
    });
  });

  it("rejects leading and trailing spaces", () => {
    expect(validateVaultPassword(" correct horse battery staple")).toEqual({
      ok: false,
      code: "outer_spaces",
      message: "Password cannot start or end with spaces.",
    });
  });

  it("rejects common weak passwords even when decorated", () => {
    expect(validateVaultPassword("vault-password")).toEqual({
      ok: false,
      code: "too_weak",
      message: "Password is too easy to guess. Use a longer passphrase.",
    });
    expect(validateVaultPassword("obsidian-vault")).toEqual({
      ok: false,
      code: "too_weak",
      message: "Password is too easy to guess. Use a longer passphrase.",
    });
    expect(validateVaultPassword("obsidian-vault-password")).toEqual({
      ok: false,
      code: "too_weak",
      message: "Password is too easy to guess. Use a longer passphrase.",
    });
    expect(validateVaultPassword("password1234567890")).toEqual({
      ok: false,
      code: "too_weak",
      message: "Password is too easy to guess. Use a longer passphrase.",
    });
  });

  it("rejects repeated characters and simple sequences", () => {
    expect(validateVaultPassword("aaaaaaaaaaaa")).toEqual({
      ok: false,
      code: "repeated_character",
      message: "Password cannot be one repeated character.",
    });
    expect(validateVaultPassword("abcdefghijkl")).toEqual({
      ok: false,
      code: "simple_sequence",
      message: "Password cannot be a simple sequence.",
    });
  });
});
