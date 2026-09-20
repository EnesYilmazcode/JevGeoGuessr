"""Frame-by-frame capture of web/render.html into an MP4 and a GIF.

usage: python scripts/render.py [fps] [out-basename]
Needs ffmpeg on PATH. Serves web/ itself, so nothing else has to be running.

Seeks rather than records in real time, so the output is identical every run and does not depend
on how busy the machine was.
"""
import http.server, os, shutil, socketserver, subprocess, sys, threading, time

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
WEB = os.path.join(ROOT, "web")
OUT_DIR = os.path.join(ROOT, "media")
FRAMES = os.path.join(ROOT, "renders", "frames")
W, H = 1600, 900
PORT = 8791

fps = int(sys.argv[1]) if len(sys.argv) > 1 else 30
name = sys.argv[2] if len(sys.argv) > 2 else "drive"

DATA = sys.argv[3] if len(sys.argv) > 3 else "drive.json"
if not os.path.exists(os.path.join(WEB, DATA)):
    sys.exit(f"web/{DATA} missing. Run: npm run drive -- <lat> <lng>")

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("playwright missing. Run: pip install playwright && playwright install chromium")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
server = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

shutil.rmtree(FRAMES, ignore_errors=True)
os.makedirs(FRAMES, exist_ok=True)
os.makedirs(OUT_DIR, exist_ok=True)

started = time.time()
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
    page.goto(f"http://127.0.0.1:{PORT}/render.html?size={W}x{H}&capture=1&data={DATA}", wait_until="networkidle")
    page.wait_for_function("window.__render && document.fonts.ready")
    # Photographs are several megabytes each and are preloaded; a frame captured before they
    # decode is a grey rectangle that no amount of encoding fixes.
    page.wait_for_function("Array.from(document.images).every(i => i.complete)", timeout=120_000)
    page.wait_for_timeout(1200)

    duration = page.evaluate("window.__render.duration")
    looks = page.evaluate("window.__render.steps")
    total = int(duration * fps) + 1
    print(f"{looks} looks, {duration:.1f}s, {total} frames at {fps}fps")

    for i in range(total):
        page.evaluate(f"window.__render.seek({i / fps})")
        page.screenshot(path=os.path.join(FRAMES, f"{i:05d}.jpg"), type="jpeg", quality=94)
        if i % 60 == 0:
            print(f"  {i}/{total}")
    browser.close()

server.shutdown()
print(f"captured in {time.time() - started:.0f}s")

mp4 = os.path.join(OUT_DIR, f"{name}.mp4")
gif = os.path.join(OUT_DIR, f"{name}.gif")
pattern = os.path.join(FRAMES, "%05d.jpg")

subprocess.run([
    "ffmpeg", "-y", "-framerate", str(fps), "-i", pattern,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
    # X re-encodes anything it does not like; an even-dimension yuv420p h264 is what it accepts.
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart", mp4,
], check=True)

palette = os.path.join(FRAMES, "palette.png")
subprocess.run(["ffmpeg", "-y", "-i", mp4, "-vf", "fps=15,scale=900:-1:flags=lanczos,palettegen", palette], check=True)
subprocess.run([
    "ffmpeg", "-y", "-i", mp4, "-i", palette,
    "-lavfi", "fps=15,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse", gif,
], check=True)

for path in (mp4, gif):
    print(f"{path}  {os.path.getsize(path) / 1024 / 1024:.1f} MB")
