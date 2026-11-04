#!/usr/bin/env python3
"""RB-02: write the Rev B netclasses, netclass patterns, board design settings and custom DRC rules
(REVB_MANUFACTURING_CONSTRAINTS.md §3, §3.1) into ARTHUR_EMG_RevB.kicad_pro / .kicad_dru.

    python3 rb02_write_project.py [--project-dir <ARTHUR_EMG_RevB dir>]

Idempotent: it only touches net_settings and board.design_settings.  Net-to-class patterns match the hierarchical net
names that KiCad produces for the frozen schematic; `rb02_check_netclasses.py` proves that no net falls back to Default.
"""
import argparse
import json
from pathlib import Path

CLASSES = {
    # name: (track, clearance, via_dia, via_drill)
    "EMG_ELECTRODE": (0.25, 0.30, 0.6, 0.3), "EMG_HIZ": (0.20, 0.20, 0.6, 0.3), "EMG_BUF": (0.20, 0.20, 0.6, 0.3),
    "ANALOG_REF": (0.20, 0.25, 0.6, 0.3), "ADC_CAP": (0.25, 0.20, 0.6, 0.3), "PWR_AFE": (0.30, 0.20, 0.6, 0.3),
    "PWR_VBAT": (0.50, 0.20, 0.8, 0.4), "PWR_DVDD": (0.30, 0.20, 0.6, 0.3), "SPI_FAST": (0.20, 0.20, 0.6, 0.3),
    "CTRL_SLOW": (0.20, 0.20, 0.6, 0.3), "VBUS_SENSE": (0.25, 0.30, 0.6, 0.3), "GND": (0.30, 0.20, 0.6, 0.3),
    "NC": (0.20, 0.20, 0.6, 0.3),
}
PATTERNS = [
    ("EMG_ELECTRODE", "/CH?/ELEC_*"),
    ("EMG_HIZ", "/CH?/HIZ_*"),
    ("EMG_BUF", "/CH?/BUF_*"), ("EMG_BUF", "/CH?/ACN_*"), ("EMG_BUF", "/CH?_P"), ("EMG_BUF", "/CH?_N"),
    ("ANALOG_REF", "/VCM"), ("ANALOG_REF", "/Reference_VCM/*"),
    ("ADC_CAP", "/ADC/AFE_CAP"),
    ("PWR_AFE", "AFE_3V0"),
    ("PWR_VBAT", "VBAT"), ("PWR_VBAT", "/Analog_Power_Interlock/VBAT_AFE"),
    ("PWR_DVDD", "DVDD_F"), ("PWR_DVDD", "/XIAO_Brain_Interface/XIAO_3V3"),
    ("SPI_FAST", "/SCLK"), ("SPI_FAST", "/MOSI"), ("SPI_FAST", "/MISO"), ("SPI_FAST", "/ADC/ADC_CLKIN"), ("SPI_FAST", "/ADC/ADC_DOUT"),
    ("SPI_FAST", "/ADC/X1_OUT"), ("SPI_FAST", "/XIAO_Brain_Interface/SCLK_MCU"), ("SPI_FAST", "/XIAO_Brain_Interface/MOSI_MCU"),
    ("CTRL_SLOW", "/CS_N"), ("CTRL_SLOW", "/DRDY_N"), ("CTRL_SLOW", "/SYNC_RESET_N"), ("CTRL_SLOW", "/AFE_EN_REQ"),
    ("CTRL_SLOW", "/Analog_Power_Interlock/AFE_EN"), ("CTRL_SLOW", "/Analog_Power_Interlock/VBUS_GATE"),
    ("CTRL_SLOW", "/XIAO_Brain_Interface/USB_PRESENT"), ("CTRL_SLOW", "/XIAO_Brain_Interface/VBAT_SENSE"), ("CTRL_SLOW", "/ADC/ADC_DRDY_N"),
    ("VBUS_SENSE", "/XIAO_5V"),
    ("GND", "GND"),
    ("NC", "unconnected-*"),
]

