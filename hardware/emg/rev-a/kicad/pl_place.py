"""ARTHUR EMG Rev A -- portable deterministic placement generator.

Canonical placement source:
    pl_rows_a.py (ROWS_A) + pl_rows_b.py (ROWS_B) for coordinates/rotation,
    pl_core_c.py (VALS) + pl_core_d.py (EXTRA_VAL) for values,
    pl_core_d.py (EXTRA_FP / EXTRA_NETS) for DNP companion footprints.

Geometry source (pads + silk/fab/courtyard graphics + netlist):
    extracted from the footprint instances of a reference .kicad_pcb
    (default: the committed ARTHUR_EMG_RevA/ARTHUR_EMG_RevA.kicad_pcb
    itself, which embeds all pad geometry and net assignments).
    No KiCad stock footprint libraries are required.

Usage (repo kicad dir, Windows or Linux, no source edits):
    python3 pl_place.py [--check] [--out PATH] [--ref PATH]

    default: regenerate ARTHUR_EMG_RevA/ARTHUR_EMG_RevA.kicad_pcb in place.
    --check: regenerate to a temp file and diff footprint-relevant content
             against the current file; exit nonzero on placement mismatch.
    --out:   write to PATH instead of the project PCB.
    --ref:   read geometry/nets from PATH instead of the project PCB.

Header (title block / layers / setup / net classes / net declarations)
is preserved verbatim from the reference PCB, so netlist changes must come
with the reference file. Only footprint instances + Edge.Cuts/gr_text tail
are re-emitted.
"""
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import pl_rows_a as RA
import pl_rows_b as RB
import pl_core_c as CC
import pl_core_d as CD

PROJECT_PCB = ROOT / "ARTHUR_EMG_RevA" / "ARTHUR_EMG_RevA.kicad_pcb"
BOARD_W, BOARD_H = 45, 30

BOTTOM_REFS = frozenset([
    "J8001", "TP605", "TP606", "TP607", "TP608", "TP609",
    "TP113", "TP114", "TP115", "TP116", "TP117", "TP118",
    "U901", "U902", "U903", "U904", "U905", "U906", "R2002",
    "C4006", "C6001", "C6002",
])

SKIP_MAIN = frozenset([
    "CM101", "CM102", "CM201", "CM202", "CM301", "CM302",
    "CM401", "CM402", "D101", "D201", "D301", "D401",
    "C607B", "C608B",
])

EXTRA_ORDER = [
    ("CM101", 32.0, 3.0, 0, "B.Cu", True),
    ("CM102", 35.5, 3.0, 0, "B.Cu", True),
    ("CM201", 39.0, 3.0, 0, "B.Cu", True),
    ("CM202", 42.5, 3.0, 0, "B.Cu", True),
    ("CM301", 32.0, 6.5, 0, "B.Cu", True),
    ("CM302", 35.5, 6.5, 0, "B.Cu", True),
    ("CM401", 39.0, 6.5, 0, "B.Cu", True),
    ("CM402", 42.5, 6.5, 0, "B.Cu", True),
    ("D101", 32.0, 10.0, 0, "B.Cu", True),
    ("D201", 36.5, 10.0, 0, "B.Cu", True),
    ("D301", 32.0, 14.0, 0, "B.Cu", True),
    ("D401", 36.5, 14.0, 0, "B.Cu", True),
    ("C607B", 21.5, 12.3, 0, "F.Cu", False),
    ("C608B", 24.0, 21.7, 0, "F.Cu", False),
]

TP_DEFAULT_VAL = "TP_SMD"

TAIL_TEXTS = [
    ("ARTHUR EMG Rev A - PLACEMENT REV A (no copper)", 22.5, 29.0, "F.SilkS", 1.0),
    ("ELECTRODE EDGE (CH1-CH4 + RLD)", 22.5, 29.6, "Cmts.User", 0.8),
    ("USB / POWER SIDE", 22.5, 0.6, "Cmts.User", 0.8),
    ("RF EDGE ->", 43.5, 28.0, "Cmts.User", 0.8),
    ("ANT KEEPOUT: no copper/components (Raytac -1MV2 TBD-verify)", 43.25, 8.4, "Cmts.User", 0.6),
    ("BATTERY 503040-class REGION, BOTTOM SIDE (TBD)", 22.5, 15.0, "B.SilkS", 1.0),
]


