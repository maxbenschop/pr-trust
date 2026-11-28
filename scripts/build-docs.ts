/**
 * Renders docs/*.md into the website: site/docs/<page>/index.html and site/docs/index.html.
 * The Markdown is the source; the HTML is built on deploy and not committed.
 * Fails on a link to a page or heading that does not exist.
 *
 *   node scripts/build-docs.ts
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Marked, type Tokens } from "marked";

const REPO = "https://github.com/maxbenschop/pr-trust";
const SITE = "https://maxbenschop.github.io/pr-trust";
const SOURCE = "docs";
const OUT = "site/docs";

/** The order of the sidebar. `summary` is the line on the index page and the meta description. */
const PAGES: { slug: string; summary: string }[] = [
  { slug: "getting-started", summary: "Install it with two files, and see what happens on each pull request." },
  { slug: "rules", summary: "Every key in .github/trust.yml, and how to check the file before merging." },
  { slug: "vouching", summary: "Admit someone with a /vouch comment, and check pull requests again when your list changes." },
  { slug: "action", summary: "The Action's inputs, outputs and permissions." },
  { slug: "command-line", summary: "check, backtest and validate, and how to read a backtest." },
  { slug: "enterprise", summary: "Running on GitHub Enterprise Server or ghe.com." },
  { slug: "limitations", summary: "What the Action and the backtest cannot see." },
];

type Heading = { depth: number; text: string; id: string };
type Page = { slug: string; summary: string; title: string; html: string; headings: Heading[]; links: string[] };

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** GitHub's heading anchors, so a link works in both places. */
export function slugify(text: string, seen: Map<string, number>): string {
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/** A link as written in docs/*.md, as it should be on the website. */
export function siteHref(href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return href;
  const [file = "", anchor] = href.split("#");
  const hash = anchor ? `#${anchor}` : "";
  if (file.startsWith("../")) return `${REPO}/blob/main/${file.slice(3)}${hash}`;
  if (/^[\w-]+\.md$/.test(file)) return `../${file.slice(0, -3)}/${hash}`;
  throw new Error(`Cannot place the link "${href}" on the website`);
}

function render(slug: string, summary: string): Page {
  const headings: Heading[] = [];
  const links: string[] = [];
  const seen = new Map<string, number>();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Heading) {
        const text = token.text.replace(/`/g, "");
        const id = slugify(text, seen);
        headings.push({ depth: token.depth, text, id });
        const inner = this.parser.parseInline(token.tokens);
        if (token.depth === 1) return `<h1>${inner}</h1>\n`;
        return `<h${token.depth} id="${id}"><a class="anchor" href="#${id}">${inner}</a></h${token.depth}>\n`;
      },
      link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link) {
        links.push(token.href);
        const href = siteHref(token.href);
        return `<a href="${escapeHtml(href)}">${this.parser.parseInline(token.tokens)}</a>`;
      },
    },
  });
  const source = fs.readFileSync(path.join(SOURCE, `${slug}.md`), "utf8");
  const html = (marked.parse(source) as string)
    .replaceAll("<table>", '<div class="tbl" tabindex="0"><table>')
    .replaceAll("</table>", "</table></div>");
  const title = headings.find((h) => h.depth === 1)?.text;
  if (!title) throw new Error(`docs/${slug}.md has no "# Title" line`);
  return { slug, summary, title, html, headings, links };
}

/** Every link between pages must name a page and a heading that exist. */
function checkLinks(pages: Page[]): string[] {
  const problems: string[] = [];
  for (const page of pages) {
    for (const href of page.links) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      const [file = "", anchor] = href.split("#");
      if (file.startsWith("../")) {
        if (!fs.existsSync(path.join(SOURCE, file))) problems.push(`docs/${page.slug}.md links to ${file}, which does not exist`);
        continue;
      }
      const target = file === "" ? page : pages.find((p) => `${p.slug}.md` === file);
      if (!target) problems.push(`docs/${page.slug}.md links to ${file}, which is not a docs page`);
      else if (anchor && !target.headings.some((h) => h.id === anchor)) {
        problems.push(`docs/${page.slug}.md links to ${file}#${anchor}, but docs/${target.slug}.md has no such heading`);
      }
    }
  }
  return problems;
}

