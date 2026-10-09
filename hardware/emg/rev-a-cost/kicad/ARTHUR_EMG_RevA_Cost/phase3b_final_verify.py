import pcbnew as p,pathlib,json,hashlib,collections,re,math,sys
p.SwigPyIterator.next=p.SwigPyIterator.__next__
D=pathlib.Path(__file__).resolve().parent
BASE='ARTHUR_EMG_RevA_Cost_Phase3A_ThreeNetClean';INPUT='ARTHUR_EMG_RevA_Cost_Phase3B6_LocalGNDClean';COPY='ARTHUR_EMG_RevA_Cost_Phase3B_VerificationCandidate'
ART=COPY
if 'final' in sys.argv:ART='ARTHUR_EMG_RevA_Cost_Phase3B_FinalClean'
def sha(n):return hashlib.sha256((D/n).read_bytes()).hexdigest()
def uid(o):return o.m_Uuid.AsString()
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
def objid(x):return next(v[1].strip('"') for v in x if isinstance(v,list) and v[0]=='uuid')
def copper(tree):return {objid(x):x for x in blocks(tree,'segment')+blocks(tree,'via')}
def fixedcompare(ta,tb):
 tags={x[0] for x in ta if isinstance(x,list)}|{x[0] for x in tb if isinstance(x,list)};r={}
 for tag in tags-{'zone','segment','via'}:
  aa=collections.Counter(json.dumps(x) for x in blocks(ta,tag));bb=collections.Counter(json.dumps(x) for x in blocks(tb,tag));r[tag]={'before':sum(aa.values()),'after':sum(bb.values()),'equal':aa==bb};assert aa==bb,(tag,r[tag])
 assert zdefs(ta)==zdefs(tb);r['zone_definitions_equal']=True
 return r
def conn(board):
 board.BuildConnectivity();c=board.GetConnectivity();r={};pads={};allpads=[]
 for f in board.GetFootprints():
  for pad in f.Pads():
   allpads.append(pad)
   if not pad.GetNetCode():continue
   k=f.GetReference()+'.'+pad.GetNumber();pads[k]=pad;items=c.GetConnectedItems(pad)
   v={'net':pad.GetNetname(),'pads':sorted({k}|{x.GetParentFootprint().GetReference()+'.'+x.GetNumber() for x in items if isinstance(x,p.PAD)}),'zones':sorted({uid(x) for x in items if isinstance(x,p.ZONE)})}
   assert k not in r or r[k]==v;r[k]=v
 return r,pads,allpads
def groups(c):
 out={}
 for k,v in c.items():out.setdefault(v['net'],set()).add(tuple(v['pads']))
 return {n:sorted(g) for n,g in out.items()}
def cpstats(items):
 ts=[t for t in items if not isinstance(t,p.PCB_VIA)];vs=[t for t in items if isinstance(t,p.PCB_VIA)]
 return {'segment_count':len(ts),'via_count':len(vs),'track_length_mm':sum(p.ToMM(t.GetLength()) for t in ts),'width_counts_mm':dict(collections.Counter(str(p.ToMM(t.GetWidth())) for t in ts)),'layers':sorted({('F.Cu' if t.GetLayer()==p.F_Cu else 'B.Cu') for t in ts}),'via_dimensions_mm':sorted({(p.ToMM(v.GetWidth(p.F_Cu)),p.ToMM(v.GetDrillValue())) for v in vs}),'vias_by_net':dict(collections.Counter(t.GetNetname() for t in vs))}
