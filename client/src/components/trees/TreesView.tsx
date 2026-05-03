import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Users, X, GitBranch, RefreshCw, UserPlus, Pin, Pencil, FolderOpen, Info, Undo2, Redo2, Move, EyeOff, Eye, ChevronDown, Sliders, Play, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  getFamilyGraph,
  getFaceCrop,
  getPersonFaceCrop,
  listPersons,
  removeRelationship,
  createNamedPerson,
  createPlaceholderPerson,
  addRelationship,
  getPersonsCooccurrence,
  getPartnerSuggestionScores,
  listAllRelationships,
  listSavedTrees,
  createSavedTree,
  updateSavedTree,
  toggleHiddenAncestor,
  undoGraphOperation,
  redoGraphOperation,
  getGraphHistoryCounts,
  listRelationshipsForPerson,
  mergePlaceholderIntoPerson,
  onPeopleDataChanged,
  type FamilyGraph,
  type SavedTreeRecord,
} from '@/lib/electron-bridge';
import { computeFocusLayout } from '@/lib/trees-layout';
import { toast } from 'sonner';
import { TreesCanvas } from './TreesCanvas';
import { SetRelationshipModal } from './SetRelationshipModal';
import { EditRelationshipsModal } from './EditRelationshipsModal';
import { SiblingKindDialog, type SiblingKind } from './SiblingKindDialog';
import { HiddenSuggestionsReview } from './HiddenSuggestionsReview';
import { TreePeopleListModal } from './TreePeopleListModal';
import { useDraggableModal } from './useDraggableModal';
import { ManageTreesModal } from './ManageTreesModal';
import { DateQuickEditor } from './DateQuickEditor';
import { NameQuickEditor } from './NameQuickEditor';
import { promptConfirm, promptChoice, promptCheckList } from './promptConfirm';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { Checkbox } from '@/components/ui/checkbox';
import { SnapshotStatusBadge } from '@/components/SnapshotStatusBadge';

interface PersonSummary {
  id: number;
  name: string;
  /** Optional long-form name (`persons.full_name`). Trees prompts and
   *  any other formal-context UI should prefer this over the short
   *  name — "Sylvia Mills" reads better in a confirmation modal than
   *  the user's family nickname "Nan". Short name remains the fallback
   *  when no full name is on file. */
  fullName: string | null;
  /** Avatar data URL (`persons.avatar_data`). Used by Trees prompt
   *  modals to render a face crop alongside the question — anchors
   *  the question visually so the user isn't parsing a long
   *  "Sylvia Mills Carol Rouse's parent…" string. Null when no avatar
   *  has been set; the caller falls back to a plain monogram in that
   *  case. */
  avatarData: string | null;
  /** Total photos this person is linked to via face detections —
   *  includes AI-suggested faces the user hasn't confirmed. Kept for
   *  legacy sorting in the picker. */
  photoCount: number;
  /** Photos where the linking face has been user-verified. Shown in
   *  the People-list modal as the real measure of invested work. */
  verifiedPhotoCount: number;
  /** Stored gender string ('male' / 'female' / 'non_binary' / …). Used
   *  by the People-list modal to render the gender column. */
  gender: string | null;
  /** Stored birth date (YYYY-MM-DD or partial). Used to anchor the
   *  Gen-from-youngest calculation in the People-list modal. */
  birthDate: string | null;
}

/**
 * Trees v1 — family graph explorer.
 *
 * Flow:
 *   1. Mount → show focus picker modal.
 *   2. User picks focus person → fetch graph + compute layout.
 *   3. Canvas renders; double-click a node → refocus on that person.
 *   4. Right-click a node → Add parent / partner / child / Remove.
 */
export interface TreesViewProps {
  /** Called when the user asks to set a tree's canvas background.
   *  The parent routes them to S&D in pick mode; the pick eventually
   *  writes via updateSavedTree, so TreesView doesn't need to observe
   *  the result — it re-reads via the normal savedTrees refresh. */
  onRequestCanvasBackgroundPick?: (args: { treeId: number; treeName: string }) => void;
  /** Called when the user asks to set a card background via right-click. */
  onRequestCardBackgroundPick?: (args: { treeId: number; treeName: string; personId: number; personName: string }) => void;
}

/** Fetch the best avatar dataUrl for a person, prioritising the live
 *  face crop (graph node's representative face → getFaceCrop pipeline)
 *  over the stored persons.avatar_data snapshot. Returns undefined if
 *  no source is available; the caller renders a monogram fallback in
 *  that case. Used by Trees confirmation prompts to anchor questions
 *  with a face thumbnail. */
async function fetchPersonAvatar(
  personId: number,
  graph: { nodes: { personId: number; representativeFaceFilePath: string | null; representativeFaceBox: { x: number; y: number; w: number; h: number } | null }[] } | null,
  allPersons: { id: number; avatarData: string | null }[],
): Promise<string | undefined> {
  // Live face crop first — this matches what the canvas card shows
  // right now, even if avatar_data hasn't been refreshed.
  const node = graph?.nodes.find(n => n.personId === personId);
  if (node?.representativeFaceFilePath && node.representativeFaceBox) {
    try {
      const r = await getFaceCrop(
        node.representativeFaceFilePath,
        node.representativeFaceBox.x,
        node.representativeFaceBox.y,
        node.representativeFaceBox.w,
        node.representativeFaceBox.h,
        96,
      );
      if (r.success && r.dataUrl) return r.dataUrl;
    } catch { /* fall through */ }
  }
  // Snapshot from persons.avatar_data (set when the person was named
  // from a face cluster). Often null for people who weren't named
  // from a cluster, including children added via Trees quick-add.
  const summary = allPersons.find(p => p.id === personId);
  if (summary?.avatarData) return summary.avatarData;
  // Last-resort fallback: ask the backend to resolve this person's
  // representative face directly. Covers the case where the target
  // person isn't in the rendered graph yet (e.g. a child being added
  // before the parent_of edge has been written) AND has no stored
  // avatar_data — the path Terry hit when Carol's avatar showed as
  // an initial despite her having photos.
  try {
    const r = await getPersonFaceCrop(personId, 96);
    if (r.success && r.dataUrl) return r.dataUrl;
  } catch { /* fall through */ }
  return undefined;
}

/** Compute the generation offset for a single target person from the
 *  graph, mirroring the BFS used inside the main generationOffsets
 *  useMemo. Used by finaliseQuickAdd to detect Generations-overage
 *  on a freshly added person before the visual layout has had a
 *  chance to recompute. Returns null if the person is unreachable. */
function computeGenerationOffset(
  graph: { nodes: { personId: number }[]; edges: { aId: number; bId: number; type: string; derived?: boolean }[] },
  focusPersonId: number,
  targetPersonId: number,
): number | null {
  if (focusPersonId === targetPersonId) return 0;
  const out = new Map<number, number>();
  out.set(focusPersonId, 0);
  const queue: number[] = [focusPersonId];
  while (queue.length) {
    const cur = queue.shift()!;
    const curGen = out.get(cur)!;
    for (const e of graph.edges) {
      if (e.derived) continue;
      let neighbour: number | null = null;
      let shift = 0;
      if (e.type === 'parent_of') {
        if (e.aId === cur) { neighbour = e.bId; shift = -1; }
        else if (e.bId === cur) { neighbour = e.aId; shift = +1; }
      } else if (e.type === 'sibling_of' || e.type === 'spouse_of') {
        if (e.aId === cur) neighbour = e.bId;
        else if (e.bId === cur) neighbour = e.aId;
      }
      if (neighbour == null) continue;
      const newGen = curGen + shift;
      const existing = out.get(neighbour);
      if (existing == null || Math.abs(newGen) < Math.abs(existing)) {
        out.set(neighbour, newGen);
        queue.push(neighbour);
      }
    }
  }
  const result = out.get(targetPersonId);
  return result == null ? null : result;
}

