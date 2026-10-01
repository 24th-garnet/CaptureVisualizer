"""平面図を DXF へ書き出す。

本格的な編集は CAD へ渡してから行う前提なので、ここは受け渡しの形を作るまで。

**R12（AC1009）のテキスト形式で書く。** 外部依存を持たずに手で組め、どの CAD
でも読めるため。R12 には LWPOLYLINE が無いので POLYLINE / VERTEX / SEQEND を
使う。寸法も DIMENSION ではなく線と文字で描く——R12 の DIMENSION は寸法スタイル
表と結びついていて、手で組むと読み手によって見え方が変わる。

単位はミリメートル。図の向きは画面と揃える（X = 平面図の z、Y = 平面図の x）。
画面で見たものがそのまま CAD で開く。
"""
from __future__ import annotations

import math

#: レイヤ名は ASCII 大文字にする。**R12 にレイヤ名の文字コードの定めが無く**、
#: 日本語名は読み手の環境で化ける。名前は AIA 系の慣習に寄せ、説明を添える。
LAYERS = [
    ("A-WALL", 7, "壁（断面）"),
    ("A-OPNG", 5, "開口（窓・出入口）"),
    ("A-FURN", 8, "家具"),
    ("A-DIMS", 2, "寸法"),
    ("A-ANNO", 3, "室名"),
]

#: 文字高さ（モデル空間の mm）。1/50 で紙上 3.5mm と 2.5mm になる。
H_NAME = 175.0
H_TEXT = 125.0

#: 壁厚が無いときの作図上の仮定（m）。webapp.WALL_THICKNESS と同じ値。
WALL_THICKNESS = 0.12


def _g(code: int, value) -> str:
    return f"{code}\n{value}\n"


def _pt(x: float, y: float, base: int = 10) -> str:
    return _g(base, f"{x:.3f}") + _g(base + 10, f"{y:.3f}") + _g(base + 20, "0.0")


def _line(layer: str, a, b) -> str:
    return _g(0, "LINE") + _g(8, layer) + _pt(*a) + _pt(*b, base=11)


def _poly(layer: str, pts) -> str:
    out = [_g(0, "POLYLINE"), _g(8, layer), _g(66, 1), _g(70, 1),
           _pt(0.0, 0.0)]
    for p in pts:
        out.append(_g(0, "VERTEX") + _g(8, layer) + _pt(*p))
    out.append(_g(0, "SEQEND") + _g(8, layer))
    return "".join(out)


def _text(layer: str, p, s: str, h: float) -> str:
    # 72 = 1 で中央寄せ。そのとき位置は第 2 点（11/21）で決まるので両方書く。
    return (_g(0, "TEXT") + _g(8, layer) + _pt(*p) + _g(40, f"{h:.1f}")
            + _g(1, s) + _g(50, "0.0") + _g(72, 1) + _pt(*p, base=11))


def _header(lo, hi) -> str:
    return (_g(0, "SECTION") + _g(2, "HEADER")
            + _g(9, "$ACADVER") + _g(1, "AC1009")
            # 日本語の文字列を R12 に載せるための宣言。中身も cp932 で書く。
            + _g(9, "$DWGCODEPAGE") + _g(3, "ANSI_932")
            + _g(9, "$INSBASE") + _pt(0.0, 0.0)
            + _g(9, "$EXTMIN") + _pt(*lo)
            + _g(9, "$EXTMAX") + _pt(*hi)
            + _g(0, "ENDSEC"))


def _tables() -> str:
    out = [_g(0, "SECTION"), _g(2, "TABLES"),
           _g(0, "TABLE"), _g(2, "LAYER"), _g(70, len(LAYERS))]
    for name, color, _ in LAYERS:
        out.append(_g(0, "LAYER") + _g(2, name) + _g(70, 0)
                   + _g(62, color) + _g(6, "CONTINUOUS"))
    out.append(_g(0, "ENDTAB") + _g(0, "ENDSEC"))
    return "".join(out)


def _moved_objects(plan: dict, moves: dict | None) -> list[dict]:
    """家具を moves.json のぶんだけ動かす。保存されているのは world 座標。"""
    objs = [dict(o) for o in plan.get("objects", [])]
    if not moves:
        return objs
    R = plan.get("rot") or [[1.0, 0.0], [0.0, 1.0]]
    by_id = {o["id"]: o for o in objs}
    for m in moves.get("moved", []):
        o = by_id.get(m.get("id"))
        if o is None:
            continue
        d = m.get("delta", {})
        dx, dz = float(d.get("dx", 0.0)), float(d.get("dz", 0.0))
        o["c"] = [o["c"][0] + R[0][0] * dx + R[0][1] * dz,
                  o["c"][1] + R[1][0] * dx + R[1][1] * dz]
        o["yaw"] = o.get("yaw", 0.0) + float(d.get("dyaw", 0.0))
    return objs


