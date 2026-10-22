'use client';
import { useState } from 'react';
import { sampleModels, sampleMatch, type Role } from './content';
import styles from './engine.module.css';
export function RoleControl({ value, onChange }: {
    value: Role;
    onChange: (role: Role) => void;
}) { return <div className={styles.roleControl} role="group" aria-label="Illustrative worker role">{(['planner', 'coder', 'reviewer'] as const).map(r => <button key={r} onClick={() => onChange(r)} aria-pressed={value === r}>{r}</button>)}</div>; }
export function RegistryExplorer() { const [role, setRole] = useState<Role>('coder'); const match = sampleMatch(role); return <div className={styles.sampleExplorer}><RoleControl value={role} onChange={setRole}/><p aria-live="polite" className={styles.match}>Sample rule: <strong>{role} → {match.name} → {match.provider}</strong></p><div className={styles.sampleEntries}>{sampleModels.map(m => <div key={m.id} data-match={m.id === match.id}><strong>{m.name}</strong><span>{m.provider} / {m.tags}</span><small>Illustrative context policy: {m.context}</small></div>)}</div><p className={styles.small}>Fictional catalog. Exact tag matching only; no real models, measured rankings, prices or context limits.</p></div>; }
