import { PlayCircle, AlertTriangle } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/custom-button';

interface HelpSupportContentProps {
  /** Fires when the user clicks the in-content "Start Tour" button.
   *  When omitted, the entire "Take a Quick Tour" accordion is
   *  hidden — used by the Welcome modal so the user can't short-cut
   *  past the Library Drive step into a tour-fired Workspace. */
  onStartTour?: () => void;
  /** When provided, surfaces the in-app "Report a problem" CTA inside
   *  the When-to-Contact-Support accordion. Welcome's modal currently
   *  doesn't wire this (no log-tail context exists pre-destination),
   *  so it's optional. */
  onReportProblem?: () => void;
}

/**
 * Shared accordion stack for Help & Support. Used both:
 *   1. Inside Workspace (post-destination) as a full-page panel
 *      with sidebar visible and a "Back to Workspace" CTA.
 *   2. On the Welcome screen (pre-destination) as a modal overlay
 *      with a close affordance — keeps the user on Welcome rather
 *      than dragging them through the Workspace shell whose every
 *      sidebar item is a destination-required leaf.
 *
 * The component owns the title + description + accordion stack +
 * "Why This Exists" closing callout. The PARENT owns the wrapper
 * chrome (page padding vs modal shell) and the back/close button —
 * which is the part that actually differs between the two surfaces.
 */
