/* ============================================================================
   QueryForge — Schema-Aware SQL Generator
   ----------------------------------------------------------------------------
   This file has three responsibilities:
     1. Call the Groq API (chat completions, JSON object mode) to turn a
        plain-English question + a pasted schema into a SQL query, an
        explanation, and a list of tables used.
     2. Defensively parse whatever Groq returns, even if it's wrapped in
        markdown fences or has stray text around the JSON.
     3. Lazily boot sql.js (SQLite compiled to WebAssembly) and actually
        execute the generated SQL against pasted sample data, so the result
        is verified in the browser instead of just trusted from the LLM.
   ============================================================================ */

/* ============================================================================
   CONFIG
   ============================================================================ */

// PASTE YOUR GROQ API KEY HERE. Get one at https://console.groq.com/keys
// This key is used directly from the browser — see the README for the
// security tradeoffs of that before deploying this publicly.
const API_KEY = "PASTE_YOUR_GROQ_API_KEY_HERE";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// A current Groq-hosted model that supports JSON object mode and has a
// large context window. Swap this string if you want to try another model
// from https://console.groq.com/docs/models — no other code changes needed.
const GROQ_MODEL = "llama-3.3-70b-versatile";

// sql.js is loaded via <script> tag in index.html (window.initSqlJs).
// This is where its .wasm binary lives — must match the script version.
const SQL_JS_CDN_BASE = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.5.0/";

const DIALECT_LABELS = {
  sqlite: "SQLite",
  mysql: "MySQL",
  postgresql: "PostgreSQL",
};

/* ============================================================================
   DOM REFERENCES
   ============================================================================ */

const els = {};

function cacheElements() {
  els.schemaInput = document.getElementById("schemaInput");
  els.sampleDataInput = document.getElementById("sampleDataInput");
  els.questionInput = document.getElementById("questionInput");
  els.dialectSelect = document.getElementById("dialectSelect");

  els.generateBtn = document.getElementById("generateBtn");
  els.generateSpinner = document.getElementById("generateSpinner");
  els.clearBtn = document.getElementById("clearBtn");
  els.statusText = document.getElementById("statusText");

  els.tablesUsedList = document.getElementById("tablesUsedList");
  els.sqlOutput = document.getElementById("sqlOutput");
  els.explanationOutput = document.getElementById("explanationOutput");
  els.copyBtn = document.getElementById("copyBtn");

  els.runBtn = document.getElementById("runBtn");
  els.runSpinner = document.getElementById("runSpinner");
  els.resultsContainer = document.getElementById("resultsContainer");

  els.progressBar = document.getElementById("progressBar");
}

/* ============================================================================
   APP STATE
   ============================================================================ */

const state = {
  generatedSql: "",       // last SQL string returned by Groq
  sqlJsModule: null,      // the initialized SQL.js module (window.initSqlJs result)
  sqlJsLoadingPromise: null, // guards against loading sql.js more than once
};

/* ============================================================================
   SMALL UI HELPERS
   ============================================================================ */

function setStatus(message, type = "info") {
  els.statusText.textContent = message || "";
  els.statusText.className = "status-text" + (message ? ` ${type}` : "");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Simple ref-counted visibility so the top progress bar stays correct even
// if generation and execution ever overlap (e.g. a fast double-click).
let activeOperations = 0;

function pushProgress() {
  activeOperations += 1;
  if (els.progressBar) els.progressBar.hidden = false;
}

function popProgress() {
  activeOperations = Math.max(0, activeOperations - 1);
  if (activeOperations === 0 && els.progressBar) els.progressBar.hidden = true;
}

function setGeneratingState(isGenerating) {
  els.generateBtn.disabled = isGenerating;
  els.generateSpinner.hidden = !isGenerating;
  els.clearBtn.disabled = isGenerating;
  if (isGenerating) {
    pushProgress();
  } else {
    popProgress();
  }
}

function setRunningState(isRunning) {
  els.runBtn.disabled = isRunning || !state.generatedSql;
  els.runSpinner.hidden = !isRunning;
  if (isRunning) {
    pushProgress();
  } else {
    popProgress();
  }
}

function renderErrorBox(container, title, message) {
  container.innerHTML = `
    <div class="error-box">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

/* ============================================================================
   DEFENSIVE JSON PARSING
   ----------------------------------------------------------------------------
   Groq's JSON object mode is generally reliable, but models sometimes wrap
   their output in ```json fences, add a leading sentence, or add trailing
   commentary. This function tries several strategies before giving up.
   ============================================================================ */

function parseModelJson(rawText) {
  if (!rawText || !rawText.trim()) {
    throw new Error("Groq returned an empty response with no JSON to parse.");
  }

  let text = rawText.trim();

  // Strategy 1: strip a markdown code fence if the whole response is wrapped in one.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  }

  // Strategy 2: try parsing directly.
  try {
    return JSON.parse(text);
  } catch (_) {
    // fall through to the next strategy
  }

  // Strategy 3: extract the substring between the first "{" and the last "}",
  // in case the model added stray text before or after the JSON object.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // fall through to final failure
    }
  }

  throw new Error(
    "Couldn't parse a valid JSON object from Groq's response. The model may have replied in an unexpected format — try again."
  );
}

