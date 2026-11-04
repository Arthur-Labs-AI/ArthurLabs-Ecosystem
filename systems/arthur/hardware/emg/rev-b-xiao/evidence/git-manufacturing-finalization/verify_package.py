#!/usr/bin/env python3
"""Read-only integrity check; optional fresh rb05_package export directory argument."""
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[5]
REV = ROOT / 'hardware/emg/rev-b-xiao'
CLOSURE = REV / 'evidence/pre-manufacturing-audit/jlcpcb-closure'
PACKAGE = CLOSURE / 'NOT_RELEASED_PENDING_FACTORY_APPROVAL'
SOURCE = REV / 'kicad/ARTHUR_EMG_RevB'
PREFIX = 'ARTHUR_Neuron_RevB_HJ_JLC_RC1_NOT_RELEASED'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def rows(path):
    return list(csv.DictReader(io.StringIO(path.read_text())))


def refs(row):
    return [r.strip() for r in row['Designator'].split(',')]


def sum_entries(data):
    return [line.split(None, 1) for line in data.decode().splitlines() if line.strip()]


def normalized_plot(data):
    # Only generation timestamps/comments are nondeterministic. Keep all geometry.
    return b'\n'.join(line for line in data.splitlines() if not (
        b'TF.CreationDate,' in line or line.startswith(b'G04 Created by KiCad ')
        or line.startswith(b'; DRILL file KiCad ')))


def main():
    manifest = json.loads((CLOSURE / 'MANUFACTURING_MANIFEST.json').read_text())
    files = {SOURCE / p: h for p, h in manifest['source_files_sha256'].items()}
    for key in ('closure_documents_sha256', 'verification_files_sha256'):
        files.update({CLOSURE / p: h for p, h in manifest[key].items()})
    files.update({CLOSURE / x['path']: x['sha256'] for x in manifest['factory_review_files']})
    for path, expected in files.items():
        assert sha(path.read_bytes()) == expected, f'Manifest mismatch: {path}'
        committed = subprocess.check_output(['git', 'show', f'HEAD:{path.relative_to(ROOT)}'], cwd=ROOT)
        assert sha(committed) == expected, f'HEAD mismatch: {path}'
    for expected, name in sum_entries((CLOSURE / 'SHA256SUMS.txt').read_bytes()):
        assert sha((CLOSURE / name).read_bytes()) == expected, name
    for expected, name in sum_entries((CLOSURE / 'REVIEW_BUNDLE_SHA256.txt').read_bytes()):
        assert sha((CLOSURE / name).read_bytes()) == expected, name
        with zipfile.ZipFile(CLOSURE / name) as bundle:
            assert bundle.testzip() is None
            for inner_hash, inner_name in sum_entries(bundle.read('SHA256SUMS.txt')):
                assert sha(bundle.read(inner_name)) == inner_hash, inner_name
            for inner_name in bundle.namelist():
                if inner_name != 'SHA256SUMS.txt':
                    assert bundle.read(inner_name) == (CLOSURE / inner_name).read_bytes(), inner_name
    bom = rows(PACKAGE / f'{PREFIX}_BOM.csv')
    review = rows(PACKAGE / 'COMPONENT_REVIEW_REQUEST.csv')
    cpl = rows(PACKAGE / f'{PREFIX}_CPL.csv')
    assert len(bom) == len(review) == 28
    bom_refs = [r for row in bom for r in refs(row)]
    assert len(bom_refs) == len(set(bom_refs)) == len(cpl) == 126
    assert set(bom_refs) == {row['Designator'] for row in cpl}
    assert len({row['Designator'] for row in cpl}) == 126
    assert 'U1' not in bom_refs and not any(r.startswith('TP') for r in bom_refs)
    assert all(row['Layer'] == 'Top' for row in cpl)
    for row in cpl:
        for axis in ('Mid X', 'Mid Y'):
            assert re.fullmatch(r'-?\d+(?:\.\d+)?mm', row[axis])
        float(row['Rotation'])
    for row, quantities in zip(bom, review):
        assert all(row[key] == quantities[key] for key in row)
        assert int(quantities['qty_per_board']) == len(refs(row))
        assert int(quantities['qty_for_two_assembled']) == 2 * len(refs(row))
        assert row['LCSC Part #'] and quantities['exact_MPN'] in row['Comment']
        assert 'B2B-PH' not in str(row) and 'C160352' not in str(row)
    jst = [row for row in review if row['exact_MPN'] == 'S2B-PH-SM4-TB(LF)(SN)']
    assert len(jst) == 1 and jst[0]['LCSC Part #'] == 'C295747'
    assert set(refs(jst[0])) == {'J1', 'J101', 'J201', 'J301', 'J401', 'J5001'}
    assert manifest['production_approved'] is False and manifest['human_contact_approved'] is False
    assert manifest['externally_submitted'] is False and manifest['order_or_payment_performed'] is False
    assert 'NOT RELEASED' in manifest['status']
    gerber_path = PACKAGE / f'{PREFIX}_Gerbers.zip'
    with zipfile.ZipFile(gerber_path) as gerbers:
        assert gerbers.testzip() is None
        names = gerbers.namelist()
        assert len(names) == len(set(names)) == 11
        assert {Path(n).suffix for n in names} == {'.gbl', '.gbs', '.gbo', '.gm1', '.gtl', '.gts', '.gtp', '.gto', '.g1', '.g2', '.drl'}
        drill = gerbers.read(next(n for n in names if n.endswith('.drl'))).decode()
        assert 'T1C0.300' in drill and 'T2C1.900' in drill
        assert len(re.findall(r'^X[^\n]+', drill, re.M)) == 192
        if len(sys.argv) > 1:
            fresh = Path(sys.argv[1])
            for suffix in ('BOM.csv', 'CPL.csv', 'CPL_raw_KiCad_rotation.csv'):
                assert rows(fresh / f'ARTHUR_EMG_RevB_{suffix}') == rows(PACKAGE / f'{PREFIX}_{suffix}'), suffix
            with zipfile.ZipFile(fresh / 'ARTHUR_EMG_RevB_Gerbers.zip') as newer:
                assert set(newer.namelist()) == set(names)
                for name in names:
                    assert normalized_plot(gerbers.read(name)) == normalized_plot(newer.read(name)), name
    result = dict(
        status='PASS', checked_git_HEAD=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        manifest_bound_files_and_git_blobs=len(files), manifest_source_files=len(manifest['source_files_sha256']),
        manifest_and_bundle_checksums='PASS', bundle_members_match_disk=True,
        BOM_groups=len(bom), factory_references=len(bom_refs), horizontal_JST_references=refs(jst[0]),
        exclusions=['U1', 'TP1-TP8'], explicit_quantity_total_per_board=sum(int(x['qty_per_board']) for x in review),
        explicit_quantity_total_two_assembled=sum(int(x['qty_for_two_assembled']) for x in review),
        CPL_unique_top_placements=len(cpl), gerber_drill_members=len(names), drill_hits=192,
        fresh_export_comparison='PASS: CSV rows identical; all 11 plot/drill members identical except generation timestamps' if len(sys.argv)>1 else 'NOT RUN',
        manufacturing_package='NOT_RELEASED_PENDING_FACTORY_APPROVAL', production_approved=False, human_contact_approved=False,
        authority='Current committed schematic/PCB plus hash-bound package; historical manifest git_HEAD records pre-commit provenance',
    )
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
