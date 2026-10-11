"""GFLUX code checking with the real Arduino compiler (arduino-cli).

Used by kicad_bridge.py's HTTP server:

    GET  /api/arduino/health  -> {ok, cli, version, source, esp32, problem, setup}
    POST /api/arduino/check   {code, fqbn?} -> {ok, issues: [{line, col, level, msg}], needs: {core, headers}}
    POST /api/arduino/setup   {libs?: [...]} -> start installing arduino-cli / ESP32 support / libraries
    GET  /api/arduino/setup   -> setup status {state, message, step}

arduino-cli is found in this order: the path saved by GFLUX, ARDUINO_CLI, PATH,
the copy bundled inside Arduino IDE 2, common install folders, and finally a
copy GFLUX downloaded itself from downloads.arduino.cc.
"""
import glob
import io
import json
import os
import platform as _platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
import zipfile

import kicad_bridge as kb

ESP32_INDEX = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json'
DOWNLOADS = 'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_%s'
EXE = 'arduino-cli.exe' if sys.platform == 'win32' else 'arduino-cli'

_lock = threading.Lock()        # one compile / setup step at a time
_cache = {'info': None}
_setup = {'state': 'idle', 'message': '', 'step': ''}
_setup_lock = threading.Lock()


def gflux_home():
    """Folder for GFLUX's own downloads and build cache (next to its config file)."""
    return os.path.dirname(kb.config_path())


def ide_config():
    """Arduino IDE 2 keeps its arduino-cli settings here; reuse them so we see the same boards and libraries."""
    path = os.path.join(os.path.expanduser('~'), '.arduinoIDE', 'arduino-cli.yaml')
    return path if os.path.isfile(path) else None


def candidates():
    out = []
    saved = kb.load_config().get('arduino_cli')
    if saved:
        out.append((saved, 'saved setting'))
    if os.environ.get('ARDUINO_CLI'):
        out.append((os.environ['ARDUINO_CLI'], 'ARDUINO_CLI'))
    which = shutil.which('arduino-cli')
    if which:
        out.append((which, 'PATH'))
    bundled = os.path.join('resources', 'app', 'lib', 'backend', 'resources', EXE)
    if sys.platform == 'win32':
        for base in (os.environ.get('LOCALAPPDATA', ''), os.environ.get('ProgramFiles', ''), os.environ.get('ProgramFiles(x86)', '')):
            if base:
                out.append((os.path.join(base, 'Programs', 'Arduino IDE', bundled), 'Arduino IDE'))
                out.append((os.path.join(base, 'Arduino IDE', bundled), 'Arduino IDE'))
                out.append((os.path.join(base, 'Microsoft', 'WinGet', 'Links', EXE), 'winget'))
                out.append((os.path.join(base, 'Arduino CLI', EXE), 'Program Files'))
    elif sys.platform == 'darwin':
        for app in ['/Applications/Arduino IDE.app', os.path.expanduser('~/Applications/Arduino IDE.app')]:
            out.append((os.path.join(app, 'Contents', 'Resources', 'app', 'lib', 'backend', 'resources', EXE), 'Arduino IDE'))
        out += [('/opt/homebrew/bin/arduino-cli', 'Homebrew'), ('/usr/local/bin/arduino-cli', 'Homebrew')]
    else:
        out += [('/usr/bin/arduino-cli', 'system'), ('/usr/local/bin/arduino-cli', 'system'),
                (os.path.expanduser('~/bin/arduino-cli'), 'home'), (os.path.expanduser('~/.local/bin/arduino-cli'), 'home')]
        out += [(p, 'Arduino IDE') for p in glob.glob(os.path.expanduser('~/*/resources/app/lib/backend/resources/arduino-cli'))]
    out.append((os.path.join(gflux_home(), 'arduino-cli', EXE), 'downloaded by GFLUX'))
    return out


def run(cli, args, timeout=600):
    argv = [cli]
    cfg = ide_config()
    if cfg:
        argv += ['--config-file', cfg]
    return subprocess.run(argv + args, capture_output=True, text=True, errors='replace', timeout=timeout, **kb._proc_kw())


