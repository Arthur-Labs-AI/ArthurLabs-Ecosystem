#!/usr/bin/env python3
"""Draw board-measured lands and nominal body envelopes; not a factory preview."""
from pathlib import Path
import subprocess

OUT=Path(__file__).resolve().parent.parent/'evidence/placement-orientation-2026-10-20'
s=['<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="820" viewBox="0 0 1400 820"><rect width="1400" height="820" fill="#f7f9fc"/><style>text{font-family:DejaVu Sans,sans-serif;fill:#172d48} .title{font-size:24px;font-weight:bold} .sub{font-size:16px} .small{font-size:14px}</style>']
def text(x,y,t,cls='sub',color=None):
    s.append(f'<text x="{x}" y="{y}" class="{cls}"'+(f' style="fill:{color}"' if color else '')+f'>{t}</text>')
def line(x,y,a,b,color='#172d48',width=2):s.append(f'<line x1="{x}" y1="{y}" x2="{a}" y2="{b}" stroke="{color}" stroke-width="{width}"/>')
def rect(x,y,w,h,fill,stroke='none',dash=False):s.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" stroke="{stroke}" stroke-width="2"'+(' stroke-dasharray="7 5"' if dash else '')+'/>')
text(40,40,'North-edge C295747 placement: verify opening AND terminal registration','title')
text(40,69,'Board-measured KiCad lands + nominal JST catalog body bounds. Public JLC 2D zero used as a hypothesis; no factory 3D verification.','small')
# Two single-connector top views, 30px/mm. y=0 at north board edge.
for ox,title,flip,color in [(95,'RC1 CPL 0°: reported inward mouth',True,'#bc3838'),(755,'RC2 CPL 180°: proposed outward mouth',False,'#13765d')]:
    oy=190;scale=27;cy=5.15
    text(ox-35,117,title,'title')
    text(ox-35,145,'TOP VIEW: north up; no mirrored underside view','small')
    rect(ox-25,oy,440,330,'#e0eee7')
    line(ox-25,oy,ox+415,oy,'#176751',3);text(ox+220,oy-10,'PCB north edge Y=0','small')
    # Screen origin on footprint center x=0 at ox+150, origin y=5.15 mm.
    cx=ox+150
    def xy(x,y):return cx+x*scale,oy+y*scale
    for name,x,y,w,h in [('1',1,8,1,3.5),('2',-1,8,1,3.5),('MP',-3.35,2.25,1.5,3.4),('MP',3.35,2.25,1.5,3.4)]:
        a,b=xy(x-w/2,y-h/2);rect(a,b,w*scale,h*scale,'#c6963d')
        a,b=xy(x,y);text(a-8,b+5,name,'small')
    # F.Fab body envelope at nominal seated design; local main body -1.6..4.4.
    ya,yb=(cy-4.4,cy+1.6) if not flip else (cy-1.6,cy+4.4)
    a,b=xy(-3.95,ya);rect(a,b,7.9*scale,(yb-ya)*scale,'none',color,True)
    mouth=yb if flip else ya
    a,b=xy(-2.9,mouth);c,d=xy(2.9,mouth);line(a,b,c,d,color,6)
    midx,midy=xy(0,mouth);sign=1 if flip else -1
    line(midx,midy,midx,midy+sign*50,color,4)
    line(midx,midy+sign*50,midx-7,midy+sign*38,color,3);line(midx,midy+sign*50,midx+7,midy+sign*38,color,3)
    text(ox-25,548,'Gold: fixed PCB lands. Dashed: body in hypothesized CPL pose.','small')
    text(ox-25,573,'Signal tails must land south; retention tabs must land north.','small')
    text(ox-25,598,'Pin 1 EAST; pin 2 WEST. A 180° turn also swaps pin sides.','small')
    if flip:text(ox-25,623,'Reject if opening, signal leads or retention tabs disagree.','small',color)
    else:text(ox-25,623,'Accept only after matching actual JLC 2D + 3D overlays.','small',color)
text(40,675,'Required board coordinates (mm): signal centers Y=8.00; retention centers Y=2.25; entry face Y=0.75.','sub')
text(40,704,'Origins west → east: J401 (6.85,5.15), J301 (16.25,5.15), J201 (25.65,5.15), J101 (35.05,5.15), J5001 (44.45,5.15).','small')
text(40,733,'Signal pin 1 = origin X+1; pin 2 = origin X−1. Retention pads = origin X±3.35. Body width 7.90; height 5.50 mm.','small')
text(40,765,'J1 remains CPL 270° but is ON HOLD: public 2D suggests 90°. Its opening must face EAST, pin 1 must land on VBAT.','sub','#a62f28')
text(40,795,'NOT RELEASED — diagram is derived geometry, not a manufacturer CAD model or JLCPCB assembly screenshot.','small')
s.append('</svg>');p=OUT/'north-jst-orientation.svg';p.write_text('\n'.join(s));subprocess.run(['rsvg-convert',str(p),'-o',str(OUT/'north-jst-orientation.png')],check=True)
