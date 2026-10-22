import { gsap } from 'gsap';
import { shots } from './workflow';
type Point = readonly [
    number,
    number
];
const pairs = [[0, 5], [5, 1], [5, 2], [1, 3], [2, 4], [1, 2]];
const curve = (a: Point, b: Point) => `M${a[0]} ${a[1]} C${a[0] + (b[0] - a[0]) * .48} ${a[1]},${b[0] - (b[0] - a[0]) * .48} ${b[1]},${b[0]} ${b[1]}`;
/** One continuous coordinate space, persistent information nodes, reversible native-scroll clock. */
export function createWorkflow(root: HTMLElement, mobile: boolean) {
    const q = gsap.utils.selector(root), nodes = q('[data-wf-node]'), paths = q('[data-wf-link]');
    const anchor: Point = mobile ? [50, 49] : [52, 53];
    const knowledge: Point[] = mobile ? [[50, 51], [23, 35], [77, 35], [23, 65], [77, 65], [50, 78]] : [[46, 48], [24, 35], [74, 34], [20, 68], [79, 68], [50, 78]];
    const plan: Point[] = mobile ? [[23, 39], [76, 48], [76, 63], [76, 34], [76, 78], [23, 64]] : [[24, 51], [65, 28], [65, 43], [65, 58], [65, 73], [41, 77]];
    const nexus: Point[] = mobile ? [[22, 39], [77, 48], [77, 63], [77, 34], [77, 78], [27, 61]] : [[16, 53], [62, 35], [62, 70], [85, 35], [85, 70], [38, 53]];
    const review: Point[] = mobile ? [[22, 39], [76, 48], [76, 63], [76, 34], [76, 78], [25, 61]] : [[17, 37], [73, 43], [73, 60], [73, 27], [73, 77], [32, 53]];
    const consolidate: Point[] = mobile ? [[23, 39], [76, 48], [76, 63], [76, 34], [76, 78], [26, 61]] : [[17, 49], [70, 43], [70, 60], [70, 27], [70, 77], [39, 49]];
    const poses = [Array(6).fill(anchor), knowledge, plan, nexus, nexus, review, consolidate, consolidate, knowledge] as Point[][];
    const tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
    gsap.set(nodes, { left: `${anchor[0]}%`, top: `${anchor[1]}%`, autoAlpha: 0, scale: .65 });
    gsap.set(nodes[0], { autoAlpha: 1, scale: 1, width: mobile ? 300 : 540 });
    gsap.set(q('[data-wf-label]'), { autoAlpha: 0 });
    gsap.set(q('[data-wf-label="0"]'), { autoAlpha: 1 });
    gsap.set(paths, { autoAlpha: 0, attr: { d: curve(anchor, anchor) } });
    gsap.set(q('[data-wf-camera]'), { scale: mobile ? 1 : 1.16, xPercent: mobile ? 0 : -3, rotation: .35 });
    gsap.set(nodes[0].querySelector('[data-wf-label-slot]'), { minHeight: mobile ? 90 : 130 });
    gsap.set(q('[data-wf-title]'), { clipPath: 'inset(0 100% 0 0)' });
    gsap.set(q('[data-audit-plane]'), { autoAlpha: 0, xPercent: 12 });
    tl.to({}, { duration: 1 }, 0).to(q('[data-wf-title]'), { clipPath: 'inset(0 0% 0 0)', duration: .07 }, .005);
    shots.forEach((shot, s) => {
        if (!s)
            return;
        const start = shot.at - .06, duration = s === 1 ? .10 : .085;
        nodes.forEach((node, i) => {
            tl.to(node, { left: `${poses[s][i][0]}%`, top: `${poses[s][i][1]}%`, scale: 1, autoAlpha: 1, duration }, start + i * .003);
            if (s === 1 && i === 0) tl.to(node.querySelector('[data-wf-label-slot]'), { minHeight: mobile ? 44 : 50, duration: .045 }, start + .055);
            // Preserve the large thought's measure until its typographic handoff is complete.
            tl.to(node, { width: mobile ? 126 : (i === 0 ? 230 : 190), duration: s === 1 && i === 0 ? .045 : duration }, start + (s === 1 && i === 0 ? .055 : i * .003));
        });
        pairs.forEach(([a, b], i) => tl.to(paths[i], { autoAlpha: s === 1 ? .55 : .8, attr: { d: curve(poses[s][a], poses[s][b]) }, duration }, start + i * .003));
        tl.to(q(`[data-wf-label="${s - 1}"]`), { autoAlpha: 0, duration: .035 }, start + .015)
            .to(q(`[data-wf-label="${s}"]`), { autoAlpha: 1, duration: .04 }, start + .05);
    });
    tl.to(q('[data-wf-camera]'), { scale: 1, xPercent: 0, rotation: 0, duration: .20 }, .07)
        .to(q('[data-wf-camera]'), { scale: mobile ? 1 : 1.035, xPercent: mobile ? 0 : -1, yPercent: 0, duration: .16 }, .27)
        .to(root, { '--wf-accent': '#b79ae8', '--wf-light': 'rgba(150,100,220,.045)', duration: .15 }, .28)
        .to(q('[data-capture-rule]'), { autoAlpha: 0, duration: .10 }, .09)
        .to(q('[data-audit-plane]'), { autoAlpha: 1, xPercent: 0, duration: .12 }, .50)
        .to(root, { '--wf-accent': '#acd39d', '--wf-light': 'rgba(100,160,100,.04)', duration: .12 }, .51)
        .to(q('[data-wf-camera]'), { xPercent: mobile ? 0 : -2, scale: 1, duration: .14 }, .52)
        .to(root, { '--wf-accent': '#b79ae8', '--wf-light': 'rgba(150,100,220,.04)', duration: .08 }, .70)
        .to(q('[data-audit-plane]'), { autoAlpha: 0, xPercent: -8, duration: .10 }, .71)
        .to(root, { '--wf-accent': '#c4d3c9', '--wf-light': 'rgba(180,205,180,.035)', duration: .12 }, .87)
        .to(q('[data-wf-camera]'), { xPercent: 0, scale: 1, rotation: 0, duration: .12 }, .87);
    return tl;
}
