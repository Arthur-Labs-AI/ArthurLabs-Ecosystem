'use client';
import { novaSteps } from '../features/data';
import { clamp, mix, smooth, curve, curvePoint, type FeatureMotion } from './useFeatureMotion';
import styles from './motion.module.css';
const names=['Objective','Requirements','Plan','Storage work','Task interactions','Registry metadata','Storage worker','Interaction worker','Evidence package','Sentry','Findings'];
const subtitles=['User intent','Local data + open questions','Coordinator · planned','Define local behavior','Depends on storage','Role + route constraints','Conceptual coding role','Conceptual coding role','Observations ≠ verification','Separate application','Reject empty titles'];
const appears=[0,1,2,3,3,4,5,5,6,7,8];
function layout(stage:number,mobile:boolean){
 const base=mobile?[[240,40],[240,125],[240,215],[120,320],[360,320],[360,125],[120,430],[360,430],[240,535],[350,535],[120,535]]:[[480,50],[480,140],[480,230],[250,330],[710,330],[800,140],[250,440],[710,440],[480,550],[790,510],[200,510]];
 return base.map((p,i)=>{let [x,y]=p;let scale=1;
  if(stage===0){x=mobile?240:480;y=mobile?280:290;scale=i===0?1.55:.3;}
  if(stage===1&&i===1){y=mobile?280:300;scale=1.25;}
  if(stage===2&&i===2){y=mobile?300:330;scale=1.2;}
  if(mobile&&stage>=4&&i===1)x=120;
  if(stage>=6){if(i===0)y=mobile?35:40;if(i===1)y=mobile?125:130;if(i===2)y=mobile?215:220;if(i===3||i===4)y=mobile?320:330;if(i===6||i===7)y=mobile?430:435;}
  if(stage>=7){if(i===8){x=mobile?125:440;y=mobile?535:530;}if(i===9){x=mobile?355:800;y=mobile?535:530;}}
  if(stage===8&&i===10){x=mobile?240:480;y=mobile?605:610;}
  const opacity=i===0?1:stage>=appears[i]?1:0;
  return {x,y,scale,opacity:stage>=6&&(i===0||i===1)?.28:opacity};
 });
}
const edges=[[0,1,0],[1,2,1],[2,3,2],[2,4,2],[3,4,2.3],[5,2,3],[3,6,4],[4,7,4],[6,8,5],[7,8,5.25],[8,9,6],[9,10,7],[10,2,7.35]];
export function NovaScene({motion}:{motion:FeatureMotion}){
 const s=motion.step,f=smooth(motion.progress-s);
 return <div className={styles.novaScene} data-nova-scene>{[false,true].map(mobile=>{
  const from=layout(s,mobile),to=layout(Math.min(8,s+1),mobile);
  const nodes=from.map((p,i)=>({x:mix(p.x,to[i].x,f),y:mix(p.y,to[i].y,f),scale:mix(p.scale,to[i].scale,f),opacity:mix(p.opacity,to[i].opacity,f)}));
  const w=mobile?480:960,h=mobile?680:670;
  return <svg key={String(mobile)} className={mobile?styles.mobileScene:styles.desktopScene} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Planned Nova architecture, stage ${s+1}. ${novaSteps[s].title}. Separate Sentry verification.`}>
   <text className={styles.sceneLabel} x="20" y="22">ARCHITECTURAL SIMULATION / NOT A RUNNING TASK</text>
   {edges.map(([a,b,start],i)=>{const na=nodes[a],nb=nodes[b],p=clamp((motion.progress-start)/(i===12?8-start:1)),d=curve([na.x,na.y],[nb.x,nb.y]);const token=curvePoint([na.x,na.y],[nb.x,nb.y],smooth(p));return <g key={i} className={styles.novaLine} data-phase={b>=9?'verification':b>=6?'execution':'planning'}><path data-nova-edge={i} d={d} pathLength="1" strokeDasharray="1" strokeDashoffset={1-p} opacity={p>0?.8:0}/>{p>0&&p<1&&<circle data-nova-packet cx={token[0]} cy={token[1]} r={mobile?5:4}/>}</g>;})}
   {nodes.map((n,i)=>{const bw=mobile?190:215,bh=mobile?72:68;return <g key={names[i]} data-nova-node={i} data-geometry={`${n.x.toFixed(2)},${n.y.toFixed(2)},${n.scale.toFixed(3)}`} opacity={n.opacity} transform={`translate(${n.x} ${n.y}) scale(${n.scale})`} className={styles.novaActor} data-phase={i>=9?'verification':i===6||i===7||i===8?'execution':'planning'}>
    {i===9&&<rect x={-bw/2-9} y={-bh/2-10} width={bw+18} height={bh+20} rx="8" className={styles.externalBoundary}/>}
    <rect x={-bw/2} y={-bh/2} width={bw} height={bh} rx={i===0?bh/2:5}/><text y="-4" textAnchor="middle" className={styles.actorTitle}>{names[i]}</text><text y="18" textAnchor="middle" className={styles.actorSubtitle}>{subtitles[i]}</text>
    {(i===6||i===7)&&<text y="-43" textAnchor="middle" className={styles.workerStatus}>{s<6?'ILLUSTRATIVE ASSIGNMENT':'SAMPLE OBSERVATION RETURNED'}</text>}
   </g>;})}
   <text x={w/2} y={h-10} textAnchor="middle" className={styles.sceneFoot}>PLAN → BOUNDED WORK → EVIDENCE → INDEPENDENT FEEDBACK</text>
  </svg>;
 })}</div>;
}
