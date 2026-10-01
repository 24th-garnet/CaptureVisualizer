"""壁への追従のための重み（webgeom.wall_weights / top_slots / cluster）。"""
import numpy as np

from mdr2colmap import segment, webgeom


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


def test_wall_faces_are_assigned_to_their_wall():
    V, F, cls = _box_room()
    own = webgeom.wall_owner(V, F, cls, WALLS)
    assert own is not None and len(own) == len(F)
    # 立っている面はすべてどれかの壁に付く
    tri = V[F]
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    standing = np.abs(nrm[:, 1]) < 0.35
    assert (own[standing] >= 0).all()
    # しかも正しい壁に付く（z=0 の面は w0）
    cen = tri.mean(axis=1)
    z0 = standing & (cen[:, 2] < 0.01)
    assert (own[z0] == 0).all(), set(own[z0].tolist())


def test_floor_is_not_a_wall():
    V, F, cls = _box_room()
    own = webgeom.wall_owner(V, F, cls, WALLS)
    tri = V[F]
    flat = tri[:, :, 1].max(axis=1) < 1e-9
    assert flat.any()
    assert (own[flat] == -1).all(), "床が壁に取り込まれている"


def test_unclassified_but_standing_counts_as_wall():
    """分類が none でも立っていれば壁。実測で壁の近くの none 面の 48.7% が
    立っており、落とすと壁に穴が開く。"""
    V, F, cls = _box_room()
    cls = cls.copy()
    tri = V[F]
    cen = tri.mean(axis=1)
    target = (cls == 1) & (cen[:, 2] < 0.01)
    cls[target] = 0                                  # none にしてみる
    own = webgeom.wall_owner(V, F, cls, WALLS)
    assert (own[target] == 0).all()


def test_a_wall_far_from_every_line_is_left_alone():
    """平面図に無い壁（間仕切りの残骸など）は動かさない。"""
    V, F, cls = _box_room()
    far = [("w0", [0.0, 10.0], [3.0, 10.0])]
    own = webgeom.wall_owner(V, F, cls, far)
    assert (own == -1).all()


def test_no_classification_means_no_assignment():
    V, F, _ = _box_room()
    assert webgeom.wall_owner(V, F, None, WALLS) is None


def test_cluster_gives_each_part_its_own_vertices():
    """部品ごとに呼ぶので頂点は共有されない。だから継ぎ目は裂けて開く。"""
    V, F, cls = _box_room()
    own = webgeom.wall_owner(V, F, cls, WALLS)
    a = webgeom.cluster(V, np.zeros((len(V), 3), np.uint8), F[own == 0], 0.05)
    b = webgeom.cluster(V, np.zeros((len(V), 3), np.uint8), F[own == 1], 0.05)
    assert a[3] is None and b[3] is None          # UV を渡していないので None
    assert len(a[0]) and len(b[0])
    shared = {tuple(np.round(q, 6)) for q in a[0]} & {tuple(np.round(q, 6)) for q in b[0]}
    # 角で座標が一致する頂点はあり得るが、別配列なので動かしても連動しない
    assert a[2].max() < len(a[0]) and b[2].max() < len(b[0])


def _room_with_aircon():
    """壁 w0（z=0）に棚状の突出物を付けた部屋。

    突出物は壁と同じ 0.1m 刻みで刻む。`face_adjacency` は辺の共有で繋がりを
    見るので、刻みを合わせないと壁と地続きにならない。
    """
    V, F, C = [], [], []
    n, h = 30, 24
    _grid([0, 0, 0.0], [3, 0, 0], [0, 2.4, 0], n, h, 1, V, F, C)
    _grid([0, 0, 3.0], [3, 0, 0], [0, 2.4, 0], n, h, 1, V, F, C)
    _grid([0.0, 0, 0], [0, 0, 3], [0, 2.4, 0], n, h, 1, V, F, C)
    _grid([3.0, 0, 0], [0, 0, 3], [0, 2.4, 0], n, h, 1, V, F, C)
    _grid([0, 0, 0], [3, 0, 0], [0, 0, 3], n, n, 2, V, F, C)
    first = len(F)
    # 高さ 1.8m、壁から 0.3m 出た水平な板。分類は none、寝ているので
    # 「立っている面」の規則では拾われない。
    _grid([1.2, 1.8, 0.0], [0.8, 0, 0], [0, 0, 0.3], 8, 3, 0, V, F, C)
    aircon = np.zeros(len(F), bool)
    aircon[first:] = True
    return np.array(V, float), np.array(F), np.array(C, np.uint8), aircon


