'use client';
import {useEffect,useLayoutEffect,useRef,useState, type PointerEvent} from 'react';
import {gsap} from 'gsap';
import {ArrowUpRight,ArrowLeft,RotateCcw} from 'lucide-react';
import {initialThought,objects,observations,wordings,type DeskObject} from './content';
import {ObjectSurface} from './ObjectSurface';
import {InspectorContent} from './InspectorContent';
import {createInspection,type MotionPhase} from './motion';
import styles from './studio.module.css';
export function InfiniteDesk(){
  const root=useRef<HTMLElement>(null),camera=useRef<HTMLDivElement>(null),dialog=useRef<HTMLDialogElement>(null),room=useRef<HTMLDivElement>(null),flight=useRef<HTMLDivElement>(null),detail=useRef<HTMLDivElement>(null);
  const origin=useRef<HTMLButtonElement|null>(null),inspection=useRef<ReturnType<typeof createInspection>|null>(null),active=useRef(false);
  const [selected,setSelected]=useState<DeskObject|null>(null),[thought,setThought]=useState(initialThought),[ready,setReady]=useState(false),[phase,setPhase]=useState<MotionPhase>('idle');
  useEffect(()=>{setReady(true);const currentCamera=camera.current;return()=>{if(currentCamera)gsap.killTweensOf(currentCamera);};},[]);
  useLayoutEffect(()=>{
    if(!selected||!dialog.current||!room.current||!flight.current||!detail.current||!origin.current||!root.current)return;
    const reduced=matchMedia('(prefers-reduced-motion:reduce)');
    inspection.current=createInspection({dialog:dialog.current,room:room.current,flight:flight.current,detail:detail.current,origin:origin.current,desk:root.current,reduced:reduced.matches,onPhase:setPhase,onReturn:()=>{active.current=false;setSelected(null);}});
    const settle=()=>inspection.current?.close(true);
    window.addEventListener('resize',settle);reduced.addEventListener('change',settle);
    return()=>{window.removeEventListener('resize',settle);reduced.removeEventListener('change',settle);inspection.current?.dispose();inspection.current=null;};
  },[selected]);
  function select(object:DeskObject,button:HTMLButtonElement){
    if(active.current||!ready||!('showModal' in HTMLDialogElement.prototype))return;
    active.current=true;origin.current=button;
    if(camera.current){gsap.killTweensOf(camera.current);gsap.set(camera.current,{rotationX:0,rotationY:0});}
    setSelected(object);
  }
  function parallax(e:PointerEvent<HTMLDivElement>){
    if(active.current||e.pointerType!=='mouse'||!matchMedia('(hover:hover) and (prefers-reduced-motion:no-preference) and (min-width:900px)').matches)return;
    const r=e.currentTarget.getBoundingClientRect();gsap.to(camera.current,{rotationY:((e.clientX-r.x)/r.width-.5)*2,rotationX:-((e.clientY-r.y)/r.height-.5)*1.4,duration:.65,ease:'power2.out',overwrite:true});
  }
  function reset(){if(!active.current)gsap.to(camera.current,{rotationX:0,rotationY:0,duration:matchMedia('(prefers-reduced-motion:reduce)').matches?0:.5,overwrite:true});}
  function explore(){root.current?.querySelector<HTMLButtonElement>('[data-desk-object]')?.focus({preventScroll:true});}
  return <section ref={root} id="infinite-desk" className={styles.deskSection} data-motion={phase} data-selected={selected?.id??'none'} aria-labelledby="desk-title">
    <div className={styles.deskHeading}><div><span className={styles.kicker}>AN OPEN EXPLORATION</span><h2 id="desk-title" tabIndex={-1}>Nothing here is finished.<br/><em>That’s the point.</em></h2></div><div className={styles.deskInvitation}><p>One thought. Many ways to look at it.<br/>Pick up anything that catches your eye.</p><button type="button" onClick={explore} disabled={!ready}>Start exploring <ArrowUpRight size={16}/></button></div></div>
    <div className={styles.deskStage} onPointerMove={parallax} onPointerLeave={reset}>
      <div className={styles.deskRule}><span>THE INFINITE DESK</span><span>AN IDEA ABOUT HUMAN GESTURES</span><button type="button" onClick={reset} aria-label="Reset desk perspective"><RotateCcw size={13}/> Reset view</button></div>
      <div ref={camera} className={styles.camera} data-desk-camera><div className={styles.canvas}>
        <span className={styles.marginNote} aria-hidden="true">leave a little<br/>room for wonder.</span>
        {objects.map(object=><div key={object.id} className={styles.slot} data-slot={object.id}><button type="button" disabled={!ready} data-desk-object={object.id} className={styles.deskObject} aria-label={`Inspect ${object.label}`} onClick={e=>select(object,e.currentTarget)}><ObjectSurface object={object} thought={thought}/><span className={styles.pickUp} aria-hidden="true"><ArrowUpRight size={17}/></span></button></div>)}
        <span className={styles.deskSignature} aria-hidden="true">a thought can be a place.</span>
      </div></div>
      <div className={styles.deskLegend}><span>Fictional sample content · freely explore in any order</span><span>Not a live application or gesture-recognition demo.</span></div>
    </div>
    <details className={styles.readCollection}><summary>Prefer to read? Explore the same collection without the spatial view.</summary><div>{objects.map(object=><article key={object.id}><span>{object.category}</span><h3>{object.title}</h3><p>{object.description}</p><p>{object.capability}</p>{object.id==='thought'&&<blockquote>{thought}</blockquote>}{object.id==='observations'&&<ul>{observations.map(o=><li key={o.title}><strong>{o.title}</strong> {o.text}</li>)}</ul>}{object.id==='revisions'&&wordings.map(t=><blockquote key={t}>{t}</blockquote>)}{object.id==='studio'&&<a href="/images/studio.webp">View the authentic Studio capture ↗</a>}</article>)}</div></details>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="desk-inspector-title" onCancel={e=>{e.preventDefault();inspection.current?.close();}} onClick={e=>{if(e.target===e.currentTarget)inspection.current?.close();}}>
      {selected&&<><div className={styles.inspectorBar}><span>ARTHUR STUDIO <span>/ {selected.category}</span></span><button type="button" autoFocus onClick={()=>inspection.current?.close()}><ArrowLeft size={17}/> Return to Desk <kbd>Esc</kbd></button></div><div className={styles.inspection} data-inspection-kind={selected.id}><div ref={room} className={styles.visualRoom}><div ref={flight} className={styles.flight} data-flight><ObjectSurface object={selected} thought={thought}/></div></div><div ref={detail}><InspectorContent key={selected.id} object={selected} thought={thought} onThought={setThought}/></div></div></>}
    </dialog>
  </section>;
}
