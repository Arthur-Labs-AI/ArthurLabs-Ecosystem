'use client';
import { useEffect, useRef, useState } from 'react';
import { NexusDownloadLink } from '../nexus-download/NexusDownloads';
import styles from './product.module.css';
const sections = [['native-core','Native Core'],['nexus-nova','Nova'],['context-compaction','CCv2'],['model-registry','Registry'],['engineering-mode','Engineering'],['nexus-interfaces','CLI + Desktop'],['sentry-integration','Sentry'],['nexus-resources','Resources']];
export function ProductNav() {
  const [open,setOpen] = useState(false);
  const nav = useRef<HTMLElement>(null), toggle = useRef<HTMLButtonElement>(null);
  useEffect(()=>{function dismiss(e:PointerEvent){if(!nav.current?.contains(e.target as Node))setOpen(false);}function escape(e:KeyboardEvent){if(e.key==='Escape'&&open){setOpen(false);toggle.current?.focus();}}document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape);};},[open]);
  function navigate(e:React.MouseEvent<HTMLAnchorElement>,id:string){if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();setOpen(false);history.pushState(null,'',`#${id}`);const destination=document.getElementById(id);destination?.setAttribute('tabindex','-1');destination?.focus({preventScroll:true});destination?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'start'});}
  return <nav ref={nav} onClick={e=>{if((e.target as HTMLElement).closest('a[href="#nexus-downloads"]'))setOpen(false);}} className={styles.nav} aria-label="Nexus product navigation"><a className={styles.wordmark} href="#nexus-concept-title">NEXUS<span> / THE ENGINE</span></a><button className={styles.sectionToggle} ref={toggle} aria-expanded={open} aria-controls="nexus-section-index" onClick={()=>setOpen(!open)}>On this page <span aria-hidden="true">{open?'−':'+'}</span></button><NexusDownloadLink className={styles.download}>Download Nexus ↓</NexusDownloadLink><div className={styles.index} id="nexus-section-index" hidden={!open}>{sections.map(([id,label],i)=><a key={id} href={`#${id}`} onClick={e=>navigate(e,id)}><span>0{i+1}</span>{label}<span aria-hidden="true">↗</span></a>)}</div></nav>;
}
