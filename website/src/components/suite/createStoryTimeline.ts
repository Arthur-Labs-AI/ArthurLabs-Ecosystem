import { gsap } from 'gsap';

/** Normalized deterministic timeline. ScrollTrigger is the only playback clock. */
export function createStoryTimeline(root: HTMLElement, mobile: boolean) {
  const panels = gsap.utils.toArray<HTMLElement>('[data-suite-panel]', root);
  const card = root.querySelector<HTMLElement>('[data-travel-document]')!;
  const viewport = card.parentElement!;
  const focus = root.querySelector('[data-workspace-focus]');
  const destination = root.querySelector('[data-destination]');
  const span = Math.max(0, viewport.clientWidth - card.offsetWidth - (mobile ? 40 : 80));
  const docks = [0, -span * .72, 0, -span * .50, 0];
  const lift = mobile ? 38 : Math.min(110, viewport.clientHeight * .25);
  // Regions refer to the genuine captures: capture prompt, task brief, QA,
  // consolidation context, then Studio's project knowledge. These are overlays.
  const regions = [
    { left: '21%', top: '13%', width: '69%', height: '30%' },
    { left: '22%', top: '15%', width: '65%', height: '29%' },
    { left: '20%', top: '42%', width: '45%', height: '48%' },
    { left: '22%', top: '15%', width: '65%', height: '29%' },
    { left: '21%', top: '41%', width: '50%', height: '48%' },
  ];
  const tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
  gsap.set(panels, { autoAlpha: 0, scale: 1, xPercent: 0, y: 0, rotationY: 0 });
  gsap.set(panels[0], { autoAlpha: 1 });
  gsap.set(card, { autoAlpha: 0, x: 0, y: mobile ? 18 : 42, scale: .72, rotation: 0 });
  gsap.set([focus, destination], { autoAlpha: 0 });
  gsap.set(focus, regions[0]);
  tl.to({}, { duration: 1 });
  tl.to(focus, { autoAlpha: .75, duration: .035 }, .015)
    .to(panels[0], { scale: mobile ? 1.025 : 1.055, duration: .12 }, .015)
    .to(card, { autoAlpha: 1, y: 0, scale: 1, duration: .09, ease: 'power2.out' }, .035);
  const handoffs = [.18, .42, .66, .80];
  handoffs.forEach((at, index) => {
    // Alternate destination docks; the physical card never unmounts or teleports.
    const from = docks[index], to = docks[index + 1];
    tl.to(focus, { autoAlpha: 0, duration: .025 }, at)
      .to(card, { x: (from + to) / 2, y: -lift, scale: mobile ? 1.02 : 1.10, rotation: index % 2 ? 2 : -2, duration: .055, ease: 'power1.inOut' }, at)
      .to(panels[index], { autoAlpha: 0, scale: mobile ? .96 : .88, xPercent: -3, y: -12, rotationY: mobile ? 0 : -4, duration: .10 }, at + .005)
      .fromTo(panels[index + 1], { autoAlpha: 0, scale: mobile ? 1.04 : 1.12, xPercent: 6, y: 18, rotationY: mobile ? 0 : 4 }, { autoAlpha: 1, scale: 1, xPercent: 0, y: 0, rotationY: 0, duration: .10 }, at + .025)
      .set(destination, { x: to }, at + .04)
      .to(destination, { autoAlpha: .9, duration: .035 }, at + .04)
      .to(card, { x: to, y: 0, scale: 1, rotation: 0, duration: .07, ease: 'power1.inOut' }, at + .055)
      .to(destination, { autoAlpha: 0, duration: .045 }, at + .08)
      .set(focus, regions[index + 1], at + .12)
      .to(focus, { autoAlpha: .65, duration: .025 }, at + .125);
    const next = handoffs[index + 1] ?? 1;
    if (next > at + .145) tl.to(panels[index + 1], { scale: mobile ? 1.025 : 1.045, duration: next - at - .145 }, at + .145);
  });
  return tl;
}
