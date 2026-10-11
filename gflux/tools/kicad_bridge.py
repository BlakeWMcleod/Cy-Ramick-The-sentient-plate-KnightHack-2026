#!/usr/bin/env python3
"""GFLUX local KiCad bridge (Python 3 standard library only).

    python3 gflux/tools/kicad_bridge.py [--port 8765] [--host 127.0.0.1]

Serves the gflux/ folder at http://localhost:8765/ and exposes kicad-cli:

    GET  /api/kicad/health     -> cached KiCad detection, see health() below
    POST /api/kicad/recheck    -> look for KiCad again, returns the same shape as health
    POST /api/kicad/locate     -> show a file picker on this computer so the user can point
                                  at their KiCad; saves it and returns health (+ located/message)
    GET  /api/arduino/health   -> Arduino status (?refresh=1 re-scans); POST /api/arduino/check|setup|open: see arduino_bridge.py
    GET  /api/kicad/install    -> install status {"state": "idle|running|done|failed|manual", ...}
    POST /api/kicad/install    -> start installing KiCad (winget / Homebrew)
    POST /api/kicad/schematic  {name, sch}            -> zip: .kicad_sch, -schematic.pdf, -schematic.svg
    POST /api/kicad/pcb        {name, pcb, sch?, pro?} -> zip: .kicad_pcb, gerbers/ + drill, -pcb.pdf

recheck, locate and install only accept requests from the page this bridge
serves (no Origin header, or http://localhost:<port> / http://127.0.0.1:<port>).

KiCad is found by the launcher, never by the browser: detect_kicad() checks a
saved setting, $KICAD_CLI, PATH, the usual install folders for this OS and, on
Windows, the registry, then runs `kicad-cli version` on what it finds.

CORS (including Chrome's Private Network Access preflight) is enabled, so a
copy of GFLUX hosted elsewhere can still talk to the bridge on localhost.
Errors come back as JSON: {"ok": false, "error": "...", "stderr": "..."}.
Works with kicad-cli 7, 8 and 9.
"""
import argparse
import hashlib
import glob
import io
import json
import os
import plistlib
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # the gflux/ folder
MAX_BODY = 25 * 1024 * 1024
TIMEOUT = 180
PROBE_TIMEOUT = 30   # `kicad-cli version` can be slow on a cold start / virus scan
MIN_MAJOR = 7        # kicad-cli first shipped with KiCad 7
FLATPAK_ID = 'org.kicad.KiCad'
OVERRIDE_SOURCES = ('saved setting', 'KICAD_CLI', 'PATH')
DOWNLOAD_URL = 'https://www.kicad.org/download/'

GERBER_LAYERS = ['F.Cu', 'B.Cu', 'F.Paste', 'B.Paste', 'F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask', 'Edge.Cuts']
PDF_LAYERS = ['F.Cu', 'B.Cu', 'F.SilkS', 'Edge.Cuts']


class CliError(Exception):
    def __init__(self, message, stderr=''):
        super().__init__(message)
        self.stderr = stderr


def safe_name(name):
    """Same rule as GFLUX.kicad.baseName in js/kicad.js."""
    s = re.sub(r'[^A-Za-z0-9_-]+', '_', str(name or '')).strip('_')[:60]
    return s or 'gflux'


# ------------------------------------------------------------ running kicad-cli
# A "cli" is either a path to kicad-cli or an argv prefix list, e.g.
# ['flatpak', 'run', '--command=kicad-cli', 'org.kicad.KiCad'].

def cli_argv(cli):
    return list(cli) if isinstance(cli, (list, tuple)) else [cli]


def cli_display(cli):
    """The cli as one string, for JSON and the console."""
    if cli is None:
        return None
    return cli if isinstance(cli, str) else ' '.join(cli)


