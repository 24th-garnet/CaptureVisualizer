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
onWallMove(ev(0, 0.5, 'w3'));       // w3 の法線（z）へ 0.5
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

print(fails ? ('\n' + fails + ' FAIL') : '\nALL PASS');
