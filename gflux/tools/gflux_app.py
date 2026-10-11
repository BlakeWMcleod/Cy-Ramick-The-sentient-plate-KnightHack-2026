#!/usr/bin/env python3
import argparse
import json
import os
import socket
import sys
import threading
import urllib.error
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kicad_bridge


def site_root():
    if getattr(sys, 'frozen', False):
        return os.path.join(sys._MEIPASS, 'site')
    return os.path.dirname(HERE)


def get_json(url, timeout=2):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def already_running(port):
    return running_site(port) is not None


def running_site(port):
    try:
        return get_json('http://127.0.0.1:%d/api/app' % port, timeout=2).get('site') or ''
    except urllib.error.HTTPError:
        pass
    except Exception:
        return None
    try:
        return '' if get_json('http://127.0.0.1:%d/api/kicad/health' % port, timeout=5).get('bridge') is True else None
    except Exception:
        return None


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if sys.platform != 'win32':
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def stop_old_gflux(port):
    try:
        req = urllib.request.Request('http://127.0.0.1:%d/api/app/quit' % port, data=b'{}', method='POST',
                                     headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=2).close()
    except Exception:
        if sys.platform == 'win32':
            kill_windows_listener(port)
    for _ in range(30):
        if port_free(port):
            return True
        threading.Event().wait(0.2)
    return False