def find_arduino(refresh=False):
    if _cache['info'] and not refresh:
        return _cache['info']
    info = {'ok': False, 'cli': None, 'version': None, 'source': None, 'esp32': False, 'problem': None}
    for path, source in candidates():
        if not path or not os.path.isfile(path):
            continue
        try:
            r = run(path, ['version'], timeout=30)
        except (OSError, subprocess.SubprocessError):
            continue
        m = re.search(r'Version:\s*([\w.\-]+)', r.stdout + r.stderr)
        if r.returncode != 0 or not m:
            continue
        info.update(ok=True, cli=path, version=m.group(1), source=source)
        try:
            cores = run(path, ['core', 'list', '--format', 'json'], timeout=60).stdout
            info['esp32'] = 'esp32:esp32' in cores
        except (OSError, subprocess.SubprocessError):
            pass
        if not info['esp32']:
            info['problem'] = 'ESP32 board support is not installed yet.'
        break
    else:
        info['problem'] = 'Arduino (arduino-cli) was not found on this computer.'
    _cache['info'] = info
    return info


def find_ide():
    """The Arduino IDE app, if installed: argv prefix that opens a sketch in it."""
    if sys.platform == 'win32':
        for base in (os.environ.get('LOCALAPPDATA', ''), os.environ.get('ProgramFiles', ''), os.environ.get('ProgramFiles(x86)', '')):
            for rel in (os.path.join('Programs', 'Arduino IDE', 'Arduino IDE.exe'), os.path.join('Arduino IDE', 'Arduino IDE.exe'), os.path.join('Arduino', 'arduino.exe')):
                path = os.path.join(base, rel)
                if base and os.path.isfile(path):
                    return [path]
    elif sys.platform == 'darwin':
        for app in ('/Applications/Arduino IDE.app', os.path.expanduser('~/Applications/Arduino IDE.app'), '/Applications/Arduino.app'):
            if os.path.isdir(app):
                return ['open', '-a', app]
    else:
        for name in ('arduino-ide', 'arduino'):
            path = shutil.which(name)
            if path:
                return [path]
    return None


def health(refresh=False):
    info = dict(find_arduino(refresh))
    ide = find_ide()
    info['ide'] = ide[-1] if ide else None
    info['setup'] = setup_status()
    return info


def open_sketch(name, code):
    """Save the sketch as Documents/GFLUX/<name>/<name>/<name>.ino and open it in the Arduino IDE."""
    name = kb.safe_name(name)
    if not isinstance(code, str) or not code.strip():
        raise ValueError('missing code')
    folder = os.path.join(kb.documents_dir(), name, name)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, name + '.ino')
    kb.write(path, code)
    ide = find_ide()
    if ide:
        kb.launch(ide + [path])
        return {'ok': True, 'path': path, 'opened': 'Arduino IDE'}
    # No IDE found: let the computer open .ino files with whatever it uses for them.
    if not os.environ.get('GFLUX_NO_LAUNCH'):
        if sys.platform == 'win32':
            os.startfile(path)  # noqa: S606  (opens with the associated app)
        else:
            kb.launch(['open' if sys.platform == 'darwin' else 'xdg-open', path])
    return {'ok': True, 'path': path, 'opened': 'default app', 'note': 'Arduino IDE not found, so it opened with your default app.'}


# ------------------------------------------------------------------- checking

LINE = re.compile(r'gflux_check\.ino:(\d+):(?:(\d+):)?\s*(fatal error|error|warning):\s*(.*)')


def parse_output(text):
    """Compiler output -> issues (line numbers are the user's lines)."""
    issues, headers, seen = [], [], set()
    for raw in text.splitlines():
        m = LINE.search(raw)
        if not m:
            continue
        line, col, level, msg = int(m.group(1)), int(m.group(2) or 0), m.group(3), m.group(4).strip()
        h = re.match(r'([\w./-]+\.h(?:pp)?): No such file or directory', msg)
        if h:
            headers.append(os.path.basename(h.group(1)))
        key = (line, msg)
        if key in seen:
            continue
        seen.add(key)
        issues.append({'line': line, 'col': col, 'level': 'warn' if level == 'warning' else 'error', 'msg': msg})
    return issues, headers


