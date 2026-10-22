import {gsap} from 'gsap';
import {ScrollTrigger} from 'gsap/ScrollTrigger';
import {harnesses,stageAt,type HarnessId,type Scope} from './data';
import {cameraPose,chamberPose,curve,curvePoint,mix,segment,clamp} from './geometry';
export type FilmConfig={selected:readonly HarnessId[];scope:Scope;focus:HarnessId};
export function createRenderer(root:HTMLElement,mobile:boolean,getConfig:()=>FilmConfig,onStage:(stage:number)=>void){
 const find=(s:string)=>root.querySelector(s)!;
 const attr=(e:Element,key:string,value:string|number)=>e.setAttribute(key,String(value));
 const opacity=(e:Element,n:number)=>attr(e,'opacity',n.toFixed(4));
 const svg=find('[data-pipeline]'),camera=find('[data-chamber-camera]'),entry=find('[data-entry-line]'),revision=find('[data-revision]'),surface=find('[data-revision-surface]'),manifest=find('[data-manifest]'),frame=find('[data-manifest-frame]'),freeze=find('[data-freeze-corners]'),runtime=find('[data-runtime-boundary]'),junction=find('[data-junction]'),outline=find('[data-overview-outline]'),report=find('[data-run-report]') as HTMLElement;
 const lanes=harnesses.map(h=>({h,branch:find(`[data-branch=${h.id}]`),packet:find(`[data-flow-packet=${h.id}]`),chamber:find(`[data-chamber=${h.id}]`),surface:find(`[data-chamber=${h.id}] foreignObject`),card:find(`[data-harness-card=${h.id}]`),detail:find(`[data-chamber=${h.id}] [data-chamber-detail]`) as HTMLElement,status:find(`[data-chamber=${h.id}] [data-card-status]`),outcome:find(`[data-chamber=${h.id}] [data-card-outcome]`) as HTMLElement,highlight:find(`[data-chamber=${h.id}] [data-code-highlight]`) as HTMLElement,finding:find(`[data-chamber=${h.id}] [data-finding]`) as HTMLElement,result:find(`[data-result-path=${h.id}]`),resultPacket:find(`[data-result-packet=${h.id}]`),slot:find(`[data-result-slot=${h.id}]`)}));
 attr(svg,'viewBox',mobile?'0 0 360 370':'0 0 1000 760');
 return(p:number)=>{
  const cfg=getConfig(),center=mobile?180:500,cameraAt=cameraPose(p,mobile,cfg.focus),split=segment(p,.17,.32),junctionAt={x:center,y:600},scene=stageAt(p),reportIn=segment(p,.84,.94);
  root.dataset.progress=p.toFixed(5);root.dataset.stage=String(scene);root.dataset.split=split.toFixed(5);root.dataset.selected=cfg.selected.join(',');root.style.setProperty('--chamber-progress',String(p));onStage(scene);
  attr(camera,'transform',`translate(${center} ${mobile?185:380}) scale(${cameraAt.s}) translate(${-cameraAt.x} ${-cameraAt.y})`);opacity(camera,1-reportIn);
  attr(entry,'d',`M${center} 65V600`);attr(entry,'stroke-dashoffset',1-segment(p,0,.18));
  attr(runtime.querySelector('rect')!,'x',mobile?12:65);attr(runtime.querySelector('rect')!,'width',mobile?336:870);attr(runtime.querySelector('text')!,'x',mobile?24:90);opacity(runtime,segment(p,.01,.08));
  attr(revision,'transform',`translate(${center} ${mix(170,420,segment(p,0,.13))})`);opacity(revision,1-segment(p,.21,.35)*.35);
  const half=mobile?145:185;attr(surface,'x',-half);attr(surface,'width',half*2);attr(surface,'rx',mix(16,3,segment(p,.06,.15)));
  attr(manifest,'transform',`translate(${center} 420)`);opacity(manifest,segment(p,.055,.16));attr(frame,'x',mobile?-164:-220);attr(frame,'width',mobile?328:440);attr(freeze,'transform',mobile?'scale(.74 1)':'scale(1)');
  find('[data-scope-label]').textContent=cfg.scope==='full'?'FULL QA / FROZEN MANIFEST':'TARGETED / src/tasks.ts IN MANIFEST';
  attr(junction,'cx',center);opacity(junction,segment(p,.14,.21));attr(junction,'r',mix(3,8,split));
  lanes.forEach((lane,i)=>{
   const pose=chamberPose(p,i,mobile),enabled=cfg.selected.includes(lane.h.id),from={x:pose.x,y:pose.y-pose.height/2},end={x:mobile?180:280+i*220,y:mobile?1930+i*66:1930},start={x:pose.x,y:pose.y+pose.height/2},bend=mobile?(i-1)*130:0;
   attr(lane.branch,'d',curve(junctionAt,from,bend));attr(lane.branch,'stroke-dashoffset',1-segment(p,.17+i*.009,.32+i*.004));opacity(lane.branch,enabled?.85:.13);attr(lane.branch,'data-executing',enabled&&p>=.2&&p<.6?'true':'false');
   const inputProgress=segment(p,.22+i*.012,.45+i*.012),packet=curvePoint(junctionAt,from,inputProgress,bend);attr(lane.packet,'cx',packet.x);attr(lane.packet,'cy',packet.y);opacity(lane.packet,enabled&&p>.20&&p<.47?Math.sin(inputProgress*Math.PI):0);
   attr(lane.chamber,'transform',`translate(${pose.x} ${pose.y})`);opacity(lane.chamber,segment(p,.17+i*.004,.25+i*.004)*(enabled?1:.25));
   attr(lane.surface,'x',-pose.width/2);attr(lane.surface,'y',-pose.height/2);attr(lane.surface,'width',pose.width);attr(lane.surface,'height',pose.height);attr(lane.card,'data-selected',String(enabled));attr(lane.card,'data-terminal',String(p>=.60));
   const details=segment(p,.34,.43)*(1-segment(p,.58,.65));lane.detail.style.opacity=String(details*(enabled?1:0));lane.detail.style.visibility=details>.01?'visible':'hidden';lane.detail.inert=details<.5;
   lane.status.textContent=!enabled?'Not selected · no execution':p<.35?'Private workspace':p<.6?'Illustrative investigation':lane.h.outcome;
   lane.outcome.style.opacity=String(enabled?segment(p,.59,.67):0);lane.highlight.style.transform=`translateY(${mix(0,32,segment(p,.47,.56))}px)`;lane.highlight.style.opacity=String(enabled?segment(p,.46,.51):0);lane.finding.style.opacity=String(enabled?segment(p,.51,.58):0);
   attr(lane.result,'d',curve(start,end,mobile?(i-1)*80:0));attr(lane.result,'stroke-dashoffset',1-segment(p,.7,.89));opacity(lane.result,enabled?segment(p,.68,.73)*.7:0);
   const out=segment(p,.72+i*.008,.89+i*.008),point=curvePoint(start,end,out,mobile?(i-1)*80:0);attr(lane.resultPacket,'transform',`translate(${point.x} ${point.y})`);opacity(lane.resultPacket,enabled&&p>.71&&p<.92?Math.sin(out*Math.PI):0);opacity(lane.slot,enabled?1:.15);
   if(mobile){const rect=lane.slot.querySelector('rect')!;attr(rect,'x',30);attr(rect,'y',1890+i*75);attr(rect,'width',300);attr(rect,'height',65);lane.slot.querySelectorAll('text').forEach((text,j)=>{attr(text,'x',44);attr(text,'y',1915+i*75+j*23);});}
  });
  opacity(outline,segment(p,.75,.88));const rect=outline.querySelector('rect')!;attr(rect,'x',mobile?12:50);attr(rect,'width',mobile?336:900);outline.querySelector('text')?.setAttribute('x',mobile?'28':'80');attr(find('[data-overview-note]'),'x',center);
  report.style.opacity=String(reportIn);report.style.transform=`translateY(${mix(38,0,reportIn)}px) scale(${mix(.93,1,reportIn)})`;report.style.clipPath=`inset(${mix(40,0,reportIn)}% 0 0)`;report.inert=p<.855;report.setAttribute('aria-hidden',String(p<.855));report.style.visibility=p<.82?'hidden':'visible';
 };
}
export function createChamber(root:HTMLElement,mobile:boolean,config:()=>FilmConfig,onStage:(s:number)=>void){
 gsap.registerPlugin(ScrollTrigger);const clock={p:0},render=createRenderer(root,mobile,config,onStage);const timeline=gsap.timeline({paused:true,onUpdate:()=>render(clock.p)}).to(clock,{p:1,duration:1,ease:'none'});
 const trigger=ScrollTrigger.create({trigger:root,start:()=>`top ${parseFloat(getComputedStyle(root).getPropertyValue('--nav'))||74}px`,end:'bottom bottom',animation:timeline,scrub:true,invalidateOnRefresh:true,onRefresh:()=>render(clock.p)});
 render(clock.p);return{trigger,render:()=>render(clock.p),destroy(){trigger.kill();timeline.kill();}};
}
