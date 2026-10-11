<p align="center"><img src="gflux/img/banner.png" alt="GFLUX" width="520"></p>

!# GFLUX
GFLUX is a beginner-friendly circuit builder for Basic board projects. Drop real popular modules into a grid, connect them with wires (or make us do it)
GFLUX checks the wiring as you go. It shows current moving through each wire and turns your circuit into KiCad files.

Big thanks to Kicad, this project was designed to be a more begginer friendly version as part of a UCF Hackathon!

## Get started - Hello Judges!

1. Download **GFLUX-Windows.exe** from **[Releases → GFLUX (latest build)](https://github.com/BlakeWMcleod/Cy-Ramick-The-sentient-plate-KnightHack-2026/releases/tag/gflux-latest)**. macOS and Linux builds are on the same page.
2. Double-click it. GFLUX opens in your browser.
3.It should Find or Install Kicad if you don't own it

Keep the small window open while you work.

Opening `gflux/index.html` Does **NOT** Work as intended, sorry hackers

## Using GFLUX

| To… | Do this |
| --- | --- |
| Add a part | Open **Library** on the right, then click a part or drag it onto the grid |
| See a part's full name and where to buy it | Hover over its name tag |
| Wire a part automatically | Click the **Power** next to its name. Power, ground and the right ESP32 pins are wired for you |
| Wire by hand | Drag from one pin to another. Let go on empty grid to leave the end loose, or click a pin and then click the grid to add bends |
| Rotate / delete | Select, then press <kbd>R</kbd> / <kbd>Del</kbd>, or use the tools on the left |
| Undo / redo | <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> |
| Save / open | **File** menu. Work also autosaves in your browser |
| Finilise | Checks your work to find any Errors |

### Safe wiring

Wiring an LED straight to a GPIO or a supply automatically adds a 220 Ω resistor. You can turn that off in the **Wire color** menu.
This program should detect short circuits, but may not supply step up converters

- **Signal pins:** crimson red, orange, yellow, green, blue, indigo and violet 
- **Power:** red
- **Ground:** black

### KiCad

The **KiCad** menu offers:

- **Create schematic:** a `.kicad_sch` file, plus a PDF when KiCad is connected
- **Create PCB:** a `.kicad_pcb` file with every module placed where it is on the canvas (1 grid square = 2.54 mm), plus Gerbers, drill files and a PDF when KiCad is connected
- **Download KiCad project:** a `.zip` with the project, schematic, board and generated `.ino` sketch
- **Check again / Locate / Install:** ask the app to find KiCad, point it at your install, or install KiCad for you

**PLEASE NOTE THIS USES CODE FROM KICAD; I DIDNT DO THIS PLEASE GIVE THANKS TO THE KICAD DEV TEAM**

## Parts library
 50 modules you can buy on Amazon, each with a plain name and its real pinout:

- **Boards:** ESP32 DevKit V1, ESP32-C3 SuperMini
- **Basics:** resistor, push button, slide switch, knob
- **Lights:** LED, RGB LED, LED ring and strip, LED grid
- **Sensors:** distance (ultrasonic and laser), temperature and humidity, weather, motion, light, sound, soil, gas, tilt, line, magnet, heart rate, weight, GPS
- **Input:** touch, joystick, clicky knob, keypad, IR remote, RFID
- **Screens:** OLED, 16×2 LCD, 4-digit display
- **Motors:** servo, DC motor and driver, stepper, relay, vibration
- **Sound & storage:** buzzer, speaker and amp, MP3 player, SD card, clock module
- **Power:** battery pack, charger, regulator, breadboard supply
-**More**
You can also add your own parts from the bottom of the library, please note if creating a G pin it connect to ground and not to green.

## For developers

GFLUX is plain HTML, CSS and JavaScript with no build step. The desktop app is a small Python program.

```bash
python3 gflux/tools/gflux_app.py         # run the app from source
pip install pyinstaller pillow
python gflux/tools/build_app.py          # build the app (GFLUX.exe on Windows)
python3 -m unittest discover gflux/tools/tests -v
```
|
| `gflux/tools/` | Desktop app, KiCad bridge, build script and tests |
(firmware/README.md).
