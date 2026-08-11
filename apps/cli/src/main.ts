import { parseArgs } from "node:util";

import { CliAppContext, CliUsageError, describeError } from "./app/context";
import { runLogin } from "./commands/login";
import { runLogout } from "./commands/logout";
import { runStatus } from "./commands/status";
import { runSync } from "./commands/sync";
import { runVaultConnect } from "./commands/vault-connect";
import { runWatch } from "./commands/watch";
import { CLI_VERSION, resolveApiBaseUrl } from "./config";
import { resolveVaultPath } from "./host/paths";

const HELP_TEXT = `synch ${CLI_VERSION} - end-to-end encrypted vault sync

Usage:
  synch login                                 Sign in with a device code
  synch logout                                Sign out and clear stored keys
  synch vault connect --vault-id <id>         Connect a vault directory to a remote vault
  synch sync                                  Synchronize the vault once and exit
  synch watch                                 Keep the vault in sync until interrupted
  synch status                                Show account, vault, and sync state

Options:
  --vault <path>      Vault directory (default: current directory)
  --vault-id <id>     Remote vault ID (for \`vault connect\`)
  --api-url <url>     API server URL (or SYNCH_API_URL)
  -h, --help          Show this help
  -v, --version       Show version
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseCliArgs(argv);

  if (values.version) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  const command = resolveCommand(positionals);
  if (values.help || !command) {
    process.stdout.write(HELP_TEXT);
    return values.help || positionals.length === 0 ? 0 : 2;
  }

  const ctx = new CliAppContext({
    vaultPath: resolveVaultPath(values.vault),
    apiBaseUrl: resolveApiBaseUrl(values["api-url"]),
  });

  try {
    switch (command) {
      case "login":
        return await runLogin(ctx);
      case "logout":
        return await runLogout(ctx);
      case "vault-connect":
        return await runVaultConnect(ctx, values["vault-id"]);
      case "sync":
        return await runSync(ctx);
      case "watch":
        return await runWatch(ctx);
      case "status":
        return await runStatus(ctx);
    }
  } finally {
    await ctx.close();
  }
}

function parseCliArgs(argv: string[]): ReturnType<typeof parseArgs<CliParseArgsConfig>> {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: CLI_OPTIONS,
    });
  } catch (error) {
    // Unknown or malformed flags are usage errors (exit code 2), not crashes.
    throw new CliUsageError(
      `${describeError(error)}\nRun \`synch --help\` for usage.`,
    );
  }
}

const CLI_OPTIONS = {
  vault: { type: "string" },
  "vault-id": { type: "string" },
  "api-url": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

interface CliParseArgsConfig {
  args: string[];
  allowPositionals: true;
  options: typeof CLI_OPTIONS;
}

type CliCommand =
  | "login"
  | "logout"
  | "vault-connect"
  | "sync"
  | "watch"
  | "status";

function resolveCommand(positionals: string[]): CliCommand | null {
  const [first, second] = positionals;
  switch (first) {
    case "login":
    case "logout":
    case "sync":
    case "watch":
    case "status":
      return positionals.length === 1 ? first : null;
    case "vault":
      return second === "connect" && positionals.length === 2
        ? "vault-connect"
        : null;
    default:
      return null;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliUsageError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`error: ${describeError(error)}\n`);
    process.exitCode = 1;
  }
}