def test_protrusion_is_not_picked_up_without_adjacency():
    V, F, cls, air = _room_with_aircon()
    own = webgeom.wall_owner(V, F, cls, WALLS)
    assert (own[air] == -1).all(), "隣接表なしで突出物が拾われている"


def test_protrusion_moves_with_its_wall():
    """エアコンのような、壁にしか繋がっていない突出物は壁と一緒に動く。"""
    V, F, cls, air = _room_with_aircon()
    adj = segment.face_adjacency(F, V)
    own = webgeom.wall_owner(V, F, cls, WALLS, adj=adj, ceiling_y=2.4)
    assert (own[air] == 0).all(), set(own[air].tolist())


def test_roomplan_objects_touching_a_wall_stay_put():
    """RoomPlan が箱を持つ物は、壁に接していても壁と一緒に動かさない。

    位置は人が平面図で決めるもので、壁から決まるものではない。
    """
    V, F, cls, air = _room_with_aircon()
    adj = segment.face_adjacency(F, V)
    assigned = np.where(air, 0, -1)                  # 突出物を家具ということにする
    own = webgeom.wall_owner(V, F, cls, WALLS, assigned, adj, 2.4)
    assert (own[air] == -1).all(), "家具が壁に吸い込まれている"


def test_growth_does_not_cross_the_floor():
    V, F, cls, air = _room_with_aircon()
    adj = segment.face_adjacency(F, V)
    own = webgeom.wall_owner(V, F, cls, WALLS, adj=adj, ceiling_y=2.4)
    tri = V[F]
    flat = tri[:, :, 1].max(axis=1) < 1e-9
    assert (own[flat] == -1).all(), "床を伝って広がっている"


def test_growth_stops_at_the_reach():
    """壁から PROTRUSION_REACH より先へは伸びない。部屋じゅうへ広がらないため。"""
    V, F, C = [], [], []
    n, h = 30, 24
    _grid([0, 0, 0.0], [3, 0, 0], [0, 2.4, 0], n, h, 1, V, F, C)
    _grid([0, 0, 3.0], [3, 0, 0], [0, 2.4, 0], n, h, 1, V, F, C)
    _grid([0.0, 0, 0], [0, 0, 3], [0, 2.4, 0], n, h, 1, V, F, C)
    _grid([3.0, 0, 0], [0, 0, 3], [0, 2.4, 0], n, h, 1, V, F, C)
    _grid([0, 0, 0], [3, 0, 0], [0, 0, 3], n, n, 2, V, F, C)
    first = len(F)
    # 壁から 1.2m（PROTRUSION_REACH の 2 倍）伸びる板。途中で切れるはず。
    _grid([1.2, 1.8, 0.0], [0.8, 0, 0], [0, 0, 1.2], 8, 12, 0, V, F, C)
    V, F, cls = np.array(V, float), np.array(F), np.array(C, np.uint8)
    long = np.zeros(len(F), bool); long[first:] = True

    adj = segment.face_adjacency(F, V)
    own = webgeom.wall_owner(V, F, cls, WALLS, adj=adj, ceiling_y=2.4)
    z = V[F].mean(axis=1)[:, 2]
    took = long & (own >= 0)
    assert took.any(), "根元すら拾われていない"
    assert not long[own >= 0].all() or took.sum() < long.sum(), "全部拾っている"
    assert z[took].max() <= webgeom.PROTRUSION_REACH + 1e-9, z[took].max()
    assert (own[long & (z > webgeom.PROTRUSION_REACH)] == -1).all()


