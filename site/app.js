"use strict";

/* Release the snippets point at. Updated on each release. */
var RELEASE = { repo: "maxbenschop/pr-trust", tag: "v0.1.1", sha: "00e722ff4f51d4bdf2b1ed89316b741ef5cf0ac6" };

/* Backtest of the default rules (own list, then 1 merged PR here within 24 months),
   outside PRs opened 2025-11-27 to 2026-11-27. From results/all.json. */
var RESULTS = [{"repo":"ghostty-org/ghostty","own":true,"external":944,"admitted":557,"unknown":386,"denounced":1,"uMerged":105,"uRejected":63,"uWithdrawn":28,"uBot":178,"uOpen":12},{"repo":"netbox-community/netbox","own":true,"external":170,"admitted":91,"unknown":79,"denounced":0,"uMerged":41,"uRejected":26,"uWithdrawn":7,"uBot":5,"uOpen":0},{"repo":"cloudflare/workers-sdk","own":true,"external":708,"admitted":224,"unknown":484,"denounced":0,"uMerged":270,"uRejected":102,"uWithdrawn":48,"uBot":34,"uOpen":30},{"repo":"juanfont/headscale","own":true,"external":180,"admitted":34,"unknown":146,"denounced":0,"uMerged":43,"uRejected":56,"uWithdrawn":14,"uBot":18,"uOpen":15},{"repo":"triggerdotdev/trigger.dev","own":true,"external":414,"admitted":37,"unknown":377,"denounced":0,"uMerged":10,"uRejected":15,"uWithdrawn":11,"uBot":332,"uOpen":9},{"repo":"facebook/react","own":false,"external":1257,"admitted":184,"unknown":1073,"denounced":0,"uMerged":71,"uRejected":123,"uWithdrawn":183,"uBot":301,"uOpen":395},{"repo":"sveltejs/svelte","own":false,"external":545,"admitted":130,"unknown":415,"denounced":0,"uMerged":137,"uRejected":106,"uWithdrawn":46,"uBot":0,"uOpen":126},{"repo":"astral-sh/uv","own":false,"external":756,"admitted":130,"unknown":626,"denounced":0,"uMerged":128,"uRejected":168,"uWithdrawn":71,"uBot":64,"uOpen":195},{"repo":"tailwindlabs/tailwindcss","own":false,"external":308,"admitted":71,"unknown":237,"denounced":0,"uMerged":83,"uRejected":91,"uWithdrawn":18,"uBot":0,"uOpen":45},{"repo":"denoland/deno","own":false,"external":734,"admitted":222,"unknown":512,"denounced":0,"uMerged":149,"uRejected":110,"uWithdrawn":62,"uBot":0,"uOpen":191}];

var TAG = {
  admitted: { text: "trust: admitted", bg: "#35D07F", fg: "#06150C", bd: "#35D07F", ls: "solid" },
  unknown: { text: "trust: unknown", bg: "transparent", fg: "#D5DAD7", bd: "#848D88", ls: "dashed" },
  denounced: { text: "trust: denounced", bg: "#3D1218", fg: "#FF8087", bd: "#3D1218", ls: "solid" },
  none: { text: "no label", bg: "transparent", fg: "#A8B0AB", bd: "#343B37", ls: "solid" }
};

var lists = null; // from lists.json
var builtAt = null;

function num(n) { return Number(n).toLocaleString("en-US"); }

function ago(iso) {
  var days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return days + " days ago";
  var months = Math.round(days / 30.4);
  if (months < 12) return months === 1 ? "a month ago" : months + " months ago";
  var years = Math.round(days / 365);
  return years === 1 ? "a year ago" : years + " years ago";
}

