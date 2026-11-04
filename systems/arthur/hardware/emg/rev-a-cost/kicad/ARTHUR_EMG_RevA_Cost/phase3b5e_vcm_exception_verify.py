import pcbnew as p,pathlib,json,hashlib,collections,re,math
p.SwigPyIterator.next=p.SwigPyIterator.__next__
D=pathlib.Path(__file__).resolve().parent;BASE='ARTHUR_EMG_RevA_Cost_Phase3B4_RLDClean';CAND='ARTHUR_EMG_RevA_Cost_Phase3B5E_VCMExceptionCandidate';OLD='30a501c9-ab5c-4380-ba9f-44465f57214b'
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
a=p.LoadBoard(str(D/(BASE+'.kicad_pcb')));b=p.LoadBoard(str(D/(CAND+'.kicad_pcb')));ta,tb=parse(BASE+'.kicad_pcb'),parse(CAND+'.kicad_pcb');added=json.loads((D/'phase3b5e_vcm_exception_added.json').read_text());checks={}
assert {x[0] for x in ta if isinstance(x,list)}=={x[0] for x in tb if isinstance(x,list)}
for tag in {x[0] for x in ta if isinstance(x,list)}-{'zone'}:
 ac=collections.Counter(json.dumps(x) for x in blocks(ta,tag));bc=collections.Counter(json.dumps(x) for x in blocks(tb,tag));removed=list((ac-bc).elements());extra=list((bc-ac).elements());checks[tag]={'before':sum(ac.values()),'after':sum(bc.values()),'removed_or_changed':len(removed),'added':len(extra)}
 assert len(removed)==(1 if tag=='segment' else 0) and len(extra)==(3 if tag=='segment' else 0)
 if tag=='segment':assert OLD in removed[0] and all(any(k in s for k in added['added_uuids']) for s in extra)
assert zdefs(ta)==zdefs(tb)
idsa={uid(t) for t in a.GetTracks()};idsb={uid(t) for t in b.GetTracks()};assert idsa-idsb=={OLD} and idsb-idsa==set(added['added_uuids'])
new=[t for t in b.GetTracks() if uid(t) in added['added_uuids']];path=added['path']
for t,x,z in zip([next(t for t in new if uid(t)==k) for k in added['added_uuids']],path,path[1:]):
 assert t.GetNetname()=='VCM' and t.GetLayer()==p.F_Cu and t.GetWidth()==p.FromMM(.15) and xy(t.GetStart())==x and xy(t.GetEnd())==z
old=next(t for t in a.GetTracks() if uid(t)==OLD);assert path[0]==xy(old.GetStart()) and path[-1]==xy(old.GetEnd())
def conn(board):
 board.BuildConnectivity();c=board.GetConnectivity();r={};pads={}
 for f in board.GetFootprints():
  for pad in f.Pads():
   k=f.GetReference()+'.'+pad.GetNumber();pads[k]=pad
   if not pad.GetNetCode():continue
   items=c.GetConnectedItems(pad);r[k]={'net':pad.GetNetname(),'pads':sorted({k}|{x.GetParentFootprint().GetReference()+'.'+x.GetNumber() for x in items if isinstance(x,p.PAD)}),'zones':sorted({uid(x) for x in items if isinstance(x,p.ZONE)})}
 return r,pads
ca,pa=conn(a);cb,pads=conn(b);assert ca==cb
vcmpads=sorted(k for k,v in cb.items() if v['net']=='VCM');assert len(vcmpads)==14 and all(cb[k]['pads']==vcmpads for k in vcmpads)
# Post-refill physical preflight: virtual objects only, never added or saved.
escape=p.PCB_TRACK(b);escape.SetStart(pads['U503.4'].GetPosition());escape.SetEnd(p.VECTOR2I(p.FromMM(46.9),p.FromMM(20.5)));escape.SetWidth(p.FromMM(.4));escape.SetLayer(p.F_Cu);escape.SetNetCode(b.FindNet('AFE_3V0').GetNetCode())
via=p.PCB_VIA(b);via.SetPosition(escape.GetEnd());via.SetWidth(p.FromMM(.55));via.SetDrill(p.FromMM(.3));via.SetLayerPair(p.F_Cu,p.B_Cu);via.SetViaType(p.VIATYPE_THROUGH);via.SetNetCode(b.FindNet('AFE_3V0').GetNetCode())
items=list(b.GetTracks())+list(pads.values())
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
  for l in [p.F_Cu,p.B_Cu,p.In1_Cu,p.In2_Cu]:
   if not(t.GetLayerSet().Contains(l) and o.GetLayerSet().Contains(l)):continue
   d=distance(t.GetEffectiveShape(l),o.GetEffectiveShape(l),minimum)
   if d<minimum:minimum=d;witness={'uuid':uid(o),'net':o.GetNetname(),'layer':b.GetLayerName(l)}
 return {'minimum_foreign_clearance_mm':minimum,'witness':witness}
