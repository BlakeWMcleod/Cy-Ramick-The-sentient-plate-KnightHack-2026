"""
Cy-Ramick plate enclosure generator (Blender 5.2).

Builds the round 3D-printed tray and lid that sit under the plate, plus
stand-in blocks for every component, checks the fit, and writes the files
below. To keep print time down, the outer shell stays closed but the floor
is opened wherever nothing rests on it and the lid is a ring.


  tray.stl, lid.stl            print files in mm (lid already flipped tabs-up)
  plate_enclosure.blend        assembled model with component stand-ins
  preview_inside.png           lid hidden
  preview_outside.png          lid on, seen from below

Run from this folder:
  "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" -b --factory-startup --python make_enclosure.py

All dimensions are in mm. Coordinates: origin at the centre of the tray
floor's underside, +Z up, -X is the left wall (USB-C slot), +X the right
wall (buttons), +Y the back wall (speaker vents).
"""

import math
import os
import struct

import bmesh
import bpy
from mathutils.bvhtree import BVHTree

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# ============================================================== Parameters

# Shell
R = 79.0              # Outer radius (158 mm across)
WALL = 1.6            # 4 perimeters with a 0.4 mm nozzle
FLOOR = 1.6           # Also sets the IR sensors' height above the table
LID = 1.2
TRAY_H = 23.1         # Tray height including the floor; lid sits on top
CLEAR = 0.3           # Fit clearance around located parts
SEG = 192             # Circle resolution

# Plate fit (measure the inside of the plate's foot ring when it arrives)
PLATE_FOOT_RING_ID = 162.0

# Battery holder (DAIERTEK 4xAA)
BAT_L, BAT_W = 68.7, 64.2
BAT_H = 19.0          # Body height
BAT_SW_H = 22.5       # Height including the switch
BAT_X, BAT_Y = 14.85, 0.0
BAT_ROT = 0           # 0: long side along X, 90: long side along Y
BAT_SW = (12.0, 8.0)  # Switch footprint, near one end of the cover
BAT_GUIDE_H = 6.0

# ESP32 DevKit 30-pin
ESP_L, ESP_W = 52.0, 28.5
ESP_PCB = 1.6
ESP_LEDGE_Z = 11.0    # Board underside above the floor
ESP_Y = 0.0           # Board centreline; the USB end faces the -X wall
ESP_WALL_GAP = 2.4    # USB connector to the wall's inner face
ESP_LEDGE_W = 3.5     # Ledges under the two pin-free ends of the board
ESP_PIN_LEN = 8.5     # Header pins below the board
ESP_ROW_PITCH = 25.4
ESP_PINS = 15
ESP_USB = (8.0, 9.0, 3.2)  # Connector length, width, height
USB_SLOT = (13.0, 7.5)     # Slot width, height through the left wall

# GY-521 (MPU-6050), glued flat to the floor (any orientation; calibrated at boot)
GY_L, GY_W, GY_H = 21.0, 16.0, 4.0
GY_POS = None         # (x, y, degrees); None = under the ESP32 between its header rows

# DFPlayer Mini
DF_S, DF_H = 20.5, 6.0
DF_X, DF_Y = 61.75, 0.0
DF_GUIDE_H = 4.0

# Speaker (31 x 28 x 15 sealed box), face down on a hollow plenum
SPK_L, SPK_W, SPK_H = 31.0, 28.0, 15.0
SPK_ANGLE = 90        # Direction from the centre to the speaker; vents face the same way
SPK_DIST = 50.0       # Speaker centre from the tray centre
PLENUM_H = 4.4        # Total plenum height above the floor
PLENUM_TOP = 1.2      # Plenum roof thickness
PLENUM_HALF_W = 18.0
SPK_HOLE_D = 22.0
VENT_N, VENT_W, VENT_PITCH = 5, 3.0, 6.0

