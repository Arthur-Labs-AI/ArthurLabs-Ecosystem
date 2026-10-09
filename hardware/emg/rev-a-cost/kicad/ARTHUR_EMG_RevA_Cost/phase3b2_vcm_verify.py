import pcbnew as p, pathlib,json,hashlib,collections,re,math
p.SwigPyIterator.next=p.SwigPyIterator.__next__
D=pathlib.Path(__file__).resolve().parent;BASE='ARTHUR_EMG_RevA_Cost_Phase3B1_ReferenceClean';CAND='ARTHUR_EMG_RevA_Cost_Phase3B2_VCMCandidate'
a=p.LoadBoard(str(D/(BASE+'.kicad_pcb')));b=p.LoadBoard(str(D/(CAND+'.kicad_pcb')))
def sha(n):return hashlib.sha256((D/n).read_bytes()).hexdigest()
def uid(t):return t.m_Uuid.AsString()
def xy(v):return [p.ToMM(v.x),p.ToMM(v.y)]
def parse(n):
 stack=[];root=None
 for t in re.findall(r'"(?:\\.|[^"\\])*"|[^\s()]+|[()]',(D/n).read_text()):
  if t=='(':new=[];stack[-1].append(new) if stack else None;stack.append(new)
  elif t==')':root=stack.pop()
  else:stack[-1].append(t)
 return root
def blocks(tree,tag):return [x for x in tree if isinstance(x,list) and x[0]==tag]
def zdefs(tree):return [[x for x in z if not(isinstance(x,list) and x[0] in ['filled_polygon','fill_segments'])] for z in blocks(tree,'zone')]
ta,tb=parse(BASE+'.kicad_pcb'),parse(CAND+'.kicad_pcb');checks={}
for tag in {x[0] for x in ta if isinstance(x,list)}-{'zone'}:
 ac=collections.Counter(json.dumps(x) for x in blocks(ta,tag));bc=collections.Counter(json.dumps(x) for x in blocks(tb,tag))
 checks[tag]={'before':sum(ac.values()),'after':sum(bc.values()),'removed_or_changed':sum((ac-bc).values()),'added':sum((bc-ac).values())}
 assert checks[tag]['removed_or_changed']==0,(tag,checks[tag])
 if tag not in ['segment','via']:assert checks[tag]['added']==0,(tag,checks[tag])
assert zdefs(ta)==zdefs(tb)
oldids={uid(t) for t in a.GetTracks()};new=[t for t in b.GetTracks() if uid(t) not in oldids]
assert all(t.GetNetname()=='VCM' for t in new)
branches=json.loads((D/'phase3b2_vcm_branches.json').read_text());newbyid={uid(t):t for t in new}
assert set(newbyid)=={i for v in branches.values() for key in ['track_uuids','via_uuids'] for i in v[key]}
def conn(board):
 board.BuildConnectivity();c=board.GetConnectivity();r={};padmap={}
 for f in board.GetFootprints():
  for pad in f.Pads():
   key=f.GetReference()+'.'+pad.GetNumber();padmap[key]=pad
   if not pad.GetNetCode():continue
   items=c.GetConnectedItems(pad)
   r[key]={'net':pad.GetNetname(),'pads':sorted({key}|{x.GetParentFootprint().GetReference()+'.'+x.GetNumber() for x in items if isinstance(x,p.PAD)}),'zones':sorted({uid(x) for x in items if isinstance(x,p.ZONE)})}
 return r,padmap
ca,pa=conn(a);cb,pb=conn(b)
vcmpads={k for k,v in cb.items() if v['net']=='VCM'};beforegroups={tuple(v['pads']) for v in ca.values() if v['net']=='VCM'};aftergroups={tuple(v['pads']) for v in cb.values() if v['net']=='VCM'}
assert len(beforegroups)==5 and len(aftergroups)==1
assert all(set(cb[k]['pads'])==vcmpads for k in vcmpads)
assert all(ca[k]==cb[k] for k in ca if ca[k]['net']!='VCM'),'non-VCM pad connectivity changed'
planes=[]
for za,zb in zip(a.Zones(),b.Zones()):
 if zb.GetIsRuleArea():continue
 l=zb.GetLayer();fa=za.GetFilledPolysList(l);fb=zb.GetFilledPolysList(l)
 v={'layer':b.GetLayerName(l),'uuid':uid(zb),'polygons_before':fa.OutlineCount(),'polygons_after':fb.OutlineCount(),'islands_before':[i for i in range(fa.OutlineCount()) if za.IsIsland(l,i)],'islands_after':[i for i in range(fb.OutlineCount()) if zb.IsIsland(l,i)]}
 assert v['polygons_before']==v['polygons_after']==1 and not v['islands_after'];planes.append(v)
