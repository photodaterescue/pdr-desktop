// Detection of scanner / multifunction-printer devices from EXIF Make/Model.
//
// Scanners typically write the scan timestamp into EXIF DateTimeOriginal.
// That timestamp is almost never the actual photo date (a 1995 wedding photo
// scanned today would show as "today"), so any file recognised as scanner
// output is demoted to the "marked" confidence tier so it surfaces in the
// Date Editor for manual review rather than silently corrupting the library.
//
// This module is deliberately zero-dependency and pure so it can be imported
// by both the analysis engine (pre-fix classification) and the search
// indexer (post-fix re-classification of already-fixed libraries).

export function isScannerDevice(make: string | null | undefined, model: string | null | undefined): boolean {
  const m = `${make || ''} ${model || ''}`.toLowerCase();
  if (!m.trim()) return false;

  // ── 1. Dedicated scanner product lines ───────────────────────────────────
  const scannerPatterns: RegExp[] = [
    /\bscanjet\b/,             // HP Scanjet (flatbed / photo scanners)
    /\bperfection\b/,          // Epson Perfection (flatbed)
    /\bcanoscan\b/,            // Canon CanoScan
    /\bopticfilm\b/,           // Plustek OpticFilm (film scanner)
    /\bopticpro\b/,            // Plustek OpticPro
    /\bcoolscan\b/,            // Nikon Coolscan
    /\bscanmaker\b/,           // Microtek ScanMaker
    /\bscanwit\b/,             // Acer ScanWit
    /\bvuescan\b/,             // VueScan (driver/software ident in EXIF)
    /\bimacon\b/,              // Imacon / Hasselblad film scanners
    /\bflextight\b/,           // Hasselblad Flextight
    /\bpacific image\b/,       // Pacific Image film scanners
    /\bdimage\s*scan\b/,       // Minolta Dimage Scan
  ];
  if (scannerPatterns.some(rx => rx.test(m))) return true;

  // ── 2. Multifunction printer/scanner brand-line tokens ───────────────────
  // These tokens are used ONLY for printer / MFP product lines, never for
  // cameras, so a bare match is sufficient — no extra "scan" keyword needed.
  // (Previous version required a "scan" token too, which missed EXIF output
  // from a Canon PIXMA MG5200 scanning a photo: Make="Canon" / Model=
  // "MG5200 series" — no "PIXMA", no "scan", everything went to Confirmed.)
  const mfpBrandLines = /\b(officejet|deskjet|laserjet|envy\s+photo|workforce|expression|pixma|imageclass|imagerunner|irc\d|maxify|ecotank|photosmart\s+(premium|plus|wireless|all-?in-?one)|stylus\s+(tx|nx|cx))\b/;
  if (mfpBrandLines.test(m)) return true;

  // ── 3. Canon printer model-number patterns ───────────────────────────────
  // Canon's PIXMA / Maxify EXIF often contains just the bare model number
  // with no brand-line word. These prefixes are exclusively printer/MFP
  // product families at Canon (no cameras share them):
  //   MG\d{3,4}  — PIXMA MG (e.g. MG5200, MG7700)
  //   MX\d{3,4}  — PIXMA MX (e.g. MX450, MX922)
  //   TS\d{3,4}  — PIXMA TS (e.g. TS3150, TS8350)
  //   TR\d{3,4}  — PIXMA TR (e.g. TR4550, TR8620)
  //   MB\d{3,4}  — Maxify MB (e.g. MB2150, MB5150)
  //   GX\d{3,4}  — Maxify GX (e.g. GX5050, GX7050)
  //   iP\d{3,4}  — PIXMA iP
  //   iX\d{3,4}  — PIXMA iX
  //   G\d{3,4}   — PIXMA G (MegaTank)
  // Only treat these as scanner-ish when the Make is (or is blank and could
  // be) Canon, to avoid grabbing unrelated device naming elsewhere.
  const canonMfpModel = /(^|\s)(mg|mx|ts|tr|mb|gx|ip|ix|g)\d{3,4}\b/;
  if (/\bcanon\b/.test(m) && canonMfpModel.test(m)) return true;

  // ── 4. "series" suffix on a Canon/HP/Epson/Brother/Lexmark Make ──────────
  // The word "series" is extremely rare in camera Model fields but common in
  // printer firmware EXIF (e.g. "MG5200 series", "OfficeJet Pro 8710 series").
  // Combined with a printer-brand Make, this is a near-certain printer/MFP.
  const printerMakes = /\b(canon|hewlett[-\s]?packard|\bhp\b|epson|brother|lexmark|kodak alaris|fujitsu\s+scansnap|plustek)\b/;
  if (printerMakes.test(m) && /\bseries\b/.test(m)) return true;

  // ── 5. Brother / Lexmark / Fujitsu model prefix patterns ─────────────────
  // These are MFP-only product prefixes.
  const bwMfpPrefix = /\b(mfc|dcp|fax\d|scansnap|ix\d{3,4}|sv\d{3,4}|fi-\d{3,4})\b/;
  if (bwMfpPrefix.test(m)) return true;

  // ── 6. Fallback: the word 'scanner' anywhere in Make/Model ──────────────
  if (/\bscanner\b/.test(m)) return true;

  return false;
}
