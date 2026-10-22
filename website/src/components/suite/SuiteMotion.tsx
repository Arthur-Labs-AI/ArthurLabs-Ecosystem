'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import styles from './suite.module.css';

/** Suite-only entrance and supporting-section motion; the story owns its own clock. */
export function SuiteMotion({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      const context = gsap.context(() => {
        const select = gsap.utils.selector(root);
        const hero = gsap.timeline({ onComplete: () => { if(root.current) root.current.dataset.entrance = 'complete'; } });
        hero.from(select('[data-hero-line]'), { autoAlpha: 0, y: 24, duration: .7, stagger: .10, ease: 'power2.out' })
          .from(select('[data-hero-screen]'), { autoAlpha: 0, y: 45, scale: .95, duration: .85, ease: 'power2.out' }, .12)
          .from(select('[data-hero-document]'), { autoAlpha: 0, y: 48, scale: .82, rotation: -3, duration: .8, ease: 'power2.out' }, .35)
          .from(select('[data-hero-controls]'), { autoAlpha: 0, y: 12, duration: .5, stagger: .08 }, .45);
        for (const item of select('[data-suite-entry]')) {
          gsap.from(item, { opacity: .35, y: 25, duration: .7, ease: 'power2.out', scrollTrigger: { trigger: item, start: 'top 94%', toggleActions: 'play none none reverse' } });
        }
        for (const svg of select('[data-architecture-lines]')) {
          const paths = svg.querySelectorAll<SVGPathElement>('[data-connection]');
          const flow = svg.querySelectorAll<SVGCircleElement>('[data-flow]');
          const tl = gsap.timeline({ scrollTrigger: { trigger: svg.parentElement, start: 'top 85%', end: 'bottom 35%', scrub: true } });
          paths.forEach((path: SVGPathElement, index: number) => {
            const length = path.getTotalLength();
            tl.fromTo(path, { strokeDasharray: length, strokeDashoffset: length }, { strokeDashoffset: 0, duration: .45, ease: 'none' }, index * .25);
          });
          flow.forEach((dot: SVGCircleElement, index: number) => {
            const vertical = svg.hasAttribute('data-vertical');
            const from = vertical ? { cy: index ? 214 : 108 } : { cx: index ? 610 : 280 };
            const to = vertical ? { cy: index ? 234 : 128 } : { cx: index ? 720 : 390 };
            tl.fromTo(dot, { ...from, opacity: 0 }, { ...to, opacity: 1, duration: .35, ease: 'none' }, .2 + index * .25)
              .to(dot, { opacity: 0, duration: .15 }, .55 + index * .25);
          });
        }
        for (const item of select('[data-hardware-object]')) gsap.fromTo(item, { y: 10 }, { y: -10, ease: 'none', scrollTrigger: { trigger: item.parentElement, start: 'top bottom', end: 'bottom top', scrub: true } });
      }, root);
      return () => context.revert();
    });
    return () => media.revert();
  }, []);
  return <div ref={root} className={styles.suitePage} data-suite-motion>{children}</div>;
}