def test_small_components_are_dropped():
    """中空に浮いた小片を落とす。床と天井は別成分だが十分大きいので残る。"""
    V = np.array([[0, 0, 0], [1, 0, 0], [0, 0, 1],          # 1 辺 1m の床
                  [5, 1, 5], [5.02, 1, 5], [5, 1, 5.02]])   # 2cm の小片
    C = np.zeros((6, 3), np.uint8)
    F = np.array([[0, 1, 2], [3, 4, 5]])
    p, c, f, _ = webgeom.drop_small(V, C, F, min_area=0.02)
    assert len(f) == 1, f
    assert len(p) == 3
    assert np.allclose(np.sort(p[f[0]], axis=0), np.sort(V[:3], axis=0))


def test_nothing_is_dropped_when_all_parts_are_big():
    V = np.array([[0, 0, 0], [1, 0, 0], [0, 0, 1], [5, 1, 5], [6, 1, 5], [5, 1, 6]])
    C = np.zeros((6, 3), np.uint8)
    F = np.array([[0, 1, 2], [3, 4, 5]])
    _, _, f, _ = webgeom.drop_small(V, C, F, min_area=0.02)
    assert len(f) == 2


def test_wall_sides_are_measured_not_assumed():
    """室内側は床の面がある側で決める。巻き方向には頼らない。"""
    V, F, cls = _box_room()
    sides = webgeom.wall_sides(V, F, cls, WALLS)
    assert sides == [1, 1, 1, 1], sides
    # 向きを逆にした壁は -1 になる
    flipped = [(i, b, a) for i, a, b in WALLS]
    assert webgeom.wall_sides(V, F, cls, flipped) == [-1, -1, -1, -1]


def test_wall_sides_without_classification():
    """分類が無くても、低い面を床とみなして測れる。"""
    V, F, _ = _box_room()
    assert webgeom.wall_sides(V, F, None, WALLS) == [1, 1, 1, 1]


def test_uv_is_part_of_the_cluster_key():
    """UV も鍵に入れる。位置だけで丸めると、アトラスの継ぎ目をまたいで UV が
    平均され、テクスチャがちぎれる。"""
    # 同じ場所にあるが UV が離れた 2 枚（＝チャートの継ぎ目）
    V = np.array([[0, 0, 0], [0.3, 0, 0], [0, 0, 0.3],
                  [0.001, 0, 0], [0.3, 0, 0.001], [0.001, 0, 0.3]], float)
    UV = np.array([[0.1, 0.1], [0.2, 0.1], [0.1, 0.2],
                   [0.8, 0.8], [0.9, 0.8], [0.8, 0.9]])
    C = np.zeros((6, 3), np.uint8)
    F = np.array([[0, 1, 2], [3, 4, 5]])
    _, _, f_pos, _ = webgeom.cluster(V, C, F, 0.5)
    p, _, f_uv, uv = webgeom.cluster(V, C, F, 0.5, UV=UV)
    assert len(f_pos) < len(f_uv), "位置だけだと 2 枚が溶けて消える"
    assert uv is not None and len(uv) == len(p)
    # 継ぎ目の両側が混ざっていない
    assert uv.min() < 0.3 and uv.max() > 0.7, uv


def test_small_parts_are_counted_by_position_not_by_uv_split():
    """UV で割れた頂点のまま数えると、本物の面まで小片に見える。"""
    # 1 辺 0.5m の板を 2 枚。中央で UV だけ割れている（位置は共有）。
    V = np.array([[0, 0, 0], [0.5, 0, 0], [0, 0, 0.5], [0.5, 0, 0.5],
                  [0.5, 0, 0], [0.5, 0, 0.5]], float)
    C = np.zeros((6, 3), np.uint8)
    F = np.array([[0, 1, 2], [4, 5, 3]])          # 頂点番号は別だが位置は連続
    _, _, f, _ = webgeom.drop_small(V, C, F, min_area=0.05)
    assert len(f) == 2, "位置で繋がっているのに切られている"


