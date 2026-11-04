# Thoughtspace: implementation notes

The approved prototypes are `screens.html` + `thoughtspace.css` in this folder. This file records what has been ported
into `apps/arthur`, and every place the app differs from the prototypes.

## Ported
- **Tokens and fonts** (`app/styles/tokens.css`): Thoughtspace palette, Onest + JetBrains Mono (Latin + Cyrillic, bundled),
  light values under `:root[data-theme="light"]`. Token *names* were kept, so every existing screen picks up the new
  look. `--serif` is kept as the name of the "thought text" role and now resolves to the sans. All `italic` was removed
  (Onest has no italic; a synthesized oblique looks wrong).
- **Content-type colour:** `--kind-idea|task|decision|question|note`. Applied to the kind glyph and the type pill on
  Home. This intentionally relaxes the Marginalia rule "never per-kind colour"; shape still carries the kind.
- **Shell:** accent Capture button, new mark, mono counts and key hints.
- **Home:** headline "Your thoughts, expanded.", a real-counts summary line, kind pill on every thought, mono times.
- **Composer:** "Capture a thought…", sans, smaller type.
- **Copy:** the time-of-day greeting and "What's on your mind?" are gone (desktop and mobile).

### Step 4-7 (second pass)
- **Thought detail** (the Ideas inspector): sans title, kind pill, uppercase section labels, mono counts and times, spine
  of revisions as dots. Structure and actions are unchanged.
- **Connections**: nodes are stroked in their kind colour (shape + colour), edge labels and relation legend in the new
  type; inspector uses the same detail style.
- **Capture** (composer and dialog): recording shows a red REC dot with an elapsed timer. There is **no waveform**: the
  app has no audio-level signal, and a drawn waveform without one would be decoration.
- **Appearance** (Settings, desktop and mobile): Dark / Light / System, per-device (`localStorage`), default Dark,
  applied at startup in `main.tsx`. See `app/theme.ts`.
- **Mobile**: tokens, fonts, headline, accent primary actions and the accent centre Capture tab. Layouts are unchanged.

## Differences from the prototypes
| Prototype | App | Why |
|---|---|---|
| Top bar with global search | not built | There is no global search; Ideas has its own, Ask has Mod+K. No fake controls. |
| Capture button in the top bar | stays in the rail | Same reason; the rail already owns Capture and the recording pill. |
| Nav "Thoughts" | "Home" + "Ideas" kept | The app has both a capture-and-stream Home and an Ideas list; merging them is an IA decision, not a restyle. |
| Type pills Idea/Voice/Note/Task/Insight | the real kinds: idea, task, decision, question, note | Voice is a capture *source*, not a kind; Insight is not a kind. Source is shown on the capture row. |
| Tags (#mobile) | not built | `KnowledgeObject` has no tags. |
| "Linked entities" (people, topics, places) | not built | Only ideas and Projects exist as entities. |
| EMG / wristband surfaces | not built | The hardware does not exist yet (owner decision). |
| Left filter panel on Connections (relations, show, made by) | the existing legend (relation toggles) and origin tabs | They already filter by relation and origin; kind/entity filters have nothing to filter yet. |
| Waveform while recording | REC dot + timer | No audio-level signal exists (see above). |

### Third pass: Evolution, Review, Ask, mobile type
- **Evolution**: sans headings, mono revision tags, times and counts; the revision graph keeps its structure and
  accent-on-current.
- **Review**, **Ask**: headings, question input, answer text and evidence in the Thoughtspace type scale. `--serif` is
  still used as the role name for answer text (it resolves to the sans), which `recall-css.test.ts` asserts.
- **Mobile**: every `--serif` heading and row title was moved to the sans scale (600 for titles, 550 for row titles).
  Compositions are unchanged.

### Fourth pass: mobile layout
- **Capture surface**: the notebook card and ruled lines are gone. One bar ("Capture a thought…") opens typing, Speak
  and the keyboard button sit beneath it. The permission, retry and failure behaviour from `mobile/DECISIONS.md` is
  unchanged: Speak is still the only thing that asks for the microphone.
- **Stream**: each thought carries its kind pill and a mono time; day labels and capture meta follow the desktop scale.
- **Tab bar**: Capture is a lifted accent tab; the current tab's icon takes the accent.
- Typing mode now uses a bordered field instead of ruled lines.

## Not yet ported
Review has only been inspected in its empty state (the preview client has no proposals). Mobile Ask, Evolution and
Connections keep their existing compositions with the new tokens and type; the idea page, stream and capture surface are
the screens that were recomposed.
