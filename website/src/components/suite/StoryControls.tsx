import { chapters } from './story';
import styles from './suite.module.css';
export function StoryControls({ chapter, ready, select, motion, toggleMotion, reduced }: {
  chapter: number; ready: boolean; select: (index: number) => void; motion: boolean; toggleMotion: () => void; reduced: boolean;
}) {
  return <div className={styles.controls}>
    <div className={styles.chapterTabs} role="group" aria-label="Suite workflow chapters" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (chapter + (event.key === 'ArrowRight' ? 1 : 3)) % 4;
      select(next);
      event.currentTarget.querySelectorAll('button')[next]?.focus({ preventScroll: true });
    }}>{chapters.map((item, index) => <button key={item.name} type="button" disabled={!ready} aria-current={index === chapter ? 'step' : undefined} aria-label={`${item.name} chapter`} onClick={() => select(index)}><span>0{index + 1}</span>{item.name}</button>)}</div>
    <button type="button" className={styles.motionButton} disabled={!ready || reduced} onClick={toggleMotion} aria-pressed={!motion}>{reduced ? 'Reduced motion' : motion ? 'Ⅱ Pause motion' : '↗ Enable motion'}</button>
  </div>;
}
