(function () {
  "use strict";

  const U = window.DashboardUtils;
  const REFRESH_MS = 30000;
  const MS_PER_MINUTE = 60000;

  const state = {
    incidents: [],
    priorities: [],
    status: "all",
    priorityId: "",
    search: "",
    loaded: false,
    error: null,
    lastUpdated: null,
  };

  let loading = false;
  let refreshTimer = null;
  let detailRequestId = 0; // lets a newer details request win over a slower older one

  const $ = (id) => document.getElementById(id);

  // Small DOM builder. Text always goes in via text nodes (never innerHTML),
  // because incident titles and names are user-supplied.
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") node.className = value;
        else if (typeof value === "function") node.addEventListener(key.replace(/^on/, ""), value);
        else node.setAttribute(key, value === true ? "" : value);
      }
    }
    children.flat().forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  // "P3 - Medium" -> "P3"
  const shortPriority = (name) => String(name || "").split(" ")[0];

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---------- Data ----------

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body && body.error && body.error.message) message = body.error.message;
      } catch (_) {
        /* keep the generic message */
      }
      throw new Error(message);
    }
    return res.json();
  }

  async function load() {
    if (loading) return;
    loading = true;
    $("refreshBtn").disabled = true;
    try {
      const [incidents, priorities] = await Promise.all([
        fetchJson("/api/incidents"),
        state.priorities.length ? Promise.resolve(state.priorities) : fetchJson("/api/priorities"),
      ]);
      state.incidents = incidents;
      state.priorities = priorities;
      state.error = null;
      state.loaded = true;
      state.lastUpdated = new Date();
    } catch (err) {
      state.error = err.message || "Could not load incidents";
    } finally {
      loading = false;
      $("refreshBtn").disabled = false;
      render();
    }
  }

  function scheduleRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = null;
    if ($("autoRefresh").checked) {
      // Skip ticks while the tab is hidden; the visibilitychange handler
      // below refreshes as soon as the user comes back.
      refreshTimer = setInterval(() => {
        if (!document.hidden) load();
      }, REFRESH_MS);
    }
  }

  // ---------- Rendering ----------

  function render() {
    // Chips and rows are rebuilt on every render (including the periodic
    // auto-refresh), which would drop keyboard focus. Remember which one had
    // it and put it back afterwards.
    const active = document.activeElement;
    const focusKey = active && active.getAttribute ? active.getAttribute("data-focus-key") : null;

    renderSummary();
    renderLegend();
    renderPriorityOptions();
    renderStatusChips();
    renderResults();
    $("lastUpdated").textContent = state.lastUpdated
      ? `Updated ${state.lastUpdated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`
      : "";

    if (focusKey) {
      const target = Array.from(document.querySelectorAll("[data-focus-key]")).find(
        (n) => n.getAttribute("data-focus-key") === focusKey
      );
      if (target) target.focus();
    }
  }

  function renderSummary() {
    const box = $("summary");
    clear(box);
    if (!state.loaded) return;
    const s = U.summarize(state.incidents);

    const card = (label, value, cls) =>
      el("div", { class: `card ${cls}` }, el("div", { class: "value" }, value), el("div", { class: "label" }, label));

    box.append(
      card("Open incidents", s.open, "neutral"),
      card("Critical (P1) open", s.criticalOpen, s.criticalOpen ? "alert" : "neutral"),
      card("SLA breached", s.overdue, s.overdue ? "alert" : "neutral"),
      card("Unassigned", s.unassigned, "neutral")
    );
  }

  function renderLegend() {
    const box = $("legend");
    clear(box);
    state.priorities.forEach((p) => {
      box.append(
        el(
          "span",
          { class: "legend-item" },
          el("span", { class: `badge prio-badge ${U.priorityClass(p.level)}` }, p.name),
          el("span", { class: "legend-note" }, `resolve within ${U.formatDuration(p.sla_resolution_mins * MS_PER_MINUTE)}`)
        )
      );
    });
  }

  function renderPriorityOptions() {
    const select = $("priorityFilter");
    const wanted = state.priorities.map((p) => p.id).join(",");
    if (select.dataset.built === wanted) return;
    clear(select);
    select.append(el("option", { value: "" }, "All priorities"));
    state.priorities.forEach((p) => select.append(el("option", { value: p.id }, p.name)));
    select.value = state.priorityId;
    select.dataset.built = wanted;
  }

  function renderStatusChips() {
    const box = $("statusFilters");
    clear(box);
    // Counts follow the priority + search filters, so each chip shows what
    // you'd get by clicking it.
    const base = U.filterIncidents(state.incidents, {
      status: "all",
      priorityId: state.priorityId,
      search: state.search,
    });
    const counts = U.countByStatus(base);

    const chip = (value, label) =>
      el(
        "button",
        {
          type: "button",
          class: "chip",
          "data-focus-key": `chip:${value}`,
          "aria-pressed": String(state.status === value),
          onclick: () => {
            state.status = value;
            render();
          },
        },
        label,
        el("span", { class: "count" }, counts[value] || 0)
      );

    box.append(chip("all", "All"));
    U.STATUS_ORDER.forEach((s) => box.append(chip(s, U.statusLabel(s))));
  }

  function hasActiveFilters() {
    return state.status !== "all" || state.priorityId !== "" || state.search.trim() !== "";
  }

  function renderResults() {
    const message = $("stateMessage");
    const wrap = $("tableWrap");
    const rows = $("incidentRows");
    clear(message);
    clear(rows);

    if (!state.loaded && !state.error) {
      wrap.hidden = true;
      $("resultCount").textContent = "";
      message.append(el("div", { class: "message", "aria-busy": "true" }, "Loading incidents…"));
      return;
    }

    if (state.error && !state.loaded) {
      wrap.hidden = true;
      $("resultCount").textContent = "";
      message.append(
        el(
          "div",
          { class: "message error", role: "alert" },
          el("strong", null, "Couldn't load incidents"),
          state.error,
          el("div", null, el("button", { type: "button", class: "btn", onclick: load }, "Try again"))
        )
      );
      return;
    }

    if (state.error) {
      message.append(el("div", { class: "banner", role: "alert" }, `Couldn't refresh: ${state.error}. Showing the last data loaded.`));
    }

    const filtered = U.sortIncidents(
      U.filterIncidents(state.incidents, {
        status: state.status,
        priorityId: state.priorityId,
        search: state.search,
      })
    );

    $("resultCount").textContent = `Showing ${filtered.length} of ${state.incidents.length} incidents`;

    if (filtered.length === 0) {
      wrap.hidden = true;
      if (state.incidents.length === 0) {
        message.append(
          el(
            "div",
            { class: "message" },
            el("strong", null, "No incidents yet"),
            "Create one with POST /api/incidents, or load sample data with npm run db:demo."
          )
        );
      } else {
        message.append(
          el(
            "div",
            { class: "message" },
            el("strong", null, "No incidents match these filters"),
            hasActiveFilters() ? el("button", { type: "button", class: "btn", onclick: clearFilters }, "Clear filters") : null
          )
        );
      }
      return;
    }

    wrap.hidden = false;
    const now = new Date();
    filtered.forEach((i) => rows.append(renderRow(i, now)));
  }

  function renderRow(i, now) {
    const prio = U.priorityClass(i.priority_level);
    const due = U.dueInfo(i, now);

    return el(
      "tr",
      { class: `row ${prio}` },
      el(
        "td",
        { "data-label": "Priority" },
        el(
          "span",
          { class: "prio-cell" },
          el("span", { class: `badge prio-badge ${prio}` }, i.priority_name || "Unknown"),
          i.escalation_count > 0
            ? el(
                "span",
                {
                  class: "escalated-tag",
                  title: `Escalated ${i.escalation_count} time(s). Started as ${i.original_priority_name}.`,
                },
                `↑ from ${shortPriority(i.original_priority_name)}`
              )
            : null
        )
      ),
      el(
        "td",
        { class: "cell-title", "data-label": "Incident" },
        el(
          "button",
          { type: "button", class: "link-btn", "data-focus-key": `row:${i.id}`, onclick: () => openDetails(i.id) },
          i.title
        ),
        el("div", { class: "muted small" }, i.category_name || "Uncategorized")
      ),
      el("td", { "data-label": "Status" }, el("span", { class: `badge status-badge status-${i.status}` }, U.statusLabel(i.status))),
      el("td", { "data-label": "Assignee" }, i.assignee_name || el("span", { class: "muted" }, "Unassigned")),
      el("td", { "data-label": "SLA" }, el("span", { class: `due due-${due.tone}` }, due.text)),
      el("td", { "data-label": "Created" }, U.formatDateTime(i.created_at))
    );
  }

  function clearFilters() {
    state.status = "all";
    state.priorityId = "";
    state.search = "";
    $("priorityFilter").value = "";
    $("search").value = "";
    render();
  }

  // ---------- Detail dialog ----------

  async function openDetails(id) {
    const requestId = ++detailRequestId;
    const dialog = $("detailDialog");
    const body = $("detailBody");
    $("detailTitle").textContent = "Incident";
    clear(body);
    body.append(el("p", { class: "muted" }, "Loading…"));
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }

    try {
      const i = await fetchJson(`/api/incidents/${encodeURIComponent(id)}`);
      if (requestId !== detailRequestId) return; // a newer details request replaced this one
      renderDetails(i);
    } catch (err) {
      if (requestId !== detailRequestId) return;
      clear(body);
      body.append(el("p", { class: "banner", role: "alert" }, err.message));
    }
  }

  // A list of events, or a muted message when there are none. `describe`
  // returns the pieces of text for one item.
  function renderTimeline(items, emptyText, describe) {
    if (!items || !items.length) return el("p", { class: "muted small" }, emptyText);
    return el("ol", { class: "timeline" }, items.map((item) => el("li", null, ...describe(item))));
  }

  function renderDetails(i) {
    const body = $("detailBody");
    const prio = U.priorityClass(i.priority_level);
    const due = U.dueInfo(i);
    const resp = U.responseInfo(i);
    const slaRes = i.sla && i.sla.resolution ? i.sla.resolution : null;
    clear(body);
    $("detailTitle").textContent = i.title;

    const fact = (label, value) => [el("dt", null, label), el("dd", null, value)];

    body.append(
      el(
        "div",
        { class: "badges" },
        el("span", { class: `badge prio-badge ${prio}` }, i.priority_name),
        el("span", { class: `badge status-badge status-${i.status}` }, U.statusLabel(i.status))
      ),
      i.description ? el("p", { class: "desc" }, i.description) : null,
      el(
        "dl",
        { class: "facts" },
        fact("Reporter", i.reporter_name || "—"),
        fact("Assignee", i.assignee_name || "Unassigned"),
        fact("Category", i.category_name || "—"),
        fact("Team", i.team_name || "—"),
        fact("Created", U.formatDateTime(i.created_at)),
        fact("Resolution due", U.formatDateTime(slaRes ? slaRes.due_at : i.due_at)),
        fact("Resolution SLA", el("span", { class: `due due-${due.tone}` }, due.text)),
        fact("Response SLA", el("span", { class: `due due-${resp.tone}` }, resp.text)),
        slaRes && slaRes.paused_ms > 0 ? fact("Time on hold", U.formatDuration(slaRes.paused_ms)) : null,
        fact("Resolved", U.formatDateTime(i.resolved_at)),
        fact("Closed", U.formatDateTime(i.closed_at))
      ),
      el("h3", null, "Assignment history"),
      renderTimeline(i.assignments, "Not assigned yet.", (a) => [
        `${a.assigned_to_name}`,
        a.assigned_by_name ? ` (assigned by ${a.assigned_by_name})` : "",
        ` · ${U.formatDateTime(a.assigned_at)}`,
        a.unassigned_at ? ` → until ${U.formatDateTime(a.unassigned_at)}` : " → current",
        a.reason ? ` · ${a.reason}` : "",
      ]),
      el("h3", null, "Status history"),
      renderTimeline(i.statusHistory, "No status changes recorded.", (h) => [
        h.from_status ? `${U.statusLabel(h.from_status)} → ${U.statusLabel(h.to_status)}` : `Created as ${U.statusLabel(h.to_status)}`,
        h.changed_by_name ? ` · ${h.changed_by_name}` : "",
        ` · ${U.formatDateTime(h.changed_at)}`,
        h.note ? ` · “${h.note}”` : "",
      ]),
      el("h3", null, "Escalation history"),
      renderTimeline(i.escalations, "Never escalated.", (e) => [
        `${e.from_priority_name} → ${e.to_priority_name}`,
        ` · ${e.escalated_by_name || "Automatic"}`,
        ` · ${U.formatDateTime(e.escalated_at)}`,
        e.reason ? ` · ${e.reason}` : "",
      ])
    );
  }

  // ---------- Wiring ----------

  $("refreshBtn").addEventListener("click", load);
  $("autoRefresh").addEventListener("change", scheduleRefresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && $("autoRefresh").checked) load();
  });
  $("clearFilters").addEventListener("click", clearFilters);
  $("priorityFilter").addEventListener("change", (e) => {
    state.priorityId = e.target.value;
    render();
  });
  $("search").addEventListener("input", (e) => {
    state.search = e.target.value;
    render();
  });
  $("closeDialog").addEventListener("click", () => $("detailDialog").close());
  // Click on the dimmed backdrop (the dialog element itself) closes it.
  $("detailDialog").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });

  render();
  load();
  scheduleRefresh();
})();