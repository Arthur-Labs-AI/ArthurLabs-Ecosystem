import {ArrowDown,ArrowUpRight} from 'lucide-react';
import styles from './studio.module.css';
export function StudioHero(){return <section className={styles.hero} aria-labelledby="studio-concept-title">
  <div className={styles.identity}><span className={styles.studioMark} aria-hidden="true">A<span/></span><span>Arthur Studio<small>IDEAS & KNOWLEDGE</small></span><span className={styles.edition}>THE INFINITE DESK<br/>A CREATIVE EXPLORATION / 05</span></div>
  <div className={styles.heroGrid}><h1 id="studio-concept-title"><span>A home for</span><em>unfinished ideas.</em></h1><div className={styles.heroAside}><span className={styles.kicker}>WHERE THOUGHTS TAKE SHAPE</span><p>An open space to capture, explore, and develop the things worth thinking about.</p><div className={styles.actions}><a className={styles.primary} href="#studio-downloads">Download Arthur Studio <ArrowDown size={16}/></a><a className={styles.secondary} href="#infinite-desk">Explore the Desk <ArrowUpRight size={16}/></a></div></div></div>
  <div className={styles.heroFooter}><span>A little less structure.<br/><em>A little more possibility.</em></span><span>CAPTURE A THOUGHT.<br/>GIVE IT SOME ROOM.</span></div>
</section>;}
