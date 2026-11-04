# Arthur desktop UI: design exploration ("Marginalia")

Status: **design exploration only. Awaiting approval.** Nothing in `apps/arthur`, the backend, SQLite, `ArthurClient`, the graph, lineage or AI infrastructure was touched. Everything here is static HTML/CSS/JS in this folder.

Open in a browser (Chrome/Firefox, `file://` works, fonts are bundled):

| File | What it is |
|---|---|
| `directions.html` | The three directions, with verdicts |
| `design-system.html` | Interactive design-system playground (presets, theme, density, accent, type, radius, kind tint, copyable prompt) |
| `screens.html?s=home\|ideas\|connections\|evolution` | The four desktop compositions, interactive (select rows, nodes, edges, revisions, filters) |
| `arthur.css`, `arthur-ui.js` | Tokens, components, sample data, graph + lineage renderers |
| `shots/*.png` | Screenshots rendered from the above in headless Chrome at 1440×900 |
| `shoot.sh` | Re-renders a screenshot |

---

## 1. Critique of the current UI

Read from `apps/arthur/src` (App.tsx, layout.tsx, styles.css, the five panels, GraphView, LineageGraph).

It feels like a developer prototype for specific, fixable reasons:

1. **It is one vertical stack of five unrelated panels** (Capture, Knowledge, Lineage, Graph, Runtime) in a 48rem column. There is no navigation, no hierarchy and no sense of place. It reads as a test harness, one panel per milestone.
2. **Features are named after subsystems, not user intent.** "Knowledge", "Runtime", "Cognitive Runtime", "Distill", raw ids like `capture 3fa2c1d8 · characters 89–143`. The user is asked to operate Arthur's pipeline.
3. **Distillation is a manual button per capture.** That contradicts "Capture quickly. Arthur organizes."
4. **Provenance, connections and revisions are three separate panels**, each re-listing the same objects. The product's core idea (they are facets of one thought) is invisible.
5. **Identical `.panel` boxes** (1px border, 0.75rem radius, same padding) everywhere, so nothing is more important than anything else.
6. **System font, 1.5rem tracked-caps-style title, a footer disclaimer** ("Sync, recall and devices are not implemented yet") baked into the chrome.
7. **The graph and lineage are SVGs with the same visual grammar**: circles, curved arrows, same type. They look like one visualisation shown twice.
8. **Colour is the only encoding in places** (kind badges, edge kinds), with tiny labels doing the real work.

**Where the rough mockups fall short too** (you gave permission to challenge them):

- Stat cards ("12 Active ideas / 28 connections / 6 inferred today / 4 evolving threads") are dashboard furniture, and *"inferred today"* and *"evolving threads"* are not values the data model produces.
- Every region is a rounded card, often with a card inside. Blue→violet gradients and glows on the composer and nodes.
- Home quote box in the sidebar; "Local Node Ready" status; sparkle glyphs as decoration.
- Evolution reused circles and the same curved-edge style as Connections.
- Revision rows show commit-message captions ("Add emphasis on seamless organization"). **`ThoughtRevision` has no message field**; those would have to be invented.
- "Make current", "Confirm/Remove connection" are natural-looking buttons that `ArthurClient` cannot do (no delete/confirm relation, no set-current on an existing revision).

## 2. Arthur's visual identity, in concrete terms

**Idea:** *a notebook with a memory.* A thought is a page. What Arthur knows *about* the thought lives in its margin.

- **The margin.** Every thought, everywhere (row, inspector, node), carries the same three annotations in the same place: source (voice/typed/wristband), connections (count), revisions (r-number).
- **The thread.** The one memorable device. A hairline runs from a raw Capture down to the ideas distilled from it (Home), and the same thread becomes the rail in Evolution. The logo's apex node is the same dot.
- **Serif is content, sans is chrome.** Newsreader for anything the user thought or Arthur distilled. Hanken Grotesk for what the interface says. The face tells you whose words you are reading.
- **Solid is yours, dashed is Arthur's.** Model-proposed links carry a hollow dashed dot; user/system ones a solid dot. Diff and lineage use the same logic (a revision from a new capture gets a pencil-blue outline).
- **Colour means a relation or a state, never a category.** Idea kinds are five shapes (circle, rounded square, diamond, hexagon, page). One accent (verdigris), used only for *current / focus / selection*.
- **Quiet.** Hairlines and whitespace instead of cards. The only raised surfaces: the composer, popovers and the graph legend. The only shadows: overlays.

