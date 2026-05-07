import { useEffect, useState } from 'react';
import { X, Send, AlertTriangle, Check, FolderOpen } from 'lucide-react';
import { reportProblem, getLogFilePath, revealInFolder } from '@/lib/electron-bridge';
import { Button } from '@/components/ui/custom-button';

interface ReportProblemModalProps {
  onClose: () => void;
  /**
   * Pre-fill the description box with this text. Used when the modal
   * is opened automatically from a crash handler (e.g. the analysis
   * IPC error path) so the user sees what we already know about
   * the failure before they add their own context.
   */
  initialDescription?: string;
}

/**
 * One-click support bundle modal.
 *
 * User types a short description → clicks Send. Main process:
 *   1. composes a pre-filled email (system info + recent log tail),
 *   2. opens the user's default mail client on that email,
 *   3. opens Explorer on %APPDATA%\Photo Date Rescue\logs so the
 *      user can drag the log file into the email as an attachment
 *      (mailto: doesn't support attachments).
 *
 * The "Open log folder" link below the form gives power users a
 * direct path to the log file if they prefer to send it themselves.
 */
export function ReportProblemModal({ onClose, initialDescription }: ReportProblemModalProps) {
  const [description, setDescription] = useState(initialDescription ?? '');
  const [userEmail, setUserEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sentOk, setSentOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logPath, setLogPath] = useState<string | null>(null);
  // Captured from the reportProblem IPC response so we can show the
  // user the exact .zip filename to drag into their email.
  const [diagnosticZipPath, setDiagnosticZipPath] = useState<string | null>(null);

  // Resolve the log file path up-front so the UI can show it even
  // before the user hits Send. Useful for copy-paste and reassurance.
  useEffect(() => {
    (async () => {
      const r = await getLogFilePath(false);
      if (r?.path) setLogPath(r.path);
    })();
  }, []);

  const handleSend = async () => {
    setError(null);
    setSending(true);
    try {
      const r = await reportProblem({ description: description.trim(), userEmail: userEmail.trim() });
      if (r.success) {
        setSentOk(true);
        if (r.logFilePath) setLogPath(r.logFilePath);
        if (r.diagnosticZipPath) setDiagnosticZipPath(r.diagnosticZipPath);
      } else {
        setError(r.error ?? 'Could not open your mail client. Please send a message to admin@photodaterescue.com manually.');
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-background rounded-xl shadow-2xl border border-border max-w-lg w-full"
        onClick={e => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3 relative">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            <h3 className="text-base font-semibold text-foreground">Report a problem</h3>
          </div>
          <button onClick={onClose} className="absolute right-3 top-3 p-1 rounded hover:bg-accent" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-4 flex flex-col gap-3">
          {!sentOk ? (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Briefly describe what went wrong, then click Send. We'll create a diagnostic ZIP for you —{' '}
                <strong className="text-foreground font-semibold">drag it into the email when your mail client opens, then send.</strong>
              </p>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">What happened?</span>
                <textarea
                  autoFocus
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="E.g. The app crashed at 33% while analyzing a Google Takeout zip."
                  rows={5}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground resize-y focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">Your email <span className="text-muted-foreground font-normal">(optional — lets us reply)</span></span>
                <input
                  type="email"
                  value={userEmail}
                  onChange={e => setUserEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </label>
              {error && (
                <div className="text-xs text-red-600 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                  {error}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center text-center gap-3 py-4">
              <div className="w-12 h-12 rounded-full bg-emerald-500/15 flex items-center justify-center">
                <Check className="w-6 h-6 text-emerald-600" />
              </div>
              <h4 className="text-sm font-semibold text-foreground">
                {diagnosticZipPath ? 'Email opened — please attach this file' : 'Email opened — please attach the log'}
              </h4>
              <p className="text-xs text-muted-foreground max-w-sm">
                {diagnosticZipPath
                  ? 'Drag the diagnostic ZIP from the folder we just opened into the email before sending. It bundles your log + system info + licence state.'
                  : 'Drag main.log from the folder we just opened into the email before sending.'}
              </p>

              {/* Attention-grabbing callout for the file the user has
                  to attach. Amber outline (matches the caution palette
                  used elsewhere) plus the readable text-xs path so
                  even on small displays the user can see what to
                  drag. The Open folder button reuses the Button
                  primitive — no freehand styling. */}
              {(diagnosticZipPath || logPath) && (
                <div className="w-full rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 flex flex-col gap-2 text-left">
                  <span className="text-xs font-medium text-foreground">File to attach:</span>
                  <code className="block px-2 py-1.5 rounded bg-background border border-border text-xs text-foreground break-all">
                    {diagnosticZipPath ?? logPath}
                  </code>
                  <Button
                    size="sm"
                    onClick={() => {
                      const target = diagnosticZipPath ?? logPath;
                      if (target) void revealInFolder(target);
                    }}
                    className="self-center"
                  >
                    <FolderOpen className="w-4 h-4 mr-1.5" />
                    Open folder
                  </Button>
                </div>
              )}

              {/* No-mail-client fallback. mailto: relies on the OS
                  having a default mail handler — many users don't
                  (webmail-only, no Outlook installed). The explicit
                  support address + manual-attach instruction means
                  the user always has a path forward even if
                  shell.openExternal silently fails. */}
              <p className="text-xs text-muted-foreground italic max-w-sm">
                Mail client didn't open? Email{' '}
                <a
                  href="mailto:admin@photodaterescue.com"
                  className="text-foreground font-medium underline"
                >
                  admin@photodaterescue.com
                </a>{' '}
                manually and attach the file above.
              </p>
            </div>
          )}
        </div>

        <div className="border-t border-border px-4 py-3 flex items-center justify-end gap-2">
          {/* "Open log folder" power-user button removed entirely —
              it taught users that the log was what they had to attach,
              which contradicts the actual flow (the diagnostic ZIP is
              the single artefact they ever need to send). The
              success state has its own Open-folder Button that
              targets the ZIP in Documents. If a power user really
              wants the raw log path it's still in main.log inside
              the ZIP and surfaced in About PDR. */}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-foreground hover:bg-accent">
              {sentOk ? 'Done' : 'Cancel'}
            </button>
            {!sentOk && (
              <button
                onClick={handleSend}
                disabled={sending || !description.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 hover:bg-primary/90"
              >
                <Send className="w-3.5 h-3.5" />
                {sending ? 'Opening…' : 'Send'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
