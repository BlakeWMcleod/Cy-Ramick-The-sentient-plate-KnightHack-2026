#!/usr/bin/env python3
"""GFLUX local KiCad bridge (Python 3 standard library only).

    python3 gflux/tools/kicad_bridge.py [--port 8765] [--host 127.0.0.1]

Serves the gflux/ folder at http://localhost:8765/ and exposes kicad-cli:

    GET  /api/kicad/health     -> {"ok": true, "bridge": true, "version": "7.0.11", "cli": "/usr/bin/kicad-cli"}
    GET  /api/kicad/install    -> install status {"state": "idle|running|done|failed|manual", ...}
    POST /api/kicad/install    -> start installing KiCad (winget / Homebrew), same-origin requests only
    POST /api/kicad/schematic  {name, sch}            -> zip: .kicad_sch, -schematic.pdf, -schematic.svg
    POST /api/kicad/pcb        {name, pcb, sch?, pro?} -> zip: .kicad_pcb, gerbers/ + drill, -pcb.pdf

CORS (including Chrome's Private Network Access preflight) is enabled, so a
copy of GFLUX hosted elsewhere can still talk to the bridge on localhost.
Errors come back as JSON: {"ok": false, "error": "...", "stderr": "..."}.
Works with kicad-cli 7, 8 and 9.
"""
import argparse
import glob
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import webbrowser
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # the gflux/ folder
MAX_BODY = 25 * 1024 * 1024
TIMEOUT = 180

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


def find_cli():
    env = os.environ.get('KICAD_CLI')
    candidates = [env] if env else []
    candidates.append(shutil.which('kicad-cli'))
    candidates += [
        '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli',
        os.path.expanduser('~/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'),
        '/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli', '/snap/bin/kicad-cli',
        '/var/lib/flatpak/exports/bin/org.kicad.KiCad',
    ]
    for base in (os.environ.get('ProgramFiles', r'C:\Program Files'), os.environ.get('ProgramFiles(x86)', '')):
        if base:  # newest version first: C:\Program Files\KiCad\9.0\bin\kicad-cli.exe
            candidates += sorted(glob.glob(os.path.join(base, 'KiCad', '*', 'bin', 'kicad-cli.exe')), reverse=True)
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK) and 'flatpak' not in c:
            return c
    return None


_version_cache = {}


def cli_version(cli):
    if cli not in _version_cache:
        r = subprocess.run([cli, 'version'], capture_output=True, text=True, timeout=30)
        m = re.search(r'(\d+)\.(\d+)(?:\.(\d+))?', r.stdout + r.stderr)
        if r.returncode != 0 or not m:
            raise CliError('kicad-cli did not report a version', r.stderr or r.stdout)
        _version_cache[cli] = (m.group(0), int(m.group(1)))
    return _version_cache[cli]


def run(cli, args, cwd):
    try:
        r = subprocess.run([cli] + args, cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT)
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


