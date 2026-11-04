from pathlib import Path
import sys,json,math
P=Path(__file__).resolve().parent;sys.path.insert(0,str(P.parents[1]/'tools'))
from rb04_gerber import parse_gerber,aperture_size
from rb04_geom import sseg
M=parse_gerber(P/'existing-gerbers/ARTHUR_EMG_RevB-F_Mask.gts');S=parse_gerber(P/'existing-gerbers/ARTHUR_EMG_RevB-F_Silkscreen.gto')
res=[]
for a,b,ap,interp,pol in S['draws']:
 if interp!='G01' or pol!='D':continue
 sw=aperture_size(S['apertures'][ap])[0]
 for (x,y),code,pol in M['flashes']:
  if pol!='D':continue
  w,h=aperture_size(M['apertures'][code]);x0,y0,x1,y1=x-w/2,y-h/2,x+w/2,y+h/2
  seg=(*a,*b);edges=[(x0,y0,x1,y0),(x1,y0,x1,y1),(x1,y1,x0,y1),(x0,y1,x0,y0)]
  d=min(sseg(seg,e) for e in edges)-sw/2
  if d<.15:res.append({'conservative_bbox_gap_mm':round(d,4),'silk_segment':[a,b],'mask_center':[x,y],'mask_size':[w,h]})
(P/'silk-check.json').write_text(json.dumps({'model':'Axis-aligned mask aperture bounding rectangles; corners conservative; straight silk strokes only; not factory CAM','count_below_0_15':len(res),'lowest':sorted(res,key=lambda r:r['conservative_bbox_gap_mm'])[:30]},indent=2));print('below0.15',len(res),'min',min((r['conservative_bbox_gap_mm'] for r in res),default=None))
