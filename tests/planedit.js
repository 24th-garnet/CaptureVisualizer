// 平面図の編集を DOM 無しで確かめる。pytest（test_planedit.py）から jsc で走る。
// ブラウザが無い環境でも、壁を動かしたときの開口の挙動を押さえておきたい。
function Node(tag) {
  this.tag = tag; this.attrs = {}; this.kids = []; this._text = ''; this.dataset = {};
  this.value = ''; this.hidden = false; this.style = {};
  this.focus = function () { this.focused = true; };
  var cls = {};
  this.classList = {
    add: function (c) { cls[c] = true; },
    remove: function (c) { delete cls[c]; },
    contains: function (c) { return !!cls[c]; },
    toggle: function (c, on) {
      if (on === undefined) on = !cls[c];
      if (on) cls[c] = true; else delete cls[c];
      return !!cls[c];
    }
  };
}
Node.prototype.append = function () {
  for (var i = 0; i < arguments.length; i++) this.kids.push(arguments[i]);
};
Node.prototype.setAttribute = function(k, v) { this.attrs[k] = v; };
Node.prototype.getAttribute = function(k) { return this.attrs[k]; };
Node.prototype.appendChild = function(n) { this.kids.push(n); return n; };
Node.prototype.addEventListener = function(){};
Node.prototype.querySelector = function(){ return null; };
Node.prototype.querySelectorAll = function(){ return []; };
var captured = null;
Node.prototype.setPointerCapture = function(){ captured = this; };
Node.prototype.releasePointerCapture = function(){ captured = null; };
Node.prototype.getBoundingClientRect = function(){
  return { width: 800, height: 600, left: 0, top: 0 };
};
Node.prototype.removeChild = function (n) {
  this.kids = this.kids.filter(function (k) { return k !== n; });
};
Node.prototype.createSVGPoint = function(){
  return { x: 0, y: 0, matrixTransform: function(m){ return m.apply(this); } };
};
Node.prototype.getScreenCTM = function(){
  return { inverse: function(){ return { apply: function(p){ return {x: p.x, y: p.y}; } }; } };
};
Object.defineProperty(Node.prototype, 'textContent', {
  get: function(){ return this._text; }, set: function(v){ this._text = v; } });
Object.defineProperty(Node.prototype, 'innerHTML', {
  get: function(){ return ''; }, set: function(v){ this.kids = []; } });

var els = {};
function stub(id) { if (!els[id]) els[id] = new Node('div'); return els[id]; }
var document = {
  createElementNS: function(ns, tag) { return new Node(tag); },
  createElement: function(tag) { return new Node(tag); },
  getElementById: stub,
  querySelectorAll: function(){ return []; },
  querySelector: function(){ return new Node('tbody'); },
  documentElement: new Node('html'),
  addEventListener: function(){}
};
var window = { addEventListener: function(){}, devicePixelRatio: 1 };
var devicePixelRatio = 1;
var getComputedStyle = function(){ return { getPropertyValue: function(){ return '#888'; } }; };
var fetch = function(){ return { then: function(){ return { then: function(){} }; } }; };
var THREE = undefined, ResizeObserver = function(){ this.observe = function(){}; };
var requestAnimationFrame = function(){};
var setTimeout = function(){ return 0; };
var localStorage = { getItem: function(){ return null; }, setItem: function(){} };
var atob = function(){ return ''; };
var confirm = function(){ return true; };

load(APP_JS);

var fails = 0;
function ok(name, cond, extra) {
  if (!cond) { fails++; print('NG  ' + name + (extra ? '  ' + extra : '')); }
  else print('ok  ' + name);
}
function near(a, b, tol) { return Math.abs(a - b) < (tol || 1e-6); }

plan = JSON.parse(readFile(PLAN_JSON));
state = new Map();
for (var i = 0; i < plan.objects.length; i++)
  state.set(plan.objects[i].id, { dx: 0, dz: 0, dyaw: 0 });

// --- 溶接 -------------------------------------------------------------------
// 部屋は w0(x=0,z 方向) / w3(z=0,x 方向) / w1(x=3.13) / w2(z=3.58) の 4 枚。
// w3 の法線は z 方向なので、w3 を動かすと w0 と w1 が縮む。
buildGraph();
ok('4 壁が 4 節点に溶接される', graph.nodes.length === 4, 'nodes=' + graph.nodes.length);

els['editmode'].onchange({ target: { checked: true } });   // 編集に入る
ok('編集に入ると現状が控えに積まれる', hist.length === 1 && histAt === 0);
var vb0 = els['plan'].attrs.viewBox;
ok('編集中も描ける', els['plan'].kids.length > 0);
var handles = 0;
(function count(n) {
  if ((n.attrs['class'] || '') === 'node') handles++;
  for (var i = 0; i < n.kids.length; i++) count(n.kids[i]);
})(els['plan']);
ok('つまみが 4 個出る', handles === 4, 'handles=' + handles);

// --- 壁のドラッグ：法線方向にだけ動く --------------------------------------
function ev(x, z, wallId, nodeIdx) {
  var t = new Node('line');
  t.dataset = wallId ? { wall: wallId } : { node: String(nodeIdx) };
  t.setPointerCapture = function(){};
  // toPlan は [extent[0] - clientY, clientX] を返す。その逆を入れる。
  return { clientX: z, clientY: plan.extent[0] - x, pointerId: 1,
           stopPropagation: function(){}, currentTarget: t };
}
var W = {};
function reindex() { for (var i = 0; i < plan.walls.length; i++) W[plan.walls[i].id] = plan.walls[i]; }
reindex();
var s1 = W.w1.openings[0].s, w1width = W.w1.openings[0].e - W.w1.openings[0].s;

onWallDown(ev(0, 0, 'w3'));
// **捕捉は svg が持たなければならない。** drawPlan は svg.innerHTML を空に
// するので、掴んだ線に預けると最初の 1 コマで消え、壁が 1 刻みで止まる。
ok('捕捉は描き直しで消えない svg が持つ', captured === els['plan']);
onWallMove(ev(0, 0.2, 'w3'));
onWallMove(ev(0, 0.5, 'w3'));       // 描き直しを挟んでも続く
onWallUp();
reindex();
ok('w3 が法線方向に 0.5 動く', near(W.w3.a[1], 0.5) && near(W.w3.b[1], 0.5),
   JSON.stringify([W.w3.a, W.w3.b]));
ok('w3 の長さは変わらない',
   near(Math.hypot(W.w3.b[0]-W.w3.a[0], W.w3.b[1]-W.w3.a[1]), 3.1347, 1e-3));
ok('斜めにならない', near(W.w3.a[1], W.w3.b[1]));
ok('繋がった w0 の端が追従する', near(W.w0.b[1], 0.5), JSON.stringify(W.w0.b));
ok('w0 が 0.5 短くなる',
   near(Math.hypot(W.w0.b[0]-W.w0.a[0], W.w0.b[1]-W.w0.a[1]), 3.0754, 1e-3));
ok('動いていない w2 はそのまま', near(W.w2.a[1], 3.5754) && near(W.w2.b[1], 3.5754));
ok('w0 の開口は a 端からの距離を保つ（a は動いていない側）',
   near(W.w0.openings[0].s, 0.0638) && near(W.w0.openings[0].e, 0.7981));
