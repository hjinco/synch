import { describe, expect, it } from "vitest";

import {
  createPasswordWrappedRemoteVaultKey,
  unwrapRemoteVaultKeyWithPassword,
} from "./crypto";

describe("vault crypto", () => {
  it("round-trips a password-wrapped vault key", async () => {
    const created = await createPasswordWrappedRemoteVaultKey("correct horse battery staple", {
      kdfOverrides: {
        memoryKiB: 8,
        iterations: 1,
        parallelism: 1,
      },
    });
    const unwrapped = await unwrapRemoteVaultKeyWithPassword(
      "correct horse battery staple",
      created.envelope,
    );

    expect(unwrapped).toEqual(created.remoteVaultKey);
    expect(created.envelope.wrap.algorithm).toBe("aes-256-gcm");
    expect(created.envelope.kdf.name).toBe("argon2id");
  });

  it("rejects the wrong password", async () => {
    const created = await createPasswordWrappedRemoteVaultKey("vault-password", {
      kdfOverrides: {
        memoryKiB: 8,
        iterations: 1,
        parallelism: 1,
      },
    });

    await expect(
      unwrapRemoteVaultKeyWithPassword("wrong-password", created.envelope),
    ).rejects.toThrow();
  });

  it("rejects passwords with leading or trailing spaces", async () => {
    await expect(
      createPasswordWrappedRemoteVaultKey(" correct horse battery staple", {
        kdfOverrides: {
          memoryKiB: 8,
          iterations: 1,
          parallelism: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "outer_spaces" });
  });
});
