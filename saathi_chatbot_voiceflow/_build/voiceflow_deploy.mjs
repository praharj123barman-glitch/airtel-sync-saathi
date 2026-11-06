/*
 * voiceflow_deploy.mjs: builds the Saathi agent in Voiceflow from this kit's files, through Voiceflow's API (BUILD
 * SCRIPT).
 *
 * What it does, in order (every step is safe to re-run: things are found by name and updated in place, and only what
 * is missing is created):
 *   1. project variables: the conversation variables the playbooks use, plus one per function-tool output
 *   2. the 11 function tools: code from 3_function_tools/, inputs from START_HERE.md's tool reference (checked
 *      against the code by a test), outputs read from the generated tool itself, descriptions from TOOL_SETUP.md
 *   3. the 5 playbooks from 2_playbooks/ (Name, Trigger, Instructions), each with Buttons and the knowledge base on
 *   4. tool attachments: each playbook's "Tools" line, plus consent_manager on the agent itself; every input mapped,
 *      every output saved to the same-named variable
 *   5. the agent: global prompt and routing from 1_agent_global_prompt.txt, the playbook routing list (Trigger =
 *      routing description, "Required variables" line), knowledge base tool on
 *   6. the knowledge base: the 3 text documents and the catalogue as a table, from 4_knowledge_base/
 *   7. compile the environment, so test conversations run against what was just built
 *
 * What it does NOT do (manual: a person does these in Voiceflow): sign in, create the API key, connect Google
 * Sheets (needs your Google sign-in), set the initialization workflow for referral links, publish, or choose a paid
 * model. It never deletes anything.
 *
 * How it fits: reads the API key from .env through _build/voiceflow_api.mjs (never printed). Run after any change
 * to the prompt, playbooks, tools or knowledge base:  node _build/voiceflow_deploy.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { request, ENVIRONMENT_ALIAS, PROJECT_ID } from "./voiceflow_api.mjs";

// ================================================================ CONFIG

const KIT_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTION_DIRECTORY = path.join(KIT_DIRECTORY, "3_function_tools");
const PLAYBOOK_DIRECTORY = path.join(KIT_DIRECTORY, "2_playbooks");
const KNOWLEDGE_BASE_DIRECTORY = path.join(KIT_DIRECTORY, "4_knowledge_base");
const GLOBAL_PROMPT_FILE = path.join(KIT_DIRECTORY, "1_agent_global_prompt.txt");
const START_HERE_FILE = path.join(KIT_DIRECTORY, "START_HERE.md");
const TOOL_SETUP_FILE = path.join(FUNCTION_DIRECTORY, "TOOL_SETUP.md");

/** The 11 function tools (Voiceflow tool name = file name). verify_gstin_lite is only a manual fallback. */
const FUNCTION_TOOLS = [
  "price_bundle",
  "verify_gstin",
  "verify_udyam",
  "register_lead",
  "order_status",
  "onboard_from_gstin",
  "bill_swap",
  "readiness_score",
  "reach_tag_lead",
  "downtime_credit",
  "consent_manager",
];
/** Attached to the agent itself as well: an owner can withdraw consent in any playbook (global prompt, "Consent"). */
const AGENT_LEVEL_TOOLS = ["consent_manager"];
/** Conversation variables the playbooks set or read that are not tool outputs (START_HERE.md, step 4). */
const CONVERSATION_VARIABLES = [
  "referral_code",
  "quote_accepted",
  "has_gstin",
  "has_udyam",
  "stage",
  "reason_not_closed",
  "contact_name",
  "contact_phone",
  "callback_time",
  "order_id",
  "lang",
];
/** The global prompt's sections that are routing, sent as the agent's "instructions"; the rest is the prompt. */
const ROUTING_SECTION_TITLES = ["# Where to send the conversation", "# First message"];
/** The line that separates a file's header from the text to paste (prompt and playbooks). */
const PASTE_MARKER = /^-{20,}.*$/m;
const VARIABLE_COLOR = "#5B9FD7";
const TEXT_DOCUMENTS = ["saathi_bundles_and_rules.txt", "saathi_faq.txt", "saathi_privacy_notice.txt"];
const CATALOGUE_TABLE = "accel_product_catalogue.csv";
const BUTTON_TOOL_DESCRIPTION =
  "Use this tool to show quick-reply buttons whenever the playbook lists buttons, and for consent Yes/No answers. " +
  "Labels must match the playbook's wording exactly. Never use buttons for free-form input.";
