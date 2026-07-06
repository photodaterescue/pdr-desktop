// Companion Phase A — the curated answer corpus for the in-app "Ask PDR" smart help search.
//
// v3.1 (Terry) — Phase A of the offline AI Companion. This is a hand-authored knowledge base
// distilled FROM PDR's own in-app help (Help & Support, Getting Started, Best Practices), so the
// search only ever surfaces REAL, accurate answers — it can't invent anything. Each entry links to
// the live help section it came from, so "Take me there" opens the full context.
//
// The search "brain" over this corpus lives in companion-search.ts. It starts as a fast lexical +
// synonym matcher (ships instantly, no download); a neural embedding re-rank can drop in behind the
// SAME interface later (Phase A.2) without touching this corpus or the UI.
//
// WHEN EDITING: keep answers short + plain-English (2–4 sentences), and load `keywords` with the
// words REAL users type (synonyms, phrasings) — keywords drive retrieval quality. Never reference the
// retired "Date Editor" — it is "Needs Dates" (see reference_surface_names).
//
// ⛔ PRICING — READ THIS. PDR HAS SUBSCRIPTIONS: Monthly AND Yearly, PLUS a one-off Lifetime licence.
// NEVER write "no subscription" / "not a subscription" / "subscription-free" / "one-off only" anywhere.
// The honest positioning vs cloud apps is CHOICE (sub OR Lifetime) + "your library stays yours even if
// you stop paying" — NOT "no subscription". (Terry, hard rule; see feedback_pricing_model_dual.)

export type CompanionPanel = 'help-support' | 'getting-started' | 'best-practices';

export interface CompanionEntry {
  id: string;
  /** The question / topic title (shown as the answer-card heading). */
  q: string;
  /** The answer, plain-language. This IS the answer the user reads. */
  a: string;
  /** Words + phrasings real users type. Drives retrieval — load it generously. */
  keywords: string[];
  /** Which help panel this answer's fuller context lives in. */
  panel: CompanionPanel;
  /** The section id inside that panel to scroll to ("Take me there"). */
  section: string;
}

export const COMPANION_PANEL_LABEL: Record<CompanionPanel, string> = {
  'help-support': 'Help & Support',
  'getting-started': 'Getting Started',
  'best-practices': 'Best Practices',
};

// Synonym GROUPS — a query word that matches any word in a group is expanded to the whole group,
// so "pictures" finds entries keyworded "photos", "get in" finds "add", etc. Keep groups tight
// (only truly interchangeable-in-PDR words) so retrieval doesn't get muddy.
export const COMPANION_SYNONYMS: string[][] = [
  ['photo', 'photos', 'pic', 'pics', 'picture', 'pictures', 'image', 'images', 'snap', 'snaps'],
  ['add', 'import', 'bring', 'load', 'insert', 'ingest'],
  ['get', 'getting', 'put', 'pull'],
  ['source', 'sources', 'folder', 'folders', 'zip', 'archive', 'rar', 'takeout'],
  ['fix', 'fixing', 'run', 'process', 'scan', 'rescue', 'repair', 'sort'],
  ['date', 'dates', 'dated', 'dating', 'timestamp', 'timestamps', 'taken'],
  ['undated', 'marked', 'mk', 'unknown', 'missing'],
  ['library', 'destination', 'storage', 'disk'],
  ['drive', 'drives', 'ssd', 'hdd', 'usb'],
  ['collage', 'collages'],
  ['carousel', 'carousels', 'instagram', 'insta', 'slides', 'slide', 'swipe'],
  ['share', 'send', 'sending', 'export', 'exporting', 'out', 'transfer', 'off'],
  ['phone', 'mobile', 'iphone', 'android', 'cell'],
  ['print', 'printer', 'printing', 'pdf'],
  ['people', 'person', 'face', 'faces', 'facial', 'recognition', 'recognise', 'recognize', 'recognising'],
  ['tree', 'trees', 'family', 'genealogy', 'ancestry', 'relative', 'relatives', 'relations'],
  ['video', 'videos', 'clip', 'clips', 'movie', 'footage'],
  ['enhance', 'enhanced', 'brighten', 'restore', 'retouch', 'retouching'],
  ['backup', 'backups', 'snapshot', 'snapshots', 'safety'],
  ['private', 'privacy', 'cloud', 'online', 'internet', 'upload', 'secure', 'security', 'offline'],
  ['reinstall', 'reinstalled', 'reinstalling', 'reinstallation', 'migrate', 'migrating', 'moving'],
  ['duplicate', 'duplicates', 'dupe', 'dupes', 'copies', 'identical'],
  ['search', 'find', 'finding', 'discover', 'discovery', 'locate', 'filter', 'filters'],
  ['memories', 'timeline', 'memory'],
  ['album', 'albums'],
  ['confidence', 'confident', 'confirmed', 'recovered'],
  ['screenshot', 'screengrab'],
  ['record', 'recording'],
  ['capture', 'screen'],
  ['png', 'lossless', 'quality'],
  ['jpg', 'jpeg', 'lossy'],
  ['delete', 'remove', 'recycle', 'trash', 'bin'],
];