def kill_windows_listener(port):
    import subprocess
    try:
        out = subprocess.run(['netstat', '-ano', '-p', 'TCP'], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return
    mine = {os.getpid(), os.getppid()}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[3] == 'LISTENING' and parts[1].endswith(':%d' % port) and parts[4].isdigit():
            pid = int(parts[4])
            if pid in mine:
                continue
            try:
                name = subprocess.run(['tasklist', '/FI', 'PID eq %d' % pid, '/FO', 'CSV', '/NH'],
                                      capture_output=True, text=True, timeout=10).stdout
            except Exception:
                continue
            if 'gflux' in name.lower():
                subprocess.run(['taskkill', '/F', '/PID', str(pid)], capture_output=True, timeout=10)


def free_port(start):
    for port in range(start, start + 50):
        if port_free(port):
            return port
    raise SystemExit('No free port found between %d and %d.' % (start, start + 49))


def say(text=''):
    try:
        print(text, flush=True)
    except UnicodeEncodeError:
        print(text.encode('ascii', 'replace').decode('ascii'), flush=True)


def interactive():
    return bool(sys.stdin) and sys.stdin.isatty()


def choose(prompt, keys, default):
    if not interactive():
        return default
    while True:
        try:
            answer = input(prompt).strip().lower()
        except EOFError:
            return default
        if not answer:
            return default
        if answer[0] in keys:
            return answer[0]
        say(' Please type one of: %s' % ', '.join(k.upper() for k in keys))


def show_kicad(info):
    for line in kicad_bridge.describe_kicad(info):
        say(' ' + line)


def install_kicad():
    status = kicad_bridge.start_install()
    say(' ' + status['message'])
    return status


def wait_for_install(runner):
    status = kicad_bridge.install_status()
    if status['state'] != 'running':
        return status
    while status['state'] == 'running':
        runner.run_pending(3)
        print('.', end='', flush=True)
        status = kicad_bridge.install_status()
    say()
    say(' ' + status['message'])
    if status['state'] == 'done':
        info = kicad_bridge.detect_kicad()
        show_kicad(info)
        if info['found']:
            say(' Reload GFLUX in your browser to use KiCad.')
    return status


def locate_kicad_console():
    path = None
    if kicad_bridge.picker_available():
        say(' A window will open: pick kicad-cli, kicad.exe, KiCad.app or the KiCad folder.')
        try:
            path = kicad_bridge.pick_kicad_path()
        except (kicad_bridge.PickerUnavailable, kicad_bridge.PickerBusy) as e:
            say(' Could not open a file picker (%s).' % e)
            path = False
        if path is None:
            say(' No file picked.')
            return False
    if not path:
        if not interactive():
            return False
        try:
            path = input(' Paste the full path to kicad-cli, kicad.exe, KiCad.app or the KiCad folder: ').strip()
        except EOFError:
            return False
        if not path:
            return False
    ok, message = kicad_bridge.locate_kicad(path)
    say(' ' + message)
    return ok


def offer_kicad(auto_yes):
    _, url, how = kicad_bridge.install_plan()
    say()
    say(' Without KiCad, GFLUX still works, but the Schematic and PCB buttons can only')
    say(' make KiCad files, not PDFs or Gerbers.')
    if auto_yes:
        return install_kicad()['state'] == 'running'
    while interactive():
        say()
        say(' [I] Install KiCad (free, about 1 GB, using %s)' % how)
        say(' [L] Locate it (KiCad is already installed)')
        say(' [S] Skip')
        pick = choose(' Choose I, L or S [S]: ', 'ils', 's')
        if pick == 'i':
            return install_kicad()['state'] == 'running'
        if pick == 'l':
            if locate_kicad_console():
                show_kicad(kicad_bridge.detect_kicad())
                return False
            continue
        break
    say(' Skipped. You can install or locate KiCad later from the KiCad button in GFLUX,')
    say(' or get it from %s' % url)
    return False


def selftest(port):
    base = 'http://127.0.0.1:%d' % port
    with urllib.request.urlopen(base + '/', timeout=5) as r:
        page = r.read().decode('utf-8')
    assert 'GFLUX' in page and 'js/app.js' in page, 'index.html missing'
    for path in ('/js/app.js', '/js/parts.js', '/js/editor.js', '/css/gflux.css'):
        with urllib.request.urlopen(base + path, timeout=5) as r:
            assert r.status == 200 and len(r.read()) > 1000, path
            assert r.headers.get('Cache-Control') == 'no-cache', path
    assert running_site(port) == kicad_bridge.site_version(site_root()), 'site version'
    health = get_json(base + '/api/kicad/health', timeout=60)
    assert health.get('bridge') is True and health.get('launcher') is True, health
    for key in ('ok', 'version', 'cli', 'source', 'problem', 'searched', 'canInstall', 'install'):
        assert key in health, key
    req = urllib.request.Request(base + '/api/kicad/recheck', data=b'', method='POST')
    with urllib.request.urlopen(req, timeout=60) as r:
        again = json.loads(r.read().decode('utf-8'))
    assert again.get('bridge') is True and again.get('ok') == health.get('ok'), again
    req = urllib.request.Request(base + '/api/kicad/locate', data=b'', method='POST',
                                 headers={'Origin': 'http://evil.example'})
    log, kicad_bridge.Handler.log_message = kicad_bridge.Handler.log_message, lambda *a: None
    try:
        urllib.request.urlopen(req, timeout=10)
        raise AssertionError('locate accepted a foreign Origin')
    except urllib.error.HTTPError as e:
        assert e.code == 403, e.code
    finally:
        kicad_bridge.Handler.log_message = log
    say('selftest ok: ' + json.dumps(again))


def main():
    ap = argparse.ArgumentParser(description='Run GFLUX on this computer.')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--yes', action='store_true', help='install KiCad without asking')
    ap.add_argument('--selftest', action='store_true')
    args = ap.parse_args()

    root = site_root()
    if not os.path.isfile(os.path.join(root, 'index.html')):
        raise SystemExit('GFLUX site files not found in %s' % root)

    running = None if args.selftest else running_site(args.port)
    if running is not None:
        if running == kicad_bridge.site_version(root):
            say('GFLUX is already running. Opening it in your browser.')
            webbrowser.open('http://localhost:%d/' % args.port)
            return
        say('An older GFLUX is running. Replacing it with this version...')
        if not stop_old_gflux(args.port):
            say('Could not close the older GFLUX. Close its window to use this version\'s address next time.')
    port = free_port(args.port)
    httpd = kicad_bridge.make_server('127.0.0.1', port, root, launcher=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = 'http://localhost:%d/' % port

    if args.selftest:
        try:
            selftest(port)
        finally:
            httpd.shutdown()
        return

    runner = kicad_bridge.MainThreadRunner()
    kicad_bridge.set_ui_runner(runner)
    say('=' * 60)
    say(' GFLUX is running at %s' % url)
    say(' Keep this window open')
    say('=' * 60)
    say(' Looking for KiCad...')
    info = kicad_bridge.detect_kicad()
    show_kicad(info)
    installing = False
    if not info['found']:
        installing = offer_kicad(args.yes)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        if installing:
            wait_for_install(runner)
        while True:
            runner.run_pending(3600)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()


if __name__ == '__main__':
    main()