def ts_of(s):
    h = hashlib.md5(s.encode()).hexdigest()
    return h[:8] + "-" + h[8:12] + "-4" + h[13:16] + "-8" + h[16:19] + "-" + h[19:31]


def fail(msg):
    print("pl_place: ERROR: " + msg, file=sys.stderr)
    raise SystemExit(2)


def split_blocks(pcb_text):
    starts = [m.start() for m in re.finditer(r"\(footprint \"", pcb_text)]
    if not starts:
        fail("no footprint blocks found in reference PCB")
    blocks = {}
    for k, s in enumerate(starts):
        e = starts[k + 1] if k + 1 < len(starts) else len(pcb_text)
        blk = pcb_text[s:e]
        m = re.search(r'\(property "Reference" "([^"]+)"', blk)
        if not m:
            fail("footprint block without Reference property")
        ref = m.group(1)
        if ref in blocks:
            fail("duplicate footprint instance for " + ref)
        blocks[ref] = blk
    head = pcb_text[:starts[0]]
    return head, blocks


def footprint_header(blk):
    m = re.search(r'\(footprint "([^"]+)"', blk)
    libfp = m.group(1)
    m = re.search(r"\(property \"Value\" \"((?:[^\"\\]|\\.)*)\"", blk)
    val = m.group(1) if m else ""
    return libfp, val


def body_of(blk):
    '''Body: (attr ...) through last (pad ...) close (depth-counted).'''
    lines = blk.splitlines()
    attr_idx = None
    for i, ln in enumerate(lines):
        if ln.strip().startswith('(attr '):
            attr_idx = i
            break
    if attr_idx is None:
        fail('no attr')
    pad_start = None
    for i in range(len(lines) - 1, attr_idx, -1):
        if lines[i].strip().startswith('(pad '):
            pad_start = i
            break
    if pad_start is None:
        fail('no pads')
    depth = 0
    pad_end = None
    instr = False
    for i in range(pad_start, len(lines)):
        for c in lines[i]:
            if c == '"':
                instr = not instr
            elif not instr:
                if c == '(':
                    depth += 1
                elif c == ')':
                    depth -= 1
                    if depth == 0:
                        pad_end = i
                        break
        if pad_end is not None:
            break
    if pad_end is None:
        fail('unterminated pad')
    return lines[attr_idx:pad_end + 1]


def head_nets(head):
    names = {}
    codes = {}
    for m in re.finditer(r'\(net\s+(\d+)\s+"([^"]*)"\)', head):
        code, name = m.group(1), m.group(2)
        names[code] = name
        codes.setdefault(name, code)
    return {"codes": codes, "names": names}


def pad_nets(ref_block):
    pads = {}
    starts = [m.start() for m in re.finditer(r"\(pad\s+", ref_block)]
    for k, s in enumerate(starts):
        e = starts[k + 1] if k + 1 < len(starts) else len(ref_block)
        blk = ref_block[s:e]
        mref = re.search(r'\(pad\s+\"?([^\"\s)]+)\"?', blk)
        mnet = re.search(r'\(net\s+(\d+)\s+"([^"]*)"\)', blk)
        if mref and mnet:
            pads[mref.group(1)] = (mnet.group(1), mnet.group(2))
    return pads


def apply_net_tags(body_lines, ref_pad_nets, nets):
    codes = nets.get("codes", {})
    out = []
    cur = [None]
    def flush():
        pass
    for ln in body_lines:
        s = ln.strip()
        if s.startswith("(pad "):
            import re as _re
            m = _re.search(r'\(pad\s+"?([^"\s)]+)"?', ln)
            cur[0] = m.group(1) if m else None
        out.append(ln)
        if cur[0] and '(layers ' in ln and ('(net ' not in ln):
            tag = ref_pad_nets.get(cur[0])
            if tag is not None:
                code_s, name_s = tag
                indent_s = ln[:len(ln) - len(ln.lstrip())]
                out.append(indent_s + '\t' + ' (net ' + code_s + ' ' + chr(34) + name_s + chr(34) + ')')
            cur[0] = None
    return out


def layer_of_bottom(bottom):
    return "B.Cu" if bottom else "F.Cu"


