import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAINTAINER_LOGIN = process.env.OBSIDIAN_RELEASE_MAINTAINER ?? "hhhjin";

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: node scripts/prepare-release-notes.mjs <x.y.z>");
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(pluginRoot, "../..");
const sourcePath = path.join(pluginRoot, "release-notes", "next.md");
const releaseDir = path.join(pluginRoot, "dist");
const releaseNotesPath = path.join(releaseDir, "release-notes.md");

const source = await fs.readFile(sourcePath, "utf8");
const repositoryUrl = await getRepositoryUrl(repoRoot);
const blameByLine = await getBlameByLine(repoRoot, sourcePath);
const annotatedSource = await annotateReleaseNoteBullets(source, blameByLine, repositoryUrl);
const body = omitEmptySections(
  annotatedSource.replace(/^# Next Obsidian plugin release\s*/u, "").trim(),
);

if (!/^[-*]\s+\S/m.test(body)) {
  throw new Error(`${sourcePath} must contain at least one release note bullet.`);
}

await fs.mkdir(releaseDir, { recursive: true });
await fs.writeFile(
  releaseNotesPath,
  `# Synch ${version}\n\nReleased ${new Date().toISOString().slice(0, 10)}.\n\n${body}\n`,
);

console.log(releaseNotesPath);

async function annotateReleaseNoteBullets(noteSource, blameByLine, repositoryUrl) {
  const lines = noteSource.split("\n");
  const commitInfoBySha = new Map();
  const annotatedLines = await Promise.all(
    lines.map(async (line, index) => {
      const match = /^(\s*[-*]\s+)(.+?)\s*$/u.exec(line);
      const blame = blameByLine.get(index + 1);

      if (!match || !blame || /\/commit\//u.test(line)) {
        return line;
      }

      let info = commitInfoBySha.get(blame.sha);
      if (info === undefined) {
        info = await resolveCommitInfo(blame.sha);
        commitInfoBySha.set(blame.sha, info);
      }

      const attribution = formatChangesetAttribution({
        sha: blame.sha,
        repositoryUrl,
        githubLogin: info.githubLogin,
        gitAuthor: blame.author,
        pullRequest: info.pullRequest,
      });

      return `${match[1]}${attribution} ${match[2]}`;
    }),
  );

  return annotatedLines.join("\n");
}

function formatChangesetAttribution({
  sha,
  repositoryUrl,
  githubLogin,
  gitAuthor,
  pullRequest,
}) {
  const parts = [];

  if (pullRequest) {
    parts.push(`[#${pullRequest.number}](${pullRequest.url})`);
  }

  parts.push(`[\`${sha.slice(0, 7)}\`](${repositoryUrl}/commit/${sha})`);

  const maintainer = MAINTAINER_LOGIN.toLowerCase();
  const isMaintainer =
    githubLogin?.toLowerCase() === maintainer || gitAuthor?.toLowerCase() === maintainer;
  if (!isMaintainer) {
    if (githubLogin) {
      parts.push(`Thanks [@${githubLogin}](https://github.com/${githubLogin})!`);
    } else if (gitAuthor) {
      parts.push(`Thanks ${gitAuthor}!`);
    }
  }

  return `${parts.join(" ")} -`;
}

function omitEmptySections(markdown) {
  return markdown
    .split(/^(?=## )/mu)
    .filter((section) => {
      if (!section.startsWith("## ")) {
        return section.trim().length > 0;
      }

      return /^[-*]\s+\S/mu.test(section.replace(/^## .+\n*/u, ""));
    })
    .join("")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

async function getBlameByLine(repoRoot, sourcePath) {
  // Release-note bullets are attributed to the commit that last changed their line.
  // This matches the current convention of adding the user-facing note with the feature commit.
  const relativePath = path.relative(repoRoot, sourcePath);
  const { stdout } = await execFileAsync("git", ["blame", "--line-porcelain", "--", relativePath], {
    cwd: repoRoot,
  });
  const blameByLine = new Map();
  let current = null;

  for (const line of stdout.split("\n")) {
    const header = /^(\w{40})\s+\d+\s+(\d+)(?:\s+\d+)?$/u.exec(line);
    if (header) {
      current = { sha: header[1], lineNumber: Number(header[2]) };
      continue;
    }

    if (current && line.startsWith("author ")) {
      current.author = line.slice("author ".length);
      continue;
    }

    if (current && line.startsWith("\t")) {
      blameByLine.set(current.lineNumber, current);
      current = null;
    }
  }

  return blameByLine;
}

async function resolveCommitInfo(sha) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const apiUrl = process.env.GITHUB_API_URL;

  if (!token || !repository || !apiUrl) {
    return { githubLogin: null, pullRequest: null };
  }

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  try {
    const [commitResponse, pullsResponse] = await Promise.all([
      fetch(`${apiUrl}/repos/${repository}/commits/${sha}`, { headers }),
      fetch(`${apiUrl}/repos/${repository}/commits/${sha}/pulls`, { headers }),
    ]);

    const githubLogin = commitResponse.ok
      ? ((await commitResponse.json()).author?.login ?? null)
      : null;

    let pullRequest = null;
    if (pullsResponse.ok) {
      const pulls = await pullsResponse.json();
      if (Array.isArray(pulls) && pulls.length > 0) {
        const preferred = pulls.find((pull) => pull.merged_at) ?? pulls[0];
        pullRequest = {
          number: preferred.number,
          url: preferred.html_url,
        };
      }
    }

    return { githubLogin, pullRequest };
  } catch {
    return { githubLogin: null, pullRequest: null };
  }
}

async function getRepositoryUrl(repoRoot) {
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_SERVER_URL) {
    return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`;
  }

  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
    });
    return normalizeRemoteUrl(stdout.trim());
  } catch {
    return "https://github.com/unknown/unknown";
  }
}

function normalizeRemoteUrl(remoteUrl) {
  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/u.exec(remoteUrl);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  return remoteUrl.replace(/\.git$/u, "");
}