# TCRT5000 modules, mounted upside down, sensor resting on the floor
IR_L, IR_W, IR_PCB = 35.0, 10.0, 1.6
IR_BODY_H = 7.0       # Sensor body height (sets the PCB height above the floor)
IR_SENSOR_U = 3.5     # Sensor centre from the sensor end of the module
IR_WALL_GAP = 9.4     # Module centreline to the wall's inner face
IR_ANGLES = [50, 135, 215, 270, 320]  # Degrees, counter-clockwise from +X
IR_PIN_DIR = [-1, -1, 1, 1, -1]       # Which end the header pins leave from
IR_PIN_LEN = 6.0
IR_WINDOW = (10.4, 7.0)               # Floor window across, along the module

# 6x6x9.5 mm tactile buttons in the right wall
BTN_ANGLES = [15, -15]
BTN_Z = 12.0          # Plunger centre height
BTN_BODY, BTN_BODY_H = 6.0, 3.5
BTN_TOTAL_H = 9.5
BTN_PLUNGER_D = 3.5
BTN_HOLE_D = 4.0
BTN_PROTRUDE = 2.4    # Plunger beyond the outer wall

# Print-time savings
FLOOR_CUTOUTS = True  # Open the floor wherever nothing rests on it
FLOOR_RIM = 5.0       # Solid floor band inside the wall
FLOOR_PAD = 2.0       # Solid floor margin around parts and guides
FLOOR_SPOKES = 8      # Radial floor ribs that keep the floor stiff
SPOKE_W = 5.0
BAT_SEAT = 8.0        # Width of the floor band the battery holder is glued to
LID_RING_W = 5.0      # Lid is a ring this far inside the wall (0 = solid lid)

# Lid tabs
TAB_ANGLES = [30, 150, 270]
TAB_LEN, TAB_T, TAB_H = 10.0, 1.5, 3.0

RENDER_PREVIEWS = True

# ============================================================== Derived

R_IN = R - WALL
LID_Z = TRAY_H
ESP_X0 = -min(math.sqrt(R_IN ** 2 - ESP_Y ** 2) - ESP_WALL_GAP,
              math.sqrt(R_IN ** 2 - (abs(ESP_Y) + ESP_W / 2) ** 2) - 0.6)  # USB end of the board
BAT_DX, BAT_DY = (BAT_L, BAT_W) if BAT_ROT == 0 else (BAT_W, BAT_L)
IR_RADIUS = R_IN - IR_WALL_GAP
ESP_XC = ESP_X0 + ESP_L / 2
ESP_Z = FLOOR + ESP_LEDGE_Z          # Board underside
BTN_A = R + BTN_PROTRUDE - BTN_TOTAL_H  # Button base, radial distance

# ============================================================== Geometry helpers
# A "part" is (verts, faces) in world coordinates.


def rot(u, v, deg):
    a = math.radians(deg)
    return (u * math.cos(a) - v * math.sin(a), u * math.sin(a) + v * math.cos(a))


