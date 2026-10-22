'use client';
import type { FeatureMotion } from './useFeatureMotion';
import styles from './motion.module.css';
export function MotionControls({ motion, labels, action, name, previous = '← Previous', next = 'Next step →' }: { motion: FeatureMotion; labels: readonly string[]; action: string; name: string; previous?: string; next?: string }) {
  return <div className={styles.controls} data-motion-controls={name}>
    <div className={styles.transport}>
      <button className={styles.play} onClick={() => motion.play()} disabled={!motion.ready || motion.state === 'playing'}>{motion.state === 'paused' ? 'Resume example' : action}<span aria-hidden="true"> ↗</span></button>
      <button onClick={motion.pause} disabled={motion.state !== 'playing'}>Pause</button>
      <button disabled={!motion.ready} onClick={() => motion.play(true)}>Replay</button>
      <span className={styles.state}>{motion.reduced ? 'Reduced motion · manual stages' : motion.state === 'idle' ? 'Ready when you are' : motion.state} · {motion.step + 1}/{labels.length}</span>
    </div>
    <div className={styles.rail} role="group" aria-label={`${name} step timeline`}>{labels.map((label,i) => <button key={label} disabled={!motion.ready} aria-current={motion.step===i?'step':undefined} onClick={()=>motion.seek(i)}><small>{String(i+1).padStart(2,'0')}</small><span>{label}</span><i style={{transform:`scaleX(${Math.max(0,Math.min(1,motion.progress-i))})`}}/></button>)}</div>
    <div className={styles.previousNext}><button disabled={!motion.ready || motion.step===0} onClick={()=>motion.seek(motion.step-1)}>{previous}</button><span>{labels[motion.step]}</span><button disabled={!motion.ready || motion.step===labels.length-1} onClick={()=>motion.seek(motion.step+1)}>{next}</button></div>
  </div>;
}
