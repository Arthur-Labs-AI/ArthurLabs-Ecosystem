import Image from 'next/image';
import type {DeskObject} from './content';
import {observations} from './content';
import {HandStudy} from './HandStudy';
import styles from './studio.module.css';
export function ObjectSurface({object, thought}: {object:DeskObject; thought:string}) {
  return <span className={styles.surface} data-kind={object.id}>
    {object.id === 'thought' && <><span className={styles.paperPin}/><span className={styles.objectMeta}>A THOUGHT / LEFT OPEN</span><span className={styles.noteWords} data-long={thought.length>80}>{thought}</span><span className={styles.pencilLine}/><span className={styles.objectFoot}>No need to know the answer yet.</span></>}
    {object.id === 'study' && <><span className={styles.objectMeta}>FIELD STUDY / HUMAN GESTURE</span><HandStudy/><span className={styles.sketchTitle}>A language<br/>before words.</span><span className={styles.objectFoot}>Illustrative sketch · open to explore</span></>}
    {object.id === 'observations' && <><span className={styles.objectMeta}>IN THE MARGINS</span><span className={styles.observationTitle}>Things<br/>I keep noticing.</span><span className={styles.observationLines}>{observations.map(o=><span key={o.title}>{o.title}</span>)}</span><span className={styles.objectFoot}>Three related observations</span></>}
    {object.id === 'question' && <><span className={styles.objectMeta}>KEEP THIS QUESTION</span><span className={styles.questionWords}>Intention,<br/>or just<br/><em>movement?</em></span><span className={styles.objectFoot}>Something worth asking.</span></>}
    {object.id === 'revisions' && <><span className={styles.objectMeta}>THE SAME IDEA, SEEN AGAIN</span><span className={styles.revisionWords}><s>Recognize a gesture.</s><br/><em>Understand an intention.</em></span><span className={styles.objectFoot}>A change of mind is a beginning.</span></>}
    {object.id === 'studio' && <><span className={styles.windowBar}><span className={styles.windowDot}/><span>Arthur Studio</span><span>ACTUAL INTERFACE</span></span><Image src="/images/studio.webp" alt="Authentic Arthur Studio Home interface: capture, recent ideas, connected thinking and revision history" width={1616} height={998} sizes="(max-width:700px) 88vw, 1200px"/><span className={styles.windowCaption}>A real place for what’s on your mind. <span>↗</span></span></>}
  </span>;
}