/* ============================================================================
   PROMPT BUILDING
   ============================================================================ */

function buildMessages(schema, sampleData, question, dialectLabel) {
  const systemPrompt = `You are an expert SQL assistant. You will be given a database schema, optional sample data, a plain-English question, and a target SQL dialect.

Write a single, correct SQL query in the ${dialectLabel} dialect that answers the question using only the tables and columns provided in the schema. Use dialect-appropriate syntax (for example: identifier quoting, string functions, LIMIT/OFFSET vs FETCH, date functions) for ${dialectLabel} specifically.

Respond with a JSON object and nothing else — no markdown code fences, no commentary before or after it. The JSON object must have exactly this shape:
{"sql": "the SQL query as a single string", "explanation": "a short plain-English explanation of what the query does and why", "tables_used": ["table_name_1", "table_name_2"]}`;

  const userPrompt = `SQL dialect: ${dialectLabel}

Schema:
${schema}

Sample data:
${sampleData ? sampleData : "(none provided)"}

Question: ${question}

Respond only with the JSON object described in the system message.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

/* ============================================================================
   GENERATE SQL (Groq API call)
   ============================================================================ */

async function generateSql() {
  const schema = els.schemaInput.value.trim();
  const sampleData = els.sampleDataInput.value.trim();
  const question = els.questionInput.value.trim();
  const dialect = els.dialectSelect.value;
  const dialectLabel = DIALECT_LABELS[dialect] || dialect;

  // --- Validation ---
  if (!schema) {
    setStatus("Paste your schema (CREATE TABLE statements) before generating.", "error");
    els.schemaInput.focus();
    return;
  }
  if (!question) {
    setStatus("Type a question about your data before generating.", "error");
    els.questionInput.focus();
    return;
  }
  if (!API_KEY || API_KEY === "PASTE_YOUR_GROQ_API_KEY_HERE") {
    setStatus(
      "No Groq API key set. Open script.js and paste your key into the API_KEY constant.",
      "error"
    );
    return;
  }

  setGeneratingState(true);
  setStatus("Contacting Groq and generating your SQL query…", "info");

  try {
    const messages = buildMessages(schema, sampleData, question, dialectLabel);

    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: messages,
      }),
    });

    if (!response.ok) {
      let detail = "";
      try {
        const errJson = await response.json();
        detail = (errJson && errJson.error && errJson.error.message) || "";
      } catch (_) {
        // response body wasn't JSON — ignore and use the generic message below
      }

      if (response.status === 401) {
        throw new Error(
          "Groq rejected the request: invalid API key. Check the API_KEY constant in script.js."
        );
      }
      if (response.status === 429) {
        throw new Error(
          `Groq rate limit reached. Wait a moment and try again.${detail ? " (" + detail + ")" : ""}`
        );
      }
      if (response.status === 400) {
        throw new Error(`Groq rejected the request${detail ? ": " + detail : "."}`);
      }
      throw new Error(`Groq API error (status ${response.status})${detail ? ": " + detail : "."}`);
    }

    const data = await response.json();
    const rawContent = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;

    if (!rawContent) {
      throw new Error("Groq's response didn't include any message content to parse.");
    }

    const parsed = parseModelJson(rawContent);

    if (!parsed || typeof parsed.sql !== "string" || !parsed.sql.trim()) {
      throw new Error("Groq's response was missing a valid \"sql\" field.");
    }

    const explanation = typeof parsed.explanation === "string" && parsed.explanation.trim()
      ? parsed.explanation.trim()
      : "No explanation was provided.";
    const tablesUsed = Array.isArray(parsed.tables_used) ? parsed.tables_used.filter(Boolean) : [];

    // --- Render results ---
    state.generatedSql = parsed.sql.trim();
    els.sqlOutput.textContent = state.generatedSql;
    els.sqlOutput.className = "language-sql";
    if (window.hljs) {
      window.hljs.highlightElement(els.sqlOutput);
    }

    els.explanationOutput.textContent = explanation;

    els.tablesUsedList.innerHTML = tablesUsed.length
      ? tablesUsed.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")
      : "";

    els.copyBtn.disabled = false;
    els.runBtn.disabled = false;
    els.resultsContainer.innerHTML = "";

    setStatus("SQL generated. Review it, then click \"Run query\" to verify it live.", "success");
  } catch (err) {
    if (err instanceof TypeError) {
      setStatus(
        "Network error: couldn't reach the Groq API. Check your internet connection.",
        "error"
      );
    } else {
      setStatus(err.message, "error");
    }
  } finally {
    setGeneratingState(false);
  }
}

/* ============================================================================
   LAZY SQL.JS INITIALIZATION
   ----------------------------------------------------------------------------
   sql.js is loaded once, on the first "Run query" click, rather than on
   page load, since it has to fetch and instantiate a WebAssembly binary.
   ============================================================================ */

function ensureSqlJsLoaded() {
  if (state.sqlJsModule) {
    return Promise.resolve(state.sqlJsModule);
  }
  if (state.sqlJsLoadingPromise) {
    return state.sqlJsLoadingPromise;
  }
  if (typeof window.initSqlJs !== "function") {
    return Promise.reject(
      new Error("sql.js failed to load from the CDN. Check your internet connection and reload the page.")
    );
  }

  state.sqlJsLoadingPromise = window
    .initSqlJs({ locateFile: (file) => SQL_JS_CDN_BASE + file })
    .then((SQL) => {
      state.sqlJsModule = SQL;
      return SQL;
    })
    .catch((err) => {
      state.sqlJsLoadingPromise = null; // allow retrying on the next click
      throw new Error("Failed to initialize sql.js: " + err.message);
    });

  return state.sqlJsLoadingPromise;
}

/* ============================================================================
   RUN QUERY (execute against sql.js)
   ============================================================================ */

async function runQuery() {
  const schema = els.schemaInput.value.trim();
  const sampleData = els.sampleDataInput.value.trim();
  const dialect = els.dialectSelect.value;
  const dialectLabel = DIALECT_LABELS[dialect] || dialect;

  if (!state.generatedSql) {
    setStatus("Generate a SQL query first before running it.", "error");
    return;
  }
  if (!schema || !sampleData) {
    renderErrorBox(
      els.resultsContainer,
      "Nothing to run against yet",
      "Paste both your schema (CREATE TABLE statements) and sample data (INSERT statements) on the left to run this query live. Live execution needs real rows to select from."
    );
    return;
  }

  setRunningState(true);
  els.resultsContainer.innerHTML = "";
  setStatus("Loading sql.js and executing the query…", "info");

  try {
    const SQL = await ensureSqlJsLoaded();

    // A fresh in-memory database per run avoids stale state or duplicate-row
    // errors from re-running the same INSERT statements multiple times.
    const db = new SQL.Database();

    try {
      db.run(schema);
    } catch (schemaErr) {
      renderErrorBox(
        els.resultsContainer,
        "Error running the schema",
        `Your CREATE TABLE statements couldn't be executed: ${schemaErr.message}`
      );
      setStatus("", "info");
      return;
    }

    try {
      db.run(sampleData);
    } catch (dataErr) {
      renderErrorBox(
        els.resultsContainer,
        "Error running the sample data",
        `Your INSERT statements couldn't be executed: ${dataErr.message}`
      );
      setStatus("", "info");
      return;
    }

    let execResult;
    try {
      execResult = db.exec(state.generatedSql);
    } catch (queryErr) {
      if (dialect !== "sqlite") {
        renderErrorBox(
          els.resultsContainer,
          "Live verification isn't fully compatible with this dialect",
          `This query uses ${dialectLabel}-specific syntax that SQLite (used here for live verification) couldn't run: ${queryErr.message}. Live execution only reliably works with SQLite-compatible SQL — the query itself may still be correct for ${dialectLabel}. Review it manually or switch the dialect to SQLite to test execution.`
        );
      } else {
        renderErrorBox(els.resultsContainer, "SQL execution error", queryErr.message);
      }
      setStatus("", "info");
      return;
    } finally {
      db.close();
    }

    renderResults(execResult, dialect, dialectLabel);
    setStatus("Query executed successfully against sql.js.", "success");
  } catch (err) {
    renderErrorBox(els.resultsContainer, "Couldn't run the query", err.message);
    setStatus("", "info");
  } finally {
    setRunningState(false);
  }
}

