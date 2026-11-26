import sys
from PIL import Image
# Trim to the object (alpha) and pad to a square with a little margin.
for f in sys.argv[1:]:
    im = Image.open(f).convert('RGBA')
    a = im.split()[3].point(lambda v: 255 if v > 12 else 0)
    x0, y0, x1, y1 = a.getbbox()
    side = int(max(x1 - x0, y1 - y0) * 1.06)
    out = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    out.paste(im.crop((x0, y0, x1, y1)), ((side - (x1 - x0)) // 2, (side - (y1 - y0)) // 2))
    out.resize((512, 512), Image.LANCZOS).save(f)