ok('w1 の開口は a 端からの距離を保つ（a が動いた側）',
   near(W.w1.openings[0].s, s1) && near(W.w1.openings[0].e, s1 + w1width));

// --- はみ出し ---------------------------------------------------------------
onWallDown(ev(0, 0.5, 'w3'));
onWallMove(ev(0, 2.0, 'w3'));
onWallUp();
reindex();
var L1 = Math.hypot(W.w1.b[0]-W.w1.a[0], W.w1.b[1]-W.w1.a[1]);
ok('w1 が 1.5754 になる', near(L1, 1.5754, 1e-3), 'L=' + L1);
ok('はみ出した開口は端へ寄る', near(W.w1.openings[0].e, L1, 1e-3),
   JSON.stringify(W.w1.openings[0]));
ok('開口は壁に収まる',
   W.w1.openings[0].s >= -1e-9 && W.w1.openings[0].e <= L1 + 1e-3,
   JSON.stringify(W.w1.openings[0]));
ok('開口の幅は保たれる（収まる限り）',
   near(W.w1.openings[0].e - W.w1.openings[0].s, Math.min(w1width, L1), 1e-3));

// --- 取り消し・やり直し -----------------------------------------------------
ok('控えが 3 つ', hist.length === 3 && histAt === 2, 'hist=' + hist.length + ' at=' + histAt);
restore(1);
reindex();
ok('ひとつ戻すと最初のドラッグ直後', near(W.w3.a[1], 0.5), JSON.stringify(W.w3.a));
restore(0);
reindex();
ok('取り消しで壁が戻る', near(W.w3.a[1], 0) && near(W.w3.b[1], 0),
   JSON.stringify([W.w3.a, W.w3.b]));
ok('取り消しで開口も戻る', near(W.w1.openings[0].e, s1 + w1width, 1e-3));
restore(2);
reindex();
ok('やり直しで最後の状態へ戻れる', near(W.w3.a[1], 2.0), JSON.stringify(W.w3.a));

// --- 節点のドラッグ ---------------------------------------------------------
restore(0);
var before = { x: graph.nodes[0].x, z: graph.nodes[0].z };
onNodeDown(ev(before.x, before.z, null, 0));
onNodeMove(ev(before.x - 0.37, before.z, null, 0));
onNodeUp();
reindex();
ok('節点は 50mm に丸められる', near(graph.nodes[0].x, before.x - 0.35),
   'x=' + graph.nodes[0].x);
ok('節点に集まる 2 壁が追従する',
   near(W.w0.a[0], before.x - 0.35) && near(W.w2.b[0], before.x - 0.35),
   JSON.stringify([W.w0.a, W.w2.b]));
ok('節点を外へ出すと繋がった壁が伸びる',
   near(Math.hypot(W.w2.b[0]-W.w2.a[0], W.w2.b[1]-W.w2.a[1]), 3.1347 + 0.35, 1e-3),
   'L=' + Math.hypot(W.w2.b[0]-W.w2.a[0], W.w2.b[1]-W.w2.a[1]));
ok('節点ドラッグも控えに積まれる', hist.length === 2 && histAt === 1,
   'hist=' + hist.length + ' at=' + histAt);

// --- 描画範囲 ---------------------------------------------------------------
drawPlan();
ok('図が原点の外へ出ても viewBox が追う', els['plan'].attrs.viewBox !== vb0,
   vb0 + ' -> ' + els['plan'].attrs.viewBox);
ok('viewBox が負の側まで覆う',
   parseFloat(els['plan'].attrs.viewBox.split(' ')[1]) < 0,
   els['plan'].attrs.viewBox);

// --- 編集を閉じるとつまみが消える -------------------------------------------
els['editmode'].onchange({ target: { checked: false } });
var h2 = 0;
(function count(n) {
  if ((n.attrs['class'] || '') === 'node' || (n.attrs['class'] || '') === 'wallhit') h2++;
  for (var i = 0; i < n.kids.length; i++) count(n.kids[i]);
})(els['plan']);
ok('編集を閉じるとつまみが消える', h2 === 0, 'h2=' + h2);


// --- 内法の数値入力 ---------------------------------------------------------
els['editmode'].onchange({ target: { checked: true } });
restore(0);
reindex();
var b0 = planBounds();
ok('内法 W は 3135', Math.round((b0[1] - b0[0]) * 1000) === 3135,
   JSON.stringify(b0));
els['dimW'].onchange({ target: { value: 3000 } });
reindex();
var b1 = planBounds();
ok('W を 3000 にすると外形が 3000 になる',
   Math.round((b1[1] - b1[0]) * 1000) === 3000, JSON.stringify(b1));
ok('近い側の辺は動かない', near(b1[0], b0[0]), b1[0] + ' vs ' + b0[0]);
ok('遠い側の辺が引っ張られる', near(b1[1], b0[1] - 0.1347, 1e-3));
ok('D は変わらない', near(b1[3] - b1[2], b0[3] - b0[2]));

// --- 壁の追加 ---------------------------------------------------------------
var before = plan.walls.length;
adding = true;
onAddPoint(ev(0, 1.5, 'x'));          // 1 点目
ok('1 点目を置くと印が出る', addFrom !== null);
onAddPoint(ev(b1[1], 1.5, 'x'));      // 2 点目（反対の壁まで）
reindex();
ok('壁が 1 枚増える', plan.walls.length === before + 1, 'n=' + plan.walls.length);
ok('追加が終わると待ち受けは閉じる', adding === false && addFrom === null);
var added = plan.walls[plan.walls.length - 1];
ok('新しい壁に id が付く', /^w\d+$/.test(added.id), 'id=' + added.id);
ok('id が既存と衝突しない',
   plan.walls.filter(function(w){ return w.id === added.id; }).length === 1);
ok('角から遠い点は吸い付かない（50mm 丸めのみ）',
   near(added.a[0], 0) && near(added.a[1], 1.5), JSON.stringify(added.a));
ok('追加した壁に開口は無い', added.openings.length === 0);
ok('高さは既存の壁から取る', near(added.height, 2.408));
buildGraph();
ok('端点が既存の節点に溶接される', graph.nodes.length <= 6,
   'nodes=' + graph.nodes.length);

// 角の近く（25cm 以内）を指すと、その角へ吸い付く。
adding = true;
onAddPoint(ev(0.12, 0.08, 'x'));       // (0,0) の角のそば
ok('角のそばは角へ吸い付く', near(addFrom[0], 0) && near(addFrom[1], 0),
   JSON.stringify(addFrom));
adding = false; addFrom = null;

// --- 壁の削除 ---------------------------------------------------------------
selWall = added.id;
els['delWall'].onclick();
ok('壁が消える', plan.walls.length === before, 'n=' + plan.walls.length);
ok('選択が外れる', selWall === null);

// --- 選択 -------------------------------------------------------------------
var hn = hist.length;
onWallDown(ev(0, 0, 'w3'));
onWallUp();                            // 動かさずに離す
ok('動かさずに離すと選択になる', selWall === 'w3', 'sel=' + selWall);
ok('選択は控えに積まれない', hist.length === hn, hn + ' -> ' + hist.length);
onWallDown(ev(0, 0, 'w3'));
onWallUp();
ok('もう一度掴むと選択が外れる', selWall === null);


