import { useEffect, useState } from 'react';
import { X, Send, ExternalLink, AlertTriangle, Check } from 'lucide-react';
import { reportProblem, getLogFilePath } from '@/lib/electron-bridge';

interface ReportProblemModalProps {
  onClose: () => void;
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
export function ReportProblemModal({ onClose }: ReportProblemModalProps) {
  const [description, setDescription] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sentOk, setSentOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logPath, setLogPath] = useState<string | null>(null);

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
      } else {
        setError(r.error ?? 'Could not open your mail client. Please send a message to admin@photodaterescue.com manually.');
      }
    } finally {
      setSending(false);
    }
  };

  const handleRevealLog = async () => {
    await getLogFilePath(true);
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
                Briefly describe what went wrong. We'll include your system info and a
                recent extract of the log automatically — you just need to drag the log
                file into the email when your mail client opens.
              </p>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">What happened?</span>
                <textarea
                  autoFocus
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="E.g. The app crashed at 33% while analysing a Google Takeout zip."
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
              {logPath && (
                <div className="text-[11px] text-muted-foreground pt-1 border-t border-border/60">
                  <p>Your log file is stored at:</p>
                  <code className="block mt-1 px-2 py-1 rounded bg-muted text-foreground break-all text-[10px]">{logPath}</code>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center text-center gap-2 py-6">
              <div className="w-12 h-12 rounded-full bg-emerald-500/15 flex items-center justify-center">
                <Check className="w-6 h-6 text-emerald-600" />
              </div>
              <h4 className="text-sm font-semibold text-foreground">Your mail client should be opening</h4>
              <p className="text-xs text-muted-foreground max-w-sm">
                We've also opened the folder containing your log file — please drag{' '}
                <code className="px-1 rounded bg-muted">main.log</code> into the email as
                an attachment before sending.
              </p>
              {logPath && (
                <code className="mt-2 px-2 py-1 rounded bg-muted text-[10px] text-foreground break-all w-full">
                  {logPath}
                </code>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border px-4 py-3 flex items-center justify-between gap-2">
          <button
            onClick={handleRevealLog}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open log folder
          </button>
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
