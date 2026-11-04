from phase3b6_local_gnd_inspect import *
import collections,sys
CAND='ARTHUR_EMG_RevA_Cost_Phase3B6_LocalGNDCandidate';CLEAN='ARTHUR_EMG_RevA_Cost_Phase3B6_LocalGNDClean'
name=CLEAN if 'clean' in sys.argv else CAND
assert sha(BASE+'.kicad_pcb')=='4683602370c4c6ff2b84c2edf484d481af3904598f8bb5fdb9d96649f18020e5'
a=p.LoadBoard(str(D/(BASE+'.kicad_pcb')));b=p.LoadBoard(str(D/(name+'.kicad_pcb')))
added=json.loads((D/'phase3b6_local_gnd_added.json').read_text());snap=json.loads((D/'phase3b6_local_gnd_baseline_geometry.json').read_text())
def parse(n):
 stack=[];root=None
 for t in re.findall(r'"(?:\\.|[^"\\])*"|[^\s()]+|[()]',(D/n).read_text()):
  if t=='(':x=[];stack[-1].append(x) if stack else None;stack.append(x)
  elif t==')':root=stack.pop()
  else:stack[-1].append(t)
 return root
def blocks(tree,tag):return [x for x in tree if isinstance(x,list) and x[0]==tag]
def zdefs(tree):return [[x for x in z if not(isinstance(x,list) and x[0] in ['filled_polygon','fill_segments'])] for z in blocks(tree,'zone')]
ta,tb=parse(BASE+'.kicad_pcb'),parse(name+'.kicad_pcb');checks={}
assert {x[0] for x in ta if isinstance(x,list)}=={x[0] for x in tb if isinstance(x,list)}
for tag in {x[0] for x in ta if isinstance(x,list)}-{'zone'}:
 ac=collections.Counter(json.dumps(x) for x in blocks(ta,tag));bc=collections.Counter(json.dumps(x) for x in blocks(tb,tag));removed=ac-bc;extra=bc-ac
 checks[tag]={'before':sum(ac.values()),'after':sum(bc.values()),'removed_or_changed':sum(removed.values()),'added':sum(extra.values())}
 assert not removed,(tag,checks[tag])
 assert sum(extra.values())==(sum(x['type']==tag for x in added) if tag in ['segment','via'] else 0),(tag,checks[tag])
assert zdefs(ta)==zdefs(tb)
oldids={uid(t) for t in a.GetTracks()};new=[t for t in b.GetTracks() if uid(t) not in oldids];assert {uid(t) for t in new}=={x['uuid'] for x in added};assert all(t.GetNetname()=='GND' for t in new)
for x in added:
 t=next(t for t in new if uid(t)==x['uuid'])
 if x['type']=='segment':assert xy(t.GetStart())==x['start'] and xy(t.GetEnd())==x['end'] and p.ToMM(t.GetWidth())==x['width_mm'] and t.GetLayer()==p.F_Cu
 else:assert xy(t.GetPosition())==x['position'] and t.GetViaType()==p.VIATYPE_THROUGH and p.ToMM(t.GetWidth(p.F_Cu))==.55 and p.ToMM(t.GetDrillValue())==.3
ca,pa=conn(a);cb,pads=conn(b);core=ca['C5001.1'];combined=sorted(core['pads']+TARGETS)
assert len(combined)==58
assert all(ca[k]['pads']==[k] and not ca[k]['zones'] and cb[k]['pads']==combined and cb[k]['zones']==core['zones'] for k in TARGETS)
assert all(cb[k]['pads']==combined and cb[k]['zones']==core['zones'] for k in core['pads'])
assert all(ca[k]==cb[k] for k in ca if k not in combined)
assert all(set(ca[k]['pads'])<=set(cb[k]['pads']) and set(ca[k]['zones'])<=set(cb[k]['zones']) for k in ca)
local=[k for k in cb if k.rsplit('.',1)[0] in snap['local_reference_afe_footprints'] and cb[k]['net']=='GND'];assert all(cb[k]['zones']==core['zones'] for k in local)
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
rules=json.loads((D/(BASE+'.kicad_pro')).read_text())['board']['design_settings']['rules'];viachecks=[]
for t in new:
 if not isinstance(t,p.PCB_VIA):continue
 assert not any(p.SHAPE.Collide(t.GetEffectiveShape(l),pad.GetEffectiveShape(l),0) for pad in pads.values() for l in layers if pad.GetLayerSet().Contains(l))
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
 connected_zones=sorted(uid(x) for x in b.GetConnectivity().GetConnectedItems(t) if isinstance(x,p.ZONE));assert connected_zones==core['zones']
 viachecks.append({'uuid':uid(t),'position':xy(t.GetPosition()),'not_via_in_pad':True,'annulus_mm':annulus,'diameter_mm':.55,'drill_mm':.3,'hole_to_foreign_copper_mm':holemin,'hole_to_other_hole_mm':holehole,'connected_gnd_zones':connected_zones,**clearances[uid(t)]})
planes=[]
for za in a.Zones():
 if za.GetIsRuleArea():continue
 zb=next(z for z in b.Zones() if uid(z)==uid(za));l=zb.GetLayer();fa,fb=za.GetFilledPolysList(l),zb.GetFilledPolysList(l)
 q={'layer':b.GetLayerName(l),'uuid':uid(zb),'before_polygons':fa.OutlineCount(),'after_polygons':fb.OutlineCount(),'before_islands':[i for i in range(fa.OutlineCount()) if za.IsIsland(l,i)],'after_islands':[i for i in range(fb.OutlineCount()) if zb.IsIsland(l,i)]}
 assert q['before_polygons']==q['after_polygons']==1 and not q['before_islands'] and not q['after_islands'];planes.append(q)