function renderResults(execResult, dialect, dialectLabel) {
  let html = "";

  if (dialect !== "sqlite") {
    html += `
      <div class="note-box">
        <strong>Note:</strong> this ran successfully against SQLite for in-browser
        verification. Behavior on real ${dialectLabel} may still differ for
        dialect-specific functions, types, or clauses.
      </div>
    `;
  }

  if (!execResult || execResult.length === 0) {
    html += `
      <div class="success-box">
        <strong>Executed successfully.</strong> The query ran without errors but
        returned no result set (this is normal for statements that don't SELECT rows).
      </div>
    `;
    els.resultsContainer.innerHTML = html;
    return;
  }

  // Render the last statement's result set (matches what a user typically expects
  // to see when a generated query is a single SELECT).
  const { columns, values } = execResult[execResult.length - 1];

  // A row-number gutter column, styled like a real database client's result
  // grid, is prepended ahead of the actual data columns.
  const headerHtml =
    `<th class="col-rownum">#</th>` +
    columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("");

  const rowsHtml = values
    .map((row, index) => {
      const dataCells = row
        .map((cell) => `<td>${cell === null ? "<em>NULL</em>" : escapeHtml(cell)}</td>`)
        .join("");
      return `<tr><td class="col-rownum">${index + 1}</td>${dataCells}</tr>`;
    })
    .join("");

  html += `
    <div class="table-scroll">
      <table class="results-table">
        <thead><tr>${headerHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <p class="results-meta">${values.length} row${values.length === 1 ? "" : "s"} returned.</p>
  `;

  els.resultsContainer.innerHTML = html;
}

