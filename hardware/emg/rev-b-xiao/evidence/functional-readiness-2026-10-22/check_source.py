#!/usr/bin/env python3
"""Check current PCB pad nets/BOM vs fresh KiCad XML; print JSON, modify nothing."""
import csv
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

REV=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REV/'tools'))
from rb02_sexpr import parse,kids,first


def main():
    xml=ET.parse(sys.argv[1]).getroot()
    nets={(p.get('ref'),p.get('pin')):n.get('name') for n in xml.findall('./nets/net') for p in n}
    comps={c.get('ref'):c for c in xml.findall('./components/comp')}
    K=REV/'kicad/ARTHUR_EMG_RevB'
    footprints={next(p[2] for p in kids(f,'property') if p[1]=='Reference'):f for f in kids(parse((K/'ARTHUR_EMG_RevB.kicad_pcb').read_text()),'footprint')}
    bad=[];compared=0;escaped_names=[]
    for ref,f in footprints.items():
        for pad in kids(f,'pad'):
            key=(ref,str(pad[1]));net=first(pad,'net');name=str(net[-1]) if net else ''
            if key in nets:
                compared+=1
                # KiCad PCB serializes slash in generated unconnected pin names.
                normalized=name.replace('{slash}','/')
                if name!=normalized:escaped_names.append([*key,name,normalized])
                if normalized!=nets[key]:bad.append([*key,name,nets[key]])
    assert not bad,bad
    P=REV/'evidence/placement-orientation-2026-10-20/NOT_RELEASED_PENDING_PREVIEW_VERIFICATION'
    bom=list(csv.DictReader(next(P.glob('*_BOM.csv')).open()));refs=[]
    for row in bom:
        for ref in row['Designator'].split(','):
            c=comps[ref];fields={f.get('name'):f.text for f in c.findall('./fields/field')}
            assert row['Comment']==c.findtext('value')+' '+fields['MPN'],ref
            assert row['LCSC Part #']==fields['LCSC'] and row['Footprint']==c.findtext('footprint').split(':')[-1],ref
            refs.append(ref)
    assert len(bom)==28 and len(refs)==len(set(refs))==126
    assert set(footprints)-set(refs)=={'U1',*[f'TP{i}' for i in range(1,9)]}
    manifest=json.loads((REV/'evidence/placement-orientation-2026-10-20/MANUFACTURING_MANIFEST.json').read_text())
    assert all(hashlib.sha256((K/p).read_bytes()).hexdigest()==d for p,d in manifest['source_files_sha256'].items())
    dnp='dnp' in first(footprints['U1'],'attr')[1:];assert dnp
    print(json.dumps(dict(status='PASS',design_hashes_unchanged=27,PCB_footprints=len(footprints),schematic_net_nodes_compared_to_PCB_pads=compared,pad_net_mismatches=bad,KiCad_escaped_unconnected_name_equivalences=escaped_names,BOM_groups=28,factory_refs=126,factory_U1_DNP=dnp,factory_exclusions=['U1 manual module; TP1-TP8 copper features'],physical_functional_test='UNVERIFIED',firmware_on_target_hardware='UNVERIFIED'),indent=2))


if __name__=='__main__':main()