export const COMPANION_CORPUS: CompanionEntry[] = [
  // ── Getting photos in / the core Fix flow ─────────────────────────────────────────────
  {
    id: 'get-photos-in',
    q: 'How do I get my photos into PDR?',
    a: 'Add them as a Source. Click Add Source and point PDR at a folder, a ZIP (like a Google Takeout), a RAR archive, or a whole drive of photos. You can add several Sources at once, then run Fix to bring them into your library.',
    keywords: ['get photos in', 'add photos', 'import photos', 'bring in', 'load photos', 'where do i start', 'how do i begin', 'start', 'add source', 'get started', 'first time'],
    panel: 'getting-started', section: 'gs-first-fix',
  },
  {
    id: 'first-fix',
    q: 'How do I do my first fix?',
    a: 'Five steps: 1) pick your Library Drive (where fixed photos will live), 2) Add a Source, 3) tick the checkbox on the source you want, 4) review the analysis, 5) press Run Fix. PDR dates every photo and files it year-by-year on your Library Drive.',
    keywords: ['first fix', 'getting started', 'how do i start', 'begin', 'walkthrough', 'steps', 'setup', 'new user', 'quick start'],
    panel: 'getting-started', section: 'gs-first-fix',
  },
  {
    id: 'run-fix',
    q: 'What does Run Fix actually do?',
    a: 'It is one processing pass. PDR analyses every file across all your Sources, works out the correct date, then copies each file to your Library Drive with the corrected date written into the EXIF, the filename, and a clean year-by-year folder. Your originals are never touched.',
    keywords: ['run fix', 'what does fix do', 'process', 'what happens when i fix', 'rescue', 'sort my photos'],
    panel: 'getting-started', section: 'gs-first-fix',
  },
  {
    id: 'after-fix',
    q: 'What happens after I run Fix?',
    a: 'PDR shows you exactly what happened — how many photos were Confirmed, Recovered or Marked — and files everything on your Library Drive. Your photos then appear in Memories, become searchable in Search & Discovery, and face recognition catches up shortly after.',
    keywords: ['after fix', 'what happens next', 'done', 'finished', 'results', 'where did my photos go'],
    panel: 'getting-started', section: 'gs-after',
  },
  {
    id: 'source-types',
    q: 'What can I add as a Source?',
    a: 'Four kinds: Folders, small ZIP files, one large ZIP or RAR at a time (like a full Google Takeout up to ~50GB), and whole drives. You can mix folders, drives and small archives in the same Fix — only a second LARGE zip needs to wait for the first to finish.',
    keywords: ['source types', 'what can i add', 'folder', 'zip', 'rar', 'takeout', 'google photos', 'what sources', 'kinds of source'],
    panel: 'best-practices', section: 'bp-source-types',
  },
  {
    id: 'large-zip',
    q: 'Why only one large ZIP at a time?',
    a: 'A large ZIP (like a full Google Takeout, up to ~50GB) has to be unpacked into a temporary workspace before PDR can read each photo. PDR limits that to one at a time so a partial extraction can never fill your drive. Folders, drives and small archives can still be added alongside it.',
    keywords: ['one large zip', 'why one zip', 'takeout', 'big zip', 'second zip', 'multiple zips', '50gb'],
    panel: 'help-support', section: 'glossary',
  },

  // ── Library Drive ─────────────────────────────────────────────────────────────────────
  {
    id: 'library-drive',
    q: 'What is the Library Drive and where do my fixed photos go?',
    a: 'The Library Drive is the drive your organised photos and videos live on — you pick it once during setup. Every fixed photo is copied there, dated and filed in clean year-by-year folders. Your original files are left exactly as they were.',
    keywords: ['library drive', 'where do photos go', 'destination', 'where are my photos saved', 'output location', 'storage'],
    panel: 'best-practices', section: 'bp-library-drive',
  },
  {
    id: 'pick-drive',
    q: 'Which drive should I choose for my library?',
    a: 'The Library Drive Advisor rates each connected drive on speed, capacity and reliability so you can choose confidently. An internal drive connected to the motherboard is usually the fastest pick. The Library Planner also estimates how much room your collection will need.',
    keywords: ['which drive', 'best drive', 'choose drive', 'pick drive', 'external drive', 'ssd or hdd', 'advisor'],
    panel: 'best-practices', section: 'bp-library-drive',
  },

  // ── Confidence + Marked + Needs Dates ────────────────────────────────────────────────
  {
    id: 'confidence',
    q: 'What do Confirmed, Recovered and Marked mean?',
    a: 'They are PDR\'s confidence labels. Confirmed = the date came straight from trustworthy metadata (EXIF or a Takeout sidecar). Recovered = worked out from reliable signals like filename patterns. Marked = no usable date was found, so a safe fallback was applied and the file is set aside for you to date.',
    keywords: ['confirmed', 'recovered', 'marked', 'confidence', 'labels', 'what do the labels mean', 'colours', 'confidence level'],
    panel: 'help-support', section: 'understanding-results',
  },
  {
    id: 'marked-why',
    q: 'Why are some photos Marked?',
    a: 'Because no reliable date survived export or transfer, so PDR won\'t pretend to be certain. Marked files get a "_MK" in their name. Open Memories → Needs Dates to set the real date when you know it — one at a time or in bulk.',
    keywords: ['why marked', 'marked photos', '_mk', 'no date', 'undated', 'unknown date', 'set date'],
    panel: 'help-support', section: 'faq',
  },
  {
    id: 'needs-dates',
    q: 'How do I set dates for undated (Marked) photos?',
    a: 'Go to Memories → Needs Dates. There you can set the correct date for any Marked photo — individually, or select several and set them in bulk. Once dated, they slot into your timeline like everything else.',
    keywords: ['needs dates', 'set date', 'fix date', 'change date', 'undated', 'marked', 'edit date', 'add date', 'correct date', 'wrong date'],
    panel: 'help-support', section: 'faq',
  },

  // ── Filenames + output format ────────────────────────────────────────────────────────
  {
    id: 'suffixes',
    q: 'What do the filename codes mean (_CF, _RC, _MK, _E, _T, _CO, _CW, _SS, _SR)?',
    a: 'PDR adds a short code to every file. _CF = Confirmed date, _RC = Recovered date, _MK = Marked (needs a date). _E = an Enhanced copy, _T = a Trimmed video clip. _CO = a saved Collage, _CW = a Carousel design. _SS = a screenshot, _SR = a screen recording.',
    keywords: ['filename codes', 'suffix', 'suffixes', '_cf', '_rc', '_mk', '_e', '_t', '_co', '_cw', '_ss', '_sr', 'what does cf mean', 'letters in filename', 'naming'],
    panel: 'best-practices', section: 'bp-filenames',
  },
  {
    id: 'output-format',
    q: 'Should I choose JPG or PNG (Full Quality)?',
    a: 'JPG is the universal format — small files, quality 92, virtually indistinguishable from the original. PNG (labelled "Full Quality") preserves every pixel exactly but files are 2.5–3× larger and slower to write. Pick JPG for everyday use; PNG for photos you\'ll edit, print or archive long-term. Or keep originals untouched.',
    keywords: ['jpg or png', 'output format', 'file format', 'full quality', 'lossless', 'which format', 'best format', 'keep originals'],
    panel: 'best-practices', section: 'bp-output-format',
  },

  // ── Safety / privacy / originals ─────────────────────────────────────────────────────
  {
    id: 'originals-safe',
    q: 'Are my source photos safe — will PDR change, move or delete them?',
    a: 'Your source files are completely safe. PDR only ever READS your originals and writes fresh, dated copies to the Library Drive you choose — it never edits, renames, moves or deletes anything in your source folders, ZIPs or drives. Afterwards you can keep or delete your sources yourself; PDR won’t have touched them.',
    keywords: ['are my source photos safe', 'source photos safe', 'source files safe', 'are my originals safe', 'original photos safe', 'is my data safe', 'damage', 'safe', 'overwrite', 'change originals', 'delete my photos', 'move my photos', 'ruin', 'break my photos', 'modify', 'lose photos', 'risk'],
    panel: 'help-support', section: 'faq',
  },
  {
    id: 'privacy',
    q: 'Is PDR private? Does it upload my photos anywhere?',
    a: 'Everything runs entirely on your own machine — no cloud, no upload, no account. Your photos stay on your hardware (Security), nothing is shared (Privacy), and the library is yours forever (Ownership). It works fully offline.',
    keywords: ['private', 'privacy', 'cloud', 'upload', 'internet', 'offline', 'secure', 'safe', 'account', 'does it need internet', 'send my photos'],
    panel: 'help-support', section: 'start-here',
  },
  {
    id: 'duplicates',
    q: 'How does PDR handle duplicate photos?',
    a: 'PDR detects files that are identical in content (by a content hash, not by name or date) and safely skips the extras, so you won\'t get two copies of the same photo. It keeps the best version; the rest are left out of the output rather than deleted.',
    keywords: ['duplicates', 'dupes', 'copies', 'identical', 'same photo twice', 'remove duplicates', 'deduplicate'],
    panel: 'help-support', section: 'faq',
  },
  {
    id: 'stop-fix',
    q: 'Can I stop a Fix once it has started?',
    a: 'Yes. Any output produced so far stays safe and usable, and the completed work is recorded in Reports History. You can pick up where you left off.',
    keywords: ['stop fix', 'cancel', 'pause', 'abort', 'interrupt', 'quit mid fix'],
    panel: 'help-support', section: 'faq',
  },
  {
    id: 'run-again',
    q: 'What if I run Fix more than once?',
    a: 'Each run produces its own output and its own report — nothing is merged or overwritten automatically. That keeps every run traceable in Reports History.',
    keywords: ['run again', 'run twice', 'multiple runs', 'run fix again', 'redo', 'rerun'],
    panel: 'help-support', section: 'faq',
  },

  // ── Reports / Memories / Search / Albums ─────────────────────────────────────────────
  {
    id: 'reports',
    q: 'What are Reports and Reports History?',
    a: 'Reports History is an audit trail of every Fix you\'ve run — reopenable, exportable to CSV or TXT, and comparable across runs. Each report is a snapshot of that specific run, so it doesn\'t change when you add more files later.',
    keywords: ['reports', 'reports history', 'audit', 'log', 'csv', 'export report', 'what did fix do', 'history'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'memories',
    q: 'What is Memories?',
    a: 'Memories is a timeline view of your library by date — your fixed photos rediscovered, year by year, with an "On This Day" view. It also holds Albums and the Needs Dates view for setting dates on Marked photos.',
    keywords: ['memories', 'timeline', 'by date', 'on this day', 'browse photos', 'view photos'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'search-discovery',
    q: 'How do I find a specific photo?',
    a: 'Use Search & Discovery — PDR\'s full-text and faceted search. Find any file by year, person, place, camera, lens, focal length, aperture, file type, or any combination of those.',
    keywords: ['find a photo', 'search', 'search and discovery', 'discover', 'filter photos', 'look for', 'locate photo', 'where is my photo'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'albums',
    q: 'What are Albums?',
    a: 'Albums are curated groupings inside Memories. You can move or copy photos into albums, and PDR files your saved collages and carousels into the PDR Collages album automatically.',
    keywords: ['albums', 'album', 'group photos', 'organise photos', 'collections'],
    panel: 'help-support', section: 'glossary',
  },

  // ── People + Trees ───────────────────────────────────────────────────────────────────
  {
    id: 'people-manager',
    q: 'How does face recognition work?',
    a: 'PDR groups similar faces into clusters. In People Manager you verify a cluster to turn it into a named Person; those verified faces are then the ground truth PDR uses to find every other photo of them. Improve Recognition re-runs matching with the latest algorithm.',
    keywords: ['face recognition', 'people manager', 'faces', 'recognise faces', 'name people', 'who is in my photos', 'tag people', 'clusters'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'improve-recognition',
    q: 'What does Improve Recognition do?',
    a: 'It re-runs face matching with PDR\'s latest algorithm and retroactively cleans up older auto-matches — adding new correct matches AND dropping bogus ones in a single pass.',
    keywords: ['improve recognition', 'better face matching', 'redo faces', 'clean up faces', 'wrong face matches'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'trees',
    q: 'How do I build a family tree?',
    a: 'Open Trees, add or pick the people, and connect them with relationships (parent, spouse, sibling). Once you\'ve verified faces to those people in People Manager, each tree node automatically attaches the right photos.',
    keywords: ['family tree', 'trees', 'build tree', 'genealogy', 'relatives', 'add people to tree', 'relationships', 'ancestry'],
    panel: 'help-support', section: 'glossary',
  },

  // ── Collages + Carousels ─────────────────────────────────────────────────────────────
  {
    id: 'collage-project-vs-save',
    q: 'What is the difference between a collage project and saving a collage?',
    a: 'A collage project is your editable design — it auto-saves as you work and lives under "Your Collage Projects" so you can reopen it any time. Saving turns that design into a finished JPG in your library (Memories → Albums → PDR Collages). The project and the saved photo are two separate things.',
    keywords: ['collage project', 'save collage', 'project vs save', 'editable collage', 'reopen collage', 'work on later', 'difference'],
    panel: 'best-practices', section: 'bp-collages',
  },
  {
    id: 'where-collages-go',
    q: 'Where do my collages go when I save one?',
    a: 'Into your library as a normal photo — Memories → Albums → PDR Collages → the album you chose — so you can view, share and print it like any other. The editable design also stays under "Your Collage Projects" so you can reopen and tweak it.',
    keywords: ['where do collages go', 'saved collage location', 'where is my collage', 'collage album', 'pdr collages'],
    panel: 'help-support', section: 'faq',
  },
  {
    id: 'update-vs-version',
    q: 'What is the difference between Update and Save as new collage?',
    a: 'After you have saved once, the button becomes Update — one click re-saves over the same library photo, so you never pile up duplicates. The chevron beside it offers Save as new collage, which keeps the existing photo and files a separate copy — handy when you want to keep both the old and new look.',
    keywords: ['update vs new', 'save as new collage', 'update collage', 'overwrite collage', 'duplicate collage', 'save a copy', 'keep both versions'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'carousel',
    q: 'How do I make an Instagram carousel?',
    a: 'On the Collages start screen choose IG Carousel. You build the pages side by side on one wide canvas; add pages with the + in the page filmstrip. When you save, PDR slices it into numbered slides (slide_01, slide_02…) so you can drag them into Instagram in order.',
    keywords: ['carousel', 'instagram carousel', 'multi page collage', 'slides', 'swipeable', 'insta post', 'add page', 'pages'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'collage-add-photo',
    q: 'How do I add more photos to a collage or carousel?',
    a: 'Use Add Photos in the collage editor and pick from your library. In a carousel the new photo lands on the page you are currently viewing — it does not create a new page (use the + in the page strip below for that). Then drag it wherever you want on the page.',
    keywords: ['add photo to collage', 'add photo to carousel', 'put photo in carousel', 'add more photos', 'insert photo collage', 'another photo collage', 'add picture to carousel', 'add to a page'],
    panel: 'best-practices', section: 'bp-collages',
  },

  // ── Sharing + capture ────────────────────────────────────────────────────────────────
  {
    id: 'share',
    q: 'How do I get a photo out of PDR to share it?',
    a: 'Several ways, all local: drag one or more photos straight into another app or a folder; Send to Phone shows a Wi-Fi QR code to scan; Print goes to a printer or a PDF; and Copy puts it on the clipboard. Nothing routes through the cloud.',
    keywords: ['share photo', 'get photo out', 'export photo', 'send photo', 'save to desktop', 'copy photo', 'drag out', 'how to share'],
    panel: 'help-support', section: 'faq',
  },
  {
    id: 'send-to-phone',
    q: 'How do I send photos to my phone?',
    a: 'Use Send to Phone. It shows a QR code that you scan with a phone on the same Wi-Fi, and the selected photos transfer straight across — no cable, no cloud, no account.',
    keywords: ['send to phone', 'phone', 'mobile', 'transfer to phone', 'qr code', 'wifi', 'get photos on my phone', 'airdrop'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'print',
    q: 'How do I print a photo?',
    a: 'Use Print — it sends a photo to a local or network printer, or saves a print-ready PDF.',
    keywords: ['print', 'printer', 'print photo', 'pdf', 'print to pdf', 'hard copy'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'screen-capture',
    q: 'How do I take a screenshot or screen recording?',
    a: 'Use Screen Capture — the camera icon in the title bar, or Ctrl+Shift+S. Screenshots (_SS) and recordings (_SR) are filed straight into your library in Memories, dated the moment they were taken.',
    keywords: ['screenshot', 'screen recording', 'record screen', 'capture', 'grab screen', 'video of my screen', 'ctrl shift s'],
    panel: 'help-support', section: 'glossary',
  },

  // ── Enhance + video ──────────────────────────────────────────────────────────────────
  {
    id: 'enhance',
    q: 'How do I enhance or edit a photo?',
    a: 'Open a photo in the Viewer and use the Enhance panel — brightness, contrast, saturation, temperature or B&W, plus AI restoration. It saves a fresh copy (named with _E) and leaves your original untouched.',
    keywords: ['enhance', 'edit photo', 'brighten', 'improve photo', 'restore', 'retouch', 'adjust', 'ai enhance', 'fix up photo', 'colour'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'trim-video',
    q: 'How do I cut a clip from a video to send or share?',
    a: 'Open the video in the Viewer and use the Trim panel to cut out a shorter segment, then Save clip — it writes a new clip (named _T) next to the original, keeping its date. That clip is a normal library file, so you can drag it out, Send to Phone, or Copy it to share, without touching the full video.',
    keywords: ['trim video', 'cut a clip', 'clip a video', 'cut clips from videos', 'cut a clip to send', 'make a clip to share', 'shorten a video to send', 'shorten video', 'clip', 'edit video', 'video segment', 'snip a video'],
    panel: 'help-support', section: 'glossary',
  },

  // ── Multi-device / reinstall / backup ────────────────────────────────────────────────
  {
    id: 'reinstall',
    q: 'Will I lose my work if I reinstall PDR or move to a new PC?',
    a: 'No. A hidden Library Database on your Library Drive holds everything PDR knows — face tags, names, Trees, date corrections, search indexes. Connect that drive to a fresh install or a new PC and it picks up exactly where you left off.',
    keywords: ['reinstall', 'new pc', 'new computer', 'lose my work', 'move to another machine', 'transfer library', 'restore after reinstall', 'library database'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'multi-device',
    q: 'Can I use my library on more than one computer?',
    a: 'Yes. Because the Library Database travels on your Library Drive, another PC can connect and read it. Only one device at a time holds "writer" status (to prevent conflicts); others are read-only until you hand writer status over, confirmed with your license key.',
    keywords: ['two computers', 'multiple devices', 'another pc', 'writer', 'reader', 'shared library', 'second machine'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'backup',
    q: 'Does PDR back up my work? What is a Snapshot?',
    a: 'A Snapshot is a point-in-time backup of your PDR database. PDR takes them automatically — before every launch, daily, weekly, and before risky operations. Find them under Settings → Backup; you can roll back to any of them.',
    keywords: ['backup', 'snapshot', 'restore', 'undo', 'roll back', 'safety net', 'lost my tags', 'recover'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'parallel-libraries',
    q: 'What are Parallel Libraries?',
    a: 'Curated sub-libraries spun off your Master — say Family-only or Pets-only — built from filtered Search & Discovery queries so you don\'t sort by hand. Each lives on a drive of your choice and can be given away or backed up independently, while PDR still shows everything unified in its views.',
    keywords: ['parallel libraries', 'sub library', 'family only', 'split library', 'separate library', 'give away photos'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'two-drives',
    q: 'What happens if my libraries are on more than one drive?',
    a: 'Everything stays unified — Search, Memories, Trees and People Manager show photos from every library regardless of which drive each lives on. Two things to know: to OPEN a full-size photo its drive must be connected (thumbnails stay visible offline), and face analysis catches up a little after each Fix.',
    keywords: ['multiple drives', 'more than one drive', 'photos on different drives', 'drive not connected', 'offline photos', 'thumbnails'],
    panel: 'help-support', section: 'faq',
  },

  // ── Support ──────────────────────────────────────────────────────────────────────────
  {
    id: 'contact-support',
    q: 'How do I contact support or report a problem?',
    a: 'For setup or how-to questions, the Guides and this help answer most things fastest. Contact support if the app won\'t launch, a Fix crashes, or a license issue blocks you — use "Report a problem" (it pre-fills your system info and log) or the web contact form.',
    keywords: ['contact support', 'report a problem', 'help', 'email support', 'bug', 'crash', 'not working', 'stuck', 'broken', 'license issue'],
    panel: 'help-support', section: 'contact-support',
  },
  {
    id: 'large-libraries',
    q: 'Can PDR handle very large libraries?',
    a: 'Yes — it\'s designed for scale. The reports and interface stay responsive even on very large runs, and large ZIPs are unpacked one at a time so a big job can\'t overwhelm your drive.',
    keywords: ['large library', 'lots of photos', 'thousands of photos', 'big collection', 'huge', 'performance', 'handle a lot'],
    panel: 'help-support', section: 'faq',
  },
  {
    id: 'cloud-safe',
    q: 'Is PDR safe to use with cloud backups like Google Photos or iCloud?',
    a: 'Yes, if you follow the Guides. Cloud services often strip or alter the date metadata on export, and the topic guides explain how to export correctly so PDR gets the best possible dates.',
    keywords: ['cloud backup', 'google photos', 'icloud', 'onedrive', 'dropbox', 'export from cloud', 'metadata stripped'],
    panel: 'help-support', section: 'guides-topic',
  },

  // ─────────────────────────────────────────────────────────────────────────────────────
  // v3.1 (Terry) — gap-audit content. How-tos the Companion was missing, verified against
  // the real UI labels (see the gap-audit artifact). Keep grounded: never describe a control
  // that isn't shipped (e.g. no People "merge" button, no built-in move-library tool).
  // ─────────────────────────────────────────────────────────────────────────────────────

  // ── Collages ──────────────────────────────────────────────────────────────────────────
  {
    id: 'make-collage',
    q: 'How do I make a collage?',
    a: 'Open Collages and pick a starting point on the welcome screen — Blank collage, one of the grid templates (Two side by side, Four grid, Six grid, Nine grid), or IG Carousel. Add pictures with Add photos in the bottom strip, drag them to arrange (or use the Arrange panel), then style them with the right-hand panels — Text, Background, Glow & shadow and more. It auto-saves as you work; press Save to file a finished JPG into your library.',
    keywords: ['make a collage', 'create a collage', 'start a collage', 'build a collage', 'new collage', 'how to make a collage', 'best way to make a collage', 'collage from scratch', 'design a collage', 'put photos together'],
    panel: 'best-practices', section: 'bp-collages',
  },
  {
    id: 'collage-text',
    q: 'How do I add text or a caption to a collage?',
    a: 'In the collage editor, open the Text section on the right and click Add text — then just start typing. Drag the text onto the collage, and double-click to edit it again. You can choose from around two dozen fonts (grouped System, Essentials, Fun, Premium and more), change the colour, and add effects like Outline, Shadow or Neon.',
    keywords: ['add text', 'text on collage', 'caption', 'write on collage', 'add words', 'title on collage', 'add a caption', 'lettering', 'change font'],
    panel: 'best-practices', section: 'bp-collages',
  },
  {
    id: 'collage-background',
    q: 'How do I change a collage background?',
    a: 'Click an empty part of the canvas, then open the Background section on the right. Under Base you pick a Solid colour or a Blended gradient; under Texture & Effects you can add a Glow circle or Blur circle on top. You can also set the background to a photo, or make it transparent for a see-through PNG export.',
    keywords: ['change background', 'collage background', 'background colour', 'background color', 'gradient background', 'background photo', 'transparent background', 'backdrop'],
    panel: 'best-practices', section: 'bp-collages',
  },
  {
    id: 'collage-effects',
    q: 'How do I add effects like glow, neon or a shadow to a collage photo?',
    a: 'Select the photo, then open the Glow & shadow section on the right. It has sliders for Glow, Drop shadow / 3D, Lift, Neon and Outline — each with its own colour swatch. There are also per-photo Blur and Pixelate sliders, plus whole-collage Vignette and Grain.',
    keywords: ['collage effects', 'glow', 'neon', 'drop shadow', 'shadow on photo', 'lift', 'outline', 'make photo pop', 'vignette', 'grain', 'blur a photo'],
    panel: 'best-practices', section: 'bp-collages',
  },
  {
    id: 'collage-crop',
    q: 'How do I crop a photo inside a collage?',
    a: 'Select the photo and drag the edge handles that appear on it — Crop left / right / top / bottom edge — to trim it within its frame. The corner handles resize the whole photo. You can also round the corners with the Curved corners slider, or soften them with Blend edges.',
    keywords: ['crop in collage', 'crop a photo', 'trim photo', 'resize photo in collage', 'cut down a photo', 'crop edges', 'rounded corners'],
    panel: 'best-practices', section: 'bp-collages',
  },
  {
    id: 'collage-template',
    q: 'How do I use a collage template?',
    a: 'A template is a ready-made layout, like a four- or nine-photo grid. On the Collages welcome screen, pick one — Two side by side, Four grid, Six grid or Nine grid — and it opens with empty frames; click or drag a photo into each frame to fill it. You can also save any design you like as a reusable template with Save as template.',
    keywords: ['template', 'templates', 'use a template', 'what is a template', 'collage layout', 'grid layout', 'preset collage', 'empty frames', 'four grid', 'nine grid'],
    panel: 'best-practices', section: 'bp-collages',
  },
  {
    id: 'collage-cutout',
    q: 'How do I cut out the subject / remove a photo’s background in a collage?',
    a: 'Select the photo and open the Background remover section on the right, then click Remove background — PDR cuts out the subject on your device and drops the background. The Cut-out strength slider fine-tunes the edges (right removes more, left keeps more). It’s also on the photo’s right-click menu, and Restore background undoes it.',
    keywords: ['remove background', 'cut out', 'cutout', 'cut out the person', 'remove the background', 'background remover', 'isolate subject', 'knockout background'],
    panel: 'best-practices', section: 'bp-collages',
  },
  {
    id: 'reopen-collage',
    q: 'How do I reopen and keep editing a saved collage?',
    a: 'Every collage auto-saves as an editable project. Open Collages and look under Your Collage Projects on the welcome screen — click a card to reopen it and carry on. The finished JPG you Save to your library is separate; the editable project always stays here.',
    keywords: ['reopen collage', 'reopen a saved collage', 'edit saved collage', 'open old collage', 'work on later', 'continue a collage', 'my collage projects'],
    panel: 'best-practices', section: 'bp-collages',
  },
  {
    id: 'export-collage',
    q: 'How do I get a finished collage out to share or post it?',
    a: 'Press Save in the collage editor — it files a finished JPG into your library at Memories → Albums → PDR Collages. From there you share it like any photo: drag it into another app, Send to Phone, Print, or Copy. (A carousel also exports numbered slides you can drag into Instagram in order.)',
    keywords: ['export collage', 'share collage', 'post collage', 'download collage', 'get collage out', 'save collage to share', 'put collage on instagram', 'send my collage'],
    panel: 'best-practices', section: 'bp-collages',
  },

  // ── Trees ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'build-tree',
    q: 'How do I add people and relationships to a family tree?',
    a: 'In Trees, right-click a person’s card to add someone connected to them — the chips add a parent, partner, child or sibling. You either pick an existing person or name a new one. For less common links (half-sibling, ex-partner and so on) use the Set relationship window. The tree redraws itself as you go.',
    keywords: ['build family tree', 'add people to tree', 'add a person to tree', 'add someone to tree', 'add someone to my family tree', 'add a family member', 'new person in tree', 'add relationship', 'parent', 'spouse', 'partner', 'sibling', 'connect people', 'family tree how to'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'tree-focus',
    q: 'How do I change who the family tree is focused on?',
    a: 'Click the “Focused on ‹name›” chip in the tree header and pick a new person from the search list — the tree re-centres around them. You can also double-click a card to bring that person to the middle.',
    keywords: ['change focus', 'tree focus', 'centre the tree', 'who the tree is about', 're-center tree', 'focus person', 'focus on someone else'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'tree-face',
    q: 'How do I give a tree person a photo when they have none?',
    a: 'Right-click their card and choose Set face from screenshot… (drag a box over a face on screen) or Set face from webcam… (snap one with your camera). Otherwise, verifying one of their face clusters in People Manager attaches their real photos automatically. “Remove this photo” reverts a manually-set one.',
    keywords: ['no photo in tree', 'add a photo to a person', 'add a face to a person', 'set face', 'tree person has no picture', 'empty tree node', 'tree picture missing', 'why no photo in tree', 'give someone a photo', 'screenshot face', 'webcam face', 'profile photo in tree'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'tree-collapse',
    q: 'My family tree is huge — how do I tidy or collapse it?',
    a: 'Use the collapse/expand button in the top-right of the canvas to fold or open all your bloodline branches at once, and the Steps and Generations pills to limit how many hops and how many ancestor/descendant levels show. You can also hide faces (right-click a card, or Trees Settings → Display) for a cleaner view.',
    keywords: ['tree too big', 'collapse tree', 'tidy tree', 'too many people in tree', 'simplify tree', 'hide branches', 'generations', 'declutter tree'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'tree-export',
    q: 'How do I save, print or share my family tree?',
    a: 'Open Trees Settings → Manage Trees and use Save as PNG to save the tree as an image, or Print / Save PDF to send it to a printer or save a PDF. That image or PDF is what you would share with relatives today (a full family-tree file export is planned for a later version).',
    keywords: ['save tree', 'print tree', 'export tree', 'tree as an image', 'tree pdf', 'png of tree', 'share family tree', 'give tree to relatives'],
    panel: 'help-support', section: 'glossary',
  },

  // ── People Manager ────────────────────────────────────────────────────────────────────
  {
    id: 'name-people',
    q: 'How do I name people and confirm who’s who?',
    a: 'Open People Manager. It groups similar faces into clusters; click a cluster, type the person’s name in the panel (or pick an existing one), and confirm the faces. Those verified faces become the ground truth PDR uses to find every other photo of that person.',
    keywords: ['name people', 'who is who', 'tag people', 'confirm faces', 'label faces', 'verify a cluster', 'name a person', 'identify people'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'merge-people',
    q: 'Two people are actually the same — how do I merge them?',
    a: 'There isn’t a one-click merge button. Instead, open the person you want to keep and reassign the other one’s faces to that same name — the faces move across and the duplicate empties out, which merges them in effect. Then run Improve Facial Recognition to tidy up.',
    keywords: ['merge people', 'same person twice', 'duplicate person', 'combine people', 'two of the same person', 'join people', 'merge faces'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'fix-wrong-face',
    q: 'A wrong face got attached to someone — how do I fix it?',
    a: 'In People Manager, select the face that’s wrong and reassign it to the correct person (type their name), or unlink it so it goes back to being unnamed. If a whole batch is wrong, drag the Match slider toward Strict and re-run Improve Facial Recognition.',
    keywords: ['wrong face', 'remove a face', 'fix a face', 'misidentified', 'wrong person', 'reassign face', 'face on the wrong person', 'unlink face'],
    panel: 'help-support', section: 'glossary',
  },

  // ── Memories / Albums / Search / Recycle / Dates ─────────────────────────────────────
  {
    id: 'create-album',
    q: 'How do I create an album and add photos to it?',
    a: 'Select some photos in Search & Discovery (or Memories), click Add to Album, and either pick an existing album or use Create new album to make one and add them in a step. To reorganise later, the Move or copy window lets you copy photos into another album or move them between albums.',
    keywords: ['create an album', 'make an album', 'new album', 'add to album', 'put photos in an album', 'organise into albums', 'group photos', 'move to album'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'find-person-place',
    q: 'How do I find all the photos of one person or one place?',
    a: 'Use Search & Discovery. Type a name in the search box (it suggests people as you type), or open the AI tab and pick the person; combine two names with a comma to find photos with both. For places, use the Location filter (country / city). You can also filter by camera, date, file type and more.',
    keywords: ['find photos of', 'photos of a person', 'find someone', 'photos of my mum', 'search for a person', 'search by place', 'photos taken in', 'find by location', 'all photos of'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'save-search',
    q: 'How do I save a search I use a lot?',
    a: 'Set up your filters in Search & Discovery, then click the Save (star) button on the right of the actions ribbon and give it a name. It appears in the Saved strip below the ribbon so you can re-run it in one click.',
    keywords: ['save a search', 'favourite search', 'saved search', 'bookmark a search', 'reuse filters', 'quick search', 'keep a search'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'delete-restore',
    q: 'How do I delete a photo — and get it back if I change my mind?',
    a: 'Deleting a photo sends it to PDR’s Recycle Bin (in the sidebar under Tools). Open it and use Restore to put a photo back where it was, or Delete permanently to remove it for good. Until you empty it, nothing is truly gone.',
    keywords: ['delete a photo', 'remove a photo', 'recycle bin', 'undo delete', 'get a photo back', 'restore photo', 'deleted by mistake', 'permanently delete', 'trash'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'no-date-info',
    q: 'What date does a photo with no date information get?',
    a: 'If PDR can’t find any reliable date, the file is Marked (its name gets _MK) rather than given a fake one. It waits for you in Memories → Needs Dates, where you set the real date when you know it. PDR never silently invents a date it isn’t sure of.',
    keywords: ['no date', 'no metadata', 'missing date', 'no exif', 'what date does it get', 'undated photo', 'no date found', 'how is the date chosen'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'undo-fix',
    q: 'Can I undo a Fix — and does it ever change my originals?',
    a: 'Your originals are never touched — a Fix only writes fresh copies to your Library Drive, so there is nothing to undo on the source. If you don’t want a run’s output, you can delete those copies (they go to the Recycle Bin); the report stays in Reports History either way.',
    keywords: ['undo a fix', 'revert a fix', 'take it back', 'does fix change my originals', 'delete a run', 'remove fixed photos', 'start over'],
    panel: 'help-support', section: 'faq',
  },

  // ── Sharing / capture / video ─────────────────────────────────────────────────────────
  {
    id: 'screen-record',
    q: 'How do I record my screen, with my voice?',
    a: 'Use Screen Capture (the camera icon in the title bar, or Ctrl+Shift+S) and choose to record. On the recorder bar you can turn on the microphone for a voiceover, and turn on auto-zoom so it zooms toward where you click. The finished recording (named _SR) is filed into your library.',
    keywords: ['record my screen', 'screen recording', 'record screen with voice', 'voiceover', 'narrate', 'microphone', 'make a video of my screen', 'capture a video', 'tutorial recording'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'capture-location',
    q: 'Where do my screenshots and screen recordings get saved?',
    a: 'Into your library under a PDR Captures folder (organised by month), and they appear in Memories like any photo — screenshots dated the moment they were taken. If your Library Drive is disconnected they wait in a pending folder and flush across automatically when it reconnects.',
    keywords: ['where do screenshots go', 'where recordings save', 'find my screenshots', 'capture folder', 'pdr captures', 'where are my recordings', 'saved screenshots'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'video-transcript',
    q: 'Can PDR transcribe what is said in a video?',
    a: 'Yes — right-click a video and choose Transcribe. PDR uses an on-device speech model (nothing is uploaded); a small model downloads the first time. Transcribed videos get a “T” badge and the Viewer shows the spoken words as subtitles. You can hide transcripts under Settings → Privacy & Security.',
    keywords: ['transcribe', 'transcript', 'transcripts for videos', 'video transcript', 'transcribe a video', 'captions', 'subtitles', 'what is said in a video', 'speech to text', 'video words', 'voice to text'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'blur-sensitive',
    q: 'How do I blur a face or a private detail?',
    a: 'While making a screen recording you can mark areas to blur, so sensitive information never appears in the video. In a collage, selecting a photo gives you a Pixelate slider to obscure part of it. There isn’t a one-click “blur this face” on a still photo in the Viewer yet.',
    keywords: ['blur a face', 'blur', 'hide a face', 'censor', 'pixelate', 'cover up', 'blur private info', 'redact', 'obscure'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'ai-enhance-models',
    q: 'What do the AI enhance options do, and do they download?',
    a: 'The Viewer’s Enhance panel has three AI tools, each an optional one-time download you opt into: CodeFormer restores blurry or damaged faces (~337MB), Real-ESRGAN upscales a whole photo 4× with more detail (~34MB), and Background remover cuts out the subject (~179MB). They run on your device — nothing is uploaded — with a progress bar while they download.',
    keywords: ['ai enhance', 'codeformer', 'real-esrgan', 'upscale', 'restore a face', 'enhance download', 'ai models', 'deblur', 'sharpen', 'fix a blurry photo', 'improve quality'],
    panel: 'help-support', section: 'glossary',
  },

  // ── Library / drives / backup ─────────────────────────────────────────────────────────
  {
    id: 'drive-space',
    q: 'How much drive space will my library need?',
    a: 'Before a Fix, the Library Planner estimates how much room your collection will need across several categories, so you can pick a big-enough Library Drive and not run out mid-job. The Library Drive Advisor also rates your connected drives on speed, capacity and reliability.',
    keywords: ['how much space', 'drive space', 'storage needed', 'disk space', 'how big a drive', 'capacity', 'room needed', 'library size', 'planner'],
    panel: 'best-practices', section: 'bp-library-drive',
  },
  {
    id: 'drive-disconnected',
    q: 'What happens if my Library Drive gets unplugged?',
    a: 'You can still browse — thumbnails stay visible from a local cache, so Memories, Search and Trees keep working. To OPEN a full-size photo, its drive needs to be connected. Any new screenshots or captures wait in a pending folder and copy across automatically when you plug the drive back in.',
    keywords: ['drive unplugged', 'drive disconnected', 'drive not connected', 'removed the drive', 'offline drive', 'usb unplugged', 'library not found', 'drive missing'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'move-library',
    q: 'How do I move my library to a new or bigger drive?',
    a: 'A built-in one-click “move library to another drive” tool isn’t available yet — it’s on the roadmap. Your library lives on the drive you chose at setup, and the hidden Library Database on that drive is what lets a new PC reconnect to it. If you need to change drives, please reach out through Help & Support so we can guide you safely.',
    keywords: ['move my library', 'change drive', 'new drive', 'bigger drive', 'transfer library', 'relocate library', 'move to another drive', 'migrate library'],
    panel: 'help-support', section: 'contact-support',
  },
  {
    id: 'backup-location',
    q: 'How do I back up my work, and where are the backups?',
    a: 'Go to Settings → Backup. PDR already takes automatic snapshots of its database — before every launch, daily, weekly, and before risky operations — and you can also Take a snapshot now and name it. Restore from snapshot rolls the database back to an earlier point. Snapshots cover your tags, names, trees and date corrections; your actual photo files are separate and are never altered.',
    keywords: ['back up', 'backup', 'snapshot', 'where are the backups', 'restore a backup', 'settings backup', 'safety copy', 'protect my work', 'recover my tags'],
    panel: 'help-support', section: 'glossary',
  },

  // ── Account / licence / formats / general ─────────────────────────────────────────────
  {
    id: 'trial-limits',
    q: 'What are the free trial limits, and what does a licence unlock?',
    a: 'The free trial lets you try everything with gentle caps — around 1000 files fixed, 12 named people, 10 video clips, 5 collages, 5 carousels, 20 screenshots and 5 recordings, on 1 device. A paid licence removes those caps and allows up to 3 devices. You can see your usage against the caps in the app.',
    keywords: ['free trial', 'trial limits', 'what do i get free', 'limits', 'caps', 'free version', 'what does the licence unlock', 'upgrade', 'free vs paid'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'pricing-model',
    q: 'Is PDR a subscription or a one-time purchase?',
    a: 'Both options exist: a Monthly or Yearly subscription, or a one-off Lifetime licence — whichever you prefer. Any paid plan removes the trial caps and works on up to 3 devices.',
    keywords: ['subscription', 'one-off', 'one time purchase', 'lifetime', 'monthly', 'yearly', 'pricing', 'cost', 'how much does it cost', 'buy', 'purchase'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'devices',
    q: 'How many devices can I use one licence on?',
    a: 'A paid licence works on up to 3 devices at once; the free trial is 1 device. If you hit the limit, open Manage Devices and remove an old device to free a slot for a new install.',
    keywords: ['how many devices', 'how many computers', 'multiple devices', 'device limit', 'another computer', 'install on two computers', 'manage devices', 'free a slot'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'heic',
    q: 'Does PDR handle iPhone (HEIC) photos?',
    a: 'Yes. PDR reads HEIC and HEIF — the iPhone photo format — and can convert them to JPG or PNG as part of a Fix. HEIC files can be a little slower to make thumbnails for, but they’re fully supported.',
    keywords: ['heic', 'iphone photos', 'heif', 'apple photos', 'iphone', 'convert heic', 'does it read heic', 'live photos'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'video-formats',
    q: 'Does PDR handle my videos (MOV and others)?',
    a: 'Yes — PDR indexes and dates videos like MOV and MP4 alongside your photos, and you can trim clips and transcribe their audio. Video isn’t re-encoded by the photo converter; it’s kept and organised as it is.',
    keywords: ['video formats', 'mov', 'mp4', 'does it handle video', 'convert video', 'video support', 'avi', 'iphone video'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'raw',
    q: 'Does PDR support RAW camera files?',
    a: 'Yes — RAW formats from most cameras are supported (CR2/CR3, NEF, ARW, DNG, ORF, RW2 and more). PDR reads them for dating and thumbnails, and can convert them to JPG or PNG on a Fix.',
    keywords: ['raw', 'raw files', 'cr2', 'nef', 'arw', 'dng', 'camera raw', 'dslr', 'does it read raw'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'update-pdr',
    q: 'How do I update PDR to the latest version?',
    a: 'You don’t have to do anything — PDR checks for updates in the background and downloads them automatically (usually just a few MB). When one is ready it offers to restart to apply it; otherwise it installs next time you close the app.',
    keywords: ['update', 'new version', 'upgrade the version', 'latest version', 'how do i update', 'auto update', 'download the update', 'is there an update'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'slow-frozen',
    q: 'PDR feels slow or froze — what should I do?',
    a: 'Heavy jobs (analysis, face recognition, big imports) run in the background and can make things feel busy for a moment — it usually catches up. If it stays stuck, close and reopen PDR; your work is safe (it auto-snapshots the database on every launch). If a problem persists, use Report a problem in Help & Support so we get your logs.',
    keywords: ['slow', 'frozen', 'stuck', 'not responding', 'hang', 'lag', 'crashing', 'busy', 'spinning', 'unresponsive'],
    panel: 'help-support', section: 'contact-support',
  },
  {
    id: 'system-requirements',
    q: 'What are PDR’s system requirements?',
    a: 'PDR is a Windows desktop app that runs entirely on your own computer — no cloud or account needed. It runs on a normal modern PC; the AI features (face recognition, enhancement) use your processor rather than a special graphics card, and go faster with more memory. For the exact minimums, see the website or Help & Support.',
    keywords: ['system requirements', 'specs', 'minimum requirements', 'what do i need to run it', 'ram', 'windows', 'hardware', 'will it run on my pc', 'requirements'],
    panel: 'help-support', section: 'contact-support',
  },

  // ─────────────────────────────────────────────────────────────────────────────────────
  // v3.1 round 591 (Terry) — batch two: the next likely band (reassurance / expectations /
  // "what's the difference"). Verified: AI/face detection can be turned off in Settings; fixed
  // photos file into chosen Year / Year-Month / Year-Month-Day folders. (originals-safe above
  // was also broadened to answer "are my source photos safe" cleanly.)
  // ─────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'where-fixed-photos-go',
    q: 'Where exactly does PDR put my fixed photos?',
    a: 'Every fixed photo is copied to the Library Drive you chose, into clean date folders — you pick the depth: Year, Year-Month, or Year-Month-Day. The corrected date is written into the file name and the EXIF too, so it sorts correctly anywhere.',
    keywords: ['where do fixed photos go', 'folder structure', 'what folders', 'how are photos organised', 'year folders', 'where are my photos saved', 'output folders', 'how does it organise'],
    panel: 'getting-started', section: 'gs-after',
  },
  {
    id: 'keeps-my-folders',
    q: 'Does PDR keep my folders, or reorganize everything by date?',
    a: 'Your original folders are left exactly as they are. In your new library, PDR files the copies by date (Year / Year-Month / Year-Month-Day) rather than mirroring your old folders — the whole point is a clean, consistent timeline. Your source structure is never changed.',
    keywords: ['keep my folders', 'reorganize', 'reorganise', 'will it move my folders', 'change my folders', 'keep my organization', 'mess up my folders', 'keep my folder structure'],
    panel: 'best-practices', section: 'bp-mental-model',
  },
  {
    id: 'photo-quality',
    q: 'Does PDR lower my photo quality when it fixes them?',
    a: 'If you choose Keep Originals, nothing about the picture changes at all. If you output JPG, it saves at quality 92 — virtually indistinguishable from the original. PNG (Full Quality) is lossless and keeps every pixel exactly. Either way, your source files stay untouched.',
    keywords: ['quality', 'lower quality', 'compress', 'recompress', 'lose quality', 'degrade', 'ruin quality', 'reduce quality', 'jpg quality'],
    panel: 'best-practices', section: 'bp-output-format',
  },
  {
    id: 'videos-included',
    q: 'Does PDR date and organize my videos too, not just photos?',
    a: 'Yes — videos are fixed and filed right alongside your photos, dated the same careful way, and they show up together in Memories and Search. You can also trim clips and transcribe their audio in the Viewer.',
    keywords: ['videos too', 'does it do videos', 'video organizing', 'date my videos', 'movies', 'video files', 'photos and videos', 'does it handle videos'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'fix-time',
    q: 'How long will a Fix take?',
    a: 'It depends on how many files there are and how fast your drives are. Reading the dates and copying is quick; a large Google Takeout has to be unpacked first, which adds time. Face and tag analysis then runs in the background afterwards, so your photos are searchable and in Memories almost right away while recognition catches up.',
    keywords: ['how long', 'how long does it take', 'fix time', 'duration', 'how fast', 'time to fix', 'takes ages', 'processing time'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'add-more-later',
    q: 'Can I add more photos or run another Fix later?',
    a: 'Absolutely — add Sources and run Fix as many times as you like. Each run adds its new photos to the same unified library and files its own report. Identical duplicates are skipped, so re-running over a folder you have already done will not make copies.',
    keywords: ['add more later', 'run again later', 'more photos later', 'another fix', 'add more folders', 'keep adding photos', 'fix more photos', 'add to my library'],
    panel: 'help-support', section: 'faq',
  },
  {
    id: 'disable-ai',
    q: 'Can I turn off face recognition or the AI features?',
    a: 'Yes — you can switch off face detection (and AI tagging) in Settings. Everything else — dating, organizing, search, albums — keeps working exactly the same; you just will not get automatic people/face grouping until you turn it back on.',
    keywords: ['turn off face recognition', 'disable ai', 'switch off faces', 'no ai', 'stop face detection', 'turn off ai', 'disable face recognition', 'opt out of ai'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'fix-finished',
    q: 'How do I know a Fix finished, and where is the summary?',
    a: 'When a run completes, PDR shows you the results — how many files were Confirmed, Recovered or Marked — and the full breakdown is saved in Reports History, which you can reopen or export any time.',
    keywords: ['fix finished', 'did it finish', 'is it done', 'completed', 'summary', 'results', 'the report', 'how do i know it worked'],
    panel: 'help-support', section: 'understanding-results',
  },
  {
    id: 'pause-fix',
    q: 'Can I stop a Fix partway and carry on later?',
    a: 'Yes — you can stop a running Fix, and whatever it has already copied stays safe and is recorded in Reports History. To carry on, run Fix again on the remaining sources; already-done files are skipped as duplicates.',
    keywords: ['pause fix', 'stop fix', 'resume', 'continue later', 'interrupt', 'carry on', 'part way', 'stop halfway', 'cancel and resume'],
    panel: 'help-support', section: 'faq',
  },
  {
    id: 'recognition-accuracy',
    q: 'How accurate is the face recognition — can I trust it?',
    a: 'It is good, but you always have the final say. PDR groups faces it thinks match, and YOU confirm each person, so nothing is named without your OK. If it groups too loosely or too tightly, the Match slider and Improve Facial Recognition let you tune it.',
    keywords: ['face recognition accurate', 'can i trust it', 'accuracy', 'is it reliable', 'wrong faces', 'how good is recognition', 'does it get faces right', 'trustworthy'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'memories-vs-search',
    q: 'What is the difference between Memories and Search & Discovery?',
    a: 'Memories is for BROWSING — your photos laid out by date (and in Albums), the way you would flip through a shoebox. Search & Discovery is for FINDING — filter by person, place, camera, date, file type and more to pull up exactly the photos you want.',
    keywords: ['memories vs search', 'difference between memories and search', 'when to use search', 'memories or search', 'browse vs search', 'which one do i use'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'mac',
    q: 'Is PDR available on Mac? When will it be?',
    a: 'PDR is a Windows app today, and a Mac version is planned for later in 2026. For the latest word on timing, check the website or Help & Support.',
    keywords: ['mac', 'macos', 'apple computer', 'macbook', 'imac', 'is there a mac version', 'when will there be a mac version', 'mac coming', 'osx', 'linux', 'does it run on mac'],
    panel: 'help-support', section: 'contact-support',
  },
  {
    id: 'nas-library',
    q: 'Can my Library Drive be a network drive or NAS?',
    a: 'You can add photos FROM a NAS or network drive as a source with no trouble. For the Library Drive itself — where your organized library lives — a fast, reliable internal or USB drive is the recommended pick; a network drive can work but is slower, and the Library Drive Advisor will steer you.',
    keywords: ['nas', 'network drive', 'library on a nas', 'network attached storage', 'shared drive', 'server', 'network storage'],
    panel: 'best-practices', section: 'bp-library-drive',
  },
  {
    id: 'same-photo-two-sources',
    q: 'What happens if two of my sources contain the same photo?',
    a: 'PDR spots files that are identical in content (by a content fingerprint, not the name or date) and keeps just one — so importing overlapping folders or backups will not fill your library with duplicates.',
    keywords: ['same photo twice', 'duplicate across sources', 'overlapping folders', 'two copies', 'same file in two places', 'import duplicates', 'backup overlap'],
    panel: 'help-support', section: 'faq',
  },
  {
    id: 'what-pdr-did',
    q: 'How do I see what PDR did to one specific photo?',
    a: 'Right-click a photo and open its info to see its date, how confident PDR was about it (Confirmed / Recovered / Marked) and where that date came from, plus camera and location. For a whole run, Reports History shows every file it touched.',
    keywords: ['what did pdr do', 'photo info', 'why this date', 'see the date source', 'confidence of a photo', 'details of a photo', 'inspect a photo', 'photo details'],
    panel: 'help-support', section: 'understanding-results',
  },
  {
    id: 'date-still-wrong',
    q: 'Why is a photo’s date still not right after a Fix?',
    a: 'If no rock-solid date survived, PDR either Recovered its best estimate from clues like the filename, or Marked it because nothing reliable was found. When you know the true date, set it yourself in Memories → Needs Dates — one photo or many at once.',
    keywords: ['date still wrong', 'wrong date after fix', 'date not right', 'incorrect date', 'bad date', 'date is off', 'still wrong date'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'album-vs-parallel',
    q: 'What is the difference between an Album and a Parallel Library?',
    a: 'An Album is a grouping inside your one library — the same photo can sit in several albums without being copied. A Parallel Library is a whole separate sub-library on its own drive (say Family-only) that you can give away or back up independently, while PDR still shows everything unified in its views.',
    keywords: ['album vs parallel library', 'difference between album and library', 'what is a parallel library', 'sub library vs album', 'separate library vs album'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'antivirus-admin',
    q: 'Will my antivirus flag PDR, or does it need admin rights?',
    a: 'PDR is code-signed and installs like a normal Windows app — you should not need special permissions for everyday use. If a security tool ever queries a signed app, that is a false positive you can safely allow. If an install will not go through, Help & Support can assist.',
    keywords: ['antivirus', 'virus', 'flagged', 'admin rights', 'administrator', 'permissions', 'blocked install', 'security warning', 'windows defender', 'smartscreen'],
    panel: 'help-support', section: 'contact-support',
  },
  {
    id: 'keep-open',
    q: 'Do I have to keep PDR open while it works?',
    a: 'Yes — keep PDR open while a Fix runs. Face and tag analysis also happens in the background whenever PDR is open and catches up over time, so it is fine to leave it running while you get on with other things.',
    keywords: ['keep it open', 'leave it running', 'close pdr', 'run in the background', 'do i have to wait', 'minimise', 'background processing', 'can i close it'],
    panel: 'help-support', section: 'glossary',
  },

  // ── v3.1 round 592 (Terry) — licensing / backup / recovery (Companion was thin here) ──────
  {
    id: 'cancel-subscription',
    q: 'How do I cancel my subscription?',
    a: 'A Lifetime licence has nothing to cancel — it is yours to keep. For a Monthly or Yearly subscription, manage or cancel it through your account with the store you bought it from (the link is in your purchase confirmation email). If it is really about cost, a cheaper plan may be available — Help & Support can point you to the right place.',
    keywords: ['cancel subscription', 'cancel my plan', 'stop paying', 'end subscription', 'unsubscribe', 'refund', 'cancel monthly', 'cancel yearly', 'stop my subscription', 'get my money back'],
    panel: 'help-support', section: 'contact-support',
  },
  {
    id: 'change-device',
    q: 'I have too many devices / a new computer — how do I move my licence?',
    a: 'A paid licence covers up to 3 devices at once. If you have hit the limit or replaced a computer, open Manage Devices, remove a device you no longer use to free a slot, then activate PDR on the new one. Your library itself lives on your Library Drive, so it comes straight back when you connect that drive.',
    keywords: ['too many devices', 'move my licence', 'move my license', 'new computer', 'change device', 'deactivate a device', 'remove a device', 'free a slot', 'device limit reached', 'transfer licence', 'replaced my pc', 'activate on new computer'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'library-backed-up',
    q: 'Is my library backed up?',
    a: 'Two separate things. PDR automatically backs up its DATABASE — your names, face tags, trees and date corrections — as snapshots (Settings → Backup), and a copy also rides along on your Library Drive. Your actual PHOTO FILES are NOT duplicated by PDR; they live on your Library Drive, so you should keep your own backup of that drive (a second drive or offsite copy) for true safety.',
    keywords: ['is my library backed up', 'library backup', 'are my photos backed up', 'is it backed up', 'do you back up my photos', 'backup my library', 'photos safe if drive dies', 'second copy'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'lost-computer',
    q: 'If my computer is lost, stolen or dies, is my library gone forever?',
    a: 'No — your library does not live on the computer, it lives on your Library Drive. A hidden Library Database on that drive holds everything PDR knows (names, faces, trees, date fixes), so you just connect the drive to a new PC, install PDR, and it picks up exactly where you left off. The one thing to protect is the DRIVE itself — keep a backup copy of it, because if the drive is lost too, so are the files on it.',
    keywords: ['lost computer', 'stolen computer', 'computer died', 'new pc', 'broken computer', 'is my library gone', 'lost my pc', 'computer stolen', 'hard drive died', 'start over on new computer', 'library gone forever', 'lose everything', 'will i lose everything', 'lose my library'],
    panel: 'help-support', section: 'glossary',
  },

  // ── v3.1 round 593 (Terry) — the fundamental "what / why / how does it compare" questions ──
  {
    id: 'what-is-pdr',
    q: 'What is Photo Date Rescue?',
    a: 'Photo Date Rescue is a private, all-on-your-computer home for your photo memories. Its heart is rescuing DATES — sorting out the wrong and missing dates that pile up when photos move between phones, apps and cloud services — then organizing everything into a clean timeline. From there it also finds and names people, builds family trees, makes collages and carousels, and captures your screen — all offline, with nothing uploaded, and your library staying yours.',
    keywords: ['what is pdr', 'what is photo date rescue', 'what does pdr do', 'what is this app', 'what is this', 'explain pdr', 'tell me about pdr', 'what does it do', 'pdr', 'purpose of pdr'],
    panel: 'getting-started', section: 'gs-what',
  },
  {
    id: 'who-is-pdr-for',
    q: 'Who is PDR for?',
    a: 'Anyone with a pile of photos and videos gathered from all over — old phones, cameras, WhatsApp, Google or iCloud exports, scans — where the dates are a mess and nothing is organized. If you want that turned into one clean, properly-dated, private library you actually own, that is exactly who PDR is for.',
    keywords: ['who is it for', 'who should use pdr', 'is it for me', 'right for me', 'who uses pdr', 'target user', 'is this for me'],
    panel: 'getting-started', section: 'gs-what',
  },
  {
    id: 'compare-other-apps',
    q: 'How does PDR compare to other photo apps?',
    a: 'Three things set PDR apart, and most cloud apps can’t honestly claim even one: Security — your photos live on your own hardware; Privacy — nothing is uploaded, shared, or tied to an account; and Ownership — your library is yours forever. And PDR isn’t just storage, it’s a whole workshop for your memories: it deeply rescues and corrects the DATES that get scrambled as photos move between phones, apps and services; finds and names the people in them and weaves them into family trees; lets you hunt down a photo from the vaguest clue and view your photos and videos in genuinely beautiful ways; turns them into collages and carousels ready for print or social; and shares them to any app, email or phone by simple drag-and-drop. On price, PDR is a subscription like most good software — Monthly or Yearly — or you can own it outright with a one-off Lifetime licence; the real difference from the cloud is that your photos are always yours, never deleted or locked away if you stop paying.',
    keywords: ['compare', 'vs other apps', 'how does it compare', 'google photos', 'icloud', 'mylio', 'better than', 'difference from other apps', 'why use pdr', 'alternative to', 'versus'],
    panel: 'help-support', section: 'start-here',
  },
  {
    id: 'pdr-strengths',
    q: 'What are PDR\'s strengths?',
    a: 'It runs completely offline — private, secure and yours, with no cloud. It rescues dates that other tools ignore, so scattered photos snap back into a proper timeline. It brings everything together in one place — dates, faces, family trees, collages, screen capture. Your whole library, with all your names and tags, survives a reinstall or a new PC because it lives on your drive, not on the app. And you choose how to pay — a monthly or yearly plan, or a one-off Lifetime licence — with your library staying yours either way.',
    keywords: ['strengths', 'what is pdr good at', 'why is it good', 'best features', 'advantages', 'what makes it good', 'pros', 'usp', 'why choose pdr', 'what is special'],
    panel: 'help-support', section: 'start-here',
  },
  {
    id: 'pdr-weaknesses',
    q: 'What are PDR\'s weaknesses or limits?',
    a: 'Honestly: it is Windows-only for now (Mac is planned for later in 2026), and by design it does not connect to the internet or sync to the cloud. That is the privacy-and-security point, but it does mean you look after your own backups and it is not a see-my-photos-on-every-device service. It is a focused desktop tool for owning and organizing your library, not a cloud platform.',
    keywords: ['weaknesses', 'limits', 'limitations', 'downsides', 'cons', 'what is it not good at', 'drawbacks', 'what can it not do', 'no internet', 'bad points'],
    panel: 'help-support', section: 'start-here',
  },
  {
    id: 'why-no-cloud-sync',
    q: 'Why can\'t I sync my library to my cloud storage?',
    a: 'That is a deliberate design choice, not a missing feature. PDR\'s whole promise is that your photos stay on YOUR hardware — private, secure and yours, with no uploading and no account. Syncing your library up to a cloud service would send it off your machine, which is exactly what PDR is built to avoid. For safety, keep your own backup of your Library Drive (a second drive or an offsite copy) rather than a cloud sync.',
    keywords: ['sync to cloud', 'cloud storage', 'save to cloud', 'why no cloud', 'upload my library', 'onedrive sync', 'google drive sync', 'dropbox sync', 'store in the cloud', 'back up to cloud', 'why not cloud'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'phone-app',
    q: 'Do you have a phone app? Why not?',
    a: 'No — and that is on purpose. Rescuing and organizing a whole photo library is heavy work that belongs on a computer: it needs the storage to hold your master library, the processing power to crunch dates and faces, and the privacy of keeping everything local rather than on a device that is easily lost. A phone simply is not the safe, capable home for a lifetime of photos. When you do want some on the go, Send to Phone hands them over instantly over your Wi-Fi.',
    keywords: ['phone app', 'mobile app', 'ios app', 'android app', 'app for my phone', 'is there an app', 'why no phone app', 'iphone app', 'tablet app'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'train-ai',
    q: 'Do you use my photos to train AI?',
    a: 'No. Everything — face recognition, tagging, enhancement — runs on your own computer, and nothing about your photos is ever uploaded or shared. Your images are never used to train anyone\'s AI. Privacy is the whole point.',
    keywords: ['train ai', 'used to train', 'my photos train ai', 'data used', 'ai training', 'do you use my data', 'harvest my photos', 'sell my data', 'privacy of ai'],
    panel: 'help-support', section: 'glossary',
  },
  {
    id: 'request-feature',
    q: 'Can you add a feature I\'d like?',
    a: 'Yes — we genuinely welcome ideas. Send your suggestion in through Help & Support (Report a problem / feedback) or the form on the website, and we will consider it for a future update. A lot of what is in PDR today came from exactly this kind of request.',
    keywords: ['add a feature', 'feature request', 'suggest a feature', 'can you add', 'i wish it could', 'future feature', 'feedback', 'suggestion', 'request a feature', 'idea'],
    panel: 'help-support', section: 'contact-support',
  },
];
