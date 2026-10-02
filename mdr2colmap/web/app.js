'use strict';
// 平面図と 3D は同じ枠（主方向で回し、原点は図面の左上、床が Y=0、単位 m）に
// 載っている。だから同期は引き算だけで済む。座標変換はここには無い。

const NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('plan');
const canvas = document.getElementById('gl');

let current = null;          // 選択中のバンドル id
let plan = null;             // 平面図のデータ
let state = new Map();       // id -> {dx, dz, dyaw}（m と度）
let sel = null;
let dirty = false;

/* 平面図の編集。
   **編集後を正とする。** ただし plan_edit.json を消せばスキャン直後へ戻る。
   壁は端点を溶接して節点グラフにする。RoomPlan は壁を独立した線分で返すが、
   実測したバンドルでは隣り合う端点が 0mm で一致していた。角を動かすと、そこに
   集まる壁がすべて追従する。 */
let editing = false;
let graph = null;            // {nodes: [{x, z}], walls: [{w, na, nb}]}
let hist = [];               // 平面図の控え（取り消し用）
let histAt = -1;
let planDirty = false;
let dragging = false;        // ドラッグ中は図面の外形を凍結する
let selWall = null;          // 選択中の壁 id（削除と情報表示のため）
let adding = false;          // 壁の追加を待っている
let addFrom = null;          // 壁を追加するときの 1 点目
const WELD = 0.05;           // 同じ節点とみなす距離（m）
const SNAP = 0.05;           // 50mm 刻み

const el = (tag, attrs, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  (parent || svg).appendChild(n);
  return n;
};
const fmt = (v, d = 0) => (v === null || v === undefined ? '—' : v.toFixed(d));
const api = (p, opts) => fetch(p, opts).then(r => r.json());
/** メートルをミリメートルの整数に。通則 7.2 により単位記号は付けない。 */
const mmv = m => Math.round(m * 1000).toLocaleString('en-US');

// --- 一覧 -------------------------------------------------------------------

async function loadList() {
  const box = document.getElementById('scans');
  box.innerHTML = '<p class="empty">読み込み中…</p>';
  const scans = await api('/api/scans');
  if (!scans.length) { box.innerHTML = '<p class="empty">.mdr が見つかりません</p>'; return; }
  box.innerHTML = '';
  for (const s of scans) {
    const d = document.createElement('div');
    d.className = 'scan' + (s.id === current ? ' sel' : '');
    d.dataset.id = s.id;
    const when = s.created ? s.created.slice(0, 16).replace('T', ' ') : '日時不明';
    const tags = [];
    if (s.hasRoom) tags.push('<span class="tag room">RoomPlan</span>');
    if (s.hasMoves) tags.push('<span class="tag moved">配置あり</span>');
    if (s.unfilled > 0.15) tags.push(`<span class="tag warn">未撮影 ${Math.round(s.unfilled * 100)}%</span>`);
    if (!s.hasVertexColor) tags.push('<span class="tag warn">3D なし</span>');
    d.innerHTML = `<div class="name">${s.name}</div>`
      + `<div class="meta"><span>${when}</span>`
      + `<span>${s.frames ?? '—'} 枚</span>`
      + `<span>${s.triangles ? (s.triangles / 1000).toFixed(0) + 'k 面' : '—'}</span></div>`
      + (tags.length ? `<div class="tags">${tags.join('')}</div>` : '');
    d.addEventListener('click', () => select(s.id));
    box.appendChild(d);
  }
}

// --- 選択 -------------------------------------------------------------------

async function select(id) {
  current = id;
  sel = null; dirty = false;
  document.querySelectorAll('.scan').forEach(n =>
    n.classList.toggle('sel', n.dataset.id === id));
  document.getElementById('placeholder').hidden = true;
  document.getElementById('content').hidden = false;
  document.getElementById('title').textContent = id.replace('.mdr', '');
  setStatus('');
  // 読み込み中の表示は出さない。キャッシュ済みなら一瞬で、
  // 出しても点滅するだけだった。失敗したときだけ `gl-note` を使う。
  document.getElementById('gl-note').hidden = true;

  const s = await api(`/api/scans/${id}`);
  document.getElementById('subtitle').textContent =
    [s.device, s.video ? `${s.video.width}×${s.video.height}` : null,
     s.duration ? `${s.duration.toFixed(0)} 秒` : null,
     s.frames ? `${s.frames} 枚` : null].filter(Boolean).join(' / ');
  facts(s);

  plan = await api(`/api/scans/${id}/plan`);
  if (plan.error) { setStatus(plan.error, true); return; }
  showPlanSource();
  state = new Map((plan.objects || []).map(o => [o.id, { dx: 0, dz: 0, dyaw: 0 }]));
  comments = [];                   // その場限り。スキャンを選び直せば消える
  replaceMap = {};                 // その場限り。スキャンを選び直せば戻る
  for (const [, n] of replaceNodes) if (scene) scene.remove(n);
  replaceNodes = new Map();
  const saved = await api(`/api/scans/${id}/moves`);
  for (const m of (saved.moved || [])) {
    if (!state.has(m.id)) continue;
    // 保存されているのは world 座標。図面の枠へ戻す（rot をそのまま掛ける）。
    const R = plan.rot, d = m.delta || {};
    state.set(m.id, { dx: R[0][0] * (d.dx || 0) + R[0][1] * (d.dz || 0),
                      dz: R[1][0] * (d.dx || 0) + R[1][1] * (d.dz || 0),
                      dyaw: d.dyaw || 0 });
  }
  graph = null; hist = []; histAt = -1; planDirty = false; dragging = false;
  selWall = null; adding = false; addFrom = null;
  if (editing) { buildGraph(); pushHistory(); }
  drawPlan();
  place();
  updateEditButtons();
  showEditBar();
  loadGeom(id);
}

/** 図面の出どころ。編集済みなら実測ではないことを明示する。 */
function showPlanSource() {
  const n = document.getElementById('plan-source');
  n.textContent = plan.edited ? '編集済み'
    : (plan.source === 'roomplan' ? 'RoomPlan' : 'メッシュ由来');
  n.className = plan.edited ? 'edited-mark' : 'muted';
}

function facts(s) {
  const dl = document.getElementById('facts');
  const rows = [
    ['三角形', s.triangles ? s.triangles.toLocaleString() : '—'],
    ['焼き込み', s.bakeSec ? s.bakeSec.toFixed(2) + ' 秒' : '—'],
    ['解像度', s.mmPerTexel ? s.mmPerTexel.toFixed(2) + ' mm/texel' : '—'],
    ['アトラス', s.atlas || '—'],
    ['未撮影', s.unfilled != null ? (s.unfilled * 100).toFixed(1) + '%' : '—'],
    ['RoomPlan', s.hasRoom ? (s.roomplanSec ? s.roomplanSec.toFixed(1) + ' 秒' : 'あり') : 'なし'],
    ['面分類', s.hasClass ? 'あり' : 'なし'],
  ];
  dl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const b = document.getElementById('badges');
  b.innerHTML = '';
}

// --- 編集の骨組み -----------------------------------------------------------

const r4 = v => Math.round(v * 10000) / 10000;

/** 壁の端点を溶接して節点グラフを作る。 */
function buildGraph() {
  const nodes = [];
  const find = p => {
    for (let i = 0; i < nodes.length; i++)
      if (Math.hypot(nodes[i].x - p[0], nodes[i].z - p[1]) < WELD) return i;
    nodes.push({ x: p[0], z: p[1] });
    return nodes.length - 1;
  };
  graph = { nodes, walls: plan.walls.map(w => ({ w, na: find(w.a), nb: find(w.b) })) };
}

/** 節点の座標を壁へ書き戻す。

    **開口は a 端からの距離を保つ。** 実務では開口の位置は壁の端からの実寸で
    決まるので、壁が伸び縮みしても s は動かさない。壁が縮んで開口が収まらなく
    なったときだけ端へ寄せる（消しはしない。人が直せるように残す）。 */
function applyGraph() {
  for (const g of graph.walls) {
    const a = graph.nodes[g.na], b = graph.nodes[g.nb];
    g.w.a = [r4(a.x), r4(a.z)];
    g.w.b = [r4(b.x), r4(b.z)];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    for (const o of (g.w.openings || [])) {
      if (o.e <= L) continue;
      const width = Math.min(o.e - o.s, L);
      o.e = r4(L);
      o.s = r4(L - width);
    }
  }
  if (!dragging) plan.extent = planExtent();
}

/** 図面の外形。toScreen がこれを使うので、ドラッグ中は変えない。

    **床の輪郭は見ない。** plan.floor はスキャン時の形のままで、壁を編集すると
    食い違う。壁は必ず部屋を囲んでいるので、壁だけで外形は足りる。 */
function planExtent() {
  let mx = 0, mz = 0;
  for (const w of plan.walls) {
    mx = Math.max(mx, w.a[0], w.b[0]); mz = Math.max(mz, w.a[1], w.b[1]);
  }
  return [r4(mx), r4(mz)];
}

/** 壁の端点が作る矩形。[x0, x1, z0, z1]。 */
function planBounds() {
  const xs = [], zs = [];
  for (const w of plan.walls) { xs.push(w.a[0], w.b[0]); zs.push(w.a[1], w.b[1]); }
  return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
}

/** 内法の全体寸法を数値で変える。**遠い側の辺を引っ張る。**
    部屋の寸法を直したいとき、人が触りたいのは「全体で何ミリ」であって
    個々の壁の移動量ではない。軸 0 が x、1 が z。 */
function resizeOverall(axis, mm) {
  const key = axis === 0 ? 'x' : 'z';
  let lo = Infinity, hi = -Infinity;
  for (const n of graph.nodes) { lo = Math.min(lo, n[key]); hi = Math.max(hi, n[key]); }
  const d = mm / 1000 - (hi - lo);
  if (!isFinite(d) || Math.abs(d) < 1e-6) return;
  for (const n of graph.nodes) if (Math.abs(n[key] - hi) < WELD) n[key] = r4(n[key] + d);
  applyGraph(); drawPlan(); place();
  planDirty = true;
  pushHistory();
}

/** 壁を 1 枚足す。端点が既存の節点に近ければ溶接される（buildGraph 任せ）。 */
function addWall(a, b) {
  let n = 0;
  for (const w of plan.walls) {
    const m = /^w(\d+)$/.exec(w.id || '');
    if (m) n = Math.max(n, +m[1] + 1);
  }
  const hs = plan.walls.map(w => w.height).filter(h => h).sort((p, q) => p - q);
  plan.walls.push({ id: `w${n}`, a: [r4(a[0]), r4(a[1])], b: [r4(b[0]), r4(b[1])],
                    height: hs.length ? hs[hs.length >> 1] : 2.4,
                    thickness: 0.12, openings: [] });
  buildGraph(); applyGraph(); drawPlan(); place();
  planDirty = true;
  pushHistory();
}

/** 壁を 1 枚消す。開口も一緒に消える。 */
function deleteWall(id) {
  plan.walls = plan.walls.filter(w => w.id !== id);
  selWall = null;
  buildGraph(); applyGraph(); drawPlan(); place();
  planDirty = true;
  pushHistory();
  showEditBar();
}

/** 編集の操作列。選択中の壁の寸法と、内法の全体寸法を映す。 */
function showEditBar() {
  const bar = document.getElementById('editbar');
  if (!bar) return;
  bar.hidden = !editing;
  if (!editing || !plan) return;
  const [x0, x1, z0, z1] = planBounds();
  const W = document.getElementById('dimW'), D = document.getElementById('dimD');
  if (document.activeElement !== W) W.value = Math.round((x1 - x0) * 1000);
  if (document.activeElement !== D) D.value = Math.round((z1 - z0) * 1000);
  const w = plan.walls.find(v => v.id === selWall);
  document.getElementById('delWall').disabled = !w;
  document.getElementById('wallinfo').textContent = w
    ? `${w.id}  L=${mmv(Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]))}`
      + `  開口 ${(w.openings || []).length}`
    : (addFrom ? '2 点目を指すと壁になります' : '壁または角を掴んで動かします');
}

