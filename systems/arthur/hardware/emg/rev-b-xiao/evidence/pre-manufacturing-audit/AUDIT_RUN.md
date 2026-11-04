# Executed audit commands and scope

2026-10-19; KiCad10.0.6. Canonical project copied to `/tmp/arthur-pre-mfg-audit/project/` before opening; canonical files never saved by KiCad/pcbnew. All output paths below are within this new audit directory. Full pre-existing source diff and718-file hash manifest retained.

Executed native checks:

```text
kicad-cli pcb drc --severity-all --schematic-parity --format json -o <audit>/drc.json <scratch>/ARTHUR_EMG_RevB.kicad_pcb
kicad-cli sch erc --severity-all --format json -o <audit>/erc.json <scratch>/ARTHUR_EMG_RevB.kicad_sch
kicad-cli sch export netlist --format kicadxml -o <audit>/netlist.xml <scratch>/ARTHUR_EMG_RevB.kicad_sch
```

Executed existing tools with scratch inputs and new audit outputs:

- `rb05_package.py /tmp/arthur-pre-mfg-audit/export-work <audit>/fresh-export`, environment `RB05_PROJECT=<scratch>`;11files,28groups,126CPLrows. New Gerbers/drill/positions then compared independently with original package.
- `rb04_geom.py --pcb <scratch>/ARTHUR_EMG_RevB.kicad_pcb --out <audit>/geometry.json`.
- `rb04_mask.py --pcb <scratch>/ARTHUR_EMG_RevB.kicad_pcb --out <audit>/mask.json`.
- `rb04_electrical.py --pcb <scratch>/ARTHUR_EMG_RevB.kicad_pcb --netlist <audit>/netlist.xml --out <audit>/layout-electrical-model.json` (secondary approximate model, hardcoded electrical assumptions; selectedJSCJ Q3001 reviewed separately).
- `rb04i_u1_compare.py` with scratchPCB and scratch vendoredXIAO footprint →`u1-comparison.json`.
- `rb04i_keepout_check.py` scratchPCB →`xiao-keepouts/`.
- `rb04_gerber.py --gerber <audit>/existing-gerbers --pcb <scratch>/ARTHUR_EMG_RevB.kicad_pcb --out <audit>/gerber-audit.json --svg-dir <audit>/plots`.
- `rb01r_netlist_audit.py <audit>/netlist.xml --json` →`legacy-netlist-audit.json`: exit1,D06only; failure preserved/dispositioned, not suppressed.

New audit-only tools:

- `python3 <audit>/independent_checks.py`: parsed PCB/baseline text and fresh XML, compared per-pad nets, every BOM/CPL row and192drillcoordinates; calculated explicitly assumed differential half-circuit transfer.
- `/usr/bin/python3 <audit>/silk_check.py`: originalGerber straight strokes against mask aperture rectangles; conservative corner treatment, exact straight-faceX1example identified in report.
- Separate one-time s-expression comparison produced`baseline-structural-diff.json`; removed only fill-cache children when comparing zone definitions, retained full footprint/track net differences.
- Separate pad-coordinate transform produced`decoupling-distances.json`: Euclidean pad centers, not routed trace/ground-loop lengths.

Visualization:

- Custom RS274X SVG plots rendered with`rsvg-convert`; all four copper layers,F.Mask,F.Paste,Edge.Cuts contact sheet reviewed plus F/Bsilk,B.Mask individual plots.
- Native `kicad-cli pcb export svg --layers F.Cu,F.SilkS,F.Mask,Edge.Cuts --mode-single --page-size-mode 2 --exclude-drawing-sheet` on scratchPCB →`plots/native-top.svg`, rendered PNG reviewed. Confirms rounded outline independently of custom parser's chord approximations.
- Primary PDF extraction with`pdftotext -layout`; Seeed current and historical schematic pages rendered with`pdftoppm` and reviewed; ADC recommended limits and selectedJSCJ electrical table rendered/reviewed and retained in`sources/`.

Native pcbnew emitted PROPERTY_ENUM diagnostic warnings during shape-provider imports; tools completed and produced output. No such warning was treated as permission to change design constraints. No physical tests, factory CAM approval, inventory reservation or qualified safety assessment were executed. No commit, push, factory message or purchase occurred.
