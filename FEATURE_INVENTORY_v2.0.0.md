# Photo Date Rescue — Feature Inventory

**Version 2.0.0** · Generated from a full codebase audit · May 2026

A comprehensive catalogue of every user-facing feature, capability and behaviour in the v2.0.0 release build. Features released in v1.0.1 are marked **[v1]**; new in v2.0.0 are marked **[NEW]**; substantially reworked are marked **[REWORKED]**. Features that exist in the codebase but are gated off in the v2.0.0 release build (Trees, Edit Dates) are listed in the appendix.

---

## 1. Date Extraction & Recovery (Core Engine)

- **EXIF DateTimeOriginal / CreateDate / ModifyDate extraction** [v1]
- **XMP metadata extraction** [v1]
- **Google Takeout JSON sidecar parsing** [v1]
- **Filename pattern analysis** — 12+ patterns (YYYY-MM-DD, YYYYMMDD, IMG_, VID_, Screenshot_, etc.) [v1]
- **WhatsApp filename detection** — IMG-YYYYMMDD-WA / VID-YYYYMMDD-WA [v1]
- **File modification time fallback** [v1]
- **ZIP entry timestamp parsing** [v1]
- **Multi-source date priority** — Google Takeout > EXIF > XMP > Filename > File modification time [v1]
- **Scanner-authored date demotion** — Dates written by scanner software are demoted to **Marked** during analysis (was: treated as Confirmed, mis-classifying scanned print dates as capture dates) [NEW]

## 2. Confidence Scoring

- **Three confidence tiers** — Confirmed / Recovered / Marked [v1]
- **Confidence dashboard cards** — Three colour-coded cards showing counts and percentages [v1]
- **Confidence filtering** — Click a card to filter the preview list [v1]
- **Date source attribution** — Each file's report entry records which method yielded its date [v1]

## 3. Media Format Support

- **Photo format recognition** — 16 formats (JPG, JPEG, PNG, GIF, BMP, TIFF, WebP, HEIC, HEIF, RAW, CR2, NEF, ARW, DNG, etc.) [v1]
- **Video format recognition** — 11 formats (MP4, MOV, AVI, MKV, WMV, FLV, WebM, M4V, 3GP, MTS, M2TS) [v1]
- **Photo/video toggle** — Filter the analysis panel to photos / videos / both [v1]

## 4. Source Management

- **Add folder or drive** — Custom Folder Browser modal (was: native OS picker) [REWORKED]
- **Add ZIP archive** — Native file picker filtered to ZIP [v1]
- **Add RAR archive** — Native file picker filtered to RAR [v1]
- **Multiple sources** — Add and combine several folders / archives [v1]
- **Source checkboxes** [v1]
- **Select-all checkbox** with indeterminate state [v1]
- **Shift+Click range selection** [v1]
- **Remove source** — also cleans up the source's extracted temp dir if any [REWORKED]
- **Source type icons** — Folder / Hard Drive / ZIP Archive / Drive [v1]
- **Source confidence summary on Source-Added card** — files-couldn't-be-processed count surfaced inline rather than buried in the report [NEW]
- **Cross-drive duplicate detection** — When you add a folder whose name + file count + total bytes match an existing source on a different drive (e.g. F:\Photos\Blackberry vs H:\Photos\Blackberry), PDR shows a soft-warning modal naming both drive letters; existing source pulses amber in the sidebar [NEW]
- **Exact-path duplicate** — Same source already added → sidebar pulse + "Already added" badge instead of a corner toast [NEW]
- **Large-zip-at-a-time guard** — Adding multiple multi-GB Takeouts in one session warns the user before adding the second, to prevent C: drive fill [NEW]
- **Default Grid view** in source picker (was: Details list) [NEW]

## 5. Archive Handling