// --- 家具が原点へ寄らないこと -----------------------------------------------
// drawPlan は .obj を transform 無しで作り直す。描き直したあと位置を書き戻さ
// ないと、家具がまとめて SVG の原点へ寄る（壁の選択で実際に起きた）。
function furnT() {
  var out = [];
  objNodes.forEach(function (g) { out.push(g.attrs.transform); });
  return out;
}
restore(0);
reindex();
var t0 = furnT();
ok('家具に位置が入っている', t0.length === 1 && /^translate\(/.test(t0[0]), t0[0]);

onWallDown(ev(0, 0, 'w3'));
onWallUp();                                  // 動かさずに離す＝選択
ok('壁を選んでも家具の位置が残る', furnT()[0] === t0[0], furnT()[0]);
onWallDown(ev(0, 0, 'w3'));
onWallUp();                                  // 選択を外す

onNodeDown(ev(graph.nodes[0].x, graph.nodes[0].z, null, 0));
ok('角を掴んだ時点でも家具の位置が残る', furnT()[0] === t0[0], furnT()[0]);
onNodeUp();

els['addWall'].onclick();                    // 壁の追加を待つ状態へ
ok('壁の追加に入っても家具の位置が残る', furnT()[0] === t0[0], furnT()[0]);
onAddPoint(ev(0, 1.5, 'x'));                 // 1 点目を置いた直後
ok('1 点目を置いても家具の位置が残る', furnT()[0] === t0[0], furnT()[0]);
adding = false; addFrom = null; drawPlan();


// --- 編集後の壁を立体にする（3D への重ね描き）-------------------------------
// three.js は読めないので、立体の素になる直方体の一覧だけを確かめる。
restore(0);
reindex();
var bx = overlayBoxes();
// 開口のある壁 3 枚は「手前の壁・垂れ壁・奥の壁」の 3 個、開口の無い w3 は 1 個。
ok('直方体は 10 個', bx.length === 10, 'n=' + bx.length);
var full = bx.filter(function (b) { return b.y0 === 0 && b.y1 === 2.408; });
ok('壁の実部は床から天井まで', full.length === 7, 'n=' + full.length);
var lint = bx.filter(function (b) { return b.y0 > 0; });
ok('垂れ壁が 3 個', lint.length === 3, 'n=' + lint.length);
ok('垂れ壁は開口の上端から始まる', near(lint[0].y0, 2.1269) && near(lint[0].y1, 2.408),
   JSON.stringify([lint[0].y0, lint[0].y1]));
ok('腰壁は出ない（sill が 0 のため）',
   bx.filter(function (b) { return b.y0 === 0 && b.y1 < 2.0; }).length === 0);
ok('厚みが入っている', bx.every(function (b) { return near(b.T, 0.12); }));

// 壁を動かすと直方体も動く＝編集がそのまま 3D に出る
onWallDown(ev(0, 0, 'w3'));
onWallMove(ev(0, 0.5, 'w3'));
onWallUp();
var bx2 = overlayBoxes();
var w3a = bx.filter(function (b) { return near(b.p[1], 0) && near(b.q[1], 0); });
var w3b = bx2.filter(function (b) { return near(b.p[1], 0.5) && near(b.q[1], 0.5); });
ok('壁を動かすと直方体も動く', w3a.length === 1 && w3b.length === 1,
   w3a.length + ' -> ' + w3b.length);

// **追加した壁も出る。** 変形では映せない操作がここでは素直に出る。
restore(0);
var before = overlayBoxes().length;
addWall([0.5, 0.0], [0.5, 3.5754]);
ok('追加した壁が立体になる', overlayBoxes().length === before + 1,
   before + ' -> ' + overlayBoxes().length);

// **削除した壁は消える。**
var id = plan.walls[plan.walls.length - 1].id;
deleteWall(id);
ok('削除した壁の立体が消える', overlayBoxes().length === before,
   'n=' + overlayBoxes().length);

restore(0);
ok('壁が無ければ直方体も無い', (function () {
  var keep = plan.walls; plan.walls = [];
  var n = overlayBoxes().length; plan.walls = keep; return n === 0;
})());


// --- スキャンした壁を編集に追従させる ---------------------------------------
// 壁は家具と同じく別部品で、自分だけの頂点を持つ。three.js は読めないので、
// 器だけ最小に作って変形の計算を確かめる。
restore(0);
reindex();
function fakeWall(id, a, b, pts) {
  var base = new Float32Array(pts);
  return { id: id, orig: frameOf(a, b), moved: false, base: base,
           mesh: { visible: true },
           geo: { attributes: { position: { array: new Float32Array(base),
                                            needsUpdate: false } },
                  computeVertexNormals: function () {} } };
}
// w3 は (0,0)-(3.1347,0)、w1 は (3.1347,0)-(3.1347,3.5754)。角を共有する。
wallParts = [fakeWall('w3', [0, 0], [3.1347, 0],
                      [0.6, 1.0, 0.02,  1.5, 0.3, -0.01,  3.0, 2.0, 0.02]),
             fakeWall('w1', [3.1347, 0], [3.1347, 3.5754],
                      [3.12, 1.0, 0.5,  3.12, 1.0, 2.0])];
followWalls = true;
var P = wallParts[0].geo.attributes.position.array;
var Q = wallParts[1].geo.attributes.position.array;

onWallDown(ev(0, 0, 'w3'));
onWallMove(ev(0, 0.5, 'w3'));            // w3 を法線方向へ +0.5
onWallUp();
ok('壁の面が壁と同じだけ動く', near(P[2], 0.52, 1e-5) && near(P[8], 0.52, 1e-5),
   P[2] + ' / ' + P[8]);
ok('面の厚みの差は保たれる', near(P[5], 0.49, 1e-5), 'z=' + P[5]);
ok('沿う向きには動かない', near(P[0], 0.6, 1e-5) && near(P[6], 3.0, 1e-5));
ok('高さは変わらない', near(P[1], 1.0) && near(P[4], 0.3) && near(P[7], 2.0));
ok('更新の印が立つ', wallParts[0].geo.attributes.position.needsUpdate === true);
ok('引き伸ばしは起きない（部品が自分の頂点を持つ）',
   near(P[2] - P[5], 0.03, 1e-5), (P[2] - P[5]).toFixed(5));
// **端点だけが動いた隣の壁は滑らない。** 線分ではなく線を写すため。
ok('端が縮んだ隣の壁は動かない',
   near(Q[2], 0.5, 1e-6) && near(Q[5], 2.0, 1e-6), Q[2] + ' / ' + Q[5]);
ok('隣の壁は法線方向にも動かない', near(Q[0], 3.12, 1e-6) && near(Q[3], 3.12, 1e-6));

restore(0);
ok('取り消すと壁も元の位置へ戻る', near(P[2], 0.02, 1e-5), 'z=' + P[2]);

// 角のドラッグでは、その角に集まる壁だけが回る
onNodeDown(ev(0, 0, null, graph.nodes.findIndex(
  function (n) { return near(n.x, 0) && near(n.z, 0); })));
onNodeMove(ev(0.3, 0.3, null, 0));
onNodeUp();
ok('角に集まる壁は回る', Math.abs(P[2] - 0.02) > 0.1, 'z=' + P[2]);
ok('角から遠い端ほど動かない',
   Math.hypot(P[6] - 3.0, P[8] - 0.02) < Math.hypot(P[0] - 0.6, P[2] - 0.02),
   Math.hypot(P[6] - 3.0, P[8] - 0.02).toFixed(4));
ok('角に関わらない壁は動かない', near(Q[2], 0.5, 1e-6) && near(Q[5], 2.0, 1e-6));

restore(0);
followWalls = false;
drawPlan();
ok('「壁を動かす」を切ると元の位置に戻る', near(P[2], 0.02, 1e-5), 'z=' + P[2]);
followWalls = true;

// --- 壁を消すと、撮った面も消える -------------------------------------------
restore(0);
reindex();
drawPlan();
ok('消す前は出ている', wallParts[0].mesh.visible === true);
deleteWall('w3');
ok('図面から消した壁は撮った面も消える', wallParts[0].mesh.visible === false);
ok('ほかの壁は出たまま', wallParts[1].mesh.visible === true);
ok('消えるのは表示だけで、元の形は残る',
   near(wallParts[0].base[2], 0.02, 1e-9), wallParts[0].base[2]);
// **取り消しの対象。** 図面の控えを戻せば面も戻る。
restore(histAt - 1);
ok('取り消すと撮った面も戻る', wallParts[0].mesh.visible === true);
ok('戻った面は元の位置にある', near(P[2], 0.02, 1e-5), 'z=' + P[2]);
deleteWall('w3');
ok('やり直すとまた消える', wallParts[0].mesh.visible === false);
// 「壁を動かす」を切れば、測ったままを見たいので出す
followWalls = false;
drawPlan();
ok('追従を切ると消した壁も出る', wallParts[0].mesh.visible === true);
followWalls = true;
drawPlan();
ok('戻すとまた消える', wallParts[0].mesh.visible === false);

restore(0);
ok('スキャン直後まで戻せば出る', wallParts[0].mesh.visible === true);
wallParts = [];


// --- 編集後の部屋の外に残った面を隠す ---------------------------------------
restore(0);
reindex();
function fakePart(kind, wallId, pts, faces) {
  var I = new Uint32Array(faces);
  var g = { attributes: { position: { array: new Float32Array(pts) } },
            index: { needsUpdate: false }, range: null,
            setDrawRange: function (a, b) { this.range = [a, b]; } };
  return { geo: g, idx: new Uint32Array(I), baseIdx: I, kind: kind,
           wallId: wallId, clipped: false };
}
// 床に見立てた 5 枚。w1 を x=2.8347 へ寄せたとき、切る境界は壁の外面
// 2.8347 + 0.12 = 2.9547。その前後と、壁の区間の外に 1 枚ずつ置く。
var floorPts = [];
[[0.5, 1.0], [2.50, 1.0], [2.90, 1.0], [3.05, 1.0], [3.05, 4.2]].forEach(function (q) {
  floorPts.push(q[0], 0, q[1],  q[0] + 0.02, 0, q[1],  q[0], 0, q[1] + 0.02);
});
origWalls = plan.walls.map(function (w) {
  var f = frameOf([w.a[0], w.a[1]], [w.b[0], w.b[1]]);
  f.id = w.id; f.inSide = 1; return f;
});
allParts = [fakePart('room', null, floorPts,
                     [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])];
followWalls = true;
var R = allParts[0];

drawPlan();
ok('編集していなければ切らない', R.clipped === false && R.geo.range === null);

// w1（x=3.1347 の壁）を内側へ 0.3m
onWallDown(ev(3.1347, 1.0, 'w1'));
onWallMove(ev(2.8347, 1.0, 'w1'));
onWallUp();
var kept = [];
for (var i = 0; i < R.geo.range[1]; i += 3) kept.push(R.idx[i] / 3);
ok('切ったことを覚えている', R.clipped === true);
ok('室内の面は残る', kept.indexOf(0) >= 0 && kept.indexOf(1) >= 0, kept.join(','));
// **境界は壁線ではなく壁の外面。** 壁線で切ると壁そのものが消える。
ok('壁厚の内側（x=2.90）は残る', kept.indexOf(2) >= 0, kept.join(','));
ok('壁の外（x=3.05）は消える', kept.indexOf(3) < 0, kept.join(','));
// 壁の区間の外は切らない。L 字の部屋で延長線が室内を切らないため。
ok('壁の区間の外（z=4.2）は切らない', kept.indexOf(4) >= 0, kept.join(','));
ok('残ったのは 4 枚', R.geo.range[1] === 12, JSON.stringify(R.geo.range));

// 自分の壁では切らない
allParts.push(fakePart('wall', 'w1', [3.20, 1.0, 1.0,  3.25, 1.0, 1.0,  3.20, 1.0, 1.05],
                       [0, 1, 2]));
var WP = allParts[1];
drawPlan();
ok('その壁自身の部品は切らない', WP.geo.range === null || WP.geo.range[1] === 3,
   JSON.stringify(WP.geo.range));

// 家具は切らない
allParts.push(fakePart('object', null, [3.20, 0.5, 1.0,  3.25, 0.5, 1.0,  3.20, 0.5, 1.05],
                       [0, 1, 2]));
var OB = allParts[2];
drawPlan();
ok('家具は切らない（貫通は採用済みの判断）',
   OB.geo.range === null || OB.geo.range[1] === 3, JSON.stringify(OB.geo.range));

// 元に戻せば索引も戻る
restore(0);
ok('取り消すと索引も戻る', R.geo.range[1] === 15 && R.clipped === false,
   JSON.stringify(R.geo.range));

followWalls = false;
allParts = []; origWalls = []; wallParts = [];
followWalls = true;


// --- 歩き回る ---------------------------------------------------------------
// 当たり判定は平面図に対して行う。メッシュも three.js も要らない。
restore(0);
reindex();
walkMark = null;
walkCam = { position: { set: function (x, y, z) { this.x = x; this.y = y; this.z = z; } },
            rotation: { set: function (x, y, z) { this.x = x; this.y = y; this.z = z; } } };

// 立ち位置は壁からも家具からも離れる
var sp = walkSpawn();
var dWall = Infinity;
plan.walls.forEach(function (w) {
  var f = frameOf(w.a, w.b);
  var qx = sp.x - f.a[0], qz = sp.z - f.a[1];
  var t = Math.max(0, Math.min(f.L, qx * f.u[0] + qz * f.u[1]));
  dWall = Math.min(dWall, Math.hypot(sp.x - (f.a[0] + f.u[0] * t),
                                     sp.z - (f.a[1] + f.u[1] * t)));
});
ok('立ち位置は壁から離れる', dWall > WALK_RADIUS, 'd=' + dWall.toFixed(3));
ok('立ち位置は塞がれていない', walkBlocked(sp.x, sp.z, 0, 0) === false);

// 壁。部屋は x 0〜3.1347 / z 0〜3.5754。
ok('壁の向こうへは行けない', walkBlocked(1.5, 0.2, 0, -0.2) === true);
// 部屋の中心はベッドの中なので、空いている立ち位置で見る。
ok('空いているところは通れる', walkBlocked(sp.x, sp.z, 0.01, 0) === false,
   sp.x.toFixed(2) + ',' + sp.z.toFixed(2));
ok('壁厚と体の半径のぶん手前で止まる', (function () {
  var lim = 0.12 / 2 + WALK_RADIUS;            // 0.36
  return walkBlocked(1.5, lim + 0.02, 0, 0) === false
      && walkBlocked(1.5, lim - 0.02, 0, 0) === true;
})(), '限界 ' + (0.06 + WALK_RADIUS));

// **消した壁は通り抜けられる。** 編集した結果の中を歩ける。
var keep = plan.walls.slice();
deleteWall('w3');                              // z=0 の壁
ok('消した壁は通れる', walkBlocked(1.5, 0.2, 0, -0.2) === false);
restore(histAt - 1);
reindex();
ok('戻すとまた塞がる', walkBlocked(1.5, 0.2, 0, -0.2) === true);

// 家具
var o = plan.objects[0];
ok('家具には入れない',
   walkBlocked(o.c[0], o.c[1], 0, 0) === true, o.label);
ok('低い物は跨げる', (function () {
  var h = o.h; o.h = 0.1;
  var r = walkBlocked(o.c[0], o.c[1], 0, 0);
  o.h = h; return r === false;
})());
ok('家具を動かすと当たりも動く', (function () {
  var m = state.get(o.id);
  var before = walkBlocked(o.c[0] + 2.0, o.c[1], 0, 0);
  m.dx = 2.0;
  var after = walkBlocked(o.c[0] + 2.0, o.c[1], 0, 0);
  m.dx = 0;
  return before === false && after === true;
})());

// 床は 0 で固定。平面図は高さを持たない。
ok('床は Y=0', walkGround() === 0);

// **向き。** three.js のカメラは局所の −Z を向く。
// 遮蔽を外して向きだけを見る。
var keepW = plan.walls, keepO = plan.objects;
plan.walls = []; plan.objects = [];
walkPos = { x: 1.5, y: 0, z: 1.5 };
walkYaw = 0; walkPitch = 0;
walkKeys.clear(); walkKeys.add('f');
walkStep(0.1);
ok('W は前（−Z）へ進む', walkPos.z < 1.5 - 1e-4, 'z=' + walkPos.z);
ok('W で横には流れない', near(walkPos.x, 1.5, 1e-9), 'x=' + walkPos.x);
walkPos = { x: 1.5, y: 0, z: 1.5 };
walkKeys.clear(); walkKeys.add('b');
walkStep(0.1);
ok('S は後ろ（+Z）へ進む', walkPos.z > 1.5 + 1e-4, 'z=' + walkPos.z);
walkPos = { x: 1.5, y: 0, z: 1.5 };
walkKeys.clear(); walkKeys.add('r');
walkStep(0.1);
ok('D は右（+X）へ進む', walkPos.x > 1.5 + 1e-4, 'x=' + walkPos.x);
walkPos = { x: 1.5, y: 0, z: 1.5 };
walkKeys.clear(); walkKeys.add('l');
walkStep(0.1);
ok('A は左（−X）へ進む', walkPos.x < 1.5 - 1e-4, 'x=' + walkPos.x);
walkPos = { x: 1.5, y: 0, z: 1.5 };
walkYaw = Math.PI / 2;
walkKeys.clear(); walkKeys.add('f');
walkStep(0.1);
ok('右を向いて W は −X へ', walkPos.x < 1.5 - 1e-4 && near(walkPos.z, 1.5, 1e-9));
plan.walls = keepW; plan.objects = keepO;

// **軸ごとに試す。** まとめて止めると壁に沿って滑れない。
walkPos = { x: 1.5, y: 0, z: 0.40 };          // 壁 w3 のすぐ内側
walkYaw = Math.PI / 4;                        // 前は (−0.707, −0.707) ＝ 壁へ向かう
walkKeys.clear(); walkKeys.add('f');
var before = { x: walkPos.x, z: walkPos.z };
walkStep(0.1);
ok('壁に当たる軸は止まる', walkPos.z >= before.z - 1e-9, 'z=' + walkPos.z.toFixed(4));
ok('空いている軸は滑る', walkPos.x < before.x - 1e-4, 'x=' + walkPos.x.toFixed(4));
ok('目の高さは床から WALK_EYE', near(walkCam.position.y, WALK_EYE, 1e-9));

walkYaw = 0; walkPitch = 0.2; walkKeys.clear();
walkStep(0.1);
ok('見上げた角度が入る', near(walkCam.rotation.x, 0.2) && near(walkCam.rotation.y, 0));
walkKeys.clear(); walkCam = null;


// --- 撮れていない隙間を塞ぐ面 -----------------------------------------------
restore(0);
reindex();
var made = [];
THREE = {
  Group: function () {
    this.children = [];
    this.add = function (o) { this.children.push(o); };
    this.traverse = function (f) { f(this); this.children.forEach(f); };
  },
  BufferGeometry: function () {
    this.attrs = {};
    this.setAttribute = function (k, v) { this.attrs[k] = v; };
    this.computeVertexNormals = function () {};
    this.dispose = function () {};
  },
  Float32BufferAttribute: function (a) { this.array = a; },
  MeshLambertMaterial: function (o) { this.o = o; },
  Mesh: function (g, m) { this.geometry = g; this.material = m; made.push({ g: g, m: m }); },
  MeshBasicMaterial: function (o) { this.o = o; },
  LineSegments: function (g, m) { this.geometry = g; this.material = m; },
  LineBasicMaterial: function (o) { this.o = o; },
  Color: function (r, gg, b) { this.r = r; this.g = gg; this.b = b; },
  DataTexture: function (d, w, h) { this.d = d; this.w = w; this.h = h;
                                    this.dispose = function () {}; },
  CanvasTexture: function (c) { this.canvas = c; this.dispose = function () {}; },
  FrontSide: 0, DoubleSide: 2, LinearFilter: 1, ClampToEdgeWrapping: 1,
  RepeatWrapping: 2, RGBFormat: 1
};
// 絵を描く器。中身は使わないので受け取るだけ。
document.createElement = function (tag) {
  var n = new Node(tag);
  if (tag === 'canvas') n.getContext = function () {
    return { fillRect: function () {}, strokeRect: function () {},
             beginPath: function () {}, moveTo: function () {},
             lineTo: function () {}, stroke: function () {} };
  };
  return n;
};
renderer = {}; scene = { add: function () {}, remove: function () {} };
origWalls = plan.walls.map(function (w) {
  var f = frameOf(w.a, w.b); f.id = w.id; f.inSide = 1; return f;
});
// 色の格子は床・天井・壁 4 枚ぶんある状態にする
fillMaps = { floor: { w: 4, h: 4, data: 'AAAA' }, ceiling: { w: 4, h: 4, data: 'AAAA' } };
plan.walls.forEach(function (w) { fillMaps[w.id] = { w: 4, h: 4, data: 'AAAA' }; });
fillTex = new Map(); shellHeight = 2.408; geomExtent = [3.1347, 3.5754];
placeholder = null;
showShell = true; cullBack = true; shell = null;
buildShell();
// スキャン当時の広さ（床・天井）＋編集後の広さ（下敷き）＋壁
ok('床・天井・下敷き・壁ぶんの面ができる', made.length === 4 + plan.walls.length,
   'n=' + made.length);

function tri(m, i) {                      // i 枚目の三角形の 3 頂点
  var a = m.g.attrs.position.array;
  return [[a[i*9], a[i*9+1], a[i*9+2]], [a[i*9+3], a[i*9+4], a[i*9+5]],
          [a[i*9+6], a[i*9+7], a[i*9+8]]];
}
function normal(t) {
  var e1 = [t[1][0]-t[0][0], t[1][1]-t[0][1], t[1][2]-t[0][2]];
  var e2 = [t[2][0]-t[0][0], t[2][1]-t[0][1], t[2][2]-t[0][2]];
  return [e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
}
var pfl = made[0], pce = made[1], flo = made[2], cei = made[3];
ok('下敷きは無機的な絵', pfl.m.o.map && pfl.m.o.map.canvas);
ok('下敷きは色の格子の面より下', tri(pfl,0)[0][1] < tri(flo,0)[0][1],
   tri(pfl,0)[0][1] + ' vs ' + tri(flo,0)[0][1]);
ok('色の格子はスキャン当時の広さに収まる', (function () {
  var t = tri(flo,0).concat(tri(flo,1));
  var xs = t.map(function (p) { return p[0]; });
  return near(Math.min.apply(null, xs), 0)
      && near(Math.max.apply(null, xs), geomExtent[0]);
})());
ok('下敷きは編集後の広さまで届く', (function () {
  var t = tri(pfl,0).concat(tri(pfl,1));
  return Math.max.apply(null, t.map(function (p) { return p[0]; })) > geomExtent[0];
})());
ok('床は上を向く', normal(tri(flo,0))[1] > 0 && normal(tri(flo,1))[1] > 0);
ok('天井は下を向く', normal(tri(cei,0))[1] < 0 && normal(tri(cei,1))[1] < 0);
// スキャンの床は実測で +0.0155m。塞ぐ面はその下でなければ手前に出てしまう。
ok('床はスキャンより下', tri(flo,0)[0][1] < 0, 'y=' + tri(flo,0)[0][1]);
ok('天井はスキャンより上', tri(cei,0)[0][1] > 2.408, 'y=' + tri(cei,0)[0][1]);
// UV は面の向きを直したときも一緒に並べ替わる
ok('床に UV が付く', flo.g.attrs.uv && flo.g.attrs.uv.array.length === 12);
ok('床の UV はちょうど 0〜1', (function () {
  var u = flo.g.attrs.uv.array, mn = 9, mx = -9;
  for (var i = 0; i < u.length; i++) { mn = Math.min(mn, u[i]); mx = Math.max(mx, u[i]); }
  return near(mn, 0) && near(mx, 1);
})(), flo.g.attrs.uv.array.join(','));

// 壁は室内を向き、スキャンした面より外になければならない
var okdir = true, okout = true;
for (var i = 0; i < plan.walls.length; i++) {
  var w = plan.walls[i], f = frameOf(w.a, w.b), m = made[4 + i];
  var n = normal(tri(m, 0));
  // 室内向き（inSide=+1 なので f.n の向き）
  if (n[0] * f.n[0] + n[2] * f.n[1] <= 0) okdir = false;
  // 壁線からの符号つき距離が負＝室外側
  var q = [tri(m,0)[0][0] - f.a[0], tri(m,0)[0][2] - f.a[1]];
  if (q[0] * f.n[0] + q[1] * f.n[1] > -0.05) okout = false;
}
ok('壁は室内を向く', okdir);
ok('壁はスキャンした面より外にある', okout);
ok('壁の UV は端から端へ', (function () {
  var u = made[4].g.attrs.uv.array, us = [], vs = [];
  for (var i = 0; i < u.length; i += 2) { us.push(u[i]); vs.push(u[i+1]); }
  return near(Math.min.apply(null, us), 0) && near(Math.max.apply(null, us), 1)
      && near(Math.min.apply(null, vs), 0) && Math.max.apply(null, vs) > 0.99;
})(), made[4].g.attrs.uv.array.join(','));
ok('UV は頂点と同じ数', made[4].g.attrs.uv.array.length / 2
   === made[4].g.attrs.position.array.length / 3);
ok('壁は床から天井まで', (function () {
  var t0 = tri(made[4], 0), t1 = tri(made[4], 1);
  var ys = t0.concat(t1).map(function (p) { return p[1]; });
  return near(Math.min.apply(null, ys), 0) && Math.max.apply(null, ys) > 2.3;
})());

ok('格子があれば質感を貼る', flo.m.o.map !== null && flo.m.o.map.w === 4);
ok('格子があるぶんだけ白で乗せる', flo.m.o.color.r === 1);
ok('質感は使い回す', fillTex.get('floor') === flo.m.o.map);

// **足した壁には格子が無い。** そこは無機的な絵になる。
// （drawPlan 経由でも作られるので、見るのは shell の中身のほう）
addWall([0.5, 0.5], [2.5, 0.5]);
var kids = shell.children;
var am = kids[kids.length - 1];              // 最後に足した壁
ok('足した壁は無機的な絵', am.material.o.map && am.material.o.map.canvas,
   plan.walls[plan.walls.length - 1].id);
ok('絵は実寸で並べる（0.25m ごと）', (function () {
  var u = am.geometry.attrs.uv.array, mx = 0;
  for (var i = 0; i < u.length; i += 2) mx = Math.max(mx, u[i]);
  return near(mx, 2.0 / PLACEHOLDER_TILE, 1e-3);
})(), am.geometry.attrs.uv.array.join(','));
ok('元からの壁は色の格子のまま', kids[4].material.o.map
   && kids[4].material.o.map.w === 4);
restore(0); reindex();

// **伸ばしたぶんは絵になる。** 色の格子はスキャン当時の長さぶんしか無い。
restore(0); reindex();
// w3（z=0、長さ 3.1347）の端の節点を外へ出して 1m 伸ばす
var ni = graph.nodes.findIndex(function (n) { return near(n.x, 3.1347) && near(n.z, 0); });
onNodeDown(ev(3.1347, 0, null, ni));
onNodeMove(ev(4.1347, 0, null, ni));
onNodeUp();
var w3 = plan.walls.find(function (v) { return v.id === 'w3'; });
ok('w3 が伸びた', frameOf(w3.a, w3.b).L > 4.0, frameOf(w3.a, w3.b).L.toFixed(3));
// w3 の面を位置で拾う。**全頂点が z≈0 にあるもの**だけ——最初の頂点だけで
// 絞ると、角で斜めになった隣の壁まで拾ってしまう。
var segs = shell.children.filter(function (m) {
  var a = m.geometry.attrs.position.array;
  if (a.length !== 18) return false;
  for (var i = 2; i < a.length; i += 3) if (Math.abs(a[i]) > 0.2) return false;
  return true;
});
var withMap = segs.filter(function (m) { return m.material.o.map && m.material.o.map.w; });
var withPh = segs.filter(function (m) { return m.material.o.map && m.material.o.map.canvas; });
ok('元の長さぶんは色の格子', withMap.length >= 1, 'n=' + withMap.length);
ok('伸ばしたぶんは絵', withPh.length >= 1, 'n=' + withPh.length);
ok('色の格子の UV は 0〜1 に収まる', (function () {
  return withMap.every(function (m) {
    var u = m.geometry.attrs.uv.array;
    for (var i = 0; i < u.length; i += 2) if (u[i] < -1e-6 || u[i] > 1 + 1e-6) return false;
    return true;
  });
})());
// 区切りは元の壁の端（3.1347m）に来る
function xrange(m) {
  var a = m.geometry.attrs.position.array, xs = [];
  for (var i = 0; i < a.length; i += 3) xs.push(a[i]);
  return [Math.min.apply(null, xs), Math.max.apply(null, xs)];
}
ok('色の格子は元の長さまで', (function () {
  var r = xrange(withMap[0]);
  return near(r[0], 0, 1e-3) && near(r[1], 3.1347, 1e-3);
})(), JSON.stringify(xrange(withMap[0])));
// 節点は 50mm に丸められるので、伸ばした端は 4.15
ok('絵は元の端から新しい端まで', (function () {
  var r = xrange(withPh[0]);
  return near(r[0], 3.1347, 1e-3) && near(r[1], 4.15, 1e-3);
})(), JSON.stringify(xrange(withPh[0])));
restore(0); reindex();

// --- 部屋の中の壁は裏からも見える -------------------------------------------
restore(0); reindex();
cullBack = true;
origWalls = plan.walls.map(function (w) {
  var f = frameOf(w.a, w.b); f.id = w.id; f.inSide = 1; f.twoSided = false; return f;
});
ok('外周の壁は片面', sideOf('w0') === THREE.FrontSide);
ok('部屋そのものは片面', sideOf(null) === THREE.FrontSide);
origWalls.find(function (o) { return o.id === 'w1'; }).twoSided = true;
ok('間仕切りは両面', sideOf('w1') === THREE.DoubleSide);
ok('足した壁は両面（スキャンに無い）', sideOf('w9') === THREE.DoubleSide);
cullBack = false;
ok('「裏面を透過」を切れば全部両面', sideOf('w0') === THREE.DoubleSide);
cullBack = true;

// 塞ぐ面にも効く
made = []; buildShell();
var w1i = plan.walls.findIndex(function (w) { return w.id === 'w1'; });
ok('間仕切りを塞ぐ面も両面', made[4 + w1i].m.o.side === THREE.DoubleSide);
var w0i = plan.walls.findIndex(function (w) { return w.id === 'w0'; });
ok('外周を塞ぐ面は片面', made[4 + w0i].m.o.side === THREE.FrontSide);
ok('床は片面', made[2].m.o.side === THREE.FrontSide);
origWalls.forEach(function (o) { o.twoSided = false; });

// **実際に部屋の中へ壁を足したとき。** 裏から覗いて消えてはいけない。
fillMaps = { floor: { w: 4, h: 4, data: 'AAAA' }, ceiling: { w: 4, h: 4, data: 'AAAA' } };
plan.walls.forEach(function (w) { fillMaps[w.id] = { w: 4, h: 4, data: 'AAAA' }; });
fillTex = new Map();
addWall([0.6, 0.6], [2.6, 2.6]);             // 部屋の中を斜めに仕切る
var kid = shell.children[shell.children.length - 1];
ok('足した壁は両面で出る', kid.material.o.side === THREE.DoubleSide,
   plan.walls[plan.walls.length - 1].id);
ok('足した壁は無機的な絵のまま',
   kid.material.o.map && kid.material.o.map.canvas);
ok('外周の壁は片面のまま', shell.children[4].material.o.side === THREE.FrontSide);
restore(0); reindex();
fillMaps = {}; fillTex = new Map();

// 格子がまったく無ければ一色で逃がす
made = []; fillMaps = {}; fillTex = new Map(); buildShell();
ok('格子が無ければ一色', made[2].m.o.map === null && near(made[2].m.o.color.r, 0.56));

// 切ると作らない
made = []; showShell = false; buildShell();
ok('切ると面を作らない', made.length === 0);
showShell = true;

// 壁を消したらその面も消える
// （drawPlan 経由でも作られるので、数えるのは shell の中身のほう）
deleteWall('w3');
ok('消した壁は塞がない', shell.children.length === 4 + plan.walls.length,
   shell.children.length + ' / 壁 ' + plan.walls.length);
restore(0);
ok('戻すとまた塞ぐ', shell.children.length === 4 + plan.walls.length,
   shell.children.length + ' / 壁 ' + plan.walls.length);

THREE = undefined; renderer = null; scene = null; shell = null;


// --- 家具の置換 -------------------------------------------------------------
// ここは three.js も描画も要らない（前の節で scene は畳んである）。
// 箱に収める倍率。3 軸とも同じ＝形が崩れない。
var box = { w: 1.27, d: 0.58, h: 0.79 };
ok('軸ごとに倍率を取る', (function () {
  var k = fitInBox([55, 35.8267, 30], box);
  return near(k[0], 1.27 / 55, 1e-9) && near(k[1], 0.79 / 35.8267, 1e-9)
      && near(k[2], 0.58 / 30, 1e-9);
})(), JSON.stringify(fitInBox([55, 35.8267, 30], box)));
ok('合わせた実寸は箱と同じ', (function () {
  var sz = [55, 35.8267, 30], k = fitInBox(sz, box);
  return near(sz[0] * k[0], box.w, 1e-9) && near(sz[1] * k[1], box.h, 1e-9)
      && near(sz[2] * k[2], box.d, 1e-9);
})());
ok('縦横比の違うアセットでも箱と同じ', (function () {
  var sz = [0.1, 10, 0.1], k = fitInBox(sz, box);
  return near(sz[0] * k[0], box.w, 1e-9) && near(sz[1] * k[1], box.h, 1e-9)
      && near(sz[2] * k[2], box.d, 1e-9);
})());
ok('0 で割らない', fitInBox([0, 0, 0], box).every(isFinite));

// **向きは箱の隅と合わなければならない。**
// 平面図の yaw は (x,z) で +x から +z へ測る。three.js の Ry(θ) は +x を
// (cosθ, −sinθ) へ送るので符号が逆になる。
function footprint(o, m) {
  var t = replaceYaw(o, m), out = [];
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (s) {
    var lx = s[0] * o.w / 2, lz = s[1] * o.d / 2;
    out.push([lx * Math.cos(t) + lz * Math.sin(t), -lx * Math.sin(t) + lz * Math.cos(t)]);
  });
  return out;
}
function planCorners(o) {                 // webgeom が box.pts を出すのと同じ式
  var th = o.yaw * Math.PI / 180;
  var u = [Math.cos(th), Math.sin(th)], v = [-Math.sin(th), Math.cos(th)], out = [];
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (s) {
    out.push([u[0] * s[0] * o.w / 2 + v[0] * s[1] * o.d / 2,
              u[1] * s[0] * o.w / 2 + v[1] * s[1] * o.d / 2]);
  });
  return out;
}
var ob = { w: 0.663, d: 0.721, h: 1.328, yaw: 153.07 };
ok('向きが箱の隅と合う', (function () {
  var a = footprint(ob, {}), b = planCorners(ob), e = 0;
  for (var i = 0; i < 4; i++)
    e = Math.max(e, Math.abs(a[i][0] - b[i][0]), Math.abs(a[i][1] - b[i][1]));
  return e < 1e-9;
})(), JSON.stringify([footprint(ob, {})[0], planCorners(ob)[0]]));
ok('yaw の符号が逆だと合わない', (function () {
  var t = ob.yaw * Math.PI / 180;         // わざと反転しない
  var lx = -ob.w / 2, lz = -ob.d / 2;
  var x = lx * Math.cos(t) + lz * Math.sin(t);
  return Math.abs(x - planCorners(ob)[0][0]) > 0.1;
})());
ok('人の回転はスキャンと同じ向き',
   near(replaceYaw({ yaw: 0 }, { dyaw: 90 }), Math.PI / 2, 1e-9));
