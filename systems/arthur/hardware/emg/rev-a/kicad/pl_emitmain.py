import json, sys, hashlib
sys.path.insert(0, r'D:\A.R.T.H.U.R\hardware\emg\rev-a\kicad')
import pl_rows_a as A
import pl_rows_b as B
import pl_core_a as CA
import pl_core_b as CB
import pl_core_c as CC
import pl_core_d as CD
import pl_final_b as FB
D = json.load(open(r'C:\Users\nikol\AppData\Local\Temp\dsh-217e9p\pcbdata.json'))
NETS = D['nets']
N2C = D['name2code']
PINS = D['comp_pins']
ROWS = A.ROWS_A + B.ROWS_B
VALOF = dict(CC.VALS)
for k in ['TP201', 'TP401', 'TP402', 'TP601', 'TP602', 'TP603', 'TP604', 'TP605', 'TP606', 'TP607', 'TP608', 'TP609', 'TP610', 'TP611', 'TP111', 'TP112', 'TP113', 'TP114', 'TP115', 'TP116', 'TP117', 'TP118']:
    VALOF[k] = 'TP_SMD'
for k, v in CD.EXTRA_VAL.items():
    VALOF[k] = v
FPOF = {}
for (r, fp, x, y, rot, flag) in ROWS:
    FPOF[r] = fp
for k, v in CD.EXTRA_FP.items():
    FPOF[k] = v
FULLEX = {}
for r, d in PINS.items():
    FULLEX[r] = dict(d)
for r, d in CD.EXTRA_NETS.items():
    FULLEX[r] = dict(d)
OUT = r'D:\A.R.T.H.U.R\hardware\emg\rev-a\kicad\ARTHUR_EMG_RevA\ARTHUR_EMG_RevA.kicad_pcb'
EXTRA = [
    ('CM101', 4.5, 10.0, 0, 'B.Cu', 1),
    ('CM102', 4.5, 8.0, 0, 'B.Cu', 1),
    ('CM201', 12.5, 10.0, 0, 'B.Cu', 1),
    ('CM202', 12.5, 8.0, 0, 'B.Cu', 1),
    ('CM301', 20.5, 10.0, 0, 'B.Cu', 1),
    ('CM302', 20.5, 8.0, 0, 'B.Cu', 1),
    ('CM401', 28.5, 10.0, 0, 'B.Cu', 1),
    ('CM402', 28.5, 8.0, 0, 'B.Cu', 1),
    ('D101', 8.0, 10.0, 0, 'B.Cu', 1),
    ('D201', 16.0, 10.0, 0, 'B.Cu', 1),
    ('D301', 24.0, 10.0, 0, 'B.Cu', 1),
    ('D401', 32.0, 10.0, 0, 'B.Cu', 1),
    ('C607B', 21.5, 12.3, 0, 'F.Cu', 0),
    ('C608B', 21.5, 21.7, 0, 'F.Cu', 0),
]
def ts_of(s):
    h = hashlib.md5(s.encode()).hexdigest()
    return h[:8] + '-' + h[8:12] + '-4' + h[13:16] + '-8' + h[16:19] + '-' + h[19:31]
def codeof(name):
    if name is None:
        return '0'
    c = N2C.get(name)
    if c is None:
        raise Exception('unknown net ' + name)
    return c
O = []
O.append('(kicad_pcb (version 20260206) (generator "ARTHUR-placement") (generator_version "10.0")')
O.append('\t(general (thickness 1.6))')
O.append('\t(paper "A4")')
O.append('\t(title_block (title "ARTHUR EMG Rev A") (company "A.R.T.H.U.R.") (rev "A-placement"))')
O.append(FB.LAYERS_TXT.rstrip())
O.append(FB.SETUP_TXT.rstrip())
O.append(FB.NETCLASS_TXT.rstrip())
O.append('\t(net 0 "")')
for code in sorted(NETS.keys(), key=lambda c: int(c)):
    O.append('\t(net %s "%s")' % (code, NETS[code]))
