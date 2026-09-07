import { describe, expect, it } from "vitest";
import { createTestContentRuntime } from "../../../test-support/content-runtime";
import { BytesInFlightBudget } from "../../core/bytes-in-flight";
import type { PendingMutationRow } from "../../store/store";
import { PushBlobRetryCache } from "../push-blob-retry-cache";

const mutation: PendingMutationRow = {
  mutationId: "mutation", entryId: "entry", op: "upsert", baseRevision: 0,
  blobId: "blob", hash: "hash", encryptedMetadata: "authenticated metadata", createdAt: 1,
};

function fixture() {
  const budget = new BytesInFlightBudget(100);
  const runtime = createTestContentRuntime({ byteBudget: budget });
  const cache = new PushBlobRetryCache(runtime);
  return { budget, runtime, cache };
}

describe("push retry cache memory ownership", () => {
  it("charges retained ciphertext to the shared budget and reclaims it for active work", async () => {
    const { budget, runtime, cache } = fixture();
    const bytes = new Uint8Array(60);
    cache.put(mutation, "vault", bytes);
    expect(cache.get(mutation, "vault")).toBe(bytes);
    expect(budget.bytesInFlight).toBe(60);

    const active = await runtime.reserve(100);
    expect(cache.get(mutation, "vault")).toBeNull();
    expect(budget.bytesInFlight).toBe(100);
    active.release();
    expect(budget.bytesInFlight).toBe(0);
  });

  it("skips optional caching when the caller holds the available memory", async () => {
    const { budget, runtime, cache } = fixture();
    const active = await runtime.reserve(100);
    cache.put(mutation, "vault", new Uint8Array(60));
    expect(cache.get(mutation, "vault")).toBeNull();
    expect(budget.bytesInFlight).toBe(100);
    expect(budget.pendingReservations).toBe(0);
    active.release();
  });

  it("drops cached bytes to allow an oversized file to run alone", async () => {
    const { budget, runtime, cache } = fixture();
    cache.put(mutation, "vault", new Uint8Array(60));
    const active = await runtime.reserve(200);
    expect(cache.get(mutation, "vault")).toBeNull();
    expect(budget.bytesInFlight).toBe(200);
    active.release();
    expect(budget.bytesInFlight).toBe(0);
  });

  it("releases retained ciphertext when the runtime is disposed", async () => {
    const { budget, runtime, cache } = fixture();
    cache.put(mutation, "vault", new Uint8Array(60));
    await runtime.dispose();
    expect(cache.get(mutation, "vault")).toBeNull();
    expect(budget.bytesInFlight).toBe(0);
    cache.delete(mutation.blobId!);
    expect(budget.bytesInFlight).toBe(0);
  });
});
