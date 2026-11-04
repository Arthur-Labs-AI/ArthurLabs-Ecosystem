#!/usr/bin/env python3
"""RB-03R analog routing audit (read-only, from the routed .kicad_pcb text).

    python3 rb03r_analog_audit.py --pcb routed.kicad_pcb --out analog.json

Measured per channel: hi-Z / electrode / buffered / ADC-input copper length and layer use, P/N difference and the resulting
parasitic-capacitance difference (microstrip estimate over the In1 plane, 0.2104 mm 7628 prepreg, eps_r 4.4, 35 um copper), the
coupling of the two ADC input runs of a pair (mean separation, share within 1.0 mm), spacing to SPI / clock / control tracks, nearest GND via
along hi-Z tracks, decoupling-loop lengths and the clock net.  No limit is imposed on length matching: the numbers are reported.
"""
import argparse
import collections
import fnmatch
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import first, kids, parse  # noqa: E402
from rb02_write_project import PATTERNS  # noqa: E402

H, ER, T = 0.2104, 4.4, 0.035


def klass(n):
    for c, p in PATTERNS:
        if fnmatch.fnmatchcase(n, p):
            return c
    return "Default"


def c_per_mm(w):
    """pF/mm of a microstrip of width w over the adjacent plane (Hammerstad / Wheeler-class estimate)"""
    u = w / H
    eeff = (ER + 1) / 2 + (ER - 1) / 2 / math.sqrt(1 + 12 / u)
    z0 = 87 / math.sqrt(ER + 1.41) * math.log(5.98 * H / (0.8 * w + T))
    return math.sqrt(eeff) / (299.79 * z0) * 1000.0          # nF/mm -> pF/mm


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    root = parse(a.pcb.read_text())
    segs = []
    for s in kids(root, "segment"):
        st, en = first(s, "start"), first(s, "end")
        segs.append((str(first(s, "net")[1]), str(first(s, "layer")[1]), float(st[1]), float(st[2]), float(en[1]), float(en[2]), float(first(s, "width")[1])))
    vias = [(str(first(v, "net")[1]), float(first(v, "at")[1]), float(first(v, "at")[2])) for v in kids(root, "via")]
    L = lambda s: math.hypot(s[4] - s[2], s[5] - s[3])
    by = collections.defaultdict(list)
    for s in segs:
        by[s[0]].append(s)
    vby = collections.defaultdict(list)
    for v in vias:
        vby[v[0]].append(v)

    def length(n):
        return round(sum(L(s) for s in by.get(n, [])), 2)

    def samples(n, step=0.5):
        out = []
        for s in by.get(n, []):
            k = max(1, int(L(s) / step))
            for q in range(k + 1):
                t = q / k
                out.append((s[2] + t * (s[4] - s[2]), s[3] + t * (s[5] - s[3]), s[1]))
        return out

    def dist_to(n_from, pred):
        """min distance from samples of n_from to the copper (segments) of any net satisfying pred, on the same layer"""
        best = 1e9
        others = [s for n, ss in by.items() if pred(n) and n != n_from for s in ss]
        for (x, y, lay) in samples(n_from, 0.5):
            for s in others:
                if s[1] != lay:
                    continue
                dx, dy = s[4] - s[2], s[5] - s[3]
                l2 = dx * dx + dy * dy
                t = 0 if l2 == 0 else max(0, min(1, ((x - s[2]) * dx + (y - s[3]) * dy) / l2))
                d = math.hypot(x - (s[2] + t * dx), y - (s[3] + t * dy)) - s[6] / 2
                if d < best:
                    best = d
        return round(best, 2)

    gnd_vias = [(x, y) for n, x, y in vias if n == "GND"]
    out = {"channels": {}}
    cpm = c_per_mm(0.2)
    out["c_per_mm_pF_0p2_over_In1"] = round(cpm, 3)
    spi = lambda n: klass(n) == "SPI_FAST"
    ctl = lambda n: klass(n) == "CTRL_SLOW"
    for c in (1, 2, 3, 4):
        ch = {}
        for kind in ("ELEC", "HIZ"):
            p, n = f"/CH{c}/{kind}_P", f"/CH{c}/{kind}_N"
            ch[kind] = {"P_mm": length(p), "N_mm": length(n), "diff_mm": round(abs(length(p) - length(n)), 2),
                        "diff_pF": round(abs(length(p) - length(n)) * cpm, 3), "vias": len(vby.get(p, [])) + len(vby.get(n, [])),
                        "layers": sorted({s[1] for s in by.get(p, []) + by.get(n, [])})}
        for kind in ("BUF", "ACN"):
            p, n = f"/CH{c}/{kind}_P", f"/CH{c}/{kind}_N"
            ch[kind] = {"P_mm": length(p), "N_mm": length(n), "diff_mm": round(abs(length(p) - length(n)), 2), "vias": len(vby.get(p, [])) + len(vby.get(n, []))}
        p, n = f"/CH{c}_P", f"/CH{c}_N"
        sp, sn = samples(p), samples(n)
        sep = []
        for (x, y, _l) in sp:
            sep.append(min((math.hypot(x - u, y - w) for (u, w, _m) in sn), default=1e9))
        within = sum(1 for d in sep if d <= 1.0) / len(sep) if sep else 0
        ch["ADCIN"] = {"P_mm": length(p), "N_mm": length(n), "diff_mm": round(abs(length(p) - length(n)), 2), "vias": len(vby.get(p, [])) + len(vby.get(n, [])),
                       "mean_separation_mm": round(sum(sep) / len(sep), 2) if sep else None, "share_of_P_within_1mm_of_N": round(within, 2),
                       "min_to_spi_mm": min(dist_to(p, spi), dist_to(n, spi)), "min_to_ctrl_mm": min(dist_to(p, ctl), dist_to(n, ctl))}
        # hi-Z: farthest point from a GND via (return-path stitching) and spacing to SPI/CTRL
        for kind in ("HIZ",):
            far = 0.0
            for nn in (f"/CH{c}/HIZ_P", f"/CH{c}/HIZ_N"):
                for (x, y, _l) in samples(nn, 1.0):
                    d = min((math.hypot(x - gx, y - gy) for gx, gy in gnd_vias), default=1e9)
                    far = max(far, d)
            ch["HIZ"]["max_distance_to_GND_via_mm"] = round(far, 2)
            ch["HIZ"]["min_to_spi_mm"] = min(dist_to(f"/CH{c}/HIZ_P", spi), dist_to(f"/CH{c}/HIZ_N", spi))
        out["channels"][f"CH{c}"] = ch
    out["clock"] = {"X1_OUT_mm": length("/ADC/X1_OUT"), "ADC_CLKIN_mm": length("/ADC/ADC_CLKIN"),
                    "X1_OUT_min_to_hiz_or_buf_mm": dist_to("/ADC/X1_OUT", lambda n: klass(n) in ("EMG_HIZ", "EMG_BUF")), "vias": len(vby.get("/ADC/X1_OUT", []))}
    out["spi_nets_mm"] = {n: length(n) for n in by if klass(n) == "SPI_FAST"}
    out["totals"] = {k: round(sum(length(n) for n in by if klass(n) == k), 1) for k in ("EMG_ELECTRODE", "EMG_HIZ", "EMG_BUF", "SPI_FAST", "CTRL_SLOW", "ANALOG_REF")}
    out["vias_on"] = {k: sum(len(v) for n, v in vby.items() if klass(n) == k) for k in ("EMG_HIZ", "EMG_ELECTRODE", "EMG_BUF", "ADC_CAP", "ANALOG_REF", "SPI_FAST")}
    a.out.write_text(json.dumps(out, indent=1))
    print(json.dumps({k: out[k] for k in ("clock", "totals", "vias_on")}, indent=1))
    for c, ch in out["channels"].items():
        print(c, "HIZ P/N", ch["HIZ"]["P_mm"], ch["HIZ"]["N_mm"], "dC pF", ch["HIZ"]["diff_pF"], "| ADCIN P/N", ch["ADCIN"]["P_mm"], ch["ADCIN"]["N_mm"],
              "sep", ch["ADCIN"]["mean_separation_mm"], "within1mm", ch["ADCIN"]["share_of_P_within_1mm_of_N"], "spi", ch["ADCIN"]["min_to_spi_mm"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