export function HelpSupportContent({ onStartTour, onReportProblem, hideTitle }: HelpSupportContentProps & { hideTitle?: boolean }) {
  return (
    <>
      {!hideTitle && (
        <>
          <h2 className="text-2xl font-semibold text-foreground mb-3">Help & Support</h2>
          <p className="text-muted-foreground mb-4">Everything you need to use Photo Date Rescue confidently — without guesswork, fear, or unnecessary emails.</p>
        </>
      )}

      {/* v2.0.15 (Terry 2026-06-04) — PDR Photos USP card. Lives
          OUTSIDE the {!hideTitle} gate so it shows on BOTH render
          paths: the Welcome-modal version (hideTitle=false, h2 above)
          and the workspace-panel version (hideTitle=true, h2 + intro
          rendered by workspace.tsx). Help & Support is where users
          land when something feels uncertain; reassuring them about
          the brand pillars (Security · Privacy · Ownership) in that
          exact moment is intentional. Soft lavender border + 5% tint
          matches the other primary-accent info cards elsewhere in
          PDR (e.g. the "Guides" callout below). */}
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 mb-10">
        <p className="text-[0.7rem] uppercase tracking-[0.22em] text-muted-foreground/80 font-medium mb-1.5">PDR Photos</p>
        <p className="text-sm text-foreground leading-relaxed">
          Built around three principles: your photos stay on your hardware (<strong className="font-semibold">Security</strong>), nothing is uploaded or shared (<strong className="font-semibold">Privacy</strong>), and the library is yours forever (<strong className="font-semibold">Ownership</strong>).
        </p>
      </div>

      <div className="space-y-6">
        <Accordion type="multiple" defaultValue={["start-here"]} className="space-y-3">

          {/* Start Here - Expanded by default */}
          <AccordionItem value="start-here" className="border border-border rounded-lg px-4">
            <AccordionTrigger className="text-foreground font-medium hover:no-underline">
              Start Here (Recommended)
            </AccordionTrigger>
            <AccordionContent className="pt-2 pb-4">
              <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
                <p>If you're unsure about what to select, why files were marked, or how to plan a clean fix, start with the Guides. They answer most questions faster than email support.</p>

                <div className="p-4 bg-primary/5 border border-primary/10 rounded-lg">
                  <p className="font-medium text-foreground mb-2">Guides: Getting Your Photos In and Out</p>
                  <button
                    onClick={async () => {
                      const { openExternalUrl } = await import('@/lib/electron-bridge');
                      await openExternalUrl('https://www.photodaterescue.com/#guides');
                    }}
                    className="text-primary hover:underline text-sm cursor-pointer bg-transparent border-none p-0 text-left"
                  >
                    photodaterescue.com/guides →
                  </button>
                </div>

                <div>
                  <p className="font-medium text-foreground mb-2">These guides help you:</p>
                  <ul className="list-disc ml-5 space-y-1">
                    <li>Plan large fixes safely</li>
                    <li>Avoid duplicate scans</li>
                    <li>Understand what metadata survives exports</li>
                    <li>Get the best possible results on the first run</li>
                  </ul>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Replay Tour — only rendered when a real handler is wired
              in. Welcome's modal omits this prop so users pre-
              destination can't short-cut past the Library Drive step
              by firing the tour, which itself routes into Workspace. */}
          {onStartTour && (
            <AccordionItem value="replay-tour" className="border border-border rounded-lg px-4">
              <AccordionTrigger className="text-foreground font-medium hover:no-underline">
                Take a Quick Tour
              </AccordionTrigger>
              <AccordionContent className="pt-2 pb-4">
                <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
                  <p>Need a refresher? Walk through the key areas of Photo Date Rescue with a guided tour. It takes less than a minute.</p>

                  <Button
                    variant="information"
                    onClick={onStartTour}
                    className="gap-2"
                    data-testid="button-replay-tour"
                  >
                    <PlayCircle className="w-4 h-4" /> Start Tour
                  </Button>
                </div>
              </AccordionContent>
            </AccordionItem>
          )}

          {/* Guides by Topic */}
          <AccordionItem value="guides-topic" className="border border-border rounded-lg px-4">
            <AccordionTrigger className="text-foreground font-medium hover:no-underline">
              Guides by Topic
            </AccordionTrigger>
            <AccordionContent className="pt-2 pb-4">
              <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
                <p>Use these if your photos came from specific places:</p>

                <div className="space-y-3">
                  <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                    <p className="font-medium text-foreground mb-1">Cloud Services</p>
                    <p className="text-sm text-muted-foreground mb-2">Google Photos, iCloud, OneDrive, Dropbox</p>
                    <button
                      onClick={async () => {
                        const { openExternalUrl } = await import('@/lib/electron-bridge');
                        await openExternalUrl('https://www.photodaterescue.com/guides/cloud-services');
                      }}
                      className="text-primary hover:underline text-xs cursor-pointer bg-transparent border-none p-0 text-left"
                    >
                      View guide →
                    </button>
                  </div>

                  <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                    <p className="font-medium text-foreground mb-1">Social & Messaging Apps</p>
                    <p className="text-sm text-muted-foreground mb-2">WhatsApp, Messenger, Telegram, Signal, Snapchat</p>
                    <button
                      onClick={async () => {
                        const { openExternalUrl } = await import('@/lib/electron-bridge');
                        await openExternalUrl('https://www.photodaterescue.com/guides/social-apps');
                      }}
                      className="text-primary hover:underline text-xs cursor-pointer bg-transparent border-none p-0 text-left"
                    >
                      View guide →
                    </button>
                  </div>

                  <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                    <p className="font-medium text-foreground mb-1">Hardware & Devices</p>
                    <p className="text-sm text-muted-foreground mb-2">Phones, cameras, scanners, external drives</p>
                    <button
                      onClick={async () => {
                        const { openExternalUrl } = await import('@/lib/electron-bridge');
                        await openExternalUrl('https://www.photodaterescue.com/guides/hardware-devices');
                      }}
                      className="text-primary hover:underline text-xs cursor-pointer bg-transparent border-none p-0 text-left"
                    >
                      View guide →
                    </button>
                  </div>
                </div>

                <div>
                  <p className="font-medium text-foreground mb-2">Each guide explains:</p>
                  <ul className="list-disc ml-5 space-y-1">
                    <li>How to export correctly</li>
                    <li>What date data is preserved or lost</li>
                    <li>How PDR reconstructs timelines safely</li>
                    <li>Common mistakes to avoid</li>
                  </ul>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Understanding Your Results */}
          <AccordionItem value="understanding-results" className="border border-border rounded-lg px-4">
            <AccordionTrigger className="text-foreground font-medium hover:no-underline">
              Understanding Your Results
            </AccordionTrigger>
            <AccordionContent className="pt-2 pb-4">
              <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
                <p>After you run Fix, PDR shows you exactly what happened.</p>

                <div>
                  <p className="font-medium text-foreground mb-3">Confidence labels</p>
                  <div className="space-y-2">
                    <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-700 rounded-lg">
                      <p className="font-medium text-emerald-700 dark:text-emerald-300 text-sm">Confirmed</p>
                      <p className="text-xs text-muted-foreground mt-1">Date taken from authoritative metadata</p>
                    </div>
                    <div className="p-3 bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-700 rounded-lg">
                      <p className="font-medium text-indigo-700 dark:text-indigo-300 text-sm">Recovered</p>
                      <p className="text-xs text-muted-foreground mt-1">Date reconstructed from reliable filename patterns</p>
                    </div>
                    <div className="p-3 bg-slate-100 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-600 rounded-lg">
                      <p className="font-medium text-slate-700 dark:text-slate-300 text-sm">Marked</p>
                      <p className="text-xs text-muted-foreground mt-1">No usable date found; safe fallback rules applied</p>
                    </div>
                  </div>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="text-sm"><span className="font-medium text-foreground">Nothing is hidden.</span> Nothing is silently guessed.</p>
                  <p className="text-sm mt-2">Use <span className="font-medium text-foreground">Reports History</span> to review or export what happened at any time.</p>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Glossary — quick reference for PDR-specific vocabulary that
              shows up across the app, this Help panel, and the website.
              Grouped by area so users can find a term either alphabetically
              by scanning, or by knowing roughly where it belongs. */}
          <AccordionItem value="glossary" className="border border-border rounded-lg px-4">
            <AccordionTrigger className="text-foreground font-medium hover:no-underline">
              Glossary
            </AccordionTrigger>
            <AccordionContent className="pt-2 pb-4">
              <div className="space-y-5 text-sm">
                <p className="text-muted-foreground">A quick reference for the terms PDR uses. Grouped by area; scan or search.</p>

                <div>
                  <p className="font-medium text-foreground mb-2">Your Library</p>
                  <dl className="space-y-2">
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Library Drive</dt>
                      <dd className="text-muted-foreground mt-0.5">The drive your organized photos and videos live on, picked once during setup. PDR rates each connected drive on speed, capacity and reliability via the Library Drive Advisor so you can choose confidently. Internal motherboard-connected drives are usually the fastest pick.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Library Database (LDB)</dt>
                      <dd className="text-muted-foreground mt-0.5">A hidden copy of everything PDR knows about your library — face tags, names, Trees, date corrections, search indexes — kept inside your Library Drive. Lets a new PC reconnect to your library and pick up exactly where the previous one left off.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Master library</dt>
                      <dd className="text-muted-foreground mt-0.5">Your complete, definitive library — every photo and video PDR has fixed for you, organized year by year on your Library Drive.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Parallel Libraries</dt>
                      <dd className="text-muted-foreground mt-0.5">Curated sub-libraries spun off your Master — Family-only, Friends-only, Pets-only — built from filtered queries in Search &amp; Discovery so you don't sort by hand. Each Parallel Library lives on a drive of your choice and can be given away, hidden, or backed up independently. PDR keeps photos from every library unified in its views (S&amp;D, Memories, Trees, People Manager), but the original files live where you sent them — so each library drive needs to be connected to OPEN a full-size file, even though thumbnails stay visible offline thanks to a local cache.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Auto-catalog</dt>
                      <dd className="text-muted-foreground mt-0.5">An always-up-to-date CSV/TXT log of every file PDR has fixed, written to your Library Drive.</dd>
                    </div>
                  </dl>
                </div>

                <div>
                  <p className="font-medium text-foreground mb-2">Fixing photos</p>
                  <dl className="space-y-2">
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Source</dt>
                      <dd className="text-muted-foreground mt-0.5">A folder, zip, RAR archive, or drive containing photos and videos you want PDR to process. A Fix can include many Sources at once.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Why one large ZIP at a time?</dt>
                      <dd className="text-muted-foreground mt-0.5">A large ZIP (e.g. a full Google Photos Takeout — up to ~50 GB, Google's max per download) has to be unpacked into a temporary workspace before PDR can read each photo's metadata. PDR caps that workspace at one large ZIP at a time so a partial extraction can't fill your drive or trip you up if something goes wrong mid-way. Folders, drives, and small archives can still be added alongside the large ZIP for the same Fix — only a SECOND large ZIP needs to wait until the current one is fixed.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Fix / Run Fix</dt>
                      <dd className="text-muted-foreground mt-0.5">A processing pass. PDR analyzes every file across all your Sources, works out the right date, then copies the file to your Library Drive with the corrected date in EXIF, in the filename, and in a clean year-by-year folder.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Confirmed</dt>
                      <dd className="text-muted-foreground mt-0.5">A date PDR is fully confident about, taken directly from EXIF or a Google Takeout sidecar.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Recovered</dt>
                      <dd className="text-muted-foreground mt-0.5">A date PDR worked out from less-direct signals — filename patterns, folder structure, neighbouring photos, file system timestamps.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Marked</dt>
                      <dd className="text-muted-foreground mt-0.5">A file PDR couldn't date with enough confidence. It's renamed for review so you can decide what to do with it in Date Editor.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Duplicate</dt>
                      <dd className="text-muted-foreground mt-0.5">A file PDR has detected is identical in content to another file in the same Fix. Safely skipped — you won't get two copies of the same photo.</dd>
                    </div>
                  </dl>
                </div>

                <div>
                  <p className="font-medium text-foreground mb-2">Output formats</p>
                  <dl className="space-y-2">
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Full Quality (PNG)</dt>
                      <dd className="text-muted-foreground mt-0.5">PDR's plain-language label for PNG output. Every pixel of the source photo is preserved exactly during conversion — no detail is dropped, no smudging on fine edges or text. The trade-off is larger files (typically 2.5–3× the JPG equivalent) and slower conversion (about 4× slower than JPG on the same hardware). Best for photos you may want to edit, print, or archive long-term.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Lossless</dt>
                      <dd className="text-muted-foreground mt-0.5">The technical term for compression that doesn't drop any picture data. PNG is lossless — saved and re-saved a thousand times, it stays identical to the original. PDR's "Full Quality" PNG output IS lossless; the two terms describe the same thing. Contrast with JPG, which uses <em className="text-muted-foreground/80">lossy</em> compression — files shrink dramatically by discarding tiny (usually invisible) detail.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">JPG (lossy)</dt>
                      <dd className="text-muted-foreground mt-0.5">The universally-supported photo format. Uses lossy compression to shrink files to a fraction of PNG's size, accepting tiny (usually invisible) detail loss in return. PDR exports JPG at quality 92 — close enough to PNG that the difference is virtually impossible to see without zooming to pixel level.</dd>
                    </div>
                  </dl>
                </div>

                {/* v2.0.15 (Terry 2026-06-06) — filename suffix
                    convention was completely undocumented before
                    this. PDR renames every fixed file with the
                    `YYYY-MM-DD_HH-MM-SS_XX.ext` pattern; the `XX`
                    is a short code that tells the user (and any
                    other photo app) how confident PDR was about that
                    file's date, or that it was born/edited in PDR.
                    Listed here as a single group so users hitting
                    e.g. `_CF.jpg` in File Explorer can decode it. */}
                <div>
                  <p className="font-medium text-foreground mb-2">Filename suffixes</p>
                  <dl className="space-y-2">
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">_CF — Confirmed</dt>
                      <dd className="text-muted-foreground mt-0.5">The date came directly from the file&apos;s EXIF data or a Google Takeout sidecar. PDR is fully confident this is when the photo was taken. Highest confidence tier.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">_RC — Recovered</dt>
                      <dd className="text-muted-foreground mt-0.5">The date was worked out from less-direct signals — filename patterns, folder structure, neighbouring photos, file system timestamps. Confident enough to use but not as bullet-proof as Confirmed.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">_MK — Marked</dt>
                      <dd className="text-muted-foreground mt-0.5">PDR couldn&apos;t work out a date with enough confidence. The file was Marked for your review — open <span className="font-medium text-foreground">Memories — Needs Dates</span> to set the real date when you know it (one at a time or in bulk).</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">_E — Enhanced</dt>
                      <dd className="text-muted-foreground mt-0.5">A new file created by the PDR Viewer&apos;s Enhance panel — brightness, contrast, saturation, temperature, or B&amp;W adjustments baked into a fresh JPG alongside the original. The original is untouched; this is your edited copy. The enhancement type (manual or AI) is recorded in the file&apos;s XMP metadata so Search &amp; Discovery can filter for it.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">_T — Trimmed</dt>
                      <dd className="text-muted-foreground mt-0.5">A new video clip created by the PDR Viewer&apos;s Trim panel — a shorter segment cut out of the original video, written as a sibling file next to it. The original is untouched; this is your shortened version. Clips inherit the original&apos;s date so they sort alongside it in Memories. If you trim the same video multiple times, you&apos;ll see <span className="font-mono">_T_2</span>, <span className="font-mono">_T_3</span>, etc.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">_CO — Collage</dt>
                      <dd className="text-muted-foreground mt-0.5">A collage you designed in PDR, flattened into a finished JPG (or PNG when it has a transparent background) and filed in <span className="font-medium text-foreground">Memories — Albums — PDR Collages</span> under the album you chose. Your editable project is stored separately, so you can reopen and keep editing it any time.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">_CW — Carousel</dt>
                      <dd className="text-muted-foreground mt-0.5">The full wide design of an Instagram-style carousel you built in PDR. Its individual pages are sliced out beside it as <span className="font-mono">slide_01</span>, <span className="font-mono">slide_02</span>… (inside a <span className="font-mono">Carousel_&lt;date&gt;</span> folder) so you can drag them into Instagram left-to-right, in order.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">_SS — Screenshot</dt>
                      <dd className="text-muted-foreground mt-0.5">A still image captured with PDR&apos;s Capture tool. It&apos;s dated the moment it was taken, so it carries Confirmed confidence.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">_SR — Screen recording</dt>
                      <dd className="text-muted-foreground mt-0.5">A video recorded with PDR&apos;s screen recorder, dated when the recording was made.</dd>
                    </div>
                  </dl>
                </div>

                <div>
                  <p className="font-medium text-foreground mb-2">Faces, people and Trees</p>
                  <dl className="space-y-2">
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Cluster</dt>
                      <dd className="text-muted-foreground mt-0.5">A group of faces PDR thinks belongs to the same person. Verify a cluster in People Manager to turn it into a named Person.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Verified face</dt>
                      <dd className="text-muted-foreground mt-0.5">A face you've confirmed belongs to a specific Person. Verified faces are the ground truth PDR uses to find more photos of that person.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Person</dt>
                      <dd className="text-muted-foreground mt-0.5">A named identity in PDR. Holds verified faces, all the photos that contain them, and their relationships to other People in Trees.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Improve Recognition</dt>
                      <dd className="text-muted-foreground mt-0.5">A one-click action that re-runs face matching with PDR's latest algorithm and retroactively cleans up auto-matches made under older, weaker rules. Adds new matches AND drops bogus ones in a single pass.</dd>
                    </div>
                  </dl>
                </div>

                <div>
                  <p className="font-medium text-foreground mb-2">Multi-device</p>
                  <dl className="space-y-2">
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Writer</dt>
                      <dd className="text-muted-foreground mt-0.5">The device currently holding write access to your Library Database. Only one writer at a time across all your devices — prevents accidental conflicts that could damage months of tagging work.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Reader</dt>
                      <dd className="text-muted-foreground mt-0.5">A device connected to your library in read-only mode. Can browse photos, search, view Trees — but not edit faces, names, or dates until you hand writer status to it.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Take over writing</dt>
                      <dd className="text-muted-foreground mt-0.5">Hand the writer role from one device to another — confirmed with your license key, so only you can do it. The previous writer drops to read-only on its next access.</dd>
                    </div>
                  </dl>
                </div>

                <div>
                  <p className="font-medium text-foreground mb-2">Safety net</p>
                  <dl className="space-y-2">
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Snapshot</dt>
                      <dd className="text-muted-foreground mt-0.5">A point-in-time backup copy of your local PDR database. PDR takes them automatically — before every launch, daily, weekly, and before risky operations like Improve Recognition or row removal. Available under Settings → Backup. Manual snapshots stay until you delete them.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Snapshot vs Library Database</dt>
                      <dd className="text-muted-foreground mt-0.5">They complement each other. Snapshots let you roll BACK IN TIME (undo last Tuesday). The Library Database lets your library TRAVEL TO ANOTHER PC. A few recent snapshots also ride along inside the Library Database, so rollback safety follows you when you switch machines.</dd>
                    </div>
                  </dl>
                </div>

                <div>
                  <p className="font-medium text-foreground mb-2">Apps and tools inside PDR</p>
                  <dl className="space-y-2">
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Search &amp; Discovery (S&amp;D)</dt>
                      <dd className="text-muted-foreground mt-0.5">PDR's full-text + faceted search engine. Find any file by year, person, place, camera, lens, focal length, aperture, file type, or any combination.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">People Manager (PM)</dt>
                      <dd className="text-muted-foreground mt-0.5">The face and person management surface. Verify clusters, name people, merge or split, browse every photo of one person at a glance.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Date Editor</dt>
                      <dd className="text-muted-foreground mt-0.5">Per-file manual date editing with a filmstrip view and a custom calendar. The place to handle edge cases PDR couldn't date confidently on its own.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Trees</dt>
                      <dd className="text-muted-foreground mt-0.5">Family-tree builder. Once you verify faces to people, your tree nodes auto-attach the right photos.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Memories</dt>
                      <dd className="text-muted-foreground mt-0.5">Timeline view of your library by extracted date — your fixed photos rediscovered, year by year.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Reports History</dt>
                      <dd className="text-muted-foreground mt-0.5">An audit trail of every Fix run. Reopenable, exportable to CSV/TXT, comparable across runs.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Library Drive Advisor</dt>
                      <dd className="text-muted-foreground mt-0.5">Pre-Fix wizard that rates each of your connected drives on speed, capacity and reliability so you pick the right Library Drive on the first try.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Library Planner</dt>
                      <dd className="text-muted-foreground mt-0.5">Pre-Fix wizard that estimates how much room your collection will need across seven categories, so you don't run out of space mid-job.</dd>
                    </div>
                  </dl>
                </div>
                <div>
                  <p className="font-medium text-foreground mb-2">Collages</p>
                  <dl className="space-y-2">
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Collage project</dt>
                      <dd className="text-muted-foreground mt-0.5">Your editable collage. It auto-saves as you work and lives under &ldquo;Your Collage Projects&rdquo; on the Collages screen, so you can reopen it and keep editing any time.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Save (a collage)</dt>
                      <dd className="text-muted-foreground mt-0.5">Turns the project into a finished JPG in your library — Memories › Albums › PDR Collages › the album you chose. It doesn&apos;t leave PDR; it becomes a real photo you can view, share and print.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Update vs Save as new version</dt>
                      <dd className="text-muted-foreground mt-0.5"><span className="font-medium text-foreground">Update</span> re-saves over the same library photo (no duplicates). <span className="font-medium text-foreground">Save as new version</span> keeps the old one and adds a fresh copy (v2, v3…).</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Carousel</dt>
                      <dd className="text-muted-foreground mt-0.5">A multi-page collage (Instagram&apos;s swipeable format) — you build the pages side by side and it exports as numbered slides.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Template</dt>
                      <dd className="text-muted-foreground mt-0.5">A reusable layout (e.g. a four- or nine-photo grid). Pick one on the Collages start screen and drop your own photos into the empty frames.</dd>
                    </div>
                  </dl>
                </div>
                <div>
                  <p className="font-medium text-foreground mb-2">Sharing &amp; capture</p>
                  <dl className="space-y-2">
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Send to Phone</dt>
                      <dd className="text-muted-foreground mt-0.5">Transfers selected photos to a phone on the same Wi-Fi by showing a QR code to scan — no cable, no cloud, no account.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Print / Print to PDF</dt>
                      <dd className="text-muted-foreground mt-0.5">Send a photo to a local or network printer, or save a print-ready PDF.</dd>
                    </div>
                    <div className="p-3 bg-secondary/30 border border-border rounded-lg">
                      <dt className="font-medium text-foreground">Screen capture</dt>
                      <dd className="text-muted-foreground mt-0.5">Grab a screenshot or screen recording straight into your library (the camera icon in the title bar, or Ctrl+Shift+S) so it&apos;s filed in Memories like any photo.</dd>
                    </div>
                  </dl>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Common Questions (FAQ) */}
          <AccordionItem value="faq" className="border border-border rounded-lg px-4">
            <AccordionTrigger className="text-foreground font-medium hover:no-underline">
              Common Questions
            </AccordionTrigger>
            <AccordionContent className="pt-2 pb-4">
              <div className="space-y-3">
                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">Will this overwrite or damage my original files?</p>
                  <p className="text-sm text-muted-foreground">No. Originals are never modified. All changes are written to a new Library Drive you choose.</p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">Where do my collages go when I save one?</p>
                  <p className="text-sm text-muted-foreground">Into your library, as a normal photo — <strong className="text-foreground font-medium">Memories › Albums › PDR Collages › the album you chose</strong> — so you can view, share and print it like any other. The editable design also stays under <strong className="text-foreground font-medium">Your Collage Projects</strong> on the Collages screen, so you can reopen and tweak it any time. &ldquo;Update&rdquo; re-saves over the same photo; &ldquo;Save as new version&rdquo; keeps the old one and adds a fresh copy.</p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">How do I get a photo out of PDR to share it?</p>
                  <p className="text-sm text-muted-foreground">Several ways, all local: <strong className="text-foreground font-medium">drag</strong> one or more photos straight into another app or a folder; <strong className="text-foreground font-medium">Send to Phone</strong> shows a Wi-Fi QR code to scan from a phone on the same network; <strong className="text-foreground font-medium">Print</strong> goes to a printer or a PDF; and <strong className="text-foreground font-medium">Copy</strong> puts it on the clipboard. Nothing routes through the cloud.</p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">Why are some files marked "Marked"?</p>
                  <p className="text-sm text-muted-foreground">Because no reliable date survived export or transfer. PDR labels this clearly instead of pretending certainty.</p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">Why don't all files have the same confidence level?</p>
                  <p className="text-sm text-muted-foreground">Different apps and devices preserve metadata differently. PDR reflects reality instead of smoothing it over.</p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">What happens if I run Fix more than once?</p>
                  <p className="text-sm text-muted-foreground">Each run creates its own output and report. Nothing is merged or overwritten automatically.</p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">Can I stop a Fix once it starts?</p>
                  <p className="text-sm text-muted-foreground">Yes. Partial output remains safe and usable. Completed work is still recorded in Reports History.</p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">What happens to my photos if I have libraries on more than one drive?</p>
                  <p className="text-sm text-muted-foreground">
                    Everything stays unified in PDR. Search &amp; Discovery, Memories, Trees and People Manager all show photos from every library you've ever fixed — regardless of which physical drive each one lives on. The clumping happens automatically when each Fix finishes; you don't need to re-scan or merge anything by hand.
                    <br /><br />
                    There are two things to know:
                    <br />
                    1. To <strong className="text-foreground font-medium">open</strong> a full-size photo (in the viewer, for example), the drive it lives on must be connected. Thumbnails stay visible offline thanks to a local cache, but the original file needs its drive plugged in.
                    <br />
                    2. AI face and tag analysis runs separately from the Fix. So a freshly-fixed library is immediately searchable and shows up in Memories, but face recognition catches up on the new photos a little later. Person assignments from your previous libraries still apply — the same face on a new drive ends up under the same Person you've already named.
                  </p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">Why don't reports change when I add more files later?</p>
                  <p className="text-sm text-muted-foreground">Reports are snapshots of a specific Fix run. This preserves traceability and avoids confusion.</p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">Why don't I see every duplicate listed?</p>
                  <p className="text-sm text-muted-foreground">Exact duplicates are removed from output, not deleted. PDR keeps the best version and explains the method used.</p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">Can I use PDR on very large libraries?</p>
                  <p className="text-sm text-muted-foreground">Yes — it's designed for scale. Reports and UI remain usable even with large runs.</p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">Is this safe to use with cloud backups?</p>
                  <p className="text-sm text-muted-foreground">Yes — if you follow the Guides. Cloud services often strip metadata, and the Guides explain how to avoid issues.</p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">Why does PDR feel stricter than other tools?</p>
                  <p className="text-sm text-muted-foreground">Because it's deterministic and auditable. Everything can be reviewed later.</p>
                </div>

                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">What if something doesn't look right?</p>
                  <p className="text-sm text-muted-foreground">Check Source Analysis, Confidence tooltips, and Reports History. If it still doesn't make sense, then contact support.</p>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* When to Contact Support */}
          <AccordionItem value="contact-support" className="border border-border rounded-lg px-4">
            <AccordionTrigger className="text-foreground font-medium hover:no-underline">
              When to Contact Support
            </AccordionTrigger>
            <AccordionContent className="pt-2 pb-4">
              <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
                <p className="font-medium text-foreground">Please contact support only if:</p>
                <ul className="list-disc ml-5 space-y-1">
                  <li>The app fails to launch</li>
                  <li>A Fix crashes or stops unexpectedly</li>
                  <li>A license issue prevents use</li>
                </ul>

                <div className="pt-4 border-t border-border mt-4">
                  <p className="text-xs text-muted-foreground mb-3">
                    For setup questions, planning advice, or interpretation of results, please use the Guides first — they're faster and more detailed than email.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {onReportProblem && (
                      <button
                        onClick={onReportProblem}
                        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg border border-border bg-secondary/30 text-foreground hover:bg-secondary/50 transition-colors cursor-pointer"
                      >
                        <AlertTriangle className="w-4 h-4 text-amber-500" />
                        Report a problem (recommended)
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        const { openExternalUrl } = await import('@/lib/electron-bridge');
                        await openExternalUrl('https://www.photodaterescue.com/support?source=app');
                      }}
                      className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium rounded-lg border border-border bg-secondary/30 text-foreground hover:bg-secondary/50 transition-colors cursor-pointer"
                    >
                      Contact Support (web form)
                    </button>
                  </div>
                  {onReportProblem && (
                    <p className="text-xs text-muted-foreground mt-2">
                      The in-app <strong className="text-foreground font-semibold">Report a problem</strong> option pre-fills a support email with your system info and log file — the fastest way for us to diagnose an issue.
                    </p>
                  )}
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

        </Accordion>

        {/* Why This Exists - Closing callout */}
        <section className="pt-4">
          <div className="p-6 bg-primary/5 border border-primary/10 rounded-xl">
            <p className="font-medium text-foreground mb-2">Why This Exists</p>
            <p className="text-sm text-muted-foreground leading-relaxed mb-3">
              Photo Date Rescue isn't just a renaming tool. It's a system for restoring trust in your timeline.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The Help & Guides exist so you can fix once, correctly — avoid rework, preserve your archive long-term, and stay in control of your data.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
