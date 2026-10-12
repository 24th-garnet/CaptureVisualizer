"""平面図から中立の実測 JSON を作る。

数量拾い（[QuantityTakeoff][qt]）との契約で、**幾何を解決して渡す側**。面積も周長も
壁の正味長も、それを知っているのはこちらなので、ここで出して数で渡す。拾い側は
算術と拾い方の規約だけを持つ。

**入口は `plan` の dict。** `RoomLayout` ではなく `plan_payload()` が返す素の辞書を
見るのは `dxf.build(plan, moves)` と同じで、「**画面で見たものがそのまま出る**」という
Web 側の約束を守るため。壁を動かして保存した図面から拾えば、その壁で数量が出る。

**測ったものと仮定したものを区別する。** 同じ壁面積でも、実測の壁厚から出した値と
仮定した 0.12m から出した値では信じてよい度合いが違う。`areaSource` が既に面積の
出どころを自己申告しているので、その思想を全部の量に広げて `basis` に書く。

ここが名乗る仮定は 3 つ。

| | |
|---|---|
| `partition` | **室を分けない。** 壁のループ全体を 1 室として出す |
| `holes` | 柱型・PS という概念が無い。**0 件は「無い」ではない** |
| `swing` | 建具の開き勝手を測っていない |

[qt]: https://github.com/24th-garnet/QuantityTakeoff
"""
from __future__ import annotations

import math

SCHEMA = "mdr-measures-1"

#: 開口の種別。RoomPlan は 3 つしか返さない
CATEGORIES = {"door": "door", "window": "window", "opening": "opening"}

#: 面積の出どころ → 根拠の語彙
AREA_BASIS = {"壁": "実測", "床外形": "推定", "メッシュ内法": "推定", "外接矩形": "外接"}


def _mm(m: float) -> int:
    """m を mm の整数へ。**整数にすると拾い側の算術に丸め誤差が入らない。**"""
    return int(round(float(m) * 1000))


def build(plan: dict, moves: dict | None = None, *,
          plan_id: str, name: str = "") -> dict:
    """平面図から実測 JSON を組む。**numpy も RoomLayout も要らない。**"""
    walls = plan.get("walls") or []
    height_m = max((float(w.get("height") or 0) for w in walls), default=0.0)
    if not height_m:
        height_m = float(plan.get("ceilingY") or 0) - float(plan.get("floorY") or 0)

    openings = [o for w in walls for o in (w.get("openings") or [])]
    perimeter = sum(_wall_length(w) for w in walls)
    net = sum(_net_length(w) for w in walls)
    wall_area = net * height_m

    area_source = str(plan.get("areaSource") or "")
    mesh = plan.get("source") == "mesh"

    room = {
        "id": "whole",
        "name": str(plan.get("roomName") or "撮影範囲"),
        "floor_area": round(float(plan.get("area") or 0), 3),
        "ceiling_area": round(float(plan.get("area") or 0), 3),
        "perimeter": _mm(perimeter),
        "height": _mm(height_m),
        "wall_area": round(wall_area, 3),
        "openings": [_opening(o) for o in openings],
        "furniture": _furniture(plan),
        "basis": {
            "area": AREA_BASIS.get(area_source, "推定"),
            # 天井高は床と天井の差から取れている。**ここは実測**
            "height": "実測",
            # 壁厚は RoomPlan が返さない
            "wall_area": "既定",
        },
        "basis_note": {
            "area": f"面積は{area_source}から" if area_source else "",
            "height": "床と天井の差から",
            "wall_area": "RoomPlan は壁厚を返さない。作図上の 0.12m に基づく",
        },
    }
    if mesh:
        # メッシュから起こした経路は開口を検出しない。
        # **0 件を「開口が無い」と読ませない**
        room["basis"]["openings"] = "未検出"
        room["basis_note"]["openings"] = (
            "メッシュから起こした経路は開口を検出しない。"
            "壁の面積が過大で、建具の員数は 0 になる")

    sheet_basis = {"partition": "未計測", "holes": "未計測", "swing": "未計測"}
    note = {
        "partition": "スキャンは室を分けない。壁のループ全体を 1 室として出した",
        "holes": "柱型・PS という概念を持たない。0 件は「無い」ではない",
        "swing": "建具の開き勝手を測っていない",
    }
    if mesh:
        sheet_basis["openings"] = "未検出"
        note["openings"] = "メッシュから起こした経路は開口を検出しない"

    return {
        "schema_version": SCHEMA,
        "source": "capturevisualizer",
        "plan_id": plan_id,
        "name": name or plan_id,
        "rooms": [room],
        "basis": sheet_basis,
        "basis_note": note,
    }


