"""Read-only audit of source text, fresh XML, original package; writes only audit evidence."""
from pathlib import Path
import sys,json,csv,math,collections,xml.etree.ElementTree as ET,zipfile,re
P=Path(__file__).resolve().parent; R=P.parents[1];sys.path.insert(0,str(R/'tools'))
from rb02_sexpr import parse,kids,first
K=R/'kicad/ARTHUR_EMG_RevB';pcb=parse((K/'ARTHUR_EMG_RevB.kicad_pcb').read_text()); base=parse((P.parent/'horizontal-jst/baseline/ARTHUR_EMG_RevB.kicad_pcb').read_text())
def fps(t):return {next(str(p[2]) for p in kids(f,'property') if p[1]=='Reference'):f for f in kids(t,'footprint')}
F=fps(pcb);B=fps(base);C=json.loads((P/'components.json').read_text());xml=ET.parse(P/'netlist.xml').getroot();N={(x.get('ref'),x.get('pin')):n.get('name') for n in xml.findall('./nets/net') for x in n}
checks={}; bad=[]
for ref,f in F.items():
 for pad in kids(f,'pad'):
  net=first(pad,'net'); net=str(net[2]) if net and len(net)>2 else (str(net[1]) if net else '')
  wanted=N.get((ref,str(pad[1])))
  if wanted and net!=wanted and net.replace('{slash}','/')!=wanted:bad.append([ref,pad[1],net,wanted])
checks['pad_net_mismatches']=bad
old=P.parent/'horizontal-jst/NOT_RELEASED_fabrication';bom=list(csv.DictReader(open(old/'ARTHUR_EMG_RevB_BOM.csv')));cpl=list(csv.DictReader(open(old/'ARTHUR_EMG_RevB_CPL.csv')))
refs=[];bom_bad=[]
for row in bom:
 for ref in row['Designator'].split(','):
  refs.append(ref);c=C[ref];fd=c['fields']
  if row['Footprint']!=c['footprint'].split(':')[-1] or row['LCSC Part #']!=fd['LCSC'] or row['Comment']!=c['value']+' '+fd['MPN']:bom_bad.append(ref)
checks['BOM']={'rows':len(bom),'refs':len(refs),'duplicates':[r for r,n in collections.Counter(refs).items() if n>1],'field_mismatches':bom_bad,'PCB_refs_absent_from_BOM':sorted(set(F)-set(refs))}
cp_bad=[];coords=[]
for row in cpl:
 ref=row['Designator']; f=F[ref];a=first(f,'at');x,y=float(a[1]),float(a[2]);rot=float(a[3]) if len(a)>3 else 0;pk=str(f[1]).split(':')[-1]
 correction=180 if pk.startswith(('SOT-23','JST_PH_S')) else 270 if pk.startswith(('TSSOP-','SOIC-')) else 0
 vals=(float(row['Mid X'].replace('mm','')),float(row['Mid Y'].replace('mm','')),float(row['Rotation']))
 if max(abs(vals[0]-x),abs(vals[1]+y),abs((vals[2]-(rot+correction)%360)))>.0001 or row['Layer']!='Top':cp_bad.append(ref)
 coords.append(dict(ref=ref,x=x,y=y,kicad_rotation=rot,correction=correction,factory_rotation=vals[2]))
checks['CPL']={'rows':len(cpl),'mismatches':cp_bad,'ref_set_matches_BOM':{r['Designator'] for r in cpl}==set(refs),'correction_qualification':'Arithmetic verified; factory reel zero-angle UNVERIFIED'}
(P/'placement-transform.json').write_text(json.dumps(coords,indent=2))
checks['ECO']={k+'_equal':kids(pcb,k)==kids(base,k) for k in ['general','setup','layers','gr_line','gr_arc','zone','net']}
changed=[]
for ref,f in F.items():
 a,b=first(f,'at'),first(B[ref],'at')
 if a!=b:changed.append(dict(ref=ref,before=b,after=a))
checks['ECO']['changed_poses']=changed
checks['ECO']['footprint_refs_equal']=set(F)==set(B)
checks['JST']={}
for ref in ['J401','J301','J201','J101','J5001','J1']:
 f=F[ref];checks['JST'][ref]={'pose':first(f,'at'),'footprint':f[1],'pads':[{key:first(p,key) for key in ['at','size','net','layers']}|{'number':p[1]} for p in kids(f,'pad')]}
# Independent comparison drill coordinates to source text (not only counts).
wanted=[]
for v in kids(pcb,'via'):
 a=first(v,'at');wanted.append((float(first(v,'drill')[1]),round(float(a[1]),4),round(-float(a[2]),4)))
for f in F.values():
 a=first(f,'at');x,y=float(a[1]),float(a[2]);th=math.radians(float(a[3]) if len(a)>3 else 0)
 for pad in kids(f,'pad'):
  d=first(pad,'drill')
  if d:
   a=first(pad,'at');px,py=float(a[1]),float(a[2]);wanted.append((float(d[1]),round(x+px*math.cos(th)+py*math.sin(th),4),round(-(y-px*math.sin(th)+py*math.cos(th)),4)))
tools={};actual=[];tool=None
for line in next((P/'existing-gerbers').glob('*.drl')).read_text().splitlines():
 m=re.match(r'T(\d+)C([\d.]+)',line)
 if m:tools[m[1]]=float(m[2]);continue
 m=re.fullmatch(r'T(\d+)',line)
 if m:tool=m[1];continue
 m=re.match(r'X(-?[\d.]+)Y(-?[\d.]+)',line)
 if m:actual.append((tools[tool],round(float(m[1]),4),round(float(m[2]),4)))
checks['drill_coordinates']={'count':len(actual),'exact_match_to_source':sorted(actual)==sorted(wanted)}
# Small-signal differential half circuit; constant typical ADC resistance assumption.
from cmath import pi
response=[]
for f in [.1,.5,.723,1,1.2,10,20,50,100,450,500,1000,7500,10000]:
 s=2j*pi*f; zc=1/(s*2.2e-6); zload=1/(1/150000+s*(1e-9+2*10e-9));zpost=1000+zload;za=1/(1/100000+1/zpost);h=za/(zc+za)*zload/zpost
 response.append({'Hz':f,'magnitude':abs(h),'dB':20*math.log10(abs(h))})
checks['filter_model']={'assumptions':'unity opamps, 2.2uF nominal, 100k bias per leg, 1k series, 1nF shunt +10nF differential; ADC 300k differential typical represented as150k half circuit (gain1 only), no digital filter or electrode source model','response':response,'unloaded_HP_Hz':1/(2*pi*1e5*2.2e-6),'VCM_nominal_V':1.5,'VCM_divider_tolerance_V':[3*.99/(1.01+.99),3*1.01/(.99+1.01)],'normal_contact_bias_10M_uA':1.5/1e7*1e6,'rail_fault_10k_3V_uA':3.045/1e4*1e6,'reference_100k_3V_uA':3.045/1e5*1e6}
(P/'independent-checks.json').write_text(json.dumps(checks,indent=2));print(json.dumps({k:v for k,v in checks.items() if k not in ['JST','filter_model']},indent=1))