def prism(poly, z0, z1):
    """Extrude a 2D polygon between two heights."""
    n = len(poly)
    verts = [(x, y, z0) for x, y in poly] + [(x, y, z1) for x, y in poly]
    faces = [list(reversed(range(n))), list(range(n, 2 * n))]
    faces += [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
    return verts, faces


def obox(u0, u1, v0, v1, z0, z1, deg=0.0, origin=(0.0, 0.0)):
    """Box given in a frame rotated by deg (u along the angle, v across it)."""
    pts = [rot(u, v, deg) for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]
    return prism([(origin[0] + x, origin[1] + y) for x, y in pts], z0, z1)


def rotate_part(part, deg):
    verts, faces = part
    return [(*rot(x, y, deg), z) for x, y, z in verts], faces


def box(x0, x1, y0, y1, z0, z1):
    return obox(x0, x1, y0, y1, z0, z1)


def circle(cx, cy, r, seg=SEG):
    return [(cx + r * math.cos(2 * math.pi * i / seg), cy + r * math.sin(2 * math.pi * i / seg))
            for i in range(seg)]


def cyl(cx, cy, r, z0, z1, seg=SEG):
    return prism(circle(cx, cy, r, seg), z0, z1)


def radial_cyl(deg, u0, u1, r, z, seg=48):
    """Cylinder whose axis runs radially outward at angle deg, centred at height z."""
    ring = [(r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
    verts = []
    for u in (u0, u1):
        for v, dz in ring:
            x, y = rot(u, v, deg)
            verts.append((x, y, z + dz))
    n = seg
    faces = [list(reversed(range(n))), list(range(n, 2 * n))]
    faces += [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
    return verts, faces


def rect_in_circle(x0, x1, y0, y1, r, step=0.5):
    """Rectangle clipped to a circle of radius r (points outside are pulled onto it)."""
    pts = []

    def edge(ax, ay, bx, by):
        n = max(1, int(math.hypot(bx - ax, by - ay) / step))
        for i in range(n):
            t = i / n
            pts.append((ax + (bx - ax) * t, ay + (by - ay) * t))

    edge(x0, y0, x1, y0)
    edge(x1, y0, x1, y1)
    edge(x1, y1, x0, y1)
    edge(x0, y1, x0, y0)
    out = []
    for x, y in pts:
        d = math.hypot(x, y)
        if d > r:
            x, y = x * r / d, y * r / d
        if not out or math.hypot(x - out[-1][0], y - out[-1][1]) > 0.05:
            out.append((x, y))
    if math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) < 0.05:
        out.pop()
    return out


def sector(r0, r1, a0, a1, seg=24):
    """Annular sector outline, angles in degrees."""
    outer = [(r1 * math.cos(math.radians(a0 + (a1 - a0) * i / seg)),
              r1 * math.sin(math.radians(a0 + (a1 - a0) * i / seg))) for i in range(seg + 1)]
    inner = [(r0 * math.cos(math.radians(a1 - (a1 - a0) * i / seg)),
              r0 * math.sin(math.radians(a1 - (a1 - a0) * i / seg))) for i in range(seg + 1)]
    return outer + inner


def l_guides(cx, cy, sx, sy, length, h, t=1.2):
    """Corner guides (L-shaped) around a rectangle of size sx x sy centred at cx, cy."""
    parts = []
    hx, hy = sx / 2 + CLEAR, sy / 2 + CLEAR
    for kx in (-1, 1):
        for ky in (-1, 1):
            xo, yo = cx + kx * hx, cy + ky * hy
            xs = sorted((xo + kx * t, xo - kx * length))  # Spans the corner so the bars overlap
            ys = sorted((yo, yo - ky * length))
            parts.append(box(xs[0], xs[1], *sorted((yo, yo + ky * t)), FLOOR - 0.5, FLOOR + h))
            parts.append(box(*sorted((xo, xo + kx * t)), ys[0], ys[1], FLOOR - 0.5, FLOOR + h))
    return parts


# ============================================================== Blender helpers

def new_collection(name, parent=None):
    col = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(col)
    return col


def make_object(name, parts, collection, material=None):
    bm = bmesh.new()
    for verts, faces in parts:
        bv = [bm.verts.new(v) for v in verts]
        for f in faces:
            bm.faces.new([bv[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    if material:
        obj.data.materials.append(material)
    return obj


def apply_boolean(target, parts, operation, tmp_collection):
    """Union or subtract a list of solids from target, using the exact solver."""
    if not parts:
        return
    col = new_collection(f"tmp_{operation}", tmp_collection)
    for i, p in enumerate(parts):
        make_object(f"tool_{i}", [p], col)
    mod = target.modifiers.new("bool", "BOOLEAN")
    mod.operation = operation
    mod.solver = "EXACT"
    mod.operand_type = "COLLECTION"
    mod.collection = col
    dg = bpy.context.evaluated_depsgraph_get()
    new_mesh = bpy.data.meshes.new_from_object(target.evaluated_get(dg))
    old = target.data
    target.modifiers.remove(mod)
    target.data = new_mesh
    bpy.data.meshes.remove(old)
    for o in list(col.objects):
        bpy.data.meshes.remove(o.data)
    bpy.data.collections.remove(col)


def material(name, rgb, alpha=1.0):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.6
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
    m.diffuse_color = (*rgb, alpha)
    return m


def mesh_triangles(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    return [tuple(mesh.vertices[i].co.copy() for i in tri.vertices) for tri in mesh.loop_triangles]


def write_stl(path, tris, transform=None):
    with open(path, "wb") as f:
        f.write(b"Cy-Ramick plate enclosure".ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        for tri in tris:
            pts = [transform(p) if transform else p for p in tri]
            a, b, c = pts
            n = (b - a).cross(c - a)
            if n.length > 0:
                n.normalize()
            f.write(struct.pack("<3f", *n))
            for p in pts:
                f.write(struct.pack("<3f", *p))
            f.write(b"\0\0")


# ============================================================== Component stand-ins

def gy_box(z0, z1, margin=0.0):
    if GY_POS is None:
        x, y, deg = ESP_XC, ESP_Y, 0
    else:
        x, y, deg = GY_POS
    return obox(-GY_L / 2 - margin, GY_L / 2 + margin, -GY_W / 2 - margin, GY_W / 2 + margin, z0, z1, deg, (x, y))


def esp_ledges(z0, z1, margin=0.0):
    ends = ((ESP_X0 - 0.6, ESP_X0 + ESP_LEDGE_W), (ESP_X0 + ESP_L - ESP_LEDGE_W, ESP_X0 + ESP_L))
    return [box(xa - margin, xb + margin, ESP_Y - ESP_W / 2 - margin, ESP_Y + ESP_W / 2 + margin, z0, z1)
            for xa, xb in ends]


def plenum_parts(margin=0.0):
    """Plenum solid, cavity, speaker hole and vents, built facing +Y then rotated into place."""
    F = FLOOR
    y0 = SPK_DIST - SPK_W / 2 - 2.0
    w = PLENUM_HALF_W - 1.2
    z_cav = F + PLENUM_H - PLENUM_TOP
    solid = prism(rect_in_circle(-PLENUM_HALF_W - margin, PLENUM_HALF_W + margin, y0 - margin, R_IN + 5,
                                 R_IN + 1.0 + margin), F - 0.5 if not margin else -2.0, F + PLENUM_H if not margin else F + 1.0)
    cuts = [prism(rect_in_circle(-w, w, y0 + 1.2, R_IN + 5, R_IN - 0.3), F - 0.4, z_cav),
            cyl(0, SPK_DIST, SPK_HOLE_D / 2, z_cav - 0.1, F + PLENUM_H + 0.1, 96)]
    for i in range(VENT_N):
        x = (i - (VENT_N - 1) / 2) * VENT_PITCH
        cuts.append(box(x - VENT_W / 2, x + VENT_W / 2, R_IN - 2.0, R + 2, F - 0.4, z_cav - 0.4))
    turn = SPK_ANGLE - 90
    return rotate_part(solid, turn), [rotate_part(c, turn) for c in cuts]


def components():
    """Return {name: (parts, colour)} for every component, in assembled position."""
    c = {}
    F = FLOOR

    # Battery holder, switch at the +X end of the cover
    bx0, bx1 = BAT_X - BAT_DX / 2, BAT_X + BAT_DX / 2
    by0, by1 = BAT_Y - BAT_DY / 2, BAT_Y + BAT_DY / 2
    sw = obox(BAT_L / 2 - 6 - BAT_SW[0], BAT_L / 2 - 6, -BAT_SW[1] / 2, BAT_SW[1] / 2,
              F + BAT_H, F + BAT_SW_H, BAT_ROT, (BAT_X, BAT_Y))
    c["Battery holder"] = ([box(bx0, bx1, by0, by1, F, F + BAT_H), sw], (0.12, 0.12, 0.12))

    # ESP32 on ledges, components up, header pins down
    x0, x1 = ESP_X0, ESP_X0 + ESP_L
    zb, zt = ESP_Z, ESP_Z + ESP_PCB
    pins_half = ESP_PINS * 2.54 / 2
    esp = [
        box(x0, x1, ESP_Y - ESP_W / 2, ESP_Y + ESP_W / 2, zb, zt),
        box(x0 - 0.5, x0 - 0.5 + ESP_USB[0], ESP_Y - ESP_USB[1] / 2, ESP_Y + ESP_USB[1] / 2, zt, zt + ESP_USB[2]),
        box(x0 + 10, x1, ESP_Y - 9, ESP_Y + 9, zt, zt + 3.2),
    ]
    for ky in (-1, 1):
        y = ESP_Y + ky * ESP_ROW_PITCH / 2
        esp.append(box(ESP_XC - pins_half, ESP_XC + pins_half, y - 1.27, y + 1.27, zb - ESP_PIN_LEN, zb))
    c["ESP32 DevKit"] = (esp, (0.08, 0.22, 0.55))

    c["GY-521"] = ([gy_box(F, F + GY_H)], (0.15, 0.4, 0.75))

    c["DFPlayer Mini"] = ([box(DF_X - DF_S / 2, DF_X + DF_S / 2, DF_Y - DF_S / 2, DF_Y + DF_S / 2, F, F + DF_H)],
                          (0.1, 0.45, 0.25))

    c["Speaker"] = ([rotate_part(box(-SPK_L / 2, SPK_L / 2, SPK_DIST - SPK_W / 2, SPK_DIST + SPK_W / 2,
                                     F + PLENUM_H, F + PLENUM_H + SPK_H), SPK_ANGLE - 90)], (0.55, 0.1, 0.1))

    # TCRT5000 modules: u = radial, v = along the module
    for i, (deg, pd) in enumerate(zip(IR_ANGLES, IR_PIN_DIR)):
        u = IR_RADIUS
        vs = -pd * (IR_L / 2 - IR_SENSOR_U)
        zp = F + IR_BODY_H
        parts = [
            obox(u - IR_W / 2, u + IR_W / 2, -IR_L / 2, IR_L / 2, zp, zp + IR_PCB, deg),
            obox(u - 5.1, u + 5.1, vs - 2.9, vs + 2.9, F, zp, deg),
            obox(u - 4, u + 4, *sorted((vs + pd * 4, pd * IR_L / 2)), zp - 4.5, zp, deg),
            obox(u - 4, u + 4, *sorted((pd * IR_L / 2, pd * (IR_L / 2 + IR_PIN_LEN))), zp - 2.5, zp, deg),
        ]
        c[f"TCRT5000 {i + 1}"] = (parts, (0.2, 0.25, 0.6))

    # Tactile buttons, plunger pointing out through the wall
    for i, deg in enumerate(BTN_ANGLES):
        h = BTN_BODY / 2
        parts = [
            obox(BTN_A, BTN_A + BTN_BODY_H, -h, h, BTN_Z - h, BTN_Z + h, deg),
            radial_cyl(deg, BTN_A + BTN_BODY_H, R + BTN_PROTRUDE, BTN_PLUNGER_D / 2, BTN_Z),
        ]
        for kv in (-1, 1):
            for kz in (-1, 1):
                v, z = kv * 3.25, BTN_Z + kz * 2.25
                parts.append(obox(BTN_A - 3.5, BTN_A, v - 0.35, v + 0.35, z - 0.35, z + 0.35, deg))
        c[f"Button {i + 1}"] = (parts, (0.85, 0.75, 0.2))

    return c


# ============================================================== Tray and lid features

def tray_adds():
    F = FLOOR
    adds = []

    # ESP32 ledges under the two short ends of the board (clear of the header pins)
    adds += esp_ledges(F - 0.5, ESP_Z)

    adds += l_guides(BAT_X, BAT_Y, BAT_DX, BAT_DY, 10.0, BAT_GUIDE_H)
    adds += l_guides(DF_X, DF_Y, DF_S, DF_S, 6.0, DF_GUIDE_H)

    # Speaker plenum, running out into the wall
    adds.append(plenum_parts()[0])

    # TCRT5000 side fences
    for deg in IR_ANGLES:
        u = IR_RADIUS
        for k in (-1, 1):
            ua = u + k * (IR_W / 2 + CLEAR)
            adds.append(obox(*sorted((ua, ua + k * 1.2)), -15, 15, F - 0.5, F + IR_BODY_H + IR_PCB + 1.0, deg))

    # Button pockets: side walls beside the body and a backing rib behind it
    for deg in BTN_ANGLES:
        half = BTN_BODY / 2 + 0.15 + 1.2
        adds.append(obox(BTN_A, R_IN + 0.5, -half, half, F - 0.5, BTN_Z + BTN_BODY / 2, deg))
        adds.append(obox(BTN_A - 1.6, BTN_A + 0.5, -1.6, 1.6, F - 0.5, BTN_Z + BTN_BODY / 2, deg))
    return adds


def tray_cuts():
    F = FLOOR
    cuts = []

    # USB-C slot in the left wall, centred on the connector
    zc = ESP_Z + ESP_PCB + ESP_USB[2] / 2
    xw = math.sqrt(R_IN ** 2 - ESP_Y ** 2)
    cuts.append(box(-R - 2, -(xw - 1), ESP_Y - USB_SLOT[0] / 2, ESP_Y + USB_SLOT[0] / 2,
                    zc - USB_SLOT[1] / 2, zc + USB_SLOT[1] / 2))

    # Plenum cavity, speaker hole and vent slots
    cuts += plenum_parts()[1]

    # Floor windows under each IR sensor
    for deg, pd in zip(IR_ANGLES, IR_PIN_DIR):
        vs = -pd * (IR_L / 2 - IR_SENSOR_U)
        cuts.append(obox(IR_RADIUS - IR_WINDOW[0] / 2, IR_RADIUS + IR_WINDOW[0] / 2,
                         vs - IR_WINDOW[1] / 2, vs + IR_WINDOW[1] / 2, -1, F + 0.2, deg))

    # Button body slots (open at the top) and plunger holes
    for deg in BTN_ANGLES:
        h = BTN_BODY / 2 + 0.15
        cuts.append(obox(BTN_A, R_IN - 0.3, -h, h, BTN_Z - h, BTN_Z + 20, deg))
        cuts.append(radial_cyl(deg, R_IN - 1.0, R + 1.0, BTN_HOLE_D / 2, BTN_Z))
    return cuts


def lid_window():
    m = 0.5
    return box(BAT_X - BAT_DX / 2 - m, BAT_X + BAT_DX / 2 + m, BAT_Y - BAT_DY / 2 - m, BAT_Y + BAT_DY / 2 + m,
               LID_Z - 1, LID_Z + LID + 1)


def lid_tabs():
    tabs = []
    r1 = R_IN - CLEAR
    r0 = r1 - TAB_T
    for deg in TAB_ANGLES:
        half = math.degrees(TAB_LEN / 2 / r1)
        tabs.append(prism(sector(r0, r1, deg - half, deg + half), LID_Z - TAB_H, LID_Z + 0.5))
    return tabs


def floor_keep_pads():
    """2D-extruded solids marking floor areas that must stay solid."""
    F = FLOOR
    z0, z1 = -2.0, F + 1.0
    m = FLOOR_PAD
    g = CLEAR + 1.2 + m   # Margin that also covers the corner guides
    pads = []
    pads.append(box(BAT_X - BAT_DX / 2 - g, BAT_X + BAT_DX / 2 + g,
                    BAT_Y - BAT_DY / 2 - g, BAT_Y + BAT_DY / 2 + g, z0, z1))
    pads.append(box(DF_X - DF_S / 2 - g, DF_X + DF_S / 2 + g, DF_Y - DF_S / 2 - g, DF_Y + DF_S / 2 + g, z0, z1))
    pads += esp_ledges(z0, z1, m)
    pads.append(gy_box(z0, z1, m))
    pads.append(plenum_parts(m)[0])
    for deg in IR_ANGLES:
        hu = IR_W / 2 + CLEAR + 1.2 + m
        pads.append(obox(IR_RADIUS - hu, IR_RADIUS + hu, -IR_L / 2 - m, IR_L / 2 + m, z0, z1, deg))
    for deg in BTN_ANGLES:
        half = BTN_BODY / 2 + 0.15 + 1.2 + m
        pads.append(obox(BTN_A - 1.6 - m, R + 1, -half, half, z0, z1, deg))
    for i in range(FLOOR_SPOKES):
        deg = 360.0 * i / FLOOR_SPOKES + 22.5
        pads.append(obox(-1, R + 1, -SPOKE_W / 2, SPOKE_W / 2, z0, z1, deg))
    pads.append(cyl(0, 0, 8, z0, z1, 48))
    return pads


def floor_cutter(tmp_collection):
    """One solid covering every floor opening: the open disc minus the keep pads,
    plus the centre of the battery seat."""
    cutter = make_object("floor_cutter", [cyl(0, 0, R_IN - FLOOR_RIM, -1, FLOOR + 0.05)], tmp_collection)
    apply_boolean(cutter, floor_keep_pads(), "DIFFERENCE", tmp_collection)
    s = BAT_SEAT
    seat = box(BAT_X - BAT_DX / 2 + s, BAT_X + BAT_DX / 2 - s, BAT_Y - BAT_DY / 2 + s, BAT_Y + BAT_DY / 2 - s,
               -1, FLOOR + 0.05)
    apply_boolean(cutter, [seat], "UNION", tmp_collection)
    mesh = cutter.data
    part = ([v.co.copy() for v in mesh.vertices], [list(p.vertices) for p in mesh.polygons])
    bpy.data.objects.remove(cutter)
    bpy.data.meshes.remove(mesh)
    return part


# ============================================================== Checks

def shrink(part, d=0.05):
    verts, faces = part
    cx = sum(v[0] for v in verts) / len(verts)
    cy = sum(v[1] for v in verts) / len(verts)
    cz = sum(v[2] for v in verts) / len(verts)
    out = []
    for x, y, z in verts:
        out.append((x - math.copysign(d, x - cx) if abs(x - cx) > d else x,
                    y - math.copysign(d, y - cy) if abs(y - cy) > d else y,
                    z - math.copysign(d, z - cz) if abs(z - cz) > d else z))
    return out, faces


def bvh_from_parts(parts):
    verts, polys = [], []
    for v, f in parts:
        base = len(verts)
        verts += v
        polys += [[base + i for i in face] for face in f]
    return BVHTree.FromPolygons(verts, polys)


def bvh_from_object(obj):
    mesh = obj.data
    return BVHTree.FromPolygons([v.co.copy() for v in mesh.vertices], [list(p.vertices) for p in mesh.polygons])


def check_solid(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bad = sum(1 for e in bm.edges if not e.is_manifold)
    vol = bm.calc_volume(signed=True)
    bm.free()
    return bad, vol


def run_checks(comps, tray, lid):
    problems = []

    trees = {name: bvh_from_parts([shrink(p) for p in parts]) for name, (parts, _) in comps.items()}
    tray_tree = bvh_from_object(tray)
    lid_tree = bvh_from_object(lid)

    names = list(trees)
    for i, a in enumerate(names):
        if trees[a].overlap(tray_tree):
            problems.append(f"{a} hits the tray")
        if trees[a].overlap(lid_tree):
            problems.append(f"{a} hits the lid")
        for b in names[i + 1:]:
            if trees[a].overlap(trees[b]):
                problems.append(f"{a} hits {b}")

    for obj in (tray, lid):
        bad, vol = check_solid(obj)
        if bad:
            problems.append(f"{obj.name} is not watertight ({bad} non-manifold edges)")
        if vol <= 0:
            problems.append(f"{obj.name} has invalid volume ({vol:.1f} mm^3)")

    if 2 * R > PLATE_FOOT_RING_ID - 2:
        problems.append(f"Enclosure ({2 * R:.1f} mm) may not fit inside the plate's foot ring "
                        f"({PLATE_FOOT_RING_ID:.1f} mm); reduce R")
    return problems


# ============================================================== Previews

def setup_render():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 900
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("World")
    if world.node_tree is None:
        world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.92, 0.93, 0.95, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    scene.world = world

    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 3.0
    sun_obj = bpy.data.objects.new("Sun", sun)
    sun_obj.rotation_euler = (math.radians(35), math.radians(15), math.radians(30))
    scene.collection.objects.link(sun_obj)

    cam = bpy.data.cameras.new("Camera")
    cam.lens = 50
    cam_obj = bpy.data.objects.new("Camera", cam)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj
    return cam_obj


def aim(cam_obj, location, target=(0, 0, 10)):
    from mathutils import Vector
    cam_obj.location = location
    direction = Vector(target) - Vector(location)
    cam_obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


# ============================================================== Main

def main():
    # Fresh scene in millimetres
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = "MILLIMETERS"

    print_col = new_collection("Print parts")
    comp_col = new_collection("Components (not printed)")
    tmp_col = new_collection("tmp")

    shell_mat = material("Shell", (0.85, 0.85, 0.82))
    lid_mat = material("Lid", (0.75, 0.8, 0.85))

    # Tray: solid disc, hollow it out, add features, then cut openings
    tray = make_object("Tray", [cyl(0, 0, R, 0, TRAY_H)], print_col, shell_mat)
    apply_boolean(tray, [cyl(0, 0, R_IN, FLOOR, TRAY_H + 1)], "DIFFERENCE", tmp_col)
    apply_boolean(tray, tray_adds(), "UNION", tmp_col)
    cuts = tray_cuts()
    if FLOOR_CUTOUTS:
        cuts.append(floor_cutter(tmp_col))
    apply_boolean(tray, cuts, "DIFFERENCE", tmp_col)

    lid = make_object("Lid", [cyl(0, 0, R, LID_Z, LID_Z + LID)], print_col, lid_mat)
    apply_boolean(lid, lid_tabs(), "UNION", tmp_col)
    if LID_RING_W > 0:
        apply_boolean(lid, [cyl(0, 0, R_IN - LID_RING_W, LID_Z - 1, LID_Z + LID + 1)], "DIFFERENCE", tmp_col)
    else:
        apply_boolean(lid, [lid_window()], "DIFFERENCE", tmp_col)
    bpy.data.collections.remove(tmp_col)

    comps = components()
    for name, (parts, rgb) in comps.items():
        make_object(name, parts, comp_col, material(name, rgb))

    # Print files: tray as modelled, lid flipped tabs-up and set on the bed
    write_stl(os.path.join(OUT_DIR, "tray.stl"), mesh_triangles(tray))
    from mathutils import Vector
    top = LID_Z + LID
    write_stl(os.path.join(OUT_DIR, "lid.stl"), mesh_triangles(lid),
              lambda p: Vector((p.x, -p.y, top - p.z)))

    problems = run_checks(comps, tray, lid)
    for obj in (tray, lid):
        print(f"{obj.name} plastic: {check_solid(obj)[1] / 1000:.1f} cm^3")

    if RENDER_PREVIEWS:
        cam = setup_render()
        lid.hide_render = True
        aim(cam, (105, -185, 235), (2, 0, 6))
        render(os.path.join(OUT_DIR, "preview_inside.png"))
        lid.hide_render = False
        aim(cam, (235, 165, -95), (0, 0, 10))
        render(os.path.join(OUT_DIR, "preview_outside.png"))

    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, "plate_enclosure.blend"))

    print(f"Enclosure: {2 * R:.1f} mm across x {TRAY_H + LID:.1f} mm tall "
          f"(tray {TRAY_H:.1f} + lid {LID:.1f})")
    if problems:
        for p in problems:
            print("CHECK FAILED:", p)
    else:
        print("CHECK: OK")


main()
