"""平面図の編集（壁のドラッグ・開口の追従・取り消し）を JavaScriptCore で動かす。

ブラウザを立ち上げずに app.js の編集まわりを確かめる。DOM は tests/planedit.js
の中で最小限に作ってある。jsc が無い環境（macOS 以外）では飛ばす。
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
JSC = Path("/System/Library/Frameworks/JavaScriptCore.framework"
           "/Versions/A/Helpers/jsc")

#: 実測した 1 室（room-d2444e36）の形。4 壁が 0mm で閉じ、3 枚に開口がある。
ROOM = {
    "source": "roomplan",
    "angle": 26.57,
    "rot": [[0.894361, 0.447346], [-0.447346, 0.894361]],
    "extent": [3.1347, 3.5754],
    "roomName": "洋室",
    "floor": [[0.0, 0.0], [3.1347, 0.0], [3.1347, 3.5754], [0.0, 3.5754]],
    "walls": [
        {"id": "w0", "a": [0.0, 3.5754], "b": [0.0, 0.0], "height": 2.408,
         "thickness": 0.12,
         "openings": [{"id": "w0-o0", "s": 0.0638, "e": 0.7981, "cat": "door",
                       "sill": 0.0, "h": 2.1269}]},
        {"id": "w1", "a": [3.1347, 0.0], "b": [3.1347, 3.5754], "height": 2.408,
         "thickness": 0.12,
         "openings": [{"id": "w1-o0", "s": 0.9178, "e": 2.5778, "cat": "door",
                       "sill": 0.0, "h": 2.1269}]},
        {"id": "w2", "a": [3.1347, 3.5754], "b": [0.0, 3.5754], "height": 2.408,
         "thickness": 0.12,
         "openings": [{"id": "w2-o0", "s": 1.5464, "e": 2.2601, "cat": "door",
                       "sill": 0.0, "h": 2.1269}]},
        {"id": "w3", "a": [0.0, 0.0], "b": [3.1347, 0.0], "height": 2.408,
         "thickness": 0.12, "openings": []},
    ],
    "objects": [
        {"id": "o0", "label": "テーブル", "c": [1.5, 1.8], "w": 1.2, "d": 0.8,
         "h": 0.72, "yaw": 90.0},
    ],
}


@pytest.mark.skipif(not JSC.exists(), reason="JavaScriptCore の jsc が無い")
def test_plan_editing(tmp_path):
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps(ROOM))
    conf = tmp_path / "conf.js"
    conf.write_text(
        f'var APP_JS = {json.dumps(str(ROOT / "mdr2colmap" / "web" / "app.js"))};\n'
        f'var PLAN_JSON = {json.dumps(str(plan))};\n')
    r = subprocess.run([str(JSC), str(conf), str(ROOT / "tests" / "planedit.js")],
                       capture_output=True, text=True, timeout=60)
    out = r.stdout + r.stderr
    assert "ALL PASS" in out, out