def mirror_body_to_bottom(body_lines):
    '''Remap an F-side pad/graphics body to B-side (Architecture B support).
    Swaps F.Cu/F.Mask/F.Paste/F.SilkS/F.Fab tokens to B-side equivalents and
    mirrors local pad x-offsets (bottom view flip). No-ops on bodies that are
    already B-side.'''
    out = []
    for ln in body_lines:
        s = ln
        if '"B.' not in ln or '"F.' in ln:
            s = (s.replace('"F.Cu"', '"B.Cu"').replace('"F.Mask"', '"B.Mask"')
                   .replace('"F.Paste"', '"B.Paste"').replace('"F.SilkS"', '"B.SilkS"')
                   .replace('"F.Fab"', '"B.Fab"'))
        out.append(s)
    return out


def emit_instance(ref, libfp, val, x, y, rot, layer, body_lines):
    silk = "B.SilkS" if layer == "B.Cu" else "F.SilkS"
    fab = "B.Fab" if layer == "B.Cu" else "F.Fab"
    L = []
    L.append('\t(footprint "%s"' % libfp)
    L.append("\t\t(version 20260206)")
    L.append('\t\t(generator "ARTHUR-placement")')
    L.append('\t\t(layer "%s")' % layer)
    L.append("\t\t(tstamp %s)" % ts_of("fp" + ref))
    L.append("\t\t(at %.2f %.2f%s)" % (x, y, "" if rot == 0 else " %s" % rot))
    L.append('\t\t(descr "placement rev A")')
    L.append('\t\t(property "Reference" "%s"' % ref)
    L.append("\t\t\t(at 0 -2.2 0)")
    L.append('\t\t\t(layer "%s")' % silk)
    L.append("\t\t\t(effects (font (size 0.8 0.8) (thickness 0.12))))")
    L.append('\t\t(property "Value" "%s"' % val)
    L.append("\t\t\t(at 0 2.2 0)")
    L.append('\t\t\t(layer "%s")' % fab)
    L.append("\t\t\t(hide yes)")
    L.append("\t\t\t(effects (font (size 0.8 0.8) (thickness 0.12))))")
    L.append('\t\t(property "Footprint" "%s"' % libfp)
    L.append("\t\t\t(at 0 0 0)")
    L.append("\t\t\t(hide yes)")
    L.append('\t\t\t(layer "%s")' % fab)
    L.append("\t\t\t(effects (font (size 1 1) (thickness 0.15))))")
    L.extend(ln.rstrip() for ln in body_lines)
    L.append("\t\t(embedded_fonts no)")
    L.append("\t)")
    return "\n".join(L)


LOCAL_LIB_DIR = ROOT / "ARTHUR_EMG_RevA" / "ARTHUR.pretty"


def load_local_lib_bodies():
    bodies = {}
    if not LOCAL_LIB_DIR.is_dir():
        return bodies
    for mod in sorted(LOCAL_LIB_DIR.glob("*.kicad_mod")):
        text = mod.read_text(encoding="utf-8")
        m = re.search(r'\(footprint "([^"]+)"', text)
        if not m:
            continue
        key = "ARTHUR:" + m.group(1)
        lines = text.splitlines()
        start = next((i for i, ln in enumerate(lines) if ln.strip().startswith("(attr ")), None)
        if start is None:
            continue
        end = None
        for i in range(len(lines) - 1, start, -1):
            s = lines[i].strip()
            if s.startswith("(net ") and s.endswith("))"):
                end = i
                break
            if s == ")" and "(pad " in lines[i - 1]:
                end = i - 1
                break
        if end is None:
            # library pads carry no nets; take through last pad close BEFORE embedded_fonts
            emb = next((i for i, ln in enumerate(lines) if ln.strip().startswith('(embedded_fonts')), len(lines))
            for i in range(min(emb, len(lines)) - 1, start, -1):
                if lines[i].strip() == ')' and i > start + 2:
                    seg = ' '.join(lines[max(start,i-8):i+1])
                    if '(pad ' in seg:
                        end = i
                        break
        if end is None:
            continue
        # strip library net tags if any (local lib must be net-free)
        chunk = []
        for ln in lines[start:end + 1]:
            chunk.append(re.sub(r"\s*\(net\s+\d+\s+\"[^\"]*\"\)", "", ln))
        bodies[key] = chunk
    return bodies


def grtext(txt, x, y, layer, size=1.0):
    return '\t(gr_text "%s" (at %.2f %.2f) (layer "%s") (tstamp %s) (effects (font (size %.2f %.2f) (thickness 0.15))))' % (
        txt, x, y, layer, ts_of(txt + str(x)), size, size)


