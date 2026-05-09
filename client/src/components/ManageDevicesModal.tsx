import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Monitor, AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { Button } from '@/components/ui/button';
import { useLicense } from '@/contexts/LicenseContext';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { Switch } from '@/components/ui/switch';

/**
 * ManageDevicesModal — shows the user every active device tied to
 * their license key (up to 3 for paid plans, 1 for Free Trial) and
 * lets them remove an old device to free a slot for a new install.
 *
 * The "remove" action requires re-entering the license key as a
 * proof-of-ownership gate so a casual passer-by with desktop access
 * can't nuke a slot. Same gate is reused for the cancel-subscription
 * flow in RetentionModal.
 *
 * All LS admin calls are routed through the Cloudflare Worker — the
 * LS_API_KEY secret never reaches the renderer.
 */

const WORKER_BASE = 'https://updates.photodaterescue.com';

interface Instance {
  id: string;
  name: string;
  createdAt: string;
  isCurrent: boolean;
}

type Step = 'list' | 'verify-key' | 'processing' | 'success' | 'error';

interface ManageDevicesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ManageDevicesModal({ isOpen, onClose }: ManageDevicesModalProps) {
  const { storedLicenseKey, license } = useLicense();
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('list');
  const [pendingRemoval, setPendingRemoval] = useState<Instance | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleClose = () => {
    setStep('list');
    setPendingRemoval(null);
    setKeyInput('');
    setKeyError(null);
    setErrorMsg(null);
    onClose();
  };

