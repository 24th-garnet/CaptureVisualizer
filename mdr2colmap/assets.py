"""置換用の 3D アセット（GLB）を読み、ブラウザへ渡す形にする。

**ブラウザ側に読み手を足さない。** three.js の r128 UMD には GLTFLoader が
入っておらず、別途読むと「three.js が落ちたら全部死ぬ」経路が一本増える
（実際に一度それで平面図ごと消した）。すでにサーバで GLB を読んでいるので、
ここで解いて `webgeom` と同じ形で渡せば、ブラウザは既存の組み立てをそのまま
使える。重いアセットをここで間引けるという利点もある。

対応するのは `.glb`（バイナリ 1 ファイル）だけ。`.gltf` + 外部 `.bin` は
受け取るファイルが増えるぶん取り違えが起きるので受けない。
"""
from __future__ import annotations

import base64
import json
import struct
from pathlib import Path

import numpy as np

#: 間引き後の面数の上限。置換アセットは部屋より小さいので控えめでよい。
ASSET_FACE_BUDGET = 60_000
#: 間引きの格子の候補（m）。アセットは実寸とは限らないので、**外形で正規化
#: してから**使う（箱の対角線に対する割合）。
ASSET_CELLS = (0.0, 0.004, 0.006, 0.009, 0.013, 0.02)

_COMP = {5120: "<i1", 5121: "u1", 5122: "<i2", 5123: "<u2",
         5125: "<u4", 5126: "<f4"}
_NUM = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _chunks(path: Path):
    b = path.read_bytes()
    magic, _, total = struct.unpack_from("<III", b, 0)
    if magic != 0x46546C67:
        raise ValueError("GLB ではない")
    off, out = 12, {}
    while off < total:
        ln, ty = struct.unpack_from("<II", b, off)
        off += 8
        out[ty] = b[off:off + ln]
        off += ln
    return json.loads(out[0x4E4F534A].decode("utf-8")), out.get(0x004E4942, b"")


def _accessor(g: dict, bin_: bytes, i: int) -> np.ndarray:
    a = g["accessors"][i]
    n = _NUM[a["type"]]
    dt = np.dtype(_COMP[a["componentType"]])
    if "bufferView" not in a:
        return np.zeros((a["count"], n), dt)
    bv = g["bufferViews"][a["bufferView"]]
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride") or dt.itemsize * n
    if stride == dt.itemsize * n:
        return np.frombuffer(bin_, dt, a["count"] * n, start).reshape(-1, n)
    # **飛び飛びに並んでいる場合。** 書き出し側がよく混ぜるので外せない。
    raw = np.frombuffer(bin_, "u1", a["count"] * stride, start).reshape(-1, stride)
    return raw[:, :dt.itemsize * n].copy().view(dt).reshape(-1, n)


def _node_matrix(node: dict) -> np.ndarray:
    if "matrix" in node:
        return np.array(node["matrix"], float).reshape(4, 4).T   # 列優先で来る
    m = np.eye(4)
    if "scale" in node:
        m[:3, :3] = np.diag(node["scale"])
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        r = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        m[:3, :3] = r @ m[:3, :3]
    if "translation" in node:
        m[:3, 3] = node["translation"]
    return m


def read_glb(path: str | Path) -> dict:
    """GLB を解く。材質ごとに部品へ分ける。

    材質ごとに分けるのは、**1 枚のメッシュにまとめると質感を 1 枚しか貼れない**
    ため。部屋の 3D が既に部品の並びなので、同じ形に合わせる。
    """
    g, bin_ = _chunks(Path(path))
    groups: dict[int, list] = {}

    def walk(i: int, parent: np.ndarray) -> None:
        node = g["nodes"][i]
        m = parent @ _node_matrix(node)
        if "mesh" in node:
            for prim in g["meshes"][node["mesh"]].get("primitives", []):
                if prim.get("mode", 4) != 4:          # 三角形以外は使わない
                    continue
                at = prim["attributes"]
                if "POSITION" not in at:
                    continue
                V = _accessor(g, bin_, at["POSITION"]).astype(np.float64)
                V = (m[:3, :3] @ V.T).T + m[:3, 3]
                UV = (_accessor(g, bin_, at["TEXCOORD_0"]).astype(np.float64)
                      if "TEXCOORD_0" in at else None)
                if "indices" in prim:
                    F = _accessor(g, bin_, prim["indices"]).reshape(-1, 3)
                else:
                    F = np.arange(len(V)).reshape(-1, 3)
                groups.setdefault(prim.get("material", -1), []).append(
                    (V, UV, F.astype(np.int64)))
        for c in node.get("children", []):
            walk(c, m)

    scene = g.get("scenes", [{}])[g.get("scene", 0)]
    for i in scene.get("nodes", range(len(g.get("nodes", [])))):
        walk(i, np.eye(4))
    if not groups:
        raise ValueError("三角形が見つからない")

    parts = []
    for mat_i, items in groups.items():
        V = np.vstack([v for v, _, _ in items])
        has_uv = all(u is not None for _, u, _ in items)
        UV = np.vstack([u for _, u, _ in items]) if has_uv else None
        F, off = [], 0
        for v, _, f in items:
            F.append(f + off)
            off += len(v)
        parts.append(dict(V=V, UV=UV, F=np.vstack(F),
                          **_material(g, bin_, mat_i)))
    return dict(parts=parts)


