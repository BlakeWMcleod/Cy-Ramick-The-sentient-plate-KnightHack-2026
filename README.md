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
| Button 1 (wait for lift), other leg to GND | GPIO 18 |
| Button 2 (mute), other leg to GND | GPIO 19 |

The five TCRT5000 sensors face down at the table from the rim of the enclosure. When all of them see the table, the plate is resting. When none of them do, it has been lifted. When only some do, it is hanging over the edge of the table.

Switch the plate on while it rests flat on the table. At boot, the firmware records that orientation as "flat" and reads each IR sensor's output level as its "sees the table" level, so the sensor polarity does not need to be known in advance.

### Buttons

- **Button 1 – wait for lift:** fades the plate to silence. It stays quiet until it has been set on the table and then lifted off it, at which point it starts talking again. Press again to cancel.
- **Button 2 – mute:** toggles mute. Unmuting fades a new clip in.

### SD card layout

| Folder | Situation |
| --- | --- |
| `01` | On the edge of a table |
| `02` | Flat (resting on the table, or lifted and held level) |
| `03` – `10` | Tilted 15–35°, 35–55°, 55–75°, 75–95°, 95–115°, 115–140°, 140–165°, 165–180° |

Use a FAT32 card of 32 GB or smaller. Name the files `001.mp3`, `002.mp3`, … inside each numbered folder (not the `/mp3` folder), and copy them in order. Install the **DFRobotDFPlayerMini** library from the Arduino Library Manager before compiling.

## Enclosure (`enclosure/`)

`make_enclosure.py` generates the round 3D-printed tray and lid (156 mm across, 24.3 mm tall) that sit under the plate, along with stand-in blocks for every component. All dimensions are parameters at the top of the script.

| File | Contents |
| --- | --- |
| `tray.stl`, `lid.stl` | Print files in mm. Print the tray floor-down; the lid is already flipped tabs-up. No supports. |
| `plate_enclosure.blend` | Assembled model with component stand-ins (not printed). |
| `preview_inside.png`, `preview_outside.png` | Renders with the lid off and on. |

Rebuild after changing a parameter (run in the `enclosure` folder):

```
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python make_enclosure.py
```

The script checks that no component hits a wall, the lid, or another component, and that both print parts are watertight. It prints `CHECK: OK` when everything passes.

Before printing:

- Measure the inside diameter of the plate's foot ring and set `PLATE_FOOT_RING_ID`. If it is under about 158 mm, reduce `R`.
- Hold a TCRT5000 module against its floor window. If the window is off-centre, adjust `IR_SENSOR_U` and rebuild.
