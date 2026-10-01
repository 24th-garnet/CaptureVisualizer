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
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from . import meshplan, roomplan, segment
from .mesh import Mesh

#: ブラウザへ渡す形の版。増やすとキャッシュが作り直される。
PAYLOAD_VER = 7
#: 間引き後の面数の上限。ブラウザへ送る量を決める。
FACE_BUDGET = 170_000
#: テクスチャ付きのときの上限。**形は UV を運べれば足りる**——細かさは
#: アトラス（2.64mm/texel）が持つ。歩くときの当たり判定も平面図へ移したので
#: 面数は描画の費用だけに効く。
TEXTURED_FACE_BUDGET = 100_000
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


def _glb_chunks(path: str | Path):
    b = Path(path).read_bytes()
    _, _, total = struct.unpack_from("<III", b, 0)
    off, chunks = 12, {}
    while off < total:
        ln, ty = struct.unpack_from("<II", b, off)
        off += 8
        chunks[ty] = b[off:off + ln]
        off += ln
    return json.loads(chunks[0x4E4F534A].decode("utf-8")), chunks[0x004E4942]


def read_textured(path: str | Path):
    """テクスチャ付き GLB から位置・UV・面を読む。無ければ None。"""
    p = Path(path)
    if not p.exists():
        return None
    g, binc = _glb_chunks(p)
    prim = g["meshes"][0]["primitives"][0]
    if "TEXCOORD_0" not in prim["attributes"]:
        return None

    def acc(i: int, dtype: str, comp: int) -> np.ndarray:
        a = g["accessors"][i]
        bv = g["bufferViews"][a["bufferView"]]
        start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        return np.frombuffer(binc, dtype=dtype, count=a["count"] * comp,
                             offset=start).reshape(-1, comp)

    V = acc(prim["attributes"]["POSITION"], "<f4", 3).astype(np.float64)
    UV = acc(prim["attributes"]["TEXCOORD_0"], "<f4", 2).astype(np.float64)
    idx = g["accessors"][prim["indices"]]
    dt = {5125: "<u4", 5123: "<u2"}[idx["componentType"]]
    F = acc(prim["indices"], dt, 1).reshape(-1, 3).astype(np.int64)
    return V, UV, F


def atlas_bytes(path: str | Path) -> tuple[bytes, str] | None:
    """テクスチャ付き GLB に埋まっている画像を取り出す。"""
    p = Path(path)
    if not p.exists():
        return None
    g, binc = _glb_chunks(p)
    if not g.get("images"):
        return None
    im = g["images"][0]
    bv = g["bufferViews"][im["bufferView"]]
    o = bv.get("byteOffset", 0)
    return binc[o:o + bv["byteLength"]], im.get("mimeType", "image/jpeg")


#: この明るさ以下を「撮れていない」とみなす（0-255）。アトラスの未着色は
#: 真っ黒で書かれる。暗いだけの本物を巻き込まないよう低めに取る。
ATLAS_EMPTY = 6
#: 埋めたアトラスを書き戻すときの JPEG 品質。**既知の texel を変えたくない**
#: ので高めに取る。実測で q=92 は差の平均 1.02（2.96MB）、q=95 は 0.45
#: （3.67MB）。元が 3.67MB なので、95 なら大きさを変えずに済む。
ATLAS_QUALITY = 95


