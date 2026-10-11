#!/usr/bin/env python3
"""GFLUX desktop launcher: the program inside GFLUX.exe.

Double-click it (or run `python3 gflux/tools/gflux_app.py`) and it will:
  1. serve the GFLUX site on this computer and open it in your browser,
  2. connect the Schematic / PCB buttons to KiCad,
  3. offer to install KiCad if it isn't installed yet.

Options:
  --port N     port to use (default 8765, or the next free one)
  --no-browser don't open the browser
  --yes        install KiCad without asking if it's missing
  --selftest   start, check the site and API respond, then exit (used by CI)
"""
import argparse
import json
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kicad_bridge  # noqa: E402  (same folder; bundled by PyInstaller)


def site_root():
    """The gflux/ web folder: bundled next to the code in the .exe, or the repo folder."""
    if getattr(sys, 'frozen', False):
        return os.path.join(sys._MEIPASS, 'site')
    return os.path.dirname(HERE)


def get_json(url, timeout=2):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def already_running(port):
    """True if a GFLUX bridge already answers on this port."""
    try:
        return get_json('http://127.0.0.1:%d/api/kicad/health' % port, timeout=1).get('bridge') is True
    except Exception:
        return False


def free_port(start):
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    raise SystemExit('No free port found between %d and %d.' % (start, start + 49))


def ask(question, default=True):
    if not sys.stdin or not sys.stdin.isatty():
        return default
    hint = '[Y/n]' if default else '[y/N]'
    try:
        answer = input('%s %s ' % (question, hint)).strip().lower()
    except EOFError:
        return default
    return default if not answer else answer.startswith('y')


def offer_kicad_install(auto_yes):
    if kicad_bridge.find_cli():
        return
    cmd, url, how = kicad_bridge.install_plan()
    print()
    print('KiCad is not installed. GFLUX still works, but the Schematic and PCB')
    print('buttons can only make KiCad files, not PDFs or Gerbers.')
    if not (auto_yes or ask('Install KiCad now using %s?' % how)):
        print('Skipped. You can install it later from the KiCad button in GFLUX or from %s' % url)
        return
    status = kicad_bridge.start_install()
    print(status['message'])
    while status['state'] == 'running':
        time.sleep(3)
        print('.', end='', flush=True)
        status = kicad_bridge.install_status()
    print()
    print(status['message'])
    if status['state'] == 'done':
        print('Reload GFLUX in your browser to use KiCad.')


def selftest(port):
    base = 'http://127.0.0.1:%d' % port
    with urllib.request.urlopen(base + '/', timeout=5) as r:
        page = r.read().decode('utf-8')
    assert 'GFLUX' in page and 'js/app.js' in page, 'index.html missing'
    for path in ('/js/app.js', '/js/parts.js', '/css/gflux.css'):
        with urllib.request.urlopen(base + path, timeout=5) as r:
            assert r.status == 200 and len(r.read()) > 1000, path
    health = get_json(base + '/api/kicad/health', timeout=30)
    assert health.get('bridge') is True, health
    print('selftest ok:', json.dumps(health))


def main():
    ap = argparse.ArgumentParser(description='Run GFLUX on this computer.')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--yes', action='store_true', help='install KiCad without asking')
    ap.add_argument('--selftest', action='store_true')
    args = ap.parse_args()

    if not args.selftest and already_running(args.port):
        print('GFLUX is already running. Opening it in your browser.')
        webbrowser.open('http://localhost:%d/' % args.port)
        return

    root = site_root()
    if not os.path.isfile(os.path.join(root, 'index.html')):
        raise SystemExit('GFLUX site files not found in %s' % root)
    port = free_port(args.port)
    httpd = kicad_bridge.make_server('127.0.0.1', port, root)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = 'http://localhost:%d/' % port

    if args.selftest:
        try:
            selftest(port)
        finally:
            httpd.shutdown()
        return

    print('=' * 60)
    print(' GFLUX is running at %s' % url)
    print(' Keep this window open while you use GFLUX. Close it to quit.')
    print('=' * 60)
    cli = kicad_bridge.find_cli()
    if cli:
        try:
            print(' KiCad %s found: %s' % (kicad_bridge.cli_version(cli)[0], cli))
        except Exception as e:  # a broken install shouldn't stop the editor
            print(' KiCad found at %s but it did not start: %s' % (cli, e))
    if not args.no_browser:
        webbrowser.open(url)
    offer_kicad_install(args.yes)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()


if __name__ == '__main__':
    main()
