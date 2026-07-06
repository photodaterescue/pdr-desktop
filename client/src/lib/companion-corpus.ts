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
    keywords: ['which drive', 'best drive', 'choose drive', 'pick drive', 'external drive', 'ssd or hdd', 'advisor', 'planner', 'how much space'],
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
    q: 'Will PDR change or damage my original photos?',
    a: 'No. Your originals are never modified. Every change PDR makes is written to a fresh copy on the Library Drive you choose, so the source files stay exactly as they were.',
    keywords: ['damage', 'safe', 'overwrite', 'change originals', 'ruin', 'break my photos', 'modify', 'lose photos', 'risk'],
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
  {
    id: 'trees-photos',
    q: 'Why does a person in my tree have no photo?',
    a: 'Tree nodes attach photos from People Manager. If a person has no photo yet, verify one of their face clusters in People Manager — or set a face directly from a screenshot or your webcam via the right-click menu on the tree tile.',
    keywords: ['tree no photo', 'empty tree node', 'person no face', 'add face to tree', 'set face', 'tree picture missing', 'webcam', 'screenshot face'],
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
    keywords: ['where do collages go', 'saved collage location', 'find my collage', 'collage album', 'pdr collages'],
    panel: 'help-support', section: 'faq',
  },
  {
    id: 'update-vs-version',
    q: 'What is the difference between Update and Save as new version?',
    a: 'Update re-saves over the same library photo, so you never pile up duplicates. Save as new version keeps the old photo and adds a fresh copy (v2, v3…) — handy when you want to keep both the old and new look.',
    keywords: ['update vs new version', 'save as new version', 'update collage', 'overwrite collage', 'duplicate collage', 'versions'],
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
  {
    id: 'template',
    q: 'What is a collage template?',
    a: 'A template is a reusable layout — like a four- or nine-photo grid. Pick one on the Collages start screen and drop your own photos into the empty frames.',
    keywords: ['template', 'templates', 'grid', 'layout', 'preset collage'],
    panel: 'help-support', section: 'glossary',
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
    q: 'How do I trim a video?',
    a: 'Open a video in the Viewer and use the Trim panel to cut out a shorter segment. It writes a new clip (named with _T) next to the original, keeping the original\'s date so it sorts alongside it in Memories.',
    keywords: ['trim video', 'cut video', 'shorten video', 'clip', 'edit video', 'video segment'],
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
    keywords: ['large library', 'lots of photos', 'thousands of photos', 'big collection', 'huge', 'performance', 'slow'],
    panel: 'help-support', section: 'faq',
  },
  {
    id: 'cloud-safe',
    q: 'Is PDR safe to use with cloud backups like Google Photos or iCloud?',
    a: 'Yes, if you follow the Guides. Cloud services often strip or alter the date metadata on export, and the topic guides explain how to export correctly so PDR gets the best possible dates.',
    keywords: ['cloud backup', 'google photos', 'icloud', 'onedrive', 'dropbox', 'export from cloud', 'metadata stripped'],
    panel: 'help-support', section: 'guides-topic',
  },
];