/** 今の状態を控える。**変更の「後」に積む。**
    直前を積むと最後の操作の結果が控えに残らず、やり直しでそこへ戻れない。
    編集に入った時点の状態が hist[0] になる。 */
function pushHistory() {
  const snap = JSON.stringify({ walls: plan.walls, extent: plan.extent });
  if (hist[histAt] === snap) return;        // 動かさずに離した
  hist = hist.slice(0, histAt + 1);
  hist.push(snap);
  if (hist.length > 60) hist.shift();
  histAt = hist.length - 1;
  updateEditButtons();
}
function restore(i) {
  const snap = JSON.parse(hist[i]);
  plan.walls = snap.walls;
  plan.extent = snap.extent;
  histAt = i;
  planDirty = true;
  selWall = null; adding = false; addFrom = null;
  buildGraph(); drawPlan(); place(); updateEditButtons(); showEditBar();
}
function updateEditButtons() {
  const d = (id, on) => { const b = document.getElementById(id); if (b) b.disabled = !on; };
  d('undo', histAt > 0);
  d('redo', histAt >= 0 && histAt < hist.length - 1);
  d('savePlan', planDirty);
}

// --- 平面図の描画 -----------------------------------------------------------

let objNodes = new Map();

function toScreen(p) { return [p[1], plan.extent[0] - p[0]]; }   // 長辺を横に

