import Image from 'next/image';
import { DocumentCard } from './DocumentCard';
import { ProductMark } from './ProductMark';
import styles from './suite.module.css';
export function SuiteHero() {
  return <section className={styles.hero} aria-labelledby="suite-title">
    <div className={styles.heroCopy}><div className={styles.eyebrow}><span/> THE ARTHURLABS SUITE</div>
      <h1 id="suite-title"><span data-hero-line>One idea.</span><span data-hero-line>Three workspaces.</span><em data-hero-line>Endless possibilities.</em></h1>
      <p>Experience how Arthur Studio, Nexus, and Sentry connect ideas, intelligent execution, and independent verification.</p>
      <div className={styles.actions} data-hero-controls><a href="#follow-the-idea" className={styles.primary}>Explore the Workflow <span aria-hidden="true">↓</span></a><a href="#suite-products" className={styles.secondary}>Meet the Products <span aria-hidden="true">↗</span></a></div>
      <div className={styles.heroFoot} data-hero-controls><span>01 — CAPTURE</span><span>02 — ORCHESTRATE</span><span>03 — VERIFY</span></div>
    </div>
    <div className={styles.heroVisual}>
      <div className={styles.previewOrbit} aria-hidden="true"/>
      <div className={styles.heroScreen} data-hero-screen><div className={styles.previewBar}><ProductMark product="studio"/><span>Arthur Studio</span><span className={styles.previewMeta}>THE STARTING POINT</span></div><Image src="/images/studio.webp" alt="Authentic Arthur Studio idea capture and connected thinking workspace" width={1616} height={998} sizes="(max-width: 900px) 88vw, 52vw" quality={90} priority/></div>
      <div className={styles.heroDocument} data-hero-document><DocumentCard compact title="A thought, made tangible" lines={['Personal tasks. Available offline.', 'A clear brief for the next workspace.']}/></div>
      <div className={styles.heroVisualNote}><span className={styles.smallDot}/> One idea, carried forward.</div>
    </div>
    <div className={styles.heroBottom}><span>FOLLOW THE IDEA</span><span>A conceptual journey. Built around real interfaces.</span><span aria-hidden="true">SCROLL TO DISCOVER ↓</span></div>
  </section>;
}
