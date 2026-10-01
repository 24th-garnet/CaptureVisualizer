// 平面図の編集を DOM 無しで確かめる。pytest（test_planedit.py）から jsc で走る。
// ブラウザが無い環境でも、壁を動かしたときの開口の挙動を押さえておきたい。
function Node(tag) {
  this.tag = tag; this.attrs = {}; this.kids = []; this._text = ''; this.dataset = {};
  this.classList = { toggle: function(){}, add: function(){}, contains: function(){return false;} };
}
Node.prototype.setAttribute = function(k, v) { this.attrs[k] = v; };
Node.prototype.getAttribute = function(k) { return this.attrs[k]; };
Node.prototype.appendChild = function(n) { this.kids.push(n); return n; };
Node.prototype.addEventListener = function(){};
Node.prototype.querySelector = function(){ return null; };
Node.prototype.querySelectorAll = function(){ return []; };
var captured = null;
Node.prototype.setPointerCapture = function(){ captured = this; };
Node.prototype.releasePointerCapture = function(){ captured = null; };
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
// three.js は読めないので、光線だけ差し替えて当たり判定の筋を確かめる。
restore(0);
reindex();
var rayHits = function () { return []; };
var lastRay = null;
THREE = {
  Raycaster: function () {
    this.far = 0;
    this.set = function (o, d) { this.o = o; this.d = d; lastRay = this; };
    this.intersectObjects = function () { return rayHits(this.o, this.d, this.far); };
  },
  Vector3: function (x, y, z) { this.x = x; this.y = y; this.z = z; }
};
_walkRay = null;
allParts = [{ mesh: { visible: true } }];
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
var inObj = (plan.objects || []).some(function (o) {
  return Math.abs(sp.x - o.c[0]) < o.w / 2 && Math.abs(sp.z - o.c[1]) < o.d / 2;
});
ok('立ち位置は家具の中でない', !inObj, JSON.stringify([sp.x.toFixed(2), sp.z.toFixed(2)]));

// 床。**当たらなければ Y=0。** 撮れていない床（この部屋で 32%）で落ちないため。
walkPos = { x: 1, y: 0, z: 1 };
rayHits = function () { return []; };
ok('床に当たらなければ Y=0', walkGround(1, 1) === 0);
rayHits = function () { return [{ point: { y: 0.15 } }]; };
ok('当たればその高さ', near(walkGround(1, 1), 0.15));
rayHits = function () { return [{ point: { y: 0.9 } }]; };
ok('登れない高さは床にしない', walkGround(1, 1) === 0, String(walkGround(1, 1)));
rayHits = function () { return [{ point: { y: 0.1 } }, { point: { y: 0.3 } }]; };
ok('届く中で一番高いところに立つ', near(walkGround(1, 1), 0.3));

// 前方の当たり
rayHits = function () { return []; };
ok('何も無ければ進める', walkBlocked(1, 1, 0.1, 0) === false);
rayHits = function () { return [{ distance: 0.2 }]; };
ok('近くに面があれば止まる', walkBlocked(1, 1, 0.1, 0) === true);
rayHits = function () { return [{ distance: 1.0 }]; };
ok('遠い面では止まらない', walkBlocked(1, 1, 0.1, 0) === false);
ok('体の半径ぶん手前で止まる', (function () {
  rayHits = function () { return [{ distance: 0.1 + WALK_RADIUS - 0.01 }]; };
  return walkBlocked(1, 1, 0.1, 0) === true;
})());

// **向き。** three.js のカメラは局所の −Z を向くので、ヨー 0 の前は −Z。
// ここを取り違えると前後が入れ替わる（実際に入れ替わっていた）。
rayHits = function () { return []; };
walkPos = { x: 1, y: 0, z: 1 };
walkYaw = 0; walkPitch = 0;
walkKeys.clear(); walkKeys.add('f');
walkStep(0.1);
ok('W は前（−Z）へ進む', walkPos.z < 1 - 1e-4, 'z=' + walkPos.z);
ok('W で横には流れない', near(walkPos.x, 1, 1e-9), 'x=' + walkPos.x);
walkPos = { x: 1, y: 0, z: 1 };
walkKeys.clear(); walkKeys.add('b');
walkStep(0.1);
ok('S は後ろ（+Z）へ進む', walkPos.z > 1 + 1e-4, 'z=' + walkPos.z);
walkPos = { x: 1, y: 0, z: 1 };
walkKeys.clear(); walkKeys.add('r');
walkStep(0.1);
ok('D は右（+X）へ進む', walkPos.x > 1 + 1e-4, 'x=' + walkPos.x);
walkPos = { x: 1, y: 0, z: 1 };
walkKeys.clear(); walkKeys.add('l');
walkStep(0.1);
ok('A は左（−X）へ進む', walkPos.x < 1 - 1e-4, 'x=' + walkPos.x);
walkPos = { x: 1, y: 0, z: 1 };
walkYaw = Math.PI / 2;                       // 右を向く＝前は −X
walkKeys.clear(); walkKeys.add('f');
walkStep(0.1);
ok('右を向いて W は −X へ', walkPos.x < 1 - 1e-4 && near(walkPos.z, 1, 1e-9),
   walkPos.x.toFixed(3) + ' / ' + walkPos.z.toFixed(3));

// **軸ごとに試す。** まとめて止めると壁に沿って滑れない。
walkPos = { x: 1, y: 0, z: 1 };
walkYaw = Math.PI / 4;                       // 前は (−0.707, −0.707)
walkKeys.clear(); walkKeys.add('f');
rayHits = function (o, d) {
  return Math.abs(d.x) > 1e-6 ? [{ distance: 0.01 }] : [];   // x 方向にだけ壁
};
var before = { x: walkPos.x, z: walkPos.z };
walkStep(0.1);
ok('塞がれた軸は進まない', near(walkPos.x, before.x, 1e-9), 'x=' + walkPos.x);
ok('空いている軸は進む', walkPos.z < before.z - 1e-4, 'z=' + walkPos.z);
ok('目の高さは床から WALK_EYE', near(walkCam.position.y, WALK_EYE, 1e-9));

// 向きの反映
walkYaw = 0; walkPitch = 0.2;
walkKeys.clear();
walkStep(0.1);
ok('見上げた角度が入る', near(walkCam.rotation.x, 0.2) && near(walkCam.rotation.y, 0));

walkKeys.clear();
allParts = []; walkCam = null; THREE = undefined; _walkRay = null;

print(fails ? ('\n' + fails + ' FAIL') : '\nALL PASS');
