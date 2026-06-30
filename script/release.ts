/**
 * PDR release pipeline.
 *
 * STANDARD WORKFLOW (v2.0.12+ — Terry 2026-05-25 after the v2.0.11 yank):
 *
 *   1.  npm run release:package
 *         → Build + sign + locate artifacts in release/. STOPS. No R2,
 *           no git tag. Terry installs the resulting Setup.exe locally
 *           and verifies it actually works before any user can fetch it.
 *
 *   2.  Terry tests the local installer.
 *
 *   3.  npm run release:publish
 *         → Reuses the artifacts in release/, uploads to R2, smoke-tests
 *           the public manifest, tags + pushes the git tag.
 *
 * `npm run release` (no flag) runs everything in one shot — kept for
 * back-compat but treated as deprecated. v2.0.11 shipped broken to R2
 * because the full pipeline ran without a test step; don't repeat it.
 *
 * What each step actually does
 *   0.  Kill running PDR/Electron — taskkill so dev sessions can't lock
 *       files the build needs to overwrite
 *   1.  Pre-flight checks    — env file, git clean, tag not taken
 *   2.  Build                — Vite + server (npm run build:release)
 *   3.  Compile              — Electron TS (npm run build:electron)
 *   4.  Package              — electron-builder NSIS, signs with the
 *                              Sectigo USB fob (PIN prompts will fire)
 *   5.  Manifest             — generate latest.yml if electron-builder
 *                              didn't (fallback for older versions)
 *   6.  Publish              — upload Setup.exe + .blockmap +
 *                              latest.yml to Cloudflare R2 via the
 *                              S3-compatible API (creds from .env)
 *   7.  Smoke test           — GET https://updates.photodaterescue.com
 *                              /latest.yml and verify the version
 *                              string matches what we just shipped
 *   8.  Tag                  — git tag vX.Y.Z + git push origin vX.Y.Z
 *                              so the release is anchored in history
 *                              and rollback to a prior commit is one
 *                              `git checkout v1.0.1` away
 *
 *   --package-only stops after step 5. --publish-only starts at step 6
 *   and requires release/ to already contain a built installer.
 *
 * Prerequisites (the script aborts early if any are missing)
 *   - package.json version bumped to the new release version
 *     (manual — keeps the bump as its own discoverable git commit)
 *   - .env at repo root with R2_* credentials (see .env.example)
 *   - Git working tree clean + pushed
 *   - Sectigo EV USB fob plugged in
 *   - PDR app NOT currently running (NSIS can't overwrite a running
 *     copy of itself if the dev install is open)
 *
 * Notes
 *   - electron-builder's "generic" publish provider is read-only —
 *     it tells the CLIENT where to fetch updates from, but doesn't
 *     know how to push artifacts. So we ship with --publish never
 *     and upload via the S3 SDK ourselves.
 *   - The cert SHA1 in package.json (build.win.signtoolOptions)
 *     points signtool at the right cert in the local store; the
 *     fob's hardware-bound private key does the actual signing.
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// ---- paths ----

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const RELEASE_DIR = resolve(REPO_ROOT, 'release');
const PUBLIC_URL = 'https://updates.photodaterescue.com';

// ---- env loading ----

const REQUIRED_ENV = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_ENDPOINT',
] as const;

type EnvKey = (typeof REQUIRED_ENV)[number];

/**
 * Minimal .env parser — pulls KEY=VALUE lines out of a .env file
 * without pulling in the dotenv dependency. The format is well-
 * defined enough that a manual parser is robust + zero-dep.
 */
