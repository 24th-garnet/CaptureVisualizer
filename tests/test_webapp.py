"""Web アプリの読み取り。**壊れたバンドルで落ちないこと**が要点。

39 件の実データには、焼き込み前・RoomPlan なし・manifest が壊れている
ものが混ざる。一覧はそれら全部を並べられないといけない。
"""
import json
from pathlib import Path

from mdr2colmap import webapp


def make(root: Path, name: str, manifest=None, bake=None, files=()):
    d = root / name
    d.mkdir()
    if manifest is not None:
        (d / "manifest.json").write_text(json.dumps(manifest))
    if bake is not None:
        (d / "bake.json").write_text(json.dumps(bake))
    for f in files:
        (d / f).write_bytes(b"x")
    return d


def test_lists_only_mdr_directories(tmp_path):
    make(tmp_path, "room-a.mdr", manifest={"created_at": "2026-09-01T00:00:00"})
    (tmp_path / "notes.txt").write_text("x")
    (tmp_path / "Scaniverse").mkdir()
    out = webapp.scan_list(tmp_path)
    assert [s["id"] for s in out] == ["room-a.mdr"]


def test_newest_first(tmp_path):
    make(tmp_path, "room-old.mdr", manifest={"created_at": "2026-09-01T00:00:00"})
    make(tmp_path, "room-new.mdr", manifest={"created_at": "2026-09-20T00:00:00"})
    assert [s["name"] for s in webapp.scan_list(tmp_path)] == ["room-new", "room-old"]


def test_broken_manifest_still_lists(tmp_path):
    d = make(tmp_path, "room-broken.mdr")
    (d / "manifest.json").write_text("{ これは JSON ではない")
    out = webapp.scan_list(tmp_path)
    assert len(out) == 1
    assert out[0].get("created") is None


def test_flags_what_the_bundle_has(tmp_path):
    make(tmp_path, "room-full.mdr",
         manifest={"created_at": "2026-09-20T00:00:00", "frame_count": 375},
         bake={"elapsed_sec": 1.74, "triangles": 727754, "unfilled_ratio": 0.057,
               "unwrap_detail": {"mm_per_texel": 2.76}, "roomplan": {"build_sec": 5.7}},
         files=("room.json", "mesh_vc.glb", "mesh_class.bin"))
    s = webapp.scan_list(tmp_path)[0]
    assert s["hasRoom"] and s["hasVertexColor"] and s["hasClass"]
    assert not s["hasMoves"] and not s["hasArranged"]
    assert s["frames"] == 375
    assert s["mmPerTexel"] == 2.76
    assert s["roomplanSec"] == 5.7


def test_bundle_without_bake_is_fine(tmp_path):
    make(tmp_path, "room-raw.mdr", manifest={"created_at": "2026-09-20T00:00:00"})
    s = webapp.scan_list(tmp_path)[0]
    assert s["hasVertexColor"] is False
    assert "bakeSec" not in s or s["bakeSec"] is None


# --- 合言葉 -----------------------------------------------------------------
#
# **ここが破れると他人のスキャンを書き換えられる。** このアプリは
# moves.json と arranged.ply を書くので、外向きに出すなら必須。

import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest


