"""
Generates the Cy-Ramick plate KiCad project from one connection table:

  plate.kicad_sch   schematic (symbols embedded, nets joined by labels)
  plate.kicad_sym   custom symbol library (ESP32 DevKit 30P, DFPlayer Mini, GY-521, ...)
  sym-lib-table     points KiCad at plate.kicad_sym
  plate.kicad_pro   project file

Run with any Python 3:  python make_schematic.py
Save in KiCad 10 format: kicad-cli sch upgrade --force plate.kicad_sch
                         kicad-cli sym upgrade --force plate.kicad_sym
Check it:                kicad-cli sch erc plate.kicad_sch
Printable copy:          kicad-cli sch export pdf -o plate.pdf plate.kicad_sch

Every pin is either listed in NETS below or marked no-connect, so the
schematic always matches the firmware's pin map.
"""

import os
import uuid as _uuid

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = "plate"
FONT = "(effects (font (size 1.27 1.27)))"
HIDDEN = "(effects (font (size 1.27 1.27)) (hide yes))"


def uid():
    return str(_uuid.uuid4())


# ============================================================== Symbols
# Pins: (number, name, electrical type). None leaves a gap.

class Sym:
    def __init__(self, name, ref, value, left, right, width=15.24, desc="", graphics=None, pins=None,
                 power=False, ref_hidden=False, value_offset=None):
        self.name, self.ref, self.value, self.desc = name, ref, value, desc
        self.power = power
        self.ref_hidden = ref_hidden
        self.hide_pin_names = pins is not None   # Two-pin parts: names add nothing
        self.pins = {}       # number -> (x, y, angle, name, type, length)
        self.graphics = graphics or []
        if pins is not None:
            for num, pname, ptype, x, y, ang, length in pins:
                self.pins[num] = (x, y, ang, pname, ptype, length)
            self.height = 5.08
            self.value_y = value_offset if value_offset is not None else -3.81
            self.ref_y = 3.81
            return
        rows = max(len(left), len(right))
        top = (rows - 1) * 2.54 / 2
        top = round(top / 1.27) * 1.27
        half_w = width / 2
        for i, p in enumerate(left):
            if p:
                self.pins[p[0]] = (-half_w - 2.54, top - i * 2.54, 0, p[1], p[2], 2.54)
        for i, p in enumerate(right):
            if p:
                self.pins[p[0]] = (half_w + 2.54, top - i * 2.54, 180, p[1], p[2], 2.54)
        body_top = top + 2.54
        body_bot = top - (rows - 1) * 2.54 - 2.54
        self.graphics.append(f"(rectangle (start {-half_w} {body_top}) (end {half_w} {body_bot}) "
                             "(stroke (width 0.254) (type default)) (fill (type background)))")
        self.ref_y = body_top + 1.27
        self.value_y = body_bot - 1.27

    def lib_text(self, full_name):
        short = full_name.split(":")[-1]
        flags = "(power) " if self.power else ""
        names = "(pin_names (offset 1.016) hide)" if self.hide_pin_names else "(pin_names (offset 1.016))"
        out = [f'(symbol "{full_name}" {flags}{names} (exclude_from_sim no) '
               f'(in_bom {"no" if self.power else "yes"}) (on_board {"no" if self.power else "yes"})']
        ref_eff = HIDDEN if self.ref_hidden else FONT
        out.append(f'(property "Reference" "{self.ref}" (at 0 {self.ref_y} 0) {ref_eff})')
        out.append(f'(property "Value" "{self.value}" (at 0 {self.value_y} 0) {FONT})')
        out.append(f'(property "Footprint" "" (at 0 0 0) {HIDDEN})')
        out.append(f'(property "Datasheet" "" (at 0 0 0) {HIDDEN})')
        out.append(f'(property "Description" "{self.desc}" (at 0 0 0) {HIDDEN})')
        out.append(f'(symbol "{short}_0_1" ' + " ".join(self.graphics) + ")")
        pins = []
        for num, (x, y, ang, pname, ptype, length) in self.pins.items():
            hide = " hide" if self.power else ""
            pins.append(f'(pin {ptype} line (at {x} {y} {ang}) (length {length}){hide} '
                        f'(name "{pname}" {FONT}) (number "{num}" {FONT}))')
        out.append(f'(symbol "{short}_1_1" ' + " ".join(pins) + ")")
        out.append(")")
        return "\n".join(out)