- **ZIP scanning without extraction (under 2 GB)** [v1]
- **Streaming ZIP engine** — switched from adm-zip to unzipper for streaming entry reads, prevents Buffer.concat overflow on multi-GB videos inside zips [REWORKED]
- **Skip-and-continue on corrupt entries** — Bad entries are logged and skipped; the rest of the zip continues processing (was: whole-zip abort) [NEW]
- **Large ZIP auto-extraction** — Now extracts to the **destination drive's** temp area instead of `%TEMP%` on C:, preventing system drive fill during multi-Takeout sessions [REWORKED]
- **Smart-prompt fallback** — When neither the destination drive nor `%TEMP%` has enough room, modal asks the user to pick another drive instead of failing silently [NEW]
- **RAR extraction** — Bundled UnRAR.exe with progress feedback [v1]
- **Honest extraction progress** — Progress denominator is total entries (media + JSON + sidecar), not media-only (which previously made the bar lie at 33% when work was 66% done) [REWORKED]
- **Per-Takeout temp cleanup** — Temp directory deleted after the copy completes (was: only on app quit, accumulating across multi-Takeout sessions) [REWORKED]
- **Source-removal cleanup hook** — Removing a source from the menu also deletes its extracted temp dir [NEW]
- **Orphaned temp cleanup on startup** — Removes leftover temp folders from previous sessions [v1]

## 6. Duplicate Detection

- **SHA-256 hash matching** — For exact duplicates on local drives [v1]
- **Async chunked hash** — Hashing of multi-hundred-MB buffers no longer blocks the main thread; UI stays responsive during analysis of large videos [REWORKED]
- **Heuristic matching** — Filename + size for network / cloud sources [v1]
- **Automatic mode selection** — Hash for local, heuristic for network/cloud [v1]
- **Large file fallback** — Files over 500 MB use heuristic [v1]
- **Cross-run detection** — Pre-scans destination before each run [v1]
- **Within-run deduplication** [v1]
- **Collision numbering** — Appends `_001`, `_002` etc. [v1]
- **Skip Duplicates toggle** [v1]
- **Thorough Duplicate Matching toggle** [v1]
- **Detection method tracking** in reports [v1]
- **Per-file size guard** in streaming path — Multi-GB videos inside zips that previously crashed v1.0.1 with `Buffer.concat` allocation errors are now skip-logged and the analysis continues [NEW]

## 7. EXIF Date Writing

- **Write dates to EXIF** — DateTimeOriginal, CreateDate, ModifyDate [v1]
- **Multi-format support** — JPG, JPEG, PNG, TIFF, WebP, HEIC, HEIF, DNG, CR2, NEF, ARW [v1]
- **Master EXIF toggle** [v1]
- **Per-confidence EXIF controls** — Independent toggles for Confirmed / Recovered / Marked [v1]
- **Date validation** — Rejects dates pre-1971 or > 24 h in the future [v1]
- **15-second per-file timeout** [v1]
- **Graceful degradation** — Failed EXIF write doesn't block the copy [v1]

## 8. File Copying & Organisation

- **Date-based renaming** — `YYYY-MM-DD_HH-MM-SS` with confidence suffix [v1]
- **Folder structure options** — Year / Year/Month / Year/Month/Day [v1]
- **Streaming copy** — 64 KB chunks [v1]
- **Non-blocking I/O** — Yields to event loop per file [v1]
- **Cancellable operations** [v1]
- **Progress tracking** — Live file name, percentage, count [v1]
- **Network-staging path** — When destination is on a network/UNC path, files are staged locally first then mirrored via robocopy; phase events surface "staging" → "mirror" in the progress UI so users understand the pause at 100% [NEW]

## 9. Search & Discovery [NEW SECTION]

- **Search panel view** — Full-text search across the indexed library by date, filename, location, person, tag, camera, scanner, EXIF fields [NEW]
- **Filter ribbon** — Camera, Calendar (date range), GPS, Photo/Video, Star rating, Source, Confidence, plus advanced numeric filters [NEW]
- **Run / library selector** — Scope search to a specific fix run, the latest run, or all indexed files [NEW]
- **Sort by** — Date, filename, size, confidence; ascending/descending [NEW]
- **Result views** — Grid, List, Details (sortable columns) [NEW]
- **Thumbnail tiles** — Adjustable size 100-360 px via slider; persisted across sessions [NEW]
- **Tile metadata overlay** — Toggle filename / date overlays on each thumbnail [NEW]
- **Selection + bulk actions** — Multi-select + bulk operations [NEW]
- **Viewer integration** — Click any result to open in the photo viewer (independent window) [NEW]
- **Camera Mode rename** — "Camera" classification carved out from the more generic "Source Type" filter; clearer for users [NEW]
- **Keyboard navigation** — Arrow keys + Enter for result navigation [NEW]
- **Empty-state default** — Search panel starts empty; user picks what's shown rather than the panel pre-populating with "all files" (which became unwieldy on libraries with 100k+ files) [NEW]