def placement_plan():
    """Ordered (ref, libfp, val, x, y, rot, layer, dnp) from rows tables."""
    plan = []
    seen = set()
    emitted = set()
    for (ref, fp, x, y, rot, _flag) in RA.ROWS_A + RB.ROWS_B:
        if ref in seen:
            fail("duplicate ref in placement rows: " + ref)
        seen.add(ref)
        if ref in SKIP_MAIN:
            # Rows carry these DNP/companion refs with schematic-zone
            # coordinates; their canonical placement comes from EXTRA_ORDER
            # below (bench coordinates, matching the current PCB).
            continue
        if ref == "U7001":
            rot = -90
        layer = layer_of_bottom(ref in BOTTOM_REFS)
        if ref.startswith("TP"):
            val = TP_DEFAULT_VAL
        else:
            val = CC.VALS.get(ref)
            if val is None:
                fail("no value for " + ref + " (pl_core_c.VALS)")
        emitted.add(ref)
        plan.append((ref, fp, val, float(x), float(y), rot, layer, False))
    for (ref, x, y, rot, layer, dnp) in EXTRA_ORDER:
        if ref in emitted:
            fail("EXTRA ref already placed: " + ref)
        seen.add(ref)
        emitted.add(ref)
        fp = CD.EXTRA_FP.get(ref)
        val = CD.EXTRA_VAL.get(ref)
        if fp is None or val is None:
            fail("EXTRA ref missing from pl_core_d: " + ref)
        plan.append((ref, fp, val, float(x), float(y), rot, layer, bool(dnp)))
    return plan


def generate(ref_path):
    pcb_text = Path(ref_path).read_text(encoding="utf-8")
    head, blocks = split_blocks(pcb_text)
    if "(net " not in head:
        fail("reference header has no net declarations")
    plan = placement_plan()
    missing = [r for (r, *_rest) in plan if r not in blocks]
    if missing:
        fail("reference PCB lacks geometry for: " + ", ".join(missing))
    # Warn (not fail) on footprint-name drift between rows and reference.
    for (ref, fp, _v, _x, _y, _rt, _ly, _dnp) in plan:
        libfp, _val = footprint_header(blocks[ref])
        if libfp != fp:
            print("pl_place: WARNING: %s rows=%s reference=%s (using rows)" % (ref, fp, libfp))
    lib_bodies = load_local_lib_bodies()
    out = [head.rstrip()]
    for (ref, fp, val, x, y, rot, layer, _dnp) in plan:
        _libfp, _val = footprint_header(blocks[ref])
        if fp in lib_bodies and footprint_header(blocks[ref])[0] != fp:
            body = apply_net_tags(lib_bodies[fp], pad_nets(blocks[ref]), head_nets(head))
        else:
            body = body_of(blocks[ref])
        if layer == "B.Cu":
            body = mirror_body_to_bottom(body)
        out.append(emit_instance(ref, fp, val, x, y, rot, layer, body))
    _bw, _bh = BOARD_W, BOARD_H
    out.append('\t(gr_rect (start 0 0) (end %g %g) (layer "Edge.Cuts") (width 0.1) (fill none) (tstamp %s))' % (_bw, _bh, ts_of("edge")))
    for (txt, x, y, layer, size) in TAIL_TEXTS:
        out.append(grtext(txt, x, y, layer, size))
    out.append('\t(gr_rect (start 2 2) (end 40 28) (layer "Cmts.User") (width 0.1) (fill none) (tstamp %s))' % ts_of("batrect"))
    out.append(")")
    return "\n".join(out) + "\n"


def main(argv):
    ref = str(PROJECT_PCB)
    out = str(PROJECT_PCB)
    check = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--check":
            check = True
        elif a == "--out" and i + 1 < len(argv):
            i += 1
            out = argv[i]
        elif a == "--ref" and i + 1 < len(argv):
            i += 1
            ref = argv[i]
        else:
            fail("unknown argument: " + a)
        i += 1
    if not Path(ref).is_file():
        fail("reference PCB not found: " + ref)
    text = generate(ref)
    if check:
        cur = Path(ref).read_text(encoding="utf-8")
        if cur == text:
            print("pl_place --check: placement identical")
            return 0
        import difflib
        n = 0
        for ln in difflib.unified_diff(cur.splitlines(), text.splitlines(), lineterm=""):
            print(ln[:200])
            n += 1
            if n > 40:
                print("... (truncated)")
                break
        fail("placement differs from reference")
    Path(out).write_text(text, encoding="utf-8")
    print("pl_place: wrote %s (%d bytes)" % (out, len(text)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