def box_pins(defs):
    return [None if d is None else d for d in defs]


ESP32 = Sym(
    "ESP32_DevKit_30P", "U", "ESP32 DevKit 30P (ESP-WROOM-32, CP2102)",
    left=[("1", "EN", "input"), ("2", "GPIO36/VP", "input"), ("3", "GPIO39/VN", "input"),
          ("4", "GPIO34", "input"), ("5", "GPIO35", "input"), ("6", "GPIO32", "bidirectional"),
          ("7", "GPIO33", "bidirectional"), ("8", "GPIO25", "bidirectional"), ("9", "GPIO26", "bidirectional"),
          ("10", "GPIO27", "bidirectional"), ("11", "GPIO14", "bidirectional"), ("12", "GPIO12", "bidirectional"),
          ("13", "GPIO13", "bidirectional"), ("14", "GND", "power_in"), ("15", "VIN", "power_in")],
    right=[("16", "GPIO23", "bidirectional"), ("17", "GPIO22", "bidirectional"), ("18", "TX0/GPIO1", "output"),
           ("19", "RX0/GPIO3", "input"), ("20", "GPIO21", "bidirectional"), ("21", "GPIO19", "bidirectional"),
           ("22", "GPIO18", "bidirectional"), ("23", "GPIO5", "bidirectional"), ("24", "TX2/GPIO17", "output"),
           ("25", "RX2/GPIO16", "input"), ("26", "GPIO4", "bidirectional"), ("27", "GPIO2", "bidirectional"),
           ("28", "GPIO15", "bidirectional"), ("29", "GND", "passive"), ("30", "3V3", "power_out")],
    width=33.02, desc="AITRIP ESP32 DevKit, 30-pin, USB-C")

DFPLAYER = Sym(
    "DFPlayer_Mini", "U", "DFPlayer Mini",
    left=[("1", "VCC", "power_in"), ("2", "RX", "input"), ("3", "TX", "output"), ("4", "DAC_R", "output"),
          ("5", "DAC_L", "output"), ("6", "SPK_1", "passive"), ("7", "GND", "power_in"), ("8", "SPK_2", "passive")],
    right=[("16", "BUSY", "output"), ("15", "USB-", "passive"), ("14", "USB+", "passive"),
           ("13", "ADKEY_2", "input"), ("12", "ADKEY_1", "input"), ("11", "IO_2", "input"),
           ("10", "GND", "passive"), ("9", "IO_1", "input")],
    width=25.4, desc="DFPlayer Mini MP3 module (HiLetgo)")

GY521 = Sym(
    "GY-521", "U", "GY-521 (MPU-6050)",
    left=[("1", "VCC", "power_in"), ("2", "GND", "power_in"), ("3", "SCL", "input"), ("4", "SDA", "bidirectional")],
    right=[("5", "XDA", "bidirectional"), ("6", "XCL", "output"), ("7", "AD0", "input"), ("8", "INT", "output")],
    width=15.24, desc="MPU-6050 accelerometer/gyro breakout")

TCRT = Sym(
    "TCRT5000_Module", "U", "TCRT5000 module",
    left=[("1", "VCC", "power_in"), ("2", "GND", "power_in")],
    right=[("3", "DO", "output"), ("4", "AO", "output")],
    width=15.24, desc="TCRT5000 reflective IR sensor module, 4-pin")

DIODE = Sym(
    "D", "D", "1N4001", [], [], pins=[("1", "K", "passive", 3.81, 0, 180, 2.54), ("2", "A", "passive", -3.81, 0, 0, 2.54)],
    graphics=["(polyline (pts (xy 1.27 1.27) (xy 1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))",
              "(polyline (pts (xy -1.27 1.27) (xy 1.27 0) (xy -1.27 -1.27) (xy -1.27 1.27)) "
              "(stroke (width 0.254) (type default)) (fill (type none)))"],
    desc="Rectifier diode")

BATTERY = Sym(
    "Battery_4xAA", "BT", "4xAA (6.0-6.4 V alkaline)", [], [],
    pins=[("1", "+", "passive", -5.08, 0, 0, 2.54), ("2", "-", "passive", 5.08, 0, 180, 2.54)],
    graphics=["(polyline (pts (xy -2.54 2.54) (xy -2.54 -2.54)) (stroke (width 0.254) (type default)) (fill (type none)))",
              "(polyline (pts (xy -1.27 1.27) (xy -1.27 -1.27)) (stroke (width 0.508) (type default)) (fill (type none)))",
              "(polyline (pts (xy 1.27 2.54) (xy 1.27 -2.54)) (stroke (width 0.254) (type default)) (fill (type none)))",
              "(polyline (pts (xy 2.54 1.27) (xy 2.54 -1.27)) (stroke (width 0.508) (type default)) (fill (type none)))"],
    desc="DAIERTEK 4xAA holder (cells)")