def _proc_kw():
    kw = {'stdin': subprocess.DEVNULL}
    if sys.platform == 'win32':
        kw['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0x08000000)
    return kw


def version_tuple(text):
    """'9.0.2' -> (9, 0, 2); 'KiCad 10' -> (10,); no number -> ()."""
    m = re.search(r'\d+(?:\.\d+)*', str(text or ''))
    return tuple(int(x) for x in m.group(0).split('.')) if m else ()


_version_cache = {}


def cli_version(cli):
    """('7.0.11', 7) for a working kicad-cli; raises CliError / OSError / SubprocessError otherwise."""
    key = tuple(cli_argv(cli))
    if key not in _version_cache:
        r = subprocess.run(cli_argv(cli) + ['version'], capture_output=True, text=True, errors='replace',
                           timeout=PROBE_TIMEOUT, **_proc_kw())
        m = re.search(r'(\d+)\.(\d+)(?:\.(\d+))?', r.stdout or '') or re.search(r'(\d+)\.(\d+)(?:\.(\d+))?', r.stderr or '')
        if r.returncode != 0 or not m:
            raise CliError('kicad-cli did not report a version (exit %d)' % r.returncode, (r.stderr or r.stdout or '').strip())
        _version_cache[key] = (m.group(0), int(m.group(1)))
    return _version_cache[key]


def run(cli, args, cwd):
    try:
        r = subprocess.run(cli_argv(cli) + args, cwd=cwd, capture_output=True, text=True, errors='replace',
                           timeout=TIMEOUT, **_proc_kw())
    except subprocess.TimeoutExpired:
        raise CliError('kicad-cli timed out: ' + ' '.join(args[:3]))
    out = (r.stdout or '') + (r.stderr or '')
    if r.returncode != 0:
        raise CliError('kicad-cli %s failed (exit %d)' % (' '.join(args[:3]), r.returncode), out.strip())
    return out


def run_layers(cli, args, layers, cwd):
    """Run with canonical layer names; retry with KiCad 8+ display names if refused."""
    try:
        return run(cli, args + ['--layers', ','.join(layers)], cwd)
    except CliError:
        alt = [l.replace('.SilkS', '.Silkscreen') for l in layers]
        if alt == layers:
            raise
        return run(cli, args + ['--layers', ','.join(alt)], cwd)


def zip_dir(folder):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, files in os.walk(folder):
            for f in sorted(files):
                full = os.path.join(dirpath, f)
                z.write(full, os.path.relpath(full, folder).replace(os.sep, '/'))
    return buf.getvalue()


def write(path, text):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def work_dir(cli, prefix):
    """Temp folder for an export. Flatpak KiCad has its own private /tmp, so use one in the home folder."""
    base = None
    if not isinstance(cli, str):
        base = os.path.join(os.path.expanduser('~'), '.cache', 'gflux')
        os.makedirs(base, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix=prefix, dir=base)


def export_schematic(cli, data):
    sch = data.get('sch')
    if not isinstance(sch, str) or '(kicad_sch' not in sch[:200]:
        raise ValueError('"sch" must be the text of a .kicad_sch file')
    name = safe_name(data.get('name'))
    with work_dir(cli, 'gflux-sch-') as tmp:
        out = os.path.join(tmp, 'out')
        os.mkdir(out)
        sch_path = os.path.join(out, name + '.kicad_sch')
        write(sch_path, sch)
        if isinstance(data.get('pro'), str):
            write(os.path.join(out, name + '.kicad_pro'), data['pro'])
        run(cli, ['sch', 'export', 'pdf', '-o', os.path.join(out, name + '-schematic.pdf'), sch_path], out)
        svg_dir = os.path.join(tmp, 'svg')
        os.mkdir(svg_dir)
        try:  # svg is a bonus: never fail the request over it
            run(cli, ['sch', 'export', 'svg', '-o', svg_dir + os.sep, sch_path], out)
            for i, f in enumerate(sorted(glob.glob(os.path.join(svg_dir, '*.svg')))):
                shutil.move(f, os.path.join(out, name + '-schematic' + ('-%d' % (i + 1) if i else '') + '.svg'))
        except CliError:
            pass
        return name, zip_dir(out)


def export_pcb(cli, data):
    pcb = data.get('pcb')
    if not isinstance(pcb, str) or '(kicad_pcb' not in pcb[:200]:
        raise ValueError('"pcb" must be the text of a .kicad_pcb file')
    name = safe_name(data.get('name'))
    with work_dir(cli, 'gflux-pcb-') as tmp:
        out = os.path.join(tmp, 'out')
        gerbers = os.path.join(out, 'gerbers')
        os.makedirs(gerbers)
        pcb_path = os.path.join(out, name + '.kicad_pcb')
        write(pcb_path, pcb)
        if isinstance(data.get('sch'), str):
            write(os.path.join(out, name + '.kicad_sch'), data['sch'])
        if isinstance(data.get('pro'), str):
            write(os.path.join(out, name + '.kicad_pro'), data['pro'])
        # Output dirs get a trailing separator: kicad-cli 7 drill export needs it.
        run_layers(cli, ['pcb', 'export', 'gerbers', '-o', gerbers + os.sep, pcb_path], GERBER_LAYERS, out)
        run(cli, ['pcb', 'export', 'drill', '--format', 'excellon', '-o', gerbers + os.sep, pcb_path], out)
        run_layers(cli, ['pcb', 'export', 'pdf', '-o', os.path.join(out, name + '-pcb.pdf'), pcb_path], PDF_LAYERS, out)
        return name, zip_dir(out)


# ------------------------------------------------------------ saved setting

def config_path(platform=None, env=None, home=None):
    """Where GFLUX keeps its settings ($GFLUX_CONFIG overrides it)."""
    platform = platform or sys.platform
    env = os.environ if env is None else env
    if env.get('GFLUX_CONFIG'):
        return env['GFLUX_CONFIG']
    home = home or os.path.expanduser('~')
    if platform == 'win32':
        return os.path.join(env.get('APPDATA') or os.path.join(home, 'AppData', 'Roaming'), 'GFLUX', 'config.json')
    if platform == 'darwin':
        return os.path.join(home, 'Library', 'Application Support', 'GFLUX', 'config.json')
    return os.path.join(env.get('XDG_CONFIG_HOME') or os.path.join(home, '.config'), 'gflux', 'config.json')


def load_config(path=None):
    """The settings dict; {} if the file is missing or corrupt."""
    try:
        with open(path or config_path(), 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(updates, path=None):
    """Merge updates into the settings file (None deletes a key). Written atomically."""
    path = path or config_path()
    data = load_config(path)
    for k, v in updates.items():
        if v is None:
            data.pop(k, None)
        else:
            data[k] = v
    folder = os.path.dirname(path) or '.'
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.config-', suffix='.tmp', dir=folder)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return data


# ------------------------------------------------------------ finding KiCad

def _cli_name(platform):
    return 'kicad-cli.exe' if platform == 'win32' else 'kicad-cli'


def _newest_first(paths, part):
    """Sort paths by the version number in part(path), newest first (numerically: 10.0 > 9.0)."""
    return sorted(paths, key=lambda p: version_tuple(part(p)), reverse=True)


def _clis_in_dir(d, exe):
    """kicad-cli paths that may live in folder d (bin folder, install folder, KiCad.app, KiCad parent...)."""
    out = [os.path.join(d, exe), os.path.join(d, 'bin', exe),
           os.path.join(d, 'Contents', 'MacOS', exe), os.path.join(d, 'KiCad.app', 'Contents', 'MacOS', exe)]
    e = glob.escape(d)
    out += _newest_first(glob.glob(os.path.join(e, '*', 'bin', exe)), lambda p: os.path.basename(os.path.dirname(os.path.dirname(p))))
    out += _newest_first(glob.glob(os.path.join(e, '*', 'KiCad.app', 'Contents', 'MacOS', exe)),
                         lambda p: os.path.relpath(p, d))
    out += glob.glob(os.path.join(e, '*', exe))
    return out


def resolve_kicad_path(path, platform=None, up=0):
    """Existing kicad-cli files for something the user pointed at: kicad-cli itself, kicad(.exe),
    KiCad.app, a bin folder, an install folder or the KiCad parent folder. With up > 0 a file or
    folder inside the install also works (parents are checked until something turns up)."""
    platform = platform or sys.platform
    if not isinstance(path, str) or not path.strip():
        return []
    p = os.path.expanduser(os.path.expandvars(path.strip().strip('"').strip("'").strip()))
    exe = _cli_name(platform)
    found = []

    def add(c):
        if c not in found and os.path.isfile(c):
            found.append(c)
    if os.path.isfile(p):
        if os.path.basename(p).lower() in (exe, 'kicad-cli', 'kicad-cli.exe'):
            add(p)
        d = os.path.dirname(p)
    elif os.path.isdir(p):
        d = p.rstrip('/\\') or p
    else:
        return []
    for _ in range(up + 1):
        if found:
            break
        for c in _clis_in_dir(d, exe):
            add(c)
        parent = os.path.dirname(d)
        if not parent or parent == d:
            break
        d = parent
    return found


def _reg_exe_path(s):
    """'"C:\\KiCad\\bin\\kicad.exe",0' or 'C:\\KiCad\\uninstall.exe /S' -> the .exe path."""
    if not isinstance(s, str) or not s.strip():
        return None
    s = os.path.expandvars(s.strip())
    if s.startswith('"'):
        s = s[1:].split('"', 1)[0]
    else:
        m = re.match(r'(.+?\.exe)(?=$|[\s,])', s, re.I)
        s = m.group(1) if m else s.split(',')[0]
    return s.strip() or None


def registry_installs():
    """KiCad install folders from the Windows registry, newest first: [{'folder', 'version', 'name'}].
    Reads the Uninstall keys (HKLM 64-bit, HKLM WOW6432Node, HKCU) and SOFTWARE\\KiCad."""
    try:
        import winreg
    except ImportError:
        return []
    found = []

    def val(key, name):
        try:
            v = winreg.QueryValueEx(key, name)[0]
        except OSError:
            return None
        return os.path.expandvars(v) if isinstance(v, str) else None

    def subkeys(key):
        names, i = [], 0
        while True:
            try:
                names.append(winreg.EnumKey(key, i))
            except OSError:
                return names
            i += 1

    def values(key):
        out, i = [], 0
        while True:
            try:
                name, v, _ = winreg.EnumValue(key, i)
            except OSError:
                return out
            if isinstance(v, str):
                out.append(os.path.expandvars(v))
            i += 1

    hklm, hkcu = winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER
    views = [(hklm, winreg.KEY_WOW64_64KEY), (hklm, winreg.KEY_WOW64_32KEY), (hkcu, 0)]  # 32KEY = WOW6432Node
    uninstall = r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
    for hive, view in views:
        try:
            root = winreg.OpenKey(hive, uninstall, 0, winreg.KEY_READ | view)
        except OSError:
            continue
        with root:
            for sub in subkeys(root):
                try:
                    k = winreg.OpenKey(root, sub)
                except OSError:
                    continue
                with k:
                    name = val(k, 'DisplayName') or ''
                    if not name.strip().lower().startswith('kicad'):
                        continue
                    version = val(k, 'DisplayVersion') or name
                    folders = [val(k, 'InstallLocation')]
                    for v in ('DisplayIcon', 'UninstallString'):
                        exe = _reg_exe_path(val(k, v))
                        folders.append(os.path.dirname(exe) if exe else None)
                    for f in folders:
                        if f and f.strip().strip('"'):
                            found.append({'folder': f.strip().strip('"'), 'version': version, 'name': name})
    for hive, view in views:  # SOFTWARE\KiCad: any string value that is a folder, one level of version subkeys
        try:
            root = winreg.OpenKey(hive, r'SOFTWARE\KiCad', 0, winreg.KEY_READ | view)
        except OSError:
            continue
        with root:
            pending = [('', root)]
            for sub in subkeys(root):
                try:
                    pending.append((sub, winreg.OpenKey(root, sub)))
                except OSError:
                    pass
            for version, k in pending:
                for v in values(k):
                    v = _reg_exe_path(v) if v.lower().strip('"').endswith('.exe') else v.strip().strip('"')
                    if v and os.path.isfile(v):
                        v = os.path.dirname(v)
                    if v and os.path.isdir(v):
                        found.append({'folder': v, 'version': version, 'name': 'KiCad'})
                if k is not root:
                    k.Close()
    seen, out = set(), []
    for item in found:
        key = os.path.normcase(os.path.normpath(item['folder']))
        if key not in seen:
            seen.add(key)
            out.append(item)
    return sorted(out, key=lambda i: version_tuple(i['version']), reverse=True)


def _windows_drives():
    """Fixed local drives (C:\\, D:\\ ...). Network and removable drives are skipped: they can hang."""
    letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        mask = k32.GetLogicalDrives()
        return ['%s:\\' % c for i, c in enumerate(letters, start=2)
                if mask >> i & 1 and k32.GetDriveTypeW('%s:\\' % c) == 3]  # 3 = DRIVE_FIXED
    except Exception:
        return ['%s:\\' % c for c in letters if os.path.isdir('%s:\\' % c)]


def _flatpak_cli(which):
    fp = which('flatpak')
    if not fp:
        return None
    try:
        r = subprocess.run([fp, 'info', FLATPAK_ID], capture_output=True, timeout=15, **_proc_kw())
    except (OSError, subprocess.SubprocessError):
        return None
    return [fp, 'run', '--command=kicad-cli', FLATPAK_ID] if r.returncode == 0 else None


def _gather(platform=None, env=None, home=None, which=None, registry=None, drives=None, root=''):
    """Every place kicad-cli could be, in priority order, whether it exists or not.
    Returns (items [(cli, source)], searched [short labels], notes [problems found on the way])."""
    platform = platform or sys.platform
    env = os.environ if env is None else env
    home = home or os.path.expanduser('~')
    if which is None:
        def which(name):
            return shutil.which(name, path=env.get('PATH', os.defpath))
    exe = _cli_name(platform)
    items, searched, notes = [], [], []

    def look(label):
        if label not in searched:
            searched.append(label)

    def R(p):  # filesystem root for the POSIX locations (tests point it at a fake tree)
        return os.path.join(root, p.lstrip('/')) if root else p

    # 1. Overrides: what the user saved, then KICAD_CLI, then PATH.
    saved = load_config(config_path(platform, env, home)).get('kicad_cli')
    if saved:
        look('saved setting')
        if isinstance(saved, list) and saved and all(isinstance(s, str) for s in saved):
            items.append((saved, 'saved setting'))
        else:
            hits = resolve_kicad_path(saved, platform)
            items += [(c, 'saved setting') for c in hits]
            if not hits:
                notes.append('The saved KiCad location %s no longer has kicad-cli in it.' % saved)
    kc = env.get('KICAD_CLI')
    if kc:
        look('KICAD_CLI')
        hits = resolve_kicad_path(kc, platform)
        items += [(c, 'KICAD_CLI') for c in hits]
        if not hits:
            notes.append('KICAD_CLI is set to %s, but there is no kicad-cli there.' % kc)
    look('PATH')
    hit = which('kicad-cli')
    if hit:
        items.append((hit, 'PATH'))

    # 2. Where installers put it on this OS.
    if platform == 'win32':
        bases = []  # (folder that may hold KiCad\, source, list it in `searched`)
        for var in ('ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'):
            if env.get(var):
                bases.append((env[var], 'Program Files', True))
        local = env.get('LOCALAPPDATA') or os.path.join(home, 'AppData', 'Local')
        bases.append((os.path.join(local, 'Programs'), 'per-user install', True))
        if drives is None:
            drives = _windows_drives() if sys.platform == 'win32' else []
        for d in drives:  # X:\Program Files\KiCad, X:\Program Files (x86)\KiCad, X:\KiCad
            bases += [(os.path.join(d, 'Program Files'), 'Program Files', False),
                      (os.path.join(d, 'Program Files (x86)'), 'Program Files', False), (d, 'Program Files', False)]
        seen = set()
        for base, source, show in bases:
            key = os.path.normcase(os.path.normpath(base))
            if key in seen:
                continue
            seen.add(key)
            kdir = os.path.join(base, 'KiCad')
            if show:
                look(kdir)
            if not os.path.isdir(kdir):
                continue
            bins = _newest_first(glob.glob(os.path.join(glob.escape(kdir), '*', 'bin')),
                                 lambda p: os.path.basename(os.path.dirname(p)))
            for b in bins + [os.path.join(kdir, 'bin')]:
                items.append((os.path.join(b, exe), source))
        if drives:
            look('X:\\Program Files\\KiCad on drives ' + ' '.join(d[:2] for d in drives))
        look('registry')
        for entry in (registry or registry_installs)():
            for c in (os.path.join(entry['folder'], 'bin', exe), os.path.join(entry['folder'], exe)):
                items.append((c, 'registry'))
    elif platform == 'darwin':
        for apps in (R('/Applications'), os.path.join(home, 'Applications')):
            look(apps)
            e = glob.escape(apps)
            bundles = [os.path.join(apps, 'KiCad', 'KiCad.app'), os.path.join(apps, 'KiCad.app')]
            bundles += _newest_first(glob.glob(os.path.join(e, 'KiCad*', 'KiCad.app')) + glob.glob(os.path.join(e, 'KiCad*.app')),
                                     lambda p: os.path.relpath(p, apps))
            for b in bundles:
                items.append((os.path.join(b, 'Contents', 'MacOS', 'kicad-cli'), 'Applications'))
        for d in ('/opt/homebrew/bin', '/usr/local/bin'):
            items.append((os.path.join(R(d), 'kicad-cli'), 'Homebrew'))
    else:
        for d in ('/usr/bin', '/usr/local/bin', '/opt/kicad/bin'):
            look(d)
            items.append((os.path.join(R(d), 'kicad-cli'), 'system'))
        look('/snap/bin')
        items += [(R('/snap/bin/kicad-cli'), 'snap'), (R('/snap/bin/kicad.kicad-cli'), 'snap')]
        look('flatpak')
        fp = _flatpak_cli(which)
        if fp:
            items.append((fp, 'flatpak'))
    return items, searched, notes


def _existing(items):
    out, seen = [], set()
    for cli, source in items:
        if isinstance(cli, str):
            if not os.path.isfile(cli):  # isfile, not os.access(X_OK): that lies on Windows
                continue
            key = os.path.normcase(os.path.realpath(cli))
        else:
            key = tuple(cli)
        if key not in seen:
            seen.add(key)
            out.append((cli, source))
    return out


def candidate_paths(platform=None, env=None, home=None, **kw):
    """Ordered [(cli, source)] of kicad-cli candidates that exist on disk (not yet run).
    cli is a path, or an argv list for flatpak. Extra keywords (for tests): which, registry, drives, root."""
    return _existing(_gather(platform, env, home, **kw)[0])


def _gui_for(cli, platform):
    """The KiCad app next to a kicad-cli path (whether or not kicad-cli exists), or None."""
    if not isinstance(cli, str):
        return '%s (flatpak)' % FLATPAK_ID if cli and FLATPAK_ID in cli else None
    d = os.path.dirname(cli)
    if platform == 'darwin' and d.endswith(os.path.join('Contents', 'MacOS')):
        app = os.path.dirname(os.path.dirname(d))
        return app if os.path.isdir(app) else None
    g = os.path.join(d, 'kicad.exe' if platform == 'win32' else 'kicad')
    return g if os.path.isfile(g) else None


def _gui_version(gui, platform):
    """Best guess at the KiCad version of an app without kicad-cli ('6.0'), or None."""
    if platform == 'darwin' and gui.endswith('.app'):
        try:
            with open(os.path.join(gui, 'Contents', 'Info.plist'), 'rb') as f:
                info = plistlib.load(f)
            v = info.get('CFBundleShortVersionString') or info.get('CFBundleVersion')
            if v and version_tuple(v):
                return str(v)
        except Exception:
            pass
    for part in reversed(re.split(r'[\\/]+', gui)[:-1]):
        m = re.fullmatch(r'(?:kicad[ _-]*)?(\d+(?:\.\d+)*)(?:\.app)?', part.strip(), re.I)
        if m:
            return m.group(1)
    return None


def _detect(platform=None, env=None, home=None, **kw):
    """Run detection. Returns (public dict, cli-or-argv for running it)."""
    platform = platform or sys.platform
    items, searched, notes = _gather(platform, env, home, **kw)
    problems, old, best = list(notes), [], None
    for cli, source in _existing(items):
        try:
            ver, major = cli_version(cli)
        except (CliError, OSError, subprocess.SubprocessError, ValueError) as e:
            problems.append('kicad-cli at %s did not run: %s' % (cli_display(cli), e))
            continue
        if major < MIN_MAJOR:
            old.append((ver, cli))
            continue
        entry = {'cli': cli, 'version': ver, 'major': major, 'source': source}
        if source in OVERRIDE_SOURCES:  # something the user chose wins outright
            best = entry
            break
        if best is None or version_tuple(ver) > version_tuple(best['version']):
            best = entry
    result = {'found': bool(best), 'cli': None, 'version': None, 'major': None, 'source': None,
              'gui': None, 'problem': None, 'searched': searched}
    if best:
        result.update(cli=cli_display(best['cli']), version=best['version'], major=best['major'],
                      source=best['source'], gui=_gui_for(best['cli'], platform))
        return result, best['cli']
    guis = []
    for cli, _ in items:
        g = _gui_for(cli, platform)
        if g and g not in guis:
            guis.append(g)
    result['gui'] = guis[0] if guis else None
    if old:
        ver, cli = max(old, key=lambda o: version_tuple(o[0]))
        result['problem'] = ('KiCad %s found at %s; GFLUX needs KiCad 7 or newer for exports. '
                             'Update it from %s' % (ver, cli_display(cli), DOWNLOAD_URL))
    elif guis:
        hint = _gui_version(guis[0], platform)
        if hint and version_tuple(hint)[0] >= MIN_MAJOR:
            result['problem'] = ('KiCad %s found at %s, but its kicad-cli is missing. '
                                 'Repair or reinstall KiCad.' % (hint, guis[0]))
        else:
            result['problem'] = ('KiCad%s found at %s; GFLUX needs KiCad 7 or newer for exports '
                                 '(older versions have no kicad-cli). Update it from %s'
                                 % (' ' + hint if hint else '', guis[0], DOWNLOAD_URL))
    elif problems:
        result['problem'] = problems[0]
    return result, None


_detected = None                      # (public dict, cli) from the last detection
_state_lock = threading.Lock()
_refresh_lock = threading.Lock()


def _public(d):
    return dict(d, searched=list(d['searched']))


def refresh_kicad():
    """Look for KiCad again (after an install, or when the user asks) and cache the result."""
    global _detected
    with _refresh_lock:
        _version_cache.clear()
        found = _detect()
        with _state_lock:
            _detected = found
        return _public(found[0])


def detect_kicad(**kw):
    """KiCad detection: {found, cli, version, major, source, gui, problem, searched}.
    Without arguments the result is cached (refresh_kicad() re-detects). With arguments
    (platform, env, home, which, registry, drives, root) it runs fresh and is not cached."""
    if kw:
        return _detect(**kw)[0]
    with _state_lock:
        cached = _detected
    return _public(cached[0]) if cached else refresh_kicad()


def find_cli():
    """The validated kicad-cli (path, or argv list for flatpak) from the cache, or None."""
    detect_kicad()
    with _state_lock:
        return _detected[1] if _detected else None


def describe_kicad(info):
    """Console lines (ASCII text) summarising a detection result."""
    if info['found']:
        return ['KiCad %s found (%s): %s' % (info['version'], info['source'], info['cli'])]
    lines = [info['problem'] or 'KiCad was not found on this computer.']
    if info.get('searched'):
        lines.append('Looked in: ' + ', '.join(info['searched']))
    return lines


# ------------------------------------------------------------ "Locate KiCad" picker

class PickerUnavailable(Exception):
    pass


class PickerBusy(Exception):
    pass


class MainThreadRunner:
    """Runs callables on the thread that calls run_pending() (the main thread).
    Tk dialogs must run on the main thread on macOS."""

    def __init__(self):
        self._q = queue.Queue()

    def __call__(self, fn, timeout=900):
        done, box = threading.Event(), {}

        def task():
            try:
                box['value'] = fn()
            except BaseException as e:  # hand it back to the caller's thread
                box['error'] = e
            finally:
                done.set()
        self._q.put(task)
        if not done.wait(timeout):
            raise PickerUnavailable('the GFLUX window did not respond')
        if 'error' in box:
            raise box['error']
        return box.get('value')

    def run_pending(self, seconds):
        end = time.monotonic() + seconds
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return
            try:
                task = self._q.get(timeout=min(left, 0.5))
            except queue.Empty:
                continue
            task()


_ui_runner = None
_pick_lock = threading.Lock()
_tk_ok = None


def set_ui_runner(runner):
    """Route file pickers through runner (a MainThreadRunner driven by the main thread)."""
    global _ui_runner
    _ui_runner = runner


def picker_available():
    """True if a native file picker can be shown here (tkinter plus a display)."""
    global _tk_ok
    if sys.platform not in ('win32', 'darwin') and not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
        return False
    if _tk_ok is None:
        try:
            import tkinter  # noqa: F401
            import tkinter.filedialog  # noqa: F401
            _tk_ok = True
        except Exception:
            _tk_ok = False
    return _tk_ok


def _tk_pick():
    try:
        import tkinter
        from tkinter import filedialog
    except Exception as e:
        raise PickerUnavailable('tkinter is not available: %s' % e)
    try:
        root = tkinter.Tk()
    except Exception as e:
        raise PickerUnavailable('could not open a window: %s' % e)
    try:
        root.withdraw()
        root.attributes('-topmost', True)
        root.update()
        if sys.platform == 'darwin':
            path = filedialog.askdirectory(parent=root, mustexist=True, initialdir='/Applications',
                                           title='Select KiCad.app, or the KiCad folder in Applications')
        elif sys.platform == 'win32':
            pf = os.environ.get('ProgramFiles') or 'C:\\Program Files'
            init = os.path.join(pf, 'KiCad') if os.path.isdir(os.path.join(pf, 'KiCad')) else pf
            path = filedialog.askopenfilename(
                parent=root, initialdir=init,
                title='Select kicad.exe or kicad-cli.exe (usually Program Files\\KiCad\\<version>\\bin)',
                filetypes=[('KiCad programs', 'kicad-cli.exe kicad.exe'), ('Programs', '*.exe'), ('All files', '*.*')])
        else:
            path = filedialog.askopenfilename(parent=root, initialdir='/usr/bin', title='Select kicad-cli',
                                              filetypes=[('KiCad', 'kicad-cli kicad'), ('All files', '*')])
        return path or None
    finally:
        try:
            root.destroy()
        except Exception:
            pass


def pick_kicad_path():
    """Show a native file picker on this computer. Returns the chosen path, or None if cancelled.
    Raises PickerUnavailable (no tkinter / no display) or PickerBusy (one is already open)."""
    if not picker_available():
        raise PickerUnavailable('No file picker is available on this computer (tkinter or a display is missing).')
    if not _pick_lock.acquire(blocking=False):
        raise PickerBusy('A KiCad file picker is already open on this computer.')
    try:
        runner = _ui_runner
        if runner is not None and threading.current_thread() is not threading.main_thread():
            return runner(_tk_pick)
        return _tk_pick()
    finally:
        _pick_lock.release()


def locate_kicad(path, platform=None):
    """Check a path the user picked or typed. If it leads to a working kicad-cli (KiCad 7+),
    save it as the setting and refresh detection. Returns (ok, message)."""
    platform = platform or sys.platform
    exe = _cli_name(platform)
    clis = resolve_kicad_path(path, platform, up=2)
    if not clis:
        return False, ('No %s found at %s. Pick %s, %s, KiCad.app or the KiCad install folder.'
                       % (exe, path, exe, 'kicad.exe' if platform == 'win32' else 'kicad'))
    errors = []
    for cli in clis:
        try:
            ver, major = cli_version(cli)
        except (CliError, OSError, subprocess.SubprocessError, ValueError) as e:
            errors.append('kicad-cli at %s did not run: %s' % (cli, e))
            continue
        if major < MIN_MAJOR:
            errors.append('KiCad %s found at %s; GFLUX needs KiCad 7 or newer for exports.' % (ver, cli))
            continue
        save_config({'kicad_cli': cli})
        refresh_kicad()
        return True, 'KiCad %s found at %s. GFLUX will use it from now on.' % (ver, cli)
    return False, errors[0]


# ------------------------------------------------------------ KiCad install

DOWNLOAD_PAGES = {
    'win32': 'https://www.kicad.org/download/windows/',
    'darwin': 'https://www.kicad.org/download/macos/',
}
_install = {'state': 'idle', 'message': '', 'url': None}
_install_lock = threading.Lock()


def install_plan():
    """(command or None, manual download page, human description) for this OS."""
    url = DOWNLOAD_PAGES.get(sys.platform, 'https://www.kicad.org/download/linux/')
    if sys.platform == 'win32':
        winget = shutil.which('winget')
        if winget:
            return ([winget, 'install', '--id', 'KiCad.KiCad', '-e',
                     '--accept-package-agreements', '--accept-source-agreements'], url, 'winget (Windows Package Manager)')
    elif sys.platform == 'darwin':
        brew = shutil.which('brew') or next((b for b in ('/opt/homebrew/bin/brew', '/usr/local/bin/brew') if os.path.isfile(b)), None)
        if brew:
            return ([brew, 'install', '--cask', 'kicad'], url, 'Homebrew')
    return (None, url, 'the KiCad website')


def install_status():
    with _install_lock:
        return dict(_install)


def start_install(open_page=True):
    """Install KiCad in the background. Returns the status right after starting.
    Without a package manager, opens the official download page instead.
    Detection is re-run when the installer finishes."""
    with _install_lock:
        if _install['state'] == 'running':
            return dict(_install)
        if find_cli():
            _install.update(state='done', message='KiCad is already installed.', url=None)
            return dict(_install)
        cmd, url, how = install_plan()
        if not cmd:
            _install.update(state='manual', url=url,
                            message='Download KiCad from %s, install it, then click Check again (or restart GFLUX).' % url)
            if open_page:
                webbrowser.open(url)
            return dict(_install)
        _install.update(state='running', url=url,
                        message='Installing KiCad with %s. Accept the Windows/macOS permission prompt if one appears. '
                                'This download is about 1 GB and can take several minutes.' % how)

    def work():
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, errors='replace', timeout=3600, **_proc_kw())
            tail = '\n'.join((r.stdout + r.stderr).strip().splitlines()[-6:])
            info = refresh_kicad()
            with _install_lock:
                if info['found']:
                    _install.update(state='done', message='KiCad %s is installed.' % info['version'])
                elif r.returncode == 0:
                    _install.update(state='done', message='The installer finished, but GFLUX could not find kicad-cli yet. '
                                    'Use "Locate KiCad" to point GFLUX at it.')
                else:
                    _install.update(state='failed', message='The installer stopped (%s). You can install KiCad from %s instead.\n%s'
                                    % (r.returncode, url, tail))
        except (OSError, subprocess.SubprocessError) as e:
            with _install_lock:
                _install.update(state='failed', message='Could not run the installer: %s. Get KiCad from %s.' % (e, url))

    threading.Thread(target=work, daemon=True).start()
    return install_status()


# ------------------------------------------------------------ HTTP

# ------------------------------------------------- finalize: open in KiCad

def documents_dir():
    """Where finalized projects are saved: Documents/GFLUX/<name>."""
    override = os.environ.get('GFLUX_PROJECTS')
    if override:
        return override
    home = os.path.expanduser('~')
    docs = os.path.join(os.environ.get('USERPROFILE', home), 'Documents') if sys.platform == 'win32' else os.path.join(home, 'Documents')
    return os.path.join(docs if os.path.isdir(docs) else home, 'GFLUX')


def editor_command(tool, path, cli=None, platform=None):
    """argv that opens `path` in KiCad's schematic ('eeschema') or PCB ('pcbnew') editor."""
    platform = platform or sys.platform
    cli = cli if cli is not None else find_cli()
    if not cli:
        return None
    if isinstance(cli, (list, tuple)):  # flatpak
        return [a if not a.startswith('--command=') else '--command=' + tool for a in cli] + [path]
    bindir = os.path.dirname(cli)
    if platform == 'darwin':
        # .../KiCad.app/Contents/MacOS/kicad-cli -> .../KiCad.app/Contents/Applications/Eeschema.app
        app = os.path.join(os.path.dirname(bindir), 'Applications', tool.capitalize() + '.app')
        return ['open', '-a', app, path] if os.path.isdir(app) else ['open', path]
    exe = os.path.join(bindir, tool + ('.exe' if platform == 'win32' else ''))
    if os.path.isfile(exe):
        return [exe, path]
    found = shutil.which(tool)
    return [found, path] if found else None


def launch(argv):
    """Start a program without waiting for it or tying it to this console."""
    if os.environ.get('GFLUX_NO_LAUNCH'):  # tests
        return
    kw = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL}
    if sys.platform == 'win32':
        kw['creationflags'] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw['start_new_session'] = True
    subprocess.Popen(argv, **kw)


