'use client';
import Image from 'next/image';
import { useRef } from 'react';
import type { Product } from '@/lib/products';
import styles from './launch.module.css';
/** Native modal supplies Escape, focus containment and focus restoration. */
export function InterfaceImage({ product: p, index }: {
    product: Product;
    index: number;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    return <><button className={styles.screenButton} type="button" aria-label={`Inspect ${p.name} interface`} onClick={() => dialog.current?.showModal()}><span className={styles.screen}><Image src={`/images/${p.id}.webp`} width={p.width} height={p.height} alt={p.alt} preload={index === 0} quality={90} sizes={index === 0 ? '(max-width:900px) 88vw, 61vw' : '(max-width:900px) 43vw, 29vw'}/></span><span className={styles.inspectHint}>Inspect interface ↗</span></button><dialog ref={dialog} className={styles.interfaceDialog} aria-label={`${p.name} interface preview`} onClick={e => { if (e.target === e.currentTarget)
        dialog.current?.close(); }}><div><div className={styles.dialogTop}><span>{p.name} / AUTHENTIC INTERFACE</span><button type="button" onClick={() => dialog.current?.close()} autoFocus>Close ×</button></div><Image src={`/images/${p.id}.webp`} width={p.width} height={p.height} alt={p.alt} quality={90} sizes="(max-width:760px) 94vw, 90vw"/><p>Interface capture for product recognition. This is not a live application.</p></div></dialog></>;
}