SWITCH = Sym(
    "SW_SPST", "SW", "SPST", [], [],
    pins=[("1", "1", "passive", -5.08, 0, 0, 2.54), ("2", "2", "passive", 5.08, 0, 180, 2.54)],
    graphics=["(circle (center -2.032 0) (radius 0.508) (stroke (width 0) (type default)) (fill (type none)))",
              "(circle (center 2.032 0) (radius 0.508) (stroke (width 0) (type default)) (fill (type none)))",
              "(polyline (pts (xy -1.524 0.254) (xy 1.524 1.778)) (stroke (width 0) (type default)) (fill (type none)))"],
    desc="Switch")

BUTTON = Sym(
    "SW_Push", "SW", "6x6x9.5 mm tactile", [], [],
    pins=[("1", "1", "passive", -5.08, 0, 0, 2.54), ("2", "2", "passive", 5.08, 0, 180, 2.54)],
    graphics=["(circle (center -2.032 0) (radius 0.508) (stroke (width 0) (type default)) (fill (type none)))",
              "(circle (center 2.032 0) (radius 0.508) (stroke (width 0) (type default)) (fill (type none)))",
              "(polyline (pts (xy -2.54 1.27) (xy 2.54 1.27)) (stroke (width 0) (type default)) (fill (type none)))",
              "(polyline (pts (xy 0 1.27) (xy 0 3.048)) (stroke (width 0) (type default)) (fill (type none)))"],
    desc="Momentary push button")

SPEAKER = Sym(
    "Speaker", "LS", "8 ohm 3 W", [], [],
    pins=[("1", "+", "passive", -5.08, 0, 0, 2.54), ("2", "-", "passive", 5.08, 0, 180, 2.54)],
    graphics=["(rectangle (start -1.27 -1.016) (end 1.27 1.016) (stroke (width 0.254) (type default)) (fill (type none)))",
              "(polyline (pts (xy -1.27 1.016) (xy -2.54 2.54) (xy 2.54 2.54) (xy 1.27 1.016)) "
              "(stroke (width 0.254) (type default)) (fill (type none)))"],
    desc="ALAMSCN 8 ohm 3 W speaker (JST plug removed)")

CAP = Sym(
    "C_Polarized", "C", "470uF 10V", [], [],
    pins=[("1", "+", "passive", -3.81, 0, 0, 2.794), ("2", "-", "passive", 3.81, 0, 180, 2.794)],
    graphics=["(polyline (pts (xy -1.016 1.778) (xy -1.016 -1.778)) (stroke (width 0.254) (type default)) (fill (type none)))",
              "(polyline (pts (xy 1.016 1.778) (xy 1.016 -1.778)) (stroke (width 0.508) (type default)) (fill (type none)))",
              "(polyline (pts (xy -2.286 1.524) (xy -2.286 0.508)) (stroke (width 0) (type default)) (fill (type none)))",
              "(polyline (pts (xy -2.794 1.016) (xy -1.778 1.016)) (stroke (width 0) (type default)) (fill (type none)))"],
    desc="Optional bulk capacitor")

GND_SYM = Sym(
    "GND", "#PWR", "GND", [], [], power=True, ref_hidden=True, value_offset=-3.81,
    pins=[("1", "GND", "power_in", 0, 0, 270, 0)],
    graphics=["(polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27)) "
              "(stroke (width 0) (type default)) (fill (type none)))"],
    desc="Ground")

P3V3_SYM = Sym(
    "+3V3", "#PWR", "+3V3", [], [], power=True, ref_hidden=True, value_offset=3.556,
    pins=[("1", "+3V3", "power_in", 0, 0, 90, 0)],
    graphics=["(polyline (pts (xy -0.762 1.27) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none)))",
              "(polyline (pts (xy 0 0) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none)))",
              "(polyline (pts (xy 0 2.54) (xy 0.762 1.27)) (stroke (width 0) (type default)) (fill (type none)))"],
    desc="3.3 V from the ESP32 regulator")

