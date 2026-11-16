#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const scratch = await mkdtemp(join(root, "apps/desktop/.catspub-e2e-"));
const artifacts = join(root, "artifacts/catspub");
await mkdir(artifacts, { recursive: true });
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/catspub-main.ts")], outfile: join(scratch, "main.mjs"),
    bundle: true, platform: "node", format: "esm", packages: "external", nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await build({
    entryPoints: [join(root, "scripts/e2e/catspub-renderer.tsx")], outfile: join(scratch, "renderer.js"),
    bundle: true, platform: "browser", format: "iife", jsx: "automatic", loader: { ".png": "file" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    plugins: [{ name: "vite-url-assets", setup(bundler) {
      bundler.onResolve({ filter: /\?url$/ }, (args) => ({ path: join(args.resolveDir, args.path.slice(0, -4)), namespace: "url-asset" }));
      bundler.onLoad({ filter: /.*/, namespace: "url-asset" }, async (args) => ({ contents: await readFile(args.path), loader: "file" }));
    } }],
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build the Desktop renderer before running Catspub E2E");
  await cp(join(renderer, "assets"), join(scratch, "assets"), { recursive: true });
  await writeFile(join(scratch, "index.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Catspub E2E</title>${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<link rel="stylesheet" href="renderer.css"><body><div id="root"></div><script src="renderer.js"></script></body></html>`);
  const env = { ...process.env, CATSPUB_TEST_DIR: scratch, CATSPUB_TEST_ROOT: root, CATSPUB_TEST_ARTIFACTS: artifacts };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(scratch, "main.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => {
    output += data;
    if (process.env.CATSPUB_E2E_VERBOSE === "1") process.stdout.write(data);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timer); }
  assert.equal(code, 0, output.slice(-10000));
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("CATSPUB_E2E "));
  assert(line, output.slice(-10000));
  console.log(line);
  console.log(`Screenshots: ${artifacts}`);
} finally { await rm(scratch, { recursive: true, force: true }); }