def compile_sketch(code, fqbn='esp32:esp32:esp32'):
    info = find_arduino()
    if not info['ok']:
        return {'ok': False, 'needs': {'cli': True}, 'error': info['problem'], 'issues': []}
    if not re.fullmatch(r'[\w:.\-=,]+', fqbn or ''):
        raise ValueError('bad board name')
    with _lock:
        tmp = tempfile.mkdtemp(prefix='gflux-ino-')
        try:
            sketch = os.path.join(tmp, 'gflux_check')
            os.makedirs(sketch)
            kb.write(os.path.join(sketch, 'gflux_check.ino'), code)
            # Reusing the build folder makes every check after the first much faster.
            build = os.path.join(gflux_home(), 'build', re.sub(r'\W+', '_', fqbn))
            os.makedirs(build, exist_ok=True)
            t0 = time.time()
            r = run(info['cli'], ['compile', '--fqbn', fqbn, '--build-path', build, '--warnings', 'default', sketch], timeout=900)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    out = r.stdout + '\n' + r.stderr
    issues, headers = parse_output(out)
    needs = {'core': bool(re.search(r"platform not installed|Platform '?esp32:esp32'? not found|Invalid FQBN", out, re.I)), 'headers': headers}
    ok = r.returncode == 0
    res = {'ok': ok, 'issues': issues, 'needs': needs, 'seconds': round(time.time() - t0, 1)}
    if not ok and not issues and not needs['core']:
        res['error'] = '\n'.join(l for l in out.strip().splitlines()[-4:])
    return res


# --------------------------------------------------------------------- setup

def setup_status():
    with _setup_lock:
        return dict(_setup)


def _download_cli():
    """Fetch the official arduino-cli into GFLUX's folder. Returns its path."""
    machine = _platform.machine().lower()
    if sys.platform == 'win32':
        name = 'Windows_64bit.zip'
    elif sys.platform == 'darwin':
        name = 'macOS_ARM64.tar.gz' if machine in ('arm64', 'aarch64') else 'macOS_64bit.tar.gz'
    else:
        name = 'Linux_ARM64.tar.gz' if machine in ('arm64', 'aarch64') else 'Linux_64bit.tar.gz'
    dest = os.path.join(gflux_home(), 'arduino-cli')
    os.makedirs(dest, exist_ok=True)
    with urllib.request.urlopen(DOWNLOADS % name, timeout=120) as resp:
        data = resp.read()
    if name.endswith('.zip'):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            z.extract(EXE, dest)
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as t:
            t.extract(t.getmember(EXE), dest)
    path = os.path.join(dest, EXE)
    os.chmod(path, 0o755)
    return path


def start_setup(libs=None):
    """Install whatever is missing for code checks: arduino-cli, ESP32 support, libraries."""
    libs = [l for l in (libs or []) if isinstance(l, str) and re.fullmatch(r"[\w .+\-()]{1,80}", l)]
    with _setup_lock:
        if _setup['state'] == 'running':
            return dict(_setup)
        _setup.update(state='running', step='start', message='Getting Arduino ready…')

    def say(step, msg):
        with _setup_lock:
            _setup.update(step=step, message=msg)

    def work():
        try:
            info = find_arduino(refresh=True)
            cli = info['cli']
            if not cli:
                say('cli', 'Downloading arduino-cli from arduino.cc…')
                cli = _download_cli()
                kb.save_config({'arduino_cli': cli})
                info = find_arduino(refresh=True)
            with _lock:
                if not info['esp32']:
                    say('core', 'Installing ESP32 support (about 500 MB, a few minutes)…')
                    run(cli, ['core', 'update-index', '--additional-urls', ESP32_INDEX], timeout=600)
                    r = run(cli, ['core', 'install', 'esp32:esp32', '--additional-urls', ESP32_INDEX], timeout=3600)
                    if r.returncode != 0:
                        raise RuntimeError('ESP32 install failed: ' + (r.stderr or r.stdout).strip().splitlines()[-1])
                for lib in libs:
                    say('libs', 'Installing library %s…' % lib)
                    run(cli, ['lib', 'install', lib], timeout=600)
            find_arduino(refresh=True)
            with _setup_lock:
                _setup.update(state='done', step='done', message='Arduino is ready for code checks.')
        except Exception as e:  # report, don't crash the server
            with _setup_lock:
                _setup.update(state='failed', step='failed', message=str(e) or type(e).__name__)

    threading.Thread(target=work, daemon=True).start()
    return setup_status()
