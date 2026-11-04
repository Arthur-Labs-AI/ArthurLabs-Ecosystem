import pcbnew as p,pathlib,json,hashlib,collections,re,math
p.SwigPyIterator.next=p.SwigPyIterator.__next__
import sys
CHECKPOINT=int(sys.argv[1])
D=pathlib.Path(__file__).resolve().parent;BASE='ARTHUR_EMG_RevA_Cost_Phase3B5B_OpAmpSupplyClean';CAND='ARTHUR_EMG_RevA_Cost_Phase3B5C_ClampRailCandidate'
def sha(n):return hashlib.sha256((D/n).read_bytes()).hexdigest()
def uid(t):return t.m_Uuid.AsString()
def xy(v):return [p.ToMM(v.x),p.ToMM(v.y)]
def parse(n):
 stack=[];root=None
 for t in re.findall(r'"(?:\\.|[^"\\])*"|[^\s()]+|[()]',(D/n).read_text()):
  if t=='(':x=[];stack[-1].append(x) if stack else None;stack.append(x)
  elif t==')':root=stack.pop()
  else:stack[-1].append(t)
 return root
def blocks(tree,tag):return [x for x in tree if isinstance(x,list) and x[0]==tag]
def zdefs(tree):return [[x for x in z if not(isinstance(x,list) and x[0] in ['filled_polygon','fill_segments'])] for z in blocks(tree,'zone')]
a=p.LoadBoard(str(D/(BASE+'.kicad_pcb')));b=p.LoadBoard(str(D/(CAND+'.kicad_pcb')));ta,tb=parse(BASE+'.kicad_pcb'),parse(CAND+'.kicad_pcb');added=json.loads((D/'phase3b5c_clamp_rail_added.json').read_text());checks={}
assert sha(BASE+'.kicad_pcb')=='350d90a013e0a1cfbe44a16e1b6b51dd9c177fac78fc8104aac2e37f2ee91777'
assert {x[0] for x in ta if isinstance(x,list)}=={x[0] for x in tb if isinstance(x,list)}
for tag in {x[0] for x in ta if isinstance(x,list)}-{'zone'}:
 ac=collections.Counter(json.dumps(x) for x in blocks(ta,tag));bc=collections.Counter(json.dumps(x) for x in blocks(tb,tag));removed=list((ac-bc).elements());extra=list((bc-ac).elements());checks[tag]={'before':sum(ac.values()),'after':sum(bc.values()),'removed_or_changed':len(removed),'added':len(extra)}
 assert not removed,(tag,checks[tag])
 assert len(extra)==sum(x['type']==tag for x in added) if tag in ['segment','via'] else not extra
assert zdefs(ta)==zdefs(tb)
oldids={uid(t) for t in a.GetTracks()};new=[t for t in b.GetTracks() if uid(t) not in oldids];assert {uid(t) for t in new}=={x['uuid'] for x in added};assert all(t.GetNetname()=='AFE_3V0' for t in new)
for x in added:
 t=next(t for t in new if uid(t)==x['uuid'])
 if x['type']=='segment':assert xy(t.GetStart())==x['start'] and xy(t.GetEnd())==x['end'] and p.ToMM(t.GetWidth())==x['width_mm'] and b.GetLayerName(t.GetLayer())==x['layer']
 else:assert xy(t.GetPosition())==x['position'] and t.GetViaType()==p.VIATYPE_THROUGH and p.ToMM(t.GetWidth(p.F_Cu))==.55 and p.ToMM(t.GetDrillValue())==.3
def conn(board):
 board.BuildConnectivity();c=board.GetConnectivity();r={};pads={}
 for f in board.GetFootprints():
  for pad in f.Pads():
   k=f.GetReference()+'.'+pad.GetNumber();pads[k]=pad
   if not pad.GetNetCode():continue
   items=c.GetConnectedItems(pad);r[k]={'net':pad.GetNetname(),'pads':sorted({k}|{x.GetParentFootprint().GetReference()+'.'+x.GetNumber() for x in items if isinstance(x,p.PAD)}),'zones':sorted({uid(x) for x in items if isinstance(x,p.ZONE)})}
 return r,pads
