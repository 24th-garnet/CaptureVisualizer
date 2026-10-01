"""ブラウザへ渡す 3D を作る。**部品に切り分けて間引く。**

家具を動かすには部品ごとのメッシュが要る。素材は `mesh_vc.glb`（頂点
カラー付き）と `room.json`（RoomPlan の向き付き境界箱）。切り分けは
`segment.assign_faces` をそのまま使い、色を運ぶために `split_mesh` は
使わず**元の頂点番号を保ったまま**部分集合を取る。

座標は平面図と揃える。world を主方向で回し、原点を図面の左上、Y は床を 0 に
する。こうすると平面図の (x, z) と 3D の (x, z) が同じ枠に乗り、同期が
引き算だけで済む（位置合わせの処理が要らない）。

727,754 面をそのまま送ると base64 で 20MB を超えるので**間引く**。頂点
クラスタリング（格子に丸めて併合）で、部屋は粗く・家具は細かく。位相は
崩れるが見た目は保たれる。実測で 727,754 → 138,001 面 / 3.5MB。
"""
from __future__ import annotations

import base64
import json
import math
import struct
from pathlib import Path

import numpy as np

from scipy.spatial import cKDTree

from . import meshplan, roomplan, segment
from .mesh import Mesh

#: ブラウザへ渡す形の版。増やすとキャッシュが作り直される。
PAYLOAD_VER = 2
#: 間引き後の面数の上限。ブラウザへ送る量を決める。
FACE_BUDGET = 170_000
#: 家具の格子（m）。小さいので細かく残す。
OBJECT_CELL = 0.03
#: 部屋の格子の候補。予算に収まる最初のものを使う。
ROOM_CELLS = (0.05, 0.06, 0.07, 0.08, 0.10, 0.14)
#: 壁として動かす面の、壁線からの許容距離（m）。実測で wall/window/door の
#: 99.4〜100% がこの内側に入る。
WALL_BAND = 0.25
#: 継ぎ目から減衰させる幅（m）。**壁は剛体のまま動き、伸びるのは床と天井の
#: 縁だけ**になる。1 列（平均 25mm）に負わせると 135mm の移動で 548% 伸びる。
#: 0.10m で 135%、0.20m で 68%。
SEAM_BLEND = 0.20
#: 1 頂点が従う壁の数。角では 2 枚に跨がるので 2 つ持つ。
SLOTS = 2
#: ARKit の面分類のうち、壁として扱う値（wall / window / door）。
WALL_CLASSES = (1, 6, 7)

FURNITURE_JA = {"sofa": "ソファ", "stairs": "階段", "table": "テーブル",
                "bed": "ベッド", "chair": "椅子", "storage": "収納",
                "television": "テレビ", "refrigerator": "冷蔵庫",
                "oven": "コンロ", "sink": "流し", "toilet": "便器",
                "bathtub": "浴槽", "washerDryer": "洗濯機", "fireplace": "暖炉",
                "stove": "レンジ", "dishwasher": "食洗機"}


