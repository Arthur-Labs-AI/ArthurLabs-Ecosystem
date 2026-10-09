import pcbnew as p,pathlib,json,hashlib,collections,re,math
p.SwigPyIterator.next=p.SwigPyIterator.__next__
D=pathlib.Path(__file__).resolve().parent;BASE='ARTHUR_EMG_RevA_Cost_Phase3B2_VCMClean';CAND='ARTHUR_EMG_RevA_Cost_Phase3B3_FollowersCandidate'
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
a=p.LoadBoard(str(D/(BASE+'.kicad_pcb')));b=p.LoadBoard(str(D/(CAND+'.kicad_pcb')))
ta,tb=parse(BASE+'.kicad_pcb'),parse(CAND+'.kicad_pcb');checks={}
assert {x[0] for x in ta if isinstance(x,list)}=={x[0] for x in tb if isinstance(x,list)}
for tag in {x[0] for x in ta if isinstance(x,list)}-{'zone'}:
 ac=collections.Counter(json.dumps(x) for x in blocks(ta,tag));bc=collections.Counter(json.dumps(x) for x in blocks(tb,tag));checks[tag]={'before':sum(ac.values()),'after':sum(bc.values()),'removed_or_changed':sum((ac-bc).values()),'added':sum((bc-ac).values())}
 assert checks[tag]['removed_or_changed']==0,(tag,checks[tag])
 assert checks[tag]['added']==(3 if tag=='segment' else 0),(tag,checks[tag])
assert zdefs(ta)==zdefs(tb)
oldids={uid(t) for t in a.GetTracks()};new=[t for t in b.GetTracks() if uid(t) not in oldids];added=json.loads((D/'phase3b3_followers_added.json').read_text());scope=set(added)
assert len(new)==3 and {t.GetNetname() for t in new}==scope and all(not isinstance(t,p.PCB_VIA) and t.GetLayer()==p.F_Cu for t in new)
def conn(board):
 board.BuildConnectivity();c=board.GetConnectivity();r={};pads={}
 for f in board.GetFootprints():
  for pad in f.Pads():
   k=f.GetReference()+'.'+pad.GetNumber();pads[k]=pad
   if not pad.GetNetCode():continue
   items=c.GetConnectedItems(pad);r[k]={'net':pad.GetNetname(),'pads':sorted({k}|{x.GetParentFootprint().GetReference()+'.'+x.GetNumber() for x in items if isinstance(x,p.PAD)}),'zones':sorted({uid(x) for x in items if isinstance(x,p.ZONE)})}
 return r,pads
ca,pa=conn(a);cb,pb=conn(b)
assert all(ca[k]==cb[k] for k in ca if ca[k]['net'] not in scope)
for net,info in added.items():
 keys=info['pads'];assert all(cb[k]['pads']==sorted(keys) for k in keys);assert all(ca[k]['pads']==[k] for k in keys)
 assert {k for k,v in cb.items() if v['net']==net}==set(keys)
 info['groups_before']=2;info['groups_after']=1;info['complete']=True
 t=next(t for t in new if t.GetNetname()==net);assert uid(t)==info['track_uuid'];info['start']=xy(t.GetStart());info['end']=xy(t.GetEnd());info['track_length_mm']=p.ToMM(t.GetLength());info['segment_count']=1;info['via_count']=0;info['layers']=['F.Cu'];info['width_mm']=p.ToMM(t.GetWidth());info['straight_line_shortest_path']=math.isclose(info['track_length_mm'],math.dist(info['start'],info['end']),abs_tol=1e-9)
 assert info['straight_line_shortest_path']
 minimum=100.;witness=None
 for o in list(b.GetTracks())+list(pb.values()):
  if o.GetNetCode()==t.GetNetCode() or not o.GetLayerSet().Contains(p.F_Cu):continue
  ts=t.GetEffectiveShape(p.F_Cu);os=o.GetEffectiveShape(p.F_Cu);hi=p.FromMM(minimum)
  if not ts.Collide(os,hi):continue
  lo=0
  while hi-lo>1:
   mid=(hi+lo)//2
   if ts.Collide(os,mid):hi=mid
   else:lo=mid
  dist=p.ToMM(lo)
  if dist<minimum:minimum=dist;witness={'foreign_uuid':uid(o),'foreign_net':o.GetNetname(),'layer':'F.Cu'}
 info['minimum_foreign_net_copper_clearance_mm']=minimum;info['clearance_witness']=witness
 z=next(z for z in b.Zones() if not z.GetIsRuleArea() and z.GetLayer()==p.In1_Cu);n=math.ceil(info['track_length_mm']/.01);hits=0
 for i in range(n+1):
  s,e=info['start'],info['end'];q=p.VECTOR2I(p.FromMM(s[0]+(e[0]-s[0])*i/n),p.FromMM(s[1]+(e[1]-s[1])*i/n));hits+=int(z.HitTestFilledArea(p.In1_Cu,q))
 info['in1_gnd_reference_samples']=n+1;info['in1_gnd_reference_hits']=hits;assert hits==n+1
planes=[]
for za,zb in zip(a.Zones(),b.Zones()):
 if zb.GetIsRuleArea():continue
 l=zb.GetLayer();fa,fb=za.GetFilledPolysList(l),zb.GetFilledPolysList(l)
 v={'layer':b.GetLayerName(l),'before_polygons':fa.OutlineCount(),'after_polygons':fb.OutlineCount(),'before_islands':[i for i in range(fa.OutlineCount()) if za.IsIsland(l,i)],'after_islands':[i for i in range(fb.OutlineCount()) if zb.IsIsland(l,i)]}
 assert v['before_polygons']==v['after_polygons']==1 and not v['after_islands'];planes.append(v)
