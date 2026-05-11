/**
 * Publish-only — upload the artifacts that script/release.ts produced,
 * smoke-test the public manifest, and tag the release in git. Skips the
 * build/sign steps entirely (no fob prompt) so it's safe to run after a
 * manual gate where the installer was already built + smoke-tested
 * locally before the operator commits to shipping.
 *
 * Expects release/Photo Date Rescue Setup <version>.exe (+ .blockmap +
 * latest.yml) to already exist. Reads version from package.json.
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const RELEASE_DIR = resolve(REPO_ROOT, 'release');
const PUBLIC_URL = 'https://updates.photodaterescue.com';

function loadDotEnv(): Record<string, string> {
  const envPath = resolve(REPO_ROOT, '.env');
  if (!existsSync(envPath)) {
    console.error('No .env file at repo root');
    process.exit(1);
  }
  const content = readFileSync(envPath, 'utf8');
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function exec(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((res, rej) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true, cwd: REPO_ROOT });
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
    child.on('error', rej);
  });
}

async function main(): Promise<void> {
  const env = loadDotEnv();
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  const version: string = pkg.version;

  const setupExe = `Photo Date Rescue Setup ${version}.exe`;
  const setupExePath = resolve(RELEASE_DIR, setupExe);
  const blockmap = `${setupExe}.blockmap`;
  const blockmapPath = resolve(RELEASE_DIR, blockmap);
  const latestYmlPath = resolve(RELEASE_DIR, 'latest.yml');

  for (const [label, path] of [
    ['installer', setupExePath],
    ['blockmap', blockmapPath],
    ['manifest', latestYmlPath],
  ] as const) {
    if (!existsSync(path)) {
      console.error(`Missing ${label}: ${path}`);
      process.exit(1);
    }
  }

  console.log(`▶ Publishing v${version} to R2`);

  const s3 = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  const uploads = [
    { key: setupExe, path: setupExePath, contentType: 'application/vnd.microsoft.portable-executable' },
    { key: blockmap, path: blockmapPath, contentType: 'application/octet-stream' },
    { key: 'latest.yml', path: latestYmlPath, contentType: 'text/yaml' },
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

  // Smoke test — confirm the public manifest now serves the new version.
  const smokeUrl = `${PUBLIC_URL}/latest.yml?_t=${Date.now()}`;
  const res = await fetch(smokeUrl, { cache: 'no-store' });
  if (!res.ok) {
    console.error(`Smoke test failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const body = await res.text();
  if (!body.includes(`version: ${version}`)) {
    console.error(`Smoke test mismatch — manifest returned old version\n${body.slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`  ✓ ${PUBLIC_URL}/latest.yml returns version ${version}`);

  // Tag the commit so the release is anchored in history.
  console.log(`▶ Tagging v${version}`);
  await exec('git', ['tag', `v${version}`]);
  await exec('git', ['push', 'origin', `v${version}`]);

  console.log(`\n✓ v${version} shipped\n  Installer: ${PUBLIC_URL}/${encodeURIComponent(setupExe)}\n  Manifest:  ${PUBLIC_URL}/latest.yml\n  Stable:    ${PUBLIC_URL}/download`);
}

main().catch((err) => {
  console.error(`✗ Publish failed: ${err.message ?? err}`);
  process.exit(1);
});