ca,pa=conn(a);cb,pads=conn(b);targets=[f'D{ch}0{diode}.2' for ch in range(1,CHECKPOINT+1) for diode in [1,2]];authority=ca['U4002.5']['pads'];combined=sorted(authority+targets)
assert all(ca[k]['pads']==[k] and cb[k]['pads']==combined for k in targets)
assert cb['U4002.5']['pads']==combined
assert all(ca[k]==cb[k] for k in ca if k not in combined)
def groups(c):return sorted({tuple(v['pads']) for v in c.values() if v['net']=='AFE_3V0'})
assert len(groups(ca))==12 and len(groups(cb))==12-2*CHECKPOINT
assert sum(len(g)-1 for g in groups(cb))==sum(len(g)-1 for g in groups(ca))+len(targets)
# Actual added copper to foreign track/via/pad copper on every common layer.
items=list(b.GetTracks())+list(pads.values());layers=[p.F_Cu,p.B_Cu,p.In1_Cu,p.In2_Cu]
def distance(sa,sb,limit=100.):
 hi=p.FromMM(limit)
 if not p.SHAPE.Collide(sa,sb,hi):return limit
 lo=0
 while hi-lo>1:
  mid=(hi+lo)//2
  if p.SHAPE.Collide(sa,sb,mid):hi=mid
  else:lo=mid
 return p.ToMM(lo)
def minclear(t):
 minimum=100.;witness=None
 for o in items:
  if o.GetNetCode()==t.GetNetCode():continue
  for l in layers:
   if not(t.GetLayerSet().Contains(l) and o.GetLayerSet().Contains(l)):continue
   d=distance(t.GetEffectiveShape(l),o.GetEffectiveShape(l),minimum)
   if d<minimum:minimum=d;witness={'uuid':uid(o),'net':o.GetNetname(),'layer':b.GetLayerName(l)}
 return {'minimum_foreign_track_via_pad_clearance_mm':minimum,'witness':witness}
