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
    const g = el('g', { class: 'obj', 'data-id': o.id }, objs);
    el('rect', { x: -o.w / 2, y: -o.d / 2, width: o.w, height: o.d }, g);
    // **家具は形状だけでなく名称と寸法を併記する**（解説 9）。寸法は W×D×H。
    // 家具が回っても文字は水平に保つので、ラベルは別の g に入れて逆回転させる。
    const lab = el('g', { class: 'lab' }, g);
    el('text', { x: 0, y: -0.06 }, lab).textContent = o.label;
    el('text', { x: 0, y: 0.09, class: 'size' }, lab).textContent =
      `${mmv(o.w)}×${mmv(o.d)}×${mmv(o.h)}`;
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
}

// --- 3D ---------------------------------------------------------------------

let overlay = null;          // 編集後の壁を立体にしたもの（図面の側）
let showOverlay = true;
let renderer, scene, camera, hemi, dirLight, meshes = new Map(), pickable = [];
let materials = [];          // 裏面の扱いを一括で切り替えるため
let cullBack = true;
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
    if (orbit && !orbit.moved) { sel = objectAt(e); place(); }
    orbit = null;
  });
  canvas.addEventListener('pointercancel', () => { orbit = null; });
  canvas.addEventListener('wheel', e => {
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
  if (g.error) {
    document.getElementById('gl-note').textContent = g.error;
    return;
  }
  for (const part of g.parts) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(dec(part.pos, Float32Array), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(dec(part.col, Uint8Array), 3, true));
    geo.setIndex(new THREE.BufferAttribute(dec(part.idx, Uint32Array), 1));
    if (part.kind === 'object') geo.translate(-part.c[0], 0, -part.c[2]);
    geo.computeVertexNormals();
    // **裏面を描かない。** ARKit のメッシュは法線が室内側を向くので、
    // 外から見ると手前の壁が消えて中が見える。両面で描くと箱の外側しか
    // 見えず、間取りの確認に使えない。
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      vertexColors: true, side: cullBack ? THREE.FrontSide : THREE.DoubleSide }));
    materials.push(mesh.material);
    if (part.kind === 'object') {
      mesh.position.set(part.c[0], 0, part.c[2]);
      mesh.userData.id = part.id;
      meshes.set(part.id, { mesh, c: part.c });
      pickable.push(mesh);
      if (part.box) addBox(part);
    }
    scene.add(mesh);
  }
  target.set(g.extent[0] / 2, 1.2, g.extent[1] / 2);
  cam.r = Math.max(6, Math.hypot(g.extent[0], g.extent[1]) * 0.9);
  document.getElementById('gl-note').hidden = true;
  updateOverlay();                            // initGL の後でないと作れない
  resizeGL(); place(); draw();
}

function resizeGL() {
  if (!renderer) return;
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1);
  camera.updateProjectionMatrix();
}
const draw = () => { needs = true; };
function loop() {
  if (needs && renderer && target) {
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
  if (overlay) {
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
  if (!sel || !plan) return;
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
document.getElementById('resetOne').onclick = () => {
  if (sel) { state.set(sel, { dx: 0, dz: 0, dyaw: 0 }); dirty = true; place(); }
};
document.getElementById('resetAll').onclick = () => {
  for (const o of (plan.objects || [])) state.set(o.id, { dx: 0, dz: 0, dyaw: 0 });
  dirty = true; place();
};
document.getElementById('cull').onchange = e => {
  cullBack = e.target.checked;
  for (const m of materials) {
    m.side = cullBack ? THREE.FrontSide : THREE.DoubleSide;
    m.needsUpdate = true;
  }
  draw();
};
document.getElementById('overlay').onchange = e => {
  showOverlay = e.target.checked;
  if (overlay) overlay.visible = showOverlay;
  draw();
};
document.getElementById('vTop').onclick = () => { cam.phi = .14; cam.theta = -Math.PI / 2; draw(); };
document.getElementById('vIso').onclick = () => { cam.phi = 1.02; cam.theta = -.9; draw(); };
document.getElementById('reload').onclick = loadList;

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

function setStatus(text, err) {
  const s = document.getElementById('status');
  s.textContent = text;
  s.className = 'status' + (err ? ' err' : '');
}

fetch('/api/scans').then(() => loadList());
