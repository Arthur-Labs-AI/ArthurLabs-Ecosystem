# KiCad routing continuation constraints

Routing Phase 3B-F is FROZEN and accepted by the user. Its exact checkpoint
was promoted to production on 2026-09-27 without routing edits.
Read [PHASE3B_ROUTING_FREEZE.md](PHASE3B_ROUTING_FREEZE.md) and
`phase3b_routing_freeze.json` before any future routing. Start from the frozen
Phase 3B production state in `ARTHUR_EMG_RevA_Cost.kicad_pcb`.
The accepted production/checkpoint SHA-256 at promotion is
`d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005`.
`ARTHUR_EMG_RevA_Cost_Phase3B_FinalClean.kicad_pcb` is the immutable,
byte-identical checkpoint. Preserve it and all six evidence files bound by
the Phase 3B manifest, plus the manifest itself. The freeze document and
manifest retain their pre-promotion verification snapshot; this instruction
records the subsequent user acceptance and production promotion.

Phase 3A remains permanently FROZEN. Read
[PHASE3A_ROUTING_FREEZE.md](PHASE3A_ROUTING_FREEZE.md) as well, but do not use
its older checkpoint, the failed Combined experiment or the earlier Recovered
state as the continuation base.

Preserve all accepted Phase 3B reference-core, VCM, follower, RLD_SAFE,
AFE_3V0 quiet-core and local GND tracks/vias exactly. The documented 3B-5E
VCM replacement is part of the accepted frozen state; do not restore the
removed segment or make further VCM edits for optimization. GND freeze
covers existing geometry and the seven accepted Phase 3B local returns;
global GND completion is not claimed. R3005.2 remains deferred to Phase 3D
discharge/interlock and TP601.1 to the later testpoint phase. Global AFE_3V0
completion is not claimed either.

Preserve AFE_CLKIN, MCU_SCLK, MCU_MOSI, AFE_MISO, MCU_CS_N, AFE_DRDY_N,
MCU_RESET_N_AFE; all 14 Phase 3A vias; all Phase 3A F.Cu/B.Cu geometry;
Phase 1 analog; Phase 2 power; placement; RF keepout; and In1/In2 GND structure.
Modify frozen geometry only if later full-board verification proves a concrete
electrical or manufacturing blocker. Preserve and document that evidence and
the minimum necessary change. Do not reroute frozen nets for optimization.

Preserve the four accepted evidence files named in PHASE3A_ROUTING_FREEZE.md.
Use real KiCad DRC with `--all-track-errors` and zone refill for later routing
validation. Compare copper violation identities/categories against the accepted
baseline separately from latent text warnings and pre-existing violations.

The separate full-board JLCPCB/manufacturing audit must review the
pre-existing Phase 3A baseline via/pad overlaps documented in the Phase 3B
freeze evidence. They are not Phase 3B additions: all 20 added Phase 3B vias
are outside pads. Do not infer whole-board absence of via-in-pad or final
assembly/process qualification from Phase 3B acceptance. Baseline overlaps
remain frozen; this warning does not authorize repairs. The 548 ordinary
DRC violations and 92 remaining unconnected pairs also remain outside the
completed Phase 3B scope.

Production promotion did not start Phase 3C. Begin later-phase work only
under an explicit user request for that phase.
