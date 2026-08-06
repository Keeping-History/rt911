#!/usr/bin/env node
/**
 * provenance.mjs — classify every commit in this repository by who wrote it.
 *
 * This exists because the obvious measure is wrong. Commits carry a
 * `Co-Authored-By: Claude …` trailer when the assistant committed directly,
 * but NOT when a subagent committed using a literal `git commit -m "…"` copied
 * from an implementation plan, and not when GitHub's squash-merge rewrote the
 * message. Those commits are fully AI-written and completely unattributed, so
 * counting trailers understates the AI's contribution rather than inflating it.
 *
 * Rather than guess quietly, this script sorts every commit into a bucket and
 * says which ones are inferred rather than known:
 *
 *   ai-attributed  the commit carries a Claude Co-Authored-By trailer. Certain.
 *   ai-inferred    no trailer, but the message follows the conventional-commit
 *                  style with a body that this project only ever produced via
 *                  the assistant, or is a squash-merged PR of such work.
 *   human-inferred no trailer, short informal subject, no body — the shape of a
 *                  hand-typed commit ("CSS Tweaks", "Layout tweak").
 *   structural     merge commits and bot commits. No authored content.
 *   pre-ai         predates the first AI commit in this repository.
 *
 * Only `ai-attributed`, `structural` and `pre-ai` are certain. The two
 * `*-inferred` buckets are heuristics over commit-message shape, stated as such
 * so a reader can disagree with them. `--list <bucket>` prints a bucket so the
 * inference can be audited or corrected by hand.
 *
 * Usage:
 *   node scripts/provenance.mjs                 # summary
 *   node scripts/provenance.mjs --json          # machine-readable snapshot
 *   node scripts/provenance.mjs --list ai-inferred
 *   node scripts/provenance.mjs --blame         # surviving-lines attribution
 *
 * Overrides: any SHA listed in scripts/provenance-overrides.json wins over the
 * heuristic, so a human correction is permanent and reviewable in git.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = join(HERE, "provenance-overrides.json");

/** The first commit in this repository authored with AI assistance. */
export const AI_ERA_START = "2026-06-10";

