// The browser side of the Playground. It uses the Thread routes of @karmi/http and the routes below /api.
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "karmi-playground-token";

let token = new URLSearchParams(location.hash.slice(1)).get("token") ?? localStorage.getItem(TOKEN_KEY);
let playground;
let stream;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== undefined && child !== null));
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
  $("app").hidden = true;
  $("gate").hidden = false;
  $("gate-error").textContent = message;
}

$("gate").addEventListener("submit", (event) => {
  event.preventDefault();
  token = $("token").value.trim();
  $("token").value = "";
  void start();
});
$("forget").addEventListener("click", () => showGate());
addEventListener("hashchange", () => playground && render());

async function start() {
  if (!token) return showGate();
  playground = await api("GET", "/api/playground");
  localStorage.setItem(TOKEN_KEY, token);
  if (location.hash.includes("token=")) history.replaceState(null, "", location.pathname);
  $("gate").hidden = true;
  $("app").hidden = false;
  const { provider } = playground;
  $("provider").textContent = provider
    ? `Provider: ${provider.label} · Model: ${provider.model}`
    : "No Provider is set up";
  render();
}

function render() {
  stream?.close();
  const current = location.hash.slice(1) || playground.scenarios[0].id;
  $("scenarios").replaceChildren(
    ...playground.scenarios.map((scenario) =>
      el(
        "li",
        {},
        el(
          "a",
          { href: `#${scenario.id}`, ...(scenario.id === current && { ariaCurrent: "page" }) },
          scenario.title,
          el("span", { className: `badge ${scenario.status}`, textContent: scenario.status }),
        ),
      ),
    ),
  );
  const scenario = playground.scenarios.find((item) => item.id === current);
  if (current === "coverage") renderCoverage();
  else if (scenario?.id === "refund") void renderRefund(scenario);
  else if (scenario) $("main").replaceChildren(...intro(scenario));
}

function intro(scenario) {
  return [
    el("h1", {}, scenario.title, el("span", { className: `badge ${scenario.status}`, textContent: scenario.status })),
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
  ].filter(Boolean);
}

