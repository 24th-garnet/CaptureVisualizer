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
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from . import meshplan, roomplan, segment
from .mesh import Mesh

#: ブラウザへ渡す形の版。増やすとキャッシュが作り直される。
PAYLOAD_VER = 5
#: 間引き後の面数の上限。ブラウザへ送る量を決める。
FACE_BUDGET = 170_000
#: 家具の格子（m）。小さいので細かく残す。
OBJECT_CELL = 0.03
#: 部屋の格子の候補。予算に収まる最初のものを使う。
ROOM_CELLS = (0.05, 0.06, 0.07, 0.08, 0.10, 0.14)
#: 壁として動かす面の、壁線からの許容距離（m）。実測で wall/window/door の
#: 99.4〜100% がこの内側に入る。
WALL_BAND = 0.25
#: ARKit の面分類のうち、壁として扱う値（wall / window / door）。
WALL_CLASSES = (1, 6, 7)
#: 壁から生やして拾う突出物（エアコン・配管・柱など）の届く距離（m）。
#: 壁面から離れていても、壁から辿り着けるならその壁の一部として動かす。
PROTRUSION_REACH = 0.6
#: 床と天井から離す距離（m）。分類が none の床・天井面が 23% あるので、
#: **分類だけでは止められない。** 高さでも止める。
PLANE_CLEAR = 0.15
#: 落とす連結成分の面積（m^2）。**中空に浮いた小片を消す。**
#: 実測では成分の大きさに段差があり、本物の面（床 10.04 / 天井 7.77 / 壁
#: 5.90〜7.74 / 家具 1.46〜4.81 m^2）と小片の間が 6 倍以上開いている。ただし
#: 0.1〜0.25 m^2 には椅子の脚（0.242）のような本物が混じるので、そこは残す。
COMPONENT_MIN_AREA = 0.02
#: 突出物を辿るときに越えない分類。床・天井のほか、家具（table / seat）も
#: 止める。RoomPlan が箱を持たない家具の縁を壁へ吸い込まないため。
STOP_CLASSES = (2, 3, 4, 5)

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


