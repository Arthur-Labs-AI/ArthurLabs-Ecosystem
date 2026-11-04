#!/usr/bin/env python3
"""Apply horizontal electrode ECO to a baseline board; preserve unrelated source blocks.
Usage: python3 horizontal_jst_eco.py BASELINE_PCB OUTPUT_PCB LIBRARY_MOD
Run on scratch project first. Does not fill zones or export fabrication files.
"""
import copy, re, sys, uuid
from pathlib import Path
from rb02_sexpr import parse, dump, kids, first, Q
REFS = {'J101', 'J201', 'J301', 'J401', 'J5001'}
TARGET = 'Connector_JST:JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal'
FIELDS = {'Value':'S2B-PH-SM4-TB', 'MPN':'S2B-PH-SM4-TB(LF)(SN)', 'LCSC':'C295747',
 'Datasheet':'https://www.jst.com/wp-content/uploads/2025/06/ePH.pdf',
 'Spec':'JST PH 2.0 mm 2-pin horizontal side-entry SMT, PHR-2 housing + SPH-002T-P0.5S contacts; two isolated retention pads'}
def blocks(text, kind):
    # All board/schematic items are balanced sexprs; strings can contain parentheses.
    for m in re.finditer(r'(?m)^\t\('+re.escape(kind)+r'\s',text):
        depth=0
        for t in re.finditer(r'"(?:\\.|[^"\\])*"|[()]',text[m.start():]):
            if t[0]=='(': depth+=1
            elif t[0]==')':
                depth-=1
                if depth==0:
                    yield m.start(),m.start()+t.end(),text[m.start():m.start()+t.end()]
                    break

