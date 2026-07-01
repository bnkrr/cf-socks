#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const profiles = {
  full: "worker/src/profiles/full.ts",
  "wss-only": "worker/src/profiles/wss-only.ts",
  "direct-connect": "worker/src/profiles/direct-connect.ts",
  "url-full": "worker/src/profiles/url-full.ts",
};

const dashboardOutfiles = {
  full: "worker/single-file/full.js",
  "wss-only": "worker/single-file/wss-only.js",
  "direct-connect": "worker/single-file/direct-connect.js",
  "url-full": "worker/single-file/url-full.js",
};

const args = parseArgs(process.argv.slice(2));
if (args.all) {
  if (args.profile || args.outfile || args.metafile) {
    console.error("--all cannot be combined with --profile, --outfile, or --metafile");
    process.exit(2);
  }
  for (const profile of Object.keys(profiles)) {
    await buildProfile(profile, dashboardOutfiles[profile]);
  }
} else {
  const profile = args.profile ?? "full";
  const outfile = args.outfile ?? dashboardOutfiles[profile];
  await buildProfile(profile, outfile, args.metafile);
}

async function buildProfile(profile, outfile, metafile) {
  const entryPoint = profiles[profile];
  if (!entryPoint) {
    console.error(`unknown worker profile: ${profile}`);
    console.error(`available profiles: ${Object.keys(profiles).join(", ")}`);
    process.exit(2);
  }

  await mkdir(dirname(resolve(outfile)), { recursive: true });
  if (metafile) {
    await mkdir(dirname(resolve(metafile)), { recursive: true });
  }

  const result = await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:sockets"],
    banner: {
      js: `// Generated from ${entryPoint} (${profile} profile). Do not edit by hand.`,
    },
    metafile: Boolean(metafile),
  });

  if (metafile) {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(metafile, JSON.stringify(result.metafile, null, 2)));
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];
    if (arg === "--all") {
      parsed.all = true;
      continue;
    }
    if (arg === "--profile" || arg === "--outfile" || arg === "--metafile") {
      const value = values[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      parsed[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      parsed.profile = arg.slice("--profile=".length);
      continue;
    }
    if (arg.startsWith("--outfile=")) {
      parsed.outfile = arg.slice("--outfile=".length);
      continue;
    }
    if (arg.startsWith("--metafile=")) {
      parsed.metafile = arg.slice("--metafile=".length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}
