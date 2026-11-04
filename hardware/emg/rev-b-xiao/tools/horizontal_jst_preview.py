#!/usr/bin/env python3
"""Generate a PREVIEW ONLY PCB with conservative body/plug envelopes, not vendor CAD.
Does not alter canonical PCB. Render with kicad-cli pcb render. Dimensions in report.
"""
import sys
from pathlib import Path
from rb02_sexpr import parse, dump, kids, first, Q
from horizontal_jst_eco import REFS
src,out=sys.argv[1:];out=Path(out);out.mkdir(parents=True,exist_ok=True)
# VRML dimensions use 0.1 inch, per KiCad convention. Y is opposite PCB local Y.
def box(x0,y0,z0,x1,y1,z1,color):
    center=[(x0+x1)/5.08,-(y0+y1)/5.08,(z0+z1)/5.08]
    size=[(x1-x0)/2.54,(y1-y0)/2.54,(z1-z0)/2.54]
    return f'Transform {{ translation {" ".join(map(str,center))} children [ Shape {{ appearance Appearance {{ material Material {{ diffuseColor {color} }} }} geometry Box {{ size {" ".join(map(str,size))} }} }} ] }}\n'
s='#VRML V2.0 utf8\n# Conservative unqualified envelopes ONLY, not production connector CAD.\n'
s+=box(-3.95,-4.2,0,3.95,4.4,5.5,'0.88 0.83 0.67')
s+=box(-2.9,4.4,.5,2.9,11.25,5,'0.12 0.65 0.85')
for x in [-1,1]:s+=box(x-.5,11.25,1.3,x+.5,19.25,2.3,'0.85 0.15 0.1')
(out/'connector-envelope.wrl').write_text(s)
r=parse(Path(src).read_text())
for f in kids(r,'footprint'):
    ref=next(p[2] for p in kids(f,'property') if p[1]=='Reference')
    if ref in REFS:
        f[:]=[n for n in f if not(isinstance(n,list) and n[0]=='model')]
        f.append(['model',Q(str((out/'connector-envelope.wrl').resolve())),['offset',['xyz',0,0,0]],['scale',['xyz',1,1,1]],['rotate',['xyz',0,0,0]]])
(out/'ENVELOPE_PREVIEW_ONLY.kicad_pcb').write_text(dump(r)+'\n')