ok('yaw と dyaw が足し合わさる',
   near(replaceYaw({ yaw: 30 }, { dyaw: 30 }), 0, 1e-9));

// 操作列。家具を選んでいるときだけ使える。
assetList = [{ key: 'table', label: 'table', faces: 928, size: [55, 36, 30] },
             { key: 'chair', label: 'chair', faces: 2500, size: [1, 1, 1] }];
replaceMap = {};
sel = null;
syncReplaceUI();
ok('選んでいなければ使えない',
   els['replaceWith'].disabled === true && els['replaceDo'].disabled === true);
sel = plan.objects[0].id;
syncReplaceUI();
ok('家具を選べば使える', els['replaceWith'].disabled === false);
ok('一覧が入る（置換なし＋2 件）', els['replaceWith'].kids.length === 3,
   'n=' + els['replaceWith'].kids.length);
ok('ボタンは「置換」', els['replaceDo'].textContent === '置換');
replaceMap[sel] = 'table';
syncReplaceUI();
ok('置換済みなら「戻す」', els['replaceDo'].textContent === '戻す');
ok('選択中のアセットが出る', els['replaceWith'].value === 'table');
sel = null; replaceMap = {}; assetList = [];
syncReplaceUI();

// **置換は人の操作でしか起きない。** 置換した家具は平面図でも分かる。
replaceMap = {};
drawPlan();
var objN = objNodes.get(plan.objects[0].id);
ok('置換していなければ印は付かない',
   (objN.attrs['class'] || '').indexOf('swap') < 0, objN.attrs['class']);