PWR_FLAG = Sym(
    "PWR_FLAG", "#FLG", "PWR_FLAG", [], [], power=True, ref_hidden=True, value_offset=3.81,
    pins=[("1", "pwr", "power_out", 0, 0, 90, 0)],
    graphics=["(polyline (pts (xy 0 0) (xy 0 1.27) (xy -1.016 1.905) (xy 0 2.54) (xy 1.016 1.905) (xy 0 1.27)) "
              "(stroke (width 0) (type default)) (fill (type none)))"],
    desc="Marks a net as driven by a power source")

SYMBOLS = [ESP32, DFPLAYER, GY521, TCRT, DIODE, BATTERY, SWITCH, BUTTON, SPEAKER, CAP, GND_SYM, P3V3_SYM, PWR_FLAG]

# ============================================================== Parts and nets

# ref: (symbol, x, y, value override, dnp)
PARTS = {
    "U1": (ESP32, 152.4, 127.0, None, False),
    "U2": (DFPLAYER, 254.0, 101.6, None, False),
    "U3": (GY521, 254.0, 160.02, None, False),
    "U4": (TCRT, 66.04, 63.5, "TCRT5000 module (IR 1)", False),
    "U5": (TCRT, 66.04, 88.9, "TCRT5000 module (IR 2)", False),
    "U6": (TCRT, 66.04, 114.3, "TCRT5000 module (IR 3)", False),
    "U7": (TCRT, 66.04, 139.7, "TCRT5000 module (IR 4)", False),
    "U8": (TCRT, 66.04, 165.1, "TCRT5000 module (IR 5)", False),
    "BT1": (BATTERY, 45.72, 228.6, None, False),
    "SW1": (SWITCH, 86.36, 228.6, "Holder switch", False),
    "D1": (DIODE, 127.0, 228.6, None, False),
    "D2": (DIODE, 167.64, 228.6, None, False),
    "C1": (CAP, 208.28, 228.6, None, True),
    "LS1": (SPEAKER, 330.2, 96.52, None, False),
    "SW2": (BUTTON, 254.0, 205.74, "Button 1 (wait for lift)", False),
    "SW3": (BUTTON, 254.0, 223.52, "Button 2 (mute)", False),
}

# net: [(ref, pin)]. GND and +3V3 get power symbols; other nets get labels.
NETS = {
    "GND": [("U1", "14"), ("U1", "29"), ("U2", "7"), ("U2", "10"), ("U3", "2"),
            ("U4", "2"), ("U5", "2"), ("U6", "2"), ("U7", "2"), ("U8", "2"),
            ("BT1", "2"), ("SW2", "2"), ("SW3", "2"), ("C1", "2")],
    "+3V3": [("U1", "30"), ("U3", "1"), ("U4", "1"), ("U5", "1"), ("U6", "1"), ("U7", "1"), ("U8", "1")],
    "VBAT": [("BT1", "1"), ("SW1", "1")],
    "VBAT_SW": [("SW1", "2"), ("D1", "2")],
    "VIN": [("D1", "1"), ("U1", "15"), ("D2", "2")],
    "DF_VCC": [("D2", "1"), ("U2", "1"), ("C1", "1")],
    "DF_RX": [("U1", "24"), ("U2", "2")],
    "DF_TX": [("U1", "25"), ("U2", "3")],
    "DF_BUSY": [("U1", "26"), ("U2", "16")],
    "SDA": [("U1", "20"), ("U3", "4")],
    "SCL": [("U1", "17"), ("U3", "3")],
    "IR1": [("U1", "6"), ("U4", "3")],
    "IR2": [("U1", "7"), ("U5", "3")],
    "IR3": [("U1", "8"), ("U6", "3")],
    "IR4": [("U1", "9"), ("U7", "3")],
    "IR5": [("U1", "10"), ("U8", "3")],
    "BTN1": [("U1", "22"), ("SW2", "1")],
    "BTN2": [("U1", "21"), ("SW3", "1")],
    "SPK+": [("U2", "6"), ("LS1", "1")],
    "SPK-": [("U2", "8"), ("LS1", "2")],
}

# Nets fed only by passive parts need a PWR_FLAG so ERC knows they are powered.
FLAGGED = ["GND", "VIN", "DF_VCC"]