## 10. Memories View [NEW SECTION]

- **Year / Month timeline** — Buckets of indexed files grouped by year, drilled down to month and day [NEW]
- **On This Day** — Photos taken on today's date in previous years [NEW]
- **Day drilldown** — Click any day-bucket to see all files from that day [NEW]
- **Library selector** — Switch between fix runs to view that library's memories [NEW]
- **Thumbnail tiles** — Same adjustable sizing as Search & Discovery [NEW]
- **Run grouping** — Multiple runs combined into one library view when desired [NEW]

## 11. People Manager [NEW SECTION]

- **Independent window** — Opens as a separate Electron window so it survives the main window being closed [NEW]
- **AI-detected face clusters** — BlazeFace + FaceMesh + FaceRes models bundled inside the installer; auto-runs on indexed files post-fix [NEW]
- **Person naming + merging** — Assign a name to a face cluster; merge two clusters when the AI's split them too aggressively [NEW]
- **Photo count + verified-only sorting** [NEW]
- **Re-analyze AI Tags** — Settings button to reprocess tags-only (preserves face clusters / people names) [NEW]
- **Auto-resume on launch** — Tags-only processing resumes if a previous session was interrupted [NEW]
- **Expanded label set** — ~180 tag terms (was ~60) [NEW]
- **AI progress pill** — Persistent in the global title bar so users can see processing happening across windows [NEW]

## 12. Storage & Performance Intelligence

- **Disk space display** — Available + total with colour-coded bar [v1]
- **Storage type classification** — Local / network / cloud-synced [v1]
- **Cloud folder detection** — OneDrive, Dropbox, Google Drive, iCloud, Box, MEGA [v1]
- **Network drive detection** — UNC paths + mapped network drives [v1]
- **Same-drive warning** — Source + destination on same slow medium [v1]
- **Storage colour coding** — Green / orange / red [v1]
- **Performance nudge tooltip** [v1]
- **Show Storage Tips toggle** [v1]
- **Drive scoring engine** — Scores each drive on speed (fast/medium/slow), connection type (Local/USB/Network/Cloud), free space, system-drive penalty; powers the Drive Advisor + Folder Browser ratings [NEW]
- **Required-GB sizing** — Once user states their library size in the Library Planner, every drive in subsequent pickers gets a "Too small for library / Tight fit / Good" rating against that target [NEW]

## 13. Library Planner [NEW SECTION]

- **Collection-size step** — 7 size buckets from "Under 50 GB" to "4 TB+", each with a sublabel describing typical content (e.g. "Multi-device library with video", "Professional-scale archive") [NEW]
- **Multiple-sources step** — Yes / No / Not sure (informs final size estimate) [NEW]
- **Drive-suggestion step** — Shows all available drives with the planner's size estimate applied as a "Required" target — drives that can't hold the library are marked clearly [NEW]
- **Bucket midpoint sizing** — Each bucket has a tight midpoint estimate (1500 GB for "1-2 TB", 3072 GB for "2-4 TB", etc.) so downstream colour-coding is accurate [NEW]
- **Skippable** — User can skip planning and pick a destination directly [NEW]

## 14. Drive Advisor (DDA) [NEW SECTION]

- **Drive scoring + ranking** — Scores drives on speed, capacity, connection type, system-drive status [NEW]
- **Recommended badges** — "Recommended" / "Not suitable" / "External" / "System drive" badges [NEW]
- **Speed tier display** — Fast / Medium / Slow, with explanatory copy ("USB 3.x will be fast", "Network — slow", etc.) [NEW]
- **Warnings** — System drive, low space, removable, network reliability concerns [NEW]
- **Crown indicator** — Top-rated drive flagged for at-a-glance choice [NEW]
- **Sort options** — By score, by free space, by capacity [NEW]
- **Continue → Folder Browser** — Hands off to the Folder Browser pre-filtered on the chosen drive [NEW]

## 15. Custom Folder Browser [NEW SECTION]

