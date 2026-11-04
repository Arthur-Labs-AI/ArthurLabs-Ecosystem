# RB-01R — independent electrical-netlist checks (proposed tooling)

**Status:** tools created outside the owner's local Git worktree. They have **not** been executed against a freshly exported KiCad netlist in the present environment. They are not an electrical-safety certification and do not replace the manufacturer's datasheets or bench measurements.

Run in the Rev B KiCad project directory (KiCad 10):

```bash
kicad-cli sch export netlist --format kicadxml -o revb-rb01r.xml ARTHUR_EMG_RevB.kicad_sch
python3 ../../tools/rb01r_netlist_audit.py revb-rb01r.xml
python3 ../../tools/test_audit_mutations.py revb-rb01r.xml
kicad-cli sch erc --severity-all --format report -o rb01r-erc.rpt ARTHUR_EMG_RevB.kicad_sch
```

If files are kept under `hardware/emg/rev-b-xiao/tools/`, relative path to tools from the KiCad project directory is `../../tools/`. Check actual CLI subcommand options for your installed KiCad version.

The audit consumes KiCad XML and derives requirements from independently reviewed component/pin invariants, **not from the schematic generator's intended-net file**. Its mutation suite changes the exported XML copy in memory and confirms that important faults trip specific assertions. Both scripts are read-only and create no PCB. Add further checks for cross-network topology, patient leakage limits, component ratings, and physical connector pin numbering when source documents permit.

**Important:** The existing 30-assertion project audit remains the historical baseline. The script supplied here is a second, intentionally focused check, not its verbatim replacement. Failing any check blocks RB-01R. A PASS does not prove analog stability, safety, component availability, PCB fabrication accuracy, or assembly.
