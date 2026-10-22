import {gsap} from 'gsap';
type Point = readonly [number,number];
const links = [[0,5],[5,1],[5,2],[1,3],[2,4],[1,2]];
function curve(a:Point,b:Point) {
  const bend=(b[0]-a[0])*.48;
  return `M${a[0]} ${a[1]} C${a[0]+bend} ${a[1]},${b[0]-bend} ${b[1]},${b[0]} ${b[1]}`;
}
/** All beats share one spatial scene and one scroll clock. No frame swapping. */
export function createFilm(root:HTMLElement,mobile:boolean,compact=false) {
  const q=gsap.utils.selector(root);
  const nodes=q('[data-information]');
  const edges=q('[data-link]');
  const anchor:Point=mobile?[47,45]:[54,47];
  const knowledge:Point[]=mobile?[[50,47],[25,31],[76,33],[23,compact?62:67],[76,compact?62:67],[50,compact?75:79]]:[[49,50],[27,33],[72,31],[23,68],[77,69],[50,80]];
  const plan:Point[]=mobile?[[28,35],[69,37],[69,50],[69,63],[69,76],[28,60]]:[[26,50],[64,28],[64,42],[64,56],[64,70],[64,84]];
  const nexus:Point[]=mobile?[[23,34],[76,38],[76,compact?57:64],[76,24],[76,compact?74:78],[31,57]]:[[17,54],[62,35],[62,71],[86,35],[86,71],[39,54]];
  const tl=gsap.timeline({paused:true,defaults:{ease:'none'}});
  gsap.set(nodes,{left:`${anchor[0]}%`,top:`${anchor[1]}%`,autoAlpha:0,scale:.6});
  gsap.set(nodes[0],{autoAlpha:1,scale:1});
  gsap.set(q('[data-plan-label],[data-final-label]'),{autoAlpha:0,y:8});
  gsap.set(q('[data-knowledge-caption],[data-plan-rule],[data-nexus-caption]'),{autoAlpha:0});
  gsap.set(edges,{attr:{d:curve(anchor,anchor)},autoAlpha:0});
  gsap.set(q('[data-capture-surface]'),{scale:1.04,xPercent:2,yPercent:2});
  gsap.set(q('[data-orchestration-space]'),{autoAlpha:0,scale:1.08,xPercent:8,yPercent:4});
  gsap.set(q('[data-camera]'),{scale:mobile?1.08:1.28,xPercent:mobile?-2:-7,yPercent:3,rotation:.5});
  gsap.set(q('[data-idea-text]'),{clipPath:'inset(0 100% 0 0)'});
  tl.to({}, {duration:1});
  tl.to(q('[data-idea-text]'),{clipPath:'inset(0 0% 0 0)',duration:.115,ease:'power1.inOut'},.015)
    .to(q('[data-capture-surface]'),{scale:1,xPercent:0,yPercent:0,duration:.23},0)
    .to(q('[data-opening-title]'),{autoAlpha:0,y:-25,duration:.09},.14)
    .to(q('[data-camera]'),{scale:1,xPercent:0,yPercent:0,rotation:0,duration:.30,ease:'power1.inOut'},.12)
    .to(q('[data-capture-surface]'),{autoAlpha:0,scale:.82,xPercent:-8,yPercent:-10,duration:.27},.14)
    .to(q('[data-knowledge-caption]'),{autoAlpha:1,y:0,duration:.08},.25);
  tl.to(nodes[0],{width:mobile?170:310,duration:.22,ease:'power2.inOut'},.16);
  tl.to(q('[data-idea-text]'),{fontSize:mobile?24:32,duration:.22},.16);
  nodes.forEach((node,i)=>{
    const at=.16+i*.018;
    tl.to(node,{autoAlpha:1,left:`${knowledge[i][0]}%`,top:`${knowledge[i][1]}%`,scale:i===0?.85:1,duration:.22,ease:'power2.inOut'},at);
  });
  edges.forEach((edge,i)=>{
    const a=0,b=i===0?5:i===1?1:i===2?2:i===3?3:i===4?4:2;
    tl.to(edge,{attr:{d:curve(knowledge[a],knowledge[b])},autoAlpha:.65,duration:.22,ease:'power1.inOut'},.21+i*.015);
  });
  tl.to(q('[data-camera]'),{scale:mobile?.94:1.08,xPercent:mobile?0:6,yPercent:-2,duration:.20,ease:'power1.inOut'},.43)
    .to(q('[data-knowledge-caption]'),{autoAlpha:0,y:-16,duration:.06},.46)
    .to(q('[data-thought-label]'),{autoAlpha:0,y:-8,duration:.06},.50)
    .to(q('[data-plan-label]'),{autoAlpha:1,y:0,duration:.08},.55)
    .to(q('[data-plan-rule]'),{autoAlpha:1,duration:.08},.55);
  tl.to(nodes[0],{width:mobile?160:240,duration:.21},.45);
  nodes.forEach((node,i)=>tl.to(node,{left:`${plan[i][0]}%`,top:`${plan[i][1]}%`,scale:1,duration:.16,ease:'power2.inOut'},.45+i*.008));
  edges.forEach((edge,i)=>tl.to(edge,{attr:{d:curve(plan[0],plan[i===0?5:i===1?1:i===2?2:i===3?3:i===4?4:2])},autoAlpha:.35,duration:.16,ease:'power1.inOut'},.46+i*.008));
  tl.to(q('[data-camera]'),{scale:1,xPercent:0,yPercent:0,duration:.25,ease:'power2.inOut'},.70)
    .to(q('[data-plan-rule]'),{autoAlpha:0,duration:.07},.69)
    .to(q('[data-orchestration-space]'),{autoAlpha:.6,scale:1,xPercent:0,yPercent:0,duration:.27,ease:'power2.inOut'},.68)
    .to(root,{'--concept-accent':'#b59cfa','--concept-rgb':'169,139,236',backgroundColor:'#100e18',duration:.27},.66)
    .to(q('[data-plan-label]'),{autoAlpha:0,y:-7,duration:.07},.73)
    .to(q('[data-final-label]'),{autoAlpha:1,y:0,duration:.08},.79)
    .to(q('[data-nexus-caption]'),{autoAlpha:1,duration:.10},.81);
  tl.to(nodes[0],{width:mobile?140:220,duration:.22},.70);
  nodes.forEach((node,i)=>tl.to(node,{left:`${nexus[i][0]}%`,top:`${nexus[i][1]}%`,scale:1,duration:.22,ease:'power2.inOut'},.70+i*.009));
  edges.forEach((edge,i)=>tl.to(edge,{attr:{d:curve(nexus[links[i][0]],nexus[links[i][1]])},autoAlpha:.85,duration:.23,ease:'power1.inOut'},.70+i*.008));
  // A single restrained trace follows each conceptual dependency; no success status.
  q('[data-trace]').forEach((path,i)=>{
    tl.set(path,{attr:{d:curve(nexus[links[i][0]],nexus[links[i][1]])}},.88)
      .fromTo(path,{attr:{'stroke-dashoffset':1},autoAlpha:0},{attr:{'stroke-dashoffset':0},autoAlpha:.9,duration:.075},.89+i*.004)
      .to(path,{autoAlpha:0,duration:.025},.965+i*.002);
  });
  return tl;
}
