"use strict";

/* Release the snippets point at. Updated on each release. */
const RELEASE = { repo: "maxbenschop/pr-trust", tag: "v0.1.0", sha: "42d48f665bc08357050696e66beac9c314946f96" };
const VOUCH_ACTION = "mitchellh/vouch/action/check-pr@d66fa29a64600490892131ad87597c30c91fcac4 # v1";

/* Projects whose merge history works with `merged` rules (checked in GitHub search). */
const TRACK_RECORD_SUGGESTIONS = [
  "rust-lang/rust",
  "python/cpython",
  "nodejs/node",
  "kubernetes/kubernetes",
  "llvm/llvm-project",
  "microsoft/TypeScript",
  "vercel/next.js",
  "rails/rails",
  "home-assistant/core",
  "astral-sh/ruff",
];

/* Backtest of the default rules, PRs opened 2025-11-27 to 2026-11-27. */
const RESULTS = [
  { repo: "ghostty-org/ghostty", vouch: true, external: 944, keeps: 78, stops: 45, through: 77, blocked: 53 },
  { repo: "netbox-community/netbox", vouch: true, external: 170, keeps: 62, stops: 63, through: 80, blocked: 55 },
  { repo: "cloudflare/workers-sdk", vouch: true, external: 708, keeps: 35, stops: 72, through: 70, blocked: 64 },
  { repo: "juanfont/headscale", vouch: true, external: 180, keeps: 36, stops: 90, through: 80, blocked: 38 },
  { repo: "triggerdotdev/trigger.dev", vouch: true, external: 414, keeps: 50, stops: 71, through: 59, blocked: 28 },
  { repo: "facebook/react", external: 1257, keeps: 30, stops: 96, through: 52, blocked: 19 },
  { repo: "sveltejs/svelte", external: 545, keeps: 32, stops: 84, through: 66, blocked: 47 },
  { repo: "astral-sh/uv", external: 756, keeps: 32, stops: 94, through: 67, blocked: 35 },
  { repo: "tailwindlabs/tailwindcss", external: 308, keeps: 28, stops: 83, through: 54, blocked: 43 },
  { repo: "denoland/deno", external: 734, keeps: 44, stops: 72, through: 63, blocked: 46 },
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* Minimal YAML colouring: comments and keys. */
function highlightYaml(text) {
  return text
    .split("\n")
    .map((line) => {
      let code = line;
      let comment = "";
      const hash = line.search(/(^|\s)#/);
      if (hash !== -1) {
        code = line.slice(0, hash);
        comment = line.slice(hash);
      }
      let html = escapeHtml(code).replace(/^(\s*(?:-\s+)?)([\w.-]+)(:)(?=\s|$)/, '$1<span class="tok-k">$2</span>$3');
      if (comment) html += `<span class="tok-c">${escapeHtml(comment)}</span>`;
      return html;
    })
    .join("\n");
}

function setCode(el, text) {
  el.dataset.raw = text;
  el.innerHTML = highlightYaml(text);
}

/* ---------- Theme ---------- */
function setupTheme() {
  const button = $("#theme-toggle");
  const effective = () =>
    document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const update = () => button.setAttribute("aria-label", `Switch to ${effective() === "dark" ? "light" : "dark"} theme`);
  button.addEventListener("click", () => {
    const next = effective() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
    update();
  });
  update();
}

/* ---------- Copy ---------- */
let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Select the text and copy it manually");
  }
}

function codeText(codeEl) {
  return codeEl.dataset.raw ?? codeEl.textContent;
}

function setupCopy() {
  for (const block of $$(".code[data-copy]")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-btn";
    button.textContent = "Copy";
    button.addEventListener("click", () => copyText(codeText($("code", block))));
    block.append(button);
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy-target]");
    if (button) copyText(codeText(document.getElementById(button.dataset.copyTarget)));
  });
  // Colour the static snippets too.
  for (const code of $$(".code pre code")) if (!code.dataset.raw && code.textContent.trim()) setCode(code, code.textContent);
}

/* ---------- Generators ---------- */
const uses = () => `${RELEASE.repo}@${RELEASE.sha} # ${RELEASE.tag}`;

function workflowYaml({ vouch = false, dispatch = false } = {}) {
  if (dispatch) {
    return `name: Contributor trust (on demand)
on:
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number
        required: true
permissions:
  contents: read
  pull-requests: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: ${uses()}
        with:
          pr-number: \${{ inputs.pr }}
          dry-run: "true"   # report only; see the job summary`;
  }
  const head = `name: ${vouch ? "Vouch check" : "Contributor trust"}
on:
  pull_request_target:   # write access for PRs from forks; never checks out PR code
    types: [opened, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  check:
    runs-on: ubuntu-latest
    steps:`;
  if (!vouch) return `${head}\n      - uses: ${uses()}`;
  return `${head}
      - id: trust
        uses: ${uses()}
        with:
          dry-run: "true"   # decide only; Vouch labels and closes
      - if: steps.trust.outputs.admitted != 'true'
        uses: ${VOUCH_ACTION}
        with:
          pr-number: \${{ github.event.pull_request.number }}
          auto-close: true
        env:
          GITHUB_TOKEN: \${{ github.token }}`;
}

