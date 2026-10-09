import pcbnew as p,pathlib,json,hashlib
p.SwigPyIterator.next=p.SwigPyIterator.__next__
D=pathlib.Path(__file__).resolve().parent;BASE='ARTHUR_EMG_RevA_Cost_Phase3B4_RLDClean';CAND='ARTHUR_EMG_RevA_Cost_Phase3B5_AFE3V0Candidate'
def sha(n):return hashlib.sha256((D/n).read_bytes()).hexdigest()
v=json.loads((D/'phase3b5_afe3v0_baseline_geometry.json').read_text());b=p.LoadBoard(str(D/(BASE+'.kicad_pcb')))
assert sha(CAND+'.kicad_pcb')==sha(BASE+'.kicad_pcb')==v['accepted_input_sha256']
assert all(sha(n)==h for n,h in v['protected_file_sha256'].items())
for ext in ['.kicad_pro','.kicad_dru']:assert sha(BASE+ext)==sha(CAND+ext)
base_drc=json.loads((D/'phase3b5_afe3v0_baseline_drc.json').read_text());drc=json.loads((D/'phase3b5_afe3v0_drc.json').read_text())
def ids(d):return {(x['type'],tuple(sorted(i['uuid'] for i in x['items']))) for x in d['violations']}
assert ids(base_drc)==ids(drc) and len(drc['violations'])==548 and len(drc['unconnected_items'])==111
pads={f.GetReference()+'.'+pad.GetNumber():pad for f in b.GetFootprints() for pad in f.Pads()};foreign=list(b.GetTracks())+list(pads.values());proposal=v['proposed_minimum_frozen_exception']
original=next(t for t in b.GetTracks() if t.m_Uuid.AsString()==proposal['original_frozen_vcm_segment_uuid'])
virtual=[]
for a,z in zip(proposal['proposed_replacement_path'],proposal['proposed_replacement_path'][1:]):
 t=p.PCB_TRACK(b);t.SetStart(p.VECTOR2I(p.FromMM(a[0]),p.FromMM(a[1])));t.SetEnd(p.VECTOR2I(p.FromMM(z[0]),p.FromMM(z[1])));t.SetWidth(p.FromMM(.15));t.SetLayer(p.F_Cu);t.SetNetCode(b.FindNet('VCM').GetNetCode());virtual.append(t)
# Proposed local escape evaluated in memory only; no object added to any PCB.
t=p.PCB_TRACK(b);t.SetStart(pads['U503.4'].GetPosition());t.SetEnd(p.VECTOR2I(p.FromMM(46.9),p.FromMM(20.5)));t.SetWidth(p.FromMM(.4));t.SetLayer(p.F_Cu);t.SetNetCode(b.FindNet('AFE_3V0').GetNetCode());virtual.append(t)
via=p.PCB_VIA(b);via.SetPosition(t.GetEnd());via.SetWidth(p.FromMM(.55));via.SetDrill(p.FromMM(.3));via.SetLayerPair(p.F_Cu,p.B_Cu);via.SetViaType(p.VIATYPE_THROUGH);via.SetNetCode(b.FindNet('AFE_3V0').GetNetCode());virtual.append(via)
checks=[]
for item in virtual:
 minimum=100.
 for o in foreign+virtual:
  if o.GetNetCode()==item.GetNetCode() or o.m_Uuid.AsString()==original.m_Uuid.AsString():continue
  for layer in [p.F_Cu,p.B_Cu,p.In1_Cu,p.In2_Cu]:
   if not(item.GetLayerSet().Contains(layer) and o.GetLayerSet().Contains(layer)):continue
   a,z=item.GetEffectiveShape(layer),o.GetEffectiveShape(layer);hi=p.FromMM(minimum)
   if not a.Collide(z,hi):continue
   lo=0
   while hi-lo>1:
    mid=(hi+lo)//2
    if a.Collide(z,mid):hi=mid
    else:lo=mid
   minimum=min(minimum,p.ToMM(lo))
 assert minimum>=.2,(item.GetNetname(),minimum)
 checks.append({'type':item.GetClass(),'net':item.GetNetname(),'minimum_foreign_clearance_mm':minimum})
assert not any(via.GetEffectiveShape(p.F_Cu).Collide(pad.GetEffectiveShape(p.F_Cu),0) for pad in pads.values() if pad.GetLayerSet().Contains(p.F_Cu))
proposal['local_shape_clearance_preflight']='PASS';proposal['local_virtual_shape_checks']=checks;proposal['full_board_drc']='UNVERIFIED; proposal not applied'
planes=[]
for z in b.Zones():
 if z.GetIsRuleArea():continue
 l=z.GetLayer();pol=z.GetFilledPolysList(l);entry={'layer':b.GetLayerName(l),'polygon_count':pol.OutlineCount(),'islands':[i for i in range(pol.OutlineCount()) if z.IsIsland(l,i)]};assert entry['polygon_count']==1 and not entry['islands'];planes.append(entry)
v['planes']=planes;v['in1_gnd_continuity']='PASS';v['in2_gnd_continuity']='PASS';v['isolated_polygons_introduced']=0
for k in ['phase1','phase2','phase3a','phase3b1','phase3b2','phase3b3','phase3b4','existing_afe_3v0_geometry','vcm','rld_safe','reference_node','placement','outline','rf_keepout','zone_definitions']:v[k+'_modified']=False
v['preservation_basis']='Entire candidate PCB is byte-identical to accepted input; therefore all original PCB objects and fills preserved exactly.'
v['ordinary_drc_violations_before']=548;v['ordinary_drc_violations_after']=548;v['unconnected_pairs_before']=111;v['unconnected_pairs_after']=111
v['new_copper_clearance_violations']=0;v['new_crossings']=0;v['new_shorts']=0;v['dangling_tracks']=0;v['dangling_vias']=0
required=['U501.4','U502.4','U503.4','C501.2','C503.2','D101.2','D102.2','D201.2','D202.2','D301.2','D302.2','D401.2','D402.2','R5003.2','U6001.1','C6007.1']
v['required_endpoints_connected_to_ldo']={k:'U4002.5' in v['afe_pad_components'][k] for k in required}
assert not any(v['required_endpoints_connected_to_ldo'].values())
v['r3005_2_intentionally_deferred']=v['afe_pad_components']['R3005.2']==['R3005.2'];v['tp601_1_intentionally_deferred']=v['afe_pad_components']['TP601.1']==['TP601.1'];v['quiet_core_connected_groups']=16
v['new_routing_minimum_clearance_mm']=None;v['new_routing_phase3a_digital_clearance_mm']=None;v['clean_artifact_created']=False;v['clean_artifact_omission_reason']='Checkpoint A blocked before routing; no completed/accepted Phase3B5 clean continuation artifact exists.'
v['commands']=['/usr/bin/python3 phase3b5_afe3v0_preflight.py',f'kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b5_afe3v0_baseline_drc.json {BASE}.kicad_pcb',f'kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b5_afe3v0_drc.json {CAND}.kicad_pcb','/usr/bin/python3 phase3b5_afe3v0_blocker_verify.py']
(D/'phase3b5_afe3v0_verification.json').write_text(json.dumps(v,indent=2))
print('BLOCKER VERIFIED; frozen PCB unchanged; Checkpoints B-D not started.')
print('Unapplied exception local geometry:',json.dumps(checks))