assert sha(BASE+'.kicad_pcb')==sha('ARTHUR_EMG_RevA_Cost.kicad_pcb')=='7a7a70d78e1e191e13251e24b882b7eeb3df1153912a4168850515c8ac8201f9'
assert sha(INPUT+'.kicad_pcb')=='d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005'
assert sha(ART+'.kicad_pcb')==sha(COPY+'.kicad_pcb')==sha(INPUT+'.kicad_pcb')
provenance=json.loads((D/'phase3b_final_provenance_before.json').read_text());protected={n:sha(n)==h for n,h in provenance['protected_sha256'].items()};assert all(protected.values())
freeze=json.loads((D/'phase3a_routing_freeze.json').read_text());phase3ahashes={n:sha(n)==h for n,h in freeze['sha256'].items()};assert all(phase3ahashes.values())
a=p.LoadBoard(str(D/(BASE+'.kicad_pcb')));b=p.LoadBoard(str(D/(ART+'.kicad_pcb')));ta=parse(BASE+'.kicad_pcb');tb=parse(ART+'.kicad_pcb');struct=fixedcompare(ta,tb);old=copper(ta);final=copper(tb)
assert old.keys()<=final.keys();assert all(old[k]==final[k] for k in old)
oldids=set(old);new=[t for t in b.GetTracks() if uid(t) not in oldids];newids={uid(t) for t in new}
assert len(new)==124 and sum(isinstance(t,p.PCB_VIA) for t in new)==20
allowed={'Net-(U503A-+)','VCM','Net-(U503B--)','Net-(U503C--)','Net-(U503D--)','RLD_SAFE','AFE_3V0','GND'};assert {t.GetNetname() for t in new}==allowed
# Independently reconstruct each accepted incremental delta; check its surviving objects in final.
chain=[('3B-1','ReferenceClean',17,3,{'Net-(U503A-+)','GND'},'5295afc4a4c899316713449917e2a8c3c54242ff632f37e0c90eaa1b62547d78'),('3B-2','VCMClean',11,3,{'VCM'},'ed9d6cb2585d4d489f24de7d32d563635ada8b9a182cd1bbc7e7acd9e98d55b4'),('3B-3','FollowersClean',3,0,{'Net-(U503B--)','Net-(U503C--)','Net-(U503D--)'},'406ccfa5d9b22dc57a04ca05d7afbf9095935f2ff90baab1c2c51b230d8d604e'),('3B-4','RLDClean',1,0,{'RLD_SAFE'},'14c41b66ab073d8f9e4891cd979d336f404ffbfefe862ff217cee983cd2b3f9a'),('3B-5E','VCMExceptionClean',3,0,{'VCM'},'38c89f12dec3ad741a90148dd5a72faacc2613daf31cc721dbdca1e9dd2cefa5'),('3B-5A','U503SupplyClean',22,3,{'AFE_3V0'},'29d57a81a4bf46332a4cf39539740649e24a0baa5a7b9b7c7b845268d3a7acbe'),('3B-5B','OpAmpSupplyClean',17,2,{'AFE_3V0'},'350d90a013e0a1cfbe44a16e1b6b51dd9c177fac78fc8104aac2e37f2ee91777'),('3B-5C','ClampRailClean',23,4,{'AFE_3V0'},'a2d6172651e884521db27631c453cfad8d149189ffdd5d66fa7a59867f80c8ed'),('3B-5D','ADC3V0Clean',3,1,{'AFE_3V0'},'4683602370c4c6ff2b84c2edf484d481af3904598f8bb5fdb9d96649f18020e5'),('3B-6','LocalGNDClean',5,4,{'GND'},'d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005')]
removed_exception='30a501c9-ab5c-4380-ba9f-44465f57214b';prev=ta;prevobj=old;ownership={};chainchecks=[];phaseitems={};byid={uid(t):t for t in b.GetTracks()}
for phase,suffix,segments,vias,nets,h in chain:
 num=phase.replace('3B-','');filename='ARTHUR_EMG_RevA_Cost_Phase3B'+num+'_'+suffix+'.kicad_pcb';assert sha(filename)==h
 tree=parse(filename);now=copper(tree);fixedcompare(prev,tree);removed=set(prevobj)-set(now);added=set(now)-set(prevobj);changed={k for k in prevobj.keys()&now.keys() if prevobj[k]!=now[k]}
 assert not changed and removed==({removed_exception} if phase=='3B-5E' else set()),(phase,removed,changed)
 assert sum(now[k][0]=='segment' for k in added)==segments and sum(now[k][0]=='via' for k in added)==vias
 bd=p.LoadBoard(str(D/filename));delta=[t for t in bd.GetTracks() if uid(t) in added];assert {t.GetNetname() for t in delta}==nets
 for k in added:
  ownership[k]=phase
  if k!=removed_exception:assert k in final and now[k]==final[k],(phase,k)
 phaseitems[phase]=[byid[k] for k in added if k in final]
 chainchecks.append({'phase':phase,'file':filename,'sha256':h,'added_uuids':sorted(added),'removed_uuids':sorted(removed),'added_geometry_statistics':cpstats(delta),'surviving_final_statistics':cpstats(phaseitems[phase]),'final_surviving_objects_identical':True})
 prev=tree;prevobj=now