export function TreesView({ onRequestCanvasBackgroundPick, onRequestCardBackgroundPick }: TreesViewProps = {}) {
  const [focusPersonId, setFocusPersonId] = useState<number | null>(null);
  // The picker opens only if we can't auto-pick a sensible focus.
  const [focusPickerOpen, setFocusPickerOpen] = useState(false);
  const [autoFocusAttempted, setAutoFocusAttempted] = useState(false);
  const [graph, setGraph] = useState<FamilyGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedHops, setExpandedHops] = useState(3);
  // Two independent filters, each can be on or off:
  //   • Steps — undirected hops from focus (wide net, includes cousins
  //     and in-laws at each step).
  //   • Generations — vertical ancestor/descendant depth, with siblings
  //     and spouses at each level included automatically.
  // When both are ON, a person must satisfy BOTH criteria (intersection)
  // to be shown — the two filters compose rather than replace each other.
  // When both are OFF, only the focus person is visible.
  // Steps and Generations are now always-on (toggle UI removed) —
  // the user adjusts via +/− only. The enabled flags stay true
  // permanently; they remain in saved-tree records for backwards
  // compatibility but are forced true on load.
  //
  // The numeric values mean exactly what they look like:
  //   • Steps = N  → people within N hops from focus
  //   • Generations = X/Y → X generations above + Y below
  //   • Steps = 0 or Generations 0/0 → only the focus person
  //   • To "see everyone" the user cranks to max (Steps 6, Gens 5/5)
  const [stepsEnabled, setStepsEnabled] = useState(true);
  const [generationsEnabled, setGenerationsEnabled] = useState(true);
  const [ancestorsDepth, setAncestorsDepth] = useState(2);
  const [descendantsDepth, setDescendantsDepth] = useState(2);
  // Brief visual pulse on the Steps / Generations pills when a newly
  // added person sits beyond the active filter limits. The new person
  // is auto-pinned so they stay visible, but the pulse signals to the
  // user that their filter would otherwise hide future siblings of
  // this addition — a hint to bump the filter if they want to see
  // them naturally instead of via the pin.
  const [pulseSteps, setPulseSteps] = useState(false);
  const [pulseGenerations, setPulseGenerations] = useState(false);
  useEffect(() => {
    if (!pulseSteps) return;
    const t = setTimeout(() => setPulseSteps(false), 3500);
    return () => clearTimeout(t);
  }, [pulseSteps]);
  useEffect(() => {
    if (!pulseGenerations) return;
    const t = setTimeout(() => setPulseGenerations(false), 3500);
    return () => clearTimeout(t);
  }, [pulseGenerations]);
  const [allPersons, setAllPersons] = useState<PersonSummary[]>([]);
  /** Formal-context display name for a person — full name when on file,
   *  short name as fallback. Use this in confirmation modals, prompts,
   *  and anywhere the user is making a decision about a specific
   *  person; the short name (often a family nickname like "Nan" /
   *  "Grandad") reads as ambiguous in those contexts. */
  const displayName = useCallback((personId: number, fallback: string = 'this person'): string => {
    const p = allPersons.find(x => x.id === personId);
    if (!p) return fallback;
    const full = p.fullName?.trim();
    if (full) return full;
    return p.name?.trim() || fallback;
  }, [allPersons]);
  const [relationshipEditorFor, setRelationshipEditorFor] = useState<number | null>(null);
  /** Optional preselection for SetRelationshipModal's "other person" —
   *  used when Edit Relationships jumps straight into an existing edge. */
  const [relationshipEditorInitialTo, setRelationshipEditorInitialTo] = useState<number | null>(null);
  /** When set, the Edit Relationships list modal is open for this person. */
  const [editRelationshipsFor, setEditRelationshipsFor] = useState<number | null>(null);
  /** When set, the Sibling Kind dialog is open between these two people.
   *  Triggered by the +sibling quick-add; on confirm we run the chosen
   *  flavour of sibling wiring instead of the old assume-full default. */
  const [siblingKindDialog, setSiblingKindDialog] = useState<{ fromId: number; toId: number; fromName: string; toName: string } | null>(null);
  /** Saved trees — named view presets. Loaded on mount; one is always
   *  active so the user's current focus/filter state has a place to
   *  persist to. If none exist at first launch we auto-create one. */
  const [savedTrees, setSavedTrees] = useState<SavedTreeRecord[]>([]);
  const [currentTreeId, setCurrentTreeId] = useState<number | null>(null);
  const [manageTreesOpen, setManageTreesOpen] = useState(false);
  const [treePeopleOpen, setTreePeopleOpen] = useState(false);
  /** Inline rename of the current tree name in the header. */
  const [editingTreeName, setEditingTreeName] = useState(false);
  const [treeNameDraft, setTreeNameDraft] = useState('');
  /** When true, the focus picker is open in "pick focus for a NEW tree"
   *  mode. Distinct from the plain Change Focus picker so we can swap
   *  the onPick behaviour without adding flags. */
  const [newTreePickerOpen, setNewTreePickerOpen] = useState(false);
  /** Optional-field toggles for inside-card display. Persisted to
   *  localStorage so the user's choice sticks across sessions. */
  const [showDates, setShowDates] = useState(
    typeof window !== 'undefined' && localStorage.getItem('pdr-trees-show-dates') === 'true'
  );
  /** Visual-effects toggles. Master switch + per-effect on/off.
   *  Persisted to localStorage; default ON for the first launch so
   *  the comet trail is visible without the user having to opt in. */
  const [effectsEnabled, setEffectsEnabled] = useState(
    typeof window !== 'undefined'
      ? localStorage.getItem('pdr-trees-effects-enabled') !== 'false'
      : true,
  );
  const [effectsCreationBurst, setEffectsCreationBurst] = useState(
    typeof window !== 'undefined'
      ? localStorage.getItem('pdr-trees-effects-creation') !== 'false'
      : true,
  );
  // Per-style toggles for the trigger-based effect. Each one is a
  // separate visual layer that can be combined with any other; the
  // user picks which look they want via the popover. Default on for
  // comet, off for the rest so the first launch is the simplest read.
  const persistedBool = (key: string, fallback: boolean) =>
    typeof window !== 'undefined'
      ? localStorage.getItem(key) === null ? fallback : localStorage.getItem(key) === 'true'
      : fallback;
  const [effectComet, setEffectComet] = useState(persistedBool('pdr-trees-effect-comet', true));
  const [effectSonar, setEffectSonar] = useState(persistedBool('pdr-trees-effect-sonar', false));
  const [effectSweep, setEffectSweep] = useState(persistedBool('pdr-trees-effect-sweep', false));
  const [effectElectric, setEffectElectric] = useState(persistedBool('pdr-trees-effect-electric', false));
  const [effectFiber, setEffectFiber] = useState(persistedBool('pdr-trees-effect-fiber', false));
  const [effectLed, setEffectLed] = useState(persistedBool('pdr-trees-effect-led', false));
  // Trigger-mechanism toggles — what user actions fire a pathway
  // highlight, separate from WHAT the highlight looks like (the styles
  // above). All gated by the master `effectsEnabled` switch.
  const [triggerOnRightClick, setTriggerOnRightClick] = useState(persistedBool('pdr-trees-trigger-rightclick', true));
  const [triggerOnAltClick, setTriggerOnAltClick] = useState(persistedBool('pdr-trees-trigger-altclick', true));
  const [triggerOnHover, setTriggerOnHover] = useState(persistedBool('pdr-trees-trigger-hover', false));
  const persistEffectStyle = useCallback((key: string, setter: (v: boolean) => void, value: boolean) => {
    setter(value);
    if (typeof window !== 'undefined') {
      localStorage.setItem(key, value ? 'true' : 'false');
    }
  }, []);
  /** Trees Settings dialog open state — controlled so the per-effect
   *  preview Play buttons can close the dialog before firing the
   *  comet, otherwise the modal backdrop sits on top of the canvas
   *  and the user doesn't see the effect they just clicked Play to
   *  preview. Built as a full Dialog (motion.div backdrop +
   *  bg-background card + horizontal tab strip) matching PDR's main
   *  SettingsModal pattern in workspace.tsx — Trees has grown enough
   *  knobs (Tree / Display / Effects) that a popover with one
   *  vertical scroll lane was visibly cramped. */
  const [treesSettingsOpen, setTreesSettingsOpen] = useState(false);
  /** Active tab inside the Trees Settings dialog. Mirrors how
   *  workspace.tsx's SettingsModal stores `settingsTab` — the active
   *  tab survives toggles within the same session but resets to
   *  'manageTrees' next time the dialog opens, which is what people
   *  expect from a settings surface. */
  const [treesSettingsTab, setTreesSettingsTab] = useState<'manageTrees' | 'people' | 'display' | 'effects'>('manageTrees');
  /** Drag-to-reposition for the Trees Settings dialog. Reuses the
   *  shared useDraggableModal hook (same one ManageTreesModal,
   *  TreePeopleListModal, and the other Trees modals use) so the
   *  drag clamp + cursor states match the rest of Trees. The header
   *  receives dragHandleProps; modalRef wraps the dialog card. */
  const treesSettingsDrag = useDraggableModal();
  /** Person currently being highlighted by the comet trail. Set by
   *  the create flows (finaliseQuickAdd, etc.) and the preview play
   *  button; cleared by PathwayHighlight's onComplete callback when
   *  the animation finishes. The `nonce` is bumped on every set so
   *  PathwayHighlight's key changes even when the same person is
   *  highlighted back-to-back — without it, React reconciles in
   *  place and the SVG SMIL <animate> elements never re-fire on
   *  consecutive triggers. */
  type EffectMode = { comet?: boolean; sonar?: boolean; sweep?: boolean; electric?: boolean; fiber?: boolean; led?: boolean };
  const [highlightTarget, setHighlightTargetState] = useState<{ id: number; nonce: number; mode: EffectMode } | null>(null);
  const setHighlightTarget = useCallback((id: number | null, mode: EffectMode = {}) => {
    if (id == null) setHighlightTargetState(null);
    else setHighlightTargetState({ id, nonce: Date.now(), mode });
  }, []);
  const persistEffectsEnabled = useCallback((v: boolean) => {
    setEffectsEnabled(v);
    if (typeof window !== 'undefined') {
      localStorage.setItem('pdr-trees-effects-enabled', v ? 'true' : 'false');
    }
  }, []);
  const persistEffectsCreationBurst = useCallback((v: boolean) => {
    setEffectsCreationBurst(v);
    if (typeof window !== 'undefined') {
      localStorage.setItem('pdr-trees-effects-creation', v ? 'true' : 'false');
    }
  }, []);
  /** Fired by the create flows after an addRelationship resolves to
   *  light up the path from focus to the new person. Gated on the
   *  master + per-effect toggles so disabled effects produce zero UI
   *  noise. The mode object passed through carries every per-style
   *  flag so PathwayHighlight knows which visual layers to render. */
  /** Generic trigger fired by the in-canvas affordances (right-click,
   *  Alt-click, hover-after-delay). Gated on the master "Enable
   *  visual effects" switch only — independent of the
   *  effectsCreationBurst toggle which only governs auto-firing on
   *  add. Same persisted style toggles drive what the highlight
   *  looks like. */
  const triggerHighlightToPerson = useCallback((personId: number) => {
    if (!effectsEnabled) return;
    if (personId === focusPersonId) return;
    const mode: EffectMode = {
      comet: effectComet,
      sonar: effectSonar,
      sweep: effectSweep,
      electric: effectElectric,
      fiber: effectFiber,
      led: effectLed,
    };
    if (!Object.values(mode).some(Boolean)) mode.comet = true;
    setHighlightTarget(personId, mode);
  }, [effectsEnabled, focusPersonId, effectComet, effectSonar, effectSweep, effectElectric, effectFiber, effectLed, setHighlightTarget]);
  const triggerCreationHighlight = useCallback((personId: number) => {
    if (!effectsEnabled) return;
    if (!effectsCreationBurst) return;
    const mode: EffectMode = {
      comet: effectComet,
      sonar: effectSonar,
      sweep: effectSweep,
      electric: effectElectric,
      fiber: effectFiber,
      led: effectLed,
    };
    // If the user has the master row on but unticked every per-style
    // option, fall back to comet so the add still produces a visible
    // burst — silence is worse than redundancy here.
    if (!Object.values(mode).some(Boolean)) mode.comet = true;
    setHighlightTarget(personId, mode);
  }, [effectsEnabled, effectsCreationBurst, effectComet, effectSonar, effectSweep, effectElectric, effectFiber, effectLed, setHighlightTarget]);
  /** Preview-only trigger declared LATER in the file (after the
   *  visibleGraph useMemo) — assigned via useRef so we can call it
   *  from this scope without referencing visibleGraph here, which
   *  would TDZ on every render and blank the whole Trees view.
   *  Set inside a useEffect just below visibleGraph's declaration. */
  const previewCreationHighlightRef = useRef<() => void>(() => {});
  const previewCreationHighlight = useCallback(() => {
    previewCreationHighlightRef.current();
  }, []);
  /** Per-preview style override. The play buttons next to each
   *  effect-style row stash a single-style mode object here before
   *  triggering, so the preview only shows that one effect even when
   *  the user has multiple styles persisted on. Cleared back to null
   *  by the highlight pipeline once the preview consumes it. */
  const previewModeOverrideRef = useRef<{ [k: string]: boolean } | null>(null);
  /** Date editor target — { personId, x, y } where x/y are screen
   *  coords for the popup. Null = editor closed. */
  const [dateEditor, setDateEditor] = useState<{ personId: number; x: number; y: number } | null>(null);
  /** Name editor — opened when the user clicks a person's name on
   *  a Trees card. Lets them edit the short and long-form names
   *  without leaving Trees. Same anchor model as the date editor. */
  const [nameEditor, setNameEditor] = useState<{ personId: number; x: number; y: number } | null>(null);
  /** Undo/redo availability counts from the graph_history table.
   *  Refreshed after every mutation + on app focus. The handlers that
   *  use refetchGraph / reloadPersons are declared AFTER those
   *  callbacks further below — see the second undo/redo block. */
  const [historyCounts, setHistoryCounts] = useState<{ canUndo: number; canRedo: number }>({ canUndo: 0, canRedo: 0 });
  const refreshHistoryCounts = useCallback(async () => {
    const r = await getGraphHistoryCounts();
    if (r.success && r.data) setHistoryCounts(r.data);
  }, []);
  useEffect(() => {
    refreshHistoryCounts();
    const onFocus = () => refreshHistoryCounts();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshHistoryCounts]);

  const toggleShowDates = useCallback((next: boolean) => {
    setShowDates(next);
    try {
      if (next) localStorage.setItem('pdr-trees-show-dates', 'true');
      else localStorage.removeItem('pdr-trees-show-dates');
    } catch {}
  }, []);
  /** Suppress auto-save while we're applying a loaded tree's settings
   *  (otherwise the act of loading would immediately overwrite the
   *  record we just read). */
  const applyingTreeRef = useRef(false);
  /** Target of an in-flight quick-add (chip around a node). null = no picker open. */
  const [quickAdd, setQuickAdd] = useState<{
    fromPersonId: number;
    kind: 'parent' | 'partner' | 'child' | 'sibling';
  } | null>(null);
  /**
   * People who should remain visible even though they're beyond the
   * user's selected Depth. Map of personId → their hop distance from
   * the current focus. Cleared when the focus changes (pins are
   * focus-relative). Populated when the user creates a new person via a
   * + chip that ends up further out than the Depth dropdown allows.
   */
  const [pinnedPeople, setPinnedPeople] = useState<Map<number, number>>(new Map());
  const lastFocusRef = useRef<number | null>(null);

  /** People whose beyond-capacity ancestors have been REVEALED via
   *  the ^ chevron above their card. Each member also gets a
   *  ref-counted entry in pinSourceCount per ancestor they brought
   *  in, so collapsing one expansion doesn't accidentally remove
   *  pins another expansion still holds. */
  const [expandedAncestorsOf, setExpandedAncestorsOf] = useState<Set<number>>(new Set());
  const [expandedDescendantsOf, setExpandedDescendantsOf] = useState<Set<number>>(new Set());
  /** For each expander personId, the set of ancestors / descendants
   *  it pulled into pinnedPeople. Used to UNDO the pinning on
   *  collapse. Ref-counted (a pin only disappears from pinnedPeople
   *  when every expander that contributed it has collapsed) so
   *  multiple chevrons can share an ancestor cleanly. */
  const ancestorPinSourcesRef = useRef<Map<number, Set<number>>>(new Map());
  const descendantPinSourcesRef = useRef<Map<number, Set<number>>>(new Map());

  // ── Saved trees: initial load ──────────────────────────────────
  // On mount, load every saved tree and activate the most-recently-
  // opened one. If none exist this is the user's first visit — we
  // auto-create "My Tree" so the settings auto-save has a target.
  useEffect(() => {
    (async () => {
      const r = await listSavedTrees();
      if (!r.success) return;
      const list = r.data ?? [];
      if (list.length === 0) {
        // Wait for allPersons / auto-focus to settle before creating —
        // the tree record needs a focusPersonId to be meaningful.
        return;
      }
      setSavedTrees(list);
      // Activate the most recently opened one.
      const activate = list[0];
      applyingTreeRef.current = true;
      setCurrentTreeId(activate.id);
      if (activate.focusPersonId != null) setFocusPersonId(activate.focusPersonId);
      // Toggle UI was removed — force enabled=true on load. Saved
      // trees that previously stored stepsEnabled=false load as
      // expandedHops=0 (only focus); same for generationsEnabled=false
      // mapping to 0/0. The user can crank +/− to expand from there.
      setStepsEnabled(true);
      setExpandedHops(activate.stepsEnabled ? activate.stepsDepth : 0);
      setGenerationsEnabled(true);
      setAncestorsDepth(activate.generationsEnabled ? activate.ancestorsDepth : 0);
      setDescendantsDepth(activate.generationsEnabled ? activate.descendantsDepth : 0);
      // Mark as opened so it stays top of the list.
      updateSavedTree(activate.id, { markOpened: true });
      // Release the suppression after one tick so setters settle.
      setTimeout(() => { applyingTreeRef.current = false; }, 0);
    })();
    // Intentionally mount-only — further refreshes come from manage modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the person list — used by focus picker and relationship-target
  // picker. Exposed as a callback so modals that create new people can
  // ask for a refresh.
  const reloadPersons = useCallback(async () => {
    const res = await listPersons();
    if (res.success && res.data) {
      setAllPersons(res.data.map(p => ({
        id: p.id,
        name: p.name,
        fullName: p.full_name ?? null,
        avatarData: p.avatar_data ?? null,
        photoCount: p.photo_count ?? 0,
        verifiedPhotoCount: (p as any).verified_photo_count ?? 0,
        gender: (p as any).gender ?? null,
        birthDate: (p as any).birth_date ?? null,
      })));
    }
  }, []);

  useEffect(() => {
    reloadPersons();
  }, [reloadPersons]);

  // (PM data-change subscription effect lives further down — must
  // be declared AFTER refetchGraph / fetchDepth or React hits a TDZ
  // crash. See comment near the undo/redo block for the same rule.)

  // Auto-focus on first open: ONLY use the last focus you explicitly
  // chose (stored in localStorage). If there isn't one, show the picker.
  // We don't second-guess with graph analysis — your first pick wins
  // forever, and you change it deliberately via the Change focus button.
  useEffect(() => {
    if (autoFocusAttempted || focusPersonId != null) return;
    if (allPersons.length === 0) return;
    setAutoFocusAttempted(true);
    try {
      // One-time migration: previous builds had an auto-picker that
      // clobbered localStorage with "most-photographed" as focus. Wipe
      // any such stale value on first run of this build so the user
      // gets to choose fresh.
      if (!localStorage.getItem('pdr-trees-last-focus-migrated-v3')) {
        localStorage.removeItem('pdr-trees-last-focus');
        localStorage.setItem('pdr-trees-last-focus-migrated-v3', '1');
      }
      const stored = localStorage.getItem('pdr-trees-last-focus');
      const storedId = stored ? parseInt(stored, 10) : NaN;
      if (Number.isFinite(storedId) && allPersons.some(p => p.id === storedId)) {
        setFocusPersonId(storedId);
        return;
      }
    } catch {}
    // No stored default → open the picker so the user makes a deliberate choice.
    setFocusPickerOpen(true);
  }, [allPersons, autoFocusAttempted, focusPersonId]);

  // Persist focus so the next Trees open lands on the same person.
  useEffect(() => {
    if (focusPersonId != null) {
      try { localStorage.setItem('pdr-trees-last-focus', String(focusPersonId)); } catch {}
    }
  }, [focusPersonId]);

  // Fetch graph whenever the focus OR the requested depth changes.
  // Depth === the number of relationship hops walked outward from the
  // focus person. It's also reused as the display horizon so the
  // dropdown genuinely controls what you see.
  const refetchGraph = useCallback(async (personId: number, hops: number) => {
    setLoading(true);
    const res = await getFamilyGraph(personId, hops);
    if (res.success && res.data) setGraph(res.data);
    setLoading(false);
  }, []);

  // Total fetch depth = max(whichever filter is active, deepest pinned
  // pathway). Generations mode needs +1 hop over the deepest shown level
  // to capture same-generation spouses reached through a spouse_of edge.
  const fetchDepth = useMemo(() => {
    const stepsReach = stepsEnabled ? expandedHops : 0;
    const gensReach = generationsEnabled
      ? Math.max(ancestorsDepth, descendantsDepth) + 1
      : 0;
    let max = Math.max(stepsReach, gensReach, 1); // floor at 1 so "both off" still fetches focus + immediate neighbours for any add-flows
    for (const hop of pinnedPeople.values()) max = Math.max(max, hop);
    return Math.min(max, 10); // safety cap
  }, [stepsEnabled, generationsEnabled, expandedHops, ancestorsDepth, descendantsDepth, pinnedPeople]);

  useEffect(() => {
    if (focusPersonId == null) return;
    if (lastFocusRef.current !== focusPersonId) {
      // Focus changed → pins are from the previous focus's perspective,
      // so drop them rather than keep stale hop numbers around. Same
      // logic for revealed extended-family branches: "Lindsay's
      // family-of-origin shown" only makes sense from her angle on
      // the tree; once the user re-focuses on someone else (where
      // Lindsay may not even appear), the expansion is meaningless.
      // Clear the ref maps too so collapseAllExpansions doesn't see
      // stale entries on the next reset click.
      setPinnedPeople(new Map());
      setExpandedAncestorsOf(new Set());
      setExpandedDescendantsOf(new Set());
      ancestorPinSourcesRef.current.clear();
      descendantPinSourcesRef.current.clear();
      lastFocusRef.current = focusPersonId;
    }
    refetchGraph(focusPersonId, fetchDepth);
  }, [focusPersonId, fetchDepth, refetchGraph]);

  /** Full set of person IDs in the focus's CONNECTED COMPONENT — every
   *  person reachable from the focus through any chain of relationships
   *  (parent_of, spouse_of, sibling_of, associated_with), unbounded by
   *  the Steps / Generations / fetchDepth caps that limit the rendered
   *  view. Used by the placeholder resolver to exclude already-linked
   *  people from "Link to existing" suggestions even when they're
   *  currently hidden, off-screen, or beyond the current fetch depth.
   *
   *  Refetched after every mutation via the `reloadConnectedComponent`
   *  bumper — any relationship add/remove could add or sever someone's
   *  tie into the tree. */
  const [connectedPersonIds, setConnectedPersonIds] = useState<Set<number>>(new Set());
  const [connectedBump, setConnectedBump] = useState(0);
  useEffect(() => {
    if (focusPersonId == null) { setConnectedPersonIds(new Set()); return; }
    let cancelled = false;
    (async () => {
      const r = await listAllRelationships();
      if (cancelled) return;
      const rels = r.success && r.data ? r.data : [];
      // Undirected BFS over every relationship type. Stops at anyone
      // already seen — no depth cap.
      const adj = new Map<number, Set<number>>();
      for (const rel of rels) {
        if (!adj.has(rel.person_a_id)) adj.set(rel.person_a_id, new Set());
        if (!adj.has(rel.person_b_id)) adj.set(rel.person_b_id, new Set());
        adj.get(rel.person_a_id)!.add(rel.person_b_id);
        adj.get(rel.person_b_id)!.add(rel.person_a_id);
      }
      const seen = new Set<number>([focusPersonId]);
      const stack = [focusPersonId];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const n of adj.get(cur) ?? []) {
          if (seen.has(n)) continue;
          seen.add(n);
          stack.push(n);
        }
      }
      if (!cancelled) setConnectedPersonIds(seen);
    })();
    return () => { cancelled = true; };
  }, [focusPersonId, connectedBump]);
  /** Call after any relationship mutation so the connected-component
   *  set recomputes. Safe no-op if focus is unset. */
  const reloadConnectedComponent = useCallback(() => {
    setConnectedBump(b => b + 1);
  }, []);

  // Undo / redo — declared here because the deps reference refetchGraph,
  // reloadPersons, AND fetchDepth, which are all defined in the hooks
  // above this point. Declaring these callbacks earlier caused a
  // temporal-dead-zone crash on mount.
  const handleUndo = useCallback(async () => {
    const r = await undoGraphOperation();
    if (r.success) {
      toast(`Undone: ${r.description ?? 'last change'}`);
      if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
      reloadPersons();
      // Saved trees may have changed too — e.g. undoing a hide-ancestry
      // flip writes to saved_trees.hidden_ancestor_person_ids, and the
      // canvas filter reads that off the current tree. Without this
      // refetch the undo succeeds in the DB but the canvas stays stale.
      reloadSavedTrees();
      refreshHistoryCounts();
    } else if (r.error) {
      toast.error(r.error);
    }
  }, [focusPersonId, fetchDepth, refetchGraph, reloadPersons, refreshHistoryCounts]);

  const handleRedo = useCallback(async () => {
    const r = await redoGraphOperation();
    if (r.success) {
      toast(`Redone: ${r.description ?? 'change'}`);
      if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
      reloadPersons();
      reloadSavedTrees();
      refreshHistoryCounts();
    } else if (r.error) {
      toast.error(r.error);
    }
  }, [focusPersonId, fetchDepth, refetchGraph, reloadPersons, refreshHistoryCounts]);

  // Subscribe to PM-side data changes. Declared HERE — after the
  // undo/redo callbacks — because the deps include refetchGraph and
  // fetchDepth, which are themselves declared earlier in the file
  // but only accessible after their initialiser runs. Same TDZ
  // rule the undo/redo block warns about.
  useEffect(() => {
    return onPeopleDataChanged(() => {
      reloadPersons();
      if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
    });
  }, [reloadPersons, refetchGraph, focusPersonId, fetchDepth]);

  // Keyboard shortcuts: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or
  // Ctrl/Cmd+Y = redo. Ignored when a text input is focused so the
  // user's typing-undo still works in name fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inText = (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA');
      if (inText) return;
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo, handleRedo]);

  // ─── Generation-offset BFS ──────────────────────────────────────
  // For each person in the graph, compute their generation relative to
  // focus: 0 = same generation (focus + siblings + spouses), +1 = parents
  // generation, +2 = grandparents, -1 = children, etc. parent_of edges
  // shift the offset; sibling_of and spouse_of keep it; associated_with
  // is ignored (no clear generation meaning). Null = unreachable.
  const generationOffsets = useMemo(() => {
    const out = new Map<number, number>();
    if (!graph || focusPersonId == null) return out;
    out.set(focusPersonId, 0);
    const queue: number[] = [focusPersonId];
    while (queue.length) {
      const cur = queue.shift()!;
      const curGen = out.get(cur)!;
      for (const e of graph.edges) {
        if (e.derived) continue;
        let neighbour: number | null = null;
        let shift = 0;
        if (e.type === 'parent_of') {
          if (e.aId === cur) { neighbour = e.bId; shift = -1; } // child
          else if (e.bId === cur) { neighbour = e.aId; shift = +1; } // parent
        } else if (e.type === 'sibling_of' || e.type === 'spouse_of') {
          if (e.aId === cur) neighbour = e.bId;
          else if (e.bId === cur) neighbour = e.aId;
          // shift = 0
        }
        if (neighbour == null) continue;
        const newGen = curGen + shift;
        const existing = out.get(neighbour);
        // Keep the offset closest to focus (smallest absolute value) —
        // stops BFS from inflating offsets through long spouse chains.
        if (existing == null || Math.abs(newGen) < Math.abs(existing)) {
          out.set(neighbour, newGen);
          queue.push(neighbour);
        }
      }
    }
    return out;
  }, [graph, focusPersonId]);

  // ─── Asymmetric visibility filter ──────────────────────────────
  // Rather than expanding the entire tree when one branch goes deep
  // (symmetric depth bump), we restrict the rendered graph to:
  //   • Steps mode: every node within the user-selected Depth from focus
  //   • Generations mode: everyone whose generation offset is in the
  //     range [-descendantsDepth, +ancestorsDepth]. Siblings and spouses
  //     at each shown level come along automatically (same-generation).
  //   • PLUS the shortest-path from focus to each pinned person
  //     (i.e. "unlock only that pathway")
  // Other branches stay at the dropdown's depth.
  const visibleGraph = useMemo(() => {
    if (!graph || focusPersonId == null) return graph;
    const visible = new Set<number>();
    // Always show the focus person regardless of filters — they're the
    // anchor the view is centred on.
    visible.add(focusPersonId);
    // Apply filters: intersection when both on, single when one on,
    // nothing extra when both off (focus-only).
    // Always-on filters with intuitive semantics:
    //   • Steps = 0 → only focus visible (0 hops out)
    //   • Generations 0/0 → only focus visible (gen offset 0)
    //   • Either filter at higher value → that many hops/generations
    // The enabled flags are kept always-true now that the toggle UI
    // is gone — see the useState block above.
    if (stepsEnabled || generationsEnabled) {
      for (const n of graph.nodes) {
        const passesSteps = !stepsEnabled ? true : n.hopsFromFocus <= expandedHops;
        const gen = generationOffsets.get(n.personId);
        const passesGens = !generationsEnabled
          ? true
          : (gen != null && gen >= -descendantsDepth && gen <= ancestorsDepth);
        if (passesSteps && passesGens) visible.add(n.personId);
      }
      // (Previously had a "extend by ONE hop" pass that pulled in
      // anyone parent/partner/sibling of an in-bounds person — to
      // keep stored family of boundary people available for chevron
      // expansion. Removed per Terry's feedback: that bypass leaked
      // 2-hop ancestors as visible cards when Steps=1, since each
      // grandparent is parent_of one of focus's parents and got
      // pulled in regardless of the Steps cap. Steps now caps
      // strictly. The new "X hidden" counter on the Steps pill
      // tells the user when filtered-out people exist.)
    }
    if (pinnedPeople.size > 0) {
      // Build an undirected adjacency map for BFS.
      const adj = new Map<number, Set<number>>();
      for (const e of graph.edges) {
        if (!adj.has(e.aId)) adj.set(e.aId, new Set());
        if (!adj.has(e.bId)) adj.set(e.bId, new Set());
        adj.get(e.aId)!.add(e.bId);
        adj.get(e.bId)!.add(e.aId);
      }
      for (const pinnedId of pinnedPeople.keys()) {
        const path = bfsShortestPath(adj, focusPersonId, pinnedId);
        for (const id of path) visible.add(id);
      }
    }
    // Per-tree "hidden ancestor" trim — when the user says "hide X's
    // ancestry", we walk every parent_of edge upward from X and remove
    // the ancestors + their spouses + their siblings from `visible`.
    // The hidden person themself stays (they're still a partner, child,
    // etc. — just their family line is collapsed).
    //
    // Critical nuance: an ancestor may belong to MORE THAN ONE person's
    // ancestry. E.g. Mel's Mum is the mother of both Mel AND Nee (half-
    // siblings sharing one parent). If the user hides Nee's ancestry,
    // naive removal would also hide Mel's Mum — who's legitimately
    // Mel's mum, and Mel isn't in the hidden list. So we compute a
    // "protected" set = ancestry cloud of every OTHER visible person
    // whose line is NOT hidden, and intersect it out before applying
    // removal. An ancestor only goes away if nobody visible besides
    // the hidden person depends on them.
    const currentTreeEntry = savedTrees.find(t => t.id === currentTreeId);
    const hiddenAncestorIds = currentTreeEntry?.hiddenAncestorPersonIds ?? [];
    if (hiddenAncestorIds.length > 0) {
      // Full upward "family cloud" for a person — direct ancestors via
      // parent_up chain + spouses/siblings of those ancestors. Used as
      // the REMOVAL candidate set: hiding X's ancestry should also
      // strip ancestor-step-parents and great-aunts/uncles that only
      // sit in the tree because of X.
      const ancestorCloudFor = (personId: number): Set<number> => {
        const cloud = new Set<number>();
        const ancestors = new Set<number>();
        const stack = [personId];
        const seen = new Set<number>([personId]);
        while (stack.length) {
          const cur = stack.pop()!;
          for (const e of graph.edges) {
            if (e.type === 'parent_of' && e.bId === cur && !seen.has(e.aId)) {
              seen.add(e.aId);
              ancestors.add(e.aId);
              stack.push(e.aId);
            }
          }
        }
        for (const a of ancestors) {
          cloud.add(a);
          for (const e of graph.edges) {
            if (e.type === 'spouse_of' && (e.aId === a || e.bId === a)) {
              cloud.add(e.aId === a ? e.bId : e.aId);
            }
            if (e.type === 'sibling_of' && (e.aId === a || e.bId === a)) {
              cloud.add(e.aId === a ? e.bId : e.aId);
            }
          }
        }
        return cloud;
      };

      // Pure upward ancestor CHAIN — parents, grandparents, etc., no
      // spouses or siblings. Used as the PROTECTION set: an ancestor
      // stays visible only if they're somebody non-hidden's direct
      // upline. Using the cloud here over-protects co-parents of the
      // hidden person (e.g. Nee's Dad, who appears as a spouse of
      // Mel's Mum in Mel's cloud — but he's in the tree PURELY because
      // of Nee, so he shouldn't survive hiding Nee's ancestry).
      const ancestorChainFor = (personId: number): Set<number> => {
        const ancestors = new Set<number>();
        const stack = [personId];
        const seen = new Set<number>([personId]);
        while (stack.length) {
          const cur = stack.pop()!;
          for (const e of graph.edges) {
            if (e.type === 'parent_of' && e.bId === cur && !seen.has(e.aId)) {
              seen.add(e.aId);
              ancestors.add(e.aId);
              stack.push(e.aId);
            }
          }
        }
        return ancestors;
      };

      const hiddenSet = new Set<number>(hiddenAncestorIds);
      // Union of ancestor CLOUDS for all HIDDEN targets — candidates
      // for removal (ancestors + their spouses + their siblings).
      const hideCloud = new Set<number>();
      for (const hid of hiddenSet) {
        if (hid === focusPersonId) continue;
        for (const id of ancestorCloudFor(hid)) hideCloud.add(id);
      }
      // Union of pure ancestor CHAINS for every OTHER visible person —
      // these are the people whose ancestry the user has NOT hidden,
      // so their direct upline must remain visible. Deliberately NOT
      // cloud: a non-hidden person's ancestor's spouse can legitimately
      // be a hidden-only relative (Nee's Dad co-parented Nee with
      // Mel's Mum — protecting him because he shows up in Mel's cloud
      // would defeat the hide).
      const protectChain = new Set<number>();
      for (const vid of visible) {
        if (hiddenSet.has(vid)) continue;
        for (const id of ancestorChainFor(vid)) protectChain.add(id);
      }
      const toHide = new Set<number>();
      for (const id of hideCloud) {
        if (protectChain.has(id)) continue; // shared direct ancestry — keep.
        toHide.add(id);
      }
      // Never drop focus; never drop any pinned person the user asked for.
      toHide.delete(focusPersonId);
      for (const pid of pinnedPeople.keys()) toHide.delete(pid);
      for (const id of toHide) visible.delete(id);

      // Derived sibling_of edges are computed from shared parents on
      // the server, and sit in graph.edges. If we just hid those shared
      // parents, the derivation no longer holds — but the edge itself
      // is still in the list, and the BFS would happily walk it and
      // keep a half-sibling (like Nee) in view just because her only-
      // hidden parent was shared with a still-visible person (Mel).
      // So: for BFS purposes, a derived sibling_of edge is only live
      // if AT LEAST ONE of its shared parents is still in `visible`.
      const childrenByParent = new Map<number, Set<number>>();
      for (const e of graph.edges) {
        if (e.type !== 'parent_of') continue;
        if (!childrenByParent.has(e.aId)) childrenByParent.set(e.aId, new Set());
        childrenByParent.get(e.aId)!.add(e.bId);
      }
      const derivedSiblingLive = (aId: number, bId: number): boolean => {
        // There's a visible shared parent iff some parent p in visible
        // has both aId and bId among its children.
        for (const [p, kids] of childrenByParent) {
          if (!visible.has(p)) continue;
          if (kids.has(aId) && kids.has(bId)) return true;
        }
        return false;
      };

      // Orphan trim — after severing the hidden branch, anyone whose
      // only connection to the focus ran THROUGH that branch (e.g. a
      // half-sibling who shared just the now-hidden parent) is left
      // floating. We run a BFS from focus over edges where both
      // endpoints are still in `visible`, dropping derived sibling
      // edges whose shared parent is no longer visible. Focus + pinned
      // people are exempt so a pin survives even if the user hid
      // everything between them and the focus.
      const reachable = new Set<number>([focusPersonId]);
      const stack: number[] = [focusPersonId];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const e of graph.edges) {
          if (!visible.has(e.aId) || !visible.has(e.bId)) continue;
          if (e.type === 'sibling_of' && e.derived && !derivedSiblingLive(e.aId, e.bId)) continue;
          let other: number | null = null;
          if (e.aId === cur) other = e.bId;
          else if (e.bId === cur) other = e.aId;
          if (other == null || reachable.has(other)) continue;
          reachable.add(other);
          stack.push(other);
        }
      }
      // Protect the people whose ancestry was hidden — they're the
      // subjects of the action, not collateral damage. If hiding a
      // half-sibling's shared parent severs their only tie to the
      // focus, we still keep THEM in view (just without their family
      // line) so the user can right-click them and Show ancestry again.
      const hiddenSetForProtect = new Set<number>(hiddenAncestorIds);
      for (const id of Array.from(visible)) {
        if (id === focusPersonId) continue;
        if (pinnedPeople.has(id)) continue;
        if (hiddenSetForProtect.has(id)) continue;
        if (!reachable.has(id)) visible.delete(id);
      }
    }
    return {
      ...graph,
      nodes: graph.nodes.filter(n => visible.has(n.personId)),
      edges: graph.edges.filter(e => visible.has(e.aId) && visible.has(e.bId)),
    };
  }, [graph, focusPersonId, stepsEnabled, generationsEnabled, expandedHops, ancestorsDepth, descendantsDepth, generationOffsets, pinnedPeople, savedTrees, currentTreeId]);

  // ─── previewCreationHighlight (deferred ref binding) ──────────────
  // Populates the ref declared earlier in the component (above
  // visibleGraph) so the play button in the Trees Settings popover
  // can fire the comet effect on the visible person furthest from
  // focus — without TDZ-ing visibleGraph at component-top declaration
  // time. Runs on every render so the closure always has the latest
  // visibleGraph + focusPersonId.
  previewCreationHighlightRef.current = () => {
    if (!visibleGraph || focusPersonId == null) return;
    // Pick the deepest visible BLOODLINE ANCESTOR by walking parent_of
    // edges upward from focus. Bloodline ancestors are always rendered
    // on the main canvas (never moved into a panel), so the comet has
    // a real card to land on. Fixes the "comet flies to empty space"
    // bug where furthest-by-hop sometimes picked a side-branch person
    // who'd been routed into an open panel and whose canvas coords are
    // a ghost position.
    let target: number | null = null;
    let bestDepth = 0;
    const visited = new Set<number>([focusPersonId]);
    const queue: { id: number; depth: number }[] = [{ id: focusPersonId, depth: 0 }];
    while (queue.length) {
      const { id, depth } = queue.shift()!;
      if (depth > bestDepth) { bestDepth = depth; target = id; }
      for (const e of visibleGraph.edges) {
        if (e.type !== 'parent_of') continue;
        if (e.bId !== id) continue;
        if (visited.has(e.aId)) continue;
        visited.add(e.aId);
        queue.push({ id: e.aId, depth: depth + 1 });
      }
    }
    // Fallbacks if focus has no visible ancestors (e.g. just-created
    // tree): try the focus's spouse, then any visible non-focus person.
    if (target == null) {
      for (const e of visibleGraph.edges) {
        if (e.type === 'spouse_of' && (e.aId === focusPersonId || e.bId === focusPersonId)) {
          target = e.aId === focusPersonId ? e.bId : e.aId;
          break;
        }
      }
    }
    if (target == null) {
      const first = visibleGraph.nodes.find(n => n.personId !== focusPersonId);
      if (first) target = first.personId;
    }
    if (target == null) return;
    // Mode for THIS preview: prefer the per-style override stashed by
    // a Play button (single-style sample), fall back to the union of
    // all enabled persisted styles, fall back to comet only when the
    // user has somehow disabled every style.
    let mode: EffectMode | null = previewModeOverrideRef.current;
    previewModeOverrideRef.current = null;
    if (!mode) {
      mode = {
        comet: effectComet,
        sonar: effectSonar,
        sweep: effectSweep,
        electric: effectElectric,
        fiber: effectFiber,
        led: effectLed,
      };
      if (!Object.values(mode).some(Boolean)) mode = { comet: true };
    }
    // setHighlightTarget bumps a per-call nonce internally, so the
    // child PathwayHighlight's key changes on every preview click and
    // remounts even when the same target is chosen back-to-back. No
    // timeout dance needed.
    setHighlightTarget(target, mode);
  };

  // Number of people in the graph who are filtered OUT specifically
  // by the Steps cap (but would pass Generations) — i.e. the count
  // a "+N hidden" badge on the Steps pill should display, and the
  // signal we use to pulse the pill so the user knows there's more
  // available behind the cap. Only counts people who would actually
  // become visible if Steps were higher (i.e., they pass Generations
  // already) — bumping Steps wouldn't reveal anyone outside the
  // Generations range, so we don't promise to.
  const hiddenByStepsCount = useMemo(() => {
    if (!graph || focusPersonId == null) return 0;
    if (!stepsEnabled) return 0;
    let count = 0;
    for (const n of graph.nodes) {
      if (n.personId === focusPersonId) continue;
      if (n.hopsFromFocus <= expandedHops) continue;
      if (generationsEnabled) {
        const gen = generationOffsets.get(n.personId);
        if (gen == null) continue;
        if (gen < -descendantsDepth || gen > ancestorsDepth) continue;
      }
      count++;
    }
    return count;
  }, [graph, focusPersonId, stepsEnabled, generationsEnabled, expandedHops, ancestorsDepth, descendantsDepth, generationOffsets]);

  // Furthest-out hop count anyone in the graph sits at — drives the
  // outlined "max useful" marker on the Steps grid so users know the
  // value past which raising Steps stops revealing more relatives.
  // Beyond this number, the user is on their own — we trust them to
  // know what they're doing if they go higher.
  const maxHopsInGraph = useMemo(() => {
    if (!graph) return 0;
    let max = 0;
    for (const n of graph.nodes) {
      if (n.hopsFromFocus > max) max = n.hopsFromFocus;
    }
    return max;
  }, [graph]);

  // Layout depth uses the widest active filter so spacing accommodates
  // the deepest visible branch.
  const effectiveLayoutHops = Math.max(
    stepsEnabled ? expandedHops : 0,
    generationsEnabled ? Math.max(ancestorsDepth, descendantsDepth) : 0,
    1, // never 0 — layout needs breathing room even in focus-only view
  );
  // ALL parent placeholders REMOVED globally per Terry's feedback —
  // both virtual ghosts (negative IDs from the now-disabled augmenter)
  // AND real placeholder_person rows (positive IDs, isPlaceholder=true)
  // get stripped before the layout runs. The real placeholders are
  // auto-created when the user marks two people as siblings — they
  // exist in the DB purely so the sibling link can derive from a
  // shared-parent relationship — and surfacing them as empty cards
  // with dotted brackets above the grandparent row is exactly the
  // visual debris Terry asked to remove.
  //
  // Sibling brackets between people who shared a placeholder parent
  // still render: the server synthesises derived sibling_of edges
  // for any pair of children sharing a parent (placeholder included),
  // and TreesCanvas already draws those derived edges as a fallback
  // when the shared parent isn't in nodeById. The sibling visual
  // therefore degrades from a parent-anchored bracket to a direct
  // sibling line — same information, no debris.
  //
  // Server side: totalParentCount / totalChildCount queries also
  // exclude placeholders (see search-database.ts) so the chevron
  // condition (totalParentCount > visibleParentCount) doesn't fire
  // above someone whose only "missing" parents were placeholders.
  const layoutGraph = (() => {
    if (!visibleGraph) return null;
    // Classify each placeholder by its graph topology:
    //
    //  • SIBLING-STUB — a placeholder whose only purpose is to glue
    //    two named siblings together via a shared "Unknown" parent
    //    (e.g. when the user marks Sylvia + Gladys as siblings, the
    //    backend creates a placeholder so a parent_of relationship
    //    can derive sibling_of). These are visual debris — strip.
    //    Topology: the placeholder's children DO NOT all share a
    //    single named non-placeholder co-parent.
    //
    //  • CO-PARENT — a placeholder representing a real-but-unnamed
    //    second parent (e.g. Ian's ex-wife who's Chloe + Abby's
    //    mother but the user hasn't typed her name yet). These are
    //    semantically meaningful and must remain visible so the
    //    user can see "Chloe has another parent we haven't named"
    //    and click in to fill her in. Stripping them silently
    //    discards the relationship the user just asserted.
    //    Topology: the placeholder has 1+ children, and every one
    //    of those children has the SAME single named non-placeholder
    //    co-parent (so this placeholder is uniquely the OTHER parent
    //    of all those children).
    const allPlaceholderIds = new Set<number>();
    for (const n of visibleGraph.nodes) {
      if (n.isPlaceholder) allPlaceholderIds.add(n.personId);
    }
    // For each placeholder, gather its children and decide which class.
    const childrenByPlaceholder = new Map<number, number[]>();
    const parentsByChild = new Map<number, number[]>();
    for (const e of visibleGraph.edges) {
      if (e.type !== 'parent_of') continue;
      if (allPlaceholderIds.has(e.aId)) {
        if (!childrenByPlaceholder.has(e.aId)) childrenByPlaceholder.set(e.aId, []);
        childrenByPlaceholder.get(e.aId)!.push(e.bId);
      }
      if (!parentsByChild.has(e.bId)) parentsByChild.set(e.bId, []);
      parentsByChild.get(e.bId)!.push(e.aId);
    }
    const stripIds = new Set<number>();
    for (const phId of allPlaceholderIds) {
      const kids = childrenByPlaceholder.get(phId) ?? [];
      if (kids.length === 0) {
        // Placeholder with no children — likely a sibling-stub on the
        // OTHER side (e.g. an unnamed grandparent). No descendants to
        // anchor a co-parent reading, so strip.
        stripIds.add(phId);
        continue;
      }
      // Find each kid's other (non-placeholder) parents.
      const namedCoParentSets: Set<number>[] = [];
      for (const kidId of kids) {
        const others = (parentsByChild.get(kidId) ?? [])
          .filter(pid => pid !== phId && !allPlaceholderIds.has(pid));
        namedCoParentSets.push(new Set(others));
      }
      // Keep only if every kid has at least one named co-parent AND
      // the SAME single named co-parent is common to every kid's set.
      // A single common name → unambiguously the same other parent.
      if (namedCoParentSets.some(s => s.size === 0)) {
        stripIds.add(phId);
        continue;
      }
      // Intersect across all kids' named-coparent sets.
      const common = new Set(namedCoParentSets[0]);
      for (let i = 1; i < namedCoParentSets.length; i++) {
        for (const v of Array.from(common)) {
          if (!namedCoParentSets[i].has(v)) common.delete(v);
        }
      }
      if (common.size === 0) stripIds.add(phId);
      // common.size >= 1 → this placeholder is a co-parent → keep.
    }
    return {
      ...visibleGraph,
      nodes: visibleGraph.nodes.filter(n => !stripIds.has(n.personId)),
      edges: visibleGraph.edges.filter(
        e => !stripIds.has(e.aId) && !stripIds.has(e.bId),
      ),
    };
  })();
  // Side-branch descendant IDs — the cousins, cousins' partners and
  // their children whose only on-screen home is a chevron-opened panel
  // floating over the canvas. We need them OUT of the canvas-spacing
  // math, otherwise gen 0 ends up wide enough to hold every cousin
  // family side-by-side and the per-family-centring pass drags Alan
  // far right of Patricia / Peter so each ancestor can sit over their
  // own (mostly-hidden) kids — which is exactly the empty-stripe
  // problem Terry flagged. Layout still keeps these people in
  // `placed` (parked at x=0) so layout.edges + layout.nodes stay
  // referentially intact for the panel BFS that re-lays them out.
  const sideBranchHiddenIds = (() => {
    if (!layoutGraph) return new Set<number>();
    const childrenOf = new Map<number, number[]>();
    const parentsOf = new Map<number, number[]>();
    for (const e of layoutGraph.edges) {
      if (e.type !== 'parent_of') continue;
      if (!childrenOf.has(e.aId)) childrenOf.set(e.aId, []);
      childrenOf.get(e.aId)!.push(e.bId);
      if (!parentsOf.has(e.bId)) parentsOf.set(e.bId, []);
      parentsOf.get(e.bId)!.push(e.aId);
    }
    const focusId = layoutGraph.focusPersonId;
    // Strict ancestors of focus (NOT including focus).
    const strictAncestors = new Set<number>();
    const upQ = [focusId];
    while (upQ.length) {
      const cur = upQ.shift()!;
      for (const p of parentsOf.get(cur) ?? []) {
        if (strictAncestors.has(p)) continue;
        strictAncestors.add(p);
        upQ.push(p);
      }
    }
    // Direct line (kept on canvas): focus + direct ancestors + direct
    // descendants + focus's siblings + their descendants. Never hidden.
    const directLine = new Set<number>([focusId, ...strictAncestors]);
    const downQ = [focusId];
    while (downQ.length) {
      const cur = downQ.shift()!;
      for (const c of childrenOf.get(cur) ?? []) {
        if (directLine.has(c)) continue;
        directLine.add(c);
        downQ.push(c);
      }
    }
    const focusParents = parentsOf.get(focusId) ?? [];
    const sibQ: number[] = [];
    for (const fp of focusParents) {
      for (const c of childrenOf.get(fp) ?? []) {
        if (c === focusId) continue;
        if (directLine.has(c)) continue;
        directLine.add(c);
        sibQ.push(c);
      }
    }
    while (sibQ.length) {
      const cur = sibQ.shift()!;
      for (const c of childrenOf.get(cur) ?? []) {
        if (directLine.has(c)) continue;
        directLine.add(c);
        sibQ.push(c);
      }
    }
    // Side-branch heads = siblings of strict ancestors (children of
    // strict ancestors' parents, excluding the ancestor and focus).
    const heads = new Set<number>();
    for (const a of strictAncestors) {
      for (const p of parentsOf.get(a) ?? []) {
        for (const c of childrenOf.get(p) ?? []) {
          if (c === a) continue;
          if (c === focusId) continue;
          if (strictAncestors.has(c)) continue;
          heads.add(c);
        }
      }
    }
    // For each head, walk DOWN collecting descendants (skipping the
    // direct line to guard against cousin marriages / half-relations
    // where someone reaches focus via two routes).
    const hidden = new Set<number>();
    for (const head of heads) {
      const q = [head];
      const seen = new Set<number>([head]);
      while (q.length) {
        const cur = q.shift()!;
        for (const c of childrenOf.get(cur) ?? []) {
          if (seen.has(c)) continue;
          seen.add(c);
          if (directLine.has(c)) continue;
          hidden.add(c);
          q.push(c);
        }
      }
    }
    // Sweep spouse_of edges so non-bloodline partners of any hidden
    // descendant come along (otherwise they linger as stranded cards
    // on the canvas while their spouse + kids are tucked into the
    // panel).
    const bloodline = new Set<number>(directLine);
    for (const head of heads) bloodline.add(head);
    // Walk down from heads to populate the rest of the bloodline so
    // hidden side-branch descendants count as bloodline (for the
    // spouse sweep test).
    for (const id of hidden) bloodline.add(id);
    for (const e of layoutGraph.edges) {
      if (e.type !== 'spouse_of') continue;
      if (hidden.has(e.aId) && !bloodline.has(e.bId)) hidden.add(e.bId);
      if (hidden.has(e.bId) && !bloodline.has(e.aId)) hidden.add(e.aId);
    }
    return hidden;
  })();
  const layout = layoutGraph ? computeFocusLayout(layoutGraph, effectiveLayoutHops, { excludeFromSpacing: sideBranchHiddenIds }) : null;

  const handleRefocus = useCallback((personId: number) => {
    setFocusPersonId(personId);
  }, []);

  /** Resolve a +sibling quick-add now that the user has chosen the
   *  sibling flavour. Runs the appropriate wiring:
   *   full → cross-inherit parents + top up to 2 with ghosts
   *   half → explicit sibling_of with flags.half, cross-wire shared parent if known
   *   none/unknown → explicit sibling_of only, parents untouched
   */
  const finaliseSiblingKind = useCallback(async (kind: SiblingKind, sharedParentId: number | null) => {
    if (!siblingKindDialog) return;
    const { fromId, toId } = siblingKindDialog;
    setSiblingKindDialog(null);

    // Read parents LIVE from the DB per person, not from the React
    // graph state — previous adds may not have refetched by the time
    // the next sibling dialog fires, so reading the React state would
    // wrongly treat a just-added person as parentless and spin up a
    // whole new pair of placeholders (Alan → Trisha works, but Trisha
    // → Peter then mints P3/P4 instead of cross-inheriting P1/P2).
    const parentsOf = async (pid: number): Promise<number[]> => {
      const r = await listRelationshipsForPerson(pid);
      if (!r.success || !r.data) return [];
      return r.data
        .filter(row => row.type === 'parent_of' && row.person_b_id === pid)
        .map(row => row.person_a_id);
    };

    if (kind === 'full') {
      const fromParents = await parentsOf(fromId);
      const toParents = await parentsOf(toId);
      for (const pid of toParents) {
        if (!fromParents.includes(pid)) await addRelationship({ personAId: pid, personBId: fromId, type: 'parent_of' });
      }
      for (const pid of fromParents) {
        if (!toParents.includes(pid)) await addRelationship({ personAId: pid, personBId: toId, type: 'parent_of' });
      }
      const shared = new Set<number>([...fromParents, ...toParents]);
      const missing = Math.max(0, 2 - shared.size);
      for (let i = 0; i < missing; i++) {
        const ph = await createPlaceholderPerson();
        if (ph.success && ph.data != null) {
          await addRelationship({ personAId: ph.data, personBId: fromId, type: 'parent_of' });
          await addRelationship({ personAId: ph.data, personBId: toId, type: 'parent_of' });
        }
      }
    } else if (kind === 'half') {
      await addRelationship({ personAId: fromId, personBId: toId, type: 'sibling_of', flags: { half: true } });
      if (sharedParentId != null) {
        const fromParents = await parentsOf(fromId);
        const toParents = await parentsOf(toId);
        if (!fromParents.includes(sharedParentId)) {
          await addRelationship({ personAId: sharedParentId, personBId: fromId, type: 'parent_of' });
        }
        if (!toParents.includes(sharedParentId)) {
          await addRelationship({ personAId: sharedParentId, personBId: toId, type: 'parent_of' });
        }
      }
    } else {
      // 'none' or 'unknown' — just link them.
      await addRelationship({ personAId: fromId, personBId: toId, type: 'sibling_of' });
    }

    // Refresh the graph + run the same Steps/Generations awareness
    // checks the parent/partner/child path runs in finaliseQuickAdd:
    // probe deeper if needed to discover the new sibling's hop
    // distance, pin them if they land beyond expandedHops (so they
    // stay visible), pulse the Steps pill, and prompt the user to
    // bump Steps so the new sibling becomes naturally visible.
    // Without this, adding e.g. Sylvia's sister Gladys at Steps=2
    // dropped her quietly past the cap with no nudge and no prompt.
    if (focusPersonId != null) {
      let probeDepth = fetchDepth;
      for (let i = 0; i < 7 && probeDepth <= 10; i++) {
        const res = await getFamilyGraph(focusPersonId, probeDepth);
        if (res.success && res.data) {
          const found = res.data.nodes.find(n => n.personId === toId);
          if (found) {
            setGraph(res.data);
            if (found.hopsFromFocus > expandedHops) {
              setPinnedPeople(prev => {
                const next = new Map(prev);
                next.set(toId, found.hopsFromFocus);
                return next;
              });
              setPulseSteps(true);
              const requiredSteps = found.hopsFromFocus;
              const newPersonFullName = displayName(toId, 'this person');
              promptConfirm({
                eyebrow: 'Beyond your current view',
                title: `${newPersonFullName} sits ${requiredSteps} steps from focus`,
                message: `Your Steps cap is ${expandedHops}, so they're pinned visible just for this session. Increase Steps to ${requiredSteps} to see them naturally and bring along anyone else at that distance too.`,
                confirmLabel: `Increase Steps to ${requiredSteps}`,
                cancelLabel: 'Keep them pinned',
              }).then(result => {
                if (result === true) {
                  setExpandedHops(requiredSteps);
                  setPinnedPeople(prev => {
                    const next = new Map(prev);
                    next.delete(toId);
                    return next;
                  });
                }
              });
            }
            const newGen = computeGenerationOffset(res.data, focusPersonId, toId);
            if (newGen != null && (newGen > ancestorsDepth || newGen < -descendantsDepth)) {
              setPulseGenerations(true);
            }
            return;
          }
        }
        probeDepth++;
      }
      refetchGraph(focusPersonId, fetchDepth);
    }
  }, [siblingKindDialog, focusPersonId, fetchDepth, refetchGraph, expandedHops, ancestorsDepth, descendantsDepth, displayName]);

  // ── Saved trees: auto-save on state change ────────────────────
  // Persist the current filter / focus state to the active tree
  // whenever anything changes. Suppressed while we're applying a
  // loaded tree (otherwise we'd immediately overwrite it).
  useEffect(() => {
    if (applyingTreeRef.current) return;
    if (currentTreeId == null) return;
    if (focusPersonId == null) return; // nothing to save yet
    updateSavedTree(currentTreeId, {
      focusPersonId,
      stepsEnabled,
      stepsDepth: expandedHops,
      generationsEnabled,
      ancestorsDepth,
      descendantsDepth,
    });
  }, [currentTreeId, focusPersonId, stepsEnabled, expandedHops, generationsEnabled, ancestorsDepth, descendantsDepth]);

  // First-visit auto-create: once a focus person has been chosen AND
  // we have no saved trees yet, mint "My Tree" so auto-save has a
  // target. Runs once; guarded by the list length.
  useEffect(() => {
    if (currentTreeId != null) return;
    if (focusPersonId == null) return;
    if (savedTrees.length > 0) return;
    (async () => {
      const r = await createSavedTree({
        name: 'My Tree',
        focusPersonId,
        stepsEnabled,
        stepsDepth: expandedHops,
        generationsEnabled,
        ancestorsDepth,
        descendantsDepth,
      });
      if (r.success && r.data) {
        setSavedTrees([r.data]);
        setCurrentTreeId(r.data.id);
      }
    })();
  }, [currentTreeId, focusPersonId, savedTrees.length, stepsEnabled, expandedHops, generationsEnabled, ancestorsDepth, descendantsDepth]);

  const currentTree = savedTrees.find(t => t.id === currentTreeId) ?? null;

  const switchToTree = useCallback((tree: SavedTreeRecord) => {
    applyingTreeRef.current = true;
    setCurrentTreeId(tree.id);
    if (tree.focusPersonId != null) setFocusPersonId(tree.focusPersonId);
    // Always-on filters (toggle UI gone). See top-of-file equivalent
    // load path for the same translation: stepsEnabled=false →
    // expandedHops=0 (no constraint), generationsEnabled=false →
    // ancestorsDepth=0 + descendantsDepth=0.
    setStepsEnabled(true);
    setExpandedHops(tree.stepsEnabled ? tree.stepsDepth : 0);
    setGenerationsEnabled(true);
    setAncestorsDepth(tree.generationsEnabled ? tree.ancestorsDepth : 0);
    setDescendantsDepth(tree.generationsEnabled ? tree.descendantsDepth : 0);
    updateSavedTree(tree.id, { markOpened: true });
    setManageTreesOpen(false);
    setTimeout(() => { applyingTreeRef.current = false; }, 0);
  }, []);

  const reloadSavedTrees = useCallback(async () => {
    const r = await listSavedTrees();
    if (r.success && r.data) setSavedTrees(r.data);
  }, []);

  const commitTreeNameRename = useCallback(async () => {
    if (currentTreeId == null) { setEditingTreeName(false); return; }
    const trimmed = treeNameDraft.trim();
    if (!trimmed) { setEditingTreeName(false); return; }
    await updateSavedTree(currentTreeId, { name: trimmed });
    await reloadSavedTrees();
    setEditingTreeName(false);
  }, [currentTreeId, treeNameDraft, reloadSavedTrees]);

  // Per-tree suggestion-exclusion plumbing. Shared between the + quick-add
  // picker (FocusPickerModal) and the "Who is this?" placeholder resolver
  // (PlaceholderResolver) so a hide in either surface takes effect in
  // both — one tree, one exclusion list.
  const toggleExcludedSuggestion = useCallback(async (personId: number) => {
    if (currentTreeId == null) return;
    const tree = savedTrees.find(t => t.id === currentTreeId);
    const current = new Set(tree?.excludedSuggestionPersonIds ?? []);
    if (current.has(personId)) current.delete(personId);
    else current.add(personId);
    await updateSavedTree(currentTreeId, { excludedSuggestionPersonIds: [...current] });
    await reloadSavedTrees();
  }, [currentTreeId, savedTrees, reloadSavedTrees]);

  // Namesake lookup against the current tree — if the typed name matches
  // someone already in the family closure, return them so the caller can
  // warn. Root cause of the double-Dorothy bug: no warning fired in the
  // placeholder resolver's Name-them path.
  const nameConflictLookup = useCallback((typed: string) => {
    const needle = typed.trim().toLowerCase();
    if (!needle) return null;
    for (const p of allPersons) {
      if (!connectedPersonIds.has(p.id)) continue;
      if (p.name.trim().toLowerCase() === needle) {
        return { id: p.id, name: p.name };
      }
    }
    return null;
  }, [allPersons, connectedPersonIds]);

  /** After a parent_of edge is added (parentId is the new parent of
   *  childId), if the child now has exactly two parents and they
   *  aren't already linked by a spouse_of edge, prompt the user to
   *  pick the relationship status between the parents. Shared by
   *  the +parent quick-add flow AND the placeholder click-to-name
   *  flow so both produce a consistent UX — without this, filling
   *  placeholders for grandparents was leaving them as silent
   *  co-parents because the prompt only fired from the chip path. */
  const maybePromptParentRelationship = useCallback(async (parentId: number, childId: number) => {
    const childRels = await listRelationshipsForPerson(childId);
    if (!childRels.success || !childRels.data) return;
    const parentEdges = childRels.data.filter(r => r.type === 'parent_of' && r.person_b_id === childId);
    const otherParentIds = parentEdges.map(r => r.person_a_id).filter(id => id !== parentId);
    if (otherParentIds.length !== 1) return;
    const existingParentId = otherParentIds[0];
    // Check both endpoints' relationships for an existing spouse_of —
    // since neither parent is the child, listRelationshipsForPerson(child)
    // doesn't include their spouse edge. We have to ask the parent.
    const parentRels = await listRelationshipsForPerson(parentId);
    if (!parentRels.success || !parentRels.data) return;
    const alreadySpouses = parentRels.data.some(r =>
      r.type === 'spouse_of' && (
        r.person_a_id === existingParentId || r.person_b_id === existingParentId
      ),
    );
    if (alreadySpouses) return;
    const childFullName = displayName(childId, 'this person');
    const newParentFullName = displayName(parentId, 'this parent');
    const existingParentFullName = displayName(existingParentId, 'the other parent');
    const newParentAvatar = await fetchPersonAvatar(parentId, graph, allPersons);
    const existingParentAvatar = await fetchPersonAvatar(existingParentId, graph, allPersons);
    const choice = await promptChoice<'married' | 'partners' | 'previously' | 'coparents_only'>({
      eyebrow: 'Relationship status',
      title: `How are ${newParentFullName} and ${existingParentFullName} related?`,
      message: `Both are ${childFullName}'s parents.`,
      avatars: {
        left: { src: newParentAvatar, label: newParentFullName, initial: newParentFullName.charAt(0) },
        right: { src: existingParentAvatar, label: existingParentFullName, initial: existingParentFullName.charAt(0) },
      },
      choices: [
        { id: 'married', label: 'Married', description: 'Currently married — they\'re spouses.', primary: true },
        { id: 'partners', label: 'Partners', description: 'Together but not married — civil partnership, long-term relationship, etc.' },
        { id: 'previously', label: 'Previously together', description: 'Divorced, separated, or no longer a couple.' },
        { id: 'coparents_only', label: 'Co-parents', description: 'Never were a couple.' },
      ],
    });
    if (choice === 'married') {
      await addRelationship({ personAId: parentId, personBId: existingParentId, type: 'spouse_of', flags: { married: true } });
    } else if (choice === 'partners') {
      await addRelationship({ personAId: parentId, personBId: existingParentId, type: 'spouse_of', flags: { married: false } });
    } else if (choice === 'previously') {
      await addRelationship({ personAId: parentId, personBId: existingParentId, type: 'spouse_of', flags: { ended: true } });
    }
    // 'coparents_only' / null: leave them as separate parents.
  }, [graph, allPersons, displayName]);

  // Hidden-person list for the review panel. Computed from the current
  // tree's exclusion IDs + the allPersons name lookup so both modals
  // can render the same "N hidden — review" footer.
  const hiddenSuggestions = (() => {
    const ids = currentTree?.excludedSuggestionPersonIds ?? [];
    return ids
      .map(id => allPersons.find(p => p.id === id))
      .filter((p): p is PersonSummary => p != null)
      .map(p => ({ id: p.id, name: p.name }));
  })();

  // Exclusion set as a Set<number> for O(1) filter checks.
  const excludedSuggestionIdSet = new Set(currentTree?.excludedSuggestionPersonIds ?? []);

  const handleRelationshipCreated = useCallback(() => {
    // A graph mutation can also change the person table (e.g. a ghost
    // placeholder getting named, or a new named person created via the
    // modal). Reload BOTH so pickers that filter by is_placeholder
    // don't leave the newly-named person out of the list.
    reloadPersons();
    if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
    refreshHistoryCounts();
  }, [focusPersonId, fetchDepth, refetchGraph, reloadPersons, refreshHistoryCounts]);

  /** Finalise a quick-add: the user has picked (or created) the other person,
   *  so wire the actual relationship based on the chip direction. */
  const finaliseQuickAdd = useCallback(async (otherPersonId: number, otherPersonName: string) => {
    if (!quickAdd) return;
    const { fromPersonId, kind } = quickAdd;
    setQuickAdd(null);
    if (kind === 'parent') {
      await addRelationship({ personAId: otherPersonId, personBId: fromPersonId, type: 'parent_of' });
      // Marriage prompt fires from the shared helper — same logic
      // runs from the placeholder click-to-name path. See
      // maybePromptParentRelationship for the full check.
      await maybePromptParentRelationship(otherPersonId, fromPersonId);
    } else if (kind === 'child') {
      // Defer the parent_of(fromPerson, child) write until AFTER the
      // co-parent prompts resolve. If the user DISMISSES any prompt
      // (X close, backdrop click, Escape) we abort the whole flow —
      // no relationship gets written. That matches Terry's
      // expectation that closing the dialog means "I changed my
      // mind", not "no second parent". Explicit "No" still completes
      // the add as a single-parent record.
      //
      // Two sources of co-parent candidates:
      //   1. CURRENT spouses (spouse_of, not ended).
      //   2. IMPLICIT co-parents — anyone already a parent_of one of
      //      fromPerson's existing children. Catches the case where
      //      grandparents share an existing child but aren't on file
      //      as spouses, so adding a sibling via just one of them
      //      would otherwise produce a half-sibling.
      const rels = await listRelationshipsForPerson(fromPersonId);
      const allRels = rels.success && rels.data ? rels.data : [];
      type CandidateMeta = { source: 'spouse' } | { source: 'implicit'; viaChildId: number };
      const candidates = new Map<number, CandidateMeta>();
      for (const r of allRels) {
        if (r.type === 'spouse_of' && !r.until) {
          const otherId = r.person_a_id === fromPersonId ? r.person_b_id : r.person_a_id;
          if (otherId !== otherPersonId) candidates.set(otherId, { source: 'spouse' });
        }
      }
      const ourChildren = allRels
        .filter(r => r.type === 'parent_of' && r.person_a_id === fromPersonId && r.person_b_id !== otherPersonId)
        .map(r => r.person_b_id);
      for (const childId of ourChildren) {
        const childRels = await listRelationshipsForPerson(childId);
        if (!childRels.success || !childRels.data) continue;
        for (const r of childRels.data) {
          if (r.type !== 'parent_of') continue;
          if (r.person_b_id !== childId) continue;
          const parentId = r.person_a_id;
          if (parentId === fromPersonId || parentId === otherPersonId) continue;
          if (!candidates.has(parentId)) {
            candidates.set(parentId, { source: 'implicit', viaChildId: childId });
          }
        }
      }

      // Run the prompts (if any) and collect the user's per-candidate
      // decisions. Dismissal aborts; "No" just means "skip this one";
      // "Yes" records that we should add this co-parent.
      const fromFullName = displayName(fromPersonId, 'them');
      const childFullName = displayName(otherPersonId, otherPersonName?.trim() || 'this child');
      const childAvatar = await fetchPersonAvatar(otherPersonId, graph, allPersons);
      const coparentsToAdd: number[] = [];
      let dismissed = false;
      for (const [candidateId, meta] of candidates) {
        const candidateFullName = displayName(candidateId, 'their co-parent');
        const candidateAvatar = await fetchPersonAvatar(candidateId, graph, allPersons);
        const message = meta.source === 'spouse'
          ? `${candidateFullName} is currently ${fromFullName}'s partner.`
          : `${candidateFullName} already shares ${displayName(meta.viaChildId, 'another child')} with ${fromFullName}.`;
        const result = await promptConfirm({
          eyebrow: 'Confirm parentage',
          title: `Is ${candidateFullName} also a parent?`,
          message,
          avatars: {
            left: { src: candidateAvatar, label: candidateFullName, initial: candidateFullName.charAt(0) },
            right: { src: childAvatar, label: childFullName, initial: childFullName.charAt(0) },
          },
          confirmLabel: 'Yes, add as parent',
          cancelLabel: 'No',
        });
        if (result === null) {
          dismissed = true;
          break;
        }
        if (result === true) coparentsToAdd.push(candidateId);
      }

      if (dismissed) {
        // User abandoned the flow. Nothing was written; just refresh
        // the layout so any optimistic UI bumps reset and exit early.
        if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
        return;
      }

      // Apply the writes: parent_of(fromPerson, child) is the always-
      // intended addition; co-parents the user said Yes to follow.
      await addRelationship({ personAId: fromPersonId, personBId: otherPersonId, type: 'parent_of' });
      for (const coparentId of coparentsToAdd) {
        await addRelationship({ personAId: coparentId, personBId: otherPersonId, type: 'parent_of' });
      }
    } else if (kind === 'partner') {
      // Ask which kind of partnership before writing — same modal
      // style as the parent-pair prompt, three options instead of
      // four (no co-parent option here since there's no child
      // involved in the question). Dismiss aborts the whole add.
      const fromFullName = displayName(fromPersonId, 'them');
      const otherFullName = displayName(otherPersonId, otherPersonName?.trim() || 'this person');
      const fromAvatar = await fetchPersonAvatar(fromPersonId, graph, allPersons);
      const otherAvatar = await fetchPersonAvatar(otherPersonId, graph, allPersons);
      const choice = await promptChoice<'married' | 'partners' | 'previously'>({
        eyebrow: 'Relationship status',
        title: `How are ${fromFullName} and ${otherFullName} related?`,
        message: 'Pick the state that fits — you can change it later.',
        avatars: {
          left: { src: fromAvatar, label: fromFullName, initial: fromFullName.charAt(0) },
          right: { src: otherAvatar, label: otherFullName, initial: otherFullName.charAt(0) },
        },
        choices: [
          { id: 'married', label: 'Married', description: 'Currently married — they\'re spouses.', primary: true },
          { id: 'partners', label: 'Partners', description: 'Together but not married — civil partnership, long-term relationship, etc.' },
          { id: 'previously', label: 'Previously together', description: 'Divorced, separated, or no longer a couple.' },
        ],
      });
      if (choice === null) return; // dismissed → write nothing
      if (choice === 'married') {
        await addRelationship({ personAId: fromPersonId, personBId: otherPersonId, type: 'spouse_of', flags: { married: true } });
      } else if (choice === 'partners') {
        await addRelationship({ personAId: fromPersonId, personBId: otherPersonId, type: 'spouse_of', flags: { married: false } });
      } else if (choice === 'previously') {
        await addRelationship({ personAId: fromPersonId, personBId: otherPersonId, type: 'spouse_of', flags: { ended: true } });
      }

      // After the spouse/partner edge is written: gather every child
      // of fromPerson who doesn't already have the new partner as a
      // parent and ask in ONE multi-select modal whether the new
      // partner is also their parent. Replaces a previous per-child
      // loop of confirms, which became a slog when fromPerson had
      // several existing children. Default state: all ticked (the
      // common case is that a new partner inherits the children the
      // user has on file).
      const fromRels = await listRelationshipsForPerson(fromPersonId);
      const fromChildren = fromRels.success && fromRels.data
        ? fromRels.data
            .filter(r => r.type === 'parent_of' && r.person_a_id === fromPersonId)
            .map(r => r.person_b_id)
        : [];
      if (fromChildren.length > 0) {
        const otherIsParentAlready = new Set<number>();
        const otherRels = await listRelationshipsForPerson(otherPersonId);
        if (otherRels.success && otherRels.data) {
          for (const r of otherRels.data) {
            if (r.type === 'parent_of' && r.person_a_id === otherPersonId) {
              otherIsParentAlready.add(r.person_b_id);
            }
          }
        }
        const candidates = fromChildren.filter(id => !otherIsParentAlready.has(id));
        if (candidates.length > 0) {
          const items = await Promise.all(candidates.map(async id => {
            const fullName = displayName(id, 'this child');
            const avatar = await fetchPersonAvatar(id, graph, allPersons);
            return {
              id,
              label: fullName,
              avatar: { src: avatar, label: fullName, initial: fullName.charAt(0) },
              checked: true,
            };
          }));
          const titleLabel = candidates.length === 1
            ? `Is ${otherFullName} also a parent?`
            : `Is ${otherFullName} also a parent of these children?`;
          const selected = await promptCheckList<number>({
            eyebrow: 'Confirm parentage',
            title: titleLabel,
            message: (
              <>
                <strong className="text-foreground">{otherFullName}</strong> is now{' '}
                <strong className="text-foreground">{fromFullName}</strong>'s partner.{' '}
                {candidates.length === 1
                  ? 'Tick the box if they’re also this child’s parent.'
                  : 'Tick the children they’re also a parent of.'}
              </>
            ),
            avatars: {
              left: { src: otherAvatar, label: otherFullName, initial: otherFullName.charAt(0) },
            },
            items,
            confirmLabel: 'Add as parent',
            cancelLabel: 'No, just partner',
          });
          if (selected && selected.length > 0) {
            for (const childId of selected) {
              await addRelationship({ personAId: otherPersonId, personBId: childId, type: 'parent_of' });
            }
            // Placeholder reabsorption — when the new partner becomes
            // a parent of children who already share an UNNAMED
            // placeholder co-parent (typically created by the
            // full-sibling auto-fill: marking Abby as a full sister
            // of Chloe spawns a shared placeholder so the sibling
            // link can derive from a parent_of relationship), the
            // new partner IS that placeholder. Merge it in instead
            // of leaving each child with both the placeholder AND
            // the named partner as separate parents — which was
            // exactly Terry's case ("I added Sam as Ian's ex-wife
            // and confirmed she's Chloe + Abby's mother — surely
            // that should fill the placeholder").
            //
            // Rule: any placeholder that's a co-parent of EVERY
            // child the user just confirmed is unambiguously the
            // person they were trying to fill in. Merge transfers
            // its parent_of edges to the new partner (deduping
            // against any we just wrote) and deletes the placeholder
            // row.
            const placeholderCoparentCounts = new Map<number, number>();
            for (const childId of selected) {
              const childRels = await listRelationshipsForPerson(childId);
              if (!childRels.success || !childRels.data) continue;
              for (const r of childRels.data) {
                if (r.type !== 'parent_of') continue;
                if (r.person_b_id !== childId) continue;
                const pid = r.person_a_id;
                if (pid === otherPersonId) continue;
                const node = graph?.nodes.find(n => n.personId === pid);
                if (!node || !node.isPlaceholder) continue;
                placeholderCoparentCounts.set(pid, (placeholderCoparentCounts.get(pid) ?? 0) + 1);
              }
            }
            for (const [phId, count] of placeholderCoparentCounts) {
              if (count !== selected.length) continue;
              await mergePlaceholderIntoPerson(phId, otherPersonId);
            }
          }
        }
      }
    } else if (kind === 'sibling') {
      // Ask the user what kind of sibling relationship it is, rather
      // than silently assuming full siblings and auto-filling ghost
      // parents. Use the just-typed name (if this was a "Name them"
      // create) before falling back to allPersons, which may not have
      // reloaded yet.
      // Prefer full names — "Sylvia Mills" reads more clearly than the
      // short / nickname form in a decision dialog.
      const fromName = displayName(fromPersonId, 'this person');
      const toName = displayName(otherPersonId, otherPersonName?.trim() || 'this person');
      setSiblingKindDialog({ fromId: fromPersonId, toId: otherPersonId, fromName, toName });
      return; // dialog confirm handles the rest
    }

    // Probe fetch depth upward until the new person appears, so we know
    // their hop distance. If they end up beyond the user's selected
    // Depth, pin them — that keeps them visible via the asymmetric
    // pathway without expanding every other branch symmetrically.
    if (focusPersonId != null) {
      let probeDepth = fetchDepth;
      for (let i = 0; i < 7 && probeDepth <= 10; i++) {
        const res = await getFamilyGraph(focusPersonId, probeDepth);
        if (res.success && res.data) {
          const found = res.data.nodes.find(n => n.personId === otherPersonId);
          if (found) {
            setGraph(res.data);
            if (found.hopsFromFocus > expandedHops) {
              setPinnedPeople(prev => {
                const next = new Map(prev);
                next.set(otherPersonId, found.hopsFromFocus);
                return next;
              });
              setPulseSteps(true);
              // Prompt the user to bump Steps so the new person is
              // naturally visible (not just pinned) — keeps them
              // aware that they're sitting beyond the current cap
              // and offers a one-click way to extend the view.
              // Fire-and-forget — the function returns immediately
              // and the modal handles its own state.
              const requiredSteps = found.hopsFromFocus;
              const newPersonFullName = displayName(otherPersonId, otherPersonName?.trim() || 'this person');
              promptConfirm({
                eyebrow: 'Beyond your current view',
                title: `${newPersonFullName} sits ${requiredSteps} steps from focus`,
                message: `Your Steps cap is ${expandedHops}, so they're pinned visible just for this session. Increase Steps to ${requiredSteps} to see them naturally and bring along anyone else at that distance too.`,
                confirmLabel: `Increase Steps to ${requiredSteps}`,
                cancelLabel: 'Keep them pinned',
              }).then(result => {
                if (result === true) {
                  setExpandedHops(requiredSteps);
                  // Unpin so they're picked up by the Steps cap
                  // naturally — pinning was just a session-scoped
                  // safety net.
                  setPinnedPeople(prev => {
                    const next = new Map(prev);
                    next.delete(otherPersonId);
                    return next;
                  });
                }
              });
            }
            // Generations overage check: re-derive the new person's
            // generation offset from the same BFS the renderer uses,
            // then compare against the active ancestors/descendants
            // caps. Triggers a brief pulse on the Generations pill so
            // the user sees their filter would have hidden this add
            // (the pin keeps them visible regardless).
            const newGen = computeGenerationOffset(res.data, focusPersonId, otherPersonId);
            if (newGen != null && (newGen > ancestorsDepth || newGen < -descendantsDepth)) {
              setPulseGenerations(true);
            }
            // Fire the comet trail showing the path from focus to the
            // newly-added person. Gated inside triggerCreationHighlight
            // on the master + per-effect Visual Effects toggles, so a
            // user who turned them off sees nothing. Setting this AFTER
            // setGraph(res.data) so the layout already contains the
            // new person when PathwayHighlight runs its BFS.
            triggerCreationHighlight(otherPersonId);
            return;
          }
        }
        probeDepth++;
      }
      // Couldn't find them within 10 hops — unusual; just refresh at default.
      refetchGraph(focusPersonId, fetchDepth);
      triggerCreationHighlight(otherPersonId);
    }
  }, [quickAdd, graph, focusPersonId, expandedHops, ancestorsDepth, descendantsDepth, fetchDepth, refetchGraph, displayName, allPersons, triggerCreationHighlight]);

  /** Toggle reveal/hide for one person's beyond-capacity ancestors.
   *  First click probes deeper graph, walks parent_of edges upward
   *  from `personId`, and pins each newly-discovered ancestor —
   *  recording in ancestorPinSourcesRef which pins THIS expansion
   *  contributed. Second click reverses: removes from pinnedPeople
   *  any ancestor whose only remaining contributor was this
   *  expansion. Ref-counting means two chevrons can both reveal a
   *  shared ancestor without one collapse erasing the other's view.
   *
   *  Direction-aware: walks ONLY upward, so clicking the chevron
   *  above Lindsay doesn't drag in her partner's lineage. */
  const handleExpandAncestors = useCallback(async (personId: number) => {
    if (focusPersonId == null) return;

    // ── Collapse path ───────────────────────────────────────────────
    if (expandedAncestorsOf.has(personId)) {
      const sourced = ancestorPinSourcesRef.current.get(personId) ?? new Set<number>();
      // Remove this expander's claim from every pin it contributed.
      // A pin disappears from pinnedPeople only when no other
      // expander is still claiming it. Remaining claimants are
      // tracked by walking the OTHER expanded sets.
      const stillClaimedBy = new Map<number, number>(); // pinId → count
      for (const otherExpander of expandedAncestorsOf) {
        if (otherExpander === personId) continue;
        const otherSourced = ancestorPinSourcesRef.current.get(otherExpander);
        if (!otherSourced) continue;
        for (const pid of otherSourced) stillClaimedBy.set(pid, (stillClaimedBy.get(pid) ?? 0) + 1);
      }
      for (const otherExpander of expandedDescendantsOf) {
        const otherSourced = descendantPinSourcesRef.current.get(otherExpander);
        if (!otherSourced) continue;
        for (const pid of otherSourced) stillClaimedBy.set(pid, (stillClaimedBy.get(pid) ?? 0) + 1);
      }
      setPinnedPeople(prev => {
        const next = new Map(prev);
        for (const pid of sourced) {
          if ((stillClaimedBy.get(pid) ?? 0) === 0) next.delete(pid);
        }
        return next;
      });
      ancestorPinSourcesRef.current.delete(personId);
      setExpandedAncestorsOf(prev => {
        const next = new Set(prev);
        next.delete(personId);
        return next;
      });
      return;
    }

    // ── Reveal path ─────────────────────────────────────────────────
    // Fast path: if the current graph already contains ancestors above
    // this person (the common case when toggling a non-bloodline
    // chevron — Lindsay's family-of-origin is usually fetched but
    // hidden by default), just flip the expanded flag. The render-
    // level filter (hiddenExtendedIds) does the rest. No probe, no
    // pin churn.
    if (graph) {
      const parentsOfFast = new Map<number, number[]>();
      for (const e of graph.edges) {
        if (e.type !== 'parent_of') continue;
        if (!parentsOfFast.has(e.bId)) parentsOfFast.set(e.bId, []);
        parentsOfFast.get(e.bId)!.push(e.aId);
      }
      let hasAncestorInGraph = false;
      const stack = [personId];
      const seenFast = new Set<number>([personId]);
      while (stack.length) {
        const cur = stack.pop()!;
        for (const p of parentsOfFast.get(cur) ?? []) {
          if (seenFast.has(p)) continue;
          seenFast.add(p);
          hasAncestorInGraph = true;
          stack.push(p);
        }
      }
      if (hasAncestorInGraph) {
        setExpandedAncestorsOf(prev => {
          const next = new Set(prev);
          next.add(personId);
          return next;
        });
        // No pin contributions — these ancestors were already in
        // graph, just hidden by the filter. Empty source set keeps
        // the collapse-path bookkeeping consistent.
        ancestorPinSourcesRef.current.set(personId, new Set());
        return;
      }
    }

    // Slow path: nothing above this person in current graph — they're
    // genuinely beyond the active fetch depth. Probe deeper, pin the
    // newly-discovered ancestors, mark expanded.
    const startingPersonIds = new Set<number>(graph?.nodes.map(n => n.personId) ?? []);
    let probeDepth = fetchDepth;
    for (let i = 0; i < 4 && probeDepth <= 10; i++) {
      probeDepth++;
      const res = await getFamilyGraph(focusPersonId, probeDepth);
      if (!res.success || !res.data) continue;
      const parentsOf = new Map<number, number[]>();
      for (const e of res.data.edges) {
        if (e.type !== 'parent_of') continue;
        if (!parentsOf.has(e.bId)) parentsOf.set(e.bId, []);
        parentsOf.get(e.bId)!.push(e.aId);
      }
      const queue: number[] = [personId];
      const newlyRevealed = new Map<number, number>(); // personId → hopsFromFocus
      const seen = new Set<number>([personId]);
      while (queue.length) {
        const cur = queue.shift()!;
        for (const p of parentsOf.get(cur) ?? []) {
          if (seen.has(p)) continue;
          seen.add(p);
          if (!startingPersonIds.has(p)) {
            const hop = res.data.nodes.find(n => n.personId === p)?.hopsFromFocus;
            if (hop != null) newlyRevealed.set(p, hop);
          }
          queue.push(p);
        }
      }
      if (newlyRevealed.size > 0) {
        setGraph(res.data);
        setPinnedPeople(prev => {
          const next = new Map(prev);
          for (const [pid, hop] of newlyRevealed) next.set(pid, hop);
          return next;
        });
        ancestorPinSourcesRef.current.set(personId, new Set(newlyRevealed.keys()));
        setExpandedAncestorsOf(prev => {
          const next = new Set(prev);
          next.add(personId);
          return next;
        });
        setPulseSteps(true);
        return;
      }
    }
    refetchGraph(focusPersonId, fetchDepth);
  }, [focusPersonId, graph, fetchDepth, refetchGraph, expandedAncestorsOf, expandedDescendantsOf]);

  /** Toggle reveal/hide for a side-branch head's cousins (bloodline
   *  descendants of an aunt / uncle / great-aunt). Pure flag flip —
   *  no graph probe needed because cousins are already in the
   *  fetched graph (they're bloodline, included in the connected-
   *  component fetch); the canvas's render filter
   *  (hiddenSideBranchIds) is what was hiding them. Mirrors the
   *  fast-path of handleExpandAncestors. */
  const handleExpandDescendants = useCallback((personId: number) => {
    if (focusPersonId == null) return;
    if (expandedDescendantsOf.has(personId)) {
      // Collapse — just clear the flag. No pin contributions to
      // unwind because the reveal path doesn't pin (cousins are in
      // graph by default).
      setExpandedDescendantsOf(prev => {
        const next = new Set(prev);
        next.delete(personId);
        return next;
      });
      descendantPinSourcesRef.current.delete(personId);
      return;
    }
    setExpandedDescendantsOf(prev => {
      const next = new Set(prev);
      next.add(personId);
      return next;
    });
    descendantPinSourcesRef.current.set(personId, new Set());
  }, [focusPersonId, expandedDescendantsOf]);

  /** Steps-aware +parent gate. Before opening the +parent picker
   *  for a person, check whether they already have parents stored
   *  but currently hidden by the Steps cap. If so, the user almost
   *  certainly didn't realise — prompt them to bump Steps and
   *  reveal what's already there instead of creating a duplicate.
   *  If they say "Add another parent anyway" we fall through to
   *  the normal flow (covers step-parent / multi-parent cases).
   */
  const handleQuickAddParentWithStepsGate = useCallback(async (personId: number) => {
    if (!graph || !visibleGraph || focusPersonId == null) {
      setQuickAdd({ fromPersonId: personId, kind: 'parent' });
      return;
    }
    const visibleIds = new Set(visibleGraph.nodes.map(n => n.personId));
    const existingParents = graph.edges
      .filter(e => e.type === 'parent_of' && e.bId === personId && !e.derived)
      .map(e => e.aId);
    const hiddenParents = existingParents.filter(pid => !visibleIds.has(pid));
    if (hiddenParents.length === 0) {
      setQuickAdd({ fromPersonId: personId, kind: 'parent' });
      return;
    }
    // Build the prompt copy and figure out the Steps target that
    // would reveal them. Steps target = max hopsFromFocus across
    // hidden parents — that's the lowest Steps value at which all
    // of them appear.
    const personFullName = displayName(personId, 'this person');
    const hiddenNames = hiddenParents
      .map(p => displayName(p, '?'))
      .filter(s => s !== '?')
      .join(' and ');
    const requiredSteps = Math.max(
      ...hiddenParents.map(pid => graph.nodes.find(n => n.personId === pid)?.hopsFromFocus ?? expandedHops + 1),
    );
    const result = await promptConfirm({
      eyebrow: 'Hidden on this tree',
      title: `${personFullName} already has ${hiddenParents.length === 1 ? 'a parent' : `${hiddenParents.length} parents`} on file`,
      message: hiddenNames
        ? `${hiddenNames} ${hiddenParents.length === 1 ? 'is' : 'are'} hidden by your current Steps cap of ${expandedHops}. Increase Steps to ${requiredSteps} to see ${hiddenParents.length === 1 ? 'them' : 'both'} now.`
        : `${hiddenParents.length === 1 ? 'A parent is' : `${hiddenParents.length} parents are`} hidden by your current Steps cap of ${expandedHops}. Increase Steps to ${requiredSteps} to see ${hiddenParents.length === 1 ? 'them' : 'all of them'}.`,
      confirmLabel: `Increase Steps to ${requiredSteps}`,
      cancelLabel: 'Add another parent anyway',
    });
    if (result === true) {
      setExpandedHops(requiredSteps);
      return;
    }
    if (result === false) {
      // Step-parent / multi-parent — fall through to normal flow.
      setQuickAdd({ fromPersonId: personId, kind: 'parent' });
      return;
    }
    // Dismissed — do nothing.
  }, [graph, visibleGraph, focusPersonId, expandedHops, displayName]);

  /** Hide every revealed extended-family branch in one click — the
   *  "tidy up" reset that keeps the tree from sprawling once the user
   *  has explored several in-laws' lineages. Removes any pins those
   *  expansions contributed (leaves quick-add pins alone since they
   *  don't sit in the expansion ref maps), then clears all expansion
   *  state. */
  const collapseAllExpansions = useCallback(() => {
    const allContributed = new Set<number>();
    for (const sourced of ancestorPinSourcesRef.current.values()) {
      for (const id of sourced) allContributed.add(id);
    }
    for (const sourced of descendantPinSourcesRef.current.values()) {
      for (const id of sourced) allContributed.add(id);
    }
    if (allContributed.size > 0) {
      setPinnedPeople(prev => {
        const next = new Map(prev);
        for (const id of allContributed) next.delete(id);
        return next;
      });
    }
    ancestorPinSourcesRef.current.clear();
    descendantPinSourcesRef.current.clear();
    setExpandedAncestorsOf(new Set());
    setExpandedDescendantsOf(new Set());
  }, []);

  const handleRemovePerson = useCallback(async (personId: number) => {
    // Remove every edge touching this person in the current graph.
    if (!graph) return;
    const edgesToRemove = graph.edges.filter(e =>
      (e.aId === personId || e.bId === personId) && e.id != null && !e.derived
    );
    if (edgesToRemove.length === 0) return;
    const personName = displayName(personId, 'this person');
    const confirmMsg = `This will remove all ${edgesToRemove.length} relationship${edgesToRemove.length === 1 ? '' : 's'} involving ${personName}. The person themselves stays — only the relationships go. You'll have a few seconds to undo.`;
    if (!(await promptConfirm({
      title: `Remove all relationships?`,
      message: confirmMsg,
      confirmLabel: 'Remove all',
      danger: true,
    }))) return;
    // Snapshot edges BEFORE removal so Undo can re-create them.
    // We capture the full shape (type, flags, since/until) so restore
    // is lossless.
    const snapshot = edgesToRemove.map(e => ({
      personAId: e.aId,
      personBId: e.bId,
      type: e.type as any,
      since: e.since ?? null,
      until: e.until ?? null,
      flags: e.flags ?? null,
    }));
    for (const e of edgesToRemove) {
      if (e.id != null) await removeRelationship(e.id);
    }
    if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);

    // Offer Undo — re-creates the stored edges one by one. 12s window.
    toast(`Removed ${edgesToRemove.length} relationship${edgesToRemove.length === 1 ? '' : 's'} for ${personName}`, {
      duration: 12000,
      action: {
        label: 'Undo',
        onClick: async () => {
          for (const s of snapshot) {
            await addRelationship(s);
          }
          if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
          toast.success(`Restored ${snapshot.length} relationship${snapshot.length === 1 ? '' : 's'}`);
        },
      },
    });
  }, [graph, focusPersonId, fetchDepth, refetchGraph, allPersons]);


  return (
    <div className="flex-1 h-full flex flex-col bg-background relative">
      {/* Header bar */}
      <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-3">
        <GitBranch className="w-5 h-5 text-primary" />
        {/* Current tree name — click to rename inline. Falls back to
            'Trees' label while nothing is loaded yet. */}
        {editingTreeName ? (
          <input
            autoFocus
            value={treeNameDraft}
            onChange={e => setTreeNameDraft(e.target.value)}
            onBlur={commitTreeNameRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitTreeNameRename();
              else if (e.key === 'Escape') setEditingTreeName(false);
            }}
            className="text-base font-semibold bg-transparent border-b border-primary outline-none min-w-[12ch] max-w-[30ch]"
          />
        ) : (
          <IconTooltip label="Click to rename this tree" side="bottom" disabled={!currentTree}>
            <button
              onClick={() => {
                if (!currentTree) return;
                setTreeNameDraft(currentTree.name);
                setEditingTreeName(true);
              }}
              className="group inline-flex items-center gap-1.5 text-base font-semibold hover:text-primary transition-colors"
            >
              {currentTree?.name ?? 'Trees'}
              {currentTree && <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity" />}
            </button>
          </IconTooltip>
        )}
        {graph && (
          <>
            <span className="text-xs text-muted-foreground">
              {graph.nodes.length} {graph.nodes.length === 1 ? 'person' : 'people'} · {graph.edges.filter(e => !e.derived).length} relationships
            </span>
            <div className="flex-1" />
            {/* Undo / Redo — history is persistent across sessions, so
                you can walk changes all the way back to when the app
                was first used. Buttons disable when the respective
                stack is empty; keyboard shortcut Ctrl/Cmd+Z also works. */}
            <div className="inline-flex items-center rounded-lg border border-border bg-background">
              <IconTooltip label={historyCounts.canUndo > 0 ? `Undo (Ctrl+Z) — ${historyCounts.canUndo} change${historyCounts.canUndo === 1 ? '' : 's'} available` : 'Nothing to undo'} side="bottom">
                <button
                  onClick={handleUndo}
                  disabled={historyCounts.canUndo === 0}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed rounded-l-lg"
                >
                  <Undo2 className="w-4 h-4" />
                </button>
              </IconTooltip>
              <div className="w-px h-5 bg-border" />
              <IconTooltip label={historyCounts.canRedo > 0 ? `Redo (Ctrl+Y) — ${historyCounts.canRedo} change${historyCounts.canRedo === 1 ? '' : 's'} available` : 'Nothing to redo'} side="bottom">
                <button
                  onClick={handleRedo}
                  disabled={historyCounts.canRedo === 0}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed rounded-r-lg"
                >
                  <Redo2 className="w-4 h-4" />
                </button>
              </IconTooltip>
            </div>
            {/* Trees Settings — single ribbon button that opens a full
                Dialog (TreesSettingsModal, rendered at the bottom of
                this view). Replaces an earlier popover-with-tabs that
                Terry rightly called out as cramped: Trees has grown
                three families of settings (Tree, Display, Effects) and
                a small floating popover hides them rather than
                presenting them. The dialog mirrors PDR's main
                SettingsModal pattern — same backdrop, same rounded-2xl
                card, same horizontal tab strip with a primary
                underline on the active tab — so users feel one
                consistent settings surface across the app. The
                ribbon button reuses the "information" palette
                (#dbeafe / #3b82f6 / #1e3a8a) so it sits next to the
                other ribbon buttons without introducing new colours.
                The (1) badge fires when Dates Living is on, so the
                user sees at-a-glance that an Add-Info option is
                active even when the dialog is closed. */}
            <IconTooltip label="Trees settings — Tree, Display, Effects" side="bottom">
              <button
                onClick={() => { setTreesSettingsTab('manageTrees'); setTreesSettingsOpen(true); }}
                data-pdr-variant="information"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{ backgroundColor: '#dbeafe', borderColor: '#3b82f6', color: '#1e3a8a', borderWidth: '1px', borderStyle: 'solid' }}
              >
                <Sliders className="w-4 h-4" />
                Trees Settings{showDates ? ' (1)' : ''}
              </button>
            </IconTooltip>
            <IconTooltip label="Change the focus person" side="bottom">
              <button
                onClick={() => setFocusPickerOpen(true)}
                data-pdr-variant="information"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{ backgroundColor: '#dbeafe', borderColor: '#3b82f6', color: '#1e3a8a', borderWidth: '1px', borderStyle: 'solid' }}
              >
                <Users className="w-4 h-4" />
                Change focus
              </button>
            </IconTooltip>
            {/* Snapshot status — same shared component as PM and S&D
                so the safety net is visible everywhere users make
                data decisions. Tree edits can be just as expensive
                as PM edits — this is the right home for the badge
                in this view. */}
            <SnapshotStatusBadge className="" />
            {pinnedPeople.size > 0 && (
              <IconTooltip label={`${pinnedPeople.size} person${pinnedPeople.size === 1 ? ' is' : 's are'} pinned beyond your current Depth. Click to reset and re-hide them.`} side="bottom">
                <button
                  onClick={() => setPinnedPeople(new Map())}
                  data-pdr-variant="caution"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
                  style={{ backgroundColor: '#fde68a', borderColor: '#f59e0b', color: '#78350f', borderWidth: '1px', borderStyle: 'solid' }}
                >
                  <Pin className="w-3 h-3" />
                  {pinnedPeople.size} pinned
                </button>
              </IconTooltip>
            )}
            {/* Branch-expansion list — popover showing every
                chevron currently expanded, split into Bloodline
                (cousins / descendant chevrons, lavender) and
                Extended family (in-laws' lineages / ancestor
                chevrons, orange). Each row has a checkbox the
                user can toggle to close that single branch, plus
                a "Clear all" footer to collapse the lot. Replaces
                the previous one-click-close-all button — Terry
                wanted granular control and a per-section colour
                cue rather than a binary on/off. */}
            {(expandedAncestorsOf.size + expandedDescendantsOf.size) > 0 && (
              <BranchesShownDropdown
                expandedAncestors={expandedAncestorsOf}
                expandedDescendants={expandedDescendantsOf}
                graph={graph}
                onToggleAncestor={handleExpandAncestors}
                onToggleDescendant={handleExpandDescendants}
                onClearAll={collapseAllExpansions}
              />
            )}
            {/* Steps filter — same dropdown style as the
                Generations D/A pickers (0–10 grid, type-any-number,
                +10 quick-step). Per Terry: the previous +/- stepper
                capped at 6 was too restrictive; a dropdown matches
                the Generations affordance and lets users go to 10
                or any custom number.
                The pill pulses (continuously) when hidden people
                exist beyond the current Steps cap, AND briefly
                flashes via pulseSteps when a new-add lands beyond
                the cap. The dropdown trigger carries a "+N"
                badge with the hidden count so the user knows
                exactly how many more they'd see by bumping Steps. */}
            <FilterPill
              label="Steps"
              pulse={pulseSteps}
              pulseSlow={hiddenByStepsCount > 0}
            >
              <StepsDropdown
                value={expandedHops}
                onChange={setExpandedHops}
                hiddenCount={hiddenByStepsCount}
                maxUseful={maxHopsInGraph}
              />
            </FilterPill>
            <FilterPill label="Generations" pulse={pulseGenerations}>
              {/* D (descendants) on left, A (ancestors) on right —
                  matches Terry's spatial intuition (younger below,
                  older above). Each is a dropdown of 0–10 with
                  type-any-number + "Add 10 more" for users who
                  legitimately need deeper trees (royal families,
                  deep historical research). No hard cap. */}
              <div className="inline-flex items-center gap-1.5">
                <GenerationDropdown
                  label="D"
                  value={descendantsDepth}
                  onChange={setDescendantsDepth}
                />
                <GenerationDropdown
                  label="A"
                  value={ancestorsDepth}
                  onChange={setAncestorsDepth}
                />
              </div>
            </FilterPill>
            <IconTooltip label="Refresh tree and people list" side="bottom">
              <button
                onClick={() => {
                  // Refresh BOTH the family graph AND the master
                  // people list. Previously only refetched the graph,
                  // which left allPersons stale — a person Terry just
                  // added in PM wasn't appearing as a +partner /
                  // +child suggestion until the next session.
                  if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
                  reloadPersons();
                }}
                className="p-1.5 rounded-lg border border-border hover:bg-accent transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </IconTooltip>
          </>
        )}
      </div>

      {/* Canvas */}
      <div className="flex-1 relative overflow-hidden">
        {loading && !layout && (
          <div className="absolute inset-0 flex items-center justify-center">
            <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {layout && (
          <TreesCanvas
            layout={layout}
            highlightTargetId={highlightTarget?.id ?? null}
            highlightNonce={highlightTarget?.nonce ?? 0}
            highlightMode={highlightTarget?.mode ?? {}}
            onTriggerHighlight={triggerHighlightToPerson}
            triggerHighlightOnRightClick={effectsEnabled && triggerOnRightClick}
            triggerHighlightOnAltClick={effectsEnabled && triggerOnAltClick}
            triggerHighlightOnHover={effectsEnabled && triggerOnHover}
            onHighlightComplete={() => setHighlightTarget(null)}
            onRefocus={handleRefocus}
            onSetRelationship={(personId) => { setRelationshipEditorInitialTo(null); setRelationshipEditorFor(personId); }}
            onEditRelationships={(personId) => setEditRelationshipsFor(personId)}
            onRemovePerson={handleRemovePerson}
            onGraphMutated={handleRelationshipCreated}
            onQuickAddParent={handleQuickAddParentWithStepsGate}
            onQuickAddPartner={(personId) => setQuickAdd({ fromPersonId: personId, kind: 'partner' })}
            onQuickAddChild={(personId) => setQuickAdd({ fromPersonId: personId, kind: 'child' })}
            onQuickAddSibling={(personId) => setQuickAdd({ fromPersonId: personId, kind: 'sibling' })}
            onExpandAncestors={handleExpandAncestors}
            onExpandDescendants={handleExpandDescendants}
            expandedAncestorsOf={expandedAncestorsOf}
            expandedDescendantsOf={expandedDescendantsOf}
            hideQuickAddChips={!stepsEnabled && !generationsEnabled}
            showDates={showDates}
            onEditDates={(personId, screenX, screenY) => {
              setDateEditor({ personId, x: screenX, y: screenY });
            }}
            onEditName={(personId, screenX, screenY) => {
              setNameEditor({ personId, x: screenX, y: screenY });
            }}
            canvasBackground={currentTree?.backgroundImage ?? null}
            canvasBackgroundOpacity={currentTree?.backgroundOpacity ?? 0.15}
            treeContrast={currentTree?.treeContrast ?? 0.3}
            allReachablePersonIds={connectedPersonIds}
            excludedSuggestionIds={excludedSuggestionIdSet}
            hiddenSuggestions={hiddenSuggestions}
            onHideSuggestion={currentTreeId != null ? toggleExcludedSuggestion : undefined}
            onUnhideSuggestion={currentTreeId != null ? toggleExcludedSuggestion : undefined}
            nameConflictLookup={nameConflictLookup}
            onParentResolved={maybePromptParentRelationship}
            useGenderedLabels={currentTree?.useGenderedLabels ?? true}
            simplifyHalfLabels={currentTree?.simplifyHalfLabels ?? false}
            hideGenderMarker={currentTree?.hideGenderMarker ?? false}
            hiddenAncestorPersonIds={currentTree?.hiddenAncestorPersonIds ?? []}
            onToggleHiddenAncestor={async (personId) => {
              if (!currentTreeId || !currentTree) return;
              // Goes through toggleHiddenAncestor so the flip is logged
              // to graph_history — Ctrl+Z / Redo / "Revert to this
              // point" all roll it back like any relationship mutation.
              await toggleHiddenAncestor(currentTreeId, personId);
              await reloadSavedTrees();
              await refreshHistoryCounts();
            }}
            onRequestCardBackgroundPick={(personId, personName) => {
              if (!onRequestCardBackgroundPick || !currentTreeId) return;
              onRequestCardBackgroundPick({
                treeId: currentTreeId,
                treeName: currentTree?.name ?? 'tree',
                personId,
                personName,
              });
            }}
          />
        )}
        {/* Empty-state hint — anchored to the top of the canvas so it never
            overlaps with the centred focus avatar. */}
        {!loading && graph && graph.nodes.length === 1 && stepsEnabled === false && generationsEnabled === false ? (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 max-w-lg text-center px-4 py-3 bg-background/95 backdrop-blur rounded-lg shadow-md border border-border pointer-events-none">
            <h3 className="text-sm font-semibold">Nothing to show</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Both <strong>Steps</strong> and <strong>Generations</strong> are turned off, so only the focus person is visible. Turn one back on to see their family.
            </p>
          </div>
        ) : !loading && graph && graph.nodes.length === 1 && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 max-w-lg text-center px-4 py-3 bg-background/95 backdrop-blur rounded-lg shadow-md border border-border pointer-events-none">
            <h3 className="text-sm font-semibold">Right-click your focus person to set a relationship</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              You've already named people in People Manager — here you just connect them. Pick any two, say how they're related (parent, sibling, cousin, partner…), and PDR stores the link.
            </p>
          </div>
        )}
      </div>

      {/* Focus picker modal — the sort toggle is enabled here so the user
          can browse by Connections / Photos / A–Z when changing focus. */}
      {focusPickerOpen && (
        <FocusPickerModal
          persons={allPersons}
          currentFocusId={focusPersonId}
          showSortOptions={true}
          onPick={(personId) => {
            setFocusPersonId(personId);
            setFocusPickerOpen(false);
          }}
          onPersonsChanged={reloadPersons}
          onClose={() => {
            if (focusPersonId != null) setFocusPickerOpen(false);
          }}
          // (name argument is accepted by onPick's type but unused here)
        />
      )}

      {/* Quick-add picker — fires when the user clicks one of the +
          chips around a node. Uses the same searchable person list with
          "create new" support as the focus picker. */}
      {quickAdd && (() => {
        // Title uses the FULL name ("Derek Mills"), not the short /
        // family nickname ("Grandad"). The short name is fine on a
        // node label where the user already knows who they're looking
        // at; in a modal title it has to read unambiguously even when
        // the user is many generations deep into a tree they've been
        // building for hours.
        const fromName = displayName(quickAdd.fromPersonId, 'this person');
        const title = quickAdd.kind === 'parent'  ? `Add ${fromName}'s parent`
                    : quickAdd.kind === 'child'   ? `Add ${fromName}'s child`
                    : quickAdd.kind === 'partner' ? `Add ${fromName}'s partner`
                    : `Add a sibling for ${fromName}`;
        // Filter out logically-impossible candidates so the picker only
        // suggests people who CAN hold the relationship you're adding.
        //   • Always exclude the "from" person themselves
        //   • For + parent: exclude descendants and siblings
        //   • For + child: exclude ancestors
        //   • For + partner: exclude blood relatives
        //   • For + sibling: exclude your own parents/children
        const excludedSuggestions = currentTree?.excludedSuggestionPersonIds ?? [];
        const excluded = impossibleCandidates(quickAdd.fromPersonId, quickAdd.kind, graph, connectedPersonIds, excludedSuggestions);
        // For + partner: compute the set of co-parents — people who are
        // already a parent of at least one of fromPerson's children.
        // These are the strongest partner suggestions (Alan is Sally's
        // children's other parent → Alan should top the list, not Mel
        // who just happens to share a photo with Sally).
        const coparents = quickAdd.kind === 'partner' ? coparentsOf(quickAdd.fromPersonId, graph) : undefined;
        // For partner quick-add, use intimacy/tag-weighted partner score
        // instead of raw cooccurrence count — 2 group photos shouldn't
        // beat 1 intimate photo. Non-partner adds keep the simple count.
        const isPartner = quickAdd.kind === 'partner';
        return (
          <FocusPickerModal
            persons={allPersons.filter(p => p.id !== quickAdd.fromPersonId && !excluded.has(p.id))}
            currentFocusId={null}
            title={title}
            cooccurrenceAnchorId={isPartner ? undefined : quickAdd.fromPersonId}
            partnerScoreAnchorId={isPartner ? quickAdd.fromPersonId : undefined}
            coparentIds={coparents}
            onPick={finaliseQuickAdd}
            onPersonsChanged={reloadPersons}
            onClose={() => setQuickAdd(null)}
            onHideSuggestion={currentTreeId != null ? toggleExcludedSuggestion : undefined}
            hiddenSuggestions={hiddenSuggestions}
            onUnhideSuggestion={currentTreeId != null ? toggleExcludedSuggestion : undefined}
            nameConflictLookup={nameConflictLookup}
          />
        );
      })()}

      {/* Declarative relationship editor — any two named people, any link type. */}
      {relationshipEditorFor != null && (() => {
        const fromPerson = allPersons.find(p => p.id === relationshipEditorFor);
        if (!fromPerson) return null;
        return (
          <SetRelationshipModal
            fromPersonId={relationshipEditorFor}
            fromPersonName={fromPerson.name}
            persons={allPersons}
            graph={graph}
            initialToPersonId={relationshipEditorInitialTo ?? undefined}
            onClose={() => { setRelationshipEditorFor(null); setRelationshipEditorInitialTo(null); }}
            onRelationshipCreated={handleRelationshipCreated}
            onPersonsChanged={reloadPersons}
            onOpenEditRelationships={(personId) => {
              // Close this modal and pop open Edit Relationships for
              // the other person so the user can fix the conflicting
              // link (remove it, or flip Parent ↔ Child).
              setRelationshipEditorFor(null);
              setRelationshipEditorInitialTo(null);
              setEditRelationshipsFor(personId);
            }}
          />
        );
      })()}

      {/* Edit Relationships list — shows every existing link for a
          person with per-row Edit / Remove controls and an Add-new CTA. */}
      {editRelationshipsFor != null && (() => {
        const person = allPersons.find(p => p.id === editRelationshipsFor);
        if (!person) return null;
        return (
          <EditRelationshipsModal
            personId={editRelationshipsFor}
            personName={person.name}
            persons={allPersons}
            onClose={() => setEditRelationshipsFor(null)}
            onEditEdge={(otherId) => {
              // Hand off to SetRelationshipModal with the other side
              // preselected — its edge-detection will prefill the form.
              const pid = editRelationshipsFor;
              setEditRelationshipsFor(null);
              setRelationshipEditorInitialTo(otherId);
              setRelationshipEditorFor(pid);
            }}
            onAddNew={() => {
              const pid = editRelationshipsFor;
              setEditRelationshipsFor(null);
              setRelationshipEditorInitialTo(null);
              setRelationshipEditorFor(pid);
            }}
            onChanged={handleRelationshipCreated}
          />
        );
      })()}

      {/* Manage Trees — list, rename, switch, (optionally) remove, and
          export as PNG / PDF. Opened from the header button. */}
      {manageTreesOpen && (
        <ManageTreesModal
          currentTreeId={currentTreeId}
          currentFocusPersonId={focusPersonId}
          getTreeSvg={() => document.querySelector<SVGSVGElement>('svg[data-tree-canvas="true"]')}
          onSwitch={switchToTree}
          onChanged={reloadSavedTrees}
          onClose={() => setManageTreesOpen(false)}
          onRequestNewTree={() => {
            // Close Manage Trees and open the focus picker so the user
            // starts a new tree with a chosen focal person + default
            // filters — NOT a clone of the current tree.
            setManageTreesOpen(false);
            setNewTreePickerOpen(true);
          }}
          onRequestBackgroundPick={(tree) => {
            if (!onRequestCanvasBackgroundPick) return;
            setManageTreesOpen(false);
            onRequestCanvasBackgroundPick({ treeId: tree.id, treeName: tree.name });
          }}
          getPersonName={(id) => {
            const p = allPersons.find(pp => pp.id === id);
            return p?.name?.trim() ? p.name : `Person #${id}`;
          }}
        />
      )}

      {/* New-tree focus picker — fires after the user clicks "New tree"
          in Manage Trees. On pick we create a saved tree with that
          focus and default filter settings, then switch to it. */}
      {newTreePickerOpen && (
        <FocusPickerModal
          persons={allPersons}
          currentFocusId={null}
          title="Who's at the centre of this new tree?"
          showSortOptions={true}
          onPick={async (personId) => {
            setNewTreePickerOpen(false);
            const r = await createSavedTree({
              name: 'Untitled tree',
              focusPersonId: personId,
              stepsEnabled: true,
              stepsDepth: 3,
              generationsEnabled: false,
              ancestorsDepth: 2,
              descendantsDepth: 2,
            });
            if (r.success && r.data) {
              await reloadSavedTrees();
              // Switch to the new tree (applies its settings and sets
              // focus via switchToTree).
              switchToTree(r.data);
              // Reopen Manage Trees so the user can immediately rename
              // the newly-created tree — it starts with "Untitled tree".
              setManageTreesOpen(true);
            }
          }}
          onPersonsChanged={reloadPersons}
          onClose={() => setNewTreePickerOpen(false)}
        />
      )}

      {/* Tree people list — shows everyone on the tree plus any
          orphaned persons (created in Trees but not reachable from the
          current focus). Lets the user delete mistakes with a 30-second
          undo toast; deletion of persons with photo tags is routed to
          People Manager so Trees can't casually destroy verified work. */}
      {treePeopleOpen && (
        <TreePeopleListModal
          focusPersonId={focusPersonId}
          treeName={currentTree?.name ?? 'this tree'}
          graph={graph}
          allPersons={allPersons}
          connectedPersonIds={connectedPersonIds}
          excludedSuggestionIds={excludedSuggestionIdSet}
          stepsEnabled={stepsEnabled}
          steps={expandedHops}
          onStepsChange={(next) => setExpandedHops(Math.max(1, Math.min(12, next)))}
          onSetFocus={(personId) => {
            // Inline focus change — the modal stays open; only the tree
            // state changes. The modal re-renders with the new focus
            // anchor and relationship labels.
            setFocusPersonId(personId);
          }}
          useGenderedLabels={currentTree?.useGenderedLabels ?? true}
          simplifyHalfLabels={currentTree?.simplifyHalfLabels ?? false}
          onClose={() => setTreePeopleOpen(false)}
          onPersonsChanged={async () => {
            await reloadPersons();
            if (focusPersonId != null) {
              const r = await getFamilyGraph(focusPersonId, fetchDepth);
              if (r.success && r.data) setGraph(r.data);
            }
          }}
        />
      )}

      {/* Date quick editor — opens when the user clicks the dates strip
          inside a card (when Dates Living is on). Year-only entry with
          a "still living" checkbox. Saves via updatePersonLifeEvents. */}
      {dateEditor && (() => {
        const node = graph?.nodes.find(n => n.personId === dateEditor.personId);
        // Prefer full name on the date editor header — matches the
        // formal-modal naming rule used elsewhere in Trees.
        const name = node?.fullName?.trim() || displayName(dateEditor.personId, node?.name ?? '');
        return (
          <DateQuickEditor
            personId={dateEditor.personId}
            personName={name}
            birthDate={node?.birthDate ?? null}
            deathDate={node?.deathDate ?? null}
            x={dateEditor.x}
            y={dateEditor.y}
            onSaved={() => {
              setDateEditor(null);
              if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
            }}
            onClose={() => setDateEditor(null)}
          />
        );
      })()}

      {nameEditor && (() => {
        const node = graph?.nodes.find(n => n.personId === nameEditor.personId);
        const initialName = node?.name ?? allPersons.find(p => p.id === nameEditor.personId)?.name ?? '';
        const initialFullName = node?.fullName ?? null;
        return (
          <NameQuickEditor
            personId={nameEditor.personId}
            initialName={initialName}
            initialFullName={initialFullName}
            x={nameEditor.x}
            y={nameEditor.y}
            onSaved={() => {
              setNameEditor(null);
              if (focusPersonId != null) refetchGraph(focusPersonId, fetchDepth);
              reloadPersons();
            }}
            onClose={() => setNameEditor(null)}
          />
        );
      })()}

      {/* Sibling kind dialog — fires after the +sibling quick-add picks
          a person. Asks full vs half vs none vs unknown before touching
          any parent_of edges, so we don't silently auto-fill shared
          placeholder parents when that isn't the intent. */}
      {siblingKindDialog && (
        <SiblingKindDialog
          fromPersonId={siblingKindDialog.fromId}
          fromPersonName={siblingKindDialog.fromName}
          toPersonId={siblingKindDialog.toId}
          toPersonName={siblingKindDialog.toName}
          graph={graph}
          onConfirm={(kind, sharedParentId) => {
            finaliseSiblingKind(kind, sharedParentId);
          }}
          onClose={() => setSiblingKindDialog(null)}
        />
      )}

      {/* Trees Settings dialog — built to mirror PDR's main
          SettingsModal in workspace.tsx (the surface the user pointed
          us at with a screenshot). Same backdrop scrim, same
          rounded-2xl card, same icon + title header with an X close,
          same horizontal tab strip with a primary underline marking
          the active tab. We split the Trees knobs across three tabs:

           - Tree     → cross-tree management (Manage Trees, People).
           - Display  → what each card shows (Dates Living, etc.).
           - Effects  → visual effects (the six pathway styles + the
                         right-click / Alt-click / hover triggers that
                         drive them).

          AnimatePresence wraps the dialog so it fades in/out cleanly,
          matching the same primitive workspace.tsx uses. The dialog
          owns its own scroll lane (h-[55vh] overflow-y-auto pr-2 pt-5)
          so each tab's content can grow without dragging the chrome
          (header / tab strip / outer card) out of the viewport. */}
      <AnimatePresence>
        {treesSettingsOpen && (
          <motion.div
            key="trees-settings-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setTreesSettingsOpen(false)}
            className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
          >
            <motion.div
              ref={treesSettingsDrag.modalRef}
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-background rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden"
            >
              {/* Header — drag handle wraps the icon + title row so the
                  user can grab the dialog from a generous strip rather
                  than hunting a narrow grip. Same pattern Trees' other
                  modals use (Manage Trees, People). The Move icon hints
                  the strip is grabbable; X close stays absolute right
                  for parity with PDR's SettingsModal. */}
              <div
                {...treesSettingsDrag.dragHandleProps}
                className={`relative px-6 py-5 border-b border-border ${treesSettingsDrag.dragHandleProps.className}`}
              >
                <Move className="absolute left-4 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60" aria-hidden />
                <div className="flex items-center justify-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                    <Sliders className="w-5 h-5 text-primary" />
                  </div>
                  <h2 className="text-xl font-semibold text-foreground">Trees Settings</h2>
                </div>
                <button
                  onClick={() => setTreesSettingsOpen(false)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 hover:bg-secondary rounded-full transition-colors"
                  data-testid="button-close-trees-settings"
                  aria-label="Close Trees Settings"
                >
                  <X className="w-5 h-5 text-muted-foreground" />
                </button>
              </div>

              {/* Tab strip — same `flex border-b border-border` pattern
                  as workspace.tsx's SettingsModal. Active tab is
                  underlined with `border-primary` + filled with
                  `text-primary`; inactive tabs sit on `bg-muted/40`
                  with muted-foreground text. Tabs share the width
                  equally via flex-1. Manage Trees and People are now
                  full tabs (their bodies render inline) instead of
                  buttons that opened separate modals — Terry called
                  out that modals-within-modals felt wrong. */}
              <div className="flex border-b border-border">
                {([
                  { value: 'manageTrees' as const, label: 'Manage Trees' },
                  { value: 'people' as const,      label: 'People' },
                  { value: 'display' as const,     label: 'Display' },
                  { value: 'effects' as const,     label: 'Effects' },
                ]).map((tab) => {
                  const active = treesSettingsTab === tab.value;
                  return (
                    <button
                      key={tab.value}
                      type="button"
                      onClick={() => setTreesSettingsTab(tab.value)}
                      data-testid={`tab-trees-${tab.value}`}
                      className={`flex-1 px-2 py-2 text-xs font-medium cursor-pointer transition-all duration-200 border-b-2 whitespace-nowrap ${
                        active
                          ? 'border-primary text-primary bg-background'
                          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 bg-muted/40'
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              {/* Tab body — fixed-height scroll lane so the dialog
                  stays put as the user toggles between tabs. The
                  Manage Trees / People tabs embed the existing modal
                  bodies (via the `embedded` prop) so the user gets
                  the same list / sort / delete capabilities without
                  a second modal opening on top. */}
              <div className="px-6 pb-6 pt-5 h-[55vh] overflow-y-auto">

                {/* ═══════════════ MANAGE TREES TAB ═══════════════ */}
                {treesSettingsTab === 'manageTrees' && (
                  <ManageTreesModal
                    embedded
                    currentTreeId={currentTreeId}
                    currentFocusPersonId={focusPersonId}
                    getTreeSvg={() => document.querySelector<SVGSVGElement>('svg[data-tree-canvas="true"]')}
                    onSwitch={(t) => { setTreesSettingsOpen(false); switchToTree(t); }}
                    onChanged={reloadSavedTrees}
                    onClose={() => setTreesSettingsOpen(false)}
                    onRequestNewTree={() => {
                      setTreesSettingsOpen(false);
                      setNewTreePickerOpen(true);
                    }}
                    onRequestBackgroundPick={(tree) => {
                      if (!onRequestCanvasBackgroundPick) return;
                      setTreesSettingsOpen(false);
                      onRequestCanvasBackgroundPick({ treeId: tree.id, treeName: tree.name });
                    }}
                    getPersonName={(id) => {
                      const p = allPersons.find(pp => pp.id === id);
                      return p?.name?.trim() ? p.name : `Person #${id}`;
                    }}
                  />
                )}

                {/* ═══════════════ PEOPLE TAB ═══════════════ */}
                {treesSettingsTab === 'people' && (
                  <TreePeopleListModal
                    embedded
                    focusPersonId={focusPersonId}
                    treeName={currentTree?.name ?? 'this tree'}
                    graph={graph}
                    allPersons={allPersons}
                    connectedPersonIds={connectedPersonIds}
                    excludedSuggestionIds={excludedSuggestionIdSet}
                    stepsEnabled={stepsEnabled}
                    steps={expandedHops}
                    onStepsChange={(next) => setExpandedHops(Math.max(1, Math.min(12, next)))}
                    onSetFocus={(personId) => setFocusPersonId(personId)}
                    useGenderedLabels={currentTree?.useGenderedLabels ?? true}
                    simplifyHalfLabels={currentTree?.simplifyHalfLabels ?? false}
                    onClose={() => setTreesSettingsOpen(false)}
                    onPersonsChanged={async () => {
                      await reloadPersons();
                      if (focusPersonId != null) {
                        const r = await getFamilyGraph(focusPersonId, fetchDepth);
                        if (r.success && r.data) setGraph(r.data);
                      }
                    }}
                  />
                )}

                {/* ═══════════════ DISPLAY TAB ═══════════════
                    What each card on the canvas shows. Currently
                    just Dates Living, but the surface is roomy
                    enough to grow more "show below the card"
                    options without rework. */}
                {treesSettingsTab === 'display' && (
                  <div className="space-y-4">
                    <p className="text-xs text-muted-foreground px-1 pb-1">
                      Show below each card
                    </p>
                    <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Info className="w-4 h-4 text-primary" />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-foreground">Dates Living</span>
                          <span className="text-xs text-muted-foreground">e.g. 1948–Living</span>
                        </div>
                      </div>
                      <Checkbox
                        checked={showDates}
                        onCheckedChange={(checked) => toggleShowDates(!!checked)}
                        data-testid="checkbox-dates-living"
                      />
                    </label>
                  </div>
                )}

                {/* ═══════════════ EFFECTS TAB ═══════════════
                    Visual effects engine. Master enable + creation
                    burst toggle on top, then six per-style toggles
                    each with a Play preview button, then the three
                    triggers (right-click, Alt-click, hover). All
                    rows beneath the master use a disabled state
                    when effects are off so they read as inert. */}
                {treesSettingsTab === 'effects' && (
                  <div className="space-y-4">
                    <label className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/50 cursor-pointer transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Sparkles className="w-4 h-4 text-primary" />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-foreground">Enable visual effects</span>
                          <span className="text-xs text-muted-foreground">Master switch — turns the comet, sonar, and friends on or off.</span>
                        </div>
                      </div>
                      <Checkbox
                        checked={effectsEnabled}
                        onCheckedChange={(checked) => persistEffectsEnabled(!!checked)}
                        data-testid="checkbox-effects-enabled"
                      />
                    </label>

                    <label className={`flex items-center justify-between p-3 rounded-lg border border-border transition-colors ${effectsEnabled ? 'hover:border-primary/50 cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Play className="w-4 h-4 text-primary" />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-foreground">Pathway burst on add</span>
                          <span className="text-xs text-muted-foreground">When you add a new person, run the effect along the path that ties them in.</span>
                        </div>
                      </div>
                      <Checkbox
                        checked={effectsCreationBurst}
                        disabled={!effectsEnabled}
                        onCheckedChange={(checked) => persistEffectsCreationBurst(!!checked)}
                        data-testid="checkbox-effects-creation-burst"
                      />
                    </label>

                    <div className="pt-3 border-t border-border">
                      <p className="text-xs font-semibold text-muted-foreground tracking-wide uppercase px-1 pb-2">
                        Effect styles — pick any combination, they layer
                      </p>
                      <div className="space-y-2">
                        {([
                          { key: 'comet',    label: 'Comet',          hint: 'bright head + halo',     state: effectComet,    set: setEffectComet,    storageKey: 'pdr-trees-effect-comet' },
                          { key: 'sonar',    label: 'Sonar ping',     hint: 'expanding rings',        state: effectSonar,    set: setEffectSonar,    storageKey: 'pdr-trees-effect-sonar' },
                          { key: 'sweep',    label: 'Gradient sweep', hint: 'soft trailing stripe',   state: effectSweep,    set: setEffectSweep,    storageKey: 'pdr-trees-effect-sweep' },
                          { key: 'electric', label: 'Electric arc',   hint: 'jagged bolts',           state: effectElectric, set: setEffectElectric, storageKey: 'pdr-trees-effect-electric' },
                          { key: 'fiber',    label: 'Fibre-optic',    hint: 'flowing dashes',         state: effectFiber,    set: setEffectFiber,    storageKey: 'pdr-trees-effect-fiber' },
                          { key: 'led',      label: 'LED tube',       hint: 'steady neon glow',       state: effectLed,      set: setEffectLed,      storageKey: 'pdr-trees-effect-led' },
                        ] as const).map(row => (
                          <div
                            key={row.key}
                            className={`flex items-center gap-2 p-2 rounded-lg border border-border transition-colors ${effectsEnabled ? 'hover:border-primary/50' : 'opacity-50'}`}
                          >
                            <label className={`flex-1 flex items-center gap-3 ${effectsEnabled ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                              <Checkbox
                                checked={row.state}
                                disabled={!effectsEnabled}
                                onCheckedChange={(checked) => persistEffectStyle(row.storageKey, row.set, !!checked)}
                                data-testid={`checkbox-effect-${row.key}`}
                              />
                              <span className="text-sm font-medium text-foreground flex-1">{row.label}</span>
                              <span className="text-xs text-muted-foreground">{row.hint}</span>
                            </label>
                            <IconTooltip label={`Preview ${row.label}`} side="left">
                              <button
                                type="button"
                                disabled={!effectsEnabled}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setTreesSettingsOpen(false);
                                  previewModeOverrideRef.current = { [row.key]: true };
                                  setTimeout(() => previewCreationHighlight(), 220);
                                }}
                                className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${effectsEnabled ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground/40 cursor-not-allowed'}`}
                                aria-label={`Preview ${row.label}`}
                                data-testid={`button-preview-${row.key}`}
                              >
                                <Play className="w-3.5 h-3.5" fill="currentColor" />
                              </button>
                            </IconTooltip>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="pt-3 border-t border-border">
                      <p className="text-xs font-semibold text-muted-foreground tracking-wide uppercase px-1 pb-2">
                        Trigger on click / hover
                      </p>
                      <div className="space-y-2">
                        {([
                          { key: 'rightclick', label: 'Right-click → Show pathway', hint: 'menu item',     state: triggerOnRightClick, set: setTriggerOnRightClick, storageKey: 'pdr-trees-trigger-rightclick' },
                          { key: 'altclick',   label: 'Alt-click a card',           hint: 'modifier-click', state: triggerOnAltClick,   set: setTriggerOnAltClick,   storageKey: 'pdr-trees-trigger-altclick' },
                          { key: 'hover',      label: 'Hover a card (½ s)',         hint: 'ambient',        state: triggerOnHover,      set: setTriggerOnHover,      storageKey: 'pdr-trees-trigger-hover' },
                        ] as const).map(row => (
                          <label
                            key={row.key}
                            className={`flex items-center gap-3 p-2 rounded-lg border border-border transition-colors ${effectsEnabled ? 'hover:border-primary/50 cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
                          >
                            <Checkbox
                              checked={row.state}
                              disabled={!effectsEnabled}
                              onCheckedChange={(checked) => persistEffectStyle(row.storageKey, row.set, !!checked)}
                              data-testid={`checkbox-trigger-${row.key}`}
                            />
                            <span className="text-sm font-medium text-foreground flex-1">{row.label}</span>
                            <span className="text-xs text-muted-foreground">{row.hint}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Return the set of person IDs who are "co-parents" of `fromId` — i.e.,
 * anyone currently registered as a parent of any of fromId's children.
 * These are the obvious candidates when asking "who's fromId's partner?"
 * because they already share kids in the tree, regardless of whether a
 * spouse_of edge has been asserted yet.
 */
/** Header filter button with its own stepper control tucked to the right.
 *  Active state looks like a CTA (solid primary tint, primary border);
 *  off state looks muted but still clearly clickable. Matches the
 *  'Change focus' button's look so the three header controls read as a
 *  consistent row of actions, not a mix of labels and inputs. */
function FilterPill({ label, children, pulse, pulseSlow }: {
  label: string; children: React.ReactNode;
  /** When true, the pill briefly animates to draw attention to a
   *  filter overage (e.g. user added a relative beyond the current
   *  Steps or Generations cap — the pill nudges them to consider
   *  bumping it). 1.5 s cycle — snappy "look here". */
  pulse?: boolean;
  /** Same animation, slower 2 s cycle — used for AMBIENT signals
   *  that should sit in peripheral vision rather than demand
   *  attention (Steps pill while hidden relatives exist). pulse
   *  takes priority when both are set. */
  pulseSlow?: boolean;
}) {
  // The label is now a non-interactive caption — only the +/−
  // steppers inside are buttons. Previously the label itself was a
  // toggle button which was (a) visually ambiguous with the +/−
  // next to it, and (b) had different active/inactive colour
  // states that made paired Steps/Generations look like two
  // unrelated controls when one was on and the other off. Now the
  // chrome is fixed; "off" is just a value (Steps=0 or
  // Generations 0/0 = "no constraint" via the filter logic above).
  // Pulse class — fast (1.5s) wins if both flags are set, otherwise
  // slow (2s) for ambient hidden-people signal. Falls back to no
  // animation when neither is set.
  const pulseClass = pulse
    ? 'animate-pulse-cta ring-2 ring-primary/40 ring-offset-1 ring-offset-background'
    : pulseSlow
      ? 'animate-pulse-cta-slow ring-2 ring-primary/40 ring-offset-1 ring-offset-background'
      : '';
  return (
    <div className={`inline-flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded-lg border bg-primary/10 border-primary/40 transition-shadow ${pulseClass}`}>
      <span className="px-2 py-0.5 text-sm font-medium text-primary select-none">{label}</span>
      {children}
    </div>
  );
}

/** Compact stepper control — two buttons (−/+) around a centered number.
 *  Replaces a native <select> where quick small adjustments matter.
 *  When disabled, the whole control dims but stays rendered so the
 *  header layout doesn't shift when the parent toggle flips.
 *
 *  Two layouts:
 *    horizontal (default) — `[−] 2 [+]`, used standalone (Steps).
 *    stacked — `[+]` over `[−]` next to the number, used when two
 *              steppers sit side-by-side (Generations) and the
 *              horizontal width would otherwise blow up the
 *              toolbar. Same hit-targets, half the width. */
function NumberStepper({ value, onChange, min, max, disabled, layout = 'horizontal' }: {
  value: number; onChange: (n: number) => void; min: number; max: number; disabled?: boolean; layout?: 'horizontal' | 'stacked';
}) {
  const dec = () => !disabled && onChange(Math.max(min, value - 1));
  const inc = () => !disabled && onChange(Math.min(max, value + 1));
  if (layout === 'stacked') {
    return (
      <div className={`inline-flex items-center gap-1 text-xs ${disabled ? 'opacity-70' : ''}`}>
        <span className="w-4 text-center font-mono tabular-nums leading-none">{value}</span>
        <div className="flex flex-col">
          <button
            type="button"
            onClick={inc}
            disabled={disabled || value >= max}
            className="w-4 h-3.5 flex items-center justify-center rounded-sm hover:bg-accent disabled:hover:bg-transparent disabled:text-muted-foreground/70 leading-none text-xs font-bold"
            aria-label="Increase"
          >
            +
          </button>
          <button
            type="button"
            onClick={dec}
            disabled={disabled || value <= min}
            className="w-4 h-3.5 flex items-center justify-center rounded-sm hover:bg-accent disabled:hover:bg-transparent disabled:text-muted-foreground/70 leading-none text-xs font-bold"
            aria-label="Decrease"
          >
            −
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={`inline-flex items-center text-xs ${disabled ? 'opacity-70' : ''}`}>
      <button
        type="button"
        onClick={dec}
        disabled={disabled || value <= min}
        className="w-5 h-5 flex items-center justify-center rounded hover:bg-accent disabled:hover:bg-transparent disabled:text-muted-foreground/70"
        aria-label="Decrease"
      >
        −
      </button>
      <span className="w-5 text-center font-mono tabular-nums">{value}</span>
      <button
        type="button"
        onClick={inc}
        disabled={disabled || value >= max}
        className="w-5 h-5 flex items-center justify-center rounded hover:bg-accent disabled:hover:bg-transparent disabled:text-muted-foreground/70"
        aria-label="Increase"
      >
        +
      </button>
    </div>
  );
}

/** Dropdown for ancestor / descendant generation depth.
 *  Inline popover (no modal jump):
 *    • 0–10 as a button grid for quick picks (also the reset path —
 *      whatever your current value, click 5 and you're at 5)
 *    • Direct numeric input for any value (no spinner arrows —
 *      type-only, Enter to apply)
 *    • "+ Add 10 more" quick increment for deep trees
 *  The earlier modal-based design hid these behind a "Custom…" click
 *  and the modal's spinner arrows were tiny — Terry rightly called
 *  it out. This version puts every option in one always-visible
 *  pane. */
function GenerationDropdown({ label, value, onChange }: {
  label: 'D' | 'A';
  value: number;
  onChange: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);

  // The Ancestors (A) pill sits at the right edge of the toolbar; align
  // its popover to the trigger's end so it doesn't overflow the window.
  // The Descendants (D) pill sits further left, so start-align is fine.
  const popoverAlign: 'start' | 'end' = label === 'A' ? 'end' : 'start';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-background border border-border hover:bg-accent transition-colors"
          aria-label={`${label === 'D' ? 'Descendants' : 'Ancestors'} generations: ${value}`}
        >
          <span className="text-[10px] font-semibold text-muted-foreground tracking-wide">{label}</span>
          <span className="font-mono tabular-nums text-foreground min-w-[1ch] text-center">{value}</span>
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align={popoverAlign} collisionPadding={12}>
        <p className="text-[10px] font-semibold text-muted-foreground tracking-wide mb-1.5 uppercase">
          {label === 'D' ? 'Descendants' : 'Ancestors'}
        </p>
        {/* 0-5 grid — v2 cap. Clicking any sets the value directly. */}
        <div className="grid grid-cols-6 gap-1">
          {[0, 1, 2, 3, 4, 5].map(n => (
            <button
              key={n}
              onClick={() => { onChange(n); setOpen(false); }}
              className={`px-2 py-1.5 rounded text-sm font-mono tabular-nums hover:bg-accent transition-colors ${
                value === n ? 'bg-primary/10 text-primary font-semibold' : ''
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Steps dropdown — same affordance as the Generations D/A
 * pickers (0–10 grid + type-any-number + +10 quick-step) wired
 * to the steps filter. Replaces the previous +/- NumberStepper
 * which capped at 6; per Terry's request the cap is removed and
 * the affordance unified with Generations.
 *
 * Sits inside the existing FilterPill so the outer "Steps"
 * label stays put — only the value picker swaps.
 */
function StepsDropdown({ value, onChange, hiddenCount = 0, maxUseful = 0 }: {
  value: number;
  onChange: (n: number) => void;
  /** Number of people in the graph who are filtered OUT by the
   *  current Steps cap (but pass Generations). Surfaced as a
   *  small "+N" badge on the trigger button so the user knows
   *  how many more relatives they'd see by bumping Steps. */
  hiddenCount?: number;
  /** Furthest-out hop count anyone in the graph sits at. The
   *  matching button in the 0–10 grid is outlined as the
   *  "max useful" marker — past this value, raising Steps
   *  stops revealing more relatives. Past 10 we trust the
   *  user knows what they're doing. */
  maxUseful?: number;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => { if (open) setDraft(String(value)); }, [open, value]);

  const applyDraft = () => {
    const n = parseInt(draft, 10);
    if (Number.isFinite(n) && n >= 0) {
      onChange(n);
      setOpen(false);
    }
  };

  // Explainer label for the trigger button — IconTooltip on the
  // wrapper so the user can hover the pill (or its +N badge) and
  // read "X people are hidden by this Steps cap" instead of being
  // left to guess what the small primary number next to the value
  // means.
  const triggerTooltip = hiddenCount > 0
    ? `${hiddenCount} ${hiddenCount === 1 ? 'person is' : 'people are'} hidden by the current Steps cap of ${value}. Click to increase.`
    : `Steps cap. Click to change.`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <IconTooltip label={triggerTooltip} side="bottom">
      <PopoverTrigger asChild>
        <button
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-background border border-border hover:bg-accent transition-colors"
          aria-label={hiddenCount > 0
            ? `Steps: ${value}. ${hiddenCount} more ${hiddenCount === 1 ? 'person is' : 'people are'} hidden — increase to see them.`
            : `Steps: ${value}`}
        >
          <span className="font-mono tabular-nums text-foreground min-w-[1ch] text-center">{value}</span>
          {/* +N badge removed — Terry: it just read as confusion
              next to the value. The hover IconTooltip on the
              wrapper still surfaces the count and explains it
              ("N people are hidden by the current Steps cap…");
              the slow ambient pulse on the FilterPill remains
              the at-a-glance signal that hidden people exist. */}
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      </IconTooltip>
      <PopoverContent className="w-56 p-3" align="start" collisionPadding={12}>
        <p className="text-[10px] font-semibold text-muted-foreground tracking-wide mb-1.5 uppercase">
          Steps
        </p>
        <div className="grid grid-cols-6 gap-1 mb-2">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => {
            const isCurrent = value === n;
            // "Max useful" outline — same hop number where the
            // furthest relative actually sits. Beyond it raising
            // Steps stops revealing more. Marked with a GOLD
            // ring (--color-gold = #f8c15c, the same DNA token
            // PDR uses for focus-ring + step-badge highlights)
            // so it stands out clearly from the lavender
            // active-state fill — Terry's request.
            const isMaxUseful = maxUseful > 0 && n === maxUseful && !isCurrent;
            return (
              <button
                key={n}
                onClick={() => { onChange(n); setOpen(false); }}
                aria-label={isMaxUseful ? `${n} — furthest relative on this tree` : `${n}`}
                className={`px-2 py-1.5 rounded text-sm font-mono tabular-nums hover:bg-accent transition-colors ${
                  isCurrent ? 'bg-primary/10 text-primary font-semibold' : ''
                }`}
                style={isMaxUseful
                  ? { boxShadow: 'inset 0 0 0 1.5px #f8c15c', color: '#b07106' }
                  : undefined}
              >
                {n}
              </button>
            );
          })}
        </div>
        {maxUseful > 0 && maxUseful <= 10 && (
          <p className="text-[10px] text-muted-foreground mb-2 -mt-1">
            <span className="font-semibold" style={{ color: '#b07106' }}>{maxUseful}</span> covers everyone currently on this tree.
          </p>
        )}
        <div className="border-t border-border pt-2">
          <label className="block text-[11px] text-muted-foreground mb-1">Or type any number:</label>
          <div className="flex gap-1.5">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={draft}
              onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyDraft();
                else if (e.key === 'Escape') setOpen(false);
              }}
              className="flex-1 px-2 py-1.5 rounded-md border border-border bg-background text-sm font-mono"
            />
            <button
              onClick={applyDraft}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Set
            </button>
          </div>
        </div>
        <div className="border-t border-border mt-2 pt-2">
          <button
            onClick={() => { onChange(value + 10); setOpen(false); }}
            className="w-full px-2 py-1.5 rounded text-xs font-medium text-foreground hover:bg-accent transition-colors text-left"
          >
            <span className="text-primary">+</span> Add 10 more (currently {value})
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Branches-shown dropdown — Popover trigger styled to match the
 * brand-orange "caution-tier" pill the previous one-click button
 * used (so the toolbar geometry doesn't shift), but contents are
 * a per-branch list split by Bloodline (lavender / cousins) and
 * Extended family (orange / in-laws), each with its own toggle
 * checkbox and a "Clear all" footer.
 *
 * Categorisation rule: descendant chevrons (cousins) are always
 * bloodline by construction (the head IS the bloodline relative).
 * Ancestor chevrons are categorised as extended family — the rare
 * bloodline-with-out-of-scope-ancestors case is grouped there too
 * for v1 simplicity; can be split if it becomes confusing.
 */
function BranchesShownDropdown({
  expandedAncestors,
  expandedDescendants,
  graph,
  onToggleAncestor,
  onToggleDescendant,
  onClearAll,
}: {
  expandedAncestors: Set<number>;
  expandedDescendants: Set<number>;
  graph: FamilyGraph | null;
  onToggleAncestor: (id: number) => void;
  onToggleDescendant: (id: number) => void;
  onClearAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const total = expandedAncestors.size + expandedDescendants.size;

  // Person-name lookup straight from graph.nodes — full name when
  // available so the dropdown reads naturally ("Lindsay Clapson"
  // not "Lindsay"), short name otherwise.
  const nameOf = (id: number) => {
    const n = graph?.nodes.find(p => p.personId === id);
    return n?.fullName?.trim() || n?.name?.trim() || `#${id}`;
  };

  const bloodlineEntries = Array.from(expandedDescendants)
    .map(id => ({ id, name: nameOf(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const extendedEntries = Array.from(expandedAncestors)
    .map(id => ({ id, name: nameOf(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={`${total} branch${total === 1 ? '' : 'es'} shown — click to manage`}
          data-pdr-variant="caution"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style={{ backgroundColor: '#fed7aa', borderColor: '#f59e0b', color: '#7c2d12', borderWidth: '1px', borderStyle: 'solid' }}
        >
          <Users className="w-3 h-3" />
          {total} branch{total === 1 ? '' : 'es'} shown
          <ChevronDown className="w-3 h-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="end" collisionPadding={12}>
        {bloodlineEntries.length > 0 && (
          <div className="mb-3">
            <p
              className="text-[10px] font-semibold tracking-wide mb-1.5 uppercase"
              style={{ color: '#7e6df0' }}
            >
              Bloodline
            </p>
            <ul className="space-y-1">
              {bloodlineEntries.map(entry => (
                <li key={`d-${entry.id}`}>
                  <label
                    className="flex items-center gap-2 px-1 py-1 rounded cursor-pointer hover:bg-accent transition-colors"
                  >
                    <Checkbox
                      checked
                      onCheckedChange={() => onToggleDescendant(entry.id)}
                    />
                    <span className="text-sm" style={{ color: '#7e6df0' }}>{entry.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        {extendedEntries.length > 0 && (
          <div>
            <p
              className="text-[10px] font-semibold tracking-wide mb-1.5 uppercase"
              style={{ color: '#c2740a' }}
            >
              Extended family
            </p>
            <ul className="space-y-1">
              {extendedEntries.map(entry => (
                <li key={`a-${entry.id}`}>
                  <label
                    className="flex items-center gap-2 px-1 py-1 rounded cursor-pointer hover:bg-accent transition-colors"
                  >
                    <Checkbox
                      checked
                      onCheckedChange={() => onToggleAncestor(entry.id)}
                    />
                    <span className="text-sm" style={{ color: '#c2740a' }}>{entry.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="border-t border-border mt-3 pt-2">
          <button
            onClick={() => { onClearAll(); setOpen(false); }}
            className="w-full px-2 py-1.5 rounded text-xs font-medium text-foreground hover:bg-accent transition-colors text-left"
          >
            Clear all
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function coparentsOf(fromId: number, graph: FamilyGraph | null): Set<number> {
  const out = new Set<number>();
  if (!graph) return out;
  const myChildren = graph.edges
    .filter(e => e.type === 'parent_of' && e.aId === fromId && !e.derived)
    .map(e => e.bId);
  for (const childId of myChildren) {
    for (const e of graph.edges) {
      if (e.type !== 'parent_of' || e.derived) continue;
      if (e.bId === childId && e.aId !== fromId) out.add(e.aId);
    }
  }
  return out;
}

/**
 * Return the set of person IDs that CAN'T hold a given kind of
 * relationship to `fromId`, so the quick-add picker doesn't suggest
 * them. Common-sense filters:
 *   • + parent: can't be yourself, your siblings, your descendants,
 *     or anyone ALREADY on your parent list (you already have them).
 *   • + child: can't be yourself, your ancestors, or an existing child.
 *   • + partner: can't be yourself, anyone in your existing family
 *     graph closure (blood, in-laws, ex-in-laws, exes — anyone reached
 *     by any chain of recorded relationships), and can't be someone
 *     currently partnered to a third party.
 *   • + sibling: can't be yourself, your parents, or your children.
 */
function impossibleCandidates(
  fromId: number,
  kind: 'parent' | 'partner' | 'child' | 'sibling',
  graph: FamilyGraph | null,
  /** No longer used — the previous "exclude the whole connected
   *  component" rule meant a person whose tree relationships had
   *  been undone was still hidden from the quick-add picker because
   *  one stale edge could keep them reachable from focus. Kept in the
   *  signature for callers that still pass it; intentionally ignored. */
  _connectedPersonIds?: Set<number>,
  /** Per-tree user-flagged "not part of this family" list. Persists
   *  across sessions via the saved_trees.excluded_suggestion_person_ids
   *  column. Reversible via the picker's review list. */
  excludedSuggestionPersonIds?: Iterable<number>,
): Set<number> {
  const out = new Set<number>([fromId]);
  // Exclude everyone CURRENTLY VISIBLE on the canvas (graph.nodes) —
  // these are the people already placed in some role on the tree
  // right now. This matches what the placeholder picker does; both
  // surfaces use the visible-set rather than the BFS-reachable
  // connected component, so people who were undone reappear in the
  // pickers immediately instead of staying hidden via stale edges.
  if (graph) {
    for (const n of graph.nodes) out.add(n.personId);
  }
  // User-curated exclusions — people they've manually flagged as not
  // part of this family (e.g. Michael Gentleman for a Clapson tree).
  // These apply to every kind (parent/child/partner/sibling) because
  // "not in this family" means not in any role.
  if (excludedSuggestionPersonIds) {
    for (const id of excludedSuggestionPersonIds) out.add(id);
  }
  if (!graph) return out;

  const parentsOf = (pid: number): number[] =>
    graph.edges.filter(e => e.type === 'parent_of' && e.bId === pid && !e.derived).map(e => e.aId);
  const childrenOf = (pid: number): number[] =>
    graph.edges.filter(e => e.type === 'parent_of' && e.aId === pid && !e.derived).map(e => e.bId);

  // BFS up/down helpers.
  const ancestors = (start: number): Set<number> => {
    const seen = new Set<number>();
    const q = [start];
    while (q.length) {
      const cur = q.shift()!;
      for (const p of parentsOf(cur)) {
        if (seen.has(p)) continue;
        seen.add(p);
        q.push(p);
      }
    }
    return seen;
  };
  const descendants = (start: number): Set<number> => {
    const seen = new Set<number>();
    const q = [start];
    while (q.length) {
      const cur = q.shift()!;
      for (const c of childrenOf(cur)) {
        if (seen.has(c)) continue;
        seen.add(c);
        q.push(c);
      }
    }
    return seen;
  };

  const myParents = new Set(parentsOf(fromId));
  const myChildren = new Set(childrenOf(fromId));

  // Siblings = people who share at least one parent with fromId.
  const mySiblings = new Set<number>();
  for (const p of myParents) {
    for (const sib of childrenOf(p)) {
      if (sib !== fromId) mySiblings.add(sib);
    }
  }

  if (kind === 'parent') {
    // Exclude descendants, siblings, and existing parents.
    for (const d of descendants(fromId)) out.add(d);
    for (const s of mySiblings) out.add(s);
    for (const p of myParents) out.add(p);
  } else if (kind === 'child') {
    for (const a of ancestors(fromId)) out.add(a);
    for (const c of myChildren) out.add(c);
  } else if (kind === 'partner') {
    // The outer loop already excluded the full family closure (via
    // connectedPersonIds). Belt-and-braces: also exclude the fetched
    // graph closure in case connectedPersonIds is stale.
    const closure = familyClosure(fromId, graph);
    for (const id of closure) out.add(id);
    // Co-parents of fromId's children are exactly the couples the
    // user is likely trying to formalize as partners (e.g. Sally and
    // Alan, who share Colin as a child, but whose spouse_of edge
    // hasn't been asserted yet). Exempt them from BOTH the DB-level
    // closure AND the graph-level closure — they're valid candidates,
    // not hidden relatives.
    const coparents = coparentsOf(fromId, graph);
    for (const cp of coparents) out.delete(cp);
    // Self is never a valid partner, even if somehow flagged as a
    // co-parent of their own child (duplicate edge shouldn't exist
    // but we guard anyway).
    out.add(fromId);
    // Block anyone currently in an active spouse_of with a third
    // party — already-married people aren't valid partner suggestions
    // even if they're a co-parent.
    for (const id of currentlyPartnered(graph, fromId)) out.add(id);
  } else if (kind === 'sibling') {
    for (const a of ancestors(fromId)) out.add(a);
    for (const d of descendants(fromId)) out.add(d);
  }
  return out;
}

/**
 * Connected component of `fromId` using every non-derived relationship
 * edge as an undirected link. Produces the "extended family closure":
 * blood relatives, in-laws, ex-in-laws, exes, and anyone else already
 * tied to fromId through a chain of recorded relationships.
 */
function familyClosure(fromId: number, graph: FamilyGraph | null): Set<number> {
  const closure = new Set<number>([fromId]);
  if (!graph) return closure;
  const adj = new Map<number, Set<number>>();
  for (const e of graph.edges) {
    if (e.derived) continue;
    if (!adj.has(e.aId)) adj.set(e.aId, new Set());
    if (!adj.has(e.bId)) adj.set(e.bId, new Set());
    adj.get(e.aId)!.add(e.bId);
    adj.get(e.bId)!.add(e.aId);
  }
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (closure.has(next)) continue;
      closure.add(next);
      queue.push(next);
    }
  }
  return closure;
}

/**
 * People currently in an active spouse_of relationship (no `until` date)
 * with someone OTHER than `exceptId`. Excluded from partner suggestions
 * so we don't suggest someone already married.
 */
function currentlyPartnered(graph: FamilyGraph | null, exceptId: number): Set<number> {
  const out = new Set<number>();
  if (!graph) return out;
  for (const e of graph.edges) {
    if (e.derived) continue;
    if (e.type !== 'spouse_of') continue;
    if (e.until) continue; // ended marriages don't count
    if (e.aId !== exceptId) out.add(e.aId);
    if (e.bId !== exceptId) out.add(e.bId);
  }
  return out;
}

/** Breadth-first shortest path (in edge count) from `fromId` to `toId`
 *  on the undirected adjacency graph. Returns the node IDs along the
 *  path, inclusive of both endpoints. Empty array if unreachable. */
function bfsShortestPath(adj: Map<number, Set<number>>, fromId: number, toId: number): number[] {
  if (fromId === toId) return [fromId];
  const prev = new Map<number, number>();
  const visited = new Set<number>([fromId]);
  const queue: number[] = [fromId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      prev.set(next, cur);
      if (next === toId) {
        const path: number[] = [];
        let step: number | undefined = next;
        while (step != null) {
          path.unshift(step);
          step = prev.get(step);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────
// Focus / person picker modal
// ─────────────────────────────────────────────────────────────────

interface FocusPickerModalProps {
  persons: PersonSummary[];
  currentFocusId: number | null;
  title?: string;
  /** When set, the "Pick existing" list is sorted by how many photos
   *  each candidate co-appears in with this person — so the most
   *  likely match (e.g. the current focus's partner) floats to the top. */
  cooccurrenceAnchorId?: number;
  /** Show a sort toggle (Connections / Photos / A–Z) above the list.
   *  Used for the Change-focus picker where the user wants to browse
   *  by different criteria. Ignored when `cooccurrenceAnchorId` is set. */
  showSortOptions?: boolean;
  /** For partner quick-adds: set of person IDs who are CO-PARENTS of the
   *  anchor's children — i.e., the obvious partner candidates. These
   *  float to the top of suggestions ahead of simple co-occurrence. */
  coparentIds?: Set<number>;
  /** For partner quick-adds: when set, fetch intimacy- and tag-weighted
   *  partner scores for this anchor and sort candidates by score DESC
   *  instead of raw shared-photo count. Two group photos lose to one
   *  2-person photo; a wedding tag boosts; a 20-person group penalises. */
  partnerScoreAnchorId?: number;
  /** Called with the chosen person's id AND their display name. Name is
   *  passed explicitly because allPersons in the parent may not have
   *  reloaded yet when a brand-new person was just created via the
   *  "Name them" path, leaving callers to fall back to "this person". */
  onPick: (personId: number, personName: string) => void;
  onPersonsChanged?: () => void;
  onClose: () => void;
  /** When a typed name in the "Name them" tab matches an existing person
   *  already on this tree, return that person so the user can confirm
   *  whether they really intended to create a new namesake. null = no
   *  conflict. When omitted, no name-conflict warning is shown. */
  nameConflictLookup?: (name: string) => { id: number; name: string } | null;
  /** Hide a suggested person from future picker lists in this tree.
   *  Used for the "Michael Gentleman isn't in this family" case — one
   *  click removes them from every picker until the user un-hides via
   *  the review list. When omitted, per-row hide buttons don't render. */
  onHideSuggestion?: (personId: number) => void | Promise<void>;
  /** Persons currently hidden from suggestions in this tree. Surfaced
   *  in the "N hidden — review" footer so mistakes can be reversed. */
  hiddenSuggestions?: PersonSummary[];
  /** Counterpart of onHideSuggestion — removes a person from the hidden
   *  list, bringing them back into the suggestion pool. Called from the
   *  review list. */
  onUnhideSuggestion?: (personId: number) => void | Promise<void>;
}

type PickerSortMode = 'connections' | 'photos' | 'alpha';

function FocusPickerModal({ persons, currentFocusId, title, cooccurrenceAnchorId, showSortOptions, coparentIds, partnerScoreAnchorId, onPick, onPersonsChanged, onClose, nameConflictLookup, onHideSuggestion, hiddenSuggestions, onUnhideSuggestion }: FocusPickerModalProps) {
  // Shared drag hook — header stays on-screen even after drag.
  const { modalRef, dragHandleProps } = useDraggableModal();

  // Single-flow picker: one search input drives BOTH existing-person
  // filtering AND the "+ Add X to PDR" create affordance that appears
  // at the bottom of the results when the query doesn't exactly match
  // any existing person. Replaces the older tabbed design (Link to
  // existing / Name them) that split the same intent across two
  // surfaces and forced the user to pick a mode before typing.
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** personId → co-occurrence photo count with the anchor, or null until loaded. */
  const [cooccurrence, setCooccurrence] = useState<Map<number, number> | null>(null);
  /** personId → weighted partner score for the partner quick-add anchor. */
  const [partnerScores, setPartnerScores] = useState<Map<number, number> | null>(null);
  /** Relationship-edge count per person, used by the Connections sort. */
  const [connectionCounts, setConnectionCounts] = useState<Map<number, number>>(new Map());
  /** Current sort mode when showSortOptions is enabled. */
  const [sortMode, setSortMode] = useState<PickerSortMode>('connections');

  // When an anchor is provided (e.g. quick-add for Terry), load how many
  // photos each candidate shares with Terry so the Pick-existing list
  // can surface Mel (or whoever Terry appears with most) at the top.
  useEffect(() => {
    if (cooccurrenceAnchorId == null) { setCooccurrence(null); return; }
    (async () => {
      const r = await getPersonsCooccurrence([cooccurrenceAnchorId]);
      if (r.success && r.data) {
        const m = new Map<number, number>();
        for (const row of r.data) m.set(row.id, row.photo_count);
        setCooccurrence(m);
      }
    })();
  }, [cooccurrenceAnchorId]);

  // Partner quick-add: fetch intimacy/tag-weighted scores for the anchor.
  // Replaces the raw co-occurrence sort so 2 group photos don't outrank
  // 1 intimate photo.
  useEffect(() => {
    if (partnerScoreAnchorId == null) { setPartnerScores(null); return; }
    (async () => {
      const r = await getPartnerSuggestionScores(partnerScoreAnchorId);
      if (r.success && r.data) {
        const m = new Map<number, number>();
        for (const row of r.data) m.set(row.id, row.score);
        setPartnerScores(m);
      }
    })();
  }, [partnerScoreAnchorId]);

  // Load relationship-edge counts if the sort UI is enabled.
  useEffect(() => {
    if (!showSortOptions) return;
    (async () => {
      const r = await listAllRelationships();
      if (r.success && r.data) {
        const counts = new Map<number, number>();
        for (const rel of r.data) {
          counts.set(rel.person_a_id, (counts.get(rel.person_a_id) ?? 0) + 1);
          counts.set(rel.person_b_id, (counts.get(rel.person_b_id) ?? 0) + 1);
        }
        setConnectionCounts(counts);
      }
    })();
  }, [showSortOptions]);

  const filtered = persons
    .filter(p => !p.name.startsWith('__'))
    .filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => {
      // Partner quick-add — weighted score wins over raw photo count.
      //   1. Co-parents to the top (they already share a child).
      //   2. Intimacy/tag-weighted partner score DESC. A 2-person wedding
      //      photo (score ~1.5) now beats two 10-person group shots
      //      (score ~0.2) that used to win on raw count alone.
      //   3. Alphabetical tie-break for people with no partner signal.
      if (partnerScoreAnchorId != null) {
        const isCoparentA = coparentIds?.has(a.id) ? 1 : 0;
        const isCoparentB = coparentIds?.has(b.id) ? 1 : 0;
        if (isCoparentA !== isCoparentB) return isCoparentB - isCoparentA;
        const scoreA = partnerScores?.get(a.id) ?? 0;
        const scoreB = partnerScores?.get(b.id) ?? 0;
        if (scoreA !== scoreB) return scoreB - scoreA;
        return a.name.localeCompare(b.name);
      }
      // When an anchor is set (non-partner quick-add), sort priorities:
      //   1. Co-parents float to the top.
      //   2. Co-occurrence DESC — people in many shared photos next.
      //   3. Alphabetical tie-break.
      if (cooccurrenceAnchorId != null) {
        const isCoparentA = coparentIds?.has(a.id) ? 1 : 0;
        const isCoparentB = coparentIds?.has(b.id) ? 1 : 0;
        if (isCoparentA !== isCoparentB) return isCoparentB - isCoparentA;
        const countA = cooccurrence?.get(a.id) ?? 0;
        const countB = cooccurrence?.get(b.id) ?? 0;
        if (countA !== countB) return countB - countA;
        return a.name.localeCompare(b.name);
      }
      // With sort options, honour the chosen mode.
      if (showSortOptions) {
        if (sortMode === 'connections') {
          const ca = connectionCounts.get(a.id) ?? 0;
          const cb = connectionCounts.get(b.id) ?? 0;
          if (ca !== cb) return cb - ca;
          return a.name.localeCompare(b.name);
        }
        if (sortMode === 'photos') {
          if (a.photoCount !== b.photoCount) return b.photoCount - a.photoCount;
          return a.name.localeCompare(b.name);
        }
        return a.name.localeCompare(b.name); // alpha
      }
      return a.name.localeCompare(b.name);
    });

  const handleCreate = async (rawName: string) => {
    setError(null);
    const trimmed = rawName.trim();
    if (!trimmed) { setError('Type a name first.'); return; }
    // Namesake guard: if someone on this tree already has this exact
    // name, ask the user to confirm a genuine namesake before we
    // create a second person with the same name. Without this the
    // single-flow picker would cheerfully create a second Dorothy.
    const conflict = nameConflictLookup?.(trimmed);
    if (conflict) {
      const proceed = await promptConfirm({
        title: `"${conflict.name}" is already on this tree`,
        message: `Someone named "${conflict.name}" already exists on your tree. Creating a new person here will add a second person with the same name — only do this if they're genuinely different people who happen to share a name.`,
        confirmLabel: `Yes, create another "${trimmed}"`,
        cancelLabel: 'Cancel',
      });
      if (!proceed) return;
    }
    setBusy(true);
    const r = await createNamedPerson(trimmed);
    setBusy(false);
    if (!r.success || r.data == null) {
      setError(r.error ?? 'Could not create person.');
      return;
    }
    if (onPersonsChanged) onPersonsChanged();
    onPick(r.data, trimmed);
  };

  // Exact-match check used to decide whether to show the "+ Add X"
  // create row. If the user has typed a name that exactly matches an
  // existing candidate (case/whitespace insensitive), we skip the
  // create row — the existing person is already right there to click.
  const trimmedQuery = query.trim();
  const hasExactMatch = trimmedQuery.length > 0 && filtered.some(
    p => p.name.trim().toLowerCase() === trimmedQuery.toLowerCase()
  );
  const showCreateRow = trimmedQuery.length > 0 && !hasExactMatch && !busy;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={modalRef}
        className="bg-background rounded-xl shadow-2xl border border-border max-w-md w-full p-4"
        onClick={e => e.stopPropagation()}
      >
        <div
          {...dragHandleProps}
          className={`flex items-center gap-2 mb-3 ${dragHandleProps.className}`}
        >
          <Move className="w-3 h-3 text-muted-foreground/60 shrink-0" aria-hidden />
          <UserPlus className="w-4 h-4 text-primary" />
          <span className="text-base font-semibold">{title ?? 'Focus on who?'}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-0.5 rounded hover:bg-accent">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Single-flow picker: one search input, existing matches
            filtered below, a "+ Add X to PDR" create row appended at
            the bottom when the query doesn't match anyone. */}
        <div>
          <input
              type="text"
              autoFocus
              // Family names like "Filmer" trip the OS spell-checker
              // and the red squiggle is permanent visual noise. Same
              // rule we apply on NameQuickEditor — names aren't
              // dictionary words. autoCorrect / autoCapitalize off
              // for the same reason (iOS / Android web views).
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const exact = filtered.find(p => p.name.trim().toLowerCase() === trimmedQuery.toLowerCase());
                  if (exact) onPick(exact.id);
                  else if (filtered.length === 1) onPick(filtered[0].id);
                  else if (showCreateRow) handleCreate(trimmedQuery);
                }
              }}
              placeholder="Search or type a new name…"
              className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-sm"
            />
            {showSortOptions && cooccurrenceAnchorId == null && (
              <div className="flex items-center gap-1 mt-2 p-0.5 bg-muted rounded-lg text-[10px]">
                {(['connections', 'photos', 'alpha'] as PickerSortMode[]).map(m => (
                  <button
                    key={m}
                    onClick={() => setSortMode(m)}
                    className={`flex-1 px-2 py-1 rounded transition-colors ${sortMode === m ? 'bg-background shadow-sm font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {m === 'connections' ? 'Connections' : m === 'photos' ? 'Photos' : 'A–Z'}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 max-h-72 overflow-auto flex flex-col gap-0.5 border border-border rounded p-0.5">
              {filtered.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-2">No matches.</p>
              )}
              {filtered.map(p => {
                const coCount = cooccurrence?.get(p.id);
                const connCount = connectionCounts.get(p.id) ?? 0;
                const isCoparent = coparentIds?.has(p.id) ?? false;
                // Context-specific rich label (shares children / shared
                // photos / connection count) takes priority when it
                // carries more signal than the raw photo count.
                let rightLabel: string | null = null;
                if (isCoparent) {
                  rightLabel = 'shares children';
                } else if (cooccurrenceAnchorId != null && coCount != null && coCount > 0) {
                  rightLabel = `${coCount} shared photo${coCount === 1 ? '' : 's'}`;
                } else if (showSortOptions) {
                  if (sortMode === 'connections' && connCount > 0) rightLabel = `${connCount} connection${connCount === 1 ? '' : 's'}`;
                  else if (sortMode === 'photos' && p.photoCount > 0) rightLabel = `${p.photoCount} photo${p.photoCount === 1 ? '' : 's'}`;
                }
                // Fallback: plain photo count, matching the placeholder
                // resolver's row format so users see the same signal
                // ("N photos") across both pickers — helps them spot
                // which candidate is the right match when names are
                // identical or similar.
                if (!rightLabel) {
                  rightLabel = `${p.photoCount} ${p.photoCount === 1 ? 'photo' : 'photos'}`;
                }
                return (
                  <div
                    key={p.id}
                    className={`group flex items-center gap-1 px-2 py-1 rounded text-sm ${
                      p.id === currentFocusId ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-accent'
                    } ${busy ? 'opacity-70' : ''}`}
                  >
                    <button
                      onClick={() => !busy && onPick(p.id)}
                      disabled={busy}
                      className="flex-1 min-w-0 flex items-center justify-between gap-2 text-left"
                    >
                      <span className="truncate">{p.name}</span>
                      {rightLabel && (
                        <span className="text-[10px] text-muted-foreground shrink-0">{rightLabel}</span>
                      )}
                    </button>
                    {onHideSuggestion && (
                      <IconTooltip label="Not in this family — hide from suggestions" side="left">
                        <button
                          onClick={(e) => { e.stopPropagation(); onHideSuggestion(p.id); }}
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded text-muted-foreground hover:text-destructive hover:bg-background shrink-0 transition-opacity"
                          aria-label={`Hide ${p.name} from suggestions`}
                        >
                          <EyeOff className="w-3 h-3" />
                        </button>
                      </IconTooltip>
                    )}
                  </div>
                );
              })}
              {showCreateRow && (
                <button
                  onClick={() => handleCreate(trimmedQuery)}
                  disabled={busy}
                  className="flex items-start gap-2 px-2 py-1.5 rounded text-sm text-left text-foreground hover:bg-primary/10 border-t border-dashed border-border/60 mt-0.5 pt-2 disabled:opacity-50"
                >
                  {/* Body uses text-foreground (defined typography
                      tier) so the row reads at full contrast on
                      white. Lavender is reserved for the icon
                      accent + the hover background — applying it to
                      the whole label produced washed-out body text
                      which broke the typography rules. */}
                  <UserPlus className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary" />
                  <span className="leading-snug whitespace-normal break-words">
                    Add <strong>{trimmedQuery}</strong> as a new person — they aren't on PDR yet.
                  </span>
                </button>
              )}
            </div>
            {hiddenSuggestions && hiddenSuggestions.length > 0 && onUnhideSuggestion && (
              <HiddenSuggestionsReview
                hidden={hiddenSuggestions}
                onUnhide={onUnhideSuggestion}
              />
            )}
          </div>

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        {/* Footer: muted text-link cancel + a primary CTA, matching
            the convention used by every other modal in PDR
            (promptConfirm, FaceGridModal, DateEditor, etc.). The
            CTA's label and behaviour adapt to context — pick the
            highlighted existing person, or create the typed name
            as a new one. Disabled when there's nothing actionable. */}
        {(() => {
          const exactMatch = trimmedQuery.length > 0
            ? filtered.find(p => p.name.trim().toLowerCase() === trimmedQuery.toLowerCase())
            : null;
          const singleMatch = !exactMatch && filtered.length === 1 ? filtered[0] : null;
          const willCreate = !exactMatch && !singleMatch && showCreateRow;
          const hasAction = !!(exactMatch || singleMatch || willCreate);
          const ctaLabel = willCreate
            ? `Add ${trimmedQuery}`
            : exactMatch
            ? `Pick ${exactMatch.name}`
            : singleMatch
            ? `Pick ${singleMatch.name}`
            : 'Add';
          const onCommit = () => {
            if (exactMatch) onPick(exactMatch.id);
            else if (singleMatch) onPick(singleMatch.id);
            else if (willCreate) handleCreate(trimmedQuery);
          };
          return (
            <div className="flex items-center justify-between gap-3 mt-3 pt-2 border-t border-border">
              <button
                type="button"
                onClick={onClose}
                className="text-sm text-muted-foreground hover:text-foreground font-medium transition-colors px-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onCommit}
                disabled={busy || !hasAction}
                className="px-5 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {busy ? 'Adding…' : ctaLabel}
              </button>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

