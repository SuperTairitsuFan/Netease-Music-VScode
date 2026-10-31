#!/usr/bin/env node
/**
 * Publish this project to GitHub without requiring git or gh.
 *
 * Required:
 *   GITHUB_TOKEN   classic token with `repo`, or fine-grained token with
 *                  Contents (read/write) + Administration (read/write) if it
 *                  must create the repository.
 * Optional:
 *   GITHUB_OWNER   user/org; defaults to the token's authenticated user
 *   GITHUB_REPO    repository name; default netease-music-vscode
 *   GITHUB_VISIBILITY  public|private; default public
 *   GITHUB_DESCRIPTION
 *
 * Usage:
 *   node scripts/publish-github.mjs --dry-run
 *   $env:GITHUB_TOKEN="github_pat_..." ; node scripts/publish-github.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dryRun = process.argv.includes("--dry-run");
function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const tokenFile = process.env.GITHUB_TOKEN_FILE ?? path.join(os.homedir(), ".github-token");
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}
const token = readToken();
const repoName = process.env.GITHUB_REPO ?? "netease-music-vscode";
const visibility = process.env.GITHUB_VISIBILITY === "private" ? "private" : "public";
const description =
  process.env.GITHUB_DESCRIPTION ??
  "A desktop-like NetEase Cloud Music client for VS Code, built with EAPI and optional native audio output.";

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-vsix",
  ".package",
  ".smoke-storage",
  "tmp",
  "components",
  "components-zip",
  ".git",
  "tools",
]);
const IGNORED_FILES = new Set(["package-lock.json.bak"]);
const IGNORED_EXT = new Set([".vsix", ".map", ".tsbuildinfo"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (IGNORED_FILES.has(entry.name)) continue;
      if (IGNORED_EXT.has(path.extname(entry.name))) continue;
      out.push({ full, rel });
    }
  }
  return out;
}

const files = walk(root).sort((a, b) => a.rel.localeCompare(b.rel));

function gitBlobSha(content) {
  return crypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}
const vsix = path.join(root, "dist-vsix", `netease-music-${pkg.version}-win32-x64.vsix`);

if (dryRun) {
  console.log(`Repository: ${repoName} (${visibility})`);
  console.log(`Files: ${files.length}`);
  for (const file of files) console.log(`  ${file.rel} (${(fs.statSync(file.full).size / 1024).toFixed(1)} KiB)`);
  console.log(`Release asset: ${fs.existsSync(vsix) ? path.relative(root, vsix) : "missing"}`);
  process.exit(0);
}

if (!token) {
  console.error("缺少 GITHUB_TOKEN。请先设置一个有 repo/Contents 权限的 GitHub Token。");
  console.error('PowerShell: $env:GITHUB_TOKEN="github_pat_..." ; node scripts/publish-github.mjs');
  process.exit(1);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.stringify(JSON.parse(text));
    } catch {
      /* keep text */
    }
    throw new Error(`GitHub API ${response.status} ${url}\n${detail.slice(0, 1200)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function uploadAsset(uploadUrl, file, name) {
  const response = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: fs.readFileSync(file),
  });
  if (!response.ok) throw new Error(`release asset upload failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function main() {
  const user = await api("https://api.github.com/user");
  const owner = process.env.GITHUB_OWNER ?? user.login;
  console.log(`[github] authenticated as ${user.login}; repository ${owner}/${repoName}`);

  let repo;
  try {
    repo = await api(`https://api.github.com/repos/${owner}/${repoName}`);
    console.log(`[github] using existing repository ${repo.html_url}`);
  } catch (error) {
    if (!String(error).includes("404")) throw error;
    repo = await api("https://api.github.com/user/repos", {
      method: "POST",
      body: JSON.stringify({
        name: repoName,
        description,
        private: visibility === "private",
        has_issues: true,
        has_wiki: false,
        has_projects: false,
        auto_init: false,
      }),
    });
    console.log(`[github] created ${repo.html_url}`);
  }

  let parent;
  try {
    const ref = await api(`https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/main`);
    parent = ref.object.sha;
  } catch (error) {
    if (!String(error).includes("404")) throw error;
  }

  // Reuse blobs that already exist in the parent tree so only changed files are uploaded.
  const existing = new Map();
  if (parent) {
    const commit = await api(`https://api.github.com/repos/${owner}/${repoName}/git/commits/${parent}`);
    const base = await api(`https://api.github.com/repos/${owner}/${repoName}/git/trees/${commit.tree.sha}?recursive=1`);
    for (const entry of base.tree ?? []) if (entry.type === "blob") existing.set(entry.path, entry.sha);
  }

  console.log(`[github] uploading ${files.length} files...`);
  const blobs = [];
  let uploaded = 0;
  for (const file of files) {
    const content = fs.readFileSync(file.full);
    const sha = gitBlobSha(content);
    if (existing.get(file.rel) === sha) {
      blobs.push({ path: file.rel, mode: "100644", type: "blob", sha });
    } else {
      const blob = await api(`https://api.github.com/repos/${owner}/${repoName}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: content.toString("base64"), encoding: "base64" }),
      });
      blobs.push({ path: file.rel, mode: "100644", type: "blob", sha: blob.sha });
      uploaded += 1;
    }
    process.stdout.write(`\r  ${blobs.length}/${files.length} (uploaded ${uploaded})`);
  }
  process.stdout.write("\n");

  const tree = await api(`https://api.github.com/repos/${owner}/${repoName}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ tree: blobs }),
  });

  const commit = await api(`https://api.github.com/repos/${owner}/${repoName}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `Release v${pkg.version}`,
      tree: tree.sha,
      parents: parent ? [parent] : [],
    }),
  });

  if (parent) {
    await api(`https://api.github.com/repos/${owner}/${repoName}/git/refs/heads/main`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: true }),
    });
  } else {
    await api(`https://api.github.com/repos/${owner}/${repoName}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: "refs/heads/main", sha: commit.sha }),
    });
  }
  await api(`https://api.github.com/repos/${owner}/${repoName}`, {
    method: "PATCH",
    body: JSON.stringify({ default_branch: "main" }),
  });
  console.log(`[github] pushed commit ${commit.sha.slice(0, 8)} to ${repo.html_url}`);

  if (fs.existsSync(vsix)) {
    const tag = `v${pkg.version}`;
    let release;
    try {
      release = await api(`https://api.github.com/repos/${owner}/${repoName}/releases/tags/${tag}`);
    } catch (error) {
      if (!String(error).includes("404")) throw error;
      release = await api(`https://api.github.com/repos/${owner}/${repoName}/releases`, {
        method: "POST",
        body: JSON.stringify({
          tag_name: tag,
          name: `v${pkg.version}`,
          body: `NetEase Cloud Music for VS Code v${pkg.version}\n\nWindows x64 VSIX.`,
          draft: false,
          prerelease: false,
        }),
      });
    }
    const assetNames = fs
      .readdirSync(path.join(root, "dist-vsix"))
      .filter((name) => name.startsWith(`netease-music-${pkg.version}-`) && name.endsWith(".vsix"))
      .sort();
    for (const assetName of assetNames) {
      const assetPath = path.join(root, "dist-vsix", assetName);
      const existing = (release.assets ?? []).find((asset) => asset.name === assetName);
      if (existing) {
        console.log(`[github] release asset already exists: ${existing.browser_download_url}`);
        continue;
      }
      const uploaded = await uploadAsset(release.upload_url.replace(/\{.*$/, ""), assetPath, assetName);
      console.log(`[github] release asset: ${uploaded.browser_download_url}`);
    }
  } else {
    console.warn(`[github] no VSIX at ${vsix}; skipped release asset`);
  }
  console.log(`[github] done: ${repo.html_url}`);
}

main().catch((error) => {
  console.error(`[github] failed: ${error.message}`);
  process.exit(1);
});