- **Replaces native OS folder picker** for both source and destination selection — gives PDR control over visuals + can refuse system drives [NEW]
- **Drive listing with colour-coded ratings** — Good / warning / poor based on the drive scorer; required-GB sizing if planner data exists [NEW]
- **Quick Access folders** — Desktop, Downloads, Documents, Pictures, Videos, Music — collapsible [NEW]
- **Hide / Restore drives** — User can hide drives they don't want to see (DVD drives, etc.); restore later [NEW]
- **Three view modes** — Grid (large thumbnails), List, Details (sortable columns) [NEW]
- **Sort by header click** in Details view — Name, Size, Modified [NEW]
- **Inline thumbnails** for image folders [NEW]
- **Create new folder** inline [NEW]
- **Folder navigation** — Back / forward, breadcrumbs [NEW]
- **25-second help nudge** — If user dwells on the picker for 25 s, a hint surface appears with tips about drive choice [NEW]
- **Library Planner re-access button** — Open the planner again from inside the folder browser if the user wants to revise their estimate [NEW]
- **Drive Advisor re-access button** — Same, for DDA [NEW]

## 16. Pre-Scan

- **Quick file count** — Scans source for photos, videos, total size [v1]
- **Live progress** — Updates every 20-100 files [v1]
- **20-second timeout** for slow network/cloud sources [v1]
- **Continue or proceed** after timeout [v1]
- **Size severity warnings** — Low / Medium / High / Very High [v1]
- **Estimated analysis time** [v1]
- **Cancellable** [v1]

## 17. Reports & Export

- **Automatic report saving** as JSON [v1]
- **Reports history** [v1]
- **Report detail view** [v1]
- **Export to CSV** — Run ID, filename, confidence, method, file type, EXIF status [v1]
- **Export to TXT** — Formatted plain text [v1]
- **Delete reports** (gated by Allow Report Removal) [v1]
- **Report storage** — Persists across sessions [v1]
- **Stale runs detection** — Warns if a re-fix is being run against a destination that no longer matches the index (file moved/deleted outside PDR) [NEW]

## 18. Destination Management

- **Destination-first flow** — User picks library drive on the interim screen *before* adding sources (was: source-first, often led to running out of space mid-fix) [REWORKED]
- **Select destination folder** — via the custom Folder Browser [REWORKED]
- **Change destination** — Available at any point pre-fix [v1]
- **Storage indicator** — Visual bar showing used vs free space [v1]
- **Free-space display** in GB [v1]
- **Output preview** — Visual folder tree showing the planned organisation [v1]
- **Open destination folder** in Explorer [v1]
- **Parallel structure modal** — Preview of how the destination will be organised against the chosen folder structure (Year / Year/Month / Year/Month/Day) [NEW]

## 19. License & Activation

- **License key entry** — XXXX-XXXX-XXXX-XXXX format [v1]
- **One-click activation** via Lemon Squeezy API [v1]
- **Plan detection** — Monthly, Yearly, Lifetime [v1]
- **Machine fingerprint** — SHA-256 hardware ID [v1]
- **License status badge** — Green / amber / red [v1]
- **License modal** — Plan, email, status, action buttons [v1]
- **Offline grace period** — 7 days [v1]
- **Grace period countdown** [v1]
- **Deactivate license** [v1]
- **Refresh validation** [v1]
- **Purchase link** [v1]
- **License-gated features** — Premium features prompt activation if missing [v1]
- **5-second AbortController timeout** on the activation/validation API call — offline launch falls back to cached state in 5 s instead of waiting on the OS-level 21 s TCP timeout [NEW]
- **Feature teaser modal** — Replaces the generic License Required modal for specific premium features (Search & Discovery, Memories, People Manager) with a tailored explanation of what that feature does + a Buy button [NEW]

## 20. Auto-Update [REWORKED SECTION]

