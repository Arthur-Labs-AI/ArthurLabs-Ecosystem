"""RB-02G variant definitions (board frame, mm).  See rb02g_layouts.py for the block model.

Common single-part adjustments (placement only):
  R7105/R7106 moved north in their column so that R7106 keeps >= 2.5 mm body distance from the south edge.
  R7107/R7108/C7103 (battery sense divider) moved 0.85 mm west of J1 in V1 so that they keep >= 2.5 mm from the east edge.
"""
_R7 = {"R7105": (0.0, -1.8), "R7106": (0.0, -1.75), "R3009": (0.0, -0.06)}

VARIANTS = {
    # V1: portrait 50.6 x 62.5 -- Zone A turned 180 deg (all five electrode connectors on the north edge) above the
    # unchanged Zone B/C/D block with the battery connector and power strip left in their RB-02 place above the module
    "V1": {"W": 51.3, "H": 62.45,
           "blocks": [("ALLA", 180, 2.15, 0.0), ("CORE_NOBATT", 0, 3.27, 31.95), ("J1", 270, 39.3, 31.2)],
           "single": _R7, "abs": {"R7107": (36.6, 37.0, 90), "R7108": (34.8, 38.8, 90), "C7103": (36.6, 33.7, 90)},
           "zone_a": [(0, 0, 51.3, 31.0)], "zone_d_cut": (25.5, 31.0)},
    # V2: square 60 x 58.9 -- same Zone A row, battery connector and power strip moved into a right-hand column beside it
    "V2": {"W": 60.4, "H": 58.9,
           "blocks": [("ALLA", 180, 2.15, 0.0), ("BATT", 0, 49.25, 1.8), ("PWR", 90, 50.0, 15.6), ("CORE", 0, 12.37, 30.9)],
           "single": _R7, "abs": {"R7107": (51.8, 13.7, 90), "R7108": (54.0, 13.7, 90), "C7103": (56.2, 13.7, 90)},
           "zone_a": [(0, 0, 49.2, 31.0)], "zone_d_cut": (38.6, 37.0)},
    # V1R: V1 with the edge margin of the Economic FAQ (0.3 mm) instead of the T&C 2.5 mm body rule: width 48.6.
    # Only valid if JLCPCB confirms that 2.5 mm does not apply (RB-02F OPEN); NOT recommended before that answer.
    "V1R": {"W": 48.6, "H": 62.45,
            "blocks": [("ALLA", 180, 0.8, 0.0), ("CORE_NOBATT", 0, 0.57, 31.95), ("J1", 270, 36.6, 31.2)],
            "single": _R7, "abs": {"R7107": (33.9, 37.0, 90), "R7108": (32.1, 38.8, 90), "C7103": (33.9, 33.7, 90)},
            "zone_a": [(0, 0, 48.6, 31.0)], "zone_d_cut": (22.8, 31.0)},
    # --- infeasibility probes: the V1 block stack squeezed into the requested envelopes (portrait equivalents of
    #     60 x 50, 60 x 45, 55 x 45).  They are expected to FAIL (courtyard overlaps / parts outside the outline).
    "P50x60": {"W": 50.0, "H": 60.0, "blocks": [("ALLA", 180, 1.5, 0.0), ("CORE_PWR", 0, 1.5, 28.1)], "single": _R7,
               "zone_a": [(0, 0, 50.0, 29.0)], "zone_d_cut": (24.0, 29.0)},
    "P45x60": {"W": 45.0, "H": 60.0, "blocks": [("ALLA", 180, 0.0, 0.0), ("CORE_PWR", 0, 0.0, 28.1)], "single": _R7,
               "zone_a": [(0, 0, 45.0, 29.0)], "zone_d_cut": (20.0, 29.0)},
    "P45x55": {"W": 45.0, "H": 55.0, "blocks": [("ALLA", 180, 0.0, 0.0), ("CORE_PWR", 0, 0.0, 23.1)], "single": _R7,
               "zone_a": [(0, 0, 45.0, 24.0)], "zone_d_cut": (20.0, 24.0)},
    # V1B (RB-03R): V1 with the Zone B/C/D block, battery connector and its resistors 2.5 mm further south: opens a fan-out
    # channel below the band row of the channel cells (board 51.3 x 64.95)
    "V1B": {"W": 51.3, "H": 64.95,
            "blocks": [("ALLA", 180, 2.15, 0.0), ("CORE_NOBATT", 0, 3.27, 34.45), ("J1", 270, 39.3, 33.7)],
            "single": _R7, "abs": {"R7107": (36.6, 39.5, 90), "R7108": (34.8, 41.3, 90), "C7103": (36.6, 36.2, 90)},
            "zone_a": [(0, 0, 51.3, 31.0)], "zone_d_cut": (25.5, 33.5)},
    # V1C (RB-03R): V1B plus the eight 100 kohm DC-return resistors R(b+3)/R(b+4) of the band row moved 3.0 mm south to open the row
    "V1C": {"W": 51.3, "H": 64.95,
            "blocks": [("ALLA", 180, 2.15, 0.0), ("CORE_NOBATT", 0, 3.27, 34.45), ("J1", 270, 39.3, 33.7)],
            "single": {**_R7, **{f"R{c}0{k}": (0.0, 3.0) for c in (1, 2, 3, 4) for k in (3, 4)}},
            "abs": {"R7107": (36.6, 39.5, 90), "R7108": (34.8, 41.3, 90), "C7103": (36.6, 36.2, 90)},
            "zone_a": [(0, 0, 51.3, 31.0)], "zone_d_cut": (25.5, 33.5)},
}
