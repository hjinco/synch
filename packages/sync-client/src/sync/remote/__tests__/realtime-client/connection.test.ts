import { describe, expect, it, vi } from "vitest";

import { SyncRealtimeError } from "../../realtime-client";
import {
  createMutation,
  openRealtimeSession,
  waitForSentMessage,
} from "./helpers";

describe("SyncRealtimeClient connection health", () => {
  it("exposes the server storage and file size policy from hello acknowledgement", async () => {
    const { session } = await openRealtimeSession();

    expect(session.maxFileSizeBytes).toBe(3_000_000);
    expect(session.storageUsedBytes).toBe(24_300_000);
    expect(session.storageLimitBytes).toBe(100_000_000);
    session.close();
  });

  it("uses the fresh policy storage limit when the stored status is stale", async () => {
    const { session } = await openRealtimeSession({
      helloPolicy: {
        storageLimitBytes: 1_000_000_000,
        maxFileSizeBytes: 3_000_000,
      },
      helloStorageStatus: {
        storageUsedBytes: 24_300_000,
        storageLimitBytes: 50_000_000,
      },
    });

    expect(session.storageUsedBytes).toBe(24_300_000);
    expect(session.storageLimitBytes).toBe(1_000_000_000);
    session.close();
  });

  it("updates the active session policy from realtime policy updates", async () => {
    const policies: unknown[] = [];
    const storageStatuses: unknown[] = [];
    const { socket, session } = await openRealtimeSession({
      callbacks: {
        onPolicyUpdated(policy, storageStatus) {
          policies.push(policy);
          storageStatuses.push(storageStatus);
        },
      },
    });

    socket.emitMessage({
      type: "policy_updated",
      policy: {
        storageLimitBytes: 1_000_000_000,
        maxFileSizeBytes: 5_000_000,
      },
      storageStatus: {
        storageUsedBytes: 25_000_000,
        storageLimitBytes: 50_000_000,
      },
    });

    expect(session.maxFileSizeBytes).toBe(5_000_000);
    expect(session.storageUsedBytes).toBe(25_000_000);
    expect(session.storageLimitBytes).toBe(1_000_000_000);
    expect(policies).toEqual([
      {
        storageLimitBytes: 1_000_000_000,
        maxFileSizeBytes: 5_000_000,
      },
    ]);
    expect(storageStatuses).toEqual([
      {
        storageUsedBytes: 25_000_000,
        storageLimitBytes: 1_000_000_000,
      },
    ]);
    session.close();
  });

  it("rejects pending requests and closes the session when a request times out", async () => {
    vi.useFakeTimers();

    const errors: Error[] = [];
    const onClose = vi.fn();
    const { session } = await openRealtimeSession({
      clientOptions: {
        requestTimeoutMs: 100,
      },
      callbacks: {
        onClose,
        onError(error) {
          errors.push(error);
        },
      },
    });

    const commitPromise = session.commitMutation(createMutation());
    const commitExpectation = expect(commitPromise).rejects.toThrow(
      "sync websocket request timed out",
    );
    await vi.advanceTimersByTimeAsync(100);

    await commitExpectation;
    expect(errors).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the session when a websocket send fails", async () => {
    const errors: Error[] = [];
    const onClose = vi.fn();
    const { socket, session } = await openRealtimeSession({
      callbacks: {
        onClose,
        onError(error) {
          errors.push(error);
        },
      },
    });

    socket.failNextSend = true;
    const commitPromise = session.commitMutation(createMutation());

    await expect(commitPromise).rejects.toThrow("send failed");
    expect(errors).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports local vault replacement from the websocket close code", async () => {
    const errors: Error[] = [];
    const onClose = vi.fn();
    const { socket, session } = await openRealtimeSession({
      callbacks: {
        onClose,
        onError(error) {
          errors.push(error);
        },
      },
    });

    const commitPromise = session.commitMutation(createMutation());
    socket.emit("close", {
      code: 4409,
      reason: "superseded by newer connection",
    });

    await expect(commitPromise).rejects.toMatchObject({
      code: "local_vault_replaced",
      message: "superseded by newer connection",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SyncRealtimeError);
    expect(errors[0]).toMatchObject({
      code: "local_vault_replaced",
      message: "superseded by newer connection",
    });
    expect(onClose).toHaveBeenCalledWith({
      code: 4409,
      reason: "superseded by newer connection",
    });
  });

  it("uses heartbeat messages to detect a stale websocket", async () => {
    vi.useFakeTimers();

    const errors: Error[] = [];
    const onClose = vi.fn();
    const { socket } = await openRealtimeSession({
      clientOptions: {
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 250,
      },
      callbacks: {
        onClose,
        onError(error) {
          errors.push(error);
        },
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForSentMessage(socket, 1);
    expect(socket.sentMessageAt(1)).toMatchObject({
      type: "heartbeat",
    });

    await vi.advanceTimersByTimeAsync(250);

    expect(errors.map((error) => error.message)).toEqual([
      "sync websocket request timed out",
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the session open when heartbeat acknowledgements arrive", async () => {
    vi.useFakeTimers();

    const onClose = vi.fn();
    const errors: Error[] = [];
    const { socket, session } = await openRealtimeSession({
      clientOptions: {
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 250,
      },
      callbacks: {
        onClose,
        onError(error) {
          errors.push(error);
        },
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForSentMessage(socket, 1);
    const heartbeat = socket.sentMessageAt(1);
    socket.emitMessage({
      type: "heartbeat_ack",
      requestId: heartbeat.requestId,
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(errors).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    session.close();
  });

  it("detaches the local vault over the realtime control channel", async () => {
    const { socket, session } = await openRealtimeSession();

    const detachPromise = session.detachLocalVault();
    await waitForSentMessage(socket, 1);
    const detach = socket.sentMessageAt(1);
    expect(detach).toMatchObject({
      type: "detach_local_vault",
    });

    socket.emitMessage({
      type: "local_vault_detached",
      requestId: detach.requestId,
    });

    await expect(detachPromise).resolves.toBeUndefined();
    session.close();
  });
});
