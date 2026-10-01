"""壁への追従のための重み（webgeom.wall_weights / top_slots / cluster）。"""
import numpy as np

from mdr2colmap import webgeom


def _grid(origin, du, dv, nu, nv, cls_value, V, F, C):
    """矩形を nu×nv に刻んで三角形にする。**細かさが要る**——重みは「壁の頂点
    までの距離」で落とすので、頂点の間隔が SEAM_BLEND より粗いと落ちすぎる。
    実測のメッシュは平均 25mm 間隔で、減衰幅 200mm より十分細かい。
    """
    o = np.array(origin, float); u = np.array(du, float); v = np.array(dv, float)
    base = len(V)
    for i in range(nu + 1):
        for j in range(nv + 1):
            V.append(o + u * (i / nu) + v * (j / nv))
    w = nv + 1
    for i in range(nu):
        for j in range(nv):
            a = base + i * w + j
            F.append([a, a + w, a + w + 1]); F.append([a, a + w + 1, a + 1])
            C.extend([cls_value, cls_value])


def _box_room(step=0.1):
    """3×3m・高さ 2.4m の部屋。壁 4 枚と床を step 刻みで刻む。"""
    V, F, C = [], [], []
    n, h = int(3 / step), int(2.4 / step)
    _grid([0, 0, 0.0], [3, 0, 0], [0, 2.4, 0], n, h, 1, V, F, C)   # z=0
    _grid([0, 0, 3.0], [3, 0, 0], [0, 2.4, 0], n, h, 1, V, F, C)   # z=3
    _grid([0.0, 0, 0], [0, 0, 3], [0, 2.4, 0], n, h, 1, V, F, C)   # x=0
    _grid([3.0, 0, 0], [0, 0, 3], [0, 2.4, 0], n, h, 1, V, F, C)   # x=3
    _grid([0, 0, 0], [3, 0, 0], [0, 0, 3], n, n, 2, V, F, C)       # 床
    return np.array(V, float), np.array(F), np.array(C, np.uint8)


#: 平面図側の壁。並びと向きは webapp.derive_plan と同じ約束。
WALLS = [("w0", [0.0, 0.0], [3.0, 0.0]), ("w1", [3.0, 0.0], [3.0, 3.0]),
         ("w2", [3.0, 3.0], [0.0, 3.0]), ("w3", [0.0, 3.0], [0.0, 0.0])]


def test_wall_faces_get_full_weight():
    V, F, cls = _box_room()
    W = webgeom.wall_weights(V, F, cls, WALLS)
    assert W.shape == (len(V), 4)
    # 壁の頂点（高さを持つもの）は、どれか 1 枚に完全に従う
    high = V[:, 1] > 1.0
    assert np.allclose(W[high].max(axis=1), 1.0)


def test_floor_far_from_walls_follows_nothing():
    V, F, cls = _box_room()
    W = webgeom.wall_weights(V, F, cls, WALLS)
    mid = (np.abs(V[:, 0] - 1.5) < 0.3) & (np.abs(V[:, 2] - 1.5) < 0.3)
    assert mid.any()
    assert W[mid].max() == 0.0, "部屋の真ん中の床がどれかの壁に従っている"


def test_weight_falls_off_from_the_seam():
    """床は壁の際から SEAM_BLEND かけて 0 へ落ちる。**壁そのものは剛体。**"""
    V, F, cls = _box_room()
    W = webgeom.wall_weights(V, F, cls, WALLS)[:, 0]        # w0 は z=0 の壁
    floor = (V[:, 1] < 1e-9) & (np.abs(V[:, 0] - 1.5) < 1e-9)
    z = V[floor][:, 2]; w = W[floor]
    order = np.argsort(z)
    z, w = z[order], w[order]
    assert w[0] == 1.0, "壁の際の床が従っていない"
    assert all(w[i] >= w[i + 1] - 1e-9 for i in range(len(w) - 1)), w
    off = z[w == 0.0]
    assert off.min() <= webgeom.SEAM_BLEND + 0.11, off.min()
    assert ((0.0 < w) & (w < 1.0)).sum() >= 1, w


def test_slots_are_normalised_so_corners_do_not_double():
    """角は 2 枚の壁に 1 ずつ従う。足すと変位が二重になるので割って揃える。"""
    W = np.array([[1.0, 1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0], [0.4, 0.3, 0.0, 0.0]])
    idx, wt = webgeom.top_slots(W)
    assert idx.shape == (3, webgeom.SLOTS)
    # 1 バイトに丸めるので 0.5 は 128/255。合計は 1 の前後 1/255 に収まる。
    assert abs(wt[0].sum() / 255 - 1.0) <= 2 / 255    # 角は半分ずつ
    assert wt[1][0] == 255 and idx[1][1] == 255
    assert abs(wt[2].sum() / 255 - 0.7) < 0.01  # 1 以下はそのまま


def test_cluster_carries_the_weights_through():
    """間引きで平均されるので、滲んだ境界が中間の重みになる。"""
    V = np.array([[0.0, 0, 0], [0.01, 0, 0], [1.0, 0, 0], [0.0, 0, 1.0]])
    C = np.zeros((4, 3), np.uint8)
    F = np.array([[0, 2, 3], [1, 2, 3]])
    W = np.array([[1.0], [0.0], [0.0], [0.0]])
    p, c, f, w = webgeom.cluster(V, C, F, 0.1, extra=W)
    assert w is not None and len(w) == len(p)
    assert 0.0 < w.max() < 1.0                 # 2 頂点が溶けて中間の値になる


def test_no_classification_means_no_weights():
    V, F, _ = _box_room()
    assert webgeom.wall_weights(V, F, None, WALLS) is None
