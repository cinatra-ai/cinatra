"""Compare the pre-press and post-press pictures pixel by pixel.

The DOM answer is in capture-records.json (`clickProof.detailIdentical`); this
answers the other half a reader asks — whether the PICTURES are byte-identical,
and, when they are not, exactly where and by how much they differ. It writes the
answer back into capture-records.json rather than into prose, so the claim in
README.md is a reading of a file and not a sentence someone typed.

    python3 evidence/2970-setup-rail/drivers/10-pixel-diff.py
"""
import json
import sys

import numpy as np
from PIL import Image, ImageChops

RECORDS = "evidence/2970-setup-rail/capture-records.json"
BEFORE = "evidence/2970-setup-rail/captures/C7__setup-run-page__light.png"
AFTER = "evidence/2970-setup-rail/captures/C7-click__setup-run-page__light.png"

a = Image.open(BEFORE).convert("RGB")
b = Image.open(AFTER).convert("RGB")
if a.size != b.size:
    sys.exit(f"the two pictures are different sizes: {a.size} vs {b.size}")
diff = np.array(ImageChops.difference(a, b)).sum(axis=2)
ys, xs = np.nonzero(diff)
total = a.size[0] * a.size[1]
answer = {
    "width": a.size[0],
    "height": a.size[1],
    "totalPixels": total,
    "differingPixels": int(len(xs)),
    "identical": bool(len(xs) == 0),
}
if len(xs):
    answer["bbox"] = {
        "x0": int(xs.min()), "x1": int(xs.max()),
        "y0": int(ys.min()), "y1": int(ys.max()),
    }
    answer["maxChannelSum"] = int(diff.max())
records = json.load(open(RECORDS))
# The reader's real question is not "are the two files identical" but "did
# anything change INSIDE the run surface". The recorder wrote down where the run
# surface is in the picture; this counts the differing pixels inside it.
rect = None
for r in records["records"]:
    if r["step"] == "c7-light":
        rect = r["controls"].get("runSurfaceRect")
if rect and len(xs):
    inside = int(
        np.count_nonzero(
            (xs >= rect["x0"]) & (xs < rect["x1"]) & (ys >= rect["y0"]) & (ys < rect["y1"])
        )
    )
    answer["runSurfaceRect"] = rect
    answer["differingPixelsInsideRunSurface"] = inside
elif rect:
    answer["runSurfaceRect"] = rect
    answer["differingPixelsInsideRunSurface"] = 0
records["clickProof"]["pixelDiff"] = answer
json.dump(records, open(RECORDS, "w"), indent=2)
open(RECORDS, "a").write("\n")
print(json.dumps(answer))
