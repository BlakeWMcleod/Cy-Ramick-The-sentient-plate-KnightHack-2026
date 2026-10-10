# Cy-Ramick-The-sentient-plate-KnightHack-2026
A extension to the underside of your plate that tunrs it into a scared, god-fearing plate

## Firmware (`firmware/sentient_plate/sentient_plate.ino`)

The plate talks continuously. Each clip is chosen from the SD-card folder that matches the plate's current orientation, and changes in orientation fade the current clip out before fading the next one in.

### Hardware

| Part | ESP32 pin |
| --- | --- |
| DFPlayer Mini RX (pin 2) | GPIO 17 (TX2) |
| DFPlayer Mini TX (pin 3) | GPIO 16 (RX2) |
| DFPlayer Mini BUSY (pin 16) | GPIO 4 |
| GY-521 (MPU-6050) SDA / SCL | GPIO 21 / GPIO 22 |
| TCRT5000 sensors 1–5, DO | GPIO 32, 33, 25, 26, 27 |

The five TCRT5000 sensors face down at the table from the rim of the enclosure. When all of them see the table, the plate is resting. When none of them do, it has been lifted. When only some do, it is hanging over the edge of the table.

Switch the plate on while it rests flat on the table. At boot, the firmware records that orientation as "flat" and reads each IR sensor's output level as its "sees the table" level, so the sensor polarity does not need to be known in advance.

### SD card layout

| Folder | Situation |
| --- | --- |
| `01` | On the edge of a table |
| `02` | Flat (resting on the table, or lifted and held level) |
| `03` – `10` | Tilted 15–35°, 35–55°, 55–75°, 75–95°, 95–115°, 115–140°, 140–165°, 165–180° |

Use a FAT32 card of 32 GB or smaller. Name the files `001.mp3`, `002.mp3`, … inside each numbered folder (not the `/mp3` folder), and copy them in order. Install the **DFRobotDFPlayerMini** library from the Arduino Library Manager before compiling.
