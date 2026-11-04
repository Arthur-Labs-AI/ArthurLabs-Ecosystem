# A.R.T.H.U.R EMG Rev B — Firmware and Connectivity Feasibility Audit

Date: 2026-10-13. Read-only audit: no hardware, firmware or application file was modified; nothing committed, pushed or ordered (this report is a new, uncommitted document).
Evidence: the frozen R1b schematic/netlist and RB-04 documents; TI **ADS131M04 SBAS890D** and Espressif **ESP32-S3 Datasheet v2.2** (both read from the manufacturer PDFs on 2026-10-13); the Tauri v2 app in `apps/arthur` (Tauri 2.12.1, Android minSdk 24 / targetSdk 37); public plugin/permission documentation (cited at the end). Numbers marked *estimate* are my calculations or experience values, not measurements.

## 0. Answers

| Question | Answer |
|---|---|
| Is XIAO ESP32-S3 sufficient? | **Yes.** 4 ch × 2 kSPS is 8 ksamples/s; the SPI bus is used < 4 %, DSP < 2 % of one core (*estimate*), RAM and PSRAM are ample, BLE 5 (1M/2M PHY) carries raw 1–2 kSPS with margin or features/gestures with large margin. The limits are *radio-noise discipline* (Wi-Fi off while acquiring) and Android BLE behaviour, not CPU/RAM. |
| Is the existing pin mapping viable? | **Yes.** All 11 signals map to usable GPIOs; the only strapping pin used (GPIO3) is ignored by default eFuses and externally pulled up as the datasheet requires; the UART0 pins (GPIO43/44) are usable provided the console is moved to USB-Serial-JTAG. Verified against the datasheet (§2). |
| Is any PCB modification needed before manufacturing? | **No blocking change.** One consequence to accept knowingly: with USB attached the AFE is hardware-inhibited, so *live-EMG debugging over USB is impossible by design*; wireless logging (BLE) and a simulation mode replace it (§9). Optional, not recommended now: D4/D5 (GPIO5/6) could carry a debug UART to test pads — a PCB change. |
| What firmware and app development remains? | **Essentially all of it**: the repo contains no firmware and no Bluetooth code (§8). Hardware is complete. |
| What requires physical testing? | The analog front end (noise, CMRR, mains pick-up, input impedance), radio-induced noise in the 20–450 Hz band, real BLE throughput/latency on target phones, antenna placement in the enclosure, current budget, USB-inhibit behaviour (§10). |

## 1. ADS131M04 interface (datasheet-verified)

| Item | Datasheet (SBAS890D) | Rev B design | Verdict |
|---|---|---|---|
| SPI mode | CPOL = 0, CPHA = 1 (mode 1); CS may change only while SCLK low; DOUT valid on SCLK rising, DIN latched falling | SCLK idles low; 33 Ω series; CS on GPIO44 with 100 k pull-up | OK — configure ESP32-S3 SPI mode 1 |
| SCLK | ≤ 25 MHz (tc(SC) ≥ 40 ns) | 4–8 MHz planned | OK (GPIO-matrix routing is fine at ≤ 8 MHz) |
| Word / frame | 16/24/32-bit words, **24-bit default**; frame = response + 4 channel words + CRC = **6 words = 18 bytes**; DIN carries command + 4 zero words + CRC/zeros | 144 bit | 18 µs at 8 MHz |
| CRC | **output CRC cannot be disabled**, appended to every frame; CCITT x¹⁶+x¹²+x⁵+1 (default) or ANSI; **seed FFFFh**; input CRC optional | — | firmware must verify every frame; ESP32-S3 ROM has `crc16_be` |
| DRDY | active-low; default level format (low until the data are shifted out, brief high before next); `tw(DRL)` = 4 tCLKIN (0.49 µs) for the pulse format; first data after reset/sync may have a narrow pulse → read the second set immediately | D1/GPIO2 via 100 Ω | use falling-edge interrupt; do not read while a conversion completes |
| Data rate | ODR = fCLKIN / (2 × OSR): 8.192 MHz → OSR 1024 = 4 kSPS, **2048 = 2 kSPS, 4096 = 1 kSPS** | local 8.192 MHz XO (X1) | exact binary rates; ADC timing independent of MCU |
| SPI timeout | frame must complete within 2¹⁵ tCLKIN (4.0 ms) when enabled | 18 µs frame | OK |
| Reset | POR 250 µs; pin reset ≥ 2048 tCLKIN (250 µs); wait for DRDY rising edge; STATUS RESET bit set after reset | SYNC/RESET_N on GPIO3, 10 k pull-up; 60 µs power-up glitch < 250 µs | OK |
| Supply order | **any order**; inputs must never exceed their own supply | DVDD from XIAO 3V3, AVDD from AFE_3V0 (switched) | OK — closes the "AVDD 0 V / DVDD on" bench item of RB-04C |
| Start-up samples | ignore the first conversions after reset/enable (sinc filter settling; fast-start table) | AFE settling 5τ ≈ 1.1 s on top | firmware: discard until ≥ 1.1 s after AFE_EN |
| Test sources | per-channel input mux: normal / **inputs shorted** / **±DC test signal (2/15 × VREF)** | — | a ready-made bring-up path with no extra hardware |

