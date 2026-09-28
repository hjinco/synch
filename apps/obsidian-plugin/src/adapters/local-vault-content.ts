import type { App } from "obsidian";

/** Configuration created by Obsidian itself does not make a fresh vault nonempty. */
export async function hasExistingVaultFiles(app: App): Promise<boolean> {
  const vault = app.vault;
  if (vault.getFiles().length > 0) return true;
  const folders = [""];
  while (folders.length > 0) {
    const folder = folders.pop()!;
    const entries = await vault.adapter.list(folder);
    if (entries.files.length > 0) return true;
    folders.push(...entries.folders.filter((path) => path !== vault.configDir && path !== ".trash"));
  }
  return false;
}