NOTES = """Cy-Ramick plate - hand-wired, no PCB.

Power: 4xAA alkaline (6.0-6.4 V fresh) -> holder switch -> D1 -> ESP32 VIN (~5.3 V)
       VIN -> D2 -> DFPlayer VCC (~4.5 V; DFPlayer is rated 3.2-5.0 V).
       D1 also blocks USB 5 V from back-feeding the cells while programming.
       The ESP32's onboard AMS1117 makes 3V3 for the GY-521 and all five TCRT5000 modules
       (ESP32 GPIOs are not 5 V tolerant).
DFPlayer RX needs no series resistor: the ESP32 is 3.3 V logic.
C1 is optional (DNP): fit it across DFPlayer VCC/GND if the player resets or pops at high volume.
Buttons: any spare even GPIO (0, 12, 14, 18) acts as button 1 and any spare odd GPIO
         (5, 13, 15, 19, 23) as button 2. SW2/SW3 show the main wiring on GPIO18/GPIO19.
Avoid the strapping pins 0, 2, 5, 12, 15 for anything that pulls them at power-up."""

# ============================================================== Writer

ROOT = uid()


def pin_world(ref, num):
    sym, x, y, _, _ = PARTS[ref]
    px, py, ang, *_ = sym.pins[num]
    return round(x + px, 2), round(y - py, 2), ang


def outward(ang):
    """Direction (dx, dy) in schematic coordinates pointing away from the symbol body."""
    return {0: (-1, 0), 180: (1, 0), 90: (0, 1), 270: (0, -1)}[ang]


