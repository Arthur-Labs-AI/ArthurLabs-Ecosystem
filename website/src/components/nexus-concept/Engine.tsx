'use client';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { chapters, chapterAt, nodeLabels, nodeDetails, facts, sampleMatch, type Role } from './content';
import { createEngine } from './createEngine';
import { ComparisonControl } from './ContextComparison';
import { RoleControl } from './RegistryExplorer';
import styles from './engine.module.css';
export function Engine() {
    const root = useRef<HTMLElement>(null), trigger = useRef<ScrollTrigger | null>(null), dialog = useRef<HTMLDialogElement>(null), returnFocus = useRef<HTMLButtonElement | null>(null);
    const [chapter, setChapter] = useState(0), [progress, setProgress] = useState(0), [role, setRole] = useState<Role>('coder'), [inspection, setInspection] = useState<{
        chapter: number;
        node: number;
    } | null>(null);
    const match = sampleMatch(role);
    useEffect(() => {
        gsap.registerPlugin(ScrollTrigger);
        const media = gsap.matchMedia();
        media.add({ compact: '(max-width:1000px)', wide: '(min-width:1001px)', short: '(max-height:740px)', reduced: '(prefers-reduced-motion:reduce)' }, ctx => {
            if (!root.current)
                return;
            const el = root.current;
            if (ctx.conditions?.reduced) {
                el.dataset.ready = 'true';
                el.dataset.motion = 'reduced';
                return;
            }
            el.dataset.motion = 'scroll';
            const timeline = createEngine(el, !!ctx.conditions?.compact, !!ctx.conditions?.short);
            const update = (self: ScrollTrigger) => { setChapter(chapterAt(self.progress)); setProgress(self.progress); el.dataset.progress = self.progress.toFixed(4); el.dataset.timeline = timeline.progress().toFixed(4); el.dataset.chapter = String(chapterAt(self.progress)); el.style.setProperty('--engine-progress', String(self.progress)); };
            trigger.current = ScrollTrigger.create({ id: 'nexus-inside-engine', trigger: el, start: 'top top', end: 'bottom bottom', animation: timeline, scrub: true, onUpdate: update, onRefresh: update });
            el.dataset.ready = 'true';
            return () => { trigger.current = null; };
        }, root);
        return () => media.revert();
    }, []);
    function seek(p: number) {
        const t = trigger.current;
        if (t)
            window.scrollTo({ top: t.start + (t.end - t.start) * p, behavior: 'instant' });
    }
    function inspect(node: number, e: React.MouseEvent<HTMLButtonElement>) { returnFocus.current = e.currentTarget; setInspection({ chapter, node }); dialog.current?.showModal(); }
    return <>
 <section ref={root} className={styles.film} id="inside-engine" aria-label="Inside the Engine architectural exploration" data-engine data-ready="false" data-motion="scroll" data-registry-match={match.id}>
  <div className={styles.canvas}>
   <div className={styles.filmTop}><span>NEXUS / INSIDE THE ENGINE</span><a href="#engine-reference">Read without the film ↗</a></div>
   <div className={styles.chapterRail} role="group" aria-label="Engine chapters">{chapters.map((c, i) => <button key={c.id} onClick={() => seek(c.seek)} aria-current={chapter === i ? 'step' : undefined}><span>0{i + 1}</span>{c.name}</button>)}</div>
   <div className={styles.chapterHeading}><span>{chapters[chapter].eyebrow}</span><h2>{chapters[chapter].headline}</h2><small>{chapters[chapter].status}</small></div>
   <div className={styles.scene}>
    <div className={styles.camera} data-engine-camera>
     <svg className={styles.lines} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <path key={i} data-engine-edge data-edge-index={i} d="M50 50C50 50 50 50 50 50"/>)}{Array.from({ length: 7 }, (_, i) => <path key={`trace-${i}`} data-context-trace pathLength="1" strokeDasharray=".08 .92" strokeDashoffset="1" d="M50 50C50 50 50 50 50 50"/>)}</svg>
     <div className={styles.coreBoundary} data-core-boundary aria-hidden="true"><span>NATIVE AUTHORITY / SCOPED EXECUTION</span></div>
     <div className={styles.contextGroups} data-context-groups aria-hidden="true"><span>GROUNDED CONTEXT</span><span>WORKING TAIL / OPEN WORK</span></div>
     {Array.from({ length: 7 }, (_, i) => <button key={i} type="button" className={styles.engineNode} data-engine-node={i} data-sample-selected={chapter === 3 && i === match.id} aria-label={`Inspect ${nodeLabels[chapter][i]}`} onClick={e => inspect(i, e)}><span className={styles.nodeNumber}>0{i + 1} <span aria-hidden="true">↗</span></span><span className={styles.nodeLabels} data-node-slot>{nodeLabels.map((labels, c) => <span key={c} data-node-label={c} aria-hidden={chapter !== c}><strong>{labels[i]}</strong>{c === 2 ? <small>{facts[i].short}</small> : null}{c === 3 && i < 3 ? <small>{i === 0 ? 'Planning' : i === 1 ? 'Coding · tools' : 'Review · read only'}</small> : null}</span>)}</span></button>)}
     <div className={styles.interfacePlane} data-interface-plane aria-hidden="true"><Image src="/images/nexus.webp" width={1920} height={912} alt="" quality={90} sizes="(max-width:1000px) 75vw, 65vw"/><span>INTERFACE SURFACE / NATIVE LAYERS BELOW</span></div>
    </div>
   </div>
   <div className={styles.filmBottom}><div className={styles.sceneNote} aria-live="polite">{chapter === 0 ? 'Explore the boundary. Select a component to inspect its responsibility.' : chapter === 1 ? 'Illustrative context follows dependencies. Sentry is an external verification system.' : chapter === 2 ? 'The same seven example facts reorganize into grounded context and working state.' : 'Registry policy informs planned Nova selection, within native execution boundaries and structured task context.'}</div><div className={styles.chapterInteraction}>{chapter === 2 ? <ComparisonControl value={Math.max(0, Math.min(1, (progress - .62) / .10))} onChange={n => seek(.62 + .10 * n)}/> : chapter === 3 ? <><RoleControl value={role} onChange={setRole}/><span className={styles.routingResult} aria-live="polite">{role} → {match.name} → {match.provider}</span></> : <span className={styles.interactionHint}>{chapter === 0 ? 'SCROLL TO OPEN THE ARCHITECTURE' : 'NOVA IS PLANNED · THIS TASK IS AN ILLUSTRATION'}</span>}</div><span className={styles.filmDisclaimer}>CONCEPT EXPLORATION · NO LIVE EXECUTION <a href="#engine-reference">Skip the motion ↓</a></span></div>
   <div className={styles.progress} role="progressbar" aria-label="Engine exploration progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}/>
  </div>
 </section>
 <dialog ref={dialog} className={styles.inspector} onClose={() => returnFocus.current?.focus({ preventScroll: true })} onClick={e => {
            if (e.target === e.currentTarget)
                dialog.current?.close();
        }} aria-labelledby="engine-inspection-title"><div><span className={styles.eyebrow}>COMPONENT / RESPONSIBILITY</span><button type="button" className={styles.close} onClick={() => dialog.current?.close()} autoFocus>Close ×</button><h3 id="engine-inspection-title">{inspection ? nodeLabels[inspection.chapter][inspection.node] : ''}</h3><p>{inspection ? nodeDetails[inspection.chapter][inspection.node] : ''}</p><small>{inspection ? chapters[inspection.chapter].status : ''}</small></div></dialog>
 </>;
}