def cluster(V: np.ndarray, C: np.ndarray, F: np.ndarray, cell: float):
    """頂点クラスタリングで間引く。格子に丸めて併合し、潰れた面を捨てる。

    **部品ごとに呼ぶので、部品は自分だけの頂点を持つ。** 壁と床が頂点を共有
    しないため、壁を動かすと継ぎ目は引き伸びずにそのまま開く。
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
    nf = inv[F]
    keep = (nf[:, 0] != nf[:, 1]) & (nf[:, 1] != nf[:, 2]) & (nf[:, 0] != nf[:, 2])
    nf = nf[keep]
    if len(nf) == 0:
        return pos[:0], col[:0], nf
    used, remap = np.unique(nf, return_inverse=True)
    return pos[used], col[used], remap.reshape(-1, 3)


def wall_owner(Vl: np.ndarray, F: np.ndarray, cls: np.ndarray | None,
               walls: list, assigned: np.ndarray | None = None,
               adj: list | None = None,
               ceiling_y: float | None = None) -> np.ndarray | None:
    """面を壁へ振り分ける。戻り値は壁の添字、-1 は壁でない面。

    分類（wall / window / door）と、平面図の壁線からの距離で決める。分類が
    `none` でも立っていて壁の近くにあれば壁として扱う——実測で壁の近くの
    `none` 面の 48.7% が立っており、落とすと壁に穴が開く。

    `adj` を渡すと、そこから**壁にしか繋がっていない突出物**（エアコン、
    配管、柱）を辿って一緒に拾う。床・天井・家具で止まるので、壁から
    床や天井を伝って部屋じゅうへ広がることはない。
    """
    if cls is None or not walls or len(cls) != len(F):
        return None
    tri = Vl[F]
    cen = tri[:, :, [0, 2]].mean(axis=1)
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
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
    span = (s > -0.15) & (s < L[None] + 0.15)
    ok = span & (np.abs(d) < WALL_BAND)
    own = np.where(wallish & ok.any(axis=1),
                   np.where(ok, np.abs(d), np.inf).argmin(axis=1), -1)
    if adj is None:
        return own

    # **壁からしか辿り着けない突出物を、その壁の一部として拾う。**
    # エアコンや配管は壁にしか付いていないので、壁が動けば一緒に動く。
    # RoomPlan が箱を持つ物（`assigned >= 0`）は対象外——壁に接していても
    # 家具であり、位置は人が平面図で決めるもの。
    ceiling = float(Vl[:, 1].max()) if ceiling_y is None else ceiling_y
    cy = Vl[F][:, :, 1].mean(axis=1)
    reach = np.where(span, np.abs(d), np.inf).min(axis=1)
    free = np.ones(len(F), bool) if assigned is None else (assigned < 0)
    ok_grow = (own < 0) & free & ~np.isin(cls, STOP_CLASSES) \
        & (cy > PLANE_CLEAR) & (cy < ceiling - PLANE_CLEAR) \
        & (reach < PROTRUSION_REACH)
    frontier = np.flatnonzero(own >= 0).tolist()
    while frontier:
        nxt = []
        for f in frontier:
            k = own[f]
            for h in adj[f]:
                if ok_grow[h] and own[h] < 0:
                    own[h] = k
                    nxt.append(h)
        frontier = nxt
    return own


def drop_small(p: np.ndarray, c: np.ndarray, f: np.ndarray,
               min_area: float = COMPONENT_MIN_AREA):
    """浮いた小片を落とす。連結成分ごとの面積で見る。

    部品に切り分けたあとに呼ぶ。床と天井は壁を外した時点で別々の成分になる
    が、どちらも十分大きいので残る。
    """
    if len(f) == 0:
        return p, c, f
    e = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    g = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(len(p), len(p)))
    k, lab = connected_components(g, directed=False)
    if k == 1:
        return p, c, f
    t = p[f]
    ar = np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1) / 2
    fl = lab[f[:, 0]]
    area = np.zeros(k)
    np.add.at(area, fl, ar)
    keep = area[fl] >= min_area
    if keep.all():
        return p, c, f
    f = f[keep]
    if len(f) == 0:
        return p[:0], c[:0], f
    used, remap = np.unique(f, return_inverse=True)
    return p[used], c[used], remap.reshape(-1, 3)


def wall_sides(Vl: np.ndarray, F: np.ndarray, cls: np.ndarray | None,
               walls: list) -> list[int]:
    """壁ごとに「法線の向きが室内かどうか」を測る。+1 なら n が室内を指す。

    **巻き方向に頼らない。** RoomPlan の壁は法線が室内を向くが、メッシュ由来
    の平面図や人が足した壁ではその保証が無い。床の面がある側を室内とする。
    """
    cen3 = Vl[F]
    floor = (cls == 2) if cls is not None else (cen3[:, :, 1].mean(axis=1) < 0.15)
    cen = cen3[:, :, [0, 2]].mean(axis=1)[floor]
    out = []
    for _, a, b in walls:
        a = np.asarray(a, float)
        d = np.asarray(b, float) - a
        L = max(float(np.linalg.norm(d)), 1e-9)
        u = d / L
        n = np.array([-u[1], u[0]])
        q = cen - a
        s, dd = q @ u, q @ n
        m = (s > 0) & (s < L) & (np.abs(dd) < 1.5)
        out.append(1 if (not m.any() or float(np.median(dd[m])) >= 0) else -1)
    return out


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
    if boxes:
        tri = V[F]
        centroids = tri.mean(axis=1)
        normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
        adj = segment.face_adjacency(F, V)
        assigned = segment.assign_faces(
            centroids, boxes, floor_y, walls=lay.walls, ceiling_y=lay.ceiling_y,
            normals=normals, adj=adj)
        ceil_h = float(lay.ceiling_y - floor_y)
    else:
        adj = segment.face_adjacency(F, V)
        assigned = np.full(len(F), -1)
        ceil_h = float(plan.ceiling_y - floor_y)

    # 面を壁へ。家具の振り分け（assigned）と隣接表が要るのでここで呼ぶ。
    owner = wall_owner(Vl, F, cls, wall_lines, assigned, adj, ceil_h)

    parts, used_faces = [], 0
    for i, b in enumerate(boxes):
        sel = assigned == i
        if sel.sum() < 30:
            continue
        p, c, f = drop_small(*cluster(Vl, C, F[sel], OBJECT_CELL))
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

    # **壁は家具と同じく別の部品に切り出す。** 部品ごとに間引くので壁は自分
    # だけの頂点を持ち、動かしても床や天井を引き伸ばさず、継ぎ目がそのまま
    # 開く。開いた先は撮れていないので、色も付かない。
    rest = assigned < 0
    wall_sel = []
    if owner is not None:
        for k in range(len(wall_lines)):
            sel = rest & (owner == k)
            if sel.sum() >= 30:
                wall_sel.append((k, sel))
                rest = rest & ~sel

    room = F[rest]
    for cell in ROOM_CELLS:
        groups = [drop_small(*cluster(Vl, C, room, cell))]
        for _, sel in wall_sel:
            groups.append(drop_small(*cluster(Vl, C, F[sel], cell)))
        total = sum(len(g[2]) for g in groups)
        if total + used_faces <= face_budget:
            break
    p, c, f = groups[0]
    for (k, _), (wp, wc, wf) in zip(wall_sel, groups[1:]):
        if len(wf) == 0:
            continue
        wid, a, b = wall_lines[k]
        parts.insert(0, dict(id=f"__wall__{wid}", label=f"壁 {wid}", kind="wall",
                             wall=wid, a=a, b=b, faces=len(wf),
                             pos=_b64(wp.astype("<f4")),
                             col=_b64(wc.round().astype("u1")),
                             idx=_b64(wf.astype("<u4"))))
    parts.insert(0, dict(id="__room__", label="部屋", kind="room", faces=len(f),
                         pos=_b64(p.astype("<f4")), col=_b64(c.round().astype("u1")),
                         idx=_b64(f.astype("<u4"))))

    return dict(parts=parts,
                extent=[round(float(rot[:, 0].max() - x0), 3),
                        round(float(rot[:, 1].max() - z0), 3)],
                angle=round(math.degrees(ang), 2),
                rot=[[round(v, 6) for v in row] for row in R.tolist()],
                origin=[round(x0, 4), round(z0, 4)],
                floorY=round(float(floor_y), 4),
                sourceFaces=int(len(F)), roomCell=cell,
                walls=[dict(id=i, a=a, b=b, inSide=sd)
                       for (i, a, b), sd in zip(wall_lines,
                                                wall_sides(Vl, F, cls, wall_lines))],
                hasClass=cls is not None)