const LOGO = `<svg aria-hidden="true" width="29" height="16" viewBox="7 18 50 28"><rect x="7" y="18" width="50" height="28" rx="9" fill="#35D07F"/><path d="M23 32.5 L29.5 39 L42 25.5" fill="none" stroke="#080A09" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** `root` is the path from the page to site/, and `docs` the path to site/docs/. */
function layout(o: { title: string; description: string; url: string; root: string; docs: string; current: string | null; pages: Page[]; body: string }): string {
  const nav = o.pages
    .map((p) => {
      const here = p.slug === o.current;
      const sections = here
        ? `<ul>${p.headings
            .filter((h) => h.depth === 2)
            .map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
            .join("")}</ul>`
        : "";
      return `<li><a href="${o.docs}${p.slug}/"${here ? ' aria-current="page"' : ""}>${escapeHtml(p.title)}</a>${sections}</li>`;
    })
    .join("\n");
  const title = `${o.title} · pr-trust docs`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(o.description)}">
<link rel="canonical" href="${o.url}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(o.description)}">
<meta property="og:image" content="${SITE}/social-preview.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#080A09">
<link rel="icon" href="${o.root}favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Mona+Sans:wght@400;500;600;700;800&amp;family=JetBrains+Mono:wght@400;500;700&amp;display=swap" rel="stylesheet">
<link rel="stylesheet" href="${o.root}styles.css">
<link rel="stylesheet" href="${o.root}docs.css">
</head>
<body class="docs">
<a class="skip" href="#content">Skip to the page</a>
<header class="docs-top">
<div class="docs-top-in">
<a class="docs-logo" href="${o.root}">${LOGO}<span>pr-trust</span></a>
<nav aria-label="Site">
<a href="${o.docs}" aria-current="true">Docs</a>
<a href="${o.root}#builder">Rule builder</a>
<a href="${o.root}#lists">Trust lists</a>
<a href="${o.root}contributors/">For contributors</a>
<a href="${REPO}">GitHub</a>
</nav>
</div>
</header>
<div class="docs-wrap">
<nav class="docs-side" aria-label="Documentation">
<ul>
${nav}
</ul>
</nav>
<main id="content" class="prose">
${o.body}
</main>
</div>
<footer class="docs-foot"><div>pr-trust is <a href="${REPO}">open source</a>, Apache-2.0.</div></footer>
</body>
</html>
`;
}

function build(): void {
  const pages = PAGES.map((p) => render(p.slug, p.summary));
  const unlisted = fs
    .readdirSync(SOURCE)
    .filter((f) => f.endsWith(".md") && !PAGES.some((p) => `${p.slug}.md` === f));
  const problems = [...checkLinks(pages), ...unlisted.map((f) => `docs/${f} is not in the PAGES list in scripts/build-docs.ts`)];
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  pages.forEach((page, i) => {
    const prev = pages[i - 1];
    const next = pages[i + 1];
    const pager = `<nav class="pager" aria-label="More pages">
${prev ? `<a href="../${prev.slug}/"><small>Previous</small>${escapeHtml(prev.title)}</a>` : "<span></span>"}
${next ? `<a class="next" href="../${next.slug}/"><small>Next</small>${escapeHtml(next.title)}</a>` : "<span></span>"}
</nav>
<p class="edit"><a href="${REPO}/blob/main/docs/${page.slug}.md">This page on GitHub</a></p>`;
    const dir = path.join(OUT, page.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "index.html"),
      layout({
        title: page.title,
        description: page.summary,
        url: `${SITE}/docs/${page.slug}/`,
        root: "../../",
        docs: "../",
        current: page.slug,
        pages,
        body: `${page.html}${pager}`,
      }),
    );
  });

  const cards = pages
    .map((p) => `<a class="card" href="${p.slug}/"><strong>${escapeHtml(p.title)}</strong><span>${escapeHtml(p.summary)}</span></a>`)
    .join("\n");
  fs.writeFileSync(
    path.join(OUT, "index.html"),
    layout({
      title: "Documentation",
      description: "How to install pr-trust, write rules, vouch for contributors and test rules on your own history.",
      url: `${SITE}/docs/`,
      root: "../",
      docs: "",
      current: null,
      pages,
      body: `<h1>Documentation</h1>
<p>pr-trust checks who opened a pull request against rules you write. Start with the first page; the rest is reference.</p>
<div class="cards">
${cards}
</div>`,
    }),
  );
  console.log(`Built ${pages.length} docs pages into ${OUT}/`);
}

// Only when run as a script; the tests import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) build();
