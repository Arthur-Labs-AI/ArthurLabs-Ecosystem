"""Read-only verification of closure scope, source/package membership and silk geometry."""
from pathlib import Path
import sys,math,json,collections,csv,xml.etree.ElementTree as ET,copy,re,hashlib
O=Path(__file__).resolve().parent;R=O.parents[2];K=R/'kicad/ARTHUR_EMG_RevB';B=O/'baseline/project';sys.path.insert(0,str(R/'tools'))
from rb02_sexpr import parse,kids,first
from inspect_silk import xy,seggap,dstseg,boxdist
A=parse((K/'ARTHUR_EMG_RevB.kicad_pcb').read_text());Z=parse((B/'ARTHUR_EMG_RevB.kicad_pcb').read_text())
meta={'RC0603FR-0710ML','CC0603KRX7R9BB104','CL21A226MAQNNNE'};libs={'Resistor_SMD:R_0603_1608Metric','Resistor_SMD:R_0805_2012Metric','Capacitor_SMD:C_0603_1608Metric','Capacitor_SMD:C_0805_2012Metric','Inductor_SMD:L_0603_1608Metric','ARTHUR:OSC_SCTF_SX3M_SMD3225-4P','TestPoint:TestPoint_Pad_D1.5mm'}
def norm(n,lib=None,mt=False):
 if not isinstance(n,list):return n
 if n[0] in ['symbol','footprint']:
  mt=any(p[1]=='MPN' and p[2] in meta for p in kids(n,'property'))
  if n[0]=='footprint':lib=str(n[1])
 if n[0]=='property' and len(n)>2 and n[1] in ['Spec','Description'] and mt:return [*n[:2],'AUTHORIZED_METADATA',*n[3:]]
 if n[0]=='copper_finish':return ['copper_finish','AUTHORIZED_FINISH']
 if n[0]=='fp_line' and lib in libs and first(n,'layer')[1] in ['F.SilkS','B.SilkS']:
  return [x if not isinstance(x,list) or x[0] not in ['start','end'] else [x[0],'AUTHORIZED_SILK'] for x in n]
 if n[0]=='fp_circle' and lib=='TestPoint:TestPoint_Pad_D1.5mm' and first(n,'layer')[1] in ['F.SilkS','B.SilkS']:
  return [x if not isinstance(x,list) or x[0]!='end' else ['end','AUTHORIZED_RADIUS'] for x in n]
 return [norm(x,lib,mt) for x in n]
check={};changed=[]
for p in B.rglob('*'):
 if not p.is_file():continue
 rel=p.relative_to(B);q=K/rel
 if q.read_bytes()==p.read_bytes():continue
 changed.append(str(rel))
 if p.suffix in ['.kicad_pcb','.kicad_sch','.kicad_mod']:
  a,b=parse(q.read_text()),parse(p.read_text());lib=None
  if p.suffix=='.kicad_mod':lib=rel.parts[1].replace('.pretty','')+':'+p.stem;a[1]=lib;b[1]=lib
  check[str(rel)]=norm(a,lib)==norm(b,lib)
 elif p.name=='fp-lib-table':
  a,b=parse(q.read_text()),parse(p.read_text())
  def nf(t):return [[x for x in l if not isinstance(x,list) or x[0]!='descr'] for l in kids(t,'lib')]
  check[str(rel)]=nf(a)==nf(b)
 else:check[str(rel)]=False
check['DRC_rules_project_symbols_preserved']=all((K/f).read_bytes()==(B/f).read_bytes() for f in ['ARTHUR_EMG_RevB.kicad_pro','ARTHUR_EMG_RevB.kicad_dru','ARTHUR_RevB.kicad_sym','sym-lib-table'])
(O/'verification/source-invariants.json').write_text(json.dumps({'checks':check,'changed_files':changed},indent=2));assert all(check.values()),check
F={next(p[2] for p in kids(f,'property') if p[1]=='Reference'):f for f in kids(A,'footprint')}
# Global mask shapes, actual pad angle is stored absolute in installed board pads.
mask=[];graphics=[]
for ref,f in F.items():
 at=first(f,'at');X,Y=float(at[1]),float(at[2]);theta=math.radians(float(at[3]) if len(at)>3 else 0)
 def tr(p):x,y=p;return(X+x*math.cos(theta)+y*math.sin(theta),Y-x*math.sin(theta)+y*math.cos(theta))
 for p in kids(f,'pad'):
  lay=first(p,'layers')[1:];c=tr(xy(first(p,'at')));w,h=xy(first(p,'size'));pa=first(p,'at');ang=float(pa[3]) if len(pa)>3 else 0
  if abs(ang%180-90)<.001:w,h=h,w
  mar=first(p,'solder_mask_margin');m=float(mar[1]) if mar else 0;w+=2*m;h+=2*m
  for side in ['F','B']:
   if side+'.Mask' in lay or '*.Mask' in lay:mask.append({'ref':ref+'.'+str(p[1]),'side':side,'center':c,'box':(c[0]-w/2,c[1]-h/2,c[0]+w/2,c[1]+h/2),'circle':str(p[3])=='circle','radius':w/2})
 for g in f:
  if not isinstance(g,list) or g[0] not in ['fp_line','fp_poly','fp_circle']:continue
  ly=first(g,'layer')
  if not ly or ly[1] not in ['F.SilkS','B.SilkS']:continue
  rec={'ref':ref,'type':g[0],'side':ly[1][0],'width':float(first(first(g,'stroke'),'width')[1])}
  if g[0]=='fp_line':rec['points']=[tr(xy(first(g,k))) for k in ['start','end']]
  elif g[0]=='fp_poly':rec['points']=[tr(xy(x)) for x in first(g,'pts')[1:]]
  else:
   rec['center']=tr(xy(first(g,'center')));rec['radius']=math.dist(xy(first(g,'center')),xy(first(g,'end')));rec['filled']=first(g,'fill')[1] in ['yes','solid']
  graphics.append(rec)
