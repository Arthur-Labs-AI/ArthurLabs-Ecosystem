'use client';
import { useState, type ReactNode, type MouseEvent } from 'react';
import Link from 'next/link';
import { nexusTargets, type NexusRelease, type NexusTarget } from './releases';
import styles from './downloads.module.css';
/** Inert distribution UI. Only server-validated catalog entries reach the client. */
export function NexusDownloads({releases}:{releases:readonly NexusRelease[]}) {
  const [system,setSystem]=useState<NexusTarget>('Windows');
  const available=releases.filter(r=>r.system===system);
  return <section id="nexus-downloads" tabIndex={-1} className={styles.downloads} aria-labelledby="nexus-download-title" data-nexus-downloads>
   <div className={styles.heading}><div><span className={styles.eyebrow}>NEXUS / YOUR OWN WORKSPACE</span><h2 id="nexus-download-title">The engine.<br/><em>On your terms.</em></h2><p>Nexus is an independent desktop and command-line application. Explore it on its own, or alongside Arthur Studio and Sentry.</p></div><div className={styles.availability}><span>{releases.length?'VERIFIED RELEASE METADATA':'IN DEVELOPMENT'}</span><strong>{releases.length?'Choose a verified Nexus artifact.':'Download Not Yet Available'}</strong><p>{releases.length?'Each artifact lists its own operating system, architecture and installation requirements.':'No verified downloadable Nexus artifact is listed. Platform compatibility, architectures and installation requirements will be published with verified releases.'}</p></div></div>
   <div className={styles.releaseArea}><div className={styles.selectorLabel}>RELEASE TARGETS TO CHECK <small>Support is confirmed only by artifact metadata.</small></div><div className={styles.platforms} role="group" aria-label="Nexus release target">{nexusTargets.map(s=><button key={s} aria-pressed={s===system} onClick={()=>setSystem(s)}><svg viewBox="0 0 24 24" aria-hidden="true">{s==='Windows'?<path d="M3 5 10 4v7H3Zm9-1 9-1v8h-9ZM3 13h7v7l-7-1Zm9 0h9v9l-9-1Z"/>:s==='Linux'?<path d="M8 14C4 18 5 21 8 20h8c3 1 4-2 0-6V8c0-7-8-7-8 0v6Zm2-5h.1M14 9h.1M10 12l2 1 2-1"/>:<path d="M15 6c-2-1-3 1-4 0-6-2-8 4-5 10 3 6 4 4 6 4s4 2 6-3c-4-2-4-6-1-8l-2-3Zm-3-2c0-2 2-3 4-3 0 2-2 4-4 4"/>}</svg><strong>{s}</strong><small>{releases.some(r=>r.system===s)?'View verified artifacts':'No verified artifact'}</small></button>)}</div>
   <div className={styles.targetResult} aria-live="polite">{available.length?available.map(r=><article key={`${r.system}-${r.architecture}-${r.filename}`} className={styles.releaseCard}><div><span className={styles.eyebrow}>VERIFIED NEXUS ARTIFACT</span><h3>Nexus {r.version}</h3><dl><div><dt>Operating system</dt><dd>{r.system}</dd></div><div><dt>Architecture</dt><dd>{r.architecture}</dd></div><div><dt>Installer format</dt><dd>{r.format}</dd></div></dl><a className={styles.primary} href={r.url}>Download {r.filename} ↓</a><a className={styles.notes} href={r.releaseNotes}>Release notes ↗</a></div><div><h4>Installation</h4><ol>{r.installation.map((s,i)=><li key={i}>{s}</li>)}</ol><h4>Command-line interface</h4>{r.cli?<><p>{r.cli.availability==='included'?'Included in this artifact.':'Provided separately; follow the verified release instructions.'}</p><ol>{r.cli.instructions.map((s,i)=><li key={i}>{s}</li>)}</ol></>:<p>CLI availability is not specified for this artifact.</p>}</div></article>):<div className={styles.emptyTarget}><div className={styles.targetGlyph} aria-hidden="true">↧</div><div><h3>{system} release information is pending.</h3><p>No verified {system} installer or architecture is published in this catalog. Installation guidance and release notes will accompany a verified artifact.</p><span>DESKTOP / CLI DISTRIBUTION DETAILS NOT YET VERIFIED</span></div></div>}</div></div>
   <div className={styles.installation}><div><h3>Before you install.</h3><p>When a release is verified, check its operating system, architecture and requirements, then follow the instructions attached to that artifact. No installation command is supplied before those details are confirmed.</p></div><div><h3>Independent. Connected.</h3><p>The suite contains independent applications. Nexus remains its own desktop/CLI product; no suite launcher or unified installer is implied.</p><Link href="/suite">Explore Nexus as part of the ArthurLabs Suite. ↗</Link></div></div>
  </section>;
}
export function NexusDownloadLink({children,className}:{children:ReactNode;className?:string}) {
 function navigate(event:MouseEvent<HTMLAnchorElement>) {
  if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  const target=document.getElementById('nexus-downloads');if(!target)return;
  event.preventDefault();
  if(location.hash!=='#nexus-downloads')history.pushState(null,'','#nexus-downloads');
  target.focus({preventScroll:true});
  const top=target.getBoundingClientRect().top+scrollY-150;
  scrollTo({top,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
 }
 return <a href="#nexus-downloads" className={className} onClick={navigate}>{children}</a>;
}
export function NexusDownloadNav(){return <nav className={styles.localNav} aria-label="Nexus concept navigation"><a href="#nexus-concept-title" className={styles.wordmark}>NEXUS <span>Independent desktop / CLI</span></a><div><a href="#inside-engine" className={styles.explore}>Explore the Engine</a><NexusDownloadLink className={styles.navDownload}>Download Nexus ↓</NexusDownloadLink></div></nav>;}