Brand: everyday UI says **Arthur**. The mark is two legs meeting at one accent node (a letter, or a thought that branches). "A.R.T.H.U.R. Cognitive Runtime" is reserved for About, docs and competition material.

## 3. Three directions

| | Bet | Verdict |
|---|---|---|
| **A · Ledger** | Arthur is a fast tracker. ⌘K palette, table of ideas, properties panel. | Cheapest and scales, but it's *the* generic option (Linear with different data). Graph/lineage become secondary "views"; provenance becomes a column. |
| **B · Atlas** | Arthur is a map. The graph is home; time is a scrubber; composer docks like a command line. | Most memorable demo, but it collapses at scale (12 nodes lovely, 400 a hairball), is bad for text-heavy tasks/notes, lands in glow/glass/neon-HUD territory you asked to avoid, and doesn't translate to mobile. |
| **C · Marginalia** | Arthur is a notebook with a memory. Document-first, margin annotations, graph and lineage as zoom-outs. | Best fit. See below. |

Scored on distinctiveness, showing the three concepts, feeling like thinking, build cost and mobile-readiness in `directions.html`.

## 4. Selected direction: C · Marginalia

Why it fits Arthur:

- It is the only direction that makes **provenance, connections and evolution part of every thought**, as your brief asks, rather than three screens.
- It is **"an extension of your thinking"**, not a database admin tool and not a chat app. It reads like a notebook.
- It **scales** (rows + hairlines + one inspector) and **adapts to mobile** (margin collapses under the thought; inspector becomes a bottom sheet; rail becomes a tab bar; the map defaults to list).
- It spends its boldness once (the thread + margin) and stays disciplined elsewhere.
- Its weakness, being quieter than Atlas in a 30-second demo, is covered by making **Connections** the showpiece screen.

## 5. Design system (summary; full interactive version in `design-system.html`)

**Type.** Newsreader (display 42/1.12, page title 32, thought title 27, body 16/1.62 max 62ch, row title 16.5, quote italic 14.5). Hanken Grotesk 13.5 UI, 12 meta, tabular numerals. Sentence case; no all-caps eyebrows; day groups are italic serif.

**Colour (Graphite).** Ground `#151716`, sunken `#111312`, raised `#1c1f1e`, overlay `#232726`, lines `#2c302e` / `#222625`, ink `#e9e6dd` → `#a9aca3` → `#747971` → `#4d524c`. Accent `#6fbfa6`. Pencil `#8ba4bd`. Relations: related_to `#7d837b`, extends `#8bb6d9`, depends_on `#d9b36b`, derived_from `#c58f6e`, contradicts `#e8836a`, duplicates `#bdb9aa`, supersedes `#b79bd8`. Diff +`#8fc79b` / −`#e8836a`. **Daylight** (cool paper, not cream) is a full secondary theme with its own values.

**Shape.** Radii by role: 3 (chips/kbd), 6 (buttons/inputs/rows), 11 (composer/popovers), full only for Speak and status dots. 4px spacing base; comfortable row 68px, compact 48px (drops snippet).

**Surfaces/borders.** Ground → sunken (rail, inputs) → raised (composer only) → overlay (menus, legend). Selection = 2px accent leading bar + 8% ink wash, never an outlined box.

