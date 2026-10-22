export const chapters = [
    { id: 'native', name: 'Native Core', eyebrow: '01 / NEXUS NATIVE CORE', headline: 'Native performance. Engineered for control.', status: 'Source-reviewed native components', description: 'A native boundary between interfaces, execution authority and durable state. Explore the Rust components underneath the desktop surface.', seek: .19, note: 'Source review confirms Rust kernel, IPC, broker and SQLite modules. Enabled execution remains scope-dependent; this is not a live runtime.' },
    { id: 'nova', name: 'Nova', eyebrow: '02 / NEXUS NOVA', headline: 'One objective. Coordinated intelligence.', status: 'Planned architecture · illustrative task', description: 'Build and test an offline-first task manager. Follow a conceptual objective through planning, work boundaries, selection and an independent review handoff.', seek: .38, note: 'The inspected Nova manifest is planned, non-selectable and non-runnable. This graph explains the intended orchestration, not a completed implementation.' },
    { id: 'compaction', name: 'Compaction v2', eyebrow: '03 / CONTENT COMPACTION V2', headline: 'Keep the context that matters.', status: 'Existing primitives · durable mutation disabled', description: 'A growing execution history becomes structured context: grounded decisions, checkpoint boundaries, evidence references and the work still open.', seek: .60, note: 'Safe-point, checkpoint and provenance/seal primitives exist. The inspected durable mutation policy is disabled. This comparison is illustrative, not a production compaction run.' },
    { id: 'registry', name: 'Model Registry', eyebrow: '04 / MODEL REGISTRY', headline: 'Your models. Your rules.', status: 'Source-reviewed resolver · fictional sample catalog', description: 'Model identity, provider route and worker responsibility are distinct. Change a sample role to see an explicit, deterministic match.', seek: .90, note: 'The Registry resolver validates role/capability and route compatibility. All models, providers and matching tags shown here are invented examples. Nova remains planned.' },
] as const;
export const chapterAt = (p: number) => p < .25 ? 0 : p < .50 ? 1 : p < .78 ? 2 : 3;
export const nodeLabels = [
    ['Desktop UI', 'CLI interface', 'Typed client / IPC', 'Rust Native Core', 'Broker / provider boundary', 'SQLite journal', 'Registry resolution'],
    ['Original objective', 'Planning', 'Work packages', 'Worker selection', 'Bounded tool work', 'Dependencies', 'Sentry handoff ↗'],
    ['Original objective', 'Relevant decisions', 'Execution state', 'Tool observations', 'Checkpoint boundary', 'Artifact references', 'Unresolved work'],
    ['Sample A', 'Sample B', 'Sample C', 'Provider One', 'Provider Two', 'Nexus Nova', 'Worker selection'],
] as const;
export const nodeDetails = [
    [
        'The desktop source uses React and typed Tauri commands, then a client/daemon boundary. The renderer does not own model routing or direct SQLite access.',
        'A Rust CLI crate exists beside the desktop interface. The diagram abstracts client entry points; it is not a trace of an actual CLI request.',
        'The desktop README documents typed commands → nexus-client → daemon IPC → kernel. Explicit contracts separate the interface from runtime state.',
        'The Rust kernel contains acceptance, approvals, integrity, readiness and tool authorization modules. Source existence does not mean every execution scope is enabled.',
        'The broker is a narrow front door for local user intents. Its documented chain uses Registry issuance and daemon authorization; it does not give the renderer provider credentials.',
        'The native store uses transactional SQLite and journal/witness modules. This is authoritative runtime state, distinct from the model’s conversation text.',
        'Registry resolution validates model, provider, route, connection and role compatibility. The website does not perform real routing or carry application authority.'
    ],
    [
        'Illustrative objective: build and test an offline-first task manager. There is no model request, code generation or completed run behind this scene.',
        'The planned Nova manifest declares a Planner slot. This work breakdown is an explanatory example, not generated planning output.',
        'Conceptual work units: local storage, task interactions and review scope. Dependencies constrain their relationship; no worker has actually run.',
        'Registry configuration informs the intended model/worker assignment. A model is not silently chosen by the website; the final chapter exposes a deterministic sample match.',
        'Tool work belongs behind execution and permission boundaries. This concept neither runs tools nor implies arbitrary unrestricted access.',
        'Context and dependency edges make the required order explicit. The moving line indicates illustrative task context, not operational status.',
        'Sentry is a separate verification application. The handoff crosses an integration boundary; Sentry is not a module inside the Rust core.'
    ],
    [
        'Objective: an offline-first task manager. In the example this remains attached to the same task context before and after reorganization.',
        'Example decision: task data remains local. Structured context must distinguish decisions from observations and unresolved questions.',
        'Example intermediate state: storage scope defined; interaction work remains open. It is not a claim that code exists or tests passed.',
        'Example observation: unavailable storage needs an explicit response. Observations are evidence inputs, not instructions with elevated authority.',
        'SafePointDetector checks operational boundaries, including open tool/stream edges. Checkpoint primitives and provenance/seal mechanisms exist. Durable mutation is disabled in the inspected policy. The content seal provides integrity binding, not keyed authentication or guaranteed safety.',
        'Illustrative reference: storage design note. Artifact references preserve a way back to evidence; they are not fabricated repository files.',
        'Open question: define title validation and future synchronization policy. Compaction is not permission to turn unfinished work into completion.'
    ],
    [
        'Fictional Sample A: planning tag, Provider One, example context policy “objective + constraints”. No real model capability or context limit is claimed.',
        'Fictional Sample B: coding and tool-use tags, Provider One, example context policy “requirements + working tail”. No inference or provider probe occurs.',
        'Fictional Sample C: review and read-only tags, Provider Two, example context policy “scope + evidence”. This is not a real provider or supported-model announcement.',
        'Fictional Provider One offers Sample A and Sample B. Model identity and route identity are intentionally distinct; no URL or credentials exist here.',
        'Fictional Provider Two offers Sample C. The example demonstrates a relationship, not a live connection, account or platform capability.',
        'Registry → Nova → worker selection is the intended connection. Nova is planned/non-runnable in the inspected source, even though the Registry resolver exists.',
        'Role matching here is transparent: planner → Sample A; coder → Sample B; reviewer → Sample C. It uses only the explicitly labeled sample tags, with no scores, prices or hidden fallback.'
    ],
] as const;
export const facts = [
    { name: 'Original objective', short: 'Offline-first tasks', text: 'Offline-first task manager', group: 'Task identity' },
    { name: 'Relevant decisions', short: 'Keep data local', text: 'Task data stays local', group: 'Grounded checkpoint' },
    { name: 'Execution state', short: 'Interactions still open', text: 'Storage scope defined; interactions open', group: 'Working tail' },
    { name: 'Tool observations', short: 'Storage may be unavailable', text: 'Handle unavailable storage explicitly', group: 'Working tail' },
    { name: 'Checkpoint boundary', short: 'Inspect open edges', text: 'Inspect open execution edges first', group: 'Grounded checkpoint' },
    { name: 'Artifact references', short: 'Storage design note', text: 'Storage design note · illustrative reference', group: 'Evidence links' },
    { name: 'Unresolved work', short: 'Validation still open', text: 'Title validation; future sync policy', group: 'Open work' },
];
export type Role = 'planner' | 'coder' | 'reviewer';
export const sampleModels = [
    { id: 0, name: 'Sample A', provider: 'Provider One', roles: ['planner'], tags: 'planning', context: 'Objective + constraints' },
    { id: 1, name: 'Sample B', provider: 'Provider One', roles: ['coder'], tags: 'coding · tool use', context: 'Requirements + working tail' },
    { id: 2, name: 'Sample C', provider: 'Provider Two', roles: ['reviewer'], tags: 'review · read only', context: 'Scope + evidence' },
] as const;
export function sampleMatch(role: Role) { return sampleModels.find(m => (m.roles as readonly string[]).includes(role))!; }