def read_glb(path: str | Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """頂点カラー付き GLB から位置・色・面を読む。"""
    b = Path(path).read_bytes()
    _, _, total = struct.unpack_from("<III", b, 0)
    off, chunks = 12, {}
    while off < total:
        ln, ty = struct.unpack_from("<II", b, off)
        off += 8
        chunks[ty] = b[off:off + ln]
        off += ln
    g = json.loads(chunks[0x4E4F534A].decode("utf-8"))
    binc = chunks[0x004E4942]

    def acc(i: int, dtype: str, comp: int) -> np.ndarray:
        a = g["accessors"][i]
        bv = g["bufferViews"][a["bufferView"]]
        start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        return np.frombuffer(binc, dtype=dtype, count=a["count"] * comp,
                             offset=start).reshape(-1, comp)

    p = g["meshes"][0]["primitives"][0]
    V = acc(p["attributes"]["POSITION"], "<f4", 3).astype(np.float64)
    C = acc(p["attributes"]["COLOR_0"], "u1", 4)[:, :3]
    F = acc(p["indices"], "<u4", 1).reshape(-1, 3).astype(np.int64)
    return V, C, F


def cluster(V: np.ndarray, C: np.ndarray, F: np.ndarray, cell: float,
            extra: np.ndarray | None = None):
    """頂点クラスタリングで間引く。格子に丸めて併合し、潰れた面を捨てる。

    `extra` に頂点ごとの値（N×K）を渡すと、位置や色と同じように平均して返す。
    壁に従う重みを間引きの後まで運ぶために使う。**平均されることで、格子に
    丸めて滲んだ境界が自然に中間の重みになる。**
    """
    key = np.floor(V / cell).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    n = int(inv.max()) + 1
    pos = np.zeros((n, 3)); col = np.zeros((n, 3)); cnt = np.zeros(n)
    np.add.at(pos, inv, V)
    np.add.at(col, inv, C.astype(np.float64))
    np.add.at(cnt, inv, 1)
    pos /= cnt[:, None]
    col /= cnt[:, None]
    ex = None
    if extra is not None:
        ex = np.zeros((n, extra.shape[1]))
        np.add.at(ex, inv, extra)
        ex /= cnt[:, None]
    nf = inv[F]
    keep = (nf[:, 0] != nf[:, 1]) & (nf[:, 1] != nf[:, 2]) & (nf[:, 0] != nf[:, 2])
    nf = nf[keep]
    if len(nf) == 0:
        return pos[:0], col[:0], nf, (None if ex is None else ex[:0])
    used, remap = np.unique(nf, return_inverse=True)
    return (pos[used], col[used], remap.reshape(-1, 3),
            None if ex is None else ex[used])


def wall_weights(Vl: np.ndarray, F: np.ndarray, cls: np.ndarray | None,
                 walls: list) -> np.ndarray | None:
    """頂点ごとに「どの壁にどれだけ従うか」を出す。戻り値は N×（壁の数）。

    面を分類と距離で壁へ振り分け、その頂点を 1 とする。壁に属さない頂点は
    継ぎ目からの距離で 0 へ落とす。こうすると**壁・扉・窓は剛体のまま動き、
    伸びるのは床と天井の縁だけ**になり、開口が歪まない。

    減衰は**壁の頂点までの距離**で測る。継ぎ目を陽に探すより簡単だが、頂点の
    間隔が SEAM_BLEND より粗いメッシュでは落ちすぎる。実測のメッシュは平均
    25mm 間隔で、200mm に対して十分細かい。
    """
    if cls is None or not walls or len(cls) != len(F):
        return None
    tri = Vl[F]
    cen = tri[:, :, [0, 2]].mean(axis=1)
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    # 分類が none でも、立っていて壁の近くにあれば壁として扱う。実測で
    # 壁の近くの none 面の 48.7% が立っており、落とすと壁に穴が開く。
    wallish = np.isin(cls, WALL_CLASSES) | ((cls == 0) & (np.abs(nrm[:, 1]) < 0.35))

    A = np.array([w[1] for w in walls], dtype=float)
    B = np.array([w[2] for w in walls], dtype=float)
    D = B - A
    L = np.maximum(np.linalg.norm(D, axis=1), 1e-9)
    U = D / L[:, None]
    Nn = np.column_stack([-U[:, 1], U[:, 0]])
    q = cen[:, None, :] - A[None]
    s = np.einsum("fwk,wk->fw", q, U)
    d = np.einsum("fwk,wk->fw", q, Nn)
    ok = (s > -0.15) & (s < L[None] + 0.15) & (np.abs(d) < WALL_BAND)
    owner = np.where(wallish & ok.any(axis=1),
                     np.where(ok, np.abs(d), np.inf).argmin(axis=1), -1)

    W = np.zeros((len(Vl), len(walls)), dtype=np.float64)
    for k in range(len(walls)):
        vs = np.unique(F[owner == k])
        if len(vs):
            W[vs, k] = 1.0
    for k in range(len(walls)):
        own = np.flatnonzero(W[:, k] > 0)
        rest = np.flatnonzero(W[:, k] == 0)
        if not len(own) or not len(rest):
            continue
        dist, _ = cKDTree(Vl[own]).query(Vl[rest],
                                         distance_upper_bound=SEAM_BLEND)
        W[rest, k] = np.clip(1.0 - dist / SEAM_BLEND, 0.0, 1.0)
    return W


def top_slots(W: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """効きの大きい壁を SLOTS 個だけ残して 1 バイトに丸める。255 は「無し」。

    **合計が 1 を超えたら割って揃える。** 角の頂点は 2 枚の壁に 1 ずつ従うが、
    その 2 枚は節点を共有しているので、どちらの変換も角を同じ場所へ写す。
    足すと変位が二重になる（実測で 0.5m の移動が 0.98m になった）。平均を
    取れば一致した答えがそのまま出る。
    """
    order = np.argsort(-W, axis=1)[:, :SLOTS]
    wt = np.take_along_axis(W, order, axis=1)
    tot = wt.sum(axis=1, keepdims=True)
    wt = np.where(tot > 1.0, wt / np.maximum(tot, 1e-9), wt)
    idx = np.where(wt > 0.004, order, 255).astype(np.uint8)
    return idx, np.clip(np.round(wt * 255), 0, 255).astype(np.uint8)


def _b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def build(bundle: str | Path, face_budget: int = FACE_BUDGET) -> dict:
    """バンドルから部品つきの 3D を組む。`room.json` が無ければ部屋 1 個。"""
    bundle = Path(bundle)
    glb = bundle / "mesh_vc.glb"
    if not glb.exists():
        raise FileNotFoundError("mesh_vc.glb がない（頂点カラーを焼いていない撮影）")
    V, C, F = read_glb(glb)
    cls = None
    cf = bundle / "mesh_class.bin"
    if cf.exists():
        cls = np.frombuffer(cf.read_bytes(), dtype=np.uint8)

    room_json = bundle / "room.json"
    if room_json.exists():
        lay = roomplan.load(room_json)
        boxes = segment.boxes_from_room(room_json)
        th = np.array([math.atan2(*(w.p1 - w.p0)[::-1]) for w in lay.walls])
        Lw = np.array([w.length for w in lay.walls])
        ang = float(np.angle(np.sum(Lw * np.exp(4j * th)) / Lw.sum()) / 4)
        floor_y = lay.floor_y
        pts = np.array([p for w in lay.walls for p in (w.p0, w.p1)])
        if lay.floor_polygon is not None:
            pts = np.vstack([pts, lay.floor_polygon])
    else:
        plan = meshplan.extract(Mesh(vertices=V, faces=F))
        if plan is None:
            raise ValueError("平面が取れない")
        lay, boxes = None, []
        ang = math.radians(plan.angle)
        floor_y = plan.floor_y
        pts = plan.outline @ np.linalg.inv(meshplan.rotation(ang)).T

    R = meshplan.rotation(ang)
    rot = pts @ R.T
    x0, z0 = float(rot[:, 0].min()), float(rot[:, 1].min())

    xz = V[:, [0, 2]] @ R.T
    Vl = np.column_stack([xz[:, 0] - x0, V[:, 1] - floor_y, xz[:, 1] - z0])

    # 壁の線を 3D と同じ枠へ。**並びは平面図（webapp.derive_plan）と同じで
    # なければならない。** 識別子 w0, w1, … で対応を取るので、ここで一緒に
    # 書き出して突き合わせられるようにする。
    def _loc(q):
        r = np.asarray(q) @ R.T
        return [round(float(r[0] - x0), 4), round(float(r[1] - z0), 4)]

    if lay is not None:
        wall_lines = [(f"w{i}", _loc(w.p0), _loc(w.p1))
                      for i, w in enumerate(lay.walls)]
    else:
        ol = plan.outline
        wall_lines = [(f"w{i}",
                       [round(float(ol[i][0] - x0), 4), round(float(ol[i][1] - z0), 4)],
                       [round(float(ol[(i + 1) % len(ol)][0] - x0), 4),
                        round(float(ol[(i + 1) % len(ol)][1] - z0), 4)])
                      for i in range(len(ol))]
    weights = wall_weights(Vl, F, cls, wall_lines)

    if boxes:
        tri = V[F]
        centroids = tri.mean(axis=1)
        normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
        assigned = segment.assign_faces(
            centroids, boxes, floor_y, walls=lay.walls, ceiling_y=lay.ceiling_y,
            normals=normals, adj=segment.face_adjacency(F, V))
    else:
        assigned = np.full(len(F), -1)

    parts, used_faces = [], 0
    for i, b in enumerate(boxes):
        sel = assigned == i
        if sel.sum() < 30:
            continue
        p, c, f, _ = cluster(Vl, C, F[sel], OBJECT_CELL)
        if len(f) == 0:
            continue
        cxz = np.array([b.center[0], b.center[2]]) @ R.T
        # RoomPlan の向き付き境界箱を、3D と同じ枠へ落として渡す。
        #
        # **符号の取り違えを避けるため、向きは JS で組み立てない。** 箱の軸から
        # 隅の座標をここで出し、中心からの相対で渡す。JS 側は中心に置いて
        # dyaw だけ回せばよく、回転の向きを推し量る必要がなくなる。
        corner = []
        for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            w = b.center + b.axes[:, 0] * b.half[0] * sx + b.axes[:, 2] * b.half[2] * sz
            q = np.array([w[0], w[2]]) @ R.T
            corner.append([round(float(q[0] - x0 - (cxz[0] - x0)), 4),
                           round(float(q[1] - z0 - (cxz[1] - z0)), 4)])
        parts.append(dict(
            id=b.identifier, label=FURNITURE_JA.get(b.category, b.category),
            category=b.category, confidence=b.confidence, kind="object",
            c=[round(float(cxz[0] - x0), 4), 0.0, round(float(cxz[1] - z0), 4)],
            box=dict(pts=corner,
                     y0=round(float(b.center[1] - b.half[1] - floor_y), 4),
                     h=round(float(b.half[1] * 2), 4)),
            faces=len(f),
            pos=_b64(p.astype("<f4")), col=_b64(c.round().astype("u1")),
            idx=_b64(f.astype("<u4"))))
        used_faces += len(f)

    room = F[assigned < 0]
    for cell in ROOM_CELLS:
        p, c, f, w = cluster(Vl, C, room, cell, extra=weights)
        if len(f) + used_faces <= face_budget:
            break
    part = dict(id="__room__", label="部屋", kind="room", faces=len(f),
                pos=_b64(p.astype("<f4")), col=_b64(c.round().astype("u1")),
                idx=_b64(f.astype("<u4")))
    if w is not None and len(w):
        # 壁ごとの追従。1 頂点あたり「どの壁か」と「どれだけ」を SLOTS 組。
        idx, wt = top_slots(w)
        part["widx"] = _b64(idx)
        part["wwt"] = _b64(wt)
    parts.insert(0, part)

    return dict(parts=parts,
                extent=[round(float(rot[:, 0].max() - x0), 3),
                        round(float(rot[:, 1].max() - z0), 3)],
                angle=round(math.degrees(ang), 2),
                rot=[[round(v, 6) for v in row] for row in R.tolist()],
                origin=[round(x0, 4), round(z0, 4)],
                floorY=round(float(floor_y), 4),
                sourceFaces=int(len(F)), roomCell=cell,
                walls=[dict(id=i, a=a, b=b) for i, a, b in wall_lines],
                slots=SLOTS, seamBlend=SEAM_BLEND,
                hasClass=cls is not None)