const KNOWLEDGE_BASE_TOOL_DESCRIPTION =
  "Use this tool for general questions about products, documents, installation, billing, the activation " +
  "guarantee and privacy. Never use it for prices or bundles: those come only from price_bundle.";

// ================================================================ LOGIC: reading the kit's files

const readText = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/** The text below a file's dashed "paste below" line. */
function textBelowPasteMarker(text) {
  const match = text.match(PASTE_MARKER);
  if (!match) throw new Error("paste marker line not found");
  return text.slice(match.index + match[0].length).trim();
}

/** The global prompt split into { prompt, instructions } by section heading (see ROUTING_SECTION_TITLES). */
function readGlobalPrompt() {
  const body = textBelowPasteMarker(readText(GLOBAL_PROMPT_FILE));
  const sections = body.split(/\n(?=# )/);
  const isRouting = (section) => ROUTING_SECTION_TITLES.some((title) => section.startsWith(title));
  return {
    prompt: sections
      .filter((section) => !isRouting(section))
      .join("\n\n")
      .trim(),
    instructions: sections.filter(isRouting).join("\n\n").trim(),
  };
}

/** A header field ("Trigger  : …") with its continuation lines, as one line of text. */
function headerField(header, fieldName) {
  const match = header.match(new RegExp("^" + fieldName + "\\s*:\\s*([\\s\\S]*?)(?=\\n\\S|$)", "m"));
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

/** Every playbook file as { file, name, trigger, tools, requiredVariables, instructions }. */
function readPlaybooks() {
  return fs
    .readdirSync(PLAYBOOK_DIRECTORY)
    .filter((file) => file.endsWith(".txt"))
    .sort()
    .map((file) => {
      const text = readText(path.join(PLAYBOOK_DIRECTORY, file));
      const header = text.slice(0, text.search(PASTE_MARKER));
      const toolsLine = headerField(header, "Tools");
      const required = headerField(header, "Required variables").split(/[ (]/)[0];
      return {
        file,
        name: headerField(header, "Name"),
        trigger: headerField(header, "Trigger"),
        tools: FUNCTION_TOOLS.filter((tool) => new RegExp("\\b" + tool + "\\b").test(toolsLine)),
        requiredVariables: required && required !== "none" ? required.split(/,\s*/) : [],
        instructions: textBelowPasteMarker(text),
      };
    });
}

/** Each tool's input descriptions from START_HERE.md's tool reference: { tool: { input: description } }. */
function readInputDescriptions() {
  const guide = readText(START_HERE_FILE);
  const result = {};
  FUNCTION_TOOLS.forEach((tool) => {
    const start = guide.indexOf("`" + tool + "`\n\n- **Voiceflow tool name:**");
    if (start < 0) throw new Error("START_HERE.md has no section for " + tool);
    const end = guide.indexOf("\n#### ", start);
    const section = guide.slice(start, end < 0 ? guide.indexOf("\n---", start) : end);
    result[tool] = {};
    for (const row of section.matchAll(/^\| `([a-z_]+)` \| ([^|]*) \| ([^|]*) \| ([^|]*) \|$/gm)) {
      result[tool][row[1]] = `${row[4].trim()} (${row[2].trim()}; ${row[3].trim().toLowerCase()})`;
    }
  });
  return result;
}

/** Each tool's "Tool description" from TOOL_SETUP.md. */
function readToolDescriptions() {
  const setup = readText(TOOL_SETUP_FILE);
  const result = {};
  FUNCTION_TOOLS.forEach((tool) => {
    const start = setup.indexOf("`" + tool + "`:");
    const match = start < 0 ? null : setup.slice(start).match(/\*\*Tool description:\*\* \*([\s\S]*?)\*\n/);
    if (!match) throw new Error("TOOL_SETUP.md has no tool description for " + tool);
    result[tool] = match[1].replace(/\s+/g, " ").trim();
  });
  return result;
}

/** The outputs a generated tool returns (same method as the test suite): run it with no inputs. */
async function readOutputNames(tool) {
  const main = (await import(pathToFileURL(path.join(FUNCTION_DIRECTORY, tool + ".js")).href)).default;
  return Object.keys((await main({ inputVars: {} })).outputVars);
}

/** CSV text → array of row objects (quoted fields may hold commas, quotes and line breaks). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (inQuotes) {
      if (character === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (character === '"') inQuotes = false;
      else field += character;
    } else if (character === '"') inQuotes = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") field += character;
  }
  if (field || row.length) rows.push(row.concat(field));
  const header = rows.shift();
  return rows
    .filter((cells) => cells.length === header.length)
    .map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index]])));
}

// ================================================================ LOGIC: Voiceflow steps

const log = (line) => console.log(line);
const byName = (items) => Object.fromEntries(items.map((item) => [item.name, item]));

/** Step 1: creates the missing project variables; returns { name: id } for every variable. */
async function ensureVariables(names) {
  const existing = byName((await request("GET", "/v1/stable/variable")).variables);
  const missing = [...new Set(names)].filter((name) => !existing[name]);
  if (missing.length) {
    const created = await request("POST", "/v2/stable/variable/batch", {
      variables: missing.map((name) => ({ name, color: VARIABLE_COLOR, description: "Saathi: " + name })),
    });
    created.variables.forEach((variable) => (existing[variable.name] = variable));
  }
  log(`variables: ${missing.length} created, ${Object.keys(existing).length} in the project`);
  return Object.fromEntries(Object.values(existing).map((variable) => [variable.name, variable.id]));
}

/** Step 2: creates or updates one function and its variables; returns { id, inputIDs, outputIDs }. */
async function ensureFunction(tool, existingFunctions, description, inputNames, outputNames) {
  const code = fs.readFileSync(path.join(FUNCTION_DIRECTORY, tool + ".js"), "utf8");
  let functionID = existingFunctions[tool] && existingFunctions[tool].id;
  if (functionID) {
    await request("PATCH", `/v1/stable/function/${functionID}`, { code, description });
  } else {
    functionID = (await request("POST", "/v1/stable/function", { name: tool, code, description })).function.id;
  }
  const current = (await request("GET", "/v1/stable/function-variable", undefined, { functionID })).variables;
  const has = (name, type) => current.some((variable) => variable.name === name && variable.type === type);
  const missing = inputNames
    .filter((name) => !has(name, "input"))
    .map((name) => ({ name, type: "input" }))
    .concat(outputNames.filter((name) => !has(name, "output")).map((name) => ({ name, type: "output" })));
  if (missing.length) {
    const created = await request("POST", "/v1/stable/function-variable/batch", { functionID, variables: missing });
    current.push(...created.variables);
  }
  const idsOf = (type) =>
    Object.fromEntries(current.filter((variable) => variable.type === type).map((v) => [v.name, v.id]));
  log(`function ${tool}: ${existingFunctions[tool] ? "updated" : "created"}, ${missing.length} variables added`);
  return { id: functionID, inputIDs: idsOf("input"), outputIDs: idsOf("output") };
}

/** Step 3: creates or updates one playbook; returns its ID. */
async function ensurePlaybook(playbook, existingPlaybooks) {
  const body = {
    name: playbook.name,
    description: playbook.trigger,
    instructions: playbook.instructions,
    buttonTool: { enabled: true, description: BUTTON_TOOL_DESCRIPTION },
    knowledgeBaseTool: { enabled: true, description: KNOWLEDGE_BASE_TOOL_DESCRIPTION },
  };
  const existing = existingPlaybooks[playbook.name];
  const result = existing
    ? await request("PATCH", `/v2/stable/playbook/${existing.id}`, body)
    : await request("POST", "/v2/stable/playbook", body);
  const id = existing ? existing.id : result.playbook.id;
  const unresolved = (result.unresolvedReferences || []).length;
  log(
    `playbook ${playbook.name}: ${existing ? "updated" : "created"}${unresolved ? ` (${unresolved} literal refs)` : ""}`,
  );
  return id;
}

/** Step 4: attaches (or re-maps) a function tool on a target ({ global: true } or { playbookID }). */
async function ensureToolAttachment(target, tool, built, inputDescriptions, toolDescription, variableIDs) {
  const query = target.global ? { global: "true" } : { playbookID: target.playbookID };
  const attached = (await request("GET", "/v2/stable/tool", undefined, query)).tools.find(
    (attachment) => attachment.type === "function" && attachment.functionID === built.id,
  );
  const inputVariables = Object.fromEntries(
    Object.entries(built.inputIDs).map(([name, id]) => [
      name,
      { functionInputVariableID: id, description: inputDescriptions[name] || name, required: false },
    ]),
  );
  const captureResponse = Object.fromEntries(
    Object.entries(built.outputIDs).map(([name, id]) => [
      name,
      { variableOrEntityID: variableIDs[name], functionOutputVariableID: id, captureType: "variable" },
    ]),
  );
  const body = { type: "function", description: toolDescription, inputVariables, captureResponse };
  if (attached) await request("PATCH", `/v2/stable/tool/${attached.id}`, body);
  else await request("POST", "/v2/stable/tool", Object.assign({ functionID: built.id, target }, body));
  return attached ? "updated" : "attached";
}

/** Step 6: uploads the knowledge base (overwriting same-named documents). */
async function uploadKnowledgeBase() {
  for (const fileName of TEXT_DOCUMENTS) {
    const form = new FormData();
    const content = fs.readFileSync(path.join(KNOWLEDGE_BASE_DIRECTORY, fileName));
    form.append("file", new Blob([content], { type: "text/plain" }), fileName);
    const result = await request("POST", "/v1/stable/document/text", form, { overwrite: "true" });
    log(`knowledge base: ${fileName} → ${result.document.status.type}`);
  }
  const items = parseCsv(fs.readFileSync(path.join(KNOWLEDGE_BASE_DIRECTORY, CATALOGUE_TABLE), "utf8"));
  const result = await request(
    "POST",
    "/v1/stable/document/table",
    { name: CATALOGUE_TABLE, items, schema: { searchableFields: Object.keys(items[0]), metadataFields: [] } },
    { overwrite: "true" },
  );
  log(`knowledge base: ${CATALOGUE_TABLE} (${items.length} products) → ${result.document.status.type}`);
}

async function main() {
  log(`Voiceflow project ${PROJECT_ID}, environment "${ENVIRONMENT_ALIAS}"`);
  const playbooks = readPlaybooks();
  const inputDescriptions = readInputDescriptions();
  const toolDescriptions = readToolDescriptions();
  const outputNamesByTool = {};
  for (const tool of FUNCTION_TOOLS) outputNamesByTool[tool] = await readOutputNames(tool);

  // 1. variables
  const variableIDs = await ensureVariables(
    CONVERSATION_VARIABLES.concat(...Object.values(outputNamesByTool), ...playbooks.map((p) => p.requiredVariables)),
  );

  // 2. functions
  const existingFunctions = byName((await request("GET", "/v1/stable/function")).functions);
  const built = {};
  for (const tool of FUNCTION_TOOLS) {
    built[tool] = await ensureFunction(
      tool,
      existingFunctions,
      toolDescriptions[tool],
      Object.keys(inputDescriptions[tool]),
      outputNamesByTool[tool],
    );
  }

  // 3 + 4. playbooks and their tools
  const existingPlaybooks = byName((await request("GET", "/v2/stable/playbook")).playbooks);
  const playbookIDs = {};
  for (const playbook of playbooks) {
    playbookIDs[playbook.name] = await ensurePlaybook(playbook, existingPlaybooks);
    for (const tool of playbook.tools) {
      const action = await ensureToolAttachment(
        { playbookID: playbookIDs[playbook.name] },
        tool,
        built[tool],
        inputDescriptions[tool],
        toolDescriptions[tool],
        variableIDs,
      );
      log(`  tool ${tool} ${action}`);
    }
  }
  for (const tool of AGENT_LEVEL_TOOLS) {
    const action = await ensureToolAttachment(
      { global: true },
      tool,
      built[tool],
      inputDescriptions[tool],
      toolDescriptions[tool],
      variableIDs,
    );
    log(`agent tool ${tool} ${action}`);
  }

  // 5. agent: prompt, routing, playbook list
  const { prompt, instructions } = readGlobalPrompt();
  const agentResult = await request("PATCH", "/v2/stable/agent", {
    prompt,
    instructions,
    playbooks: playbooks.map((playbook) => ({
      playbookID: playbookIDs[playbook.name],
      description: playbook.trigger,
      condition: null,
      requiredVariables: playbook.requiredVariables.map((name) => ({
        variableOrEntityID: variableIDs[name],
        description: name,
      })),
    })),
    knowledgeBaseTool: { enabled: true, description: KNOWLEDGE_BASE_TOOL_DESCRIPTION },
  });
  log(`agent: prompt and routing set, ${playbooks.length} playbooks routed`);
  (agentResult.unresolvedMentions || []).forEach((mention) => log(`  note: unresolved mention ${mention.mention}`));

  // 6. knowledge base, 7. compile
  await uploadKnowledgeBase();
  const compiled = await request("PUT", `/v1/stable/environment/${ENVIRONMENT_ALIAS}/compile`, undefined, {
    noProject: true,
    projectID: PROJECT_ID,
  });
  log(`compiled in ${compiled.durationMs} ms`);
}

await main();
