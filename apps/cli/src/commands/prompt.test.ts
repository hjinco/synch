import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

import { promptHidden } from "./prompt";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockStdin(): PassThrough {
  const stdin = new PassThrough();
  // Non-TTY input only needs the readable stream API; process.stdin's terminal
  // methods and file descriptor are intentionally absent from this fixture.
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
  return stdin;
}

it.each([
  { input: "first\nsecond\n", expected: "first" },
  { input: "first\r\nsecond\r\n", expected: "first" },
  { input: "without a newline", expected: "without a newline" },
  { input: "\n", expected: "" },
  { input: "", expected: "" },
])("reads one piped line from $input", async ({ input, expected }) => {
  const stdin = mockStdin();

  const answer = promptHidden("Password: ");
  stdin.end(input);

  await expect(answer).resolves.toBe(expected);
});

it("preserves a piped Unicode password when UTF-8 bytes arrive separately", async () => {
  const stdin = mockStdin();

  const answer = promptHidden("Password: ");
  for (const byte of Buffer.from("비밀번호🔐\r\nignored\n", "utf8")) {
    stdin.write(Buffer.from([byte]));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  stdin.end();

  await expect(answer).resolves.toBe("비밀번호🔐");
});

it("propagates piped input errors", async () => {
  const stdin = mockStdin();
  const error = new Error("input failed");

  const answer = promptHidden("Password: ");
  stdin.destroy(error);

  await expect(answer).rejects.toBe(error);
});
