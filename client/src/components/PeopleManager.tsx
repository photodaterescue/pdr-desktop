import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  X,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Trash2,
  Eye,
  Users,
  Tag,
  Sparkles,
  Pencil,
  Check,
  UserX,
  LayoutList,
  Grid3X3,
  Undo2,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
  Info,
  ImageIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent, PopoverAnchor } from '@/components/ui/popover';
import {
  getPersonClusters,
  listPersons,
  namePerson,
  unnameFace,
  assignFace,
  setRepresentativeFace,
  getClusterFaces,
  getFaceCrop,
  getFaceContext,
  deletePersonRecord,
  permanentlyDeletePerson,
  restorePerson,
  listDiscardedPersons,
  renamePerson,
  reclusterFaces,
  getSettings,
  setSetting,
  type PersonCluster,
  type PersonRecord,
  type DiscardedPerson,
  type ClusterFacesResult,
  getVisualSuggestions,
} from '@/lib/electron-bridge';

// ─── Notify main window that data changed ─────────────────────────────────
function notifyChange() {
  if ((window as any).pdr?.people?.notifyChange) {
    (window as any).pdr.people.notifyChange();
  }
}

// ─── Main People Manager (standalone page, not modal) ─────────────────────
export default function PeopleManager() {
  const [activeTab, setActiveTab] = useState<'named' | 'unnamed' | 'unsure' | 'ignored'>('named');
  const [viewMode, setViewMode] = useState<'list' | 'card'>('card');
  const [zoomLevel, setZoomLevel] = useState(() => {
    const saved = localStorage.getItem('pdr-people-zoom');
    return saved ? parseInt(saved, 10) : 100;
  });
  const [clusters, setClusters] = useState<PersonCluster[]>([]);
  const [discardedPersons, setDiscardedPersons] = useState<DiscardedPerson[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [faceCropsMap, setFaceCropsMap] = useState<Record<string, string>>({});
  const [editingCluster, setEditingCluster] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [existingPersons, setExistingPersons] = useState<PersonRecord[]>([]);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<{ personId: number; personName: string; photoCount: number } | null>(null);
  const [confirmPermanentDelete, setConfirmPermanentDelete] = useState<{ personId: number; personName: string } | null>(null);
  const [pendingIgnore, setPendingIgnore] = useState<string | null>(null);
  const [pendingUnsure, setPendingUnsure] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [clusterThreshold, setClusterThreshold] = useState(0.70);
  const [isReclustering, setIsReclustering] = useState(false);
  const [showUnverifiedOnly, setShowUnverifiedOnly] = useState(false);

  // Cross-row face selection state (shared across all PersonCardRow instances)
  const [globalSelectedFaces, setGlobalSelectedFaces] = useState<Set<number>>(new Set());
  const [globalReassignFaceId, setGlobalReassignFaceId] = useState<number | null>(null);
  const [globalReassignName, setGlobalReassignName] = useState('');
  const [panelSuggestionIdx, setPanelSuggestionIdx] = useState(-1);

  // Load saved threshold from settings on mount
  useEffect(() => {
    (async () => {
      const settings = await getSettings();
      if (settings?.matchThreshold != null) {
        setClusterThreshold(settings.matchThreshold);
      }
    })();
  }, []);

  const clusterKey = (c: PersonCluster) => {
    // Special categories share one person_id, so use cluster_id to keep them separate
    if (c.person_name === '__ignored__' || c.person_name === '__unsure__') return `c${c.cluster_id}`;
    return c.person_id ? `p${c.person_id}` : `c${c.cluster_id}`;
  };

  const loadClusters = async () => {
    setIsLoading(true);
    const result = await getPersonClusters();
    if (result.success && result.data) {
      setClusters(result.data);
      const crops: Record<string, string> = {};
      await Promise.all(result.data.map(async (cluster) => {
        const key = clusterKey(cluster);
        if (cluster.sample_faces) {
          for (const face of cluster.sample_faces) {
            const crop = await getFaceCrop(face.file_path, face.box_x, face.box_y, face.box_w, face.box_h, 64);
            if (crop.success && crop.dataUrl) crops[face.face_id] = crop.dataUrl;
          }
        }
      }));
      setFaceCropsMap(crops);
    }
    const persons = await listPersons();
    if (persons.success && persons.data) setExistingPersons(persons.data);
    const discarded = await listDiscardedPersons();
    if (discarded.success && discarded.data) setDiscardedPersons(discarded.data);
    setIsLoading(false);
  };

  useEffect(() => { loadClusters(); }, []);

  useEffect(() => {
    if (!isLoading) {
      const named = clusters.filter(c => c.person_name && c.person_name !== '__ignored__' && c.person_name !== '__unsure__');
      const unnamed = clusters.filter(c => !c.person_name);
      if (activeTab === 'named' && named.length === 0 && unnamed.length > 0) {
        setActiveTab('unnamed');
      }
    }
  }, [isLoading, clusters]);

  // Ctrl+scroll zoom
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoomLevel(prev => {
          const next = Math.max(60, Math.min(150, prev + (e.deltaY < 0 ? 5 : -5)));
          localStorage.setItem('pdr-people-zoom', String(next));
          return next;
        });
      }
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, []);

  const handleNameCluster = async (clusterId: number, name: string) => {
    if (!name.trim()) return;
    setEditingCluster(null);
    setNameInput('');
    const result = await namePerson(name.trim(), clusterId);
    if (result.success) { await loadClusters(); notifyChange(); }
  };

  const handleRename = async (personId: number, newName: string) => {
    if (!newName.trim()) return;
    await renamePerson(personId, newName.trim());
    setEditingCluster(null); setNameInput('');
    await loadClusters(); notifyChange();
  };

  const handleDiscardPerson = async (personId: number) => {
    await deletePersonRecord(personId);
    setConfirmDiscard(null);
    await loadClusters(); notifyChange();
  };

  const handleRecluster = async (threshold: number) => {
    setIsReclustering(true);
    // Persist the threshold to settings
    await setSetting('matchThreshold', threshold);
    await reclusterFaces(threshold);
    await loadClusters();
    notifyChange();
    setIsReclustering(false);
  };

  const handleIgnoreCluster = async (clusterId: number) => {
    await namePerson('__ignored__', clusterId);
    setPendingIgnore(null);
    await loadClusters(); notifyChange();
  };

  const handleUnsureCluster = async (clusterId: number) => {
    await namePerson('__unsure__', clusterId);
    setPendingUnsure(null);
    await loadClusters(); notifyChange();
  };

  const handleRestoreToUnnamed = async (clusterId: number, personId: number | null) => {
    if (personId) {
      await deletePersonRecord(personId);
      await loadClusters(); notifyChange();
    }
  };

  const handleRestorePerson = async (personId: number) => {
    await restorePerson(personId);
    await loadClusters(); notifyChange();
  };

  const handlePermanentDelete = async (personId: number) => {
    await permanentlyDeletePerson(personId);
    setConfirmPermanentDelete(null);
    await loadClusters(); notifyChange();
  };

  const handleReassignFace = async (faceId: number, newName: string, verified: boolean = true, skipReload: boolean = false) => {
    if (newName === '__unnamed__') {
      await unnameFace(faceId);
      if (!skipReload) { await loadClusters(); notifyChange(); }
      return;
    }
    const personResult = await namePerson(newName);
    if (personResult.success && personResult.data?.personId) {
      await assignFace(faceId, personResult.data.personId, verified);
      if (!skipReload) { await loadClusters(); notifyChange(); }
    }
  };

  const handleSetRepresentative = async (personId: number, faceId: number) => {
    await setRepresentativeFace(personId, faceId);
    await loadClusters(); notifyChange();
  };

  const namedClusters = clusters.filter(c => c.person_name && c.person_name !== '__ignored__' && c.person_name !== '__unsure__');
  const unnamedClusters = clusters.filter(c => !c.person_name);
  const ignoredClusters = clusters.filter(c => c.person_name === '__ignored__');
  const unsureClusters = clusters.filter(c => c.person_name === '__unsure__');

  const prepareFaces = (cluster: PersonCluster): PersonCluster => {
    if (!cluster.sample_faces) return cluster;
    let faces = [...cluster.sample_faces].sort((a, b) => (a.verified || 0) - (b.verified || 0));
    if (showUnverifiedOnly) faces = faces.filter(f => !f.verified);
    return { ...cluster, sample_faces: faces };
  };

  const filteredNamed = (searchFilter
    ? namedClusters.filter(c => c.person_name?.toLowerCase().includes(searchFilter.toLowerCase()))
    : namedClusters
  ).map(prepareFaces);

  const tabCounts = {
    named: namedClusters.length,
    unnamed: unnamedClusters.length,
    unsure: unsureClusters.length,
    ignored: ignoredClusters.length,
  };

  const pmTabClass = (tab: string) =>
    `flex-1 text-center px-3 py-2.5 text-sm font-medium cursor-pointer transition-all duration-200 border-b-2 ${
      activeTab === tab
        ? 'border-purple-500 text-purple-600 dark:text-purple-400 bg-background'
        : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 bg-muted/40'
    } ${tab === 'named' ? 'rounded-tl-lg' : ''} ${tab === 'ignored' ? 'rounded-tr-lg' : ''}`;

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">

      {/* Header — below the title bar */}
      <div className="flex items-center justify-between px-6 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-purple-500/10 flex items-center justify-center">
            <Users className="w-4 h-4 text-purple-500" />
          </div>
          <h2 className="text-base font-semibold text-foreground">People</h2>
          <span className="text-[11px] text-muted-foreground">
            {namedClusters.length} named · {unnamedClusters.length} unnamed
            {unsureClusters.length > 0 && ` · ${unsureClusters.length} unsure`}
            {ignoredClusters.length > 0 && ` · ${ignoredClusters.length} ignored`}
          </span>
        </div>
        <div className="flex flex-col items-center flex-1 mx-4 max-w-[220px]">
          <span className="text-[11px] text-foreground/60 font-semibold uppercase tracking-wider mb-0.5">Match</span>
          <div className="flex items-center gap-2 w-full">
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">0%</span>
            <div className="relative flex-1">
              <input
                type="range"
                min="0.55"
                max="0.90"
                step="0.01"
                value={clusterThreshold}
                onChange={(e) => setClusterThreshold(parseFloat(e.target.value))}
                onMouseUp={() => handleRecluster(clusterThreshold)}
                onTouchEnd={() => handleRecluster(clusterThreshold)}
                className="w-full h-1 accent-purple-500 cursor-pointer relative z-10"
                title={`Match: ${Math.round(((clusterThreshold - 0.55) / 0.35) * 100)}%`}
                disabled={isReclustering}
              />
              {/* Tick marks at 25%, 50%, 75% */}
              <div className="absolute top-1/2 left-0 right-0 flex justify-between px-[2px] pointer-events-none" style={{ transform: 'translateY(-50%)' }}>
                <div className="w-px h-2 bg-transparent" /> {/* 0% spacer */}
                <div className="w-px h-2.5 bg-muted-foreground/25" /> {/* 25% */}
                <div className="w-px h-2.5 bg-muted-foreground/25" /> {/* 50% */}
                <div className="w-px h-2.5 bg-muted-foreground/25" /> {/* 75% */}
                <div className="w-px h-2 bg-transparent" /> {/* 100% spacer */}
              </div>
            </div>
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">100%</span>
          </div>
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex border-b border-border mx-6 mb-0">
        <div className="flex flex-1">
          <button type="button" className={pmTabClass('named')} onClick={() => { setActiveTab('named'); setSearchFilter(''); }}>
            <span className="flex items-center justify-center gap-1.5">
              Named
              {tabCounts.named > 0 && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400">{tabCounts.named}</span>}
            </span>
          </button>
          <div className="w-px bg-border/60 my-2" />
          <button type="button" className={pmTabClass('unnamed')} onClick={() => { setActiveTab('unnamed'); setSearchFilter(''); }}>
            <span className="flex items-center justify-center gap-1.5">
              Unnamed
              {tabCounts.unnamed > 0 && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">{tabCounts.unnamed}</span>}
            </span>
          </button>
          <div className="w-px bg-border/60 my-2" />
          <button type="button" className={pmTabClass('unsure')} onClick={() => { setActiveTab('unsure'); setSearchFilter(''); }}>
            <span className="flex items-center justify-center gap-1.5">
              Unsure
              {tabCounts.unsure > 0 && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">{tabCounts.unsure}</span>}
            </span>
          </button>
          <div className="w-px bg-border/60 my-2" />
          <button type="button" className={pmTabClass('ignored')} onClick={() => { setActiveTab('ignored'); setSearchFilter(''); }}>
            <span className="flex items-center justify-center gap-1.5">
              Ignored
              {tabCounts.ignored > 0 && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-[#76899F]/20 text-[#76899F]">{tabCounts.ignored}</span>}
            </span>
          </button>
        </div>
        <div className="flex items-center gap-2 pb-1">
          {activeTab === 'named' && (
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchFilter}
                onChange={e => setSearchFilter(e.target.value)}
                placeholder="Filter..."
                className="pl-8 pr-3 py-1 text-xs rounded-md border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/50 w-[120px] focus:outline-none focus:ring-1 focus:ring-purple-400/50"
              />
              {searchFilter && (
                <button onClick={() => setSearchFilter('')} className="absolute right-2 top-1/2 -translate-y-1/2">
                  <X className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </div>
          )}
          {activeTab === 'named' && (
            <button
              onClick={() => setShowUnverifiedOnly(!showUnverifiedOnly)}
              className={`p-1 rounded transition-all ${showUnverifiedOnly ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-500' : 'text-muted-foreground hover:text-foreground'}`}
              title={showUnverifiedOnly ? 'Showing unverified only' : 'Show all faces'}
            >
              <Eye className="w-3.5 h-3.5" />
            </button>
          )}
          {(activeTab === 'named' || activeTab === 'unnamed') && (
            <div className="flex items-center bg-secondary/40 rounded-md p-0.5">
              <button
                onClick={() => setViewMode('card')}
                className={`p-1 rounded transition-all ${viewMode === 'card' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                title="Card view"
              >
                <Grid3X3 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1 rounded transition-all ${viewMode === 'list' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                title="List view"
              >
                <LayoutList className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Main content area — scrollable content + optional side panel */}
      <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 pt-4 pb-6" style={{ zoom: `${zoomLevel}%` }}>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
            <span className="ml-2 text-sm text-muted-foreground">Loading face clusters...</span>
          </div>
        ) : clusters.length === 0 && discardedPersons.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Users className="w-12 h-12 text-muted-foreground/20 mb-3" />
            <h3 className="text-sm font-semibold text-foreground mb-1">No faces detected yet</h3>
            <p className="text-xs text-muted-foreground max-w-xs">
              Run AI analysis on your photos to detect faces. Similar faces will be automatically grouped together.
            </p>
          </div>
        ) : (
          <>
            {/* Discard confirmation banner */}
            {confirmDiscard && (
              <div className="rounded-xl border border-amber-300/60 dark:border-amber-700/40 bg-amber-50/50 dark:bg-amber-950/20 p-4 mb-4">
                <div className="flex items-start gap-3 mb-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="text-sm font-semibold text-foreground mb-1">Discard "{confirmDiscard.personName}"?</h4>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      This will remove the name from <strong>{confirmDiscard.photoCount} photo{confirmDiscard.photoCount !== 1 ? 's' : ''}</strong> and send {confirmDiscard.photoCount === 1 ? 'it' : 'them'} to the Unnamed tab.
                      Face detections are kept — you can re-name faces later.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-8">
                  <button onClick={() => handleDiscardPerson(confirmDiscard.personId)} className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium transition-colors">
                    Discard
                  </button>
                  <button onClick={() => setConfirmDiscard(null)} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* ─── NAMED TAB ─── */}
            {activeTab === 'named' && (
              <>
{filteredNamed.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Users className="w-10 h-10 text-muted-foreground/20 mb-3" />
                    <h3 className="text-sm font-medium text-foreground mb-1">
                      {searchFilter ? 'No matches' : 'No named people yet'}
                    </h3>
                    <p className="text-xs text-muted-foreground max-w-xs">
                      {searchFilter ? `No names matching "${searchFilter}".` : 'Switch to the Unnamed tab to start naming detected faces.'}
                    </p>
                  </div>
                ) : viewMode === 'card' ? (
                  <div className="space-y-2">
                    {filteredNamed.map((cluster, idx) => (
                      <PersonCardRow
                        rowIndex={idx}
                        key={clusterKey(cluster)}
                        cluster={cluster}
                        cropUrl={faceCropsMap[clusterKey(cluster)]}
                        sampleCrops={faceCropsMap}
                        isEditing={editingCluster === clusterKey(cluster)}
                        nameInput={nameInput}
                        onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(cluster.person_name || ''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                        onNameChange={setNameInput}
                        onSubmit={() => cluster.person_id ? handleRename(cluster.person_id, nameInput) : handleNameCluster(cluster.cluster_id, nameInput)}
                        onCancel={() => { setEditingCluster(null); setNameInput(''); }}
                        inputRef={nameInputRef}
                        existingPersons={existingPersons}
                        onSelectPerson={(name) => handleNameCluster(cluster.cluster_id, name)}
                        onDiscard={cluster.person_id ? () => { setConfirmDiscard({ personId: cluster.person_id!, personName: cluster.person_name!, photoCount: cluster.photo_count }); } : undefined}
                        onReassignFace={handleReassignFace}
                        onSetRepresentative={cluster.person_id ? (faceId) => handleSetRepresentative(cluster.person_id!, faceId) : undefined}
                        globalSelectedFaces={globalSelectedFaces}
                        onGlobalSelectionChange={setGlobalSelectedFaces}
                        globalReassignFaceId={globalReassignFaceId}
                        onGlobalReassignChange={(id, name) => { setGlobalReassignFaceId(id); setGlobalReassignName(name); }}
                        globalReassignName={globalReassignName}
                        onGlobalReassignNameChange={setGlobalReassignName}
                        currentTab={activeTab}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {filteredNamed.map((cluster, idx) => (
                      <PersonListRow
                        key={clusterKey(cluster)} cluster={cluster} cropUrl={faceCropsMap[clusterKey(cluster)]} sampleCrops={faceCropsMap}
                        isEditing={editingCluster === clusterKey(cluster)} nameInput={nameInput}
                        onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(cluster.person_name || ''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                        onNameChange={setNameInput}
                        onSubmit={() => cluster.person_id ? handleRename(cluster.person_id, nameInput) : handleNameCluster(cluster.cluster_id, nameInput)}
                        onCancel={() => { setEditingCluster(null); setNameInput(''); }}
                        inputRef={nameInputRef}
                        onDiscard={cluster.person_id ? () => { setConfirmDiscard({ personId: cluster.person_id!, personName: cluster.person_name!, photoCount: cluster.photo_count }); } : undefined}
                      />
                    ))}
                  </div>
                )}
              </>
            )}

            {/* ─── UNNAMED TAB ─── */}
            {activeTab === 'unnamed' && (
              <>
                {unnamedClusters.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <CheckCircle2 className="w-10 h-10 text-green-400/40 mb-3" />
                    <h3 className="text-sm font-medium text-foreground mb-1">All groups are named</h3>
                    <p className="text-xs text-muted-foreground max-w-xs">Every detected face group has been assigned a name, marked unsure, or ignored.</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start gap-3 p-3 rounded-xl bg-purple-50/50 dark:bg-purple-950/20 border border-purple-200/30 dark:border-purple-800/20 mb-4">
                      <Sparkles className="w-4 h-4 text-purple-500 shrink-0 mt-0.5" />
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Click a group to name it. Don't recognise someone? Use <strong>Unsure</strong> to revisit later, or <strong>Ignore</strong> to hide them permanently.
                      </p>
                    </div>
                    {viewMode === 'card' ? (
                      <div className="space-y-2">
                        {unnamedClusters.map((cluster, idx) => (
                          <PersonCardRow
                            rowIndex={idx}
                            key={clusterKey(cluster)}
                            cluster={cluster}
                            cropUrl={faceCropsMap[clusterKey(cluster)]}
                            sampleCrops={faceCropsMap}
                            isEditing={editingCluster === clusterKey(cluster)}
                            nameInput={nameInput}
                            onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                            onNameChange={setNameInput}
                            onSubmit={() => handleNameCluster(cluster.cluster_id, nameInput)}
                            onCancel={() => { setEditingCluster(null); setNameInput(''); }}
                            inputRef={nameInputRef}
                            existingPersons={existingPersons}
                            onSelectPerson={(name) => handleNameCluster(cluster.cluster_id, name)}
                            pendingIgnore={pendingIgnore === clusterKey(cluster)}
                            onIgnore={() => setPendingIgnore(clusterKey(cluster))}
                            onConfirmIgnore={() => handleIgnoreCluster(cluster.cluster_id)}
                            onCancelIgnore={() => setPendingIgnore(null)}
                            pendingUnsure={pendingUnsure === clusterKey(cluster)}
                            onUnsure={() => setPendingUnsure(clusterKey(cluster))}
                            onConfirmUnsure={() => handleUnsureCluster(cluster.cluster_id)}
                            onCancelUnsure={() => setPendingUnsure(null)}
                            onReassignFace={handleReassignFace}
                            globalSelectedFaces={globalSelectedFaces}
                            onGlobalSelectionChange={setGlobalSelectedFaces}
                            globalReassignFaceId={globalReassignFaceId}
                            onGlobalReassignChange={(id, name) => { setGlobalReassignFaceId(id); setGlobalReassignName(name); }}
                            globalReassignName={globalReassignName}
                            onGlobalReassignNameChange={setGlobalReassignName}
                            currentTab={activeTab}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        {unnamedClusters.map((cluster) => (
                          <PersonListRow
                            key={clusterKey(cluster)} cluster={cluster} cropUrl={faceCropsMap[clusterKey(cluster)]} sampleCrops={faceCropsMap}
                            isEditing={editingCluster === clusterKey(cluster)} nameInput={nameInput}
                            onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                            onNameChange={setNameInput}
                            onSubmit={() => handleNameCluster(cluster.cluster_id, nameInput)}
                            onCancel={() => { setEditingCluster(null); setNameInput(''); }}
                            inputRef={nameInputRef}
                            pendingIgnore={pendingIgnore === clusterKey(cluster)}
                            onIgnore={() => setPendingIgnore(clusterKey(cluster))}
                            onConfirmIgnore={() => handleIgnoreCluster(cluster.cluster_id)}
                            onCancelIgnore={() => setPendingIgnore(null)}
                            pendingUnsure={pendingUnsure === clusterKey(cluster)}
                            onUnsure={() => setPendingUnsure(clusterKey(cluster))}
                            onConfirmUnsure={() => handleUnsureCluster(cluster.cluster_id)}
                            onCancelUnsure={() => setPendingUnsure(null)}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {/* ─── UNSURE TAB ─── */}
            {activeTab === 'unsure' && (
              <>
                {unsureClusters.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <HelpCircle className="w-10 h-10 text-muted-foreground/20 mb-3" />
                    <h3 className="text-sm font-medium text-foreground mb-1">No unsure faces</h3>
                    <p className="text-xs text-muted-foreground max-w-xs">
                      Faces you mark as "Unsure" from the Unnamed tab will appear here so you can revisit them later.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start gap-3 p-3 rounded-xl bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200/30 dark:border-blue-800/20 mb-4">
                      <HelpCircle className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        These are faces you weren't sure about. Click to name them, or move them to Ignored if you'll never know.
                      </p>
                    </div>
                    <div className="space-y-2">
                      {unsureClusters.map((cluster, idx) => (
                        <PersonCardRow
                          rowIndex={idx}
                          key={clusterKey(cluster)}
                          cluster={cluster}
                          cropUrl={faceCropsMap[clusterKey(cluster)]}
                          sampleCrops={faceCropsMap}
                          isEditing={editingCluster === clusterKey(cluster)}
                          nameInput={nameInput}
                          onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                          onNameChange={setNameInput}
                          onSubmit={() => handleNameCluster(cluster.cluster_id, nameInput)}
                          onCancel={() => { setEditingCluster(null); setNameInput(''); }}
                          inputRef={nameInputRef}
                          existingPersons={existingPersons}
                          onSelectPerson={(name) => handleNameCluster(cluster.cluster_id, name)}
                          pendingIgnore={pendingIgnore === clusterKey(cluster)}
                          onIgnore={() => setPendingIgnore(clusterKey(cluster))}
                          onConfirmIgnore={() => handleIgnoreCluster(cluster.cluster_id)}
                          onCancelIgnore={() => setPendingIgnore(null)}
                          onRestore={() => handleRestoreToUnnamed(cluster.cluster_id, cluster.person_id)}
                          onReassignFace={handleReassignFace}
                          globalSelectedFaces={globalSelectedFaces}
                          onGlobalSelectionChange={setGlobalSelectedFaces}
                          globalReassignFaceId={globalReassignFaceId}
                          onGlobalReassignChange={(id, name) => { setGlobalReassignFaceId(id); setGlobalReassignName(name); }}
                          globalReassignName={globalReassignName}
                          onGlobalReassignNameChange={setGlobalReassignName}
                          currentTab={activeTab}
                        />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {/* ─── IGNORED TAB ─── */}
            {activeTab === 'ignored' && (
              <>
                {ignoredClusters.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <UserX className="w-10 h-10 text-muted-foreground/20 mb-3" />
                    <h3 className="text-sm font-medium text-foreground mb-1">No ignored faces</h3>
                    <p className="text-xs text-muted-foreground max-w-xs">
                      Faces you ignore from the Unnamed tab will appear here. You can restore them or delete permanently.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start gap-3 p-3 rounded-xl bg-slate-50/50 dark:bg-slate-900/20 border border-slate-200/30 dark:border-slate-700/20 mb-4">
                      <Info className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        These faces have been ignored. You can restore them back to Unnamed, or delete them permanently.
                      </p>
                    </div>
                    <div className="space-y-2">
                      {ignoredClusters.map((cluster, idx) => (
                        <PersonCardRow
                          rowIndex={idx}
                          key={clusterKey(cluster)}
                          cluster={cluster}
                          cropUrl={faceCropsMap[clusterKey(cluster)]}
                          sampleCrops={faceCropsMap}
                          isEditing={editingCluster === clusterKey(cluster)}
                          nameInput={nameInput}
                          onStartEdit={() => { setEditingCluster(clusterKey(cluster)); setNameInput(''); setTimeout(() => nameInputRef.current?.focus(), 50); }}
                          onNameChange={setNameInput}
                          onSubmit={() => handleNameCluster(cluster.cluster_id, nameInput)}
                          onCancel={() => { setEditingCluster(null); setNameInput(''); }}
                          inputRef={nameInputRef}
                          existingPersons={existingPersons}
                          onSelectPerson={(name) => handleNameCluster(cluster.cluster_id, name)}
                          onRestore={() => handleRestoreToUnnamed(cluster.cluster_id, cluster.person_id)}
                          onDiscard={cluster.person_id ? () => setConfirmPermanentDelete({ personId: cluster.person_id!, personName: 'Ignored face group' }) : undefined}
                          onReassignFace={handleReassignFace}
                          globalSelectedFaces={globalSelectedFaces}
                          onGlobalSelectionChange={setGlobalSelectedFaces}
                          globalReassignFaceId={globalReassignFaceId}
                          onGlobalReassignChange={(id, name) => { setGlobalReassignFaceId(id); setGlobalReassignName(name); }}
                          globalReassignName={globalReassignName}
                          onGlobalReassignNameChange={setGlobalReassignName}
                          currentTab={activeTab}
                        />
                      ))}
                    </div>
                  </>
                )}

                {confirmPermanentDelete && (
                  <div className="rounded-xl border border-red-300/60 dark:border-red-700/40 bg-red-50/50 dark:bg-red-950/20 p-4 mt-4">
                    <div className="flex items-start gap-3 mb-3">
                      <ShieldAlert className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                      <div>
                        <h4 className="text-sm font-semibold text-foreground mb-1">Permanently delete?</h4>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          This will permanently remove this face group and all associated AI data. This action cannot be undone.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-8">
                      <button onClick={() => handlePermanentDelete(confirmPermanentDelete.personId)} className="px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-xs font-medium transition-colors">
                        Permanently delete
                      </button>
                      <button onClick={() => setConfirmPermanentDelete(null)} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* ── Side panel — fixed action modal for face assignment ── */}
      {globalReassignFaceId !== null && (
        <div className="w-[280px] shrink-0 border-l border-border bg-background p-4 overflow-y-auto">
          <div className="space-y-2">
            {globalSelectedFaces.size > 1 && (
              <div className="bg-green-500 text-white text-xs font-medium text-center py-1 px-3 rounded-md">
                {globalSelectedFaces.size} faces selected
              </div>
            )}
            {faceCropsMap[globalReassignFaceId] && (
              <div className="flex justify-center">
                <img src={faceCropsMap[globalReassignFaceId]} alt="" className="w-16 h-16 rounded-full object-cover border-2 border-purple-400/40" />
              </div>
            )}
            {globalSelectedFaces.size <= 1 && (
              <p className="text-xs text-muted-foreground text-center">Choose an action for this face</p>
            )}
            <div className="relative">
              {(() => {
                const typed = globalReassignName.trim().toLowerCase();
                const panelSuggestions = typed.length > 0
                  ? existingPersons.filter(p => {
                      const name = p.name.toLowerCase();
                      // Hide suggestion if user has typed the exact full name
                      if (name === typed) return false;
                      return name.includes(typed) && (p.photo_count ?? 0) > 0;
                    }).slice(0, 5)
                  : [];
                return (
                  <>
                    <input
                      type="text"
                      value={globalReassignName}
                      onChange={(e) => { setGlobalReassignName(e.target.value); setPanelSuggestionIdx(-1); }}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown' && panelSuggestions.length > 0) {
                          e.preventDefault();
                          setPanelSuggestionIdx(prev => Math.min(prev + 1, panelSuggestions.length - 1));
                        } else if (e.key === 'ArrowUp' && panelSuggestions.length > 0) {
                          e.preventDefault();
                          setPanelSuggestionIdx(prev => Math.max(prev - 1, -1));
                        } else if (e.key === 'Enter') {
                          e.preventDefault();
                          let nameToUse = globalReassignName.trim();
                          if (panelSuggestionIdx >= 0 && panelSuggestions[panelSuggestionIdx]) {
                            nameToUse = panelSuggestions[panelSuggestionIdx].name;
                            setGlobalReassignName(nameToUse);
                            setPanelSuggestionIdx(-1);
                          }
                          if (!nameToUse) return;
                          const targets = Array.from(globalSelectedFaces);
                          if (targets.length === 0) return;
                          (async () => {
                            for (let i = 0; i < targets.length; i++) {
                              const isLast = i === targets.length - 1;
                              await handleReassignFace(targets[i], nameToUse, true, !isLast);
                            }
                            setGlobalReassignFaceId(null);
                            setGlobalReassignName('');
                            setGlobalSelectedFaces(new Set());
                            setPanelSuggestionIdx(-1);
                          })();
                        } else if (e.key === 'Escape') {
                          setGlobalReassignFaceId(null);
                          setGlobalReassignName('');
                          setGlobalSelectedFaces(new Set());
                          setPanelSuggestionIdx(-1);
                        }
                      }}
                      placeholder="Type person name..."
                      className="w-full text-sm px-2.5 py-1.5 rounded-lg border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                      autoFocus
                    />
                    {panelSuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-full mt-1 rounded-lg border border-border bg-background shadow-lg z-10 py-0.5">
                        {panelSuggestions.map((p, idx) => (
                          <button key={p.id} onMouseDown={(e) => { e.preventDefault(); setGlobalReassignName(p.name); setPanelSuggestionIdx(-1); }}
                            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs transition-colors text-left ${idx === panelSuggestionIdx ? 'bg-purple-200/70 dark:bg-purple-800/40' : 'hover:bg-purple-100/50 dark:hover:bg-purple-900/20'}`}>
                            <span className="truncate">{p.name}</span>
                            <span className="text-[9px] text-muted-foreground ml-auto shrink-0">{p.photo_count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
            {(() => {
              // Determine implicit name: if all selected faces belong to the same Named cluster, use its name
              const targets = Array.from(globalSelectedFaces);
              const targetClusters = targets.map(fid => clusters.find(c => c.sample_faces?.some(f => f.face_id === fid)));
              const allSameNamedCluster = targetClusters.length > 0
                && targetClusters.every(c => c && c.person_name && !c.person_name.startsWith('__') && c.person_id === targetClusters[0]?.person_id);
              const implicitName = allSameNamedCluster ? (targetClusters[0]?.person_name || '') : '';
              const effectiveName = globalReassignName.trim() || implicitName;
              return (
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      const t = Array.from(globalSelectedFaces);
                      if (t.length === 0 || !effectiveName) return;
                      (async () => {
                        for (let i = 0; i < t.length; i++) {
                          const isLast = i === t.length - 1;
                          await handleReassignFace(t[i], effectiveName, true, !isLast);
                        }
                        setGlobalReassignFaceId(null);
                        setGlobalReassignName('');
                        setGlobalSelectedFaces(new Set());
                      })();
                    }}
                    disabled={!effectiveName}
                    className="flex-1 px-2 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
                  >
                    Verify{globalSelectedFaces.size > 1 ? ` (${globalSelectedFaces.size})` : ''}
                  </button>
                  <button
                    onClick={() => { setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalSelectedFaces(new Set()); }}
                    className="px-2 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              );
            })()}
            <div className="flex gap-1.5 pt-1 border-t border-border">
              {activeTab !== 'unsure' && (
                <button onClick={() => {
                  const targets = Array.from(globalSelectedFaces);
                  if (targets.length === 0) return;
                  setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalSelectedFaces(new Set());
                  (async () => { for (let i = 0; i < targets.length; i++) await handleReassignFace(targets[i], '__unsure__', false, i < targets.length - 1); })();
                }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-blue-300/50 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-xs font-medium transition-colors">
                  <HelpCircle className="w-3 h-3" /> Unsure
                </button>
              )}
              {activeTab !== 'unnamed' && (
                <button onClick={() => {
                  const targets = Array.from(globalSelectedFaces);
                  if (targets.length === 0) return;
                  setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalSelectedFaces(new Set());
                  (async () => { for (let i = 0; i < targets.length; i++) await handleReassignFace(targets[i], '__unnamed__', false, i < targets.length - 1); })();
                }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-amber-300/50 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 text-xs font-medium transition-colors">
                  <Users className="w-3 h-3" /> Unnamed
                </button>
              )}
              {activeTab !== 'ignored' && (
                <button onClick={() => {
                  const targets = Array.from(globalSelectedFaces);
                  if (targets.length === 0) return;
                  setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalSelectedFaces(new Set());
                  (async () => { for (let i = 0; i < targets.length; i++) await handleReassignFace(targets[i], '__ignored__', false, i < targets.length - 1); })();
                }} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-slate-300/50 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/30 text-xs font-medium transition-colors">
                  <UserX className="w-3 h-3" /> Ignore
                </button>
              )}
            </div>
            {/* Set as main photo — only in Named tab with 1 face selected */}
            {activeTab === 'named' && globalSelectedFaces.size === 1 && (() => {
              // Find the cluster that owns this face
              const faceId = Array.from(globalSelectedFaces)[0];
              const ownerCluster = clusters.find(c => c.sample_faces?.some(f => f.face_id === faceId));
              if (!ownerCluster?.person_id) return null;
              return (
                <button
                  onClick={async () => {
                    await handleSetRepresentative(ownerCluster.person_id!, faceId);
                    setGlobalReassignFaceId(null); setGlobalReassignName(''); setGlobalSelectedFaces(new Set());
                  }}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-green-300/50 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 text-xs font-medium transition-colors"
                >
                  <ImageIcon className="w-3 h-3" /> Set as main photo
                </button>
              );
            })()}
          </div>
        </div>
      )}
      </div>{/* end flex wrapper */}

      {/* Footer status bar */}
      <div className="px-6 py-3 border-t border-border bg-muted/30 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {namedClusters.length} named · {unnamedClusters.length} unnamed · {unsureClusters.length} unsure · {ignoredClusters.length} ignored
          {isReclustering && <span className="ml-2 text-purple-500"><Loader2 className="w-3 h-3 animate-spin inline-block" /> Reclustering...</span>}
        </p>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <button onClick={() => { const z = Math.max(60, zoomLevel - 10); setZoomLevel(z); localStorage.setItem('pdr-people-zoom', String(z)); }} className="p-0.5 hover:text-foreground transition-colors">−</button>
          <span className="w-8 text-center">{zoomLevel}%</span>
          <button onClick={() => { const z = Math.min(150, zoomLevel + 10); setZoomLevel(z); localStorage.setItem('pdr-people-zoom', String(z)); }} className="p-0.5 hover:text-foreground transition-colors">+</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Face Grid Modal — paginated grid of all faces, confidence-sorted ──── */

function FaceGridModal({ cluster, cropUrl, existingPersons, onReassignFace, onSetRepresentative, onClose }: {
  cluster: PersonCluster;
  cropUrl?: string;
  existingPersons: PersonRecord[];
  onReassignFace: (faceId: number, newName: string, verified?: boolean) => Promise<void>;
  onSetRepresentative?: (faceId: number) => Promise<void>;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ClusterFacesResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [faceCrops, setFaceCrops] = useState<Record<number, string>>({});
  const [reassignFaceId, setReassignFaceId] = useState<number | null>(null);
  const [reassignName, setReassignName] = useState('');
  const reassignInputRef = useRef<HTMLInputElement>(null);
  const PER_PAGE = 40;

  const loadPage = async (p: number) => {
    setIsLoading(true);
    const result = await getClusterFaces(cluster.cluster_id, p, PER_PAGE, cluster.person_id ?? undefined);
    if (result.success && result.data) {
      setData(result.data);
      const crops: Record<number, string> = {};
      await Promise.all(result.data.faces.map(async (face) => {
        const crop = await getFaceCrop(face.file_path, face.box_x, face.box_y, face.box_w, face.box_h, 96);
        if (crop.success && crop.dataUrl) crops[face.face_id] = crop.dataUrl;
      }));
      setFaceCrops(prev => ({ ...prev, ...crops }));
    }
    setIsLoading(false);
  };

  useEffect(() => { loadPage(0); }, []);

  const handleReassign = async (faceId: number, name: string, verified: boolean = true) => {
    if (!name.trim()) return;
    await onReassignFace(faceId, name.trim(), verified);
    setReassignFaceId(null);
    setReassignName('');
    await loadPage(page);
  };

  // Visual similarity suggestions — loaded when popover opens
  const [visualSugs, setVisualSugs] = useState<{ personId: number; personName: string; similarity: number }[]>([]);
  const [visualSugsLoading, setVisualSugsLoading] = useState(false);

  useEffect(() => {
    if (reassignFaceId == null) { setVisualSugs([]); return; }
    let cancelled = false;
    setVisualSugsLoading(true);
    getVisualSuggestions(reassignFaceId).then(r => {
      if (!cancelled && r.success && r.data) setVisualSugs(r.data);
      if (!cancelled) setVisualSugsLoading(false);
    });
    return () => { cancelled = true; };
  }, [reassignFaceId]);

  const [reassignInputFocused, setReassignInputFocused] = useState(false);

  const reassignSuggestions = (() => {
    if (!reassignInputFocused) return [];
    const typed = reassignName.trim().toLowerCase();
    if (typed.length === 0) {
      return visualSugs
        .filter(v => v.similarity >= 0.70)
        .map(v => {
          const match = (existingPersons || []).find(p => p.id === v.personId);
          return { id: v.personId, name: v.personName, photo_count: match?.photo_count ?? 0 };
        });
    }
    const textMatches = (existingPersons || [])
      .filter(p => p.name.toLowerCase().includes(typed) && (p.photo_count ?? 0) > 0)
      .slice(0, 6);
    const visualMap = new Map(visualSugs.map(v => [v.personId, v.similarity]));
    return textMatches
      .map(p => ({ ...p, similarity: visualMap.get(p.id) ?? 0 }))
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .map(({ similarity, ...rest }) => rest)
      .slice(0, 5);
  })();

  const confidenceColor = (conf: number) => {
    if (conf >= 0.85) return 'text-green-500';
    if (conf >= 0.6) return 'text-amber-500';
    return 'text-red-500';
  };

  const confidenceLabel = (conf: number) => {
    if (conf >= 0.85) return 'High';
    if (conf >= 0.6) return 'Medium';
    return 'Low';
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-black/[0.35] backdrop-blur-[2px] flex items-center justify-center z-[60] p-4"
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-background rounded-2xl shadow-2xl max-w-3xl w-full p-6"
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              {cropUrl && <img src={cropUrl} alt="" className="w-10 h-10 rounded-full object-cover border-2 border-purple-400/40" />}
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  {cluster.person_name && cluster.person_name !== '__ignored__' && cluster.person_name !== '__unsure__'
                    ? cluster.person_name
                    : 'Unknown person'}
                </h2>
                <p className="text-[11px] text-muted-foreground">
                  {cluster.face_count} faces across {cluster.photo_count} photos · sorted by confidence (lowest first)
                </p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Grid */}
          <div className="h-[55vh] overflow-y-auto pr-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
                <span className="ml-2 text-sm text-muted-foreground">Loading faces...</span>
              </div>
            ) : data && data.faces.length > 0 ? (
              <div className="grid grid-cols-8 gap-2">
                {data.faces.map((face) => (
                  <Popover key={face.face_id} open={reassignFaceId === face.face_id} onOpenChange={(open) => { if (!open) { setReassignFaceId(null); setReassignName(''); } }}>
                    <PopoverTrigger asChild>
                      <div
                        className="relative group cursor-pointer"
                        onClick={() => { setReassignFaceId(face.face_id); setReassignName(''); setTimeout(() => reassignInputRef.current?.focus(), 100); }}
                      >
                        {faceCrops[face.face_id] ? (
                          <img src={faceCrops[face.face_id]} alt="" className={`w-full aspect-square rounded-lg object-cover hover:ring-2 hover:ring-purple-400/50 transition-all ${face.verified ? verifiedBorder : 'border border-border/50'}`} />
                        ) : (
                          <div className={`w-full aspect-square rounded-lg bg-secondary flex items-center justify-center ${face.verified ? verifiedBorder : ''}`}>
                            <Users className="w-4 h-4 text-muted-foreground/40" />
                          </div>
                        )}
                        <span className={`absolute bottom-0.5 right-0.5 text-[8px] font-bold px-1 py-0.5 rounded bg-background/80 backdrop-blur-sm ${confidenceColor(face.confidence)}`}>
                          {Math.round(face.confidence * 100)}%
                        </span>
                      </div>
                    </PopoverTrigger>
                    <PopoverContent side="top" align="center" className="min-w-[250px] max-w-[320px] w-auto p-3 z-[60]" onOpenAutoFocus={(e) => e.preventDefault()} collisionPadding={8}>
                      <div className="space-y-2">
                        {faceCrops[face.face_id] && (
                          <div className="flex justify-center">
                            <img src={faceCrops[face.face_id]} alt="" className="w-16 h-16 rounded-full object-cover border-2 border-purple-400/40" />
                          </div>
                        )}
                        <p className="text-[10px] text-center text-muted-foreground">
                          Confidence: <span className={`font-semibold ${confidenceColor(face.confidence)}`}>{confidenceLabel(face.confidence)} ({Math.round(face.confidence * 100)}%)</span>
                        </p>
                        <p className="text-xs text-muted-foreground text-center">Choose an action for this face</p>
                        <div className="relative">
                        <input
                          ref={reassignInputRef}
                          type="text"
                          value={reassignName}
                          onChange={(e) => setReassignName(e.target.value)}
                          onFocus={() => setReassignInputFocused(true)}
                          onBlur={() => setTimeout(() => setReassignInputFocused(false), 150)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && reassignName.trim()) handleReassign(face.face_id, reassignName); if (e.key === 'Escape') { setReassignFaceId(null); setReassignName(''); } }}
                          placeholder="Type person name..."
                          className="w-full text-sm px-2.5 py-1.5 rounded-lg border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                          autoFocus
                        />
                        {reassignSuggestions.length > 0 && (
                          <div className="absolute left-0 right-0 top-full mt-1 rounded-lg border border-border bg-background shadow-lg z-10 py-0.5">
                            {reassignSuggestions.map(p => (
                              <button key={p.id} onMouseDown={(e) => { e.preventDefault(); setReassignName(p.name); setReassignInputFocused(false); }}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-purple-100/50 dark:hover:bg-purple-900/20 transition-colors text-left">
                                <span className="truncate">{p.name}</span>
                                <span className="text-[9px] text-muted-foreground ml-auto shrink-0">{p.photo_count}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        </div>
                        <div className="flex gap-1.5">
                          <button onClick={() => handleReassign(face.face_id, reassignName)} disabled={!reassignName.trim()}
                            className="flex-1 px-2 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors">
                            Verify
                          </button>
                          <button onClick={() => { setReassignFaceId(null); setReassignName(''); }}
                            className="px-2 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors">
                            Cancel
                          </button>
                        </div>
                        <div className="flex gap-1.5 pt-1 border-t border-border">
                          <button onClick={() => handleReassign(face.face_id, '__unsure__', false)}
                            className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-blue-300/50 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-xs font-medium transition-colors">
                            <HelpCircle className="w-3 h-3" /> Unsure
                          </button>
                          <button onClick={() => handleReassign(face.face_id, '__unnamed__', false)}
                            className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-amber-300/50 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 text-xs font-medium transition-colors">
                            <Users className="w-3 h-3" /> Unnamed
                          </button>
                          <button onClick={() => handleReassign(face.face_id, '__ignored__', false)}
                            className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-slate-300/50 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/30 text-xs font-medium transition-colors">
                            <UserX className="w-3 h-3" /> Ignore
                          </button>
                        </div>
                        {onSetRepresentative && cluster.person_id && (
                          <button onClick={async () => { await onSetRepresentative(face.face_id); setReassignFaceId(null); setReassignName(''); }}
                            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-green-300/50 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 text-xs font-medium transition-colors">
                            <ImageIcon className="w-3 h-3" /> Set as main photo
                          </button>
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Users className="w-10 h-10 text-muted-foreground/20 mb-3" />
                <p className="text-sm text-muted-foreground">No faces found</p>
              </div>
            )}
          </div>

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
              <button
                onClick={() => { const p = Math.max(0, page - 1); setPage(p); loadPage(p); }}
                disabled={page === 0}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-secondary text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" /> Previous
              </button>
              <span className="text-sm text-muted-foreground">
                Page {page + 1} of {data.totalPages} · {data.total} faces
              </span>
              <button
                onClick={() => { const p = Math.min(data.totalPages - 1, page + 1); setPage(p); loadPage(p); }}
                disabled={page >= data.totalPages - 1}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-secondary text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Footer */}
          <div className="mt-4 pt-3 border-t border-border">
            <button onClick={onClose} className="w-full px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
              Done
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/* ─── Card Row — name LEFT, scrollable thumbnails RIGHT ─────────────────── */

function PersonCardRow({ cluster, cropUrl, sampleCrops, isEditing, nameInput, onStartEdit, onNameChange, onSubmit, onCancel, inputRef, existingPersons, onSelectPerson, onDiscard, pendingIgnore, onIgnore, onConfirmIgnore, onCancelIgnore, pendingUnsure, onUnsure, onConfirmUnsure, onCancelUnsure, onRestore, displayName, onReassignFace, onSetRepresentative, globalSelectedFaces, onGlobalSelectionChange, globalReassignFaceId, onGlobalReassignChange, globalReassignName, onGlobalReassignNameChange, currentTab, rowIndex }: {
  cluster: PersonCluster;
  cropUrl?: string;
  sampleCrops: Record<string, string>;
  isEditing: boolean;
  nameInput: string;
  onStartEdit: () => void;
  onNameChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  existingPersons?: PersonRecord[];
  onSelectPerson?: (name: string) => void;
  onDiscard?: () => void;
  pendingIgnore?: boolean;
  onIgnore?: () => void;
  onConfirmIgnore?: () => void;
  onCancelIgnore?: () => void;
  pendingUnsure?: boolean;
  onUnsure?: () => void;
  onConfirmUnsure?: () => void;
  onCancelUnsure?: () => void;
  onRestore?: () => void;
  displayName?: string;
  onReassignFace?: (faceId: number, newName: string, verified?: boolean, skipReload?: boolean) => Promise<void>;
  onSetRepresentative?: (faceId: number) => Promise<void>;
  // Cross-row selection props
  globalSelectedFaces: Set<number>;
  onGlobalSelectionChange: (faces: Set<number>) => void;
  globalReassignFaceId: number | null;
  onGlobalReassignChange: (faceId: number | null, name: string) => void;
  globalReassignName: string;
  onGlobalReassignNameChange: (name: string) => void;
  currentTab?: 'named' | 'unnamed' | 'unsure' | 'ignored';
  rowIndex?: number;
}) {
  // Ring colour for verified faces based on which category the cluster belongs to
  const getVerifiedBorderClass = (): string => {
    if (!cluster.person_name) return 'border-2 border-amber-400/70'; // Unnamed
    if (cluster.person_name === '__unsure__') return 'border-2 border-blue-400/70';
    if (cluster.person_name === '__ignored__') return 'border-2 border-[#76899F]/70';
    if (cluster.person_name.startsWith('__')) return '';
    return 'border-2 border-purple-400/70'; // Named (real name)
  };
  const verifiedBorder = getVerifiedBorderClass();

  const filteredPersons = (existingPersons || [])
    .filter(p => nameInput.length > 0 && p.name.toLowerCase().includes(nameInput.toLowerCase()) && p.name !== cluster.person_name && (p.photo_count ?? 0) > 0)
    .slice(0, 4);

  // Use global selection state (shared across rows)
  const reassignFaceId = globalReassignFaceId;
  const setReassignFaceId = (id: number | null) => onGlobalReassignChange(id, id == null ? '' : globalReassignName);
  const reassignName = globalReassignName;
  const setReassignName = (name: string) => onGlobalReassignNameChange(name);
  const selectedFaces = globalSelectedFaces;
  const setSelectedFaces = (update: Set<number> | ((prev: Set<number>) => Set<number>)) => {
    if (typeof update === 'function') {
      onGlobalSelectionChange(update(globalSelectedFaces));
    } else {
      onGlobalSelectionChange(update);
    }
  };
  const reassignInputRef = useRef<HTMLInputElement>(null);

  // Visual similarity suggestions — loaded when popover opens
  const [visualSugs, setVisualSugs] = useState<{ personId: number; personName: string; similarity: number }[]>([]);
  const [visualSugsLoading, setVisualSugsLoading] = useState(false);

  useEffect(() => {
    if (reassignFaceId == null) { setVisualSugs([]); return; }
    let cancelled = false;
    setVisualSugsLoading(true);
    getVisualSuggestions(reassignFaceId).then(r => {
      if (!cancelled && r.success && r.data) setVisualSugs(r.data);
      if (!cancelled) setVisualSugsLoading(false);
    });
    return () => { cancelled = true; };
  }, [reassignFaceId]);

  const [reassignInputFocused, setReassignInputFocused] = useState(false);

  // Combine visual + text suggestions: visual first (sorted by similarity), text filter when typing
  const reassignSuggestions = (() => {
    if (!reassignInputFocused) return [];
    const typed = reassignName.trim().toLowerCase();
    if (typed.length === 0) {
      // Show visual suggestions >= 70% similarity, sorted by highest match
      return visualSugs
        .filter(v => v.similarity >= 0.70)
        .map(v => {
          const match = (existingPersons || []).find(p => p.id === v.personId);
          return {
            id: v.personId,
            name: v.personName,
            photo_count: match?.photo_count ?? 0,
          };
        });
    }
    // Text-based filtering, boosted by visual similarity
    const textMatches = (existingPersons || [])
      .filter(p => p.name.toLowerCase().includes(typed) && (p.photo_count ?? 0) > 0)
      .slice(0, 6);
    const visualMap = new Map(visualSugs.map(v => [v.personId, v.similarity]));
    return textMatches
      .map(p => ({ ...p, similarity: visualMap.get(p.id) ?? 0 }))
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .map(({ similarity, ...rest }) => rest)
      .slice(0, 5);
  })();

  // Face-level multi-select (selectedFaces and setSelectedFaces are aliases to global props above)
  const [lastSelectedFaceIdx, setLastSelectedFaceIdx] = useState<number | null>(null);
  const [showSelectionPrompt, setShowSelectionPrompt] = useState(false);

  const handleFaceClick = (faceId: number, faceIdx: number, e: React.MouseEvent) => {
    const faces = cluster.sample_faces || [];
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click — toggle this face in/out of selection, keep popover on anchor face
      setSelectedFaces(prev => {
        const next = new Set(prev);
        if (next.has(faceId)) next.delete(faceId); else next.add(faceId);
        return next;
      });
      setLastSelectedFaceIdx(faceIdx);
      // If no popover is open yet, open one on this face
      if (reassignFaceId === null) {
        onGlobalReassignChange(faceId, '');
        setTimeout(() => reassignInputRef.current?.focus(), 100);
      }
    } else if (e.shiftKey && lastSelectedFaceIdx !== null) {
      // Shift+click — range select within this row
      const start = Math.min(lastSelectedFaceIdx, faceIdx);
      const end = Math.max(lastSelectedFaceIdx, faceIdx);
      setSelectedFaces(prev => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          if (faces[i]) next.add(faces[i].face_id);
        }
        return next;
      });
      // If no popover is open yet, open one on the first selected face
      if (reassignFaceId === null) {
        onGlobalReassignChange(faceId, '');
        setTimeout(() => reassignInputRef.current?.focus(), 100);
      }
    } else {
      // Normal click — select this face, open popover (clears previous selection)
      const newSelection = new Set<number>();
      newSelection.add(faceId);
      setSelectedFaces(newSelection);
      setLastSelectedFaceIdx(faceIdx);
      setShowSelectionPrompt(false);
      onGlobalReassignChange(faceId, '');
      // Pre-load the context crop so tooltip is ready when user hovers
      const clickedFace = faces.find(f => f.face_id === faceId);
      if (clickedFace?.file_path) {
        loadContextCrop(`face_${faceId}`, clickedFace.file_path, clickedFace.box_x, clickedFace.box_y, clickedFace.box_w, clickedFace.box_h);
      }
      setTimeout(() => reassignInputRef.current?.focus(), 100);
    }
  };

  const clearSelection = () => {
    onGlobalSelectionChange(new Set());
    setLastSelectedFaceIdx(null);
    setShowSelectionPrompt(false);
  };

  // Get all face IDs that this action should apply to (uses global selection)
  const getTargetFaceIds = (): number[] => {
    return Array.from(globalSelectedFaces);
  };

  const handleReassign = async (name: string, verified: boolean = true) => {
    if (!name.trim() || !onReassignFace) return;
    const targets = getTargetFaceIds();
    if (targets.length === 0) return;
    // Close modal and clear selection first to prevent interference
    setReassignFaceId(null);
    setReassignName('');
    clearSelection();
    // Process all faces — skip reload for all except the last
    for (let i = 0; i < targets.length; i++) {
      const isLast = i === targets.length - 1;
      await onReassignFace(targets[i], name.trim(), verified, !isLast);
    }
  };

  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState(-1);
  const [reassignSuggestionIdx, setReassignSuggestionIdx] = useState(-1);

  const [contextCrops, setContextCrops] = useState<Record<string, string>>({});
  const loadContextCrop = async (key: string, filePath: string, bx: number, by: number, bw: number, bh: number) => {
    if (contextCrops[key]) return;
    const result = await getFaceContext(filePath, bx, by, bw, bh, 200);
    if (result.success && result.dataUrl) {
      setContextCrops(prev => ({ ...prev, [key]: result.dataUrl! }));
    }
  };

  const [showFaceGrid, setShowFaceGrid] = useState(false);
  const [scrollPosition, setScrollPosition] = useState(0); // index of first visible thumbnail

  const cardRef = useRef<HTMLDivElement>(null);
  const thumbStripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = thumbStripRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      // Only intercept vertical scroll for horizontal thumb scrolling when there's overflow to scroll
      const hasHorizontalOverflow = el.scrollWidth > el.clientWidth;
      if (e.deltaY !== 0 && hasHorizontalOverflow) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
        e.stopPropagation();
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    // Track scroll position to show "X of Y" counter
    const scrollHandler = () => {
      const thumbWidth = 46; // w-10 (40px) + gap (6px)
      const visibleIdx = Math.round(el.scrollLeft / thumbWidth);
      setScrollPosition(visibleIdx);
    };
    el.addEventListener('scroll', scrollHandler, { passive: true });
    return () => { el.removeEventListener('wheel', handler); el.removeEventListener('scroll', scrollHandler); };
  });

  useEffect(() => {
    if (!isEditing) return;
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isEditing, onCancel]);

  if (pendingIgnore) {
    return (
      <div className="rounded-xl border border-slate-300/60 dark:border-slate-600/40 bg-slate-50/30 dark:bg-slate-900/20 p-3">
        <div className="flex items-center gap-3">
          {cropUrl ? (
            <img src={cropUrl} alt="" className="w-10 h-10 rounded-full object-cover shrink-0 border border-slate-300/50 opacity-60" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-slate-500/10 flex items-center justify-center shrink-0">
              <UserX className="w-4 h-4 text-slate-400" />
            </div>
          )}
          <p className="text-sm text-foreground flex-1">Ignore this person?</p>
          <button onClick={onConfirmIgnore} className="px-3 py-1.5 rounded-lg bg-slate-500 hover:bg-slate-600 text-white text-xs font-medium transition-colors">
            Yes, ignore
          </button>
          <button onClick={onCancelIgnore} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (pendingUnsure) {
    return (
      <div className="rounded-xl border border-blue-300/60 dark:border-blue-600/40 bg-blue-50/30 dark:bg-blue-900/20 p-3">
        <div className="flex items-center gap-3">
          {cropUrl ? (
            <img src={cropUrl} alt="" className="w-10 h-10 rounded-full object-cover shrink-0 border border-blue-300/50 opacity-60" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
              <HelpCircle className="w-4 h-4 text-blue-400" />
            </div>
          )}
          <p className="text-sm text-foreground flex-1">Move to Unsure?</p>
          <button onClick={onConfirmUnsure} className="px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium transition-colors">
            Yes
          </button>
          <button onClick={onCancelUnsure} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary text-xs font-medium transition-colors">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={0}>
    <div
      ref={cardRef}
      className={`rounded-xl border transition-all group ${
        isEditing
          ? 'border-purple-400/60 bg-purple-50/30 dark:bg-purple-950/20 shadow-md'
          : 'border-border hover:border-purple-300/50 hover:shadow-sm'
      }`}
    >
      <div className="p-4">
        <div className="flex items-center gap-3">
          {/* Row number */}
          {rowIndex != null && (
            <span className={`text-xs font-bold shrink-0 w-5 text-center ${
              cluster.person_name === '__ignored__' ? 'text-[#76899F]'
              : cluster.person_name === '__unsure__' ? 'text-blue-600'
              : !cluster.person_name ? 'text-amber-600'
              : 'text-purple-600'
            }`}>{rowIndex + 1}</span>
          )}
          {/* Main face thumbnail — always shows the first sample face */}
          <TooltipProvider delayDuration={500}>
            <Tooltip onOpenChange={(open) => {
              const firstFace = cluster.sample_faces?.[0];
              if (open && firstFace?.file_path) {
                loadContextCrop(`main_${firstFace.face_id}`, firstFace.file_path, firstFace.box_x, firstFace.box_y, firstFace.box_w, firstFace.box_h);
              }
            }}>
              <TooltipTrigger asChild>
                <div className={`shrink-0 ${(!isEditing && cluster.person_name && !cluster.person_name.startsWith('__')) ? 'cursor-pointer' : ''}`} onClick={() => { if (!isEditing && cluster.person_name && !cluster.person_name.startsWith('__')) onStartEdit(); }}>
                  {(cropUrl || (cluster.sample_faces?.[0] && sampleCrops[cluster.sample_faces[0].face_id])) ? (
                    <img src={sampleCrops[cluster.sample_faces?.[0]?.face_id] || cropUrl} alt="" className={`w-14 h-14 rounded-full object-cover shrink-0 border-2 ${
                      cluster.person_name === '__ignored__' ? 'border-[#76899F]'
                      : cluster.person_name === '__unsure__' ? 'border-blue-400'
                      : !cluster.person_name ? 'border-amber-400'
                      : cluster.person_name.startsWith('__') ? 'border-purple-400/40'
                      : 'border-indigo-500'
                    }`} />
                  ) : (
                    <div className="w-14 h-14 rounded-full bg-purple-500/15 flex items-center justify-center shrink-0">
                      <Users className="w-6 h-6 text-purple-400" />
                    </div>
                  )}
                </div>
              </TooltipTrigger>
              {(cropUrl || cluster.sample_faces?.[0]) && (
                <TooltipContent side="right" className="p-0.5 border border-purple-400/30 bg-background shadow-lg rounded-xl z-[70]">
                  {(() => {
                    const firstFaceId = cluster.sample_faces?.[0]?.face_id;
                    const contextKey = firstFaceId ? `main_${firstFaceId}` : '';
                    const contextImg = contextKey ? contextCrops[contextKey] : null;
                    const fallback = firstFaceId ? sampleCrops[firstFaceId] : cropUrl;
                    return <img src={contextImg || fallback} alt="" className={`${contextImg ? 'w-[200px] h-[200px] rounded-lg' : 'w-28 h-28 rounded-full'} object-cover`} />;
                  })()}
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>

          {/* Name + stats — clicking this area opens rename (only for named persons) */}
          <div
            className={`min-w-0 ${isEditing ? 'flex-1' : `w-[120px] shrink-0 ${cluster.person_name && !cluster.person_name.startsWith('__') ? 'cursor-pointer' : ''}`}`}
            onClick={() => { if (!isEditing && cluster.person_name && !cluster.person_name.startsWith('__')) onStartEdit(); }}
          >
            {isEditing ? (
              <div onClick={(e) => e.stopPropagation()}>
                <form onSubmit={(e) => { e.preventDefault(); if (nameInput.trim()) onSubmit(); }} className="flex items-center gap-3">
                  <input
                    ref={inputRef}
                    type="text"
                    value={nameInput}
                    onChange={(e) => { onNameChange(e.target.value); setSelectedSuggestionIdx(-1); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                      if (e.key === 'ArrowDown' && filteredPersons.length > 0) {
                        e.preventDefault();
                        setSelectedSuggestionIdx(prev => Math.min(prev + 1, filteredPersons.length - 1));
                      }
                      if (e.key === 'ArrowUp' && filteredPersons.length > 0) {
                        e.preventDefault();
                        setSelectedSuggestionIdx(prev => Math.max(prev - 1, -1));
                      }
                      if (e.key === 'Enter' && selectedSuggestionIdx >= 0 && filteredPersons[selectedSuggestionIdx]) {
                        e.preventDefault();
                        onSelectPerson?.(filteredPersons[selectedSuggestionIdx].name);
                        setSelectedSuggestionIdx(-1);
                      }
                    }}
                    placeholder="Type a name..."
                    className="flex-1 text-sm bg-transparent border-b-2 border-purple-400 outline-none text-foreground placeholder:text-muted-foreground/50 pb-0.5 min-w-0"
                    autoFocus
                  />
                  <button type="submit" disabled={!nameInput.trim()} className="px-3 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors whitespace-nowrap">
                    Update name
                  </button>
                </form>
                {filteredPersons.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {filteredPersons.map((p, idx) => (
                      <button key={p.id} onClick={(e) => { e.stopPropagation(); onSelectPerson?.(p.name); }}
                        className={`w-full flex items-center gap-2 px-1.5 py-1 rounded text-xs transition-colors text-left ${idx === selectedSuggestionIdx ? 'bg-purple-200/70 dark:bg-purple-800/40' : 'hover:bg-purple-100/50 dark:hover:bg-purple-900/20'}`}>
                        <Users className="w-3 h-3 text-purple-400 shrink-0" />
                        <span className="truncate">{p.name}</span>
                        {p.photo_count != null && <span className="text-[9px] text-muted-foreground ml-auto shrink-0">{p.photo_count}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                <p className={`text-sm font-medium truncate ${(cluster.person_name && !cluster.person_name.startsWith('__') && !displayName) ? 'text-foreground' : 'text-muted-foreground italic'}`}>
                  {displayName || (cluster.person_name && !cluster.person_name.startsWith('__') ? cluster.person_name : 'Unknown person')}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {cluster.photo_count} {cluster.photo_count === 1 ? 'photo' : 'photos'}
                  {currentTab === 'named' && cluster.sample_faces && (() => {
                    const verifiedCount = cluster.sample_faces.filter(f => f.verified).length;
                    const totalCount = cluster.sample_faces.length;
                    return verifiedCount > 0 ? <span className="text-purple-500 ml-1">· {verifiedCount}/{totalCount} verified</span> : null;
                  })()}
                </p>
              </>
            )}
          </div>

          {/* Sample face thumbnails */}
          {!isEditing && cluster.sample_faces && cluster.sample_faces.length > 0 && (
            <div className="flex flex-col flex-1 min-w-0">
              <div
                ref={thumbStripRef}
                className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent py-1"
                onClick={(e) => e.stopPropagation()}
              >
                {cluster.sample_faces.map((face, faceIdx) => (
                    <TooltipProvider key={face.face_id} delayDuration={500}>
                      <Tooltip onOpenChange={(open) => {
                        if (open && face.file_path) {
                          loadContextCrop(`face_${face.face_id}`, face.file_path, face.box_x, face.box_y, face.box_w, face.box_h);
                        }
                      }}>
                        <TooltipTrigger asChild>
                            <div
                              className="shrink-0 relative"
                              data-face-thumb="true"
                              onClick={(e) => { e.stopPropagation(); handleFaceClick(face.face_id, faceIdx, e); }}
                            >
                              {sampleCrops[face.face_id] ? (
                                <img
                                  src={sampleCrops[face.face_id]}
                                  alt=""
                                  className={`w-10 h-10 rounded-full object-cover cursor-pointer transition-all ${
                                    selectedFaces.has(face.face_id)
                                      ? 'ring-2 ring-green-500 ring-offset-1 ring-offset-background'
                                      : face.verified ? `${verifiedBorder} hover:ring-2 hover:ring-purple-400/50` : 'border border-border/50 hover:ring-2 hover:ring-purple-400/50'
                                  }`}
                                />
                              ) : (
                                <div className={`w-10 h-10 rounded-full bg-secondary flex items-center justify-center cursor-pointer ${
                                  selectedFaces.has(face.face_id)
                                    ? 'ring-2 ring-green-500 ring-offset-1 ring-offset-background'
                                    : face.verified ? verifiedBorder : ''
                                }`}>
                                  <Users className="w-3.5 h-3.5 text-muted-foreground/40" />
                                </div>
                              )}
                              {selectedFaces.has(face.face_id) && (
                                <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center shadow-sm">
                                  <Check className="w-2.5 h-2.5 text-white" />
                                </div>
                              )}
                              <div className={`absolute -top-1 -left-1 w-4 h-4 rounded-full flex items-center justify-center shadow-sm ${
                                face.verified && cluster.person_name && !cluster.person_name.startsWith('__') ? 'bg-purple-400/80' : 'bg-muted-foreground/50'
                              }`}>
                                <span className="text-[8px] font-bold text-white">{faceIdx + 1}</span>
                              </div>
                            </div>
                        </TooltipTrigger>
                        {contextCrops[`face_${face.face_id}`] && (
                          <TooltipContent side="top" avoidCollisions={false} className="p-0.5 border border-purple-400/30 bg-background shadow-lg rounded-xl z-[80]">
                            <img src={contextCrops[`face_${face.face_id}`]} alt="" className="w-[150px] h-[150px] rounded-lg object-cover" />
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                ))}
              </div>
              {/* Scroll position counter */}
              {cluster.sample_faces && cluster.sample_faces.length > 6 && (
                <div className="text-[9px] text-muted-foreground/60 text-right pr-1 mt-0.5">
                  {Math.min(scrollPosition + 1, cluster.sample_faces.length)}–{Math.min(scrollPosition + Math.floor((thumbStripRef.current?.clientWidth || 300) / 46), cluster.sample_faces.length)} of {cluster.sample_faces.length}
                </div>
              )}

            </div>
          )}

          {/* Hover action buttons */}
          {!isEditing && (
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
              {cluster.face_count > 20 && onReassignFace && (
                <Tooltip><TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowFaceGrid(true); }}
                    className="p-1.5 rounded-lg border border-purple-300/50 bg-background hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors"
                  >
                    <Grid3X3 className="w-3.5 h-3.5 text-purple-500" />
                  </button>
                </TooltipTrigger><TooltipContent>View all faces</TooltipContent></Tooltip>
              )}
              {onDiscard && (
                <Tooltip><TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDiscard(); }}
                    className="p-1.5 rounded-lg border border-red-300/50 bg-background hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-500" />
                  </button>
                </TooltipTrigger><TooltipContent>Send to Unnamed</TooltipContent></Tooltip>
              )}
              {onUnsure && (
                <Tooltip><TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onUnsure(); }}
                    className="p-1.5 rounded-lg border border-blue-300/50 bg-background hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                  >
                    <HelpCircle className="w-3.5 h-3.5 text-blue-500" />
                  </button>
                </TooltipTrigger><TooltipContent>Can't remember</TooltipContent></Tooltip>
              )}
              {onIgnore && (
                <Tooltip><TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onIgnore(); }}
                    className="p-1.5 rounded-lg border border-slate-300/50 bg-background hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors"
                  >
                    <UserX className="w-3.5 h-3.5 text-slate-500" />
                  </button>
                </TooltipTrigger><TooltipContent>Ignore</TooltipContent></Tooltip>
              )}
              {onRestore && (
                <Tooltip><TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRestore(); }}
                    className="p-1.5 rounded-lg border border-green-300/50 bg-background hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                  >
                    <Undo2 className="w-3.5 h-3.5 text-green-500" />
                  </button>
                </TooltipTrigger><TooltipContent>Move back to Unnamed</TooltipContent></Tooltip>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    {showFaceGrid && onReassignFace && (
      <FaceGridModal
        cluster={cluster}
        cropUrl={cropUrl}
        existingPersons={existingPersons || []}
        onReassignFace={onReassignFace}
        onSetRepresentative={onSetRepresentative}
        onClose={() => setShowFaceGrid(false)}
      />
    )}
    </TooltipProvider>
  );
}

/* ─── List View ─────────────────────────────────────────────────────────── */

function PersonListRow({ cluster, cropUrl, sampleCrops, isEditing, nameInput, onStartEdit, onNameChange, onSubmit, onCancel, inputRef, onDiscard, pendingIgnore, onIgnore, onConfirmIgnore, onCancelIgnore, pendingUnsure, onUnsure, onConfirmUnsure, onCancelUnsure }: {
  cluster: PersonCluster;
  cropUrl?: string;
  sampleCrops: Record<string, string>;
  isEditing: boolean;
  nameInput: string;
  onStartEdit: () => void;
  onNameChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onDiscard?: () => void;
  pendingIgnore?: boolean;
  onIgnore?: () => void;
  onConfirmIgnore?: () => void;
  onCancelIgnore?: () => void;
  pendingUnsure?: boolean;
  onUnsure?: () => void;
  onConfirmUnsure?: () => void;
  onCancelUnsure?: () => void;
}) {
  const getVerifiedBorderClass = (): string => {
    if (!cluster.person_name) return 'border-2 border-amber-400/70';
    if (cluster.person_name === '__unsure__') return 'border-2 border-blue-400/70';
    if (cluster.person_name === '__ignored__') return 'border-2 border-[#76899F]/70';
    if (cluster.person_name.startsWith('__')) return '';
    return 'border-[3px] border-purple-500';
  };
  const verifiedBorder = getVerifiedBorderClass();

  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isEditing) return;
    const handler = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isEditing, onCancel]);

  if (pendingIgnore) {
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-50/30 dark:bg-slate-900/20 border border-slate-300/40">
        {cropUrl ? <img src={cropUrl} alt="" className="w-7 h-7 rounded-full object-cover shrink-0 opacity-60" /> : <div className="w-7 h-7 rounded-full bg-slate-200 shrink-0" />}
        <span className="text-sm text-foreground flex-1">Ignore?</span>
        <button onClick={onConfirmIgnore} className="px-2.5 py-1 rounded-md bg-slate-500 hover:bg-slate-600 text-white text-xs font-medium transition-colors">Yes</button>
        <button onClick={onCancelIgnore} className="px-2.5 py-1 rounded-md border border-border hover:bg-secondary text-xs font-medium transition-colors">No</button>
      </div>
    );
  }
  if (pendingUnsure) {
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-blue-50/30 dark:bg-blue-900/20 border border-blue-300/40">
        {cropUrl ? <img src={cropUrl} alt="" className="w-7 h-7 rounded-full object-cover shrink-0 opacity-60" /> : <div className="w-7 h-7 rounded-full bg-blue-200 shrink-0" />}
        <span className="text-sm text-foreground flex-1">Mark as unsure?</span>
        <button onClick={onConfirmUnsure} className="px-2.5 py-1 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium transition-colors">Yes</button>
        <button onClick={onCancelUnsure} className="px-2.5 py-1 rounded-md border border-border hover:bg-secondary text-xs font-medium transition-colors">No</button>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={0}>
    <div
      ref={listRef}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all group ${
        isEditing ? 'bg-purple-50/30 dark:bg-purple-950/20 ring-1 ring-purple-400/40' : 'hover:bg-secondary/40 cursor-pointer'
      }`}
      onClick={(e) => {
        if (isEditing) return;
        onStartEdit();
      }}
    >
      {cropUrl ? (
        <img src={cropUrl} alt="" className="w-9 h-9 rounded-full object-cover shrink-0 border border-purple-400/30" />
      ) : (
        <div className="w-9 h-9 rounded-full bg-purple-500/15 flex items-center justify-center shrink-0">
          <Users className="w-4 h-4 text-purple-400" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        {isEditing ? (
          <form onSubmit={(e) => { e.preventDefault(); if (nameInput.trim()) onSubmit(); }} className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <input ref={inputRef} type="text" value={nameInput} onChange={(e) => onNameChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}
              placeholder="Type a name..." className="flex-1 text-sm bg-transparent border-b-2 border-purple-400 outline-none text-foreground placeholder:text-muted-foreground/50 pb-0.5 min-w-0" autoFocus />
            <Tooltip><TooltipTrigger asChild>
              <button type="submit" className="p-1 rounded hover:bg-purple-200/50 dark:hover:bg-purple-800/30"><Check className="w-3.5 h-3.5 text-purple-500" /></button>
            </TooltipTrigger><TooltipContent>Save</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild>
              <button type="button" onClick={onCancel} className="p-1 rounded hover:bg-secondary"><X className="w-3.5 h-3.5 text-muted-foreground" /></button>
            </TooltipTrigger><TooltipContent>Cancel</TooltipContent></Tooltip>
          </form>
        ) : (
          <p className={`text-sm truncate ${cluster.person_name ? 'font-medium text-foreground' : 'text-muted-foreground italic'}`}>
            {cluster.person_name || 'Unknown person'}
          </p>
        )}
      </div>

      {!isEditing && cluster.sample_faces && cluster.sample_faces.length > 0 && (
        <div className="flex items-center gap-0.5 shrink-0">
          {cluster.sample_faces.slice(0, 4).map(face => (
            <div key={face.face_id}>
              {sampleCrops[face.face_id] ? <img src={sampleCrops[face.face_id]} alt="" className={`w-6 h-6 rounded-full object-cover ${face.verified ? verifiedBorder : 'border border-border/40'}`} /> : <div className={`w-6 h-6 rounded-full bg-secondary ${face.verified ? verifiedBorder : ''}`} />}
            </div>
          ))}
        </div>
      )}

      {!isEditing && (
        <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0 w-[80px] text-right">
          {cluster.face_count} in {cluster.photo_count} {cluster.photo_count === 1 ? 'photo' : 'photos'}
        </span>
      )}

      {!isEditing && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0">
          <Tooltip><TooltipTrigger asChild>
            <button onClick={(e) => { e.stopPropagation(); onStartEdit(); }} className="p-1 rounded-md border border-purple-300/50 bg-background hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors">
              <Pencil className="w-3.5 h-3.5 text-purple-500" />
            </button>
          </TooltipTrigger><TooltipContent>{cluster.person_name ? 'Rename' : 'Name'}</TooltipContent></Tooltip>
          {onDiscard && (
            <Tooltip><TooltipTrigger asChild>
              <button onClick={(e) => { e.stopPropagation(); onDiscard(); }} className="p-1 rounded-md border border-red-300/50 bg-background hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                <Trash2 className="w-3.5 h-3.5 text-red-500" />
              </button>
            </TooltipTrigger><TooltipContent>Discard</TooltipContent></Tooltip>
          )}
          {onUnsure && (
            <Tooltip><TooltipTrigger asChild>
              <button onClick={(e) => { e.stopPropagation(); onUnsure(); }} className="p-1 rounded-md border border-blue-300/50 bg-background hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                <HelpCircle className="w-3.5 h-3.5 text-blue-500" />
              </button>
            </TooltipTrigger><TooltipContent>Can't remember</TooltipContent></Tooltip>
          )}
          {onIgnore && (
            <Tooltip><TooltipTrigger asChild>
              <button onClick={(e) => { e.stopPropagation(); onIgnore(); }} className="p-1 rounded-md border border-slate-300/50 bg-background hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                <UserX className="w-3.5 h-3.5 text-slate-500" />
              </button>
            </TooltipTrigger><TooltipContent>Ignore</TooltipContent></Tooltip>
          )}
        </div>
      )}
    </div>
    </TooltipProvider>
  );
}