**Sustained 1–2 kSPS/channel:** DRDY period 500 µs (2 kSPS) / 1 ms (1 kSPS); a frame is 18 µs, so the SPI is busy 3.6 % / 1.8 %. The ESP32-S3 side (§2) has two orders of magnitude of slack. **Sample integrity:** the ADC offers no conversion counter, so loss is detected in firmware by (a) CRC and STATUS (CRC_ERR, RESET, DRDYn bits) of each frame and (b) DRDY inter-arrival time latched by the ISR (a gap ≈ 2× the period = a skipped result); every sample is stamped with a monotonic 32-bit sample index.

## 2. ESP32-S3 / XIAO pin and boot verification (datasheet v2.2)

| Pin | Rev B use | Datasheet facts | Result |
|---|---|---|---|
| GPIO1 (D0) | VBAT_SENSE (ADC1) | 60 µs low glitch at power-up | divider node only dips |
| GPIO2 (D1) | DRDY_N | 60 µs low glitch | 100 Ω series limits contention |
| **GPIO3 (D2)** | SYNC/RESET_N | strapping pin, **no internal pulls; the external circuit must define it**; JTAG source = **ignored unless EFUSE_STRAP_JTAG_SEL is burned** (default 0) | 10 k pull-up defines it; **never burn STRAP_JTAG_SEL**; 60 µs glitch < 250 µs reset threshold |
| GPIO4 (D3) | AFE_EN_REQ | 60 µs low glitch | safe direction; 100 k pull-down on AFE_EN covers reset/boot/deep sleep |
| GPIO5/6 (D4/D5) | not connected | — | free |
| **GPIO43 (D6)** | USB_PRESENT sense | UART0 TX: **ROM prints here by default** (UART0 and USB-Serial-JTAG) | harmless into 60 kΩ divider; ignore the pin until boot completes; keep console off UART0 |
| **GPIO44 (D7)** | CS_N | UART0 RX; not in the glitch table; boot-mode ROM listens here only in UART download | 100 k pull-up keeps CS high through reset |
| GPIO7/8/9 (D8–D10) | SCLK / MISO / MOSI | 60 µs low glitch; IO-MUX SPI2 pins are GPIO10–13 (not available) → **GPIO matrix** | fine at ≤ 8 MHz |
| GPIO0, GPIO46 | not exposed | boot mode (GPIO0 = 0 and GPIO46 = 0 → download); GPIO45 = VDD_SPI | module buttons B/R and USB reach them |
| GPIO19/20 | USB D−/D+ | USB-Serial-JTAG, only on the module's USB-C | JTAG/CDC only with USB attached |

