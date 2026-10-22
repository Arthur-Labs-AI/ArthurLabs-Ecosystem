import type { ReactNode } from 'react';
import styles from './features.module.css';
export function FeatureIntro({ number, kicker, title, what, problem, status }: {
    number: string;
    kicker: string;
    title: string;
    what: string;
    problem: string;
    status: string;
}) { return <header className={styles.featureIntro}><span className={styles.kicker}>{number} / {kicker}</span><h2>{title}</h2><div className={styles.introColumns}><p>{what}</p><div><p>{problem}</p><span className={styles.status}>{status}</span></div></div></header>; }
export function Technical({ children }: {
    children: ReactNode;
}) { return <details className={styles.technical}><summary>Go deeper: how it works and what is implemented</summary><div>{children}</div></details>; }
export function DataExample({ input, process, output }: {
    input: string;
    process: string;
    output: string;
}) { return <dl className={styles.dataExample}><div><dt>Input</dt><dd>{input}</dd></div><div><dt>Processing</dt><dd>{process}</dd></div><div><dt>Output</dt><dd>{output}</dd></div></dl>; }
