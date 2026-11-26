// Minimal DOM shim so we can run the dashboard JS under node and see the first
// runtime error without a browser.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

class ClassList {
  constructor(node) { this.node = node; }
  get set() { return new Set((this.node._class || "").split(/\s+/).filter(Boolean)); }
  save(s) { this.node._class = [...s].join(" "); }
  add(...c) { const s = this.set; c.forEach((x) => s.add(x)); this.save(s); }
  remove(...c) { const s = this.set; c.forEach((x) => s.delete(x)); this.save(s); }
  toggle(c) { const s = this.set; s.has(c) ? s.delete(c) : s.add(c); this.save(s); }
  contains(c) { return this.set.has(c); }
}

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this._class = "";
    this._text = "";
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.classList = new ClassList(this);
    this.style = {};
    this.value = "";
  }
  set className(v) { this._class = String(v); }
  get className() { return this._class; }
  set innerHTML(v) {
    this.children = [];
    this._html = String(v);
  }
  get innerHTML() { return this._html || ""; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(n) {
    // browsers throw on non-Node; mimic that so real bugs surface here
    if (!(n instanceof Node)) throw new TypeError("parameter 1 is not of type 'Node'");
    n.parentNode = this; this.children.push(n); return n;
  }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  dispatch(ev, arg = {}) { (this.listeners[ev] || []).forEach((f) => f(arg)); }
  click() { this.dispatch("click", {}); }
  querySelector(sel) { return find(this, sel)[0] || null; }
  querySelectorAll(sel) { return find(this, sel); }
  get firstChild() { return this.children[0] || null; }
  scrollIntoView() {}
  get clientWidth() { return this._cw === undefined ? 820 : this._cw; }
  set clientWidth(v) { this._cw = v; }
  get clientHeight() { return 200; }
  getContext(kind) {
    const noop = () => {};
    this._ctx = {
      canvas: this, fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", globalAlpha: 1,
      beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, stroke: noop, fill: noop,
      fillRect: noop, clearRect: noop, strokeRect: noop, arc: noop, save: noop, restore: noop,
      translate: noop, scale: noop, setTransform: noop, fillText: noop, measureText: () => ({ width: 10 }),
      createLinearGradient: () => ({ addColorStop: noop }), drawImage: noop, getImageData: () => ({ data: [] }),
      putImageData: noop, quadraticCurveTo: noop, bezierCurveTo: noop, setLineDash: noop,
    };
    return this._ctx;
  }
  focus() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100, bottom: 100, right: 100 }; }
}

function walk(root, out = []) {
  for (const c of root.children || []) { out.push(c); walk(c, out); }
  return out;
}

function match(node, sel) {
  // supports "#id", ".cls", "tag", and comma lists — enough for this app
  for (const part of sel.split(",").map((s) => s.trim())) {
    if (!part) continue;
    let ok = true;
    for (const b of part.trim().split(/\s+(?=[#.])/)) {
      if (b.startsWith("#")) ok = ok && node.id === b.slice(1);
      else if (b.startsWith(".")) ok = ok && node.classList.contains(b.slice(1));
      else ok = ok && node.tagName === b.toUpperCase();
    }
    if (ok) return true;
  }
  return false;
}

function find(root, sel) { return walk(root).filter((n) => match(n, sel)); }

export function makeDom(rootHtml = "") {
  const doc = new Node("#document");
  doc.documentElement = doc;
  doc.createElement = (t) => new Node(t);
  doc.createTextNode = (t) => { const n = new Node("#text"); n.nodeType = 3; n._text = String(t); return n; };
  doc.createElementNS = (ns, t) => new Node(t);
  doc.body = doc.appendChild(new Node("body"));
  doc.head = doc.appendChild(new Node("head"));
  doc.getElementById = (id) => walk(doc).find((n) => n.id === id) || null;
  doc.querySelector = (s) => find(doc, s)[0] || null;
  doc.querySelectorAll = (s) => find(doc, s);
  doc.addEventListener = (ev, fn) => { (doc.listeners[ev] = doc.listeners[ev] || []).push(fn); };
  doc.readyState = "complete";
  // build the real index.html element tree so ids exist
  const html = fs.readFileSync(rootHtml, "utf8");
  const idRe = /<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g;
  const seen = new Set();
  let m;
  while ((m = idRe.exec(html))) {
    if (seen.has(m[3])) continue;
    seen.add(m[3]);
    const n = doc.body.appendChild(new Node(m[1]));
    n.setAttribute("id", m[3]);
    const cls = /class="([^"]+)"/.exec(m[2]);
    if (cls) n.className = cls[1];
  }
  return { doc, Node, find, walk };
}
