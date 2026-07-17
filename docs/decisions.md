# Decision Log

> **Owner:** Claude records · Terry approves product-intent entries · **Update when:** a non-obvious
> architectural/product decision is made · **Last reviewed:** 2026-07-17 · **Audience:** Claude (primary), Leo (background)
>
> Lightweight ADRs: *what* was decided and *why*. Newest first. When an old decision is reversed, add a new
> entry rather than editing the old one.

### On-device only — "nothing uploaded"
All analysis, AI and storage are local; there is no cloud library. **Why:** it's the core trust promise and
the main moat. Any future "sync" is device-to-device, never upload. This constrains every design and must
not be quietly broken.

### Library-drive durability for the search index and collage projects
The search DB and `.pdrcollage` projects are mirrored to a hidden `.pdr\` sidecar on the user's library
drive, with a newer-wins merge. **Why:** AppData is per-machine; a reinstall/new-PC/cleared-AppData would
otherwise wipe editable work. The drive copy restores everything.

### Collage delete = soft delete → Workspace Recycle Bin (v3.0.3)
Deleting a collage/carousel/template flips a `trashed` flag (record stays, mirrored via the existing
sidecar merge); it appears in the Workspace Recycle Bin (Templates on their own row) and only **delete
forever** removes files (→ OS Recycle Bin). **Why:** Terry's instinct — a delete should be recoverable
inside PDR, and templates are precious/rarely-deleted so they get a VIP row. Chosen over a Windows-only bin
(cryptic filenames) and over a Collages-local trash (he expected the sidebar bin).

### Version naming: v2.1 never shipped; it became v3.0.0
The big collages+capture+Trees release was re-versioned to **v3.0**; there is no v2.1 anywhere. Last shipped
before 3.0.0 was 2.0.14. **Why:** Terry's call (2026-06-22). Don't reintroduce a v2.1 label.

### "Date Editor" cancelled → replaced by "Needs Dates"
Date-fixing for low-confidence files lives in **Needs Dates**; the separate Date-Editor redesign is dead
(and its old window is dead code). **Why:** Terry (2026-06-22). Never plan or mention a "Date Editor".

### Pricing = dual model (subscriptions **and** Lifetime)
Monthly $19 / Yearly $79 / Lifetime $199, plus two free surfaces; retention prices are in-app-only. **Why:**
Yearly ≈ 4 months of Monthly (upsell without killing Lifetime); Lifetime ≈ 2.5 years of Yearly (fair for
the keep-forever customer). Never describe PDR as only-subscription or only-one-off.

### WYSIWYG collage export
Collages/carousels export through the *same* engine that draws the editor (offscreen `viewer.html` bake),
not a separate server-side renderer. **Why:** guarantees the exported image matches the editor pixel-for-pixel.

### Clips (v3.1) scope locked to CapCut-lite
One video row + two audio rows, transitions only at joins; stacked video layers out. **Why:** a real-time
composed multi-layer preview is the one genuinely hard problem; keeping it out makes v1 shippable on the
existing ffmpeg engine.

### Big local-LLM AI companion is on ice
The ~1–2.5 GB local chat model is parked; v3.1 only tweaks the lightweight "Ask PDR". **Why:** Terry isn't
convinced the heavy download earns its footprint. Don't build it without a fresh green light.

### Mobile companion (v4.0): build the sync protocol on the desktop first
Not phone-first. Build pairing + E2E sync + index/preview transfer inside the desktop app (test PC↔PC),
then a thin React Native/Expo client, **read-only viewer first**. **Why:** de-risks the hard part with zero
mobile tooling; the phone app becomes "just" a client.

### US spelling is user-facing only — never touch code
Spelling changes apply to visible UI text only; code identifiers/comments stay as-is and must not be
"corrected". **Why:** Terry, emphatically (2026-07-17). Settled exceptions: "Nardo Grey", "PDR Catalogue".

### Release notes are mandatory every release
`release-notes/v<version>.md` is written before packaging and injected into the update manifest. **Why:** it
becomes the in-app "what's new" toast; no file = users see a blank update.

### GitHub `/docs` is the source of truth; local agent memory is subordinate
This knowledge layer is authoritative over any agent's session-local memory. **Why:** so a desktop-Claude
and a future remote/Telegram-Claude (and Leo) can't develop divergent understandings of PDR.
