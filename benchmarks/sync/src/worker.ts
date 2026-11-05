import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { Command } from "./sample-worker";

export class Worker {
  private readonly child = fork(fileURLToPath(new URL("sample-worker.ts", import.meta.url)), [], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  get processId() { return this.child.pid!; }
  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor() {
    // Drain without retaining bodies, paths, or credentials from runtime logs.
    this.child.stdout?.resume(); this.child.stderr?.resume();
    this.child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("id" in message) || typeof message.id !== "number") return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if ("error" in message && typeof message.error === "string") waiter.reject(new Error(message.error));
      else waiter.resolve("value" in message ? message.value : undefined);
    });
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", (code, signal) => this.fail(new Error(`Client worker exited: ${signal ?? code}`)));
  }
  private fail(error: Error) { for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear(); }
  async call<T = void>(command: Command, timeoutMs = 300_000): Promise<T> {
    if (!this.child.connected) throw new Error("Client worker disconnected");
    const id = ++this.nextId;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await new Promise<T>((resolve, reject) => {
        // The command and reply are paired by the parent-owned request id.
        this.pending.set(id, { resolve: value => resolve(value as T), reject });
        timer = setTimeout(() => {
          this.pending.delete(id);
          this.child.kill("SIGKILL");
          reject(new Error(`Client ${command.type} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        this.child.send({ id, command }, error => { if (error) this.fail(error); });
      });
    } finally { clearTimeout(timer!); }
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { if (this.child.connected) await this.call({ type: "close" }, 5_000); }
    catch { /* Always reap even if client disposal failed. */ }
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
}
