/**
 * Minimal DOM Stub - reply-UI tests
 *
 * openReplyBox() needs `document.querySelector`, `Element.querySelector`,
 * `Element.contains`, `isConnected`, `getAttribute` and `click()`. There is no
 * jsdom here and the project has no npm dependencies, so this implements exactly
 * that surface — enough to reproduce the real failure, nothing more.
 *
 * The selector engine supports what the adapter actually queries: comma-separated
 * groups, descendant combinators, tag names, #id, .class and [attr] / [attr="v"].
 */

/** Parse a single compound selector (`div#id.cls[attr="v"]`). */
function parseCompound(token) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([#.]?[\w-]+)|(\[[^\]]*\])/g;
  let m;
  while ((m = re.exec(token)) !== null) {
    const t = m[0];
    if (t.charAt(0) === '#') out.id = t.slice(1);
    else if (t.charAt(0) === '.') out.classes.push(t.slice(1));
    else if (t.charAt(0) === '[') {
      const body = t.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq === -1) out.attrs.push([body.trim(), null]);
      else {
        out.attrs.push([
          body.slice(0, eq).trim(),
          body.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
        ]);
      }
    } else out.tag = t.toUpperCase();
  }
  return out;
}

/** Parse a full selector into groups of descendant steps. */
function parseSelector(selector) {
  return String(selector)
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean)
    .map((group) => group.split(/\s+/).map(parseCompound));
}

function matchesCompound(node, spec) {
  if (spec.tag && node.tagName !== spec.tag) return false;
  if (spec.id && node.attrs.id !== spec.id) return false;
  for (const cls of spec.classes) {
    if ((node.attrs.class || '').split(/\s+/).indexOf(cls) === -1) return false;
  }
  for (const [name, value] of spec.attrs) {
    if (!(name in node.attrs)) return false;
    if (value !== null && node.attrs[name] !== value) return false;
  }
  return true;
}

/** Match one descendant group against a node, right to left. */
function matchesGroup(node, steps) {
  if (!matchesCompound(node, steps[steps.length - 1])) return false;
  let current = node.parent;
  for (let i = steps.length - 2; i >= 0; i--) {
    let found = false;
    while (current) {
      if (matchesCompound(current, steps[i])) { found = true; break; }
      current = current.parent;
    }
    if (!found) return false;
    current = current ? current.parent : null;
  }
  return true;
}

/** Depth-first list of every descendant of `node`, in document order. */
function descendants(node, out) {
  for (const child of node.children) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

class FakeElement {
  /**
   * @param {string} tag
   * @param {Object} [attrs]
   * @param {Array<FakeElement|string>} [children]
   */
  constructor(tag, attrs = {}, children = []) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = Object.assign({}, attrs);
    this.children = [];
    this.parent = null;
    this.isConnected = false;
    this.textContent = '';
    this.clicked = 0;
    this.focused = 0;
    /** Called on click() — lets a test simulate YouTube re-rendering the thread. */
    this.onClick = null;
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
    if (typeof child === 'string') {
      this.textContent += child;
      return child;
    }
    child.parent = this;
    this.children.push(child);
    child.setConnected(this.isConnected);
    return child;
  }

  /** Attach or detach this subtree from the stub document. */
  setConnected(connected) {
    this.isConnected = connected;
    for (const child of this.children) child.setConnected(connected);
  }

  /**
   * Remove this node from the document, exactly as a real DOM replacement does.
   *
   * `setConnected(false)` only flips the flag, so the node would stay reachable by
   * querySelector — which would hide the very bug this suite reproduces. Every test
   * that simulates a re-render must use this.
   */
  detach() {
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index !== -1) this.parent.children.splice(index, 1);
      this.parent = null;
    }
    this.setConnected(false);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }

  matches(selector) {
    return parseSelector(selector).some((steps) => matchesGroup(this, steps));
  }

  /** Nearest ancestor-or-self matching `selector`. */
  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches && current.matches(selector)) return current;
      current = current.parent;
    }
    return null;
  }

  get parentElement() {
    return this.parent;
  }

  querySelectorAll(selector) {
    const groups = parseSelector(selector);
    return descendants(this, []).filter((node) => groups.some((steps) => matchesGroup(node, steps)));
  }

  querySelector(selector) {
    const found = this.querySelectorAll(selector);
    return found.length ? found[0] : null;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  }

  click() {
    this.clicked++;
    if (typeof this.onClick === 'function') this.onClick();
  }

  focus() {
    this.focused++;
  }
}

/**
 * Build a fresh stub document.
 *
 * @returns {{root: FakeElement, document: Object, el: Function, setTimeoutFast: Function}}
 */
function createStubDocument() {
  const root = new FakeElement('html', { id: 'stub-root' });
  root.setConnected(true);

  const document = {
    documentElement: root,
    body: root,
    querySelectorAll(selector) { return root.querySelectorAll(selector); },
    querySelector(selector) { return root.querySelector(selector); }
  };

  /**
   * `el('ytd-comment-thread-renderer', { id: 'x' }, child, 'text')`
   */
  function el(tag, attrs, ...children) {
    const node = new FakeElement(tag, attrs, children.filter(Boolean));
    root.appendChild(node);
    return node;
  }

  return { root, document, el, FakeElement };
}

export { createStubDocument, FakeElement };