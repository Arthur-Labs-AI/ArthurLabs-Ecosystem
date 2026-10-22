export const chapterPositions = [0, .20, .45, .67, .90];
export const chapters = [
  { label: '00 / PREVIEWS', num: '00 / THE ECOSYSTEM', title: 'Three distinct tools.', body: 'Explore their real interfaces. Scroll to follow the proposed integrated workflow.', control: 'Overview chapter', short: 'All' },
  { label: '01 / CAPTURE', num: '01 / ARTHUR STUDIO', title: 'Capture a thought.', body: 'Capture and connect ideas in Arthur Studio. Your thinking becomes structured context.', control: 'Arthur Studio chapter', short: '01' },
  { label: '02 / ORCHESTRATE', num: '02 / NEXUS', title: 'Turn context into work.', body: 'Nexus orchestrates models, agents, and tools to carry the task forward.', control: 'Nexus chapter', short: '02' },
  { label: '03 / VERIFY', num: '03 / SENTRY', title: 'Check the outcome.', body: 'Sentry adds an independent quality and security review to the workflow.', control: 'Sentry chapter', short: '03' },
  { label: '04 / CONNECT', num: '04 / THE FULL SUITE', title: 'Keep the knowledge.', body: 'Nexus returns the output and verification results to Arthur Studio.', control: 'Connected workflow chapter', short: '↻' },
];
export function sceneFor(progress: number) {
  return progress < .13 ? 0 : progress < .34 ? 1 : progress < .56 ? 2 : progress < .79 ? 3 : 4;
}
export function WorkflowAnimation({ scene, ready, select }: { scene: number; ready: boolean; select: (scene: number) => void }) {
  const chapter = chapters[scene];
  return <>
    <svg className="flow-line" viewBox="0 0 1200 500" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs><path d="M140 295 C400 470 800 470 1060 295" markerEnd="url(#flow-arrow)"/><path d="M1060 250 C800 45 400 45 140 250" markerEnd="url(#flow-arrow)"/></svg>
    <span className="scene-label label-arthur">01 / CAPTURE</span><span className="scene-label label-nexus">02 / EXECUTE</span><span className="scene-label label-sentry">03 / VERIFY</span>
    <div className="workflow-meta"><div className="scene-description" aria-live="polite" aria-atomic="true"><span className="num">{chapter.num}</span><strong>{chapter.title}</strong><p>{chapter.body}</p></div>
    <div className="stage-bottom"><span className="stage-name"><b>{chapter.label}</b></span><div className="scene-dots" role="group" aria-label="Workflow chapters" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 4 : (scene + (event.key === 'ArrowRight' ? 1 : 4)) % 5;
      select(next);
      event.currentTarget.querySelectorAll('button')[next]?.focus();
    }}>{chapters.map((item, index) => <button key={item.num} type="button" disabled={!ready} className="scene-btn" aria-label={item.control} aria-current={scene === index ? 'step' : undefined} onClick={() => select(index)}>{item.short}</button>)}</div></div>
    </div>
  </>;
}