replaceMap[plan.objects[0].id] = 'table';
drawPlan();
objN = objNodes.get(plan.objects[0].id);
ok('置換した家具には印が付く',
   (objN.attrs['class'] || '').indexOf('swap') >= 0, objN.attrs['class']);
ok('寸法のかわりにアセット名が出る', (function () {
  var lab = null;
  (function walk(n) {
    if ((n.attrs['class'] || '') === 'size') lab = n;
    n.kids.forEach(walk);
  })(objN);
  return lab && lab.textContent.indexOf('table') >= 0;
})());
// 戻せば印も消える
replaceMap = {};
drawPlan();
ok('戻せば印は消える',
   (objNodes.get(plan.objects[0].id).attrs['class'] || '').indexOf('swap') < 0);


// --- コメント ---------------------------------------------------------------
comments = [];
walking = false; commenting = false; cmtPending = null;
setCommenting(true);
ok('歩いていなければコメントモードに入らない', commenting === false);
walking = true;
setCommenting(true);
ok('歩いていれば入れる', commenting === true);
ok('十字の見た目が変わる', els['walkhud'].classList.contains('commenting') === true);
ok('案内が切り替わる', els['walktip'].textContent.indexOf('クリック') >= 0,
   els['walktip'].textContent);
setCommenting(false);
ok('戻すと案内も戻る', els['walktip'].textContent.indexOf('W A S D') >= 0);
ok('十字も戻る', els['walkhud'].classList.contains('commenting') === false);