def apply(src, out, lib):
    text=Path(src).read_text(); template=parse(Path(lib).read_text()); edits=[]
    for start,end,raw in blocks(text,'footprint'):
        old=parse(raw); props={p[1]:p for p in kids(old,'property')}
        ref=props['Reference'][2]
        if ref not in REFS: continue
        assert 'Vertical' in old[1], ref
        new=copy.deepcopy(template); new[1]=Q(TARGET)
        # Keep footprint identity, schematic path, attributes, and project metadata.
        geom={'fp_line','fp_arc','fp_rect','fp_circle','fp_poly','fp_text','pad','model','descr','tags'}
        new=[n for n in old if not(isinstance(n,list) and n[0] in geom)]
        new[1]=Q(TARGET)
        first(new,'at')[2]='5.15'
        for p in kids(new,'property'):
            if p[1] in FIELDS: p[2]=Q(FIELDS[p[1]])
            if p[1]=='Description': p[2]=Q(str(p[2]).replace('vertical','horizontal side-entry'))
        oldpads={}
        for p in kids(old,'pad'): oldpads.setdefault(p[1],[]).append(p)
        for n in template:
            if not isinstance(n,list) or n[0] not in geom: continue
            n=copy.deepcopy(n)
            if n[0] in ('pad','fp_text'):
                at=first(n,'at')
                if at:
                    if len(at)==3: at.append('180')
                    else: at[3]='180'
            if n[0]=='pad':
                prev=oldpads[n[1]].pop(0)
                n += [copy.deepcopy(first(prev,'net')),copy.deepcopy(first(prev,'uuid'))]
                for key in ('pinfunction','pintype'):
                    if first(prev,key): n.append(copy.deepcopy(first(prev,key)))
            elif n[0] not in ('descr','tags','model'):
                n.append(['uuid',Q(str(uuid.uuid5(uuid.NAMESPACE_URL,ref+dump(n))))])
            new.append(n)
        edits.append((start,end,'\t'+dump(new)))
    assert len(edits)==5
    # Horizontal resistors fit the remaining strip before the unchanged clamp diodes.
    for start,end,raw in blocks(text,'footprint'):
        f=parse(raw); ref=next(p[2] for p in kids(f,'property') if p[1]=='Reference')
        if ref not in {'R101','R102','R201','R202','R301','R302','R401','R402','R5002'}: continue
        rot=90 if ref=='R5002' else 180
        first(f,'at')[2:]=['12.2' if ref=='R5002' else '11.1',str(rot)]
        for pad in kids(f,'pad'):
            at=first(pad,'at')
            at[3:]=[str(rot)]
        edits.append((start,end,'\t'+dump(f)))
    # Replace only affected electrode/retention traces and the short VCM approach.
    routes=[]
    def seg(net,a,b,w=.25):
        routes.append(['segment',['start',*a],['end',*b],['width',w],['layer',Q('F.Cu')],['net',Q(net)],
                       ['uuid',Q(str(uuid.uuid5(uuid.NAMESPACE_URL,net+str(a)+str(b))))]])
    root=parse(text)
    fps={next(p[2] for p in kids(f,'property') if p[1]=='Reference'):f for f in kids(root,'footprint')}
    for kind in ('segment','via'):
        for start,end,raw in blocks(text,kind):
            n=parse(raw); net=first(n,'net')[1]
            if net=='/Reference_VCM/RLD_SAFE' and (kind=='via' or first(n,'layer')[1]=='B.Cu'):
                for key in (('at',) if kind=='via' else ('start','end')):
                    xy=first(n,key)
                    if float(xy[1])==45 and float(xy[2])==13.9: xy[1]='46.5'
                edits.append((start,end,'\t'+dump(n))); continue
            if '/ELEC_' in net or (net=='/Reference_VCM/RLD_SAFE' and kind=='segment' and first(n,'layer')[1]=='F.Cu') or any(net==f'unconnected-({r}-PadMP)' for r in REFS):
                edits.append((start,end,'')); continue
            if kind=='segment' and net=='/VCM' and min(float(first(n,'start')[2]),float(first(n,'end')[2]))<14:
                edits.append((start,end,'')); continue
            if kind=='segment' and re.fullmatch(r'/CH[1-4]/HIZ_[PN]',net) and min(float(first(n,'start')[2]),float(first(n,'end')[2]))<13.8:
                edits.append((start,end,''))
    for ref in sorted(REFS):
        cx=float(first(fps[ref],'at')[1])
        seg(f'unconnected-({ref}-PadMP)',(cx-3.35,2.25),(cx+3.35,2.25),.2)
        if ref=='J5001': continue
        ch=int(ref[1])
        for pin,suffix,sgn,pol in [('1','01',1,'P'),('2','02',-1,'N')]:
            # Short 45-degree top-layer approaches; no electrode signal vias.
            x=cx+sgn; rx=cx+(3.175 if pol=='P' else -1.525)
            turn=10.975-abs(rx-x)
            seg(f'/CH{ch}/ELEC_{pol}',(x,8),(x,turn))
            seg(f'/CH{ch}/ELEC_{pol}',(x,turn),(rx,10.975))
            seg(f'/CH{ch}/ELEC_{pol}',(rx,10.975),(rx,11.1))
    for ch in range(1,5):
        for suffix,sgn,pol in [('01',1,'P'),('02',-1,'N')]:
            cx=float(first(fps[f'R{ch}{suffix}'],'at')[1]); px=cx-.825
            anchor=cx-.4; turn=11.1

            seg(f'/CH{ch}/HIZ_{pol}',(px,turn),(anchor,turn),.2)
            seg(f'/CH{ch}/HIZ_{pol}',(anchor,turn),(anchor,13.8),.2)
    # Retain the existing TP5 via and bottom trace; approach on the resistor's right.
    seg('/Reference_VCM/RLD_SAFE',(44.45,11.2875),(45.8,11.2875),.2)
    seg('/Reference_VCM/RLD_SAFE',(45.8,11.2875),(46.5,11.9875),.2)
    seg('/Reference_VCM/RLD_SAFE',(46.5,11.9875),(46.5,12.4),.2)
    seg('/Reference_VCM/RLD_SAFE',(46.5,12.4),(46.5,13.9),.2)
    seg('/Reference_VCM/RLD_SAFE',(43.45,8),(43.45,10.2875),.2)
    seg('/Reference_VCM/RLD_SAFE',(43.45,10.2875),(44.45,11.2875),.2)
    seg('/VCM',(44.45,13.1125),(43.4,14.1625),.2)
    seg('/VCM',(43.4,14.1625),(43.4,16.5),.2)
    seg('/VCM',(43.4,16.5),(45.8,18.9),.2)
    seg('/VCM',(45.8,18.9),(45.8,20.5),.2)
    text=text[:text.rfind(')')]+ '\n'+'\n'.join('\t'+dump(n) for n in routes)+ '\n'+text[text.rfind(')'):]

    for start,end,new in sorted(edits,reverse=True): text=text[:start]+new+text[end:]
    Path(out).write_text(text)
if __name__=='__main__': apply(*sys.argv[1:])
