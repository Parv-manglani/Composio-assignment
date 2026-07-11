#!/usr/bin/env node
// Research pipeline: for each app, (1) check whether Composio already has a toolkit
// for it, and (2) ask Claude — with the web_search tool turned on — to research the
// app's real docs and fill in the schema used across this project's dataset.
//
// Requires:
//   ANTHROPIC_API_KEY   - for the research/classification step (Claude + web_search)
//   COMPOSIO_API_KEY    - optional, only used for the richer session.tools() cross-check
//
// Usage:
//   node research.mjs                 # research all 100 apps
//   node research.mjs --limit=10      # research only the first 10 (smoke test)
//   node research.mjs --ids=1,7,55    # research specific app ids

import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

const SCHEMA_INSTRUCTIONS = `
Research this app and return ONE JSON object with exactly this shape (no markdown fences, no prose):

{
  "id": <int>,
  "name": "<app name>",
  "category": "<category>",
  "one_liner": "<what it does, <=15 words>",
  "auth_methods": ["OAuth2"|"API Key"|"Basic"|"Token"|"Other: <desc>", ...],
  "self_serve": "free_self_serve" | "trial_self_serve" | "paid_plan_required" | "admin_approval_required" | "partner_gated" | "contact_sales",
  "self_serve_notes": "<1 sentence with evidence>",
  "api_surface": {
    "type": "REST" | "GraphQL" | "REST+GraphQL" | "SOAP" | "none_public" | "SDK_only",
    "breadth": "broad" | "narrow" | "none",
    "notes": "<1 sentence>"
  },
  "existing_mcp_or_composio_toolkit": {
    "composio_toolkit_exists": true | false | "unknown",
    "third_party_mcp_exists": true | false | "unknown",
    "notes": "<brief>"
  },
  "buildability_verdict": "ready_today" | "ready_with_workaround" | "blocked",
  "main_blocker": "<if not ready_today, the ONE main blocker, else 'none'>",
  "evidence_urls": ["<url1>", "<url2>", ...]
}

Rules:
- Use the web_search tool to find and read the app's real developer docs before answering. Do not guess.
- "self_serve" describes how a developer gets credentials: instantly for free, via a free trial, only on a paid plan, only with admin/workspace approval, only via a partner program, or only via contact-sales.
- Prefer official docs URLs in evidence_urls over blog posts or marketing pages.
- If you cannot find something, say "unknown" and note why in the relevant *_notes field rather than fabricating.
`.trim();

async function checkComposioToolkitExists(appName) {
  // Composio's public toolkit pages are unauthenticated — this mirrors what the
  // research subagents did during the actual run: check composio.dev/toolkits/<slug>
  // for a couple of slug guesses before falling back to "unknown".
  const slugs = [
    appName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
    appName.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/\s+/g, ""),
  ];
  for (const slug of new Set(slugs)) {
    try {
      const res = await fetch(`https://composio.dev/toolkits/${slug}`, { method: "GET" });
      if (res.ok) return { exists: true, slug };
    } catch {
      // network error — treat as inconclusive, try next slug
    }
  }
  return { exists: "unknown", slug: slugs[0] };
}

async function researchApp(client, app) {
  const composioCheck = await checkComposioToolkitExists(app.name);

  const msg = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
    messages: [
      {
        role: "user",
        content: `App to research: "${app.name}" (hint: ${app.hint}), category: "${app.category}", id: ${app.id}.

We already checked Composio's public toolkit catalog ourselves: a toolkit page at composio.dev/toolkits/${composioCheck.slug} ${
          composioCheck.exists === true ? "DOES exist (200 OK)." : "could not be confirmed by a direct fetch — verify independently via web_search if you can."
        }

${SCHEMA_INSTRUCTIONS}`,
      },
    ],
  });

  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON found in response for ${app.name}`);
  const parsed = JSON.parse(jsonMatch[0]);

  // Our own direct HTTP check is authoritative when conclusive — it overrides
  // the model's guess so a confirmed 200 can never be downgraded to "unknown".
  if (composioCheck.exists === true) {
    parsed.existing_mcp_or_composio_toolkit.composio_toolkit_exists = true;
  }
  return parsed;
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const idsArg = args.find((a) => a.startsWith("--ids="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : undefined;
  const onlyIds = idsArg ? idsArg.split("=")[1].split(",").map(Number) : undefined;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY. Set it and re-run.");
    process.exit(1);
  }

  const apps = JSON.parse(await readFile(path.join(DATA_DIR, "apps.json"), "utf8"));
  let toRun = apps;
  if (onlyIds) toRun = apps.filter((a) => onlyIds.includes(a.id));
  else if (limit) toRun = apps.slice(0, limit);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const results = [];
  for (const app of toRun) {
    process.stdout.write(`Researching #${app.id} ${app.name}... `);
    try {
      const result = await researchApp(client, app);
      results.push(result);
      console.log("done");
    } catch (err) {
      console.log(`FAILED (${err.message})`);
      results.push({ id: app.id, name: app.name, error: err.message });
    }
  }

  await mkdir(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, "results.generated.json");
  await writeFile(outPath, JSON.stringify(results, null, 2));
  console.log(`\nWrote ${results.length} records to ${outPath}`);
  console.log(
    "Note: this file is a fresh run's output — it does NOT overwrite data/results.json, " +
      "which is the human-verified dataset the case study is built from. Diff before promoting."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
