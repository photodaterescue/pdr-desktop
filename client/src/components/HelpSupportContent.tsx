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
export function HelpSupportContent({ onStartTour, onReportProblem }: HelpSupportContentProps) {
  return (
    <>
      <h2 className="text-2xl font-semibold text-foreground mb-3">Help & Support</h2>
      <p className="text-muted-foreground mb-10">Everything you need to use Photo Date Rescue confidently — without guesswork, fear, or unnecessary emails.</p>

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

          {/* Common Questions (FAQ) */}
          <AccordionItem value="faq" className="border border-border rounded-lg px-4">
            <AccordionTrigger className="text-foreground font-medium hover:no-underline">
              Common Questions
            </AccordionTrigger>
            <AccordionContent className="pt-2 pb-4">
              <div className="space-y-3">
                <div className="p-4 bg-secondary/30 border border-border rounded-lg">
                  <p className="font-medium text-foreground text-sm mb-1">Will this overwrite or damage my original files?</p>
                  <p className="text-sm text-muted-foreground">No. Originals are never modified. All changes are written to a new destination you choose.</p>
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