function trustYaml(state) {
  const lines = [];
  lines.push(state.ownList ? "own_list: auto            # .github/VOUCHED.td or VOUCHED.td" : "own_list: none");
  const admit = [];
  for (const ref of state.lists) admit.push(`  - list: ${ref}`);
  for (const m of state.merged) admit.push(`  - merged: { repo: ${m.repo}, min: ${m.min}, within: 24mo }`);
  if (state.self) admit.push(`  - merged: { repo: self, min: ${state.selfMin}, within: ${state.selfWithin} }`);
  if (admit.length > 0) lines.push("admit:", ...admit);
  if (state.docs) lines.push("exempt_paths:", '  - "docs/**"', '  - "**/*.md"');
  if (!state.vouch) {
    lines.push(`on_unknown: ${state.mode}`);
    if (!state.comment) lines.push("comment: never            # still comments when closing");
  }
  return lines.join("\n");
}

/* ---------- Builder ---------- */
const builder = { lists: new Set(), merged: [] };
let catalog = [];

function readForm() {
  const form = $("#builder-form");
  const data = new FormData(form);
  return {
    ownList: data.has("ownList"),
    vouch: data.has("vouch"),
    self: data.has("self"),
    selfMin: Math.max(1, Math.min(50, Number(data.get("selfMin")) || 1)),
    selfWithin: data.get("selfWithin") || "24mo",
    mode: data.get("mode") || "label",
    comment: data.has("comment"),
    docs: data.has("docs"),
    lists: [...builder.lists],
    merged: builder.merged,
  };
}

function renderBuilder() {
  const state = readForm();
  setCode($("#out-trust"), trustYaml(state));
  setCode($("#out-workflow"), workflowYaml({ vouch: state.vouch }));
  $("#out-workflow-name").textContent = state.vouch ? ".github/workflows/vouch-check-pr.yml" : ".github/workflows/pr-trust.yml";

  const form = $("#builder-form");
  for (const el of $$('input[name="mode"], input[name="comment"]', form)) el.disabled = state.vouch;
  for (const el of $$('input[name="selfMin"], select[name="selfWithin"]', form)) el.disabled = !state.self;

  const notes = [];
  if (state.vouch) notes.push("With Vouch, pr-trust only decides; Vouch's own step labels and closes, so the close and comment settings don't apply.");
  else if (state.mode === "close") notes.push("Tip: start with “Label only” for a few weeks, then switch to closing.");
  if (!state.ownList && !state.self && state.lists.length === 0 && state.merged.length === 0) {
    notes.push("No rules yet: every outside author would be unknown.");
  }
  $("#builder-note").textContent = notes.join(" ");

  $("#list-chips").replaceChildren(...state.lists.map((ref) => chip(ref, () => toggleList(ref, false))));
  $("#merged-chips").replaceChildren(
    ...state.merged.map((m) => chip(`${m.repo} ≥${m.min}`, () => {
      builder.merged = builder.merged.filter((x) => x.repo !== m.repo);
      renderBuilder();
    })),
  );
  for (const button of $$(".add-btn")) {
    const on = builder.lists.has(button.dataset.ref);
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "Added ✓" : "Add to my rules";
  }
}

