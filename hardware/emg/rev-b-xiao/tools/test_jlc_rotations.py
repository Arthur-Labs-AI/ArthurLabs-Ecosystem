"""Regression for the reported north-edge C295747 assembly-preview reversal."""
import csv
from pathlib import Path
import unittest
from jlc_rotations import factory_rotation, JST_PACKAGE, NORTH_JST_REFS

REV = Path(__file__).resolve().parent.parent
PACKAGE = REV / 'evidence/pre-manufacturing-audit/jlcpcb-closure/NOT_RELEASED_PENDING_FACTORY_APPROVAL'


class RotationTests(unittest.TestCase):
    def test_five_north_headers_use_180_for_preview(self):
        for ref in sorted(NORTH_JST_REFS):
            with self.subTest(reference=ref):
                self.assertEqual(factory_rotation(ref, JST_PACKAGE, 180), 180)

    def test_battery_legacy_rotation_is_preserved(self):
        self.assertEqual(factory_rotation('J1', JST_PACKAGE, 90), 270)

    def test_all_other_121_placements_unchanged(self):
        with (PACKAGE / 'placement-review.csv').open() as f:
            table = {row['reference']: row for row in csv.DictReader(f)}
        with next(PACKAGE.glob('*_BOM.csv')).open() as f:
            footprints = {ref: row['Footprint'] for row in csv.DictReader(f) for ref in row['Designator'].split(',')}
        checked = 0
        for ref, row in table.items():
            if ref in NORTH_JST_REFS:
                continue
            self.assertEqual(factory_rotation(ref, footprints[ref], float(row['source_rotation_deg'])), float(row['CPL_rotation_deg']), ref)
            checked += 1
        self.assertEqual(checked, 121)

    def test_north_exception_refuses_changed_footprint_or_pose(self):
        for package, angle in [('Wrong_Connector', 180), (JST_PACKAGE, 0), (JST_PACKAGE, 90)]:
            with self.subTest(package=package, angle=angle):
                with self.assertRaises(ValueError):
                    factory_rotation('J101', package, angle)


if __name__ == '__main__':
    unittest.main()