**Firmware rules these facts impose**
1. ESP-IDF default console is UART0 → set `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG` (or none); otherwise logs toggle D6 and the console RX contends with CS on D7. Disable bootloader/ROM log to UART where possible **without burning eFuses**.
2. Drive CS from the SPI peripheral's CS signal via the GPIO matrix (or manually) as an output on GPIO44; re-assert the pull-up logic at deep sleep (hold).
3. Never use D6 as an output.
4. AFE enable (hardware truth table, RB-00 §4, 15 scenarios): firmware raises D3 only if `USB_PRESENT = 0`, VBAT ≥ 3.30 V (hard stop 3.20 V), and then waits ≥ 300 ms before configuring the ADC and ≥ 1.1 s before using data; any USB insertion → drop D3 immediately (the hardware does it too) and flush. Scenario 14 (Q3001 open + USB + D3 high) is the single uncovered fault; firmware D6 watch is the backup.
5. USB attached = AFE off by design: USB mode is *configuration, provisioning, DFU and simulated data only*.

## 3. CPU, RAM and real-time budget (estimates)

| Resource | Demand | Available (XIAO ESP32-S3: 240 MHz dual LX7, 512 KB SRAM, 8 MB PSRAM, 8 MB flash) |
|---|---|---|
| Acquisition ISR + SPI DMA | 2 kHz × (ISR ≈ 5–10 µs + 18 µs transfer) ≈ 4–6 % of a core | core 1 dedicated, high priority |
| Filtering (HP 20 Hz + 50/60 Hz notch + LP 450 Hz ≈ 4 biquads × 4 ch × 2 kHz) | ≈ 32 k section-updates/s × ~25 cycles ≈ 0.8 Mcycles/s ≈ 0.3 % | trivial |
| Features (RMS/MAV/ZC/SSC/WL, 100–200 ms windows) | < 1 % | trivial |
| Classifier (LDA/small MLP or 1-D CNN ~50–100 k MAC at 10–50 Hz) | 0.5–5 M MAC/s ≈ 1–5 % with optimised kernels | ample |
| Buffers | 2 kSPS × 4 ch × 3 B = 24 kB/s; 10 s ring = 240 kB (PSRAM); float working set < 100 kB | 512 KB SRAM + 8 MB PSRAM |
| Radio coexistence | BLE on core 0; Wi-Fi **off** while acquiring (architecture contract N5) | |

## 4. BLE architecture

**Link budget.** Raw 24-bit at 2 kSPS = 24 kB/s (192 kbit/s); at 1 kSPS 96 kbit/s; 16-bit decimated 1 kSPS = 64 kbit/s; features/gesture events < 1 kbit/s. ESP32-S3 supports BLE 5 (125 kbit/s, 500 kbit/s, 1 Mbit/s, **2 Mbit/s** PHYs). With ATT MTU 247 (NimBLE can negotiate up to 517), data-length extension and the 2M PHY, raw 2 kSPS needs ≈ 100 notifications/s; typical Android phones sustain several hundred (device-dependent, *to be measured*). Recommendation: **default stream = features + gesture events (+ optional decimated 1 kSPS raw); raw 2 kSPS only in "lab mode" on 2M PHY.**

**Proposed GATT (custom 128-bit UUID service `arthur-emg`)**

| Characteristic | Props | Content |
|---|---|---|
| `info` | read | protocol version, firmware version, hardware rev, ADC config (ODR, gain, channels) |
| `control` | write (encrypted) | start/stop, mode (features/raw/sim), gain, ODR, calibration, time-sync request, AFE request |
| `status` | read + notify | state (idle / settling / acquiring / usb-inhibited / low-battery), VBAT, USB, counters (overruns, CRC errors, drops) |
| `data` | notify | EMG packets (below) |
| `event` | notify / indicate | gesture events: id, confidence, sequence, device timestamp |
| `log` | notify | wireless debug log (replaces USB console while the AFE is on) |

