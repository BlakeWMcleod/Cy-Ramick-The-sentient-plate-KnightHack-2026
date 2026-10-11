"""Tests for KiCad detection and the bridge's KiCad endpoints.

    python3 -m unittest discover gflux/tools/tests -v

Detection tests are hermetic: they build fake Windows / macOS / Linux install
trees in a temp folder, with tiny Python "kicad-cli" scripts that print a
version, and pass platform / env / home / root / drives / which / registry.
"""
import http.client
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile
from unittest import mock

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GFLUX = os.path.dirname(TOOLS)
sys.path.insert(0, TOOLS)
import kicad_bridge as kb  # noqa: E402

POSIX = os.name != 'nt'  # fake kicad-cli(.exe) scripts run through their #! line


def fake_cli(path, version, code=0):
    """A stand-in kicad-cli that prints `version` for `kicad-cli version`."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write('#!%s\nimport sys\nif sys.argv[1:2] == ["version"]:\n    print(%r)\nsys.exit(%d)\n'
                % (sys.executable, version, code))
    os.chmod(path, 0o755)
    return path


def touch(path, text=''):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)
    return path


@unittest.skipUnless(POSIX, 'fake kicad-cli scripts need a POSIX shell')
class DetectTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='gflux-detect-')
        self.empty_bin = os.path.join(self.tmp, 'emptybin')
        os.makedirs(self.empty_bin)
        self.home = os.path.join(self.tmp, 'home')
        os.makedirs(self.home)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def p(self, *parts):
        return os.path.join(self.tmp, *parts)


class WindowsDetection(DetectTestCase):
    def setUp(self):
        super().setUp()
        self.pf = self.p('Program Files')
        self.pf86 = self.p('Program Files (x86)')
        self.local = self.p('LocalAppData')
        self.appdata = self.p('AppData')
        self.env = {'ProgramFiles': self.pf, 'ProgramFiles(x86)': self.pf86, 'ProgramW6432': self.pf,
                    'LOCALAPPDATA': self.local, 'APPDATA': self.appdata, 'PATH': self.empty_bin}

    def install(self, base, version, cli_version=None, gui=True):
        folder = os.path.join(base, 'KiCad', version, 'bin')
        if gui:
            touch(os.path.join(folder, 'kicad.exe'))
        if cli_version:
            fake_cli(os.path.join(folder, 'kicad-cli.exe'), cli_version)
        return folder

    def detect(self, **kw):
        kw.setdefault('registry', lambda: [])
        kw.setdefault('drives', [])
        return kb.detect_kicad(platform='win32', env=self.env, home=self.home, **kw)

    def test_newest_program_files_version_wins(self):
        self.install(self.pf, '7.0', '7.0.11')
        self.install(self.pf, '9.0', '9.0.2')
        self.install(self.pf86, '8.0', '8.0.6')
        info = self.detect()
        self.assertTrue(info['found'], info)
        self.assertEqual(info['version'], '9.0.2')
        self.assertEqual(info['major'], 9)
        self.assertEqual(info['source'], 'Program Files')
        self.assertTrue(info['cli'].endswith(os.path.join('9.0', 'bin', 'kicad-cli.exe')))
        self.assertTrue(info['gui'].endswith(os.path.join('9.0', 'bin', 'kicad.exe')))
        self.assertIsNone(info['problem'])
        self.assertIn(os.path.join(self.pf, 'KiCad'), info['searched'])
        self.assertIn('registry', info['searched'])

    def test_versions_sort_numerically(self):
        for v in ('8.0', '10.0', '9.0'):
            self.install(self.pf, v, v + '.1')
        cands = kb.candidate_paths(platform='win32', env=self.env, home=self.home, registry=lambda: [], drives=[])
        folders = [os.path.basename(os.path.dirname(os.path.dirname(c))) for c, _ in cands]
        self.assertEqual(folders, ['10.0', '9.0', '8.0'])
        self.assertEqual(self.detect()['version'], '10.0.1')
        self.assertGreater(kb.version_tuple('10.0'), kb.version_tuple('9.0'))

    def test_per_user_localappdata_install(self):
        self.install(os.path.join(self.local, 'Programs'), '9.0', '9.0.1')
        self.install(self.pf, '8.0', '8.0.6')
        info = self.detect()
        self.assertEqual(info['version'], '9.0.1')
        self.assertEqual(info['source'], 'per-user install')

    def test_other_drive_program_files(self):
        drive = self.p('D_drive')
        self.install(os.path.join(drive, 'Program Files'), '9.0', '9.0.2')
        info = self.detect(drives=[drive])
        self.assertTrue(info['found'], info)
        self.assertEqual(info['version'], '9.0.2')

    def test_saved_setting_overrides_auto_detection(self):
        old = self.install(self.pf, '7.0', '7.0.11')
        self.install(self.pf, '9.0', '9.0.2')
        cfg = kb.config_path('win32', self.env, self.home)
        self.assertEqual(cfg, os.path.join(self.appdata, 'GFLUX', 'config.json'))
        kb.save_config({'kicad_cli': os.path.join(old, 'kicad-cli.exe')}, cfg)
        info = self.detect()
        self.assertEqual((info['version'], info['source']), ('7.0.11', 'saved setting'))
        # a saved install folder works too
        kb.save_config({'kicad_cli': os.path.dirname(old)}, cfg)
        self.assertEqual(self.detect()['source'], 'saved setting')

    def test_kicad_6_without_cli_is_a_problem(self):
        self.install(self.pf, '6.0', cli_version=None, gui=True)
        info = self.detect()
        self.assertFalse(info['found'])
        self.assertIsNone(info['cli'])
        self.assertTrue(info['gui'].endswith('kicad.exe'))
        self.assertIn('KiCad 6.0 found at', info['problem'])
        self.assertIn('KiCad 7 or newer', info['problem'])

    def test_old_kicad_cli_is_a_problem(self):
        self.install(self.pf, '6.99', '6.99.0')
        info = self.detect()
        self.assertFalse(info['found'])
        self.assertIn('KiCad 6.99.0 found at', info['problem'])
        self.assertIn('needs KiCad 7 or newer', info['problem'])

    def test_bogus_kicad_cli_env_is_skipped(self):
        self.install(self.pf, '8.0', '8.0.6')
        broken = fake_cli(self.p('broken', 'kicad-cli.exe'), 'oops', code=3)
        for bogus in (self.p('nowhere', 'kicad-cli.exe'), broken):
            self.env['KICAD_CLI'] = bogus
            info = self.detect()
            self.assertTrue(info['found'], info)
            self.assertEqual((info['version'], info['source']), ('8.0.6', 'Program Files'))

    def test_kicad_cli_env_accepts_file_or_folder(self):
        self.install(self.pf, '9.0', '9.0.2')
        custom = fake_cli(self.p('Portable', 'KiCad', 'bin', 'kicad-cli.exe'), '8.0.1')
        for value in (custom, os.path.dirname(custom), self.p('Portable', 'KiCad')):
            self.env['KICAD_CLI'] = value
            info = self.detect()
            self.assertEqual((info['version'], info['source']), ('8.0.1', 'KICAD_CLI'), value)

    def test_path_is_used(self):
        fake_cli(self.p('onpath', 'kicad-cli'), '8.0.3')
        self.env['PATH'] = self.p('onpath')
        info = self.detect()
        self.assertEqual((info['version'], info['source']), ('8.0.3', 'PATH'))

    def test_registry_location_is_used(self):
        folder = self.p('Apps', 'KiCad', '9.0')
        fake_cli(os.path.join(folder, 'bin', 'kicad-cli.exe'), '9.0.3')
        entry = [{'folder': folder, 'version': '9.0.3', 'name': 'KiCad r9.0.3'}]
        with mock.patch.object(kb, 'registry_installs', return_value=entry) as reg:
            info = kb.detect_kicad(platform='win32', env=self.env, home=self.home, drives=[])
        reg.assert_called_once()
        self.assertEqual((info['version'], info['source']), ('9.0.3', 'registry'))
        # DisplayIcon points at bin\kicad.exe: its folder works too
        with mock.patch.object(kb, 'registry_installs', return_value=[dict(entry[0], folder=os.path.join(folder, 'bin'))]):
            info = kb.detect_kicad(platform='win32', env=self.env, home=self.home, drives=[])
        self.assertEqual(info['source'], 'registry')

    def test_registry_value_parsing(self):
        self.assertEqual(kb._reg_exe_path('"C:\\Program Files\\KiCad\\9.0\\bin\\kicad.exe",0'),
                         'C:\\Program Files\\KiCad\\9.0\\bin\\kicad.exe')
        self.assertEqual(kb._reg_exe_path('C:\\Program Files\\KiCad\\9.0\\uninstall.exe /S'),
                         'C:\\Program Files\\KiCad\\9.0\\uninstall.exe')
        self.assertEqual(kb._reg_exe_path('C:\\KiCad\\bin\\kicad.exe,0'), 'C:\\KiCad\\bin\\kicad.exe')
        self.assertIsNone(kb._reg_exe_path(''))

    def test_nothing_installed(self):
        info = self.detect()
        self.assertFalse(info['found'])
        self.assertIsNone(info['problem'])
        self.assertIn('PATH', info['searched'])

    def test_resolve_picked_paths(self):
        folder = self.install(self.pf, '9.0', '9.0.2')
        cli = os.path.join(folder, 'kicad-cli.exe')
        for picked in (cli, os.path.join(folder, 'kicad.exe'), folder, os.path.dirname(folder),
                       os.path.join(self.pf, 'KiCad')):
            self.assertEqual(kb.resolve_kicad_path(picked, 'win32', up=2)[:1], [cli], picked)
        self.assertEqual(kb.resolve_kicad_path(self.p('nope'), 'win32', up=2), [])


class MacDetection(DetectTestCase):
    def app(self, folder, version, with_cli=True):
        app = self.p('root', 'Applications', folder, 'KiCad.app') if folder else self.p('root', 'Applications', 'KiCad.app')
        touch(os.path.join(app, 'Contents', 'MacOS', 'kicad'))
        touch(os.path.join(app, 'Contents', 'Info.plist'),
              '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>'
              '<key>CFBundleShortVersionString</key><string>%s</string></dict></plist>\n' % version)
        if with_cli:
            fake_cli(os.path.join(app, 'Contents', 'MacOS', 'kicad-cli'), version)
        return app

    def detect(self):
        return kb.detect_kicad(platform='darwin', env={'PATH': self.empty_bin}, home=self.home, root=self.p('root'))

    def test_versioned_applications_folder(self):
        self.app('KiCad', '8.0.6')
        app9 = self.app('KiCad 9', '9.0.2')
        info = self.detect()
        self.assertEqual((info['version'], info['source']), ('9.0.2', 'Applications'))
        self.assertEqual(info['gui'], app9)

    def test_home_applications(self):
        app = os.path.join(self.home, 'Applications', 'KiCad', 'KiCad.app')
        fake_cli(os.path.join(app, 'Contents', 'MacOS', 'kicad-cli'), '9.0.1')
        self.assertEqual(self.detect()['version'], '9.0.1')

    def test_kicad_6_app_without_cli(self):
        app = self.app('KiCad', '6.0.11', with_cli=False)
        info = self.detect()
        self.assertFalse(info['found'])
        self.assertEqual(info['gui'], app)
        self.assertIn('KiCad 6.0.11 found at', info['problem'])

    def test_resolve_app_bundle(self):
        app = self.app(None, '9.0.0')
        cli = os.path.join(app, 'Contents', 'MacOS', 'kicad-cli')
        self.assertEqual(kb.resolve_kicad_path(app, 'darwin'), [cli])
        self.assertEqual(kb.resolve_kicad_path(os.path.dirname(app), 'darwin'), [cli])
        self.assertEqual(kb.config_path('darwin', {}, self.home),
                         os.path.join(self.home, 'Library', 'Application Support', 'GFLUX', 'config.json'))


class LinuxDetection(DetectTestCase):
    def test_usr_bin(self):
        fake_cli(self.p('root', 'usr', 'bin', 'kicad-cli'), '8.0.4')
        info = kb.detect_kicad(platform='linux', env={'PATH': self.empty_bin}, home=self.home, root=self.p('root'))
        self.assertEqual((info['version'], info['source']), ('8.0.4', 'system'))
        self.assertEqual(kb.config_path('linux', {}, self.home), os.path.join(self.home, '.config', 'gflux', 'config.json'))

    def test_flatpak_runs_as_argv_prefix(self):
        fp_bin = self.p('fpbin')
        flatpak = os.path.join(fp_bin, 'flatpak')
        touch(flatpak, '#!%s\nimport sys\na = sys.argv[1:]\n'
                       'if a[:2] == ["info", "org.kicad.KiCad"]: sys.exit(0)\n'
                       'if a[:3] == ["run", "--command=kicad-cli", "org.kicad.KiCad"] and a[3:] == ["version"]:\n'
                       '    print("8.0.5"); sys.exit(0)\n'
                       'sys.exit(2)\n' % sys.executable)
        os.chmod(flatpak, 0o755)
        env = {'PATH': fp_bin}
        cands = kb.candidate_paths(platform='linux', env=env, home=self.home, root=self.p('root'))
        self.assertEqual(cands, [([flatpak, 'run', '--command=kicad-cli', 'org.kicad.KiCad'], 'flatpak')])
        info = kb.detect_kicad(platform='linux', env=env, home=self.home, root=self.p('root'))
        self.assertEqual((info['version'], info['source']), ('8.0.5', 'flatpak'))
        self.assertEqual(info['cli'], '%s run --command=kicad-cli org.kicad.KiCad' % flatpak)
        self.assertEqual(kb.cli_version(cands[0][0]), ('8.0.5', 8))


class ConfigFile(DetectTestCase):
    def test_corrupt_config_is_tolerated_and_replaced(self):
        cfg = self.p('cfg', 'config.json')
        touch(cfg, '{not json')
        self.assertEqual(kb.load_config(cfg), {})
        kb.save_config({'kicad_cli': '/x/kicad-cli', 'other': 1}, cfg)
        kb.save_config({'other': None}, cfg)
        self.assertEqual(kb.load_config(cfg), {'kicad_cli': '/x/kicad-cli'})
        self.assertEqual(os.listdir(os.path.dirname(cfg)), ['config.json'])  # no temp files left
        env = {'GFLUX_CONFIG': cfg, 'PATH': self.empty_bin}
        self.assertEqual(kb.config_path('win32', env, self.home), cfg)
        info = kb.detect_kicad(platform='linux', env=env, home=self.home, root=self.p('root'))
        self.assertIn('/x/kicad-cli', info['problem'])  # saved location gone: explained, not crashed


class Caching(unittest.TestCase):
    def tearDown(self):
        kb._detected = None

    def test_find_cli_reads_the_cache(self):
        fake = ({'found': True, 'cli': '/fake/kicad-cli', 'version': '9.0.0', 'major': 9, 'source': 'PATH',
                 'gui': None, 'problem': None, 'searched': ['PATH']}, '/fake/kicad-cli')
        with mock.patch.object(kb, '_detect', return_value=fake) as det:
            kb._detected = None
            self.assertEqual(kb.find_cli(), '/fake/kicad-cli')
            self.assertEqual(kb.detect_kicad()['version'], '9.0.0')
            self.assertEqual(det.call_count, 1)
            kb.refresh_kicad()
            self.assertEqual(det.call_count, 2)


# ------------------------------------------------------------ HTTP endpoints

class Server:
    def __init__(self, launcher):
        self.httpd = kb.make_server('127.0.0.1', 0, GFLUX, launcher=launcher)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def request(self, method, path, body=None, origin=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=120)
        headers = {'Content-Type': 'application/json'}
        if origin:
            headers['Origin'] = origin
        data = json.dumps(body).encode() if body is not None else b''
        conn.request(method, path, body=data if method == 'POST' else None, headers=headers)
        r = conn.getresponse()
        raw = r.read()
        conn.close()
        ctype = r.getheader('Content-Type') or ''
        return r.status, (json.loads(raw) if 'json' in ctype else raw)

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


FAKE_DETECTION = ({'found': False, 'cli': None, 'version': None, 'major': None, 'source': None, 'gui': None,
                   'problem': None, 'searched': ['PATH']}, None)


@unittest.skipUnless(POSIX, 'fake kicad-cli scripts need a POSIX shell')
class Endpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='gflux-http-')
        cls.cfg = os.path.join(cls.tmp, 'config.json')
        cls.env = mock.patch.dict(os.environ, {'GFLUX_CONFIG': cls.cfg})
        cls.env.start()
        cls.quiet = mock.patch.object(kb.Handler, 'log_message', lambda *a: None)  # expected 403/501 lines
        cls.quiet.start()
        cls.server = Server(launcher=True)
        cls.own = 'http://127.0.0.1:%d' % cls.server.port

    @classmethod
    def tearDownClass(cls):
        cls.server.close()
        cls.env.stop()
        cls.quiet.stop()
        kb._detected = None
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        kb._detected = FAKE_DETECTION  # no real detection unless a test asks for it
        if os.path.exists(self.cfg):
            os.unlink(self.cfg)

    def test_health_reports_launcher_and_detection(self):
        status, h = self.server.request('GET', '/api/kicad/health')
        self.assertEqual(status, 200)
        self.assertIs(h['launcher'], True)
        self.assertIs(h['bridge'], True)
        for key in ('ok', 'version', 'cli', 'source', 'gui', 'problem', 'searched', 'canInstall', 'install', 'platform'):
            self.assertIn(key, h)
        self.assertFalse(h['ok'])
        self.assertIn('error', h)
        other = Server(launcher=False)
        try:
            self.assertIs(other.request('GET', '/api/kicad/health')[1]['launcher'], False)
        finally:
            other.close()

    def test_post_endpoints_refuse_foreign_origins(self):
        with mock.patch.object(kb, 'pick_kicad_path') as pick, \
                mock.patch.object(kb, 'start_install') as install, \
                mock.patch.object(kb, 'refresh_kicad') as refresh:
            for route in ('recheck', 'locate', 'install'):
                for origin in ('http://evil.example', 'http://localhost:1', 'null'):
                    status, body = self.server.request('POST', '/api/kicad/' + route, origin=origin)
                    self.assertEqual(status, 403, (route, origin))
                    self.assertFalse(body['ok'])
            pick.assert_not_called()
            install.assert_not_called()
            refresh.assert_not_called()

    def test_recheck_reruns_detection(self):
        fresh = ({'found': True, 'cli': '/fake/kicad-cli', 'version': '9.0.0', 'major': 9, 'source': 'PATH',
                  'gui': None, 'problem': None, 'searched': ['PATH']}, '/fake/kicad-cli')
        with mock.patch.object(kb, '_detect', return_value=fresh) as det:
            for origin in (None, self.own, 'http://localhost:%d' % self.server.port):
                status, h = self.server.request('POST', '/api/kicad/recheck', origin=origin)
                self.assertEqual(status, 200)
                self.assertEqual((h['ok'], h['version'], h['launcher']), (True, '9.0.0', True))
            self.assertEqual(det.call_count, 3)

    def test_locate_with_picker_saves_the_setting(self):
        folder = os.path.join(self.tmp, 'Picked', 'KiCad', '8.0', 'bin')
        cli = fake_cli(os.path.join(folder, 'kicad-cli'), '8.0.9')
        with mock.patch.object(kb, 'pick_kicad_path', return_value=os.path.dirname(folder)) as pick:
            status, h = self.server.request('POST', '/api/kicad/locate', origin=self.own)
        pick.assert_called_once()
        self.assertEqual(status, 200, h)
        self.assertTrue(h['located'], h)
        self.assertTrue(h['ok'])
        self.assertEqual((h['version'], h['source'], h['cli']), ('8.0.9', 'saved setting', cli))
        self.assertEqual(kb.load_config(self.cfg)['kicad_cli'], cli)

    def test_locate_typed_path_and_bad_picks(self):
        cli = fake_cli(os.path.join(self.tmp, 'typed', 'kicad-cli'), '9.0.1')
        status, h = self.server.request('POST', '/api/kicad/locate', body={'path': cli})
        self.assertEqual((status, h['located'], h['version']), (200, True, '9.0.1'))
        old = fake_cli(os.path.join(self.tmp, 'old', 'kicad-cli'), '6.0.11')
        kb._detected = FAKE_DETECTION
        with mock.patch.object(kb, 'pick_kicad_path', return_value=old):
            status, h = self.server.request('POST', '/api/kicad/locate')
        self.assertEqual((status, h['located']), (200, False))
        self.assertIn('KiCad 7 or newer', h['message'])
        with mock.patch.object(kb, 'pick_kicad_path', return_value=None):
            status, h = self.server.request('POST', '/api/kicad/locate')
        self.assertEqual((status, h['cancelled'], h['located']), (200, True, False))

    def test_locate_without_tkinter_is_501(self):
        with mock.patch.object(kb, 'picker_available', return_value=False):
            status, h = self.server.request('POST', '/api/kicad/locate', origin=self.own)
        self.assertEqual(status, 501)
        self.assertFalse(h['ok'])
        self.assertIn('error', h)


def make_schematic():
    """A .kicad_sch made by GFLUX's own exporter (js/kicad.js) under Node."""
    node = shutil.which('node')
    if not node:
        return None
    js = os.path.join(GFLUX, 'js')
    script = ('global.window = global;\n'
              'for (const f of ["parts.js", "netlist.js", "kicad.js"]) require(%r + "/" + f);\n'
              'const state = { name: "bridge-test", parts: [{ uid: "p1", type: "esp32", x: 0, y: 0, rot: 0 },'
              ' { uid: "p2", type: "led", x: 20, y: 0, rot: 0 }], wires: [], custom: [] };\n'
              'process.stdout.write(GFLUX.kicad.schematic(state));\n' % js)
    r = subprocess.run([node, '-e', script], capture_output=True, text=True, timeout=60)
    return r.stdout if r.returncode == 0 and '(kicad_sch' in r.stdout[:200] else None


@unittest.skipUnless(os.environ.get('GFLUX_E2E', '1') != '0' and POSIX, 'end-to-end export disabled')
class EndToEndExport(unittest.TestCase):
    """Real kicad-cli (if installed) makes a PDF through the bridge."""

    def test_schematic_zip_has_pdf(self):
        kb._detected = None
        info = kb.refresh_kicad()
        if not info['found']:
            self.skipTest('KiCad is not installed here')
        sch = make_schematic()
        if not sch:
            self.skipTest('node could not build a schematic from js/kicad.js')
        server = Server(launcher=False)
        try:
            status, blob = server.request('POST', '/api/kicad/schematic', body={'name': 'bridge test', 'sch': sch})
        finally:
            server.close()
            kb._detected = None
        self.assertEqual(status, 200, blob)
        names = zipfile.ZipFile(io.BytesIO(blob)).namelist()
        self.assertIn('bridge_test-schematic.pdf', names)
        self.assertIn('bridge_test.kicad_sch', names)


if __name__ == '__main__':
    unittest.main()
