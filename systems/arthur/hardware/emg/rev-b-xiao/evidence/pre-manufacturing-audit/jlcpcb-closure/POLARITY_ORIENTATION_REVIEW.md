# Placement and polarity review for factory preview

**NOT RELEASED — PENDING FACTORY APPROVAL**

All126CPL rows were compared with current PCB positions and the retained correction conventions:SOT23+180°,TSSOP/SOIC+270°,JST_PH_S+180°. PositiveKiCadY becomes negativeCPLY; allfactory placements areTop. Arithmetic agreement is not approval of a supplier's tape/reel zeroangle. See [verification/placement-review.csv](verification/placement-review.csv) for everyreference,MPN,LCSC,source pose,factory rotation and actual pad 1 coordinate/net. Factory preview approval remains UNVERIFIED.

| References | Required identity / polarity check |
|---|---|
|J401,J301,J201,J101,J5001 |S2B-PH-SM4-TB(LF)(SN),C295747. CurrentPCB180°→factory0°. Allfive socket mouths face north. CentersX6.85,16.25,25.65,35.05,44.45;Y5.15 mm. Pin1east,pin2west. MP pads isolated from signals/GND |
|J101/J201/J301/J401 |Pin1=channelELEC_P,pin2=ELEC_N. Check cable polarity and channel identity |
|J5001 |Pin1intentionallyNC,pin2=RLD_SAFE/reference. Do not wire unusedpin1toGND |
|J1 |Unchangedbatteryhorizontalheader,PCB90°→factory270°. Mouth faces east. Pin1VBAT+,pin2GND; physicalPHkey does not standardize cell-wire polarity |
|D101/D102,D201/D202,D301/D302,D401/D402 |NexperiaBAV199,215:SOT23pin1A1→GND,pin2K2→AFE_3V0,pin3seriesjunction→HIZ. Use pin numbering, not a single-diode cathode stripe convention |
|D103/D104,D203/D204,D303/D304,D403/D404 |Samepart:SOT23pin1→GND,pin3→ADCleg,pin2intentionallyNC; do not treatNC as missingrouting |
|Q3001 |JSCJ2N7002,C8545:SOT23pin1gate,pin2sourceGND,pin3drainAFE_EN |
|U501/U502/U503 |TLV9064IPWR,PW14:pin1OUT1,pin4 V+,pin11 V−. Retain visiblepin1triangles; manufacturermarking/preview must agree |
|U4002 |TPS7A2030PDBVR,DBV5:pin1IN,pin2GND,pin3EN,pin4NC,pin5OUT; retain correctPvariant |
|U6001 |ADS131M04IPWR,PW20:pin1AVDD,pin2AGND,pin19DGND,pin20DVDD. Verify alternated analogP/Npin sequence using current netlist |
|X1 |SX3M8.192M20F30TNN,C2901557:proposed3225pin1OE(DVDD_F),pin2GND,pin3OUT,pin4VDD. Source pin1dot unchanged. Exact selected supplier land/mark/tape documentation still required; nogeneric3225substituteapproved |
|U1 |FactoryDNP; omitted fromfactoryBOM/CPL. Manualcastellations1–14andVBATpost23only; bottomGND0not intentionallysoldered tohost |

Before production, factory must return an unambiguous placement preview, exactselectedpart identity and polarity orientation for eachpackagegroup,especially the29polarized/connector placements(16diodes,6headers,Q3001,3opamps,LDO,ADC,X1). No candidateCPL rotation has been silently “corrected” from an unverified preview.
