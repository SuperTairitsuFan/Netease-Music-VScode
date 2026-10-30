import * as esbuild from "esbuild";
import { rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
if (!watch) rmSync("dist", { recursive: true, force: true });

/** @type {esbuild.BuildOptions} */
const host = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
};

/** @type {esbuild.BuildOptions[]} */
const webviews = [
  {
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    sourcemap: true,
    logLevel: "info",
  },
  {
    entryPoints: ["src/webview/sidebar.ts"],
    outfile: "dist/sidebar.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    sourcemap: true,
    logLevel: "info",
  },
  {
    entryPoints: ["src/webview/settings.ts"],
    outfile: "dist/settings.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    sourcemap: true,
    logLevel: "info",
  },
];

if (watch) {
  const contexts = await Promise.all([esbuild.context(host), ...webviews.map((options) => esbuild.context(options))]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("[esbuild] watching src/…");
} else {
  await Promise.all([esbuild.build(host), ...webviews.map((options) => esbuild.build(options))]);
  console.log("[esbuild] build ok");
}
