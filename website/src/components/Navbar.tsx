'use client';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useEffect,useRef,useState,type KeyboardEvent,type MouseEvent} from 'react';
import {Brand} from './Brand';
import styles from './Navbar.module.css';

const products=[
 {name:'Nexus',href:'/nexus',description:'AI orchestration & engineering',accent:'nexus',mark:'◇'},
 {name:'Sentry',href:'/sentry',description:'Independent code review & QA',accent:'sentry',mark:'S'},
 {name:'Arthur Studio',href:'/studio',description:'Ideas & knowledge workspace',accent:'studio',mark:'A'},
];
export function Navbar(){
 const pathname=usePathname(),[ready,setReady]=useState(false),[open,setOpen]=useState(false),[mobileOpen,setMobileOpen]=useState(false);
 const header=useRef<HTMLElement>(null),productsRoot=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),mobile=useRef<HTMLDetailsElement>(null),summary=useRef<HTMLElement>(null),destination=useRef(false);
 const previousPath=useRef(pathname);
 useEffect(()=>{setMobileOpen(mobile.current?.open??false);setReady(true);},[]);
 const download=pathname==='/nexus'?'#nexus-downloads':pathname==='/sentry'?'#sentry-downloads':pathname==='/suite'?'#downloads':null;
 function close(restore=false){const focusTarget=mobile.current?.contains(document.activeElement)?summary.current:trigger.current;setOpen(false);if(mobile.current)mobile.current.open=false;setMobileOpen(false);if(restore)focusTarget?.focus();}
 useEffect(()=>{
  const outside=(e:PointerEvent)=>{if(mobile.current?.open&&!mobile.current.contains(e.target as Node)&&header.current?.contains(e.target as Node))close();if(!header.current?.contains(e.target as Node)){const active=document.activeElement;const restore=!!active&&!!header.current?.contains(active)&&!(e.target as Element).closest('a,button,input,select,textarea,[tabindex]');close(restore);}else if(productsRoot.current&&!productsRoot.current.contains(e.target as Node))setOpen(false);};
  const escape=(e:globalThis.KeyboardEvent)=>{if(e.key==='Escape'&&(open||mobile.current?.open)){e.preventDefault();close(true);}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
 },[open]);
 useEffect(()=>{if(previousPath.current===pathname)return;previousPath.current=pathname;close();if(!destination.current)return;destination.current=false;const heading=document.querySelector<HTMLElement>('main h1');heading?.setAttribute('tabindex','-1');heading?.focus({preventScroll:true});},[pathname]);
 useEffect(()=>{const query=matchMedia('(max-width:899px)');const change=()=>close();query.addEventListener('change',change);return()=>query.removeEventListener('change',change);},[]);
 function navigate(e:MouseEvent<HTMLAnchorElement>){
  if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||e.button!==0)return;
  const url=new URL(e.currentTarget.href);close();
  if(url.pathname!==pathname)destination.current=true;
  else if(url.hash){const section=document.getElementById(url.hash.slice(1)),heading=section?.querySelector<HTMLElement>('h1,h2')??section;heading?.setAttribute('tabindex','-1');heading?.focus({preventScroll:true});}
  else (innerWidth<900?summary.current:trigger.current)?.focus();
 }
 function arrow(e:KeyboardEvent<HTMLElement>){
  if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();setOpen(true);
  const links=[...productsRoot.current!.querySelectorAll<HTMLAnchorElement>('#product-navigation a')];let i=links.indexOf(document.activeElement as HTMLAnchorElement);
  i=e.key==='Home'?0:e.key==='End'?links.length-1:e.key==='ArrowDown'?(i+1)%links.length:(i-1+links.length)%links.length;
  requestAnimationFrame(()=>links[i]?.focus());
 }
 function productLinks(){return products.map(p=><Link key={p.href} href={p.href} aria-label={p.name} aria-description={p.description} onClick={navigate} aria-current={pathname===p.href?'page':undefined} className={styles.product} data-accent={p.accent}><span className={styles.mark} aria-hidden="true">{p.mark}</span><span><strong>{p.name}</strong><small>{p.description}</small></span><span aria-hidden="true" className={styles.productArrow}>↗</span></Link>);}
 return <header ref={header} className={styles.header} data-ready={ready}><a className="skip-link" href="#main">Skip to content</a><nav aria-label="Main navigation" className={styles.navigation}><Brand/>
 <div className={styles.desktop}><div ref={productsRoot} className={styles.products} onKeyDown={arrow} onBlur={e=>{if(e.relatedTarget&&!e.currentTarget.contains(e.relatedTarget))setOpen(false);}}>
 <button ref={trigger} disabled={!ready} className={styles.trigger} aria-expanded={open} aria-controls="product-navigation" onClick={()=>setOpen(!open)}>Products <span className={styles.chevron} data-open={open} aria-hidden="true">⌄</span></button>
 <div id="product-navigation" className={styles.productPanel} data-open={open} inert={!open} aria-label="ArthurLabs products"><span className={styles.menuLabel}>THREE INDEPENDENT APPLICATIONS</span>{productLinks()}<Link className={styles.suiteLink} href="/suite" onClick={navigate}>Explore the Full Suite <span aria-hidden="true">→</span></Link></div></div>
 <Link href="/suite" onClick={navigate} aria-current={pathname==='/suite'?'page':undefined}>Full Suite</Link><Link href="/hardware" onClick={navigate} aria-current={pathname==='/hardware'?'page':undefined}>Hardware</Link></div>
 <div className={styles.action}>{download?<Link href={download} onClick={navigate}>Downloads <span aria-hidden="true">↓</span></Link>:<Link href="/suite" onClick={navigate}>Explore the Suite <span aria-hidden="true">↗</span></Link>}</div>
 <details ref={mobile} className={`mobile-menu ${styles.mobile}`} onToggle={e=>setMobileOpen(e.currentTarget.open)} onBlur={e=>{if(e.relatedTarget&&!e.currentTarget.contains(e.relatedTarget))close();}}><summary ref={summary} aria-label="Open navigation" aria-expanded={mobileOpen} aria-controls="mobile-navigation">Menu <span aria-hidden="true">{mobileOpen?'−':'＋'}</span></summary><div id="mobile-navigation" className={styles.mobilePanel}><span className={styles.menuLabel}>THE ARTHURLABS ECOSYSTEM</span>{productLinks()}<div className={styles.mobileLinks}><Link href="/suite" onClick={navigate}>Full Suite</Link><Link href="/hardware" onClick={navigate}>Hardware</Link><Link href="/#philosophy" onClick={navigate}>Our approach</Link>{download&&<Link href={download} onClick={navigate}>Downloads ↓</Link>}</div></div></details>
 </nav></header>;
}
