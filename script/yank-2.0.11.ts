/**
 * Emergency yank of v2.0.11 from R2 — the public installer ships with
 * broken utilityProcess workers (all five *.worker.cjs files buried
 * inside app.asar where utilityProcess.fork can't see them). Anyone
 * downloading it right now gets a broken cleanup-worker crash loop
 * plus dead AI / extract / conversion / startup workers.
 *
 * What this does:
 *   1. List current bucket contents so we can see what's there.
 *   2. Delete:
 *        - Photo Date Rescue Setup 2.0.11.exe
 *        - Photo Date Rescue Setup 2.0.11.exe.blockmap
 *        - latest.yml  (so auto-update stops pushing 2.0.11)
 *   3. If a v2.0.10 installer + .blockmap still sit in the bucket, we
 *      could write a fresh latest.yml pointing at it; for now we just
 *      delete latest.yml and let auto-update return "no update" until
 *      v2.0.12 ships with a fresh latest.yml.
 *
 * Once v2.0.12 ships, the normal release script re-uploads everything
 * and existing v2.0.11 clients pick up v2.0.12 on their next check.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

function loadDotEnv(): Record<string, string> {
  const envPath = resolve(REPO_ROOT, '.env');
  if (!existsSync(envPath)) {
    console.error('No .env at repo root.');
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

const env = loadDotEnv();

const s3 = new S3Client({
  region: 'auto',
  endpoint: env.R2_ENDPOINT,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

async function main() {
  console.log(`\n▶ Listing current bucket contents (${env.R2_BUCKET})...\n`);
  const list = await s3.send(new ListObjectsV2Command({ Bucket: env.R2_BUCKET }));
  if (!list.Contents || list.Contents.length === 0) {
    console.log('  Bucket is empty.');
    return;
  }
  for (const obj of list.Contents) {
    const size = obj.Size ? `${(obj.Size / 1024 / 1024).toFixed(1)} MB` : '?';
    console.log(`  ${obj.Key}  (${size}, ${obj.LastModified?.toISOString()})`);
  }

  const toDelete = [
    'Photo Date Rescue Setup 2.0.11.exe',
    'Photo Date Rescue Setup 2.0.11.exe.blockmap',
    'latest.yml',
  ];

  console.log(`\n▶ Deleting v2.0.11 artifacts + latest.yml...\n`);
  for (const key of toDelete) {
    const exists = list.Contents.some((o) => o.Key === key);
    if (!exists) {
      console.log(`  - ${key}  (not present, skipping)`);
      continue;
    }
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
      console.log(`  ✓ ${key}`);
    } catch (e) {
      console.log(`  ✗ ${key}  (${(e as Error).message})`);
    }
  }

  console.log(`\n▶ Verifying final bucket contents...\n`);
  const final = await s3.send(new ListObjectsV2Command({ Bucket: env.R2_BUCKET }));
  if (!final.Contents || final.Contents.length === 0) {
    console.log('  Bucket is now empty. New auto-update checks will return no manifest until v2.0.12 ships.');
  } else {
    for (const obj of final.Contents) {
      const size = obj.Size ? `${(obj.Size / 1024 / 1024).toFixed(1)} MB` : '?';
      console.log(`  ${obj.Key}  (${size})`);
    }
  }

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  ✓ v2.0.11 yanked from R2`);
  console.log(`═══════════════════════════════════════`);
  console.log(`  Direct downloads of the v2.0.11 installer will now 404.`);
  console.log(`  Auto-update on v2.0.10 clients will fail-quiet (no manifest).`);
  console.log(`  Existing v2.0.11 installs are broken until v2.0.12 ships.\n`);
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
