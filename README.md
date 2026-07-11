# Composio App Research — AI Product Ops Intern take-home

**Deliverable:** [`site/index.html`](site/index.html) — a single self-contained HTML page with the patterns, the full 100-app matrix, the research pipeline, and the verification trail (including what it got wrong on the first pass).

A live preview of the same page was also published as a Claude Artifact during development; the canonical deliverable is the file in this repo, meant to be served via GitHub Pages / Vercel from `site/`.

## What's in this repo

```
data/
  apps.json                 the 100-app research set (id, name, hint, category)
  raw/                      one JSON file per category, straight from each research subagent
  results.json              the merged, human-verified dataset (100 records) — source of truth
  verification.json         the manual verification log (15-app sample, pass-1 vs pass-2 accuracy)
  link_check_report.json    output of the automated evidence-URL liveness check
agent/
  research.mjs              reusable research pipeline: Composio toolkit check + Claude w/ web_search
  verify.mjs                automated verification loop #2: checks every evidence URL is still live
  package.json
site/
  template.html              page template with __RESULTS_JSON__ / __VERIFICATION_JSON__ placeholders
  index.html                  the built, self-contained deliverable (template + data injected)
```

## How the research was actually produced

The 100-app research pass that's baked into `data/results.json` was **not** run by executing `agent/research.mjs` end-to-end — it was run by Claude Code itself, split into 10 parallel subagents (one per category), each of which:

1. Used `WebFetch`/`WebSearch` to check `composio.dev/toolkits/<slug>` and confirm/deny whether Composio already has a toolkit for the app.
2. Used `WebSearch` + `WebFetch` to find and read the app's real developer docs, and classify auth method, self-serve tier, API surface, and buildability verdict against a fixed JSON schema.
3. Returned one JSON object per app; the 10 outputs were merged, deduplicated, and validated (all 100 ids present, no duplicates) into `data/results.json`.

`agent/research.mjs` is the **reusable, standalone version of that same logic** — it exists so this pipeline can be re-run later (e.g. against a different app list, or to refresh stale findings) without needing Claude Code as the orchestrator. It uses:

- The **Composio SDK / public toolkit pages** to check toolkit existence (mirrors step 1 above).
- **Claude with the `web_search` tool** to do the actual docs research and fill in the schema (mirrors step 2 above).

This is disclosed rather than glossed over: the take-home's own instructions ask "what does it do and where did it need a human" — the honest answer is that a human (via Claude Code) orchestrated the first full run, and a human also did the entire verification pass below. The script exists to make future runs reproducible without that orchestration.

### Running the pipeline yourself

```bash
cd agent
npm install
export ANTHROPIC_API_KEY=sk-ant-...      # required
node research.mjs --limit=10             # smoke test on the first 10 apps
node research.mjs                        # full 100-app run -> data/results.generated.json
```

`research.mjs` never overwrites `data/results.json` — it writes to `data/results.generated.json` so a fresh run can be diffed against the verified dataset before being promoted.

```bash
node verify.mjs --sample=25              # automated evidence-URL liveness check, no API key needed
```

### Rebuilding the site from data

`site/index.html` is `site/template.html` with `data/results.json` and `data/verification.json` spliced into two `<script type="application/json">` blocks:

```bash
node -e "
const fs = require('fs');
const t = fs.readFileSync('site/template.html','utf8');
const r = fs.readFileSync('data/results.json','utf8');
const v = fs.readFileSync('data/verification.json','utf8');
fs.writeFileSync('site/index.html', t.replace('__RESULTS_JSON__', r).replace('__VERIFICATION_JSON__', v));
"
```

## Verification — how we know the findings are trustworthy

Two independent checks ran on top of the research pass, both summarized on the deliverable page itself:

1. **Manual doc cross-check** (`data/verification.json`): 15 apps sampled across categories and verdicts, each claim re-derived from the primary source independently (not by re-reading the subagent's reasoning). Found and fixed a genuine factual error (Reducto's Composio toolkit status), a conflated claim (Twilio's MCP server scope), a numeric drift (GitHub's tool count), and flagged one claim as unverifiable rather than assuming it was right (Pinterest Ads).
2. **Automated link-liveness check** (`agent/verify.mjs` → `data/link_check_report.json`): fetches every evidence URL for a random sample and flags non-2xx responses. This is disclosed as a coarse signal, not proof — several flagged links turned out to be 403s from bot-protected sites rather than actually broken.

Pass-1 strict accuracy, pass-1 directional accuracy (would the buildability verdict itself have been wrong), and pass-2 accuracy after fixes are all reported on the deliverable page.

## Honesty notes

- Apps with no public self-serve developer docs found at all (Paygent Connect, Waterfall.io, NotebookLM's consumer product, fanbasis) are marked `blocked` with "no public docs found" rather than a fabricated API surface.
- Where an app is gated behind a paid plan, admin approval, a partner program, or contact-sales, that's recorded as the finding — not treated as a research failure.
- The dataset's `existing_mcp_or_composio_toolkit.composio_toolkit_exists` field can be `"unknown"` where a Composio toolkit page returned an ambiguous result the subagent couldn't confidently resolve; this is intentional rather than a forced guess.
