var jr = Object.defineProperty;
var Qr = (e, t, r) => t in e ? jr(e, t, { enumerable: !0, configurable: !0, writable: !0, value: r }) : e[t] = r;
var w = (e, t, r) => Qr(e, typeof t != "symbol" ? t + "" : t, r);
const Ur = "5";
var Xt;
typeof window < "u" && ((Xt = window.__svelte ?? (window.__svelte = {})).v ?? (Xt.v = /* @__PURE__ */ new Set())).add(Ur);
const Wr = 1, Gr = 2, Vr = 16, Kr = 2, C = Symbol(), qt = !1;
var pt = Array.isArray, Xr = Array.prototype.indexOf, dt = Array.from, Yr = Object.defineProperty, Se = Object.getOwnPropertyDescriptor, Jr = Object.prototype, en = Array.prototype, tn = Object.getPrototypeOf, Mt = Object.isExtensible;
function rn(e) {
  for (var t = 0; t < e.length; t++)
    e[t]();
}
const Z = 2, Yt = 4, We = 8, gt = 16, ee = 32, ge = 64, qe = 128, B = 256, Me = 512, I = 1024, U = 2048, ce = 4096, J = 8192, Ge = 16384, nn = 32768, vt = 65536, sn = 1 << 19, Jt = 1 << 20, it = 1 << 21, ze = Symbol("$state");
function er(e) {
  return e === this.v;
}
function ln(e, t) {
  return e != e ? t == t : e !== t || e !== null && typeof e == "object" || typeof e == "function";
}
function tr(e) {
  return !ln(e, this.v);
}
function an(e) {
  throw new Error("https://svelte.dev/e/effect_in_teardown");
}
function on() {
  throw new Error("https://svelte.dev/e/effect_in_unowned_derived");
}
function un(e) {
  throw new Error("https://svelte.dev/e/effect_orphan");
}
function cn() {
  throw new Error("https://svelte.dev/e/effect_update_depth_exceeded");
}
function fn() {
  throw new Error("https://svelte.dev/e/state_descriptors_fixed");
}
function hn() {
  throw new Error("https://svelte.dev/e/state_prototype_fixed");
}
function pn() {
  throw new Error("https://svelte.dev/e/state_unsafe_mutation");
}
let dn = !1;
function gn(e) {
  throw new Error("https://svelte.dev/e/lifecycle_outside_component");
}
let P = null;
function Bt(e) {
  P = e;
}
function rr(e, t = !1, r) {
  var n = P = {
    p: P,
    c: null,
    d: !1,
    e: null,
    m: !1,
    s: e,
    x: null,
    l: null
  };
  dr(() => {
    n.d = !0;
  });
}
function nr(e) {
  const t = P;
  if (t !== null) {
    const u = t.e;
    if (u !== null) {
      var r = m, n = b;
      t.e = null;
      try {
        for (var s = 0; s < u.length; s++) {
          var l = u[s];
          ie(l.effect), W(l.reaction), _t(l.fn);
        }
      } finally {
        ie(r), W(n);
      }
    }
    P = t.p, t.m = !0;
  }
  return (
    /** @type {T} */
    {}
  );
}
function sr() {
  return !0;
}
function ae(e) {
  if (typeof e != "object" || e === null || ze in e)
    return e;
  const t = tn(e);
  if (t !== Jr && t !== en)
    return e;
  var r = /* @__PURE__ */ new Map(), n = pt(e), s = /* @__PURE__ */ D(0), l = b, u = (i) => {
    var a = b;
    W(l);
    var o = i();
    return W(a), o;
  };
  return n && r.set("length", /* @__PURE__ */ D(
    /** @type {any[]} */
    e.length
  )), new Proxy(
    /** @type {any} */
    e,
    {
      defineProperty(i, a, o) {
        (!("value" in o) || o.configurable === !1 || o.enumerable === !1 || o.writable === !1) && fn();
        var c = r.get(a);
        return c === void 0 ? (c = u(() => /* @__PURE__ */ D(o.value)), r.set(a, c)) : E(
          c,
          u(() => ae(o.value))
        ), !0;
      },
      deleteProperty(i, a) {
        var o = r.get(a);
        if (o === void 0)
          a in i && (r.set(
            a,
            u(() => /* @__PURE__ */ D(C))
          ), rt(s));
        else {
          if (n && typeof a == "string") {
            var c = (
              /** @type {Source<number>} */
              r.get("length")
            ), h = Number(a);
            Number.isInteger(h) && h < c.v && E(c, h);
          }
          E(o, C), rt(s);
        }
        return !0;
      },
      get(i, a, o) {
        var p;
        if (a === ze)
          return e;
        var c = r.get(a), h = a in i;
        if (c === void 0 && (!h || (p = Se(i, a)) != null && p.writable) && (c = u(() => /* @__PURE__ */ D(ae(h ? i[a] : C))), r.set(a, c)), c !== void 0) {
          var f = y(c);
          return f === C ? void 0 : f;
        }
        return Reflect.get(i, a, o);
      },
      getOwnPropertyDescriptor(i, a) {
        var o = Reflect.getOwnPropertyDescriptor(i, a);
        if (o && "value" in o) {
          var c = r.get(a);
          c && (o.value = y(c));
        } else if (o === void 0) {
          var h = r.get(a), f = h == null ? void 0 : h.v;
          if (h !== void 0 && f !== C)
            return {
              enumerable: !0,
              configurable: !0,
              value: f,
              writable: !0
            };
        }
        return o;
      },
      has(i, a) {
        var f;
        if (a === ze)
          return !0;
        var o = r.get(a), c = o !== void 0 && o.v !== C || Reflect.has(i, a);
        if (o !== void 0 || m !== null && (!c || (f = Se(i, a)) != null && f.writable)) {
          o === void 0 && (o = u(() => /* @__PURE__ */ D(c ? ae(i[a]) : C)), r.set(a, o));
          var h = y(o);
          if (h === C)
            return !1;
        }
        return c;
      },
      set(i, a, o, c) {
        var S;
        var h = r.get(a), f = a in i;
        if (n && a === "length")
          for (var p = o; p < /** @type {Source<number>} */
          h.v; p += 1) {
            var d = r.get(p + "");
            d !== void 0 ? E(d, C) : p in i && (d = u(() => /* @__PURE__ */ D(C)), r.set(p + "", d));
          }
        h === void 0 ? (!f || (S = Se(i, a)) != null && S.writable) && (h = u(() => /* @__PURE__ */ D(void 0)), E(
          h,
          u(() => ae(o))
        ), r.set(a, h)) : (f = h.v !== C, E(
          h,
          u(() => ae(o))
        ));
        var g = Reflect.getOwnPropertyDescriptor(i, a);
        if (g != null && g.set && g.set.call(c, o), !f) {
          if (n && typeof a == "string") {
            var $ = (
              /** @type {Source<number>} */
              r.get("length")
            ), v = Number(a);
            Number.isInteger(v) && v >= $.v && E($, v + 1);
          }
          rt(s);
        }
        return !0;
      },
      ownKeys(i) {
        y(s);
        var a = Reflect.ownKeys(i).filter((h) => {
          var f = r.get(h);
          return f === void 0 || f.v !== C;
        });
        for (var [o, c] of r)
          c.v !== C && !(o in i) && a.push(o);
        return a;
      },
      setPrototypeOf() {
        hn();
      }
    }
  );
}
function rt(e, t = 1) {
  E(e, e.v + t);
}
// @__NO_SIDE_EFFECTS__
function lr(e) {
  var t = Z | U, r = b !== null && (b.f & Z) !== 0 ? (
    /** @type {Derived} */
    b
  ) : null;
  return m === null || r !== null && (r.f & B) !== 0 ? t |= B : m.f |= Jt, {
    ctx: P,
    deps: null,
    effects: null,
    equals: er,
    f: t,
    fn: e,
    reactions: null,
    rv: 0,
    v: (
      /** @type {V} */
      null
    ),
    wv: 0,
    parent: r ?? m
  };
}
// @__NO_SIDE_EFFECTS__
function vn(e) {
  const t = /* @__PURE__ */ lr(e);
  return t.equals = tr, t;
}
function ir(e) {
  var t = e.effects;
  if (t !== null) {
    e.effects = null;
    for (var r = 0; r < t.length; r += 1)
      le(
        /** @type {Effect} */
        t[r]
      );
  }
}
function kn(e) {
  for (var t = e.parent; t !== null; ) {
    if ((t.f & Z) === 0)
      return (
        /** @type {Effect} */
        t
      );
    t = t.parent;
  }
  return null;
}
function ar(e) {
  var t, r = m;
  ie(kn(e));
  try {
    ir(e), t = Er(e);
  } finally {
    ie(r);
  }
  return t;
}
function or(e) {
  var t = ar(e);
  if (e.equals(t) || (e.v = t, e.wv = Tr()), !ke) {
    var r = (se || (e.f & B) !== 0) && e.deps !== null ? ce : I;
    F(e, r);
  }
}
const $e = /* @__PURE__ */ new Map();
function Be(e, t) {
  var r = {
    f: 0,
    // TODO ideally we could skip this altogether, but it causes type errors
    v: e,
    reactions: null,
    equals: er,
    rv: 0,
    wv: 0
  };
  return r;
}
// @__NO_SIDE_EFFECTS__
function D(e, t) {
  const r = Be(e);
  return Rn(r), r;
}
// @__NO_SIDE_EFFECTS__
function _n(e, t = !1) {
  const r = Be(e);
  return t || (r.equals = tr), r;
}
function E(e, t, r = !1) {
  b !== null && !Q && sr() && (b.f & (Z | gt)) !== 0 && !(z != null && z.includes(e)) && pn();
  let n = r ? ae(t) : t;
  return ur(e, n);
}
function ur(e, t) {
  if (!e.equals(t)) {
    var r = e.v;
    ke ? $e.set(e, t) : $e.set(e, r), e.v = t, (e.f & Z) !== 0 && ((e.f & U) !== 0 && ar(
      /** @type {Derived} */
      e
    ), F(e, (e.f & B) === 0 ? I : ce)), e.wv = Tr(), cr(e, U), m !== null && (m.f & I) !== 0 && (m.f & (ee | ge)) === 0 && (N === null ? An([e]) : N.push(e));
  }
  return t;
}
function cr(e, t) {
  var r = e.reactions;
  if (r !== null)
    for (var n = r.length, s = 0; s < n; s++) {
      var l = r[s], u = l.f;
      (u & U) === 0 && (F(l, t), (u & (I | B)) !== 0 && ((u & Z) !== 0 ? cr(
        /** @type {Derived} */
        l,
        ce
      ) : Ke(
        /** @type {Effect} */
        l
      )));
    }
}
let xn = !1;
var Nt, fr, hr, pr;
function wn() {
  if (Nt === void 0) {
    Nt = window, fr = /Firefox/.test(navigator.userAgent);
    var e = Element.prototype, t = Node.prototype, r = Text.prototype;
    hr = Se(t, "firstChild").get, pr = Se(t, "nextSibling").get, Mt(e) && (e.__click = void 0, e.__className = void 0, e.__attributes = null, e.__style = void 0, e.__e = void 0), Mt(r) && (r.__t = void 0);
  }
}
function bn(e = "") {
  return document.createTextNode(e);
}
// @__NO_SIDE_EFFECTS__
function ne(e) {
  return hr.call(e);
}
// @__NO_SIDE_EFFECTS__
function kt(e) {
  return pr.call(e);
}
function H(e, t) {
  return /* @__PURE__ */ ne(e);
}
function pe(e, t = 1, r = !1) {
  let n = e;
  for (; t--; )
    n = /** @type {TemplateNode} */
    /* @__PURE__ */ kt(n);
  return n;
}
function mn(e) {
  e.textContent = "";
}
function yn(e) {
  m === null && b === null && un(), b !== null && (b.f & B) !== 0 && m === null && on(), ke && an();
}
function Sn(e, t) {
  var r = t.last;
  r === null ? t.last = t.first = e : (r.next = e, e.prev = r, t.last = e);
}
function ve(e, t, r, n = !0) {
  var s = m, l = {
    ctx: P,
    deps: null,
    nodes_start: null,
    nodes_end: null,
    f: e | U,
    first: null,
    fn: t,
    last: null,
    next: null,
    parent: s,
    prev: null,
    teardown: null,
    transitions: null,
    wv: 0
  };
  if (r)
    try {
      bt(l), l.f |= nn;
    } catch (a) {
      throw le(l), a;
    }
  else t !== null && Ke(l);
  var u = r && l.deps === null && l.first === null && l.nodes_start === null && l.teardown === null && (l.f & (Jt | qe)) === 0;
  if (!u && n && (s !== null && Sn(l, s), b !== null && (b.f & Z) !== 0)) {
    var i = (
      /** @type {Derived} */
      b
    );
    (i.effects ?? (i.effects = [])).push(l);
  }
  return l;
}
function dr(e) {
  const t = ve(We, null, !1);
  return F(t, I), t.teardown = e, t;
}
function gr(e) {
  yn();
  var t = m !== null && (m.f & ee) !== 0 && P !== null && !P.m;
  if (t) {
    var r = (
      /** @type {ComponentContext} */
      P
    );
    (r.e ?? (r.e = [])).push({
      fn: e,
      effect: m,
      reaction: b
    });
  } else {
    var n = _t(e);
    return n;
  }
}
function Tn(e) {
  const t = ve(ge, e, !0);
  return (r = {}) => new Promise((n) => {
    r.outro ? Ne(t, () => {
      le(t), n(void 0);
    }) : (le(t), n(void 0));
  });
}
function _t(e) {
  return ve(Yt, e, !1);
}
function vr(e) {
  return ve(We, e, !0);
}
function at(e, t = [], r = lr) {
  const n = t.map(r);
  return xt(() => e(...n.map(y)));
}
function xt(e, t = 0) {
  return ve(We | gt | t, e, !0);
}
function Ee(e, t = !0) {
  return ve(We | ee, e, !0, t);
}
function kr(e) {
  var t = e.teardown;
  if (t !== null) {
    const r = ke, n = b;
    Dt(!0), W(null);
    try {
      t.call(null);
    } finally {
      Dt(r), W(n);
    }
  }
}
function _r(e, t = !1) {
  var r = e.first;
  for (e.first = e.last = null; r !== null; ) {
    var n = r.next;
    (r.f & ge) !== 0 ? r.parent = null : le(r, t), r = n;
  }
}
function $n(e) {
  for (var t = e.first; t !== null; ) {
    var r = t.next;
    (t.f & ee) === 0 && le(t), t = r;
  }
}
function le(e, t = !0) {
  var r = !1;
  (t || (e.f & sn) !== 0) && e.nodes_start !== null && (xr(
    e.nodes_start,
    /** @type {TemplateNode} */
    e.nodes_end
  ), r = !0), _r(e, t && !r), He(e, 0), F(e, Ge);
  var n = e.transitions;
  if (n !== null)
    for (const l of n)
      l.stop();
  kr(e);
  var s = e.parent;
  s !== null && s.first !== null && wr(e), e.next = e.prev = e.teardown = e.ctx = e.deps = e.fn = e.nodes_start = e.nodes_end = null;
}
function xr(e, t) {
  for (; e !== null; ) {
    var r = e === t ? null : (
      /** @type {TemplateNode} */
      /* @__PURE__ */ kt(e)
    );
    e.remove(), e = r;
  }
}
function wr(e) {
  var t = e.parent, r = e.prev, n = e.next;
  r !== null && (r.next = n), n !== null && (n.prev = r), t !== null && (t.first === e && (t.first = n), t.last === e && (t.last = r));
}
function Ne(e, t) {
  var r = [];
  wt(e, r, !0), br(r, () => {
    le(e), t && t();
  });
}
function br(e, t) {
  var r = e.length;
  if (r > 0) {
    var n = () => --r || t();
    for (var s of e)
      s.out(n);
  } else
    t();
}
function wt(e, t, r) {
  if ((e.f & J) === 0) {
    if (e.f ^= J, e.transitions !== null)
      for (const u of e.transitions)
        (u.is_global || r) && t.push(u);
    for (var n = e.first; n !== null; ) {
      var s = n.next, l = (n.f & vt) !== 0 || (n.f & ee) !== 0;
      wt(n, t, l ? r : !1), n = s;
    }
  }
}
function De(e) {
  mr(e, !0);
}
function mr(e, t) {
  if ((e.f & J) !== 0) {
    e.f ^= J, (e.f & I) === 0 && (e.f ^= I), Re(e) && (F(e, U), Ke(e));
    for (var r = e.first; r !== null; ) {
      var n = r.next, s = (r.f & vt) !== 0 || (r.f & ee) !== 0;
      mr(r, s ? t : !1), r = n;
    }
    if (e.transitions !== null)
      for (const l of e.transitions)
        (l.is_global || t) && l.in();
  }
}
let Oe = [];
function En() {
  var e = Oe;
  Oe = [], rn(e);
}
function yr(e) {
  Oe.length === 0 && queueMicrotask(En), Oe.push(e);
}
let Ce = !1, ot = !1, Ze = null, oe = !1, ke = !1;
function Dt(e) {
  ke = e;
}
let Pe = [];
let b = null, Q = !1;
function W(e) {
  b = e;
}
let m = null;
function ie(e) {
  m = e;
}
let z = null;
function Rn(e) {
  b !== null && b.f & it && (z === null ? z = [e] : z.push(e));
}
let A = null, M = 0, N = null;
function An(e) {
  N = e;
}
let Sr = 1, Fe = 0, se = !1;
function Tr() {
  return ++Sr;
}
function Re(e) {
  var h;
  var t = e.f;
  if ((t & U) !== 0)
    return !0;
  if ((t & ce) !== 0) {
    var r = e.deps, n = (t & B) !== 0;
    if (r !== null) {
      var s, l, u = (t & Me) !== 0, i = n && m !== null && !se, a = r.length;
      if (u || i) {
        var o = (
          /** @type {Derived} */
          e
        ), c = o.parent;
        for (s = 0; s < a; s++)
          l = r[s], (u || !((h = l == null ? void 0 : l.reactions) != null && h.includes(o))) && (l.reactions ?? (l.reactions = [])).push(o);
        u && (o.f ^= Me), i && c !== null && (c.f & B) === 0 && (o.f ^= B);
      }
      for (s = 0; s < a; s++)
        if (l = r[s], Re(
          /** @type {Derived} */
          l
        ) && or(
          /** @type {Derived} */
          l
        ), l.wv > e.wv)
          return !0;
    }
    (!n || m !== null && !se) && F(e, I);
  }
  return !1;
}
function Ln(e, t) {
  for (var r = t; r !== null; ) {
    if ((r.f & qe) !== 0)
      try {
        r.fn(e);
        return;
      } catch {
        r.f ^= qe;
      }
    r = r.parent;
  }
  throw Ce = !1, e;
}
function Ot(e) {
  return (e.f & Ge) === 0 && (e.parent === null || (e.parent.f & qe) === 0);
}
function Ve(e, t, r, n) {
  if (Ce) {
    if (r === null && (Ce = !1), Ot(t))
      throw e;
    return;
  }
  if (r !== null && (Ce = !0), Ln(e, t), Ot(t))
    throw e;
}
function $r(e, t, r = !0) {
  var n = e.reactions;
  if (n !== null)
    for (var s = 0; s < n.length; s++) {
      var l = n[s];
      z != null && z.includes(e) || ((l.f & Z) !== 0 ? $r(
        /** @type {Derived} */
        l,
        t,
        !1
      ) : t === l && (r ? F(l, U) : (l.f & I) !== 0 && F(l, ce), Ke(
        /** @type {Effect} */
        l
      )));
    }
}
function Er(e) {
  var p;
  var t = A, r = M, n = N, s = b, l = se, u = z, i = P, a = Q, o = e.f;
  A = /** @type {null | Value[]} */
  null, M = 0, N = null, se = (o & B) !== 0 && (Q || !oe || b === null), b = (o & (ee | ge)) === 0 ? e : null, z = null, Bt(e.ctx), Q = !1, Fe++, e.f |= it;
  try {
    var c = (
      /** @type {Function} */
      (0, e.fn)()
    ), h = e.deps;
    if (A !== null) {
      var f;
      if (He(e, M), h !== null && M > 0)
        for (h.length = M + A.length, f = 0; f < A.length; f++)
          h[M + f] = A[f];
      else
        e.deps = h = A;
      if (!se)
        for (f = M; f < h.length; f++)
          ((p = h[f]).reactions ?? (p.reactions = [])).push(e);
    } else h !== null && M < h.length && (He(e, M), h.length = M);
    if (sr() && N !== null && !Q && h !== null && (e.f & (Z | ce | U)) === 0)
      for (f = 0; f < /** @type {Source[]} */
      N.length; f++)
        $r(
          N[f],
          /** @type {Effect} */
          e
        );
    return s !== null && s !== e && (Fe++, N !== null && (n === null ? n = N : n.push(.../** @type {Source[]} */
    N))), c;
  } finally {
    A = t, M = r, N = n, b = s, se = l, z = u, Bt(i), Q = a, e.f ^= it;
  }
}
function zn(e, t) {
  let r = t.reactions;
  if (r !== null) {
    var n = Xr.call(r, e);
    if (n !== -1) {
      var s = r.length - 1;
      s === 0 ? r = t.reactions = null : (r[n] = r[s], r.pop());
    }
  }
  r === null && (t.f & Z) !== 0 && // Destroying a child effect while updating a parent effect can cause a dependency to appear
  // to be unused, when in fact it is used by the currently-updating parent. Checking `new_deps`
  // allows us to skip the expensive work of disconnecting and immediately reconnecting it
  (A === null || !A.includes(t)) && (F(t, ce), (t.f & (B | Me)) === 0 && (t.f ^= Me), ir(
    /** @type {Derived} **/
    t
  ), He(
    /** @type {Derived} **/
    t,
    0
  ));
}
function He(e, t) {
  var r = e.deps;
  if (r !== null)
    for (var n = t; n < r.length; n++)
      zn(e, r[n]);
}
function bt(e) {
  var t = e.f;
  if ((t & Ge) === 0) {
    F(e, I);
    var r = m, n = P, s = oe;
    m = e, oe = !0;
    try {
      (t & gt) !== 0 ? $n(e) : _r(e), kr(e);
      var l = Er(e);
      e.teardown = typeof l == "function" ? l : null, e.wv = Sr;
      var u = e.deps, i;
      qt && dn && e.f & U;
    } catch (a) {
      Ve(a, e, r, n || e.ctx);
    } finally {
      oe = s, m = r;
    }
  }
}
function Cn() {
  try {
    cn();
  } catch (e) {
    if (Ze !== null)
      Ve(e, Ze, null);
    else
      throw e;
  }
}
function Pn() {
  var e = oe;
  try {
    var t = 0;
    for (oe = !0; Pe.length > 0; ) {
      t++ > 1e3 && Cn();
      var r = Pe, n = r.length;
      Pe = [];
      for (var s = 0; s < n; s++) {
        var l = qn(r[s]);
        In(l);
      }
      $e.clear();
    }
  } finally {
    ot = !1, oe = e, Ze = null;
  }
}
function In(e) {
  var t = e.length;
  if (t !== 0)
    for (var r = 0; r < t; r++) {
      var n = e[r];
      if ((n.f & (Ge | J)) === 0)
        try {
          Re(n) && (bt(n), n.deps === null && n.first === null && n.nodes_start === null && (n.teardown === null ? wr(n) : n.fn = null));
        } catch (s) {
          Ve(s, n, null, n.ctx);
        }
    }
}
function Ke(e) {
  ot || (ot = !0, queueMicrotask(Pn));
  for (var t = Ze = e; t.parent !== null; ) {
    t = t.parent;
    var r = t.f;
    if ((r & (ge | ee)) !== 0) {
      if ((r & I) === 0) return;
      t.f ^= I;
    }
  }
  Pe.push(t);
}
function qn(e) {
  for (var t = [], r = e; r !== null; ) {
    var n = r.f, s = (n & (ee | ge)) !== 0, l = s && (n & I) !== 0;
    if (!l && (n & J) === 0) {
      if ((n & Yt) !== 0)
        t.push(r);
      else if (s)
        r.f ^= I;
      else
        try {
          Re(r) && bt(r);
        } catch (a) {
          Ve(a, r, null, r.ctx);
        }
      var u = r.first;
      if (u !== null) {
        r = u;
        continue;
      }
    }
    var i = r.parent;
    for (r = r.next; r === null && i !== null; )
      r = i.next, i = i.parent;
  }
  return t;
}
function y(e) {
  var t = e.f, r = (t & Z) !== 0;
  if (b !== null && !Q) {
    if (!(z != null && z.includes(e))) {
      var n = b.deps;
      e.rv < Fe && (e.rv = Fe, A === null && n !== null && n[M] === e ? M++ : A === null ? A = [e] : (!se || !A.includes(e)) && A.push(e));
    }
  } else if (r && /** @type {Derived} */
  e.deps === null && /** @type {Derived} */
  e.effects === null) {
    var s = (
      /** @type {Derived} */
      e
    ), l = s.parent;
    l !== null && (l.f & B) === 0 && (s.f ^= B);
  }
  return r && (s = /** @type {Derived} */
  e, Re(s) && or(s)), ke && $e.has(e) ? $e.get(e) : e.v;
}
function mt(e) {
  var t = Q;
  try {
    return Q = !0, e();
  } finally {
    Q = t;
  }
}
const Mn = -7169;
function F(e, t) {
  e.f = e.f & Mn | t;
}
let Zt = !1;
function Bn() {
  Zt || (Zt = !0, document.addEventListener(
    "reset",
    (e) => {
      Promise.resolve().then(() => {
        var t;
        if (!e.defaultPrevented)
          for (
            const r of
            /**@type {HTMLFormElement} */
            e.target.elements
          )
            (t = r.__on_r) == null || t.call(r);
      });
    },
    // In the capture phase to guarantee we get noticed of it (no possiblity of stopPropagation)
    { capture: !0 }
  ));
}
function Rr(e) {
  var t = b, r = m;
  W(null), ie(null);
  try {
    return e();
  } finally {
    W(t), ie(r);
  }
}
function Nn(e, t, r, n = r) {
  e.addEventListener(t, () => Rr(r));
  const s = e.__on_r;
  s ? e.__on_r = () => {
    s(), n(!0);
  } : e.__on_r = () => n(!0), Bn();
}
const Ar = /* @__PURE__ */ new Set(), ut = /* @__PURE__ */ new Set();
function Dn(e, t, r, n = {}) {
  function s(l) {
    if (n.capture || ye.call(t, l), !l.cancelBubble)
      return Rr(() => r == null ? void 0 : r.call(this, l));
  }
  return e.startsWith("pointer") || e.startsWith("touch") || e === "wheel" ? yr(() => {
    t.addEventListener(e, s, n);
  }) : t.addEventListener(e, s, n), s;
}
function On(e, t, r, n, s) {
  var l = { capture: n, passive: s }, u = Dn(e, t, r, l);
  (t === document.body || // @ts-ignore
  t === window || // @ts-ignore
  t === document || // Firefox has quirky behavior, it can happen that we still get "canplay" events when the element is already removed
  t instanceof HTMLMediaElement) && dr(() => {
    t.removeEventListener(e, u, l);
  });
}
function Zn(e) {
  for (var t = 0; t < e.length; t++)
    Ar.add(e[t]);
  for (var r of ut)
    r(e);
}
function ye(e) {
  var S;
  var t = this, r = (
    /** @type {Node} */
    t.ownerDocument
  ), n = e.type, s = ((S = e.composedPath) == null ? void 0 : S.call(e)) || [], l = (
    /** @type {null | Element} */
    s[0] || e.target
  ), u = 0, i = e.__root;
  if (i) {
    var a = s.indexOf(i);
    if (a !== -1 && (t === document || t === /** @type {any} */
    window)) {
      e.__root = t;
      return;
    }
    var o = s.indexOf(t);
    if (o === -1)
      return;
    a <= o && (u = a);
  }
  if (l = /** @type {Element} */
  s[u] || e.target, l !== t) {
    Yr(e, "currentTarget", {
      configurable: !0,
      get() {
        return l || r;
      }
    });
    var c = b, h = m;
    W(null), ie(null);
    try {
      for (var f, p = []; l !== null; ) {
        var d = l.assignedSlot || l.parentNode || /** @type {any} */
        l.host || null;
        try {
          var g = l["__" + n];
          if (g != null && (!/** @type {any} */
          l.disabled || // DOM could've been updated already by the time this is reached, so we check this as well
          // -> the target could not have been disabled because it emits the event in the first place
          e.target === l))
            if (pt(g)) {
              var [$, ...v] = g;
              $.apply(l, [e, ...v]);
            } else
              g.call(l, e);
        } catch (O) {
          f ? p.push(O) : f = O;
        }
        if (e.cancelBubble || d === t || d === null)
          break;
        l = d;
      }
      if (f) {
        for (let O of p)
          queueMicrotask(() => {
            throw O;
          });
        throw f;
      }
    } finally {
      e.__root = t, delete e.currentTarget, W(c), ie(h);
    }
  }
}
function yt(e) {
  var t = document.createElement("template");
  return t.innerHTML = e.replaceAll("<!>", "<!---->"), t.content;
}
function St(e, t) {
  var r = (
    /** @type {Effect} */
    m
  );
  r.nodes_start === null && (r.nodes_start = e, r.nodes_end = t);
}
// @__NO_SIDE_EFFECTS__
function Tt(e, t) {
  var r = (t & Kr) !== 0, n, s = !e.startsWith("<!>");
  return () => {
    n === void 0 && (n = yt(s ? e : "<!>" + e), n = /** @type {Node} */
    /* @__PURE__ */ ne(n));
    var l = (
      /** @type {TemplateNode} */
      r || fr ? document.importNode(n, !0) : n.cloneNode(!0)
    );
    return St(l, l), l;
  };
}
// @__NO_SIDE_EFFECTS__
function Fn(e, t, r = "svg") {
  var n = !e.startsWith("<!>"), s = `<${r}>${n ? e : "<!>" + e}</${r}>`, l;
  return () => {
    if (!l) {
      var u = (
        /** @type {DocumentFragment} */
        yt(s)
      ), i = (
        /** @type {Element} */
        /* @__PURE__ */ ne(u)
      );
      l = /** @type {Element} */
      /* @__PURE__ */ ne(i);
    }
    var a = (
      /** @type {TemplateNode} */
      l.cloneNode(!0)
    );
    return St(a, a), a;
  };
}
// @__NO_SIDE_EFFECTS__
function Lr(e, t) {
  return /* @__PURE__ */ Fn(e, t, "svg");
}
function we(e, t) {
  e !== null && e.before(
    /** @type {Node} */
    t
  );
}
const Hn = ["touchstart", "touchmove"];
function jn(e) {
  return Hn.includes(e);
}
function Qn(e, t) {
  var r = t == null ? "" : typeof t == "object" ? t + "" : t;
  r !== (e.__t ?? (e.__t = e.nodeValue)) && (e.__t = r, e.nodeValue = r + "");
}
function Gs(e, t) {
  return Un(e, t);
}
const de = /* @__PURE__ */ new Map();
function Un(e, { target: t, anchor: r, props: n = {}, events: s, context: l, intro: u = !0 }) {
  wn();
  var i = /* @__PURE__ */ new Set(), a = (h) => {
    for (var f = 0; f < h.length; f++) {
      var p = h[f];
      if (!i.has(p)) {
        i.add(p);
        var d = jn(p);
        t.addEventListener(p, ye, { passive: d });
        var g = de.get(p);
        g === void 0 ? (document.addEventListener(p, ye, { passive: d }), de.set(p, 1)) : de.set(p, g + 1);
      }
    }
  };
  a(dt(Ar)), ut.add(a);
  var o = void 0, c = Tn(() => {
    var h = r ?? t.appendChild(bn());
    return Ee(() => {
      if (l) {
        rr({});
        var f = (
          /** @type {ComponentContext} */
          P
        );
        f.c = l;
      }
      s && (n.$$events = s), o = e(h, n) || {}, l && nr();
    }), () => {
      var d;
      for (var f of i) {
        t.removeEventListener(f, ye);
        var p = (
          /** @type {number} */
          de.get(f)
        );
        --p === 0 ? (document.removeEventListener(f, ye), de.delete(f)) : de.set(f, p);
      }
      ut.delete(a), h !== r && ((d = h.parentNode) == null || d.removeChild(h));
    };
  });
  return Wn.set(o, c), o;
}
let Wn = /* @__PURE__ */ new WeakMap();
function Gn(e) {
  P === null && gn(), gr(() => {
    const t = mt(e);
    if (typeof t == "function") return (
      /** @type {() => void} */
      t
    );
  });
}
function Ft(e, t, [r, n] = [0, 0]) {
  var s = e, l = null, u = null, i = C, a = r > 0 ? vt : 0, o = !1;
  const c = (f, p = !0) => {
    o = !0, h(p, f);
  }, h = (f, p) => {
    i !== (i = f) && (i ? (l ? De(l) : p && (l = Ee(() => p(s))), u && Ne(u, () => {
      u = null;
    })) : (u ? De(u) : p && (u = Ee(() => p(s, [r + 1, n]))), l && Ne(l, () => {
      l = null;
    })));
  };
  xt(() => {
    o = !1, t(c), o || h(null, null);
  }, a);
}
function Vn(e, t) {
  return t;
}
function Kn(e, t, r, n) {
  for (var s = [], l = t.length, u = 0; u < l; u++)
    wt(t[u].e, s, !0);
  var i = l > 0 && s.length === 0 && r !== null;
  if (i) {
    var a = (
      /** @type {Element} */
      /** @type {Element} */
      r.parentNode
    );
    mn(a), a.append(
      /** @type {Element} */
      r
    ), n.clear(), re(e, t[0].prev, t[l - 1].next);
  }
  br(s, () => {
    for (var o = 0; o < l; o++) {
      var c = t[o];
      i || (n.delete(c.k), re(e, c.prev, c.next)), le(c.e, !i);
    }
  });
}
function Xn(e, t, r, n, s, l = null) {
  var u = e, i = { flags: t, items: /* @__PURE__ */ new Map(), first: null }, a = null, o = !1, c = /* @__PURE__ */ vn(() => {
    var h = r();
    return pt(h) ? h : h == null ? [] : dt(h);
  });
  xt(() => {
    var h = y(c), f = h.length;
    o && f === 0 || (o = f === 0, Yn(h, i, u, s, t, n, r), l !== null && (f === 0 ? a ? De(a) : a = Ee(() => l(u)) : a !== null && Ne(a, () => {
      a = null;
    })), y(c));
  });
}
function Yn(e, t, r, n, s, l, u) {
  var i = e.length, a = t.items, o = t.first, c = o, h, f = null, p = [], d = [], g, $, v, S;
  for (S = 0; S < i; S += 1) {
    if (g = e[S], $ = l(g, S), v = a.get($), v === void 0) {
      var O = c ? (
        /** @type {TemplateNode} */
        c.e.nodes_start
      ) : r;
      f = es(
        O,
        t,
        f,
        f === null ? t.first : f.next,
        g,
        $,
        S,
        n,
        s,
        u
      ), a.set($, f), p = [], d = [], c = f.next;
      continue;
    }
    if (Jn(v, g, S), (v.e.f & J) !== 0 && De(v.e), v !== c) {
      if (h !== void 0 && h.has(v)) {
        if (p.length < d.length) {
          var G = d[0], q;
          f = G.prev;
          var te = p[0], R = p[p.length - 1];
          for (q = 0; q < p.length; q += 1)
            Ht(p[q], G, r);
          for (q = 0; q < d.length; q += 1)
            h.delete(d[q]);
          re(t, te.prev, R.next), re(t, f, te), re(t, R, G), c = G, f = R, S -= 1, p = [], d = [];
        } else
          h.delete(v), Ht(v, c, r), re(t, v.prev, v.next), re(t, v, f === null ? t.first : f.next), re(t, f, v), f = v;
        continue;
      }
      for (p = [], d = []; c !== null && c.k !== $; )
        (c.e.f & J) === 0 && (h ?? (h = /* @__PURE__ */ new Set())).add(c), d.push(c), c = c.next;
      if (c === null)
        continue;
      v = c;
    }
    p.push(v), f = v, c = v.next;
  }
  if (c !== null || h !== void 0) {
    for (var _e = h === void 0 ? [] : dt(h); c !== null; )
      (c.e.f & J) === 0 && _e.push(c), c = c.next;
    var x = _e.length;
    if (x > 0) {
      var T = null;
      Kn(t, _e, T, a);
    }
  }
  m.first = t.first && t.first.e, m.last = f && f.e;
}
function Jn(e, t, r, n) {
  ur(e.v, t), e.i = r;
}
function es(e, t, r, n, s, l, u, i, a, o) {
  var c = (a & Wr) !== 0, h = (a & Vr) === 0, f = c ? h ? /* @__PURE__ */ _n(s) : Be(s) : s, p = (a & Gr) === 0 ? u : Be(u), d = {
    i: p,
    v: f,
    k: l,
    a: null,
    // @ts-expect-error
    e: null,
    prev: r,
    next: n
  };
  try {
    return d.e = Ee(() => i(e, f, p, o), xn), d.e.prev = r && r.e, d.e.next = n && n.e, r === null ? t.first = d : (r.next = d, r.e.next = d.e), n !== null && (n.prev = d, n.e.prev = d.e), d;
  } finally {
  }
}
function Ht(e, t, r) {
  for (var n = e.next ? (
    /** @type {TemplateNode} */
    e.next.e.nodes_start
  ) : r, s = t ? (
    /** @type {TemplateNode} */
    t.e.nodes_start
  ) : r, l = (
    /** @type {TemplateNode} */
    e.e.nodes_start
  ); l !== n; ) {
    var u = (
      /** @type {TemplateNode} */
      /* @__PURE__ */ kt(l)
    );
    s.before(l), l = u;
  }
}
function re(e, t, r) {
  t === null ? e.first = r : (t.next = r, t.e.next = r && r.e), r !== null && (r.prev = t, r.e.prev = t && t.e);
}
function ts(e, t, r = !1, n = !1, s = !1) {
  var l = e, u = "";
  at(() => {
    var i = (
      /** @type {Effect} */
      m
    );
    if (u !== (u = t() ?? "") && (i.nodes_start !== null && (xr(
      i.nodes_start,
      /** @type {TemplateNode} */
      i.nodes_end
    ), i.nodes_start = i.nodes_end = null), u !== "")) {
      var a = u + "";
      r ? a = `<svg>${a}</svg>` : n && (a = `<math>${a}</math>`);
      var o = yt(a);
      if ((r || n) && (o = /** @type {Element} */
      /* @__PURE__ */ ne(o)), St(
        /** @type {TemplateNode} */
        /* @__PURE__ */ ne(o),
        /** @type {TemplateNode} */
        o.lastChild
      ), r || n)
        for (; /* @__PURE__ */ ne(o); )
          l.before(
            /** @type {Node} */
            /* @__PURE__ */ ne(o)
          );
      else
        l.before(o);
    }
  });
}
function rs(e, t, r) {
  var n = e == null ? "" : "" + e;
  return n = n ? n + " " + t : t, n === "" ? null : n;
}
function jt(e, t, r, n, s, l) {
  var u = e.__className;
  if (u !== r || u === void 0) {
    var i = rs(r, n);
    i == null ? e.removeAttribute("class") : e.className = i, e.__className = r;
  }
  return l;
}
function ns(e, t, r = t) {
  Nn(e, "input", (n) => {
    var s = n ? e.defaultValue : e.value;
    if (s = nt(e) ? st(s) : s, r(s), s !== (s = t())) {
      var l = e.selectionStart, u = e.selectionEnd;
      e.value = s ?? "", u !== null && (e.selectionStart = l, e.selectionEnd = Math.min(u, e.value.length));
    }
  }), // If we are hydrating and the value has since changed,
  // then use the updated value from the input instead.
  // If defaultValue is set, then value == defaultValue
  // TODO Svelte 6: remove input.value check and set to empty string?
  mt(t) == null && e.value && r(nt(e) ? st(e.value) : e.value), vr(() => {
    var n = t();
    nt(e) && n === st(e.value) || e.type === "date" && !n && !e.value || n !== e.value && (e.value = n ?? "");
  });
}
function nt(e) {
  var t = e.type;
  return t === "number" || t === "range";
}
function st(e) {
  return e === "" ? null : +e;
}
function Qt(e, t) {
  return e === t || (e == null ? void 0 : e[ze]) === t;
}
function ss(e = {}, t, r, n) {
  return _t(() => {
    var s, l;
    return vr(() => {
      s = l, l = [], mt(() => {
        e !== r(...l) && (t(e, ...l), s && Qt(r(...s), e) && t(null, ...s));
      });
    }), () => {
      yr(() => {
        l && Qt(r(...l), e) && t(null, ...l);
      });
    };
  }), e;
}
function $t() {
  return { async: !1, breaks: !1, extensions: null, gfm: !0, hooks: null, pedantic: !1, renderer: null, silent: !1, tokenizer: null, walkTokens: null };
}
var fe = $t();
function zr(e) {
  fe = e;
}
var Te = { exec: () => null };
function _(e, t = "") {
  let r = typeof e == "string" ? e : e.source, n = { replace: (s, l) => {
    let u = typeof l == "string" ? l : l.source;
    return u = u.replace(L.caret, "$1"), r = r.replace(s, u), n;
  }, getRegex: () => new RegExp(r, t) };
  return n;
}
var L = { codeRemoveIndent: /^(?: {1,4}| {0,3}\t)/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceTabs: /^\t+/, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] /, listReplaceTask: /^\[[ xX]\] +/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, unescapeTest: /&(#(?:\d+)|(?:#x[0-9A-Fa-f]+)|(?:\w+));?/ig, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (e) => new RegExp(`^( {0,3}${e})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: (e) => new RegExp(`^ {0,${Math.min(3, e - 1)}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`), hrRegex: (e) => new RegExp(`^ {0,${Math.min(3, e - 1)}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`), fencesBeginRegex: (e) => new RegExp(`^ {0,${Math.min(3, e - 1)}}(?:\`\`\`|~~~)`), headingBeginRegex: (e) => new RegExp(`^ {0,${Math.min(3, e - 1)}}#`), htmlBeginRegex: (e) => new RegExp(`^ {0,${Math.min(3, e - 1)}}<(?:[a-z].*>|!--)`, "i") }, ls = /^(?:[ \t]*(?:\n|$))+/, is = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/, as = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/, Ae = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/, os = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/, Et = /(?:[*+-]|\d{1,9}[.)])/, Cr = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/, Pr = _(Cr).replace(/bull/g, Et).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex(), us = _(Cr).replace(/bull/g, Et).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex(), Rt = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/, cs = /^[^\n]+/, At = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/, fs = _(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", At).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex(), hs = _(/^( {0,3}bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g, Et).getRegex(), Xe = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul", Lt = /<!--(?:-?>|[\s\S]*?(?:-->|$))/, ps = _("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", Lt).replace("tag", Xe).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(), Ir = _(Rt).replace("hr", Ae).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)]) ").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", Xe).getRegex(), ds = _(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", Ir).getRegex(), zt = { blockquote: ds, code: is, def: fs, fences: as, heading: os, hr: Ae, html: ps, lheading: Pr, list: hs, newline: ls, paragraph: Ir, table: Te, text: cs }, Ut = _("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", Ae).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)]) ").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", Xe).getRegex(), gs = { ...zt, lheading: us, table: Ut, paragraph: _(Rt).replace("hr", Ae).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", Ut).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)]) ").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", Xe).getRegex() }, vs = { ...zt, html: _(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", Lt).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: Te, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: _(Rt).replace("hr", Ae).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", Pr).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() }, ks = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/, _s = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/, qr = /^( {2,}|\\)\n(?!\s*$)/, xs = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/, Ye = /[\p{P}\p{S}]/u, Ct = /[\s\p{P}\p{S}]/u, Mr = /[^\s\p{P}\p{S}]/u, ws = _(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, Ct).getRegex(), Br = /(?!~)[\p{P}\p{S}]/u, bs = /(?!~)[\s\p{P}\p{S}]/u, ms = /(?:[^\s\p{P}\p{S}]|~)/u, ys = /\[[^\[\]]*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|`[^`]*?`|<(?! )[^<>]*?>/g, Nr = /^(?:\*+(?:((?!\*)punct)|[^\s*]))|^_+(?:((?!_)punct)|([^\s_]))/, Ss = _(Nr, "u").replace(/punct/g, Ye).getRegex(), Ts = _(Nr, "u").replace(/punct/g, Br).getRegex(), Dr = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)", $s = _(Dr, "gu").replace(/notPunctSpace/g, Mr).replace(/punctSpace/g, Ct).replace(/punct/g, Ye).getRegex(), Es = _(Dr, "gu").replace(/notPunctSpace/g, ms).replace(/punctSpace/g, bs).replace(/punct/g, Br).getRegex(), Rs = _("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, Mr).replace(/punctSpace/g, Ct).replace(/punct/g, Ye).getRegex(), As = _(/\\(punct)/, "gu").replace(/punct/g, Ye).getRegex(), Ls = _(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex(), zs = _(Lt).replace("(?:-->|$)", "-->").getRegex(), Cs = _("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", zs).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex(), je = /(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`[^`]*`|[^\[\]\\`])*?/, Ps = _(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]*(?:\n[ \t]*)?)(title))?\s*\)/).replace("label", je).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex(), Or = _(/^!?\[(label)\]\[(ref)\]/).replace("label", je).replace("ref", At).getRegex(), Zr = _(/^!?\[(ref)\](?:\[\])?/).replace("ref", At).getRegex(), Is = _("reflink|nolink(?!\\()", "g").replace("reflink", Or).replace("nolink", Zr).getRegex(), Pt = { _backpedal: Te, anyPunctuation: As, autolink: Ls, blockSkip: ys, br: qr, code: _s, del: Te, emStrongLDelim: Ss, emStrongRDelimAst: $s, emStrongRDelimUnd: Rs, escape: ks, link: Ps, nolink: Zr, punctuation: ws, reflink: Or, reflinkSearch: Is, tag: Cs, text: xs, url: Te }, qs = { ...Pt, link: _(/^!?\[(label)\]\((.*?)\)/).replace("label", je).getRegex(), reflink: _(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", je).getRegex() }, ct = { ...Pt, emStrongRDelimAst: Es, emStrongLDelim: Ts, url: _(/^((?:ftp|https?):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/, "i").replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: /^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|https?:\/\/|ftp:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/ }, Ms = { ...ct, br: _(qr).replace("{2,}", "*").getRegex(), text: _(ct.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() }, Le = { normal: zt, gfm: gs, pedantic: vs }, be = { normal: Pt, gfm: ct, breaks: Ms, pedantic: qs }, Bs = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }, Wt = (e) => Bs[e];
function j(e, t) {
  if (t) {
    if (L.escapeTest.test(e)) return e.replace(L.escapeReplace, Wt);
  } else if (L.escapeTestNoEncode.test(e)) return e.replace(L.escapeReplaceNoEncode, Wt);
  return e;
}
function Gt(e) {
  try {
    e = encodeURI(e).replace(L.percentDecode, "%");
  } catch {
    return null;
  }
  return e;
}
function Vt(e, t) {
  var l;
  let r = e.replace(L.findPipe, (u, i, a) => {
    let o = !1, c = i;
    for (; --c >= 0 && a[c] === "\\"; ) o = !o;
    return o ? "|" : " |";
  }), n = r.split(L.splitPipe), s = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !((l = n.at(-1)) != null && l.trim()) && n.pop(), t) if (n.length > t) n.splice(t);
  else for (; n.length < t; ) n.push("");
  for (; s < n.length; s++) n[s] = n[s].trim().replace(L.slashPipe, "|");
  return n;
}
function me(e, t, r) {
  let n = e.length;
  if (n === 0) return "";
  let s = 0;
  for (; s < n && e.charAt(n - s - 1) === t; )
    s++;
  return e.slice(0, n - s);
}
function Ns(e, t) {
  if (e.indexOf(t[1]) === -1) return -1;
  let r = 0;
  for (let n = 0; n < e.length; n++) if (e[n] === "\\") n++;
  else if (e[n] === t[0]) r++;
  else if (e[n] === t[1] && (r--, r < 0)) return n;
  return r > 0 ? -2 : -1;
}
function Kt(e, t, r, n, s) {
  let l = t.href, u = t.title || null, i = e[1].replace(s.other.outputLinkReplace, "$1");
  n.state.inLink = !0;
  let a = { type: e[0].charAt(0) === "!" ? "image" : "link", raw: r, href: l, title: u, text: i, tokens: n.inlineTokens(i) };
  return n.state.inLink = !1, a;
}
function Ds(e, t, r) {
  let n = e.match(r.other.indentCodeCompensation);
  if (n === null) return t;
  let s = n[1];
  return t.split(`
`).map((l) => {
    let u = l.match(r.other.beginningSpace);
    if (u === null) return l;
    let [i] = u;
    return i.length >= s.length ? l.slice(s.length) : l;
  }).join(`
`);
}
var Qe = class {
  constructor(e) {
    w(this, "options");
    w(this, "rules");
    w(this, "lexer");
    this.options = e || fe;
  }
  space(e) {
    let t = this.rules.block.newline.exec(e);
    if (t && t[0].length > 0) return { type: "space", raw: t[0] };
  }
  code(e) {
    let t = this.rules.block.code.exec(e);
    if (t) {
      let r = t[0].replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw: t[0], codeBlockStyle: "indented", text: this.options.pedantic ? r : me(r, `
`) };
    }
  }
  fences(e) {
    let t = this.rules.block.fences.exec(e);
    if (t) {
      let r = t[0], n = Ds(r, t[3] || "", this.rules);
      return { type: "code", raw: r, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: n };
    }
  }
  heading(e) {
    let t = this.rules.block.heading.exec(e);
    if (t) {
      let r = t[2].trim();
      if (this.rules.other.endingHash.test(r)) {
        let n = me(r, "#");
        (this.options.pedantic || !n || this.rules.other.endingSpaceChar.test(n)) && (r = n.trim());
      }
      return { type: "heading", raw: t[0], depth: t[1].length, text: r, tokens: this.lexer.inline(r) };
    }
  }
  hr(e) {
    let t = this.rules.block.hr.exec(e);
    if (t) return { type: "hr", raw: me(t[0], `
`) };
  }
  blockquote(e) {
    let t = this.rules.block.blockquote.exec(e);
    if (t) {
      let r = me(t[0], `
`).split(`
`), n = "", s = "", l = [];
      for (; r.length > 0; ) {
        let u = !1, i = [], a;
        for (a = 0; a < r.length; a++) if (this.rules.other.blockquoteStart.test(r[a])) i.push(r[a]), u = !0;
        else if (!u) i.push(r[a]);
        else break;
        r = r.slice(a);
        let o = i.join(`
`), c = o.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
        n = n ? `${n}
${o}` : o, s = s ? `${s}
${c}` : c;
        let h = this.lexer.state.top;
        if (this.lexer.state.top = !0, this.lexer.blockTokens(c, l, !0), this.lexer.state.top = h, r.length === 0) break;
        let f = l.at(-1);
        if ((f == null ? void 0 : f.type) === "code") break;
        if ((f == null ? void 0 : f.type) === "blockquote") {
          let p = f, d = p.raw + `
` + r.join(`
`), g = this.blockquote(d);
          l[l.length - 1] = g, n = n.substring(0, n.length - p.raw.length) + g.raw, s = s.substring(0, s.length - p.text.length) + g.text;
          break;
        } else if ((f == null ? void 0 : f.type) === "list") {
          let p = f, d = p.raw + `
` + r.join(`
`), g = this.list(d);
          l[l.length - 1] = g, n = n.substring(0, n.length - f.raw.length) + g.raw, s = s.substring(0, s.length - p.raw.length) + g.raw, r = d.substring(l.at(-1).raw.length).split(`
`);
          continue;
        }
      }
      return { type: "blockquote", raw: n, tokens: l, text: s };
    }
  }
  list(e) {
    let t = this.rules.block.list.exec(e);
    if (t) {
      let r = t[1].trim(), n = r.length > 1, s = { type: "list", raw: "", ordered: n, start: n ? +r.slice(0, -1) : "", loose: !1, items: [] };
      r = n ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`, this.options.pedantic && (r = n ? r : "[*+-]");
      let l = this.rules.other.listItemRegex(r), u = !1;
      for (; e; ) {
        let a = !1, o = "", c = "";
        if (!(t = l.exec(e)) || this.rules.block.hr.test(e)) break;
        o = t[0], e = e.substring(o.length);
        let h = t[2].split(`
`, 1)[0].replace(this.rules.other.listReplaceTabs, (v) => " ".repeat(3 * v.length)), f = e.split(`
`, 1)[0], p = !h.trim(), d = 0;
        if (this.options.pedantic ? (d = 2, c = h.trimStart()) : p ? d = t[1].length + 1 : (d = t[2].search(this.rules.other.nonSpaceChar), d = d > 4 ? 1 : d, c = h.slice(d), d += t[1].length), p && this.rules.other.blankLine.test(f) && (o += f + `
`, e = e.substring(f.length + 1), a = !0), !a) {
          let v = this.rules.other.nextBulletRegex(d), S = this.rules.other.hrRegex(d), O = this.rules.other.fencesBeginRegex(d), G = this.rules.other.headingBeginRegex(d), q = this.rules.other.htmlBeginRegex(d);
          for (; e; ) {
            let te = e.split(`
`, 1)[0], R;
            if (f = te, this.options.pedantic ? (f = f.replace(this.rules.other.listReplaceNesting, "  "), R = f) : R = f.replace(this.rules.other.tabCharGlobal, "    "), O.test(f) || G.test(f) || q.test(f) || v.test(f) || S.test(f)) break;
            if (R.search(this.rules.other.nonSpaceChar) >= d || !f.trim()) c += `
` + R.slice(d);
            else {
              if (p || h.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || O.test(h) || G.test(h) || S.test(h)) break;
              c += `
` + f;
            }
            !p && !f.trim() && (p = !0), o += te + `
`, e = e.substring(te.length + 1), h = R.slice(d);
          }
        }
        s.loose || (u ? s.loose = !0 : this.rules.other.doubleBlankLine.test(o) && (u = !0));
        let g = null, $;
        this.options.gfm && (g = this.rules.other.listIsTask.exec(c), g && ($ = g[0] !== "[ ] ", c = c.replace(this.rules.other.listReplaceTask, ""))), s.items.push({ type: "list_item", raw: o, task: !!g, checked: $, loose: !1, text: c, tokens: [] }), s.raw += o;
      }
      let i = s.items.at(-1);
      if (i) i.raw = i.raw.trimEnd(), i.text = i.text.trimEnd();
      else return;
      s.raw = s.raw.trimEnd();
      for (let a = 0; a < s.items.length; a++) if (this.lexer.state.top = !1, s.items[a].tokens = this.lexer.blockTokens(s.items[a].text, []), !s.loose) {
        let o = s.items[a].tokens.filter((h) => h.type === "space"), c = o.length > 0 && o.some((h) => this.rules.other.anyLine.test(h.raw));
        s.loose = c;
      }
      if (s.loose) for (let a = 0; a < s.items.length; a++) s.items[a].loose = !0;
      return s;
    }
  }
  html(e) {
    let t = this.rules.block.html.exec(e);
    if (t) return { type: "html", block: !0, raw: t[0], pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: t[0] };
  }
  def(e) {
    let t = this.rules.block.def.exec(e);
    if (t) {
      let r = t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal, " "), n = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", s = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
      return { type: "def", tag: r, raw: t[0], href: n, title: s };
    }
  }
  table(e) {
    var u;
    let t = this.rules.block.table.exec(e);
    if (!t || !this.rules.other.tableDelimiter.test(t[2])) return;
    let r = Vt(t[1]), n = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), s = (u = t[3]) != null && u.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], l = { type: "table", raw: t[0], header: [], align: [], rows: [] };
    if (r.length === n.length) {
      for (let i of n) this.rules.other.tableAlignRight.test(i) ? l.align.push("right") : this.rules.other.tableAlignCenter.test(i) ? l.align.push("center") : this.rules.other.tableAlignLeft.test(i) ? l.align.push("left") : l.align.push(null);
      for (let i = 0; i < r.length; i++) l.header.push({ text: r[i], tokens: this.lexer.inline(r[i]), header: !0, align: l.align[i] });
      for (let i of s) l.rows.push(Vt(i, l.header.length).map((a, o) => ({ text: a, tokens: this.lexer.inline(a), header: !1, align: l.align[o] })));
      return l;
    }
  }
  lheading(e) {
    let t = this.rules.block.lheading.exec(e);
    if (t) return { type: "heading", raw: t[0], depth: t[2].charAt(0) === "=" ? 1 : 2, text: t[1], tokens: this.lexer.inline(t[1]) };
  }
  paragraph(e) {
    let t = this.rules.block.paragraph.exec(e);
    if (t) {
      let r = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
      return { type: "paragraph", raw: t[0], text: r, tokens: this.lexer.inline(r) };
    }
  }
  text(e) {
    let t = this.rules.block.text.exec(e);
    if (t) return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
  }
  escape(e) {
    let t = this.rules.inline.escape.exec(e);
    if (t) return { type: "escape", raw: t[0], text: t[1] };
  }
  tag(e) {
    let t = this.rules.inline.tag.exec(e);
    if (t) return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = !0 : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = !1), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = !0 : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = !1), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: !1, text: t[0] };
  }
  link(e) {
    let t = this.rules.inline.link.exec(e);
    if (t) {
      let r = t[2].trim();
      if (!this.options.pedantic && this.rules.other.startAngleBracket.test(r)) {
        if (!this.rules.other.endAngleBracket.test(r)) return;
        let l = me(r.slice(0, -1), "\\");
        if ((r.length - l.length) % 2 === 0) return;
      } else {
        let l = Ns(t[2], "()");
        if (l === -2) return;
        if (l > -1) {
          let u = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + l;
          t[2] = t[2].substring(0, l), t[0] = t[0].substring(0, u).trim(), t[3] = "";
        }
      }
      let n = t[2], s = "";
      if (this.options.pedantic) {
        let l = this.rules.other.pedanticHrefTitle.exec(n);
        l && (n = l[1], s = l[3]);
      } else s = t[3] ? t[3].slice(1, -1) : "";
      return n = n.trim(), this.rules.other.startAngleBracket.test(n) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(r) ? n = n.slice(1) : n = n.slice(1, -1)), Kt(t, { href: n && n.replace(this.rules.inline.anyPunctuation, "$1"), title: s && s.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
    }
  }
  reflink(e, t) {
    let r;
    if ((r = this.rules.inline.reflink.exec(e)) || (r = this.rules.inline.nolink.exec(e))) {
      let n = (r[2] || r[1]).replace(this.rules.other.multipleSpaceGlobal, " "), s = t[n.toLowerCase()];
      if (!s) {
        let l = r[0].charAt(0);
        return { type: "text", raw: l, text: l };
      }
      return Kt(r, s, r[0], this.lexer, this.rules);
    }
  }
  emStrong(e, t, r = "") {
    let n = this.rules.inline.emStrongLDelim.exec(e);
    if (!(!n || n[3] && r.match(this.rules.other.unicodeAlphaNumeric)) && (!(n[1] || n[2]) || !r || this.rules.inline.punctuation.exec(r))) {
      let s = [...n[0]].length - 1, l, u, i = s, a = 0, o = n[0][0] === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      for (o.lastIndex = 0, t = t.slice(-1 * e.length + s); (n = o.exec(t)) != null; ) {
        if (l = n[1] || n[2] || n[3] || n[4] || n[5] || n[6], !l) continue;
        if (u = [...l].length, n[3] || n[4]) {
          i += u;
          continue;
        } else if ((n[5] || n[6]) && s % 3 && !((s + u) % 3)) {
          a += u;
          continue;
        }
        if (i -= u, i > 0) continue;
        u = Math.min(u, u + i + a);
        let c = [...n[0]][0].length, h = e.slice(0, s + n.index + c + u);
        if (Math.min(s, u) % 2) {
          let p = h.slice(1, -1);
          return { type: "em", raw: h, text: p, tokens: this.lexer.inlineTokens(p) };
        }
        let f = h.slice(2, -2);
        return { type: "strong", raw: h, text: f, tokens: this.lexer.inlineTokens(f) };
      }
    }
  }
  codespan(e) {
    let t = this.rules.inline.code.exec(e);
    if (t) {
      let r = t[2].replace(this.rules.other.newLineCharGlobal, " "), n = this.rules.other.nonSpaceChar.test(r), s = this.rules.other.startingSpaceChar.test(r) && this.rules.other.endingSpaceChar.test(r);
      return n && s && (r = r.substring(1, r.length - 1)), { type: "codespan", raw: t[0], text: r };
    }
  }
  br(e) {
    let t = this.rules.inline.br.exec(e);
    if (t) return { type: "br", raw: t[0] };
  }
  del(e) {
    let t = this.rules.inline.del.exec(e);
    if (t) return { type: "del", raw: t[0], text: t[2], tokens: this.lexer.inlineTokens(t[2]) };
  }
  autolink(e) {
    let t = this.rules.inline.autolink.exec(e);
    if (t) {
      let r, n;
      return t[2] === "@" ? (r = t[1], n = "mailto:" + r) : (r = t[1], n = r), { type: "link", raw: t[0], text: r, href: n, tokens: [{ type: "text", raw: r, text: r }] };
    }
  }
  url(e) {
    var r;
    let t;
    if (t = this.rules.inline.url.exec(e)) {
      let n, s;
      if (t[2] === "@") n = t[0], s = "mailto:" + n;
      else {
        let l;
        do
          l = t[0], t[0] = ((r = this.rules.inline._backpedal.exec(t[0])) == null ? void 0 : r[0]) ?? "";
        while (l !== t[0]);
        n = t[0], t[1] === "www." ? s = "http://" + t[0] : s = t[0];
      }
      return { type: "link", raw: t[0], text: n, href: s, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  inlineText(e) {
    let t = this.rules.inline.text.exec(e);
    if (t) {
      let r = this.lexer.state.inRawBlock;
      return { type: "text", raw: t[0], text: t[0], escaped: r };
    }
  }
}, X = class ft {
  constructor(t) {
    w(this, "tokens");
    w(this, "options");
    w(this, "state");
    w(this, "tokenizer");
    w(this, "inlineQueue");
    this.tokens = [], this.tokens.links = /* @__PURE__ */ Object.create(null), this.options = t || fe, this.options.tokenizer = this.options.tokenizer || new Qe(), this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: !1, inRawBlock: !1, top: !0 };
    let r = { other: L, block: Le.normal, inline: be.normal };
    this.options.pedantic ? (r.block = Le.pedantic, r.inline = be.pedantic) : this.options.gfm && (r.block = Le.gfm, this.options.breaks ? r.inline = be.breaks : r.inline = be.gfm), this.tokenizer.rules = r;
  }
  static get rules() {
    return { block: Le, inline: be };
  }
  static lex(t, r) {
    return new ft(r).lex(t);
  }
  static lexInline(t, r) {
    return new ft(r).inlineTokens(t);
  }
  lex(t) {
    t = t.replace(L.carriageReturn, `
`), this.blockTokens(t, this.tokens);
    for (let r = 0; r < this.inlineQueue.length; r++) {
      let n = this.inlineQueue[r];
      this.inlineTokens(n.src, n.tokens);
    }
    return this.inlineQueue = [], this.tokens;
  }
  blockTokens(t, r = [], n = !1) {
    var s, l, u;
    for (this.options.pedantic && (t = t.replace(L.tabCharGlobal, "    ").replace(L.spaceLine, "")); t; ) {
      let i;
      if ((l = (s = this.options.extensions) == null ? void 0 : s.block) != null && l.some((o) => (i = o.call({ lexer: this }, t, r)) ? (t = t.substring(i.raw.length), r.push(i), !0) : !1)) continue;
      if (i = this.tokenizer.space(t)) {
        t = t.substring(i.raw.length);
        let o = r.at(-1);
        i.raw.length === 1 && o !== void 0 ? o.raw += `
` : r.push(i);
        continue;
      }
      if (i = this.tokenizer.code(t)) {
        t = t.substring(i.raw.length);
        let o = r.at(-1);
        (o == null ? void 0 : o.type) === "paragraph" || (o == null ? void 0 : o.type) === "text" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + i.raw, o.text += `
` + i.text, this.inlineQueue.at(-1).src = o.text) : r.push(i);
        continue;
      }
      if (i = this.tokenizer.fences(t)) {
        t = t.substring(i.raw.length), r.push(i);
        continue;
      }
      if (i = this.tokenizer.heading(t)) {
        t = t.substring(i.raw.length), r.push(i);
        continue;
      }
      if (i = this.tokenizer.hr(t)) {
        t = t.substring(i.raw.length), r.push(i);
        continue;
      }
      if (i = this.tokenizer.blockquote(t)) {
        t = t.substring(i.raw.length), r.push(i);
        continue;
      }
      if (i = this.tokenizer.list(t)) {
        t = t.substring(i.raw.length), r.push(i);
        continue;
      }
      if (i = this.tokenizer.html(t)) {
        t = t.substring(i.raw.length), r.push(i);
        continue;
      }
      if (i = this.tokenizer.def(t)) {
        t = t.substring(i.raw.length);
        let o = r.at(-1);
        (o == null ? void 0 : o.type) === "paragraph" || (o == null ? void 0 : o.type) === "text" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + i.raw, o.text += `
` + i.raw, this.inlineQueue.at(-1).src = o.text) : this.tokens.links[i.tag] || (this.tokens.links[i.tag] = { href: i.href, title: i.title }, r.push(i));
        continue;
      }
      if (i = this.tokenizer.table(t)) {
        t = t.substring(i.raw.length), r.push(i);
        continue;
      }
      if (i = this.tokenizer.lheading(t)) {
        t = t.substring(i.raw.length), r.push(i);
        continue;
      }
      let a = t;
      if ((u = this.options.extensions) != null && u.startBlock) {
        let o = 1 / 0, c = t.slice(1), h;
        this.options.extensions.startBlock.forEach((f) => {
          h = f.call({ lexer: this }, c), typeof h == "number" && h >= 0 && (o = Math.min(o, h));
        }), o < 1 / 0 && o >= 0 && (a = t.substring(0, o + 1));
      }
      if (this.state.top && (i = this.tokenizer.paragraph(a))) {
        let o = r.at(-1);
        n && (o == null ? void 0 : o.type) === "paragraph" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + i.raw, o.text += `
` + i.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = o.text) : r.push(i), n = a.length !== t.length, t = t.substring(i.raw.length);
        continue;
      }
      if (i = this.tokenizer.text(t)) {
        t = t.substring(i.raw.length);
        let o = r.at(-1);
        (o == null ? void 0 : o.type) === "text" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + i.raw, o.text += `
` + i.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = o.text) : r.push(i);
        continue;
      }
      if (t) {
        let o = "Infinite loop on byte: " + t.charCodeAt(0);
        if (this.options.silent) {
          console.error(o);
          break;
        } else throw new Error(o);
      }
    }
    return this.state.top = !0, r;
  }
  inline(t, r = []) {
    return this.inlineQueue.push({ src: t, tokens: r }), r;
  }
  inlineTokens(t, r = []) {
    var i, a, o;
    let n = t, s = null;
    if (this.tokens.links) {
      let c = Object.keys(this.tokens.links);
      if (c.length > 0) for (; (s = this.tokenizer.rules.inline.reflinkSearch.exec(n)) != null; ) c.includes(s[0].slice(s[0].lastIndexOf("[") + 1, -1)) && (n = n.slice(0, s.index) + "[" + "a".repeat(s[0].length - 2) + "]" + n.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex));
    }
    for (; (s = this.tokenizer.rules.inline.anyPunctuation.exec(n)) != null; ) n = n.slice(0, s.index) + "++" + n.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);
    for (; (s = this.tokenizer.rules.inline.blockSkip.exec(n)) != null; ) n = n.slice(0, s.index) + "[" + "a".repeat(s[0].length - 2) + "]" + n.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);
    let l = !1, u = "";
    for (; t; ) {
      l || (u = ""), l = !1;
      let c;
      if ((a = (i = this.options.extensions) == null ? void 0 : i.inline) != null && a.some((f) => (c = f.call({ lexer: this }, t, r)) ? (t = t.substring(c.raw.length), r.push(c), !0) : !1)) continue;
      if (c = this.tokenizer.escape(t)) {
        t = t.substring(c.raw.length), r.push(c);
        continue;
      }
      if (c = this.tokenizer.tag(t)) {
        t = t.substring(c.raw.length), r.push(c);
        continue;
      }
      if (c = this.tokenizer.link(t)) {
        t = t.substring(c.raw.length), r.push(c);
        continue;
      }
      if (c = this.tokenizer.reflink(t, this.tokens.links)) {
        t = t.substring(c.raw.length);
        let f = r.at(-1);
        c.type === "text" && (f == null ? void 0 : f.type) === "text" ? (f.raw += c.raw, f.text += c.text) : r.push(c);
        continue;
      }
      if (c = this.tokenizer.emStrong(t, n, u)) {
        t = t.substring(c.raw.length), r.push(c);
        continue;
      }
      if (c = this.tokenizer.codespan(t)) {
        t = t.substring(c.raw.length), r.push(c);
        continue;
      }
      if (c = this.tokenizer.br(t)) {
        t = t.substring(c.raw.length), r.push(c);
        continue;
      }
      if (c = this.tokenizer.del(t)) {
        t = t.substring(c.raw.length), r.push(c);
        continue;
      }
      if (c = this.tokenizer.autolink(t)) {
        t = t.substring(c.raw.length), r.push(c);
        continue;
      }
      if (!this.state.inLink && (c = this.tokenizer.url(t))) {
        t = t.substring(c.raw.length), r.push(c);
        continue;
      }
      let h = t;
      if ((o = this.options.extensions) != null && o.startInline) {
        let f = 1 / 0, p = t.slice(1), d;
        this.options.extensions.startInline.forEach((g) => {
          d = g.call({ lexer: this }, p), typeof d == "number" && d >= 0 && (f = Math.min(f, d));
        }), f < 1 / 0 && f >= 0 && (h = t.substring(0, f + 1));
      }
      if (c = this.tokenizer.inlineText(h)) {
        t = t.substring(c.raw.length), c.raw.slice(-1) !== "_" && (u = c.raw.slice(-1)), l = !0;
        let f = r.at(-1);
        (f == null ? void 0 : f.type) === "text" ? (f.raw += c.raw, f.text += c.text) : r.push(c);
        continue;
      }
      if (t) {
        let f = "Infinite loop on byte: " + t.charCodeAt(0);
        if (this.options.silent) {
          console.error(f);
          break;
        } else throw new Error(f);
      }
    }
    return r;
  }
}, Ue = class {
  constructor(e) {
    w(this, "options");
    w(this, "parser");
    this.options = e || fe;
  }
  space(e) {
    return "";
  }
  code({ text: e, lang: t, escaped: r }) {
    var l;
    let n = (l = (t || "").match(L.notSpaceStart)) == null ? void 0 : l[0], s = e.replace(L.endingNewline, "") + `
`;
    return n ? '<pre><code class="language-' + j(n) + '">' + (r ? s : j(s, !0)) + `</code></pre>
` : "<pre><code>" + (r ? s : j(s, !0)) + `</code></pre>
`;
  }
  blockquote({ tokens: e }) {
    return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
  }
  html({ text: e }) {
    return e;
  }
  def(e) {
    return "";
  }
  heading({ tokens: e, depth: t }) {
    return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
  }
  hr(e) {
    return `<hr>
`;
  }
  list(e) {
    let t = e.ordered, r = e.start, n = "";
    for (let u = 0; u < e.items.length; u++) {
      let i = e.items[u];
      n += this.listitem(i);
    }
    let s = t ? "ol" : "ul", l = t && r !== 1 ? ' start="' + r + '"' : "";
    return "<" + s + l + `>
` + n + "</" + s + `>
`;
  }
  listitem(e) {
    var r;
    let t = "";
    if (e.task) {
      let n = this.checkbox({ checked: !!e.checked });
      e.loose ? ((r = e.tokens[0]) == null ? void 0 : r.type) === "paragraph" ? (e.tokens[0].text = n + " " + e.tokens[0].text, e.tokens[0].tokens && e.tokens[0].tokens.length > 0 && e.tokens[0].tokens[0].type === "text" && (e.tokens[0].tokens[0].text = n + " " + j(e.tokens[0].tokens[0].text), e.tokens[0].tokens[0].escaped = !0)) : e.tokens.unshift({ type: "text", raw: n + " ", text: n + " ", escaped: !0 }) : t += n + " ";
    }
    return t += this.parser.parse(e.tokens, !!e.loose), `<li>${t}</li>
`;
  }
  checkbox({ checked: e }) {
    return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox">';
  }
  paragraph({ tokens: e }) {
    return `<p>${this.parser.parseInline(e)}</p>
`;
  }
  table(e) {
    let t = "", r = "";
    for (let s = 0; s < e.header.length; s++) r += this.tablecell(e.header[s]);
    t += this.tablerow({ text: r });
    let n = "";
    for (let s = 0; s < e.rows.length; s++) {
      let l = e.rows[s];
      r = "";
      for (let u = 0; u < l.length; u++) r += this.tablecell(l[u]);
      n += this.tablerow({ text: r });
    }
    return n && (n = `<tbody>${n}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + n + `</table>
`;
  }
  tablerow({ text: e }) {
    return `<tr>
${e}</tr>
`;
  }
  tablecell(e) {
    let t = this.parser.parseInline(e.tokens), r = e.header ? "th" : "td";
    return (e.align ? `<${r} align="${e.align}">` : `<${r}>`) + t + `</${r}>
`;
  }
  strong({ tokens: e }) {
    return `<strong>${this.parser.parseInline(e)}</strong>`;
  }
  em({ tokens: e }) {
    return `<em>${this.parser.parseInline(e)}</em>`;
  }
  codespan({ text: e }) {
    return `<code>${j(e, !0)}</code>`;
  }
  br(e) {
    return "<br>";
  }
  del({ tokens: e }) {
    return `<del>${this.parser.parseInline(e)}</del>`;
  }
  link({ href: e, title: t, tokens: r }) {
    let n = this.parser.parseInline(r), s = Gt(e);
    if (s === null) return n;
    e = s;
    let l = '<a href="' + e + '"';
    return t && (l += ' title="' + j(t) + '"'), l += ">" + n + "</a>", l;
  }
  image({ href: e, title: t, text: r, tokens: n }) {
    n && (r = this.parser.parseInline(n, this.parser.textRenderer));
    let s = Gt(e);
    if (s === null) return j(r);
    e = s;
    let l = `<img src="${e}" alt="${r}"`;
    return t && (l += ` title="${j(t)}"`), l += ">", l;
  }
  text(e) {
    return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : "escaped" in e && e.escaped ? e.text : j(e.text);
  }
}, It = class {
  strong({ text: e }) {
    return e;
  }
  em({ text: e }) {
    return e;
  }
  codespan({ text: e }) {
    return e;
  }
  del({ text: e }) {
    return e;
  }
  html({ text: e }) {
    return e;
  }
  text({ text: e }) {
    return e;
  }
  link({ text: e }) {
    return "" + e;
  }
  image({ text: e }) {
    return "" + e;
  }
  br() {
    return "";
  }
}, Y = class ht {
  constructor(t) {
    w(this, "options");
    w(this, "renderer");
    w(this, "textRenderer");
    this.options = t || fe, this.options.renderer = this.options.renderer || new Ue(), this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new It();
  }
  static parse(t, r) {
    return new ht(r).parse(t);
  }
  static parseInline(t, r) {
    return new ht(r).parseInline(t);
  }
  parse(t, r = !0) {
    var s, l;
    let n = "";
    for (let u = 0; u < t.length; u++) {
      let i = t[u];
      if ((l = (s = this.options.extensions) == null ? void 0 : s.renderers) != null && l[i.type]) {
        let o = i, c = this.options.extensions.renderers[o.type].call({ parser: this }, o);
        if (c !== !1 || !["space", "hr", "heading", "code", "table", "blockquote", "list", "html", "def", "paragraph", "text"].includes(o.type)) {
          n += c || "";
          continue;
        }
      }
      let a = i;
      switch (a.type) {
        case "space": {
          n += this.renderer.space(a);
          continue;
        }
        case "hr": {
          n += this.renderer.hr(a);
          continue;
        }
        case "heading": {
          n += this.renderer.heading(a);
          continue;
        }
        case "code": {
          n += this.renderer.code(a);
          continue;
        }
        case "table": {
          n += this.renderer.table(a);
          continue;
        }
        case "blockquote": {
          n += this.renderer.blockquote(a);
          continue;
        }
        case "list": {
          n += this.renderer.list(a);
          continue;
        }
        case "html": {
          n += this.renderer.html(a);
          continue;
        }
        case "def": {
          n += this.renderer.def(a);
          continue;
        }
        case "paragraph": {
          n += this.renderer.paragraph(a);
          continue;
        }
        case "text": {
          let o = a, c = this.renderer.text(o);
          for (; u + 1 < t.length && t[u + 1].type === "text"; ) o = t[++u], c += `
` + this.renderer.text(o);
          r ? n += this.renderer.paragraph({ type: "paragraph", raw: c, text: c, tokens: [{ type: "text", raw: c, text: c, escaped: !0 }] }) : n += c;
          continue;
        }
        default: {
          let o = 'Token with "' + a.type + '" type was not found.';
          if (this.options.silent) return console.error(o), "";
          throw new Error(o);
        }
      }
    }
    return n;
  }
  parseInline(t, r = this.renderer) {
    var s, l;
    let n = "";
    for (let u = 0; u < t.length; u++) {
      let i = t[u];
      if ((l = (s = this.options.extensions) == null ? void 0 : s.renderers) != null && l[i.type]) {
        let o = this.options.extensions.renderers[i.type].call({ parser: this }, i);
        if (o !== !1 || !["escape", "html", "link", "image", "strong", "em", "codespan", "br", "del", "text"].includes(i.type)) {
          n += o || "";
          continue;
        }
      }
      let a = i;
      switch (a.type) {
        case "escape": {
          n += r.text(a);
          break;
        }
        case "html": {
          n += r.html(a);
          break;
        }
        case "link": {
          n += r.link(a);
          break;
        }
        case "image": {
          n += r.image(a);
          break;
        }
        case "strong": {
          n += r.strong(a);
          break;
        }
        case "em": {
          n += r.em(a);
          break;
        }
        case "codespan": {
          n += r.codespan(a);
          break;
        }
        case "br": {
          n += r.br(a);
          break;
        }
        case "del": {
          n += r.del(a);
          break;
        }
        case "text": {
          n += r.text(a);
          break;
        }
        default: {
          let o = 'Token with "' + a.type + '" type was not found.';
          if (this.options.silent) return console.error(o), "";
          throw new Error(o);
        }
      }
    }
    return n;
  }
}, lt, Ie = (lt = class {
  constructor(e) {
    w(this, "options");
    w(this, "block");
    this.options = e || fe;
  }
  preprocess(e) {
    return e;
  }
  postprocess(e) {
    return e;
  }
  processAllTokens(e) {
    return e;
  }
  provideLexer() {
    return this.block ? X.lex : X.lexInline;
  }
  provideParser() {
    return this.block ? Y.parse : Y.parseInline;
  }
}, w(lt, "passThroughHooks", /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens"])), lt), Os = class {
  constructor(...e) {
    w(this, "defaults", $t());
    w(this, "options", this.setOptions);
    w(this, "parse", this.parseMarkdown(!0));
    w(this, "parseInline", this.parseMarkdown(!1));
    w(this, "Parser", Y);
    w(this, "Renderer", Ue);
    w(this, "TextRenderer", It);
    w(this, "Lexer", X);
    w(this, "Tokenizer", Qe);
    w(this, "Hooks", Ie);
    this.use(...e);
  }
  walkTokens(e, t) {
    var n, s;
    let r = [];
    for (let l of e) switch (r = r.concat(t.call(this, l)), l.type) {
      case "table": {
        let u = l;
        for (let i of u.header) r = r.concat(this.walkTokens(i.tokens, t));
        for (let i of u.rows) for (let a of i) r = r.concat(this.walkTokens(a.tokens, t));
        break;
      }
      case "list": {
        let u = l;
        r = r.concat(this.walkTokens(u.items, t));
        break;
      }
      default: {
        let u = l;
        (s = (n = this.defaults.extensions) == null ? void 0 : n.childTokens) != null && s[u.type] ? this.defaults.extensions.childTokens[u.type].forEach((i) => {
          let a = u[i].flat(1 / 0);
          r = r.concat(this.walkTokens(a, t));
        }) : u.tokens && (r = r.concat(this.walkTokens(u.tokens, t)));
      }
    }
    return r;
  }
  use(...e) {
    let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
    return e.forEach((r) => {
      let n = { ...r };
      if (n.async = this.defaults.async || n.async || !1, r.extensions && (r.extensions.forEach((s) => {
        if (!s.name) throw new Error("extension name required");
        if ("renderer" in s) {
          let l = t.renderers[s.name];
          l ? t.renderers[s.name] = function(...u) {
            let i = s.renderer.apply(this, u);
            return i === !1 && (i = l.apply(this, u)), i;
          } : t.renderers[s.name] = s.renderer;
        }
        if ("tokenizer" in s) {
          if (!s.level || s.level !== "block" && s.level !== "inline") throw new Error("extension level must be 'block' or 'inline'");
          let l = t[s.level];
          l ? l.unshift(s.tokenizer) : t[s.level] = [s.tokenizer], s.start && (s.level === "block" ? t.startBlock ? t.startBlock.push(s.start) : t.startBlock = [s.start] : s.level === "inline" && (t.startInline ? t.startInline.push(s.start) : t.startInline = [s.start]));
        }
        "childTokens" in s && s.childTokens && (t.childTokens[s.name] = s.childTokens);
      }), n.extensions = t), r.renderer) {
        let s = this.defaults.renderer || new Ue(this.defaults);
        for (let l in r.renderer) {
          if (!(l in s)) throw new Error(`renderer '${l}' does not exist`);
          if (["options", "parser"].includes(l)) continue;
          let u = l, i = r.renderer[u], a = s[u];
          s[u] = (...o) => {
            let c = i.apply(s, o);
            return c === !1 && (c = a.apply(s, o)), c || "";
          };
        }
        n.renderer = s;
      }
      if (r.tokenizer) {
        let s = this.defaults.tokenizer || new Qe(this.defaults);
        for (let l in r.tokenizer) {
          if (!(l in s)) throw new Error(`tokenizer '${l}' does not exist`);
          if (["options", "rules", "lexer"].includes(l)) continue;
          let u = l, i = r.tokenizer[u], a = s[u];
          s[u] = (...o) => {
            let c = i.apply(s, o);
            return c === !1 && (c = a.apply(s, o)), c;
          };
        }
        n.tokenizer = s;
      }
      if (r.hooks) {
        let s = this.defaults.hooks || new Ie();
        for (let l in r.hooks) {
          if (!(l in s)) throw new Error(`hook '${l}' does not exist`);
          if (["options", "block"].includes(l)) continue;
          let u = l, i = r.hooks[u], a = s[u];
          Ie.passThroughHooks.has(l) ? s[u] = (o) => {
            if (this.defaults.async) return Promise.resolve(i.call(s, o)).then((h) => a.call(s, h));
            let c = i.call(s, o);
            return a.call(s, c);
          } : s[u] = (...o) => {
            let c = i.apply(s, o);
            return c === !1 && (c = a.apply(s, o)), c;
          };
        }
        n.hooks = s;
      }
      if (r.walkTokens) {
        let s = this.defaults.walkTokens, l = r.walkTokens;
        n.walkTokens = function(u) {
          let i = [];
          return i.push(l.call(this, u)), s && (i = i.concat(s.call(this, u))), i;
        };
      }
      this.defaults = { ...this.defaults, ...n };
    }), this;
  }
  setOptions(e) {
    return this.defaults = { ...this.defaults, ...e }, this;
  }
  lexer(e, t) {
    return X.lex(e, t ?? this.defaults);
  }
  parser(e, t) {
    return Y.parse(e, t ?? this.defaults);
  }
  parseMarkdown(e) {
    return (t, r) => {
      let n = { ...r }, s = { ...this.defaults, ...n }, l = this.onError(!!s.silent, !!s.async);
      if (this.defaults.async === !0 && n.async === !1) return l(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
      if (typeof t > "u" || t === null) return l(new Error("marked(): input parameter is undefined or null"));
      if (typeof t != "string") return l(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(t) + ", string expected"));
      s.hooks && (s.hooks.options = s, s.hooks.block = e);
      let u = s.hooks ? s.hooks.provideLexer() : e ? X.lex : X.lexInline, i = s.hooks ? s.hooks.provideParser() : e ? Y.parse : Y.parseInline;
      if (s.async) return Promise.resolve(s.hooks ? s.hooks.preprocess(t) : t).then((a) => u(a, s)).then((a) => s.hooks ? s.hooks.processAllTokens(a) : a).then((a) => s.walkTokens ? Promise.all(this.walkTokens(a, s.walkTokens)).then(() => a) : a).then((a) => i(a, s)).then((a) => s.hooks ? s.hooks.postprocess(a) : a).catch(l);
      try {
        s.hooks && (t = s.hooks.preprocess(t));
        let a = u(t, s);
        s.hooks && (a = s.hooks.processAllTokens(a)), s.walkTokens && this.walkTokens(a, s.walkTokens);
        let o = i(a, s);
        return s.hooks && (o = s.hooks.postprocess(o)), o;
      } catch (a) {
        return l(a);
      }
    };
  }
  onError(e, t) {
    return (r) => {
      if (r.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
        let n = "<p>An error occurred:</p><pre>" + j(r.message + "", !0) + "</pre>";
        return t ? Promise.resolve(n) : n;
      }
      if (t) return Promise.reject(r);
      throw r;
    };
  }
}, ue = new Os();
function k(e, t) {
  return ue.parse(e, t);
}
k.options = k.setOptions = function(e) {
  return ue.setOptions(e), k.defaults = ue.defaults, zr(k.defaults), k;
};
k.getDefaults = $t;
k.defaults = fe;
k.use = function(...e) {
  return ue.use(...e), k.defaults = ue.defaults, zr(k.defaults), k;
};
k.walkTokens = function(e, t) {
  return ue.walkTokens(e, t);
};
k.parseInline = ue.parseInline;
k.Parser = Y;
k.parser = Y.parse;
k.Renderer = Ue;
k.TextRenderer = It;
k.Lexer = X;
k.lexer = X.lex;
k.Tokenizer = Qe;
k.Hooks = Ie;
k.parse = k;
k.options;
k.setOptions;
k.use;
k.walkTokens;
k.parseInline;
Y.parse;
X.lex;
function Zs(e, t) {
  e.key === "Enter" && !e.shiftKey && (e.preventDefault(), t());
}
const OQ_MARKDOWN_ALLOWED_TAGS = new Set([
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "img", "li", "ol", "p", "pre", "s", "span", "strong", "table", "tbody", "td",
  "th", "thead", "tr", "ul"
]), OQ_MARKDOWN_ALLOWED_ATTRS = {
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "title"]),
  code: new Set(["class"]),
  td: new Set(["align"]),
  th: new Set(["align"])
}, OQ_MARKDOWN_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
function isSafeMarkdownUrl(e, t) {
  const r = String(e || "").trim();
  if (!r || r.replace(/[\u0000-\u001F\u007F\s]+/g, "").toLowerCase().startsWith("javascript:")) return !1;
  if (t === "src" && /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/]+=*$/i.test(r)) return !0;
  try {
    return OQ_MARKDOWN_URL_PROTOCOLS.has(new URL(r, window.location.href).protocol);
  } catch {
    return !1;
  }
}
function sanitizeRenderedMarkdown(e) {
  const t = document.createElement("template");
  t.innerHTML = String(e || "");
  const r = document.createTreeWalker(t.content, NodeFilter.SHOW_ELEMENT), n = [];
  for (; r.nextNode(); ) {
    const s = r.currentNode, l = s.localName;
    if (!OQ_MARKDOWN_ALLOWED_TAGS.has(l)) {
      n.push(s);
      continue;
    }
    for (const u of Array.from(s.attributes)) {
      const i = u.name.toLowerCase(), a = OQ_MARKDOWN_ALLOWED_ATTRS[l] || new Set();
      if (i.startsWith("on") || !a.has(i)) {
        s.removeAttribute(u.name);
        continue;
      }
      if ((i === "href" || i === "src") && !isSafeMarkdownUrl(u.value, i)) {
        s.removeAttribute(u.name);
        continue;
      }
      if (l === "code" && i === "class" && !/^language-[A-Za-z0-9_-]+$/.test(u.value)) s.removeAttribute(u.name);
      if ((l === "td" || l === "th") && i === "align" && !/^(left|center|right)$/i.test(u.value)) s.removeAttribute(u.name);
    }
    if (l === "a" && s.hasAttribute("href")) {
      s.setAttribute("target", "_blank");
      s.setAttribute("rel", "noopener noreferrer");
    }
  }
  for (const s of n) s.replaceWith(document.createTextNode(s.textContent || ""));
  return t.innerHTML;
}
var Fs = /* @__PURE__ */ Lr('<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="svelte-1665k1s"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" class="svelte-1665k1s"></path><circle cx="12" cy="7" r="4" class="svelte-1665k1s"></circle></svg>'), Hs = /* @__PURE__ */ Lr('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="svelte-1665k1s"><path d="M12 2L2 7L12 12L22 7L12 2Z" class="svelte-1665k1s"></path><path d="M2 17L12 22L22 17" class="svelte-1665k1s"></path><path d="M2 12L12 17L22 12" class="svelte-1665k1s"></path></svg>'), js = /* @__PURE__ */ Tt('<div><div><!></div> <div class="message markdown-content svelte-1665k1s"><!></div></div>'), Qs = /* @__PURE__ */ Tt('<div class="message-wrapper assistant svelte-1665k1s"><div class="avatar assistant svelte-1665k1s"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="svelte-1665k1s"><path d="M12 2L2 7L12 12L22 7L12 2Z" class="svelte-1665k1s"></path><path d="M2 17L12 22L22 17" class="svelte-1665k1s"></path><path d="M2 12L12 17L22 12" class="svelte-1665k1s"></path></svg></div> <div class="loading-dots svelte-1665k1s"><div class="loading-dot svelte-1665k1s"></div> <div class="loading-dot svelte-1665k1s"></div> <div class="loading-dot svelte-1665k1s"></div></div></div>'), Us = /* @__PURE__ */ Tt('<div class="wrapper svelte-1665k1s"><div class="header svelte-1665k1s"><div class="header-icon svelte-1665k1s"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="svelte-1665k1s"><path d="M12 2L2 7L12 12L22 7L12 2Z" class="svelte-1665k1s"></path><path d="M2 17L12 22L22 17" class="svelte-1665k1s"></path><path d="M2 12L12 17L22 12" class="svelte-1665k1s"></path></svg></div> <div class="header-title svelte-1665k1s"> </div></div> <div class="messages svelte-1665k1s"><!> <!></div> <div class="input-container svelte-1665k1s"><form class="svelte-1665k1s"><div class="input-wrapper svelte-1665k1s"><textarea placeholder="Send a message..." class="svelte-1665k1s"></textarea> <button type="submit" aria-label="Send message" class="svelte-1665k1s"><svg class="send-icon svelte-1665k1s" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" class="svelte-1665k1s"></path></svg></button></div></form></div></div>');
function Vs(e, t) {
  rr(t, !0);
  let r = /* @__PURE__ */ D(ae([])), n = /* @__PURE__ */ D(""), s = /* @__PURE__ */ D(!1), l, u = "", i = /* @__PURE__ */ D("gpt-4o-mini"), a = "/api/chat/completions";
  k.setOptions({ breaks: !0, gfm: !0 });
  function o(x) {
    return sanitizeRenderedMarkdown(k.parse(x));
  }
  Gn(() => {
    try {
      const x = window.bedrockChatRuntimeConfig || {}, T = x.apiKey, V = x.model, K = x.endpoint;
      T !== void 0 && (u = T), V !== void 0 && E(i, V, !0), K !== void 0 && (a = K);
    } catch (x) {
      console.error("Error processing query parameters in onMount:", x);
    }
  }), gr(() => {
    y(r).length && l && setTimeout(
      () => {
        l.scrollTop = l.scrollHeight;
      },
      100
    );
  });
  async function c() {
    var T, V, K;
    const x = y(n).trim();
    if (!(!x || y(s))) {
      E(
        r,
        [
          ...y(r),
          { role: "user", content: x }
        ],
        !0
      ), E(n, ""), E(s, !0);
      try {
        const xe = await (await fetch(a, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${u}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: y(i),
            messages: [{ role: "user", content: x }]
          })
        })).json(), et = ((K = (V = (T = xe == null ? void 0 : xe.choices) == null ? void 0 : T[0]) == null ? void 0 : V.message) == null ? void 0 : K.content) ?? "⚠️ Error retrieving response";
        E(
          r,
          [
            ...y(r),
            { role: "assistant", content: et }
          ],
          !0
        );
      } catch {
        E(
          r,
          [
            ...y(r),
            {
              role: "assistant",
              content: "⚠️ Network error"
            }
          ],
          !0
        );
      } finally {
        E(s, !1);
      }
    }
  }
  function h(x) {
    const T = x.target;
    T.style.height = "auto", T.style.height = Math.min(T.scrollHeight, 120) + "px";
  }
  var f = Us(), p = H(f), d = pe(H(p), 2), g = H(d), $ = pe(p, 2), v = H($);
  Xn(v, 17, () => y(r), Vn, (x, T) => {
    var V = js(), K = H(V), Je = H(K);
    {
      var xe = (he) => {
        var tt = Fs();
        we(he, tt);
      }, et = (he) => {
        var tt = Hs();
        we(he, tt);
      };
      Ft(Je, (he) => {
        y(T).role === "user" ? he(xe) : he(et, !1);
      });
    }
    var Fr = pe(K, 2), Hr = H(Fr);
    ts(Hr, () => o(y(T).content)), at(() => {
      jt(V, 1, `message-wrapper ${y(T).role ?? ""}`, "svelte-1665k1s"), jt(K, 1, `avatar ${y(T).role ?? ""}`, "svelte-1665k1s");
    }), we(x, V);
  });
  var S = pe(v, 2);
  {
    var O = (x) => {
      var T = Qs();
      we(x, T);
    };
    Ft(S, (x) => {
      y(s) && x(O);
    });
  }
  ss($, (x) => l = x, () => l);
  var G = pe($, 2), q = H(G), te = H(q), R = H(te);
  R.__keydown = [Zs, c], R.__input = h;
  var _e = pe(R, 2);
  at(
    (x) => {
      Qn(g, y(i)), R.disabled = y(s), _e.disabled = x;
    },
    [
      () => !y(n).trim() || y(s)
    ]
  ), On("submit", q, (x) => {
    x.preventDefault(), c();
  }), ns(R, () => y(n), (x) => E(n, x)), we(e, f), nr();
}
Zn(["keydown", "input"]);
export {
  Vs as ChatWidget,
  Vs as default,
  Gs as mount
};