**Icons.** 1.5px stroke / 24 grid, Lucide-compatible for generic UI. **Custom** for the 5 kinds and 7 relations (Arthur's vocabulary).

**Navigation.** 216px rail: mark, filled **Capture** button (⌘N, global action), Home / Ideas / Connections / Evolution, a disabled "Ask Arthur" slot, Settings. Current = wash + 2px accent bar.

**Buttons/inputs.** One ink-filled primary per view; outlined default; ghost; accent only for Speak. Filters are underline tabs, not pills; empty kinds dim but don't move.

**Graph (Connections): organic, spatial, serif labels.** Node shape = kind; size = connection count (12–26px). Edge **geometry** = relation: related_to thin solid; extends solid + open chevron; depends_on long dash + filled arrow; derived_from dotted + hollow arrow; contradicts bar–bar; duplicates double line; supersedes arrow + stop bar. Edge labels **only on focus**. Selecting dims the rest to 34%. Region names are quiet italic text, not boxes.

**Lineage (Evolution): structured, temporal, sans labels.** Rounded-rectangle revisions on a left→right two-lane rail with orthogonal rounded-corner joins. Current = accent fill (exactly one). Merge = underlined box with two rails in. From-new-capture = pencil outline. Deterministic word diff inline (+ green wash, − red wash *and* strike).

**States.** Empty = an instruction ("Say or type a thought…"). Loading preserves layout with skeletons. Errors say what happened and what's unchanged ("Couldn't save the merge. R2 and R3 are unchanged…").

**Motion.** 120ms state, 220ms structural, one easing. One orchestrated moment: on capture, the thread draws (600ms, staggered) from the capture to its ideas. New revision rail draws left→right. Graph never auto-floats; layout is computed once so the map is stable. `prefers-reduced-motion` → instant.

## 6. Screen specifications (1440×900 reference; rail 216px)

**Home.** `Good evening` (italic serif, muted) above the **composer**, whose placeholder *is* the headline ("What's on your mind?", Newsreader 42). Raised surface, 11px radius, focus = accent border + 4px soft ring. Bottom bar: **Speak** (accent, pill, ⌥Space), Add context, hint, **Capture ⌘↵**. Below: two columns (1fr / 340). Left, **Today**, grouped **by Capture**: a node with the source icon and a one-line italic excerpt, then the ideas Arthur distilled from it, joined by the thread; each idea row shows kind glyph, serif title, snippet, margin. Right: **Connected thinking** (ego-graph, 6 nodes, geometry-true, no container) and **Recently evolving** (title, a 104px mini-rail showing its actual shape, "r5 current · 18 min ago").

**Ideas.** Two columns: list / 430px inspector. Header: title, subtitle, search (`/`), Sort, Filter. Underline tabs All / Ideas / Tasks / Decisions / Questions / Notes with counts. Day groups in italic serif. Rows 68px: glyph · title · snippet · margin (source · connections · r-number · age). Inspector: kind + edited-ago → title → body → Revise / Branch → **Source** (capture meta + quote with the exact span highlighted) → **Connections** (ego-graph + sentence rows: relation swatch · title · verb, with origin dot) → **Revisions** (vertical spine, current marked). Each section header links to its screen.

**Connections.** Full-bleed dotted-grid canvas (no card). Page head: title, "12 ideas, 14 links", Map/List, find, **Find connections** (renamed from "Infer"). Top-left of canvas: origin filter *All / Yours / Proposed by Arthur*. Bottom-left: **legend that is also the filter** (7 relation swatches, toggle to hide). 392px inspector: node mode (kind, title, 4-line body, Open idea, "5 revisions", connections grouped by relation with glyph + origin) or **edge mode** ("A *extends* B" sentence, big swatch, what it means, origin, created, direction, plus the "checked twice" note for model origin).

**Evolution.** 300px **idea picker** (title, r-number, mini-rail) + work area. Head: idea title, "5 revisions · 1 branch · 1 merge · R5 is current"; **Revise**, **Branch from R_n**, **Merge…** (the three real client verbs). The rail (two lanes, tags above: capture / edit / from capture / merge / current; generated captions below: `+15 −0 words · title`, `Merged R2 + R3`; timestamps). Below: selected revision: diff (title + body, with "vs R2 / vs R3" toggle for merges), and a side column **Source** (capture span if the revision truly has one; otherwise "This text is your edit, so it has no capture source.", which mirrors the contract's rule) and **Continues from / Merged from**.

## 7. UX changes I recommend

1. **Delete the stat tiles.** Counts live inside what they count; "inferred today" / "evolving threads" aren't data we have.
2. **Home groups by Capture, not by object type.** It makes provenance visible without a page for it.
3. **Auto-distill after capture** (with an "Arthur is organizing…" state) instead of a Distill button. This is a *behaviour* change, so it's a proposal for you to approve, not something I assumed.
4. **Evolution needs an idea picker.** Lineage is per object; a global "Create revision" has no target.
5. **Replace invented revision messages with derived captions** (`+15 −0 words · title`) because `ThoughtRevision` has no message. If you want messages, that's a contract/schema change.
6. **Edge labels only on focus.** Eight permanent labels is the spaghetti you want to avoid.
7. **"Infer connections" → "Find connections"** and surface its cost (3 provider requests max: one proposal + two verification votes). `inferRelations(objectIds?)` accepts a scope, so "find for this idea" belongs in the inspector too.
8. **Drop buttons the client can't honour:** Remove/Confirm connection, "Make current" on an old revision. If wanted later they need new client calls.
9. **Footer honesty.** The rail says "Stored on this device", not "Local node / nothing leaves", because cloud STT and the DeepSeek provider exist.
10. **Reserve ⌘K** for the future Ask Arthur/command bar; local filtering uses `/`. Ask Arthur has a visible, disabled slot.
11. **Hide or dim zero-count kind tabs** rather than showing "Notes 0" as a destination.

## 8. Reuse vs redesign

**Reuse as-is (logic, no visual debt):** `ArthurClient` + all clients, contracts, `use-captures` / `use-knowledge` / `use-graph` / `use-lineage` hooks, `graph-layout.ts`, `lineage-layout.ts` (as a starting point: graph layout needs a stable semantic placement, lineage layout needs lanes + time columns), `relation-style.ts` (labels, meanings, origins, `describeRelation`), `SourceView` span logic, the existing keyboard activation helpers, existing tests' behavioural assertions.

**Redesign:** `layout.tsx` + `App.tsx` (shell, routing), `styles.css` (replace with tokens), `CapturePanel` → global composer, `KnowledgePanel` → Ideas list + inspector, `GraphPanel`/`GraphView` → Connections (new geometry), `LineagePanel`/`LineageGraph` → Evolution (rail + diff), `RuntimePanel` → Settings.

## 9. Implementation implications

- **The stack isn't what the brief assumes.** `apps/arthur/package.json` has only React 19, Tauri v2, Vite, Vitest. **Tailwind v4, shadcn/ui and Lucide are not installed.** Adding them is a real step. The design is token-driven (CSS variables) so it maps cleanly to Tailwind v4 `@theme`. shadcn is useful for Dialog/Popover/Tooltip/Command (Radix a11y); I would not use its default look: override radius and colour tokens. Lucide covers generic icons; kind/relation/mark art stays custom SVG.
- **Routing.** Needs a router (or a minimal state router) for 5 screens + the Capture overlay (⌘N). Currently there is none.
- **Fonts.** Bundle Newsreader + Hanken Grotesk locally (≈160KB woff2 total). The app is offline-first, no CDN.
- **Graph layout.** `graph-layout.ts` is a generic layout. The playground uses hand-placed positions for beauty; the real thing needs deterministic stable placement (e.g. seeded force layout, positions cached per object id) so the map doesn't reshuffle between visits. Clustering labels ("Capture & cognition") would need a real source or be dropped; they're optional here.
- **Lineage layout.** Needs lane assignment (main line vs branches) and column ordering from `createdAt`; the existing DAG layout is the base.
- **Data the UI wants that may need a client call:** idea counts by kind, per-object connection/revision counts for rows (currently each requires fetching relations/lineage per object, so add batched/derived queries or compute in a store).
- **Accessibility.** Shape + geometry + text, never colour alone (existing code already follows this, which is good). Focus ring 2px accent. Contrast of ink-3/ink-4 on ground needs a final audit before implementation; ink-4 is decorative/disabled only.
- **Mobile.** Rail → bottom tab bar (Home, Ideas, +Capture, Connections, Evolution). Inspector → bottom sheet. Margin cluster collapses to a single line under the title. Connections defaults to List with a Map toggle. Evolution rail becomes vertical (same lanes, rotated). Composer is the whole Home.
- **Testing.** Existing vitest panel tests assert behaviour and a11y roles, so most should survive if components keep roles/labels; layout tests are unaffected.

## 10. Known limits of this exploration

- Sample data is hand-authored in the shape of the contracts; positions in the graph are hand-placed.
- Only the desktop layout is composed. Mobile is specified in words, not drawn.
- Contrast was judged by eye, not measured.
- The Daylight theme is checked on Ideas only.