**Data packet (≤ 244 B payload):** `ver(1) | type(1) | seq(u16) | sample_index0(u32) | t0_us(u32) | n(1) | status(1) | payload: n × 4 ch × 24-bit` (n = 10 → 128 B; 5 ms @ 2 kSPS). The BLE link-layer CRC protects transport; the ADC frame CRC was already verified on the device; `seq` detects notification loss, `sample_index` detects sample loss.
**Timestamps:** the device latches a µs counter at DRDY; the phone maps device→host time with a periodic round-trip exchange (offset + drift estimate; ADC clock ±20 ppm, ±30 ppm over temperature). Display latency target < 150 ms (window 100 ms + connection interval 15–30 ms + app).
**Reconnect:** bonded peers, resolvable private address; on disconnect firmware keeps acquiring into a ring (≥ 8 s at 2 kSPS = 192 kB) and marks gaps with `seq`/`sample_index`; Android quirks (GATT status 133, cache) handled by retry/refresh logic; connection priority "high".
**Pairing:** the XIAO has no display or keypad → LE Secure Connections **Just Works** with bonding gives encryption but no MITM protection; add an application-layer authentication (challenge-response with a secret provisioned once over USB, which does not need the AFE) or use an OOB/QR passkey on the enclosure.
**In-band interference:** BLE connection-interval fundamentals fall inside 20–450 Hz (architecture risk N2); choose and fix the interval by FFT of shorted-input data at bring-up; Wi-Fi stays off during acquisition.

## 5. Android Bluetooth and the Tauri integration path

| Item | Finding |
|---|---|
| Current app | Manifest declares only `INTERNET` and `RECORD_AUDIO`; capability file has `core:default`; **no Bluetooth plugin, permission, UI or protocol code**; `emg` exists only as a capture *source kind* (`packages/contracts/capture.ts`, `capture_store.rs`) with icon/label/provenance mapping |
| Permissions (Android 12+, API 31) | `BLUETOOTH_SCAN` (with `usesPermissionFlags="neverForLocation"`) and `BLUETOOTH_CONNECT` as runtime permissions ("Nearby devices"); for ≤ API 30: `BLUETOOTH`, `BLUETOOTH_ADMIN` (maxSdk 30) and `ACCESS_FINE_LOCATION`. Background streaming needs a foreground service of type *connectedDevice* (Android 14: `FOREGROUND_SERVICE_CONNECTED_DEVICE`) |
| Integration option A | **`tauri-plugin-blec`** (btleplug on desktop/iOS, own Kotlin backend on Android; scan, connect, notifications, MTU; actively maintained, 0.17 listed). Fastest; check its minSdk and that its manifest merge matches the app's `neverForLocation` choice |
| Integration option B | own Kotlin `BluetoothPlugin` registered like the app's existing `AudioPlugin`/`SecretsPlugin` via `register_android_plugin`, with the same runtime-permission pattern as the microphone flow; more control (connection priority, 2M PHY, foreground service), more code |
| Web Bluetooth | not an option: Android WebView and WebKitGTK lack it |
| Desktop | btleplug: Windows (WinRT), Linux (BlueZ over D-Bus, `bluetoothd` required), macOS (CoreBluetooth); expose through the same Rust trait as Android; add plugin permissions to the capability file |

## 6. Wi-Fi (optional) and external antenna

* **Wi-Fi**: ESP32-S3 Wi-Fi 4 gives UDP/WebSocket throughput orders of magnitude above the need, but TX bursts (≈ 300 mA+) couple into VBAT and the analog band. Treat Wi-Fi as a *non-acquisition* transport (firmware update, bulk export, configuration); keep it off during acquisition.
* **Antenna**: the XIAO has **no chip antenna**; the supplied U.FL antenna is mandatory for BLE range. U.FL on the module top at board (45.04, 45.54); cable leaves east, J1's plug opens east ~7 mm away (RB-04C). Place the antenna element away from the electrodes, hi-Z traces and battery, on the outer side of the enclosure wall; the module's U.FL is delicate (side-insertion only). Reduce BLE TX power at bring-up (0–8 dBm) to limit radio pick-up; verify range with the real enclosure.

## 7. Verified electrical/interlock interface summary

Hardware interlock truth table (15 cases), SPI/DRDY pin glitches, strapping pin policy, UART0 default behaviour, 3V3 budget (≈ 11 mA from the module rail, ≈ 700 mA available) and the USB-inhibit path were re-checked against the datasheets above and the frozen netlist; no contradiction was found.

## 8. Implemented vs missing

