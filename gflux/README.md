# GFLUX

A beginner-friendly circuit builder for ESP32 projects. Place real hobby modules on a rounded grid, connect them with jumper wires, export to KiCad, and generate the Arduino code.

## Run it

### Easiest: the GFLUX app

Download **GFLUX-Windows.exe** (or the macOS/Linux build) from the repository's **Releases → "GFLUX (latest build)"** page and double-click it.

- GFLUX opens in your browser, with the Schematic and PCB buttons connected to KiCad.
- If KiCad isn't installed, the app offers to install it: through winget on Windows or Homebrew on macOS, or by opening the official download page. You can also use the orange **Install KiCad** button in the top bar.
- Keep the small console window open while you use GFLUX. Closing it quits.
- The app isn't code-signed. On Windows, click **More info → Run anyway** the first time. On macOS, right-click it and choose **Open**.

Every push that changes `gflux/` rebuilds the app through `.github/workflows/gflux-app.yml`. To build it yourself:

```bash
pip install pyinstaller pillow
python gflux/tools/build_app.py      # -> gflux/dist/GFLUX(.exe), for the OS you run it on
```

### Without the app

Open `index.html` from inside this folder, so it stays next to its `css/` and `js/` folders. Everything except KiCad's PDF/Gerber output works offline.

To have KiCad generate the PDF, SVG and Gerber files without the app, install [KiCad](https://www.kicad.org/download/) (7 or newer) and run:

```bash
python3 tools/kicad_bridge.py      # then open http://localhost:8765
```

## Using it

| Action | How |
| --- | --- |
| Add a part | Open **Library** on the left, then click a part or drag it onto the grid |
| See a part's full name and buy link | Hover over its name tag |
| Wire | Drag from one pin to another. Click a pin, then click empty grid to add bends |
| Rotate / delete | Select, then press <kbd>R</kbd> / <kbd>Del</kbd> (or use the buttons at top right) |
| Wire colour | Pick a swatch before wiring, or select a wire and pick a swatch. **Auto** colours by role (black GND, red 3V3, orange 5V, blue SDA, yellow SCL) |
| Undo / redo | <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> |
| Save / load | **Save** downloads a `.gflux.json` file and **Load** opens one. Work is also autosaved in the browser |

### Safe wiring

While you drag a wire, the screen dims and every pin is marked:

- **Green:** a good match (power to a supply, ground to ground, signal to a GPIO, default I2C pins)
- **Blue:** works
- **Yellow:** works, but be careful (strapping pins, input-only pins, powering a module from a GPIO)
- **Red dashed:** blocked, because it would short a supply to GND, join two supplies, tie a GPIO to power, or put 5 V on a 3.3 V-only part

### Flow animation

With **Flow** on, moving dashes show which way current runs:

- **Yellow dashes:** power leaving a supply
- **White dashes:** current returning to ground
- **Blue pulses:** signals going between the ESP32 and each module

### KiCad export

- **Schematic:** downloads a `.kicad_sch` that KiCad 7 or newer can open. Pins with the same label are connected.
- **PCB:** downloads a `.kicad_pcb` with footprints placed where they are on the canvas (1 grid = 2.54 mm) and a ratsnest for every connection.
- **KiCad project:** downloads a `.zip` with the project, schematic, board and the generated `.ino` sketch.

### Code AI

The left panel can write ESP32 Arduino code for your circuit.

- **Starter code** works offline. It generates a sketch that uses the GPIO pins you actually wired.
- For free-form requests ("beep when something is closer than 10 cm"), add an [Anthropic API key](https://console.anthropic.com/settings/keys) under **AI settings**. The key stays in your browser, and requests go straight to Anthropic.

## Files

| File | What it does |
| --- | --- |
| `js/parts.js` | Parts library: about 50 Amazon-available modules with real pinouts, beginner names and code snippets |
| `js/netlist.js` | Circuit model: pin positions, nets, reference designators |
| `js/rules.js` | Wiring safety checks and current-flow directions |
| `js/art.js` | Artwork for each module |
| `js/app.js` | Editor: canvas, wire routing, library, top bar |
| `js/kicad.js` | KiCad schematic, PCB, project and ZIP writers |
| `js/codegen.js`, `js/assistant.js` | Starter-code generator and AI assistant |
| `tools/kicad_bridge.py` | Local server that drives `kicad-cli` and can install KiCad |
| `tools/gflux_app.py`, `tools/build_app.py` | The desktop launcher and its PyInstaller build script |
