import { attachVault } from "@synch/sync-testkit/account";
import { applyChanges, verifyFiles, type Fixture } from "./fixtures";
import { Device } from "./device";
import type { Scenario } from "./profiles";

export type Command =
  | { type: "init"; directory: string; baseUrl: string; cookie: string; vaultId: string; key: number[] }
  | { type: "queue"; paths: string[] }
  | { type: "sync" }
  | { type: "change"; fixture: Fixture }
  | { type: "measure"; scenario: Scenario }
  | { type: "verify"; fixture: Fixture; incremental: boolean; targetCursor: number }
  | { type: "close" };
let device: Device | undefined;
async function handle(command: Command) {
  if (command.type === "init") {
    const remote = attachVault(command.baseUrl, command.cookie, command.vaultId, new Uint8Array(command.key));
    // Every receiver independently fetches and unwraps the real server envelope.
    device = new Device(command.directory, command.baseUrl, remote, await remote.unlock());
    await device.initialize(remote);
    await device.connect();
    return { cursor: device.cursor, policy: device.policy };
  }
  if (!device) throw new Error("Worker is not initialized");
  switch (command.type) {
    case "queue": await device.queue(command.paths); break;
    case "sync": await device.sync(); return device.cursor;
    case "change":
      await applyChanges(command.fixture, device.vault.directory);
      await device.queue(command.fixture.entries.filter(e => e.changed).map(e => e.path));
      await device.sync();
      return device.cursor;
    case "measure":
      try { return { metrics: await device.measure(command.scenario), cursor: device.cursor }; }
      catch (error) { return { metrics: { ...device.metrics.snapshot(), pageRequests: device.pageRequests, downloadRequests: device.downloadRequests, downloadedBytes: device.downloadedBytes }, cursor: device.cursor, error: String(error) }; }
    case "verify": {
      await verifyFiles(command.fixture, device.vault.directory, command.incremental);
      const paths = (await device.vault.listFiles()).map(f => f.path).sort();
      const expected = command.fixture.entries.map(e => e.path).sort();
      if (JSON.stringify(paths) !== JSON.stringify(expected)) throw new Error("Vault path/count mismatch");
      if (await device.store.getCursor() !== command.targetCursor || await device.engine.hasPendingMutations()) throw new Error("Final state mismatch");
      break;
    }
    case "close": await device.close(); device = undefined; break;
  }
}
let pending = Promise.resolve();
process.on("message", (message: { id: number; command: Command }) => {
  pending = pending.then(async () => {
    try {
      const value = await handle(message.command);
      process.send?.({ id: message.id, value });
    } catch (error) {
      process.send?.({ id: message.id, error: String(error) });
    }
  });
});
process.on("disconnect", () => { void device?.close().finally(() => process.exit()); });
