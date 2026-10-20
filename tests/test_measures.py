"""実測 JSON の書き出し。**数量拾いとの契約を直したら落ちる**ように書く。

実際の `.mdr` には依らない。平面図の dict を合成して食わせる。
"""
from __future__ import annotations

import json

import pytest

from mdr2colmap import measures


def wall(a, b, openings=(), height=2.48):
    return {"id": "w", "a": list(a), "b": list(b), "height": height,
            "thickness": 0.12, "openings": list(openings)}


def plan(**kw):
    base = {
        "source": "roomplan", "roomName": "居室", "area": 19.434,
        "areaSource": "壁", "floorY": 0.0, "ceilingY": 2.48,
        "walls": [wall((0, 0), (4.55, 0)), wall((4.55, 0), (4.55, 4.27)),
                  wall((4.55, 4.27), (0, 4.27)), wall((0, 4.27), (0, 0))],
        "objects": [],
    }
    return base | kw


def build(**kw):
    return measures.build(plan(**kw), plan_id="room-a")


def room(**kw):
    return build(**kw)["rooms"][0]


def test_契約の版を名乗る():
    assert build()["schema_version"] == measures.SCHEMA


def test_長さは_mm_の整数で出す():
    # 整数にすると拾い側の算術に丸め誤差が入らない
    r = room()
    assert r["perimeter"] == 17640
    assert isinstance(r["perimeter"], int)


def test_周長は壁の長さの和():
    # (4.55 + 4.27) * 2 = 17.64 m
    assert room()["perimeter"] == 17640


def test_壁の面積は開口を抜く前の見付面積():
    """**開口はここでは引かない。** 引くのは拾い側（QuantityTakeoff）の仕事。

    1 か所いくつ以下を引かないかは積算基準の規約で、幾何を知っているこちらは
    持っていない。ここで引くと拾い側がもう一度引き、**開口が二重に抜ける**。
    先に引いていた頃は、ドア幅ぶんの床から天井までの帯を抜いていたので、
    量としても間違っていた（抜くべきは開口の面積だけ）。
    """
    # 周長 17.64m × 壁高 2.48m = 43.747。開口 1.69 × 1.11 は引かない
    r = room(walls=[wall((0, 0), (4.55, 0), [
        {"id": "o", "s": 1.43, "e": 3.12, "cat": "window", "sill": 0.82, "h": 1.11}]),
        wall((4.55, 0), (4.55, 4.27)), wall((4.55, 4.27), (0, 4.27)),
        wall((0, 4.27), (0, 0))])
    assert r["wall_area"] == pytest.approx(43.747, abs=1e-3)


def test_壁の面積は開口の合計より小さくならない():
    """**破れていた不変条件。** 引きすぎれば仕上げる面が開口より狭くなる。"""
    r = room(walls=[wall((0, 0), (4.55, 0), [
        {"id": "o", "s": 1.43, "e": 3.12, "cat": "window", "sill": 0.82, "h": 1.11}]),
        wall((4.55, 0), (4.55, 4.27)), wall((4.55, 4.27), (0, 4.27)),
        wall((0, 4.27), (0, 0))])
    holes = sum((o["width"] / 1000) * (o["height"] / 1000) for o in r["openings"])
    assert r["wall_area"] > holes


def test_重なる開口は畳んでから引く():
    # 引きすぎると壁が負になる
    w = wall((0, 0), (4.0, 0), [
        {"id": "a", "s": 1.0, "e": 2.0, "cat": "door", "sill": 0, "h": 2.0},
        {"id": "b", "s": 1.5, "e": 2.5, "cat": "door", "sill": 0, "h": 2.0}])
    assert measures._net_length(w) == pytest.approx(2.5)


def test_開口が壁より長くても負にしない():
    w = wall((0, 0), (1.0, 0), [
        {"id": "a", "s": 0, "e": 5.0, "cat": "opening", "sill": 0, "h": 2.0}])
    assert measures._net_length(w) == 0.0


def test_開口の幅は始点と終点の差():
    r = room(walls=[wall((0, 0), (4.55, 0), [
        {"id": "o", "s": 1.43, "e": 3.12, "cat": "window", "sill": 0.82, "h": 1.11}])])
    o = r["openings"][0]
    assert (o["width"], o["height"], o["sill"]) == (1690, 1110, 820)