def _pushpull(img: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """ピラミッドへ畳んでから戻し、重みの無いところを埋める（push-pull）。

    **バイキュービックでは届かない。** 補間は既知の点のあいだしか埋められず、
    この穴は縁から最大 38 texel（約 100mm）奥まっている。畳めばどこまで奥でも
    色が届く。O(N) で反復も要らない。

    **色は近傍からしか来ない。** 各 texel は「自分の升目に値がある一番細かい
    段」から取るので、穴の周りに色があればそこで決まる。段を 64 texel で
    打ち切っても結果が変わらないことを実測で確かめた（差の中央値 0.0）。

    1×1 まで畳む。2×2 で止めると、その升目が空のとき埋め残る。
    拡大は float のまま行う。uint8 を経由すると暗い穴が 0 へ張り付く。
    """
    from PIL import Image

    accs, wts = [], []
    c = (img * valid[..., None]).astype(np.float32)
    m = valid.astype(np.float32)
    accs.append(c)
    wts.append(m)
    while c.shape[0] > 1 or c.shape[1] > 1:
        if c.shape[0] % 2:
            c = np.concatenate([c, np.zeros((1,) + c.shape[1:], np.float32)], 0)
            m = np.concatenate([m, np.zeros((1, m.shape[1]), np.float32)], 0)
        if c.shape[1] % 2:
            c = np.concatenate([c, np.zeros((c.shape[0], 1, 3), np.float32)], 1)
            m = np.concatenate([m, np.zeros((m.shape[0], 1), np.float32)], 1)
        h2, w2 = c.shape[0] // 2, c.shape[1] // 2
        c = c.reshape(h2, 2, w2, 2, 3).sum((1, 3))
        m = m.reshape(h2, 2, w2, 2).sum((1, 3))
        accs.append(c)
        wts.append(m)

    out = None
    for i in range(len(accs) - 1, -1, -1):
        a, ww = accs[i], wts[i]
        nz = ww > 0
        cur = np.zeros_like(a)
        cur[nz] = a[nz] / ww[nz][:, None]
        if out is not None:
            up = np.stack([
                np.asarray(Image.fromarray(out[:, :, k], mode="F")
                           .resize((a.shape[1], a.shape[0]), Image.BICUBIC))
                for k in range(3)], axis=2)
            cur[~nz] = up[~nz]
        out = cur
    return out[:img.shape[0], :img.shape[1]]


def fill_atlas(data: bytes) -> bytes:
    """アトラスの黒い穴を、まわりの色で埋める。

    **埋めるのはチャートの中に閉じた穴だけ**（＝撮れていない面。実測でアトラス
    の 3.22%）。歩いて見えるのはここだけで、チャートの外の隙間（21.7%）は
    三角形が参照しない。

    隙間を黒のまま残しても縮小表示で困らない。撮影アプリの膨張がチャートの
    縁から中央値 31 texel（約 83mm）伸びており、黒が滲むのは mip 4 段目
    （texel 42mm）より粗いところだけ。

    埋めた色は測った値ではない。まわりの平均が滑らかに伸びているだけで、
    模様は作らない。見ていない場所に模様を描くより、のっぺりしているほうが
    「ここは撮れていない」と分かる。既知の texel は変えない。
    """
    from io import BytesIO

    from PIL import Image
    from scipy import ndimage

    img = Image.open(BytesIO(data)).convert("RGB")
    A = np.asarray(img).astype(np.float32)
    valid = A.max(axis=2) > ATLAS_EMPTY
    if valid.all():
        return data

    lab, n = ndimage.label(~valid)
    border = set(np.unique(np.concatenate(
        [lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    holes = np.isin(lab, [i for i in range(1, n + 1) if i not in border])
    if not holes.any():
        return data

    out = A.copy()
    out[holes] = _pushpull(A, valid)[holes]
    buf = BytesIO()
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(
        buf, format="JPEG", quality=ATLAS_QUALITY)
    return buf.getvalue()


def cluster(V: np.ndarray, C: np.ndarray, F: np.ndarray, cell: float,
            UV: np.ndarray | None = None, uv_cell: float = 0.004):
    """頂点クラスタリングで間引く。格子に丸めて併合し、潰れた面を捨てる。

    **部品ごとに呼ぶので、部品は自分だけの頂点を持つ。** 壁と床が頂点を共有
    しないため、壁を動かすと継ぎ目は引き伸びずにそのまま開く。

    `UV` を渡すと、**UV も鍵に入れて**まとめる。位置だけで丸めると、アトラスの
    チャートの継ぎ目をまたいで UV が平均され、テクスチャがちぎれる。
    """
    key = np.floor(V / cell).astype(np.int64)
    if UV is not None:
        key = np.column_stack([key, np.floor(UV / uv_cell).astype(np.int64)])
    _, inv = np.unique(key, axis=0, return_inverse=True)
    n = int(inv.max()) + 1
    pos = np.zeros((n, 3)); col = np.zeros((n, 3)); cnt = np.zeros(n)
    np.add.at(pos, inv, V)
    np.add.at(col, inv, C.astype(np.float64))
    np.add.at(cnt, inv, 1)
    pos /= cnt[:, None]
    col /= cnt[:, None]
    uv = None
    if UV is not None:
        uv = np.zeros((n, 2))
        np.add.at(uv, inv, UV)
        uv /= cnt[:, None]
    nf = inv[F]
    keep = (nf[:, 0] != nf[:, 1]) & (nf[:, 1] != nf[:, 2]) & (nf[:, 0] != nf[:, 2])
    nf = nf[keep]
    if len(nf) == 0:
        return pos[:0], col[:0], nf, (None if uv is None else uv[:0])
    used, remap = np.unique(nf, return_inverse=True)
    return (pos[used], col[used], remap.reshape(-1, 3),
            None if uv is None else uv[used])


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
               uv: np.ndarray | None = None,
               min_area: float = COMPONENT_MIN_AREA):
    """浮いた小片を落とす。連結成分ごとの面積で見る。

    部品に切り分けたあとに呼ぶ。床と天井は壁を外した時点で別々の成分になる
    が、どちらも十分大きいので残る。
    """
    if len(f) == 0:
        return p, c, f, uv
    # **繋がりは位置で見る。** UV を鍵に入れて間引くと、アトラスのチャートの
    # 継ぎ目ごとに頂点が割れて位相が切れる。頂点番号のまま数えると成分が
    # 30 個から 5,196 個に増え、本物の面を 13.6%（7.86 m²）消してしまう。
    _, wid = np.unique(np.round(p / 1e-4).astype(np.int64), axis=0,
                       return_inverse=True)
    fw = wid[f]
    e = np.vstack([fw[:, [0, 1]], fw[:, [1, 2]], fw[:, [2, 0]]])
    n = int(wid.max()) + 1
    g = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n))
    k, lab = connected_components(g, directed=False)
    if k == 1:
        return p, c, f, uv
    t = p[f]
    ar = np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1) / 2
    fl = lab[fw[:, 0]]
    area = np.zeros(k)
    np.add.at(area, fl, ar)
    keep = area[fl] >= min_area
    if keep.all():
        return p, c, f, uv
    f = f[keep]
    if len(f) == 0:
        return p[:0], c[:0], f, (None if uv is None else uv[:0])
    used, remap = np.unique(f, return_inverse=True)
    return (p[used], c[used], remap.reshape(-1, 3),
            None if uv is None else uv[used])


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


def surface_colors(C: np.ndarray, F: np.ndarray,
                   cls: np.ndarray | None) -> dict:
    """床・天井・壁それぞれの代表色。**撮れていない隙間を塞ぐのに使う。**

    平均ではなく中央値を取る。撮り残しの縁には暗い値が混じるので、平均だと
    引きずられる。
    """
    out = {}
    if cls is None:
        return out
    for name, ks in (("floor", (2,)), ("ceiling", (3,)), ("wall", (1, 6, 7))):
        m = np.isin(cls, ks)
        if m.sum() < 50:
            continue
        v = C[F[m]].reshape(-1, 3)
        out[name] = [int(x) for x in np.median(v, axis=0)]
    return out


def _b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def build(bundle: str | Path, face_budget: int | None = None) -> dict:
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

    # **テクスチャ付きがあればそちらを使う。** 色の密度が面積あたり 235 倍
    # （頂点カラー 40.5mm 間隔 に対し 2.64mm/texel）。
    #
    # ただし mesh.glb は UV の継ぎ目で頂点を割っているぶん並びが違う。面の
    # 並びも一致しない（面数と面積は同じでも重心の差が中央値 1.0m）ので、
    # mesh_class.bin（mesh.ply の並び）をそのままは使えない。同じ形なので
    # **位置と重心で引き直す。**
    UV = None
    tex = read_textured(bundle / "mesh.glb")
    if tex is not None and len(tex[2]) == len(F):
        Vt, UV, Ft = tex
        C = C[cKDTree(V).query(Vt)[1]]
        if cls is not None:
            cls = cls[cKDTree(V[F].mean(axis=1)).query(Vt[Ft].mean(axis=1))[1]]
        V, F = Vt, Ft
    else:
        UV = None
    if face_budget is None:
        face_budget = TEXTURED_FACE_BUDGET if UV is not None else FACE_BUDGET

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
        p, c, f, u = drop_small(*cluster(Vl, C, F[sel], OBJECT_CELL,
                                         UV=UV))
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
        if u is not None:
            parts[-1]["uv"] = _b64(u.astype("<f4"))
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
        groups = [drop_small(*cluster(Vl, C, room, cell, UV=UV))]
        for _, sel in wall_sel:
            groups.append(drop_small(*cluster(Vl, C, F[sel], cell, UV=UV)))
        total = sum(len(g[2]) for g in groups)
        if total + used_faces <= face_budget:
            break
    p, c, f, u = groups[0]
    for (k, _), (wp, wc, wf, wu) in zip(wall_sel, groups[1:]):
        if len(wf) == 0:
            continue
        wid, a, b = wall_lines[k]
        part = dict(id=f"__wall__{wid}", label=f"壁 {wid}", kind="wall",
                    wall=wid, a=a, b=b, faces=len(wf),
                    pos=_b64(wp.astype("<f4")),
                    col=_b64(wc.round().astype("u1")),
                    idx=_b64(wf.astype("<u4")))
        if wu is not None:
            part["uv"] = _b64(wu.astype("<f4"))
        parts.insert(0, part)
    rp = dict(id="__room__", label="部屋", kind="room", faces=len(f),
              pos=_b64(p.astype("<f4")), col=_b64(c.round().astype("u1")),
              idx=_b64(f.astype("<u4")))
    if u is not None:
        rp["uv"] = _b64(u.astype("<f4"))
    parts.insert(0, rp)

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
                hasClass=cls is not None,
                textured=UV is not None,
                fillColors=surface_colors(C, F, cls))
