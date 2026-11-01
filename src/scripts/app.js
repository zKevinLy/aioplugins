import { DEFAULT_STREAM_FORMAT } from "../lib/default-stream-format";

const $ = (selector) => document.querySelector(selector);

    let user = null;
    let pendingUser = null;
    let state = new Map();
    let profiles = [];
    let streamFields = [];
    let activeView = "configure";
    let activeMiddlewareTab = "filters";
    let pluginUrl = "";
    let manifestPath = "";
    let isSaving = false;
    let formatterPreviewTimer = 0;
    let formatterPreviewRequest = 0;
    const defaultStreamFormat = DEFAULT_STREAM_FORMAT;
    const streamFormatPresets = {
      detailed: defaultStreamFormat,
      compact: "{stream.title}{? · {stream.resolution}?}{? · {stream.size::sbytes}?}",
      title: "{stream.title}"
    };

    const catalog = $("#catalog");
    const status = $("#status");
    const saveStatus = $("#save-status");
    const authStatus = $("#auth-status");
    const discoverButton = $("#discover");
    const applyButton = $("#apply");
    const goSaveButton = $("#go-save");
    const searchInput = $("#search");
    const pluginUrlButton = $("#plugin-url");
    const copyUrlButton = $("#copy-plugin-url");
    const copyFeedback = $("#copy-feedback");
    const manifestPreview = $("#manifest-preview");
    const outputState = $("#output-state");
    const middlewareSaveButton = $("#save-middleware");
    const copyrightYear = document.querySelector("#copyright-year");

    if (copyrightYear) {
      copyrightYear.textContent = new Date().getFullYear();
    }
    
    async function loadAppVersion() {
      try {
        const response = await fetch("/version.json", {
          cache: "no-store"
        });

        if (!response.ok) return;

        const data = await response.json();

        if (typeof data.version === "string" && data.version.trim()) {
          const badge = $("#app-version");
          badge.textContent = data.version;
          badge.hidden = false;
        }
      } catch {
        // Version information is optional.
      }
    }

    async function api(path, body, method) {
      const response = await fetch(path, {
        method: method || (body === undefined ? "GET" : "POST"),
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || `Request failed (${response.status})`);
      }

      return result;
    }

    function setStatus(message, kind = "") {
      const target = !user
        ? authStatus
        : activeView === "middleware"
          ? $("#middleware-status")
        : activeView === "account" || activeView === "save"
          ? saveStatus
          : status;

      target.textContent = message;
      target.className = `status ${kind}`;
    }

    async function copyText(text, onDone, onFail) {
      try {
        await navigator.clipboard.writeText(text);
        onDone();
      } catch {
        onFail();
      }
    }

    function showAuthTab(tab) {
      const login = tab === "login";
      $("#login-form").hidden = !login;
      $("#register-form").hidden = login;
      $("#login-tab").setAttribute("aria-selected", String(login));
      $("#register-tab").setAttribute("aria-selected", String(!login));
      authStatus.textContent = "";
    }

    function showView(view) {
      activeView = view;

      $("#configure-view").hidden = view !== "configure";
      $("#middleware-view").hidden = view !== "middleware";
      $("#save-view").hidden = view !== "save";
      $("#account-view").hidden = view !== "account";

      const navItems = {
        configure: "configure-tab",
        filters: "filters-tab",
        sorting: "sorting-tab",
        formatting: "formatting-tab",
        save: "save-tab",
        account: "account-nav"
      };
      const activeNav = view === "middleware" ? activeMiddlewareTab : view;

      Object.entries(navItems).forEach(([name, id]) => {
        const button = document.getElementById(id);
        const active = name === activeNav;

        button.classList.toggle("active", active);
        button.setAttribute("aria-current", active ? "page" : "false");
      });

      const pageContent = {
        configure: {
          title: "Choose your plugins",
          description: "Select plugin sources and choose the providers you want to use."
        },
        save: {
          title: "Review & install",
          description: "Check your selection, save your setup, and add it to Nuvio."
        },
        account: {
          title: "Account settings",
          description: "Manage your account and configuration backups."
        }
      };

      const middlewareContent = {
        filters: { title: "Filter streams", description: "Choose which provider results reach Nuvio." },
        sorting: { title: "Sort streams", description: "Choose the order of each provider's results." },
        formatting: { title: "Format stream details", description: "Surface stream metadata in displayed titles." }
      };
      const content = view === "middleware"
        ? middlewareContent[activeMiddlewareTab]
        : pageContent[view];

      $("#page-title").textContent = content.title;
      $("#page-description").textContent = content.description;

      if (view === "save") {
        renderReview();

        if (pluginUrl) {
          refreshManifestPreview().catch((error) => {
            setStatus(error.message, "error");
          });
        }
      }
    }

    function showMiddlewareTab(tab) {
      activeMiddlewareTab = tab;
      showView("middleware");

      document.querySelectorAll(".middleware-panel").forEach((panel) => {
        panel.hidden = panel.id !== `middleware-${tab}`;
      });
      document.querySelectorAll(".middleware-tab").forEach((button) => {
        const active = button.dataset.middlewareTab === tab;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      });
    }

    const filterOperatorOptions = {
      text: [
        ["contains", "Contains"], ["notContains", "Does not contain"],
        ["equals", "Equals"], ["notEquals", "Does not equal"],
        ["exists", "Has a value"], ["missing", "Is empty"]
      ],
      list: [
        ["contains", "Contains"], ["notContains", "Does not contain"],
        ["equals", "Equals"], ["notEquals", "Does not equal"],
        ["exists", "Has a value"], ["missing", "Is empty"]
      ],
      number: [
        ["equals", "Equals"], ["notEquals", "Does not equal"],
        ["gt", "Greater than"], ["gte", "At least"],
        ["lt", "Less than"], ["lte", "At most"],
        ["exists", "Has a value"], ["missing", "Is empty"]
      ],
      boolean: [
        ["isTrue", "Is true"], ["isFalse", "Is false"],
        ["exists", "Has a value"], ["missing", "Is empty"]
      ]
    };

    function populateFieldSelect(select, includeProviderOrder = false) {
      const options = [];
      if (includeProviderOrder) {
        options.push({ value: "", label: "Provider order" });
      }
      for (const field of streamFields) {
        options.push({ value: field.key, label: field.label });
      }
      select.replaceChildren(...options.map(({ value, label }) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }));
    }

    function operatorsForField(fieldKey) {
      const field = streamFields.find((entry) => entry.key === fieldKey);
      return filterOperatorOptions[field?.type] || filterOperatorOptions.text;
    }

    function readFilterRows(includeIncomplete = false) {
      return [...document.querySelectorAll(".filter-rule")].map((row) => ({
        field: row.querySelector(".filter-field").value,
        operator: row.querySelector(".filter-operator").value,
        value: row.querySelector(".filter-value").value.trim()
      })).filter((rule) =>
        includeIncomplete ||
        ["exists", "missing", "isTrue", "isFalse"].includes(rule.operator) ||
        Boolean(rule.value)
      );
    }

    function renderFilterRules(rules) {
      const container = $("#filter-rules");
      container.replaceChildren();
      if (!rules.length) {
        const empty = document.createElement("p");
        empty.className = "field-hint filter-empty";
        empty.textContent = "No filters added.";
        container.append(empty);
        return;
      }

      rules.forEach((rule, index) => {
        const row = document.createElement("div");
        row.className = "filter-rule";

        const field = document.createElement("select");
        field.className = "filter-field";
        populateFieldSelect(field);
        field.value = rule.field;

        const operator = document.createElement("select");
        operator.className = "filter-operator";
        const operators = operatorsForField(rule.field);
        for (const [value, label] of operators) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          operator.append(option);
        }
        operator.value = operators.some(([value]) => value === rule.operator)
          ? rule.operator
          : operators[0]?.[0] || "contains";

        const value = document.createElement("input");
        value.className = "filter-value";
        value.type = streamFields.find((entry) => entry.key === rule.field)?.type === "number"
          ? "number"
          : "text";
        value.step = "any";
        value.placeholder = "Value";
        value.value = rule.value || "";

        const updateValueVisibility = () => {
          const noValue = ["exists", "missing", "isTrue", "isFalse"].includes(operator.value);
          value.hidden = noValue;
          value.disabled = noValue;
        };
        updateValueVisibility();

        field.addEventListener("change", () => {
          const nextRules = readFilterRows(true);
          nextRules[index].field = field.value;
          const nextOperators = operatorsForField(field.value);
          if (!nextOperators.some(([value]) => value === nextRules[index].operator)) {
            nextRules[index].operator = nextOperators[0]?.[0] || "contains";
          }
          nextRules[index].value = "";
          renderFilterRules(nextRules);
        });
        operator.addEventListener("change", updateValueVisibility);

        const remove = document.createElement("button");
        remove.className = "button button-small filter-remove";
        remove.type = "button";
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", `Remove ${rule.field} filter`);
        remove.addEventListener("click", () => {
          const nextRules = readFilterRows(true);
          nextRules.splice(index, 1);
          renderFilterRules(nextRules);
        });

        row.append(field, operator, value, remove);
        container.append(row);
      });
    }

    function setMiddlewareSettings(value) {
      const settings = value && typeof value === "object" ? value : {};
      $("#stream-sort-field").value = settings.sortField || "";
      $("#stream-sort-direction").value = settings.sortDirection === "asc" ? "asc" : "desc";
      renderFilterRules(Array.isArray(settings.filters) ? settings.filters : []);
      $("#stream-format").value = typeof settings.format === "string" && settings.format.trim()
        ? settings.format
        : defaultStreamFormat;
      scheduleFormatterPreview();
    }

    function readMiddlewareSettings() {
      return {
        filters: readFilterRows().slice(0, 30),
        sortField: $("#stream-sort-field").value,
        sortDirection: $("#stream-sort-direction").value,
        format: $("#stream-format").value
      };
    }

    function scheduleFormatterPreview() {
      clearTimeout(formatterPreviewTimer);
      $("#formatter-preview-state").textContent = "Updating";
      $("#formatter-preview-state").className = "formatter-preview-state";
      formatterPreviewTimer = setTimeout(renderFormatterPreview, 180);
    }

    async function renderFormatterPreview() {
      const requestId = ++formatterPreviewRequest;
      const title = $("#formatter-preview-title");
      const state = $("#formatter-preview-state");

      try {
        const stream = JSON.parse($("#formatter-stream-data").value);
        const metadata = JSON.parse($("#formatter-metadata").value);
        if (!stream || typeof stream !== "object" || Array.isArray(stream)) {
          throw new Error("Stream data must be a JSON object.");
        }
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
          throw new Error("Metadata must be a JSON object.");
        }
        stream.filename = $("#formatter-filename").value.trim();

        const result = await api("/api/formatter/preview", {
          format: $("#stream-format").value,
          stream,
          metadata
        });
        if (requestId !== formatterPreviewRequest) return;

        title.textContent = result.title || "(empty output)";
        $("#formatter-parsed-fields").textContent = JSON.stringify(result.parsed, null, 2);
        state.textContent = "Updated";
        state.className = "formatter-preview-state ready";
      } catch (error) {
        if (requestId !== formatterPreviewRequest) return;
        title.textContent = "Preview unavailable";
        $("#formatter-parsed-fields").textContent = "{}";
        state.textContent = error.message;
        state.className = "formatter-preview-state error";
      }
    }

    function setUser(next) {
      user = next;
      state = new Map();

      const authed = Boolean(next);

      $("#auth-view").hidden = authed;
      $("#app-view").hidden = !authed;
      $("#session-bar").hidden = !authed;
      $("#server-state").hidden = authed;

      if (!authed) {
        for (const input of document.querySelectorAll("#auth-view input, #delete-password")) {
          input.value = "";
          if (input.type === "checkbox") input.checked = false;
        }

        pendingUser = null;
        $("#new-account").hidden = true;
        $("#auth-tabs").hidden = false;
        $("#continue").disabled = true;
        pluginUrl = "";
        manifestPath = "";
        showAuthTab("login");
        return;
      }

      $("#session-id").textContent = `${next.id.slice(0, 8)}…`;
      $("#account-uuid").textContent = next.id;

      manifestPath = next.installPath;
      pluginUrl = `${location.origin}${manifestPath}`;

      pluginUrlButton.textContent = pluginUrl;
      $("#open-manifest").href = manifestPath;
      copyUrlButton.disabled = false;

      showView("configure");
      loadProfilesList().then(() => restoreSelection());
    }

    async function enter(nextUser) {
      setUser(nextUser);
    }

    async function refreshManifestPreview() {
      if (!manifestPath) return;

      const response = await fetch(manifestPath, { cache: "no-store" });

      if (!response.ok) {
        throw new Error("Could not load the Nuvio manifest preview");
      }

      const manifest = await response.json();
      manifestPreview.textContent = JSON.stringify(manifest, null, 2);

      const pluginCount = manifest.scrapers?.length || 0;

      outputState.textContent = pluginCount === 1
        ? "1 plugin included"
        : `${pluginCount} plugins included`;

      outputState.classList.toggle("ready", pluginCount > 0);
    }

    function selectionCount() {
      return [...state.values()].reduce(
        (sum, source) => sum + source.selected.size,
        0
      );
    }

    function updateCounts() {
      const count = selectionCount();

      const label = count === 1 ? "1 plugin selected" : `${count} plugins selected`;

      $("#source-count").textContent = String(state.size);
      $("#selection-count").textContent = label;
      $("#review-count").textContent = label;

      applyButton.disabled = count === 0 || isSaving;
      middlewareSaveButton.disabled = count === 0 || isSaving;
      goSaveButton.disabled = count === 0;

      renderReview();
    }

    function renderReview() {
      const container = $("#review-selection");
      if (!container) return;

      container.replaceChildren();

      const selected = [];

      for (const source of state.values()) {
        for (const provider of source.providers) {
          if (source.selected.has(provider.id)) {
            selected.push({
              name: provider.name,
              id: provider.id,
              repository: source.repository,
              types: provider.types
            });
          }
        }
      }

      if (selected.length === 0) {
        const empty = document.createElement("p");
        empty.className = "view-intro";
        empty.textContent = "No plugins selected yet. Go back and choose some plugins.";
        container.append(empty);
        return;
      }

      const list = document.createElement("div");
      list.className = "review-list";

      for (const plugin of selected) {
        const row = document.createElement("div");
        row.className = "review-row";

        const details = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = plugin.name;

        const id = document.createElement("p");
        id.className = "provider-id";
        id.textContent = plugin.id;

        details.append(name, id);

        const type = document.createElement("span");
        type.className = "type-tag";
        type.textContent = plugin.types.length
          ? plugin.types.join(" · ")
          : "plugin";

        row.append(details, type);
        list.append(row);
      }

      container.append(list);
    }

    function render() {
      const query = searchInput.value.trim().toLowerCase();
      catalog.replaceChildren();

      if (state.size === 0) {
        catalog.className = "catalog-empty";

        const heading = document.createElement("strong");
        heading.textContent = "Loading your plugin sources...";

        const message = document.createElement("p");
        message.textContent = "Your suggested sources will appear here automatically.";

        catalog.append(heading, message);
        updateCounts();
        return;
      }

      catalog.className = "catalog-content";
      let visible = 0;

      for (const [key, source] of state) {
        const providers = source.providers.filter((provider) =>
          `${provider.name} ${provider.id} ${provider.description}`
            .toLowerCase()
            .includes(query)
        );

        if (providers.length === 0) continue;
        visible += providers.length;

        const group = document.createElement("section");
        group.className = "source-group";

        const titleRow = document.createElement("div");
        titleRow.className = "source-title";

        const titleWrap = document.createElement("div");
        const title = document.createElement("h3");

        const sourceLink = document.createElement("a");
        sourceLink.href = source.repository;
        sourceLink.target = "_blank";
        sourceLink.rel = "noopener noreferrer";
        sourceLink.textContent =
          new URL(source.repository).pathname.split("/").filter(Boolean).slice(-1)[0]
          || source.repository;
        title.append(sourceLink);

        const meta = document.createElement("p");
        meta.className = "source-meta";
        meta.textContent = `${source.ref} · ${source.commit.slice(0, 8)}`;

        titleWrap.append(title, meta);

        const actions = document.createElement("div");
        actions.className = "source-actions";

        const chooseAll = document.createElement("button");
        chooseAll.className = "button button-small";
        chooseAll.type = "button";
        chooseAll.textContent = "Select enabled";

        chooseAll.addEventListener("click", () => {
          for (const provider of source.providers) {
            if (provider.enabled && provider.types.length) {
              source.selected.add(provider.id);
            }
          }
          render();
        });

        const remove = document.createElement("button");
        remove.className = "button button-small";
        remove.type = "button";
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", `Remove ${source.repository}`);

        remove.addEventListener("click", () => {
          state.delete(key);
          render();
        });

        actions.append(chooseAll, remove);
        titleRow.append(titleWrap, actions);
        group.append(titleRow);

        for (const provider of providers) {
          const row = document.createElement("label");
          row.className = "provider-row";

          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = source.selected.has(provider.id);
          checkbox.disabled = !provider.enabled || provider.types.length === 0;

          checkbox.addEventListener("change", () => {
            if (checkbox.checked) source.selected.add(provider.id);
            else source.selected.delete(provider.id);
            updateCounts();
          });

          const detail = document.createElement("span");

          const name = document.createElement("span");
          name.className = "provider-name";
          name.append(document.createTextNode(provider.name));

          const id = document.createElement("span");
          id.className = "provider-id";
          id.textContent = provider.id;
          name.append(id);

          const description = document.createElement("p");
          description.className = "provider-description";
          description.textContent = provider.description || "No description provided.";

          detail.append(name, description);

          const tag = document.createElement("span");
          tag.className = `type-tag${
            provider.enabled && provider.types.length ? "" : " disabled"
          }`;

          tag.textContent = provider.types.length
            ? provider.types.join(" · ")
            : "unsupported";

          row.append(checkbox, detail, tag);
          group.append(row);
        }

        catalog.append(group);
      }

      if (!visible) {
        catalog.className = "catalog-empty";

        const message = document.createElement("p");
        message.textContent = query
          ? "No plugins match this search."
          : "No available plugins found.";

        catalog.append(message);
      }

      updateCounts();
    }

    async function inspect(repository, ref, options = {}) {
      if (!repository) {
        setStatus("Enter a GitHub repository URL.", "error");
        return null;
      }

      const showStatus = options.showStatus !== false;

      if (showStatus) {
        discoverButton.disabled = true;
        discoverButton.classList.add("loading");
        setStatus("Checking GitHub manifest…");
      }

      try {
        const source = await api("/api/discover", { repository, ref });
        const key = `${source.repository}@${source.ref}`;
        const prior = state.get(key);

        const loaded = {
          ...source,
          selected: prior?.selected || new Set()
        };

        state.set(key, loaded);

        if (options.render !== false) render();

        if (showStatus) {
          setStatus(
            `Found ${source.providers.length} providers at commit ${source.commit.slice(0, 8)}.`,
            "success"
          );
        }

        return loaded;
      } catch (error) {
        if (showStatus) setStatus(error.message, "error");
        throw error;
      } finally {
        if (showStatus) {
          discoverButton.disabled = false;
          discoverButton.classList.remove("loading");
        }
      }
    }

    function suggestedSources() {
      return [...document.querySelectorAll(".quick-source")].map((button) => ({
        repository: button.dataset.repo,
        ref: "main"
      }));
    }

    async function restoreSelection() {
      discoverButton.disabled = true;
      setStatus("Loading your plugin sources…");

      try {
        const saved = await api("/api/config");
        streamFields = Array.isArray(saved.fields) ? saved.fields : [];
        populateFieldSelect($("#stream-sort-field"), true);
        populateFieldSelect($("#format-field"));
        setMiddlewareSettings(saved.middleware);
        const savedSources = saved.sources || [];
        const wanted = new Map();

        for (const source of [...suggestedSources(), ...savedSources]) {
          wanted.set(`${source.repository}@${source.ref}`, source);
        }

        const requestedSources = [...wanted.values()];

        const results = await Promise.allSettled(
          requestedSources.map((source) =>
            api("/api/discover", {
              repository: source.repository,
              ref: source.ref
            })
          )
        );

        const failed = [];

        results.forEach((result, index) => {
          const requested = requestedSources[index];

          if (result.status === "rejected") {
            failed.push(
              `${requested.repository.split("/").slice(-1)[0]}: ${result.reason.message}`
            );
            return;
          }

          const source = result.value;
          const key = `${source.repository}@${source.ref}`;

          const savedSelection = savedSources.find(
            (item) => `${item.repository}@${item.ref}` === key
          );

          state.set(key, {
            ...source,
            selected: new Set(savedSelection?.providerIds || [])
          });
        });

        render();

        if (failed.length) {
          setStatus(`Some sources couldn't load: ${failed.join("; ")}`, "error");
        } else {
          setStatus(
            `Loaded ${state.size} plugin sources. Choose the plugins you want.`,
            "success"
          );
        }
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        discoverButton.disabled = false;
      }
    }

    // Profiles
    async function loadProfilesList() {
      try {
        const res = await api("/api/profiles");
        profiles = Array.isArray(res.profiles) ? res.profiles : [];

        const select = $("#profile-select");
        select.replaceChildren();

        if (profiles.length === 0) {
          const opt = document.createElement("option");
          opt.value = "";
          opt.textContent = "No saved profiles";
          select.appendChild(opt);
        } else {
          profiles.forEach((profile) => {
            const opt = document.createElement("option");
            opt.value = profile.id;
            opt.textContent = profile.name;
            select.appendChild(opt);
          });
        }

        $("#delete-profile").disabled = profiles.length === 0;
      } catch (error) {
        console.error("Could not load profiles:", error);
      }
    }

    $("#profile-select").addEventListener("change", async (event) => {
      const profileId = event.target.value;
      const found = profiles.find((profile) => profile.id === profileId);
      if (!found) return;

      setStatus("Switching profile…");

      const nextState = new Map();
      const failed = [];

      for (const sourceInfo of found.sources || []) {
        try {
          const source = await api("/api/discover", {
            repository: sourceInfo.repository,
            ref: sourceInfo.ref
          });

          const key = `${source.repository}@${source.ref}`;

          nextState.set(key, {
            ...source,
            selected: new Set(sourceInfo.providerIds || [])
          });
        } catch (error) {
          failed.push(error.message);
        }
      }

      state = nextState;
      render();
      showView("configure");

      if (failed.length) {
        setStatus(`Some profile sources couldn't load: ${failed.join("; ")}`, "error");
      } else {
        setStatus(`Profile "${found.name}" loaded successfully.`, "success");
      }
    });

    $("#save-new-profile").addEventListener("click", async () => {
      const name = prompt("Enter profile name:", "My Custom Profile");
      if (!name?.trim()) return;

      const sources = [...state.values()].map((source) => ({
        repository: source.repository,
        ref: source.ref,
        commit: source.commit,
        providerIds: [...source.selected]
      })).filter((source) => source.providerIds.length);

      if (!sources.length) {
        return setStatus("Select at least one plugin before saving a profile.", "error");
      }

      try {
        await api("/api/profiles", { name: name.trim(), sources });
        await loadProfilesList();
        setStatus("Profile saved successfully.", "success");
      } catch (error) {
        setStatus(error.message, "error");
      }
    });

    $("#delete-profile").addEventListener("click", async () => {
      const profileId = $("#profile-select").value;

      if (!profileId) return alert("Select a profile to delete.");
      if (!confirm("Are you sure you want to delete this profile?")) return;

      try {
        await api(`/api/profiles/${profileId}`, undefined, "DELETE");
        await loadProfilesList();
        setStatus("Profile deleted.", "success");
      } catch (error) {
        setStatus(error.message, "error");
      }
    });

    // Authentication
    $("#login-tab").addEventListener("click", () => showAuthTab("login"));
    $("#register-tab").addEventListener("click", () => showAuthTab("register"));

    $("#login-form").addEventListener("submit", async (event) => {
      event.preventDefault();

      try {
        const result = await api("/api/login", {
          uuid: $("#login-uuid").value.trim(),
          password: $("#login-password").value
        });

        await enter(result.user);
      } catch (error) {
        setStatus(error.message, "error");
      }
    });

    $("#register-form").addEventListener("submit", async (event) => {
      event.preventDefault();

      const password = $("#register-password").value;

      if (password.length < 8) {
        return setStatus("Password must be at least 8 characters.", "error");
      }

      if (password !== $("#register-confirm").value) {
        return setStatus("Passwords do not match.", "error");
      }

      try {
        const result = await api("/api/register", { password });

        pendingUser = result.user;
        $("#new-uuid").textContent = pendingUser.id;
        $("#register-form").hidden = true;
        $("#auth-tabs").hidden = true;
        $("#new-account").hidden = false;
        authStatus.textContent = "";
      } catch (error) {
        setStatus(error.message, "error");
      }
    });

    $("#copy-new-uuid").addEventListener("click", () => {
      if (!pendingUser) return;

      copyText(
        pendingUser.id,
        () => setStatus("UUID copied.", "success"),
        () => setStatus("Clipboard access is unavailable.", "error")
      );
    });

    $("#saved-ack").addEventListener("change", (event) => {
      $("#continue").disabled = !event.target.checked;
    });

    $("#continue").addEventListener("click", () => {
      if (pendingUser) enter(pendingUser);
    });

    $("#logout").addEventListener("click", async () => {
      try {
        await api("/api/logout", {});
      } finally {
        setUser(null);
      }
    });

    // Account settings
    $("#account-menu").addEventListener("click", () => showView("account"));
    $("#account-nav").addEventListener("click", () => showView("account"));
    $("#back-from-account").addEventListener("click", () => showView("configure"));

    $("#copy-uuid").addEventListener("click", () => {
      if (!user) return;

      copyText(
        user.id,
        () => setStatus("UUID copied.", "success"),
        () => setStatus("Clipboard access is unavailable.", "error")
      );
    });

    $("#delete-account").addEventListener("click", async () => {
      const password = $("#delete-password").value;

      if (!password) {
        return setStatus("Enter your password to delete your account.", "error");
      }

      if (!confirm("Permanently delete this account and its saved selection?")) return;

      try {
        await api("/api/account", { password }, "DELETE");
        setUser(null);
        setStatus("Account deleted.", "success");
      } catch (error) {
        setStatus(error.message, "error");
      }
    });

    // Discover custom sources
    discoverButton.addEventListener("click", () => {
      inspect(
        $("#repository").value.trim(),
        $("#ref").value.trim() || "main"
      );
    });

    document.querySelectorAll(".quick-source").forEach((button) => {
      button.addEventListener("click", () => {
        $("#repository").value = button.dataset.repo;
        $("#ref").value = "main";
        inspect(button.dataset.repo, "main");
      });
    });

    // Navigation
    searchInput.addEventListener("input", render);

    $("#configure-tab").addEventListener("click", () => showView("configure"));
    $("#filters-tab").addEventListener("click", () => showMiddlewareTab("filters"));
    $("#sorting-tab").addEventListener("click", () => showMiddlewareTab("sorting"));
    $("#formatting-tab").addEventListener("click", () => showMiddlewareTab("formatting"));
    document.querySelectorAll(".middleware-tab").forEach((button) => {
      button.addEventListener("click", () => showMiddlewareTab(button.dataset.middlewareTab));
    });
    ["#stream-format", "#formatter-filename", "#formatter-stream-data", "#formatter-metadata"]
      .forEach((selector) => $(selector).addEventListener("input", scheduleFormatterPreview));
    $("#apply-format-preset").addEventListener("click", () => {
      $("#stream-format").value = streamFormatPresets[$("#format-preset").value] || defaultStreamFormat;
      scheduleFormatterPreview();
    });
    $("#add-stream-filter").addEventListener("click", () => {
      const filters = readFilterRows(true);
      const firstField = streamFields[0];
      if (!firstField) return;
      filters.push({ field: firstField.key, operator: "contains", value: "" });
      renderFilterRules(filters);
    });
    $("#insert-format-field").addEventListener("click", () => {
      const editor = $("#stream-format");
      const token = `{stream.${$("#format-field").value}}`;
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.setRangeText(token, start, end, "end");
      editor.focus();
      scheduleFormatterPreview();
    });

    $("#save-tab").addEventListener("click", () => {
      if (selectionCount() === 0) return;
      showView("save");
    });

    $("#go-save").addEventListener("click", () => {
      if (selectionCount() === 0) return;
      showView("save");
    });

    $("#back-to-plugins").addEventListener("click", () => showView("configure"));
    $("#edit-selection").addEventListener("click", () => showView("configure"));

    // Copy install URL
    const copyPluginUrl = () => {
      if (!pluginUrl) return;

      copyText(
        pluginUrl,
        () => {
          copyFeedback.textContent =
            "Copied! Paste this link into Nuvio's plugin source settings.";
        },
        () => {
          copyFeedback.textContent = "Clipboard access is unavailable.";
        }
      );
    };

    pluginUrlButton.addEventListener("click", copyPluginUrl);
    copyUrlButton.addEventListener("click", copyPluginUrl);

    async function applySetup(button) {
      if (isSaving || selectionCount() === 0) return;

      isSaving = true;
      applyButton.disabled = true;
      middlewareSaveButton.disabled = true;
      const originalLabel = button.textContent;
      button.textContent = "Saving…";

      setStatus("Fetching selected plugin files and building your link…");

      const sources = [...state.values()].map((source) => ({
        repository: source.repository,
        ref: source.ref,
        commit: source.commit,
        providerIds: [...source.selected]
      })).filter((source) => source.providerIds.length);

      try {
        const result = await api("/api/apply", {
          sources,
          middleware: readMiddlewareSettings()
        });

        await refreshManifestPreview();

        setStatus(
          `Successfully saved ${result.plugins} selected plugins.`,
          "success"
        );

        outputState.textContent = `${result.plugins} plugins included`;
        outputState.classList.add("ready");

        copyFeedback.textContent =
          "Your setup is saved. Copy your URL and add it to Nuvio.";

        if (button === applyButton) {
          $(".output-panel").scrollIntoView({
            behavior: "smooth",
            block: "start"
          });
        }
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        isSaving = false;
        button.textContent = originalLabel;
        applyButton.disabled = selectionCount() === 0;
        middlewareSaveButton.disabled = selectionCount() === 0;
      }
    }

    // Save selection and middleware settings
    applyButton.addEventListener("click", () => applySetup(applyButton));
    middlewareSaveButton.addEventListener("click", () => applySetup(middlewareSaveButton));

    // Export backup
    $("#export-config").addEventListener("click", async () => {
      try {
        const saved = await api("/api/config");

        const backup = {
          format: "aioplugins-profile",
          version: 1,
          sources: saved.sources || [],
          middleware: saved.middleware
        };

        const blobUrl = URL.createObjectURL(
          new Blob([JSON.stringify(backup, null, 2)], {
            type: "application/json"
          })
        );

        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = `aioplugins-${user.id.slice(0, 8)}.json`;
        link.click();

        URL.revokeObjectURL(blobUrl);
        setStatus("Backup exported.", "success");
      } catch (error) {
        setStatus(error.message, "error");
      }
    });

    // Import backup
    $("#import-config").addEventListener("click", () => {
      $("#import-config-file").click();
    });

    $("#import-config-file").addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const backup = JSON.parse(await file.text());

        if (
          backup.format !== "aioplugins-profile" ||
          backup.version !== 1 ||
          !Array.isArray(backup.sources)
        ) {
          throw new Error("This file is not a valid AIOPlugins backup.");
        }

        setStatus("Restoring plugins…");
        await api("/api/apply", {
          sources: backup.sources,
          middleware: backup.middleware
        });
        setMiddlewareSettings(backup.middleware);

        const restoredState = new Map();

        for (const sourceInfo of backup.sources) {
          const source = await api("/api/discover", {
            repository: sourceInfo.repository,
            ref: sourceInfo.ref
          });

          const key = `${source.repository}@${source.ref}`;

          restoredState.set(key, {
            ...source,
            selected: new Set(sourceInfo.providerIds || [])
          });
        }

        state = restoredState;
        render();
        await refreshManifestPreview();

        setStatus("Backup restored successfully.", "success");
        showView("configure");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        event.target.value = "";
      }
    });

    // Initial session check
    async function initialize() {
      try {
        const { user: current } = await api("/api/session");

        if (current) {
          await enter(current);
        } else {
          setUser(null);
        }
      } catch (error) {
        setUser(null);
        setStatus(error.message, "error");
      }
    }

    loadAppVersion();
    initialize();
