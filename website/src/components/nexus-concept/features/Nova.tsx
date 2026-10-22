'use client';
import { NovaGuide } from '../../nexus-product/ReadingGuide';
import { novaSteps } from './data';
import { FeatureIntro, Technical } from './Shared';
import styles from './features.module.css';
import { useFeatureMotion } from '../motion/useFeatureMotion';
import { MotionControls } from '../motion/Controls';
import { NovaScene } from '../motion/NovaScene';
export function Nova({ productPage = false }: { productPage?: boolean }) {
    const motion = useFeatureMotion(9, 3.2);
    const step = motion.step;
    const item = novaSteps[step];
    return <section id="nexus-nova" className={`${styles.feature} ${styles.novaFeature}`} data-nova data-step={step} data-motion="nova" data-progress={motion.progress.toFixed(4)} data-state={motion.state} aria-labelledby="nova-title"><FeatureIntro number="02" kicker="NEXUS NOVA / AI ORCHESTRATION" title="Complex work. Coordinated intelligence." what="Nova is the planned coordinator for complex engineering work. It is intended to connect an objective, work units, model assignments, tools and feedback." problem="A difficult task rarely fits into one unexamined instruction. The coordination problem is deciding what needs to happen, what depends on it, and what evidence the next decision needs." status="Planned / non-runnable in inspected source · all steps below are illustrative"/>
 {productPage && <NovaGuide step={step}/>}
 <div className={styles.objective}><span>SAMPLE REQUEST</span><h3 id="nova-title">“Build an offline-first task manager.”</h3><p>A worker means an assigned role in the example. A dependency means one piece of work needs information or an outcome from another.</p></div><div className={styles.novaWorkspace}><div><NovaScene motion={motion}/><MotionControls motion={motion} labels={novaSteps.map(s=>s.short)} name="Nova example" action="Simulate orchestration"/></div><div className={styles.novaExplanation} aria-live="polite"><span className={styles.kicker}>ILLUSTRATIVE STEP / 0{step + 1}</span><h4>{item.title}</h4><dl><div><dt>What enters</dt><dd>{item.input}</dd></div><div><dt>Decision illustrated</dt><dd>{item.decision}</dd></div><div><dt>Who is responsible</dt><dd>{item.owner}</dd></div><div><dt>What leaves</dt><dd>{item.output}</dd></div></dl><p className={styles.reason}><b>Why this step matters</b>{item.why}</p></div></div>
 <Technical><p>The inspected Nova manifest declares planned Planner, Engineer, Reviewer, Verifier and optional Specialist slots. It is explicitly non-selectable and non-runnable. Declaring slots is not proof that the proposed orchestration is implemented.</p><p>Registry validation supplies compatible configuration; it does not create the plan. Supported Native Core paths enforce execution boundaries. Context records must preserve grounded decisions and open work. Sentry is a separate application at the illustrated review boundary, with feedback returning through Nexus.</p><p>No model is called, tool is run, code is generated or verification result is invented by this simulator. “Result package” and “finding” refer to the authored example only.</p></Technical>
 </section>;
}