def open_in_kicad(data):
    """Save the project under Documents/GFLUX/<name> and open its schematic and PCB in KiCad."""
    name = safe_name(data.get('name'))
    for key in ('sch', 'pcb'):
        if not isinstance(data.get(key), str) or not data[key].strip():
            raise ValueError('missing %s' % key)
    folder = os.path.join(documents_dir(), name)
    os.makedirs(folder, exist_ok=True)
    files = {name + '.kicad_sch': data['sch'], name + '.kicad_pcb': data['pcb']}
    if isinstance(data.get('pro'), str):
        files[name + '.kicad_pro'] = data['pro']
    if isinstance(data.get('ino'), str):
        files[os.path.join(name, name + '.ino')] = data['ino']  # Arduino wants a matching folder
    for rel, text in files.items():
        path = os.path.join(folder, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write(path, text)
    opened, problems = [], []
    if not find_cli():
        problems.append(detect_kicad().get('problem') or 'KiCad is not installed')
    else:
        for tool, rel in (('eeschema', name + '.kicad_sch'), ('pcbnew', name + '.kicad_pcb')):
            argv = editor_command(tool, os.path.join(folder, rel))
            if not argv:
                problems.append('could not find the KiCad %s editor' % ('schematic' if tool == 'eeschema' else 'PCB'))
                continue
            try:
                launch(argv)
                opened.append('schematic' if tool == 'eeschema' else 'pcb')
            except OSError as e:
                problems.append(str(e))
    return {'ok': not problems, 'folder': folder, 'files': sorted(files), 'opened': opened, 'problems': problems}


def health(launcher=False):
    """What the web page shows. ok/bridge/version keep their old meaning."""
    d = detect_kicad()
    h = {'ok': d['found'], 'bridge': True, 'launcher': bool(launcher),
         'version': d['version'], 'major': d['major'], 'cli': d['cli'], 'source': d['source'],
         'gui': d['gui'], 'problem': d['problem'], 'searched': d['searched'],
         'checking': _refresh_lock.locked(), 'canInstall': install_plan()[0] is not None,
         'canLocate': picker_available(), 'install': install_status(), 'platform': sys.platform}
    if not d['found']:
        h['error'] = d['problem'] or ('KiCad (kicad-cli) was not found. Install KiCad 7 or newer, '
                                      'or use Locate KiCad if it is already installed.')
    return h


class Handler(SimpleHTTPRequestHandler):
    server_version = 'GFLUXBridge/1.1'

    def end_headers(self):
        origin = self.headers.get('Origin')
        self.send_header('Access-Control-Allow-Origin', origin or '*')
        if origin:
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Expose-Headers', 'Content-Disposition')
        self.send_header('Access-Control-Max-Age', '600')
        if self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-store')
        else:
            # Always ask before reusing a cached page file, so a new GFLUX
            # never runs with the old version's scripts.
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep the console readable: only report failures.
        if len(args) > 1 and str(args[1])[:1] in '45':
            sys.stderr.write('%s\n' % (fmt % args))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def send_json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def same_origin(self):
        """True for requests from the page this bridge serves (or non-browser clients)."""
        origin = self.headers.get('Origin')
        if not origin:
            return True
        port = self.server.server_address[1]
        return origin in ('http://localhost:%d' % port, 'http://127.0.0.1:%d' % port)

    def read_json(self, optional=False):
        """The JSON object in the body ({} if optional and empty). Raises ValueError."""
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = -1
        if optional and length == 0:
            return {}
        if length <= 0 or length > MAX_BODY:
            raise ValueError('expected a JSON body up to 25 MB')
        data = json.loads(self.rfile.read(length).decode('utf-8'))
        if not isinstance(data, dict):
            raise ValueError('JSON body must be an object')
        return data

    def health(self):
        return health(getattr(self.server, 'launcher', False))

    def do_GET(self):
        route = self.path.split('?')[0].rstrip('/')
        if route == '/api/app':
            return self.send_json(200, {'gflux': True, 'site': getattr(self.server, 'site_version', ''),
                                        'launcher': getattr(self.server, 'launcher', False)})
        if route == '/api/kicad/health':
            return self.send_json(200, self.health())
        if route == '/api/kicad/install':
            return self.send_json(200, install_status())
        if route == '/api/arduino/health':
            import arduino_bridge
            return self.send_json(200, arduino_bridge.health(refresh='refresh=1' in self.path))
        if route == '/api/arduino/setup':
            import arduino_bridge
            return self.send_json(200, arduino_bridge.setup_status())
        if self.path.startswith('/api/'):
            return self.send_json(404, {'ok': False, 'error': 'unknown endpoint'})
        return super().do_GET()

    def do_POST(self):
        route = self.path.split('?')[0].rstrip('/')
        if route == '/api/app/quit':
            # A newer GFLUX asks this one to make way. Never from a web page.
            if self.headers.get('Origin') or not getattr(self.server, 'launcher', False):
                return self.send_json(403, {'ok': False, 'error': 'not allowed'})
            self.send_json(200, {'ok': True})
            threading.Timer(0.3, lambda: os._exit(0)).start()
            return
        if route in ('/api/arduino/check', '/api/arduino/setup', '/api/arduino/open'):
            # Compiling and installing run programs on this computer: GFLUX's own page only.
            if not self.same_origin():
                return self.send_json(403, {'ok': False, 'error': 'this request must come from the GFLUX page itself'})
            import arduino_bridge
            try:
                data = self.read_json(optional=True)
                if route == '/api/arduino/setup':
                    return self.send_json(200, arduino_bridge.start_setup(data.get('libs')))
                if route == '/api/arduino/open':
                    return self.send_json(200, arduino_bridge.open_sketch(data.get('name'), data.get('code')))
                code = data.get('code')
                if not isinstance(code, str) or not code.strip():
                    raise ValueError('missing code')
                return self.send_json(200, arduino_bridge.compile_sketch(code, data.get('fqbn') or 'esp32:esp32:esp32'))
            except (ValueError, UnicodeDecodeError) as e:
                return self.send_json(400, {'ok': False, 'error': str(e)})
            except (OSError, subprocess.SubprocessError) as e:
                return self.send_json(500, {'ok': False, 'error': 'could not run arduino-cli: %s' % e})
        if route in ('/api/kicad/install', '/api/kicad/recheck', '/api/kicad/locate', '/api/kicad/open'):
            # Only GFLUX's own page may install, re-scan or open a picker, never another website.
            if not self.same_origin():
                return self.send_json(403, {'ok': False, 'error': 'this request must come from the GFLUX page itself'})
            if route == '/api/kicad/install':
                return self.send_json(200, start_install())
            if route == '/api/kicad/recheck':
                refresh_kicad()
                return self.send_json(200, self.health())
            if route == '/api/kicad/open':
                try:
                    return self.send_json(200, open_in_kicad(self.read_json()))
                except (ValueError, UnicodeDecodeError) as e:
                    return self.send_json(400, {'ok': False, 'error': str(e)})
                except OSError as e:
                    return self.send_json(500, {'ok': False, 'error': 'could not save the project: %s' % e})
            return self.locate()
        jobs = {'/api/kicad/schematic': export_schematic, '/api/kicad/pcb': export_pcb}
        if route not in jobs:
            return self.send_json(404, {'ok': False, 'error': 'unknown endpoint'})
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = -1
        if length > MAX_BODY:
            return self.send_json(413, {'ok': False, 'error': 'expected a JSON body up to 25 MB'})
        try:
            data = self.read_json()
        except (ValueError, UnicodeDecodeError) as e:
            return self.send_json(400, {'ok': False, 'error': 'bad JSON: %s' % e})
        cli = find_cli()
        if not cli:
            info = detect_kicad()
            return self.send_json(503, {'ok': False, 'error': info['problem'] or 'kicad-cli not found. Install KiCad 7 or newer.'})
        try:
            name, blob = jobs[route](cli, data)
        except ValueError as e:
            return self.send_json(400, {'ok': False, 'error': str(e)})
        except CliError as e:
            return self.send_json(500, {'ok': False, 'error': str(e), 'stderr': e.stderr})
        except Exception as e:  # keep the server alive and tell the page what happened
            return self.send_json(500, {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)})
        suffix = '-schematic' if route.endswith('schematic') else '-pcb'
        self.send_response(200)
        self.send_header('Content-Type', 'application/zip')
        self.send_header('Content-Length', str(len(blob)))
        self.send_header('Content-Disposition', 'attachment; filename="%s%s.zip"' % (name, suffix))
        self.end_headers()
        self.wfile.write(blob)

    def locate(self):
        """POST /api/kicad/locate [{path}]: without a path, open a file picker on this computer."""
        try:
            path = self.read_json(optional=True).get('path')
        except (ValueError, UnicodeDecodeError) as e:
            return self.send_json(400, {'ok': False, 'error': 'bad JSON: %s' % e})
        if not (isinstance(path, str) and path.strip()):
            try:
                path = pick_kicad_path()
            except PickerUnavailable as e:
                return self.send_json(501, {'ok': False, 'error': str(e)})
            except PickerBusy as e:
                return self.send_json(409, {'ok': False, 'error': str(e)})
        if not path:
            return self.send_json(200, dict(self.health(), located=False, cancelled=True, message='No file was picked.'))
        ok, message = locate_kicad(path)
        h = dict(self.health(), located=ok, cancelled=False, message=message, picked=path)
        if not ok and not h['ok']:
            h['error'] = message
        return self.send_json(200, h)


