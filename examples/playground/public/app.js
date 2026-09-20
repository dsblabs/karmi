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
  const response = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (response.status === 401) {
    showGate("The Playground did not accept this token.");
    throw new Error("unauthorized");
  }
  if (!response.ok) throw new Error((await response.json()).error?.message ?? response.statusText);
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
  else if (scenario?.id === "refund") void renderRefund(scenario);
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

function orderCard(order) {
  const rows = [
    ["Order", order.id],
    ["Customer", order.customer],
    ["Item", order.item],
    ["Total", `$${order.total}`],
    order.refund && ["Refund", `$${order.refund.amount} (${order.refund.reason})`],
  ].filter(Boolean);
  return el(
    "div",
    { className: "card", id: "order" },
    el("h3", {}, "Order system", el("span", { className: `badge ${order.status}`, textContent: order.status })),
    el(
      "dl",
      {},
      ...rows.flatMap(([name, value]) => [el("dt", { textContent: name }), el("dd", { textContent: value })]),
    ),
    el("p", { className: "fine", textContent: "This is sample data. Reset restores it." }),
  );
}

async function renderRefund(scenario) {
  const mine = view;
  const ready = scenario.status === "ready";
  const prompt = el("textarea", {
    id: "prompt",
    value: scenario.prompt,
    ariaLabel: "Prompt",
    placeholder: "Write a message to the Agent.",
  });
  const run = el("button", { id: "run", className: "primary", textContent: "Run", disabled: true });
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
        el("div", { className: "composer" }, prompt, el("div", { className: "row" }, run, status)),
      ),
      el(
        "aside",
        { className: "side" },
        el("div", { className: "card", id: "order" }, el("p", { className: "muted", textContent: "Loading…" })),
        el("details", { className: "card events" }, el("summary", {}, "Event log (", logCount, " events)"), log),
      ),
    ),
  );

  let state = await api("GET", "/api/scenarios/refund");
  if (mine !== view) return;
  let shownOrder;
  const showOrder = (order) => {
    const next = JSON.stringify(order);
    if (next === shownOrder) return;
    const card = orderCard(order);
    if (shownOrder !== undefined) card.classList.add("changed");
    shownOrder = next;
    $("order").replaceWith(card);
  };
  showOrder(state.order);
  // One request covers a burst of events, for example the replay of the event log after a reload.
  let orderTimer;
  const refreshOrder = () => {
    clearTimeout(orderTimer);
    orderTimer = setTimeout(async () => {
      const { order } = await api("GET", "/api/scenarios/refund");
      if (mine === view) showOrder(order);
    }, 60);
  };

  let live;
  let busy = false;
  let waiting = 0;
  const typing = el("div", { className: "typing", textContent: "The Agent works" });
  const tools = new Map();
  const json = (value) => JSON.stringify(value, null, 2);
  const sync = () => {
    run.disabled = !ready || busy;
    status.textContent = !ready
      ? "This scenario cannot run with the current setup."
      : waiting > 0
        ? "The Agent waits for your decision."
        : busy
          ? "The Agent works…"
          : "Ctrl + Enter runs the prompt.";
    if (busy && waiting === 0 && !live) steps.append(typing);
    else typing.remove();
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
  const agentText = () =>
    (live ??= add(el("div", { className: "agent" }, el("strong", { textContent: "Agent" }), el("span"))));

  const onEvent = (event) => {
    logCount.textContent = String(Number(logCount.textContent) + 1);
    log.append(el("pre", { textContent: JSON.stringify(event) }));
    switch (event.type) {
      case "turn.started":
        busy = true;
        add(el("div", { className: "you" }, el("strong", { textContent: "You" }), event.input.parts?.[0]?.text ?? ""));
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
        card.state.textContent = event.isError ? "error" : "done";
        card.append(
          el("h4", { textContent: "Result" }),
          el("pre", { textContent: event.content.map((block) => block.text ?? "").join("\n") }),
        );
        // A finished call gives its id back, because a Provider can use the same id in a later Step.
        tools.delete(event.id);
        refreshOrder();
        break;
      }
      case "approval.requested": {
        if (event.kind !== "tool") break;
        const card = toolCard(event.id, event.tool, event.input);
        const answer = (decision) => async () => {
          card.querySelectorAll("button").forEach((button) => (button.disabled = true));
          await api("POST", `/threads/${state.threadKey}/approvals/${event.seq}`, { decision, by: "operator" });
        };
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
      case "turn.completed":
      case "turn.failed":
        if (event.type === "turn.failed")
          add(
            el("p", {
              className: "error",
              textContent: `The Turn failed: ${event.message} Check the model name and the credential that you gave to pnpm setup.`,
            }),
          );
        busy = false;
        refreshOrder();
        break;
    }
    sync();
  };

  const listen = () => {
    stream?.close();
    stream = new EventSource(`/threads/${state.threadKey}/events?after=0&token=${encodeURIComponent(token)}`);
    stream.onmessage = (message) => onEvent(JSON.parse(message.data));
  };
  listen();
  reset.disabled = false;
  sync();

  run.onclick = async () => {
    const text = prompt.value.trim();
    if (!text) return prompt.focus();
    busy = true;
    sync();
    try {
      await api("POST", `/threads/${state.threadKey}/turns`, { kind: "message", parts: [{ type: "text", text }] });
      prompt.value = "";
    } catch (error) {
      busy = false;
      add(el("p", { className: "error", textContent: String(error.message) }));
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
    try {
      state = await api("POST", "/api/scenarios/refund/reset");
    } finally {
      reset.disabled = false;
    }
    if (mine !== view) return;
    steps.replaceChildren();
    log.replaceChildren();
    tools.clear();
    logCount.textContent = "0";
    live = undefined;
    busy = false;
    waiting = 0;
    prompt.value = scenario.prompt;
    showOrder(state.order);
    listen();
    sync();
  };
}

void start();
