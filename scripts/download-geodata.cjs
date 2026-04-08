#!/usr/bin/env node
/**
 * Download and process GeoNames cities5000 dataset into a compact format
 * for offline reverse geocoding in PDR.
 *
 * Data source: GeoNames (https://www.geonames.org/)
 * License: Creative Commons Attribution 4.0
 *
 * Usage: node scripts/download-geodata.js
 * Output: electron/geodata/cities.json (~3-5MB)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createUnzip } = require('zlib');

const CITIES_URL = 'https://download.geonames.org/export/dump/cities5000.zip';
const COUNTRY_INFO_URL = 'https://download.geonames.org/export/dump/countryInfo.txt';
const OUTPUT_DIR = path.join(__dirname, '..', 'electron', 'geodata');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'cities.json');
const TEMP_DIR = path.join(__dirname, '..', '.geodata-temp');

// ISO 3166-1 alpha-2 country code to name mapping
// We'll fetch this from GeoNames countryInfo.txt

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;

    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
          process.stdout.write(`\r  Downloading... ${pct}% (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB)`);
        }
      });

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('');
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function extractZip(zipPath, destDir) {
  // Use adm-zip if available, otherwise use unzipper
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);
    return;
  } catch {
    // fallback: use Node's built-in if available
  }

  // Try unzipper
  try {
    const unzipper = require('unzipper');
    await new Promise((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: destDir }))
        .on('close', resolve)
        .on('error', reject);
    });
    return;
  } catch {}

  throw new Error('No zip extraction library available. Install adm-zip: npm install adm-zip');
}

function parseCountryInfo(text) {
  const countries = {};
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length >= 5) {
      const iso = parts[0];        // ISO alpha-2
      const name = parts[4];       // Country name
      if (iso && name && iso.length === 2) {
        countries[iso] = name;
      }
    }
  }
  return countries;
}

function parseCities(text) {
  const cities = [];
  const lines = text.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 15) continue;

    // GeoNames cities format (tab-separated):
    // 0: geonameid, 1: name, 2: asciiname, 3: alternatenames,
    // 4: latitude, 5: longitude, 6: feature class, 7: feature code,
    // 8: country code, 9: cc2, 10: admin1 code, 11: admin2 code,
    // 12: admin3 code, 13: admin4 code, 14: population, 15: elevation,
    // 16: dem, 17: timezone, 18: modification date

    const lat = parseFloat(parts[4]);
    const lon = parseFloat(parts[5]);
    const name = parts[1];        // UTF-8 name
    const asciiName = parts[2];   // ASCII name (fallback)
    const cc = parts[8];          // Country code
    const admin1 = parts[10];     // Admin1 (state/province) code
    const population = parseInt(parts[14] || '0', 10);

    if (isNaN(lat) || isNaN(lon) || !cc) continue;

    // Use ASCII name if the UTF-8 name contains non-Latin scripts
    // (keeps JSON smaller and more compatible)
    const displayName = asciiName || name;

    cities.push({
      lat: Math.round(lat * 10000) / 10000,  // 4 decimal places (~11m precision)
      lon: Math.round(lon * 10000) / 10000,
      name: displayName,
      cc,
      adm: admin1 || '',
      pop: population,
    });
  }

  // Sort by population descending — helps with tie-breaking in nearest search
  cities.sort((a, b) => b.pop - a.pop);

  return cities;
}

async function main() {
  console.log('PDR Geodata Preparation Tool');
  console.log('============================');
  console.log(`Using GeoNames cities5000 dataset (Creative Commons Attribution 4.0)\n`);

  // Create temp directory
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Download country info
  console.log('1. Downloading country info...');
  const countryInfoPath = path.join(TEMP_DIR, 'countryInfo.txt');
  await downloadFile(COUNTRY_INFO_URL, countryInfoPath);
  const countryInfoText = fs.readFileSync(countryInfoPath, 'utf-8');
  const countries = parseCountryInfo(countryInfoText);
  console.log(`   Found ${Object.keys(countries).length} countries`);

  // Download cities
  console.log('2. Downloading cities5000.zip...');
  const citiesZipPath = path.join(TEMP_DIR, 'cities5000.zip');
  await downloadFile(CITIES_URL, citiesZipPath);

  // Extract
  console.log('3. Extracting...');
  await extractZip(citiesZipPath, TEMP_DIR);

  // Parse
  console.log('4. Parsing cities...');
  const citiesText = fs.readFileSync(path.join(TEMP_DIR, 'cities5000.txt'), 'utf-8');
  const cities = parseCities(citiesText);
  console.log(`   Found ${cities.length} cities`);

  // Build compact output
  // Format: array of [lat, lon, name, countryCode, admin1] tuples for compactness
  console.log('5. Building compact dataset...');
  const compactCities = cities.map(c => [c.lat, c.lon, c.name, c.cc, c.adm]);

  const output = {
    version: 1,
    source: 'GeoNames cities5000',
    license: 'Creative Commons Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/)',
    attribution: 'GeoNames (https://www.geonames.org/)',
    generated: new Date().toISOString(),
    totalCities: compactCities.length,
    countries,
    // Each city: [lat, lon, name, countryCode, admin1Code]
    cities: compactCities,
  };

  const jsonStr = JSON.stringify(output);
  fs.writeFileSync(OUTPUT_FILE, jsonStr, 'utf-8');

  const sizeKB = (Buffer.byteLength(jsonStr) / 1024).toFixed(0);
  const sizeMB = (Buffer.byteLength(jsonStr) / 1024 / 1024).toFixed(1);
  console.log(`\n   Output: ${OUTPUT_FILE}`);
  console.log(`   Size: ${sizeKB} KB (${sizeMB} MB)`);
  console.log(`   Cities: ${compactCities.length}`);
  console.log(`   Countries: ${Object.keys(countries).length}`);

  // Cleanup
  console.log('\n6. Cleaning up temp files...');
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  console.log('\nDone! Geodata ready for PDR reverse geocoding.');
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