def build(plan: dict, moves: dict | None = None) -> str:
    """平面図から DXF の文字列を作る。`moves` を渡すと家具を動かした形で出す。"""
    def to(p):
        """平面図 (x, z) → DXF (X, Y)。画面と同じ向きで、単位は mm。"""
        return (p[1] * 1000.0, p[0] * 1000.0)

    ents: list[str] = []
    walls = plan.get("walls", [])

    for w in walls:
        T = float(w.get("thickness") or WALL_THICKNESS)
        a, b = w["a"], w["b"]
        dx, dz = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dz) or 1.0
        u = (dx / L, dz / L)
        n = (-u[1], u[0])

        def at(t):
            return (a[0] + u[0] * t, a[1] + u[1] * t)

        def off(p, s):
            return (p[0] + n[0] * s, p[1] + n[1] * s)

        spans = sorted(((max(0.0, min(L, o["s"])), max(0.0, min(L, o["e"])),
                         o.get("cat"))
                        for o in w.get("openings", [])), key=lambda v: v[0])
        cur = 0.0
        for s, e, cat in [*spans, (L, L, None)]:
            if s > cur:
                p, q = at(cur), at(s)
                ents.append(_poly("A-WALL", [to(off(p, T / 2)), to(off(q, T / 2)),
                                             to(off(q, -T / 2)), to(off(p, -T / 2))]))
            if cat is None:
                break
            p, q = at(s), at(e)
            if cat == "window":
                for k in (0.5, -0.5, 0.15, -0.15):
                    ents.append(_line("A-OPNG", to(off(p, T * k)), to(off(q, T * k))))
            else:
                # 出入口。**開き勝手は出ないので扉を開いて描かない。**
                for r in (p, q, at((s + e) / 2)):
                    ents.append(_line("A-OPNG", to(off(r, T / 2)), to(off(r, -T / 2))))
            cur = e

    for o in _moved_objects(plan, moves):
        c, hw, hd = o["c"], o["w"] / 2, o["d"] / 2
        th = math.radians(o.get("yaw", 0.0))
        ux, uz = math.cos(th), math.sin(th)
        corners = [(c[0] + ux * sw - uz * sd, c[1] + uz * sw + ux * sd)
                   for sw, sd in ((hw, hd), (hw, -hd), (-hw, -hd), (-hw, hd))]
        ents.append(_poly("A-FURN", [to(p) for p in corners]))
        # **家具は形状だけでなく名称と寸法を併記する**（インテリア製図通則 解説 9）。
        ents.append(_text("A-FURN", to((c[0] + 0.06, c[1])), o.get("label", ""), H_TEXT))
        ents.append(_text("A-FURN", to((c[0] - 0.09, c[1])),
                          f"{round(o['w'] * 1000)}×{round(o['d'] * 1000)}"
                          f"×{round(o['h'] * 1000)}", H_TEXT))

    pts = [p for w in walls for p in (w["a"], w["b"])]
    if pts:
        x0 = min(p[0] for p in pts); x1 = max(p[0] for p in pts)
        z0 = min(p[1] for p in pts); z1 = max(p[1] for p in pts)
        # 全体の内法寸法。DIMENSION は使わず、補助線・寸法線・文字で組む。
        #
        # **押し出しは DXF の座標で決める。** 平面図の (x, z) で向きを判断すると
        # 画面と軸が入れ替わっているぶんだけ符号を取り違え、寸法線が室内へ入る。
        X0, Y0 = to((x0, z0))
        X1, Y1 = to((x1, z1))
        PUSH = 450.0                          # 図から離す距離（mm）
        for horiz, label in ((True, round(X1 - X0)), (False, round(Y1 - Y0))):
            if horiz:                          # 幅。図の下へ出す。
                ends = ((X0, Y0), (X1, Y0))
                off = (0.0, -PUSH)
            else:                              # 奥行。図の左へ出す。
                ends = ((X0, Y0), (X0, Y1))
                off = (-PUSH, 0.0)
            pa = (ends[0][0] + off[0], ends[0][1] + off[1])
            pb = (ends[1][0] + off[0], ends[1][1] + off[1])
            ents.append(_line("A-DIMS", ends[0], pa))   # 寸法補助線
            ents.append(_line("A-DIMS", ends[1], pb))
            ents.append(_line("A-DIMS", pa, pb))        # 寸法線
            ents.append(_text("A-DIMS",
                              ((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2 + 60.0),
                              f"{label:,}", H_TEXT))
        name = plan.get("roomName")
        if name:
            ents.append(_text("A-ANNO", to(((x0 + x1) / 2, (z0 + z1) / 2)),
                              name, H_NAME))
        lo = (X0 - 1000.0, Y0 - 1000.0)
        hi = (X1 + 1000.0, Y1 + 1000.0)
    else:
        lo, hi = (0.0, 0.0), (1000.0, 1000.0)

    return (_header(lo, hi) + _tables()
            + _g(0, "SECTION") + _g(2, "ENTITIES") + "".join(ents) + _g(0, "ENDSEC")
            + _g(0, "EOF"))


def encode(text: str) -> bytes:
    """cp932 で書く。$DWGCODEPAGE に ANSI_932 と宣言しているため。

    収まらない文字は落とさず `?` にする。図面が開けなくなるより読める方がよい。
    """
    return text.encode("cp932", errors="replace")
