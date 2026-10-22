'use client';
import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { products } from '@/lib/products';
import { ProductWindow } from './ProductWindow';
import { WorkflowAnimation, sceneFor, chapterPositions } from './WorkflowAnimation';

export function InteractiveHero() {
  const root = useRef<HTMLElement>(null);
  const progressFill = useRef<HTMLSpanElement>(null);
  const [scene, setScene] = useState(0);
  const [ready, setReady] = useState(false);
  const scrollTrigger = useRef<ScrollTrigger | null>(null);
  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);
    const media = gsap.matchMedia();
    // The short-phone and reduced-motion layouts are non-sticky, selectable previews.
    media.add('(prefers-reduced-motion: no-preference) and (min-height: 701px), (prefers-reduced-motion: no-preference) and (min-width: 761px)', () => {
      const sync = (trigger: ScrollTrigger) => {
        setScene(sceneFor(trigger.progress));
        gsap.set(progressFill.current, { scaleY: trigger.progress });
      };
      const trigger = ScrollTrigger.create({
        trigger: root.current, start: 'top top', end: 'bottom bottom',
        onUpdate: sync, onRefresh: sync,
      });
      scrollTrigger.current = trigger;
      return () => { scrollTrigger.current = null; trigger.kill(); };
    }, root);
    setReady(true);
    return () => media.revert();
  }, []);

  function selectChapter(next: number) {
    const trigger = scrollTrigger.current;
    if (!trigger) { setScene(next); return; }
    // Seeking within the pinned viewport is instant; the windows retain their smooth
    // CSS transitions. Scroll remains the only chapter authority, without timer locks
    // or a second manual state that could disagree on the next wheel/touch event.
    window.scrollTo({ top: trigger.start + chapterPositions[next] * (trigger.end - trigger.start), behavior: 'instant' });
    ScrollTrigger.update();
  }
  return <section ref={root} className="hero-story" id="home" data-workflow-ready={ready} aria-label="ArthurLabs interactive introduction">
    <div className="hero-sticky" data-scene={scene}>
      <div className="hero-copy"><div className="eyebrow">THOUGHT / EXECUTION / VERIFICATION</div><h1>From idea <span className="accent">to impact.</span></h1><p className="hero-deck">Capture what matters. Orchestrate intelligent work.<br/>Verify the outcome. Three distinct tools, designed to work together.</p><div className="ctas"><a className="btn primary" href="#suite">Explore the Suite <span aria-hidden="true">↗</span></a><a className="btn secondary" href="#products">Meet the Products <span aria-hidden="true">→</span></a></div></div>
      <div className="visual-stage">
        {products.map((product, index) => <ProductWindow key={product.id} product={product} ready={ready} selected={scene === index + 1} onSelect={() => selectChapter(index + 1)}/>)}
        <WorkflowAnimation ready={ready} scene={scene} select={selectChapter}/>
      </div>
      <div className="story-progress" aria-hidden="true"><span ref={progressFill}/></div><span className="scroll-cue">SCROLL TO FOLLOW THE WORKFLOW</span>
    </div>
  </section>;
}
