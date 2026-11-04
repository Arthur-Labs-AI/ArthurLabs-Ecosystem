# Rev B project-local footprint libraries (RB-01R)

* `*.pretty` for Resistor_SMD, Capacitor_SMD, Inductor_SMD, Package_SO, Package_TO_SOT_SMD, Connector_JST, TestPoint:
  **unmodified subset** of the KiCad official footprint libraries, tag `10.0.0`
  (https://gitlab.com/kicad/libraries/kicad-footprints, CC-BY-SA 4.0 with the KiCad library exception),
  retrieved 2026-10-10 and vendored so qualification and ERC are reproducible without a system library install.
  Nothing here was edited; compare with `sha256sum` against upstream if in doubt.
* `ARTHUR.pretty/` holds the two project footprints authored in RB-02 by `tools/rb02_make_footprints.py`
  (geometry: Seeed PCB extraction of RB-02A, SCTF 3CM drawing, RB-00.6 host values):
  `XIAO_ESP32S3_HANDSOLDER` and `OSC_SCTF_SX3M_SMD3225-4P`. Audit: `tools/rb02_audit_footprints.py`,
  REVB_RB02_FOOTPRINT_AUDIT.md. They clear the last two ERC `footprint_link_issues` warnings (X1, U1).
