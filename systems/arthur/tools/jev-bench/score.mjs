#!/usr/bin/env node
// Offline deterministic scoring of a saved raw file. Usage: node tools/jev-bench/score.mjs results/raw-<id>.json
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus, analyse, renderMarkdown } from "./lib.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(process.argv[2], "utf8"));
const corpus = loadCorpus(join(HERE, "corpus.json"));
if (raw.meta.corpus_sha256 !== corpus.sha256) console.warn("WARNING: corpus changed since this run was recorded.");
const a = analyse(raw.records, corpus);
const out = process.argv[2].replace(/raw-/, "report-").replace(/\.json$/, ".md");
writeFileSync(out, renderMarkdown(a, raw.meta, corpus));
writeFileSync(process.argv[2].replace(/raw-/, "analysis-"), JSON.stringify({ meta: raw.meta, ...a }, null, 1));
console.log("wrote", out);