- **Background version check** — Hits `https://updates.photodaterescue.com/latest.yml` 10 s after launch and every 4 h thereafter [REWORKED — was: manual check on launch only, opened browser to download]
- **Download in background** — Differential update via .blockmap; only the changed bytes are downloaded (typical: 1-10 MB instead of full 80 MB installer) [NEW]
- **State machine** — idle → checking → available → downloading → downloaded → error, with a UI tile per state [NEW]
- **"Update available" toast** — Bottom-right corner, with a description of the new version + Get update / Later buttons [REWORKED]
- **"Downloading update" progress bar** — Live percentage, transferred bytes / total bytes [NEW]
- **"Update ready — Restart now" toast** — Click to install immediately and relaunch [NEW]
- **Install on quit** — If user dismisses the restart prompt, installer runs silently when they next quit PDR; next launch is on the new version [NEW]
- **Persistent log forwarding** — Updater events go to `main.log` so support can diagnose update failures [NEW]
- **Code-signing verification** — Updater on Windows verifies the new installer is signed by the same publisher CN ("Photo Date Rescue Ltd") before installing [NEW]
- **Cloudflare-fronted distribution** — Custom domain `updates.photodaterescue.com` proxies a private R2 bucket; signed installers + manifest live there [NEW]

## 21. Settings

### Core Settings

- **Folder structure** — Year / Year-Month / Year-Month-Day [v1]
- **Play completion sound** [v1]
- **Show Welcome Screen on launch** [v1]
- **Show Welcome Capability Showcase** — Toggle for the "5 PDR apps" row on Welcome [NEW]

### Advanced Settings

- **Allow Report Removal** [v1]
- **Skip duplicate files** [v1]
- **Thorough duplicate matching** [v1]
- **Write EXIF dates to files** + per-confidence sub-toggles [v1]
- **Show storage performance warnings** [v1]
- **Reset to Defaults** [v1]
- **Auto-reset on startup** — Skip Duplicates re-enabled every launch [v1]
- **Re-analyze AI Tags** — Tags-only AI reprocess button (preserves faces / people) [NEW]
- **Reset Onboarding** — Clears Welcome-skip + tour-completion flags so user sees the onboarding flow again; useful for support [NEW]
- **Burger menu pulse opt-out** — Disable the "what's hidden in the menu?" pulse on the title-bar burger [NEW]
- **Settings reset confirmation** — Re-analyze AI Tags now uses a styled promptConfirm + toast (was: native dialog) [REWORKED]

## 22. Welcome & Onboarding

- **Welcome screen** — Animated logo, heading, three interactive cards [v1]
- **Capability showcase row** — 5 PDR apps row showing what's coming + what's available now (Trees + Edit Dates show as "Released shortly") [NEW]
- **"Find Your Photos & Videos" card** — Now flows into the destination-first interim screen [REWORKED]
- **"Take a Quick Tour" card** [v1]
- **"Best Practices" card** [v1]
- **"Help & Support" modal access** from Welcome — same H&S content available without entering the workspace first [NEW]
- **"Go to Workspace" shortcut** [v1]
- **"Skip this screen next time" checkbox** [v1]
- **Animated entrance** [v1]
- **Background gradient blobs** [v1]

## 23. Destination-First Interim Screen [NEW SECTION]

- **Pick a Library Drive prompt** — User chooses where their library will live before they add the first source [NEW]
- **Library Planner CTA** — Opens the Library Planner modal [NEW]
- **Drive Advisor CTA** — Opens the DDA modal [NEW]
- **Custom Folder Browser** — Opens the FolderBrowser for direct destination pick [NEW]
- **Drives prewarm** — Drive list begins enumerating in background while user is still on this screen so the picker opens instantly [NEW]
- **Skip / Use Default** — User can defer the destination choice and pick later (default behaviour falls back to the OS Pictures folder) [NEW]
- **Persistent destination** — Chosen library drive is saved across sessions; PDR remembers and prefers it on next launch [NEW]

## 24. Guided Tour

- **10-step interactive walkthrough** with spotlight overlay [v1]
- **Pulsing ring animation** [v1]
- **Step tooltip with title and description** [v1]
- **Previous / Next navigation + Skip Tour** [v1]
- **Step indicator dots** [v1]
- **First-visit auto-trigger** [v1]
- **Replay from sidebar** [v1]
- **Completion tracking** [v1]

## 25. Guidance & Help Panels

