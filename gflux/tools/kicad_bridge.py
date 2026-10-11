#!/usr/bin/env python3
"""GFLUX local KiCad bridge (Python 3 standard library only).

    python3 gflux/tools/kicad_bridge.py [--port 8765] [--host 127.0.0.1]

Serves the gflux/ folder at http://localhost:8765/ and exposes kicad-cli:

    GET  /api/kicad/health     -> {"ok": true, "version": "7.0.11", "cli": "/usr/bin/kicad-cli"}
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

    def do_GET(self):
        if self.path.split('?')[0].rstrip('/') == '/api/kicad/health':
            cli = find_cli()
            if not cli:
                return self.send_json(200, {'ok': False, 'error': 'kicad-cli not found. Install KiCad 7 or newer, '
                                            'or set KICAD_CLI to the full path of kicad-cli.'})
            try:
                version, _ = cli_version(cli)
            except (CliError, OSError, subprocess.TimeoutExpired) as e:
                return self.send_json(200, {'ok': False, 'error': str(e), 'stderr': getattr(e, 'stderr', '')})
            return self.send_json(200, {'ok': True, 'version': version, 'cli': cli})
        if self.path.startswith('/api/'):
            return self.send_json(404, {'ok': False, 'error': 'unknown endpoint'})
        return super().do_GET()

    def do_POST(self):
        route = self.path.split('?')[0].rstrip('/')
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


def main():
    ap = argparse.ArgumentParser(description='Serve GFLUX and bridge it to kicad-cli.')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1', help='interface to bind (default: localhost only)')
    args = ap.parse_args()
    Handler.extensions_map.update({'.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml'})
    httpd = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=ROOT))
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