def _material(g: dict, bin_: bytes, i: int) -> dict:
    """材質から基本色と画像を取る。見つからなければ灰色。"""
    out = dict(color=[200, 200, 200], image=None, mime="image/png")
    if i < 0 or i >= len(g.get("materials", [])):
        return out
    pbr = g["materials"][i].get("pbrMetallicRoughness", {})
    f = pbr.get("baseColorFactor")
    if f:
        out["color"] = [int(max(0.0, min(1.0, c)) ** (1 / 2.2) * 255) for c in f[:3]]
    tex = pbr.get("baseColorTexture")
    if tex is None:
        return out
    src = g["textures"][tex["index"]].get("source")
    if src is None:
        return out
    im = g["images"][src]
    if "bufferView" in im:
        bv = g["bufferViews"][im["bufferView"]]
        o = bv.get("byteOffset", 0)
        out["image"] = bin_[o:o + bv["byteLength"]]
        out["mime"] = im.get("mimeType", "image/png")
    elif str(im.get("uri", "")).startswith("data:"):
        head, b64 = im["uri"].split(",", 1)
        out["image"] = base64.b64decode(b64)
        out["mime"] = head[5:head.index(";")] if ";" in head else "image/png"
    return out


#: 置換アセットの画像の一辺の上限。実測で 1 点 8.5〜34.5MB の画像が入っていた。
#: 家具 1 つに部屋のアトラス（4096²/3.6MB）より大きい絵は要らない。
ASSET_TEX_MAX = 1024
ASSET_TEX_QUALITY = 85


def _shrink(data: bytes, mime: str) -> tuple[bytes, str]:
    from io import BytesIO

    from PIL import Image

    im = Image.open(BytesIO(data))
    if max(im.size) > ASSET_TEX_MAX:
        k = ASSET_TEX_MAX / max(im.size)
        im = im.resize((max(1, int(im.size[0] * k)), max(1, int(im.size[1] * k))),
                       Image.LANCZOS)
    elif mime in ("image/jpeg", "image/jpg"):
        return data, mime
    buf = BytesIO()
    im.convert("RGB").save(buf, format="JPEG", quality=ASSET_TEX_QUALITY)
    return buf.getvalue(), "image/jpeg"


def payload(path: str | Path, face_budget: int = ASSET_FACE_BUDGET) -> dict:
    """ブラウザへ渡す形にする。**外形で正規化して原点中心に置く。**

    アセットの実寸はあてにならない（実測で 24×39×26 や 55×35×30 のものが
    あった）。箱に合わせるのはブラウザ側なので、ここでは「中心が原点、外形が
    `size`」という形だけ保証する。
    """
    from . import webgeom

    d = read_glb(path)
    allv = np.vstack([p["V"] for p in d["parts"]])
    lo, hi = allv.min(axis=0), allv.max(axis=0)
    center = (lo + hi) / 2
    size = np.maximum(hi - lo, 1e-6)
    diag = float(np.linalg.norm(size))

    total = sum(len(p["F"]) for p in d["parts"])
    cell = 0.0
    for c in ASSET_CELLS:
        if c == 0.0:
            if total <= face_budget:
                break
            continue
        n = 0
        for p in d["parts"]:
            V = (p["V"] - center)
            n += len(webgeom.cluster(V, np.zeros((len(V), 3), np.uint8), p["F"],
                                     c * diag, UV=p["UV"])[2])
        if n <= face_budget:
            cell = c * diag
            break
    else:
        cell = ASSET_CELLS[-1] * diag

    parts, texs = [], []
    for p in d["parts"]:
        V = p["V"] - center
        C = np.zeros((len(V), 3), np.uint8)
        if cell > 0:
            V, _, F, UV = webgeom.cluster(V, C, p["F"], cell, UV=p["UV"])
        else:
            F, UV = p["F"], p["UV"]
        if len(F) == 0:
            continue
        q = dict(faces=len(F), color=p["color"],
                 pos=webgeom._b64(V.astype("<f4")),
                 idx=webgeom._b64(F.astype("<u4")))
        if UV is not None:
            q["uv"] = webgeom._b64(UV.astype("<f4"))
        if p["image"]:
            img, mime = _shrink(p["image"], p["mime"])
            q["tex"] = len(texs)
            texs.append((img, mime))
        parts.append(q)
    return dict(size=[round(float(v), 4) for v in size],
                parts=parts, textures=[m for _, m in texs],
                faces=sum(p["faces"] for p in parts)), [b for b, _ in texs]
