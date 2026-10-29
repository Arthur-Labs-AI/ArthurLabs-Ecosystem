import {StudioHero} from './Hero';
import {InfiniteDesk} from './InfiniteDesk';
import {StudioEditorial} from './Editorial';
import {StudioDownloads} from './Downloads';
import styles from './studio.module.css';

/** The approved experience, shared by the product route and its concept reference. */
export function StudioExperience(){return <div className={styles.page}><StudioHero/><InfiniteDesk/><StudioEditorial/><StudioDownloads/></div>;}
