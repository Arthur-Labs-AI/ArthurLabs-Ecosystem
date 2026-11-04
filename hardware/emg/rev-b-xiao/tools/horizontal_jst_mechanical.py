#!/usr/bin/env python3
"""Read-only nominal mechanical audit and dimensioned previews for the horizontal JST ECO.
No manufacturer STEP is implied: header/plug bounds are reconstructed from catalog
numbers; their registration to the footprint is a documented engineering derivation.
Usage: python3 horizontal_jst_mechanical.py --pcb BOARD --out EVIDENCE_DIRECTORY
"""
import argparse, copy, csv, hashlib, json, math
from pathlib import Path
from html import escape
from rb02_sexpr import parse, kids, first, dump, Q
REFS = ('J401','J301','J201','J101','J5001')
D = dict(pitch=2.0,header_width=7.9,header_height=5.5,header_depth=6.0,
         header_tail_reference=2.6,reinforcement_extension=1.6,
         housing_width=5.8,housing_axial=6.85,housing_thickness=4.5,
         mated_reference=9.6)
A = dict(withdrawal_design_travel=7.0,clearance_proposal=.5,
         plug_z_offset=.5,straight_wire_example=5.0,
         cable_od_example=1.5,illustrative_bend_radii=[3,5,8])

def props(f): return {p[1]:p[2] for p in kids(f,'property')}
def xy(f,x,y):
    a=first(f,'at');t=math.radians(float(a[3]) if len(a)>3 else 0)
    return (float(a[1])+x*math.cos(t)+y*math.sin(t),float(a[2])-x*math.sin(t)+y*math.cos(t))
def lines(f,layer):
    out=[]
    for n in f:
        if not isinstance(n,list) or first(n,'layer')!=['layer',layer]: continue
        if n[0]=='fp_line':out.append((xy(f,*map(float,first(n,'start')[1:])),xy(f,*map(float,first(n,'end')[1:]))))
        elif n[0]=='fp_rect':
            x0,y0=map(float,first(n,'start')[1:]);x1,y1=map(float,first(n,'end')[1:])
            pts=[xy(f,x0,y0),xy(f,x1,y0),xy(f,x1,y1),xy(f,x0,y1)]
            out.extend(zip(pts,pts[1:]+pts[:1]))
        elif n[0]=='fp_poly':
            pts=[xy(f,*map(float,q[1:])) for q in kids(first(n,'pts'),'xy')]
            out.extend(zip(pts,pts[1:]+pts[:1]))
    return out
def point_segment(p,a,b):
    dx,dy=b[0]-a[0],b[1]-a[1];l=dx*dx+dy*dy
    t=max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/l)) if l else 0
    return math.dist(p,(a[0]+t*dx,a[1]+t*dy))
def segment_distance(s,t):
    # This is used only after DRC confirms nonintersecting courtyards.
    return min(point_segment(p,*q) for q,ps in [(s,t),(t,s)] for p in ps)
