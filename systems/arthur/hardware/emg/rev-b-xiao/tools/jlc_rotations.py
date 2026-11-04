"""Factory rotation policy; numerical agreement does not qualify factory preview."""
import re

# Retained historical rules. Part-specific preview is still required.
CORRECTIONS = [(r'^SOT-23', 180), (r'^TSSOP-', 270), (r'^SOIC-', 270), (r'^JST_PH_S', 180)]
NORTH_JST_REFS = frozenset({'J101', 'J201', 'J301', 'J401', 'J5001'})
JST_PACKAGE = 'JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal'


def factory_rotation(reference, package, raw_rotation):
    # User reports inward C295747 mouths at legacy CPL 0 degrees. JLC's public
    # C295747 land pattern has the same pad ordering as KiCad at zero degrees.
    # Use raw 180 for these five only. Assembly-session verification is pending.
    if reference in NORTH_JST_REFS:
        if package != JST_PACKAGE or float(raw_rotation) % 360 != 180:
            raise ValueError(f'{reference}: north-header override needs requalification')
        return 180.0
    # J1 deliberately stays on its legacy rule until independently qualified.
    offset = next((angle for pattern, angle in CORRECTIONS if re.match(pattern, package)), 0)
    return (float(raw_rotation) + offset) % 360