assert set(ownership)-{removed_exception}==newids
assert removed_exception not in final
replacement=json.loads((D/'phase3b5e_vcm_exception_added.json').read_text());assert replacement['removed_uuid']==removed_exception
expected_path=[[46.75,19.2],[47.5,19.2],[47.5,21.15],[46.75,21.15]]
assert replacement['path']==expected_path
for k,s,e in zip(replacement['added_uuids'],expected_path,expected_path[1:]):
 t=byid[k];assert xy(t.GetStart())==s and xy(t.GetEnd())==e and t.GetNetname()=='VCM' and t.GetLayer()==p.F_Cu and p.ToMM(t.GetWidth())==.15
assert not any(t.GetNetname()=='VCM' and {tuple(xy(t.GetStart())),tuple(xy(t.GetEnd()))}=={(46.75,19.2),(46.75,21.15)} for t in b.GetTracks() if not isinstance(t,p.PCB_VIA))
print('Geometry and all incremental provenance PASS',flush=True)
ca,pa,allpa=conn(a);cb,pads,allpads=conn(b);ga,gb=groups(ca),groups(cb);assert ga.keys()==gb.keys()
expected_delta={'Net-(U503A-+)':4,'VCM':4,'Net-(U503B--)':1,'Net-(U503C--)':1,'Net-(U503D--)':1,'RLD_SAFE':1,'AFE_3V0':15,'GND':7}
reconciliation={n:{'groups_before':len(ga[n]),'groups_after':len(gb[n]),'missing_pairs_before':len(ga[n])-1,'missing_pairs_after':len(gb[n])-1,'pairs_eliminated':len(ga[n])-len(gb[n]),'before_components':[list(g) for g in ga[n]],'after_components':[list(g) for g in gb[n]]} for n in ga}
assert sum(len(v)-1 for v in ga.values())==126 and sum(len(v)-1 for v in gb.values())==92
assert {n:v['pairs_eliminated'] for n,v in reconciliation.items() if v['pairs_eliminated']}==expected_delta
assert all(set(ca[k]['pads'])<=set(cb[k]['pads']) and set(ca[k]['zones'])<=set(cb[k]['zones']) for k in ca)
assert all(ca[k]==cb[k] for k in ca if ca[k]['net'] not in allowed)
reference=['C5001.2','C5002.2','R5004.2','R5003.1','U503.3'];followers={'Net-(U503B--)':['U503.6','U503.7'],'Net-(U503C--)':['U503.8','U503.9'],'Net-(U503D--)':['U503.13','U503.14']}
assert gb['Net-(U503A-+)']==[tuple(sorted(reference))]
for n,g in followers.items():assert gb[n]==[tuple(sorted(g))]
assert gb['RLD_SAFE']==[('J5001.2','R5002.2')]
assert len(gb['VCM'])==1 and len(gb['VCM'][0])==14 and all(k in gb['VCM'][0] for k in ['U503.1','U503.2','U503.5','U503.10','U503.12','R5002.1'])
quiet=['U501.4','U502.4','U503.4','C501.2','C503.2','D101.2','D102.2','D201.2','D202.2','D301.2','D302.2','D401.2','D402.2','R5003.2','U6001.1','C6007.1']
quietcore=sorted(quiet+['U4002.5','C4006.1','C502.2']);assert gb['AFE_3V0']==sorted([tuple(quietcore),('R3005.2',),('TP601.1',)])
assert cb['R3005.2']==ca['R3005.2'] and cb['TP601.1']==ca['TP601.1']
grounds=['C5001.1','C5002.1','R5004.1','C501.1','C503.1','U503.11','J5001.1'];core=ca['C502.1'];groundcore=sorted(core['pads']+grounds);assert len(core['pads'])==51 and len(groundcore)==58
assert all(cb[k]['pads']==groundcore and cb[k]['zones']==core['zones'] for k in groundcore)
assert all(ca[k]==cb[k] for k in ca if ca[k]['net']=='GND' and k not in groundcore)
planes=[]
for z in b.Zones():
 if z.GetIsRuleArea():continue
 l=z.GetLayer();f=z.GetFilledPolysList(l);q={'layer':b.GetLayerName(l),'uuid':uid(z),'polygons':f.OutlineCount(),'islands':[i for i in range(f.OutlineCount()) if z.IsIsland(l,i)]};assert q['polygons']==1 and not q['islands'];planes.append(q)