def elevations(plan: dict) -> list[dict]:
    """壁ごとの立面。**開口のある壁だけ。**

    必要な数はすべて平面図のペイロードに揃っている——壁の長さと高さ、開口の
    壁沿いの位置（`s` / `e`）、下端（`sill`）と高さ（`h`）。`app.js` の
    `overlayBoxes()` が既に腰壁 `[0, sill]` と垂れ壁 `[top, H]` を 3D で起こして
    いるので、それを高さ方向に潰すだけ。

    **建具の割付と開き勝手は描かない。** 測っていないものを描けるふりをしない。
    """
    out = []
    for wall in plan.get("walls") or []:
        openings = wall.get("openings") or []
        if not openings:
            continue
        total = _wall_length(wall)
        height = float(wall.get("height") or 0)
        rects = []
        for o in openings:
            lo = max(0.0, float(o.get("s", 0)))
            hi = min(total, float(o.get("e", 0)))
            if hi <= lo:
                continue
            sill = max(0.0, min(float(o.get("sill") or 0), height))
            head = max(sill, min(sill + float(o.get("h") or 0), height))
            rects.append({"id": str(o.get("id") or ""),
                          "kind": CATEGORIES.get(str(o.get("cat") or ""), "opening"),
                          "lo": _mm(lo), "hi": _mm(hi),
                          "sill": _mm(sill), "head": _mm(head)})
        if not rects:
            continue
        out.append({"wall": str(wall.get("id") or ""),
                    "length": _mm(total), "height": _mm(height),
                    "solid": [{"lo": _mm(lo), "hi": _mm(hi)}
                              for lo, hi in _solid_spans(wall, total)],
                    "openings": rects})
    return out


def _solid_spans(wall: dict, total: float) -> list[tuple[float, float]]:
    """開口に食われていない区間。`roomplan.Wall.solid_spans` と同じ考え方。"""
    holes = sorted(((max(0.0, float(o.get("s", 0))), min(total, float(o.get("e", 0))))
                    for o in (wall.get("openings") or [])), key=lambda t: t[0])
    out: list[tuple[float, float]] = []
    cursor = 0.0
    for lo, hi in holes:
        lo, hi = max(lo, cursor), max(hi, cursor)
        if lo > cursor:
            out.append((cursor, lo))
        cursor = max(cursor, hi)
    if cursor < total:
        out.append((cursor, total))
    return out


def _wall_length(wall: dict) -> float:
    a, b = wall.get("a") or [0, 0], wall.get("b") or [0, 0]
    return math.dist((float(a[0]), float(a[1])), (float(b[0]), float(b[1])))


def _net_length(wall: dict) -> float:
    """開口を抜いた壁の正味長さ（m）。

    `roomplan.Wall.solid_spans` と同じ考え方を dict の上でやる。重なる開口は
    畳んでから引く——引きすぎると壁が負になる。
    """
    total = _wall_length(wall)
    spans = sorted(((max(0.0, float(o.get("s", 0))), min(total, float(o.get("e", 0))))
                    for o in (wall.get("openings") or [])), key=lambda t: t[0])
    cut, cursor = 0.0, 0.0
    for lo, hi in spans:
        lo, hi = max(lo, cursor), max(hi, cursor)
        if hi > lo:
            cut += hi - lo
            cursor = hi
    return max(total - cut, 0.0)


def _opening(o: dict) -> dict:
    width = max(float(o.get("e", 0)) - float(o.get("s", 0)), 0.0)
    return {
        "id": str(o.get("id") or ""),
        "kind": CATEGORIES.get(str(o.get("cat") or ""), "opening"),
        "width": _mm(width),
        "height": _mm(float(o.get("h") or 0)),
        "sill": _mm(float(o.get("sill") or 0)),
    }


def _furniture(plan: dict) -> list[dict]:
    """家具の員数。**同じ品目はまとめて数える。**"""
    counts: dict[str, dict] = {}
    for obj in plan.get("objects") or []:
        code = str(obj.get("category") or "")
        if not code:
            continue
        got = counts.setdefault(code, {"code": code,
                                       "label": str(obj.get("label") or code),
                                       "count": 0})
        got["count"] += 1
    return [counts[k] for k in sorted(counts)]
