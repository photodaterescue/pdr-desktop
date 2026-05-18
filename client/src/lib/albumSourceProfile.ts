/**
 * AlbumSourceProfile (v2.0.8).
 *
 * Maps an album group's `source_kind` + `source_key` (or an album's
 * `source` value) to render hints: an icon component, a pastel
 * border/background palette, and a human-readable label. Centralises
 * the per-source visual identity so the AlbumsView tree, individual
 * album cards, and the AddToAlbumPopover row icons all read the
 * same fact the same way.
 *
 * Brand-colour disclaimer (Terry 2026-05-18): colour values aren't
 * copyrightable; trademarks protect logos and specific colour-
 * combinations in specific industries (UPS brown, Tiffany blue),
 * neither of which apply to pastel hints in a photo-org app.
 * The actual brand logos are NEVER rendered — generic lucide icons
 * (Sparkles, Cloud, Camera, etc.) keep us comfortably clear of any
 * trademark concern.
 */

import {
  Sparkles, Home, Cloud, FolderClosed, Aperture, HardDriveDownload,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AlbumGroupRecord, AlbumSummary } from './electron-bridge';

export interface AlbumSourceProfile {
  /** Lucide icon component for the source. */
  Icon: LucideIcon;
  /** Tailwind classes for a pastel card background + border. Applied
   *  to the album card surface so the source is recognisable at a
   *  glance from across the grid. */
  cardBgClass: string;
  /** Tailwind classes for the corner badge background — slightly
   *  stronger than the card surface, used by AlbumsView's icon
   *  badge in the cover overlay. */
  badgeBgClass: string;
  /** Tailwind colour for the source icon. Used inside badges + in
   *  popover rows. */
  iconColorClass: string;
  /** Subtle text-colour variant for the badge label when one is
   *  rendered next to the icon (e.g. "Takeout" / "Yours"). */
  badgeTextClass: string;
  /** Human-readable name for the source — used in tooltips and the
   *  group-header title when no explicit title was given (rare). */
  label: string;
  /** Short brand-recognisable name for the card corner badge (e.g.
   *  "Google Photos", "PDR", "OneDrive"). Terry 2026-05-18: "Yours"
   *  read as generic and unbranded; "Takeout" read as technical
   *  jargon. Badges should signal the company / product the album
   *  belongs to so the source identity is obvious at a glance. */
  badgeLabel: string;
}

// ── Auto-source profiles, keyed by albums.source value ─────────────────────

const AUTO_PROFILES: Record<string, AlbumSourceProfile> = {
  // PDR-native: violet (PDR's brand colour). Home icon — "your space,
  // centrally managed". Replaced PencilLine because that icon reads as
  // "click to edit/rename" everywhere else in PDR; users were
  // misinterpreting it as a rename affordance on the album cards.
  user_created: {
    Icon: Home,
    cardBgClass: 'bg-violet-50 dark:bg-violet-950/40 border-2 border-violet-300 dark:border-violet-700/60',
    badgeBgClass: 'bg-violet-50 dark:bg-violet-950/80',
    iconColorClass: 'text-violet-500 dark:text-violet-400',
    badgeTextClass: 'text-violet-700 dark:text-violet-300',
    label: 'PDR',
    badgeLabel: 'PDR',
  },
  // Google Photos Takeout: soft red (Google's primary brand red).
  takeout_imported: {
    Icon: Sparkles,
    cardBgClass: 'bg-red-50 dark:bg-red-950/40 border-2 border-red-300 dark:border-red-700/60',
    badgeBgClass: 'bg-red-50 dark:bg-red-950/80',
    iconColorClass: 'text-red-500 dark:text-red-400',
    badgeTextClass: 'text-red-700 dark:text-red-300',
    label: 'Google Photos Takeout',
    badgeLabel: 'Google Photos',
  },
  // ── Future sources (importers don't exist yet; profiles stubbed
  //    so they slot in cleanly when added) ───────────────────────────
  apple_photos: {
    Icon: Aperture,
    cardBgClass: 'bg-pink-50 dark:bg-pink-950/40 border-2 border-pink-300 dark:border-pink-700/60',
    badgeBgClass: 'bg-pink-50 dark:bg-pink-950/80',
    iconColorClass: 'text-pink-500 dark:text-pink-400',
    badgeTextClass: 'text-pink-700 dark:text-pink-300',
    label: 'Apple Photos',
    badgeLabel: 'Apple Photos',
  },
  icloud_drive: {
    Icon: Cloud,
    cardBgClass: 'bg-sky-50 dark:bg-sky-950/40 border-2 border-sky-300 dark:border-sky-700/60',
    badgeBgClass: 'bg-sky-50 dark:bg-sky-950/80',
    iconColorClass: 'text-sky-500 dark:text-sky-400',
    badgeTextClass: 'text-sky-700 dark:text-sky-300',
    label: 'iCloud Drive',
    badgeLabel: 'iCloud',
  },
  onedrive: {
    Icon: Cloud,
    cardBgClass: 'bg-blue-50 dark:bg-blue-950/40 border-2 border-blue-300 dark:border-blue-700/60',
    badgeBgClass: 'bg-blue-50 dark:bg-blue-950/80',
    iconColorClass: 'text-blue-500 dark:text-blue-400',
    badgeTextClass: 'text-blue-700 dark:text-blue-300',
    label: 'OneDrive',
    badgeLabel: 'OneDrive',
  },
  google_drive: {
    Icon: Cloud,
    cardBgClass: 'bg-emerald-50 dark:bg-emerald-950/40 border-2 border-emerald-300 dark:border-emerald-700/60',
    badgeBgClass: 'bg-emerald-50 dark:bg-emerald-950/80',
    iconColorClass: 'text-emerald-500 dark:text-emerald-400',
    badgeTextClass: 'text-emerald-700 dark:text-emerald-300',
    label: 'Google Drive',
    badgeLabel: 'Google Drive',
  },
  dropbox: {
    Icon: Cloud,
    cardBgClass: 'bg-indigo-50 dark:bg-indigo-950/40 border-2 border-indigo-300 dark:border-indigo-700/60',
    badgeBgClass: 'bg-indigo-50 dark:bg-indigo-950/80',
    iconColorClass: 'text-indigo-500 dark:text-indigo-400',
    badgeTextClass: 'text-indigo-700 dark:text-indigo-300',
    label: 'Dropbox',
    badgeLabel: 'Dropbox',
  },
  amazon_photos: {
    Icon: Cloud,
    cardBgClass: 'bg-amber-50 dark:bg-amber-950/40 border-2 border-amber-300 dark:border-amber-700/60',
    badgeBgClass: 'bg-amber-50 dark:bg-amber-950/80',
    iconColorClass: 'text-amber-500 dark:text-amber-400',
    badgeTextClass: 'text-amber-700 dark:text-amber-300',
    label: 'Amazon Photos',
    badgeLabel: 'Amazon',
  },
};

