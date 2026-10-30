#!/usr/bin/env node
/**
 * Builds one platform-specific .vsix.
 *
 *   node scripts/package.mjs linux-x64
 *   node scripts/package.mjs --all
 *
 * Only the matching components/<platform>-<arch>/ directory is copied into the
 * staging tree, so a linux .vsix never carries a Windows executable (and vice
 * versa).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const TARGETS = ["linux-x64", "linux-arm64", "win32-x64"];

function run(command, args, cwd = root) {
  console.log(`[package] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`命令失败：${command} ${args.join(" ")}`);
}

function copy(relative, staging) {
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, path.join(staging, relative), { recursive: true });
}

function packageTarget(target, options) {
  const staging = path.join(root, ".package", target);
  const outDir = path.join(root, "dist-vsix");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const entry of ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "dist", "media"]) {
    copy(entry, staging);
  }
  const componentDir = path.join("components", target);
  if (!fs.existsSync(path.join(root, componentDir))) {
    throw new Error(`缺少 ${componentDir}，先运行 node scripts/build-native.mjs ${target}`);
  }
  copy(componentDir, staging);

  // vsce runs vscode:prepublish inside the staging dir, where the build
  // toolchain is not copied. The bundle is already built at this point.
  const stagedPkgPath = path.join(staging, "package.json");
  const stagedPkg = JSON.parse(fs.readFileSync(stagedPkgPath, "utf8"));
  if (stagedPkg.scripts) delete stagedPkg.scripts["vscode:prepublish"];
  delete stagedPkg.devDependencies;
  fs.writeFileSync(stagedPkgPath, `${JSON.stringify(stagedPkg, null, 2)}\n`);

  // Source maps and staging-only files should not ship.
  fs.writeFileSync(path.join(staging, ".vscodeignore"), ["**/*.map", "**/tsconfig.json", "**/*.ts", ".package/**", ".git/**"].join("\n"));

  const output = path.join(outDir, `${pkg.name}-${pkg.version}-${target}.vsix`);
  fs.rmSync(output, { force: true });
  // Resolve the JS entry instead of the .cmd shim: spawnSync of .cmd is
  // unreliable on Windows when the workspace path contains spaces.
  const vsce = path.join(root, "node_modules", "@vscode", "vsce", "vsce");
  run(
    process.execPath,
    [
      vsce,
      "package",
      "--target",
      target,
      "--out",
      output,
      "--no-dependencies",
      "--allow-missing-repository",
      "--skip-license",
    ],
    staging,
  );
  const size = fs.statSync(output).size;
  console.log(`[package] ${target} -> ${path.relative(root, output)} (${(size / 1024).toFixed(1)} KiB)`);
  if (!options.keepStaging) fs.rmSync(staging, { recursive: true, force: true });
  return output;
}

const args = process.argv.slice(2);
const targets = args.includes("--all") ? TARGETS : args.filter((arg) => !arg.startsWith("-"));
if (!targets.length) {
  console.error(`用法：node scripts/package.mjs <${TARGETS.join("|")}> [--all] [--skip-build] [--keep-staging]`);
  process.exit(1);
}
const options = {
  keepStaging: args.includes("--keep-staging"),
  skipBuild: args.includes("--skip-build"),
};

if (!options.skipBuild) {
  run(process.execPath, [path.join(root, "scripts", "build-native.mjs"), ...targets]);
  if (!fs.existsSync(path.join(root, "dist", "extension.js"))) {
    run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);
  }
}

const built = [];
for (const target of targets) {
  if (!TARGETS.includes(target)) throw new Error(`未知目标：${target}`);
  built.push(packageTarget(target, options));
}
console.log(`[package] 完成：\n${built.map((file) => `  ${path.relative(root, file)}`).join("\n")}`);