// 入力の受け渡し。**ポインタの固定を外さないと文字が打てない。**
var unlocked = 0, relocked = 0;
document.exitPointerLock = function () { unlocked++; document.pointerLockElement = null; };
els['gl'].requestPointerLock = function () { relocked++; document.pointerLockElement = els['gl']; };
document.pointerLockElement = els['gl'];
walking = true;
askComment([1, 2, 3]);
ok('場所を覚える', JSON.stringify(cmtPending) === '[1,2,3]');
ok('入力欄が出る', els['cmtbox'].hidden === false);
ok('ポインタの固定を外す', unlocked === 1);
ok('外れている間は固定されていない', locked() === false);
// **書き終えたら即座に奪い返す。**
closeComment();
ok('やめれば場所を忘れる', cmtPending === null);
ok('入力欄は隠れる', els['cmtbox'].hidden === true);
ok('すぐ固定を取り戻す', relocked >= 1 && locked() === true, 'relocked=' + relocked);
// 歩いていなければ取り戻さない
walking = false;
relocked = 0;
closeComment();
ok('歩いていなければ取り戻さない', relocked === 0);
walking = false; document.pointerLockElement = null;

// 平面図に出る
comments = [{ id: 'a', p: [1.0, 1.2, 2.0], text: 'あ', at: '' },
            { id: 'b', p: [2.0, 0.5, 0.5], text: 'い', at: '' }];
