'use client';
import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {gsap} from 'gsap';
import {ScrollTrigger} from 'gsap/ScrollTrigger';
import {createFilm} from './createFilm';
import {beats,beatFor,information} from './story';
import styles from './concept.module.css';

export function ConceptFilm() {
  const root=useRef<HTMLElement>(null);
  const [beat,setBeat]=useState(0);
  useEffect(()=>{
    gsap.registerPlugin(ScrollTrigger);
    const media=gsap.matchMedia();
    media.add({mobile:'(max-width:760px)',desktop:'(min-width:761px)',compact:'(max-height:740px)',reduced:'(prefers-reduced-motion:reduce)'},context=>{
      if(!root.current)return;
      const element=root.current;
      if(context.conditions?.reduced){element.dataset.motion='reduced';element.dataset.ready='true';return;}
      element.dataset.motion='scroll';
      const tl=createFilm(element,!!context.conditions?.mobile,!!context.conditions?.mobile && !!context.conditions?.compact);
      const update=(self:ScrollTrigger)=>{
        setBeat(beatFor(self.progress));
        element.dataset.progress=self.progress.toFixed(4);
        element.dataset.timeline=tl.progress().toFixed(4);
        element.style.setProperty('--film-progress',String(self.progress));
      };
      ScrollTrigger.create({id:'arthurlabs-concept-film',trigger:element,start:'top top',end:'bottom bottom',animation:tl,scrub:true,onUpdate:update,onRefresh:update});
      element.dataset.ready='true';
    },root);
    return()=>media.revert();
  },[]);
  function replay(){if(root.current){window.scrollTo({top:root.current.getBoundingClientRect().top+scrollY,behavior:'instant'});root.current.querySelector<HTMLElement>('#concept-title')?.focus({preventScroll:true});}}
  return <div className={styles.experiment}>
    <section ref={root} className={styles.film} id="concept-film" aria-labelledby="concept-title" data-concept-film data-motion="scroll" data-ready="false">
      <div className={styles.canvas} data-canvas>
        <div className={styles.topline}><span>ARTHURLABS / CREATIVE STUDY 01</span><a href="#concept-storyboard">Read the storyboard <span aria-hidden="true">↗</span></a></div>
        <div className={styles.openingTitle} data-opening-title><span className={styles.overline}>FROM THOUGHT TO CREATION</span><h1 id="concept-title" tabIndex={-1}>Before anything is built,<br/><em>something is imagined.</em></h1></div>
        <div className={styles.captureSurface} data-capture-surface aria-hidden="true">
          <span>ARTHUR STUDIO / CAPTURE</span><div className={styles.captureLine}/><small>ONE THOUGHT. ROOM TO GROW.</small>
        </div>
        <div className={styles.orchestrationSpace} data-orchestration-space aria-hidden="true">
          <svg viewBox="0 0 1000 1000" preserveAspectRatio="none"><path d="M170 340V780 M390 340V780 M620 260V790 M860 260V790"/></svg>
          <span className={styles.environmentLabel}>CONTEXT → COORDINATION → WORK PACKAGES</span>
        </div>
        <div className={styles.knowledgeCaption} data-knowledge-caption><span>ARTHUR STUDIO / CONNECTED KNOWLEDGE</span><strong>Nothing begins<br/>in isolation.</strong></div>
        <div className={styles.nexusCaption} data-nexus-caption><span>NEXUS / ORCHESTRATION</span><strong>A thought,<br/><em>ready to become.</em></strong></div>
        <div className={styles.camera} data-camera aria-hidden="true">
          <svg className={styles.connections} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {Array.from({length:6},(_,i)=><path key={i} data-link pathLength="1" d="M54 47C54 47 54 47 54 47"/>)}
            {Array.from({length:6},(_,i)=><path key={`trace-${i}`} data-trace pathLength="1" strokeDasharray=".08 .92" strokeDashoffset="1" className={styles.trace} d="M54 47C54 47 54 47 54 47"/>)}
          </svg>
          <div className={styles.planRule} data-plan-rule aria-hidden="true"><span>PROJECT / OFFLINE 001</span><strong>The shape of the work.</strong><span>INTENTION → REQUIREMENTS → CONTEXT</span></div>
          {information.map((item,index)=><div key={item.id} className={`${styles.information} ${index===0?styles.rootNode:''}`} data-information={item.id}>
            <span className={styles.nodeIndex}>{index===0?'THE IDEA':`0${index}`}</span>
            <div className={styles.nodeText}>
              <span className={styles.thought} data-thought-label><strong {...(index===0?{'data-idea-text':true}:{})}>{item.thought}</strong></span>
              <span className={styles.plan} data-plan-label><strong>{item.plan}</strong><small>{index===0?'Offline-first task manager':item.thought}</small></span>
              <span className={styles.final} data-final-label><strong>{index===0?item.plan:item.detail}</strong><small>{item.final}</small></span>
            </div>
            <span className={styles.nodePin} aria-hidden="true"/>
          </div>)}
        </div>
        <div className={styles.caption} aria-live="polite" aria-atomic="true"><span>{beats[beat].label}</span><p>{beats[beat].text}</p></div>
        <div className={styles.filmFooter}><span>CONCEPTUAL WORKFLOW · NO LIVE EXECUTION</span><span className={styles.scrollHint}>SCROLL TO FOLLOW THE THOUGHT <span aria-hidden="true">↓</span></span></div>
        <div className={styles.progress} aria-hidden="true"/>
      </div>
    </section>
    <h1 className={styles.reducedTitle}>From thought to creation.</h1>
    <section id="concept-storyboard" className={styles.storyboard} aria-labelledby="storyboard-title" tabIndex={-1}>
      <div className={styles.storyboardIntro}><span className={styles.overline}>ONE TRANSITION / A CREATIVE EXPERIMENT</span><h2 id="storyboard-title">The idea is the thread.</h2><p>This is a conceptual study of information moving from Arthur Studio to Nexus. The capture surface, idea, relationships, plan and orchestration graph are crisp, illustrative elements—not a running application interface. No application task runs here.</p></div>
      <ol>{beats.map((item,i)=><li key={item.label}><span>{item.label}</span><h3>{item.title}</h3><p>{item.text}</p>{i===1?<div className={styles.staticConnections}>Idea <span>↔</span> Constraints <span>↔</span> Requirements</div>:i===3?<div className={styles.staticConnections}>Context <span>→</span> Orchestration <span>→</span> Work packages</div>:null}</li>)}</ol>
      <p className={styles.architectureNote}>The wider intended workflow is Arthur Studio → Nexus → Sentry → Nexus → Arthur Studio. This experiment stops at Nexus. Independent verification and the return journey are not implemented here.</p>
      <div className={styles.endActions}><button type="button" onClick={replay}>Replay the transition <span aria-hidden="true">↥</span></button><Link href="/suite">Return to the current Suite page <span aria-hidden="true">↗</span></Link></div>
    </section>
  </div>;
}