J8001_DONE = [False]
def fp_block(ref, libfp, val, x, y, rot, layer, dnp):
    key = CB.FPKEY[libfp]
    pads = CA.PADMAP[key]
    pin2net = FULLEX.get(ref, {})
    ts = ts_of('fp' + ref)
    silk = 'F.SilkS' if layer == 'F.Cu' else 'B.SilkS'
    fab = 'F.Fab' if layer == 'F.Cu' else 'B.Fab'
    L = []
    L.append('\t(footprint "%s"' % libfp)
    L.append('\t\t(version 20260206)')
    L.append('\t\t(generator "ARTHUR-placement")')
    L.append('\t\t(layer "%s")' % layer)
    L.append('\t\t(tstamp %s)' % ts)
    if rot == 0:
        L.append('\t\t(at %.2f %.2f)' % (x, y))
    else:
        L.append('\t\t(at %.2f %.2f %s)' % (x, y, rot))
    L.append('\t\t(descr "placement rev A")')
    L.append('\t\t(property "Reference" "%s"' % ref)
    L.append('\t\t\t(at 0 -2.2 0)')
    L.append('\t\t\t(layer "%s")' % silk)
    L.append('\t\t\t(effects (font (size 0.8 0.8) (thickness 0.12))))')
    L.append('\t\t(property "Value" "%s"' % val)
    L.append('\t\t\t(at 0 2.2 0)')
    L.append('\t\t\t(layer "%s")' % fab)
    L.append('\t\t\t(hide yes)')
    L.append('\t\t\t(effects (font (size 0.8 0.8) (thickness 0.12))))')
    L.append('\t\t(property "Footprint" "%s"' % libfp)
    L.append('\t\t\t(at 0 0 0)')
    L.append('\t\t\t(hide yes)')
    L.append('\t\t\t(layer "%s")' % fab)
    L.append('\t\t\t(effects (font (size 1 1) (thickness 0.15))))')
    if dnp:
        L.append('\t\t(attr smd dnp)')
    else:
        L.append('\t\t(attr smd)')
    for p in pads:
        net = pin2net.get(p)
        if net is None:
            L.append('\t\t(pad "%s" (net 0 ""))' % p)
        else:
            L.append('\t\t(pad "%s" (net %s "%s"))' % (p, codeof(net), net))
    L.append('\t\t(embedded_fonts no)')
    L.append('\t)')
    return '\n'.join(L)
for (r, fp, x, y, rot, flag) in ROWS:
    if r == 'J8001':
        O.append(fp_block(r, fp, VALOF.get(r, r), x, y, rot, 'B.Cu', True))
        J8001_DONE[0] = True
    else:
        O.append(fp_block(r, fp, VALOF.get(r, r), x, y, rot, 'F.Cu', False))
for (r, x, y, rot, layer, dnp) in EXTRA:
    O.append(fp_block(r, CD.EXTRA_FP[r], CD.EXTRA_VAL[r], x, y, rot, layer, bool(dnp) and r[0] in ('C', 'D')))
O.append('\t(gr_rect (start 0 0) (end 45 30) (layer "Edge.Cuts") (width 0.1) (fill none) (tstamp %s))' % ts_of('edge'))
def keepout(name, x1, y1, x2, y2):
    pts = '(pts (xy %.2f %.2f) (xy %.2f %.2f) (xy %.2f %.2f) (xy %.2f %.2f))' % (x1, y1, x2, y1, x2, y2, x1, y2)
    return '\t(zone (net 0) (net_name "") (locked no) (layer "F.Cu") (tstamp %s) (name "%s") (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25) (keepout (tracks not_allowed) (vias not_allowed) (pads not_allowed) (footprints not_allowed) (copperpour not_allowed)) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon %s))' % (ts_of(name), name, pts)
O.append(keepout('ANT_KEEPOUT', 41.5, 9.0, 45.0, 21.0))
def grtext(txt, x, y, layer, size=1.0):
    return '\t(gr_text "%s" (at %.2f %.2f) (layer "%s") (tstamp %s) (effects (font (size %.2f %.2f) (thickness 0.15))))' % (txt, x, y, layer, ts_of(txt + str(x)), size, size)
O.append(grtext('ARTHUR EMG Rev A - PLACEMENT REV A (no copper)', 22.5, 29.0, 'F.SilkS', 1.0))
O.append(grtext('ELECTRODE EDGE (CH1-CH4 + RLD)', 22.5, 29.6, 'Cmts.User', 0.8))
O.append(grtext('USB / POWER SIDE', 22.5, 0.6, 'Cmts.User', 0.8))
O.append(grtext('RF EDGE ->', 43.5, 28.0, 'Cmts.User', 0.8))
O.append(grtext('ANT KEEPOUT: no copper/components (Raytac -1MV2 TBD-verify)', 43.25, 8.4, 'Cmts.User', 0.6))
O.append(grtext('BATTERY 503040-class REGION, BOTTOM SIDE (TBD)', 22.5, 15.0, 'B.SilkS', 1.0))
O.append('\t(gr_rect (start 2 2) (end 43 28) (layer "Cmts.User") (width 0.1) (fill none) (tstamp %s))' % ts_of('batrect'))
O.append(')')
open(OUT, 'w', encoding='utf-8').write('\n'.join(O) + '\n')
print('pcb written', len(O), 'blocks')
