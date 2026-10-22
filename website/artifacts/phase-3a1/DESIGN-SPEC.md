# Four independent engineering experiences — implementation specification

## Page composition

Retain the Nexus Hero. Follow it with a brief non-linear responsibilities overview, then four substantial sections: Native Core, Nova, Content Compaction v2 and Model Registry. End with a concise architectural synthesis, links back to the overview and `/nexus`. No pinning, long scroll reserve, scroll-driven selection or automatic section changes.

Every feature begins with a plain-language definition/problem, an explicit implementation-state label, and a concrete example. Visitors can enter any section from the overview. Deeper mechanics and boundaries are progressively disclosed in native details elements. Controls affect only their own demo; reading and scrolling never advance a simulator.

### Native Core / layered runtime architecture

Headline: “Built natively. Engineered for control.” Question: “What actually happens when you submit a task to Nexus?” Desktop: layered architecture map beside a readable responsibility inspector; tablet/phone: map above inspector. UI/CLI sit outside execution authority. Native runtime/kernel and state are distinct from Registry/configuration and provider communication. Existing source establishes these components; connections are simplified relationship edges rather than an actual request trace.

Select or hover a component to highlight it and its incoming/outgoing edges. Keyboard focus selects as well. Inspector shows purpose, responsibility, incoming example, processing and outgoing example. Example: coding task → typed request/authorization boundary → recorded task outcome or a refusal. No fabricated successful execution. Source details explain scoped native paths, local IPC, journal state and Registry-supplied resolution.

### Nova / manual orchestration simulator

Headline: “Complex work. Coordinated intelligence.” Nine explicit manual steps cover objective, requirements, plan, dependencies, model/worker eligibility, bounded tools, result collection, eligible Sentry handoff and feedback. A detailed SVG-backed task graph stays local to the section. Selected work unit and relevant dependency edges highlight as the visitor advances; no autoplay or scroll trigger.

Each step visibly names what entered, the illustrative decision, responsible component, outgoing information and why it matters. Concrete sample: “Build an offline-first task manager.” Provide Previous/Next and directly selectable numbered steps. Sentry has a separate dashed boundary. Nova is prominently labeled planned/non-runnable. Terms such as worker and dependency are explained before details.

### CCv2 / session ledger and preservation comparison

Headline: “Keep what matters. Continue with confidence.” Explain finite model context in familiar terms first. A substantial sample session contains objective, requirements, decisions, observations, intermediate attempts, checkpoint, artifact reference, current execution state, outstanding work, repeated observation and a derived scratch note.

Before shows a chronological ledger. After groups the same identified entries by disposition: kept directly, reorganized into grounded context, referenced for later recovery, and sample history reduced/omitted from the active view. Omitted items remain inspectable in the explanatory ledger. Clearly state that omission requires coverage/durability/eligibility; old text is not automatically disposable. Clicking an item explains its exact treatment. No fake savings percentage. Optional details explain SafePointDetector, freshness/coverage, provenance and unkeyed integrity. Durable writes remain disabled. Local Before/After and category filters never seek page scroll. A small scoped layout transition respects reduced motion.

### Model Registry / configuration explorer

Headline: “Your models. Your rules.” A readable model roster, provider relationship and selected-entry field inspector explain model identity, capabilities, roles, illustrative context policy, availability/configuration and route metadata. Three fictional sample models reuse existing names. One sample route intentionally lacks a configured connection to demonstrate an honest refusal, never fallback.

Separate from browsing entries: a three-step “How planned Nova might use this” demo chooses a role, requests compatible configuration, checks the fictional route/connection and exposes a binding or blocked result. Registry validates and supplies metadata; Nova would own coordination. No actual Registry/API call, provider credentials or real availability claim. Fields have plain-language definitions and optional technical validation details.

## Layout / styling / motion

Keep graphite and purple; each section uses a different editorial composition: cutaway map + inspector; dependency graph + step navigator; chronological document ledger + disposition view; configuration roster + field definitions. Use 44px controls and readable body text. Desktop has generous two-column exploration; tablet/mobile stack content without shrinking graphs into illegible desktop miniatures. SVG connects real diagram anchors; DOM buttons carry native semantics. Use restrained CSS/SVG transitions and an optional GSAP FLIP-like context reorganization, scoped to CCv2 only. No additional animation dependencies.

## Architecture review

1. Source of truth: typed feature content and deterministic demo records. Each local React section owns its selection/step, never scroll position.
2. Ownership: four independent client components; overview/section introductions are server content. No shared writable demo state.
3. Direction: route → feature components → stable content/pure selection functions. No application imports, backend or cycles.
4. Boundaries: typed native IDs, simulator steps, session record dispositions and fictional Registry entries. No live runtime objects or credentials.
5. Failures: no remote dependencies; absent JS leaves introductions, default demonstrations and technical explanations readable. Fictional unconfigured route is explicitly blocked.
6. Lifecycle: local event state and scoped layout-animation cleanup. No global listeners, scroll effects or timers/autoplay. Native controls and details handle disclosure.
7. Tests: pure role eligibility; actual component states/edge highlights; manual progression, independent state preservation, keyboard and responsive bounds. Read scrollY before/after interactions to guard automatic jumps.
8. Compatibility: only the concept route changes; existing Hero/styles/data retained, obsolete film not rendered. Protected source/asset/config hashes and existing browser tests guard Landing/Suite/product pages. Rollback can restore the old route composition.
9. Observability: per-section data-selected/data-step/data-view attributes; console errors and screenshots/recordings. No telemetry.
10. Security: inert sample data only, no execution, network, storage or application configuration writes. Capability map separates implemented/restricted/planned states.

## Verification / educational acceptance

Run baseline suite, production build, TypeScript, all existing unaffected tests plus replacement Nexus tests for the new specification. Capture 390/768/1440/1920 and independent interaction recordings on desktop/mobile. Verify touch targets, layout containment, no pinned reserve, no automatic scroll, native keyboard controls and reduced-motion behavior.

First-time-reader review: Can a visitor describe runtime vs UI; explain a planned orchestration step's input/decision/output; explain finite context and why some history needs grounding/references; distinguish a model from its provider/route; and describe the four supporting responsibilities without inventing a linear pipeline? Automated coverage confirms the explanations exist and interactions work; actual novice comprehension remains a human review gate.
