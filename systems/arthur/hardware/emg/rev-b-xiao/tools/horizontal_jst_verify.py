#!/usr/bin/env python3
"""Independent structural and net invariants for the horizontal JST ECO.
Usage: python3 horizontal_jst_verify.py BASELINE FINAL OUT_JSON
KiCad DRC and schematic parity remain separate required checks.
"""
import collections, json, math, sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from rb02_sexpr import parse, kids, first
REFS={'J101','J201','J301','J401','J5001'}
MOVED={f'R{ch}{suffix}' for ch in range(1,5) for suffix in ['01','02']}|{'R5002'}
def norm(n):
    if isinstance(n,list): return [norm(x) for x in n]
    try:return str(Decimal(n).normalize())
    except InvalidOperation:return str(n)
def footprints(root):return {next(p[2] for p in kids(f,'property') if p[1]=='Reference'):f for f in kids(root,'footprint')}
def nets(f):return sorted((p[1],first(p,'net',['net',''])[1]) for p in kids(f,'pad'))
def copper(s):return first(s,'net')[1]
def lengths(root):
    d=collections.defaultdict(float)
    for s in kids(root,'segment'):
        a=list(map(float,first(s,'start')[1:]));b=list(map(float,first(s,'end')[1:]))
        d[copper(s)]+=math.dist(a,b)
    return {k:round(v,6) for k,v in sorted(d.items()) if '/ELEC_' in k or '/HIZ_' in k}
def verify(before,after,out):
    a=parse(Path(before).read_text());b=parse(Path(after).read_text());af,bf=footprints(a),footprints(b)
    checks={}
    def check(name,condition):
        checks[name]=bool(condition)
        assert condition,name
    check('same_footprint_census',af.keys()==bf.keys())
    check('J1_unchanged',norm(af['J1'])==norm(bf['J1']))
    check('other_components_unchanged',all(norm(af[r])==norm(bf[r]) for r in af.keys()-REFS-MOVED))
    check('all_pad_nets_unchanged',all(nets(af[r])==nets(bf[r]) for r in af))
    check('title_and_nonrelease_warning_preserved',norm(first(a,'title_block'))==norm(first(b,'title_block')) and 'NOT RELEASED' in str(first(b,'title_block')))
    check('stackup_and_setup_unchanged',norm(first(a,'setup'))==norm(first(b,'setup')))
    def edges(r):return [norm(n) for n in r if isinstance(n,list) and first(n,'layer')==['layer','Edge.Cuts']]
    check('outline_unchanged',edges(a)==edges(b))
    check('layers_unchanged',norm(first(a,'layers'))==norm(first(b,'layers')))
    check('resistor_values_and_properties_unchanged',all(norm(kids(af[r],'property'))==norm(kids(bf[r],'property')) for r in MOVED))
    check('zone_definitions_unchanged',[[norm(x) for x in z if not(isinstance(x,list) and x[0] in ('filled_polygon','fill_segments'))] for z in kids(a,'zone')]==[[norm(x) for x in z if not(isinstance(x,list) and x[0] in ('filled_polygon','fill_segments'))] for z in kids(b,'zone')])
    table=[]
    for ref in sorted(REFS):
        f=bf[ref]; props={p[1]:p[2] for p in kids(f,'property')}
        expected=[('1',f'/CH{ref[1]}/ELEC_P'),('2',f'/CH{ref[1]}/ELEC_N')] if ref!='J5001' else [('1','unconnected-(J5001-Pad1)'),('2','/Reference_VCM/RLD_SAFE')]
        check(ref+'_signal_mapping',[(p,n) for p,n in nets(f) if p in ('1','2')]==expected)
        check(ref+'_retention_isolated',all(n==f'unconnected-({ref}-PadMP)' for p,n in nets(f) if p=='MP'))
        check(ref+'_target_part','Horizontal' in f[1] and props['MPN']=='S2B-PH-SM4-TB(LF)(SN)' and props['LCSC']=='C295747')
        check(ref+'_north_entry',first(f,'at')[2:]==['5.15','180'])
        table.append({'ref':ref,'old_footprint':af[ref][1],'new_footprint':f[1],'old_at':first(af[ref],'at')[1:],'new_at':first(f,'at')[1:],'pad_nets':nets(f)})
    affected={f'/CH{ch}/{name}_{pol}' for ch in range(1,5) for name in ['ELEC','HIZ'] for pol in ['P','N']}|{'/VCM','/Reference_VCM/RLD_SAFE'}|{f'unconnected-({r}-PadMP)' for r in REFS}
    for kind in ['segment','via']:
        check('unrelated_'+kind+'s_unchanged', [norm(s) for s in kids(a,kind) if copper(s) not in affected]==[norm(s) for s in kids(b,kind) if copper(s) not in affected])
    res={'checks':checks,'connectors':table,'old_lengths_mm':lengths(a),'new_lengths_mm':lengths(b),'track_counts':[len(kids(r,'segment')) for r in [a,b]],'via_counts':[len(kids(r,'via')) for r in [a,b]],'notes':['Schematic parity and physical connectivity are checked by KiCad CLI separately.','Mechanical body/courtyard and mating corridor figures are nominal; enclosure and qualified vendor 3D models absent.']}
    Path(out).write_text(json.dumps(res,indent=2)+'\n');print(f'{len(checks)} invariants PASS')
if __name__=='__main__':verify(*sys.argv[1:])
