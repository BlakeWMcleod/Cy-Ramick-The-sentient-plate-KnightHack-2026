<p align="center"><img src="gflux/img/banner.png" alt="GFLUX" width="520"></p>

# GFLUX

GFLUX is a beginner-friendly circuit builder for ESP32 projects. Drop real hobby modules onto a grid, connect them with jumper wires, and GFLUX checks the wiring as you go. It shows current moving through each wire and turns your circuit into KiCad files and ready-to-upload Arduino code.

## Get started

1. Download **GFLUX-Windows.exe** from **[Releases → GFLUX (latest build)](https://github.com/BlakeWMcleod/Cy-Ramick-The-sentient-plate-KnightHack-2026/releases/tag/gflux-latest)**. macOS and Linux builds are on the same page.
2. Double-click it. GFLUX opens in your browser.
3. The app looks for KiCad on your computer. If KiCad isn't there, it offers to **install** it, or to **locate** an install it couldn't find.

Keep the small console window open while you work. Closing it quits GFLUX.

> The app isn't code-signed. On Windows, click **More info → Run anyway** the first time. On macOS, right-click it and choose **Open**.

Opening `gflux/index.html` directly also works, but without KiCad PDFs or Gerbers. The page asks you to use the app instead.

## Using GFLUX

| To… | Do this |
| --- | --- |
| Add a part | Open **Library** on the right, then click a part or drag it onto the grid |
| See a part's full name and where to buy it | Hover over its name tag |
| Wire a part automatically | Click the **⚡** next to its name. Power, ground and the right ESP32 pins are wired for you |
| Wire by hand | Drag from one pin to another. Let go on empty grid to leave the end loose, or click a pin and then click the grid to add bends |
| Rotate / delete | Select, then press <kbd>R</kbd> / <kbd>Del</kbd>, or use the tools on the left |
| Undo / redo | <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> |
| Copy / paste | <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> (<kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates) |
| Save / open | **File** menu. Work also autosaves in your browser |

### Safe wiring

While you drag a wire, the screen dims and every pin is marked:

| Mark | Meaning |
| --- | --- |
| **Green** | Good match: power to a supply, ground to ground, signal to a GPIO, or the default I2C pins |
| **Blue** | Works |
| **Yellow** | Works, but be careful: strapping pins, input-only pins, or powering a module from a GPIO |
| **Red dashed** | Blocked, because it would short a supply to GND, join two supplies, tie a GPIO to power, or put 5 V on a 3.3 V-only part |

Wiring an LED straight to a GPIO or a supply automatically adds a 220 Ω resistor. You can turn that off in the **Wire color** menu.

### Wire colours

With **Auto** selected, each wire takes the colour printed on the ESP32 pin it connects to:

- **Signal pins:** cycle through red, orange, yellow, green, blue, indigo and violet down the header
- **Power:** red
- **Ground:** black

The **Wire color** menu also has the nine jumper colours, a custom colour picker, and **Auto-color all wires**.

### Animation

Moving dashes show the way current flows, treating the ESP32 as the power source:

- **Yellow:** power leaving a supply
- **White:** current returning to ground
- **Blue:** signals between the ESP32 and each module

In the **Animation** menu you can change the speed, spacing, size and style (dashes, dots or pulses), and choose which kinds of wire are animated.

### KiCad

The **KiCad** menu offers:

- **Create schematic:** a `.kicad_sch` file, plus a PDF when KiCad is connected
- **Create PCB:** a `.kicad_pcb` file with every module placed where it is on the canvas (1 grid square = 2.54 mm), plus Gerbers, drill files and a PDF when KiCad is connected
- **Download KiCad project:** a `.zip` with the project, schematic, board and generated `.ino` sketch
- **Check again / Locate / Install:** ask the app to find KiCad, point it at your install, or install KiCad for you

### Code

The **Code** panel on the right writes and checks ESP32 Arduino code:

- **Examples:** four ready-made projects (Blink + button, Distance alarm, Weather screen, Servo knob). Each one loads its wired circuit and its sketch.
- **Starter code:** works offline and uses the pins you actually wired.
- **Check / Check my code:** catches big mistakes in a few words, such as "Missing ; · line 12", "GPIO34 is input-only", "GPIO13 not wired" or "Missing library ESP32Servo".
  - Through the GFLUX app it compiles with the real Arduino compiler (`arduino-cli`, found in your Arduino IDE, or downloaded on request together with ESP32 support).
  - In a plain browser it runs the quick checks only.
- **AI:** for free-form requests ("beep when something is closer than 10 cm"), add an [Anthropic API key](https://console.anthropic.com/settings/keys) under **AI settings**. The key stays in your browser.

### Power and voltage checks

The **Buck converter** (steps voltage down) and **Boost converter** (steps it up) have an adjustable output: select one and type the volts. GFLUX works out the voltage on every power line and flags problems live, such as "6V too high [RFID card reader]", "Buck needs 6.5V+ in" or "5V signal on D18". The part with the problem gets a red outline.

### Finalize

**Finalize** lists every remaining problem in a few words. Choose **Back out** or **Finalize**. Finalizing saves the project to `Documents/GFLUX/<name>`, opens the schematic and PCB in KiCad, and shows a shopping list with Amazon links.

## Parts library

About 50 modules you can buy on Amazon, each with a plain name (for example "Distance sensor" instead of "HC-SR04 Ultrasonic Distance Sensor Module") and its real pinout:

- **Boards:** ESP32 DevKit V1, ESP32-C3 SuperMini
- **Basics:** resistor, push button, slide switch, knob
- **Lights:** LED, RGB LED, LED ring and strip, LED grid
- **Sensors:** distance (ultrasonic and laser), temperature and humidity, weather, motion, light, sound, soil, gas, tilt, line, magnet, heart rate, weight, GPS
- **Input:** touch, joystick, clicky knob, keypad, IR remote, RFID
- **Screens:** OLED, 16×2 LCD, 4-digit display
- **Motors:** servo, DC motor and driver, stepper, relay, vibration
- **Sound & storage:** buzzer, speaker and amp, MP3 player, SD card, clock module
- **Power:** battery pack, charger, regulator, breadboard supply

You can also add your own parts from the bottom of the library.

## For developers

GFLUX is plain HTML, CSS and JavaScript with no build step. The desktop app is a small Python program.

```bash
python3 gflux/tools/gflux_app.py         # run the app from source
pip install pyinstaller pillow
python gflux/tools/build_app.py          # build the app (GFLUX.exe on Windows)
python3 -m unittest discover gflux/tools/tests -v
```

Every push that changes `gflux/` rebuilds the Windows, macOS and Linux apps (`.github/workflows/gflux-app.yml`) and updates the release.

| Path | What it does |
| --- | --- |
| `gflux/index.html`, `gflux/css/` | Page layout and styles |
| `gflux/js/parts.js` | Parts library: pinouts, plain names, Amazon searches, code snippets |
| `gflux/js/netlist.js`, `gflux/js/rules.js` | Circuit model, wiring safety rules and current-flow directions |
| `gflux/js/autowire.js` | One-click auto-wiring |
| `gflux/js/app.js`, `gflux/js/art.js` | Editor, wire router and part artwork |
| `gflux/js/kicad.js` | KiCad schematic, PCB and project writers |
| `gflux/js/codegen.js`, `gflux/js/assistant.js` | Starter code and the Code panel |
| `gflux/js/check.js`, `gflux/js/codecheck.js` | Circuit and voltage checks, code checks, examples |
| `gflux/tools/` | Desktop app, KiCad and Arduino bridges, build script and tests |

The ESP32 firmware for the sentient plate lives in [`firmware/`](firmware/README.md).
