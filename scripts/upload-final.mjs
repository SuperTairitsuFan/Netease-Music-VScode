import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repo = "SuperTairitsuFan/Netease-Music-VScode";
const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

async function request(method, endpoint, body) {
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "dsh-release",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, data: text ? JSON.parse(text) : undefined };
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw last;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "dist-vsix", ".package", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const top = ["README.md", "VERSION_CHANGES.md", "package.json", "package-lock.json", "esbuild.mjs", "tsconfig.json"];
const dirs = ["src", "native/src", "scripts", "test"];
const files = [...top.filter((file) => fs.existsSync(file)), ...dirs.flatMap((dir) => fs.existsSync(dir) ? walk(dir) : [])]
  .filter((file) => !file.includes("upload-github"));

let count = 0;
for (const file of files) {
  const relative = file.split(path.sep).join("/");
  const current = await request("GET", `/contents/${encodeURIComponent(relative)}?ref=main`);
  const content = fs.readFileSync(file).toString("base64");
  const body = {
    message: `release: v1.3.1 (${relative})`,
    content,
    branch: "main",
    ...(current.ok && current.data?.sha ? { sha: current.data.sha } : {}),
  };
  const result = await request("PUT", `/contents/${encodeURIComponent(relative)}`, body);
  if (!result.ok) {
    console.error("FAILED", relative, result.status, JSON.stringify(result.data).slice(0, 500));
    process.exit(1);
  }
  count += 1;
  console.log("uploaded", relative);
}
console.log("done", count);
