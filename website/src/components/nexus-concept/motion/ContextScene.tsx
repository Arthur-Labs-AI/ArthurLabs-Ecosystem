'use client';
import type { CSSProperties } from 'react';
import { sessionRecords, dispositionInfo } from '../features/data';
import { mix, smooth, type FeatureMotion } from './useFeatureMotion';
import styles from './motion.module.css';
export const contextStages=['Working history','Track identities','Group related state','Retain references','Explain reduction','Continuation view'] as const;
function target(stage:number,i:number,mobile:boolean){const r=sessionRecords[i];const group=['preserved','reorganized','referenced','reduced'].indexOf(r.kind);const ordinal=sessionRecords.filter(x=>x.kind===r.kind).findIndex(x=>x.id===r.id);
 let x=mobile?(i%2?75:25):16+(i%3)*34,y=mobile?95+Math.floor(i/2)*85:92+Math.floor(i/3)*90;
 if(stage>=2){if(mobile){x=group%2?75:25;y=105+Math.floor(group/2)*300+ordinal*82;}else{x=12.5+group*25;y=112+ordinal*100;}}
 if(stage===2&&group>=2){x=mobile?(i%2?75:25):16+(i%3)*34;y=mobile?95+Math.floor(i/2)*85:92+Math.floor(i/3)*90;}
 if(stage===3&&group===3){x=mobile?75:88;y=mobile?405+ordinal*82:112+ordinal*100;}
 return{x,y};}
export function ContextScene({motion,onSelect,selected}:{motion:FeatureMotion;onSelect:(id:string)=>void;selected:string}){
 const s=motion.step,f=smooth(motion.progress-s);
 return <div className={styles.contextScene} data-context-scene><div className={styles.contextStage}>
 <div className={styles.contextLayers} style={{opacity:Math.min(1,Math.max(0,motion.progress-1))}}>{Object.entries(dispositionInfo).map(([kind,v],i)=><span key={kind} data-treatment={kind} style={{'--layer-x':i*25+'%','--layer-cx':(i%2?50:0)+'%','--layer-cy':(i<2?40:340)+'px'} as CSSProperties}>{v.label}</span>)}</div>
 <span className={styles.contextHeading}>{s<2?'ONE AUTHORED SESSION / STABLE RECORD IDENTITIES':'CONTINUATION REPRESENTATION / NO DURABLE WRITE'}</span>
 {sessionRecords.map((r,i)=>{const a=target(s,i,false),b=target(Math.min(5,s+1),i,false),ca=target(s,i,true),cb=target(Math.min(5,s+1),i,true);const reduced=s>=4&&r.kind==='reduced', arrival=i<3?1:smooth(motion.progress*1.6-i*.08);return <button key={r.id} data-context-record={r.id} data-treatment={r.kind} aria-label={`Inspect context record ${i+1}: ${r.name}`} aria-pressed={selected===r.id} onClick={()=>{motion.pause();onSelect(r.id);}} style={{'--record-x':`${mix(a.x,b.x,f)}%`,'--record-cx':`${mix(ca.x,cb.x,f)}%`,'--record-y':(mix(a.y,b.y,f)+(1-arrival)*24)+'px','--record-cy':(mix(ca.y,cb.y,f)+(1-arrival)*24)+'px',opacity:.32+.68*arrival,width:s>=2?'22%':'29%',height:reduced?62:76,transform:`translateX(-50%) scale(${mix(s===1?1+Math.sin(i*.8)*.025:1,s+1===1?1+Math.sin(i*.8)*.025:1,f)})`} as CSSProperties}><span className={styles.identityTag}>C{String(i+1).padStart(2,'0')} <i style={{opacity:Math.min(1,motion.progress)}}>↔</i></span><strong>{r.name}</strong><small>{s>=3?dispositionInfo[r.kind].label:'Working history'}</small></button>;})}
 <div className={styles.continuity} style={{opacity:Math.max(0,motion.progress-4)}}>Same identities. Grounded state, open work and evidence references.</div>
 </div></div>;
}
