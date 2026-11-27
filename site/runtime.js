/*
 * A very small template runtime for the site's two pages.
 *
 * The markup keeps the design's structure:
 *   <template data-for="list" data-as="item">…{{ item.x }}…</template>  repeats its content
 *   <template data-if="flag">…</template>                               shows its content when truthy
 *   {{ path }} in text or attributes outside templates                   is bound to a value
 *   data-on="{{ fn }}" / data-on="fn"                                     calls a function on click
 *   <sc-if value="{{ path }}">…</sc-if> inside a data-for template       conditional inside an item
 *
 * mount(root, view) calls view(state, set) to get the values and re-renders on every set().
 */
"use strict";

(function () {
  var EXPR = /\{\{\s*([\w.]+)\s*\}\}/g;

  function get(obj, path) {
    if (path === "true") return true;
    if (path === "false") return false;
    return path.split(".").reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  window.copier = function (set, id, text) {
    return function () {
      var done = function () {
        set({ copied: id });
        clearTimeout(window.__copyTimer);
        window.__copyTimer = setTimeout(function () { set({ copied: "" }); }, 1600);
      };
      var value = typeof text === "function" ? text() : text;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done, done);
        else done();
      } catch (e) { done(); }
    };
  };

  window.mount = function (root, view) {
    var state = {};
    var handlers = [];
    var vals = {};
    var blocks = [];
    var bindings = [];

    // Templates: remember each one and where its rendered nodes go.
    Array.prototype.forEach.call(root.querySelectorAll("template[data-for], template[data-if]"), function (t) {
      blocks.push({ el: t, html: t.innerHTML, list: t.getAttribute("data-for"), as: t.getAttribute("data-as"), cond: t.getAttribute("data-if"), nodes: [] });
    });

    // Bindings in text and attributes outside templates.
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        for (var p = n.parentNode; p && p !== root; p = p.parentNode) if (p.tagName === "TEMPLATE") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (var node = walker.currentNode; node; node = walker.nextNode()) {
      if (node.nodeType === 3) {
        if (node.nodeValue.indexOf("{{") !== -1) bindings.push({ node: node, tpl: node.nodeValue });
      } else if (node.tagName !== "TEMPLATE") {
        Array.prototype.forEach.call(node.attributes, function (a) {
          if (a.value.indexOf("{{") !== -1) bindings.push({ node: node, attr: a.name, tpl: a.value });
        });
      }
    }

    function fill(html, scope, key) {
      html = html.replace(/<sc-if value="\{\{\s*([\w.]+)\s*\}\}">([\s\S]*?)<\/sc-if>/g, function (_, path, inner) {
        return get(scope, path) ? inner : "";
      });
      return html.replace(/data-on="\{\{\s*([\w.]+)\s*\}\}"/g, function (_, path) {
        handlers.push(get(scope, path));
        return 'data-on="#' + (handlers.length - 1) + '" data-fid="' + key + ":" + path + '"';
      }).replace(EXPR, function (_, path) {
        var v = get(scope, path);
        return escapeHtml(v == null ? "" : v);
      });
    }

    function render() {
      var active = document.activeElement;
      var fid = active && root.contains(active) ? active.getAttribute("data-fid") : null;
      handlers = [];
      vals = view(state, set);

      blocks.forEach(function (b) {
        b.nodes.forEach(function (n) { n.remove(); });
        var html = "";
        if (b.list) {
          (get(vals, b.list) || []).forEach(function (item, i) {
            var scope = Object.create(vals);
            scope[b.as] = item;
            html += fill(b.html, scope, b.list + "." + i);
          });
        } else if (get(vals, b.cond)) {
          html = fill(b.html, vals, b.cond);
        }
        var range = document.createRange();
        range.selectNode(b.el);
        var frag = range.createContextualFragment(html);
        b.nodes = Array.prototype.slice.call(frag.childNodes);
        b.el.parentNode.insertBefore(frag, b.el.nextSibling);
      });

      bindings.forEach(function (b) {
        if (b.attr === "data-on") {
          var path = b.tpl.replace(EXPR, "$1");
          handlers.push(get(vals, path));
          b.node.setAttribute("data-on", "#" + (handlers.length - 1));
          return;
        }
        var text = b.tpl.replace(EXPR, function (_, path) {
          var v = get(vals, path);
          return v == null ? "" : String(v);
        });
        if (b.attr) b.node.setAttribute(b.attr, text);
        else b.node.nodeValue = text;
      });

      if (fid) {
        var again = root.querySelector('[data-fid="' + fid + '"]');
        if (again) again.focus({ preventScroll: true });
      }
    }

    function set(patch) {
      Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
      render();
    }

    root.addEventListener("click", function (e) {
      var el = e.target.closest("[data-on]");
      if (!el || !root.contains(el)) return;
      var ref = el.getAttribute("data-on");
      var fn = ref.charAt(0) === "#" ? handlers[Number(ref.slice(1))] : get(vals, ref);
      if (typeof fn === "function") fn(e);
    });
    root.addEventListener("input", function (e) {
      var key = e.target.getAttribute && e.target.getAttribute("data-input");
      if (key) { var patch = {}; patch[key] = e.target.value; set(patch); }
    });

    render();
    return { set: set, render: render };
  };
})();
