/**
 * Evidence corpus fetch + normalize (S4 / RFC 0011 §3.2, issue #107 groundwork).
 *
 * Usage:
 *   npx tsx scripts/fetch-sources.mts                 # fetch everything in sources/catalog.json
 *   npx tsx scripts/fetch-sources.mts --only ods-iron # one source
 *   npx tsx scripts/fetch-sources.mts --dry           # parse + report, write nothing
 *
 * Output, per source: `sources/<id>/manifest.json` (document-level facts: publisher,
 * licence with its evidence URL, snapshot timestamp, content hash) and
 * `sources/<id>/sections.jsonl` (one line per section: path, heading, ordinal,
 * anchor, text, content hash). Both are committed: they are the reproducible
 * input the ingest step reads, and a reviewer has to be able to see exactly which
 * words entered the evidence layer.
 *
 * Why no HTML parser dependency: these are federal pages whose body is regular
 * (`h1..h4` + `p`/`li`), and the failure mode of a regex extractor — swallowing
 * navigation — is visible in the output and fixed by widening the strip list.
 * The alternative was a new dependency in the path that decides what the model is
 * allowed to cite, which is a bad trade for a script that runs a handful of times.
 *
 * Why the crawler is polite by construction: one request at a time, a descriptive
 * User-Agent, and a delay between fetches. Several of these hosts are behind bot
 * protection and answered a scripted request with a challenge page — see
 * sources/README.md, which is also where the licence determination lives.
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const SOURCES_DIR = "sources";
const FETCH_DELAY_MS = 1500;
const USER_AGENT =
  "NutriBuddy-evidence-fetcher/0.1 (+https://github.com/SnackJJ/NutriBuddy; operator-run; respects robots)";

/**
 * Text that must not become part of a section even when it sits inside the body:
 * copyright notices, navigation furniture, and the standard federal boilerplate
 * that carries no advisory content.
 */
/**
 * Deliberately narrow: a bare "copyright" word match flags every federal footer
 * that links to a "Copyright Policy" page, and a scan that cries wolf is a scan
 * nobody reads. What is being looked for is a *claim* on the content.
 */
const COPYRIGHT_PATTERNS = [
  /©/,
  /&copy;/i,
  /copyright\s*(©|\(c\)|\d{4})/i,
  /all rights reserved/i,
];

interface CatalogSource {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly originalUrl?: string;
  readonly authorityLevel: number;
  readonly license: string;
  readonly licenseEvidence: string;
}

export interface Section {
  readonly sectionId: string;
  readonly sectionPath: string;
  readonly heading: string | null;
  readonly ordinal: number;
  readonly text: string;
  readonly contentHash: string;
}

export interface Manifest {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly originalUrl?: string;
  readonly license: string;
  readonly licenseEvidence: string;
  readonly licenseCheckedAt: string;
  /** Findings from the copyright scan, for the human review the README describes. */
  readonly licenseFlags: readonly string[];
  readonly authorityLevel: number;
  readonly docVersion: string;
  readonly fetchedAt: string;
  readonly sha256: string;
  readonly sectionCount: number;
  readonly sections: readonly {
    readonly sectionId: string;
    readonly sectionPath: string;
    readonly heading: string | null;
    readonly ordinal: number;
    readonly contentHash: string;
    readonly chars: number;
  }[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCharCode(Number(code)),
    );
}

/**
 * Drop comments and code, keep the article, then remove chrome — in that order.
 *
 * The order is the whole point. A first version stripped chrome first and lost
 * 99% of an ODS page: the page carries a single `<form>` opened at offset 5k and
 * closed at 444k, so a non-greedy `<form>...</form>` removal swallowed the
 * article. Any element strip is therefore bounded — a match larger than a fifth
 * of its region is not chrome, it is content the regex is confused about.
 */
export function stripToBody(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  const main = mainRegion(text);
  if (main) text = main;

  for (const tag of ["nav", "header", "footer", "aside", "form", "svg", "noscript"]) {
    const pattern = new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, "gi");
    text = text.replace(pattern, (match) =>
      match.length > text.length * 0.2 ? match : " ",
    );
  }
  return text;
}

/**
 * The `<main>` region, when there is a plausible one.
 *
 * First `<main>` to **last** `</main>`: with nested or teapot-shaped markup the
 * non-greedy pairing takes a fragment, and the region is rejected outright if it
 * carries fewer than three paragraphs — an empty `<main>` is a template, and the
 * whole page is the better input then.
 */