- **Getting Started panel** — Step-by-step new-user walkthrough [v1]
- **Best Practices panel** [v1]
- **What Happens Next panel** [v1]
- **Help & Support panel** [v1]
- **Help & Support modal** — Same content reachable via Welcome screen modal (without entering the workspace) [NEW]
- **About PDR panel** — Now includes Version History accordion with v2.0.0, v1.0.1, v1.0.0 release notes + Check for Updates button [REWORKED]
- **Bundled guide screenshots** — 13 screenshots illustrate the help panels [v1]
- **Take a Quick Tour accordion hidden from Welcome's H&S modal** (full tour is its own card on Welcome) [NEW]

## 26. Reporting & Diagnostics [REWORKED SECTION]

- **Report a Problem modal** — Now in Help & Support (was: separate location) [REWORKED]
- **Diagnostic ZIP** — Bundles `main.log`, `main.old.log`, system info, licence state into a single `pdr-diagnostic-<timestamp>.zip` in user's Documents folder [NEW]
- **Pre-filled mailto** with system info + last 200 log lines [v1]
- **Reveal the diagnostic ZIP in Explorer** — User drags one file into the email instead of fishing through `%APPDATA%` [NEW]
- **Webmail fallback copy** — Modal shows `admin@photodaterescue.com` as a clickable mailto for users with no default mail client [NEW]
- **Crash detection on analysis path** — When the analysis IPC handler throws unexpectedly (Jane's "analysis just routes back to workspace silently" symptom), full error context (message, stack, source path) is logged to `main.log` and a "Send report" toast surfaces with a single click to open the diagnostic-ZIP modal pre-filled [NEW]
- **Persistent log file** — `electron-log` writes both main and renderer logs to `%APPDATA%\Photo Date Rescue\logs\main.log` with rotation [NEW]
- **Renderer → main log forwarder** — Anything the React side logs is also written to `main.log` so support has one place to look [NEW]

## 27. Dark Mode

- **Toggle button** — Sun/Moon in the title bar [v1]
- **Full theme inversion** — Background, text, card, border, hover [v1]
- **Conditional logo** — Light/dark variants [v1]
- **Persistent preference** [v1]

## 28. Zoom Controls

- **Zoom in / Zoom out** — 5% steps; 60% min, 130% max [v1]
- **Current zoom display** [v1]
- **Disabled at bounds** [v1]
- **Persistent zoom level** [v1]
- **Initial zoom 80%** [v1]
- **Fixed bottom-right position** [v1]
- **Keyboard zoom blocked** — Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0 prevented at the BrowserWindow level (was: native zoom + custom zoom both running, causing layout glitches) [NEW]

## 29. Modals & Dialogs

- **License modal** [v1]
- **License Required modal** [v1]
- **Settings modal** [v1]
- **Pre-Scan Results modal** [v1]
- **Network Scan modal** [v1]
- **Fix Progress modal** [v1]
- **Cancel confirmation dialog** [v1]
- **Preview Changes modal** [v1]
- **Post-Fix Report modal** [v1]
- **Reports List modal** [v1]
- **Source Type Selector modal** [v1]
- **Folder Browser modal** [NEW]
- **Library Planner modal** [NEW]
- **Destination Advisor (DDA) modal** [NEW]
- **Parallel Structure modal** [NEW]
- **Temp Space Prompt modal** — Smart-prompt fallback when no drive has enough room [NEW]
- **Stale Runs modal** — Warns when a re-fix is running against a stale index [NEW]
- **Soft-Dup Source modal** — Cross-drive duplicate confirmation with drive letters named [NEW]
- **Help & Support modal** — Welcome-screen entry point [NEW]
- **Report a Problem modal** — Diagnostic ZIP flow [REWORKED]
- **Feature Teaser modal** — Per-feature buy prompts [NEW]
- **Update Notification toast** — State-driven (replaces the old single-shot UpdateNotification) [REWORKED]

## 30. Title Bar & Window Chrome [NEW SECTION]

- **Custom title bar** — Replaces the native window chrome with a PDR-branded bar that includes the burger menu, fix-in-progress chip, app menu, and zoom/dark-mode controls [NEW]
- **Cross-window Fix-in-progress chip** — Shows in the title bar of every open PDR window when a fix is running, with a click-to-open hook that surfaces the FixProgressModal [NEW]
- **Main process liveness banner** — If the renderer detects the main process is unresponsive, a banner surfaces in the title bar so the user understands why PDR isn't responding [NEW]
- **Burger menu** — Opens the sidebar Guidance / Tools / App sections in a compact menu form for narrow windows [NEW]
- **Burger pulse** — The burger pulses lavender when there's an unread item the user hasn't yet opened (settable per user via the pulse-opt-out toggle) [NEW]
- **AI progress pill** — Persistent in title bar during AI tag/face processing across all windows [NEW]

## 31. Sidebar & Navigation

- **Resizable sidebar** — 200-600 px range [v1]
- **Restructured into sections** — Views / Tools / Guidance / App (was: flat list) [REWORKED]
- **Auto-fold on new source** — Sidebar auto-collapses sections when adding a source so the source menu has more room [NEW]
- **Pre-emptive section collapse on overflow** — When the source menu fills the sidebar, less-used sections collapse first [NEW]
- **10% wider default** [NEW]
- **Workspace button** — Returns to dashboard [v1]
- **Sources section** — List with checkboxes + type icons [v1]
- **Add Source / Remove buttons** [v1]
- **Views** — Dashboard, Search & Discovery, Memories, Trees (gated), People Manager [REWORKED — Trees etc. are new]
- **Tools** — Date Editor (gated) [NEW]
- **Guidance** — Quick Tour, Getting Started, Best Practices, What Happens Next [v1]
- **App** — Settings, About PDR, Help & Support [v1]
- **Hover highlighting + active state** [v1]

## 32. Independent Child Windows [NEW SECTION]

- **People Manager runs as separate window** — survives main window close [NEW]
- **Date Editor runs as separate window** — *(gated in v2.0.0)* [NEW, gated]
- **Photo Viewer runs as separate window** — for image preview [NEW]
- **Cross-window theme synchronisation** — Dark mode toggle in the main window propagates to all open child windows [NEW]
- **Cross-window data invalidation** — Mutations in People Manager invalidate caches in main / Search panel [NEW]

## 33. Animations & Visual Polish

- **Page entrance animations** — Fade + slide-up, staggered timing [v1]
- **Card hover effects** — Lift, scale, border, shadow [v1]
- **Icon hover effects** — Scale + rotate [v1]
- **Button hover effects** [v1]
- **Modal entrance / exit** — Backdrop fade, scale, opacity [v1]
- **Spring physics** on License Required modal [v1]
- **Smooth CSS transitions** — 200-500 ms [v1]
- **Spinner animation** [v1]
- **Progress bar animation** [v1]
- **Accordion animation** [v1]
- **Gradient hover overlays** [v1]
- **Arrow reveal on card hover** [v1]
- **Lavender outline-pulse** keyframe — used by Add Source CTA + first-source attention pulse [NEW]
- **Amber outline-pulse** keyframe — used by the "Already added" sidebar highlight (caution palette) [NEW]
- **Comet trail on Trees creation** [NEW, gated]
- **Card-perimeter lap** on Trees [NEW, gated]

## 34. Notifications & Feedback

- **Toast messages** via Sonner — top-center, rich colours, close button, expand [REWORKED — moved from bottom-right to top-center for better visibility]
- **Completion sound** — `pdr_success_bell.wav` via PowerShell MediaPlayer [v1]
- **Taskbar flash** for long-operation completion [v1]
- **Info message dialogs** — System-level alerts [v1]
- **Sonner toast action buttons** — toast.error('...', { action: { label: 'Send report', onClick: ... }}) used by the analysis-error capture [NEW]
- **Cross-window toast forwarder** — `ToastListener` re-emits toasts from main process to the active renderer regardless of which window is focused [NEW]

## 35. Keyboard & Accessibility

- **Tab navigation** [v1]
- **Space / Enter activation** [v1]
- **Shift+Click range selection** [v1]
- **Escape to close modals** [v1]
- **ARIA labels** [v1]
- **Focus indicators** [v1]
- **Semantic HTML** [v1]
- **Alt+Arrow / browser back/forward blocked** — Prevents native history navigation in the BrowserWindow which would otherwise leave PDR in an unrecoverable state [NEW]

## 36. Progress & Cancellation

- **Analysis progress** — current file, phase, percentage [v1]
- **Copy progress** — file count + elapsed time [v1]
- **Pre-scan progress** [v1]
- **Extraction progress** [v1]
- **Cancel any operation** [v1]
- **Cancel confirmation dialog** [v1]
- **Elapsed time display** [v1]
- **Streaming diagnostic events** — Phase markers, periodic memory snapshots, per-large-file timings, skip-and-continue warnings, final summary; surfaced in DevTools console during release-testing [NEW]
- **Network-staging phase indicator** — When destination is on a network drive, progress label switches to "Staging locally" → "Mirroring to network" so user understands the pause at 100% [NEW]

## 37. Window & System Integration

- **Custom window** — 1280×800 default, 1100×700 minimum, hidden title bar [v1]
- **Custom app icon** [v1]
- **Open in Explorer** [v1]
- **Open external links** [v1]
- **Graceful shutdown** — Cancels operations + cleans temp files [v1]
- **Single-instance lock** — Only one PDR per machine; second-launch focuses the existing window. Eliminates the SQLite-lock race that produced "Tree empty / sources missing" symptoms when two instances ran [NEW]
- **DevTools gated to dev-only** — F12 / Ctrl+Shift+I do nothing in the packaged production build [NEW]
- **Activate-on-second-launch** — When user double-clicks the icon while PDR is running, second instance focuses the existing main window [NEW]

## 38. Installer & Distribution

- **NSIS installer** — Custom install directory selection [v1]
- **Per-user installation** — No admin required by default [v1]
- **Code signing** — Sectigo EV cert ("Photo Date Rescue Ltd"), DigiCert SHA-256 timestamp [REWORKED — same EV cert, now also writes publisher CN consistently for auto-update verification]
- **Bundled dependencies** — ExifTool, UnRAR.exe, FFmpeg, BlazeFace / FaceMesh / FaceRes models, success sound, logo [REWORKED — added AI models + FFmpeg]
- **App ID** — `com.photodaterescue.app` [v1]
- **Differential-update support** — `.blockmap` published alongside the installer; future releases install only the changed bytes [NEW]
- **Cloudflare R2 + Worker distribution** — `updates.photodaterescue.com` serves the installer + manifest, gated behind a custom domain on the Cloudflare zone [NEW]
- **release/ auto-clean** — Build pipeline wipes `release/` before each electron-builder run; no stale artefacts ever ship [NEW]

## 39. Data Persistence

- **Settings store** via electron-store [v1]
- **License cache** with timestamp + offline grace [v1]
- **Report archive** — JSON files in `userData/fix-reports/` [v1]
- **Search index** — SQLite database in `userData/search-index.sqlite` [NEW]
- **AI cache** — Person clusters, face vectors, tags persisted across sessions [NEW]
- **Trees database** — Family relationships persisted [NEW, gated]
- **Startup DB backup** — Search/Trees/People databases are backed up on every launch in case the next session corrupts them [NEW]
- **Temporary extraction** — Now in `<destination-drive>/PDR_Temp/` (was: `%TEMP%/PDR_Temp/`) with per-source cleanup [REWORKED]
- **localStorage items** — Dark mode, zoom level, tour completion, welcome-skip, report-deletion flag, sidebar widths, panel collapsed states, AI re-analyze cache flags, Library Planner answers [REWORKED — substantially expanded]

---

## Appendix: Features in the codebase but gated off in the v2.0.0 release build

These features are fully implemented in code and reachable in development builds, but are hidden from end users in the v2.0.0 release via `VITE_PDR_RELEASE_GATE=release`. The sidebar entries render greyed out with a "Released shortly" tooltip. Lifting the gate is a one-line flip in the production build script when the features are deemed ready.

### Trees
- Family-tree visualisation with relationships, partner suggestions, royal-chart card style
- AI-assisted partner / parent / child detection from face clusters + co-occurrence in photos
- Manage Trees modal with named view presets, PNG/PDF export, time-based history
- Drag-to-pan canvas with focus + steps/generations view modes
- Placeholder persons + sibling-kind dialog for unknowns
- Linked-photos count per person card
- Cross-tree namesake guard + per-tree exclusion lists

### Edit Dates
- Date-strip click → manual date editor surface
- Date Editor (standalone window) with context-aware suggestions

These will ship in the v2.x sequence alongside polish work documented in the v2.0.0 release notes as "Released shortly."

---

*Generated from a full codebase audit of Photo Date Rescue Desktop v2.0.0. May 2026.*