function chip(text, onRemove) {
  const el = document.createElement("span");
  el.className = "chip";
  el.textContent = text;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove ${text}`);
  remove.textContent = "×";
  remove.addEventListener("click", onRemove);
  el.append(remove);
  return el;
}

function toggleList(ref, on) {
  if (on ?? !builder.lists.has(ref)) builder.lists.add(ref);
  else builder.lists.delete(ref);
  renderBuilder();
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

function addMerged(repo, min) {
  repo = repo.trim();
  if (!REPO_RE.test(repo)) {
    toast("Use the form owner/repo");
    return false;
  }
  builder.merged = builder.merged.filter((m) => m.repo.toLowerCase() !== repo.toLowerCase());
  builder.merged.push({ repo, min: Math.max(1, Math.min(50, Number(min) || 1)) });
  renderBuilder();
  return true;
}

function setupBuilder() {
  $("#builder-form").addEventListener("input", renderBuilder);
  $("#builder-form").addEventListener("change", renderBuilder);

  const search = $("#list-search");
  const pick = () => {
    const value = search.value.trim().toLowerCase();
    const match = catalog.find((l) => l.ref.toLowerCase() === value || l.repo.toLowerCase() === value);
    if (match) {
      toggleList(match.ref, true);
      search.value = "";
    }
  };
  search.addEventListener("change", pick);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      pick();
    }
  });

  const repoInput = $("#merged-repo");
  const add = () => {
    if (addMerged(repoInput.value, $("#merged-min").value)) repoInput.value = "";
  };
  $("#merged-add").addEventListener("click", add);
  repoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  });
  $("#merged-suggest").replaceChildren(
    ...TRACK_RECORD_SUGGESTIONS.map((repo) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `+ ${repo}`;
      b.addEventListener("click", () => addMerged(repo, $("#merged-min").value));
      return b;
    }),
  );
  renderBuilder();
}

/* ---------- Presets ---------- */
const PRESETS = [
  {
    id: "label",
    name: "Label only",
    intro: "The safe start. Every outside PR gets a label and the reason; nothing is closed. Run it for a few weeks and see who lands in “unknown”.",
    trust: `own_list: auto
admit:
  - merged: { repo: self, min: 1, within: 24mo }
on_unknown: label`,
    workflow: () => workflowYaml(),
  },
  {
    id: "close",
    name: "Comment and close",
    intro: "For projects drowning in drive-by PRs. Unknown authors get your message and a closed PR; a maintainer can always reopen, and the check then only labels it.",
    trust: `own_list: auto
admit:
  - merged: { repo: self, min: 1, within: 24mo }
on_unknown: close
on_denounced: close
message_file: .github/trust-message.md   # placeholders: {author} {reason} {repo} {next}`,
    workflow: () => workflowYaml(),
  },
  {
    id: "vouch",
    name: "Alongside Vouch",
    intro: "Keep Vouch's check and messages. pr-trust runs first and lets in people your list doesn't know yet: vouched by projects you trust, or with a track record here.",
    trust: `own_list: auto
admit:
  - list: ghostty-org/ghostty
  - list: hyprwm/.github:vouch/VOUCHED.td
  - merged: { repo: self, min: 1, within: 24mo }`,
    workflow: () => workflowYaml({ vouch: true }),
  },
  {
    id: "docs",
    name: "Docs stay open",
    intro: "Gate code, but keep documentation and translations open to everyone. Denounced authors are still blocked.",
    trust: `own_list: auto
admit:
  - merged: { repo: self, min: 1, within: 24mo }
exempt_paths:
  - "docs/**"
  - "**/*.md"
  - "i18n/**"
  - "locales/**"
on_unknown: close`,
    workflow: () => workflowYaml(),
  },
  {
    id: "ecosystem",
    name: "Ecosystem track record",
    intro: "For libraries in a bigger ecosystem: admit people with merged work in the projects your users already trust, as well as your own contributors.",
    trust: `own_list: auto
admit:
  - merged: { repo: rust-lang/rust, min: 3, within: 24mo }
  - merged: { repo: rust-lang/cargo, min: 2, within: 24mo }
  - merged: { repo: tokio-rs/tokio, min: 2, within: 24mo }
  - merged: { repo: self, min: 1, within: 24mo }
on_unknown: label`,
    workflow: () => workflowYaml(),
  },
  {
    id: "dispatch",
    name: "Check on demand",
    intro: "Run the check by hand on any PR from the Actions tab, without changing it. Handy for trying new rules before you rely on them.",
    trust: `# Uses your existing .github/trust.yml`,
    workflow: () => workflowYaml({ dispatch: true }),
  },
];

function setupPresets() {
  const tabs = $("#preset-tabs");
  const panel = $("#preset-panel");
  const show = (preset) => {
    for (const tab of $$(".tab", tabs)) {
      const on = tab.dataset.id === preset.id;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", `tab-${preset.id}`);
    panel.innerHTML = `
      <div class="preset-intro"><h3>${escapeHtml(preset.name)}</h3><p>${escapeHtml(preset.intro)}</p></div>
      <div class="file"><div class="file-head"><span>.github/trust.yml</span><button class="copy-btn" type="button" data-copy-target="preset-trust">Copy</button></div><pre><code id="preset-trust"></code></pre></div>
      <div class="file"><div class="file-head"><span>.github/workflows/${preset.id === "vouch" ? "vouch-check-pr" : "pr-trust"}.yml</span><button class="copy-btn" type="button" data-copy-target="preset-workflow">Copy</button></div><pre><code id="preset-workflow"></code></pre></div>`;
    setCode($("#preset-trust"), preset.trust);
    setCode($("#preset-workflow"), preset.workflow());
  };
  for (const preset of PRESETS) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.id = `tab-${preset.id}`;
    tab.role = "tab";
    tab.dataset.id = preset.id;
    tab.setAttribute("aria-controls", "preset-panel");
    tab.textContent = preset.name;
    tab.addEventListener("click", () => show(preset));
    tab.addEventListener("keydown", (e) => {
      const i = PRESETS.indexOf(preset);
      const next = e.key === "ArrowRight" ? PRESETS[(i + 1) % PRESETS.length] : e.key === "ArrowLeft" ? PRESETS[(i - 1 + PRESETS.length) % PRESETS.length] : null;
      if (next) {
        show(next);
        $(`#tab-${next.id}`).focus();
      }
    });
    tabs.append(tab);
  }
  show(PRESETS[0]);
}