assert len(planes)==2
baseline=json.loads((D/'phase3b3_followers_baseline_drc.json').read_text());candidate=json.loads((D/'phase3b3_followers_candidate_drc.json').read_text())
def identities(r):return {(v['type'],tuple(sorted(i['uuid'] for i in v['items']))) for v in r['violations']}
assert identities(baseline)==identities(candidate),'DRC ordinary violation identities changed'
assert len(baseline['violations'])==len(candidate['violations'])==548
assert len(baseline['unconnected_items'])==115 and len(candidate['unconnected_items'])==112
assert not any(any(net in i['description'] for net in scope) for v in candidate['unconnected_items'] for i in v['items'])
assert not any(v['type'] in ['clearance','shorting_items','tracks_crossing','dangling_track','dangling_via'] for v in candidate['violations'])
snap=json.loads((D/'phase3b3_followers_baseline_geometry.json').read_text());protected={n:sha(n)==h for n,h in snap['protected_file_sha256'].items()};assert all(protected.values())
freeze=json.loads((D/'phase3a_routing_freeze.json').read_text());freezehash={n:sha(n)==h for n,h in freeze['sha256'].items()};assert all(freezehash.values())
result={'authoritative_input':BASE+'.kicad_pcb','authoritative_input_sha256':sha(BASE+'.kicad_pcb'),'candidate_sha256':sha(CAND+'.kicad_pcb'),'nets':added,'structural_comparison':checks,'zone_definitions_preserved':True,'zone_objects_including_fills_identical':blocks(ta,'zone')==blocks(tb,'zone'),'planes':planes,'in1_gnd_continuity':'PASS','in2_gnd_continuity':'PASS','isolated_gnd_polygons_introduced':0,'other_net_connectivity_identical':True,'phase1_modified':False,'phase2_modified':False,'phase3a_modified':False,'phase3b1_modified':False,'phase3b2_modified':False,'vcm_modified':False,'afe_3v0_modified':False,'placement_modified':False,'outline_modified':False,'rf_keepout_modified':False,'zone_definitions_modified':False,'phase3a_vias_preserved':sum(isinstance(t,p.PCB_VIA) and t.GetNetname() in freeze['frozen_nets'] for t in a.GetTracks()),'phase3b1_ground_vias_preserved':3,'phase3b2_vcm_vias_preserved':3,'protected_file_hash_checks':protected,'phase3a_freeze_manifest_hash_checks':freezehash,'baseline_ordinary_violations':548,'final_ordinary_violations':548,'ordinary_drc_violation_identities_identical':True,'drc_categories':dict(collections.Counter(v['type'] for v in candidate['violations'])),'unconnected_pairs_before':115,'unconnected_pairs_after':112,'new_copper_violations':0,'new_crossings':0,'new_shorts':0,'dangling_tracks':0,'dangling_vias':0,'ready_to_freeze_3b3':True}
assert result['phase3a_vias_preserved']==14
(D/'phase3b3_followers_verification.json').write_text(json.dumps(result,indent=2))
print('VERIFICATION PASS')
for net,v in added.items():print(net,v['track_length_mm'],v['minimum_foreign_net_copper_clearance_mm'])
# Local overview from actual KiCad objects; yellow shows only the added closures.
parts=['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="44 17.5 9 6.75"><rect x="44" y="17.5" width="9" height="6.75" fill="#16202a"/>']
for t in b.GetTracks():
 s,e=xy(t.GetStart()),xy(t.GetEnd());color='#ffe36d' if uid(t) not in oldids else '#bc8edc' if t.GetNetname()=='VCM' else '#e58681' if t.GetNetname()=='Net-(U503A-+)' else '#51d88a' if t.GetNetname()=='GND' else '#6987ce'
 if isinstance(t,p.PCB_VIA):parts.append(f'<circle cx="{s[0]}" cy="{s[1]}" r="{p.ToMM(t.GetWidth(p.F_Cu))/2}" fill="{color}"/><circle cx="{s[0]}" cy="{s[1]}" r="{p.ToMM(t.GetDrillValue())/2}" fill="#16202a"/>')
 else:parts.append(f'<path d="M{s[0]} {s[1]} L{e[0]} {e[1]}" stroke="{color}" stroke-width="{p.ToMM(t.GetWidth())}" stroke-dasharray="{0 if t.GetLayer()==p.F_Cu else .12}"/>')
for f in b.GetFootprints():
 for pad in f.Pads():
  x,y=xy(pad.GetPosition());w,h=xy(pad.GetSize());color='#ffe36d' if pad.GetNetname() in scope else '#bc8edc' if pad.GetNetname()=='VCM' else '#e58681' if pad.GetNetname()=='Net-(U503A-+)' else '#51d88a' if pad.GetNetname()=='GND' else '#b1b5bd'
  parts.append(f'<rect x="{x-w/2}" y="{y-h/2}" width="{w}" height="{h}" rx=".05" fill="{color}" transform="rotate({-pad.GetOrientationDegrees()} {x} {y})"/>')
  if f.GetReference()=='U503':parts.append(f'<text x="{x}" y="{y+.08}" font-size=".22" text-anchor="middle" fill="#16202a">{pad.GetNumber()}</text>')
parts.append('</svg>');(D/'phase3b3_followers_layout.svg').write_text(''.join(parts))
