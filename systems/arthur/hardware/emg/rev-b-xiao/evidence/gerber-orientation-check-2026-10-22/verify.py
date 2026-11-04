#!/usr/bin/env python3
"""Read-only verification of Gerbers for a CPL-only connector rotation correction.
Usage: python3 verify.py <fresh rb05_package export directory>
Prints JSON; writes no candidate, PCB or schematic files.
"""
import csv
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import zipfile

OUT = Path(__file__).resolve().parent
REV = OUT.parents[1]
OLD = REV/'evidence/pre-manufacturing-audit/jlcpcb-closure'
ECO = REV/'evidence/placement-orientation-2026-10-20'
PACKAGE = ECO/'NOT_RELEASED_PENDING_PREVIEW_VERIFICATION'
K = REV/'kicad/ARTHUR_EMG_RevB'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def normalize(data):
    return b'\n'.join(line for line in data.splitlines() if not (
        b'TF.CreationDate,' in line or line.startswith((b'G04 Created by KiCad ', b'; DRILL file KiCad '))))


def flashes(text):
    component = pin = net = None
    result = []
    for line in text.splitlines():
        if line.startswith('%TO.P,'):
            fields = line[6:-2].split(','); component, pin = fields[:2]
        elif line.startswith('%TO.C,'):
            component = line[6:-2]
        elif line.startswith('%TO.N,'):
            net = line[6:-2]
        elif line == '%TD*%':
            component = pin = net = None
        elif (m := re.fullmatch(r'X(-?\d+)Y(-?\d+)D03\*', line)):
            result.append(dict(component=component, pin=pin, net=net,
                               board_xy_mm=[round(int(m[1])/1e6,6),round(-int(m[2])/1e6,6)]))
    return result


def main():
    manifest = json.loads((ECO/'MANUFACTURING_MANIFEST.json').read_text())
    for name,digest in manifest['source_files_sha256'].items():
        assert sha((K/name).read_bytes()) == digest, name
    for item in manifest['factory_review_files']+manifest['alternate_preview_files']:
        assert sha((ECO/item['path']).read_bytes()) == item['sha256'], item['path']
    archive = next(PACKAGE.glob('*_Gerbers.zip'))
    oldarchive = next((OLD/'NOT_RELEASED_PENDING_FACTORY_APPROVAL').glob('*_Gerbers.zip'))
    assert archive.read_bytes() == oldarchive.read_bytes()
    proof = json.loads((ECO/'mechanical-proofs.json').read_text())['records']
    with zipfile.ZipFile(archive) as current, zipfile.ZipFile(Path(sys.argv[1])/'ARTHUR_EMG_RevB_Gerbers.zip') as fresh:
        assert current.testzip() is None and fresh.testzip() is None
        assert set(current.namelist()) == set(fresh.namelist()) and len(current.namelist()) == 11
        comparison = {name:normalize(current.read(name)) == normalize(fresh.read(name)) for name in current.namelist()}
        assert all(comparison.values())
        layers = {label:flashes(current.read('ARTHUR_EMG_RevB-'+name).decode()) for label,name in [('copper','F_Cu.gtl'),('mask','F_Mask.gts'),('paste','F_Paste.gtp')]}
        connector_checks = []
        for rec in proof:
            ref = rec['reference']
            expected = sorted(tuple(p['board_xy']) for p in rec['pads'])
            for label,items in layers.items():
                installed = [p for p in items if p['component'] == ref]
                assert sorted(tuple(p['board_xy_mm']) for p in installed) == expected, (ref,label,installed)
                if label == 'copper':
                    assert sorted((p['pin'],p['net'],tuple(p['board_xy_mm'])) for p in installed) == sorted((p['number'],p['net'],tuple(p['board_xy'])) for p in rec['pads']), ref
            connector_checks.append(dict(reference=ref,all_four_pad_centers_match_copper_mask_paste=True,copper_pin_numbers_and_nets_match=True,pads=rec['pads']))
        drill = current.read('ARTHUR_EMG_RevB.drl').decode()
        assert 'T1C0.300' in drill and 'T2C1.900' in drill
        assert len(re.findall(r'^X',drill,re.M)) == 192
    with next((ECO/'ALTERNATE_J1_TEST_ONLY').glob('*_CPL.csv')).open() as f:
        selected={r['Designator']:r for r in csv.DictReader(f)}
    with next((OLD/'NOT_RELEASED_PENDING_FACTORY_APPROVAL').glob('*_CPL.csv')).open() as f:
        before={r['Designator']:r for r in csv.DictReader(f)}
    assert set(selected)==set(before) and len(selected)==126
    expected_rotations={'J101':'180','J201':'180','J301':'180','J401':'180','J5001':'180','J1':'90'}
    changed=[]
    for ref,row in before.items():
        assert all(row[key]==selected[ref][key] for key in row if key!='Rotation'), ref
        if row['Rotation']!=selected[ref]['Rotation']:changed.append(ref)
    assert set(changed)==set(expected_rotations)
    assert all(selected[r]['Rotation']==v for r,v in expected_rotations.items())
    print(json.dumps(dict(local_date='2026-10-22 Europe/Sofia',git_HEAD=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),status='PASS: no Gerber change needed for CPL-only rotation correction',source_hashes_unchanged=27,Gerber_zip=str(archive.relative_to(REV)),Gerber_zip_SHA256=sha(archive.read_bytes()),RC1_RC2_Gerber_ZIP_byte_identical=True,fresh_Gerber_members_geometry_identical=comparison,connector_checks=connector_checks,drill_hits=192,PCB_outline_mm=[51.30,64.95],outline_evidence='Fresh outline member identical to hash-bound RC1/RC2; prior measured outline retained',selected_CPL=str(next((ECO/'ALTERNATE_J1_TEST_ONLY').glob('*_CPL.csv')).relative_to(REV)),CPL_rotations_deg=expected_rotations,CPL_coordinates_sides_and_other_120_rotations_unchanged=True,private_preview_file_identification='User confirms provided file; interpreted as last linked J1_90 test alternative',rendered_mouth_direction='New user screenshot corroborates outward north-row and outward J1 openings; user confirms correct direction',final_2D_pin_net_overlay_and_factory_CAM='UNVERIFIED',production_approved=False,human_contact_approved=False),indent=2))


if __name__=='__main__':main()
