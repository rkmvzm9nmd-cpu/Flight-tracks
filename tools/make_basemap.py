"""Make the globe's base map (site/assets/earth.jpg) in the site's twilight palette.

Inputs are the land/water mask and elevation images from the three-globe
examples (MIT licence, derived from NASA Blue Marble imagery):
  https://github.com/vasturiano/three-globe/tree/master/example/img
    earth-water.png     (water white, land black)
    earth-topology.png  (greyscale elevation)

Usage: python tools/make_basemap.py earth-water.png earth-topology.png site/assets/earth.jpg
"""
import sys

import numpy as np
from PIL import Image, ImageFilter

W, H = 2048, 1024
OCEAN_DEEP = np.array([24, 33, 66], float)    # #182142
OCEAN_SHELF = np.array([34, 46, 86], float)   # #222E56
LAND_LOW = np.array([58, 66, 104], float)     # #3A4268
LAND_HIGH = np.array([104, 108, 140], float)  # #686C8C
COAST = np.array([120, 132, 176], float)      # #7884B0


def main(water_path: str, topo_path: str, out_path: str) -> None:
    water = Image.open(water_path).convert("L").resize((W, H), Image.LANCZOS)
    land = 1.0 - np.asarray(water, float) / 255.0  # 1 on land
    topo = np.asarray(Image.open(topo_path).convert("L").resize((W, H), Image.LANCZOS), float) / 255.0

    # Shallow shelf glow: blurred land mask spills a little colour into the sea.
    near = np.asarray(Image.fromarray((land * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(10)), float) / 255.0
    ocean = OCEAN_DEEP + (OCEAN_SHELF - OCEAN_DEEP) * np.clip(near * 1.6, 0, 1)[..., None]

    # Simple hillshade from the elevation image (light from the north-west).
    gy, gx = np.gradient(topo * 40)
    shade = np.clip(0.5 + (-gx - gy) * 0.5, 0, 1)
    elev = np.clip(topo ** 0.6, 0, 1)
    landc = LAND_LOW + (LAND_HIGH - LAND_LOW) * elev[..., None]
    landc *= (0.82 + 0.3 * shade)[..., None]

    # Thin coastline highlight.
    edge = np.asarray(Image.fromarray((land * 255).astype(np.uint8)).filter(ImageFilter.FIND_EDGES), float) / 255.0
    edge = np.asarray(Image.fromarray((np.clip(edge, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8)), float) / 255.0

    img = ocean * (1 - land[..., None]) + landc * land[..., None]
    img = img + (COAST - img) * np.clip(edge * 0.6, 0, 0.6)[..., None]
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(out_path, quality=86, optimize=True, progressive=True)
    print("wrote", out_path)


if __name__ == "__main__":
    main(*sys.argv[1:4])