assert len(planes)==2
# Plane reference beneath F.Cu and above B.Cu, omitting intentional signal-via antipads.
coverage=[];vcmvias=[t for t in b.GetTracks() if isinstance(t,p.PCB_VIA) and t.GetNetname()=='VCM']
for t in new:
 if isinstance(t,p.PCB_VIA):continue
 l=p.In1_Cu if t.GetLayer()==p.F_Cu else p.In2_Cu;z=next(z for z in b.Zones() if not z.GetIsRuleArea() and z.GetLayer()==l)
 s,e=xy(t.GetStart()),xy(t.GetEnd());n=max(1,math.ceil(math.dist(s,e)/.02));hits=0;checked=0;excluded=0
 for i in range(n+1):
  q=[s[0]+(e[0]-s[0])*i/n,s[1]+(e[1]-s[1])*i/n]
  if any(math.dist(q,xy(v.GetPosition()))<=p.ToMM(v.GetWidth(l))/2+p.ToMM(z.GetLocalClearance())+.001 for v in vcmvias):excluded+=1;continue
  checked+=1;hits+=int(z.HitTestFilledArea(l,p.VECTOR2I(p.FromMM(q[0]),p.FromMM(q[1]))))
 coverage.append({'track':uid(t),'reference_plane':b.GetLayerName(l),'samples_checked':checked,'gnd_samples':hits,'via_antipad_samples_excluded':excluded})
print('coverage',coverage)
assert all(x['samples_checked']==x['gnd_samples'] for x in coverage)
# Exact KiCad copper shape distance via binary search. Compare all other-net tracks/vias/pads on common layers.
allc=list(b.GetTracks())+list(pb.values())
for endpoint,branch in branches.items():
 branch['track_length_mm']=sum(p.ToMM(newbyid[i].GetLength()) for i in branch['track_uuids']);branch['via_count']=len(branch['via_uuids']);branch['layers']=sorted({b.GetLayerName(newbyid[i].GetLayer()) for i in branch['track_uuids']})
 minimum=100.;witness=None;digital=100.
 for i in branch['track_uuids']+branch['via_uuids']:
  t=newbyid[i]
  for o in allc:
   if o.GetNetCode()==t.GetNetCode():continue
   for l in [p.F_Cu,p.B_Cu,p.In1_Cu,p.In2_Cu]:
    if not(t.GetLayerSet().Contains(l) and o.GetLayerSet().Contains(l)):continue
    ts=t.GetEffectiveShape(l);os=o.GetEffectiveShape(l);isdigital=o.GetNetname() in ['AFE_CLKIN','MCU_SCLK','MCU_MOSI','AFE_MISO','MCU_CS_N','AFE_DRDY_N','MCU_RESET_N_AFE'];hi=p.FromMM(max(minimum,digital if isdigital else 0))
    if not ts.Collide(os,hi):continue
    lo=0
    while hi-lo>1:
     mid=(hi+lo)//2
     if ts.Collide(os,mid):hi=mid
     else:lo=mid
    dist=p.ToMM(lo)
    if dist<minimum:minimum=dist;witness={'added':i,'other':uid(o),'other_net':o.GetNetname(),'layer':b.GetLayerName(l)}
    if isdigital:digital=min(digital,dist)
 branch['minimum_clearance_mm']=minimum;branch['clearance_witness']=witness;branch['same_layer_clock_spi_clearance_mm']=digital
 # All new via annuli must be outside all pad copper; no via-in-pad.
 for i in branch['via_uuids']:
  v=newbyid[i]
  for pad in pb.values():
   if pad.GetLayerSet().Contains(p.F_Cu):assert not v.GetEffectiveShape(p.F_Cu).Collide(pad.GetEffectiveShape(p.F_Cu),0),(endpoint,'via overlaps pad',uid(pad))
 branch['no_via_in_pad']='PASS'
