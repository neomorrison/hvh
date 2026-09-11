"""stdin: raw RGBA bytes; argv: width height alpha(0/1) quality → stdout: JPEG (opaque) or PNG (alpha). Used by bsp2map.mjs."""
import sys
from PIL import Image
w, h, alpha, q = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3] == '1', int(sys.argv[4])
im = Image.frombytes('RGBA', (w, h), sys.stdin.buffer.read())
out = sys.stdout.buffer
if alpha:
    im.save(out, format='PNG', optimize=True)
else:
    im.convert('RGB').save(out, format='JPEG', quality=q, optimize=True, progressive=False)
