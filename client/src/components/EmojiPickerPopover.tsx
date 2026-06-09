// EmojiPickerPopover — v2.1 round 60 (Terry 2026-06-09).
//
// Tiny self-contained emoji picker. Built in-house rather than pulling
// in emoji-picker-react (~150 KB) or @emoji-mart/react (~30 KB) — for
// 60-odd curated emojis across five tabs, a 5 KB component beats a
// dependency. Curated list (not the full 3,000+ Unicode set) keeps
// the picker fast to scan and the bundle small; captions are short-
// form so the long tail of obscure emojis isn't valuable here.
//
// Pattern matches the Radix Popover used elsewhere in PDR (e.g. the
// Memories Insights popover): trigger button + portalled content with
// `forceMount` so the popover paints above the modal's stacking
// context (caption modal lives at z-80; Radix defaults sit below).
//
// Insertion strategy: caller passes the input/textarea ref + a
// state setter. Clicking an emoji splices it into `value` at the
// current selection range so users can interleave emojis with text
// rather than always appending at the end. Cursor is restored
// immediately after the spliced glyph so they can keep typing.

import { useState } from 'react';
import { Smile } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconTooltip } from '@/components/ui/icon-tooltip';

// Five tabs, ~12-16 emojis each. Curated to cover the common
// caption use-cases: faces/feelings, hearts/love, family/people,
// nature/food, travel/celebration.
const EMOJI_TABS: Array<{ key: string; label: string; emojis: string[] }> = [
  {
    key: 'smileys',
    label: '😀',
    emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😉','😊','😇','😍','🥰','😘','😋','😜','🤩','🥳','😎','🤔','😴','😢','😭','😡','😱'],
  },
  {
    key: 'hearts',
    label: '❤️',
    emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💖','💗','💓','💞','💕','💝','💘','💌','💟','♥️','💯','✨','⭐','🌟','💫','🔥','🎉'],
  },
  {
    key: 'people',
    label: '👍',
    emojis: ['👍','👎','👌','✌️','🤞','🤟','🤘','👏','🙌','🤝','🙏','💪','🫶','👋','🤗','🫂','👶','👧','👦','👩','👨','👵','👴','👨‍👩‍👧','👨‍👩‍👦','👪'],
  },
  {
    key: 'nature',
    label: '🌿',
    emojis: ['🌿','🌳','🌲','🌴','🌵','🌷','🌹','🌻','🌼','🌸','🌺','🍀','🍂','🍁','🌍','🌞','🌝','🌚','🌙','☀️','⛅','🌧️','❄️','🌈','🐶','🐱'],
  },
  {
    key: 'food',
    label: '🍕',
    emojis: ['🍕','🍔','🍟','🌭','🥪','🌮','🌯','🥗','🍣','🍱','🍝','🍜','🍲','🍛','🍤','🥘','🍰','🎂','🧁','🍪','🍫','🍩','☕','🍵','🍺','🍷'],
  },
  {
    key: 'travel',
    label: '✈️',
    emojis: ['✈️','🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🚚','🚛','🚜','🚲','🛵','🏍️','🛶','⛵','🚤','🛳️','⛴️','🚢','🏖️','🏔️','🗻'],
  },
];

interface EmojiPickerPopoverProps {
  /** Called with the picked emoji glyph. Caller is responsible for
   *  splicing it into the input value and updating its state. */
  onPick: (emoji: string) => void;
}

export function EmojiPickerPopover({ onPick }: EmojiPickerPopoverProps) {
  const [activeTab, setActiveTab] = useState<string>(EMOJI_TABS[0].key);
  const [open, setOpen] = useState(false);
  const currentTab = EMOJI_TABS.find(t => t.key === activeTab) ?? EMOJI_TABS[0];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <IconTooltip label="Insert emoji" side="top">
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
            data-testid="caption-emoji-trigger"
            aria-label="Insert emoji"
          >
            <Smile className="w-4 h-4" />
          </button>
        </PopoverTrigger>
      </IconTooltip>
      <PopoverContent className="w-[280px] p-2 z-[90]" align="end" side="top">
        {/* Tab strip — emoji-only buttons so the strip stays compact
            and language-neutral. */}
        <div className="flex items-center gap-1 mb-2 border-b border-border pb-1">
          {EMOJI_TABS.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={`flex-1 text-base px-1 py-1 rounded transition-colors ${activeTab === t.key ? 'bg-primary/15' : 'hover:bg-secondary/60'}`}
              aria-label={`${t.key} emojis`}
              aria-pressed={activeTab === t.key}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* Emoji grid — 6 columns × N rows. Click inserts and KEEPS
            the popover open so the user can stack several emojis
            without re-clicking the trigger. */}
        <div className="grid grid-cols-6 gap-0.5 max-h-[180px] overflow-y-auto">
          {currentTab.emojis.map((emoji, i) => (
            <button
              key={`${currentTab.key}-${i}`}
              type="button"
              onClick={() => onPick(emoji)}
              className="text-lg w-9 h-9 flex items-center justify-center rounded hover:bg-secondary/60 transition-colors"
              aria-label={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