assert len(planes)==2
phase3avias=[uid(t) for t in a.GetTracks() if isinstance(t,p.PCB_VIA) and t.GetNetname() in freeze['frozen_nets']];assert len(phase3avias)==14 and set(phase3avias)<=final.keys()
print('Independent connectivity PASS: all 34 mergers reconciled; no unrelated mergers',flush=True)
# Exact common-layer KiCad copper-shape audit of every surviving Phase 3B addition.
items=list(b.GetTracks())+allpads;layers=[p.F_Cu,p.B_Cu,p.In1_Cu,p.In2_Cu]
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
   if t.GetLayerSet().Contains(l) and o.GetLayerSet().Contains(l):
    d=distance(t.GetEffectiveShape(l),o.GetEffectiveShape(l),minimum)
    if d<minimum:minimum=d;witness={'uuid':uid(o),'net':o.GetNetname(),'layer':b.GetLayerName(l)}
 return {'clearance_mm':minimum,'witness':witness}
clearances={uid(t):minclear(t) for t in new};minimum=min(q['clearance_mm'] for q in clearances.values());assert minimum>=.2
watchpoints={}
for phase,expected in [('3B-5A',.201789),('3B-5C',.202341),('3B-5B',.228161),('3B-6',.235)]:
 selection=phaseitems[phase]
 if phase=='3B-5C':
  c1={q['uuid'] for q in json.loads((D/'phase3b5c_clamp_rail_added.json').read_text()) if q.get('role')=='C1'};selection=[t for t in selection if uid(t) in c1]
 value=min(clearances[uid(t)]['clearance_mm'] for t in selection);assert abs(value-expected)<=.000001,(phase,value,expected)
 witness=[{'uuid':uid(t),**clearances[uid(t)]} for t in selection if abs(clearances[uid(t)]['clearance_mm']-value)<.000001]
 watchpoints[phase]={'accepted_minimum_mm':expected,'final_measured_minimum_mm':value,'formal_0_20mm_rule_pass':value>=.2,'minimum_objects':witness}
