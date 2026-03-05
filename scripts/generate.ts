#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CACHE_DIR = join(ROOT, ".cache");
const REPO_DIR = join(CACHE_DIR, "lobe-chat");
const MODEL_BANK_SRC = join(REPO_DIR, "packages/model-bank/src");

// ---------------------------------------------------------------------------
// 1. Clone or update lobehub/lobe-chat (sparse checkout, model-bank only)
// ---------------------------------------------------------------------------

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

function run(cmd: string[], opts?: { cwd?: string }) {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts?.cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    console.error(`Command failed: ${cmd.join(" ")}`);
    process.exit(1);
  }
}

if (!existsSync(join(REPO_DIR, ".git"))) {
  console.log("Cloning lobehub/lobe-chat (sparse, model-bank only)...");
  mkdirSync(REPO_DIR, { recursive: true });
  run(["git", "init"], { cwd: REPO_DIR });
  run(["git", "remote", "add", "origin", "https://github.com/lobehub/lobe-chat.git"], {
    cwd: REPO_DIR,
  });
  run(["git", "config", "core.sparseCheckout", "true"], { cwd: REPO_DIR });
  await Bun.write(join(REPO_DIR, ".git/info/sparse-checkout"), "packages/model-bank/\n");
  run(["git", "pull", "--depth", "1", "origin", "main"], { cwd: REPO_DIR });
} else {
  console.log("Updating .cache/lobe-chat...");
  run(["git", "pull", "--depth", "1", "origin", "main"], { cwd: REPO_DIR });
}

// ---------------------------------------------------------------------------
// 2. Stub external deps so bun can resolve imports in model-bank source files
//    No real install needed -- model files only use type imports from these.
// ---------------------------------------------------------------------------

const nmDir = join(REPO_DIR, "packages/model-bank/node_modules");

function stubPackage(name: string, code: string) {
  const dir = join(nmDir, ...name.split("/"));
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  Bun.write(join(dir, "index.ts"), code);
  Bun.write(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "0.0.0", main: "index.ts" }),
  );
}

// zod: used in types/aiModel.ts for schema definitions (enum, object, etc.)
stubPackage("zod", `
const handler = { get: (_: any, prop: string) => (...args: any[]) => new Proxy({}, handler) };
export const z = new Proxy({}, handler);
`);

// type-fest: used in some type files
stubPackage("type-fest", "export {};");

// @lobechat/business-const: workspace dep used in aiModels/index.ts
stubPackage("@lobechat/business-const", "export const ENABLE_BUSINESS_FEATURES = false;");

// Stub @/types/llm for modelProviders (import type only, just needs to resolve)
const stubTypesDir = join(MODEL_BANK_SRC, "types");
if (!existsSync(join(stubTypesDir, "llm.ts"))) {
  await Bun.write(join(stubTypesDir, "llm.ts"), "export type ModelProviderCard = Record<string, any>;\n");
}

// tsconfig paths: map @/ -> src/ so modelProviders can resolve @/types/llm
const tsconfigPath = join(REPO_DIR, "packages/model-bank/tsconfig.json");
if (!existsSync(tsconfigPath)) {
  await Bun.write(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// 3. Import each provider's model file
// ---------------------------------------------------------------------------

console.log("\nExtracting models...");
const aiModelsDir = join(MODEL_BANK_SRC, "aiModels");
const entries = readdirSync(aiModelsDir);

const models: Record<string, unknown[]> = {};
let totalModels = 0;

for (const entry of entries) {
  if (entry === "index.ts") continue;

  const fullPath = join(aiModelsDir, entry);
  const stat = statSync(fullPath);

  let importPath: string;
  let providerId: string;

  if (stat.isDirectory()) {
    importPath = join(fullPath, "index.ts");
    providerId = entry;
    if (!existsSync(importPath)) continue;
  } else if (entry.endsWith(".ts")) {
    importPath = fullPath;
    providerId = basename(entry, ".ts");
  } else {
    continue;
  }

  try {
    const mod = await import(importPath);
    const modelList: unknown[] = mod.default ?? mod.allModels ?? [];

    if (Array.isArray(modelList) && modelList.length > 0) {
      models[providerId] = modelList;
      totalModels += modelList.length;
      console.log(`  ${providerId}: ${modelList.length} models`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    console.warn(`  [skip] ${providerId}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Import each provider's card
// ---------------------------------------------------------------------------

console.log("\nExtracting providers...");
const providersDir = join(MODEL_BANK_SRC, "modelProviders");
const providerEntries = readdirSync(providersDir);

const providers: Record<string, unknown> = {};

for (const entry of providerEntries) {
  if (entry === "index.ts") continue;

  const fullPath = join(providersDir, entry);
  const stat = statSync(fullPath);

  let importPath: string;
  let providerId: string;

  if (stat.isDirectory()) {
    importPath = join(fullPath, "index.ts");
    providerId = entry;
    if (!existsSync(importPath)) continue;
  } else if (entry.endsWith(".ts")) {
    importPath = fullPath;
    providerId = basename(entry, ".ts");
  } else {
    continue;
  }

  try {
    const mod = await import(importPath);
    const card = mod.default;
    if (card && typeof card === "object") {
      providers[providerId] = card;
      console.log(`  ${providerId}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    console.warn(`  [skip] ${providerId}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 5. Write models.json
// ---------------------------------------------------------------------------

const commitHash = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  cwd: REPO_DIR,
  stdout: "pipe",
}).stdout.toString().trim();

const output = {
  _meta: {
    commitHash,
    generatedAt: new Date().toISOString(),
    providerCount: Object.keys(providers).length,
    modelCount: totalModels,
  },
  providers,
  models,
};

const outPath = join(ROOT, "models.json");
await Bun.write(outPath, JSON.stringify(output, null, 2));
console.log(`\nDone: models.json (${Object.keys(models).length} providers, ${totalModels} models)`);
