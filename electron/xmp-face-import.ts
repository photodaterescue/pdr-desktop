/**
 * XMP Sidecar Face Region Import
 *
 * Reads MWG-Regions face data from Lightroom-style .xmp sidecar files
 * (stored next to the corresponding photo, e.g. IMG_1234.jpg + IMG_1234.xmp)
 * and imports them into the PDR database as verified face detections.
 *
 * MWG-Regions schema spec:
 *   http://www.metadataworkinggroup.com/specs/MWGRegions.xsd
 *
 * A typical sidecar face region looks like:
 *   <rdf:li rdf:parseType="Resource">
 *     <mwg-rs:Name>Sarah</mwg-rs:Name>
 *     <mwg-rs:Type>Face</mwg-rs:Type>
 *     <mwg-rs:Area stArea:x="0.4" stArea:y="0.3" stArea:w="0.1" stArea:h="0.15" />
 *   </rdf:li>
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDb, upsertPerson, insertFaceDetections } from './search-database.js';

export interface XmpFaceRegion {
  name: string;
  // MWG coordinates: centre-based, 0..1 fractions of image width/height
  x: number; // centre x (0..1)
  y: number; // centre y (0..1)
  w: number; // width (0..1)
  h: number; // height (0..1)
}

/**
 * Parse MWG-Regions face data from XMP XML content.
 * Returns empty array if no regions found.
 */
export function parseXmpFaceRegions(xmpContent: string): XmpFaceRegion[] {
  const regions: XmpFaceRegion[] = [];

  // Match each <rdf:li> inside a <mwg-rs:RegionList>. XMP variants are many,
  // so we use a forgiving regex approach rather than a full XML parser.
  const liBlockRegex = /<rdf:li\b[\s\S]*?<\/rdf:li>|<rdf:li\b[\s\S]*?\/>/g;
  const regionListMatch = xmpContent.match(/<mwg-rs:RegionList[\s\S]*?<\/mwg-rs:RegionList>/);
  if (!regionListMatch) return regions;

  const listContent = regionListMatch[0];
  const liMatches = listContent.match(liBlockRegex) || [];

  for (const li of liMatches) {
    // Must be Type="Face" — skip BarCode, Pet, Focus regions etc.
    const typeMatch = li.match(/mwg-rs:Type[=\s"'>]+([^"'<\s/]+)/i);
    if (typeMatch && typeMatch[1] && typeMatch[1].toLowerCase() !== 'face') continue;

    // Extract name — can be an attribute or an element
    let name: string | null = null;
    const attrNameMatch = li.match(/mwg-rs:Name="([^"]+)"/);
    if (attrNameMatch) name = decodeXmlEntities(attrNameMatch[1]);
    if (!name) {
      const elemNameMatch = li.match(/<mwg-rs:Name>([^<]+)<\/mwg-rs:Name>/);
      if (elemNameMatch) name = decodeXmlEntities(elemNameMatch[1]);
    }
    if (!name || !name.trim()) continue;

    // Extract area
    const areaMatch = li.match(/<mwg-rs:Area\b[^/]*\/>/);
    if (!areaMatch) continue;
    const area = areaMatch[0];
    const x = parseFloat((area.match(/stArea:x="([^"]+)"/) || [])[1] || '');
    const y = parseFloat((area.match(/stArea:y="([^"]+)"/) || [])[1] || '');
    const w = parseFloat((area.match(/stArea:w="([^"]+)"/) || [])[1] || '');
    const h = parseFloat((area.match(/stArea:h="([^"]+)"/) || [])[1] || '');
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) continue;

    regions.push({ name: name.trim(), x, y, w, h });
  }

  return regions;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/**
 * Find a sidecar .xmp file for a given photo path.
 * Checks both "IMG.jpg.xmp" (Lightroom default) and "IMG.xmp" (alternate style).
 */
export function findSidecarPath(photoPath: string): string | null {
  const candidates = [
    photoPath + '.xmp',
    path.join(path.dirname(photoPath), path.basename(photoPath, path.extname(photoPath)) + '.xmp'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Import face regions from XMP sidecars for every indexed file.
 *
 * For each file:
 *   1. Find its paired .xmp sidecar (if any)
 *   2. Parse MWG face regions
 *   3. For each face region, upsert the person and insert a verified face_detection
 *
 * Skips files that already have face detections (to avoid duplicating on re-run).
 */
export function importXmpFacesForAllFiles(): {
  filesScanned: number;
  sidecarsFound: number;
  facesImported: number;
  personsCreated: number;
  filesSkipped: number;
} {
  const db = getDb();
  const files = db.prepare(`SELECT id, file_path FROM indexed_files WHERE file_type = 'photo'`).all() as { id: number; file_path: string }[];

  const filesWithFaces = new Set(
    (db.prepare(`SELECT DISTINCT file_id FROM face_detections`).all() as { file_id: number }[])
      .map(r => r.file_id)
  );

  const seenPersons = new Set<number>();
  let sidecarsFound = 0;
  let facesImported = 0;
  let filesSkipped = 0;

  for (const file of files) {
    if (filesWithFaces.has(file.id)) {
      filesSkipped++;
      continue;
    }
    const sidecarPath = findSidecarPath(file.file_path);
    if (!sidecarPath) continue;
    sidecarsFound++;

    let content: string;
    try {
      content = fs.readFileSync(sidecarPath, 'utf8');
    } catch {
      continue;
    }

    const regions = parseXmpFaceRegions(content);
    if (regions.length === 0) continue;

    // Read actual image dimensions? MWG regions are already fractional, so we can store them as fractions.
    // PDR face_detections schema uses absolute pixel coordinates elsewhere. For consistency with AI output,
    // we store fractional coordinates here — the display code reads box_x/y/w/h as given.

    const faceRecords = regions.map(r => {
      const personId = upsertPerson(r.name);
      seenPersons.add(personId);
      // Convert MWG centre-based to top-left based coordinates (still fractional)
      const boxX = Math.max(0, r.x - r.w / 2);
      const boxY = Math.max(0, r.y - r.h / 2);
      return {
        file_id: file.id,
        person_id: personId,
        box_x: boxX,
        box_y: boxY,
        box_w: r.w,
        box_h: r.h,
        embedding: null as any,
        confidence: 1.0,
        cluster_id: null as any,
        verified: 1,
      } as any;
    });

    // Insert — note PDR's insertFaceDetections doesn't set verified, so we insert manually
    const insertStmt = db.prepare(`
      INSERT INTO face_detections (file_id, person_id, box_x, box_y, box_w, box_h, embedding, confidence, cluster_id, verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const insertMany = db.transaction((items: any[]) => {
      for (const f of items) {
        insertStmt.run(f.file_id, f.person_id, f.box_x, f.box_y, f.box_w, f.box_h, f.embedding, f.confidence, f.cluster_id);
      }
    });
    insertMany(faceRecords);
    facesImported += faceRecords.length;
  }

  return {
    filesScanned: files.length,
    sidecarsFound,
    facesImported,
    personsCreated: seenPersons.size,
    filesSkipped,
  };
}