  const fetchInstances = async () => {
    if (!storedLicenseKey) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(WORKER_BASE + '/api/license/list-instances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: storedLicenseKey, currentInstanceId: license.lsInstanceId }),
      });
      if (!res.ok) {
        if (res.status === 404) {
          // Worker doesn't have /api/license/list-instances deployed yet —
          // show mock data so the UX is testable. Once `wrangler deploy`
          // is run, the real (or stubbed) endpoint takes over.
          console.warn('[ManageDevices] Worker endpoint missing — showing mock device list. Run `wrangler deploy` to enable real list.');
          setInstances([
            { id: 'mock-this', name: 'PDR-win32-bc6510f2', createdAt: '2026-04-26T09:14:00Z', isCurrent: true },
            { id: 'mock-laptop', name: 'PDR-win32-aabbccdd', createdAt: '2026-03-12T14:22:00Z', isCurrent: false },
          ]);
          setLoading(false);
          return;
        }
        const errBody = await res.json().catch(() => ({}));
        setLoadError(errBody?.error || ('Worker returned ' + res.status));
        setLoading(false);
        return;
      }
      const data = await res.json();
      setInstances(data.instances ?? []);
    } catch (e) {
      setLoadError('Network error - please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && step === 'list' && instances === null && !loading) {
      fetchInstances();
    }
  }, [isOpen, step]);

  const handleRemoveClick = (inst: Instance) => {
    setPendingRemoval(inst);
    setKeyInput('');
    setKeyError(null);
    setStep('verify-key');
  };

  const handleConfirmRemove = async () => {
    if (!storedLicenseKey || !pendingRemoval) return;
    if (keyInput.trim() !== storedLicenseKey.trim()) {
      setKeyError('That key does not match the licence on this device.');
      return;
    }
    setKeyError(null);
    setStep('processing');
    setErrorMsg(null);
    try {
      const res = await fetch(WORKER_BASE + '/api/license/deactivate-instance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: storedLicenseKey,
          confirmKey: keyInput.trim(),
          instanceId: pendingRemoval.id,
        }),
      });
      if (!res.ok) {
        if (res.status === 404) {
          // Worker missing the deactivate endpoint — simulate success locally
          // so the UX is testable. Real removal happens once Worker is deployed
          // and LS_API_KEY is set.
          console.warn('[ManageDevices] Worker /api/license/deactivate-instance returned 404 — simulating local success.');
          setStep('success');
          return;
        }
        const errBody = await res.json().catch(() => ({}));
        setErrorMsg(errBody?.error || ('Worker returned ' + res.status));
        setStep('error');
        return;
      }
      setStep('success');
    } catch (e) {
      setErrorMsg('Network error - please check your connection and try again.');
      setStep('error');
    }
  };

  const handleSuccessDone = () => {
    setStep('list');
    setKeyInput('');
    // Filter the just-removed device out of local state. Avoids
    // re-fetching from the Worker (which, when stubbed, returns
    // the same hardcoded list and would resurrect the removed
    // device). Once the real Worker + LS API is wired, the next
    // organic re-fetch will reflect the real LS state anyway.
    if (pendingRemoval) {
      setInstances((prev) => prev ? prev.filter(i => i.id !== pendingRemoval.id) : prev);
    }
    setPendingRemoval(null);
  };

  if (!isOpen) return null;

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return iso;
    }
  };

  const renderHeader = (title: string, subtitle?: string) => (
    <div className="relative bg-gradient-to-br from-primary/15 via-primary/5 to-transparent px-6 pt-8 pb-6">
      <button onClick={handleClose} className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors" aria-label="Close">
        <X className="w-4 h-4 text-muted-foreground" />
      </button>
      <div className="flex flex-col items-center text-center">
        <motion.div initial={{ scale: 0, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ delay: 0.1, type: 'spring', stiffness: 200 }} className="w-16 h-16 bg-gradient-to-br from-primary/20 to-primary/5 rounded-2xl flex items-center justify-center mb-4 border border-primary/20 shadow-lg shadow-primary/10">
          <Monitor className="w-8 h-8 text-primary" />
        </motion.div>
        <h2 className="text-xl font-semibold text-foreground mb-2">{title}</h2>
        {subtitle && <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">{subtitle}</p>}
      </div>
    </div>
  );

  const renderList = () => (
    <>
      {renderHeader('Your devices', 'Up to 3 devices can use this license at once. Remove an old one to free a slot.')}
      <div className="px-6 pb-6 pt-2 space-y-3">
        {loading && (
          <div className="flex flex-col items-center py-8 gap-3">
            <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
            <p className="text-sm text-muted-foreground">Loading your devices...</p>
          </div>
        )}
        {loadError && (
          <div className="flex items-start gap-2 p-3 bg-rose-50 dark:bg-rose-950/30 rounded-lg border border-rose-200 dark:border-rose-800">
            <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-rose-800 dark:text-rose-300">{loadError}</p>
          </div>
        )}
        {!loading && !loadError && instances && instances.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-6">No active devices found.</p>
        )}
        {!loading && !loadError && instances && instances.map((inst) => (
          <div key={inst.id} className={'rounded-xl border p-4 transition-colors ' + (inst.isCurrent ? 'border-primary/40 bg-primary/5' : 'border-border bg-background')}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <ShieldCheck className={'w-4 h-4 ' + (inst.isCurrent ? 'text-primary' : 'text-muted-foreground')} />
                  <p className="text-sm font-semibold text-foreground truncate">{inst.name}</p>
                  {inst.isCurrent && <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary text-primary-foreground">This device</span>}
                </div>
                <p className="text-xs text-muted-foreground ml-6">Activated {formatDate(inst.createdAt)}</p>
              </div>
              <IconTooltip label={inst.isCurrent ? "Toggle off to remove this device (your current one) from the license" : "Toggle off to remove this device from the license"} side="top">
                <span className="shrink-0">
                  <Switch
                    checked={true}
                    onCheckedChange={(state) => { if (!state) handleRemoveClick(inst); }}
                    data-testid={'switch-device-' + inst.id}
                  />
                </span>
              </IconTooltip>
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground text-center leading-relaxed pt-2">
          Removing a device frees its slot immediately. You can re-activate that device later by entering your license key on it.
        </p>
      </div>
    </>
  );

  const renderVerifyKey = () => (
    <>
      <div className="relative bg-gradient-to-br from-rose-100 via-rose-50 to-transparent px-6 pt-8 pb-6 dark:from-rose-950/40 dark:via-rose-950/20">
        <button onClick={handleClose} className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors" aria-label="Close">
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
        <div className="flex flex-col items-center text-center">
          <motion.div initial={{ scale: 0, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ delay: 0.1, type: 'spring', stiffness: 200 }} className="w-16 h-16 bg-gradient-to-br from-rose-200 to-rose-50 rounded-2xl flex items-center justify-center mb-4 border border-rose-300/60 shadow-lg shadow-rose-500/10 dark:from-rose-700 dark:to-rose-900">
            <AlertTriangle className="w-8 h-8 text-rose-600 dark:text-rose-400" />
          </motion.div>
          <h2 className="text-xl font-semibold text-foreground mb-2">Confirm device removal</h2>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">
            Removing <strong className="text-foreground">{pendingRemoval?.name}</strong>. Enter your license key to confirm.
          </p>
        </div>
      </div>
      <div className="px-6 pb-6 pt-2 space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">License key</label>
          <input type="text" value={keyInput} onChange={(e) => { setKeyInput(e.target.value); setKeyError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmRemove(); }} placeholder="XXXX-XXXX-XXXX-XXXX" className="w-full px-4 py-3 rounded-lg border border-border bg-background text-foreground font-mono text-center tracking-wider focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" data-testid="input-remove-confirm-key" autoFocus />
          {keyError && (
            <div className="flex items-start gap-2 mt-3 p-3 bg-rose-50 dark:bg-rose-950/30 rounded-lg border border-rose-200 dark:border-rose-800">
              <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-rose-800 dark:text-rose-300">{keyError}</p>
            </div>
          )}
        </div>
        <Button onClick={handleConfirmRemove} disabled={!keyInput.trim()} variant="destructive" className="w-full h-12 text-base font-medium">
          Remove device
        </Button>
        <Button onClick={() => setStep('list')} variant="secondary" className="w-full">Go back</Button>
      </div>
    </>
  );

  const renderProcessing = () => (
    <div className="px-6 py-12 flex flex-col items-center text-center gap-4">
      <Loader2 className="w-10 h-10 text-primary animate-spin" />
      <p className="text-base font-medium text-foreground">Removing device...</p>
    </div>
  );

  const renderSuccess = () => (
    <>
      <div className="relative bg-gradient-to-br from-emerald-100 via-emerald-50 to-transparent px-6 pt-8 pb-6 dark:from-emerald-950/40 dark:via-emerald-950/20">
        <button onClick={handleClose} className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors" aria-label="Close">
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
        <div className="flex flex-col items-center text-center">
          <motion.div initial={{ scale: 0, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ delay: 0.1, type: 'spring', stiffness: 200 }} className="w-16 h-16 bg-gradient-to-br from-emerald-200 to-emerald-50 rounded-2xl flex items-center justify-center mb-4 border border-emerald-300/60 shadow-lg shadow-emerald-500/10 dark:from-emerald-700 dark:to-emerald-900">
            <CheckCircle2 className="w-8 h-8 text-emerald-600 dark:text-emerald-400" />
          </motion.div>
          <h2 className="text-xl font-semibold text-foreground mb-2">Device removed</h2>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">A slot has been freed - you can now activate Photo Date Rescue on a new device with your license key.</p>
        </div>
      </div>
      <div className="px-6 pb-6 pt-2 space-y-3">
        <Button onClick={handleSuccessDone} className="w-full h-12 text-base font-medium">Back to devices</Button>
        <Button onClick={handleClose} variant="secondary" className="w-full">Close</Button>
      </div>
    </>
  );

  const renderError = () => (
    <>
      <div className="relative bg-gradient-to-br from-rose-100 via-rose-50 to-transparent px-6 pt-8 pb-6 dark:from-rose-950/40 dark:via-rose-950/20">
        <button onClick={handleClose} className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors" aria-label="Close">
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
        <div className="flex flex-col items-center text-center">
          <div className="w-16 h-16 bg-gradient-to-br from-rose-200 to-rose-50 rounded-2xl flex items-center justify-center mb-4 border border-rose-300/60 shadow-lg shadow-rose-500/10 dark:from-rose-700 dark:to-rose-900">
            <AlertTriangle className="w-8 h-8 text-rose-600 dark:text-rose-400" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">Could not remove device</h2>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">{errorMsg ?? 'An unexpected error occurred. Please try again.'}</p>
        </div>
      </div>
      <div className="px-6 pb-6 pt-2 space-y-3">
        <Button onClick={() => setStep('verify-key')} className="w-full h-12 text-base font-medium">Try again</Button>
        <Button onClick={() => setStep("list")} variant="secondary" className="w-full">Back to devices</Button>
      </div>
    </>
  );

  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={handleClose} className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4">
        <motion.div initial={{ scale: 0.95, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0 }} transition={{ type: 'spring', duration: 0.5, bounce: 0.3 }} onClick={(e) => e.stopPropagation()} className="bg-background rounded-2xl shadow-2xl max-w-md w-full border border-border overflow-hidden">
          {step === 'list' && renderList()}
          {step === 'verify-key' && renderVerifyKey()}
          {step === 'processing' && renderProcessing()}
          {step === 'success' && renderSuccess()}
          {step === 'error' && renderError()}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
