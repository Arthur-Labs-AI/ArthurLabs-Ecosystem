"""Minimal, span-preserving source corrections for AUD-04/AUD-08; run once against baseline."""
from pathlib import Path
import sys,re,json,copy,math
O=Path(__file__).resolve().parent;R=O.parents[2];sys.path.insert(0,str(R/'tools'))
from rb02_sexpr import parse,kids,first,dump
from inspect_silk import segbox,xy,pads,seggap
K=R/'kicad/ARTHUR_EMG_RevB';LOG=[]
# Locate nested expression spans independently; retain all untouched source bytes.
def spans(text):
 stack=[];out=[]
 for m in re.finditer(r'"(?:\\.|[^"\\])*"|[()]',text):
  if m[0]=='(':stack.append(m.start())
  elif m[0]==')':out.append((stack.pop(),m.end()))
 return out

def edit(path,callback):
 text=path.read_text();changes=[]
 for a,b in spans(text):
  raw=text[a:b]
  if not re.match(r'\((?:footprint|symbol|fp_line|fp_circle)\b',raw):continue
  node=parse(raw);new,detail=callback(node)
  if new is not None and new!=node:
   # callback must return a copy; replacing this smallest selected node only.
   indent=len(text[:a].rsplit('\n',1)[-1]);replacement=dump(new,0).replace('\n','\n'+'\t'*indent)
   changes.append((a,b,replacement,detail))
 # Only one level may change at once: no overlapping replacement spans.
 for (a,b,_,_), (c,d,_,_) in zip(sorted(changes),sorted(changes)[1:]):assert b<=c,(path,a,b,c,d)
 for a,b,new,detail in sorted(changes,reverse=True):text=text[:a]+new+text[b:];LOG.append({'file':str(path),'detail':detail})
 if changes:path.write_text(text)

# One-shot reconstruction guard. Existing edited work must not be overwritten.
for _b in (O/'baseline/project').rglob('*'):
 if _b.is_file() and (K/_b.relative_to(O/'baseline/project')).read_bytes()!=_b.read_bytes():
  raise RuntimeError('Reconstruction requires the preserved pre-closure source; current edits will not be overwritten')

# Read every target's current AST before editing. Only properties of exact selected MPNs change.
meta={
 'RC0603FR-0710ML': [('±5%','±1%'),('10M 5%','10M 1%')],
 'CC0603KRX7R9BB104':[('100nF 16V','100nF 50V')],
 'CL21A226MAQNNNE':[('22uF 10V','22uF 25V')],
}
def metadata(n):
 if n[0] not in ['symbol','footprint']:return None,None
 props={p[1]:p for p in kids(n,'property')};mpn=props.get('MPN',[None,None,''])[2]
 if mpn not in meta:return None,None
 nn=copy.deepcopy(n);names=[]
 for p in kids(nn,'property'):
  if p[1] not in ['Spec','Description']:continue
  old=p[2]
  for a,b in meta[mpn]:p[2]=type(p[2])(str(p[2]).replace(a,b))
  if p[2]!=old:names.append(p[1])
 return nn,{'kind':'metadata','MPN':mpn,'properties':names}
for path in [K/'ARTHUR_EMG_RevB.kicad_pcb',*K.glob('*.kicad_sch')]:
 parse(path.read_text());edit(path,metadata)

# Conservative clipping of silk centerlines outside each local pad AABB plus0.16 clearance+halfstroke.
# No pads, Fab, courtyards, pin1 polygons/circles, copper or reference poses change.
TRIMS={}
for path in K.glob('fp-libs/*/*.kicad_mod'):
 f=parse(path.read_text());pd=pads(f);changes={}
 for line in kids(f,'fp_line'):
  if first(line,'layer')[1]!='F.SilkS':continue
  a,b=xy(first(line,'start')),xy(first(line,'end'));sw=float(first(first(line,'stroke'),'width')[1]);tlist=[]
  if min(seggap(a,b,box)-sw/2 for _,box in pd)>=.16:continue
  for _,box in pd:
   grow=.16+sw/2+.00001;box=(box[0]-grow,box[1]-grow,box[2]+grow,box[3]+grow);iv=segbox(a,b,box)
   if iv and iv[1]>iv[0]:tlist.append(iv)
  if not tlist:continue
  # Preserve complete readable outline strokes: move an axis-aligned line away from body centre.
  # Only silk is affected; copper and component courtyards remain unchanged.
  if abs(a[1]-b[1])<1e-9:axis=1
  elif abs(a[0]-b[0])<1e-9:axis=0
  else:raise RuntimeError(('Non-axis line needs manual review',path,line))
  direction=1 if (a[axis]+b[axis])/2>0 else -1
  shift=0
  while True:
   shift+=.001
   aa=list(a);bb=list(b);aa[axis]+=direction*shift;bb[axis]+=direction*shift
   if min(seggap(aa,bb,box)-sw/2 for _,box in pd)>=.160001:break
   if shift>.2:raise RuntimeError(('Move would exceed0.2mm',path,line))
  nn=copy.deepcopy(line)
  first(nn,'start')[1:]=[round(v,6) for v in aa];first(nn,'end')[1:]=[round(v,6) for v in bb]
  changes[repr(line)]=nn
 if changes:
  TRIMS[str(path)]=changes
  edit(path,lambda n:(copy.deepcopy(changes[repr(n)]),{'kind':'silk outward move','old':n,'new':changes[repr(n)]}) if repr(n) in changes else (None,None))