def run_server(tmp_path, token="", read_only=False):
    webapp.Handler.root = tmp_path
    webapp.Handler.token = token
    webapp.Handler.read_only = read_only
    srv = ThreadingHTTPServer(("127.0.0.1", 0), webapp.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def get(url, token=None):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def post(url, token=None, body=b"{}"):
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def test_token_gates_every_route(tmp_path):
    make(tmp_path, "room-a.mdr", manifest={"created_at": "2026-09-01T00:00:00"})
    srv, base = run_server(tmp_path, token="secret")
    try:
        assert get(f"{base}/api/scans") == 401
        assert get(f"{base}/api/scans", "wrong") == 401
        assert get(f"{base}/api/scans", "secret") == 200
        assert post(f"{base}/api/scans/room-a.mdr/moves") == 401
    finally:
        srv.shutdown()


def test_read_only_refuses_writes(tmp_path):
    make(tmp_path, "room-a.mdr", manifest={"created_at": "2026-09-01T00:00:00"})
    srv, base = run_server(tmp_path, token="secret", read_only=True)
    try:
        assert get(f"{base}/api/scans", "secret") == 200
        assert post(f"{base}/api/scans/room-a.mdr/moves", "secret",
                    b'{"moved":[]}') == 403
        assert not (tmp_path / "room-a.mdr" / "moves.json").exists()
    finally:
        srv.shutdown()


def test_cannot_escape_the_root(tmp_path):
    make(tmp_path, "room-a.mdr", manifest={"created_at": "2026-09-01T00:00:00"})
    srv, base = run_server(tmp_path)
    try:
        assert get(f"{base}/api/scans/..%2f..%2fetc/plan") == 404
        assert get(f"{base}/api/scans/nope.mdr/plan") == 404
    finally:
        srv.shutdown()


# --- 編集の保存とロールバック -----------------------------------------------
#
# **編集後を正とする。** ただしスキャン直後へいつでも戻せること。
# 戻したときに識別子が変わると、家具の moves.json との対応が切れる。

def test_entities_have_stable_ids(tmp_path):
    import json as _json
    from mdr2colmap import webapp as W
    d = make(tmp_path, "room-a.mdr", manifest={"created_at": "2026-01-01T00:00:00"})
    _json.dump(_ROOM, open(d / "room.json", "w"))
    first = W.derive_plan(d)
    again = W.derive_plan(d)
    ids = [w["id"] for w in first["walls"]]
    assert ids == [w["id"] for w in again["walls"]], "導出のたびに識別子が変わる"
    assert len(set(ids)) == len(ids), "識別子が重複している"
    assert all("thickness" in w for w in first["walls"])


def test_edited_plan_wins_and_can_be_reverted(tmp_path):
    import json as _json
    from mdr2colmap import webapp as W
    d = make(tmp_path, "room-a.mdr", manifest={"created_at": "2026-01-01T00:00:00"})
    _json.dump(_ROOM, open(d / "room.json", "w"))
    base = W.derive_plan(d)

    edited = _json.loads(_json.dumps(base))
    edited["roomName"] = "書斎"
    edited["walls"][0]["a"] = [0.0, 9.0]
    W.save_plan(d, edited)

    got = W.plan_payload(d)
    assert got["roomName"] == "書斎"
    assert got["walls"][0]["a"] == [0.0, 9.0]
    assert got["edited"] is True
    # **元データは無傷。** room.json を書き換えていないこと。
    assert W.derive_plan(d)["walls"][0]["a"] == base["walls"][0]["a"]

    assert W.reset_plan(d)["reverted"] is True
    after = W.plan_payload(d)
    assert after["walls"][0]["a"] == base["walls"][0]["a"]
    assert not after.get("edited")
    assert [w["id"] for w in after["walls"]] == [w["id"] for w in base["walls"]]


def test_reset_without_edits_is_harmless(tmp_path):
    import json as _json
    from mdr2colmap import webapp as W
    d = make(tmp_path, "room-a.mdr", manifest={"created_at": "2026-01-01T00:00:00"})
    _json.dump(_ROOM, open(d / "room.json", "w"))
    assert W.reset_plan(d)["reverted"] is False
    assert W.plan_payload(d)["walls"]


#: 4 枚の壁が閉じた最小の RoomPlan。実データの形に合わせてある。
def _wall(cx, cz, w, ax):
    t = [[1.0, 0, 0, 0], [0, 1.0, 0, 0], [0, 0, 1.0, 0], [cx, 0.0, cz, 1.0]]
    if ax == "z":
        t[0] = [0, 0, -1.0, 0]
        t[2] = [1.0, 0, 0, 0]
    return {"identifier": f"wall-{cx}-{cz}", "dimensions": [w, 2.4, 0.0],
            "transform": [v for row in t for v in row],
            "category": {"wall": {}}, "confidence": {"high": {}}}


_ROOM = {
    "walls": [_wall(1.5, 0.0, 3.0, "x"), _wall(1.5, 3.0, 3.0, "x"),
              _wall(0.0, 1.5, 3.0, "z"), _wall(3.0, 1.5, 3.0, "z")],
    "doors": [], "windows": [], "openings": [], "objects": [],
    "sections": [], "floors": [],
    "version": 2, "story": 0,
}


def test_replacement_is_not_persisted(tmp_path):
    """置換はその場限り。**スキャンにも、別ファイルにも残さない。**

    残すと、次に開いた人が測ったものと置き換えたものを見分けられない。
    """
    from mdr2colmap import webapp
    b = tmp_path / "room-x.mdr"
    b.mkdir()
    (b / "manifest.json").write_text("{}")
    assert not hasattr(webapp, "REPLACE_FILE")
    assert "replaced" not in webapp.summary(b)
    assert sorted(p.name for p in b.iterdir()) == ["manifest.json"]


def test_asset_list_ignores_other_files(tmp_path):
    from mdr2colmap import webapp
    (tmp_path / "notes.txt").write_text("x")
    (tmp_path / "broken.glb").write_bytes(b"nope")
    assert webapp.asset_list(tmp_path) == []
    assert webapp.asset_list(tmp_path / "missing") == []


def test_comments_are_not_persisted(tmp_path):
    """コメントもその場限り。置換と同じ扱い。

    スキャンにも別ファイルにも残さない。残すと、次に開いた人が測ったものと
    書き加えたものを見分けられない。
    """
    from mdr2colmap import webapp
    b = tmp_path / "room-c.mdr"
    b.mkdir()
    (b / "manifest.json").write_text("{}")
    assert not hasattr(webapp, "COMMENT_FILE")
    assert not hasattr(webapp, "save_comments")
    assert "comments" not in webapp.summary(b)
    assert sorted(q.name for q in b.iterdir()) == ["manifest.json"]


def test_hidden_attribute_is_not_overridden_by_display():
    """`hidden` を付けた要素が、クラスの `display` に負けないこと。

    `[hidden]{display:none}` は UA の規定なので、`.cmtbox{display:flex}` の
    ような指定があると勝ってしまい、隠したはずの入力欄が出たままになる。
    """
    from mdr2colmap import webapp
    css = (webapp.WEB_ROOT / "style.css").read_text()
    html = (webapp.WEB_ROOT / "index.html").read_text()
    assert "[hidden]" in css and "display: none !important" in css
    # hidden を付けている要素が display を指定しているなら、上の規則が要る
    assert html.count("hidden>") + html.count('hidden ') >= 4


def test_walk_mode_does_not_hide_the_cursor():
    """歩くモードで `cursor: none` を指定しない。

    ポインタを固定している間はブラウザが隠すので要らず、コメントを書くために
    固定を外したときにカーソルを見失わせるだけになる。
    """
    from mdr2colmap import webapp
    css = (webapp.WEB_ROOT / "style.css").read_text()
    block = css[css.index(".stage.walking"):][:160]
    assert "cursor: none" not in block, block


def _css():
    from mdr2colmap import webapp
    return (webapp.WEB_ROOT / "style.css").read_text()


def test_drawing_line_weights_follow_the_standard():
    """線の太さはインテリア製図通則（表2）の符号化。

    **見た目を整えるときに巻き込んで変えない。** 太線・中線・細線の比は 4:2:1
    で、1/50 の図面では紙上 0.5 / 0.25 / 0.125mm にあたる。
    """
    import re
    css = _css()
    for name, w in (("--w-thick", 0.025), ("--w-mid", 0.0125), ("--w-thin", 0.00625)):
        m = re.search(re.escape(name) + r":\s*([0-9.]+)", css)
        assert m, name
        assert float(m.group(1)) == w, (name, m.group(1))
    # 比が 4:2:1 であること
    assert 0.025 / 0.0125 == 2 and 0.0125 / 0.00625 == 2


def test_drawing_symbols_keep_their_weights():
    """記号ごとの線の太さ。壁は太線、窓と出入口の中央線は細線、方立は太線。"""
    css = _css()
    want = {
        ".wall": "--w-thick",      # 壁の仕上線（断面の外形）
        ".win": "--w-thin",        # 窓一般
        ".jamb": "--w-thick",      # 出入口の方立
        ".door-bar": "--w-thin",   # 出入口一般の中央線
        ".dimline": "--w-thin",    # 寸法線
    }
    for sel, token in want.items():
        i = css.index(sel + " ")
        block = css[i:css.index("}", i)]
        assert token in block, (sel, block)


def test_the_plan_has_no_rounded_corners_or_shadows():
    """図面そのものに飾りを足さない。**製図に角丸も影も無い。**"""
    css = _css()
    for sel in (".wall", ".win", ".jamb", ".obj rect", ".ghost"):
        i = css.index(sel + " ")
        block = css[i:css.index("}", i)]
        assert "radius" not in block and "shadow" not in block, (sel, block)