assert len(planes)==2
baseline=json.loads((D/'phase3b6_local_gnd_baseline_drc.json').read_text());report=json.loads((D/('phase3b6_local_gnd_drc.json' if name==CLEAN else 'phase3b6_local_gnd_candidate_drc.json')).read_text())
def identities(r):return collections.Counter((v['type'],tuple(sorted(i['uuid'] for i in v['items']))) for v in r['violations'])
assert identities(baseline)==identities(report)
assert len(baseline['violations'])==len(report['violations'])==548 and len(baseline['unconnected_items'])==96 and len(report['unconnected_items'])==92
assert not any(v['type'] in ['clearance','shorting_items','tracks_crossing','dangling_track','dangling_via','hole_clearance','annular_width','via_diameter','drill_out_of_range'] for v in report['violations'])
protected={n:sha(n)==h for n,h in snap['protected_file_sha256'].items()};assert all(protected.values())
freeze=json.loads((D/'phase3a_routing_freeze.json').read_text());freezehash={n:sha(n)==h for n,h in freeze['sha256'].items()};assert all(freezehash.values())
phase3avias=[uid(t) for t in a.GetTracks() if isinstance(t,p.PCB_VIA) and t.GetNetname() in freeze['frozen_nets']];assert len(phase3avias)==14
metrics={}
for k in TARGETS:
 ts=[t for t in new if next(x['target'] for x in added if x['uuid']==uid(t))==k];tracks=[t for t in ts if not isinstance(t,p.PCB_VIA)];via=next(t for t in ts if isinstance(t,p.PCB_VIA))
 metrics[k]={'stub_length_mm':sum(p.ToMM(t.GetLength()) for t in tracks),'stub_widths_mm':sorted(set(p.ToMM(t.GetWidth()) for t in tracks)),'segment_count':len(tracks),'via_location':xy(via.GetPosition()),'via_diameter_mm':.55,'via_drill_mm':.3,'minimum_foreign_track_via_pad_clearance_mm':min(clearances[uid(t)]['minimum_foreign_track_via_pad_clearance_mm'] for t in ts),'copper_uuids':[uid(t) for t in ts],'gnd_access':'PASS'}
sidecars={ext:sha(BASE+ext)==sha(name+ext) for ext in ['.kicad_pro','.kicad_dru']};assert all(sidecars.values())
r={'authoritative_input':BASE+'.kicad_pcb','input_sha256':sha(BASE+'.kicad_pcb'),'artifact':name+'.kicad_pcb','artifact_sha256':sha(name+'.kicad_pcb'),'production_sha256':sha('ARTHUR_EMG_RevA_Cost.kicad_pcb'),'local_gnd_inventory_before':snap['local_gnd_inventory'],'local_reference_afe_footprints':snap['local_reference_afe_footprints'],'exactly_four_isolated_target_groups_before':True,'no_additional_unresolved_local_gnd_pad_before':True,'all_phase3b_local_gnd_access_complete':True,'targets_before':{k:ca[k] for k in TARGETS},'targets_after':{k:cb[k] for k in TARGETS},'gnd_core_before':core,'gnd_core_after':cb['C5001.1'],'gnd_core_pad_count_before':54,'gnd_core_pad_count_after':58,'target_metrics':metrics,'unconnected_pairs_before':96,'unconnected_pairs_after':92,'ordinary_drc_violations_before':548,'ordinary_drc_violations_after':548,'ordinary_drc_identities_identical':True,'new_copper_violations':0,'new_crossings':0,'new_shorts':0,'dangling_tracks':0,'dangling_vias':0,'structural_comparison':checks,'zone_definitions_preserved':True,'all_original_tracks_vias_footprints_preserved':True,'only_authorized_new_gnd_tracks_vias_added':True,'all_unrelated_pad_connectivity_preserved':True,'no_previously_connected_gnd_pad_loses_connectivity':True,'phase3b1_gnd_returns_preserved':True,'phase3b5d_preserved':True,'phase3b5c_preserved':True,'phase3b5b_preserved':True,'phase3b5a_preserved':True,'phase3b5e_preserved':True,'all_earlier_frozen_geometry_preserved':True,'afe_3v0_modified':False,'vcm_modified':False,'reference_modified':False,'rld_safe_modified':False,'phase3a_vias_preserved':phase3avias,'protected_file_hash_checks':protected,'phase3a_manifest_hash_checks':freezehash,'copied_rule_sidecars_identical':sidecars,'planes':planes,'in1_gnd_continuity':'PASS','in2_gnd_continuity':'PASS','isolated_gnd_polygons':0,'per_object_clearance':clearances,'minimum_foreign_track_via_pad_clearance_mm':minimum,'via_checks':viachecks,'manufacturing_rules':rules,'via_count':len(viachecks),'segment_count':sum(x['type']=='segment' for x in added),'track_length_mm':sum(v['stub_length_mm'] for v in metrics.values()),'standard_four_layer_manufacturing_preserved':True,'no_global_gnd_completion_performed':True,'candidate_refill_drc_pass':True,'final_clean_readonly_drc_pass':name==CLEAN,'ready_to_freeze_3b6':name==CLEAN}
if name==CLEAN:
 assert sha(CLEAN+'.kicad_pcb')==sha(CAND+'.kicad_pcb')
 r['clean_byte_identical_to_refilled_candidate']=True
(D/('phase3b6_local_gnd_verification.json' if name==CLEAN else 'phase3b6_local_gnd_candidate_verification.json')).write_text(json.dumps(r,indent=2)+'\n')
print('VERIFICATION PASS',name);print(json.dumps(metrics,indent=2));print('Minimum new clearance',minimum,'; DRC 548 ordinary, 92 unconnected')