def test_床まで届く建具は窓台が_0():
    r = room(walls=[wall((0, 0), (4, 0), [
        {"id": "o", "s": 1, "e": 1.8, "cat": "door", "sill": 0, "h": 1.99}])])
    assert r["openings"][0]["sill"] == 0


def test_家具は同じ品目をまとめて数える():
    r = room(objects=[{"id": "1", "category": "storage", "label": "収納"},
                      {"id": "2", "category": "storage", "label": "収納"},
                      {"id": "3", "category": "sofa", "label": "ソファ"}])
    got = {f["code"]: f["count"] for f in r["furniture"]}
    assert got == {"storage": 2, "sofa": 1}


# --- 測ったものと仮定したものの区別 -------------------------------------

def test_壁厚は仮定だと名乗る():
    # RoomPlan は壁厚を返さない。0.12m は作図上の仮定
    r = room()
    assert r["basis"]["wall_area"] == "既定"
    assert "壁厚を返さない" in r["basis_note"]["wall_area"]


def test_天井高は実測だと名乗る():
    # 床と天井の差から取れている。**豊かなはずの CAD より強い根拠**
    assert room()["basis"]["height"] == "実測"


def test_面積の出どころを根拠の語彙に写す():
    assert room(areaSource="壁")["basis"]["area"] == "実測"
    assert room(areaSource="床外形")["basis"]["area"] == "推定"
    assert room(areaSource="外接矩形")["basis"]["area"] == "外接"


def test_室を分けないことを申告する():
    # 「居室・キッチン」は 2 区画が 1 室に潰れている強い証拠
    assert build()["basis"]["partition"] == "未計測"


def test_柱型を見ていないことを申告する():
    # **0 件は「無い」ではない**
    assert build()["basis"]["holes"] == "未計測"


def test_開き勝手を測っていないことを申告する():
    assert build()["basis"]["swing"] == "未計測"


def test_メッシュ経路は開口を検出しないと申告する():
    # 0 件を「開口が無い」と読ませない。壁の面積が過大になる
    b = build(source="mesh", areaSource="メッシュ内法")
    assert b["basis"]["openings"] == "未検出"
    assert b["rooms"][0]["basis"]["openings"] == "未検出"


def test_根拠の語彙だけを使う():
    # 拾い側が固定語彙で読むので、自由記述を basis に混ぜない
    allowed = {"実測", "推定", "代用", "既定", "外接", "未検出", "未計測"}
    b = build(areaSource="外接矩形", source="mesh")
    assert set(b["basis"].values()) <= allowed
    assert set(b["rooms"][0]["basis"].values()) <= allowed


def test_json_にできる():
    json.dumps(build(), ensure_ascii=False)


# --- 立面 ---------------------------------------------------------------

def test_開口のある壁だけを立面にする():
    p = plan(walls=[
        wall((0, 0), (4, 0), [{"id": "o", "s": 1, "e": 2.7, "cat": "window",
                               "sill": 0.8, "h": 1.1}]),
        wall((4, 0), (4, 3)),
    ])
    got = measures.elevations(p)
    assert len(got) == 1
    assert got[0]["openings"][0]["sill"] == 800


def test_立面の開口は上端まで出す():
    p = plan(walls=[wall((0, 0), (4, 0), [
        {"id": "o", "s": 1, "e": 2.7, "cat": "window", "sill": 0.8, "h": 1.1}])])
    o = measures.elevations(p)[0]["openings"][0]
    assert (o["lo"], o["hi"], o["sill"], o["head"]) == (1000, 2700, 800, 1900)


def test_立面の実体は開口に食われた分だけ切れる():
    p = plan(walls=[wall((0, 0), (4, 0), [
        {"id": "o", "s": 1, "e": 2.0, "cat": "door", "sill": 0, "h": 2.0}])])
    spans = measures.elevations(p)[0]["solid"]
    assert spans == [{"lo": 0, "hi": 1000}, {"lo": 2000, "hi": 4000}]


def test_開口が壁の高さを超えても天井で止める():
    p = plan(walls=[wall((0, 0), (4, 0), [
        {"id": "o", "s": 1, "e": 2.0, "cat": "door", "sill": 0, "h": 9.9}],
        height=2.48)])
    assert measures.elevations(p)[0]["openings"][0]["head"] == 2480


def test_開口の無い壁は立面にしない():
    assert measures.elevations(plan()) == []