| Layer | Exists | Missing |
|---|---|---|
| Hardware (R1b PCB, BOM/CPL, release package) | complete, frozen | — |
| Firmware | **nothing** in the repo (no source, build files or ESP-IDF/Arduino project) | everything: HAL and safe pin states, AFE-enable state machine, ADS131M04 driver (+CRC, status, reset), DRDY ISR + DMA queue, DSP chain, features/classifier + calibration, GATT service, pairing, battery/low-voltage handling, logging, DFU, simulation mode, unit tests |
| App backend (Rust/Tauri) | capture store accepts `source: "emg"`; recall maps `emg` → "gesture" | BLE client layer, protocol decoder, device manager, session recorder, gesture→capture mapping, permissions, foreground service, Windows/Linux transport |
| App UI | "Wristband" source icon/label | device scan/pair/status screens, live signal view, calibration flow, settings (gain, ODR, mode) |
| Contracts | `CAPTURE_SOURCE_KINDS` includes `emg` | device/packet/GATT contract (shared TS/Rust), versioning |
| Tests | app unit tests unrelated to devices | protocol vectors, emulator, soak tests |

## 9. End-to-end test plan with simulated EMG (before the board arrives)

| Level | Setup | What it proves |
|---|---|---|
| L0 — host only | Generator (Python/Rust): band-limited 20–450 Hz noise with gesture bursts, 50/60 Hz mains + harmonics, electrode pops, motion artefacts, channel crosstalk, DC offset; outputs (a) float traces, (b) **bit-exact ADS131M04 frames** (status + 4 × 24-bit + CRC16-CCITT seed FFFFh) | algorithm development, golden vectors, CRC test vectors |
| L1 — firmware logic | build flag `SIM_ADC`: the driver reads frames from a flash/PSRAM table at the true DRDY cadence | DSP/classifier on-target, CPU/RAM load, latency, watchdog |
| L2 — real SPI path | **two retail XIAOs wired as in Rev B** (D1 DRDY, D7 CS, D8 SCLK, D9 MISO, D10 MOSI, D2 SYNC): unit B runs an *ADS131M04 emulator* (ESP32-S3 SPI slave, mode 1, 18-byte frames, DRDY, reset/RESET word, deliberate CRC/skip faults), unit A runs the real driver | SPI mode, GPIO-matrix timing, DRDY ISR, CRC/loss detection at 1 and 2 kSPS, 24 h run |
| L3 — BLE | unit A streams to Android (12/13/14), Windows and Linux; sequence + sample-index checks | throughput vs MTU/PHY/interval, loss, latency, reconnect, bonding, permission flow |
| L4 — app | mock BLE backend in Rust for UI/CI; real device for integration | decode, session handling, gesture→capture, foreground service |
| L5 — classification | replay public sEMG gesture datasets (e.g. NinaPro, UCI EMG-for-gestures — check licences and channel layouts) through the same pipeline | accuracy/latency envelope, thresholds |
| L6 — board bring-up (physical) | ADC input-shorted and internal DC test signal; function generator at an electrode connector; battery-only runs | analog chain, noise floor, CMRR, mains, interlock, radio-induced lines |

Pass criteria to define up front: 0 CRC errors and 0 lost samples in 24 h at 2 kSPS in L2; < 0.1 % notification loss and < 150 ms median latency in L3; classifier accuracy target on L5.

## 10. Needs the physical board / module

Input noise, CMRR and 50/60 Hz pick-up with real electrodes; BLE/Wi-Fi radiated and conducted noise into the 20–450 Hz band and the chosen connection interval; supply droop at 300 mA bursts through the 4.7 Ω/22 µF filter; D2/D6/D7 levels at boot and the USB-inhibit timing; charger current of the plain module; antenna range in the enclosure; thermal behaviour; the BAT+ post joint.

## 11. Sources

Datasheets: TI ADS131M04 SBAS890D (§8.3.12 CRC, §8.4.1 reset, §8.5.1 SPI, §8.3.9 test signals, §10.2 sequencing); Espressif ESP32-S3 Datasheet v2.2 (Tables 2-2, 3-3, 3-5, §3.3, §3.4). Android Developers "Bluetooth permissions". tauri-plugin-blec (GitHub / docs.rs).
