import {stagePositions,type HarnessId} from './data';
export type Point={x:number;y:number};
export const clamp=(n:number)=>Math.max(0,Math.min(1,n));
export const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
export function segment(p:number,a:number,b:number){const t=clamp((p-a)/(b-a));return t*t*(3-2*t);}
export function curve(a:Point,b:Point,bend=0){return `M${a.x} ${a.y} C${a.x+bend} ${mix(a.y,b.y,.45)},${b.x} ${mix(a.y,b.y,.5)},${b.x} ${b.y}`;}
export function curvePoint(a:Point,b:Point,t:number,bend=0){const q=1-t;return{x:q*q*q*a.x+3*q*q*t*(a.x+bend)+3*q*t*t*b.x+t*t*t*b.x,y:q*q*q*a.y+3*q*q*t*mix(a.y,b.y,.45)+3*q*t*t*mix(a.y,b.y,.5)+t*t*t*b.y};}
export function chamberPose(p:number,i:number,mobile:boolean){const split=segment(p,.17,.32),expand=segment(p,.32,.43),compact=segment(p,.59,.68),center=mobile?180:500;
 const spread=(mobile?[70,180,290]:[180,500,820])[i];
 return{x:mix(mix(center,spread,split),mobile?180:spread,expand),y:mix(mix(mobile?650:720,(mobile?[735,870,1005]:[970,970,970])[i],split),(mobile?[1100,1450,1800]:[1100,1100,1100])[i],expand)*(1-compact)+(mobile?[1250,1370,1490]:[1250,1250,1250])[i]*compact,width:mix(mobile?112:240,mobile?300:250,expand),height:mix(mix(mobile?112:84,330,expand),100,compact)};
}
export function cameraPose(p:number,mobile:boolean,focus:HarnessId){const index=['opencode','deepseek','glm'].indexOf(focus),focusX=[310,500,690][index];
 const poses=mobile?[{x:180,y:210,s:1},{x:180,y:420,s:1},{x:180,y:820,s:.72},{x:180,y:[1100,1450,1800][index],s:1},{x:180,y:[1100,1450,1800][index],s:1.04},{x:180,y:1370,s:.93},{x:180,y:1770,s:.8},{x:180,y:2030,s:1},{x:180,y:2050,s:1}]:[{x:500,y:210,s:1.14},{x:500,y:440,s:1.08},{x:500,y:760,s:.82},{x:500,y:1100,s:.97},{x:focusX,y:1090,s:1.6},{x:500,y:1260,s:.92},{x:500,y:1630,s:.86},{x:500,y:1990,s:.95},{x:500,y:2020,s:1}];
 let next=stagePositions.findIndex(at=>at>p);if(next<0)next=8;if(next===0)next=1;const prev=next-1,t=segment(p,stagePositions[prev],stagePositions[next]);return{x:mix(poses[prev].x,poses[next].x,t),y:mix(poses[prev].y,poses[next].y,t),s:mix(poses[prev].s,poses[next].s,t)};
}
