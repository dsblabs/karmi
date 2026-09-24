// The browser side of the Playground. It uses the Thread routes of @karmi/http and the routes below /api.
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "karmi-playground-token";

let token = new URLSearchParams(location.hash.slice(1)).get("token") ?? localStorage.getItem(TOKEN_KEY);
let playground;
let stream;
// The streams of the child Threads that the conversation shows. Each one belongs to one child card.
const childStreams = new Set();
// The number of the current view. An async render stops when the operator opened a different view.
let view = 0;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== undefined && child !== null && child !== false));
  return node;
}

async function api(method, path, body) {
  const form = body instanceof FormData;
  const response = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined && !form && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: form ? body : JSON.stringify(body) }),
  });
  if (response.status === 401) {
    showGate("The Playground did not accept this token.");
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    // A crash of the Worker answers with a page from Cloudflare, which is not JSON.
    const { error } = await response.json().catch(() => ({}));
    const fallback = `The Playground answered with HTTP ${response.status}. Look at the Worker logs.`;
    throw Object.assign(new Error(error?.message ?? fallback), { issues: error?.issues });
  }
  return response.status === 204 ? undefined : response.json();
}

function closeStreams() {
  stream?.close();
  for (const child of childStreams) child.close();
  childStreams.clear();
}

function showGate(message = "") {
  closeStreams();
  localStorage.removeItem(TOKEN_KEY);
  $("loading").hidden = true;
  $("app").hidden = true;
  $("gate").hidden = false;
  $("gate-error").textContent = message;
  $("token").focus();
}

$("gate").addEventListener("submit", (event) => {
  event.preventDefault();
  token = $("token").value.trim();
  $("token").value = "";
  void start();
});
$("forget").addEventListener("click", () => showGate());
$("menu").addEventListener("click", () => $("app").classList.toggle("nav-open"));
$("main").addEventListener("click", () => $("app").classList.remove("nav-open"));
addEventListener("hashchange", () => playground && render());

async function start() {
  if (!token) return showGate();
  $("open").disabled = true;
  try {
    playground = await api("GET", "/api/playground");
  } catch (error) {
    // The api function shows the gate for a token that the Playground did not accept.
    if (error.message !== "unauthorized") showGate(`The Playground did not answer: ${error.message}`);
    return;
  } finally {
    $("open").disabled = false;
  }
  localStorage.setItem(TOKEN_KEY, token);
  // The OAuth callback of the MCP scenario adds its outcome to the query. The MCP cards show it one time.
  if (location.search) history.replaceState(null, "", `${location.pathname}${location.hash}`);
  if (location.hash.includes("token=")) history.replaceState(null, "", location.pathname);
  $("loading").hidden = true;
  $("gate").hidden = true;
  $("app").hidden = false;
  const { provider } = playground;
  $("provider").textContent = provider
    ? `Provider: ${provider.label} · Model: ${provider.model}`
    : "No Provider is set up";
  render();
}

const badge = (status) => el("span", { className: `badge ${status}`, textContent: status });

function render() {
  closeStreams();
  view += 1;
  $("app").classList.remove("nav-open");
  const current = location.hash.slice(1) || playground.scenarios[0].id;
  const link = (scenario) =>
    el(
      "li",
      {},
      el(
        "a",
        { href: `#${scenario.id}`, ...(scenario.id === current && { ariaCurrent: "page" }) },
        el("span", { className: `dot ${scenario.status}`, title: scenario.status }),
        scenario.title,
      ),
    );
  $("scenarios").replaceChildren(...playground.scenarios.filter((scenario) => scenario.built).map(link));
  $("planned").replaceChildren(...playground.scenarios.filter((scenario) => !scenario.built).map(link));
  if (current === "coverage") $("coverage-link").ariaCurrent = "page";
  else $("coverage-link").removeAttribute("aria-current");
  const scenario = playground.scenarios.find((item) => item.id === current);
  $("main").scrollTop = 0;
  scrollTo(0, 0);
  if (current === "coverage") renderCoverage();
  else if (scenario?.walkthrough)
    $("main").replaceChildren(
      intro(scenario, el("a", { href: scenario.code, target: "_blank", textContent: "Example code" })),
      walkthroughSteps(scenario),
    );
  else if (scenario?.built) void renderScenario(scenario);
  else if (scenario) $("main").replaceChildren(intro(scenario));
}

function intro(scenario, ...actions) {
  // The notes stay closed, thus the conversation gets the height of the view. Only the reason why a scenario cannot
  // run stays open, because the operator cannot use the scenario without it.
  const localLimits = scenario.localLimits ?? [];
  const notes = [...scenario.modelNotes, ...localLimits, ...(scenario.notes ?? [])];
  const { prerequisites } = scenario;
  return el(
    "section",
    { className: "intro" },
    el(
      "div",
      { className: "title" },
      el("h1", { textContent: scenario.title }),
      badge(scenario.status),
      el("div", { className: "actions" }, ...actions),
    ),
    el("p", { textContent: scenario.summary }),
    scenario.reason && el("p", { className: "note", textContent: scenario.reason }),
    notes.length + prerequisites.length > 0 &&
      el(
        "details",
        { className: "notes" },
        el("summary", {}, notesLabel(notes.length - localLimits.length, localLimits.length, prerequisites.length)),
        el(
          "div",
          {},
          ...notes.map((note) => el("p", { className: "note", textContent: note })),
          prerequisites.length > 0 &&
            el(
              "div",
              { className: "card" },
              el("h3", { textContent: "Prerequisites" }),
              el("ul", {}, ...prerequisites.map((text) => el("li", { textContent: text }))),
            ),
        ),
      ),
  );
}

// The summary of the closed notes of a scenario, with the number of each kind of item.
function notesLabel(notes, localLimits, prerequisites) {
  const count = (number, word) => (number === 0 ? [] : [`${String(number)} ${word}${number === 1 ? "" : "s"}`]);
  const counts = [
    ...count(notes, "note"),
    ...count(localLimits, "local limit"),
    ...count(prerequisites, "prerequisite"),
  ];
  return `Notes and prerequisites (${counts.join(", ")})`;
}

// A scenario with a prerequisite other than Provider setup is optional. The others run after pnpm setup and pnpm dev.
const setupOf = (scenario) => (scenario.prerequisites.length > 0 ? "Optional scenario" : "Default scenario");

// A table cell with one line for each text, or a muted sentence when there is none. A phone shows no header row,
// thus the sentence names the column.
function linesCell(texts, empty) {
  return el(
    "td",
    {},
    texts.length > 0
      ? el("ul", {}, ...texts.map((text) => el("li", { textContent: text })))
      : el("span", { className: "muted", textContent: empty }),
  );
}

function renderCoverage() {
  const title = (id) => playground.scenarios.find((scenario) => scenario.id === id)?.title;
  const groups = Map.groupBy(playground.coverage, (row) => row.group);
  $("main").replaceChildren(
    el(
      "section",
      { className: "intro" },
      el("h1", { textContent: "Feature coverage" }),
      el("p", { textContent: "Each row is a documented feature. A row without a scenario is not shown yet." }),
    ),
    el("h2", { textContent: "Scenarios" }),
    el("p", {
      className: "fine",
      textContent:
        "A default scenario runs after pnpm setup and pnpm dev. An optional scenario needs its prerequisites. In local development, the state is in .wrangler/ and not in a Cloudflare account.",
    }),
    el(
      "div",
      { className: "table", id: "coverage-scenarios" },
      el(
        "table",
        {},
        el(
          "tr",
          {},
          ...["Scenario", "Setup", "Starting data", "Prerequisites", "Local limits"].map((text) =>
            el("th", { textContent: text }),
          ),
        ),
        ...playground.scenarios
          .filter((scenario) => scenario.built)
          .map((scenario) =>
            el(
              "tr",
              {},
              el("td", {}, el("a", { href: `#${scenario.id}`, textContent: scenario.title })),
              el("td", { textContent: setupOf(scenario) }),
              el("td", { textContent: scenario.startingData }),
              linesCell(scenario.prerequisites, "No prerequisite."),
              linesCell(scenario.localLimits ?? [], "No local limit."),
            ),
          ),
      ),
    ),
    el("h2", { textContent: "Features" }),
    el(
      "div",
      { className: "table", id: "coverage-features" },
      el(
        "table",
        {},
        el(
          "tr",
          {},
          ...["Feature", "Scenario", "What you do and see", "Verification"].map((text) =>
            el("th", { textContent: text }),
          ),
        ),
        ...[...groups].flatMap(([group, rows]) => [
          el("tr", { className: "group" }, el("td", { colSpan: 4, textContent: group })),
          ...rows.map((row) =>
            el(
              "tr",
              {},
              el("td", { textContent: row.feature }),
              el(
                "td",
                {},
                row.scenario
                  ? el("a", { href: `#${row.scenario}`, textContent: title(row.scenario) })
                  : el("span", { className: "muted", textContent: "Not built yet" }),
              ),
              el("td", { textContent: row.observable ?? "" }),
              el("td", { textContent: row.verification ?? "" }),
            ),
          ),
        ]),
      ),
    ),
  );
}

/** A definition list of the given rows. A row that is false is left out, and a value can be a node. */
function rows(...items) {
  return el(
    "dl",
    {},
    ...items.filter(Boolean).flatMap(([name, value]) => [el("dt", { textContent: name }), el("dd", {}, value)]),
  );
}

function orderCard(order) {
  return el(
    "div",
    { className: "card titled", id: "order" },
    el("h3", {}, "Order system", el("span", { className: `badge ${order.status}`, textContent: order.status })),
    rows(
      ["Order", order.id],
      ["Customer", order.customer],
      ["Item", order.item],
      ["Total", `$${order.total}`],
      order.refund && ["Refund", `$${order.refund.amount} (${order.refund.reason})`],
    ),
    el("p", { className: "fine", textContent: "This is sample data. Reset restores it." }),
  );
}

const describeMatch = ({ tool, annotations }) =>
  [tool && [tool].flat().join(", "), annotations && `each Tool with ${JSON.stringify(annotations)}`]
    .filter(Boolean)
    .join(" and ") || "each Tool";

function stockCards({ stock, tools, policy }) {
  // A line is a name and optional detail. The detail shows as code, because it is data of the Framework.
  const lines = (tag, items, empty) =>
    items.length > 0
      ? el(
          tag,
          {},
          ...items.map(([name, detail]) =>
            el("li", {}, name, detail && " ", detail && el("code", { textContent: detail })),
          ),
        )
      : el("p", { className: "muted", textContent: empty });
  const list = (title, items, empty) =>
    el("div", { className: "card" }, el("h3", { textContent: title }), lines("ul", items, empty));
  // Reference data stays closed until the operator asks for it.
  const reference = (title, items, empty) =>
    el(
      "details",
      { className: "card" },
      el("summary", { textContent: `${title} (${items.length})` }),
      lines("ul", items, empty),
    );
  return [
    el(
      "div",
      { className: "card", id: "stock" },
      el("h3", { textContent: "Stock system" }),
      el(
        "dl",
        {},
        ...stock.products.flatMap((product) => [
          el("dt", { textContent: product.sku }),
          el("dd", { textContent: `${product.name}: ${product.stock}` }),
        ]),
      ),
      el("p", { className: "fine", textContent: "This is sample data. Reset restores it." }),
    ),
    list(
      "Supplier orders",
      stock.supplierOrders.map((order) => [`${order.quantity} × ${order.sku}`]),
      "The restock Skill made no order yet.",
    ),
    el(
      "div",
      { className: "card", id: "audit" },
      el("h3", { textContent: "Audit log of the Hook" }),
      lines(
        "ol",
        stock.audit.map((text) => [undefined, text]),
        "The stock_audit Hook wrote no line yet.",
      ),
    ),
    reference(
      "Permission Policy",
      policy.map((rule) => [`${rule.effect}:`, describeMatch(rule.match)]),
      "The Agent has no rule.",
    ),
    reference(
      "Tool annotations",
      tools.map((tool) => [tool.name, JSON.stringify(tool.annotations)]),
      "The Agent has no Tool.",
    ),
  ];
}

/** Shows why a save failed. A Spec that did not pass validation lists each issue with its code and its path. */
function showRejection(result, error) {
  result.className = "error";
  result.replaceChildren(
    error.issues ? "The Scope rejected the Spec and keeps the stored version." : error.message,
    el(
      "ul",
      {},
      ...(error.issues ?? []).map((issue) =>
        el("li", { textContent: `${issue.code} at ${issue.path}: ${issue.message}` }),
      ),
    ),
  );
}

function specCards({ agent, prompt, presets, ceilings }, onSaved) {
  const editor = el("textarea", { id: "spec", className: "editor", ariaLabel: "Agent Spec", spellcheck: false });
  editor.value = JSON.stringify(agent.spec, null, 2);
  const result = el("p", { id: "spec-result", className: "fine" });
  const save = el("button", { id: "save-spec", className: "primary", textContent: "Save the Spec" });
  save.onclick = async () => {
    let spec;
    try {
      spec = JSON.parse(editor.value);
    } catch (error) {
      result.className = "error";
      result.textContent = `The text is not JSON: ${error.message}`;
      return;
    }
    save.disabled = true;
    try {
      // The answer is the state of the scenario with a new Thread, thus the new version starts with no history.
      const next = await api("PUT", "/api/scenarios/agents/spec", spec);
      onSaved(next, `The Scope stored version ${next.agent.version}. A new Thread uses it.`);
    } catch (error) {
      showRejection(result, error);
    } finally {
      save.disabled = false;
    }
  };
  return [
    el(
      "div",
      { className: "card", id: "prompt-preview" },
      el("h3", { textContent: "What the Prompt entries give now" }),
      ...prompt.flatMap((entry) => [
        el("h4", { textContent: entry.source }),
        el("pre", { textContent: entry.text ?? "The page cannot show this entry." }),
      ]),
      el("p", { className: "fine", textContent: "The Harness makes the Prompt again at the start of each Turn." }),
    ),
    el(
      "div",
      { className: "card" },
      el("h3", { textContent: `Agent Spec, version ${agent.version}` }),
      el(
        "div",
        { className: "chips" },
        ...presets.map((preset) =>
          el("button", {
            textContent: preset.label,
            title: preset.expect,
            onclick: () => {
              editor.value = JSON.stringify(preset.spec, null, 2);
              result.className = "fine";
              result.textContent = `After you save: ${preset.expect}`;
            },
          }),
        ),
      ),
      editor,
      el("div", { className: "row" }, save),
      result,
      el("p", {
        className: "fine",
        textContent: `Scope ceiling: ${JSON.stringify(ceilings)}. The editor shows the Spec with the defaults that the Framework added.`,
      }),
    ),
  ];
}

/**
 * What each park reason means: `waits` names what the Turn waits for, and `line` is the line that the
 * conversation shows. A park that an Approval card already explains has no line.
 */
const PARKED = {
  approval: { waits: "your Approval of a Tool call" },
  budget: { waits: "a new budget", line: "The Turn is parked. It spent the Steps of its budget." },
  job: { waits: "the Job", line: "The Turn is parked. It waits for the Job and uses no Worker time." },
  scope_suspended: {
    waits: "the Scope",
    line: "The Turn is parked, because the Scope is suspended. Resume the Scope to continue it.",
  },
};

// What the conversation tells for each Schedule event.
const SCHEDULE_LINES = {
  "schedule.created": "The Thread has a new Schedule.",
  "schedule.fired": "A Schedule fired. Its Event starts a Turn, or waits for the end of the current Turn.",
  "schedule.skipped": "A recurring Schedule skipped a tick, because the Event of its last tick still waits for a Turn.",
  "schedule.cancelled": "The Thread cancelled a Schedule.",
};

// What the conversation tells for each trigger of a Compaction.
const COMPACTION_TRIGGERS = {
  auto: "The context is over the window minus the reserve.",
  manual: "You asked for a Compaction.",
  overflow: "The Provider refused the request, because the context was too large.",
};

/**
 * Adds the request for a Connection to the card of the Tool call. Only OAuth can grant it: the operator opens the
 * consent page, or denies the request here.
 */
function connectAsk(card, event, ask) {
  card.id = `approval-${event.seq}`;
  card.open = true;
  card.classList.add("approval", "waiting");
  card.state.textContent = "needs a Connection";
  card.append(
    el(
      "div",
      { className: "ask" },
      el(
        "strong",
        {},
        "The server ",
        el("code", { textContent: event.serverId }),
        " needs a Connection of the level ",
        el("code", { textContent: event.level }),
        ". The Turn is parked until OAuth completes.",
      ),
      rows(["Authorization server", el("code", { textContent: new URL(event.authUrl).origin })]),
      el(
        "div",
        { className: "row" },
        el("button", {
          className: "primary",
          textContent: "Open the consent page",
          onclick: () => open(event.authUrl, "_blank", "noopener"),
        }),
        el("button", { textContent: "Deny", onclick: ask(event.seq, "deny") }),
      ),
    ),
  );
  return card;
}

