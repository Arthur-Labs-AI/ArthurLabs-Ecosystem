'use client';
import { useState } from 'react';
import { facts } from './content';
import styles from './engine.module.css';
export function ComparisonControl({ value, onChange }: {
    value: number;
    onChange: (n: number) => void;
}) { return <div className={styles.comparisonControl}><button type="button" onClick={() => onChange(0)} aria-pressed={value < .05}>Before</button><label><span>Context organization</span><input aria-label="Context organization" type="range" min="0" max="100" value={Math.round(value * 100)} onChange={e => onChange(Number(e.target.value) / 100)}/></label><button type="button" onClick={() => onChange(1)} aria-pressed={value > .95}>After</button></div>; }
export function ContextComparison() { const [value, setValue] = useState(0); return <div className={styles.staticComparison}><ComparisonControl value={value} onChange={setValue}/><p>{value < .5 ? 'Full working context · illustrative sample' : 'Structured compacted context · illustrative sample'}</p><ol data-organization={value < .5 ? 'before' : 'after'}>{facts.map(f => <li key={f.name}><small>{value < .5 ? 'WORKING CONTEXT' : f.group.toUpperCase()}</small><strong>{f.name}</strong><span>{f.text}</span></li>)}</ol><p className={styles.small}>The same seven example facts remain inspectable. This is not a guarantee of perfect retention or an enabled durable CCv2 operation.</p></div>; }
