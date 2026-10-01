"""DXF 書き出し。

外部のライブラリを入れずに済ませたいので、読み手の代わりに群コードを素で
たどって確かめる（開発中は ezdxf でも読ませ、監査が通ることを見ている）。
"""
import math

import pytest

from mdr2colmap import dxf
from tests.test_planedit import ROOM


def pairs(text: str):
    """DXF は「群コード」と「値」の 2 行ずつ。その並びに戻す。"""
    lines = text.split("\n")
    assert lines[-1] == "", "最後は改行で終わる"
    lines = lines[:-1]
    assert len(lines) % 2 == 0, "行数が偶数でない＝対になっていない"
    return [(int(lines[i]), lines[i + 1]) for i in range(0, len(lines), 2)]


def entities(text: str):
    """ENTITIES 節の中身を {種別, 群コード一覧} に割る。"""
    ps = pairs(text)
    i = ps.index((0, "SECTION"))
    while ps[i + 1] != (2, "ENTITIES"):
        i = ps.index((0, "SECTION"), i + 1)
    out, cur = [], None
    for code, val in ps[i + 2:]:
        if code == 0:
            if val == "ENDSEC":
                break
            cur = {"type": val, "codes": []}
            out.append(cur)
        elif cur is not None:
            cur["codes"].append((code, val))
    return out


def layer_of(e):
    return next(v for c, v in e["codes"] if c == 8)


def points(e):
    xs = [float(v) for c, v in e["codes"] if c == 10]
    ys = [float(v) for c, v in e["codes"] if c == 20]
    return list(zip(xs, ys))


def test_structure_is_balanced():
    t = dxf.build(ROOM)
    ps = pairs(t)
    assert ps[0] == (0, "SECTION")
    assert ps[-1] == (0, "EOF")
    assert sum(1 for p in ps if p == (0, "SECTION")) == 3      # HEADER/TABLES/ENTITIES
    assert sum(1 for p in ps if p == (0, "ENDSEC")) == 3
    assert (1, "AC1009") in ps                                  # R12
    assert sum(1 for p in ps if p == (0, "POLYLINE")) == \
           sum(1 for p in ps if p == (0, "SEQEND"))


def test_every_entity_sits_on_a_declared_layer():
    t = dxf.build(ROOM)
    declared = {n for n, _, _ in dxf.LAYERS}
    assert (2, "LAYER") in pairs(t)
    for e in entities(t):
        if e["type"] in ("POLYLINE", "LINE", "TEXT"):
            assert layer_of(e) in declared, (e["type"], layer_of(e))


def test_walls_are_closed_rectangles_of_the_right_thickness():
    es = [e for e in entities(dxf.build(ROOM))
          if e["type"] == "POLYLINE" and layer_of(e) == "A-WALL"]
    # 開口が 3 枚の壁を切るので、断面は 4 枚ではなく 7 枚になる
    assert len(es) == 7
    for e in es:
        assert (70, "1") in e["codes"], "閉じたポリラインでない"
    verts = [e for e in entities(dxf.build(ROOM)) if e["type"] == "VERTEX"]
    assert len(verts) == 7 * 4 + 1 * 4          # 壁 7 枚 + 家具 1 個、各 4 頂点


def test_wall_thickness_comes_out_in_millimetres():
    t = dxf.build(ROOM)
    es = entities(t)
    # 最初の壁の 4 頂点
    vs = [points(e)[0] for e in es if e["type"] == "VERTEX"][:4]
    w = math.dist(vs[0], vs[3])
    assert abs(w - 120.0) < 1e-6, w             # 0.12m = 120mm


def test_drawing_matches_the_screen_orientation():
    """X = 平面図の z、Y = 平面図の x。画面で見たものと同じ向きになる。"""
    t = dxf.build(ROOM)
    vs = [points(e)[0] for e in entities(t) if e["type"] == "VERTEX"]
    xs = [v[0] for v in vs]
    ys = [v[1] for v in vs]
    assert abs((max(xs) - min(xs)) - (3575.4 + 120)) < 1.0     # z 方向 + 壁厚
    assert abs((max(ys) - min(ys)) - (3134.7 + 120)) < 1.0     # x 方向 + 壁厚


def test_dimension_lines_stay_outside_the_plan():
    """寸法線が室内へ入らないこと。符号を取り違えると内側に落ちる。"""
    t = dxf.build(ROOM)
    es = entities(t)
    vs = [points(e)[0] for e in es if e["type"] == "VERTEX"]
    x0 = min(v[0] for v in vs)
    y0 = min(v[1] for v in vs)
    texts = [e for e in es if e["type"] == "TEXT" and layer_of(e) == "A-DIMS"]
    assert len(texts) == 2
    got = {next(v for c, v in e["codes"] if c == 1): points(e)[0] for e in texts}
    assert set(got) == {"3,575", "3,135"}
    assert got["3,575"][1] < y0, "幅の寸法が図の下に出ていない"
    assert got["3,135"][0] < x0, "奥行の寸法が図の左に出ていない"


def test_room_name_and_furniture_labels():
    es = entities(dxf.build(ROOM))
    anno = [e for e in es if layer_of(e) == "A-ANNO"]
    assert [next(v for c, v in e["codes"] if c == 1) for e in anno] == ["洋室"]
    furn = [next(v for c, v in e["codes"] if c == 1)
            for e in es if e["type"] == "TEXT" and layer_of(e) == "A-FURN"]
    assert "テーブル" in furn
    assert "1200×800×720" in furn, furn       # W×D×H がミリで入る


def test_openings_are_drawn_but_doors_are_not_swung():
    es = entities(dxf.build(ROOM))
    opng = [e for e in es if layer_of(e) == "A-OPNG"]
    # 出入口 3 つ × 方立 2 + 中央線 1 = 9 本。弧（ARC）は出さない。
    assert len(opng) == 9
    assert all(e["type"] == "LINE" for e in opng)
    assert not any(e["type"] == "ARC" for e in es)


def test_furniture_follows_moves():
    """家具は moves.json のぶんだけ動いた位置で出す。画面と揃えるため。"""
    base = entities(dxf.build(ROOM))
    moved = entities(dxf.build(ROOM, {"moved": [
        {"id": "o0", "delta": {"dx": 0.5, "dz": 0.0, "dyaw": 0.0}}]}))

    def furn(es):
        out, take = [], False
        for e in es:
            if e["type"] == "POLYLINE":
                take = layer_of(e) == "A-FURN"
            elif e["type"] == "VERTEX" and take:
                out.append(points(e)[0])
        return out

    a, b = furn(base), furn(moved)
    assert len(a) == 4 and len(b) == 4
    R = ROOM["rot"]
    # world の (0.5, 0) は図面の枠では R を掛けたぶん動く
    dx = R[0][0] * 0.5 * 1000
    dz = R[1][0] * 0.5 * 1000
    for p, q in zip(a, b):
        assert abs((q[0] - p[0]) - dz) < 1e-3     # DXF の X は図面の z
        assert abs((q[1] - p[1]) - dx) < 1e-3     # DXF の Y は図面の x


def test_japanese_text_is_written_as_cp932():
    """$DWGCODEPAGE に ANSI_932 と書くので、中身も cp932 で出す。"""
    t = dxf.build(ROOM)
    assert (3, "ANSI_932") in pairs(t)
    b = dxf.encode(t)
    assert "洋室".encode("cp932") in b
    assert b.decode("cp932") == t


def test_plan_without_walls_still_produces_a_file():
    t = dxf.build({"walls": [], "objects": []})
    assert pairs(t)[-1] == (0, "EOF")
    assert entities(t) == []
