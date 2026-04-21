// Detection of scanner / multifunction-printer devices from EXIF metadata.
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
//
// Four layered rules:
//   1. Known scanning SOFTWARE in the Software EXIF tag — strongest signal,
//      identifies a scan regardless of hardware.
//   2. Dedicated scanner product lines (CanoScan, Scanjet, Perfection, ...).
//   3. Multifunction printer product lines (PIXMA, OfficeJet, WorkForce, ...).
//      Bare match is sufficient — no extra "scan" keyword required — since
//      these tokens are printer-only at their respective manufacturers.
//   4. Manufacturer-specific model-number prefix patterns (Canon MG####,
//      Brother MFC-*, etc.) that appear in EXIF without any brand-line word.
export function isScannerDevice(make, model, software = null) {
    const mm = `${make || ''} ${model || ''}`.toLowerCase();
    const sw = (software || '').toLowerCase();
    // ── 1. Software EXIF tag — scanning apps self-identify here ───────────────
    // Catches scans from any hardware as long as a known scanning application
    // produced the file. Covers the long tail of unknown/old scanners.
    if (sw) {
        const scanningApps = [
            // Third-party scanning apps
            /\bvuescan\b/, // VueScan (Hamrick)
            /\bsilverfast\b/, // SilverFast (LaserSoft)
            /\bnaps2\b/, // Not Another PDF Scanner 2
            // Canon scanning software
            /\bscangear\b/, // Canon ScanGear
            /\bmp\s*navigator\b/, // Canon MP Navigator EX
            /\bij\s*scan\s*utility\b/, // Canon IJ Scan Utility
            /\bmp\s*driver\b/, // Canon MP Driver (print + scan)
            // Epson scanning software
            /\bepson\s*scan\b/, // Epson Scan / Epson Scan 2
            /\bepson\s*easy\s*photo\s*scan\b/,
            /\bepson\s*document\s*capture\b/,
            // HP scanning software
            /\bhp\s*scansmart\b/,
            /\bhp\s*easy\s*scan\b/,
            /\bhp\s*smart(?:\s+app|\s+tasks)?\b/,
            /\bhp\s*scan\b/,
            /\bhp\s*digital\s*imaging\b/,
            // Brother scanning software
            /\biprint\s*&?\s*scan\b/,
            /\bcontrolcenter\b/, // Brother ControlCenter
            /\bbrother\s*scan\b/,
            // Fujitsu ScanSnap software
            /\bscansnap\s*(manager|home|organizer)\b/,
            /\bscansnap\b/,
            // Platform built-ins
            /\bwindows\s*fax\s*and\s*scan\b/,
            /\bimage\s*capture\b/, // macOS Image Capture
            /\bpreview\b(?=.*\bapple\b)/, // macOS Preview (require Apple context so it doesn't match Preview.app post-process)
            // Generic / OEM tokens that reliably indicate scanning workflow
            /\bscanner\s*driver\b/,
            /\btwain\b/, // TWAIN driver
            /\bwia\b/, // Windows Image Acquisition
            /\bsane\b/, // Scanner Access Now Easy (Linux)
        ];
        if (scanningApps.some(rx => rx.test(sw)))
            return true;
    }
    if (!mm.trim())
        return false;
    // ── 2. Dedicated scanner product lines ───────────────────────────────────
    const dedicatedScannerPatterns = [
        // Canon
        /\bcanoscan\b/,
        // HP
        /\bscanjet\b/,
        // Epson
        /\bperfection\b/,
        /\bexpression\s+\d+\b/, // Epson Expression (standalone scanners like Expression 12000XL)
        // Nikon
        /\bcoolscan\b/,
        /\bsuper\s*coolscan\b/,
        // Plustek
        /\bopticfilm\b/,
        /\bopticpro\b/,
        /\bopticbook\b/,
        /\bopticslim\b/,
        // Microtek
        /\bscanmaker\b/,
        /\bartixscan\b/,
        // Acer
        /\bscanwit\b/,
        // Minolta / Konica Minolta
        /\bdimage\s*scan\b/,
        // Imacon / Hasselblad
        /\bimacon\b/,
        /\bflextight\b/,
        // Pacific Image
        /\bpacific\s*image\b/,
        // Kodak / Kodak Alaris
        /\bkodak\s*(scanmate|scan\s*station|i\d{3,4})\b/,
        // Fujitsu
        /\bfujitsu\s*scansnap\b/,
        /\bscansnap\s*(ix|sv|fi)?\d{2,4}\b/,
        /\bfi-\d{3,4}\b/, // Fujitsu fi-series production scanners
        // Polaroid
        /\bsprintscan\b/,
        // Reflecta
        /\bcrystalscan\b/,
        /\bproscan\b/, // Reflecta ProScan
        /\brpssf\d+\b/, // Reflecta model numbers
        // Panasonic
        /\bpanasonic\s*kv-\w+\b/,
        // Generic
        /\bscanner\b/,
        /\bfilm\s*scanner\b/,
        /\bphoto\s*scanner\b/,
        /\bslide\s*scanner\b/,
        /\bflatbed\b/,
    ];
    if (dedicatedScannerPatterns.some(rx => rx.test(mm)))
        return true;
    // ── 3. Multifunction-printer brand-line tokens ───────────────────────────
    // These tokens are used exclusively for printer / MFP product lines — no
    // cameras share these names — so a bare match is sufficient.
    const mfpBrandLines = [
        // Canon
        /\bpixma\b/, // Canon PIXMA
        /\bpixus\b/, // Canon PIXUS (JP market)
        /\bimageclass\b/,
        /\bimagerunner\b/,
        /\bir-\w*\d/, // Canon iR-series copiers (imageRUNNER)
        /\bi[\s-]?sensys\b/, // Canon i-SENSYS (EU market)
        /\bmaxify\b/,
        // HP
        /\bofficejet\b/,
        /\bofficejet\s*pro\b/,
        /\bdeskjet\b/,
        /\blaserjet\b/,
        /\bcolor\s*laserjet\b/,
        /\bpagewide\b/,
        /\bneverstop\b/,
        /\bsmart\s*tank\b/,
        /\benvy\s*(photo|pro|inspire|\d{4})\b/,
        /\bphotosmart\s*(premium|plus|wireless|all-?in-?one|c\d{3,4}|b\d{3,4}|d\d{3,4})\b/,
        // Epson
        /\bworkforce\b/,
        /\becotank\b/,
        /\bxp-\d{3,4}\b/, // Epson XP-series (consumer MFP)
        /\bet-\d{3,4}\b/, // Epson ET-series EcoTank
        /\bl\d{3,4}(?:[a-z])?\b/, // Epson L-series EcoTank (requires Epson context)
        /\bstylus\s+(tx|nx|cx|dx|rx)\b/, // old Epson Stylus MFP lines
        // Brother
        /\bmfc-\w+\b/, // Brother MFC multifunction
        /\bdcp-\w+\b/, // Brother DCP digital copier/printer
        /\bads-\w+\b/, // Brother ADS scanners
        // Xerox
        /\bworkcentre\b/,
        /\bversalink\b/,
        /\baltalink\b/,
        /\bprimelink\b/,
        /\bdocumate\b/,
        /\bdocucentre\b/,
        // Ricoh
        /\baficio\b/,
        /\bricoh\s*im\s*c\d+\b/,
        /\bsp\s*c?\d{3,4}sf\b/, // Ricoh SP MFPs
        // Kyocera
        /\btaskalfa\b/,
        /\becosys\b/,
        // Sharp
        /\bsharp\s*mx-\w+\b/,
        /\bsharp\s*ar-\w+\b/,
        // Konica Minolta
        /\bbizhub\b/,
        // Samsung
        /\bscx-\w+\b/, // Samsung SCX MFP
        /\bclx-\w+\b/, // Samsung CLX colour MFP
        /\bmultixpress\b/,
        /\bproxpress\b/,
        // Lexmark
        /\bmb\d{3,4}\b/, // Lexmark MB MFP
        /\bmx\d{3,4}\b/, // Lexmark MX
        /\bmc\d{3,4}\b/, // Lexmark MC colour MFP
        /\bcx\d{3,4}\b/, // Lexmark CX colour MFP
        // Toshiba
        /\be-studio\b/,
        // OKI
        /\boki\s*mc-?\d{3,4}\b/,
        // Dell (rebrands Lexmark/Samsung)
        /\bdell\s*\d+(?:cdn|dn|mfp|cn)\b/,
    ];
    if (mfpBrandLines.some(rx => rx.test(mm)))
        return true;
    // ── 4. Manufacturer-specific model-number prefix patterns ────────────────
    // Canon PIXMA / Maxify MFP model numbers (MG5200 — the user's scanner —
    // lives here). These prefixes are exclusively printer/MFP families at
    // Canon; no cameras share them. Require \bcanon\b to avoid collision.
    const canonMfpModel = /(^|\s)(mg|mx|ts|tr|mb|gx|ip|ix|g)\d{3,4}\b/;
    if (/\bcanon\b/.test(mm) && canonMfpModel.test(mm))
        return true;
    // Canon imageCLASS MF-series (MF3010, MF445dw, etc.)
    if (/\bcanon\b/.test(mm) && /\bmf\d{3,4}\w*\b/.test(mm))
        return true;
    // HP OfficeJet / Envy / LaserJet numeric models when the Make is HP —
    // e.g. Make='HP' / Model='8710' or 'Officejet Pro 8710'.
    if (/\bhp\b|hewlett[-\s]?packard/.test(mm) && /\b\d{4}(?:[a-z]+)?\b/.test(mm) && /(pro|plus|photo|all[-\s]?in[-\s]?one|mfp|color)/.test(mm))
        return true;
    // Brother full model-prefix check (MFC-L8900CDW etc.)
    if (/\b(mfc|dcp|ads)[-\s]?[lj]?\d{3,4}\w*\b/.test(mm))
        return true;
    // Fujitsu ScanSnap full model list (ix500, ix1500, ix1600, SV600, S1300i ...)
    if (/\b(ix|sv|s)\d{3,4}[a-z]?\b/.test(mm) && /fujitsu|scansnap/.test(mm))
        return true;
    // ── 5. "series" suffix + printer-brand Make ──────────────────────────────
    // Scanners / MFPs frequently report Model ending in "series"; cameras very
    // rarely do. Combined with a known printer-brand Make, it's near-certain.
    const printerMakes = /\b(canon|hewlett[-\s]?packard|\bhp\b|epson|brother|lexmark|kodak\s*alaris|fujitsu|plustek|xerox|ricoh|kyocera|sharp|konica|minolta|samsung|toshiba|oki|panasonic)\b/;
    if (printerMakes.test(mm) && /\bseries\b/.test(mm))
        return true;
    return false;
}