export function mainRegion(html: string): string | null {
  const start = html.search(/<main[\s>]/i);
  if (start < 0) return null;
  const end = html.lastIndexOf("</main>");
  if (end <= start) return null;
  const region = html.slice(start, end + "</main>".length);
  return (region.match(/<p[\s>]/gi) ?? []).length >= 3 ? region : null;
}

export interface RawBlock {
  readonly level: number;
  readonly kind: "heading" | "paragraph" | "list-item";
  readonly text: string;
  readonly anchor?: string;
}

/**
 * Walk the body in document order, keeping headings, paragraphs and list items.
 *
 * Document order matters: it is what makes `sectionPath` ("Vitamin D / Sources of
 * Vitamin D") a real path rather than a guess, and the citation layer points at
 * that path.
 */
export function extractBlocks(body: string): RawBlock[] {
  const pattern =
    /<(h[1-4])([^>]*)>([\s\S]*?)<\/\1>|<p([^>]*)>([\s\S]*?)<\/p>|<li([^>]*)>([\s\S]*?)<\/li>/gi;
  const blocks: RawBlock[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(body)) !== null) {
    const headingLevel = match[1];
    const headingAttrs = match[2] ?? "";
    const headingText = match[3];
    const paragraphText = match[5];
    const listText = match[7];

    const raw = headingLevel ? headingText : (paragraphText ?? listText ?? "");
    const attrs = headingLevel ? headingAttrs : (match[4] ?? match[6] ?? "");

    const text = decodeEntities(
      raw
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (text.length === 0) continue;
    // A one-word "paragraph" is a control, a breadcrumb or a stray label.
    if (!headingLevel && text.length < 4) continue;

    const anchor =
      /\bid=["']([^"']+)["']/i.exec(attrs)?.[1] ??
      /<a[^>]*name=["']([^"']+)["']/i.exec(raw)?.[1];

    blocks.push({
      level: headingLevel ? Number(headingLevel.slice(1)) : 0,
      kind: headingLevel ? "heading" : paragraphText !== undefined ? "paragraph" : "list-item",
      text,
      anchor,
    });
  }

  return blocks;
}

/**
 * Group blocks into sections at heading boundaries.
 *
 * `sectionPath` is the heading trail ("Vitamin D / Sources of Vitamin D"), which
 * is what a citation shows a reader and what an ingest run turns into a stable id.
 */
export function groupSections(sourceId: string, blocks: readonly RawBlock[]): Section[] {
  const sections: Section[] = [];
  const trail: string[] = [];
  let current: { path: string; heading: string | null; anchor?: string; parts: string[] } | null =
    null;

  /**
   * Slugs are truncated to 60 characters, so two long sibling paths can collide
   * ("Groups at Risk of X Inadequacy / People with ..." twice). The corpus check
   * rejects duplicate ids, so a collision is disambiguated here rather than
   * discovered later: the section id is what a citation points at, and two rows
   * sharing one is a citation that cannot be resolved.
   */
  const usedSlugs = new Map<string, number>();

  const flush = (): void => {
    if (!current) return;
    const text = current.parts.join("\n\n").trim();
    if (text.length > 0) {
      const ordinal = sections.length + 1;
      const base = slug(current.path) || `s${ordinal}`;
      const seen = usedSlugs.get(base) ?? 0;
      usedSlugs.set(base, seen + 1);
      const sectionId = `${sourceId}#${seen === 0 ? base : `${base}-${seen + 1}`}`;
      sections.push({
        sectionId,
        sectionPath: current.path,
        heading: current.heading,
        ordinal,
        text,
        contentHash: sha256(text).slice(0, 16),
      });
    }
    current = null;
  };

  for (const block of blocks) {
    if (block.kind === "heading") {
      flush();
      trail.length = block.level - 1;
      trail[block.level - 1] = block.text;
      const path = trail.filter(Boolean).join(" / ");
      current = { path, heading: block.text, anchor: block.anchor, parts: [] };
      continue;
    }
    if (!current) {
      // Body text before any heading: keep it, under a path that says so.
      current = { path: "Preamble", heading: null, parts: [] };
    }
    current.parts.push(block.kind === "list-item" ? `- ${block.text}` : block.text);
  }

  flush();
  return sections;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** The copyright scan the README promises: flag, do not silently include. */
export function scanLicenseFlags(text: string): string[] {
  const flags: string[] = [];
  for (const pattern of COPYRIGHT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) flags.push(`matched ${pattern} near "${text.slice(Math.max(0, match.index - 40), match.index + 60).trim()}"`);
  }
  return flags;
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const html = await response.text();
  if (/Just a moment|cf-challenge|Attention Required/i.test(html.slice(0, 2000))) {
    throw new Error(`bot challenge instead of content for ${url} (see sources/README.md)`);
  }
  return html;
}