# Installed line poses retain footprint-relative start/end; stored rotations on pads are irrelevant.
bylib={path.split('/fp-libs/')[1].replace('.pretty/ ',':'):v for path,v in TRIMS.items()}
board=K/'ARTHUR_EMG_RevB.kicad_pcb'
def board_silk(n):
 if n[0]!='footprint':return None,None
 lib=str(n[1]);nick,part=lib.split(':');path=str(K/'fp-libs'/(nick+'.pretty')/(part+'.kicad_mod'));changes=TRIMS.get(path)
 if not changes:return None,None
 nn=copy.deepcopy(n);changed=0
 # Match line geometry ignoring per-instanceUUID and rotation; all are same local coordinates.
 def signature(x):return (tuple(xy(first(x,'start'))),tuple(xy(first(x,'end'))),str(first(x,'layer')[1]))
 mapping={}
 oldf=parse((O/'baseline/project/fp-libs'/(nick+'.pretty')/(part+'.kicad_mod')).read_text())
 for oldline in kids(oldf,'fp_line'):
  if repr(oldline) in changes:mapping[signature(oldline)]=changes[repr(oldline)]
 for g in kids(nn,'fp_line'):
  target=mapping.get(signature(g))
  if target:
   first(g,'start')[1:]=first(target,'start')[1:];first(g,'end')[1:]=first(target,'end')[1:];changed+=1
 assert changed==len(changes),(lib,changed,len(changes))
 return nn,{'kind':'board silk outward move','lib':lib,'lines':changed}
edit(board,board_silk)
# TP mask is a concentric circle:0.95-0.75-0.06=0.14; increase silk radius only to0.98 ->0.17mm.
tp=K/'fp-libs/TestPoint.pretty/TestPoint_Pad_D1.5mm.kicad_mod'
def tp_silk(n):
 if n[0]=='fp_circle' and first(n,'layer')[1]=='F.SilkS' and xy(first(n,'center'))==(0,0) and abs(xy(first(n,'end'))[1])==.95:
  nn=copy.deepcopy(n);first(nn,'end')[2]=.98 if float(first(nn,'end')[2])>0 else -.98;return nn,{'kind':'TP circle radius','before':.95,'after':.98}
 return None,None
edit(tp,tp_silk)
def board_tp(n):
 if n[0]!='footprint' or n[1]!='TestPoint:TestPoint_Pad_D1.5mm':return None,None
 nn=copy.deepcopy(n)
 for g in kids(nn,'fp_circle'):
  if first(g,'layer')[1]=='B.SilkS' and xy(first(g,'end'))==(0,-.95):first(g,'end')[2]=-.98
 return nn,{'kind':'TP board silk radius','after':.98}
edit(board,board_tp)
# Local library descriptions must no longer claim affected vendored subsets are unmodified.
p=K/'fp-lib-table';s=p.read_text();
for nick in ['Resistor_SMD','Capacitor_SMD','Inductor_SMD','TestPoint']:
 s=re.sub(r'(\(lib \(name "'+nick+r'"\).*?\(descr ")[^"]*("\)\))',r'\1KiCad 10.0.0 subset; local silk-clearance edits for JLCPCB review, copper unchanged\2',s)
p.write_text(s)
(O/'source-edits.json').write_text(json.dumps(LOG,indent=2));print('Changed nodes',len(LOG),'trimmed libraries',list(TRIMS))
