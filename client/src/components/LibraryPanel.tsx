import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  X,
  FolderOpen,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  HardDrive,
  Pencil,
  Eye,
  Plug,
  PlugZap,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLicense } from '@/contexts/LicenseContext';

// LibraryPanel — the user-facing surface for the library-portable DB
// feature. Visual vocabulary intentionally mirrors ManageDevicesModal
// (gradient header, motion'd icon tile, license-key verification
// sub-step) so the two modals feel like siblings.
//
// Flows it owns:
//   - View current library status (connected path, sync status, writer
//     device, this device's read/write role)
//   - Connect to a library: pick a folder → detect sidecar → branch
//     (Restore from existing OR Set as new) → license-key gate where
//     needed → processing → success
//   - Take over writing (if currently read-only): license-key verify →
//     processing → success
//   - Disconnect this device from the library

interface LibraryStatus {
  attached: boolean;
  libraryRoot: string | null;
  thisDeviceId: string;
  isWriter: boolean;
  writerDeviceName: string | null;
  writerDeviceId: string | null;
  sidecarPresent: boolean;
  lastAttachedAt: string | null;
}

interface SidecarDetection {
  found: boolean;
  dbExists: boolean;
  dbSizeBytes: number;
  lockExists: boolean;
  lock: any | null;
  auditExists: boolean;
  snapshotCount: number;
}

interface DriveTypeInfo {
  driveType: 'fixed' | 'removable' | 'network' | 'unknown';
  isSafeForLibrary: boolean;
  reason: string;
}

type Step =
  | 'status'
  | 'picker-loading'
  | 'detected-existing'
  | 'detected-empty'
  | 'drive-unsafe'
  | 'verify-key'
  | 'processing'
  | 'success'
  | 'error';

type PendingAction =
  | { kind: 'attachFromSidecar'; libraryRoot: string }
  | { kind: 'attachAsNew'; libraryRoot: string }
  | { kind: 'takeOverWriter' };