local={'escape':{'start':xy(escape.GetStart()),'end':xy(escape.GetEnd()),'width_mm':.4,'layer':'F.Cu','length_mm':p.ToMM(escape.GetLength()),**minclear(escape)},'via':{'center':xy(via.GetPosition()),'diameter_mm':.55,'drill_mm':.3,'type':'ordinary through-via',**minclear(via)},'placed_in_board':False}
assert local['escape']['minimum_foreign_clearance_mm']>=.2 and local['via']['minimum_foreign_clearance_mm']>=.2
assert not any(via.GetEffectiveShape(p.F_Cu).Collide(pad.GetEffectiveShape(p.F_Cu),0) for pad in pads.values() if pad.GetLayerSet().Contains(p.F_Cu));local['via']['not_via_in_pad']=True
hole=p.SHAPE_CIRCLE(via.GetPosition(),p.FromMM(.15));holemin=100.;holehole=100.
for o in items:
 if o.GetNetCode()!=via.GetNetCode():
  for l in [p.F_Cu,p.B_Cu,p.In1_Cu,p.In2_Cu]:
   if o.GetLayerSet().Contains(l):holemin=min(holemin,distance(hole,o.GetEffectiveShape(l),holemin))
 if isinstance(o,p.PCB_VIA):holehole=min(holehole,distance(hole,p.SHAPE_CIRCLE(o.GetPosition(),o.GetDrillValue()//2),holehole))
 elif isinstance(o,p.PAD) and o.GetDrillSize().x>0:
  holehole=min(holehole,distance(hole,p.SHAPE_CIRCLE(o.GetPosition(),max(o.GetDrillSize().x,o.GetDrillSize().y)//2),holehole))
assert holemin>=.25 and holehole>=.25
local['via']['minimum_hole_to_foreign_copper_mm']=holemin;local['via']['minimum_hole_to_existing_hole_mm']=holehole
planes=[]
for za,zb in zip(a.Zones(),b.Zones()):
 if zb.GetIsRuleArea():continue
 l=zb.GetLayer();fa,fb=za.GetFilledPolysList(l),zb.GetFilledPolysList(l);v={'layer':b.GetLayerName(l),'before_polygons':fa.OutlineCount(),'after_polygons':fb.OutlineCount(),'after_islands':[i for i in range(fb.OutlineCount()) if zb.IsIsland(l,i)]};assert v['before_polygons']==v['after_polygons']==1 and not v['after_islands'];planes.append(v)
assert len(planes)==2
baseline=json.loads((D/'phase3b5e_vcm_exception_baseline_drc.json').read_text());candidate=json.loads((D/'phase3b5e_vcm_exception_candidate_drc.json').read_text())
def identities(r):return {(v['type'],tuple(sorted(i['uuid'] for i in v['items']))) for v in r['violations']}
assert identities(baseline)==identities(candidate)
assert len(candidate['violations'])==548 and len(candidate['unconnected_items'])==111
assert not any(v['type'] in ['clearance','shorting_items','tracks_crossing','dangling_track','dangling_via'] for v in candidate['violations'])
snap=json.loads((D/'phase3b5e_vcm_exception_baseline_geometry.json').read_text());protected={n:sha(n)==h for n,h in snap['protected_file_sha256'].items()};assert all(protected.values())
freeze=json.loads((D/'phase3a_routing_freeze.json').read_text());freezehash={n:sha(n)==h for n,h in freeze['sha256'].items()};assert all(freezehash.values())
r={'authoritative_input':BASE+'.kicad_pcb','input_sha256':sha(BASE+'.kicad_pcb'),'candidate_sha256':sha(CAND+'.kicad_pcb'),'authorized_vcm_exception_applied':True,'removed_uuid':OLD,'added_uuids':added['added_uuids'],'replacement_path':path,'replacement_net':'VCM','replacement_width_mm':.15,'replacement_layer':'F.Cu','old_length_mm':p.ToMM(old.GetLength()),'replacement_length_mm':sum(p.ToMM(t.GetLength()) for t in new),'added_vias':0,'structural_comparison':checks,'old_segment_removed':True,'replacement_path_connected':True,'original_endpoints_preserved':True,'all_pad_connectivity_identical':True,'vcm_pad_count':14,'vcm_pads':vcmpads,'vcm_connected_groups':1,'vcm_connectivity_preserved':True,'escape_recheck':local,'u503_4_0_40mm_escape_feasible':True,'standard_via_location_feasible':True,'supply_via_placed':False,'afe_3v0_routed':False,'all_non_authorized_frozen_geometry_preserved':True,'phase3a_vias_preserved':sum(isinstance(t,p.PCB_VIA) and t.GetNetname() in freeze['frozen_nets'] for t in a.GetTracks()),'zone_definitions_preserved':True,'zone_objects_including_fills_identical':blocks(ta,'zone')==blocks(tb,'zone'),'planes':planes,'in1_gnd_continuity':'PASS','in2_gnd_continuity':'PASS','isolated_gnd_polygons_introduced':0,'ordinary_drc_violations':548,'unconnected_pairs_before':111,'unconnected_pairs_after':111,'ordinary_drc_violation_identities_identical':True,'new_copper_violations':0,'new_crossings':0,'new_shorts':0,'dangling_tracks':0,'dangling_vias':0,'protected_file_hash_checks':protected,'phase3a_manifest_hash_checks':freezehash,'ready_for_phase3b5_continuation':True}
assert r['phase3a_vias_preserved']==14
for phase in ['phase1','phase2','phase3a','phase3b1','phase3b3','phase3b4','afe_3v0','placement','outline','rf_keepout']:r[phase+'_modified']=False
r['phase3b2_modified']='ONLY ONE EXPLICITLY AUTHORIZED VCM SEGMENT';r['replacement_clearance_checks']={uid(t):minclear(t) for t in new}
(D/'phase3b5e_vcm_exception_verification.json').write_text(json.dumps(r,indent=2))
print('VERIFICATION PASS; one removal / three additions; unchanged pad connectivity.')
print(json.dumps(local,indent=2))