def _jpeg(arr, quality=98):
    from io import BytesIO

    from PIL import Image
    b = BytesIO()
    Image.fromarray(arr.astype(np.uint8)).save(b, format="JPEG", quality=quality)
    return b.getvalue()


def _decode(data):
    from io import BytesIO

    from PIL import Image
    return np.asarray(Image.open(BytesIO(data)).convert("RGB")).astype(int)


def test_atlas_holes_are_filled_from_the_neighbours():
    """撮れていない黒い領域を、まわりの色で埋める。"""
    a = np.full((128, 128, 3), 180, np.uint8)
    a[40:90, 40:90] = 0                       # 50×50 の穴
    out = _decode(webgeom.fill_atlas(_jpeg(a)))
    hole = out[55:75, 55:75]
    assert hole.min() > 100, hole.min()       # 黒が残っていない
    assert abs(hole.mean() - 180) < 25, hole.mean()


def test_a_hole_larger_than_any_kernel_is_still_filled():
    """バイキュービックでは届かない大きさでも埋まる（ピラミッドで畳むため）。"""
    a = np.full((256, 256, 3), 200, np.uint8)
    a[28:228, 28:228] = 0                     # 200×200
    out = _decode(webgeom.fill_atlas(_jpeg(a)))
    assert out[128, 128].max() > 100, out[128, 128]


def test_known_texels_are_left_alone():
    """既知の texel は変えない。

    **JPEG の入れ直しぶんと比べる。** 素の差で測ると圧縮の劣化を算入して
    しまい、何を見ているのか分からなくなる。
    """
    y, x = np.mgrid[0:128, 0:128]
    a = np.stack([y * 2 % 256, x * 2 % 256, (x + y) % 256], axis=2).astype(np.uint8)
    a = np.clip(a, 20, 240)
    a[50:70, 50:70] = 0
    src = _jpeg(a)
    keep = _decode(src).max(axis=2) > webgeom.ATLAS_EMPTY
    # 埋めずに同じ品質で入れ直しただけのもの
    plain = _decode(_jpeg(_decode(src), quality=webgeom.ATLAS_QUALITY))
    out = _decode(webgeom.fill_atlas(src))
    assert np.abs(out[keep] - plain[keep]).mean() < 0.5, \
        np.abs(out[keep] - plain[keep]).mean()


def test_an_atlas_without_holes_is_returned_untouched():
    a = np.full((64, 64, 3), 120, np.uint8)
    data = _jpeg(a)
    assert webgeom.fill_atlas(data) is data


def test_the_gutter_is_left_black():
    """チャートの外（外周へ繋がる黒）は埋めない。三角形が参照しないため。"""
    a = np.zeros((64, 64, 3), np.uint8)
    a[20:44, 20:44] = 200                      # 真ん中にチャートが 1 枚
    out = _decode(webgeom.fill_atlas(_jpeg(a)))
    assert out[2, 2].max() <= webgeom.ATLAS_EMPTY, out[2, 2]
    assert out[32, 32].max() > 150


def test_a_hole_is_filled_however_deep_it_sits():
    """1×1 まで畳むので、縁から遠い穴でも色が届く。2×2 で止めると残った。"""
    a = np.full((96, 96, 3), 200, np.uint8)
    a[8:88, 8:88] = 0                          # 縁から 40 texel 奥まで黒
    out = _decode(webgeom.fill_atlas(_jpeg(a)))
    assert out[48, 48].max() > 100, out[48, 48]


def test_odd_sized_images_do_not_break_the_pyramid():
    """辺が 2 の冪でなくても畳める。切り捨てると形が合わなくなった。"""
    a = np.full((67, 53, 3), 150, np.uint8)
    a[25:35, 20:30] = 0
    out = _decode(webgeom.fill_atlas(_jpeg(a)))
    assert out[30, 25].max() > 80, out[30, 25]
