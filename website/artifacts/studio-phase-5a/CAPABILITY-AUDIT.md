# Arthur Studio capability audit — 2026-10-28

Read-only inspection of `/home/kaloyan/Projects/A.R.T.H.U.R`. No application build, native execution, provider call or application test was performed. “Implemented” means present in inspected source, not newly validated runtime functionality. Older READMEs are superseded by newer source where they disagree.

| Capability | Classification | Evidence relative to application root | Website treatment |
| --- | --- | --- | --- |
| Typed capture, native local SQLite persistence; automatic organization after capture commits | Implemented | `apps/arthur/src/client/arthur-client.ts` createCapture/distillCapture/listOrganizationStates; `features/home/HomeScreen.tsx`; app README Local capture storage/Auto-organize | Thought note; preserve original words, provider work separately described |
| Structured ideas, provenance, searchable list, inspector | Implemented | `features/ideas/IdeasScreen.tsx`, `client/arthur-client.ts` getCaptures/listKnowledgeObjects | Observations card; sample content, not generated output |
| Typed user relations and model-assisted inference | Implemented; inference requires provider setup | `client/arthur-client.ts` createRelation/listRelations; `features/graph/ConnectionsScreen.tsx` | Related observations, no invented automatic graph/pipeline |
| Project organization, Inbox, scoped knowledge | Implemented | ArthurClient project methods; `features/projects/projects-context.tsx` | Honest editorial explanation; no invented executable project plan |
| Edit, branch, merge, compare and restore revisions | Implemented | `features/lineage/EvolutionScreen.tsx` useLineage/restore; ArthurClient lineage contracts | Two sample wordings, explicitly browser-only illustration |
| Ask Arthur UI and native grounded recall | Implemented with provider/data prerequisites | `features/recall/AskScreen.tsx`; `client/desktop-client.ts` askOverIpc; `docs/architecture/cognitive-recall/m04c-implementation-notes.md` | Question card explains scoped recall. No fake live chat, web research or fabricated citations |
| AI Thought Evolution | Experimental/restricted: off by default, review-first, explicit approval; real-provider quality/privacy acceptance outstanding | `docs/architecture/m047b-phase5-review-first-activation.md` release status; `features/review/ReviewScreen.tsx` | Restriction stated, never automatic autonomous changes |
| Voice | Restricted by client capability; Android implementation, desktop unavailable in inspected app README | ArthurClient capabilities; app README Voice capture | Not promoted as desktop feature |
| Nexus/Sentry execution or live handoff | Planned/unverified | Cognitive Recall design explicitly excludes tool/Nexus/Sentry invocation; no invocation contract in inspected client | Ecosystem intent only, explicit unavailable integration |
| Gesture input/sketch editor, tactile Infinite Desk | Illustrative website concept | Not claimed by inspected application contract | Hand drawing is a conceptual reference; no sensor/gesture-recognition product claim |
| Sample gesture idea, observations, edited wording | Illustrative website concept | Authored website sample, not real user records | Labels on desk and inspector; local demo edits never leave page or persist |
| Authentic interface | Actual user-supplied Studio capture | `public/images/studio.webp` 1616×998, extracted from approved Landing prototype | Native aspect ratio, max display width ≤1616px, no invented screenshots |
| Desktop distribution | UNVERIFIED / no eligible Studio artifacts in website catalog | `src/components/suite-launch/releases.ts`; official Git remote from app config; GitHub unauthenticated releases API returned 404 on 2026-10-28 | Development/unavailable, no OS claims or enabled links |

Release check: `https://api.github.com/repos/Kaloyan3D/A.R.T.H.U.R/releases` returned 404. This may mean private or inaccessible; it does **not** establish that no internal release exists. Source/build targets are not installer availability. No public source/docs link is presented without public verification. No release metadata added to the shared catalog.

Existing desktop app README describes Linux/Windows build intent and later platforms; that is not distribution verification. Historical recall design says “design only”, but current AskScreen/desktop IPC and later implementation notes establish implemented code. Current evolution release notes explicitly qualify review-first controlled use; no blanket production-ready claim.
