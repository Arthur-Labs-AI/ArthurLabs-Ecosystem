from pathlib import Path
import sys,math,json
O=Path(__file__).resolve().parent;R=O.parents[2];sys.path.insert(0,str(R/'tools'))
from rb02_sexpr import parse,kids,first
K=R/'kicad/ARTHUR_EMG_RevB'
def xy(n):return float(n[1]),float(n[2])
def dstseg(p,a,b):
 dx,dy=b[0]-a[0],b[1]-a[1];l=dx*dx+dy*dy;t=max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/l)) if l else 0;return math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)
def boxdist(p,b):return math.hypot(max(b[0]-p[0],0,p[0]-b[2]),max(b[1]-p[1],0,p[1]-b[3]))
def segbox(a,b,box):
 lo,hi=0,1
 for i in [0,1]:
  d=b[i]-a[i]
  if abs(d)<1e-12:
   if not box[i]<=a[i]<=box[i+2]:return None
  else:
   t0,t1=(box[i]-a[i])/d,(box[i+2]-a[i])/d;lo=max(lo,min(t0,t1));hi=min(hi,max(t0,t1))
 if hi<lo:return None
 return max(0,lo),min(1,hi)
def seggap(a,b,box):
 if segbox(a,b,box):return 0
 return min(boxdist(a,box),boxdist(b,box),*(dstseg(p,a,b) for p in [(box[0],box[1]),(box[0],box[3]),(box[2],box[1]),(box[2],box[3])]))
def pads(f):
 out=[]
 for p in kids(f,'pad'):
  layers=first(p,'layers') or []
  if not any(l in layers for l in ['F.Mask','*.Mask']):continue
  x,y=xy(first(p,'at'));w,h=xy(first(p,'size'));at=first(p,'at');ang=float(at[3]) if len(at)>3 else 0
  if abs(ang%180-90)<.001:w,h=h,w
  m=first(p,'solder_mask_margin');m=float(m[1]) if m else 0
  out.append((p[1],(x-w/2-m,y-h/2-m,x+w/2+m,y+h/2+m)))
 return out
if __name__=='__main__':
 res=[]
 for path in K.glob('fp-libs/*/*.kicad_mod'):
  f=parse(path.read_text());pd=pads(f);bad=[]
  for g in f:
   if not isinstance(g,list) or g[0] not in ['fp_line','fp_circle','fp_poly','fp_arc','fp_rect']:continue
   if not first(g,'layer') or first(g,'layer')[1]!='F.SilkS':continue
   sw=float(first(first(g,'stroke'),'width')[1]);mind=99
   for n,box in pd:
    if g[0]=='fp_line':gap=seggap(xy(first(g,'start')),xy(first(g,'end')),box)-sw/2
    elif g[0]=='fp_circle':
     c=xy(first(g,'center'));rad=math.dist(c,xy(first(g,'end')));gap=boxdist(c,box)-rad-sw/2
    elif g[0]=='fp_poly':
     pts=[xy(x) for x in first(g,'pts')[1:]];gap=min(seggap(a,b,box) for a,b in zip(pts,pts[1:]+pts[:1]))-sw/2
    else:continue
    mind=min(mind,gap)
   if mind<.159999:bad.append({'type':g[0],'gap':round(mind,6),'geometry':g})
  if bad:res.append({'file':str(path),'bad':bad})
 (O/'silk-before-local.json').write_text(json.dumps(res,indent=2));print([(Path(x['file']).name,len(x['bad']),[(a['type'],a['gap']) for a in x['bad'][:4]]) for x in res])