pro=json.loads((D/(INPUT+'.kicad_pro')).read_text());rules=pro['board']['design_settings']['rules'];via_checks=[];overlaps=[]
for t in b.GetTracks():
 if not isinstance(t,p.PCB_VIA):continue
 assert t.GetViaType()==p.VIATYPE_THROUGH
 hitpads=sorted({x.GetParentFootprint().GetReference()+'.'+x.GetNumber() for x in allpads for l in layers if x.GetLayerSet().Contains(l) and p.SHAPE.Collide(t.GetEffectiveShape(l),x.GetEffectiveShape(l),0)})
 if hitpads:
  drill=p.SHAPE_CIRCLE(t.GetPosition(),t.GetDrillValue()//2);center=p.SHAPE_CIRCLE(t.GetPosition(),1)
  holepads=sorted({x.GetParentFootprint().GetReference()+'.'+x.GetNumber() for x in allpads for l in layers if x.GetLayerSet().Contains(l) and p.SHAPE.Collide(drill,x.GetEffectiveShape(l),0)})
  centerpads=sorted({x.GetParentFootprint().GetReference()+'.'+x.GetNumber() for x in allpads for l in layers if x.GetLayerSet().Contains(l) and p.SHAPE.Collide(center,x.GetEffectiveShape(l),0)})
  assert uid(t) in oldids;overlaps.append({'uuid':uid(t),'position':xy(t.GetPosition()),'net':t.GetNetname(),'annulus_overlap_pads':hitpads,'drill_overlap_pads':holepads,'drill_center_inside_pads':centerpads,'unchanged_phase3a_baseline':True})
 if uid(t) not in newids:continue
 assert not hitpads
 hole=p.SHAPE_CIRCLE(t.GetPosition(),t.GetDrillValue()//2);hc=100.;hh=100.
 for o in items:
  if uid(o)==uid(t):continue
  if o.GetNetCode()!=t.GetNetCode():
   for l in layers:
    if o.GetLayerSet().Contains(l):hc=min(hc,distance(hole,o.GetEffectiveShape(l),hc))
  if isinstance(o,p.PCB_VIA):hh=min(hh,distance(hole,p.SHAPE_CIRCLE(o.GetPosition(),o.GetDrillValue()//2),hh))
  elif isinstance(o,p.PAD) and o.GetDrillSize().x>0:hh=min(hh,distance(hole,p.SHAPE_CIRCLE(o.GetPosition(),max(o.GetDrillSize().x,o.GetDrillSize().y)//2),hh))
 annulus=p.ToMM(t.GetWidth(p.F_Cu)-t.GetDrillValue())/2
 assert annulus>=rules['min_via_annular_width'] and p.ToMM(t.GetDrillValue())>=rules['min_through_hole_diameter'] and p.ToMM(t.GetWidth(p.F_Cu))>=rules['min_via_diameter'] and hc>=rules['min_hole_clearance'] and hh>=rules['min_hole_to_hole']
 via_checks.append({'uuid':uid(t),'net':t.GetNetname(),'position':xy(t.GetPosition()),'diameter_mm':p.ToMM(t.GetWidth(p.F_Cu)),'drill_mm':p.ToMM(t.GetDrillValue()),'annulus_mm':annulus,'hole_to_foreign_copper_mm':hc,'hole_to_other_hole_mm':hh,'outside_all_pads':True,'through_via':True})
assert len(via_checks)==20
stats=cpstats(new);stats['by_net']={n:cpstats([t for t in new if t.GetNetname()==n]) for n in sorted(allowed)};stats['minimum_foreign_net_clearance_mm']=minimum
tracks=[t for t in new if not isinstance(t,p.PCB_VIA)];longest=max(tracks,key=lambda t:t.GetLength());stats['longest_single_segment']={'uuid':uid(longest),'net':longest.GetNetname(),'start':xy(longest.GetStart()),'end':xy(longest.GetEnd()),'length_mm':p.ToMM(longest.GetLength())}
neck=[t for t in tracks if t.GetNetname()=='AFE_3V0' and p.ToMM(t.GetWidth())<.4];assert len(neck)==1 and xy(neck[0].GetStart())==[49.3,20.5] and xy(neck[0].GetEnd())==[50.7,20.5] and p.ToMM(neck[0].GetWidth())==.3
stats['neck_down_regions']=[{'uuid':uid(t),'net':t.GetNetname(),'width_mm':p.ToMM(t.GetWidth()),'length_mm':p.ToMM(t.GetLength()),'start':xy(t.GetStart()),'end':xy(t.GetEnd())} for t in neck]
rolelengths=[]
for f in ['phase3b5a_u503_supply_added.json','phase3b5b_opamp_supply_added.json','phase3b5c_clamp_rail_added.json','phase3b5d_adc3v0_added.json']:
 rows=json.loads((D/f).read_text());roles={q.get('role','ADC authority attachment') for q in rows if q['type']=='segment'}
 for role in roles:
  ids=[q['uuid'] for q in rows if q['type']=='segment' and q.get('role','ADC authority attachment')==role]
  rolelengths.append({'evidence_file':f,'role':role,'uuids':ids,'measured_total_length_mm':sum(p.ToMM(byid[k].GetLength()) for k in ids)})
# Role groups are increment feeds/branches, not whole-net endpoint-to-endpoint path lengths.
longfeed=max(rolelengths,key=lambda q:q['measured_total_length_mm']);assert longfeed['role']=='authority attachment';stats['longest_increment_added_feed']=longfeed;stats['route_length_definition']='Longest separately introduced feed/branch measured from actual saved copper UUIDs; shared copper counted once. This is distinct from longest single segment and aggregate whole-net copper length.'
print('Manufacturing / exact clearances PASS; minimum',minimum,'; baseline pad overlaps',len(overlaps),flush=True)
# Independent real DRC reconciliation: current baseline identities + exactly known text warnings.
baseline=json.loads((D/'phase3b_final_phase3a_baseline_drc.json').read_text());report=json.loads((D/('phase3b_final_drc.json' if ART!=COPY else 'phase3b_final_candidate_drc.json')).read_text());serialized=json.loads((D/'phase3b6_local_gnd_drc.json').read_text())
def identities(r):return collections.Counter((v['type'],tuple(sorted(i['uuid'] for i in v['items']))) for v in r['violations'])
idbase,idfinal=identities(baseline),identities(report);extra=idfinal-idbase;removed=idbase-idfinal
assert not removed and sum(extra.values())==23 and all(k[0]=='nonmirrored_text_on_back_layer' for k in extra)
assert idfinal==identities(serialized)
assert len(baseline['violations'])==525 and len(baseline['unconnected_items'])==126 and len(report['violations'])==548 and len(report['unconnected_items'])==92
assert not any(v['type'] in ['clearance','shorting_items','tracks_crossing','dangling_track','dangling_via','hole_clearance','annular_width','via_diameter','drill_out_of_range'] for v in report['violations'])
# Map each DRC pair to a net and independently match every net's component-count deficit.
def drcpairs(r,board):
 idx={uid(t):t.GetNetname() for t in board.GetTracks()};idx.update({uid(x):x.GetNetname() for f in board.GetFootprints() for x in f.Pads()});idx.update({uid(z):z.GetNetname() for z in board.Zones()});counts=collections.Counter()
 for pair in r['unconnected_items']:
  nets={idx[i['uuid']] for i in pair['items']};assert len(nets)==1;n=next(iter(nets));counts[n]+=1
 return counts
pb,pf=drcpairs(baseline,a),drcpairs(report,b)
assert pb==collections.Counter({n:len(g)-1 for n,g in ga.items() if len(g)>1}) and pf==collections.Counter({n:len(g)-1 for n,g in gb.items() if len(g)>1})
sidecars={ext:sha(BASE+ext)==sha(INPUT+ext)==sha(ART+ext) for ext in ['.kicad_pro','.kicad_dru']};assert all(sidecars.values())
assert b.GetCopperLayerCount()==4
r={'scope':'Full accumulated Phase 3B independent verification; no routing edits, production overwrite or later-phase work','authoritative_input':INPUT+'.kicad_pcb','input_sha256':sha(INPUT+'.kicad_pcb'),'phase3a_baseline':BASE+'.kicad_pcb','phase3a_sha256':sha(BASE+'.kicad_pcb'),'artifact':ART+'.kicad_pcb','artifact_sha256':sha(ART+'.kicad_pcb'),'refilled_copy_byte_identical_to_accepted_input':True,'all_phase3a_baseline_objects_preserved':True,'structural_comparison':struct,'original_segment_count':len(blocks(ta,'segment')),'final_segment_count':len(blocks(tb,'segment')),'original_via_count':len(blocks(ta,'via')),'final_via_count':len(blocks(tb,'via')),'incremental_geometry_reconciliation':chainchecks,'authorized_vcm_exception':{'removed_uuid':removed_exception,'removed_segment_present':False,'replacement_path':expected_path,'replacement_uuids':replacement['added_uuids'],'present_exactly':True,'no_other_accepted_vcm_edits':True},'reference_core':'PASS','vcm':'PASS','followers':'PASS','rld_safe':'PASS','afe_3v0_quiet_core':'PASS','local_gnd':'PASS','buffered_vcm_r5002_rld_safe_j5001_path_preserved':True,'r3005_2_deferred':True,'r3005_2_reason':'Phase 3D discharge/interlock','tp601_1_deferred':True,'tp601_1_reason':'Later testpoint phase','afe_3v0_final_components':[list(g) for g in gb['AFE_3V0']],'afe_3v0_groups':3,'afe_3v0_missing_pairs':2,'component_reconciliation_by_net':reconciliation,'component_mergers_by_phase3b_net':expected_delta,'pairs_before':126,'pairs_after':92,'phase3b_pairs_eliminated':34,'every_net_drc_pair_count_matches_components':True,'baseline_drc_pairs_by_net':dict(pb),'final_drc_pairs_by_net':dict(pf),'no_unrelated_component_mergers':True,'gnd_core_before':core,'gnd_core_after':cb['C502.1'],'gnd_core_pads_before':51,'gnd_core_pads_after':58,'seven_local_gnd_endpoints':{k:cb[k] for k in grounds},'no_previously_connected_gnd_pad_loses_connectivity':True,'planes':planes,'in1_gnd':'PASS','in2_gnd':'PASS','gnd_islands':0,'phase1_preserved':True,'phase2_preserved':True,'phase3a_preserved':True,'phase3a_vias_preserved':phase3avias,'placement_preserved':True,'board_outline_preserved':True,'rf_keepout_preserved':True,'zone_definitions_preserved':True,'statistics':stats,'watchpoints':watchpoints,'per_object_clearance':clearances,'phase3b_via_checks':via_checks,'phase3b_no_via_in_pad':True,'whole_board_no_via_in_pad':not overlaps,'unchanged_baseline_via_pad_overlaps':overlaps,'baseline_via_annulus_overlap_count':len(overlaps),'baseline_via_drill_overlap_count':sum(bool(q['drill_overlap_pads']) for q in overlaps),'baseline_via_drill_center_inside_pad_count':sum(bool(q['drill_center_inside_pads']) for q in overlaps),'all_board_vias_standard_through':True,'no_microvias':True,'no_blind_vias':True,'no_buried_vias':True,'unchanged_four_layer_stackup':True,'phase3b_introduces_special_process':False,'manufacturing_rule_sidecars_unchanged':sidecars,'baseline_ordinary_drc':525,'known_serialization_text_warnings':23,'final_ordinary_drc':548,'baseline_violations_preserved':True,'known_text_warning_only_delta':True,'same_ordinary_identities_as_phase3b6':True,'new_copper_violations':0,'new_crossings':0,'new_shorts':0,'dangling_tracks':0,'dangling_vias':0,'protected_file_hash_checks':protected,'phase3a_manifest_hash_checks':phase3ahashes,'candidate_refill_save_drc':'PASS','final_readonly_drc':'PASS' if ART!=COPY else 'NOT RUN ON FINAL CHECKPOINT YET','via_in_pad_gate_scope':'Phase 3B additions only, explicitly confirmed by user; unchanged baseline overlaps documented separately','gate_scope_clarification_pending':False,'standard_4layer_cost_first_process_preserved':True,'ready_to_freeze':ART!=COPY,'ready_for_production_promotion':ART!=COPY}
(D/('phase3b_final_verification.json' if ART!=COPY else 'phase3b_final_candidate_verification.json')).write_text(json.dumps(r,indent=2)+'\n')
print('ALL ELECTRICAL / DELTA / MANUFACTURING ADDITION CHECKS PASS',flush=True);print(json.dumps({'statistics':stats,'watchpoints':watchpoints,'baseline_via_drill_center_inside_pad_count':r['baseline_via_drill_center_inside_pad_count']},indent=2))
