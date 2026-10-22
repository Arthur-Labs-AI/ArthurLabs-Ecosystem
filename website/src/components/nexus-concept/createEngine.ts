import { gsap } from 'gsap';
type Point = readonly [
    number,
    number
];
const topology = [[[0, 2], [1, 2], [2, 3], [3, 5], [6, 4], [4, 3], [6, 3]], [[0, 1], [1, 2], [0, 3], [3, 4], [2, 4], [4, 5], [5, 6]], [[0, 1], [1, 4], [0, 2], [2, 3], [4, 5], [3, 6], [5, 6]], [[0, 3], [1, 3], [2, 4], [3, 5], [4, 5], [5, 6], [5, 5]]];
const curve = (a: Point, b: Point) => `M${a[0]} ${a[1]} C${a[0] + (b[0] - a[0]) * .5} ${a[1]},${b[0] - (b[0] - a[0]) * .5} ${b[1]},${b[0]} ${b[1]}`;
export function createEngine(root: HTMLElement, compact: boolean, short = false) {
    const q = gsap.utils.selector(root), nodes = q('[data-engine-node]'), paths = q('[data-engine-edge]'), traces = q('[data-context-trace]');
    const native: Point[] = compact ? [[24, 10], [77, 10], [24, 37], [77, 40], [24, 66], [77, 70], [24, 92]] : [[20, 18], [18, 69], [41, 40], [61, 55], [80, 26], [78, 86], [46, 90]];
    const nova: Point[] = compact ? [[24, 10], [76, 10], [24, 38], [76, 38], [24, 66], [76, 66], [50, 92]] : [[13, 46], [34, 20], [35, 74], [57, 24], [58, 70], [78, 45], [89, 82]];
    const before: Point[] = compact ? [[50, 8], [24, 36], [77, 36], [24, 63], [77, 63], [24, 91], [77, 91]] : [[14, 40], [38, 15], [38, 43], [38, 76], [67, 17], [67, 48], [67, 82]];
    const after: Point[] = compact ? [[24, 8], [24, 36], [77, 36], [77, 63], [24, 63], [24, 91], [77, 91]] : [[14, 40], [37, 26], [68, 26], [68, 59], [37, 59], [37, 88], [68, 88]];
    const registry: Point[] = compact ? [[24, 8], [24, 36], [24, 65], [77, 15], [77, 50], [24, 92], [77, 92]] : [[15, 15], [15, 49], [15, 83], [44, 30], [44, 76], [69, 52], [91, 52]];
    const frames = [{ at: .16, points: native, chapter: 0 }, { at: .36, points: nova, chapter: 1 }, { at: .56, points: before, chapter: 2 }, { at: .72, points: after, chapter: 2 }, { at: .89, points: registry, chapter: 3 }];
    const tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
    gsap.set(nodes, { left: '50%', top: '50%', autoAlpha: 0, scale: .75 });
    gsap.set(paths, { autoAlpha: 0, attr: { d: curve([50, 50], [50, 50]) } });
    gsap.set(q('[data-node-label]'), { autoAlpha: 0 });
    gsap.set(q('[data-node-label="0"]'), { autoAlpha: 1 });
    gsap.set(q('[data-engine-camera]'), { rotationX: compact ? 0 : 12, rotationZ: compact ? 0 : -3, scale: compact ? .98 : .94 });
    gsap.set(q('[data-core-boundary]'), { autoAlpha: 0 });
    gsap.set(q('[data-context-groups]'), { autoAlpha: 0 });
    gsap.set(q('[data-node-slot]'), { minHeight: compact ? (short ? 25 : 31) : 32 });
    gsap.set(traces, { autoAlpha: 0, attr: { strokeDashoffset: 1 } });
    tl.to({}, { duration: 1 }, 0).to(q('[data-interface-plane]'), { scale: .84, yPercent: -9, rotationX: compact ? 0 : 18, rotationY: compact ? 0 : -5, duration: .12 }, 0).to(q('[data-interface-plane]'), { autoAlpha: 0, duration: .09 }, .075);
    frames.forEach((frame, index) => {
        const start = frame.at - (index === 0 ? .12 : .10), duration = index === 0 ? .12 : .10;
        nodes.forEach((node, i) => tl.to(node, { left: `${frame.points[i][0]}%`, top: `${frame.points[i][1]}%`, autoAlpha: 1, scale: 1, duration }, start));
        topology[frame.chapter].forEach(([a, b], i) => { const d = curve(frame.points[a], frame.points[b]); tl.to(paths[i], { autoAlpha: .6, attr: { d }, duration }, start); tl.to(traces[i], { attr: { d }, duration }, start); });
        if (index !== 3 && index > 0) {
            const prev = index === 4 ? 2 : index - 1;
            tl.to(q(`[data-node-label="${prev}"]`), { autoAlpha: 0, duration: .025 }, start + .015).to(q(`[data-node-label="${frame.chapter}"]`), { autoAlpha: 1, duration: .03 }, start + .045);
        }
    });
    tl.to(q('[data-core-boundary]'), { autoAlpha: 1, duration: .10 }, .07).to(q('[data-core-boundary]'), { autoAlpha: 0, duration: .09 }, .25)
        .to(q('[data-engine-camera]'), { rotationX: 0, rotationZ: 0, scale: 1, duration: .14 }, .23)
        .to(q('[data-node-slot]'), { minHeight: compact ? (short ? 37 : 43) : 48, duration: .10 }, .46).to(q('[data-node-slot]'), { minHeight: compact ? (short ? 25 : 31) : 32, duration: .10 }, .79)
        .to(q('[data-context-groups]'), { autoAlpha: 1, duration: .07 }, .63).to(q('[data-context-groups]'), { autoAlpha: 0, duration: .06 }, .78);
    traces.forEach((t, i) => { tl.to(t, { autoAlpha: .8, duration: .01 }, .36 + i * .008).to(t, { attr: { strokeDashoffset: 0 }, duration: .07 }, .37 + i * .008).to(t, { autoAlpha: 0, duration: .015 }, .44 + i * .008); });
    return tl;
}