def site_version(root):
    """Fingerprint of the site files, so two GFLUX apps can tell if they match."""
    h = hashlib.sha1()
    for folder, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in ('build', 'dist', 'tools', '.git'))
        for name in sorted(files):
            if name.endswith(('.html', '.js', '.css')):
                path = os.path.join(folder, name)
                h.update(os.path.relpath(path, root).replace(os.sep, '/').encode())
                with open(path, 'rb') as f:
                    h.update(f.read())
    return h.hexdigest()[:12]


def make_server(host='127.0.0.1', port=8765, root=None, launcher=False):
    """HTTP server for the GFLUX site (root) plus the KiCad API.
    launcher=True when running inside the GFLUX app (reported by /api/kicad/health)."""
    Handler.extensions_map.update({'.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml'})
    httpd = ThreadingHTTPServer((host, port), partial(Handler, directory=root or ROOT))
    httpd.daemon_threads = True
    httpd.launcher = bool(launcher)
    httpd.site_version = site_version(root or ROOT)
    return httpd


def main():
    ap = argparse.ArgumentParser(description='Serve GFLUX and bridge it to kicad-cli.')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1', help='interface to bind (default: localhost only)')
    args = ap.parse_args()
    httpd = make_server(args.host, args.port)
    info = detect_kicad()
    print('GFLUX:  http://localhost:%d/' % args.port)
    for line in describe_kicad(info):
        print('KiCad:  ' + line)
    sys.stdout.flush()
    runner = MainThreadRunner()  # file pickers run here, on the main thread
    set_ui_runner(runner)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        while True:
            runner.run_pending(3600)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        httpd.server_close()


if __name__ == '__main__':
    main()
