'use client';
import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { createWorkflow } from './createWorkflow';
import { acts, shots, actAt, shotAt } from './workflow';
import styles from './launch.module.css';
export function LivingWorkflow() {
    const root = useRef<HTMLElement>(null), trigger = useRef<ScrollTrigger | null>(null);
    const [act, setAct] = useState(0), [shot, setShot] = useState(0);
    useEffect(() => {
        gsap.registerPlugin(ScrollTrigger);
        const media = gsap.matchMedia();
        media.add({ mobile: '(max-width:900px)', desktop: '(min-width:901px)', reduced: '(prefers-reduced-motion:reduce)' }, ctx => {
            if (!root.current)
                return;
            const el = root.current;
            if (ctx.conditions?.reduced) {
                el.dataset.motion = 'reduced';
                el.dataset.ready = 'true';
                return;
            }
            el.dataset.motion = 'scroll';
            const tl = createWorkflow(el, !!ctx.conditions?.mobile);
            const update = (self: ScrollTrigger) => { const p = self.progress; setAct(actAt(p)); setShot(shotAt(p)); el.dataset.progress = p.toFixed(4); el.dataset.workspace = shots[shotAt(p)].workspace; el.style.setProperty('--wf-progress', String(p)); };
            trigger.current = ScrollTrigger.create({ trigger: el, start: 'top top', end: 'bottom bottom', animation: tl, scrub: true, onUpdate: update, onRefresh: update });
            el.dataset.ready = 'true';
            return () => { trigger.current = null; };
        }, root);
        return () => media.revert();
    }, []);
    function seek(i: number) { const t = trigger.current; if (t)
        window.scrollTo({ top: t.start + (t.end - t.start) * acts[i].at, behavior: 'instant' }); }
    return <>
 <section className={styles.workflowIntro} id="living-workflow" aria-labelledby="workflow-title"><span className={styles.eyebrow}>02 / THE LIVING WORKFLOW</span><h2 id="workflow-title">The thought is<br /><em>only the beginning.</em></h2><p>Follow one idea through three independent perspectives. A conceptual demonstration of the intended architecture, with illustrative work and findings.</p><div className={styles.workflowLinks}><a href="#workflow-film">Enter the workflow ↓</a><a href="#workflow-story">Read the four acts ↗</a><a href="#downloads">Skip to downloads ↗</a></div></section>
 <section ref={root} className={styles.film} id="workflow-film" data-workflow-film data-ready="false" data-motion="scroll" aria-label="Conceptual four-act workflow">
  <div className={styles.canvas}>
   <div className={styles.filmTop}><span>FROM THOUGHT TO CREATION</span><a href="#downloads">Return to downloads ↗</a></div>
   <div className={styles.actTitle}><span>{acts[act].product.toUpperCase()} / {shots[shot].name.toUpperCase()}</span><h3>{acts[act].title}</h3></div>
   <div className={styles.captureRule} data-capture-rule aria-hidden="true"><span>ARTHUR STUDIO / CAPTURE</span><div /><small>ONE THOUGHT. ROOM TO GROW.</small></div>
   <div className={styles.auditPlane} data-audit-plane aria-hidden="true"><span>INDEPENDENT REVIEW / ILLUSTRATIVE FINDINGS</span><div /><div /><div /></div>
   <div className={styles.camera} data-wf-camera aria-hidden="true">
    <svg className={styles.connections} viewBox="0 0 100 100" preserveAspectRatio="none">{Array.from({ length: 6 }, (_, i) => <path key={i} data-wf-link d="M50 50C50 50 50 50 50 50"/>)}</svg>
    {Array.from({ length: 6 }, (_, i) => <div className={`${styles.infoNode} ${i === 0 ? styles.ideaNode : ''}`} key={i} data-wf-node={i}><span className={styles.nodeIndex}>{i === 0 ? 'THE PROJECT' : `0${i}`}</span><div className={styles.labels} data-wf-label-slot>{shots.map((s, j) => <span key={s.name} data-wf-label={j} className={j === 0 && i === 0 ? styles.firstThought : undefined}><strong {...(i === 0 && j === 0 ? { 'data-wf-title': true } : {})}>{s.labels[i]}</strong>{j === 5 && i > 0 ? <small>ILLUSTRATIVE · NOT A LIVE RESULT</small> : null}</span>)}</div><i /></div>)}
   </div>
   <div className={styles.filmBottom}><p aria-live="polite" aria-atomic="true">{acts[act].text}</p><div className={styles.actControls} role="group" aria-label="Workflow acts">{acts.map((a, i) => <button key={a.name} onClick={() => seek(i)} aria-current={act === i ? 'step' : undefined}><span>0{i + 1}</span>{a.name}</button>)}</div><span className={styles.conceptNote}>CONCEPTUAL WORKFLOW · NO LIVE EXECUTION</span></div>
   <div className={styles.filmProgress} aria-hidden="true"/>
  </div>
 </section>
 <section className={styles.story} id="workflow-story" tabIndex={-1} aria-label="The four acts"><div className={styles.storyGrid}>{acts.map((a, i) => <article key={a.name}><span className={styles.eyebrow}>0{i + 1} / {a.product}</span><h3>{a.name}.</h3><p>{a.text}</p></article>)}</div><p className={styles.topology}>Arthur Studio <span>→</span> Nexus <span>→</span> Sentry <span>→</span> Nexus <span>→</span> Arthur Studio</p><p className={styles.fine}>Sentry findings return through Nexus. The final record includes observations, decisions and outstanding work—not a fabricated success state.</p></section>
 </>;
}
