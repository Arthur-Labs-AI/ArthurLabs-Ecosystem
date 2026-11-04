#!/usr/bin/env python3
"""Compare PCB numbered-pad geometry with archived, browser-visible JLC footprints.
This is a library comparison, never proof of a session's 3D-model/reel mapping.
"""
import csv
import json
import math
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
from rb02_sexpr import parse, kids, first
from jlc_rotations import factory_rotation

REV = Path(__file__).resolve().parent.parent
OUT = REV / 'evidence/placement-orientation-2026-10-20'
K = REV / 'kicad/ARTHUR_EMG_RevB'
OLD = REV / 'evidence/pre-manufacturing-audit/jlcpcb-closure/NOT_RELEASED_PENDING_FACTORY_APPROVAL'


def rotate(xy, angle):
    x, y = xy
    c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    return x*c+y*s, -x*s+y*c


def main():
    tree = parse((K/'ARTHUR_EMG_RevB.kicad_pcb').read_text())
    old = {r['Designator']: r for r in csv.DictReader(next(OLD.glob('*_CPL.csv')).open())}
    rows = []
    full = []
    for f in kids(tree, 'footprint'):
        props = {p[1]: str(p[2]) for p in kids(f, 'property')}
        ref = props['Reference']
        if ref not in old or not ref.startswith(('D', 'Q', 'U', 'X', 'J')):
            continue
        at = first(f, 'at'); x, y = map(float, at[1:3]); angle = float(at[3]) if len(at)>3 else 0
        pads = {}
        for p in kids(f, 'pad'):
            if not str(p[1]).isdigit():
                continue
            px, py = map(float, first(p, 'at')[1:3]); dx, dy = rotate((px, py), angle)
            net = first(p, 'net')
            pads[str(p[1])] = dict(board_xy_mm=[round(x+dx, 6), round(y+dy, 6)], net=str(net[-1]) if net else '', local_xy_mm=[px, py])
        lcsc = props['LCSC']
        svg = ET.fromstring((OUT/'sources'/f'JLC_{lcsc}_footprint.svg').read_text())
        jlc = {e.get('number'): tuple(float(a)*0.254 for a in e.get('c_origin').split(',')) for e in svg.iter() if e.get('c_partid')=='part_pad'}
        numbers = sorted(set(pads)&set(jlc), key=int)
        assert len(numbers)==len(pads), (ref, numbers, pads)
        board = [pads[n]['board_xy_mm'] for n in numbers]; lib = [jlc[n] for n in numbers]
        def center(points):
            avg = [sum(p[i] for p in points)/len(points) for i in (0,1)]
            return [(p[0]-avg[0],p[1]-avg[1]) for p in points]
        board, lib = center(board), center(lib)
        scores = {a: round(math.sqrt(sum(math.dist(p,rotate(q,a))**2 for p,q in zip(board,lib))/len(board)),6) for a in (0,90,180,270)}
        best = min(scores,key=scores.get)
        new = factory_rotation(ref, str(f[1]).split(':')[-1], angle)
        verdict = 'ALIGNS_WITH_PUBLIC_2D_LIBRARY' if new==best else 'MISMATCH_WITH_PUBLIC_2D_LIBRARY_HOLD'
        rec = dict(reference=ref,MPN=props.get('MPN',''),LCSC=lcsc,PCB_deg=angle,before_CPL_deg=float(old[ref]['Rotation']),candidate_CPL_deg=new,public_2D_best_CPL_deg=best,public_2D_best_RMS_mm=scores[best],pad1_X_mm=pads['1']['board_xy_mm'][0],pad1_Y_mm=pads['1']['board_xy_mm'][1],pad1_net=pads['1']['net'],library_result=verdict,assembly_3D_preview='UNVERIFIED')
        rows.append(rec); full.append(dict(**rec,all_numbered_pads=pads,RMS_by_angle_mm=scores,method='centered numbered-pad fit; SVG coordinates ×0.254; CCW top-view rotations; origin translation removed'))
    rows.sort(key=lambda r:r['reference'])
    assert len(rows)==29
    with (OUT/'polarized-orientation-review.csv').open('w',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
    (OUT/'polarized-pad-analysis.json').write_text(json.dumps(full,indent=2)+'\n')
    print(json.dumps(rows,indent=2))


if __name__=='__main__':
    main()
