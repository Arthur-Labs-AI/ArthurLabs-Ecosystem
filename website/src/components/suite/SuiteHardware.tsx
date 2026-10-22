import Link from 'next/link';
import styles from './suite.module.css';
export function SuiteHardware() {
  return <section className={styles.hardwareTeaser} aria-labelledby="suite-hardware-title"><div><span className={styles.eyebrow}>04 / BEYOND SOFTWARE</span><h2 id="suite-hardware-title">A wider world<br/><em>of interaction.</em></h2><p>Exploring how dedicated computing, wearable input, and future spatial interfaces could connect to the ecosystem.</p><Link className={styles.secondary} href="/hardware">Explore hardware research <span data-hardware-object aria-hidden="true">↗</span></Link></div><div className={styles.hardwareConcepts} data-suite-entry>
    <div><span className={styles.boxIcon} data-hardware-object aria-hidden="true"/><div><h3>Arthur Box</h3><p>Dedicated computing concepts.</p></div><span>01</span></div>
    <div><span className={styles.bandIcon} data-hardware-object aria-hidden="true"/><div><h3>EMG wristband</h3><p>Exploring intent through wearable input.</p></div><span>02</span></div>
    <div><span className={styles.xrIcon} data-hardware-object aria-hidden="true"/><div><h3>Future XR interaction</h3><p>New possibilities beyond the screen.</p></div><span>03</span></div>
    <p className={styles.hardwareDisclaimer}>Research concepts. Not released products or confirmed integrations.</p>
  </div></section>;
}
