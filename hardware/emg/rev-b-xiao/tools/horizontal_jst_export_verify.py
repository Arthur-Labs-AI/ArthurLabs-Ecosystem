#!/usr/bin/env python3
"""Verify ECO fabrication exports against the source. Run from repository root."""
import sys,json,csv,zipfile,hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from rb04_gerber import parse_gerber,excellon
from rb02_sexpr import *
p=Path('hardware/emg/rev-b-xiao/evidence/horizontal-jst');board=Path('hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb');r=parse(board.read_text());pack=p/'NOT_RELEASED_fabrication'
with zipfile.ZipFile(pack/'ARTHUR_EMG_RevB_Gerbers.zip') as z:
 assert len(z.namelist())==11 and all('/' not in n for n in z.namelist()); z.extractall('/tmp/arthur-horizontal/verified-gerber');names=z.namelist()
g=Path('/tmp/arthur-horizontal/verified-gerber');_,pts=excellon(next(g.glob('*.drl')))
vias=sorted((round(float(first(v,'at')[1]),3),round(-float(first(v,'at')[2]),3)) for v in kids(r,'via'))
assert vias==sorted((round(x,3),round(y,3)) for x,y in pts[.3])
assert len(vias)==191
# Verify each connector's four pad centres in all relevant copper / mask / paste Gerbers.
import math
allpads=[]
for f in kids(r,'footprint'):
 at=first(f,'at');a=math.radians(float(at[3]) if len(at)>3 else 0);ref=next(p[2] for p in kids(f,'property') if p[1]=='Reference')
 for pad in kids(f,'pad'):
  if ref not in {'J101','J201','J301','J401','J5001'}:continue
  x,y=map(float,first(pad,'at')[1:3]); allpads.append((ref,pad[1],float(at[1])+x*math.cos(a)+y*math.sin(a),-(float(at[2])-x*math.sin(a)+y*math.cos(a))))
for pattern in ['*-F_Cu.gtl','*-F_Mask.gts','*-F_Paste.gtp']:
 parsed=parse_gerber(next(g.glob(pattern)));fl=[pos for pos,code,pol in parsed['flashes']]
 for ref,pad,x,y in allpads:assert any(abs(a-x)<.002 and abs(b-y)<.002 for a,b in fl),(pattern,ref,pad)
cpl=list(csv.DictReader((pack/'ARTHUR_EMG_RevB_CPL.csv').open()));assert len(cpl)==126 and len({v['Designator'] for v in cpl})==126
bom=list(csv.DictReader((pack/'ARTHUR_EMG_RevB_BOM.csv').open()));brefs={x.strip() for row in bom for x in row['Designator'].split(',')};assert brefs=={row['Designator'] for row in cpl}
assert {row['Designator']:row for row in cpl}['J1']['Rotation']=='270'
res={'zip_files':names,'via_drills_matched_to_source':len(vias),'connector_pad_flashes_checked':len(allpads)*3,'cpl_and_bom_refs':len(cpl),'J1_factory_rotation':270,'result':'PASS','limits':'Pad centres verified; this does not qualify paste stencil, assembly tolerances, or factory feeder rotation.'}
(p/'fabrication-check.json').write_text(json.dumps(res,indent=2)+'\n');print(res)
