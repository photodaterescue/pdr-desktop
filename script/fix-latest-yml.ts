/**
 * One-shot manifest repair for v2.0.12.
 *
 * Yesterday's `release:publish` ran twice (first attempt aborted at git-
 * clean preflight, second succeeded), and the release-notes injection
 * step in `release.ts` is not idempotent — it appends `releaseNotes:`
 * unconditionally. Result: the latest.yml uploaded to R2 had TWO
 * `releaseNotes:` blocks, YAML parsers throw "duplicated mapping key
 * (29:1)", and every existing PDR install has been failing its
 * 4-hourly auto-update check since the v2.0.12 publish.
 *
 * This script:
 *   1. Rebuilds latest.yml from scratch using the actual signed Setup.exe
 *      (re-computes sha512 + size) — guaranteed single releaseNotes block.
 *   2. Uploads the clean manifest to R2.
 *   3. Fetches the public URL and verifies no duplicate top-level keys.
 *
 * Once this completes, every existing PDR install will pick up v2.0.12
 * on its next 4-hourly update check (or 10 s after next launch).
 *
 * The script bug itself is fixed separately in release.ts (next commit).
 */

import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

function loadDotEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(resolve(REPO_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

async function main() {
  const env = loadDotEnv();
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  const version: string = pkg.version;

  const setupExe = `Photo Date Rescue Setup ${version}.exe`;
  const exePath = resolve(REPO_ROOT, 'release', setupExe);
  const notesPath = resolve(REPO_ROOT, 'release-notes', `v${version}.md`);
  const yamlOut = resolve(REPO_ROOT, 'release', 'latest.yml');

  if (!existsSync(exePath)) {
    throw new Error(`Missing installer: ${exePath}`);
  }

  console.log(`▶ Hashing ${setupExe}...`);
  const buf = readFileSync(exePath);
  const sha512 = createHash('sha512').update(buf).digest('base64');
  const size = statSync(exePath).size;
  console.log(`  size=${size} sha512=${sha512.slice(0, 16)}...`);

  // Build a CLEAN manifest from scratch — no risk of double-append.
  let yml = `version: ${version}\n`;
  yml += `files:\n`;
  yml += `  - url: ${setupExe}\n`;
  yml += `    sha512: ${sha512}\n`;
  yml += `    size: ${size}\n`;
  yml += `path: ${setupExe}\n`;
  yml += `sha512: ${sha512}\n`;
  yml += `releaseDate: '${new Date().toISOString()}'\n`;

  if (existsSync(notesPath)) {
    const notes = readFileSync(notesPath, 'utf8').trim();
    if (notes.length > 0) {
      const indented = notes.split('\n').map(l => `  ${l}`).join('\n');
      yml += `releaseNotes: |\n${indented}\n`;
    }
  }

  writeFileSync(yamlOut, yml, 'utf8');
  console.log(`▶ Wrote ${yamlOut} (${statSync(yamlOut).size} bytes)`);

  // Local validation — no duplicate top-level keys.
  const localText = readFileSync(yamlOut, 'utf8');
  const keys = localText.split('\n').filter(l => /^[a-zA-Z_][a-zA-Z0-9_]*:/.test(l)).map(l => l.split(':')[0]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length > 0) throw new Error(`Local manifest has duplicate keys: ${dupes.join(',')}`);
  console.log(`  local top-level keys: ${keys.join(', ')} — no duplicates`);

  console.log(`▶ Uploading to R2 bucket ${env.R2_BUCKET}...`);
  const s3 = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  await s3.send(new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: 'latest.yml',
    Body: readFileSync(yamlOut),
    ContentType: 'text/yaml',
  }));
  console.log(`  uploaded`);

  console.log(`▶ Smoke-testing public manifest...`);
  const url = `https://updates.photodaterescue.com/latest.yml?_t=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Smoke test failed: ${res.status} ${res.statusText}`);
  const body = await res.text();
  if (!body.includes(`version: ${version}`)) {
    throw new Error(`Smoke test mismatch: ${body.slice(0, 200)}`);
  }
  const remoteKeys = body.split('\n').filter(l => /^[a-zA-Z_][a-zA-Z0-9_]*:/.test(l)).map(l => l.split(':')[0]);
  const remoteDupes = remoteKeys.filter((k, i) => remoteKeys.indexOf(k) !== i);
  if (remoteDupes.length > 0) {
    throw new Error(`Remote manifest STILL has duplicate keys: ${remoteDupes.join(',')}`);
  }
  console.log(`  remote top-level keys: ${remoteKeys.join(', ')} — no duplicates`);

  console.log('\n═══════════════════════════════════════');
  console.log(`  ✓ latest.yml repaired for v${version}`);
  console.log('═══════════════════════════════════════');
  console.log('  Existing PDR clients will resume auto-updating on next check.');
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