drawPlan();
var marks = 0;
(function count(n) {
  if ((n.attrs['class'] || '') === 'cmt') marks++;
  n.kids.forEach(count);
})(els['plan']);
ok('平面図に件数ぶん出る', marks === 2, 'n=' + marks);
comments = [];
drawPlan();
marks = 0;
(function count(n) {
  if ((n.attrs['class'] || '') === 'cmt') marks++;
  n.kids.forEach(count);
})(els['plan']);
ok('無ければ出ない', marks === 0);

// --- 近づくと吹き出しが出る -------------------------------------------------
THREE = {
  Vector3: function () {
    this.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
    this.project = function () { this.x = 0; this.y = 0; this.z = 0.5; return this; };
  }
};
_cmtV = null;
walkCam = {};
walkPos = { x: 0, y: 0, z: 0 };
comments = [{ id: 'a', p: [0, WALK_EYE, 1.0], text: '近い', at: '' },
            { id: 'b', p: [0, WALK_EYE, 9.0], text: '遠い', at: '' }];
cmtPops = [];
updateCmtPops();
ok('件数ぶんの枠を作る', cmtPops.length === 2, 'n=' + cmtPops.length);
ok('近いものは出る', cmtPops[0].hidden === false && cmtPops[0].textContent === '近い');
ok('遠いものは出ない（点だけに戻す）', cmtPops[1].hidden === true);
ok('距離の境目は CMT_POP_DIST', CMT_POP_DIST > 1.0 && CMT_POP_DIST < 9.0);
ok('画面の位置が入る', cmtPops[0].style.left === '400px', cmtPops[0].style.left);

// 後ろにあるものは出さない（投影は背後でも値を返す）
THREE.Vector3 = function () {
  this.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  this.project = function () { this.x = 0; this.y = 0; this.z = 1.4; return this; };
};
_cmtV = null;
updateCmtPops();
ok('後ろのものは出さない', cmtPops[0].hidden === true);

// 件数が減れば枠も減らす
comments = [comments[0]];
updateCmtPops();
ok('件数が減れば枠も減る', cmtPops.length === 1, 'n=' + cmtPops.length);

hideCmtPops();
ok('まとめて消せる', cmtPops.every(function (d) { return d.hidden; }));
comments = []; cmtPops = []; walkCam = null; THREE = undefined; _cmtV = null;
drawPlan();

print(fails ? ('\n' + fails + ' FAIL') : '\nALL PASS');