const CONVENTIONAL = /^(feat|fix|docs|chore|refactor|test|perf|build|ci|style)(\([^)]*\))?!?: /;
const SQUASHED_PR = /\(#\d+\)$/;

function git(...args) {
	return execFileSync("git", args, { cwd: join(HERE, ".."), maxBuffer: 1 << 30 }).toString();
}

function loadOverrides() {
	if (!existsSync(OVERRIDES_PATH)) return {};
	const raw = JSON.parse(readFileSync(OVERRIDES_PATH, "utf8"));
	// { "<sha>": { "bucket": "...", "why": "..." } }
	return Object.fromEntries(Object.entries(raw.commits ?? {}).map(([k, v]) => [k, v.bucket]));
}

export function classify({ sha, author, date, subject, body, parents }, overrides = {}) {
	if (overrides[sha]) return overrides[sha];
	if (date < AI_ERA_START) return "pre-ai";
	if (parents > 1 || subject.startsWith("Merge ")) return "structural";
	if (author.includes("[bot]")) return "structural";
	if (/co-authored-by:.*claude/i.test(body)) return "ai-attributed";
	if (CONVENTIONAL.test(subject) || SQUASHED_PR.test(subject)) return "ai-inferred";
	return "human-inferred";
}

export function readCommits() {
	const SEP = "\x1f";
	const REC = "\x1e";
	const raw = git(
		"log",
		`--format=%H${SEP}%an${SEP}%ad${SEP}%P${SEP}%s${SEP}%b${REC}`,
		"--date=short",
	);
	return raw
		.split(REC)
		.map((r) => r.trim())
		.filter(Boolean)
		.map((r) => {
			const [sha, author, date, parents, subject, ...rest] = r.split(SEP);
			return {
				sha,
				author,
				date,
				parents: parents.trim() ? parents.trim().split(" ").length : 0,
				subject,
				body: rest.join(SEP) ?? "",
			};
		});
}

const BUCKETS = ["ai-attributed", "ai-inferred", "human-inferred", "structural", "pre-ai"];

const CODE_EXT = [".ts", ".tsx", ".go", ".py", ".mjs", ".js", ".scss", ".css"];

/**
 * Attribute the code that actually survives in the tree, rather than commit
 * counts. Commit counts flatter whoever commits in smaller pieces; blaming the
 * working tree asks the more useful question — of the code running today, who
 * wrote the line?
 *
 * A merge commit authors nothing, so blame never lands on one; the `structural`
 * bucket is therefore expected to be empty here.
 */
function blameAttribution(bucketOf) {
	const files = git("ls-files", "packages")
		.split("\n")
		.filter((f) => CODE_EXT.some((e) => f.endsWith(e)) && !f.includes(".venv") && !f.includes("/dist/"));

	const lines = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
	let total = 0;
	for (const f of files) {
		let out;
		try {
			out = git("blame", "--line-porcelain", "-w", "--", f);
		} catch {
			continue; // unreadable or binary-ish; skip rather than abort the run
		}
		for (const line of out.split("\n")) {
			const p = line.split(" ");
			// A porcelain group header is "<sha> <origline> <finalline> <count>".
			if (p.length >= 4 && p[0].length === 40 && /^\d+$/.test(p[1]) && /^\d+$/.test(p[3])) {
				const n = Number(p[3]);
				const b = bucketOf(p[0]);
				if (b) lines[b] += n;
				total += n;
			}
		}
	}
	return { lines, total, fileCount: files.length };
}

function main() {
	const argv = process.argv.slice(2);
	const overrides = loadOverrides();
	const commits = readCommits().map((c) => ({ ...c, bucket: classify(c, overrides) }));

	if (argv.includes("--blame")) {
		const byId = new Map(commits.map((c) => [c.sha, c.bucket]));
		const { lines, total, fileCount } = blameAttribution((sha) => byId.get(sha));
		console.log(`Surviving lines of code under packages/ (${fileCount} files): ${total.toLocaleString()}`);
		for (const b of BUCKETS) {
			if (!lines[b]) continue;
			const pct = ((100 * lines[b]) / total).toFixed(1);
			console.log(`  ${b.padEnd(15)} ${String(lines[b]).padStart(8)}  ${pct.padStart(5)}%`);
		}
		return;
	}

	const listIdx = argv.indexOf("--list");
	if (listIdx !== -1) {
		const want = argv[listIdx + 1];
		for (const c of commits.filter((c) => c.bucket === want)) {
			console.log(`${c.sha.slice(0, 9)}  ${c.date}  ${c.subject}`);
		}
		return;
	}

	const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
	for (const c of commits) counts[c.bucket]++;

	if (argv.includes("--json")) {
		console.log(
			JSON.stringify(
				{
					generated_from: git("rev-parse", "HEAD").trim(),
					ai_era_start: AI_ERA_START,
					total_commits: commits.length,
					counts,
					note: "ai-inferred and human-inferred are heuristics over commit-message shape, not ground truth.",
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Commits: ${commits.length}   (AI era begins ${AI_ERA_START})`);
	for (const b of BUCKETS) {
		const pct = ((100 * counts[b]) / commits.length).toFixed(1);
		const certainty = b.endsWith("-inferred") ? "inferred" : "certain";
		console.log(`  ${b.padEnd(15)} ${String(counts[b]).padStart(5)}  ${pct.padStart(5)}%   (${certainty})`);
	}
	const overrideCount = Object.keys(overrides).length;
	console.log(
		overrideCount
			? `\n${overrideCount} commit(s) reclassified by hand via provenance-overrides.json`
			: "\nNo hand corrections recorded yet (scripts/provenance-overrides.json)",
	);
}

if (process.argv[1] && process.argv[1].endsWith("provenance.mjs")) main();