base_drc=json.loads((D/'phase3b2_vcm_baseline_drc.json').read_text());drc=json.loads((D/'phase3b2_vcm_candidate_drc.json').read_text())
def ident(v):return (v['type'],tuple(sorted(x['uuid'] for x in v['items'])))
copper={'clearance','shorting_items','tracks_crossing','dangling_track','dangling_via','copper_edge_clearance','hole_clearance','hole_to_hole','isolated_copper','starved_thermal'}
newerrors=[v for v in drc['violations'] if v['type'] in copper and ident(v) not in {ident(x) for x in base_drc['violations']}]
assert not newerrors
assert len(base_drc['unconnected_items'])==119 and len(drc['unconnected_items'])==115
assert not any('[VCM]' in x['description'] for v in drc['unconnected_items'] for x in v['items'])
freeze=json.loads((D/'phase3a_routing_freeze.json').read_text());freezehash={n:sha(n)==h for n,h in freeze['sha256'].items()};assert all(freezehash.values())
basehash=sha(BASE+'.kicad_pcb');assert basehash==json.loads((D/'phase3b1_reference_verification.json').read_text())['clean_board_sha256']
assert sha('ARTHUR_EMG_RevA_Cost.kicad_pcb')=='7a7a70d78e1e191e13251e24b882b7eeb3df1153912a4168850515c8ac8201f9'
result={'authoritative_base':BASE+'.kicad_pcb','authoritative_base_sha256':basehash,'candidate_sha256':sha(CAND+'.kicad_pcb'),'branches':branches,'track_length_mm':sum(v['track_length_mm'] for v in branches.values()),'via_count':sum(v['via_count'] for v in branches.values()),'track_segments_added':sum(not isinstance(t,p.PCB_VIA) for t in new),'vcm_connected_groups_before':5,'vcm_connected_groups_after':1,'vcm_pads':sorted(vcmpads),'endpoints_connected':{k:True for k in branches},'vcm_complete_for_phase3b':True,'unconnected_pairs_before':119,'unconnected_pairs_after':115,'baseline_drc_categories':dict(collections.Counter(x['type'] for x in base_drc['violations'])),'candidate_drc_categories':dict(collections.Counter(x['type'] for x in drc['violations'])),'new_copper_violations':newerrors,'new_crossings':0,'new_shorts':0,'dangling_tracks':0,'dangling_vias':0,'structural_comparison':checks,'zone_definitions_preserved':True,'phase1_modified':False,'phase2_modified':False,'phase3a_modified':False,'phase3b1_modified':False,'preexisting_vcm_modified':False,'afe_3v0_modified':False,'placement_modified':False,'board_outline_modified':False,'rf_keepout_modified':False,'non_vcm_connectivity_unchanged':True,'planes':planes,'in1_gnd_continuity':'PASS','in2_gnd_continuity':'PASS','isolated_gnd_polygons_introduced':0,'ground_projection_checks':coverage,'freeze_manifest_hash_checks':freezehash,'phase3a_vias_preserved':sum(isinstance(t,p.PCB_VIA) and t.GetNetname() in freeze['frozen_nets'] for t in a.GetTracks()),'ready_to_freeze_3b2':True}
assert result['phase3a_vias_preserved']==14
(D/'phase3b2_vcm_verification.json').write_text(json.dumps(result,indent=2))
print('VERIFICATION PASS')
for k,v in branches.items():print(k,'length',v['track_length_mm'],'vias',v['via_count'],'clearance',v['minimum_clearance_mm'])
# Reproduce local copper overview from KiCad geometry.
parts=['<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1100" viewBox="42 16.5 13 10.2"><rect x="42" y="16.5" width="13" height="10.2" fill="#16202a"/>']
for t in b.GetTracks():
 s,e=xy(t.GetStart()),xy(t.GetEnd());col='#ffb74d' if uid(t) in newbyid else '#a97bd5' if t.GetNetname()=='VCM' else '#51d88a' if t.GetNetname()=='GND' else '#e58681' if t.GetNetname()=='Net-(U503A-+)' else '#6987ce'
 if isinstance(t,p.PCB_VIA):parts.append(f'<circle cx="{s[0]}" cy="{s[1]}" r="{p.ToMM(t.GetWidth(p.F_Cu))/2}" fill="{col}"/><circle cx="{s[0]}" cy="{s[1]}" r="{p.ToMM(t.GetDrillValue())/2}" fill="#16202a"/>')
 else:parts.append(f'<path d="M{s[0]} {s[1]} L{e[0]} {e[1]}" stroke="{col}" stroke-width="{p.ToMM(t.GetWidth())}" stroke-dasharray="{0 if t.GetLayer()==p.F_Cu else .13}" opacity="{1 if uid(t) in newbyid or t.GetLayer()==p.F_Cu else .5}"/>')
for f in b.GetFootprints():
 for pad in f.Pads():
  x,y=xy(pad.GetPosition());w,h=xy(pad.GetSize());col='#ffb74d' if pad.GetNetname()=='VCM' else '#51d88a' if pad.GetNetname()=='GND' else '#e58681' if pad.GetNetname()=='Net-(U503A-+)' else '#b1b5bd'
  parts.append(f'<rect x="{x-w/2}" y="{y-h/2}" width="{w}" height="{h}" rx=".07" fill="{col}" transform="rotate({-pad.GetOrientationDegrees()} {x} {y})"/>')
 if f.GetReference() in ['U503','R5002','R5003','R5004','C5001','C5002']:
  x,y=xy(f.GetPosition());parts.append(f'<text x="{x}" y="{y}" fill="white" font-size=".25" text-anchor="middle">{f.GetReference()}</text>')
parts.append('</svg>');(D/'phase3b2_vcm_layout.svg').write_text(''.join(parts))
