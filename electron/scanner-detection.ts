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

  // Dedicated scanner product lines
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

  // Multifunction printer/scanner combos — match brand product-line token
  // AND a scan-identifying token, so we don't false-positive on camera
  // brands sharing a parent company (e.g. Canon DSLRs).
  const mfpHints = /\b(officejet|deskjet|envy|laserjet|workforce|expression|pixma|imageclass|mfc|dcp|hl|maxify)\b/;
  if (mfpHints.test(m) && /\b(scan|mfp|all[-\s]?in[-\s]?one|aio)\b/.test(m)) return true;

  // Fallback: the word 'scanner' anywhere in Make/Model.
  if (/\bscanner\b/.test(m)) return true;

  return false;
}
