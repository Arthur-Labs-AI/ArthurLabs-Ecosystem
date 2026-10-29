import {gsap} from 'gsap';
export type MotionPhase = 'idle'|'lifting'|'opening'|'open'|'closing';
type Elements = {dialog:HTMLDialogElement; flight:HTMLElement; room:HTMLElement; detail:HTMLElement; origin:HTMLButtonElement; desk:HTMLElement; reduced:boolean; onPhase:(p:MotionPhase)=>void; onReturn:()=>void};
/** The flight owns all moving geometry. CSS owns static desk-slot rotation only. */
export function createInspection({dialog,flight,room,detail,origin,desk,reduced,onPhase,onReturn}:Elements) {
  let timeline:gsap.core.Timeline|undefined, disposed=false, closing=false;
  const siblings=[...desk.querySelectorAll<HTMLElement>('[data-desk-object]')].filter(e=>e!==origin);
  const pagePosition={left:scrollX,top:scrollY};
  window.scrollTo({...pagePosition,behavior:'instant'});
  const initial=origin.getBoundingClientRect();
  const sourceParts=[...origin.querySelectorAll<HTMLElement>('span')];
  const flightParts=[...flight.querySelectorAll<HTMLElement>('span')];
  const materialStyles=(element:HTMLElement)=>{const s=getComputedStyle(element);return {fontSize:s.fontSize,paddingTop:s.paddingTop,paddingRight:s.paddingRight,paddingBottom:s.paddingBottom,paddingLeft:s.paddingLeft,gap:s.gap};};
  const partStyles=flightParts.map((element,i)=>({element,start:materialStyles(sourceParts[i]),end:materialStyles(element)}));
  const originalOverflow=document.body.style.overflow;
  const angle=Number(getComputedStyle(origin.parentElement!).getPropertyValue('--angle').replace('deg',''))||0;
  document.body.style.overflow='hidden';
  dialog.showModal();dialog.scrollTop=0;
  // Native dialog focus must never relocate the underlying desk.
  window.scrollTo({...pagePosition,behavior:'instant'});
  const bounds=()=>{
    const source=origin.getBoundingClientRect(),target=room.getBoundingClientRect();
    return {x:source.x+source.width/2-target.x-origin.offsetWidth/2,y:source.y+source.height/2-target.y-origin.offsetHeight/2,width:origin.offsetWidth,height:origin.offsetHeight,rotation:angle,scale:1};
  };
  const target=()=>({x:0,y:0,width:room.clientWidth,height:room.clientHeight,rotation:0,scale:1});
  const start=()=>{const r=room.getBoundingClientRect();return {x:initial.x+initial.width/2-r.x-origin.offsetWidth/2,y:initial.y+initial.height/2-r.y-origin.offsetHeight/2,width:origin.offsetWidth,height:origin.offsetHeight,rotation:angle,scale:1};};
  gsap.set(origin,{visibility:'hidden'});
  gsap.set(flight,{...start(),transformOrigin:'50% 50%',opacity:1});
  gsap.set(detail,{opacity:reduced?1:0,y:reduced?0:14});
  if(!reduced)partStyles.forEach(p=>gsap.set(p.element,p.start));
  onPhase(reduced?'open':'lifting');
  if(reduced){gsap.set(flight,target());gsap.set(dialog,{'--inspection-shade':1});gsap.set(siblings,{opacity:.3});}
  else {
    gsap.set(dialog,{'--inspection-shade':0});
    timeline=gsap.timeline();
    timeline.to(flight,{y:'-=20',scale:1.035,rotation:angle-1.5,duration:.18,ease:'power2.out'})
      .add(()=>onPhase('opening'))
      .to(dialog,{'--inspection-shade':1,duration:.45},.16)
      .to(siblings,{opacity:.28,scale:.96,duration:.5,ease:'power2.out'},.16)
      .to(flight,{...target(),duration:.8,ease:'power3.inOut'},.18)
      .to(detail,{opacity:1,y:0,duration:.32,ease:'power2.out'},.65)
      .add(()=>onPhase('open'));
    partStyles.forEach(p=>timeline!.to(p.element,{...p.end,duration:.8,ease:'power3.inOut'},.18));
  }
  function finish(){
    if(disposed)return;
    gsap.set([origin,...siblings],{clearProps:'visibility,opacity,transform'});
    dialog.close();document.body.style.overflow=originalOverflow;
    window.scrollTo({...pagePosition,behavior:'instant'});
    onPhase('idle');origin.focus({preventScroll:true});onReturn();
  }
  function close(instant=false){
    if(disposed||(closing&&!instant))return;closing=true;timeline?.kill();onPhase('closing');
    if(instant||reduced){finish();return;}
    // Re-measure the live desk destination. Closing during expansion reverses from its actual current transform.
    timeline=gsap.timeline({onComplete:finish});
    timeline.to(detail,{opacity:0,y:8,duration:.14},0)
      .to(flight,{...bounds(),duration:.7,ease:'power3.inOut'},0)
      .to(dialog,{'--inspection-shade':0,duration:.4},.3)
      .to(siblings,{opacity:1,scale:1,duration:.45,ease:'power2.out'},.22);
    partStyles.forEach(p=>timeline!.to(p.element,{...p.start,duration:.7,ease:'power3.inOut'},0));
  }
  return {close,dispose(){disposed=true;timeline?.kill();gsap.killTweensOf([flight,detail,dialog,...siblings,...flightParts]);gsap.set([origin,...siblings],{clearProps:'visibility,opacity,transform'});if(dialog.open)dialog.close();document.body.style.overflow=originalOverflow;
    window.scrollTo({...pagePosition,behavior:'instant'});}};
}