/** The conversation card of a `continue` Approval. It shows what the Turn spent and takes the answer. */
function continueCard(event, ask) {
  const label = el("span", { className: "state", textContent: "needs your Approval" });
  const card = el(
    "details",
    { className: "tool approval waiting", id: `approval-${event.seq}`, open: true },
    el("summary", {}, el("span", {}, "Budget of the Turn"), label),
    el("h4", { textContent: "Spent in this budget" }),
    el("pre", { textContent: JSON.stringify(event.budget, null, 2) }),
    el(
      "div",
      { className: "ask" },
      el("strong", { textContent: "The Turn spent its budget. Do you give it a new one?" }),
      el(
        "div",
        { className: "row" },
        el("button", { className: "primary", textContent: "Allow", onclick: ask(event.seq, "allow") }),
        el("button", { textContent: "Deny", onclick: ask(event.seq, "deny") }),
      ),
    ),
  );
  card.state = label;
  return card;
}

function dispatchCards({ dispatch, turn }) {
  const booking = dispatch.booking;
  const result = el("p", { className: "fine" });
  const report = (label, outcome, primary) =>
    el("button", {
      className: primary ? "primary" : "",
      textContent: label,
      onclick: async (click) => {
        const button = click.target;
        button.disabled = true;
        result.className = "fine";
        result.textContent = "";
        try {
          await api("POST", "/api/scenarios/turns/job", { report: outcome });
        } catch (error) {
          result.className = "error";
          result.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      },
    });
  return [
    el(
      "div",
      { className: "card", id: "dispatch" },
      el("h3", { textContent: "Dispatch system" }),
      rows(...dispatch.parcels.map((parcel) => [parcel.id, `${parcel.item}: ${parcel.packed ? "packed" : "open"}`])),
      el("p", { className: "fine", textContent: "This is sample data. Reset restores it." }),
    ),
    el(
      "div",
      { className: "card", id: "turn" },
      el("h3", { textContent: "Turn" }),
      rows(
        ["State", turn.state],
        turn.paused && ["Waits for", PARKED[turn.paused]?.waits ?? turn.paused],
        turn.budget && ["Steps", `${turn.budget.steps} of ${turn.budget.max.steps}`],
      ),
      el("p", {
        className: "fine",
        textContent: "The Steps come from the longRunning grant of the Agent. A parked Turn uses no Worker time.",
      }),
    ),
    el(
      "div",
      { className: "card titled", id: "courier" },
      el(
        "h3",
        {},
        "Courier system",
        booking && el("span", { className: `badge ${booking.status}`, textContent: booking.status }),
      ),
      booking
        ? rows(
            ["Job", el("code", { textContent: booking.jobId })],
            ["Parcels", String(booking.parcels)],
            ["Note", booking.note],
          )
        : el("p", { className: "muted", textContent: "The Agent booked no courier yet." }),
      booking &&
        turn.paused === "job" &&
        el(
          "div",
          { className: "row" },
          report("Report the collection", "collected", true),
          report("Report a failure", "failed"),
        ),
      booking &&
        turn.paused !== "job" &&
        el("p", {
          className: "fine",
          textContent: "No Turn waits for this Job. The booking stays in the sample courier system.",
        }),
      result,
    ),
  ];
}

/** A list of media refs. `href` gives the download route of an item, or false when its bytes are gone. */
function mediaList(items, href) {
  return el(
    "ul",
    {},
    ...items.map((item) => {
      const route = href(item);
      return el(
        "li",
        {},
        item.name ?? item.id,
        " ",
        el("code", { textContent: `${item.mimeType}, ${item.bytes} bytes` }),
        route &&
          el("a", {
            href: `${route}?token=${encodeURIComponent(token)}`,
            download: item.name ?? item.id,
            textContent: `Download ${item.name ?? item.id}`,
          }),
      );
    }),
  );
}

function forkCards({ original, fork, positions }, onChanged, isCurrent) {
  const threadCard = (id, title, thread) => {
    const media = thread.media ?? [];
    return el(
      "div",
      { className: "card titled", id },
      el("h3", {}, title, badge(thread.deleted ? "deleted" : thread.status.state)),
      rows(["Thread key", el("code", { textContent: thread.threadKey })], ["Events", `${thread.events.length} events`]),
      media.length > 0
        ? mediaList(
            media,
            (item) =>
              !thread.deleted &&
              `/api/scenarios/forks/threads/${encodeURIComponent(thread.threadKey)}/media/${encodeURIComponent(item.id)}`,
          )
        : el("p", {
            className: "muted",
            textContent: thread.deleted
              ? "The original media is no longer available."
              : "Upload a file to this Thread.",
          }),
      el(
        "details",
        { className: "thread-events" },
        el("summary", { textContent: `Inspect ${thread.events.length} events` }),
        el("pre", { textContent: JSON.stringify(thread.events, null, 2) }),
      ),
    );
  };
  const select = el(
    "select",
    { ariaLabel: "Fork position", disabled: positions.length === 0 || Boolean(fork) },
    ...positions.map((position) => el("option", { value: String(position.seq), textContent: position.label })),
  );
  // The default position is the newest one, thus the Fork gets the full conversation.
  select.value = String(positions.at(-1)?.seq ?? "");
  const result = el("p", { className: "fine" });
  const action = (label, path, body, disabled) =>
    el("button", {
      textContent: label,
      disabled,
      onclick: async (click) => {
        click.target.disabled = true;
        try {
          const next = await api("POST", path, body?.());
          if (!isCurrent()) return;
          onChanged(
            next,
            label === "Fork the Thread" ? "The Fork has its own event log and media copy." : "The Fork remains usable.",
          );
        } catch (error) {
          if (!isCurrent()) return;
          result.className = "error";
          result.textContent = error.message;
        } finally {
          click.target.disabled = false;
        }
      },
    });
  return [
    threadCard("original-thread", "Original Thread", original),
    fork
      ? threadCard("fork-thread", "Fork Thread", fork)
      : el(
          "div",
          { className: "card", id: "fork-thread" },
          el("h3", { textContent: "Fork Thread" }),
          el("p", { className: "muted", textContent: "Select a completed Turn and make the Fork." }),
        ),
    el(
      "div",
      { className: "card" },
      el("h3", { textContent: "Thread actions" }),
      fork
        ? el("p", {
            className: "fine",
            textContent: "A scenario has one Fork. Reset the scenario to make another one.",
          })
        : positions.length > 0
          ? el("p", { className: "fine", textContent: "The supported positions are the ends of completed Turns." })
          : el("p", { className: "muted", textContent: "Complete a Turn before you make a Fork." }),
      el(
        "div",
        { className: "row" },
        select,
        action(
          "Fork the Thread",
          "/api/scenarios/forks/fork",
          () => ({ seq: Number(select.value) }),
          positions.length === 0 || Boolean(fork),
        ),
        action("Delete the original", "/api/scenarios/forks/original/delete", undefined, !fork || original.deleted),
      ),
      result,
      el("p", {
        className: "fine",
        textContent: "Delete is available after the Fork, so you can first inspect both Threads.",
      }),
    ),
  ];
}

/** One action button of a card. It shows the failure in `result` and gives the answer of the route to `done`. */
function cardAction(label, request, done, result, primary = false) {
  return el("button", {
    className: primary ? "primary" : "",
    textContent: label,
    onclick: async (click) => {
      click.target.disabled = true;
      result.className = "fine";
      result.textContent = "";
      try {
        done(await request());
      } catch (error) {
        result.className = "error";
        result.textContent = error.message;
      } finally {
        click.target.disabled = false;
      }
    },
  });
}

// What the operator selected and typed in the Schedule form.
const scheduleForm = { mode: "delay", value: undefined };

function scheduleCards({ threadKey, schedules, reminders, inbox, modes }, onChanged, isCurrent, subscriber) {
  const path = "/api/scenarios/schedules";
  const time = (at) => new Date(at).toLocaleTimeString();
  const changed = (note) => (next) => isCurrent() && onChanged(next, note);
  const result = el("p", { className: "fine" });
  const mode = el(
    "select",
    { id: "timing-mode", ariaLabel: "Timing mode" },
    ...modes.map((item) => el("option", { value: item.mode, textContent: item.label })),
  );
  const value = el("input", { id: "timing-value", type: "text", ariaLabel: "Timing value", spellcheck: false });
  const expect = el("p", { className: "fine" });
  // The side column renders again when its data changes. The form keeps what the operator selected and typed.
  const showMode = (typed) => {
    const selected = modes.find((item) => item.mode === mode.value);
    // The suggested time is two minutes from now, because a fixed time in the sample data is soon in the past.
    value.value = typed ?? (selected.mode === "at" ? new Date(Date.now() + 120_000).toISOString() : selected.value);
    expect.textContent = selected.expect;
  };
  mode.onchange = () => {
    scheduleForm.mode = mode.value;
    scheduleForm.value = undefined;
    showMode();
  };
  value.oninput = () => (scheduleForm.value = value.value);
  mode.value = scheduleForm.mode;
  showMode(scheduleForm.value);
  const inboxResult = el("p", { className: "fine" });
  const answer = (seq, decision) =>
    cardAction(
      decision === "allow" ? "Allow" : "Deny",
      () => api("POST", `/threads/${threadKey}/approvals/${seq}`, { decision, by: "operator" }),
      () => (inboxResult.textContent = `You answered ${decision}. The Turn continues.`),
      inboxResult,
      decision === "allow",
    );
  const triggerResult = el("p", { className: "fine" });
  return [
    el(
      "div",
      { className: "card titled", id: "schedules" },
      el("h3", {}, "Pending Schedules", el("span", { className: "badge", textContent: String(schedules.length) })),
      schedules.length > 0
        ? el(
            "ul",
            {},
            ...schedules.map((item) =>
              el(
                "li",
                {},
                `${item.cron ? "Recurring" : "One time"}, next at ${time(item.nextAt)} `,
                el("code", { textContent: item.cron ? `${item.cron} ${item.tz}` : item.input.type }),
                el(
                  "div",
                  { className: "row" },
                  cardAction(
                    "Cancel the Schedule",
                    () => api("POST", `${path}/schedule/cancel`, { scheduleId: item.scheduleId }),
                    changed("The Thread cancelled the Schedule. It records a schedule.cancelled event."),
                    result,
                  ),
                ),
              ),
            ),
          )
        : el("p", { className: "muted", textContent: "Create a Schedule here, or ask the Agent to create one." }),
      el(
        "div",
        { className: "row" },
        mode,
        value,
        cardAction(
          "Create the Schedule",
          () => api("POST", `${path}/schedule`, { mode: mode.value, value: value.value }),
          changed("The Thread has the Schedule. A Turn starts when it fires."),
          result,
          true,
        ),
      ),
      expect,
      result,
    ),
    el(
      "div",
      { className: "card titled", id: "subscriber" },
      el("h3", {}, "Subscriber of this page", badge(subscriber.attached ? "attached" : "detached")),
      el("p", {
        className: "fine",
        textContent: subscriber.attached
          ? "The page holds a WebSocket of the Thread. An attached Subscriber stops offline delivery, thus the inbox gets nothing."
          : "The page holds no socket. It reads new events with plain requests, which are no Subscriber. The Deliverer gets each completed Turn and each Approval request about one second after it occurs.",
      }),
      el(
        "div",
        { className: "row" },
        el("button", {
          className: "primary",
          textContent: subscriber.attached ? "Detach the Subscriber" : "Attach the Subscriber",
          onclick: subscriber.toggle,
        }),
      ),
    ),
    el(
      "div",
      { className: "card titled", id: "inbox" },
      el("h3", {}, "Sample inbox", el("span", { className: "badge", textContent: String(inbox.length) })),
      inbox.length > 0
        ? el(
            "ul",
            {},
            ...inbox.map((entry) =>
              el(
                "li",
                {},
                el("span", { className: `badge ${entry.kind}`, textContent: entry.kind }),
                ` ${entry.text}`,
                entry.call && el("pre", { textContent: JSON.stringify(entry.call.input, null, 2) }),
                entry.waiting && el("div", { className: "row" }, answer(entry.seq, "allow"), answer(entry.seq, "deny")),
              ),
            ),
          )
        : el("p", {
            className: "muted",
            textContent: "The Deliverer wrote no message yet. Detach the Subscriber, then let a Turn complete.",
          }),
      inboxResult,
      el("p", {
        className: "fine",
        textContent: "This is a sample system, not an email account. The sample_inbox Deliverer writes to it.",
      }),
    ),
    el(
      "div",
      { className: "card", id: "trigger" },
      el("h3", { textContent: "External trigger" }),
      el("p", {
        className: "fine",
        textContent:
          "A trigger from a different system is your code: it finds the Thread and sends an Event. This button and the scheduled handler of the Worker call the same function. The README tells how to call the handler.",
      }),
      el(
        "div",
        { className: "row" },
        cardAction(
          "Send the supplier Event",
          () => api("POST", `${path}/trigger`),
          changed("The Thread got the supplier.delivery Event. A Turn starts for it."),
          triggerResult,
          true,
        ),
      ),
      triggerResult,
    ),
    el(
      "div",
      { className: "card", id: "reminders" },
      el("h3", { textContent: "Reminder system" }),
      reminders.sent.length > 0
        ? el("ul", {}, ...reminders.sent.map((item) => el("li", { textContent: `${item.customer}: ${item.text}` })))
        : el("p", { className: "muted", textContent: "The send_reminder Tool sent no reminder yet." }),
      el("p", { className: "fine", textContent: "This is sample data. Reset restores it." }),
    ),
  ];
}

function ledgerCards({ threadKey, ledger, context, turn }, onChanged, isCurrent) {
  const path = "/api/scenarios/compaction";
  const changed = (note) => (next) => isCurrent() && onChanged(next, note);
  const holdResult = el("p", { className: "fine" });
  const compactResult = el("p", { className: "fine" });
  const instructions = el("input", {
    id: "compact-instructions",
    type: "text",
    ariaLabel: "Compaction instructions",
    value: "Keep each entry id and amount.",
    spellcheck: false,
  });
  return [
    el(
      "div",
      { className: "card titled", id: "ledger" },
      el("h3", {}, "Ledger system", badge(ledger.held ? "held" : "open")),
      rows(...ledger.entries.map((entry) => [entry.id, `${entry.text}: ${entry.amount}`])),
      el(
        "div",
        { className: "row" },
        cardAction(
          ledger.held ? "Release the ledger" : "Hold the ledger",
          () => api("POST", `${path}/hold`, { held: !ledger.held }),
          changed(
            ledger.held
              ? "The ledger is open. A Tool call that waits returns its result now."
              : "The ledger is held. Each Tool call waits up to five minutes before it returns its result.",
          ),
          holdResult,
          true,
        ),
      ),
      holdResult,
      el("p", {
        className: "fine",
        textContent:
          "This is sample data. Reset restores it. Hold the ledger, run a prompt, then stop the dev server while the Tool call runs. The README has the walkthrough.",
      }),
    ),
    el(
      "div",
      { className: "card", id: "context" },
      el("h3", { textContent: "Context of the Agent" }),
      rows(
        ["Window", `${context.window} tokens`],
        ["Reserve", `${context.reserveTokens} tokens`],
        ["Kept", `${context.keepRecentTokens} tokens`],
      ),
      el("p", {
        className: "fine",
        textContent:
          "Before each model Step, the Harness compares the context with the window minus the reserve. Over the limit, a compact Step summarises the events before the kept part. The limits are small on purpose.",
      }),
      el(
        "div",
        { className: "row" },
        instructions,
        cardAction(
          "Compact the Thread",
          () => api("POST", `/threads/${threadKey}/compact`, { instructions: instructions.value.trim() }),
          () => (compactResult.textContent = "The Thread compacts. The conversation shows the summary."),
          compactResult,
        ),
      ),
      compactResult,
      el("p", {
        className: "fine",
        textContent: "The Thread must be idle. It refuses a Compaction while a Turn runs or is parked.",
      }),
    ),
    el(
      "div",
      { className: "card", id: "turn" },
      el("h3", { textContent: "Turn" }),
      rows(["State", turn.state], turn.paused && ["Waits for", PARKED[turn.paused]?.waits ?? turn.paused]),
      el("p", {
        className: "fine",
        textContent:
          "After a restart of the dev server, the state stays running until the Thread recovers the Turn. The watchdog alarm of the Thread does that about one minute after the last Step began. A new input to the Thread does it at once.",
      }),
    ),
  ];
}

/** What a parked Turn waits for. A Turn with a child Thread waits for the child, which the Job represents. */
const waitsFor = (reason, hasChildren) =>
  reason === "job" && hasChildren ? "the child Thread" : (PARKED[reason]?.waits ?? reason);

function purchaseCards({ purchases, turn, children, usage }) {
  const waits = (child) => (child.paused ? waitsFor(child.paused, false) : child.state);
  return [
    el(
      "div",
      { className: "card", id: "purchases" },
      el("h3", { textContent: "Purchase system" }),
      el("h4", { textContent: "Suppliers" }),
      rows(...purchases.suppliers.map((item) => [item.id, `${item.name}: ${item.item}, ${item.unitPrice} each`])),
      el("h4", { textContent: "Orders" }),
      purchases.orders.length > 0
        ? rows(
            ...purchases.orders.map((order) => [
              order.id,
              `${order.quantity} × ${order.item} from ${order.supplierId}`,
            ]),
          )
        : el("p", { className: "muted", textContent: "The purchase desk placed no order yet." }),
      el("p", { className: "fine", textContent: "This is sample data. Reset restores it." }),
    ),
    el(
      "div",
      { className: "card titled", id: "children" },
      el("h3", {}, "Child Threads", el("span", { className: "badge", textContent: String(children.length) })),
      children.length > 0
        ? el(
            "ul",
            {},
            ...children.map((child) =>
              el(
                "li",
                {},
                el("span", { className: `badge ${child.state}`, textContent: waits(child) }),
                " ",
                el("code", { textContent: child.threadId }),
                rows(
                  ["Agent", child.agent],
                  ["Parent call", el("code", { textContent: child.parent?.callId ?? "" })],
                  ["Parent key", el("code", { textContent: child.parent?.threadKey ?? "" })],
                ),
              ),
            ),
          )
        : el("p", { className: "muted", textContent: "Run a prompt. The delegate Tool starts a child Thread." }),
      el("p", {
        className: "fine",
        textContent:
          "A child id is the parent id, then the call id of the delegate call. The child acts for the same User and has new context. Reset deletes each child.",
      }),
    ),
    el(
      "div",
      { className: "card titled", id: "usage" },
      el("h3", {}, "Usage records", el("span", { className: "badge", textContent: String(usage.length) })),
      usage.length > 0
        ? el(
            "ul",
            {},
            ...usage.map((record) =>
              el(
                "li",
                {},
                `${record.agent}, ${record.kind}: ${record.input} in, ${record.output} out `,
                el("code", { textContent: record.threadId }),
                record.parent && " for the call ",
                record.parent && el("code", { textContent: record.parent.callId }),
              ),
            ),
          )
        : el("p", { className: "muted", textContent: "No model call ran yet." }),
      el("p", {
        className: "fine",
        textContent:
          "Each Thread records its own spend, thus no tokens are in two records. A record of a child names the parent Thread and the call.",
      }),
    ),
    el(
      "div",
      { className: "card", id: "turn" },
      el("h3", { textContent: "Turn" }),
      rows(
        ["State", turn.state],
        turn.paused && ["Waits for", waitsFor(turn.paused, children.length > 0)],
        turn.delegated && ["Children", `${turn.delegated.children} started, ${turn.delegated.active} active`],
      ),
      el("p", {
        className: "fine",
        textContent:
          "The delegate call parks the Turn as a Job. The delegation grant limits the depth, the concurrent children and the children of one Turn.",
      }),
    ),
  ];
}

// The last answer of the Scope boundary request. The side column renders again when its data changes, and the
// card shows the answer again.
let boundaryAnswer = "No request was sent yet.";

/** The Memory and Scope isolation scenario: one Memory card for each sample Scope, and the Scope boundary card. */
function memoryCards({ user, scopes, fields }, onChanged, isCurrent) {
  const path = "/api/scenarios/memory";
  const changed = (note) => (next) => isCurrent() && onChanged(next, note);
  const memoryCard = (scope) => {
    const result = el("p", { className: "fine" });
    const stored = Object.keys(scope.memory.profile).length > 0 || scope.memory.notes.length > 0;
    return el(
      "div",
      { className: "card titled", id: `memory-${scope.id}` },
      el("h3", {}, `Memory of ${user} in ${scope.id}`, badge(stored ? "stored" : "empty")),
      ...(stored
        ? [
            el("h4", { textContent: "Profile" }),
            el("pre", { textContent: JSON.stringify(scope.memory.profile, null, 2) }),
            el("h4", { textContent: `Notes (${scope.memory.notes.length})` }),
            scope.memory.notes.length > 0
              ? el(
                  "ul",
                  {},
                  ...scope.memory.notes.map((note) =>
                    el("li", {}, note.text, " ", el("code", { textContent: `by ${note.agent}` })),
                  ),
                )
              : el("p", { className: "muted", textContent: "The Agent wrote no Note." }),
          ]
        : [el("p", { className: "muted", textContent: "Nothing is stored. Run the Remember prompt in this Scope." })]),
      rows(
        ["Users with a Memory", scope.users.length > 0 ? scope.users.join(", ") : "none"],
        ["Threads since the reset", String(scope.threads.length)],
      ),
      el(
        "div",
        { className: "row" },
        cardAction(
          "Start a new Thread",
          () => api("POST", `${path}/thread`, { scope: scope.id }),
          changed(`A new Thread of ${user} in ${scope.id}. Ask the Agent what it knows.`),
          result,
          true,
        ),
        cardAction(
          "Forget the User",
          () => api("POST", `${path}/forget`, { scope: scope.id }),
          changed(`The Scope ${scope.id} deleted the Memory of ${user}. The Threads stay.`),
          result,
        ),
      ),
      result,
      el("p", {
        className: "fine",
        textContent:
          "The card reads the Memory with scope.users.memory. Only a Turn writes it. Forget calls delete, which a Platform uses when a User asks to erase their data.",
      }),
    );
  };
  const [first, second] = scopes;
  const boundary = el("pre", { textContent: boundaryAnswer });
  const boundaryResult = el("p", { className: "fine" });
  return [
    ...scopes.map(memoryCard),
    el(
      "div",
      { className: "card", id: "boundary" },
      el("h3", { textContent: "Scope boundary" }),
      el("p", {
        className: "fine",
        textContent: `Each request of this page acts in one Scope. The access token opens ${first.id} and ${second.id}, and a request names its Scope in the scope query parameter. A Thread key names a Thread in the Scope of the request only. This button reads the current Thread of ${second.id} with a request in ${first.id}.`,
      }),
      el(
        "div",
        { className: "row" },
        cardAction(
          `Read the ${second.id} Thread as ${first.id}`,
          async () => {
            const response = await fetch(`/threads/${second.threadKey}`, {
              headers: { authorization: `Bearer ${token}` },
            });
            return `GET /threads/${second.threadKey}\nHTTP ${response.status}\n${await response.text()}`;
          },
          (text) => (boundary.textContent = boundaryAnswer = text),
          boundaryResult,
          true,
        ),
      ),
      boundary,
      boundaryResult,
    ),
    el(
      "details",
      { className: "card" },
      el("summary", { textContent: `Profile fields of the Agent (${Object.keys(fields).length})` }),
      el("pre", { textContent: JSON.stringify(fields, null, 2) }),
      el("p", {
        className: "fine",
        textContent: "The remember Tool can write these fields only. The Harness checks each value against the schema.",
      }),
    ),
  ];
}

// A script record has no model and no tokens. A model or Compaction record has both.
function tokenLine(record) {
  if (record.input === undefined) return "";
  return [
    `${record.input} in`,
    `${record.output} out`,
    record.cacheRead > 0 && `${record.cacheRead} cache read`,
    record.cacheWrite > 0 && `${record.cacheWrite} cache write`,
  ]
    .filter(Boolean)
    .join(", ");
}

// The sum of the reported costs, by currency. A record without a cost adds nothing, and the line tells how many
// records had one, thus a missing cost never reads as zero.
function reportedCost(usage) {
  const priced = usage.filter((record) => record.cost);
  if (priced.length === 0) return "No record has a reported cost.";
  const totals = new Map();
  for (const { cost } of priced) totals.set(cost.currency, (totals.get(cost.currency) ?? 0) + cost.amount);
  const sum = [...totals].map(([currency, amount]) => `${Number(amount.toPrecision(12))} ${currency}`).join(" + ");
  return `${sum}, from ${priced.length} of ${usage.length} records`;
}

function usageTable(usage) {
  return el(
    "div",
    { className: "table" },
    el(
      "table",
      {},
      el("tr", {}, ...["Record", "Tokens", "Cost", "Reported by"].map((name) => el("th", { textContent: name }))),
      ...usage.map((record) =>
        el(
          "tr",
          {},
          el("td", {
            textContent: record.kind === "model" ? `seq ${record.seq}` : `seq ${record.seq}, ${record.kind}`,
          }),
          el("td", { textContent: tokenLine(record) }),
          el("td", { textContent: record.cost ? `${record.cost.amount} ${record.cost.currency}` : "Not reported" }),
          el("td", { textContent: record.cost ? `${record.cost.source}, ${record.cost.basis}` : "" }),
        ),
      ),
    ),
  );
}

// The UsageHandler writes `duplicate` for a key that it stored before, and skips the record.
const DELIVERY_STATUS = { stored: "stored", duplicate: "duplicate, skipped", failed: "failed, the Queue retries" };

function observabilityCards({ usage, handler, logs, redaction, exampleChild }, onChanged, isCurrent) {
  const path = "/api/scenarios/observability";
  const handlerResult = el("p", { className: "fine" });
  const logResult = el("p", { className: "fine" });
  const changed = (note) => (next) => isCurrent() && onChanged(next, note);
  const stored = handler.deliveries.some((item) => item.status === "stored");
  const [first] = usage;
  const models = [...new Set(usage.filter((record) => record.model).map((r) => `${r.provider}/${r.model}`))];
  return [
    el(
      "div",
      { className: "card titled", id: "usage" },
      el("h3", {}, "Usage records", el("span", { className: "badge", textContent: String(usage.length) })),
      ...(first
        ? [
            rows(
              ["Scope", first.scope],
              ["Agent", first.agent],
              ["User", first.user ?? "none"],
              ["Thread", el("code", { textContent: first.threadId })],
              models.length > 0 && ["Model", el("code", { textContent: models.join(", ") })],
              ["Reported cost", reportedCost(usage)],
            ),
            usageTable(usage),
          ]
        : [el("p", { className: "muted", textContent: "No model call ran yet." })]),
      el("p", {
        className: "fine",
        textContent:
          "The Agent does not know its spend. Each model call writes one record with the Step. The key of a record is threadId:seq. karmi never prices tokens, and a missing cost is not zero.",
      }),
    ),
    el(
      "div",
      { className: "card titled", id: "handler" },
      el(
        "h3",
        {},
        "UsageHandler",
        handler.waiting
          ? el("span", { className: "badge waiting", textContent: "waiting for the Queue" })
          : el("span", { className: "badge", textContent: String(handler.deliveries.length) }),
      ),
      handler.waiting &&
        el("p", {
          className: "fine",
          textContent:
            "The Queue has not delivered the last record yet. It sends a batch when the batch is full or after a few seconds. The card updates when the batch arrives.",
        }),
      handler.failNext &&
        el("p", {
          className: "note",
          textContent: "The next batch will fail one time, then the Queue retries it.",
        }),
      handler.deliveries.length > 0
        ? el(
            "ul",
            {},
            ...handler.deliveries.map((item) =>
              el(
                "li",
                {},
                el("code", { textContent: item.key }),
                " ",
                el("span", { className: `badge ${item.status}`, textContent: DELIVERY_STATUS[item.status] }),
              ),
            ),
          )
        : el("p", { className: "muted", textContent: "No batch has reached the sample UsageHandler yet." }),
      el(
        "div",
        { className: "row" },
        cardAction(
          "Fail the next batch",
          () => api("POST", `${path}/fail`),
          changed("The next batch will fail once."),
          handlerResult,
        ),
        stored &&
          cardAction(
            "Deliver the last batch again",
            () => api("POST", `${path}/replay`),
            changed("The handler received the last batch again and skipped each duplicate."),
            handlerResult,
          ),
      ),
      handlerResult,
      el("p", {
        className: "fine",
        textContent:
          "The Queue delivers each batch at least once. The handler skips a key that it stored before. A thrown error retries the batch. The Turn does not fail.",
      }),
    ),
    el(
      "div",
      { className: "card titled", id: "logs" },
      el("h3", {}, "Logs", el("span", { className: "badge", textContent: String(logs.length) })),
      logs.length > 0
        ? el(
            "ul",
            {},
            ...logs.map((line) =>
              el(
                "li",
                {},
                el("h4", { textContent: `${line.level}: ${line.message}` }),
                el("pre", { textContent: JSON.stringify(line.fields, null, 2) }),
              ),
            ),
          )
        : el("p", {
            className: "muted",
            textContent: "No log line of this scenario is stored yet. Run Look up a ticket.",
          }),
      el(
        "div",
        { className: "row" },
        cardAction(
          "Show redaction",
          () => api("POST", `${path}/redact`),
          changed("redactFields replaced the credential fields."),
          logResult,
        ),
      ),
      logResult,
      redaction && el("h4", { textContent: "Before" }),
      redaction && el("pre", { textContent: JSON.stringify(redaction.before, null, 2) }),
      redaction && el("h4", { textContent: "After" }),
      redaction && el("pre", { textContent: JSON.stringify(redaction.after, null, 2) }),
      el("p", {
        className: "fine",
        textContent:
          "karmi redacts each line before the Logger. It replaces Sensitive values, credential field names and bearer tokens.",
      }),
    ),
    el(
      "details",
      { className: "card", id: "example-child" },
      el("summary", { textContent: "Example child Usage record (1)" }),
      el("pre", { textContent: JSON.stringify(exampleChild, null, 2) }),
      el("p", {
        className: "fine",
        textContent:
          "A Delegation child records its own spend and sets parent. This example is not from the Thread of this scenario.",
      }),
    ),
  ];
}

// The badge text of each state of a Script run.
const RUN_STATES = { running: "running", done: "done", failed: "failed", stopped: "stopped, the Turn ended" };

function scriptCards({ orders, grant, policy, runs }) {
  return [
    el(
      "div",
      { className: "card", id: "script-orders" },
      el("h3", { textContent: "Order system" }),
      el(
        "ul",
        {},
        ...orders.map((order) =>
          el(
            "li",
            {},
            `${order.id}, ${order.customer}, $${order.total} `,
            el("span", { className: `badge ${order.status}`, textContent: order.status }),
          ),
        ),
      ),
      el("p", {
        className: "fine",
        textContent: "This is sample data. pack_box packs an open order. Reset restores each order.",
      }),
    ),
    el(
      "div",
      { className: "card titled", id: "script-runs" },
      el("h3", {}, "Script runs", el("span", { className: "badge", textContent: String(runs.length) })),
      runs.length > 0
        ? el(
            "ul",
            {},
            ...runs.map((run) =>
              el(
                "li",
                {},
                // A call id is data of the Framework, thus it is not in an h4, which shows its text in capitals.
                el(
                  "p",
                  {},
                  el("strong", { textContent: "run_script " }),
                  el("code", { textContent: run.callId }),
                  " ",
                  el("span", { className: `badge ${run.state}`, textContent: RUN_STATES[run.state] }),
                ),
                run.state === "done" && el("pre", { textContent: JSON.stringify(run.value, null, 2) }),
                run.error && el("pre", { className: "error", textContent: run.error }),
                run.explanation && el("p", { className: "outcome", textContent: run.explanation }),
                run.logs.length > 0 && el("h4", { textContent: `Logs (${run.logs.length})` }),
                run.logs.length > 0 && el("pre", { textContent: run.logs.join("\n") }),
                el("h4", { textContent: `Tool calls of the Script (${run.calls.length})` }),
                run.calls.length > 0
                  ? el(
                      "ol",
                      {},
                      ...run.calls.map((call) =>
                        el(
                          "li",
                          {},
                          el("code", { textContent: call.name }),
                          ` ${call.isError === undefined ? "running" : call.isError ? "error" : "ok"}, call `,
                          el("code", { textContent: call.callId }),
                          ", parent ",
                          el("code", { textContent: call.parentCallId }),
                        ),
                      ),
                    )
                  : el("p", { className: "muted", textContent: "The Script called no Tool." }),
              ),
            ),
          )
        : el("p", { className: "muted", textContent: "No Script ran yet. Run a suggested prompt." }),
      el("p", {
        className: "fine",
        textContent:
          "The model sees only the result of run_script. It does not see the nested Tool calls. Each one has the parentCallId of its Script.",
      }),
    ),
    el(
      "details",
      { className: "card", id: "script-grant" },
      el("summary", { textContent: "Script grant and Permission Policy (2)" }),
      el("h4", { textContent: "capabilities.scripts" }),
      el("pre", { textContent: JSON.stringify(grant, null, 2) }),
      el("h4", { textContent: "policy" }),
      el("pre", { textContent: JSON.stringify(policy, null, 2) }),
      el("p", {
        className: "fine",
        textContent:
          "A Script gets each Tool that the Policy allows. No rule matches cancel_order, thus it needs an Approval, and a Script cannot wait for one.",
      }),
    ),
  ];
}

const CONTAINER_STATES = {
  running: "running",
  job: "Job",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
  stopped: "stopped, the Turn ended",
};

/** The container Scripts scenario: the sample files, each Script with its output and artifacts, and the grant. */
function containerCards({ files, grant, runs }) {
  const download = (item) => `/api/scenarios/container-scripts/media/${encodeURIComponent(item.id)}`;
  const output = (label, text, error = false) =>
    text ? [el("h4", { textContent: label }), el("pre", { className: error ? "error" : "", textContent: text })] : [];
  return [
    el(
      "div",
      { className: "card titled", id: "container-runs" },
      el("h3", {}, "Script runs", el("span", { className: "badge", textContent: String(runs.length) })),
      runs.length > 0
        ? el(
            "ul",
            {},
            ...runs.map((run) =>
              el(
                "li",
                {},
                el(
                  "p",
                  {},
                  el("strong", { textContent: `run_script, ${run.language} ` }),
                  el("code", { textContent: run.callId }),
                  " ",
                  el("span", { className: `badge ${run.state}`, textContent: CONTAINER_STATES[run.state] }),
                ),
                el("p", {
                  className: "fine",
                  textContent: `Files in /in: ${run.files.length > 0 ? run.files.join(", ") : "none"}.`,
                }),
                ...output("Job progress", run.progress),
                run.state === "done" && el("h4", { textContent: `Exit code ${run.exitCode}` }),
                ...output("stdout", run.stdout),
                ...output("stderr", run.stderr, true),
                ...output("Error", run.error, true),
                run.explanation && el("p", { className: "outcome", textContent: run.explanation }),
                el("h4", { textContent: `Artifacts from /out (${run.artifacts.length})` }),
                run.artifacts.length > 0
                  ? mediaList(run.artifacts, download)
                  : el("p", { className: "muted", textContent: "The Script wrote no file to /out." }),
              ),
            ),
          )
        : el("p", { className: "muted", textContent: "No Script ran yet. Run a suggested prompt." }),
    ),
    el(
      "div",
      { className: "card", id: "container-files" },
      el("h3", { textContent: "Sample files" }),
      mediaList(files, download),
      el("p", {
        className: "fine",
        textContent:
          "Each Thread gets its own copy as Thread media. The sample_files Fragment gives the model their refs, and run_script writes them to /in.",
      }),
    ),
    el(
      "div",
      { className: "card", id: "container-network" },
      el("h3", { textContent: "Network allow-list" }),
      el("pre", { textContent: JSON.stringify(grant.egress.allow) }),
      el("p", {
        className: "fine",
        textContent:
          "A Script reaches only these hostnames. The Worker answers each other request with HTTP 520 and adds a line to stderr. Run Allowed host and Denied host to compare.",
      }),
    ),
    el(
      "details",
      { className: "card", id: "container-grant" },
      el("summary", { textContent: "Script grant (1)" }),
      el("h4", { textContent: "capabilities.scripts" }),
      el("pre", { textContent: JSON.stringify(grant, null, 2) }),
      el("p", {
        className: "fine",
        textContent:
          "A process that runs longer than wallMs becomes a Job. jobMaxWallMs stops it. The Workspace stops after idleMs without a Script. At most maxArtifacts files from /out become artifacts.",
      }),
    ),
  ];
}

// What the operator typed in the ingest form. The side column renders again when its data changes.
const ingestForm = { corpus: "handbook", id: "", title: "", text: "" };

// The documents that the chips of the ingest form fill in. The last one is over the inline limit on purpose.
const INGEST_PRESETS = [
  {
    label: "Update the refund policy",
    corpus: "handbook",
    id: "refunds",
    title: "Refund policy",
    text: "A customer can return a product within 14 days of the purchase. The shop refunds the price as shop credit.",
  },
  {
    label: "Add a handbook page",
    corpus: "handbook",
    id: "grinder",
    title: "Grinder care",
    text: "Clean the grinder each Friday after the close. Run one dose of rice through it before the clean.",
  },
  {
    label: "Add a notice over the inline limit",
    corpus: "notices",
    id: "long",
    title: "A long notice",
    text: "This notice is longer than the inline limit. ".repeat(750),
  },
];

/** The Knowledge scenario: one card for each corpus, the Passages of a search, the ingest form and the bulk Job. */
function knowledgeCards({ corpora, known, inlineLimit, bulkSize, job, search }, onChanged, isCurrent) {
  const path = "/api/scenarios/knowledge";
  const changed = (note) => (next) => isCurrent() && onChanged(next, note);
  const corpusCard = (corpus) => {
    const result = el("p", { className: "fine" });
    return el(
      "div",
      { className: "card titled", id: `corpus-${corpus.name}` },
      el("h3", {}, `Corpus ${corpus.name}`, badge(corpus.mode)),
      el("p", {
        className: "fine",
        textContent:
          corpus.mode === "search"
            ? `The Agent has the read-only Tool ${corpus.tool}. It returns the Passages of the Retriever as JSON.`
            : "The Harness puts the full text of this corpus in the Prompt at the start of each Turn. The Agent needs no Tool call for it.",
      }),
      el("h4", { textContent: `Documents (${corpus.documents.length})` }),
      corpus.documents.length > 0
        ? el(
            "ul",
            {},
            ...corpus.documents.map((doc) =>
              el(
                "li",
                {},
                el("code", { textContent: doc.id }),
                ` ${doc.title || "Without a title"}, ${doc.chars} code points `,
                Object.assign(
                  cardAction(
                    "Delete",
                    () => api("POST", `${path}/delete`, { corpus: corpus.name, id: doc.id }),
                    changed(`The corpus ${corpus.name} no longer has ${doc.id}.`),
                    result,
                  ),
                  { className: "quiet", ariaLabel: `Delete ${doc.id} from ${corpus.name}` },
                ),
              ),
            ),
          )
        : el("p", { className: "muted", textContent: "The corpus has no document. Ingest one below." }),
      corpus.inline?.error &&
        el("p", { className: "error", textContent: `The next Turn fails: ${corpus.inline.error}` }),
      corpus.inline && !corpus.inline.error && el("h4", { textContent: "What the Prompt gets" }),
      corpus.inline &&
        !corpus.inline.error &&
        el("pre", { textContent: corpus.inline.text || "Nothing. The corpus is empty." }),
      el(
        "div",
        { className: "row" },
        cardAction(
          "Destroy the corpus",
          () => api("POST", `${path}/destroy`, { corpus: corpus.name }),
          changed(`The Scope no longer has the corpus ${corpus.name}. Ingest a document to make it again.`),
          result,
        ),
      ),
      result,
      el("p", {
        className: "fine",
        textContent:
          corpus.mode === "search"
            ? "A search finds a deleted document no longer. Destroy removes the corpus and its index. The Tool stays, because the Agent Spec names the corpus."
            : `The inline limit is ${inlineLimit.toLocaleString()} Unicode code points. A corpus over it fails the Turn. Use search for a large corpus.`,
      }),
    );
  };
  const searchResult = el("p", { className: "fine" });
  const query = el("input", {
    id: "query",
    type: "text",
    ariaLabel: "Search query",
    value: search?.query ?? "return product",
    spellcheck: false,
  });
  const corpusSelect = el(
    "select",
    { id: "ingest-corpus", ariaLabel: "Corpus" },
    ...corpora.map((corpus) => el("option", { value: corpus.name, textContent: corpus.name })),
  );
  const docId = el("input", { id: "ingest-id", type: "text", ariaLabel: "Document id", spellcheck: false });
  const title = el("input", { id: "ingest-title", type: "text", ariaLabel: "Document title" });
  const text = el("textarea", { id: "ingest-text", ariaLabel: "Document text" });
  const fill = (values) => {
    Object.assign(ingestForm, values);
    corpusSelect.value = ingestForm.corpus;
    docId.value = ingestForm.id;
    title.value = ingestForm.title;
    text.value = ingestForm.text;
  };
  fill({});
  for (const [field, element] of [
    ["corpus", corpusSelect],
    ["id", docId],
    ["title", title],
    ["text", text],
  ])
    element.oninput = () => (ingestForm[field] = element.value);
  const ingestResult = el("p", { className: "fine" });
  const bulkResult = el("p", { className: "fine" });
  return [
    ...corpora.map(corpusCard),
    el(
      "div",
      { className: "card titled", id: "passages" },
      el(
        "h3",
        {},
        "Passages of a search",
        el("span", { className: "badge", textContent: String(search?.passages.length ?? 0) }),
      ),
      el(
        "div",
        { className: "row" },
        query,
        cardAction(
          "Search the handbook",
          () => api("POST", `${path}/search`, { query: query.value.trim() }),
          changed("The Retriever returned these Passages. The search_handbook Tool gives the same ones to the Agent."),
          searchResult,
          true,
        ),
      ),
      search && el("h4", {}, "Query ", el("code", { textContent: search.query })),
      search &&
        (search.passages.length > 0
          ? el("pre", { textContent: JSON.stringify(search.passages, null, 2) })
          : el("p", { className: "muted", textContent: "No Passage matches. A query word must occur in a document." })),
      !search && el("p", { className: "muted", textContent: "Search the handbook here, or run the Search prompt." }),
      searchResult,
      el("p", {
        className: "fine",
        textContent:
          "The default Retriever is SQLite full-text search with BM25 ranking. It returns at most 10 Passages and needs no external service. A higher score is a better match.",
      }),
    ),
    el(
      "div",
      { className: "card", id: "ingest" },
      el("h3", { textContent: "Ingest a document" }),
      el(
        "div",
        { className: "chips" },
        ...INGEST_PRESETS.map((preset) =>
          el("button", { textContent: preset.label, onclick: () => fill({ ...preset, label: undefined }) }),
        ),
      ),
      el("div", { className: "row" }, corpusSelect, docId, title),
      text,
      el(
        "div",
        { className: "row" },
        cardAction(
          "Ingest the document",
          () =>
            api("POST", `${path}/ingest`, {
              corpus: corpusSelect.value,
              id: docId.value.trim(),
              title: title.value.trim(),
              text: text.value,
            }),
          changed("The corpus has the document. A document with a known id replaced its old text."),
          ingestResult,
          true,
        ),
      ),
      ingestResult,
      el("p", {
        className: "fine",
        textContent:
          "The Framework splits the text in chunks of 2,000 code points. The title goes in the metadata of the document, which each Passage carries.",
      }),
    ),
    el(
      "div",
      { className: "card titled", id: "bulk" },
      el("h3", {}, "Bulk ingest Job", job && badge(job.state)),
      job
        ? rows(["Job", el("code", { textContent: job.id })], ["Indexed", `${job.completed} of ${job.total} documents`])
        : el("p", { className: "muted", textContent: `No bulk ingest ran since the reset.` }),
      el(
        "div",
        { className: "row" },
        cardAction(
          `Ingest ${bulkSize} handbook pages`,
          () => api("POST", `${path}/bulk`),
          changed("The ingest returned a pending Job. The Knowledge Durable Object indexes the pages in batches."),
          bulkResult,
          true,
        ),
      ),
      bulkResult,
      el("p", {
        className: "fine",
        textContent:
          "An ingest of more than 32 documents returns { pending: jobId }. A search sees each page that the Job committed. While the Job is pending, each other write to the corpus fails with knowledge.busy.",
      }),
    ),
    el(
      "details",
      { className: "card" },
      el("summary", { textContent: `Corpora of the Scope (${known.length})` }),
      known.length > 0
        ? el("ul", {}, ...known.map((name) => el("li", {}, el("code", { textContent: name }))))
        : el("p", { className: "muted", textContent: "The Scope has no corpus." }),
      el("p", {
        className: "fine",
        textContent:
          "The list comes from scope.knowledge.list. The first ingest adds a corpus, and destroy removes it.",
      }),
    ),
  ];
}

// The label of each search mode of the vector retrieval scenario.
const VECTOR_MODES = {
  keyword: "Keyword (fts5)",
  vector: "Vector",
  hybrid: "Hybrid",
};

const vectorCount = (count) => `${count} ${count === 1 ? "vector" : "vectors"}`;

/** The vector retrieval scenario: the Passages of each Scope, the Vectorize index and the guides of each Scope. */
function vectorCards({ missing, reference, scopes, search, startingQuery }, onChanged, isCurrent) {
  if (missing) return [el("div", { className: "card" }, el("p", { className: "muted", textContent: missing }))];
  const path = "/api/scenarios/vector-retrieval";
  const changed = (note) => (next) => isCurrent() && onChanged(next, note);
  const [home, other] = scopes;
  const query = el("input", {
    id: "vector-query",
    type: "text",
    ariaLabel: "Search query",
    value: search?.query ?? startingQuery,
    spellcheck: false,
  });
  const mode = el(
    "select",
    { id: "vector-mode", ariaLabel: "Search mode" },
    ...Object.entries(VECTOR_MODES).map(([value, label]) =>
      el("option", { value, textContent: label, selected: value === (search?.mode ?? "vector") }),
    ),
  );
  const passagesOf = (scopeId, passages) => [
    el("h4", {}, "Scope ", el("code", { textContent: scopeId })),
    passages.length > 0
      ? el("pre", { textContent: JSON.stringify(passages, null, 2) })
      : el("p", { className: "muted", textContent: "No Passage matches." }),
  ];
  const searchResult = el("p", { className: "fine" });
  const indexResult = el("p", { className: "fine" });
  return [
    el(
      "div",
      { className: "card titled", id: "vector-passages" },
      el("h3", {}, "Passages of a search", search && badge(search.mode)),
      el("div", { className: "row" }, query, mode),
      el(
        "div",
        { className: "row" },
        cardAction(
          "Search both Scopes",
          () => api("POST", `${path}/search`, { query: query.value.trim(), mode: mode.value }),
          changed("Each Scope searched its own guides with the same query and mode."),
          searchResult,
          true,
        ),
      ),
      search && el("h4", {}, "Query ", el("code", { textContent: search.query })),
      ...(search
        ? [...passagesOf(home.id, search.passages), ...passagesOf(other.id, search.other)]
        : [el("p", { className: "muted", textContent: "Search here, or run a suggested prompt." })]),
      searchResult,
      el("p", {
        className: "fine",
        textContent:
          "Keyword uses the default Retriever fts5: it finds a Passage only when a word of the query is in it. Vector ranks by embedding similarity from the index, and also finds a Passage with the same meaning. Hybrid fuses the two ranks. Each Passage names its source.",
      }),
    ),
    el(
      "div",
      { className: "card titled", id: "vector-index" },
      el(
        "h3",
        {},
        "Vectorize index",
        el("span", { className: "badge", textContent: vectorCount(home.vectors.length) }),
      ),
      rows(...scopes.map((scope) => [`Scope ${scope.id}`, `${vectorCount(scope.vectors.length)} in the index`])),
      el(
        "div",
        { className: "row" },
        cardAction(
          "Rebuild the index",
          () => api("POST", `${path}/rebuild`),
          changed(`The Framework wrote the saved vectors of ${home.id} to the index again, with no embedding call.`),
          indexResult,
          true,
        ),
        cardAction(
          "Remove the vectors from the index",
          () => api("POST", `${path}/clear`),
          changed(`The index lost the vectors of ${home.id}. The Knowledge Durable Object still has them.`),
          indexResult,
        ),
        cardAction(
          "Read the index again",
          () => api("GET", path),
          changed("The page read the index again."),
          indexResult,
        ),
      ),
      indexResult,
      el("p", {
        className: "fine",
        textContent:
          "The Knowledge Durable Object keeps each vector, and the index keeps a copy. The copy has the opaque ids of the Framework, and each Scope is a namespace. Vectorize applies writes asynchronously, often after one or two minutes. Wait until the count changes before the next step. A remove deletes only the vectors that the index shows.",
      }),
    ),
    el(
      "details",
      { className: "card", id: "vector-ids" },
      el("summary", { textContent: `Opaque vector ids of ${home.id} (${home.vectors.length})` }),
      home.vectors.length > 0
        ? el("pre", { textContent: home.vectors.join("\n") })
        : el("p", { className: "muted", textContent: "The index has no vector of this Scope. Rebuild it." }),
      el("p", {
        className: "fine",
        textContent: "The Framework makes each id. The index keeps it unchanged, and a rebuild writes the same ids.",
      }),
    ),
    el(
      "details",
      { className: "card", id: "vector-guides" },
      el("summary", {
        textContent: `Corpus guides (${scopes.reduce((sum, scope) => sum + scope.documents.length, 0)} documents)`,
      }),
      ...scopes.flatMap((scope) => [
        el("h4", {}, "Scope ", el("code", { textContent: scope.id }), ` (${scope.documents.length} documents)`),
        el(
          "ul",
          {},
          ...scope.documents.map((doc) =>
            el("li", {}, el("code", { textContent: doc.id }), ` ${doc.title}, ${doc.chars} code points`),
          ),
        ),
      ]),
      el("h4", { textContent: "Corpus reference of the Agent Spec" }),
      el("pre", { textContent: JSON.stringify(reference, null, 2) }),
      el("p", {
        className: "fine",
        textContent:
          "The Knowledge scenario names no Retriever, thus it gets fts5. This reference names the vector Retriever with hybrid settings. The first ingest fixed the embedding model, its dimensions and its metric for the corpus.",
      }),
    ),
  ];
}

// What each state of a Scope means for the operator.
const SCOPE_STATES = {
  active: "Each Turn runs.",
  suspended: "A new Turn parks until you resume the Scope. The data of the Scope stays.",
  destroying: "The Scope is a tombstone. The Destroy walk deletes its data in batches.",
  destroyed: "Only the tombstone stays. The id can never hold data again.",
};

/**
 * The Scope lifecycle and credentials scenario: the disposable Scope with its Destroy walk, the Scope credential, the
 * credential of each model Step, the Provider profile and the key ring.
 */
function lifecycleCards(
  { scopeId, scope, destroy, profile, fallback, reference, credential, test, keyring, rewrap, steps },
  onChanged,
  isCurrent,
) {
  const path = "/api/scenarios/scopes";
  const changed = (note) => (next) => isCurrent() && onChanged(next, note);
  const live = scope.state === "active" || scope.state === "suspended";
  const time = (at) => (at === undefined ? "never" : new Date(at).toLocaleTimeString());
  const action = (label, name, note, result, { primary = false, enabled = live, body } = {}) => {
    const button = cardAction(label, () => api("POST", `${path}/${name}`, body), changed(note), result, primary);
    button.disabled = !enabled;
    return button;
  };

  const scopeResult = el("p", { className: "fine" });
  const scopeCard = el(
    "div",
    { className: "card titled", id: "scope" },
    el("h3", {}, "Disposable Scope", badge(scope.state)),
    rows(["Scope id", el("code", { textContent: scopeId })], ["Config revision", String(scope.configRevision)]),
    el("p", { className: "outcome", textContent: SCOPE_STATES[scope.state] }),
    el(
      "div",
      { className: "row" },
      action(
        "Suspend the Scope",
        "suspend",
        `The Scope ${scopeId} is suspended. Run a prompt: the Turn parks.`,
        scopeResult,
        {
          primary: scope.state === "active",
          enabled: scope.state === "active",
        },
      ),
      action(
        "Resume the Scope",
        "resume",
        `The Scope ${scopeId} is active again. A parked Turn continues.`,
        scopeResult,
        { primary: scope.state === "suspended", enabled: scope.state === "suspended" },
      ),
      action(
        "Destroy the Scope",
        "destroy",
        `The Scope ${scopeId} is a tombstone. The Destroy walk runs.`,
        scopeResult,
      ),
    ),
    scopeResult,
    destroy &&
      el(
        "div",
        {},
        el("h4", {}, "Destroy walk ", badge(destroy.state)),
        rows(
          ["Phase", destroy.progress.phase],
          ["Threads deleted", String(destroy.progress.threads)],
          ["Memories deleted", String(destroy.progress.memory)],
          ["Knowledge corpora deleted", String(destroy.progress.knowledge)],
          ["R2 objects deleted", String(destroy.progress.objects)],
          ["Items skipped", String(destroy.progress.skipped)],
        ),
        destroy.externalCleanup && el("pre", { textContent: JSON.stringify(destroy.externalCleanup, null, 2) }),
      ),
    el("p", {
      className: "fine",
      textContent:
        "A suspension is reversible and keeps each Thread, Memory and credential. A destroy is permanent: the tombstone keeps the id, and the walk deletes the data. Reset scenario destroys this Scope and moves to a new Scope id.",
    }),
  );

  const credentialResult = el("p", { className: "fine" });
  const value = el("input", {
    id: "scope-credential",
    type: "password",
    autocomplete: "off",
    placeholder: "Paste a Provider key",
    ariaLabel: "Scope credential",
    disabled: !live,
  });
  const store = cardAction(
    "Store the credential",
    () => api("POST", `${path}/credential`, { value: value.value }),
    changed("The Scope stored a new version of the credential. The answer has its metadata only."),
    credentialResult,
    true,
  );
  store.disabled = !live;
  const credentialState = !credential ? "none" : credential.revokedAt ? "revoked" : `version ${credential.version}`;
  const credentialCard = el(
    "div",
    { className: "card titled", id: "scope-credential-card" },
    el("h3", {}, "Scope credential", badge(credentialState)),
    credential
      ? rows(
          ["Reference", el("code", { textContent: reference })],
          ["Version", String(credential.version)],
          ["Stored at", time(credential.updatedAt)],
          ["Revoked at", time(credential.revokedAt)],
        )
      : el("p", { className: "muted", textContent: "The Scope has no credential. Store one to use it." }),
    value,
    el(
      "div",
      { className: "row" },
      store,
      action(
        "Test the credential",
        "test",
        "The Scope tested its profile with one small Provider call.",
        credentialResult,
      ),
      action(
        "Revoke the credential",
        "revoke",
        "The credential is revoked. The next model Step finds it missing.",
        credentialResult,
        { enabled: live && credential !== null && credential.revokedAt === undefined },
      ),
    ),
    credentialResult,
    test &&
      el(
        "div",
        {},
        el("h4", {}, `Last test at ${time(test.at)} `, badge(test.ok ? "passed" : "failed")),
        el("pre", {
          className: test.ok ? "" : "error",
          textContent: JSON.stringify(test.ok ? (test.credential ?? {}) : test.error, null, 2),
        }),
      ),
    el("p", {
      className: "fine",
      textContent:
        "The route stores the value with scope.credentials.put and clears the field. No route returns it: the card shows the metadata of scope.credentials.describe.",
    }),
  );

  const stepsCard = el(
    "div",
    { className: "card", id: "steps-credentials" },
    el("h3", { textContent: "Credential of each model Step" }),
    steps.length > 0
      ? el(
          "ul",
          {},
          ...steps.map((step) =>
            el(
              "li",
              {},
              el("code", { textContent: `seq ${step.seq}` }),
              " ",
              ...(step.fallback
                ? [
                    "Fallback to the Deployment profile ",
                    el("code", { textContent: step.profile }),
                    ". The reason is ",
                    el("code", { textContent: step.fallback.reason }),
                    ".",
                  ]
                : [
                    "The profile ",
                    el("code", { textContent: step.profile }),
                    " with ",
                    el("code", {
                      textContent: step.credential
                        ? `${step.credential.ref}, version ${step.credential.version}`
                        : "no credential",
                    }),
                    ".",
                  ]),
            ),
          ),
        )
      : el("p", {
          className: "muted",
          textContent: live
            ? "Run a prompt. Each model Step shows the credential that it ran under."
            : "The Destroy walk deleted the Thread with its events.",
        }),
    el("p", {
      className: "fine",
      textContent:
        "The Thread resolves the credential immediately before each model Step. Thus a store or a revoke applies at the next Step, also during a Turn.",
    }),
  );

  const profileResult = el("p", { className: "fine" });
  const profileCard = el(
    "div",
    { className: "card titled", id: "scope-profile" },
    el(
      "h3",
      {},
      "Provider profile of the Scope",
      badge(!profile ? "no config" : fallback ? "fallback on" : "fallback off"),
    ),
    profile
      ? el("pre", { textContent: JSON.stringify(profile, null, 2) })
      : el("p", { className: "muted", textContent: "A destroyed Scope has no config." }),
    el(
      "div",
      { className: "row" },
      action(
        fallback ? "Turn the fallback off" : "Turn the fallback on",
        "fallback",
        fallback
          ? "The profile has no fallback. A Step without the Scope credential fails the Turn."
          : "A Step without the Scope credential runs under the Deployment profile of setup.",
        profileResult,
        { body: { on: !fallback } },
      ),
    ),
    profileResult,
    el("p", {
      className: "fine",
      textContent:
        "The Agent runs on this profile. With the fallback, a missing Scope credential gives the Step to the Deployment profile default, which uses the credential of pnpm setup.",
    }),
  );

  const keyResult = el("p", { className: "fine" });
  const keyCard = el(
    "div",
    { className: "card", id: "keyring" },
    el("h3", { textContent: "Key ring" }),
    keyring
      ? rows(["Active key", el("code", { textContent: keyring.active })], ["Keys in the ring", keyring.keys.join(", ")])
      : el("p", { className: "muted", textContent: "The Worker has no KARMI_KEYRING. Run pnpm setup." }),
    el(
      "div",
      { className: "row" },
      action(
        "Rewrap the credentials",
        "rewrap",
        "Each credential of the Playground Scopes is now encrypted with the active key.",
        keyResult,
        { enabled: keyring !== null },
      ),
    ),
    keyResult,
    rewrap &&
      el(
        "div",
        {},
        el("h4", { textContent: "Credentials rewrapped, by Scope" }),
        el("pre", { textContent: JSON.stringify(rewrap, null, 2) }),
      ),
    el("p", {
      className: "fine",
      textContent:
        "The page shows the ids of the keys, never a key. To rotate, run pnpm rotate-key and start pnpm dev again, then rewrap. The ring keeps the old key, thus each credential stays readable until the rewrap.",
    }),
  );

  return [scopeCard, credentialCard, stepsCard, profileCard, keyCard];
}

// What the operator selected and typed in the registration form of the MCP scenario. It never holds the header value.
const mcpForm = { url: "", auth: "none", header: "Authorization", trust: false };

// The outcome of the OAuth callback, which sends the browser back with `connected=true` or `connected=false` in the
// query. The Connection card shows it one time.
let oauthReturn = new URLSearchParams(location.search).get("connected");

// What the operator must know about each way to authenticate to the server.
const MCP_AUTH = {
  none: "No credential",
  static: "Static header",
  oauth: "OAuth, one Connection for each User",
};

/**
 * The remote MCP scenario: the registration form or the registered server, the tool list of the server, the static
 * credential or the Connection of the User, and the Permission Policy of the Agent.
 */
function mcpCards(
  {
    scopeId,
    oauth,
    server,
    missing,
    unavailable,
    catalog,
    credential,
    user,
    connectionName,
    connection,
    discovery,
    policy,
  },
  onChanged,
  isCurrent,
) {
  const path = "/api/scenarios/mcp";
  const changed = (note) => (next) => isCurrent() && onChanged(next, note);
  const time = (at) => (at === undefined ? "never" : new Date(at).toLocaleTimeString());
  const auth = server?.config.auth.type;
  // The badge function makes a class of each word, thus a label of more than one word uses a plain badge.
  const plainBadge = (text) => el("span", { className: "badge", textContent: text });

  const serverResult = el("p", { className: "fine" });
  let serverCard;
  if (!server) {
    const url = el("input", {
      id: "mcp-url",
      type: "url",
      ariaLabel: "Server URL",
      placeholder: "https://mcp.example.com/mcp",
      spellcheck: false,
    });
    const select = el(
      "select",
      { id: "mcp-auth", ariaLabel: "Credential of the server" },
      ...Object.entries(MCP_AUTH).map(([value, label]) =>
        el("option", { value, textContent: label, disabled: value === "oauth" && !oauth.available }),
      ),
    );
    const header = el("input", { id: "mcp-header", type: "text", ariaLabel: "Header name", spellcheck: false });
    const value = el("input", {
      id: "mcp-value",
      type: "password",
      autocomplete: "off",
      ariaLabel: "Header value",
      placeholder: "Bearer …",
    });
    const trust = el("input", { id: "mcp-trust", type: "checkbox" });
    const staticRow = el("div", { className: "row" }, header, value);
    url.value = mcpForm.url;
    select.value = mcpForm.auth === "oauth" && !oauth.available ? "none" : mcpForm.auth;
    header.value = mcpForm.header;
    trust.checked = mcpForm.trust;
    const showStatic = () => (staticRow.hidden = select.value !== "static");
    showStatic();
    url.oninput = () => (mcpForm.url = url.value);
    header.oninput = () => (mcpForm.header = header.value);
    trust.onchange = () => (mcpForm.trust = trust.checked);
    select.onchange = () => {
      mcpForm.auth = select.value;
      showStatic();
    };
    serverCard = el(
      "div",
      { className: "card titled", id: "mcp-server" },
      el("h3", {}, "Remote MCP server", plainBadge("not registered")),
      el("p", {
        className: "muted",
        textContent: "Register a real MCP server. The Playground has no sample server.",
      }),
      el("div", { className: "row" }, url),
      el("div", { className: "row" }, select),
      staticRow,
      el("div", { className: "row" }, el("label", {}, trust, " Trust the annotations of the server")),
      el(
        "div",
        { className: "row" },
        cardAction(
          "Register the server",
          () =>
            api("POST", `${path}/register`, {
              url: url.value.trim(),
              auth: select.value,
              trustAnnotations: trust.checked,
              ...(select.value === "static" && { header: header.value.trim(), value: value.value }),
            }),
          changed("The Scope config has the server. Its host is the only permitted MCP host."),
          serverResult,
          true,
        ),
      ),
      serverResult,
      !oauth.available && el("p", { className: "fine", textContent: oauth.reason }),
      el("p", {
        className: "fine",
        textContent:
          "The route stores a static header value with scope.credentials.put and clears the field. The config names the credential scope:mcp-remote, never the value.",
      }),
    );
  } else {
    serverCard = el(
      "div",
      { className: "card titled", id: "mcp-server" },
      el("h3", {}, "Remote MCP server", badge("registered")),
      rows(
        ["Scope", el("code", { textContent: scopeId })],
        ["Server id", el("code", { textContent: server.id })],
        ["URL", el("code", { textContent: server.config.url })],
        ["Credential", MCP_AUTH[auth]],
        ["Permitted hosts", el("code", { textContent: server.hosts.join(", ") })],
        ["Annotations", server.config.trustAnnotations ? "trusted" : "not trusted: each Tool is destructive"],
      ),
      el("h4", { textContent: "Scope config of the server" }),
      el("pre", { textContent: JSON.stringify(server.config, null, 2) }),
      el("p", {
        className: "fine",
        textContent:
          "To register a different server, select Reset scenario. The reset destroys this Scope with the registration, and the next Scope has a new id.",
      }),
    );
  }

  const toolsResult = el("p", { className: "fine" });
  const failed = discovery && !discovery.ok ? discovery.error : undefined;
  const toolsCard = el(
    "div",
    { className: "card titled", id: "mcp-tools" },
    el("h3", {}, "Tools of the server", plainBadge(catalog ? `${catalog.tools.length} Tools` : "no tool list")),
    missing &&
      el(
        "p",
        { className: "error" },
        "The credential ",
        el("code", { textContent: missing }),
        " is missing. The server is not usable until the credential resolves.",
      ),
    unavailable && el("pre", { className: "error", textContent: `${unavailable.code}: ${unavailable.message}` }),
    failed && el("h4", { textContent: `The last tool list failed at ${time(discovery.at)}` }),
    failed && el("pre", { className: "error", textContent: `${failed.code}: ${failed.message}` }),
    catalog
      ? el(
          "div",
          {},
          rows(
            ["Tool list version", el("code", { textContent: catalog.version })],
            ["Fetched at", time(catalog.fetchedAt)],
            ["Cache scope", el("code", { textContent: catalog.cacheScope })],
            ["Protocol era", el("code", { textContent: catalog.era })],
          ),
          el(
            "ul",
            {},
            ...catalog.tools.map((tool) =>
              el(
                "li",
                {},
                el("code", { textContent: tool.name }),
                tool.description && ` ${tool.description}`,
                tool.annotations && el("pre", { textContent: JSON.stringify(tool.annotations) }),
              ),
            ),
          ),
        )
      : el("p", {
          className: "muted",
          textContent: !server
            ? "Register a server. Its Tools show here."
            : auth === "oauth" && !connection
              ? "Connect first. Most OAuth servers list their Tools only for a User with a grant."
              : "List the Tools, or run a prompt. A Turn lists the Tools when it starts.",
        }),
    el(
      "div",
      { className: "row" },
      Object.assign(
        cardAction(
          "List the Tools again",
          () => api("POST", `${path}/discover`),
          changed("The route called scope.mcp.refreshCatalog for the User."),
          toolsResult,
        ),
        { disabled: !server },
      ),
    ),
    toolsResult,
    el("p", {
      className: "fine",
      textContent:
        "The model sees each Tool as remote__<name>. A public tool list serves each User of the Scope. A private one serves only the User whose grant fetched it.",
    }),
  );

  const accessResult = el("p", { className: "fine" });
  let accessCard;
  if (auth === "static")
    accessCard = el(
      "div",
      { className: "card titled", id: "mcp-credential" },
      el(
        "h3",
        {},
        "Static credential",
        plainBadge(!credential ? "none" : credential.revokedAt ? "revoked" : `version ${credential.version}`),
      ),
      credential &&
        rows(
          ["Reference", el("code", { textContent: credential.reference })],
          ["Version", String(credential.version)],
          ["Stored at", time(credential.updatedAt)],
          ["Revoked at", time(credential.revokedAt)],
        ),
      el(
        "div",
        { className: "row" },
        Object.assign(
          cardAction(
            "Revoke the credential",
            () => api("POST", `${path}/revoke`),
            changed("The credential is revoked. The next request to the server has no header."),
            accessResult,
          ),
          { disabled: !credential || credential.revokedAt !== undefined },
        ),
      ),
      accessResult,
      el("p", {
        className: "fine",
        textContent:
          "No route, event or log returns the value. The card shows the metadata of scope.credentials.describe.",
      }),
    );
  if (auth === "oauth") {
    const returned = oauthReturn;
    oauthReturn = null;
    accessCard = el(
      "div",
      { className: "card titled", id: "mcp-connection" },
      el("h3", {}, "Connection of the User", plainBadge(connection ? "connected" : "no Connection")),
      rows(
        ["User", el("code", { textContent: user })],
        ["Connection", el("code", { textContent: connectionName })],
        ["Stored at", connection ? time(connection.updatedAt) : "never"],
      ),
      returned &&
        el("p", {
          className: returned === "true" ? "outcome" : "error",
          textContent:
            returned === "true"
              ? "The OAuth callback stored the grant of the User."
              : "The authorization server did not grant the Connection.",
        }),
      el(
        "div",
        { className: "row" },
        cardAction(
          "Connect",
          () => api("POST", `${path}/connect`),
          // The consent page sends the browser back to this scenario.
          ({ authUrl }) => location.assign(authUrl),
          accessResult,
          !connection,
        ),
        Object.assign(
          cardAction(
            "Disconnect",
            () => api("POST", `${path}/disconnect`),
            changed(
              "The Scope dropped the grant of the User. A private tool list goes with it. A public one stays, thus the next call asks for the Connection.",
            ),
            accessResult,
          ),
          { disabled: !connection },
        ),
      ),
      accessResult,
      el("p", {
        className: "fine",
        textContent:
          "Connect calls scope.mcp.authorize and opens the consent page. A call without a grant asks for the Connection in the conversation, when the Turn has a tool list. Disconnect keeps a public tool list, thus the next call asks. A server can also revoke the grant: karmi then drops it, and the next call asks.",
      }),
    );
  }

  const policyCard = el(
    "details",
    { className: "card" },
    el("summary", { textContent: `Permission Policy of the Agent (${policy.length} rule)` }),
    el("pre", { textContent: JSON.stringify(policy, null, 2) }),
    el("p", {
      className: "fine",
      textContent:
        "The rule allows a Tool with readOnlyHint. Each other call waits for your Approval. Without trusted annotations, no Tool of the server is read-only.",
    }),
  );

  return [serverCard, toolsCard, accessCard, policyCard].filter(Boolean);
}

// The settings that the operator selected in the Agent card and did not save yet. A save clears them.
const providerForm = { draft: undefined };

const PROVIDER_POLICIES = {
  none: "No rule: the grant allows it",
  allow: "allow",
  deny: "deny",
  ask: "ask (not valid)",
};

/**
 * The Provider scenario: the settings of the stored Agent Spec, the Provider profiles of setup, the profile of each
 * model Step, each Tool call with where it ran, and the Usage records with the gateway log id.
 */
function providerCards({ profiles, agent, steps, calls, usage }, onChanged, isCurrent) {
  if (!agent) return [el("p", { className: "card muted", textContent: "No Provider is set up. Run pnpm setup." })];
  const settings = providerForm.draft ?? agent.settings;
  const edit = (change) => (providerForm.draft = { ...settings, ...providerForm.draft, ...change });
  const profileOf = (name) => profiles.find((profile) => profile.name === name);

  const result = el("p", { id: "provider-result", className: "fine" });
  const profile = el(
    "select",
    { id: "provider-profile", ariaLabel: "Provider profile" },
    ...profiles.map((entry) => el("option", { value: entry.name, textContent: `${entry.name}: ${entry.model}` })),
  );
  profile.value = settings.profile;
  const webSearch = el("input", { id: "provider-web-search", type: "checkbox", checked: settings.webSearch });
  const policy = el(
    "select",
    { id: "provider-policy", ariaLabel: "Permission Policy rule for web_search" },
    ...Object.entries(PROVIDER_POLICIES).map(([value, label]) => el("option", { value, textContent: label })),
  );
  policy.value = settings.policy;
  const support = el("p", { className: "fine" });
  const showSupport = () => {
    const tools = profileOf(profile.value)?.providerTools ?? [];
    const code = (text) => el("code", { textContent: text });
    support.replaceChildren(
      ...(tools.length
        ? ["The profile ", code(profile.value), " accepts these Provider Tools: ", ...tools.map(code), "."]
        : [
            "The profile ",
            code(profile.value),
            " accepts no Provider Tool. A grant gets ",
            code("capability.unavailable"),
            ".",
          ]),
    );
  };
  showSupport();
  profile.onchange = () => {
    edit({ profile: profile.value });
    showSupport();
  };
  webSearch.onchange = () => edit({ webSearch: webSearch.checked });
  policy.onchange = () => edit({ policy: policy.value });
  const save = el("button", { id: "save-provider", className: "primary", textContent: "Save the Agent" });
  save.onclick = async () => {
    save.disabled = true;
    try {
      const body = { profile: profile.value, webSearch: webSearch.checked, policy: policy.value };
      const next = await api("POST", "/api/scenarios/providers/agent", body);
      providerForm.draft = undefined;
      if (isCurrent())
        onChanged(
          next,
          `The Scope stored version ${next.agent.version}. The next Turn of this Thread runs on the profile ${body.profile}.`,
        );
    } catch (error) {
      showRejection(result, error);
    } finally {
      save.disabled = false;
    }
  };
  const agentCard = el(
    "div",
    { className: "card titled", id: "provider-agent" },
    el("h3", {}, "Agent Spec", el("span", { className: "badge", textContent: `version ${agent.version}` })),
    rows(
      ["Profile", el("code", { textContent: agent.settings.profile })],
      ["Model", el("code", { textContent: agent.spec.model.id })],
      [
        "web_search",
        agent.settings.webSearch
          ? el("span", {}, "granted, Policy rule: ", el("code", { textContent: agent.settings.policy }))
          : "not granted",
      ],
    ),
    el("h4", { textContent: "Change the Agent" }),
    el("div", { className: "row" }, profile),
    support,
    el("div", { className: "row" }, el("label", {}, webSearch, " Grant the Provider Tool web_search")),
    el("div", { className: "row" }, policy),
    el("div", { className: "row" }, save),
    result,
    el(
      "p",
      { className: "fine" },
      "A save stores a new version of the Agent Spec and keeps the Thread. A Provider Tool can only be allowed or denied: an ask rule gets ",
      el("code", { textContent: "policy.ask-on-provider-tool" }),
      ".",
    ),
  );

  const stepsCard = el(
    "div",
    { className: "card", id: "provider-steps" },
    el("h3", { textContent: "Model Steps" }),
    steps.length
      ? el(
          "ul",
          {},
          ...steps.map((step) =>
            el(
              "li",
              {},
              `Turn ${step.turn}: `,
              el("code", { textContent: step.profile }),
              " ",
              el("code", { textContent: step.model }),
              `, Spec version ${step.agentVersion}`,
            ),
          ),
        )
      : el("p", { className: "muted", textContent: "Run a prompt. Each model Step shows its profile and model here." }),
  );

  const callsCard = el(
    "div",
    { className: "card", id: "provider-calls" },
    el("h3", { textContent: "Tool calls" }),
    calls.length
      ? el(
          "div",
          {},
          ...calls.flatMap((call) => [
            el(
              "h4",
              {},
              el("code", { textContent: call.name }),
              " ",
              el("span", {
                className: "badge",
                textContent: call.runsAt === "provider" ? "Provider Tool" : "Harness Tool",
              }),
            ),
            el("pre", { textContent: call.result ?? "No result yet." }),
          ]),
        )
      : el("p", {
          className: "muted",
          textContent: "Run the Harness Tool or the Provider Tool prompt. Each call shows here with where it ran.",
        }),
    el("p", {
      className: "fine",
      textContent:
        "The Harness runs shop_hours in the Worker after the Permission Policy allows it. The Provider runs web_search inside the model call, thus no before-tool Hook and no Approval can stop it.",
    }),
  );

  const usageCard = el(
    "div",
    { className: "card", id: "provider-usage" },
    el("h3", { textContent: "Usage records" }),
    usage.length
      ? el(
          "ul",
          {},
          ...usage.map((record) =>
            el(
              "li",
              {},
              `seq ${record.seq} on `,
              el("code", { textContent: record.profile }),
              `: ${tokenLine(record)}. Cost: `,
              record.cost
                ? el("code", { textContent: `${record.cost.amount} ${record.cost.currency}` })
                : "Not reported",
              ". Gateway log: ",
              record.gateway ? el("code", { textContent: record.gateway.id }) : "none",
            ),
          ),
        )
      : el("p", { className: "muted", textContent: "Run a prompt. Each model call writes a Usage record." }),
    el("p", {
      className: "fine",
      textContent:
        "Cloudflare AI Gateway reports no cost in its answer. Find the gateway log id in the logs of the gateway in the Cloudflare dashboard.",
    }),
  );

  const profilesCard = el(
    "details",
    { className: "card", id: "provider-profiles" },
    el("summary", {}, `Provider profiles of setup (${profiles.length})`),
    ...profiles.flatMap((entry) => [
      el("h4", {}, el("code", { textContent: entry.name }), ` ${entry.label}`),
      rows(
        ["Model", el("code", { textContent: entry.model })],
        [
          "Provider Tools",
          entry.providerTools.length ? el("code", { textContent: entry.providerTools.join(", ") }) : "none",
        ],
        [
          "AI Gateway",
          entry.config.gateway
            ? el("code", { textContent: `${entry.config.gateway.accountId}/${entry.config.gateway.gatewayId}` })
            : "none",
        ],
      ),
      el("pre", { textContent: JSON.stringify(entry.config, null, 2) }),
    ]),
    el("p", {
      className: "fine",
      textContent:
        "A profile names each credential, never a value. pnpm setup adds the second and the gateway profile.",
    }),
  );

  return [agentCard, stepsCard, callsCard, usageCard, profilesCard];
}

const TRANSPORT_LABELS = { sse: "Server-Sent Events", websocket: "WebSocket" };

// The guided request that the operator selected, and the last answer. The side column renders again on each event.
const requestForm = { index: 0, answer: undefined };

/**
 * Sends one guided request to a Thread route as it is. It does not use the `api` function, because a request
 * without the token must show its 401 answer, not the token form.
 */
async function sendGuided(request, threadKey) {
  const response = await fetch(request.path.replace("{key}", threadKey), {
    method: request.method,
    headers: {
      ...(request.token && { authorization: `Bearer ${token}` }),
      ...(request.body !== undefined && { "content-type": "application/json" }),
    },
    ...(request.body !== undefined && { body: JSON.stringify(request.body) }),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function transportCards({ threadKey, requests }, _onChanged, isCurrent, stream) {
  const transport = el(
    "select",
    { ariaLabel: "Transport of the event stream", onchange: () => stream.setTransport(transport.value) },
    ...Object.entries(TRANSPORT_LABELS).map(([value, label]) => el("option", { value, textContent: label })),
  );
  transport.value = stream.transport;
  const route =
    stream.transport === "sse"
      ? `GET /threads/${threadKey}/events?after=<last seq>\nAccept: text/event-stream`
      : `GET /threads/${threadKey}?after=<last seq>\nUpgrade: websocket`;
  const streamCard = el(
    "div",
    { className: "card titled", id: "stream" },
    el("h3", {}, "Event stream of this page", badge(stream.attached ? "connected" : "dropped")),
    el("p", {
      className: "fine",
      textContent: !stream.attached
        ? "The page holds no stream. A Turn still runs, and the Thread stores each event. Connect again: the stream first sends each stored event after the last seq of the page."
        : stream.transport === "sse"
          ? "An EventSource reads the events. The id of each record is the seq of the event."
          : "The Durable Object of the Thread owns the socket. Run sends a send frame on it, and the events arrive on the same socket.",
    }),
    el(
      "div",
      { className: "row" },
      transport,
      el("button", {
        className: stream.attached ? "" : "primary",
        textContent: stream.attached ? "Drop the stream" : "Connect again",
        onclick: stream.toggle,
      }),
    ),
    el("h4", { textContent: "Route" }),
    el("pre", { textContent: route }),
    rows(["Last seq of the page", stream.seq]),
    stream.replay,
    stream.reply && el("h4", { textContent: "Answer to the last frame" }),
    stream.reply && el("pre", { textContent: JSON.stringify(stream.reply, null, 2) }),
  );

  return [streamCard, requestCard(threadKey, requests, isCurrent)];
}

// The card of the guided REST requests. A new selection renders the card again with the selected request.
function requestCard(threadKey, requests, isCurrent) {
  const selected = requests[requestForm.index] ?? requests[0];
  const answer = el("pre", {
    textContent: requestForm.answer ?? "Send the request. Its status and its JSON body show here.",
  });
  const picker = el(
    "select",
    {
      ariaLabel: "Guided request",
      onchange: () => {
        requestForm.index = Number(picker.value);
        requestForm.answer = undefined;
        card.replaceWith(requestCard(threadKey, requests, isCurrent));
      },
    },
    ...requests.map((request, index) => el("option", { value: String(index), textContent: request.label })),
  );
  picker.value = String(requests.indexOf(selected));
  const send = el("button", {
    className: "primary",
    textContent: "Send the request",
    onclick: async () => {
      send.disabled = true;
      answer.textContent = "Sending…";
      try {
        const { status, body } = await sendGuided(selected, threadKey);
        requestForm.answer = `HTTP ${status}\n${JSON.stringify(body, null, 2)}`;
      } catch (error) {
        requestForm.answer = `The request failed: ${error.message}`;
      } finally {
        send.disabled = false;
      }
      if (isCurrent()) answer.textContent = requestForm.answer;
    },
  });
  const request = [
    `${selected.method} ${selected.path.replace("{key}", threadKey)}`,
    !selected.token && "(no access token)",
    selected.body !== undefined && `\n${JSON.stringify(selected.body)}`,
  ];
  const card = el(
    "div",
    { className: "card", id: "requests" },
    el("h3", { textContent: "REST requests" }),
    el("div", { className: "row" }, picker, send),
    el("pre", { textContent: request.filter(Boolean).join("\n") }),
    el("p", {
      className: "fine",
      textContent: `Expected: HTTP ${selected.status}. ${selected.shows}`,
    }),
    selected.code &&
      el("p", { className: "fine" }, "Expected error code: ", el("code", { textContent: selected.code })),
    answer,
  );
  return card;
}

// Resolves with the socket when it is open, or with undefined when it closes before it opens.
function opened(socket) {
  if (socket.readyState !== WebSocket.CONNECTING) return socket.readyState === WebSocket.OPEN ? socket : undefined;
  return new Promise((resolve) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("close", () => resolve(undefined), { once: true });
  });
}

// Renders a terminal walkthrough with one card for each step. A card has the commands, the output and what it means.
function walkthroughSteps(scenario) {
  return el(
    "ol",
    { className: "walkthrough" },
    ...scenario.walkthrough.map((step) =>
      el(
        "li",
        { className: "card" },
        el("h3", { textContent: step.title }),
        el("p", { textContent: step.purpose }),
        el("h4", { textContent: "Run in examples/playground" }),
        el("pre", { textContent: step.commands }),
        step.output && el("h4", { textContent: "Output" }),
        step.output && el("pre", { textContent: step.output }),
        el("h4", { textContent: "Expected result" }),
        el("p", { textContent: step.expected }),
      ),
    ),
  );
}

// The cards next to the conversation, by scenario id.
const PANELS = {
  refund: (state) => [orderCard(state.order)],
  agents: specCards,
  stockroom: stockCards,
  turns: dispatchCards,
  forks: forkCards,
  schedules: scheduleCards,
  compaction: ledgerCards,
  delegation: purchaseCards,
  memory: memoryCards,
  knowledge: knowledgeCards,
  "vector-retrieval": vectorCards,
  observability: observabilityCards,
  scripts: scriptCards,
  "container-scripts": containerCards,
  scopes: lifecycleCards,
  mcp: mcpCards,
  providers: providerCards,
  transports: transportCards,
};

/**
 * The Threads that the composer of a scenario can send to, or null for a scenario with one Thread. Each entry
 * has the label of the option, the Thread key and, for a scenario that acts in more than one Scope, the Scope.
 */
const TARGETS = {
  forks: (state) =>
    [
      !state.original.deleted && { label: "Send to the Original Thread", threadKey: state.original.threadKey },
      state.fork && { label: "Send to the Fork Thread", threadKey: state.fork.threadKey },
    ].filter(Boolean),
  memory: (state) =>
    state.scopes.map((scope) => ({
      label: `Send in the Scope ${scope.id}`,
      threadKey: scope.threadKey,
      scope: scope.id,
    })),
};

async function renderScenario(scenario) {
  const mine = view;
  const ready = scenario.status === "ready";
  const prompt = el("textarea", {
    id: "prompt",
    value: scenario.prompts[0].text,
    ariaLabel: "Prompt",
    placeholder: "Write a message to the Agent.",
  });
  const file = scenario.upload ? el("input", { id: "file", type: "file", ariaLabel: "File" }) : null;
  const removeFile = el("button", { textContent: "Remove the file", disabled: true });
  // A script can set the files of an input only through a DataTransfer object.
  const setFile = (...files) => {
    const transfer = new DataTransfer();
    for (const item of files) transfer.items.add(item);
    file.files = transfer.files;
    removeFile.disabled = files.length === 0;
  };
  if (file) file.onchange = () => (removeFile.disabled = file.files.length === 0);
  removeFile.onclick = () => setFile();
  // The composer of a scenario that compares Threads or Scopes selects the Thread that receives the Turn.
  const target = TARGETS[scenario.id]
    ? el("select", { id: "target", ariaLabel: "Thread that receives the Turn" })
    : null;
  const run = el("button", { id: "run", className: "primary", textContent: "Run", disabled: true });
  // The Turn controls act on the Turn that runs or is parked. Only a scenario that explains them shows them.
  const control = (id, text) => (scenario.controls ? el("button", { id, textContent: text, disabled: true }) : null);
  const steer = control("steer", "Add to this Turn");
  const queue = control("queue", "Queue for the next Turn");
  const stop = control("cancel", "Cancel the Turn");
  const controls = [steer, queue, stop].filter(Boolean);
  const reset = el("button", { id: "reset", textContent: "Reset scenario", disabled: true });
  const status = el("span", { className: "hint" });
  const steps = el("div", { id: "steps" });
  const log = el("div", { id: "log" });
  const logCount = el("span", { textContent: "0" });
  log.onclick = (event) => event.target.closest("pre")?.classList.toggle("open");
  $("main").replaceChildren(
    intro(scenario, el("a", { href: scenario.code, target: "_blank", textContent: "Example code" }), reset),
    el(
      "div",
      { className: "workspace" },
      el(
        "section",
        { className: "chat" },
        steps,
        el(
          "div",
          { className: "composer" },
          scenario.prompts.length > 1 &&
            el(
              "div",
              { className: "chips" },
              ...scenario.prompts.map((item) =>
                el("button", { textContent: item.label, onclick: () => (prompt.value = item.text) }),
              ),
            ),
          prompt,
          file &&
            el(
              "div",
              { className: "row" },
              file,
              el("button", {
                textContent: "Attach the sample file",
                onclick: () => setFile(new File(["karmi sample media\n"], "sample.txt", { type: "text/plain" })),
              }),
              removeFile,
            ),
          file &&
            el("p", {
              className: "fine",
              textContent: "The file goes with the next message only. A message without a file sends only text.",
            }),
          el("div", { className: "row" }, run, target, ...controls, status),
        ),
      ),
      el(
        "aside",
        { className: "side" },
        el("div", { id: "panel" }, el("p", { className: "card muted", textContent: "Loading…" })),
        el("details", { className: "card events" }, el("summary", {}, "Event log (", logCount, " events)"), log),
      ),
    ),
  );

  const path = `/api/scenarios/${scenario.id}`;
  let state = await api("GET", path);
  if (mine !== view) return;
  // The Thread that the conversation shows and that receives each Turn, and the sample Scope that it is in. The
  // Scope is undefined for a scenario that acts in the default Scope only. A scenario in a Scope of its own names it.
  let threadKey = state.threadKey;
  let scopeId = state.scopeId;
  // A Thread route with the Scope of the conversation. The token goes in the query for a stream.
  const threadRoute = (suffix, ...params) => {
    const query = [...params, scopeId && `scope=${encodeURIComponent(scopeId)}`].filter(Boolean).join("&");
    return `/threads/${threadKey}${suffix}${query ? `?${query}` : ""}`;
  };
  let shownPanel;
  // False while the page holds no stream of the Thread. Only the Schedules scenario detaches its Subscriber.
  let attached = true;
  // The `seq` of the newest event that the page has, thus a new stream or a plain read starts after it.
  let lastSeq = 0;
  // The transports scenario selects the transport of the stream. `replayFrom` is the seq after which the last
  // reconnect started, and `frameReply` is the answer to the last WebSocket frame of the page.
  let transport = "sse";
  let replayFrom;
  let frameReply;
  let frameId = 0;
  const seqLine = el("code", { textContent: "0" });
  const replayLine = el("p", { className: "outcome", hidden: true });
  const showPanel = () => {
    // The key is part of the comparison, because a card can act on the Thread, and a reset starts a new one.
    const next = JSON.stringify({ state, attached, transport, frameReply });
    if (next === shownPanel) return;
    // A panel action returns the whole scenario state. A saved Spec also starts a new Thread.
    const cards = PANELS[scenario.id](
      state,
      (saved, note) => {
        // A saved Spec starts a new Thread. Each other panel action keeps the Thread of the conversation.
        if (scenario.id === "agents") restart(saved);
        else {
          state = saved;
          shownPanel = undefined;
          showPanel();
          awaitQueue();
          watchProgress();
          if (syncTarget()) showThread();
        }
        $("panel").append(el("p", { id: "saved", className: "outcome", textContent: note }));
      },
      () => mine === view,
      {
        attached,
        toggle: () => setAttached(!attached),
        transport,
        setTransport: (next) => {
          transport = next;
          replayFrom = undefined;
          replayLine.hidden = true;
          frameReply = undefined;
          setAttached(true);
        },
        seq: seqLine,
        replay: replayLine,
        reply: frameReply,
      },
    );
    if (shownPanel !== undefined) cards[0].classList.add("changed");
    shownPanel = next;
    $("panel").replaceChildren(...cards);
  };
  // The number of the last panel read. Two reads can overlap, and the older answer can arrive last. The panel
  // shows the answer of the last read only, thus a stale copy never replaces a fresh one.
  let reads = 0;
  const refreshPanel = async () => {
    const read = ++reads;
    const next = await api("GET", path);
    if (mine !== view || read !== reads) return;
    state = next;
    showPanel();
    awaitQueue();
    watchProgress();
  };
  // The Queue delivers Usage records to the UsageHandler after the Turn, and no Thread event tells the page. Thus
  // the page reads the state again while the UsageHandler waits for the last record. It stops after one minute,
  // because a batch that failed each retry goes to the dead-letter queue and never arrives.
  let queueTimer;
  let queueChecks = 0;
  const awaitQueue = () => {
    clearTimeout(queueTimer);
    if (!state.handler?.waiting) return void (queueChecks = 0);
    if (queueChecks++ < 30) queueTimer = setTimeout(() => mine === view && refreshPanel(), 2000);
  };
  // A bulk ingest Job of the Knowledge scenario, the Destroy walk of a Scope and a Tool call that a held ledger keeps
  // running change the state without a Thread event, thus the page reads the state on a timer. One timer runs at a time.
  let jobTimer;
  const watchProgress = () => {
    clearTimeout(jobTimer);
    const held = state.ledger?.held && state.turn?.state === "running";
    if (state.job?.state === "pending" || state.destroy?.state === "destroying" || held)
      jobTimer = setTimeout(() => mine === view && refreshPanel(), 1000);
  };
  showPanel();
  awaitQueue();
  watchProgress();
  // One request covers a burst of events, for example the replay of the event log after a reload.
  let panelTimer;
  const refreshSoon = () => {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(refreshPanel, 60);
  };

  let live;
  let busy = false;
  let waiting = 0;
  // Why the Turn is parked, or undefined while it runs or the Thread is idle.
  let parked;
  const typing = el("div", { className: "typing", textContent: "The Agent works" });
  const tools = new Map();
  const json = (value) => JSON.stringify(value, null, 2);
  const sync = () => {
    run.disabled = !ready || busy;
    for (const button of controls) button.disabled = !ready || !busy;
    status.textContent = !ready
      ? "This scenario cannot run with the current setup."
      : waiting > 0
        ? "The Agent waits for your decision."
        : busy && !attached && scenario.id === "transports"
          ? "The page has no stream. The Turn runs, and Connect again shows its events."
          : parked
            ? `The Turn is parked. It waits for ${waitsFor(parked, children.size > 0)}.`
            : busy
              ? "The Agent works…"
              : "Ctrl + Enter runs the prompt.";
    // A node that moves restarts its animation, so the line moves only when it is not the last one.
    if (!(busy && waiting === 0 && !parked && !live)) typing.remove();
    else if (steps.lastChild !== typing) steps.append(typing);
  };
  const add = (node) => {
    // The view follows new content only when the operator is already at the end.
    const follow = steps.scrollHeight - steps.scrollTop - steps.clientHeight < 80;
    steps.append(node);
    sync();
    if (follow) steps.scrollTop = steps.scrollHeight;
    return node;
  };
  // `kind` names who runs the call: the Harness for a Tool call, or the Provider for a Provider Tool call.
  const toolCard = (id, name, input, kind = "Tool call") => {
    let card = tools.get(id);
    if (card) return card;
    const label = el("span", { className: "state", textContent: "running" });
    card = add(
      el(
        "details",
        { className: "tool" },
        el("summary", {}, el("span", {}, `${kind}: `, el("code", { textContent: name })), label),
        el("h4", { textContent: "Input" }),
        el("pre", { textContent: json(input) }),
      ),
    );
    card.state = label;
    tools.set(id, card);
    return card;
  };
  // The text of a Turn input, then one line for each file that it carries.
  const inputParts = (input) =>
    input.kind === "event"
      ? [el("code", { textContent: input.type }), el("pre", { textContent: json(input.payload) })]
      : (input.parts ?? []).map((part) =>
          part.type === "text"
            ? part.text
            : el(
                "span",
                { className: "attachment" },
                `${part.media.name ?? part.media.id} `,
                el("code", { textContent: `${part.media.mimeType}, ${part.media.bytes} bytes` }),
              ),
        );
  const agentText = () =>
    (live ??= add(el("div", { className: "agent" }, el("strong", { textContent: "Agent" }), el("span"))));

  // The child cards of the conversation, by child Thread key. Each one shows the events of its own Thread.
  const children = new Map();
  const childCard = (childKey, callId) => {
    let card = children.get(childKey);
    if (card) return card;
    const label = el("span", { className: "state", textContent: "running" });
    const items = el("div", { className: "items" });
    card = add(
      el(
        "details",
        { className: "tool child", open: true },
        el("summary", {}, el("span", {}, "Child Thread for the call ", el("code", { textContent: callId })), label),
        el("p", {
          className: "fine",
          textContent: "The child runs in its own Thread with new context. The card shows the events of the child.",
        }),
        items,
      ),
    );
    card.state = label;
    card.items = items;
    card.live = undefined;
    children.set(childKey, card);
    // The child has its own event log. The stream of the child fills this card only.
    const source = new EventSource(`/threads/${childKey}/events?after=0&token=${encodeURIComponent(token)}`);
    source.onmessage = (message) => onChildEvent(card, JSON.parse(message.data));
    childStreams.add(source);
    card.stream = source;
    return card;
  };
  // A child that ended sends no more events, thus its stream closes and leaves the set.
  const closeChild = (card) => {
    card.stream.close();
    childStreams.delete(card.stream);
  };
  const childText = (card) =>
    (card.live ??= card.items.appendChild(
      el("div", { className: "agent" }, el("strong", { textContent: "Child Agent" }), el("span")),
    ));
  const onChildEvent = (card, event) => {
    const line = (text, ...nodes) => card.items.append(el("p", { className: "outcome" }, text, ...nodes));
    switch (event.type) {
      case "turn.started":
        card.items.append(
          el("div", { className: "you" }, el("strong", { textContent: "Task" }), ...inputParts(event.input)),
        );
        break;
      case "message.delta":
        if (event.kind !== "text") break;
        childText(card).lastChild.textContent += event.text;
        break;
      case "message.part":
        if (event.block.type !== "text") break;
        childText(card).lastChild.textContent = event.block.text;
        card.live = undefined;
        break;
      case "tool.call":
        line(
          "Tool call ",
          el("code", { textContent: event.name }),
          " ",
          el("code", { textContent: JSON.stringify(event.input) }),
        );
        break;
      case "tool.result":
        line(
          `${event.isError ? "Error result" : "Result"} of `,
          el("code", { textContent: event.name }),
          `: ${event.content.map((block) => block.text ?? "").join(" ")}`,
        );
        refreshSoon();
        break;
      case "approval.requested":
        if (event.kind === "tool")
          line(
            "The child asks for an Approval of ",
            el("code", { textContent: event.tool }),
            ". The parent Thread shows it again. Answer it there.",
          );
        break;
      case "turn.completed":
        card.classList.add("done");
        card.state.textContent = "completed";
        closeChild(card);
        break;
      case "turn.failed":
        card.classList.add("failed");
        card.state.textContent = event.reason === "cancelled" ? "cancelled with the parent Turn" : "failed";
        line(
          event.reason === "cancelled"
            ? "The cancel of the parent Turn stopped the child."
            : `The child Turn failed: ${event.message}`,
        );
        closeChild(card);
        break;
    }
    refreshSoon();
  };

  // The Tool call lists of the run_script cards, by the seq of the run_script call. The parentCallId of a Tool call of
  // a Script is `{threadId}:{seq}` of that call.
  const scripts = new Map();
  const scriptCard = (event) => {
    const card = tools.get(event.id);
    const items = el("div", { className: "items" });
    card.classList.add("script");
    card.open = true;
    card.append(
      el("h4", { textContent: "Tool calls of the Script" }),
      el("p", {
        className: "fine",
        textContent: "Each call runs through the Policy, the input schema and the Hooks. The model does not see it.",
      }),
      items,
    );
    scripts.set(String(event.seq), items);
  };
  const scriptLine = (parentCallId, ...nodes) =>
    scripts
      .get(parentCallId.slice(parentCallId.lastIndexOf(":") + 1))
      ?.append(el("p", { className: "outcome" }, ...nodes));

  // Answers one Approval. The card turns its buttons off, because the Thread rejects a second answer.
  const ask = (seq, decision) => async (click) => {
    click.target
      .closest(".approval")
      .querySelectorAll("button")
      .forEach((button) => (button.disabled = true));
    await api("POST", threadRoute(`/approvals/${seq}`), { decision, by: "operator" });
  };

  // True from the start of a compact Step until its thread.compacted event. A Step without one dropped nothing.
  let compacting = false;
  // The profile of the last model Step that the conversation of the Provider scenario named.
  let shownProfile;
  const onEvent = (event) => {
    // A stream that connects again after a restart of the dev server can repeat an event.
    if (Number.isInteger(event.seq)) {
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
      seqLine.textContent = String(lastSeq);
      if (replayFrom !== undefined)
        replayLine.textContent = `Since the reconnect with after=${replayFrom}, the stream sent seq ${replayFrom + 1} to ${lastSeq}.`;
    }
    logCount.textContent = String(Number(logCount.textContent) + 1);
    log.append(el("pre", { textContent: JSON.stringify(event) }));
    switch (event.type) {
      case "turn.started":
        busy = true;
        refreshSoon();
        add(
          el(
            "div",
            { className: "you" },
            el("strong", { textContent: event.input.kind === "event" ? "Event" : "You" }),
            ...inputParts(event.input),
          ),
        );
        break;
      case "schedule.created":
      case "schedule.fired":
      case "schedule.skipped":
      case "schedule.cancelled":
        add(
          el(
            "p",
            { className: "outcome" },
            SCHEDULE_LINES[event.type],
            event.nextAt !== undefined && ` The next firing is at ${new Date(event.nextAt).toLocaleTimeString()}.`,
          ),
        );
        refreshSoon();
        break;
      case "server_tool.called": {
        const card = toolCard(event.id, event.name, event.input, "Provider Tool call");
        card.append(
          el("p", {
            className: "outcome",
            textContent:
              "The Provider runs this Tool inside the model call. The Harness does not run it, and no Approval can stop it.",
          }),
        );
        break;
      }
      case "server_tool.result": {
        const card = toolCard(event.id, event.name, undefined);
        card.classList.add("done");
        card.state.textContent = "done";
        card.append(el("h4", { textContent: "Result summary" }), el("pre", { textContent: event.summary }));
        tools.delete(event.id);
        refreshSoon();
        break;
      }
      case "step.started":
        if (scenario.id === "providers" && event.kind === "model" && event.profile !== shownProfile) {
          shownProfile = event.profile;
          add(
            el(
              "p",
              { className: "outcome" },
              "This model Step runs on the profile ",
              el("code", { textContent: event.profile }),
              " with ",
              el("code", { textContent: event.model }),
              ".",
            ),
          );
        }
        if (event.kind === "compact") {
          compacting = true;
          add(
            el("p", {
              className: "outcome",
              textContent: `${COMPACTION_TRIGGERS[event.trigger] ?? "The Harness compacts the Thread."} A compact Step runs before the model Step.`,
            }),
          );
        } else if (event.fallback)
          add(
            el(
              "p",
              { className: "outcome" },
              "This model Step runs under the Deployment profile ",
              el("code", { textContent: event.profile }),
              ". The credential of the profile ",
              el("code", { textContent: event.fallback.from }),
              " is ",
              el("code", { textContent: event.fallback.reason }),
              ".",
            ),
          );
        else if (event.attempt > 1)
          add(
            el("p", {
              className: "outcome",
              textContent: `Attempt ${event.attempt} of the ${event.kind} Step ${event.n}. The Thread runs the Step that did not finish again.`,
            }),
          );
        break;
      case "step.completed":
        if (event.kind === "compact" && compacting)
          add(
            el("p", {
              className: "outcome",
              textContent: "The compact Step dropped nothing. The recent events fit in the kept tokens.",
            }),
          );
        compacting = false;
        break;
      case "thread.compacted":
        compacting = false;
        add(
          el(
            "details",
            { className: "tool done compacted", open: true },
            el(
              "summary",
              {},
              el("span", {}, "Compaction: ", el("code", { textContent: `${event.trigger}, ${event.strategy}` })),
              el("span", { className: "state", textContent: `${event.tokensBefore} → ${event.tokensAfter} tokens` }),
            ),
            el("h4", { textContent: "Summary" }),
            el("pre", { textContent: event.summary }),
            el("h4", { textContent: "Retained context" }),
            el("p", {
              className: "outcome",
              textContent: `The log keeps every event. The next request has the Prompt, this summary and the events from seq ${event.firstKeptSeq}. The events before it are in the summary only.`,
            }),
          ),
        );
        break;
      case "turn.input":
        add(
          el(
            "div",
            { className: "you" },
            el("strong", { textContent: event.steer ? "You, added to this Turn" : "You, in this Turn" }),
            ...inputParts(event.input),
          ),
        );
        break;
      case "message.delta":
        if (event.kind !== "text") break;
        agentText().lastChild.textContent += event.text;
        steps.scrollTop = steps.scrollHeight;
        break;
      case "message.part":
        if (event.block.type !== "text") break;
        agentText().lastChild.textContent = event.block.text;
        live = undefined;
        break;
      case "tool.call":
        if (event.parentCallId) {
          scriptLine(
            event.parentCallId,
            "Tool call ",
            el("code", { textContent: event.name }),
            " ",
            el("code", { textContent: JSON.stringify(event.input) }),
          );
          break;
        }
        toolCard(event.id, event.name, event.input);
        // A container Script has a language and no Tools, thus its card lists no nested Tool calls.
        if (event.name === "run_script" && !event.input?.language) scriptCard(event);
        break;
      case "delegation.started":
        add(
          el(
            "p",
            { className: "outcome" },
            "The delegate call started the child Thread ",
            el("code", { textContent: event.childKey }),
            ". The tool Step parks until the child answers.",
          ),
        );
        childCard(event.childKey, event.id);
        refreshSoon();
        break;
      case "delegation.completed": {
        const card = childCard(event.childKey, event.id);
        card.append(
          el("h4", { textContent: "Result for the parent" }),
          el("pre", { textContent: event.result.content.map((block) => block.text ?? "").join("\n") }),
          el("p", {
            className: "outcome",
            textContent: event.result.isError
              ? "The child ended without a final answer. The parent model gets an error result."
              : "The final answer of the child is the result of the delegate call. The parent model sees only this text.",
          }),
        );
        refreshSoon();
        break;
      }
      case "tool.result": {
        if (event.parentCallId) {
          scriptLine(
            event.parentCallId,
            `${event.isError ? "Error result" : "Result"} of `,
            el("code", { textContent: event.name }),
            `: ${event.content.map((block) => block.text ?? "").join(" ")}`,
          );
          refreshSoon();
          break;
        }
        const card = toolCard(event.id, event.name, undefined);
        card.classList.add(event.isError ? "failed" : "done");
        card.state.textContent = event.interrupted ? "interrupted" : event.isError ? "error" : "done";
        if (event.interrupted)
          card.append(
            el("p", {
              className: "outcome",
              textContent: `An interruption ended attempt ${event.interrupted.attempt - 1} of this call before it reported a result. The Tool has no readOnlyHint or idempotentHint, thus the Harness does not run it again. The model gets this error result and decides what to do.`,
            }),
          );
        card.append(
          el("h4", { textContent: "Result" }),
          el("pre", {
            textContent: event.content.map((block) => block.text ?? `Loaded the Tool ${block.name}.`).join("\n"),
          }),
        );
        if (event.structuredContent !== undefined)
          card.append(
            el("h4", { textContent: "Structured result" }),
            el("pre", { textContent: json(event.structuredContent) }),
          );
        // A finished call gives its id back, because a Provider can use the same id in a later Step.
        tools.delete(event.id);
        refreshSoon();
        break;
      }
      case "tools.loaded":
        add(
          el("p", {
            className: "outcome",
            textContent: event.skill
              ? `The Skill ${event.skill.name} is active. The model now has its body and these Tools: ${event.names.join(", ") || "none"}.`
              : `The model loaded these deferred Tools: ${event.names.join(", ")}.`,
          }),
        );
        break;
      case "approval.requested": {
        // A `continue` Approval belongs to the Turn, thus it has no Tool card of its own.
        if (event.kind === "continue") {
          waiting += 1;
          add(continueCard(event, ask));
          break;
        }
        if (event.kind === "connect") {
          waiting += 1;
          connectAsk(toolCard(event.id, event.tool, undefined), event, ask).scrollIntoView({ block: "nearest" });
          break;
        }
        if (event.kind !== "tool") break;
        // A child has its own call ids, thus the card of a child Approval is keyed by the child too.
        const card = toolCard(event.child ? `${event.child.threadId}:${event.id}` : event.id, event.tool, event.input);
        const answer = (decision) => ask(event.seq, decision);
        waiting += 1;
        card.id = `approval-${event.seq}`;
        card.open = true;
        card.classList.add("approval", "waiting");
        card.state.textContent = event.child ? "needs your Approval, for the child" : "needs your Approval";
        if (event.child)
          card
            .querySelector("summary > span")
            .replaceChildren("Tool call of the child Thread: ", el("code", { textContent: event.tool }));
        card.append(
          el(
            "div",
            { className: "ask" },
            el("strong", {
              textContent: event.child
                ? `The child Agent wants to call ${event.tool}. Do you allow it? The answer goes down to the child Thread.`
                : `The Agent wants to call ${event.tool}. Do you allow it?`,
            }),
            el(
              "div",
              { className: "row" },
              el("button", { className: "primary", textContent: "Allow", onclick: answer("allow") }),
              el("button", { textContent: "Deny", onclick: answer("deny") }),
            ),
          ),
        );
        card.scrollIntoView({ block: "nearest" });
        break;
      }
      case "approval.resolved": {
        const card = $(`approval-${event.request}`);
        if (!card) break;
        waiting -= 1;
        card.classList.remove("waiting");
        const connect = event.kind === "connect";
        card.state.textContent =
          event.decision === "allow" ? (connect ? "connected, running" : "allowed, running") : "denied";
        card.querySelector(".ask").replaceWith(
          !connect
            ? el("p", { className: "outcome", textContent: `Approval outcome: ${event.decision} (${event.source})` })
            : event.decision === "allow"
              ? el("p", {
                  className: "outcome",
                  textContent: "OAuth is complete. The call runs again, one time, with the grant of the User.",
                })
              : el(
                  "p",
                  { className: "outcome" },
                  "The Connection was not granted: ",
                  el("code", { textContent: event.reason ?? event.source }),
                  ". The call gets an error result.",
                ),
        );
        refreshSoon();
        break;
      }
      case "turn.paused":
        parked = event.reason;
        const line =
          event.reason === "job" && children.size > 0
            ? "The Turn is parked. It waits for the child Thread and uses no Worker time."
            : PARKED[event.reason]?.line;
        if (line) add(el("p", { className: "outcome", textContent: line }));
        refreshSoon();
        break;
      case "turn.resumed":
        parked = undefined;
        if (event.reason === "job")
          add(
            el("p", {
              className: "outcome",
              textContent:
                children.size > 0
                  ? "The child answered. The Turn continues with its answer as the Tool result."
                  : "The Job reported its outcome. The Turn continues.",
            }),
          );
        if (event.reason === "recovered")
          add(
            el("p", {
              className: "outcome",
              textContent:
                "The Thread recovered the Turn from its event log after an interruption. Each Tool result in the log stays. The Step that did not finish runs again.",
            }),
          );
        refreshSoon();
        break;
      case "job.started":
        if (children.size > 0) break;
        add(
          el(
            "p",
            { className: "outcome" },
            "The Tool gave the call to the Job ",
            el("code", { textContent: event.jobId }),
            ". The tool Step waits for the outcome of the Job.",
          ),
        );
        break;
      case "job.progress":
      case "job.cancelled":
        refreshSoon();
        break;
      case "turn.completed":
      case "turn.failed":
        parked = undefined;
        compacting = false;
        if (event.type === "turn.completed" && event.stopReason === "budget")
          add(
            el("p", {
              className: "outcome",
              textContent: "The Turn ended on its budget. The continuation Approval got no allow.",
            }),
          );
        if (event.type === "turn.failed")
          add(
            el("p", {
              className: event.reason === "cancelled" ? "outcome" : "error",
              textContent:
                event.reason === "cancelled"
                  ? "You cancelled the Turn. The Framework cannot undo an action that a Tool finished in another system."
                  : event.reason === "recovery"
                    ? `The Turn failed: ${event.message} Each Step has three attempts.`
                    : event.reason === "credential.missing"
                      ? `The Turn failed: ${event.message} The profile has no fallback to run on.`
                      : `The Turn failed: ${event.message} Check the model name and the credential that you gave to pnpm setup.`,
            }),
          );
        busy = false;
        refreshSoon();
        break;
    }
    sync();
  };

  // Offers each Thread that the composer can send to. It returns true when the selected Thread is no longer offered,
  // thus the composer moved to the current Thread of the same Scope, or to the first Thread.
  const syncTarget = () => {
    if (!target) return false;
    const options = TARGETS[scenario.id](state);
    target.replaceChildren(
      ...options.map((option) => el("option", { value: option.threadKey, textContent: option.label })),
    );
    const moved = !options.some((option) => option.threadKey === threadKey);
    if (moved) {
      const next = options.find((option) => option.scope === scopeId) ?? options[0];
      threadKey = next.threadKey;
      scopeId = next.scope;
    }
    target.value = threadKey;
    return moved;
  };
  if (target)
    target.onchange = () => {
      threadKey = target.value;
      scopeId = TARGETS[scenario.id](state).find((option) => option.threadKey === threadKey)?.scope;
      showThread();
    };
  const listen = () => {
    // A reconnect timer can fire after the operator opened a different view. The stream is then of that view.
    if (mine !== view) return;
    stream?.close();
    if (!attached) return;
    const query = [`after=${lastSeq}`, `token=${encodeURIComponent(token)}`];
    // The Schedules scenario detaches its Subscriber. The Thread learns of a closed WebSocket at once. It can learn of
    // a closed SSE stream much later, and offline delivery stays off until then.
    if (scenario.id !== "schedules" && transport === "sse") stream = new EventSource(threadRoute("/events", ...query));
    else {
      const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}${threadRoute("", ...query)}`);
      // A WebSocket does not connect again on its own. Close code 4004 tells that the Thread no longer exists. A
      // close that the page asked for, for example on a reset, also fires this handler. The timer thus checks again
      // that the socket is still the stream of the page and that the operator is still in this view.
      socket.onclose = (closed) => {
        if (stream !== socket || !attached || mine !== view || closed.code === 4004) return;
        setTimeout(() => stream === socket && mine === view && listen(), 1000);
      };
      stream = socket;
    }
    // A socket also carries the ack and error frames that answer a frame of the page. Only an event has a seq.
    stream.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (Number.isInteger(data.seq)) onEvent(data);
      else showReply(data);
    };
  };
  const showReply = (reply) => {
    frameReply = reply;
    if (reply.type === "error") {
      busy = false;
      add(el("p", { className: "error", textContent: `The socket refused the frame: ${reply.error.message}` }));
    }
    showPanel();
    sync();
  };
  const setAttached = (next) => {
    if (next && !attached) {
      replayFrom = lastSeq;
      replayLine.hidden = false;
      replayLine.textContent = `Connected again with after=${lastSeq}. No event after it arrived yet.`;
    }
    attached = next;
    showPanel();
    listen();
  };
  // The inbox changes without a Thread event, and a detached page gets no event. Thus this scenario reads the new
  // events and its state on a timer. A plain read of the event log is no Subscriber.
  if (scenario.id === "schedules") {
    const timer = setInterval(async () => {
      if (mine !== view) return clearInterval(timer);
      try {
        const key = threadKey;
        const missed = attached ? [] : await api("GET", threadRoute("/events", `after=${lastSeq}`));
        if (mine !== view || key !== threadKey || attached) return;
        for (const event of missed) if (event.seq > lastSeq) onEvent(event);
      } catch {
        // The next tick reads the same events again.
      } finally {
        if (mine === view) refreshSoon();
      }
    }, 2000);
  }
  syncTarget();
  listen();
  reset.disabled = false;
  sync();

  /**
   * Sends the prompt as a Turn input. `steer` adds it to the Turn that runs or is parked now. Without `steer`, an
   * input that arrives during a Turn waits for the next one, thus the page shows `note` at once.
   */
  const sendInput = async ({ steer: joins = false, note } = {}) => {
    const text = prompt.value.trim();
    if (!text) return prompt.focus();
    const running = busy;
    busy = true;
    sync();
    try {
      const socket = transport === "websocket" && stream instanceof WebSocket ? await opened(stream) : undefined;
      if (socket) {
        // The transports scenario sends the Turn on the socket of the Thread. The ack frame shows in the side column.
        socket.send(
          JSON.stringify({
            id: ++frameId,
            type: "send",
            input: { kind: "message", parts: [{ type: "text", text }] },
            steer: joins,
          }),
        );
      } else if (file?.files[0]) {
        const form = new FormData();
        form.append("text", text);
        form.append("file", file.files[0]);
        await api("POST", threadRoute("/turns"), form);
        setFile();
      } else
        await api("POST", threadRoute("/turns"), {
          kind: "message",
          parts: [{ type: "text", text }],
          steer: joins,
          // The Schedules scenario names its Deliverer on each input, thus a detached page gets offline delivery.
          ...(state.channelRef && { channelRef: state.channelRef }),
        });
      prompt.value = "";
      if (note && running) add(el("p", { className: "outcome", textContent: note }));
    } catch (error) {
      busy = running;
      add(el("p", { className: "error", textContent: String(error.message) }));
    }
    sync();
  };
  run.onclick = () => sendInput();
  if (steer) steer.onclick = () => sendInput({ steer: true });
  if (queue)
    queue.onclick = () =>
      sendInput({ note: "The input waits for the next Turn, because a Thread runs one Turn at a time." });
  if (stop)
    stop.onclick = async () => {
      stop.disabled = true;
      try {
        await api("POST", threadRoute("/cancel"));
      } catch (error) {
        add(el("p", { className: "error", textContent: String(error.message) }));
      } finally {
        sync();
      }
    };
  prompt.onkeydown = (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !run.disabled) run.click();
  };
  reset.onclick = async () => {
    // Run stays off until the new Thread exists, because the old Thread no longer accepts a Turn.
    const running = busy;
    busy = reset.disabled = true;
    sync();
    stream?.close();
    let next;
    try {
      next = await api("POST", `${path}/reset`);
    } catch (error) {
      // A refused reset changes nothing. The Knowledge scenario refuses one while a bulk ingest Job is pending.
      if (mine !== view) return;
      busy = running;
      add(el("p", { className: "error", textContent: `The reset was refused. ${error.message}` }));
      listen();
      return;
    } finally {
      reset.disabled = false;
    }
    if (mine === view) restart(next);
  };
  // Shows a new Thread of the scenario with an empty conversation.
  const restart = (next) => {
    stream?.close();
    state = next;
    threadKey = state.threadKey;
    scopeId = state.scopeId;
    if (file) setFile();
    syncTarget();
    showThread();
  };
  // Shows the Thread of `threadKey` from its first event.
  const showThread = () => {
    closeStreams();
    steps.replaceChildren();
    log.replaceChildren();
    tools.clear();
    children.clear();
    scripts.clear();
    logCount.textContent = "0";
    lastSeq = 0;
    seqLine.textContent = "0";
    replayFrom = undefined;
    replayLine.hidden = true;
    frameReply = undefined;
    live = undefined;
    busy = false;
    waiting = 0;
    parked = undefined;
    prompt.value = scenario.prompts[0].text;
    showPanel();
    listen();
    sync();
  };
}

void start();