clearances={uid(t):minclear(t) for t in new};minimum=min(v['minimum_foreign_track_via_pad_clearance_mm'] for v in clearances.values());assert minimum>=.2
pro=json.loads((D/(BASE+'.kicad_pro')).read_text());rules=pro['board']['design_settings']['rules'];viachecks=[]
for t in new:
 if not isinstance(t,p.PCB_VIA):continue
 assert not any(p.SHAPE.Collide(t.GetEffectiveShape(p.F_Cu),pad.GetEffectiveShape(p.F_Cu),0) for pad in pads.values() if pad.GetLayerSet().Contains(p.F_Cu))
 hole=p.SHAPE_CIRCLE(t.GetPosition(),t.GetDrillValue()//2);holemin=100.;holehole=100.
 for o in items:
  if uid(t)==uid(o):continue
  if o.GetNetCode()!=t.GetNetCode():
   for l in layers:
    if o.GetLayerSet().Contains(l):holemin=min(holemin,distance(hole,o.GetEffectiveShape(l),holemin))
  if isinstance(o,p.PCB_VIA):holehole=min(holehole,distance(hole,p.SHAPE_CIRCLE(o.GetPosition(),o.GetDrillValue()//2),holehole))
  elif isinstance(o,p.PAD) and o.GetDrillSize().x>0:holehole=min(holehole,distance(hole,p.SHAPE_CIRCLE(o.GetPosition(),max(o.GetDrillSize().x,o.GetDrillSize().y)//2),holehole))
 annulus=p.ToMM(t.GetWidth(p.F_Cu)-t.GetDrillValue())/2
 assert annulus>=rules['min_via_annular_width'] and p.ToMM(t.GetDrillValue())>=rules['min_through_hole_diameter'] and p.ToMM(t.GetWidth(p.F_Cu))>=rules['min_via_diameter'] and holemin>=rules['min_hole_clearance'] and holehole>=rules['min_hole_to_hole']
 viachecks.append({'uuid':uid(t),'position':xy(t.GetPosition()),'not_via_in_pad':True,'annulus_mm':annulus,'hole_to_foreign_copper_mm':holemin,'hole_to_existing_hole_mm':holehole,**clearances[uid(t)]})
planes=[];zones={};basezones={}
for za,zb in zip(a.Zones(),b.Zones()):
 if zb.GetIsRuleArea():continue
 l=zb.GetLayer();fa,fb=za.GetFilledPolysList(l),zb.GetFilledPolysList(l);v={'layer':b.GetLayerName(l),'before_polygons':fa.OutlineCount(),'after_polygons':fb.OutlineCount(),'after_islands':[i for i in range(fb.OutlineCount()) if zb.IsIsland(l,i)]};assert v['before_polygons']==v['after_polygons']==1 and not v['after_islands'];planes.append(v);zones[l]=zb;basezones[l]=za
assert len(planes)==2
# Sample adjacent GND at <=0.01 mm intervals. Only intentional new supply-via antipads (0.275 mm annulus radius + frozen 0.50 mm zone clearance) may be excluded.
reference={};newvias=[t for t in new if isinstance(t,p.PCB_VIA)]
for t in new:
 if isinstance(t,p.PCB_VIA):continue
 l=p.In1_Cu if t.GetLayer()==p.F_Cu else p.In2_Cu;z=zones[l];n=math.ceil(p.ToMM(t.GetLength())/.01);s,e=xy(t.GetStart()),xy(t.GetEnd());hits=excluded=existing_excluded=0;missing=[];void_intervals=[];void_start=None;last_void=None
 for i in range(n+1):
  x=s[0]+(e[0]-s[0])*i/n;y=s[1]+(e[1]-s[1])*i/n;q=p.VECTOR2I(p.FromMM(x),p.FromMM(y))
  if z.HitTestFilledArea(l,q):hits+=1
  elif any(math.dist([x,y],xy(v.GetPosition()))<=.8001 for v in newvias):excluded+=1
  elif not basezones[l].HitTestFilledArea(l,q):
   existing_excluded+=1
   if void_start is None:void_start=[x,y]
   last_void=[x,y]
  else:missing.append([x,y])
  is_oldvoid=not z.HitTestFilledArea(l,q) and not any(math.dist([x,y],xy(v.GetPosition()))<=.8001 for v in newvias) and not basezones[l].HitTestFilledArea(l,q)
  if not is_oldvoid and void_start is not None:void_intervals.append({'start':void_start,'end':last_void});void_start=last_void=None
 if void_start is not None:void_intervals.append({'start':void_start,'end':last_void})
 reference[uid(t)]={'adjacent_layer':b.GetLayerName(l),'samples':n+1,'gnd_hits':hits,'intentional_new_supply_via_antipad_samples':excluded,'pre_existing_gnd_void_samples':existing_excluded,'pre_existing_void_intervals':void_intervals,'unexplained_missing_samples':missing}
 assert not missing,(uid(t),missing[:5])
 
baseline=json.loads((D/'phase3b5c_clamp_rail_baseline_drc.json').read_text());candidate=json.loads((D/'phase3b5c_clamp_rail_candidate_drc.json').read_text())
def identities(r):return {(v['type'],tuple(sorted(i['uuid'] for i in v['items']))) for v in r['violations']}
assert identities(baseline)==identities(candidate)
assert len(candidate['violations'])==548 and len(candidate['unconnected_items'])==105-len(targets)
assert not any(v['type'] in ['clearance','shorting_items','tracks_crossing','dangling_track','dangling_via','hole_clearance','annular_width','via_diameter','drill_out_of_range'] for v in candidate['violations'])
snap=json.loads((D/'phase3b5c_clamp_rail_baseline_geometry.json').read_text());protected={n:sha(n)==h for n,h in snap['protected_file_sha256'].items()};assert all(protected.values())
freeze=json.loads((D/'phase3a_routing_freeze.json').read_text());freezehash={n:sha(n)==h for n,h in freeze['sha256'].items()};assert all(freezehash.values())
exception=json.loads((D/'phase3b5e_vcm_exception_added.json').read_text())
assert set(exception['added_uuids'])<=oldids
tracks=[t for t in new if not isinstance(t,p.PCB_VIA)]
r={'authoritative_input':BASE+'.kicad_pcb','input_sha256':sha(BASE+'.kicad_pcb'),'candidate_sha256':sha(CAND+'.kicad_pcb'),'target_connections':{k:True for k in targets},'authority_before':authority,'authority_after':combined,'afe_groups_before':groups(ca),'afe_groups_after':groups(cb),'afe_group_count_before':12,'afe_group_count_after':12-len(targets),'afe_missing_pairs_before':11,'afe_missing_pairs_after':11-len(targets),'expected_pair_delta':-len(targets),'unconnected_pairs_before':105,'unconnected_pairs_after':105-len(targets),'ordinary_drc_violations_before':548,'ordinary_drc_violations_after':548,'ordinary_drc_identities_identical':True,'track_length_mm':sum(p.ToMM(t.GetLength()) for t in tracks),'segment_count':len(tracks),'via_count':len(newvias),'track_widths_mm':sorted(set(p.ToMM(t.GetWidth()) for t in tracks)),'track_layers':sorted(set(b.GetLayerName(t.GetLayer()) for t in tracks)),'minimum_foreign_track_via_pad_clearance_mm':minimum,'minimum_zone_clearance_requirement_mm':.2,'zone_clearance_gate':'PASS: refilled KiCad DRC has zero clearance violations','per_object_clearance':clearances,'via_checks':viachecks,'structural_comparison':checks,'all_original_tracks_vias_footprints_preserved':True,'all_other_pad_connectivity_preserved':True,'unrelated_afe_groups_unchanged':True,'zone_definitions_preserved':True,'plane_fill_changes':'Derived fills regenerated for two new supply through-vias; zone definitions and original copper unchanged','ground_reference_limitation':'Pre-existing GND void and new signal-via antipad intervals are explicitly measured below; overall plane topology remains one polygon per layer with zero islands.','planes':planes,'in1_gnd_continuity':'PASS','in2_gnd_continuity':'PASS','isolated_gnd_polygons':0,'new_supply_via_antipad_nominal_radius_mm':.775,'antipad_classification_radius_mm':.8001,'antipad_classification_margin_mm':.0251,'ground_reference_samples':reference,'gnd_pad_connectivity_preserved':True,'no_ground_routed':True,'phase3b5a_preserved':True,'phase3b5e_preserved':True,'all_earlier_frozen_phases_preserved':True,'phase3a_vias_preserved':sum(isinstance(t,p.PCB_VIA) and t.GetNetname() in freeze['frozen_nets'] for t in a.GetTracks()),'protected_file_hash_checks':protected,'phase3a_manifest_hash_checks':freezehash,'new_copper_violations':0,'new_crossings':0,'new_shorts':0,'dangling_tracks':0,'dangling_vias':0,'ready_to_freeze_3b5b':True}
assert r['phase3a_vias_preserved']==14
r['clearances_below_0_22mm']=[{'uuid':x['uuid'],'type':x['type'],'role':x.get('role','shared feed via'),**clearances[x['uuid']]} for x in added if clearances[x['uuid']]['minimum_foreign_track_via_pad_clearance_mm']<.22]
r['any_new_clearance_below_0_22mm']=bool(r['clearances_below_0_22mm'])
r['branch_metrics']={}
for role in sorted({x['role'] for x in added}):
 xs=[x for x in added if x.get('role')==role];ts=[x for x in xs if x['type']=='segment'];ids=[x['uuid'] for x in xs]
 r['branch_metrics'][role]={'track_length_mm':sum(x['length_mm'] for x in ts),'segment_count':len(ts),'via_count':sum(x['type']=='via' for x in xs),'widths_mm':sorted({x['width_mm'] for x in ts}),'layers':sorted({x['layer'] for x in ts}),'minimum_foreign_track_via_pad_clearance_mm':min(clearances[k]['minimum_foreign_track_via_pad_clearance_mm'] for k in ids)}
r['checkpoint']=CHECKPOINT
r['phase3b5b_preserved']=True
r['ready_to_freeze_3b5c']=CHECKPOINT==4
r.pop('ready_to_freeze_3b5b',None)
if CHECKPOINT==4:
 assert {frozenset(g) for g in groups(cb) if list(g)!=combined}=={frozenset(['U6001.1','C6007.1']),frozenset(['R3005.2']),frozenset(['TP601.1'])}
(D/'phase3b5c_clamp_rail_verification.json').write_text(json.dumps(r,indent=2)+'\n')
(D/f'phase3b5c_clamp_rail_c{CHECKPOINT}_verification.json').write_text(json.dumps(r,indent=2)+'\n')
print('VERIFICATION PASS checkpoint',CHECKPOINT,'pairs',r['unconnected_pairs_after'],'groups',r['afe_group_count_after'],'minimum clearance',minimum)
