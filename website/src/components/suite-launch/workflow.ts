export const acts = [
    { name: 'Imagine', product: 'Arthur Studio', title: 'Give a thought room to grow.', text: 'Capture an intention. Connect its constraints. Shape a starting point for the work.', at: 0 },
    { name: 'Orchestrate', product: 'Nexus', title: 'Make the context actionable.', text: 'Nexus brings requirements into a dependency graph and prepares a bounded review package.', at: .34 },
    { name: 'Question', product: 'Sentry', title: 'A different perspective.', text: 'Independent review connects requirements to explicit questions and illustrative findings.', at: .67 },
    { name: 'Evolve', product: 'Nexus → Arthur Studio', title: 'Return with more context.', text: 'Findings return through Nexus. Decisions and outstanding work become knowledge in Studio.', at: .80 },
];
export const shots = [
    { at: 0, workspace: 'studio', name: 'Capture', labels: ['An offline-first task manager.', 'Keep tasks on this device.', 'Create. Complete. Organize.', 'No account. No connection.', 'Make the work reviewable.', 'Give the idea structure.'] },
    { at: .13, workspace: 'studio', name: 'Connect', labels: ['An offline-first task manager.', 'Local persistence', 'Task lifecycle', 'Privacy boundary', 'Review requirements', 'Connected context'] },
    { at: .25, workspace: 'studio', name: 'Structure', labels: ['Project intention', 'Storage requirements', 'Interaction requirements', 'Offline constraint', 'Review scope', 'Structured project plan'] },
    { at: .37, workspace: 'nexus', name: 'Coordinate', labels: ['Project context', 'Storage work scope', 'Interaction work scope', 'Data boundary', 'Review input', 'Orchestration'] },
    { at: .48, workspace: 'nexus', name: 'Prepare review', labels: ['Project context', 'Implementation scope', 'Requirements & constraints', 'Open questions', 'Independent review package', 'Nexus coordination'] },
    { at: .61, workspace: 'sentry', name: 'Independent review', labels: ['Review scope', 'Example: reject empty titles', 'Question: storage unavailable?', 'Future decision: sync conflicts', 'Requirement coverage', 'Independent perspective'] },
    { at: .75, workspace: 'nexus', name: 'Findings return to Nexus', labels: ['Project context', 'Execution scope', 'Illustrative findings', 'Open decisions', 'Outstanding work', 'Nexus receives findings'] },
    { at: .84, workspace: 'nexus', name: 'Consolidate', labels: ['Project context', 'Execution summary', 'Review observations', 'Define title validation', 'Sync remains a future decision', 'Consolidated outcome'] },
    { at: .96, workspace: 'studio', name: 'Knowledge returns', labels: ['An offline-first task manager.', 'Execution context', 'Linked review findings', 'Title validation decision', 'Remaining work', 'Richer project knowledge'] },
] as const;
export const actAt = (p: number) => p < .29 ? 0 : p < .52 ? 1 : p < .73 ? 2 : 3;
export const shotAt = (p: number) => { let s = 0; shots.forEach((v, i) => { if (p >= v.at)
    s = i; }); return s; };
