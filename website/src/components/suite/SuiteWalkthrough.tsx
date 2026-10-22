'use client';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { products } from '@/lib/products';
import { chapterFor, chapterPositions, chapters, frameFor, frames } from './story';
import { DocumentCard } from './DocumentCard';
import { ProductMark } from './ProductMark';
import { StoryControls } from './StoryControls';
import { createStoryTimeline } from './createStoryTimeline';
import styles from './suite.module.css';

export function SuiteWalkthrough() {
  const root = useRef<HTMLElement>(null);
  const controller = useRef<ScrollTrigger | null>(null);
  const timeline = useRef<gsap.core.Timeline | null>(null);
  const position = useRef(0);
  const restorePosition = useRef(false);
  const [preferences, setPreferences] = useState({ ready: false, reduced: false, short: false, mobile: false });
  const [motion, setMotion] = useState(true);
  const [chapter, setChapter] = useState(0);
  const [frame, setFrame] = useState(0);
  const [percent, setPercent] = useState(0);
  const [step, setStep] = useState(0);
  const [ready, setReady] = useState(false);
  const staticMode = preferences.reduced || !motion;
  const current = frames[frame];
  const scene = chapters[chapter];

  function synchronize(progress: number) {
    position.current = progress;
    if (root.current) {
      root.current.dataset.timelineProgress = String(Math.round((timeline.current?.progress() ?? progress) * 1000) / 1000);
      root.current.dataset.scrollProgress = String(Math.round(progress * 1000) / 1000);
    }
    const chapterIndex = chapterFor(progress);
    setChapter(chapterIndex);
    const start = [0, .24, .48, .72][chapterIndex];
    const length = chapterIndex === 3 ? .28 : .24;
    setStep(Math.min(2, Math.max(0, Math.floor((progress - start) / length * 3))));
    setFrame(frameFor(progress));
    setPercent(Math.round(progress * 100));
  }

  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const short = matchMedia('(max-height: 739px)');
    const mobile = matchMedia('(max-width: 760px)');
    const read = () => setPreferences({ ready: true, reduced: reduced.matches, short: short.matches, mobile: mobile.matches });
    read();
    for (const query of [reduced, short, mobile]) query.addEventListener('change', read);
    return () => { for (const query of [reduced, short, mobile]) query.removeEventListener('change', read); };
  }, []);

  useEffect(() => {
    if (!preferences.ready || !root.current) return;
    gsap.registerPlugin(ScrollTrigger);
    if (staticMode) { setReady(true); return; }
    setReady(false);
    let restoreFrame = 0;
    const context = gsap.context(() => {
      const tl = createStoryTimeline(root.current!, preferences.mobile);
      timeline.current = tl;
      tl.progress(position.current);
      const savedProgress = position.current;
      let restoring = restorePosition.current;
      const trigger = ScrollTrigger.create({
        trigger: root.current, start: 'top top', end: 'bottom bottom', animation: tl, scrub: true,
        onUpdate: self => { if (!restoring) synchronize(self.progress); },
        onRefresh: self => { if (!restoring) synchronize(self.progress); },
      });
      controller.current = trigger;
      if (restoring) {
        // Restore after the static-to-sticky layout has settled. Ignore the new
        // trigger's initial zero-progress refresh until the saved position is applied.
        restoreFrame = requestAnimationFrame(() => {
          trigger.refresh();
          const top = trigger.start + savedProgress * (trigger.end - trigger.start);
          window.scrollTo({ top, behavior: 'instant' });
          trigger.scroll(top); // Update GSAP's scroll cache at the already-set position.
          restoring = false;
          restorePosition.current = false;
          ScrollTrigger.update();
          synchronize(trigger.progress);
          setReady(true);
        });
      } else setReady(true);
    }, root);
    return () => { cancelAnimationFrame(restoreFrame); controller.current = null; timeline.current = null; context.revert(); };
  }, [preferences, staticMode]);

  function seek(progress: number) {
    const trigger = controller.current;
    if (trigger) {
      window.scrollTo({ top: trigger.start + progress * (trigger.end - trigger.start), behavior: 'instant' });
      ScrollTrigger.update();
    } else synchronize(progress);
  }
  function selectChapter(index: number) { seek(chapterPositions[Math.max(0, Math.min(3, index))]); }
  function toggleMotion() {
    // Keep the current chapter anchored in view as the long scroll reserve collapses.
    if (root.current) {
      const top = root.current.getBoundingClientRect().top + window.scrollY;
      controller.current?.kill();
      controller.current = null;
      restorePosition.current = !motion;
      setMotion(value => !value);
      window.scrollTo({ top, behavior: 'instant' });
    }
  }

  return <>
    <section ref={root} id="follow-the-idea" className={styles.walkthrough} data-static={staticMode} data-chapter={chapter} data-workspace={current.product} data-frame={frame} data-ready={ready} aria-labelledby="walkthrough-title">
      <div className={styles.storyPin} data-story-pin>
        <div className={styles.storyMasthead}><span className={styles.eyebrow}>01 / FOLLOW THE IDEA</span><span className={styles.demoBadge}><i/> CONCEPTUAL DEMONSTRATION · NO LIVE EXECUTION</span></div>
        <StoryControls chapter={chapter} ready={ready} select={selectChapter} motion={!staticMode} reduced={preferences.reduced} toggleMotion={toggleMotion}/>
        <div className={styles.sceneHeading} aria-live="polite" aria-atomic="true"><div><span className={styles.sceneWorkspace}>0{chapter + 1} / {scene.workspace}</span><h2 id="walkthrough-title">{scene.title}</h2></div><p>{scene.body}</p></div>
        <div className={styles.experienceGrid}>
          <div className={styles.interfaceStage} data-product={current.product}>
            <div className={styles.interfaceHeader}><ProductMark product={current.product}/><span>{current.label}</span>{chapter === 3 ? <div className={styles.returnChoices} role="group" aria-label="Explore return handoff"><button type="button" disabled={!ready} aria-pressed={frame === 3} aria-label="Show Nexus consolidation" onClick={() => seek(.77)}>Nexus</button><span aria-hidden="true">→</span><button type="button" disabled={!ready} aria-pressed={frame === 4} aria-label="Show Arthur Studio return" onClick={() => seek(.93)}>Studio</button></div> : <span className={styles.captureTag}>AUTHENTIC PRODUCT CAPTURE</span>}</div>
            <div className={styles.screenViewport}>
              {frames.map((item, index) => {
                const product = products.find(product => product.id === item.product)!;
                return <div key={index} className={styles.screenPanel} data-suite-panel data-active={frame === index} aria-hidden={frame !== index}><Image src={`/images/${item.product}.webp`} alt={product.alt} fill quality={90} sizes="(max-width: 760px) 92vw, (max-width: 1100px) 80vw, 1050px"/></div>;
              })}
              <div className={styles.stageVignette} aria-hidden="true"/>
              <div className={styles.workspaceFocus} data-workspace-focus aria-hidden="true"/>
              <div className={styles.destination} data-destination aria-hidden="true"/>
              <div className={styles.travelDocument} data-travel-document><DocumentCard title={current.artifact} lines={current.contents}/></div>
            </div>
            <div className={styles.screenFoot}><span>Illustrative focus: {current.steps[step]}</span><span>ILLUSTRATIVE OVERLAYS</span></div>
          </div>
          <aside className={styles.storyInspector} aria-label="Illustrative project context" data-product={current.product}>
            <span className={styles.inspectorEyebrow}>ONE PROJECT, IN CONTEXT</span><h3>{current.contextTitle}</h3><p>{current.contextBody}</p>
            <div className={styles.demoSteps}>{current.steps.map((label, index) => <div key={label} data-current={index === step}><span>0{index + 1}</span><p>{label}</p><span aria-hidden="true">↗</span></div>)}</div>
            <div className={styles.inspectorNote}><span>{frame === 3 ? 'THE RETURN ROUTE' : 'DESIGNED CONNECTIONS'}</span><p>{frame === 3 ? 'Sentry returns its report to Nexus. Nexus consolidates the record before Arthur Studio receives it.' : frame === 4 ? 'The combined record keeps findings, outstanding work, and suggested next steps together.' : 'These overlays explain the intended workflow. They are not live tasks, model responses, or operational results.'}</p></div>
          </aside>
        </div>
        <div className={styles.storyBottom}><div className={styles.storyTransport}><button type="button" disabled={!ready || chapter === 0} onClick={() => selectChapter(chapter - 1)} aria-label="Previous chapter">←</button><span>0{chapter + 1} <i>/</i> 04</span><button type="button" disabled={!ready || chapter === 3} onClick={() => selectChapter(chapter + 1)} aria-label="Next chapter">→</button><button type="button" disabled={!ready} onClick={() => selectChapter(0)} className={styles.replay}>↻ Replay</button></div><div className={styles.progressGroup}><div className={styles.progressTrack} role="progressbar" aria-label="Suite story progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ transform: `scaleX(${percent / 100})` }}/></div><span>{String(percent).padStart(2, '0')}%</span></div><span className={styles.storyInstruction}>{staticMode ? 'SELECT A CHAPTER TO EXPLORE' : 'SCROLL TO CONTINUE ↓'}</span></div>
      </div>
    </section>
    <details className={styles.transcript}><summary>Read the complete workflow <span aria-hidden="true">＋</span></summary><ol>{chapters.map(item => <li key={item.name}><strong>{item.workspace}: {item.title}</strong><p>{item.body}</p></li>)}</ol><p>This is a conceptual demonstration of intended connections. The illustrated project, execution package, and verification findings are examples. Nothing on this page executes a model or application workflow.</p></details>
  </>;
}
