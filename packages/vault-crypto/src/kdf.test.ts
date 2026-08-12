import { describe, expect, it } from "vitest";

import { createArgon2idMetadata } from "./kdf";

describe("vault KDF metadata", () => {
  it("uses one Argon2id strength policy for new password wrappers", () => {
    const metadata = createArgon2idMetadata();

    expect(metadata).toMatchObject({
      name: "argon2id",
      memoryKiB: 65_536,
      iterations: 3,
      parallelism: 1,
    });
  });

  it("keeps explicit test overrides available", () => {
    const metadata = createArgon2idMetadata({
      memoryKiB: 8,
      iterations: 1,
      parallelism: 1,
    });

    expect(metadata).toMatchObject({
      memoryKiB: 8,
      iterations: 1,
      parallelism: 1,
    });
  });
});