interface LibraryPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatBytes(n: number): string {
  if (!n || n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function LibraryPanel({ isOpen, onClose }: LibraryPanelProps) {
  const { storedLicenseKey } = useLicense();
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [step, setStep] = useState<Step>('status');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [pendingDetection, setPendingDetection] = useState<SidecarDetection | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string>('');
  // Auto-suggest: when the user already has a destination drive set and it's
  // external/network, surface it as a one-click "use this as my Library Drive"
  // option on the status screen instead of forcing the folder-picker dance.
  const [suggestedPath, setSuggestedPath] = useState<string | null>(null);
  const [suggestedDriveInfo, setSuggestedDriveInfo] = useState<DriveTypeInfo | null>(null);
  // Stores the "this drive is internal, pick something external" reason when
  // the user picks an unsafe folder. Drives the drive-unsafe step.
  const [unsafeReason, setUnsafeReason] = useState<string | null>(null);

  const refreshStatus = async () => {
    try {
      const res = await (window as any).pdr?.library?.status();
      if (res?.success) setStatus(res.data as LibraryStatus);
    } catch (e) {
      console.warn('[LibraryPanel] status refresh failed:', e);
    }
  };

  const refreshSuggestion = async () => {
    try {
      // pdr.settings.get() returns the raw settings object (NOT a
      // { success, data } wrapper — that's only the convention for
      // operations that can fail). destinationPath is the field that
      // (in the user's mental model) IS their Library Drive.
      const settings = await (window as any).pdr?.settings?.get();
      const destPath = (settings && typeof settings.destinationPath === 'string') ? settings.destinationPath : undefined;
      if (!destPath) {
        setSuggestedPath(null);
        setSuggestedDriveInfo(null);
        return;
      }
      setSuggestedPath(destPath);
      const driveRes = await (window as any).pdr?.library?.detectDriveType(destPath);
      if (driveRes?.success) {
        setSuggestedDriveInfo(driveRes.data as DriveTypeInfo);
      } else {
        setSuggestedDriveInfo(null);
      }
    } catch (e) {
      console.warn('[LibraryPanel] suggestion refresh failed:', e);
    }
  };

  useEffect(() => {
    if (isOpen) {
      refreshStatus();
      refreshSuggestion();
      setStep('status');
      setPendingAction(null);
      setPendingDetection(null);
      setKeyInput('');
      setKeyError(null);
      setErrorMsg(null);
      setUnsafeReason(null);
    }
  }, [isOpen]);

  const handleClose = () => {
    setStep('status');
    setPendingAction(null);
    setPendingDetection(null);
    setKeyInput('');
    setKeyError(null);
    setErrorMsg(null);
    onClose();
  };

  // Inspect a path: confirm it's a safe drive type (external / network), then
  // detect whether a sidecar already exists there → branch to restore vs.
  // set-as-new. Internal drives short-circuit to the drive-unsafe explainer.
  const inspectAndRoute = async (path: string) => {
    setStep('picker-loading');
    try {
      const driveRes = await (window as any).pdr?.library?.detectDriveType(path);
      if (driveRes?.success) {
        const info = driveRes.data as DriveTypeInfo;
        if (!info.isSafeForLibrary) {
          setUnsafeReason(info.reason);
          setStep('drive-unsafe');
          return;
        }
      }
      const res = await (window as any).pdr?.library?.detectSidecar(path);
      if (!res?.success) {
        setErrorMsg(res?.error || 'Could not inspect that folder.');
        setStep('error');
        return;
      }
      const detection = res.data as SidecarDetection;
      setPendingDetection(detection);
      if (detection.dbExists) {
        setPendingAction({ kind: 'attachFromSidecar', libraryRoot: path });
        setStep('detected-existing');
      } else {
        setPendingAction({ kind: 'attachAsNew', libraryRoot: path });
        setStep('detected-empty');
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStep('error');
    }
  };

  const handleConnectClick = async () => {
    const path: string | null = await (window as any).pdr?.openFolder?.();
    if (!path) return;
    await inspectAndRoute(path);
  };

  const handleUseSuggestedPath = async () => {
    if (!suggestedPath) return;
    await inspectAndRoute(suggestedPath);
  };

  const handleTakeOverClick = () => {
    setPendingAction({ kind: 'takeOverWriter' });
    setKeyInput('');
    setKeyError(null);
    setStep('verify-key');
  };

  const handleDisconnect = async () => {
    setStep('processing');
    setErrorMsg(null);
    try {
      const res = await (window as any).pdr?.library?.disconnect();
      if (res?.success) {
        setSuccessMsg('This device is no longer linked to a library.');
        setStep('success');
        await refreshStatus();
      } else {
        setErrorMsg(res?.error || 'Could not disconnect.');
        setStep('error');
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStep('error');
    }
  };

  const runPendingAction = async () => {
    if (!pendingAction || !storedLicenseKey) return;
    setStep('processing');
    setErrorMsg(null);
    try {
      const deviceName = (status?.thisDeviceId?.slice(0, 8) || 'this') + '-device';
      let res: any;
      if (pendingAction.kind === 'attachAsNew') {
        res = await (window as any).pdr?.library?.attachAsNew({
          libraryRoot: pendingAction.libraryRoot,
          licenseKey: storedLicenseKey,
          deviceName,
        });
        if (res?.success) setSuccessMsg('Library set up. PDR will keep a hidden mirror on this drive so any device can reconnect instantly.');
      } else if (pendingAction.kind === 'attachFromSidecar') {
        res = await (window as any).pdr?.library?.attachFromSidecar({
          libraryRoot: pendingAction.libraryRoot,
          licenseKey: storedLicenseKey,
          deviceName,
        });
        if (res?.success) setSuccessMsg('Library restored. All your faces, names, dates and trees are back. Restart PDR to refresh views.');
      } else if (pendingAction.kind === 'takeOverWriter') {
        if (!status?.libraryRoot) {
          setErrorMsg('No library attached.');
          setStep('error');
          return;
        }
        res = await (window as any).pdr?.library?.takeOverWriter({
          libraryRoot: status.libraryRoot,
          licenseKey: storedLicenseKey,
          deviceName,
        });
        if (res?.success) setSuccessMsg('This device is now the writer for the library.');
      }
      if (res?.success) {
        setStep('success');
        await refreshStatus();
      } else {
        setErrorMsg(res?.error || 'Action failed.');
        setStep('error');
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStep('error');
    }
  };

  const handleConfirmKey = () => {
    if (!storedLicenseKey) return;
    if (keyInput.trim().toUpperCase() !== storedLicenseKey.trim().toUpperCase()) {
      setKeyError('That key does not match the licence on this device.');
      return;
    }
    setKeyError(null);
    void runPendingAction();
  };

  if (!isOpen) return null;

  // ─── Renderers ───────────────────────────────────────────────────────────
  const renderHeader = (title: string, subtitle?: React.ReactNode, palette: 'primary' | 'rose' | 'emerald' = 'primary', subtitleAlign: 'center' | 'left' | 'justify' = 'center') => {
    const subtitleAlignClass = subtitleAlign === 'left' ? 'text-left' : subtitleAlign === 'justify' ? 'text-justify' : '';
    const gradient = palette === 'rose'
      ? 'from-rose-100 via-rose-50 to-transparent dark:from-rose-950/40 dark:via-rose-950/20'
      : palette === 'emerald'
      ? 'from-emerald-100 via-emerald-50 to-transparent dark:from-emerald-950/40 dark:via-emerald-950/20'
      : 'from-primary/15 via-primary/5 to-transparent';
    const iconWrap = palette === 'rose'
      ? 'from-rose-200 to-rose-50 border-rose-300/60 shadow-rose-500/10 dark:from-rose-700 dark:to-rose-900'
      : palette === 'emerald'
      ? 'from-emerald-200 to-emerald-50 border-emerald-300/60 shadow-emerald-500/10 dark:from-emerald-700 dark:to-emerald-900'
      : 'from-primary/20 to-primary/5 border-primary/20 shadow-primary/10';
    const iconColor = palette === 'rose'
      ? 'text-rose-600 dark:text-rose-400'
      : palette === 'emerald'
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-primary';
    const Icon = palette === 'rose' ? AlertTriangle : palette === 'emerald' ? CheckCircle2 : HardDrive;
    return (
      <div className={`relative bg-gradient-to-br ${gradient} px-6 pt-8 pb-6`}>
        <button onClick={handleClose} className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors" aria-label="Close">
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
        <div className="flex flex-col items-center text-center">
          <motion.div initial={{ scale: 0, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ delay: 0.1, type: 'spring', stiffness: 200 }} className={`w-16 h-16 bg-gradient-to-br ${iconWrap} rounded-2xl flex items-center justify-center mb-4 border shadow-lg`}>
            <Icon className={`w-8 h-8 ${iconColor}`} />
          </motion.div>
          <h2 className="text-h1 text-foreground mb-2">{title}</h2>
          {subtitle && <p className={`text-body-muted max-w-sm ${subtitleAlignClass}`}>{subtitle}</p>}
        </div>
      </div>
    );
  };

  const renderStatus = () => {
    const attached = status?.attached;
    const isWriter = !!status?.isWriter;
    const writerLabel = isWriter ? 'You are the writer' : (status?.writerDeviceName ? `${status.writerDeviceName} is the writer` : 'Read-only');
    return (
      <>
        {attached
          ? renderHeader('Your library', 'PDR keeps a hidden copy of your face / name / date data on this drive so any of your devices can reconnect instantly.')
          : renderHeader(
              'Set up your library',
              <>
                <span className="block mb-2"><strong className="text-foreground font-medium">First-time setup.</strong> Your library isn't connected on this device yet.</span>
                <span className="block mb-2">Pick any external storage — USB stick, external SSD or HDD, SD card, Thunderbolt / USB-C / FireWire drive, or a NAS / network share. PDR will keep a hidden copy of your face, name, date and Trees data there, so if you switch PCs or your current one is lost, a new install can reconnect to that drive and everything comes straight back.</span>
                <span className="block"><strong className="text-foreground font-medium">Internal drives can't be used</strong> — they'd go with your PC if it's lost or stolen.</span>
              </>,
              'primary',
              'justify',
            )}
        <div className="px-6 pb-6 pt-2 space-y-3">
          {attached && status?.libraryRoot && (
            <div className="rounded-xl border border-primary/40 bg-primary/5 p-4">
              <div className="flex items-center gap-2 mb-1.5">
                <FolderOpen className="w-4 h-4 text-primary" />
                <p className="text-h2 text-foreground truncate">{status.libraryRoot}</p>
              </div>
              <p className="text-caption ml-6">{writerLabel}</p>
              <div className="ml-6 mt-2 flex items-center gap-2">
                {isWriter ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 text-label">
                    <Pencil className="w-3 h-3" /> Read &amp; write
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 text-label">
                    <Eye className="w-3 h-3" /> Read-only
                  </span>
                )}
              </div>
            </div>
          )}
          {/* Auto-suggest: if the user's existing Library Drive (formerly
              "destination") is set and lives on external / network storage,
              offer it as a one-click setup. Internal drives are deliberately
              not auto-suggested — they'd defeat the recovery purpose. */}
          {!attached && suggestedPath && suggestedDriveInfo?.isSafeForLibrary && (
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3">
              <div>
                <p className="text-h2 text-foreground">Use your existing Library Drive?</p>
                <p className="text-caption mt-1 break-all">{suggestedPath}</p>
                <p className="text-caption mt-1.5">{suggestedDriveInfo.reason}</p>
              </div>
              <Button onClick={handleUseSuggestedPath} variant="primary" className="w-full h-10">
                <Plug className="w-4 h-4 mr-2" /> Set this as my Library Drive
              </Button>
            </div>
          )}

          {/* If the existing Library Drive is internal — common on
              fresh installs where someone pointed PDR at C:\Photos — show
              a calm note explaining why we're not auto-suggesting it. */}
          {!attached && suggestedPath && suggestedDriveInfo && !suggestedDriveInfo.isSafeForLibrary && (
            <div className="rounded-xl border border-amber-300/40 bg-amber-50 dark:bg-amber-950/20 p-4">
              <p className="text-h2 text-foreground mb-1">Your current Library Drive is internal</p>
              <p className="text-caption break-all mb-1.5">{suggestedPath}</p>
              <p className="text-caption">{suggestedDriveInfo.reason}</p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 pt-1">
            <Button onClick={handleConnectClick} variant="primary" className="w-full h-11">
              <Plug className="w-4 h-4 mr-2" />
              {attached ? 'Connect to a different library' : (suggestedPath && suggestedDriveInfo?.isSafeForLibrary ? 'Pick a different drive' : 'Connect external drive or NAS')}
            </Button>
            {attached && !isWriter && (
              <Button onClick={handleTakeOverClick} variant="secondary" className="w-full h-11">
                <Pencil className="w-4 h-4 mr-2" />
                Take over writing
              </Button>
            )}
            {attached && (
              <Button onClick={handleDisconnect} variant="information" className="w-full h-10">
                <PlugZap className="w-4 h-4 mr-2" />
                Disconnect this device from the library
              </Button>
            )}
          </div>
        </div>
      </>
    );
  };

  const renderDetectedExisting = () => (
    <>
      {renderHeader('Existing PDR library found', 'Restore everything on this device — faces, names, dates, family trees, and your recent backup history. Your local data will be replaced; we keep a safety copy first.', 'emerald')}
      <div className="px-6 pb-6 pt-2 space-y-3">
        {pendingDetection && (
          <div className="rounded-xl border border-border bg-background/60 p-3 text-caption space-y-1">
            <div>Database: <span className="text-foreground">{formatBytes(pendingDetection.dbSizeBytes)}</span></div>
            <div>Recent snapshots in library: <span className="text-foreground">{pendingDetection.snapshotCount}</span></div>
            <div>Edit history: <span className="text-foreground">{pendingDetection.auditExists ? 'present' : 'not present'}</span></div>
            {pendingDetection.lock && (
              <div>Last writer: <span className="text-foreground">{pendingDetection.lock.writerDeviceName}</span></div>
            )}
          </div>
        )}
        <Button onClick={() => { setKeyInput(''); setKeyError(null); setStep('verify-key'); }} variant="caution" className="w-full h-12">
          <RotateCcw className="w-4 h-4 mr-2" /> Restore from this library
        </Button>
        <Button onClick={() => setStep('status')} variant="secondary" className="w-full">Cancel</Button>
      </div>
    </>
  );

  const renderDetectedEmpty = () => (
    <>
      {renderHeader('Set up a new library here?', 'No existing PDR library data on this folder. Setting it up will copy your current local database into a hidden .pdr folder here so a future device can reconnect instantly.')}
      <div className="px-6 pb-6 pt-2 space-y-3">
        <Button onClick={runPendingAction} variant="primary" className="w-full h-12">
          <Plug className="w-4 h-4 mr-2" /> Set as my library
        </Button>
        <Button onClick={() => setStep('status')} variant="secondary" className="w-full">Cancel</Button>
      </div>
    </>
  );

  const renderVerifyKey = () => (
    <>
      {renderHeader('Confirm with your license key', 'Enter your PDR license key to authorise this action. The same key gates every device-level change.', 'rose')}
      <div className="px-6 pb-6 pt-2 space-y-4">
        <div>
          <label className="block text-label text-foreground mb-2">License key</label>
          <input
            type="text"
            value={keyInput}
            onChange={(e) => { setKeyInput(e.target.value); setKeyError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmKey(); }}
            placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
            className="w-full px-4 py-3 rounded-lg border border-border bg-background text-foreground font-mono text-center tracking-wider focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            autoFocus
          />
          {keyError && (
            <div className="flex items-start gap-2 mt-3 p-3 bg-rose-50 dark:bg-rose-950/30 rounded-lg border border-rose-200 dark:border-rose-800">
              <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 flex-shrink-0 mt-0.5" />
              <p className="text-body text-rose-800 dark:text-rose-300">{keyError}</p>
            </div>
          )}
        </div>
        <Button onClick={handleConfirmKey} disabled={!keyInput.trim()} variant="primary" className="w-full h-12">
          Continue
        </Button>
        <Button onClick={() => setStep(pendingAction?.kind === 'takeOverWriter' ? 'status' : (pendingDetection?.dbExists ? 'detected-existing' : 'detected-empty'))} variant="secondary" className="w-full">Go back</Button>
      </div>
    </>
  );

  const renderProcessing = () => (
    <div className="px-6 py-12 flex flex-col items-center text-center gap-4">
      <Loader2 className="w-10 h-10 text-primary animate-spin" />
      <p className="text-h2 text-foreground">Working...</p>
    </div>
  );

  const renderSuccess = () => (
    <>
      {renderHeader('Done', successMsg, 'emerald')}
      <div className="px-6 pb-6 pt-2 space-y-3">
        <Button onClick={handleClose} variant="primary" className="w-full h-12">Close</Button>
      </div>
    </>
  );

  const renderError = () => (
    <>
      {renderHeader('Something went wrong', errorMsg ?? undefined, 'rose')}
      <div className="px-6 pb-6 pt-2 space-y-3">
        <Button onClick={() => setStep('status')} variant="secondary" className="w-full h-12">Back to library</Button>
      </div>
    </>
  );

  const renderDriveUnsafe = () => (
    <>
      {renderHeader('Pick a different drive', unsafeReason ?? 'This drive is not suitable for a Library Drive.', 'rose')}
      <div className="px-6 pb-6 pt-2 space-y-3">
        <Button onClick={handleConnectClick} variant="primary" className="w-full h-12">
          <Plug className="w-4 h-4 mr-2" /> Pick another drive
        </Button>
        <Button onClick={() => setStep('status')} variant="secondary" className="w-full h-12">Cancel</Button>
      </div>
    </>
  );

  return (
    <div className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="w-full max-w-md bg-background rounded-2xl shadow-2xl overflow-hidden border border-border"
      >
        {step === 'status' && renderStatus()}
        {step === 'picker-loading' && renderProcessing()}
        {step === 'detected-existing' && renderDetectedExisting()}
        {step === 'detected-empty' && renderDetectedEmpty()}
        {step === 'drive-unsafe' && renderDriveUnsafe()}
        {step === 'verify-key' && renderVerifyKey()}
        {step === 'processing' && renderProcessing()}
        {step === 'success' && renderSuccess()}
        {step === 'error' && renderError()}
      </motion.div>
    </div>
  );
}
