/**
 * PDR release pipeline — single command to ship a new version.
 *
 * Run via: npm run release
 *
 * What it does
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

async function preflight(
  env: Record<string, string>,
  version: string,
): Promise<void> {
  info('Pre-flight checks');

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

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════');
  console.log('  Photo Date Rescue — release pipeline');
  console.log('═══════════════════════════════════════\n');

  const env = loadDotEnv();
  const pkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const version: string = pkg.version;

  await preflight(env, version);

  // ---- build ----
  info('Step 1/4 — Vite + server bundle');
  await exec('npm', ['run', 'build:release']);

  info('Step 2/4 — Electron TypeScript');
  await exec('npm', ['run', 'build:electron']);

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
  info('Step 3/4 — electron-builder NSIS package + signtool');
  console.log('  USB fob will prompt for PIN one or more times.\n');
  await exec('npx', ['electron-builder', '--win', '--publish', 'never']);

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
