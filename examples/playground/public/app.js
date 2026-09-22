// The browser side of the Playground. It uses the Thread routes of @karmi/http and the routes below /api.
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "karmi-playground-token";

let token = new URLSearchParams(location.hash.slice(1)).get("token") ?? localStorage.getItem(TOKEN_KEY);
let playground;
let stream;
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

function showGate(message = "") {
  stream?.close();
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
  stream?.close();
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
  else if (scenario?.built) void renderScenario(scenario);
  else if (scenario) $("main").replaceChildren(intro(scenario));
}

function intro(scenario, ...actions) {
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
    ...scenario.modelNotes.map((note) => el("p", { className: "note", textContent: note })),
    scenario.prerequisites.length > 0 &&
      el(
        "div",
        { className: "card" },
        el("h3", { textContent: "Prerequisites" }),
        el("ul", {}, ...scenario.prerequisites.map((text) => el("li", { textContent: text }))),
      ),
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
    el(
      "div",
      { className: "table" },
      el(
        "table",
        {},
        el(
          "tr",
          {},
          ...["Feature", "Scenario", "What you see", "Verification"].map((text) => el("th", { textContent: text })),
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
  scope_suspended: { waits: "the Scope" },
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

function forkCards({ original, fork, positions }, onChanged, isCurrent) {
  const threadCard = (id, title, thread) => {
    const media = thread.media ?? [];
    return el(
      "div",
      { className: "card titled", id },
      el("h3", {}, title, badge(thread.deleted ? "deleted" : thread.status.state)),
      rows(["Thread key", el("code", { textContent: thread.threadKey })], ["Events", `${thread.events.length} events`]),
      media.length > 0
        ? el(
            "ul",
            {},
            ...media.map((item) =>
              el(
                "li",
                {},
                item.name ?? item.id,
                " ",
                el("code", { textContent: `${item.mimeType}, ${item.bytes} bytes` }),
                !thread.deleted &&
                  el("a", {
                    href: `/api/scenarios/forks/threads/${encodeURIComponent(thread.threadKey)}/media/${encodeURIComponent(item.id)}?token=${encodeURIComponent(token)}`,
                    download: item.name ?? item.id,
                    textContent: `Download ${item.name ?? item.id}`,
                  }),
              ),
            ),
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

// The cards next to the conversation, by scenario id.
const PANELS = {
  refund: (state) => [orderCard(state.order)],
  agents: specCards,
  stockroom: stockCards,
  turns: dispatchCards,
  forks: forkCards,
  schedules: scheduleCards,
  compaction: ledgerCards,
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
  // The composer of a scenario that compares Threads selects the Thread that receives the Turn.
  const target =
    scenario.id === "forks" ? el("select", { id: "target", ariaLabel: "Thread that receives the Turn" }) : null;
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
          el("div", { className: "row" }, run, target, status),
          controls.length > 0 && el("div", { className: "row" }, ...controls),
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
  // The Thread that the conversation shows and that receives each Turn.
  let threadKey = state.threadKey;
  let shownPanel;
  // False while the page holds no stream of the Thread. Only the Schedules scenario detaches its Subscriber.
  let attached = true;
  // The `seq` of the newest event that the page has, thus a new stream or a plain read starts after it.
  let lastSeq = 0;
  const showPanel = () => {
    // The key is part of the comparison, because a card can act on the Thread, and a reset starts a new one.
    const next = JSON.stringify({ state, attached });
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
          if (syncTarget()) showThread();
        }
        $("panel").append(el("p", { id: "saved", className: "outcome", textContent: note }));
      },
      () => mine === view,
      { attached, toggle: () => setAttached(!attached) },
    );
    if (shownPanel !== undefined) cards[0].classList.add("changed");
    shownPanel = next;
    $("panel").replaceChildren(...cards);
  };
  const refreshPanel = async () => {
    const next = await api("GET", path);
    if (mine !== view) return;
    state = next;
    showPanel();
  };
  showPanel();
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
        : parked
          ? `The Turn is parked. It waits for ${PARKED[parked]?.waits ?? parked}.`
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
  const toolCard = (id, name, input) => {
    let card = tools.get(id);
    if (card) return card;
    const label = el("span", { className: "state", textContent: "running" });
    card = add(
      el(
        "details",
        { className: "tool" },
        el("summary", {}, el("span", {}, "Tool call: ", el("code", { textContent: name })), label),
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

  // Answers one Approval. The card turns its buttons off, because the Thread rejects a second answer.
  const ask = (seq, decision) => async (click) => {
    click.target
      .closest(".approval")
      .querySelectorAll("button")
      .forEach((button) => (button.disabled = true));
    await api("POST", `/threads/${threadKey}/approvals/${seq}`, { decision, by: "operator" });
  };

  // True from the start of a compact Step until its thread.compacted event. A Step without one dropped nothing.
  let compacting = false;
  const onEvent = (event) => {
    // A stream that connects again after a restart of the dev server can repeat an event.
    if (Number.isInteger(event.seq)) {
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
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
      case "step.started":
        if (event.kind === "compact") {
          compacting = true;
          add(
            el("p", {
              className: "outcome",
              textContent: `${COMPACTION_TRIGGERS[event.trigger] ?? "The Harness compacts the Thread."} A compact Step runs before the model Step.`,
            }),
          );
        } else if (event.attempt > 1)
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
        toolCard(event.id, event.name, event.input);
        break;
      case "tool.result": {
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
        if (event.kind !== "tool") break;
        const card = toolCard(event.id, event.tool, event.input);
        const answer = (decision) => ask(event.seq, decision);
        waiting += 1;
        card.id = `approval-${event.seq}`;
        card.open = true;
        card.classList.add("approval", "waiting");
        card.state.textContent = "needs your Approval";
        card.append(
          el(
            "div",
            { className: "ask" },
            el("strong", { textContent: `The Agent wants to call ${event.tool}. Do you allow it?` }),
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
        card.state.textContent = event.decision === "allow" ? "allowed, running" : "denied";
        card
          .querySelector(".ask")
          .replaceWith(
            el("p", { className: "outcome", textContent: `Approval outcome: ${event.decision} (${event.source})` }),
          );
        break;
      }
      case "turn.paused":
        parked = event.reason;
        const line = PARKED[event.reason]?.line;
        if (line) add(el("p", { className: "outcome", textContent: line }));
        refreshSoon();
        break;
      case "turn.resumed":
        parked = undefined;
        if (event.reason === "job")
          add(el("p", { className: "outcome", textContent: "The Job reported its outcome. The Turn continues." }));
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
      case "turn.completed":
      case "turn.failed":
        parked = undefined;
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
                    : `The Turn failed: ${event.message} Check the model name and the credential that you gave to pnpm setup.`,
            }),
          );
        busy = false;
        refreshSoon();
        break;
    }
    sync();
  };

  // Offers each Thread of the scenario that exists. It returns true when the selected Thread no longer exists, thus
  // the composer moved to the first Thread that does.
  const syncTarget = () => {
    if (!target) return false;
    const threads = [
      !state.original.deleted && ["Original Thread", state.original],
      state.fork && ["Fork Thread", state.fork],
    ];
    const open = threads.filter(Boolean);
    target.replaceChildren(
      ...open.map(([label, thread]) => el("option", { value: thread.threadKey, textContent: `Send to the ${label}` })),
    );
    const moved = !open.some(([, thread]) => thread.threadKey === threadKey);
    if (moved) threadKey = open[0][1].threadKey;
    target.value = threadKey;
    return moved;
  };
  if (target)
    target.onchange = () => {
      threadKey = target.value;
      showThread();
    };
  const listen = () => {
    stream?.close();
    if (!attached) return;
    const query = `after=${lastSeq}&token=${encodeURIComponent(token)}`;
    // The Schedules scenario detaches its Subscriber. The Thread learns of a closed WebSocket at once. It can learn of
    // a closed SSE stream much later, and offline delivery stays off until then.
    if (scenario.id !== "schedules") stream = new EventSource(`/threads/${threadKey}/events?${query}`);
    else {
      const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/threads/${threadKey}?${query}`);
      // A WebSocket does not connect again on its own. Close code 4004 tells that the Thread no longer exists.
      socket.onclose = (closed) => {
        if (stream === socket && attached && mine === view && closed.code !== 4004) setTimeout(listen, 1000);
      };
      stream = socket;
    }
    stream.onmessage = (message) => onEvent(JSON.parse(message.data));
  };
  const setAttached = (next) => {
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
        const missed = attached ? [] : await api("GET", `/threads/${key}/events?after=${lastSeq}`);
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
      if (file?.files[0]) {
        const form = new FormData();
        form.append("text", text);
        form.append("file", file.files[0]);
        await api("POST", `/threads/${threadKey}/turns`, form);
        setFile();
      } else
        await api("POST", `/threads/${threadKey}/turns`, {
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
        await api("POST", `/threads/${threadKey}/cancel`);
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
    busy = reset.disabled = true;
    sync();
    stream?.close();
    let next;
    try {
      next = await api("POST", `${path}/reset`);
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
    if (file) setFile();
    syncTarget();
    showThread();
  };
  // Shows the Thread of `threadKey` from its first event.
  const showThread = () => {
    stream?.close();
    steps.replaceChildren();
    log.replaceChildren();
    tools.clear();
    logCount.textContent = "0";
    lastSeq = 0;
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
