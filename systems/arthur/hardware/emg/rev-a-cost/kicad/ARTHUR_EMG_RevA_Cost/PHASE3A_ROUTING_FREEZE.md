# Routing Phase 3A — permanent freeze

Accepted by the user on 2026-09-26.

```yaml
ROUTING PHASE 3A: FROZEN
PHASE 3A READY FOR NEXT ROUTING PHASE: YES
```

Authoritative checkpoint: `ARTHUR_EMG_RevA_Cost_Phase3A_ThreeNetClean.kicad_pcb`.
Use this checkpoint as the routing continuation base. Recovered and Combined
are historical/reference checkpoints, not the accepted routing state.

Permanently frozen nets: AFE_CLKIN, MCU_SCLK, MCU_MOSI, AFE_MISO, MCU_CS_N,
AFE_DRDY_N, MCU_RESET_N_AFE. The freeze covers all 14 Phase 3A vias and all
Phase 3A F.Cu/B.Cu routing, plus Phase 1 analog, Phase 2 power, placement,
RF keepout, and the In1.Cu/In2.Cu GND structure.

Do not modify this geometry in later phases unless later full-board
verification proves a concrete electrical or manufacturing blocker.
Retain the verification evidence and document the blocker and the minimum
necessary change if that exception becomes applicable.

Accepted verification: all seven U6001–U7001 interfaces connected; crossings,
new copper clearance violations, shorts, and dangling tracks/vias are zero.
In1/In2 GND continuity: PASS. This acceptance concerns the completed interface
routes; existing board-wide unconnected branches remain outside this freeze task.

Recovered DRC baseline: 525. Final DRC: 548. The delta consists solely of 23
latent non-mirrored back-layer text warnings; new routing violations: zero.
Validation used `--all-track-errors` and refilled zones.

Preserve these evidence files unchanged:

- PHASE3A_THREE_NET_CLEAN_REPORT.md
- phase3a_three_net_clean_drc.json
- phase3a_three_net_drc_delta.json
- phase3a_three_net_verification.json

The checkpoint, sidecars, and evidence SHA-256 hashes are recorded in
`phase3a_routing_freeze.json`. The checkpoint and evidence were not changed
while recording this freeze. No next routing phase was started.
