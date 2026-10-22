'use client';
import { nativeTrace } from './nativeTrace';
import { clamp, curve, curvePoint, smooth, type FeatureMotion } from './useFeatureMotion';
import styles from './motion.module.css';
export const widePoints = [[18,14],[80,14],[30,32],[55,50],[83,50],[45,72],[83,90],[15,88]];
export const compactPoints = [[23,13],[77,13],[23,35],[77,35],[77,60],[23,60],[77,87],[23,87]];
export function NativeFlow({ motion, denied }: { motion: FeatureMotion; denied: boolean }) {
 const i=Math.min(8,Math.floor(motion.progress)),t=smooth(motion.progress-i);
 return <>{[widePoints,compactPoints].map((points,index)=>{const a=points[nativeTrace[i].node],b=points[nativeTrace[i+1].node],token=curvePoint(a,b,t);return <svg key={index} className={`${styles.nativeFlow} ${index?styles.compactFlow:styles.wideFlow}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
 {nativeTrace.slice(0,9).map((s,n)=>{const end=nativeTrace[n+1];return <path key={n} data-trace-path={n} data-flow={denied&&n===5?'denied':end.kind} d={curve(points[s.node],points[end.node])} pathLength="1" strokeDasharray="1" strokeDashoffset={1-clamp(motion.progress-n)} opacity={motion.progress>n?.85:0}/>;})}
 {motion.state!=='idle'&&<ellipse data-trace-packet cx={token[0]} cy={token[1]} rx="1.15" ry="1.15" data-flow={denied&&motion.step===6?'denied':nativeTrace[motion.step].kind}/>}
 </svg>;})}</>;
}
export function NativeEvidence({ motion, denied }: { motion: FeatureMotion; denied: boolean }) {const item=nativeTrace[motion.step];const refusal=denied&&motion.step>=6;return <div className={styles.operation} data-operation={refusal?'denied':item.kind}><span>{refusal?'DENIED EXAMPLE / NO EXECUTION':`${item.kind.toUpperCase()} / ARCHITECTURAL ILLUSTRATION`}</span><h4>{refusal&&motion.step===6?'Refuse an unsupported proposal':item.title}</h4><p>{refusal&&motion.step===6?'Example: a mutating or unknown tool is proposed in the read-only inspection. The fixed catalog and strict argument checks refuse it; no arbitrary operation is forwarded.':item.detail}</p><small>{refusal?'Refusal remains explicit in the illustrative response. No tool is executed.':item.evidence}</small></div>;}