DRU = '''(version 1)
# ARTHUR EMG Rev B custom rules (REVB_MANUFACTURING_CONSTRAINTS.md section 3.1), RB-02.
(rule "hiz_outer_only_in2"
	(layer "In2.Cu")
	(condition "A.NetClass == 'EMG_HIZ' || A.NetClass == 'EMG_ELECTRODE'")
	(constraint disallow track)
	(severity error))
(rule "hiz_outer_only_in1"
	(layer "In1.Cu")
	(condition "A.NetClass == 'EMG_HIZ' || A.NetClass == 'EMG_ELECTRODE'")
	(constraint disallow track)
	(severity error))
(rule "hiz_no_vias"
	(constraint disallow via)
	(condition "A.NetClass == 'EMG_HIZ' || A.NetClass == 'EMG_ELECTRODE' || A.NetClass == 'ADC_CAP'")
	(severity error))
# order matters in KiCad custom rules (the LAST matching rule wins): the generic 0.4 mm leakage rule comes first,
# the stricter SPI separations after it.
# RB-03R: hi-Z leakage rules.  The 0.4 mm separation between the hi-Z node and foreign copper is enforced EVERYWHERE except in the
# physically unavoidable corner of the TLV9064 TSSOP-14 pin columns (0.65 mm pitch, 0.25 mm pad gap).  Exemptions are limited to
#  (E1) track vs track, both tracks fully enclosed by the SAME pin-column area HIZ_ESC_<IC>_<L|R> (rb03r_escape_areas.py),
#  (E2) a hi-Z track/via vs a pad of U501/U502/U503 (the neighbouring pins of the same package),
#  (E3) a hi-Z pad of U501/U502/U503 vs a foreign track fully enclosed by that IC's pin-column area.
# A hi-Z track vs a foreign pad of any other component, or any foreign item outside the pin-column areas, is NOT exempt.
(rule "hiz_leakage"
	(constraint clearance (min 0.4mm))
	(condition "A.NetClass == 'EMG_HIZ' && B.NetClass != 'GND' && B.NetClass != 'EMG_HIZ' && A.Type != 'Pad' && B.Type != 'Pad' && (A.Type == 'Track' || B.Type == 'Track' || A.Type == 'Via' || B.Type == 'Via' || A.Type == 'Zone' || B.Type == 'Zone') && !(A.Type == 'Track' && B.Type == 'Track' && ((A.enclosedByArea('HIZ_ESC_U501_L') && B.enclosedByArea('HIZ_ESC_U501_L')) || (A.enclosedByArea('HIZ_ESC_U501_R') && B.enclosedByArea('HIZ_ESC_U501_R')) || (A.enclosedByArea('HIZ_ESC_U502_L') && B.enclosedByArea('HIZ_ESC_U502_L')) || (A.enclosedByArea('HIZ_ESC_U502_R') && B.enclosedByArea('HIZ_ESC_U502_R')) || (A.enclosedByArea('HIZ_ESC_U503_L') && B.enclosedByArea('HIZ_ESC_U503_L')) || (A.enclosedByArea('HIZ_ESC_U503_R') && B.enclosedByArea('HIZ_ESC_U503_R'))))"))
(rule "hiz_track_to_foreign_pad"
	(constraint clearance (min 0.4mm))
	(condition "A.NetClass == 'EMG_HIZ' && (A.Type == 'Track' || A.Type == 'Via') && B.Type == 'Pad' && B.NetClass != 'GND' && B.NetClass != 'EMG_HIZ' && !(B.memberOfFootprint('U501') || B.memberOfFootprint('U502') || B.memberOfFootprint('U503'))"))
(rule "hiz_pad_to_foreign_track"
	(constraint clearance (min 0.4mm))
	(condition "A.NetClass == 'EMG_HIZ' && A.Type == 'Pad' && (B.Type == 'Track' || B.Type == 'Via') && B.NetClass != 'GND' && B.NetClass != 'EMG_HIZ' && !((A.memberOfFootprint('U501') && B.Type == 'Track' && B.enclosedByArea('HIZ_ESC_U501_L')) || (A.memberOfFootprint('U501') && B.Type == 'Track' && B.enclosedByArea('HIZ_ESC_U501_R')) || (A.memberOfFootprint('U502') && B.Type == 'Track' && B.enclosedByArea('HIZ_ESC_U502_L')) || (A.memberOfFootprint('U502') && B.Type == 'Track' && B.enclosedByArea('HIZ_ESC_U502_R')) || (A.memberOfFootprint('U503') && B.Type == 'Track' && B.enclosedByArea('HIZ_ESC_U503_L')) || (A.memberOfFootprint('U503') && B.Type == 'Track' && B.enclosedByArea('HIZ_ESC_U503_R')))"))
(rule "spi_to_hiz"
	(constraint clearance (min 2.0mm))
	(condition "A.NetClass == 'SPI_FAST' && B.NetClass == 'EMG_HIZ'"))
(rule "spi_to_buf"
	(constraint clearance (min 1.0mm))
	(condition "A.NetClass == 'SPI_FAST' && B.NetClass == 'EMG_BUF'"))
(rule "zone_a_no_digital"
	(constraint disallow track via)
	(condition "(A.NetClass == 'SPI_FAST' || A.NetClass == 'CTRL_SLOW') && A.insideArea('ZONE_A')")
	(severity error))
# RB-03R: the RB-02 version used hole_clearance, which KiCad skips for items of the SAME net, so it never caught a via inside its own
# pad.  physical_hole_clearance is evaluated regardless of net: via hole edge >= 0.10 mm from any SMD pad copper (centre >= 0.25 mm);
# a via centred in a pad measures 0.00 mm.
(rule "no_via_in_smd_pad"
	(constraint physical_hole_clearance (min 0.10mm))
	(condition "A.Type == 'Via' && B.Type == 'Pad' && B.Pad_Type == 'SMD'")
	(severity error))
'''


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project-dir", type=Path, default=Path(__file__).resolve().parents[1] / "kicad/ARTHUR_EMG_RevB")
    a = ap.parse_args(argv)
    pro = a.project_dir / "ARTHUR_EMG_RevB.kicad_pro"
    j = json.loads(pro.read_text())
    classes = [{"bus_width": 12, "clearance": 0.2, "diff_pair_gap": 0.25, "diff_pair_via_gap": 0.25, "diff_pair_width": 0.2,
                "line_style": 0, "microvia_diameter": 0.3, "microvia_drill": 0.1, "name": "Default",
                "pcb_color": "rgba(0, 0, 0, 0.000)", "priority": 2147483647, "schematic_color": "rgba(0, 0, 0, 0.000)",
                "track_width": 0.2, "via_diameter": 0.6, "via_drill": 0.3, "wire_width": 6}]
    for i, (n, (tw, cl, vd, vdr)) in enumerate(CLASSES.items()):
        classes.append({"bus_width": 12, "clearance": cl, "diff_pair_gap": 0.25, "diff_pair_via_gap": 0.25, "diff_pair_width": 0.2,
                        "line_style": 0, "microvia_diameter": 0.3, "microvia_drill": 0.1, "name": n,
                        "pcb_color": "rgba(0, 0, 0, 0.000)", "priority": i, "schematic_color": "rgba(0, 0, 0, 0.000)",
                        "track_width": tw, "via_diameter": vd, "via_drill": vdr, "wire_width": 6})
    j["net_settings"] = {"classes": classes, "meta": {"version": 4}, "net_colors": None, "netclass_assignments": None,
                         "netclass_patterns": [{"netclass": c, "pattern": p} for c, p in PATTERNS]}
    ds = j["board"]["design_settings"]
    ds["defaults"] = {"board_outline_line_width": 0.1, "copper_line_width": 0.2, "copper_text_size_h": 1.5, "copper_text_size_v": 1.5,
                      "copper_text_thickness": 0.3, "silk_line_width": 0.12, "silk_text_size_h": 0.8, "silk_text_size_v": 0.8, "silk_text_thickness": 0.15}
    ds["rules"] = {"min_clearance": 0.15, "min_connection": 0.15, "min_copper_edge_clearance": 0.5, "min_hole_clearance": 0.25,
                   "min_hole_to_hole": 0.5, "min_microvia_diameter": 0.2, "min_microvia_drill": 0.1, "min_resolved_spokes": 2,
                   "min_silk_clearance": 0.0, "min_text_height": 0.8, "min_text_thickness": 0.08, "min_through_hole_diameter": 0.3,
                   "min_track_width": 0.15, "min_via_annular_width": 0.15, "min_via_diameter": 0.5, "solder_mask_to_copper_clearance": 0.0,
                   "use_height_for_length_calcs": True}
    ds["track_widths"] = [0.0, 0.15, 0.2, 0.25, 0.3, 0.5]
    ds["via_dimensions"] = [{"diameter": 0.0, "drill": 0.0}, {"diameter": 0.6, "drill": 0.3}, {"diameter": 0.8, "drill": 0.4}]
    pro.write_text(json.dumps(j, indent=2) + "\n")
    (a.project_dir / "ARTHUR_EMG_RevB.kicad_dru").write_text(DRU)
    print("wrote", pro, "and .kicad_dru:", len(classes), "netclasses,", len(PATTERNS), "patterns")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
