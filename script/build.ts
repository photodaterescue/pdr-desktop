import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";

// Release-gate flag. Pass `--release` (via `npm run build:release`)
// to set VITE_PDR_RELEASE_GATE=release, which Vite then bakes into
// the client bundle as a literal string. The feature-flags helper
// (client/src/lib/feature-flags.ts) reads it to greys-out Trees +
// Edit Dates in v2.0.0. Plain `npm run build` leaves the gate
// unset so dev iteration on those features still works.
//
// Why both process.env AND inline define: Vite v7 broke the
// process.env-only path that earlier versions honoured. Setting
// process.env.VITE_* from inside a tsx script no longer reliably
// reaches the bundler — only shell-level env vars do. So we also
// pass an inline `define` below that hardcodes the replacement
// at the AST level, which is foolproof. Without this fallback the
// resulting bundle had `VITE_PDR_RELEASE_GATE=""` and Trees +
// Date Editor shipped UNGATED on every release-flag build, which
// is exactly the regression Terry caught 2026-05-20 ("Trees
// should be Gated, but you've ungated it… DO NOT FUCKING REMOVE
// UNTIL I SAY SO").
const isReleaseBuild = process.argv.includes('--release');
if (isReleaseBuild) {
  process.env.VITE_PDR_RELEASE_GATE = 'release';
  console.log('[build] Release gate flag set. (v3.0: Trees is unlocked — no features are gated off in this build.)');
}

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  // Inline define = belt-and-braces against Vite v7's flaky
  // process.env-from-script behaviour (see comment near isReleaseBuild
  // above). Replaces `import.meta.env.VITE_PDR_RELEASE_GATE` at the
  // AST level with the literal "release" or "" string so the
  // resulting bundle's feature-flag values are correct regardless
  // of whether Vite's loadEnv path picked the env var up.
  await viteBuild({
    define: {
      'import.meta.env.VITE_PDR_RELEASE_GATE': JSON.stringify(isReleaseBuild ? 'release' : ''),
    },
  });

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