/** Profile used when an unknown auto-source value appears (a future
 *  source whose importer landed but whose profile hasn't been added
 *  to this table). Neutral cloud styling so it doesn't crash render. */
const UNKNOWN_SOURCE_PROFILE: AlbumSourceProfile = {
  Icon: HardDriveDownload,
  cardBgClass: 'bg-sky-50 dark:bg-sky-950/40 border-2 border-sky-300 dark:border-sky-700/60',
  badgeBgClass: 'bg-sky-50 dark:bg-sky-950/80',
  iconColorClass: 'text-sky-500 dark:text-sky-400',
  badgeTextClass: 'text-sky-700 dark:text-sky-300',
  label: 'Imported album',
  badgeLabel: 'Imported',
};

/** Profile used by user-created folders (NOT user-created albums —
 *  user folders are the hand-created groups in the tree, not the
 *  albums inside them). Neutral muted styling so the folder reads
 *  as organisation, not a source. */
const USER_FOLDER_PROFILE: AlbumSourceProfile = {
  Icon: FolderClosed,
  cardBgClass: 'bg-muted/30 border-border',
  badgeBgClass: 'bg-muted',
  iconColorClass: 'text-muted-foreground',
  badgeTextClass: 'text-muted-foreground',
  label: 'Folder',
  badgeLabel: 'Folder',
};

// ── Lookups ───────────────────────────────────────────────────────────

/** Profile for an AlbumGroupRecord (used by AlbumsView tree headers). */
export function getSourceProfileForGroup(group: AlbumGroupRecord): AlbumSourceProfile {
  if (group.source_kind === 'user') return USER_FOLDER_PROFILE;
  if (group.source_key && AUTO_PROFILES[group.source_key]) return AUTO_PROFILES[group.source_key];
  return UNKNOWN_SOURCE_PROFILE;
}

/** Profile for an AlbumSummary based on its `source` field (used by
 *  album cards inside the tree and rows inside AddToAlbumPopover). */
export function getSourceProfileForAlbum(album: Pick<AlbumSummary, 'source'>): AlbumSourceProfile {
  return AUTO_PROFILES[album.source] ?? UNKNOWN_SOURCE_PROFILE;
}

/** True iff this group is one the user is allowed to drop albums into
 *  manually. Auto-source groups refuse manual adds (their contents
 *  are factual snapshots of what came from the source). */
export function isGroupDroppable(group: AlbumGroupRecord): boolean {
  return group.source_kind === 'user';
}

/** True iff albums of this source can have NEW photos added to them
 *  via the Add to Album popover. Source-imported albums are read-only
 *  in terms of contents (the snapshot must stay factual); only PDR-
 *  created albums accept new photos. */
export function isAlbumSourceUserEditable(albumSource: string): boolean {
  return albumSource === 'user_created';
}