def build():
    items = []
    used = {}  # (ref, pin) -> net
    for net, pins in NETS.items():
        for rp in pins:
            assert rp not in used, f"{rp} is on two nets"
            used[rp] = net

    pwr_n = 0

    def power_symbol(sym, x, y, rot=0, text_at=None, justify=None):
        nonlocal pwr_n
        pwr_n += 1
        ref = f"{sym.ref}{pwr_n:02d}"
        tx, ty = text_at or (x, y + (3.81 if sym is GND_SYM else -3.81))
        eff = f"(effects (font (size 1.27 1.27)) (justify {justify}))" if justify else FONT
        items.append(
            f'(symbol (lib_id "{LIB}:{sym.name}") (at {x} {y} {rot}) (unit 1) (exclude_from_sim no) '
            f'(in_bom no) (on_board no) (dnp no) (uuid "{uid()}") '
            f'(property "Reference" "{ref}" (at {x} {y} 0) {HIDDEN}) '
            f'(property "Value" "{sym.value}" (at {round(tx, 2)} {round(ty, 2)} {rot}) {eff}) '
            f'(property "Footprint" "" (at {x} {y} 0) {HIDDEN}) '
            f'(property "Datasheet" "" (at {x} {y} 0) {HIDDEN}) '
            f'(property "Description" "" (at {x} {y} 0) {HIDDEN}) '
            f'(pin "1" (uuid "{uid()}")) '
            f'(instances (project "plate" (path "/{ROOT}" (reference "{ref}") (unit 1)))))')

    # Parts
    for ref, (sym, x, y, value, dnp) in PARTS.items():
        val = value or sym.value
        pins = " ".join(f'(pin "{n}" (uuid "{uid()}"))' for n in sym.pins)
        items.append(
            f'(symbol (lib_id "{LIB}:{sym.name}") (at {x} {y} 0) (unit 1) (exclude_from_sim no) '
            f'(in_bom yes) (on_board yes) (dnp {"yes" if dnp else "no"}) (uuid "{uid()}") '
            f'(property "Reference" "{ref}" (at {x} {round(y - sym.ref_y, 2)} 0) {FONT}) '
            f'(property "Value" "{val}" (at {x} {round(y - sym.value_y, 2)} 0) {FONT}) '
            f'(property "Footprint" "" (at {x} {y} 0) {HIDDEN}) '
            f'(property "Datasheet" "" (at {x} {y} 0) {HIDDEN}) '
            f'(property "Description" "{sym.desc}" (at {x} {y} 0) {HIDDEN}) '
            f'{pins} (instances (project "plate" (path "/{ROOT}" (reference "{ref}") (unit 1)))))')

        # Stubs, labels, power symbols and no-connects for every pin
        for num in sym.pins:
            px, py, ang = pin_world(ref, num)
            net = used.get((ref, num))
            if net is None:
                items.append(f'(no_connect (at {px} {py}) (uuid "{uid()}"))')
                continue
            dx, dy = outward(ang)
            # Power pins get a longer stub so their symbols clear neighbouring signal labels.
            stub = 10.16 if net in ("GND", "+3V3") else 5.08
            ex, ey = round(px + dx * stub, 2), round(py + dy * stub, 2)
            items.append(f'(wire (pts (xy {px} {py}) (xy {ex} {ey})) (stroke (width 0) (type default)) (uuid "{uid()}"))')
            # Power symbols point away from the pin so they never overlap neighbouring labels.
            # The value text rotates with the symbol, which also flips its justification.
            text_at = (ex + dx * 3.81, ey)
            just = "left" if dx < 0 else "right"
            if net == "GND":
                power_symbol(GND_SYM, ex, ey, 270 if dx < 0 else 90, text_at, just)
            elif net == "+3V3":
                power_symbol(P3V3_SYM, ex, ey, 90 if dx < 0 else 270, text_at, just)
            else:
                rot = {(-1, 0): 180, (1, 0): 0, (0, 1): 270, (0, -1): 90}[(dx, dy)]
                just = "right" if dx < 0 else "left"
                items.append(f'(label "{net}" (at {ex} {ey} {rot}) (fields_autoplaced yes) '
                             f'(effects (font (size 1.27 1.27)) (justify {just} bottom)) (uuid "{uid()}"))')

    # PWR_FLAGs, each tied to its net by a short wire and a label (or GND symbol)
    fx = 304.8
    for i, net in enumerate(FLAGGED):
        x, y = fx + i * 20.32, 228.6
        power_symbol(PWR_FLAG, x, y)
        items.append(f'(wire (pts (xy {x} {y}) (xy {x} {y + 5.08})) (stroke (width 0) (type default)) (uuid "{uid()}"))')
        if net == "GND":
            power_symbol(GND_SYM, x, y + 5.08)
        else:
            items.append(f'(label "{net}" (at {x} {y + 5.08} 0) (fields_autoplaced yes) '
                         f'(effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "{uid()}"))')

    text = NOTES.replace('"', "'").replace("\n", "\\n")
    items.append(f'(text "{text}" (exclude_from_sim no) (at 20.32 254 0) '
                 f'(effects (font (size 1.27 1.27)) (justify left top)) (uuid "{uid()}"))')

    lib = "\n".join(s.lib_text(f"{LIB}:{s.name}") for s in SYMBOLS)
    sch = f"""(kicad_sch
(version 20231120)
(generator "eeschema")
(generator_version "8.0")
(uuid "{ROOT}")
(paper "A3")
(title_block (title "Cy-Ramick: The Sentient Plate") (rev "2") (company "KnightHack 2026")
  (comment 1 "Hand-wired point to point; generated by make_schematic.py"))
(lib_symbols
{lib}
)
{chr(10).join(items)}
(sheet_instances (path "/" (page "1")))
)
"""
    with open(os.path.join(HERE, "plate.kicad_sch"), "w") as f:
        f.write(sch)

    lib_file = "(kicad_symbol_lib (version 20231120) (generator \"kicad_symbol_editor\") (generator_version \"8.0\")\n"
    lib_file += "\n".join(s.lib_text(s.name) for s in SYMBOLS) + "\n)\n"
    with open(os.path.join(HERE, "plate.kicad_sym"), "w") as f:
        f.write(lib_file)

    with open(os.path.join(HERE, "sym-lib-table"), "w") as f:
        f.write('(sym_lib_table\n  (version 7)\n  (lib (name "plate")(type "KiCad")(uri "${KIPRJMOD}/plate.kicad_sym")'
                '(options "")(descr "Cy-Ramick plate parts"))\n)\n')

    pro = os.path.join(HERE, "plate.kicad_pro")
    if not os.path.exists(pro):
        with open(pro, "w") as f:
            f.write('{\n  "meta": {\n    "filename": "plate.kicad_pro",\n    "version": 1\n  },\n'
                    '  "schematic": {\n    "legacy_lib_dir": "",\n    "legacy_lib_list": []\n  },\n'
                    '  "sheets": [\n    [\n      "' + ROOT + '",\n      "Root"\n    ]\n  ]\n}\n')


if __name__ == "__main__":
    build()
    print("Wrote plate.kicad_sch, plate.kicad_sym, sym-lib-table, plate.kicad_pro")