results=[]
for g in graphics:
 for p in mask:
  if p['side']!=g['side']:continue
  if g['type']=='fp_circle':
   c=g['center'];r=g['radius'];sw=g['width']/2
   if p['circle']:
    d=math.dist(c,p['center']);gap=(d-r if g['filled'] else abs(d-r))-p['radius']-sw
   else:
    mn=boxdist(c,p['box']);b=p['box'];mx=max(math.dist(c,q) for q in [(b[0],b[1]),(b[0],b[3]),(b[2],b[1]),(b[2],b[3])]);gap=(mn-r if g['filled'] else max(mn-r,r-mx,0))-sw
  else:
   pts=g['points'];pairs=list(zip(pts,pts[1:]))
   if g['type']=='fp_poly':pairs.append((pts[-1],pts[0]))
   gap=min((dstseg(p['center'],a,b)-p['radius'] if p['circle'] else seggap(a,b,p['box'])) for a,b in pairs)-g['width']/2
  if gap<.25:results.append({'silk':g['ref'],'type':g['type'],'mask':p['ref'],'side':g['side'],'conservative_gap_mm':round(gap,6)})
viol=[x for x in results if x['conservative_gap_mm']<.15-1e-6];(O/'verification/silk-global-source.json').write_text(json.dumps({'method':'All installed line/poly/circle silk against all same-side mask pads; conservative rectangular bounds for roundrects, exact circles. No text-font tessellation; native DRC plus visual check cover text.','primitive_count':len(graphics),'mask_shapes':len(mask),'violations_below_0_15':viol,'minima':sorted(results,key=lambda x:x['conservative_gap_mm'])[:40]},indent=2))
# Fresh XML partition, exact values/MPNs, BOM/CPL references and metadata qualification.
xml=ET.parse(O/'verification/netlist.xml').getroot();old=ET.parse(O.parent/'netlist.xml').getroot();components={c.get('ref'):c for c in xml.findall('./components/comp')}
partition=lambda x:sorted((n.get('name'),tuple(sorted((p.get('ref'),p.get('pin')) for p in n))) for n in x.findall('./nets/net'))
componentids=lambda x:sorted((c.get('ref'),c.findtext('value'),c.findtext('footprint'),next((f.text for f in c.findall('./fields/field') if f.get('name')=='MPN'),'')) for c in x.findall('./components/comp'))
checks={'electrical_partition_unchanged':partition(xml)==partition(old),'component_values_MPNs_footprints_unchanged':componentids(xml)==componentids(old),'no_vertical_JST':all('B2B-PH' not in c.findtext('footprint','') and 'C160352' not in str(ET.tostring(c)) for c in components.values()),'silk_clearance_0_15':not viol}
P=O/'NOT_RELEASED_PENDING_FACTORY_APPROVAL';bom=list(csv.DictReader(open(P/'ARTHUR_Neuron_RevB_HJ_JLC_RC1_NOT_RELEASED_BOM.csv')));cpl=list(csv.DictReader(open(P/'ARTHUR_Neuron_RevB_HJ_JLC_RC1_NOT_RELEASED_CPL.csv')));br=[ref for row in bom for ref in row['Designator'].split(',')];cp=[r['Designator'] for r in cpl];bad=[]
for row in bom:
 for ref in row['Designator'].split(','):
  c=components[ref];fields={f.get('name'):f.text for f in c.findall('./fields/field')}
  if row['Comment']!=c.findtext('value')+' '+fields['MPN'] or row['LCSC Part #']!=fields['LCSC'] or row['Footprint']!=c.findtext('footprint').split(':')[-1]:bad.append(ref)
checks['all_BOM_rows_match_fresh_XML']=not bad;checks['28_groups126refs_top_CPL']=len(bom)==28 and len(br)==len(set(br))==len(cp)==126 and set(br)==set(cp) and all(r['Layer']=='Top' for r in cpl);checks['U1_TPs_excluded']=set(F)-set(br)=={'U1',*[f'TP{i}' for i in range(1,9)]}
checks['CPL_arithmetic']=True
for row in cpl:
 f=F[row['Designator']];at=first(f,'at');x,y=float(at[1]),float(at[2]);rot=float(at[3]) if len(at)>3 else 0;pkg=str(f[1]).split(':')[-1];corr=180 if pkg.startswith(('SOT-23','JST_PH_S')) else 270 if pkg.startswith(('TSSOP-','SOIC-')) else 0
 if abs(float(row['Mid X'].replace('mm',''))-x)>1e-4 or abs(float(row['Mid Y'].replace('mm',''))+y)>1e-4 or float(row['Rotation'])!=(rot+corr)%360:checks['CPL_arithmetic']=False
checks['metadata_corrected']=True
for ref,c in components.items():
 fields={f.get('name'):f.text for f in c.findall('./fields/field')};mpn=fields.get('MPN');spec=fields.get('Spec','')
 if mpn=='RC0603FR-0710ML' and '±1%' not in spec:checks['metadata_corrected']=False
 if mpn=='CC0603KRX7R9BB104' and '50V' not in spec:checks['metadata_corrected']=False
 if mpn=='CL21A226MAQNNNE' and '25V' not in spec:checks['metadata_corrected']=False
(O/'verification/package-source-checks.json').write_text(json.dumps(checks,indent=2));print(json.dumps(checks,indent=1));print('silk minima',sorted(results,key=lambda x:x['conservative_gap_mm'])[:3]);assert all(checks.values())
