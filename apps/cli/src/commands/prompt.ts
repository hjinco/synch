export async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  const stderr = process.stderr;

  if (!stdin.isTTY) {
    return await readStdinLine();
  }

  stderr.write(question);
  return await new Promise<string>((resolve, reject) => {
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };

    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Canceled."));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdin.on("data", onData);
  });
}

async function readStdinLine(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk.toString("utf8");
    const newlineIndex = data.indexOf("\n");
    if (newlineIndex >= 0) {
      return data.slice(0, newlineIndex).replace(/\r$/, "");
    }
  }

  return data.replace(/\r$/, "");
}