/** `<ts>` from a Wayback URL, so the manifest can name the snapshot it used. */
export function waybackTimestamp(url: string): string | undefined {
  return /web\.archive\.org\/web\/(\d{4,14})/.exec(url)?.[1];
}

interface Args {
  readonly only?: string;
  readonly dry: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let only: string | undefined;
  let dry = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--only") {
      only = argv[++i];
      if (!only) throw new Error("--only needs a source id");
    } else if (argv[i] === "--dry") {
      dry = true;
    } else {
      throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  return { only, dry };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const catalog = JSON.parse(
    readFileSync(join(SOURCES_DIR, "catalog.json"), "utf8"),
  ) as { sources: CatalogSource[] };

  const targets = args.only
    ? catalog.sources.filter((source) => source.id === args.only)
    : catalog.sources;
  if (targets.length === 0) {
    console.error(`no source matched ${args.only ?? "(all)"}`);
    return 1;
  }

  const fetchedAt = new Date().toISOString();
  const licenseCheckedAt = fetchedAt.slice(0, 10);
  let failures = 0;

  for (const source of targets) {
    try {
      const html = await fetchHtml(source.url);
      const sections = groupSections(source.id, extractBlocks(stripToBody(html)));
      // The whole-document text is what the copyright scan looks at: a notice in
      // a footer still says something about the page even when the footer is
      // stripped from the sections.
      const flags = scanLicenseFlags(decodeEntities(html.replace(/<[^>]+>/g, " ")));
      const snapshot = waybackTimestamp(source.url);
      // Just the version. The registry row id is `<slug>@<docVersion>`, so
      // prefixing the slug here produced `ods-x@ods-x@2024` — correct-looking and
      // wrong, and the sort of thing only a human reading a row would notice.
      const docVersion = snapshot ?? licenseCheckedAt;

      const manifest: Manifest = {
        id: source.id,
        title: source.title,
        publisher: source.publisher,
        url: source.url,
        originalUrl: source.originalUrl,
        license: source.license,
        licenseEvidence: source.licenseEvidence,
        licenseCheckedAt,
        licenseFlags: flags,
        authorityLevel: source.authorityLevel,
        docVersion,
        fetchedAt,
        sha256: sha256(sections.map((section) => section.text).join("\n")),
        sectionCount: sections.length,
        sections: sections.map((section) => ({
          sectionId: section.sectionId,
          sectionPath: section.sectionPath,
          heading: section.heading,
          ordinal: section.ordinal,
          contentHash: section.contentHash,
          chars: section.text.length,
        })),
      };

      const chars = sections.reduce((total, section) => total + section.text.length, 0);
      const flagNote = flags.length > 0 ? ` · ⚠ ${flags.length} licence flag(s)` : "";
      console.log(
        `${source.id.padEnd(22)} ${String(sections.length).padStart(4)} sections · ${String(chars).padStart(7)} chars · ${docVersion}${flagNote}`,
      );
      if (flags.length > 0) {
        for (const flag of flags) console.log(`    flag: ${flag.slice(0, 160)}`);
      }

      if (args.dry) continue;

      const dir = join(SOURCES_DIR, source.id);
      mkdirSync(dir, { recursive: true });
      rmSync(join(dir, "sections.jsonl"), { force: true });
      writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      writeFileSync(
        join(dir, "sections.jsonl"),
        sections.map((section) => JSON.stringify(section)).join("\n") + "\n",
        "utf8",
      );
    } catch (err) {
      failures += 1;
      console.error(`${source.id.padEnd(22)} FAILED: ${(err as Error).message}`);
    }

    if (targets.indexOf(source) < targets.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS));
    }
  }

  console.log(
    failures === 0
      ? `\n${targets.length} source(s) ${args.dry ? "parsed (dry run, nothing written)" : "written"}`
      : `\n${targets.length - failures}/${targets.length} written, ${failures} failed`,
  );
  return failures === 0 ? 0 : 1;
}

// Guarded like the other scripts, but for a sharper reason: the extraction
// helpers are the part worth testing, and an unguarded `main()` would make
// importing them crawl the corpus.
const invokedDirectly = process.argv[1]?.endsWith("fetch-sources.mts") ?? false;
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(`fetch-sources: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
