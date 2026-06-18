import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Smartphone, Wifi, Copy, Check, Loader2, AlertTriangle, Download } from 'lucide-react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';

interface PhoneShareStatus {
  active: boolean;
  url?: string;
  ip?: string;
  port?: number;
  fileCount?: number;
  downloads?: number;
  expiresAt?: number;
}

interface SendToPhoneModalProps {
  /** Absolute file paths to share. Non-null ⇒ open. */
  paths: string[] | null;
  onClose: () => void;
}

/**
 * v2.1 round 279 (Terry) — Sharing Phase 2: "Send to Phone" over local Wi-Fi.
 *
 * When opened with a selection, asks main to spin up a short-lived LAN server
 * (electron/phone-share.ts) and renders a QR code of its URL. The phone — on the
 * SAME Wi-Fi — scans it, opens a little page, and pulls the photos straight off
 * the PC. No cloud, no account, nothing leaves the local network: the on-ethos
 * answer to "get these onto my phone for Instagram / WhatsApp".
 *
 * Lifecycle: start() on open, poll status() for the live download count, and
 * stop() the server on close/unmount so the port never lingers. Mirrors the
 * PDR modal recipe (framer-motion overlay + `Button` primitive, same as
 * TrialLimitModal) rather than a Dialog primitive.
 */
export function SendToPhoneModal({ paths, onClose }: SendToPhoneModalProps) {
  const isOpen = !!paths && paths.length > 0;

  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [qr, setQr] = useState('');
  const [status, setStatus] = useState<PhoneShareStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isOpen || !paths) return;
    let cancelled = false;
    setPhase('loading');
    setError('');
    setQr('');
    setStatus(null);
    setCopied(false);

    (async () => {
      try {
        const api = (window as any).pdr?.phoneShare;
        if (!api?.start) { setError('Sharing is unavailable in this build.'); setPhase('error'); return; }
        const res = await api.start(paths);
        if (cancelled) return;
        if (!res?.success || !res.data?.url) {
          setError(res?.error || 'Could not start the share.');
          setPhase('error');
          return;
        }
        const url: string = res.data.url;
        setStatus(res.data);
        const dataUrl = await QRCode.toDataURL(url, {
          width: 320,
          margin: 1,
          errorCorrectionLevel: 'M',
          color: { dark: '#16162e', light: '#ffffff' },
        });
        if (cancelled) return;
        setQr(dataUrl);
        setPhase('ready');
        // Live download counter.
        pollRef.current = setInterval(async () => {
          try {
            const st = await api.status();
            if (st?.success && st.data) setStatus(st.data);
          } catch { /* transient */ }
        }, 2500);
      } catch (e) {
        if (!cancelled) { setError((e as Error)?.message || 'Could not start the share.'); setPhase('error'); }
      }
    })();

    return () => {
      cancelled = true;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      // Tear the server down when the modal closes.
      try { (window as any).pdr?.phoneShare?.stop?.(); } catch { /* ignore */ }
    };
  }, [isOpen, paths]);

  if (!isOpen) return null;

  const url = status?.url || '';
  const count = status?.fileCount ?? (paths?.length || 0);
  const downloads = status?.downloads ?? 0;

  const copyLink = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — the visible URL is the fallback */ }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: 'spring', duration: 0.5, bounce: 0.3 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-background rounded-2xl shadow-2xl max-w-md w-full border border-border overflow-hidden"
        >
          {/* Header */}
          <div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-transparent px-6 pt-8 pb-6">
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
            <div className="flex flex-col items-center text-center">
              <motion.div
                initial={{ scale: 0, rotate: -20 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ delay: 0.1, type: 'spring', stiffness: 200 }}
                className="w-16 h-16 bg-gradient-to-br from-primary/20 to-primary/5 rounded-2xl flex items-center justify-center mb-4 border border-primary/20 shadow-lg shadow-primary/10"
              >
                <Smartphone className="w-8 h-8 text-primary" />
              </motion.div>
              <h2 className="text-xl font-semibold text-foreground mb-2">Send to Phone</h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {count} {count === 1 ? 'photo' : 'photos'} · stays on your Wi-Fi, never uploaded
              </p>
            </div>
          </div>

          {/* Content */}
          <div className="px-6 pb-6 pt-2">
            {phase === 'loading' && (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Loader2 className="w-8 h-8 text-primary animate-spin mb-3" />
                <p className="text-sm text-muted-foreground">Starting local share…</p>
              </div>
            )}

            {phase === 'error' && (
              <div className="flex flex-col items-center text-center py-6">
                <div className="w-12 h-12 rounded-2xl bg-amber-100 border border-amber-300/60 flex items-center justify-center mb-3">
                  <AlertTriangle className="w-6 h-6 text-amber-600" />
                </div>
                <p className="text-sm text-foreground/80 leading-relaxed mb-5 max-w-xs">{error}</p>
                <Button onClick={onClose} variant="secondary" className="w-full">Close</Button>
              </div>
            )}

            {phase === 'ready' && (
              <div className="space-y-4">
                {/* QR on a white card so it scans regardless of app theme. */}
                <div className="flex justify-center">
                  <div className="bg-white p-3 rounded-2xl shadow-inner border border-border/60">
                    {qr ? (
                      <img src={qr} alt="Scan to download on your phone" className="w-[200px] h-[200px] block" />
                    ) : (
                      <div className="w-[200px] h-[200px] flex items-center justify-center">
                        <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
                      </div>
                    )}
                  </div>
                </div>

                {/* Steps */}
                <ol className="text-[13px] text-foreground/80 space-y-1.5">
                  <li className="flex gap-2">
                    <span className="flex-none w-5 h-5 rounded-full bg-primary/15 text-primary text-[11px] font-semibold flex items-center justify-center">1</span>
                    <span>Make sure your phone is on the <strong className="font-semibold text-foreground">same Wi-Fi</strong> as this PC.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex-none w-5 h-5 rounded-full bg-primary/15 text-primary text-[11px] font-semibold flex items-center justify-center">2</span>
                    <span>Open the <strong className="font-semibold text-foreground">camera</strong> and point it at the code.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex-none w-5 h-5 rounded-full bg-primary/15 text-primary text-[11px] font-semibold flex items-center justify-center">3</span>
                    <span>Tap the link, then <strong className="font-semibold text-foreground">save</strong> the photos.</span>
                  </li>
                </ol>

                {/* Link + copy (manual fallback if the camera won't scan) */}
                {url && (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2">
                    <Wifi className="w-3.5 h-3.5 text-muted-foreground flex-none" />
                    <span className="text-[12px] text-muted-foreground font-mono truncate flex-1" title={url}>{url}</span>
                    <button
                      onClick={copyLink}
                      className="flex-none inline-flex items-center gap-1 text-[12px] font-medium text-primary hover:opacity-80 transition-opacity"
                    >
                      {copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
                    </button>
                  </div>
                )}

                {/* Live download indicator */}
                {downloads > 0 && (
                  <div className="flex items-center justify-center gap-1.5 text-[12px] font-medium text-[var(--color-gold)]">
                    <Download className="w-3.5 h-3.5" />
                    {downloads} download{downloads === 1 ? '' : 's'} so far
                  </div>
                )}

                <Button onClick={onClose} className="w-full">Done</Button>
                <p className="text-xs text-muted-foreground/70 text-center leading-relaxed">
                  Keep this open while your phone downloads — closing stops the share. If your phone can’t connect, allow Photo Date Rescue through Windows Firewall.
                </p>
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