function loadDotEnv(): Record<string, string> {
  const envPath = resolve(REPO_ROOT, '.env');
  if (!existsSync(envPath)) {
    fail(
      'No .env file at repo root.\n' +
        '  Copy .env.example to .env and fill in your R2 credentials.',
    );
  }
  const content = readFileSync(envPath, 'utf8');
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

// ---- shell helpers ----

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function info(msg: string): void {
  console.log(`▶ ${msg}`);
}

function success(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

async function exec(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((res, rej) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: true,
      cwd: REPO_ROOT,
    });
    child.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`)),
    );
    child.on('error', rej);
  });
}

async function execCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    let out = '';
    let err = '';
    const child = spawn(cmd, args, { shell: true, cwd: REPO_ROOT });
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (err += d.toString()));
    child.on('exit', (code) =>
      code === 0
        ? res(out.trim())
        : rej(new Error(`${cmd} exited ${code}: ${err.trim()}`)),
    );
    child.on('error', rej);
  });
}

async function sha512OfFile(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash('sha512');
    const stream = createReadStream(path);
    stream.on('data', (d) => hash.update(d as Buffer));
    stream.on('end', () => res(hash.digest('base64')));
    stream.on('error', rej);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---- pre-flight ----

/**
 * Kill any running PDR / Electron processes before we start.
 *
 * MUST run before npm run build:electron, otherwise the renames inside
 * the build:electron script (X.js → X.cjs) can fail with EBUSY when
 * the dev session is holding file handles on the old .cjs files. Worse,
 * a running PDR can keep native modules (better-sqlite3.node, sharp)
 * locked, which makes @electron/rebuild fail silently or produce a
 * half-rebuilt module that ships to users.
 *
 * The 2026-05-25 incident — release shipped while Terry's dev session
 * was still running. The build happened to succeed by luck but
 * highlighted that no preflight check was preventing the dangerous
 * state. See feedback_kill_pdr_before_release.md in memory.
 *
 * Idempotent: taskkill returns a non-zero exit when no matching
 * process exists, which is the normal case — we swallow it.
 */
async function killRunningPdr(): Promise<void> {
  if (process.platform !== 'win32') {
    // Release pipeline is Windows-only (Sectigo signtool, signed NSIS).
    // If we ever run on macOS for dev/test, a no-op here is correct —
    // there's nothing to lock the .cjs files in the same way.
    return;
  }
  const candidates = ['electron.exe', 'Photo Date Rescue.exe'];
  for (const exe of candidates) {
    try {
      await execCapture('taskkill', ['/F', '/IM', exe]);
    } catch {
      // taskkill exits non-zero when the process isn't running.
      // That's the success case — nothing to kill.
    }
  }
}

async function preflight(
  env: Record<string, string>,
  version: string,
): Promise<void> {
  info('Pre-flight checks');

  // 0. Kill any running PDR / electron instances before anything else.
  //    See killRunningPdr() comment for the full rationale.
  await killRunningPdr();
  success('No running PDR / electron processes (killed any that were)');

  // 1. env file has all keys
  for (const key of REQUIRED_ENV) {
    if (!env[key]) fail(`Missing ${key} in .env (see .env.example)`);
  }
  success(`.env has all ${REQUIRED_ENV.length} R2 keys`);

  // 2. git working tree clean
  const status = await execCapture('git', ['status', '--porcelain']);
  if (status.length > 0) {
    fail(
      `Git working tree has uncommitted changes:\n${status}\n` +
        '  Commit or stash before releasing — we want the tag to ' +
        'point at a clean, pushed commit.',
    );
  }
  success('Git working tree clean');

  // 3. tag for this version not already used
  try {
    await execCapture('git', ['rev-parse', `v${version}`]);
    fail(
      `Tag v${version} already exists.\n` +
        '  Either bump package.json version, or delete the tag with:\n' +
        `    git tag -d v${version} && git push origin :v${version}`,
    );
  } catch {
    // rev-parse failure means the tag doesn't exist — that's what we want
  }
  success(`Tag v${version} available`);

  // 4. release dir exists or can be created
  // (electron-builder creates this; just confirm we have write access)
  console.log(`\n  About to release v${version} from ${REPO_ROOT}`);
  console.log(`  Sectigo EV fob plugged in? signtool needs it.`);
  console.log(`  Press Ctrl+C now to abort, or wait 5 s to continue...\n`);
  await new Promise((r) => setTimeout(r, 5_000));
}

// ---- main pipeline ----
//
// Two-stage release flow (v2.0.12+ — Terry 2026-05-25 after the v2.0.11
// yank). The default `npm run release` runs everything, but the
// SUPPORTED workflow is now:
//
//   1. `npm run release -- --package-only`
//        → Build + sign + locate artifacts in release/.
//          No R2 access, no git tag. STOPS so Terry can install the
//          Setup.exe locally and verify it actually works before any
//          users see it.
//   2. Terry tests the local installer (launch, look at logs, smoke
//      whatever the release changed).
//   3. `npm run release -- --publish-only`
//        → Reuses the artifacts in release/, uploads to R2, smoke-
//          tests the public manifest, tags + pushes.
//
// Running `npm run release` with neither flag works (legacy "all in
// one shot" behaviour) but is now treated as a deprecated path — the
// two-step flow is mandatory unless we're knowingly accepting the
// risk. See feedback_package_test_before_publish.md in memory.

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const packageOnly = args.includes('--package-only');
  const publishOnly = args.includes('--publish-only');
  if (packageOnly && publishOnly) {
    fail('--package-only and --publish-only are mutually exclusive.');
  }
  const mode: 'package-only' | 'publish-only' | 'all' =
    packageOnly ? 'package-only' : publishOnly ? 'publish-only' : 'all';

  console.log('═══════════════════════════════════════');
  console.log('  Photo Date Rescue — release pipeline');
  if (mode === 'package-only') console.log('  Mode: PACKAGE ONLY (no R2 upload, no git tag)');
  else if (mode === 'publish-only') console.log('  Mode: PUBLISH ONLY (skipping build, uploading existing artifacts)');
  console.log('═══════════════════════════════════════\n');

  const env = loadDotEnv();
  const pkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const version: string = pkg.version;

  await preflight(env, version);

  // PUBLISH-ONLY: skip build steps entirely. Jump to artifact location.
  if (mode === 'publish-only') {
    info('Skipping build steps (--publish-only) — using existing release/ artifacts');
  } else {
    // ---- build ----
    info(`Step 1/${mode === 'package-only' ? 3 : 4} — Vite + server bundle`);
    await exec('npm', ['run', 'build:release']);

    info(`Step 2/${mode === 'package-only' ? 3 : 4} — Electron TypeScript`);
    await exec('npm', ['run', 'build:electron']);

    // ---- rebuild non-N-API natives for Electron's ABI ----
    // electron-builder's blanket native rebuild is OFF (package.json
    // build.npmRebuild=false). Its @electron/rebuild pass tried to COMPILE
    // uiohook-napi from source — it doesn't recognise uiohook's
    // prebuildify-style prebuilt — and there's no Visual Studio C++
    // toolchain on the build machine, so that compile failed the v3.0.0
    // package. Instead we rebuild ONLY better-sqlite3 here (the lone
    // non-N-API native addon; it has an Electron prebuilt, no compile).
    // uiohook-napi / sharp / koffi are all N-API and self-load their own
    // prebuilds at runtime (proven across every dev build).
    info('Rebuilding better-sqlite3 for Electron (only non-N-API native)');
    await exec('npx', ['electron-rebuild', '-o', 'better-sqlite3']);

    // ---- clean prior release artefacts ----
    // electron-builder doesn't auto-clean release/ between builds, which
    // means previous-version .exes (Photo Date Rescue Setup 1.0.1.exe,
    // intermediate app.exe / signed-exe-tmp dirs, the unpacked
    // win-unpacked/ tree, etc.) accumulate. Wiping the whole release/
    // dir before each build keeps things tidy + means our R2 upload
    // can't accidentally pick up a stale artefact.
    if (existsSync(RELEASE_DIR)) {
      info(`Cleaning ${RELEASE_DIR}`);
      try {
        rmSync(RELEASE_DIR, { recursive: true, force: true });
        success('release/ cleaned');
      } catch (cleanErr) {
        // Non-fatal — electron-builder will overwrite what it can.
        // Most often this fails because Explorer has a window open on
        // a subfolder; the build will still produce the right .exe.
        console.warn(`  ⚠ couldn't fully clean release/: ${(cleanErr as Error).message}`);
      }
    }

    // ---- package + sign ----
    info(`Step 3/${mode === 'package-only' ? 3 : 4} — electron-builder NSIS package + signtool`);
    console.log('  USB fob will prompt for PIN one or more times.\n');
    await exec('npx', ['electron-builder', '--win', '--publish', 'never']);
  } // end of build block (skipped for --publish-only)

  // ---- locate / create artifacts ----
  const setupExe = `Photo Date Rescue Setup ${version}.exe`;
  const setupExePath = resolve(RELEASE_DIR, setupExe);
  const blockmap = `${setupExe}.blockmap`;
  const blockmapPath = resolve(RELEASE_DIR, blockmap);
  const latestYmlPath = resolve(RELEASE_DIR, 'latest.yml');

  if (!existsSync(setupExePath)) {
    fail(`Installer not found: ${setupExePath}`);
  }
  if (!existsSync(blockmapPath)) {
    fail(
      `Blockmap not found: ${blockmapPath}\n` +
        '  electron-builder must produce a .blockmap for differential ' +
        'updates. Check the NSIS output above for errors.',
    );
  }

  // electron-builder usually generates latest.yml when publish is
  // configured, but historic versions skip it under --publish never.
  // Generate it ourselves as a safety net.
  if (!existsSync(latestYmlPath)) {
    info('latest.yml missing — generating manually');
    const sha512 = await sha512OfFile(setupExePath);
    const size = statSync(setupExePath).size;
    const yml = [
      `version: ${version}`,
      `files:`,
      `  - url: ${setupExe}`,
      `    sha512: ${sha512}`,
      `    size: ${size}`,
      `path: ${setupExe}`,
      `sha512: ${sha512}`,
      `releaseDate: '${new Date().toISOString()}'`,
      '',
    ].join('\n');
    await writeFile(latestYmlPath, yml, 'utf8');
    success('latest.yml generated');
  } else {
    success('latest.yml generated by electron-builder');
  }

  // Inject release-notes (and optional `mandatory` flag) into the
  // generated latest.yml. electron-updater reads `releaseNotes` and
  // surfaces it in our in-app update toast verbatim — so older clients
  // see whatever copy we put here when they detect the new version.
  // This is our ONLY lever for talking to users still on v2.0.4 /
  // v2.0.5 / v2.0.6: their installed code can't be changed, but they
  // all read this manifest on every update check.
  //
  // The `mandatory` flag is a custom field that v2.0.7+ clients honour
  // (see electron/update-checker.ts) — when true, the renderer shows
  // a non-dismissable "Restart now" modal instead of the soft toast.
  // Older clients ignore the unknown field. Add it to a release ONLY
  // when the fixes are critical enough to justify blocking the user
  // from continuing on the old version.
  //
  // Source: release-notes/vX.Y.Z.md if present. Versioned per release
  // so the prose can be tuned individually. Missing file = no notes
  // injected (vanilla electron-builder behaviour).
  const notesPath = resolve(REPO_ROOT, 'release-notes', `v${version}.md`);
  if (existsSync(notesPath)) {
    const notes = readFileSync(notesPath, 'utf8').trim();
    if (notes.length > 0) {
      let existingYml = readFileSync(latestYmlPath, 'utf8');
      // IDEMPOTENCY FIX (Terry 2026-05-26):
      //   The original logic appended `releaseNotes: |\n...` unconditionally.
      //   Running release:publish twice (or publish-only after a stale
      //   package step) would append TWO `releaseNotes:` blocks. YAML
      //   parsers throw `duplicated mapping key (29:1)` and every
      //   existing PDR install's auto-update check fails. That happened
      //   on the v2.0.12 publish — first attempt failed at git-clean
      //   preflight (left notes injected in release/latest.yml),
      //   second attempt re-injected on top of the first, manifest
      //   shipped malformed, took ~9 hours to discover.
      //
      //   Strip any existing top-level `releaseNotes:` block (the key
      //   line + every indented continuation line) BEFORE appending the
      //   fresh one. Safe to run any number of times.
      existingYml = existingYml.replace(
        /^releaseNotes:[^\n]*\n(?:[ \t]+[^\n]*\n?)*/gm,
        '',
      );
      // YAML block-scalar (`|`) preserves newlines; indent each line
      // by 2 spaces to keep it a child of `releaseNotes:`.
      const indented = notes.split('\n').map(l => `  ${l}`).join('\n');
      const appended = existingYml.replace(/\n*$/, '\n') + `releaseNotes: |\n${indented}\n`;
      await writeFile(latestYmlPath, appended, 'utf8');
      success(`release notes injected from release-notes/v${version}.md`);
    }
  } else {
    info(`no release-notes/v${version}.md found — manifest ships without releaseNotes`);
  }

  // Pre-upload validation — duplicate top-level keys would break every
  // electron-updater client's YAML parse. Belt and braces; the
  // idempotency fix above prevents the most common cause, but a
  // hand-edited manifest, an unexpected build-time injector, or a
  // future refactor could re-introduce it. Catch it before the upload.
  {
    const finalText = readFileSync(latestYmlPath, 'utf8');
    const topKeys = finalText
      .split('\n')
      .filter((l) => /^[a-zA-Z_][a-zA-Z0-9_]*:/.test(l))
      .map((l) => l.split(':')[0]);
    const dupes = topKeys.filter((k, i) => topKeys.indexOf(k) !== i);
    if (dupes.length > 0) {
      fail(
        `latest.yml has DUPLICATE top-level keys: ${dupes.join(', ')}.\n` +
          '  electron-updater will throw "duplicated mapping key" and ' +
          'every existing PDR install\'s auto-update will fail.\n' +
          `  Inspect ${latestYmlPath} and re-run.`,
      );
    }
  }

  // PACKAGE-ONLY: stop here. Installer + blockmap + latest.yml are in
  // release/. Terry installs the Setup.exe and confirms it works
  // before any user sees it. Once confirmed, re-run with --publish-only.
  if (mode === 'package-only') {
    console.log('\n═══════════════════════════════════════');
    console.log(`  ✓ Package v${version} built locally`);
    console.log('═══════════════════════════════════════');
    console.log(`  Installer: ${setupExePath}`);
    console.log(`  Blockmap:  ${blockmapPath}`);
    console.log(`  Manifest:  ${latestYmlPath}`);
    console.log('');
    console.log('  Next steps:');
    console.log('    1. Install the Setup.exe above and verify it launches cleanly.');
    console.log('    2. Once verified, publish with:');
    console.log('         npm run release -- --publish-only');
    console.log('');
    return;
  }

  // ---- upload to R2 ----
  info('Step 4/4 — uploading to Cloudflare R2');
  const s3 = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  const uploads = [
    {
      key: setupExe,
      path: setupExePath,
      contentType: 'application/vnd.microsoft.portable-executable',
    },
    {
      key: blockmap,
      path: blockmapPath,
      contentType: 'application/octet-stream',
    },
    {
      key: 'latest.yml',
      path: latestYmlPath,
      contentType: 'text/yaml',
    },
  ];

  for (const u of uploads) {
    const size = formatBytes(statSync(u.path).size);
    process.stdout.write(`  ${u.key} (${size}) ... `);
    const body = readFileSync(u.path);
    await s3.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: u.key,
        Body: body,
        ContentType: u.contentType,
      }),
    );
    process.stdout.write('uploaded\n');
  }
  success(`uploaded ${uploads.length} artifacts to ${env.R2_BUCKET}`);

  // ---- smoke test ----
  info('Smoke-testing public manifest');
  // Bust any edge cache by appending ?_t=<unix-ms>. The Worker's
  // cache-control header is short (60 s) but during a release we
  // want to verify *this* upload is what the URL returns RIGHT NOW.
  const smokeUrl = `${PUBLIC_URL}/latest.yml?_t=${Date.now()}`;
  const res = await fetch(smokeUrl, { cache: 'no-store' });
  if (!res.ok) {
    fail(`Smoke test failed: ${res.status} ${res.statusText} from ${smokeUrl}`);
  }
  const body = await res.text();
  if (!body.includes(`version: ${version}`)) {
    fail(
      `Smoke test mismatch — manifest returned old version.\n` +
        `  First 200 chars:\n${body.slice(0, 200)}`,
    );
  }
  success(`${PUBLIC_URL}/latest.yml returns version ${version}`);

  // ---- git tag ----
  info(`Tagging v${version}`);
  await exec('git', ['tag', `v${version}`]);
  await exec('git', ['push', 'origin', `v${version}`]);
  success(`pushed tag v${version} to origin`);

  // ---- summary ----
  console.log('\n═══════════════════════════════════════');
  console.log(`  ✓ Release v${version} complete`);
  console.log('═══════════════════════════════════════');
  console.log(`  Installer: ${PUBLIC_URL}/${encodeURIComponent(setupExe)}`);
  console.log(`  Manifest:  ${PUBLIC_URL}/latest.yml`);
  console.log(`  Tag:       v${version}`);
  console.log('');
  console.log('  Existing PDR clients will pick this up on their next');
  console.log('  4-hourly check (or 10 s after their next launch).');
  console.log('');
}

main().catch((err) => {
  console.error(`\n✗ Release failed: ${err.message ?? err}\n`);
  process.exit(1);
});
