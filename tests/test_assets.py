"""置換用アセット（GLB）の読み込み。

**ブラウザに読み手を足さないための経路。** three.js r128 の UMD には
GLTFLoader が無く、別途読むと「three.js が落ちたら全部死ぬ」経路が増える。
"""
import base64
import json
import struct

import numpy as np
import pytest

from mdr2colmap import assets


def _glb(gltf: dict, bin_: bytes = b"") -> bytes:
    j = json.dumps(gltf).encode()
    j += b" " * (-len(j) % 4)
    b = bin_ + b"\x00" * (-len(bin_) % 4)
    total = 12 + 8 + len(j) + (8 + len(b) if b else 0)
    out = struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(j), 0x4E4F534A) + j
    if b:
        out += struct.pack("<II", len(b), 0x004E4942) + b
    return out


def _simple(tmp_path, *, matrix=None, stride=False, uv=True):
    """1 枚の三角形だけの GLB を作る。"""
    pos = np.array([[0, 0, 0], [2, 0, 0], [0, 3, 0]], "<f4")
    tex = np.array([[0, 0], [1, 0], [0, 1]], "<f4")
    idx = np.array([0, 1, 2], "<u4")
    if stride:
        # 位置と UV を交互に並べる（書き出し側がよくやる）
        inter = np.zeros((3, 5), "<f4")
        inter[:, :3] = pos
        inter[:, 3:] = tex
        bin_ = inter.tobytes() + idx.tobytes()
        views = [dict(buffer=0, byteOffset=0, byteLength=60, byteStride=20),
                 dict(buffer=0, byteOffset=60, byteLength=12)]
        acc = [dict(bufferView=0, byteOffset=0, componentType=5126, count=3, type="VEC3"),
               dict(bufferView=0, byteOffset=12, componentType=5126, count=3, type="VEC2"),
               dict(bufferView=1, componentType=5125, count=3, type="SCALAR")]
    else:
        bin_ = pos.tobytes() + tex.tobytes() + idx.tobytes()
        views = [dict(buffer=0, byteOffset=0, byteLength=36),
                 dict(buffer=0, byteOffset=36, byteLength=24),
                 dict(buffer=0, byteOffset=60, byteLength=12)]
        acc = [dict(bufferView=0, componentType=5126, count=3, type="VEC3"),
               dict(bufferView=1, componentType=5126, count=3, type="VEC2"),
               dict(bufferView=2, componentType=5125, count=3, type="SCALAR")]
    at = {"POSITION": 0}
    if uv:
        at["TEXCOORD_0"] = 1
    node = dict(mesh=0)
    if matrix is not None:
        node["matrix"] = matrix
    g = dict(asset=dict(version="2.0"), scene=0, scenes=[dict(nodes=[0])],
             nodes=[node],
             meshes=[dict(primitives=[dict(attributes=at, indices=2, material=0)])],
             materials=[dict(pbrMetallicRoughness=dict(baseColorFactor=[1, 0, 0, 1]))],
             buffers=[dict(byteLength=len(bin_))], bufferViews=views, accessors=acc)
    f = tmp_path / "a.glb"
    f.write_bytes(_glb(g, bin_))
    return f


def test_reads_positions_uv_and_faces(tmp_path):
    d = assets.read_glb(_simple(tmp_path))
    assert len(d["parts"]) == 1
    p = d["parts"][0]
    assert p["F"].shape == (1, 3)
    assert np.allclose(p["V"], [[0, 0, 0], [2, 0, 0], [0, 3, 0]])
    assert p["UV"] is not None and p["UV"].shape == (3, 2)


def test_interleaved_buffers(tmp_path):
    """**飛び飛びに並んだ頂点を読める。** 書き出し側がよく混ぜる。"""
    d = assets.read_glb(_simple(tmp_path, stride=True))
    p = d["parts"][0]
    assert np.allclose(p["V"], [[0, 0, 0], [2, 0, 0], [0, 3, 0]]), p["V"]
    assert np.allclose(p["UV"], [[0, 0], [1, 0], [0, 1]]), p["UV"]


def test_node_matrix_is_applied(tmp_path):
    """節点の行列は列優先で入っている。取り違えると形が転置する。"""
    m = [2, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  10, 0, 0, 1]   # x を 2 倍し +10
    d = assets.read_glb(_simple(tmp_path, matrix=m))
    assert np.allclose(d["parts"][0]["V"], [[10, 0, 0], [14, 0, 0], [10, 3, 0]])


def test_base_color_factor_becomes_a_colour(tmp_path):
    d = assets.read_glb(_simple(tmp_path))
    r, g, b = d["parts"][0]["color"]
    assert r > 200 and g < 30 and b < 30, (r, g, b)


def test_payload_centres_and_reports_size(tmp_path):
    doc, texs = assets.payload(_simple(tmp_path))
    assert doc["size"] == [2.0, 3.0, 1e-06] or doc["size"][0] == 2.0
    assert doc["faces"] == 1
    assert texs == []
    V = np.frombuffer(base64.b64decode(doc["parts"][0]["pos"]), "<f4").reshape(-1, 3)
    # **中心が原点。** 箱へ合わせるのはブラウザ側なので、ここで揃えておく。
    assert abs(V[:, 0].mean() - 0) < 1.0 and abs(V[:, :2].min()) <= 1.5
    assert abs((V[:, 0].max() + V[:, 0].min()) / 2) < 1e-5
    assert abs((V[:, 1].max() + V[:, 1].min()) / 2) < 1e-5


def test_a_file_that_is_not_glb_is_refused(tmp_path):
    f = tmp_path / "x.glb"
    f.write_bytes(b"not a glb at all")
    with pytest.raises(Exception):
        assets.read_glb(f)


def test_a_glb_without_triangles_is_refused(tmp_path):
    g = dict(asset=dict(version="2.0"), scene=0, scenes=[dict(nodes=[])], nodes=[])
    f = tmp_path / "e.glb"
    f.write_bytes(_glb(g))
    with pytest.raises(ValueError):
        assets.read_glb(f)
