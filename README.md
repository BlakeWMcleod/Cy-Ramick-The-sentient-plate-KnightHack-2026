# Cy-Ramick-The-sentient-plate-KnightHack-2026
A extension to the underside of your plate that tunrs it into a scared, god-fearing plate

## Firmware (`firmware/sentient_plate/sentient_plate.ino`)

The plate talks continuously. Each clip is chosen from the SD-card folder that matches the plate's current orientation, and changes in orientation fade the current clip out before fading the next one in.

### Hardware

| Part | ESP32 pin |
| --- | --- |
| MPU6050 SDA / SCL | GPIO 21 / GPIO 22 |
| DFPlayer Mini TX → ESP32 RX2 | GPIO 16 |
| DFPlayer Mini RX ← ESP32 TX2 (via 1 kΩ resistor) | GPIO 17 |
| DFPlayer Mini BUSY | GPIO 4 |
| IR cliff sensor (e.g. TCRT5000) digital out | GPIO 27 |

Mount the cliff sensor facing down near the rim of the plate so that it loses sight of the table when the plate overhangs an edge. Power the plate on while it lies flat; the boot orientation is used as the "flat" reference.

### SD card layout

| Folder | Situation |
| --- | --- |
| `01` | On the edge of a table |
| `02` | Flat (held level or resting) |
| `03` – `10` | Tilted 15–35°, 35–55°, 55–75°, 75–95°, 95–115°, 115–140°, 140–165°, 165–180° |

Name the files `001.mp3`, `002.mp3`, … inside each folder. Install the **DFRobotDFPlayerMini** library from the Arduino Library Manager before compiling.