function view(st, set) {
  var picked = st.picked || { "ghostty-org/ghostty": true };
  var merged = st.merged !== false;
  var docs = !!st.docs;
  var unknown = st.unknown || "comment";
  var den = st.den || "close";
  var who = st.who || "newcomer";
  var file = st.file || "rules";
  var copied = st.copied || "";
  var proj = st.proj || RESULTS[0].repo;

  function copyLabel(id, idle) { return copied === id ? "Copied" : idle; }

  /* ---------------------------------------------------------- how it decides */
  var ruleDefs = [
    { text: "Bot, or someone with write access", res: "none" },
    { text: "Denounced on your own list", res: "denounced" },
    { text: "Vouched on your own list", res: "admitted" },
    { text: "Vouched on a shared list you accept", res: "admitted" },
    { text: "Merged a pull request here in the last 24 months", res: "admitted" },
    { text: "Only changes paths you exempted", res: "admitted" },
    { text: "Everyone else", res: "unknown" }
  ];
  var peopleDefs = [
    { id: "maintainer", name: "sigrid-aasen", desc: "Maintainer with write access", hit: 0 },
    { id: "bad", name: "xk-9911", desc: "Denounced on your own VOUCHED.td", hit: 1 },
    { id: "own", name: "hanne-vik", desc: "Vouched on your own VOUCHED.td", hit: 2 },
    { id: "shared", name: "tomasz-wrobel", desc: "Vouched on ghostty-org/ghostty", hit: 3 },
    { id: "track", name: "lena-park", desc: "Two merged pull requests here this year", hit: 4 },
    { id: "newcomer", name: "mirelle-okafor", desc: "First pull request, on no list", hit: 6 }
  ];
  var cur = peopleDefs.filter(function (p) { return p.id === who; })[0] || peopleDefs[5];
  var people = peopleDefs.map(function (p) {
    var on = p.id === cur.id;
    return { name: p.name, desc: p.desc, on: on, bg: on ? "#151918" : "transparent", bd: on ? "#35D07F" : "#222826", pick: function () { set({ who: p.id }); } };
  });
  var ruleRows = ruleDefs.map(function (r, i) {
    var isHit = i === cur.hit;
    return {
      text: r.text, isHit: isHit, isPassed: i < cur.hit, isAfter: i > cur.hit,
      bg: isHit ? "#10281B" : "transparent",
      fg: isHit ? "#F2F5F3" : (i < cur.hit ? "#A8B0AB" : "#848D88"),
      weight: isHit ? 600 : 400,
      tag: TAG[r.res]
    };
  });

  /* ---------------------------------------------------------- install */
  var releaseRef = RELEASE.repo + "@" + RELEASE.sha;
  var tabs = [
    { id: "rules", label: "trust.yml" },
    { id: "flow", label: "workflows/pr-trust.yml" },
    { id: "commit", label: "commit" }
  ].map(function (t) {
    var on = t.id === file;
    return { label: t.label, on: on, fg: on ? "#F2F5F3" : "#8FA89A", bd: on ? "#35D07F" : "transparent", pick: function () { set({ file: t.id }); } };
  });
  var fileText = {
    rules: "# .github/trust.yml\nown_list: auto # .github/VOUCHED.td, if you have one\nadmit:\n  - list: ghostty-org/ghostty # a shared list you trust\n  - merged: { repo: self, min: 1, within: 24mo }\non_unknown: label # nothing is closed\non_denounced: close\ncomment: unknown # explain how to get vouched\n",
    flow: "# .github/workflows/pr-trust.yml\nname: Contributor trust\n\non:\n  pull_request_target: # never checks out PR code\n    types: [opened, reopened]\n\npermissions:\n  contents: read\n  pull-requests: write\n\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: " + releaseRef + " # " + RELEASE.tag + "\n",
    commit: 'git add .github/trust.yml .github/workflows/pr-trust.yml\ngit commit -m "Label pull requests by contributor trust"\ngit push\n'
  };

  /* ---------------------------------------------------------- directory */
  var all = (lists || []).slice().sort(function (a, b) { return (b.stars || 0) - (a.stars || 0); });
  var filter = (st.filter || "").trim().toLowerCase();
  var shown = all.filter(function (l) {
    return !filter || [l.repo, l.description || "", l.language || ""].join(" ").toLowerCase().indexOf(filter) !== -1;
  });
  var showAll = !!st.showAll || !!filter;
  var visible = showAll ? shown : shown.slice(0, 6);
  function toggle(repo) {
    return function () {
      var next = Object.assign({}, picked);
      next[repo] = !picked[repo];
      set({ picked: next });
    };
  }
  var dirRows = visible.map(function (l) {
    var on = !!picked[l.ref];
    return {
      repo: l.repo, url: l.url, v: num(l.vouched), d: num(l.denounced), up: ago(l.updatedAt), on: on,
      btn: on ? "In your rules" : "Add to rules",
      btnBg: on ? "#10281B" : "transparent", btnFg: on ? "#7BE3A6" : "#F2F5F3", btnBd: on ? "#1A4A31" : "#343B37",
      toggle: toggle(l.ref)
    };
  });
  var pickedRefs = Object.keys(picked).filter(function (k) { return picked[k]; });
  var pickedLine = pickedRefs.length === 1 ? "1 shared list is in your rules." : pickedRefs.length + " shared lists are in your rules.";
  var buildLine = builtAt
    ? "Last build: " + new Date(builtAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(",", "")
    : "";

  /* ---------------------------------------------------------- builder */
  var top = all.slice(0, 4).map(function (l) { return l.ref; });
  var builderRefs = top.concat(pickedRefs.filter(function (r) { return top.indexOf(r) === -1; }));
  if (!lists) builderRefs = pickedRefs;
  function box(on) { return { boxBg: on ? "#35D07F" : "#080A09", boxBd: on ? "#35D07F" : "#848D88" }; }
  var listItems = builderRefs.map(function (ref) {
    var l = all.filter(function (x) { return x.ref === ref; })[0];
    var on = !!picked[ref];
    return Object.assign({ repo: ref, note: l ? num(l.vouched) + " vouched" : "shared list", on: on, toggle: toggle(ref) }, box(on));
  });
  listItems.push(Object.assign({
    repo: "merged here", note: "1 merged pull request in this repo in the last 24 months", on: merged,
    toggle: function () { set({ merged: !merged }); }
  }, box(merged)));
  var extras = [Object.assign({
    repo: "docs and *.md", note: "anyone may change only docs/ or Markdown files", on: docs,
    toggle: function () { set({ docs: !docs }); }
  }, box(docs))];

  function radio(on) { return on ? "#35D07F" : "#848D88"; }
  var actions = [
    { id: "label", label: "Label only" },
    { id: "comment", label: "Label and explain how to get vouched" },
    { id: "close", label: "Close with a comment" }
  ].map(function (a) { return { label: a.label, on: unknown === a.id, boxBd: radio(unknown === a.id), pick: function () { set({ unknown: a.id }); } }; });
  var denActions = [
    { id: "label", label: "Label only" },
    { id: "close", label: "Close the pull request" }
  ].map(function (a) { return { label: a.label, on: den === a.id, boxBd: radio(den === a.id), pick: function () { set({ den: a.id }); } }; });

  var lines = [];
  var yamlText = "";
  function flat(t) { lines.push({ text: t, flat: true, indent: false, comment: false }); yamlText += t + "\n"; }
  function indent(t) { lines.push({ text: t, flat: false, indent: true, comment: false }); yamlText += "  " + t + "\n"; }
  function comment(t) { lines.push({ text: t, flat: false, indent: false, comment: true }); yamlText += t + "\n"; }
  flat("own_list: auto");
  var admit = pickedRefs.map(function (r) { return "- list: " + r; });
  if (merged) admit.push("- merged: { repo: self, within: 24mo }");
  if (admit.length) { flat("admit:"); admit.forEach(indent); } else flat("admit: []");
  if (docs) {
    comment("# PRs touching only these: admitted");
    flat("exempt_paths:");
    indent('- "docs/**"');
    indent('- "**/*.md"');
  }
  if (unknown === "close") comment("# unknown: closed, with a comment");
  else if (unknown === "comment") comment("# unknown: told how to get vouched");
  else comment("# unknown: labelled, nothing closed");
  flat("on_unknown: " + (unknown === "close" ? "close" : "label"));
  flat("on_denounced: " + den);
  flat("comment: " + (unknown === "label" ? "never" : "unknown"));

  var listA = builderRefs[0] || "ghostty-org/ghostty";
  function vouchedOf(ref) { var l = all.filter(function (x) { return x.ref === ref; })[0]; return l ? l.vouched : 0; }
  var listB = builderRefs.filter(function (r) { return r !== listA && !picked[r]; }).sort(function (a, b) { return vouchedOf(b) - vouchedOf(a); })[0] || builderRefs[1] || listA;
  var none = "on no list you accept";
  function outcome(kind) {
    if (kind === "admitted") return "Stays open";
    var close = kind === "denounced" ? den === "close" : unknown === "close";
    if (close) return "Closed with a comment";
    return unknown === "label" ? "Stays open" : "Open, comment posted";
  }
  var preview = [
    { name: "hanne-vik", kind: "admitted", why: "on your own list" },
    { name: "tomasz-wrobel", kind: picked[listA] ? "admitted" : "unknown", why: picked[listA] ? "vouched on " + listA : none },
    { name: "ines-carvalho", kind: picked[listB] ? "admitted" : "unknown", why: picked[listB] ? "vouched on " + listB : none },
    { name: "lena-park", kind: merged ? "admitted" : "unknown", why: merged ? "2 merged pull requests here" : "has merged work, but you don't count it" },
    { name: "xk-9911", kind: "denounced", why: "denounced on your own list" },
    { name: "mirelle-okafor", kind: docs ? "admitted" : "unknown", why: docs ? "first pull request, only fixes docs" : "first pull request, a docs fix" }
  ].map(function (s) {
    var out = outcome(s.kind);
    return { name: s.name, why: s.why, t: TAG[s.kind], out: out, outFg: out.indexOf("Closed") === 0 ? "#FF8087" : "#A8B0AB" };
  });
  var hint = picked[listB]
    ? "ines-carvalho is admitted because you accept " + listB + ". That is shared trust doing its job."
    : "Tick " + listB + " and watch ines-carvalho turn green. That is shared trust doing its job.";

  /* ---------------------------------------------------------- presets */
  var uNames = { label: "Label", comment: "Label and comment", close: "Close with comment" };
  var presets = [
    { name: "Watch", note: "Start here. Nothing is closed and nobody gets a comment.", u: "label", d: "label", docs: false },
    { name: "Explain", note: "Tells newcomers how to get vouched. Still closes nothing.", u: "comment", d: "label", docs: false },
    { name: "The defaults", note: "What you get with no trust.yml. Closes only people your own list denounces.", u: "comment", d: "close", docs: false },
    { name: "Docs stay open", note: "Gates code, but anyone can fix documentation and translations.", u: "close", d: "close", docs: true },
    { name: "Trusted only", note: "For projects buried in generated pull requests. Blocks newcomers until someone vouches.", u: "close", d: "close", docs: false }
  ].map(function (p) {
    var active = unknown === p.u && den === p.d && docs === p.docs;
    var closes = p.u === "close";
    return {
      name: p.name, note: p.note,
      uText: closes && p.docs ? "Close, except docs" : uNames[p.u],
      uFg: closes ? "#FF8087" : "#F2F5F3", uW: closes ? 600 : 400,
      dText: p.d === "close" ? "Close" : "Label",
      dFg: p.d === "close" ? "#FF8087" : "#F2F5F3", dW: p.d === "close" ? 600 : 400,
      btn: active ? "Loaded in builder" : "Load in builder",
      btnBg: active ? "#10281B" : "transparent", btnFg: active ? "#7BE3A6" : "#F2F5F3", btnBd: active ? "#1A4A31" : "#343B37",
      load: function () { set({ unknown: p.u, den: p.d, docs: p.docs }); }
    };
  });

  /* ---------------------------------------------------------- results */
  var r = RESULTS.filter(function (x) { return x.repo === proj; })[0] || RESULTS[0];
  var resModes = RESULTS.map(function (x) {
    var on = x.repo === r.repo;
    return { label: x.repo.split("/")[1], on: on, bg: on ? "#F2F5F3" : "transparent", fg: on ? "#080A09" : "#A8B0AB", pick: function () { set({ proj: x.repo }); } };
  });
  var rest = r.unknown - r.uMerged;
  var res = {
    v: r.admitted, u: r.unknown, d: r.denounced, dMin: r.denounced ? "10px" : "0",
    vT: num(r.admitted), uT: num(r.unknown), dT: num(r.denounced),
    big: num(r.uMerged), bigFg: "#F2F5F3",
    head: "of the " + num(r.unknown) + " unknown pull requests on " + r.repo + " were good, and got merged.",
    body: "Their authors had no vouch and no merged work here yet, so most were newcomers. With closing switched on, every one of them would have waited for a vouch first. Of the other " + num(rest) + ", " +
      num(r.uRejected) + " were rejected, " + num(r.uWithdrawn) + " withdrawn, " + num(r.uBot) + " closed by a bot and " + num(r.uOpen) + " are still open." +
      (r.own ? "" : " This project has no VOUCHED.td, so only merged work admitted anyone; shared lists would let more people in."),
    span: num(r.external) + " outside pull requests, 27 Nov 2025 to 27 Nov 2026"
  };

  return {
    people: people, ruleRows: ruleRows, result: TAG[ruleDefs[cur.hit].res],
    tabs: tabs, isRules: file === "rules", isFlow: file === "flow", isCommit: file === "commit",
    releaseRef: releaseRef, releaseTag: RELEASE.tag,
    copyFile: copier(set, "file", fileText[file]), copyFileLabel: copyLabel("file", "Copy"),
    listItems: listItems, extras: extras, dirRows: dirRows, pickedLine: pickedLine, buildLine: buildLine,
    noRows: dirRows.length === 0, emptyLine: lists ? "No list matches “" + (st.filter || "") + "”." : "Loading lists…",
    allLabel: showAll && !filter ? "Show fewer lists" : "Show all " + all.length + " public lists",
    toggleAll: function () { set({ showAll: !st.showAll, filter: "" }); var f = document.getElementById("list-filter-v2"); if (f) f.value = ""; },
    actions: actions, denActions: denActions, yamlLines: lines,
    copyYaml: copier(set, "yaml", yamlText), copyYamlLabel: copyLabel("yaml", "Copy file"),
    preview: preview, hint: hint, presets: presets, resModes: resModes, res: res,
    copyCli: copier(set, "cli", "npx github:maxbenschop/pr-trust backtest you/your-repo"), copyCliLabel: copyLabel("cli", "Copy")
  };
}

var app = mount(document.getElementById("app"), view);

fetch("lists.json")
  .then(function (r) { return r.json(); })
  .then(function (data) {
    lists = data.lists || [];
    builtAt = data.generatedAt;
    app.render();
  })
  .catch(function () { lists = []; app.render(); });
