#!/usr/bin/env node
// Automated verification loop #1: link-liveness check.
// For a random sample of researched apps, HEAD/GET every evidence_url and report
// which ones 404/error. This is a cheap, fast automatable check that runs on every
// research pass and complements (but does not replace) the manual doc cross-check
// recorded in data/verification.json.
//
// Usage: node verify.mjs [--sample=20]

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

function sample(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

async function checkUrl(url) {
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    return { url, ok: res.ok, status: res.status };
  } catch (err) {
    return { url, ok: false, status: null, error: err.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sampleArg = args.find((a) => a.startsWith("--sample="));
  const n = sampleArg ? parseInt(sampleArg.split("=")[1], 10) : 20;

  const results = JSON.parse(await readFile(path.join(DATA_DIR, "results.json"), "utf8"));
  const picked = sample(results, Math.min(n, results.length));

  const report = [];
  for (const app of picked) {
    const checks = await Promise.all((app.evidence_urls || []).map(checkUrl));
    const brokenLinks = checks.filter((c) => !c.ok);
    report.push({
      id: app.id,
      name: app.name,
      total_evidence_urls: checks.length,
      broken_links: brokenLinks,
    });
    console.log(
      `#${app.id} ${app.name}: ${checks.length - brokenLinks.length}/${checks.length} evidence URLs reachable` +
        (brokenLinks.length ? ` (broken: ${brokenLinks.map((b) => b.url).join(", ")})` : "")
    );
  }

  const totalUrls = report.reduce((s, r) => s + r.total_evidence_urls, 0);
  const totalBroken = report.reduce((s, r) => s + r.broken_links.length, 0);
  console.log(`\n${totalUrls - totalBroken}/${totalUrls} evidence URLs reachable across ${report.length} sampled apps.`);

  await writeFile(
    path.join(DATA_DIR, "link_check_report.json"),
    JSON.stringify({ sampled: report.length, totalUrls, totalBroken, report }, null, 2)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