/* ---------- Directory ---------- */
const fmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function timeAgo(iso) {
  if (!iso) return "unknown";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 45) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months} months ago` : `${Math.round(months / 12)} years ago`;
}

function renderDirectory() {
  const grid = $("#dir-grid");
  const query = $("#dir-search").value.trim().toLowerCase();
  const sort = $("#dir-sort").value;
  const items = catalog
    .filter((l) => !query || [l.repo, l.description, l.language].some((v) => v && v.toLowerCase().includes(query)))
    .sort((a, b) =>
      sort === "vouched" ? b.vouched - a.vouched : sort === "updated" ? (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") : b.stars - a.stars,
    );
  if (items.length === 0) {
    grid.innerHTML = `<p class="muted">No lists match “${escapeHtml(query)}”.</p>`;
    return;
  }
  grid.innerHTML = items
    .map(
      (l) => `
    <article class="list-card">
      <h3><a href="${escapeHtml(l.url)}">${escapeHtml(l.repo)}</a></h3>
      <p class="desc">${escapeHtml(l.description ?? "")}</p>
      <div class="meta">
        <span><b>${l.vouched}</b> vouched</span>
        <span>★ ${fmt.format(l.stars)}</span>
        ${l.language ? `<span>${escapeHtml(l.language)}</span>` : ""}
        <span>updated ${timeAgo(l.updatedAt)}</span>
      </div>
      <div class="row">
        <code>list: ${escapeHtml(l.ref)}</code>
        <button type="button" class="add-btn" data-ref="${escapeHtml(l.ref)}" aria-pressed="false">Add to my rules</button>
      </div>
    </article>`,
    )
    .join("");
  renderBuilder();
}

async function setupDirectory() {
  $("#dir-search").addEventListener("input", renderDirectory);
  $("#dir-sort").addEventListener("change", renderDirectory);
  $("#dir-grid").addEventListener("click", (e) => {
    const button = e.target.closest(".add-btn");
    if (!button) return;
    toggleList(button.dataset.ref);
    if (builder.lists.has(button.dataset.ref)) toast("Added to the rule builder");
  });
  try {
    const response = await fetch("lists.json", { cache: "no-cache" });
    const data = await response.json();
    catalog = data.lists ?? [];
    const total = catalog.reduce((sum, l) => sum + l.vouched, 0);
    $("#dir-meta").textContent = `${catalog.length} lists vouching for ${total.toLocaleString("en")} people in total. Refreshed ${timeAgo(data.generatedAt)}.`;
    $("#list-options").replaceChildren(
      ...catalog.map((l) => {
        const o = document.createElement("option");
        o.value = l.ref;
        o.label = `${l.repo} · ${l.vouched} vouched`;
        return o;
      }),
    );
    renderDirectory();
  } catch {
    $("#dir-grid").innerHTML = '<p class="muted">Could not load the directory. See <a href="https://github.com/maxbenschop/pr-trust/blob/main/lists/catalog.json">lists/catalog.json</a>.</p>';
  }
}

/* ---------- Results ---------- */
function setupResults() {
  const bar = (value, warn) => `<span class="bar${warn ? " warn" : ""}">${value}%<i style="width:${Math.round(value * 0.6)}px"></i></span>`;
  $("#results-table tbody").innerHTML = RESULTS.map(
    (r) => `<tr>
      <td class="repo">${escapeHtml(r.repo)}${r.vouch ? '<span class="tag">uses Vouch</span>' : ""}</td>
      <td class="num">${r.external.toLocaleString("en")}</td>
      <td class="num">${bar(r.keeps, r.keeps < 50)}</td>
      <td class="num">${bar(r.stops)}</td>
      <td class="num">${r.through}%</td>
      <td class="num">${r.blocked}%</td>
    </tr>`,
  ).join("");
}

/* ---------- Init ---------- */
setCode($(".js-workflow-basic"), workflowYaml());
setupTheme();
setupCopy();
setupBuilder();
setupPresets();
setupResults();
setupDirectory();