def export_schematic(cli, data):
    sch = data.get('sch')
    if not isinstance(sch, str) or '(kicad_sch' not in sch[:200]:
        raise ValueError('"sch" must be the text of a .kicad_sch file')
    name = safe_name(data.get('name'))
    with tempfile.TemporaryDirectory(prefix='gflux-sch-') as tmp:
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
    with tempfile.TemporaryDirectory(prefix='gflux-pcb-') as tmp:
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
    Without a package manager, opens the official download page instead."""
    with _install_lock:
        if _install['state'] == 'running':
            return dict(_install)
        if find_cli():
            _install.update(state='done', message='KiCad is already installed.', url=None)
            return dict(_install)
        cmd, url, how = install_plan()
        if not cmd:
            _install.update(state='manual', url=url,
                            message='Download KiCad from %s, install it, then restart GFLUX.' % url)
            if open_page:
                webbrowser.open(url)
            return dict(_install)
        _install.update(state='running', url=url,
                        message='Installing KiCad with %s. Accept the Windows/macOS permission prompt if one appears. '
                                'This download is about 1 GB and can take several minutes.' % how)

    def work():
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, errors='replace', timeout=3600)
            tail = '\n'.join((r.stdout + r.stderr).strip().splitlines()[-6:])
            ok = r.returncode == 0 or find_cli() is not None
            with _install_lock:
                if ok:
                    _install.update(state='done', message='KiCad is installed.')
                else:
                    _install.update(state='failed', message='The installer stopped (%s). You can install KiCad from %s instead.\n%s'
                                    % (r.returncode, url, tail))
        except (OSError, subprocess.TimeoutExpired) as e:
            with _install_lock:
                _install.update(state='failed', message='Could not run the installer: %s. Get KiCad from %s.' % (e, url))
        _version_cache.clear()

    threading.Thread(target=work, daemon=True).start()
    return install_status()


class Handler(SimpleHTTPRequestHandler):
    server_version = 'GFLUXBridge/1.0'

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

    def do_GET(self):
        route = self.path.split('?')[0].rstrip('/')
        if route == '/api/kicad/health':
            cli = find_cli()
            can_install = install_plan()[0] is not None
            if not cli:
                return self.send_json(200, {'ok': False, 'bridge': True, 'canInstall': can_install, 'install': install_status(),
                                            'error': 'kicad-cli not found. Install KiCad 7 or newer, '
                                            'or set KICAD_CLI to the full path of kicad-cli.'})
            try:
                version, _ = cli_version(cli)
            except (CliError, OSError, subprocess.TimeoutExpired) as e:
                return self.send_json(200, {'ok': False, 'bridge': True, 'error': str(e), 'stderr': getattr(e, 'stderr', '')})
            return self.send_json(200, {'ok': True, 'bridge': True, 'version': version, 'cli': cli})
        if route == '/api/kicad/install':
            return self.send_json(200, install_status())
        if self.path.startswith('/api/'):
            return self.send_json(404, {'ok': False, 'error': 'unknown endpoint'})
        return super().do_GET()

    def do_POST(self):
        route = self.path.split('?')[0].rstrip('/')
        if route == '/api/kicad/install':
            # Only GFLUX's own page may start an install, never another website.
            if not self.same_origin():
                return self.send_json(403, {'ok': False, 'error': 'install requests must come from the GFLUX page itself'})
            return self.send_json(200, start_install())
        jobs = {'/api/kicad/schematic': export_schematic, '/api/kicad/pcb': export_pcb}
        if route not in jobs:
            return self.send_json(404, {'ok': False, 'error': 'unknown endpoint'})
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY:
            return self.send_json(413 if length > MAX_BODY else 400, {'ok': False, 'error': 'expected a JSON body up to 25 MB'})
        try:
            data = json.loads(self.rfile.read(length).decode('utf-8'))
            if not isinstance(data, dict):
                raise ValueError('JSON body must be an object')
        except (ValueError, UnicodeDecodeError) as e:
            return self.send_json(400, {'ok': False, 'error': 'bad JSON: %s' % e})
        cli = find_cli()
        if not cli:
            return self.send_json(503, {'ok': False, 'error': 'kicad-cli not found. Install KiCad 7 or newer.'})
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


def make_server(host='127.0.0.1', port=8765, root=None):
    """HTTP server for the GFLUX site (root) plus the KiCad API."""
    Handler.extensions_map.update({'.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml'})
    return ThreadingHTTPServer((host, port), partial(Handler, directory=root or ROOT))


def main():
    ap = argparse.ArgumentParser(description='Serve GFLUX and bridge it to kicad-cli.')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1', help='interface to bind (default: localhost only)')
    args = ap.parse_args()
    httpd = make_server(args.host, args.port)
    cli = find_cli()
    try:
        kicad = '%s (%s)' % (cli, cli_version(cli)[0]) if cli else 'kicad-cli not found, exports disabled'
    except (CliError, OSError, subprocess.TimeoutExpired) as e:
        kicad = '%s is not working: %s' % (cli, e)
    print('GFLUX:  http://localhost:%d/' % args.port)
    print('KiCad:  ' + kicad)
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
