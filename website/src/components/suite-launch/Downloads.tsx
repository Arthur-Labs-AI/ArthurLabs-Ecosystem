'use client';
import { useState } from 'react';
import Link from 'next/link';
import { eligibleArtifacts, type PackageId } from './releases';
import styles from './launch.module.css';
import {hasSentryMetadata} from '@/lib/sentry-release';
export function DownloadOption({ id, name }: {
    id: PackageId;
    name: string;
}) {
    const artifacts = eligibleArtifacts(id);
    const [system, setSystem] = useState(artifacts[0]?.system ?? '');
    const [architecture, setArchitecture] = useState(artifacts[0]?.architecture ?? '');
    const systems = [...new Set(artifacts.map(a => a.system))];
    const available = artifacts.filter(a => a.system === system);
    const selected = available.find(a => a.architecture === architecture);
    return <div className={styles.releaseRow}><div><strong>{name}</strong><span>{artifacts.length ? 'Verified distribution metadata' : 'Release information awaiting verification'}</span></div>{artifacts.length ? <div className={styles.selectors}>
    <label>Operating system<select value={system} onChange={e => { setSystem(e.target.value); setArchitecture(artifacts.find(a => a.system === e.target.value)!.architecture); }}>{systems.map(s => <option key={s}>{s}</option>)}</select></label>
    <label>Architecture<select value={architecture} onChange={e => setArchitecture(e.target.value)}>{[...new Set(available.map(a => a.architecture))].map(s => <option key={s}>{s}</option>)}</select></label>
    <div aria-live="polite">{selected ? <><small>{selected.version} · {selected.format}</small><a className={styles.textLink} href={selected.url} download={selected.filename}>Download {name} ↗</a>{hasSentryMetadata(selected)&&<><p className={styles.fine}>Unsigned archive · online WSL2 bootstrap · packaged CLI</p><details className={styles.releaseDetails}><summary>Installation, source & checksum</summary><ul>{selected.requirements.map(text=><li key={text}>{text}</li>)}</ul><p><a href={selected.installation}>Installation & release notes ↗</a></p><p><a href={selected.checksumUrl}>Published SHA256 sidecar ↗</a></p><p className={styles.fine} style={{overflowWrap:'anywhere'}}>SHA256: {selected.sha256}<br/>Source: {selected.sourceCommit}</p><Link href="/sentry#sentry-downloads">Full Sentry release details ↗</Link></details></>}</> : <span>No verified artifact for this selection.</span>}</div>
  </div> : <span className={styles.status}>Download unavailable</span>}</div>;
}
