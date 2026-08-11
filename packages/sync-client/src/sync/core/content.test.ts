import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "./content";

describe("hashBytes", () => {
  it("returns SHA-256 hex digests", async () => {
    await expect(hashBytes(encodeUtf8("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
