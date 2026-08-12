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
    expect(validateVaultPassword("short word")).toMatchObject({
      ok: false,
      code: "min_length",
      count: 12,
    });
  });

  it("rejects leading and trailing spaces", () => {
    expect(validateVaultPassword(" correct horse battery staple")).toMatchObject({
      ok: false,
      code: "outer_spaces",
    });
  });

  it("rejects common weak passwords even when decorated", () => {
    for (const password of [
      "vault-password",
      "obsidian-vault",
      "obsidian-vault-password",
      "password1234567890",
    ]) {
      expect(validateVaultPassword(password)).toMatchObject({
        ok: false,
        code: "too_weak",
      });
    }
  });

  it("rejects repeated characters and simple sequences", () => {
    expect(validateVaultPassword("aaaaaaaaaaaa")).toMatchObject({
      ok: false,
      code: "repeated_character",
    });
    expect(validateVaultPassword("abcdefghijkl")).toMatchObject({
      ok: false,
      code: "simple_sequence",
    });
  });
});