/* ============================================================================
   COPY SQL
   ============================================================================ */

async function copySql() {
  if (!state.generatedSql) return;

  const originalLabel = els.copyBtn.textContent;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(state.generatedSql);
    } else {
      // Fallback for browsers without the async Clipboard API.
      const tempTextarea = document.createElement("textarea");
      tempTextarea.value = state.generatedSql;
      tempTextarea.style.position = "fixed";
      tempTextarea.style.opacity = "0";
      document.body.appendChild(tempTextarea);
      tempTextarea.select();
      document.execCommand("copy");
      document.body.removeChild(tempTextarea);
    }
    els.copyBtn.textContent = "Copied!";
  } catch (_) {
    els.copyBtn.textContent = "Copy failed";
  }

  setTimeout(() => {
    els.copyBtn.textContent = originalLabel;
  }, 1500);
}

/* ============================================================================
   CLEAR ALL
   ============================================================================ */

function clearAll() {
  els.schemaInput.value = "";
  els.sampleDataInput.value = "";
  els.questionInput.value = "";
  els.dialectSelect.value = "sqlite";

  state.generatedSql = "";

  els.sqlOutput.textContent = "-- Your generated SQL will appear here";
  els.sqlOutput.className = "language-sql";
  if (window.hljs) {
    window.hljs.highlightElement(els.sqlOutput);
  }

  els.explanationOutput.textContent = "Fill in a schema and a question on the left, then click \"Generate SQL\".";
  els.tablesUsedList.innerHTML = "";
  els.resultsContainer.innerHTML = "";

  els.copyBtn.disabled = true;
  els.runBtn.disabled = true;

  setStatus("", "info");
  els.schemaInput.focus();
}

/* ============================================================================
   INIT
   ============================================================================ */

function attachEventListeners() {
  els.generateBtn.addEventListener("click", generateSql);
  els.runBtn.addEventListener("click", runQuery);
  els.copyBtn.addEventListener("click", copySql);
  els.clearBtn.addEventListener("click", clearAll);
}

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  attachEventListeners();
});