function renderCoverage() {
  const title = (id) => playground.scenarios.find((scenario) => scenario.id === id)?.title;
  $("main").replaceChildren(
    el("h1", { textContent: "Feature coverage" }),
    el("p", { textContent: "Each row is a documented feature. A row without a scenario is not shown yet." }),
    el(
      "table",
      {},
      el(
        "tr",
        {},
        ...["Group", "Feature", "Scenario", "What you see", "Verification"].map((text) =>
          el("th", { textContent: text }),
        ),
      ),
      ...playground.coverage.map((row) =>
        el(
          "tr",
          {},
          el("td", { textContent: row.group }),
          el("td", { textContent: row.feature }),
          el(
            "td",
            {},
            row.scenario ? el("a", { href: `#${row.scenario}`, textContent: title(row.scenario) }) : "Not built yet",
          ),
          el("td", { textContent: row.observable ?? "" }),
          el("td", { textContent: row.verification ?? "" }),
        ),
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
    ["Status", order.status],
    order.refund && ["Refund", `$${order.refund.amount} (${order.refund.reason})`],
  ].filter(Boolean);
  return el(
    "div",
    { className: "card", id: "order" },
    el("h3", {}, "Order system", el("span", { className: "badge", textContent: "sample data" })),
    el(
      "dl",
      {},
      ...rows.flatMap(([name, value]) => [el("dt", { textContent: name }), el("dd", { textContent: value })]),
    ),
  );
}

async function renderRefund(scenario) {
  const ready = scenario.status === "ready";
  const prompt = el("textarea", { id: "prompt", value: scenario.prompt, ariaLabel: "Prompt" });
  const run = el("button", { id: "run", className: "primary", textContent: "Run", disabled: !ready });
  const reset = el("button", { id: "reset", textContent: "Reset scenario" });
  const steps = el("div", { id: "steps" });
  const log = el("div", { id: "log" });
  const logCount = el("span", { textContent: "0" });
  $("main").replaceChildren(
    ...intro(scenario),
    el("div", { id: "order" }),
    el("h2", { textContent: "Try it" }),
    prompt,
    el(
      "div",
      { className: "row" },
      run,
      reset,
      el("a", { href: scenario.code, target: "_blank", textContent: "Example code" }),
    ),
    steps,
    el("details", {}, el("summary", {}, "Event log (", logCount, " events)"), log),
  );

  let state = await api("GET", "/api/scenarios/refund");
  const showOrder = (order) => $("order").replaceWith(orderCard(order));
  showOrder(state.order);
  const refreshOrder = async () => showOrder((await api("GET", "/api/scenarios/refund")).order);

  let live;
  const onEvent = (event) => {
    logCount.textContent = String(Number(logCount.textContent) + 1);
    log.append(el("pre", { textContent: JSON.stringify(event) }));
    const json = (value) => JSON.stringify(value, null, 2);
    switch (event.type) {
      case "turn.started":
        run.disabled = true;
        steps.append(
          el("div", { className: "you" }, el("strong", { textContent: "You: " }), event.input.parts?.[0]?.text ?? ""),
        );
        break;
      case "message.delta":
        if (event.kind !== "text") break;
        live ??= steps.appendChild(
          el("div", { className: "agent" }, el("strong", { textContent: "Agent: " }), el("span")),
        );
        live.lastChild.textContent += event.text;
        break;
      case "message.part":
        if (event.block.type !== "text") break;
        live ??= steps.appendChild(
          el("div", { className: "agent" }, el("strong", { textContent: "Agent: " }), el("span")),
        );
        live.lastChild.textContent = event.block.text;
        live = undefined;
        break;
      case "tool.call":
        steps.append(
          el(
            "div",
            { className: "tool" },
            el("strong", { textContent: `Tool call: ${event.name}` }),
            el("pre", { textContent: json(event.input) }),
          ),
        );
        break;
      case "tool.result":
        steps.append(
          el(
            "div",
            { className: "tool" },
            el("strong", { textContent: `Tool result: ${event.name}${event.isError ? " (error)" : ""}` }),
            el("pre", { textContent: event.content.map((block) => block.text ?? "").join("\n") }),
          ),
        );
        void refreshOrder();
        break;
      case "approval.requested": {
        if (event.kind !== "tool") break;
        const answer = (decision) => async () => {
          card.querySelectorAll("button").forEach((button) => (button.disabled = true));
          await api("POST", `/threads/${state.threadKey}/approvals/${event.seq}`, { decision, by: "operator" });
        };
        const card = el(
          "div",
          { className: "approval", id: `approval-${event.seq}` },
          el("strong", { textContent: `Approval: the Agent wants to call ${event.tool}` }),
          el("pre", { textContent: json(event.input) }),
          el(
            "div",
            { className: "row" },
            el("button", { className: "primary", textContent: "Allow", onclick: answer("allow") }),
            el("button", { textContent: "Deny", onclick: answer("deny") }),
          ),
        );
        steps.append(card);
        break;
      }
      case "approval.resolved": {
        const card = $(`approval-${event.request}`);
        card
          ?.querySelector(".row")
          ?.replaceWith(
            el("p", { className: "outcome", textContent: `Approval outcome: ${event.decision} (${event.source})` }),
          );
        break;
      }
      case "turn.completed":
      case "turn.failed":
        if (event.type === "turn.failed")
          steps.append(
            el("p", {
              className: "error",
              textContent: `The Turn failed: ${event.message} Check the model name and the credential that you gave to pnpm setup.`,
            }),
          );
        run.disabled = !ready;
        void refreshOrder();
        break;
    }
  };

  const listen = () => {
    stream?.close();
    stream = new EventSource(`/threads/${state.threadKey}/events?after=0&token=${encodeURIComponent(token)}`);
    stream.onmessage = (message) => onEvent(JSON.parse(message.data));
  };
  listen();

  run.onclick = async () => {
    run.disabled = true;
    try {
      await api("POST", `/threads/${state.threadKey}/turns`, {
        kind: "message",
        parts: [{ type: "text", text: prompt.value }],
      });
    } catch (error) {
      steps.append(el("p", { className: "error", textContent: String(error.message) }));
      run.disabled = !ready;
    }
  };
  reset.onclick = async () => {
    // Run stays off until the new Thread exists, because the old Thread no longer accepts a Turn.
    run.disabled = reset.disabled = true;
    stream?.close();
    state = await api("POST", "/api/scenarios/refund/reset");
    steps.replaceChildren();
    log.replaceChildren();
    logCount.textContent = "0";
    live = undefined;
    prompt.value = scenario.prompt;
    run.disabled = !ready;
    reset.disabled = false;
    showOrder(state.order);
    listen();
  };
}

void start();
