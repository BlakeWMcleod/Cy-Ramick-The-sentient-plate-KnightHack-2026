#!/usr/bin/env python3
import importlib.util
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GFLUX = os.path.dirname(HERE)
BUILD = os.path.join(GFLUX, 'build')
DIST = os.path.join(GFLUX, 'dist')
SKIP = {'tools', 'build', 'dist', '__pycache__', 'README.md'}


def stage_site():
    site = os.path.join(BUILD, 'site')
    shutil.rmtree(site, ignore_errors=True)
    shutil.copytree(GFLUX, site, ignore=lambda d, names: [n for n in names if d == GFLUX and n in SKIP or n == '__pycache__'])
    return site


def make_icon():
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print('Pillow not installed: building without an icon')
        return None
    size, k = 256, 6
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((8, 8, size - 8, size - 8), radius=52, fill=(255, 255, 255, 255), outline=(225, 221, 211, 255), width=6)
    ox, oy, w = 8, 32, int(5.5 * k)
    red = (229, 57, 53, 255)
    P = lambda x, y: (ox + x * k, oy + y * k)
    d.line([P(5, 27), P(5, 13)], fill=red, width=w)
    d.arc([P(5, 6), P(19, 20)], 180, 360, fill=red, width=w)
    d.line([P(19, 13), P(19, 19)], fill=red, width=w)
    d.arc([P(19, 12), P(33, 26)], 0, 180, fill=red, width=w)
    d.line([P(33, 19), P(33, 5)], fill=red, width=w)
    for x, y in ((5, 27), (33, 5)):
        cx, cy = P(x, y)
        d.ellipse((cx - w * 0.55, cy - w * 0.55, cx + w * 0.55, cy + w * 0.55), fill=(207, 211, 216, 255), outline=(140, 145, 150, 255), width=3)
    path = os.path.join(BUILD, 'gflux.ico')
    img.save(path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    img.save(os.path.join(BUILD, 'gflux.png'))
    return path


def main():
    import PyInstaller.__main__
    os.makedirs(BUILD, exist_ok=True)
    site = stage_site()
    icon = make_icon()
    args = [
        os.path.join(HERE, 'gflux_app.py'),
        '--name', 'GFLUX', '--onefile', '--console', '--noconfirm', '--clean',
        '--paths', HERE, '--hidden-import', 'kicad_bridge', '--hidden-import', 'arduino_bridge',
        '--add-data', '%s%ssite' % (site, os.pathsep),
        '--distpath', DIST, '--workpath', os.path.join(BUILD, 'work'), '--specpath', BUILD,
    ]
    if icon and sys.platform == 'win32':
        args += ['--icon', icon]
    if importlib.util.find_spec('tkinter'):
        args += ['--hidden-import', 'tkinter', '--hidden-import', 'tkinter.filedialog']
    else:
        print('WARNING: this Python has no tkinter; the app will ask for a pasted path instead of a file picker')
    PyInstaller.__main__.run(args)
    print('Built:', ', '.join(os.listdir(DIST)))


if __name__ == '__main__':
    main()