function drawPlan() {
  svg.innerHTML = '';
  const M = 0.7;
  // **描画範囲は実際の点から取る。** 編集で壁が原点より外へ出ることがあり、
  // 外形（plan.extent）だけで枠を決めると図がはみ出して切れる。
  const [px0, px1, pz0, pz1] = planBounds();
  const [sx0, sy1] = toScreen([px0, pz0]), [sx1, sy0] = toScreen([px1, pz1]);
  const LX = sy1 - sy0, LZ = sx1 - sx0;
  svg.setAttribute('viewBox',
    `${sx0 - M} ${sy0 - M} ${LZ + 2 * M} ${LX + 2 * M}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const poly = (pts, cls, parent) => el('polygon',
    { points: pts.map(q => toScreen(q).join(',')).join(' '), class: cls }, parent);
  const line = (a, b, cls, parent) => {
    const [x1, y1] = toScreen(a), [x2, y2] = toScreen(b);
    return el('line', { x1, y1, x2, y2, class: cls }, parent);
  };

  // 断面の切り口を示すハッチング（表2 細線）。壁の塗りに使う。
  const defs = el('defs', {});
  const pat = el('pattern', { id: 'hatch', patternUnits: 'userSpaceOnUse',
                              width: 0.06, height: 0.06,
                              patternTransform: 'rotate(45)' }, defs);
  el('path', { d: 'M 0 0 V 0.06', class: 'hatchline' }, pat);

  const T0 = 0.12;                          // 壁厚が無いときの作図上の仮定
  for (const w of plan.walls) {
    const T = w.thickness || T0;
    const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1];
    const L = Math.hypot(dx, dz) || 1;
    const u = [dx / L, dz / L], n = [-u[1], u[0]];
    const at = t => [w.a[0] + u[0] * t, w.a[1] + u[1] * t];
    const off = (p, s) => [p[0] + n[0] * s, p[1] + n[1] * s];
    const spans = (w.openings || [])
      .map(o => [Math.max(0, Math.min(L, o.s)), Math.max(0, Math.min(L, o.e)), o.cat])
      .sort((p, q) => p[0] - q[0]);
    let cur = 0;
    for (const [s, e, cat] of spans.concat([[L, L, null]])) {
      if (s > cur) {
        // 壁は断面。切り口をハッチングで示し、仕上線を太線で描く（表2 太線）。
        const p = at(cur), q = at(s);
        poly([off(p, T / 2), off(q, T / 2), off(q, -T / 2), off(p, -T / 2)], 'wall');
      }
      if (cat === null) break;
      const p = at(s), q = at(e);
      if (cat === 'window') {
        // 窓一般。壁厚の中を細線で通す。切り口は無いのでハッチングしない。
        for (const k of [0.5, -0.5]) line(off(p, T * k), off(q, T * k), 'jamb');
        for (const k of [0.15, -0.15]) line(off(p, T * k), off(q, T * k), 'win');
      } else {
        // 出入口。**開き勝手が出ないので扉を開いて描かない。**
        // 通則は出入口のドアを 90 度開いて示すと定めるが（解説 9）、吊元は
        // RoomPlan が返さず、メッシュ上でも閉じた扉は板厚が開口全体に均一に
        // 出るだけで手がかりが無い（実測で確認）。描けば嘘になる。
        line(off(p, T / 2), off(p, -T / 2), 'jamb');
        line(off(q, T / 2), off(q, -T / 2), 'jamb');
        const mid = at((s + e) / 2);
        line(off(mid, T / 2), off(mid, -T / 2), 'door-bar');
      }
      cur = e;
    }
  }

  const ghosts = el('g', {});
  const objs = el('g', {});
  objNodes = new Map();
  for (const o of (plan.objects || [])) {
    const [gx, gy] = toScreen(o.c);
    el('rect', { class: 'ghost', x: -o.w / 2, y: -o.d / 2, width: o.w, height: o.d,
                 transform: `translate(${gx} ${gy}) rotate(${o.yaw - 90})` }, ghosts);
    const g = el('g', { class: replaceMap[o.id] ? 'obj swap' : 'obj',
                        'data-id': o.id }, objs);
    el('rect', { x: -o.w / 2, y: -o.d / 2, width: o.w, height: o.d }, g);
    // **家具は形状だけでなく名称と寸法を併記する**（解説 9）。寸法は W×D×H。
    // 家具が回っても文字は水平に保つので、ラベルは別の g に入れて逆回転させる。
    const lab = el('g', { class: 'lab' }, g);
    el('text', { x: 0, y: -0.06 }, lab).textContent = o.label;
    el('text', { x: 0, y: 0.09, class: 'size' }, lab).textContent =
      replaceMap[o.id] ? `置換: ${replaceMap[o.id]}`
                       : `${mmv(o.w)}×${mmv(o.d)}×${mmv(o.h)}`;
    objNodes.set(o.id, g);
  }
  // 室名。平面図は床上おおむね 1m の水平断面図で、室名を入れるのが通例。
  if (plan.walls.length > 2) {
    // 室名の位置も壁から取る。床の輪郭は編集に追従しない。
    const cx = (px0 + px1) / 2, cz = (pz0 + pz1) / 2;
    const [tx, ty] = toScreen([cx, cz]);
    el('text', { x: tx, y: ty, class: 'roomname' }).textContent = plan.roomName || '';
  }

  // 寸法。**空間は内法寸法、開口部は有効寸法**（通則 7.2 / 解説 7）。
  // 単位はミリメートルで、単位記号は付けない。
  const dim = (a, b, push, label) => {
    const [x1, y1] = toScreen(a), [x2, y2] = toScreen(b);
    const horiz = Math.abs(y1 - y2) < 1e-6;
    const ox = horiz ? 0 : push, oy = horiz ? push : 0;
    // 寸法補助線（細線）で図形から引き出し、寸法線を添える。
    el('path', { class: 'dimline',
      d: `M ${x1} ${y1} L ${x1 + ox} ${y1 + oy} M ${x2} ${y2} L ${x2 + ox} ${y2 + oy}`
         + ` M ${x1 + ox} ${y1 + oy} L ${x2 + ox} ${y2 + oy}` });
    const tx = (x1 + x2) / 2 + ox, ty = (y1 + y2) / 2 + oy;
    el('text', { class: 'dimtext', x: tx, y: ty - 0.05,
                 transform: horiz ? '' : `rotate(-90 ${tx} ${ty})` }).textContent = label;
  };
  // **押し出しは必ず図の外側へ。** 画面は (x,z)→(z, LX−x) に写しているので、
  // 平面図の辺がどちら向きの線になるかを取り違えると室内へ寸法線が入る。
  dim([px0, pz0], [px1, pz0], -0.45, mmv(px1 - px0));   // 画面では左側の縦線
  dim([px1, pz0], [px1, pz1], -0.45, mmv(pz1 - pz0));   // 画面では上側の横線

  // 開口部の有効寸法。壁の外側へ少し出して添える。
  for (const w of plan.walls) {
    const T = w.thickness || T0;
    const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1];
    const L = Math.hypot(dx, dz) || 1;
    const u = [dx / L, dz / L], n = [-u[1], u[0]];
    for (const o of (w.openings || [])) {
      const push = (p, s) => [p[0] + n[0] * s, p[1] + n[1] * s];
      const a = push([w.a[0] + u[0] * o.s, w.a[1] + u[1] * o.s], -T * 1.4);
      const b = push([w.a[0] + u[0] * o.e, w.a[1] + u[1] * o.e], -T * 1.4);
      const [x1, y1] = toScreen(a), [x2, y2] = toScreen(b);
      el('path', { class: 'dimline', d: `M ${x1} ${y1} L ${x2} ${y2}` });
      el('text', { class: 'dimtext', x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 0.04 })
        .textContent = mmv(o.e - o.s);
    }
  }

  // 編集のつまみ。図面の一部ではないので編集中だけ出す。
  if (editing && graph) {
    const hits = el('g', {});
    for (const g of graph.walls) {
      const h = line(g.w.a, g.w.b,
                     g.w.id === selWall ? 'wallhit sel' : 'wallhit', hits);
      h.dataset.wall = g.w.id;
      h.addEventListener('pointerdown', onWallDown);
    }
    const handles = el('g', {});
    graph.nodes.forEach((n, i) => {
      const [hx, hy] = toScreen([n.x, n.z]);
      const hot = nodeDrag && nodeDrag.i === i;
      const r = el('rect', { class: hot ? 'node hot' : 'node',
                             x: hx - 0.07, y: hy - 0.07,
                             width: 0.14, height: 0.14 }, handles);
      r.dataset.node = i;
      r.addEventListener('pointerdown', onNodeDown);
    });
    if (addFrom) {
      // 1 点目の印。2 点目を指すまで出しておく。
      const [ax, ay] = toScreen(addFrom);
      el('rect', { class: 'node hot', x: ax - 0.07, y: ay - 0.07,
                   width: 0.14, height: 0.14 }, handles);
    }
    if (adding) {
      // 受け皿を最前面に敷いて、どこを指しても拾えるようにする。
      const bg = el('rect', { x: sx0 - M, y: sy0 - M,
                              width: LZ + 2 * M, height: LX + 2 * M,
                              fill: 'transparent', class: 'addsurface' });
      bg.addEventListener('pointerdown', onAddPoint);
    }
  }

  if (comments.length) {
    // コメント。図面の記号ではないので、操作の層に置く。番号は一覧と揃える。
    const cg = el('g', {});
    comments.forEach((c, i) => {
      const [cx, cy] = toScreen([c.p[0], c.p[2]]);
      const n = el('g', { class: 'cmt', transform: `translate(${cx} ${cy})` }, cg);
      el('circle', { cx: 0, cy: 0, r: 0.09 }, n);
      el('text', { x: 0, y: 0.005 }, n).textContent = String(i + 1);
    });
  }

  if (walking) {
    // 立ち位置。図面の記号ではないので、編集のつまみと同じく操作の層に置く。
    walkMark = el('g', { class: 'walkmark' });
    el('circle', { cx: 0, cy: 0, r: 0.09 }, walkMark);
    el('path', { d: 'M 0 -0.09 L 0 -0.34 M -0.08 -0.24 L 0 -0.34 L 0.08 -0.24' },
       walkMark);
  } else {
    walkMark = null;
  }

  const y = sy1 + M * 0.45;
  el('path', { class: 'scalebar',
    d: `M 0 ${y} H 1 M 0 ${y - .06} V ${y + .06} M 1 ${y - .06} V ${y + .06}` });
  el('text', { x: 1.12, y: y + .06, class: 'scaletext' })
    .textContent = '1 m   S=1/50';
  svg.querySelectorAll('.obj').forEach(g => {
    g.addEventListener('pointerdown', onDown);
    g.addEventListener('pointermove', onMove);
    g.addEventListener('pointerup', onUp);
    g.addEventListener('pointercancel', onUp);
  });
  placeSvg();
  updateOverlay();
  buildShell();
  moveWalls();
  clipParts();
}

// --- 3D ---------------------------------------------------------------------

/* 歩き回る。
   FloorplanStudio の walkthrough を下敷きにしているが、重力と跳躍は持たない。
   **この床は 67.7% しか撮れていない**（ベッドの下は 7%）ので、落下に任せると
   穴から抜ける。代わりに床の高さへ吸い付かせる。webgeom が床を Y=0 に揃えて
   いるので、光線が当たらなければ 0 を床とみなせる——測って分かっている値を
   使えるぶん、落下より確かになる。 */
const WALK_EYE = 1.6;        // 目の高さ（m）
const WALK_SPEED = 1.4;      // 歩く速さ（m/秒）
const WALK_RADIUS = 0.3;     // 体の半径。壁へのめり込みを止める
const WALK_LOW = 0.25;       // これより低い家具は跨げる
/* コメント。歩きながら、見ている先に書き留める。
   **置換と同じく、その場限り。保存しない。** 読み込み直せば消える。
   位置は 3D と平面図が共有する枠で持つので、平面図にも同じ座標で出せる。 */
let commenting = false;      // コメントモード
let comments = [];           // [{id, p:[x,y,z], text, at}]
let cmtPending = null;       // 置く場所が決まり、文を待っている
let cmtRoot = null;          // 3D の印
let cmtPops = [];            // 近づいたとき出す吹き出し（DOM）
//: 吹き出しを出す距離（m）。これより離れたら点だけに戻す。
const CMT_POP_DIST = 2.5;
let _cmtV = null;            // 投影の作業用。毎フレーム作らない
/* コメントを出すかどうか。`V` で切り替える。
   **出すときも近いものだけ。** 距離を問わず全部開くと、手前のものが後ろの
   ものに隠れて読めなくなる。「消す」は吹き出しも 3D の点も伏せる。 */
let cmtVisible = true;
let cmtAim = -1;             // 十字が指しているコメント。-1 は無し
//: 十字がコメントを指していると見なす範囲（画面の正規化座標）。
const CMT_AIM_R = 0.12;
/* 光線はコメントのときだけ使う（歩く当たり判定は平面図に移した）。
   **module 直下で作らない。** three.js が読めないときに app.js 全体が死ぬ。 */
let _walkRay = null;
const walkRay = () => (_walkRay || (_walkRay = new THREE.Raycaster()));
let walking = false;
let walkCam = null, walkMark = null;
let walkPos = { x: 0, y: 0, z: 0 };     // 足元
let walkYaw = 0, walkPitch = 0, walkLast = 0;
const walkKeys = new Set();

let overlay = null;          // 編集後の壁を立体にしたもの（図面の側）
let showOverlay = true;
let shell = null;            // 撮れていない隙間を塞ぐ面
let showShell = true;
let fillMaps = {};           // 床・天井・壁の色（場所ごと。サーバで作る）
let fillTex = new Map();     // それを three.js の質感にしたもの
let shellHeight = 2.4;
let geomExtent = [1, 1];
let placeholder = null;      // 編集で生まれた空間に出す無機的な絵
/* 家具の置換。RoomPlan の箱の中身を、別の 3D に差し替える。
   **その場限り。保存しない。** 読み込み直せばスキャンに戻る。差し替えは
   「置いてみたらどう見えるか」を確かめるためのもので、残すと次に開いた人が
   測ったものと見分けられない。 */
let assetList = [];          // 使えるアセット
let assetCache = new Map();  // key -> 読み込んだ部品（使い回す）
let replaceMap = {};         // 家具 id -> アセット key
let replaceNodes = new Map(); // 家具 id -> 置いた 3D
const PLACEHOLDER = '\u0000placeholder';
const PLACEHOLDER_TILE = 0.25;   // 絵の 1 升が何メートルか
/* スキャンした壁を編集に追従させるための控え。
   **家具とまったく同じ扱い。** 壁は別の部品に切り出してあり、自分だけの
   頂点を持つ。だから剛体で動かしても床や天井を引き伸ばさず、継ぎ目はその
   まま開く。開いた先は撮れていないので色も付かない——それが実測の限界で、
   引き伸ばして繕うと測っていない面を描くことになる。 */
let wallParts = [];          // [{id, geo, base, orig, moved}]
let allParts = [];           // 索引を切り詰めるための控え
let origWalls = [];          // スキャン当時の壁（室内側つき）
let followWalls = true;
let renderer, scene, camera, hemi, dirLight, meshes = new Map(), pickable = [];
let materials = [];          // 裏面の扱いを一括で切り替えるため
let cullBack = true;
let useTex = true;           // テクスチャで描くか、頂点カラーで描くか
let atlas = null;            // 共有のアトラス。全部品で 1 枚
let boxes = new Map();       // RoomPlan の境界箱（線分）
const cssColor = name =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let cam = { r: 15, theta: -0.9, phi: 1.02 };
// **three.js が無くても平面図は出す。** ここで new すると、CDN を読めない
// ときにモジュール直下で例外になり app.js ごと死ぬ。初期化まで遅らせる。
let target = null;
let needs = true;

function initGL() {
  if (renderer) return;
  if (typeof THREE === 'undefined') {
    document.getElementById('gl-note').textContent = 'three.js を読み込めません（オフライン）';
    return;
  }
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 1, 0.05, 300);
  target = new THREE.Vector3();
  hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a94, 1.0);
  dirLight = new THREE.DirectionalLight(0xffffff, 0.45);
  dirLight.position.set(3, 8, 2);
  scene.add(hemi, dirLight);
  new ResizeObserver(() => { resizeGL(); draw(); }).observe(canvas.parentElement);
  // **3D からは動かさない。** 視点の操作と選択だけ。配置を変えるのは
  // 平面図の側だけにして、3D はその結果を映す。掴めるようにすると、
  // 掴んだ点と床面の交点で決まるぶん視点によって量が変わり、平面図で
  // 見ている数値と食い違う。鉛直方向の移動も持たない（家具は床に
  // 置いたままとする）。
  canvas.addEventListener('pointerdown', e => {
    if (walking) {
      // 固定が外れていたら、まず取り戻す（コメントは置かない）。
      if (!locked()) { lockPointer(); return; }
      // コメントモードなら、十字の先に印を置く。
      if (commenting && !cmtPending) {
        const p = aimPoint();
        if (p) askComment(p);
        else setStatus('その先に面がありません', true);
      }
      return;                                 // 歩いている間は視点を掴まない
    }
    canvas.setPointerCapture(e.pointerId);
    orbit = { x: e.clientX, y: e.clientY, t: cam.theta, p: cam.phi, moved: false };
  });
  canvas.addEventListener('pointermove', e => {
    if (!orbit) return;
    const dx = e.clientX - orbit.x, dy = e.clientY - orbit.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) orbit.moved = true;
    cam.theta = orbit.t + dx * 0.006;
    cam.phi = orbit.p + dy * 0.006;
    draw();
  });
  canvas.addEventListener('pointerup', e => {
    if (walking) return;
    if (orbit && !orbit.moved) { sel = objectAt(e); place(); }
    orbit = null;
  });
  canvas.addEventListener('pointercancel', () => { orbit = null; });
  canvas.addEventListener('wheel', e => {
    if (walking) return;
    e.preventDefault(); cam.r *= Math.exp(e.deltaY * 0.0012); draw();
  }, { passive: false });
  loop();
}
let orbit = null;

function dec(b64, Type) {
  const s = atob(b64), n = s.length, u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = s.charCodeAt(i);
  return new Type(u.buffer);
}

async function loadGeom(id) {
  initGL();
  if (!renderer) return;
  for (const [, m] of meshes) scene.remove(m.mesh);
  for (const [, b] of boxes) scene.remove(b);
  meshes = new Map(); pickable = []; materials = []; boxes = new Map();
  scene.children.filter(o => o.isMesh).forEach(o => scene.remove(o));
  const g = await api(`/api/scans/${id}/geom`);
  if (id !== current) return;                 // 別のスキャンへ移った
  if (atlas) { atlas.dispose(); atlas = null; }
  fillMaps = g.fillMaps || {};
  for (const [, t] of fillTex) if (t) t.dispose();
  fillTex = new Map();
  shellHeight = g.shellHeight || 2.4;
  geomExtent = g.extent || [1, 1];
  if (g.textured) {
    atlas = new THREE.TextureLoader().load(`/api/scans/${id}/atlas`, () => {
      for (const m of materials) if (m.map) m.needsUpdate = true;
      draw();
    });
    // **v は画像の上から数える並び**（実測で v=0 が 0 行目に一致）。
    // three.js の既定は画像を上下反転して載せるので、それを外す。
    atlas.flipY = false;
    atlas.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  if (g.error) {
    document.getElementById('gl-note').textContent = g.error;
    return;
  }
  wallParts = [];
  allParts = [];
  origWalls = (g.walls || []).map(w => Object.assign(frameOf(w.a, w.b),
    { id: w.id, inSide: w.inSide || 1, twoSided: !!w.twoSided }));
  for (const part of g.parts) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(dec(part.pos, Float32Array), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(dec(part.col, Uint8Array), 3, true));
    const idx = dec(part.idx, Uint32Array);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const entry = { geo, idx, baseIdx: idx.slice(), kind: part.kind,
                    wallId: part.wall || null, clipped: false };
    allParts.push(entry);
    if (part.kind === 'object') geo.translate(-part.c[0], 0, -part.c[2]);
    geo.computeVertexNormals();
    // **裏面を描かない。** ARKit のメッシュは法線が室内側を向くので、
    // 外から見ると手前の壁が消えて中が見える。両面で描くと箱の外側しか
    // 見えず、間取りの確認に使えない。
    if (part.uv) geo.setAttribute('uv', new THREE.BufferAttribute(dec(part.uv, Float32Array), 2));
    const mat = new THREE.MeshLambertMaterial({ side: sideOf(part.wall || null) });
    applySkin(mat, !!part.uv);
    const mesh = new THREE.Mesh(geo, mat);
    materials.push(mat);
    entry.mesh = mesh;
    if (part.kind === 'wall') {
      wallParts.push({ id: part.wall, geo, mesh,
                       base: geo.attributes.position.array.slice(),
                       orig: frameOf(part.a, part.b), moved: false });
    }
    if (part.kind === 'object') {
      mesh.position.set(part.c[0], 0, part.c[2]);
      mesh.userData.id = part.id;
      meshes.set(part.id, { mesh, c: part.c,
                            y0: part.box ? part.box.y0 : 0 });
      pickable.push(mesh);
      if (part.box) addBox(part);
    }
    scene.add(mesh);
  }
  target.set(g.extent[0] / 2, 1.2, g.extent[1] / 2);
  cam.r = Math.max(6, Math.hypot(g.extent[0], g.extent[1]) * 0.9);
  document.getElementById('gl-note').hidden = true;
  document.getElementById('walk').disabled = false;
  updateOverlay();                            // initGL の後でないと作れない
  buildShell();
  drawComments();
  listComments();
  applyReplacements();
  moveWalls();
  clipParts();
  resizeGL(); place(); draw();
}

function resizeGL() {
  if (!renderer) return;
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  const aspect = r.width / Math.max(r.height, 1);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  if (walkCam) { walkCam.aspect = aspect; walkCam.updateProjectionMatrix(); }
}
const draw = () => { needs = true; };
function loop() {
  if (walking && renderer && walkCam) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - walkLast) / 1000);
    walkLast = now;
    walkStep(dt);
    updateCmtPops();
    renderer.render(scene, walkCam);
  } else if (needs && renderer && target) {
    needs = false;
    cam.phi = Math.max(0.12, Math.min(Math.PI / 2 - 0.02, cam.phi));
    cam.r = Math.max(1.5, Math.min(90, cam.r));
    camera.position.set(
      target.x + cam.r * Math.sin(cam.phi) * Math.cos(cam.theta),
      target.y + cam.r * Math.cos(cam.phi),
      target.z + cam.r * Math.sin(cam.phi) * Math.sin(cam.theta));
    camera.lookAt(target);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);
}
/* RoomPlan の境界箱を線で描く。
   隅は中心からの相対座標でサーバから来る（向きの計算は Python 側で済んで
   いるので、ここで回転の符号を推し量らなくてよい）。動かすときは中心を
   移して dyaw だけ回す。 */
/** 編集後の壁を直方体の並びにする。単位は 3D と同じ（平面図の x, z と Y 上）。

    **スキャンは変形しない。** 測ったものと描いたものを別の物として重ねる。
    変形させると 3D がもう実測ではなくなるうえ、壁の追加や削除は対応する面が
    スキャンに無いので映せない。図面から立体を起こせば、追加も削除もそのまま
    出る。

    開口は腰壁と垂れ壁だけ残す。寸法は RoomPlan が返した sill と h を使い、
    **扉は開いて描かない**——開き勝手が出ないのは平面図と同じ理由。 */
function overlayBoxes() {
  const out = [];
  for (const w of (plan && plan.walls) || []) {
    const T = w.thickness || 0.12, H = w.height || 2.4;
    const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1];
    const L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    const u = [dx / L, dz / L], n = [-u[1], u[0]];
    const at = t => [w.a[0] + u[0] * t, w.a[1] + u[1] * t];
    const spans = (w.openings || [])
      .map(o => [Math.max(0, Math.min(L, o.s)), Math.max(0, Math.min(L, o.e)), o])
      .sort((p, q) => p[0] - q[0]);
    let cur = 0;
    for (const [s, e, o] of spans.concat([[L, L, null]])) {
      if (s > cur + 1e-6) out.push({ p: at(cur), q: at(s), n, T, y0: 0, y1: H });
      if (!o) break;
      const sill = o.sill || 0, top = sill + (o.h || 0);
      if (sill > 0.02) out.push({ p: at(s), q: at(e), n, T, y0: 0, y1: sill });
      if (H - top > 0.02) out.push({ p: at(s), q: at(e), n, T, y0: top, y1: H });
      cur = e;
    }
  }
  return out;
}

/** 直方体 1 個ぶんの三角形と稜線を積む。 */
function pushBox(b, tri, seg) {
  const off = (p, s) => [p[0] + b.n[0] * s, p[1] + b.n[1] * s];
  const base = [off(b.p, b.T / 2), off(b.q, b.T / 2),
                off(b.q, -b.T / 2), off(b.p, -b.T / 2)];
  const V = i => (i < 4 ? [base[i][0], b.y0, base[i][1]]
                        : [base[i - 4][0], b.y1, base[i - 4][1]]);
  const F = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
             [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
             [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0]];
  for (const f of F) for (const i of f) tri.push(...V(i));
  const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
             [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const [i, j] of E) { seg.push(...V(i), ...V(j)); }
}

/** 重ね描きを作り直す。**drawPlan の最後から呼ぶ。**

    図面が変われば必ず drawPlan を通るので、そこに繋げておけば編集が漏れない
    （家具の位置を place に預けて呼び忘れたのと同じ轍を踏まない）。 */
function updateOverlay() {
  if (overlay && scene) {
    scene.remove(overlay);
    overlay.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    overlay = null;
  }
  if (!renderer || !scene || !plan) return;
  const tri = [], seg = [];
  for (const b of overlayBoxes()) pushBox(b, tri, seg);
  if (!tri.length) return;
  const col = new THREE.Color(cssColor('--pick'));
  const gf = new THREE.BufferGeometry();
  gf.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
  // 陰を付けない材質にする。**面ではなく線画として読ませたい。**
  const faces = new THREE.Mesh(gf, new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.16,
    depthWrite: false, side: THREE.DoubleSide }));
  const gl = new THREE.BufferGeometry();
  gl.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  const edges = new THREE.LineSegments(gl, new THREE.LineBasicMaterial({
    color: col, transparent: true, opacity: 0.8 }));
  overlay = new THREE.Group();
  overlay.add(faces, edges);
  overlay.visible = showOverlay;
  scene.add(overlay);
}

/** 線分 (a, b) の局所座標系。沿う向き u・法線 n・長さ L。 */
function frameOf(a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L = Math.hypot(dx, dz) || 1;
  const u = [dx / L, dz / L];
  return { a, u, n: [-u[1], u[0]], L };
}

/** スキャンした壁を編集後の位置へ移す。

    **写すのは線分ではなく線。** 端点に合わせると、角のドラッグで端だけが
    動いたときに壁が自分の向きのまま滑る（実測で w3 を 0.5m 動かすと、隣の
    w1 が 0.5m 滑り、w0 の端は 0.49m 潰れた）。壁が短くなっても面そのものは
    撮った場所から動かないのが実測に忠実で、はみ出すぶんは「部屋の外」になる。

    そこで原点を「元の a を新しい線へ下ろした足」に取る。線が動いていなければ
    変換は恒等になり、平行移動だけなら法線方向の平行移動になる。 */
function moveWalls() {
  if (!plan) return;
  for (const wp of wallParts) {
    const w = plan.walls.find(v => v.id === wp.id);
    // **図面から消した壁は、撮った面も消す。** 消えるのは表示だけで、元の
    // 形は base に残っているから、取り消しでそのまま戻る。
    // 「壁を動かす」を切っているときは、測ったままを見たいので出す。
    if (wp.mesh) wp.mesh.visible = !followWalls || !!w;
    const t = (followWalls && w) ? frameOf(w.a, w.b) : wp.orig;
    const still = Math.abs(t.a[0] - wp.orig.a[0]) < 1e-6
               && Math.abs(t.a[1] - wp.orig.a[1]) < 1e-6
               && Math.abs(t.u[0] - wp.orig.u[0]) < 1e-6
               && Math.abs(t.u[1] - wp.orig.u[1]) < 1e-6
               && Math.abs(t.L - wp.orig.L) < 1e-6;
    if (still && !wp.moved) continue;
    const pos = wp.geo.attributes.position.array;
    const o = wp.orig;
    // 元の a を新しい線へ下ろした足。ここを原点にすると滑りが出ない。
    const k = (o.a[0] - t.a[0]) * t.u[0] + (o.a[1] - t.a[1]) * t.u[1];
    const ox = t.a[0] + t.u[0] * k, oz = t.a[1] + t.u[1] * k;
    for (let i = 0; i < pos.length; i += 3) {
      const qx = wp.base[i] - o.a[0], qz = wp.base[i + 2] - o.a[1];
      const sv = qx * o.u[0] + qz * o.u[1];
      const dv = qx * o.n[0] + qz * o.n[1];
      pos[i] = ox + t.u[0] * sv + t.n[0] * dv;
      pos[i + 2] = oz + t.u[1] * sv + t.n[1] * dv;
    }
    wp.geo.attributes.position.needsUpdate = true;
    wp.geo.computeVertexNormals();
    wp.moved = !still;
  }
}

/** 編集後の部屋の外に残った面を隠す。

    **壁を内側へ動かすと、床・天井と直交する壁がその外へ取り残される。**
    実測で 0.3m 動かすと床天井 1.71 m2 + 直交壁 1.15 m2。大きな連結成分の
    一部なので、小片を落とす処理では消せない。

    動いた壁ごとに半空間で切る。部屋の外形を多角形に組み直さないので、壁を
    足してループが閉じていなくても破綻しない。切る境界は壁線ではなく**壁の
    外面**（線から壁厚ぶん外）——壁線で切ると壁そのものが消える。 */
function clipParts() {
  if (!plan || !allParts.length) return;
  const cut = [];
  if (followWalls) {
    for (const ow of origWalls) {
      const w = plan.walls.find(v => v.id === ow.id);
      if (!w) continue;
      const t = frameOf(w.a, w.b);
      if (Math.abs(t.a[0] - ow.a[0]) < 1e-6 && Math.abs(t.a[1] - ow.a[1]) < 1e-6
          && Math.abs(t.u[0] - ow.u[0]) < 1e-6 && Math.abs(t.u[1] - ow.u[1]) < 1e-6
          && Math.abs(t.L - ow.L) < 1e-6) continue;
      cut.push({ id: ow.id, f: t, side: ow.inSide, m: w.thickness || 0.12 });
    }
  }
  for (const p of allParts) {
    if (p.mesh && !p.mesh.visible) continue;      // 消した壁は切る必要が無い
    // 家具は切らない（壁を貫くのは採用済みの判断）。自分の壁では切らない
    // ——壁の実体は自分の線より外にあるので、切れば丸ごと消える。
    const mine = p.kind === 'object' ? [] : cut.filter(c => c.id !== p.wallId);
    if (!mine.length) {
      if (p.clipped) {
        p.idx.set(p.baseIdx);
        p.geo.index.needsUpdate = true;
        p.geo.setDrawRange(0, p.baseIdx.length);
        p.clipped = false;
      }
      continue;
    }
    const pos = p.geo.attributes.position.array, I = p.baseIdx, O = p.idx;
    let n = 0;
    for (let f = 0; f < I.length; f += 3) {
      const a = I[f] * 3, b = I[f + 1] * 3, c = I[f + 2] * 3;
      const x = (pos[a] + pos[b] + pos[c]) / 3;
      const z = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
      let drop = false;
      for (const q of mine) {
        const qx = x - q.f.a[0], qz = z - q.f.a[1];
        const sv = qx * q.f.u[0] + qz * q.f.u[1];
        if (sv < -0.15 || sv > q.f.L + 0.15) continue;   // その壁の区間の外
        if ((qx * q.f.n[0] + qz * q.f.n[1]) * q.side < -q.m) { drop = true; break; }
      }
      if (drop) continue;
      O[n++] = I[f]; O[n++] = I[f + 1]; O[n++] = I[f + 2];
    }
    p.geo.index.needsUpdate = true;
    p.geo.setDrawRange(0, n);
    p.clipped = true;
  }
}

// --- 歩き回る -----------------------------------------------------------

/** 立ち位置を決める。**家具と壁から最も離れた場所。**
    部屋の中心は家具の中のことがある（実測でベッドが中心寄りだった）。
    平面図に箱があるので、光線を飛ばさずに空いている場所を選べる。 */
function walkSpawn() {
  const [x0, x1, z0, z1] = planBounds();
  let best = null, bestD = -1;
  const N = 24;
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N; j++) {
      const x = x0 + (x1 - x0) * i / N, z = z0 + (z1 - z0) * j / N;
      let d = Infinity;
      for (const w of plan.walls) {
        const f = frameOf(w.a, w.b);
        const qx = x - f.a[0], qz = z - f.a[1];
        const sv = Math.max(0, Math.min(f.L, qx * f.u[0] + qz * f.u[1]));
        d = Math.min(d, Math.hypot(x - (f.a[0] + f.u[0] * sv),
                                   z - (f.a[1] + f.u[1] * sv)));
      }
      for (const o of (plan.objects || [])) {
        const m = state.get(o.id) || { dx: 0, dz: 0 };
        const cx = o.c[0] + m.dx, cz = o.c[1] + m.dz;
        d = Math.min(d, Math.max(0, Math.hypot(x - cx, z - cz)
                                    - Math.max(o.w, o.d) / 2));
      }
      if (d > bestD) { bestD = d; best = [x, z]; }
    }
  }
  const yaw = (x1 - x0) >= (z1 - z0) ? Math.PI / 2 : 0;  // 長辺へ向く
  return { x: best[0], z: best[1], yaw };
}

/** 進めるかを**平面図に対して**見る。メッシュには当てない。

    three.js の Raycaster は BVH を持たず総当たりなので、面数がそのまま効く。
    実測で 1 フレーム 7 本の光線に 67,446 面で 13.81ms、167,281 面なら 33.58ms
    かかり、テクスチャ版にすると歩けなくなる。平面図なら壁 4 枚と家具 4 個の
    計 8 個で済み、実質ゼロになる。

    速いだけでなく確かでもある。床は 67.7% しか撮れておらず（ベッドの下は
    7%）、メッシュに当てると穴を抜ける。

    代わりに、平面図に無いもの（突き出したエアコン、段差）は止めない。 */
function walkBlocked(x, z, dx, dz) {
  if (!plan) return false;
  const nx = x + dx, nz = z + dz;
  for (const w of plan.walls) {
    const f = frameOf(w.a, w.b);
    const lim = (w.thickness || 0.12) / 2 + WALK_RADIUS;
    const qx = nx - f.a[0], qz = nz - f.a[1];
    const sv = Math.max(0, Math.min(f.L, qx * f.u[0] + qz * f.u[1]));
    if (Math.hypot(nx - (f.a[0] + f.u[0] * sv), nz - (f.a[1] + f.u[1] * sv)) < lim)
      return true;
  }
  for (const o of (plan.objects || [])) {
    if ((o.h || 0) < WALK_LOW) continue;      // ラグのような低い物は跨げる
    const m = state.get(o.id) || { dx: 0, dz: 0, dyaw: 0 };
    const cx = o.c[0] + m.dx, cz = o.c[1] + m.dz;
    const th = (o.yaw + m.dyaw) * Math.PI / 180;
    const ux = Math.cos(th), uz = Math.sin(th);
    const px = nx - cx, pz = nz - cz;
    if (Math.abs(px * ux + pz * uz) < o.w / 2 + WALK_RADIUS
        && Math.abs(-px * uz + pz * ux) < o.d / 2 + WALK_RADIUS) return true;
  }
  return false;
}

/** 床の高さ。**平面図は高さを持たないので 0 で固定する。**

    webgeom が床を Y=0 へ揃えており、実測でスキャンの床面は +0.0155m
    （標準偏差 0.0225）。段差のある家や複数階は歩けない。 */
function walkGround() {
  return 0;
}

function walkStep(dt) {
  // **カメラは局所の −Z を向く。** ヨー θ を掛けた前は (−sinθ, −cosθ)。
  // ここを (sinθ, cosθ) にすると前後が入れ替わる。
  const f = [-Math.sin(walkYaw), -Math.cos(walkYaw)];   // 前（x, z）
  const r = [-f[1], f[0]];                              // 右
  let wx = 0, wz = 0;
  if (walkKeys.has('f')) { wx += f[0]; wz += f[1]; }
  if (walkKeys.has('b')) { wx -= f[0]; wz -= f[1]; }
  if (walkKeys.has('r')) { wx += r[0]; wz += r[1]; }
  if (walkKeys.has('l')) { wx -= r[0]; wz -= r[1]; }
  const n = Math.hypot(wx, wz);
  if (n > 0) {
    const k = WALK_SPEED * dt / n;
    // **軸ごとに試す。** まとめて止めると壁に沿って滑れず、角で動けなくなる。
    if (!walkBlocked(walkPos.x, walkPos.z, wx * k, 0)) walkPos.x += wx * k;
    if (!walkBlocked(walkPos.x, walkPos.z, 0, wz * k)) walkPos.z += wz * k;
  }
  walkPos.y = walkGround();
  walkCam.position.set(walkPos.x, walkPos.y + WALK_EYE, walkPos.z);
  walkCam.rotation.set(walkPitch, walkYaw, 0, 'YXZ');
  if (walkMark) {
    const [sx, sy] = toScreen([walkPos.x, walkPos.z]);
    // 画面は (x,z)→(z, LX−x) に写す。矢印は上向き（画面 −y）に描いてあり、
    // それは平面図の +x にあたる。前は (−sinθ, −cosθ) なので 90 度ずれる。
    walkMark.setAttribute('transform',
      `translate(${sx} ${sy}) rotate(${-walkYaw * 180 / Math.PI - 90})`);
  }
}

// --- コメント ---------------------------------------------------------------

/** 十字の先にある面。**1 本だけ飛ばす。** 歩くときの当たり判定は平面図に
    移したが、コメントは「どの面に付けたか」が要るのでメッシュに当てる。
    1 本なら 94,000 面でも 2ms ほどで、押した瞬間だけの費用で済む。 */
function aimPoint() {
  if (!walkCam) return null;
  const targets = [];
  for (const p of allParts) if (p.mesh && p.mesh.visible) targets.push(p.mesh);
  if (shell) for (const m of shell.children) targets.push(m);
  for (const [, n] of replaceNodes) n.traverse(o => { if (o.isMesh) targets.push(o); });
  if (!targets.length) return null;
  const r = walkRay();
  r.far = 40;
  r.setFromCamera({ x: 0, y: 0 }, walkCam);     // 画面の中心＝十字
  const hits = r.intersectObjects(targets, false);
  if (!hits.length) return null;
  const q = hits[0].point;
  return [+q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4)];
}

/** 3D の印を作り直す。常に見えるようにする（壁の向こうでも数は分かる）。 */
function drawComments() {
  if (cmtRoot && scene) {
    scene.remove(cmtRoot);
    cmtRoot.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    cmtRoot = null;
  }
  if (!renderer || !scene || !comments.length || !cmtVisible) return;
  const g = new THREE.Group();
  const geo = new THREE.SphereGeometry(0.06, 12, 10);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(cssColor('--shu')), depthTest: false });
  for (const c of comments) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(c.p[0], c.p[1], c.p[2]);
    m.renderOrder = 999;                        // 壁に隠れても見える
    g.add(m);
  }
  cmtRoot = g;
  scene.add(g);
}

function listComments() {
  const ul = document.getElementById('cmtlist');
  if (!ul) return;
  ul.innerHTML = '';
  comments.forEach((c, i) => {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(i + 1);
    const t = document.createElement('span');
    t.textContent = c.text;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '削除';
    x.onclick = () => {
      comments = comments.filter(v => v.id !== c.id);
      refreshComments();
    };
    li.append(n, t, x);
    ul.appendChild(li);
  });
}

/** 付けたコメントを映し直す。**保存はしない。その場限り。** */
function refreshComments() {
  drawComments();
  listComments();
  drawPlan();
  draw();
}

/** コメントを出すかどうかを切り替える。 */
function toggleCmtShow() {
  cmtVisible = !cmtVisible;
  if (!cmtVisible) hideCmtPops();
  drawComments();
  walkTip();
  draw();
}

/** 歩くときの案内。いまの状態をそのまま出す。 */
function walkTip() {
  const tip = document.getElementById('walktip');
  if (!tip) return;
  const c = `コメント: ${cmtVisible ? '表示' : '消す'}（V で切替）`;
  const del = cmtAim >= 0 ? '　Delete で消す' : '';
  tip.textContent = (commenting
    ? `見ている先をクリックして書き留める　C で歩くモードへ戻る　${c}`
    : `W A S D / 矢印で移動　マウスで見回す　C でコメント　${c}　Esc で戻る`) + del;
}

function setCommenting(on) {
  commenting = on && walking;
  const hud = document.getElementById('walkhud');
  if (hud) hud.classList.toggle('commenting', commenting);
  walkTip();
}

/** 文を入れてもらう。**ポインタの固定はいったん外す。**
    固定したままでは入力欄に文字を打てない。 */
function askComment(p) {
  cmtPending = p;
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  const box = document.getElementById('cmtbox');
  const input = document.getElementById('cmtText');
  box.hidden = false;
  input.value = '';
  input.focus();
}

function closeComment() {
  cmtPending = null;
  document.getElementById('cmtbox').hidden = true;
  if (!walking) return;
  lockPointer();                            // 書き終えたら即座に奪い返す
  // **断られることがある。** 外した直後の再要求をブラウザが拒むことがあるの
  // で、少し置いてもう一度試す。それでも駄目なら次のクリックで取り戻す。
  setTimeout(lockPointer, 180);
}

/** 近くのコメントを吹き出しで出す。離れたら消す。

    画面に投影して DOM を重ねる。three.js の板で出すより字が読める。 */
function updateCmtPops() {
  const box = document.getElementById('cmtpops');
  if (!box || !walkCam) return;
  if (!_cmtV) _cmtV = new THREE.Vector3();
  const r = canvas.getBoundingClientRect();
  while (cmtPops.length < comments.length) {
    const d = document.createElement('div');
    d.className = 'cmtpop';
    box.appendChild(d);
    cmtPops.push(d);
  }
  while (cmtPops.length > comments.length) box.removeChild(cmtPops.pop());
  let aim = -1, aimD = CMT_AIM_R;
  comments.forEach((c, i) => {
    const el2 = cmtPops[i];
    el2.classList.remove('aim');
    if (!cmtVisible) { el2.hidden = true; return; }
    const dist = Math.hypot(c.p[0] - walkPos.x, c.p[1] - (walkPos.y + WALK_EYE),
                            c.p[2] - walkPos.z);
    if (dist > CMT_POP_DIST) { el2.hidden = true; return; }
    _cmtV.set(c.p[0], c.p[1], c.p[2]).project(walkCam);
    const v = _cmtV;
    // **後ろにあるものは出さない。** 投影は背後でも値を返す。
    if (v.z > 1 || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) {
      el2.hidden = true;
      return;
    }
    el2.hidden = false;
    el2.textContent = c.text;
    el2.style.left = `${(v.x * 0.5 + 0.5) * r.width}px`;
    el2.style.top = `${(-v.y * 0.5 + 0.5) * r.height}px`;
    // **十字にいちばん近いものを「指している」とする。** 消す相手を選ぶため。
    const d = Math.hypot(v.x, v.y);
    if (d < aimD) { aimD = d; aim = i; }
  });
  if (aim >= 0) cmtPops[aim].classList.add('aim');
  if (aim !== cmtAim) { cmtAim = aim; walkTip(); }
}

function hideCmtPops() {
  for (const d of cmtPops) { d.hidden = true; d.classList.remove('aim'); }
  if (cmtAim !== -1) { cmtAim = -1; walkTip(); }
}

/** 十字が指しているコメントを消す。 */
function deleteAimedComment() {
  if (cmtAim < 0 || cmtAim >= comments.length) return false;
  const c = comments[cmtAim];
  comments = comments.filter(v => v.id !== c.id);
  cmtAim = -1;
  hideCmtPops();
  refreshComments();
  setStatus(`コメントを消しました（残り ${comments.length} 件）`);
  return true;
}

function enterWalk() {
  if (!renderer || !plan || walking) return;
  if (!walkCam) walkCam = new THREE.PerspectiveCamera(75, 1, 0.03, 100);
  const sp = walkSpawn();
  walkPos = { x: sp.x, y: 0, z: sp.z };
  walkYaw = sp.yaw; walkPitch = 0;
  walking = true;
  walkKeys.clear();
  walkLast = performance.now();
  document.getElementById('stage3d').classList.add('walking');
  document.getElementById('walkhud').hidden = false;
  document.getElementById('walk').textContent = '戻る';
  walkTip();
  resizeGL();
  drawPlan();                               // 立ち位置の印を出す
  lockPointer();                            // すぐ乗っ取る
}

/** ポインタを乗っ取る。**コメントのときだけ返し、終わったら奪い返す。** */
function lockPointer() {
  if (walking && canvas.requestPointerLock) canvas.requestPointerLock();
}

/** 固定されているか。外れていたら、次のクリックで取り戻す。 */
function locked() {
  return document.pointerLockElement === canvas;
}

function exitWalk() {
  if (!walking) return;
  if (cmtPending) return;                      // 文を書いている間は出ない
  walking = false;
  setCommenting(false);
  walkKeys.clear();
  document.getElementById('stage3d').classList.remove('walking');
  document.getElementById('walkhud').hidden = true;
  hideCmtPops();
  document.getElementById('walk').textContent = '歩く';
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  resizeGL();
  drawPlan();
  draw();
}

document.addEventListener('pointerlockchange', () => {
  if (!walking || locked()) return;
  if (cmtPending) return;                    // 文を書いている間は外れていてよい
  // Esc で外れたら歩くのをやめる。掴んだままにすると操作不能になる。
  exitWalk();
});
document.addEventListener('mousemove', e => {
  if (!walking || document.pointerLockElement !== canvas) return;
  walkYaw -= e.movementX * 0.0022;
  walkPitch -= e.movementY * 0.0022;
  const lim = Math.PI / 2 - 0.05;
  walkPitch = Math.max(-lim, Math.min(lim, walkPitch));
});
const WALK_KEYMAP = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b',
                      KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
window.addEventListener('keydown', e => {
  if (!walking) return;
  if (cmtPending) return;                      // 入力中はここで食べない
  const k = WALK_KEYMAP[e.code];
  if (k) { walkKeys.add(k); e.preventDefault(); }
  else if (e.code === 'KeyC') { setCommenting(!commenting); e.preventDefault(); }
  else if (e.code === 'KeyV') { toggleCmtShow(); e.preventDefault(); }
  else if (e.code === 'Delete' || e.code === 'Backspace') {
    if (deleteAimedComment()) e.preventDefault();
  }
  else if (e.key === 'Escape') exitWalk();
});
window.addEventListener('keyup', e => {
  const k = WALK_KEYMAP[e.code];
  if (k) walkKeys.delete(k);
});

/** 材質の着せ替え。テクスチャか頂点カラーか。

    色空間はどちらも触らない。頂点カラーは u1 を 0..1 に正規化してそのまま
    使っており、JPEG も同じ扱いになる。**片方だけ sRGB を宣言すると明るさが
    食い違う**ので、揃えないことで揃える。 */
function applySkin(mat, hasUV) {
  const on = useTex && hasUV && atlas;
  mat.map = on ? atlas : null;
  mat.vertexColors = !on;
  mat.color.setHex(0xffffff);
  mat.needsUpdate = true;
}

/** 撮れていない隙間を塞ぐ面を作る。

    **メッシュそのものに穴がある。** 実測で床の被覆は 68.8%、壁は 76.5〜95.0%。
    三角形が無いので、アトラスをいくら埋めても背景が透けて黒く見える。

    平面図は「そこに床と壁がある」と言っているので、その形で面を起こして
    スキャンの**裏側**に置く。撮れたところはスキャンが手前に出て、撮れて
    いないところだけこの面が見える。

    色は模様を持たない一色にする（サーバで測った床・天井・壁の中央値）。
    **測っていない場所に模様を描かない**ための区別で、のっぺりしていること
    自体が「ここは撮れていない」の表示になる。

    床と天井は平面図の外形いっぱいの矩形で足りる。壁の外へはみ出すぶんは、
    同時に起こす壁の面が室内から隠す。凹んだ形の部屋でも三角形分割が要らない。 */
/** 面の表裏。

    **部屋の中にある壁は、裏から覗いても見えなければならない。** 外周の壁は
    片側にしか床が無いので裏面を落として構わない（そうしないと外から見たとき
    手前の壁で中が隠れる）が、間仕切りは両側から見るものなので落とすと消える。

    間仕切りかどうかはサーバで測る（壁の両側に床の面があるか）。人が足した壁は
    スキャンに無く、部屋の中に引くものなので無条件に両面。 */
function sideOf(wallId) {
  if (!cullBack) return THREE.DoubleSide;
  if (!wallId) return THREE.FrontSide;
  const o = origWalls.find(w => w.id === wallId);
  return (!o || o.twoSided) ? THREE.DoubleSide : THREE.FrontSide;
}

/** 編集で生まれた空間に出す絵。

    **撮れていない場所と、編集で生まれた場所は別物。** 前者は「そこに床は
    あるが写していない」なので周りの色で塞ぐ。後者は「スキャン当時そこに
    空間は無かった」なので、見るからに人工的な絵にして**編集の結果だと分かる
    ようにする**。写真らしい色で埋めると、測ったものと区別が付かなくなる。 */
function placeholderTexture() {
  if (placeholder !== null) return placeholder;
  const c = document.createElement('canvas');
  if (!c || !c.getContext) { placeholder = false; return false; }
  c.width = c.height = 64;
  const x = c.getContext('2d');
  if (!x) { placeholder = false; return false; }
  x.fillStyle = '#8e8b85';
  x.fillRect(0, 0, 64, 64);
  x.strokeStyle = '#7a776f';
  x.lineWidth = 2;
  for (let i = -64; i < 64; i += 8) {          // 斜めの縞
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 64, 64); x.stroke();
  }
  x.strokeStyle = '#6e6b64';
  x.lineWidth = 1;
  x.strokeRect(0.5, 0.5, 63, 63);              // 升目の枠
  placeholder = new THREE.CanvasTexture(c);
  placeholder.wrapS = placeholder.wrapT = THREE.RepeatWrapping;
  return placeholder;
}

/** 隙間を塞ぐ面に貼る色。**一色ではなく場所ごとに持つ。**
    一色だと、茶色のカーテンの穴に壁全体のベージュが出る。 */
function fillTexture(key) {
  if (fillTex.has(key)) return fillTex.get(key);
  const m = fillMaps[key];
  if (!m) { fillTex.set(key, null); return null; }
  const t = new THREE.DataTexture(dec(m.data, Uint8Array), m.w, m.h,
                                  THREE.RGBFormat);
  t.needsUpdate = true;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  // 格子の外は縁の色を引き伸ばす。繰り返すと反対側の色が出る。
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  fillTex.set(key, t);
  return t;
}

function buildShell() {
  if (shell && scene) {
    scene.remove(shell);
    shell.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    shell = null;
  }
  if (!renderer || !scene || !plan || !showShell) return;
  const [x0, x1, z0, z1] = planBounds();
  const H = Math.max(...plan.walls.map(w => w.height || 0), 2.4);
  const g = new THREE.Group();

  const quad = (pts, uvs, nrm, key, wallId) => {
    const e1 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
    const e2 = [pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
               e1[0] * e2[1] - e1[1] * e2[0]];
    // **向きは計算で合わせる。** 巻き方向を手で決めると裏返りに気付けない。
    const flip = (n[0] * nrm[0] + n[1] * nrm[1] + n[2] * nrm[2]) < 0;
    const ord = flip ? [0, 3, 2, 1] : [0, 1, 2, 3];
    const v = [], t = [];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      v.push(...pts[ord[i]]);
      t.push(...uvs[ord[i]]);          // **UV も同じ並べ替えで動かす**
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(t, 2));
    geo.computeVertexNormals();
    let map = key === PLACEHOLDER ? placeholderTexture() : fillTexture(key);
    if (map === false) map = null;
    g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      map, color: map ? new THREE.Color(1, 1, 1) : new THREE.Color(0.56, 0.55, 0.52),
      side: sideOf(wallId) })));
  };

  const M = 0.5;                                   // 壁の外へ少し出す
  // 色の格子はスキャン当時の枠で作ってあるので、UV もその枠で引く。
  const uvOf = p => [p[0] / geomExtent[0], p[2] / geomExtent[1]];
  const rect = (y, ax, az, bx, bz) =>
    [[ax, y, az], [bx, y, az], [bx, y, bz], [ax, y, bz]];
  const R = 1 / PLACEHOLDER_TILE;
  const tile = p => [p[0] * R, p[2] * R];

  // **スキャン当時の広さと、いまの広さを分けて敷く。**
  // 編集で広がったぶんは、下に敷いた無機的な絵が見える。
  const pf = rect(-0.03, x0 - M, z0 - M, x1 + M, z1 + M);
  quad(pf, pf.map(tile), [0, 1, 0], PLACEHOLDER);
  const pc = rect(H + 0.03, x0 - M, z0 - M, x1 + M, z1 + M);
  quad(pc, pc.map(tile), [0, -1, 0], PLACEHOLDER);
  // 色の格子を貼る面は、スキャン当時の広さに収める。
  const sf = rect(-0.02, 0, 0, geomExtent[0], geomExtent[1]);
  quad(sf, sf.map(uvOf), [0, 1, 0], 'floor');
  const sc = rect(H + 0.02, 0, 0, geomExtent[0], geomExtent[1]);
  quad(sc, sc.map(uvOf), [0, -1, 0], 'ceiling');

  for (const w of plan.walls) {
    const f = frameOf(w.a, w.b);
    const ow = origWalls.find(o => o.id === w.id);
    // 室内側は測って決める（巻き方向には頼らない）。壁線は内法面なので、
    // スキャンした面（線から 1〜43mm 外）より外へ出して裏に回す。
    const side = ow ? ow.inSide : 1;
    const d = -side * 0.08;
    const a = [f.a[0] + f.n[0] * d, f.a[1] + f.n[1] * d];
    const b = [a[0] + f.u[0] * f.L, a[1] + f.u[1] * f.L];
    const hh = w.height || H;
    const vt = hh / shellHeight;
    const nrm = [f.n[0] * side, 0, f.n[1] * side];
    // 壁に沿って t ∈ [0, L] の区間に面を張る。
    const span = (t0, t1, key, u0, u1) => {
      if (t1 - t0 < 1e-4) return;
      const p = t => [a[0] + f.u[0] * t, a[1] + f.u[1] * t];
      const [pa, pb] = [p(t0), p(t1)];
      const vTop = key === PLACEHOLDER ? hh / PLACEHOLDER_TILE : vt;
      quad([[pa[0], 0, pa[1]], [pb[0], 0, pb[1]],
            [pb[0], hh, pb[1]], [pa[0], hh, pa[1]]],
           [[u0, 0], [u1, 0], [u1, vTop], [u0, vTop]], nrm, key, w.id);
    };
    // **引き伸ばしたところは絵にする。** 色の格子はスキャン当時の壁の長さぶん
    // しか無い。伸びたぶんへ引き伸ばすと、元からあったように見えてしまう。
    const tile = t => t / PLACEHOLDER_TILE;
    const k = ow ? f.u[0] * ow.u[0] + f.u[1] * ow.u[1] : 0;
    if (!fillMaps[w.id] || !ow || Math.abs(k) < 0.5) {
      span(0, f.L, PLACEHOLDER, tile(0), tile(f.L));   // 足した壁・回した壁
    } else {
      // 元の壁の座標 s0 は t の一次式。s0 = c0 + k·t。
      const c0 = (a[0] - ow.a[0]) * ow.u[0] + (a[1] - ow.a[1]) * ow.u[1];
      const tAt = s0 => (s0 - c0) / k;
      let lo = tAt(0), hi = tAt(ow.L);
      if (lo > hi) { const q = lo; lo = hi; hi = q; }
      lo = Math.max(0, Math.min(f.L, lo));
      hi = Math.max(0, Math.min(f.L, hi));
      span(0, lo, PLACEHOLDER, tile(0), tile(lo));
      span(lo, hi, w.id, (c0 + k * lo) / ow.L, (c0 + k * hi) / ow.L);
      span(hi, f.L, PLACEHOLDER, tile(hi), tile(f.L));
    }
  }
  shell = g;
  scene.add(g);
}

/** アセットを読んで three.js の形にする。1 度読んだら使い回す。 */
async function loadAsset(key) {
  if (assetCache.has(key)) return assetCache.get(key);
  const pr = (async () => {
    const d = await api(`/api/assets/${encodeURIComponent(key)}`);
    if (d.error) return null;
    const g = new THREE.Group();
    for (const p of d.parts) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position',
                       new THREE.BufferAttribute(dec(p.pos, Float32Array), 3));
      if (p.uv) geo.setAttribute('uv',
                                 new THREE.BufferAttribute(dec(p.uv, Float32Array), 2));
      geo.setIndex(new THREE.BufferAttribute(dec(p.idx, Uint32Array), 1));
      geo.computeVertexNormals();
      const c = p.color || [200, 200, 200];
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255),
        side: THREE.DoubleSide });          // 外から見るものなので両面
      if (p.tex !== undefined) {
        mat.map = new THREE.TextureLoader().load(
          `/api/assets/${encodeURIComponent(key)}/tex/${p.tex}`, () => draw());
        mat.map.flipY = false;
        mat.color.setHex(0xffffff);
      }
      g.add(new THREE.Mesh(geo, mat));
    }
    return { group: g, size: d.size };
  })();
  assetCache.set(key, pr);
  return pr;
}

/** アセットを箱に合わせる倍率。**軸ごとに取り、箱と同じ大きさにする。**

    一様に縮めると箱より小さくなり（実測で 1.27×0.58×0.79 の箱に 1.07×0.69
    ×0.58 しか入らなかった）、置き換えた家具がもとの家具より小さく見える。
    縦横比の違うアセットは伸びるが、**寸法が合っていることのほうが要る**。

    アセットの局所 x が家具の幅にあたるとは限らない。向きが合わない書き出しは
    伸び方が変わるので、その場合はアセット側を直す。 */
function fitInBox(size, o) {
  return [o.w / Math.max(size[0], 1e-6),
          o.h / Math.max(size[1], 1e-6),
          o.d / Math.max(size[2], 1e-6)];
}

/** 置換した家具の向き（three.js の rotation.y, ラジアン）。

    **`yaw` の符号を反転する。** 平面図の `yaw` は (x, z) 平面で +x から +z へ
    測るが、three.js の `Ry(θ)` は +x を (cosθ, −sinθ) へ送るので向きが逆に
    なる。実測で、箱の隅（サーバが出す `box.pts`）と比べて +yaw では最大
    0.326m ずれ、−yaw でぴったり合った。

    人の回転 `dyaw` はスキャンのメッシュと同じ向き（そちらは `+dyaw`）。 */
function replaceYaw(o, m) {
  return (-(o.yaw || 0) + (m.dyaw || 0)) * Math.PI / 180;
}

/** 置換を 3D へ反映する。

    箱と同じ大きさにし、底に置いて中心を揃える。倍率は `fitInBox`。 */
async function applyReplacements() {
  if (!renderer || !plan) return;
  for (const [id, node] of replaceNodes) {
    if (replaceMap[id]) continue;
    scene.remove(node);
    replaceNodes.delete(id);
    const m = meshes.get(id);
    if (m) m.mesh.visible = true;              // 元のスキャンを戻す
  }
  for (const o of (plan.objects || [])) {
    const key = replaceMap[o.id];
    const m = meshes.get(o.id);
    if (!key) continue;
    if (m) m.mesh.visible = false;
    if (replaceNodes.has(o.id)) continue;
    const a = await loadAsset(key);
    if (!a) { delete replaceMap[o.id]; continue; }
    const k = fitInBox(a.size, o);
    const inner = a.group.clone(true);
    inner.scale.set(k[0], k[1], k[2]);
    // 合わせたあとの高さはちょうど箱の高さ。中心が原点なので半分だけ上げる。
    inner.position.set(0, o.h / 2, 0);
    const node = new THREE.Group();
    node.add(inner);
    node.userData.id = o.id;
    scene.add(node);
    replaceNodes.set(o.id, node);
  }
  place();
}

function addBox(part) {
  const b = part.box, pts = b.pts, y0 = b.y0, y1 = b.y0 + b.h, v = [];
  for (let i = 0; i < 4; i++) {
    const p = pts[i], q = pts[(i + 1) % 4];
    v.push(p[0], y0, p[1], q[0], y0, q[1]);     // 下の輪
    v.push(p[0], y1, p[1], q[0], y1, q[1]);     // 上の輪
    v.push(p[0], y0, p[1], p[0], y1, p[1]);     // 縦
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  const line = new THREE.LineSegments(g,
    new THREE.LineBasicMaterial({ color: new THREE.Color(cssColor('--rule')),
                                  transparent: true, opacity: 0.55 }));
  line.position.set(part.c[0], 0, part.c[2]);
  boxes.set(part.id, line);
  scene.add(line);
}

const ray = typeof THREE !== 'undefined' ? new THREE.Raycaster() : null;

/** 画面の点の下にある家具の id。無ければ null。 */
function objectAt(e) {
  if (!ray) return null;
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(pickable, false)[0];
  return hit ? hit.object.userData.id : null;
}
// --- 同期 -------------------------------------------------------------------

/** 家具を平面図の上へ置く。

    **drawPlan の最後から必ず呼ぶ。** drawPlan は .obj を transform 無しで作り
    直すので、ここを通さないと家具がすべて SVG の原点へ寄る。位置を描画と別の
    関数が持つ限り、描き直しのたびに呼び忘れる余地が残るため、呼ぶ側の作法に
    しない。 */
function placeSvg() {
  if (!plan) return;
  for (const o of (plan.objects || [])) {
    const m = state.get(o.id) || { dx: 0, dz: 0, dyaw: 0 };
    const g = objNodes.get(o.id);
    if (!g) continue;
    const [sx, sy] = toScreen([o.c[0] + m.dx, o.c[1] + m.dz]);
    const rot = o.yaw - 90 - m.dyaw;
    g.setAttribute('transform', `translate(${sx} ${sy}) rotate(${rot})`);
    const lab = g.querySelector('.lab');
    if (lab) lab.setAttribute('transform', `rotate(${-rot})`);
    g.classList.toggle('moved', !!(m.dx || m.dz || m.dyaw));
    g.classList.toggle('sel', sel === o.id);
  }
  syncReplaceUI();
}

function place() {
  if (!plan) return;
  placeSvg();
  for (const o of (plan.objects || [])) {
    const m = state.get(o.id) || { dx: 0, dz: 0, dyaw: 0 };
    const m3 = meshes.get(o.id);
    if (m3) {
      m3.mesh.position.set(m3.c[0] + m.dx, 0, m3.c[2] + m.dz);
      m3.mesh.rotation.y = m.dyaw * Math.PI / 180;
    }
    const rp = replaceNodes.get(o.id);
    if (rp && m3) {
      // 置換も家具と同じだけ動かす。向きは箱の向き＋人の回転。
      rp.position.set(m3.c[0] + m.dx, m3.y0 || 0, m3.c[2] + m.dz);
      rp.rotation.y = replaceYaw(o, m);
    }
    const bx = boxes.get(o.id);
    if (bx && m3) {
      bx.position.set(m3.c[0] + m.dx, 0, m3.c[2] + m.dz);
      bx.rotation.y = m.dyaw * Math.PI / 180;
      const on = sel === o.id;
      bx.material.color.set(cssColor(on ? '--pick' : '--rule'));
      bx.material.opacity = on ? 1 : 0.4;
    }
  }
  draw();
  table();
}

function table() {
  const tb = document.querySelector('#objects tbody');
  tb.innerHTML = '';
  for (const o of (plan.objects || [])) {
    const m = state.get(o.id);
    const tr = document.createElement('tr');
    if (sel === o.id) tr.className = 'sel';
    if (o.confidence === 'low') tr.classList.add('low');
    const f = v => v ? (v > 0 ? '+' : '') + (v * 1000).toFixed(0) : '—';
    tr.innerHTML = `<td class="name">${o.label}</td>`
      + `<td>${(o.w * 1000).toFixed(0)}×${(o.d * 1000).toFixed(0)}</td>`
      + `<td>${f(m.dx)}</td><td>${f(m.dz)}</td>`
      + `<td>${m.dyaw ? (m.dyaw > 0 ? '+' : '') + m.dyaw.toFixed(0) + '°' : '—'}</td>`;
    tr.addEventListener('click', () => { sel = o.id; place(); });
    tb.appendChild(tr);
  }
  for (const b of ['rotL', 'rotR', 'rot90', 'resetOne'])
    document.getElementById(b).disabled = !sel;
  document.getElementById('save').disabled = !dirty;
}

// --- 操作 -------------------------------------------------------------------

function toUser(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return [p.x, p.y];
}
let drag = null;
function onDown(e) {
  const g = e.currentTarget;
  sel = g.dataset.id;
  const m = state.get(sel);
  drag = { start: toUser(e), base: { dx: m.dx, dz: m.dz } };
  g.setPointerCapture(e.pointerId);
  place();
}
function onMove(e) {
  if (!drag || !sel) return;
  const [ux, uy] = toUser(e);
  // 画面 (sx, sy) = (z, LX - x) なので、逆に dz = dsx、dx = -dsy。
  let dz = drag.base.dz + (ux - drag.start[0]);
  let dx = drag.base.dx - (uy - drag.start[1]);
  if (document.getElementById('snap').checked) {
    dx = Math.round(dx / 0.05) * 0.05; dz = Math.round(dz / 0.05) * 0.05;
  }
  const m = state.get(sel);
  m.dx = dx; m.dz = dz;
  dirty = true;
  place();
}
function onUp() { drag = null; }

/* 画面の点を平面図の座標へ。画面は (x,z)→(z, LX−x) に写しているので戻す。 */
function toPlan(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const q = pt.matrixTransform(svg.getScreenCTM().inverse());
  return [plan.extent[0] - q.y, q.x];
}
const snap = v => Math.round(v / SNAP) * SNAP;

let nodeDrag = null, wallDrag = null;

/* 移動と終了は掴んだ要素ではなく svg で受ける。

   **drawPlan は svg.innerHTML を空にするので、掴んだ要素は最初の 1 コマで
   消える。** そこに捕捉を預けると、そこから先の pointermove が届かず、壁が
   1 刻みだけ動いて止まる。svg そのものは差し替わらないので捕捉が続く。 */
svg.addEventListener('pointermove', e => {
  if (nodeDrag) onNodeMove(e);
  else if (wallDrag) onWallMove(e);
});
const endEdit = e => {
  if (nodeDrag) onNodeUp(e);
  else if (wallDrag) onWallUp(e);
};
svg.addEventListener('pointerup', endEdit);
svg.addEventListener('pointercancel', endEdit);
svg.addEventListener('lostpointercapture', endEdit);

function onNodeDown(e) {
  if (!editing) return;
  e.stopPropagation();
  dragging = true;
  const i = +e.currentTarget.dataset.node;
  nodeDrag = { i, start: toPlan(e), base: { ...graph.nodes[i] } };
  svg.setPointerCapture(e.pointerId);
  drawPlan();
}
function onNodeMove(e) {
  if (!nodeDrag) return;
  const p = toPlan(e);
  const n = graph.nodes[nodeDrag.i];
  n.x = snap(nodeDrag.base.x + (p[0] - nodeDrag.start[0]));
  n.z = snap(nodeDrag.base.z + (p[1] - nodeDrag.start[1]));
  applyGraph(); drawPlan(); place();
}
function onNodeUp() {
  if (!nodeDrag) return;
  nodeDrag = null; dragging = false;
  applyGraph(); drawPlan(); place();
  planDirty = true;
  pushHistory();
  showEditBar();
}

function onWallDown(e) {
  if (!editing) return;
  e.stopPropagation();
  const g = graph.walls.find(x => x.w.id === e.currentTarget.dataset.wall);
  if (!g) return;
  dragging = true;
  const a = graph.nodes[g.na], b = graph.nodes[g.nb];
  const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  // **壁は自分の法線方向にだけ動かす。** 自由に動かすと長さと向きが同時に
  // 変わり、部屋の寸法を直すつもりの操作で角度まで狂う。
  wallDrag = { g, start: toPlan(e), n: [-(b.z - a.z) / L, (b.x - a.x) / L],
               base: [{ ...a }, { ...b }], moved: false };
  svg.setPointerCapture(e.pointerId);
}
function onWallMove(e) {
  if (!wallDrag) return;
  const { g, n, base, start } = wallDrag;
  const p = toPlan(e);
  const k = snap((p[0] - start[0]) * n[0] + (p[1] - start[1]) * n[1]);
  if (k !== 0) wallDrag.moved = true;
  graph.nodes[g.na].x = r4(base[0].x + n[0] * k);
  graph.nodes[g.na].z = r4(base[0].z + n[1] * k);
  graph.nodes[g.nb].x = r4(base[1].x + n[0] * k);
  graph.nodes[g.nb].z = r4(base[1].z + n[1] * k);
  applyGraph(); drawPlan(); place();
}
function onWallUp() {
  if (!wallDrag) return;
  // 動かさずに離したら選択。動かしたなら控えに積む。
  const moved = wallDrag.moved, id = wallDrag.g.w.id;
  wallDrag = null; dragging = false;
  if (!moved) {
    selWall = selWall === id ? null : id;
    drawPlan(); showEditBar();
    return;
  }
  applyGraph(); drawPlan(); place();
  planDirty = true;
  pushHistory();
  showEditBar();
}

/** 壁を足すときの点。50mm に丸め、既存の角に近ければそこへ吸い付かせる。 */
function onAddPoint(e) {
  e.stopPropagation();
  const q = toPlan(e);
  let p = [snap(q[0]), snap(q[1])];
  for (const n of graph.nodes)
    if (Math.hypot(n.x - q[0], n.z - q[1]) < 0.25) { p = [n.x, n.z]; break; }
  if (!addFrom) { addFrom = p; drawPlan(); showEditBar(); return; }
  if (Math.hypot(p[0] - addFrom[0], p[1] - addFrom[1]) < SNAP) return;  // 同じ点
  const a = addFrom;
  addFrom = null; adding = false;
  addWall(a, p);
  showEditBar();
}

window.addEventListener('keydown', e => {
  if (walking || !sel || !plan) return;
  const m = state.get(sel), step = e.shiftKey ? 0.01 : 0.05;
  const map = { ArrowUp: [step, 0], ArrowDown: [-step, 0],
                ArrowLeft: [0, -step], ArrowRight: [0, step] };
  if (map[e.key]) { m.dx += map[e.key][0]; m.dz += map[e.key][1]; dirty = true; place(); e.preventDefault(); }
  else if (e.key === '[') { m.dyaw += 5; dirty = true; place(); }
  else if (e.key === ']') { m.dyaw -= 5; dirty = true; place(); }
  else if (e.key === 'Escape') { sel = null; place(); }
});
const bump = d => { if (sel) { state.get(sel).dyaw += d; dirty = true; place(); } };
document.getElementById('rotL').onclick = () => bump(15);
document.getElementById('rotR').onclick = () => bump(-15);
document.getElementById('rot90').onclick = () => bump(90);
document.getElementById('replaceDo').onclick = async () => {
  if (!sel) return;
  const box = document.getElementById('replaceWith');
  if (replaceMap[sel]) delete replaceMap[sel];
  else if (box.value) replaceMap[sel] = box.value;
  else { setStatus('置き換えるアセットを選んでください', true); return; }
  await applyReplacements();
  drawPlan();
  syncReplaceUI();
  setStatus(replaceMap[sel] ? '置き換えました' : '元のスキャンに戻しました');
};
document.getElementById('replaceWith').onchange = () => {
  const box = document.getElementById('replaceWith');
  document.getElementById('replaceDo').textContent =
    (box.value && box.value !== replaceMap[sel]) ? '置換' : (replaceMap[sel] ? '戻す' : '置換');
};
document.getElementById('resetOne').onclick = () => {
  if (sel) { state.set(sel, { dx: 0, dz: 0, dyaw: 0 }); dirty = true; place(); }
};
document.getElementById('resetAll').onclick = () => {
  for (const o of (plan.objects || [])) state.set(o.id, { dx: 0, dz: 0, dyaw: 0 });
  dirty = true; place();
};
document.getElementById('cull').onchange = e => {
  cullBack = e.target.checked;
  for (const p of allParts) {
    if (!p.mesh) continue;
    p.mesh.material.side = sideOf(p.wallId);   // 間仕切りは切っても両面のまま
    p.mesh.material.needsUpdate = true;
  }
  buildShell();
  draw();
};
document.getElementById('shell').onchange = e => {
  showShell = e.target.checked;
  buildShell(); draw();
};
document.getElementById('tex').onchange = e => {
  useTex = e.target.checked;
  for (const p of allParts) if (p.mesh) applySkin(p.mesh.material, !!p.geo.attributes.uv);
  draw();
};
document.getElementById('overlay').onchange = e => {
  showOverlay = e.target.checked;
  if (overlay) overlay.visible = showOverlay;
  draw();
};
document.getElementById('follow').onchange = e => {
  followWalls = e.target.checked;
  moveWalls(); clipParts(); draw();
};
document.getElementById('vTop').onclick = () => { cam.phi = .14; cam.theta = -Math.PI / 2; draw(); };
document.getElementById('cmtbox').addEventListener('submit', e => {
  e.preventDefault();
  const t = document.getElementById('cmtText').value.trim();
  const p = cmtPending;
  closeComment();
  if (!t || !p) return;
  comments.push({ id: `c${Date.now().toString(36)}${comments.length}`,
                  p, text: t, at: new Date().toISOString() });
  refreshComments();
  setStatus(`コメントを付けました（${comments.length} 件）`);
});
document.getElementById('cmtCancel').onclick = () => closeComment();
document.getElementById('cmtText').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closeComment(); }
  e.stopPropagation();                        // 歩く操作に流さない
});

document.getElementById('walk').onclick = () => (walking ? exitWalk() : enterWalk());
document.getElementById('vIso').onclick = () => { cam.phi = 1.02; cam.theta = -.9; draw(); };
document.getElementById('reload').onclick = loadList;
api('/api/assets').then(a => {
  assetList = Array.isArray(a) ? a : [];
  syncReplaceUI();
});

document.getElementById('editmode').onchange = e => {
  editing = e.target.checked;
  if (editing) {
    if (!graph) buildGraph();
    if (histAt < 0) pushHistory();         // 編集前の状態を控えに入れておく
  } else {
    selWall = null; adding = false; addFrom = null;
  }
  drawPlan(); place(); showEditBar();
};
document.getElementById('addWall').onclick = () => {
  adding = !adding; addFrom = null; selWall = null;
  drawPlan(); showEditBar();
};
document.getElementById('delWall').onclick = () => { if (selWall) deleteWall(selWall); };
document.getElementById('dimW').onchange = e => resizeOverall(0, +e.target.value);
document.getElementById('dimD').onchange = e => resizeOverall(1, +e.target.value);
document.getElementById('undo').onclick = () => { if (histAt > 0) restore(histAt - 1); };
document.getElementById('redo').onclick = () => {
  if (histAt < hist.length - 1) restore(histAt + 1);
};
// 本格的な編集は CAD へ渡してから。保存前の変更は図面に入らないので断っておく。
document.getElementById('dxf').onclick = () => {
  if (!current) return;
  if (planDirty) setStatus('保存していない変更は DXF に入りません', true);
  location.href = `/api/scans/${current}/dxf`;
};
document.getElementById('savePlan').onclick = async () => {
  setStatus('図面を保存しています…');
  const doc = Object.assign({}, plan);
  delete doc.edited;
  const res = await api(`/api/scans/${current}/plan`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc) });
  if (res.ok) {
    planDirty = false;
    plan.edited = true;
    showPlanSource();
    updateEditButtons();
    setStatus('保存しました。以後はこの図面が正になります');
    loadList();
  } else setStatus(res.error || '保存できませんでした', true);
};
document.getElementById('resetPlan').onclick = async () => {
  if (!confirm('スキャン直後の図面に戻します。編集した内容は失われます。')) return;
  const res = await api(`/api/scans/${current}/plan-reset`, { method: 'POST' });
  if (res.ok) {
    setStatus(res.reverted ? 'スキャン直後に戻しました' : '編集はありませんでした');
    select(current);
    loadList();
  } else setStatus(res.error || '戻せませんでした', true);
};

document.getElementById('save').onclick = async () => {
  const R = plan.rot, moved = [];
  for (const o of (plan.objects || [])) {
    const m = state.get(o.id);
    if (!m.dx && !m.dz && !m.dyaw) continue;
    // 図面の枠から world へ。局所 = R·world なので world = Rᵀ·局所。
    moved.push({ id: o.id, delta: {
      dx: +(R[0][0] * m.dx + R[1][0] * m.dz).toFixed(4),
      dz: +(R[0][1] * m.dx + R[1][1] * m.dz).toFixed(4),
      dyaw: +m.dyaw.toFixed(1) } });
  }
  setStatus('切り分けて動かしています…');
  const res = await api(`/api/scans/${current}/arrange`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moved }) });
  if (res.ok) {
    dirty = false;
    setStatus(`arranged.ply を書きました（${res.moved ?? 0} 個 / ${(res.faces || 0).toLocaleString()} 面）`);
    loadList();
  } else {
    setStatus(res.error || '失敗しました', true);
  }
  table();
};

/** 置換の操作列。家具を選んでいるときだけ使える。 */
function syncReplaceUI() {
  const box = document.getElementById('replaceWith');
  const btn = document.getElementById('replaceDo');
  if (!box || !btn) return;
  const obj = (plan && plan.objects || []).find(v => v.id === sel);
  box.disabled = !obj;
  btn.disabled = !obj;
  if (box.dataset.filled !== String(assetList.length)) {
    box.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '置換なし';
    box.appendChild(none);
    for (const a of assetList) {
      const op = document.createElement('option');
      op.value = a.key;
      op.textContent = `${a.label}（${a.faces.toLocaleString()} 面）`;
      box.appendChild(op);
    }
    box.dataset.filled = String(assetList.length);
  }
  box.value = (obj && replaceMap[sel]) || '';
  btn.textContent = box.value ? '戻す' : '置換';
}

function setStatus(text, err) {
  const s = document.getElementById('status');
  s.textContent = text;
  s.className = 'status' + (err ? ' err' : '');
}

fetch('/api/scans').then(() => loadList());