def nearest(a,b): return min(segment_distance(s,t) for s in a for t in b)
def bounds(points): return [min(x for x,y in points),min(y for x,y in points),max(x for x,y in points),max(y for x,y in points)]
def close(a,b): return abs(float(a)-float(b))<1e-6
class SVG:
    def __init__(self,w,h,title,sub):
        self.s=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',f'<rect width="{w}" height="{h}" fill="#101a27"/>']
        self.text(36,43,title,25);self.text(36,72,sub,14,'#afc9df')
    def text(self,x,y,s,size=14,color='#edf5ff'):
        self.s.append(f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" font-family="sans-serif">{escape(str(s))}</text>')
    def line(self,x1,y1,x2,y2,color='#658899',width=1,dash=''):
        self.s.append(f'<path d="M{x1} {y1} L{x2} {y2}" fill="none" stroke="{color}" stroke-width="{width}" stroke-dasharray="{dash}"/>')
    def rect(self,x,y,w,h,fill='none',stroke='#658899',dash='',opacity=1):
        self.s.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" fill-opacity="{opacity}" stroke="{stroke}" stroke-width="1.3" stroke-dasharray="{dash}"/>')
    def dim(self,x1,y1,x2,y2,label,color='#def0ff'):
        self.line(x1,y1,x2,y2,color)
        if y1==y2:
            for x in [x1,x2]:self.line(x,y1-5,x,y1+5,color)
            self.text((x1+x2)/2-35,y1-8,label,12,color)
        else:
            for y in [y1,y2]:self.line(x1-5,y,x1+5,y,color)
            self.text(x1+8,(y1+y2)/2,label,12,color)
    def save(self,p):p.write_text('\n'.join(self.s+['</svg>'])+'\n')

def vrml_box(box,color):
    x0,y0,z0,x1,y1,z1=box
    return 'Transform { translation %s children [ Shape { appearance Appearance { material Material { diffuseColor %s } } geometry Box { size %s } } ] }\n' % (
        ' '.join(map(str,[(x0+x1)/5.08,-(y0+y1)/5.08,(z0+z1)/5.08])),color,
        ' '.join(map(str,[(x1-x0)/2.54,(y1-y0)/2.54,(z1-z0)/2.54])))
def frame(box,color):
    x0,y0,z0,x1,y1,z1=box;w=.09;s=''
    for y in [y0,y1]:
        for z in [z0,z1]:s+=vrml_box((x0,y-w/2,z-w/2,x1,y+w/2,z+w/2),color)
    for x in [x0,x1]:
        for z in [z0,z1]:s+=vrml_box((x-w/2,y0,z-w/2,x+w/2,y1,z+w/2),color)
        for y in [y0,y1]:s+=vrml_box((x-w/2,y-w/2,z0,x+w/2,y+w/2,z1),color)
    return s

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--pcb',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);a=ap.parse_args()
    a.out.mkdir(parents=True,exist_ok=True);root=parse(a.pcb.read_text());fps={props(f)['Reference']:f for f in kids(root,'footprint')}
    edge=[n for n in root if isinstance(n,list) and first(n,'layer')==['layer','Edge.Cuts']]
    pts=[tuple(map(float,first(n,k)[1:])) for n in edge for k in ['start','mid','end'] if first(n,k)]
    ext=bounds(pts);assert all(close(x,y) for x,y in zip(ext,[0,0,51.3,64.95]))
    checks={'outline_51_30_x_64_95':True};rows=[];courts={r:lines(f,'F.CrtYd') for r,f in fps.items()}
    for ref in REFS:
        f=fps[ref];p=props(f);at=list(map(float,first(f,'at')[1:]));assert at[2]==180
        assert f[1].endswith('JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal')
        assert p['MPN']=='S2B-PH-SM4-TB(LF)(SN)' and p['LCSC']=='C295747'
        padpoints=[];lands=[]
        for pad in kids(f,'pad'):
            num=pad[1];pos=first(pad,'at');size=first(pad,'size');x,y=map(float,pos[1:3]);w,h=map(float,size[1:3]);pw,ph=(1,3.5) if num in ['1','2'] else (1.5,3.4)
            assert close(w,pw) and close(h,ph)
            assert close(x,(-1 if num=='1' else 1)) and close(y,-2.85) if num in ['1','2'] else close(abs(x),3.35) and close(y,2.9)
            assert close(pos[3],180)
            padpoints += [xy(f,x+dx*w/2,y+dy*h/2) for dx in [-1,1] for dy in [-1,1]]
            lands.append(dict(pad=num,centre=xy(f,x,y),size=[w,h],net=first(pad,'net')[1]))
        pcb_bounds=bounds(padpoints);edge_gap=min(pcb_bounds[0],pcb_bounds[1],51.3-pcb_bounds[2],64.95-pcb_bounds[3]);assert edge_gap>=.5
        candidates=[(nearest(courts[ref],c),r) for r,c in courts.items() if r!=ref and c]
        gap,other=min(candidates)
        # Register catalog main rear plane to the central rear F.Fab wall at local Y=-1.6.
        # Lip/keys and actual contact seating depth are NOT independently controlled here.
        front=at[1]-4.4;rear=front+D['header_depth'];wire_exit=rear-D['mated_reference'];tip=wire_exit+D['housing_axial']
        assert close(front,.75) and close(wire_exit,-2.85) and close(tip,4.0)
        rows.append(dict(ref=ref,at_mm_deg=at,pin1_side='east',entry='north / -Y',lands=lands,
          copper_edge_gap_mm=edge_gap,nearest_courtyard={'ref':other,'gap_mm':gap},
          header_main_body_xy=[at[0]-3.95,front,at[0]+3.95,rear],
          seated_housing_xy=[at[0]-2.9,wire_exit,at[0]+2.9,tip],
          removed_housing_xy=[at[0]-2.9,wire_exit-7,at[0]+2.9,tip-7],
          housing_sweep_xy=[at[0]-2.9,wire_exit-7,at[0]+2.9,tip],
          signal_copper_bbox=pcb_bounds))
        checks[ref+'_part_lands_rotation_edge']=True
    pairs=[]
    for l,r in zip(rows,rows[1:]):
        pitch=r['at_mm_deg'][0]-l['at_mm_deg'][0]
        pairs.append(dict(left=l['ref'],right=r['ref'],pitch_mm=pitch,header_gap_mm=pitch-7.9,
                          housing_gap_mm=pitch-5.8,housing_to_adjacent_header_x_gap_mm=pitch-2.9-3.95,
                          courtyard_gap_mm=nearest(courts[l['ref']],courts[r['ref']])))
    assert all(x['header_gap_mm']>0 and x['courtyard_gap_mm']>0 for x in pairs)
    # Check 71 samples of the isolated five-plug withdrawal sweep against other headers' XY bounds.
    # Own header is deliberately excluded: housing nests inside it; cavity/latch detail is unavailable.
    sweep_checks=0
    for row in rows:
        for step in range(71):
            lo=row['seated_housing_xy'].copy();lo[1]-=step*.1;lo[3]-=step*.1
            for other in rows:
                if row['ref']==other['ref']:continue
                hb=other['header_main_body_xy'];assert lo[2]<=hb[0] or hb[2]<=lo[0] or lo[3]<=hb[1] or hb[3]<=lo[1]
                sweep_checks+=1
    checks['sampled_adjacent_header_sweeps_nonintersecting']=True
    foreign_checks=0
    for row in rows:
        sweep=row['housing_sweep_xy']
        for ref,segments in courts.items():
            if ref==row['ref'] or not segments:continue
            bb=bounds([p for seg in segments for p in seg])
            assert sweep[2]<=bb[0] or bb[2]<=sweep[0] or sweep[3]<=bb[1] or bb[3]<=sweep[1], (row['ref'],ref)
            foreign_checks+=1
    checks['swept_plugs_clear_foreign_courtyard_bounding_boxes']=True
    resistor_gaps={j:{ref:nearest(courts[j],courts[ref]) for ref in refs} for j,refs in
                   [('J101',['R101','R102']),('J201',['R201','R202']),('J301',['R301','R302']),('J401',['R401','R402']),('J5001',['R5002'])]}

    result=dict(units='mm; x east, y south, z above F.Cu plane',source_sha256=hashlib.sha256(a.pcb.read_bytes()).hexdigest(),
       board=dict(outline_bounds=ext,size=[ext[2]-ext[0],ext[3]-ext[1]],nominal_thickness=float(first(first(root,'general'),'thickness')[1]),old_61_x_52='superseded PCB target, not an enclosure constraint'),
       manufacturer_catalog_nominals=D,design_assumptions=A,checks=checks,connectors=rows,adjacent_pairs=pairs,
       sweep_checks=sweep_checks,foreign_courtyard_sweep_checks=foreign_checks,resistor_courtyard_gaps=resistor_gaps,derivations=dict(main_header_rear_y=6.75,entry_face_y=.75,
       seated_wire_exit_y=-2.85,seated_housing_tip_y=4.0,reference_overlap=3.25,
       removed_wire_exit_y=-9.85,removed_housing_tip_y=-3.0,removed_to_face_gap=3.75,
       reference_axial_stroke_note='3.25 is an inference from catalog length overlap, not a manufacturer-specified disengagement stroke; use proposed 7 mm travel pending samples'),
       limitations=['Catalog dimensions are nominal/reference, not a complete tolerance drawing.',
       'Datum registration and housing Z placement are engineering derivations/assumptions; no qualified manufacturer assembly CAD.',
       'No contact/cavity/key/friction-lock mechanics or physical sample force/cycle tests.',
       'No actual enclosure, grommet, harness OD, bend radius, strain relief or strap load specified.',
       'Nominal XY sweep checks only; own-header nesting and component 3D collisions not proven.'])
    (a.out/'measurements.json').write_text(json.dumps(result,indent=2)+'\n')
    with (a.out/'connector-clearances.csv').open('w',newline='') as fo:
        w=csv.writer(fo);w.writerow(['Reference','X','Y','Rotation','EntryFaceY','SeatedWireExitY','RemovedWireExitY_7mmProposal','CopperEdgeGap','NearestCourtyard','CourtyardGap'])
        for r in rows:w.writerow([r['ref'],*r['at_mm_deg'],.75,-2.85,-9.85,round(r['copper_edge_gap_mm'],6),r['nearest_courtyard']['ref'],round(r['nearest_courtyard']['gap_mm'],6)])
    draw_top(a.out,root,fps,rows,courts,pairs)
    draw_side(a.out)
    draw_interface(a.out,rows)
    previews(a.out,root)
    print(f'{len(checks)} mechanical assertions PASS; {sweep_checks} nominal adjacent-header sweep samples and {foreign_checks} foreign-courtyard bounds PASS; full integration UNVERIFIED')

def draw_top(out,root,fps,rows,courts,pairs):
    s=SVG(1500,1210,'Five-connector placement and mating sweep','NORTH = -Y | current board 51.30 x 64.95 mm | all clearances nominal, not a tolerance signoff')
    ox,oy,k=95,550,25
    def p(x,y):return ox+k*x,oy+k*y
    def rect(b,fill,stroke,dash='',opacity=1):
        x,y=p(b[0],b[1]);s.rect(x,y,(b[2]-b[0])*k,(b[3]-b[1])*k,fill,stroke,dash,opacity)
    rect([0,0,51.3,18.5],'#173d3b','#69a38d');s.text(ox,oy+19.5*k,'Board continues south; unchanged outline is shown separately.',15)
    for ref,f in fps.items():
        if ref in REFS:continue
        for aa,bb in lines(f,'F.Fab'):
            if max(aa[1],bb[1])<18.5:s.line(*p(*aa),*p(*bb),'#75989e',.7)
    for r in rows:
        cx=r['at_mm_deg'][0]
        rect(r['housing_sweep_xy'],'#15363f','#8de3fa','6,5',.45)
        for aa,bb in courts[r['ref']]:s.line(*p(*aa),*p(*bb),'#d097f0',1.1)
        for aa,bb in lines(fps[r['ref']],'F.Fab'):s.line(*p(*aa),*p(*bb),'#ffdc92',1.8)
        rect(r['seated_housing_xy'],'#23b8d1','#8febff','',.5)
        rect(r['removed_housing_xy'],'none','#8febff','7,5')
        for pad in r['lands']:
            x,y=pad['centre'];w,h=pad['size'];rect([x-w/2,y-h/2,x+w/2,y+h/2],'#a67755','#e9a878','',.9)
        x,y=p(cx,5.45);s.text(x-30,y,r['ref'],20);s.text(x-34,y+22,'pin 1 east',11,'#d9c79f')
        x,y=p(cx,-12.8);s.text(x-30,y,'7 mm travel*',12);s.line(x,y+10,x,oy-10,'#88def2',1.5)
    # Dimensions over first pair; highlighted row widths are source-derived.
    s.dim(*p(rows[0]['at_mm_deg'][0],-14.6),*p(rows[1]['at_mm_deg'][0],-14.6),'9.40 pitch')
    s.text(65,115,'GOLD = header F.Fab projection  |  CYAN = seated PHR-2 bound  |  DASHED = proposed removed pose / sweep',15)
    s.text(65,141,'Side entry face y=+0.75; nominal wire exit y=-2.85. Seating registration is derived from the 9.6 mm assembly reference.',14)
    s.text(65,167,'*7 mm is an engineering service allowance, not a JST withdrawal specification. Own-header nesting is not collision-tested.',14,'#ffc680')
    s.text(65,1090,'Measured: header gap 1.50 | plug gap 3.60 | plug-to-neighbour header X gap 2.55 | courtyard gap 0.20 | copper-edge 0.55 mm',14)
    s.text(65,1121,'Resistor courtyard minima: channel row 0.12 mm; R5002 0.27 mm. Tool/finger access and tolerance stack remain UNVERIFIED.',14)
    s.text(65,1165,'NOT RELEASED | no enclosure size assumed | manufacturer nominal dimensions + engineering registration',15,'#ffbf79')
    s.save(out/'01-mating-sweep-plan.svg')

def draw_side(out):
    s=SVG(1500,1280,'Seated plug, withdrawal, and cable-bend section','Section through one connector | z=0 at top PCB | same nominal geometry applies to all five')
    # Display north to left. Horizontal plotted coordinate is PCB Y; vertical coordinate is Z.
    ox,oy,k=455,470,34
    def p(y,z):return ox+k*y,oy-k*z
    def box(y0,z0,y1,z1,fill,stroke,dash='',opacity=1):
        x,y=p(y0,z1);s.rect(x,y,(y1-y0)*k,(z1-z0)*k,fill,stroke,dash,opacity)
    box(0,-1.6,13,0,'#20483b','#81b08d')
    box(.75,0,6.75,5.5,'none','#ffdc92')
    box(-2.85,.5,4,5,'#1c95ad','#8de3fa','',.55)
    box(-9.85,.5,-3,5,'none','#8de3fa','7,5')
    s.line(*p(-9.85,2.75),*p(-12.3,2.75),'#a6b3bf',3)
    s.line(*p(-2.85,2.75),*p(-7.85,2.75),'#ef927a',4)
    s.dim(*p(.75,6.8),*p(6.75,6.8),'6.00 header')
    s.dim(*p(-2.85,8.1),*p(6.75,8.1),'9.60 mated (reference)')
    s.dim(*p(-2.85,6.1),*p(4,6.1),'6.85 housing')
    s.dim(*p(-9.85,-3),*p(-2.85,-3),'7.00 proposed travel')
    s.dim(*p(11.6,0),*p(11.6,5.5),'5.50 header height')
    x,y=p(0,-1.6);s.text(x+7,y+22,'PCB 1.60 nominal; north edge at y=0',13)
    s.text(55,115,'GOLD = manufacturer header main-body bound; CYAN = catalog-sized plug at derived seating position.',15)
    s.text(55,142,'Plug lower Z=0.50 is an illustration assumption. No cavity, lock, contacts, or assembly tolerances are modeled.',14,'#ffc680')
    s.text(55,635,'Cable routing allowance — illustrative downward 90-degree bend toward the inner electrode strap',20)
    # Separate diagram leaves room for bends without suggesting routing through the board.
    ox2,oy2,k2=1180,960,22
    def q(y,z):return ox2+k2*y,oy2-k2*z
    s.line(*q(0,-2),*q(0,7),'#c4dbe7',1,'5,4');s.text(ox2+12,oy2+60,'y=0 board edge',12)
    for R,col in [(3,'#82dfc2'),(5,'#f2c87d'),(8,'#b6a0ed')]:
        vals=[(-2.85,2.75),(-7.85,2.75)]
        for i in range(1,33):
            th=math.pi/2*i/32;vals.append((-7.85-R*math.sin(th),2.75-R+R*math.cos(th)))
        for aa,bb in zip(vals,vals[1:]):s.line(*q(*aa),*q(*bb),col,2)
        yy,zz=vals[-1];s.line(*q(yy,zz),*q(yy,zz-2),col,2);s.text(*q(yy-.8,zz-3.2),f'R={R}',12,col)
    s.text(55,690,'5 mm straight lead + trial radii 3 / 5 / 8 mm;',14)
    s.text(55,714,'wire OD 1.5 mm shown only as a sizing example.',14)
    s.text(55,748,'Northmost wire surface, including OD/2:',14)
    for i,R in enumerate([3,5,8]):s.text(75,780+i*25,f'R={R}: y = -{2.85+5+R+.75:.2f} mm (illustrative)',14)
    s.text(55,900,'No bend radius is qualified for the selected harness.',14,'#ffc680')
    s.text(55,926,'Do not bend at the housing or use conductors for unplugging.',14)
    s.text(55,1180,'Strap load -> shell-mounted clamp -> slack/service section -> plug; keep the outer tightening strap load out of the PCB.',14)
    s.text(55,1211,'Clamps/grommets, pull loads, fatigue cycles, and cutout tolerances require the separate enclosure/harness design.',14)
    s.text(55,1252,'NOT RELEASED | nominal geometry only; no human-use, force, fatigue or full 3D clearance validation',15,'#ffbf79')
    s.save(out/'02-side-and-bend-section.svg')

def draw_interface(out,rows):
    s=SVG(1200,1760,'Board datum and future enclosure interface','Authoritative outline preserved | 61 x 52 mm was an older PCB target, not an enclosure limit')
    k,ox,oy=17,150,150
    s.rect(ox,oy,51.3*k,64.95*k,'#193c38','#85b998')
    s.s[-1]=s.s[-1].replace(' fill=', f' rx="{k}" fill=',1)
    s.dim(ox,oy-60,ox+51.3*k,oy-60,'51.30 mm')
    s.dim(ox+51.3*k+35,oy,ox+51.3*k+35,oy+64.95*k,'64.95 mm')
    for r in rows:
        cx=r['at_mm_deg'][0];s.rect(ox+(cx-3.95)*k,oy+.75*k,7.9*k,7.6*k,'none','#ffdc92')
        s.rect(ox+(cx-2.9)*k,oy-2.85*k,5.8*k,6.85*k,'#23889d','#8ee8fa')
        s.text(ox+cx*k-25,oy+5.4*k,r['ref'],12)
    s.text(ox+12,oy+19*k,'INNER ELECTRODE STRAP: route north; detailed path pending',17)
    s.text(ox+12,oy+21*k,'OUTER TIGHTENING STRAP: separate shell/lug load path',17)
    s.text(ox+12,oy+25*k,'No final enclosure, lugs, clamp or battery geometry is assumed.',15)
    s.text(ox+12,oy+27*k,'Source board outline and component locations are unchanged.',15)
    s.text(ox+12,oy+61*k,'USB south; J1 and U.FL east-side access must remain available.',14)
    s.text(55,1325,'Local reservations to carry into enclosure CAD (engineering starting values, not a fixed case size)',19)
    texts=['1. Header region: x=2.90..48.40, main body y=0.75..6.75, z up to 5.50 mm.',
           '2. Seated plug region: x=3.95..47.35, y=-2.85..4.00; continuous path north of PCB.',
           '3. Proposed service travel: clear y down to -9.85; open lid or a plug-sized service hatch.',
           '4. Add 0.50 mm trial solid clearance: header ceiling >=6.00; seated north wall <=-3.35.',
           '5. Cable-only holes may be smaller than a plug, but then assembly/service must occur with the lid open.',
           '6. Keep five channels identified; J5001 uses one electrode conductor, and its NC terminal stays isolated.',
           '7. Shell-mounted strain relief intercepts strap/cable tension before it reaches the connector solder tabs.',
           '8. No fastener, lug or clip positions are approved by these reservation zones.']
    for i,t in enumerate(texts):s.text(55,1364+i*33,t,14)
    s.text(55,1662,'Dimension history: earlier target 61 x 52 -> V1 51.30 x 62.45 -> routing V1C 51.30 x 64.95 -> ECO unchanged.',14)
    s.text(55,1710,'NOT RELEASED | final enclosure integration is a separate mechanical design task',17,'#ffbf79')
    s.save(out/'03-enclosure-interface.svg')

def previews(out,root):
    for travel,name in [(0,'seated'),(7,'withdrawn')]:
        model='#VRML V2.0 utf8\n# Dimensions-based bounds ONLY; not manufacturer CAD, not a qualified mating model.\n'
        # Positive local Y points out of this header; VRML Y conversion is in vrml_box.
        model+=frame((-3.95,-1.6,0,3.95,4.4,5.5),'0.95 0.72 0.22')
        # Reinforcement ears / full F.Fab back extent is shown only as another outline.
        model+=frame((-3.95,-3.2,0,3.95,4.4,.15),'0.6 0.5 0.3')
        model+=vrml_box((-2.9,1.15+travel,.5,2.9,8+travel,5),'0.12 0.7 0.85')
        for dx in [-1,1]:model+=vrml_box((dx-.75,8+travel,2,dx+.75,13+travel,3.5),'0.82 0.23 0.16')
        d=out/'previews'/name;d.mkdir(parents=True,exist_ok=True);(d/'nominal-bounds.wrl').write_text(model)
        r=copy.deepcopy(root)
        for f in kids(r,'footprint'):
            if props(f)['Reference'] not in REFS:continue
            f[:]=[n for n in f if not(isinstance(n,list) and n[0]=='model')]
            f.append(['model',Q('${KIPRJMOD}/nominal-bounds.wrl'),['offset',['xyz',0,0,0]],['scale',['xyz',1,1,1]],['rotate',['xyz',0,0,0]]])
        (d/'NOT_BOARD_SOURCE_DO_NOT_FAB.kicad_pcb').write_text(dump(r)+'\n')
if __name__=='__main__':main()
