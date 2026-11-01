import {
  DEFAULT_STREAM_DESCRIPTION_FORMAT,
  DEFAULT_STREAM_NAME_FORMAT
} from "../lib/default-stream-format";
import type {
  StreamFieldDefinition,
  StreamFieldType,
  StreamFilter,
  StreamFilterOperator
} from "../providers/stream-middleware.js";

type AppView = "configure" | "middleware" | "save" | "account";
type MiddlewareTab = "filters" | "sorting" | "formatting";
type OperatorOption = [StreamFilterOperator, string];

interface PublicUser {
  id: string;
  installPath: string;
}

interface UserResponse {
  user: PublicUser;
}

interface SessionResponse {
  user: PublicUser | null;
}

interface ProviderSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  types: string[];
}

interface DiscoveredSource {
  repository: string;
  ref: string;
  commit: string;
  providers: ProviderSummary[];
}

interface LoadedSource extends DiscoveredSource {
  selected: Set<string>;
}

interface SavedSource {
  repository: string;
  ref: string;
  providerIds: string[];
  commit?: string;
}

interface SourceReference {
  repository: string;
  ref: string;
  providerIds?: string[];
  commit?: string;
}

interface SavedProfile {
  id: string;
  name: string;
  sources: SavedSource[];
}

interface ConfigResponse {
  sources: SavedSource[];
  middleware: unknown;
  fields: StreamFieldDefinition[];
}

interface ProfilesResponse {
  profiles: SavedProfile[];
}

interface DiscoverResponse extends DiscoveredSource {}

interface FormatterPreviewResponse {
  name: string;
  description: string;
  parsed: Record<string, unknown>;
}

interface ApplyResponse {
  plugins: number;
}

interface SelectedProvider {
  name: string;
  id: string;
  repository: string;
  types: string[];
}

interface ProfileBackup {
  format: "aioplugins-profile";
  version: 1;
  sources: SavedSource[];
  middleware?: unknown;
}

interface ManifestPreview {
  scrapers?: unknown[];
}

function $<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required UI element: ${selector}`);
  return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function isStreamFilterOperator(value: string): value is StreamFilterOperator {
  return [
    "contains", "notContains", "equals", "notEquals", "gt", "gte",
    "lt", "lte", "isTrue", "isFalse", "exists", "missing"
  ].includes(value);
}

function isStreamFilter(value: unknown): value is StreamFilter {
  return isRecord(value) &&
    typeof value.field === "string" &&
    typeof value.operator === "string" &&
    isStreamFilterOperator(value.operator) &&
    typeof value.value === "string";
}

function parseJsonRecord(value: string, message: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error(message);
  return parsed;
}

function isSavedSource(value: unknown): value is SavedSource {
  return isRecord(value) &&
    typeof value.repository === "string" &&
    typeof value.ref === "string" &&
    Array.isArray(value.providerIds) &&
    value.providerIds.every((id) => typeof id === "string") &&
    (value.commit === undefined || typeof value.commit === "string");
}

function parseProfileBackup(value: unknown): ProfileBackup {
  if (
    !isRecord(value) ||
    value.format !== "aioplugins-profile" ||
    value.version !== 1 ||
    !Array.isArray(value.sources) ||
    !value.sources.every(isSavedSource)
  ) {
    throw new Error("This file is not a valid AIOPlugins backup.");
  }

  return {
    format: "aioplugins-profile",
    version: 1,
    sources: value.sources,
    middleware: value.middleware
  };
}

    let user: PublicUser | null = null;
    let pendingUser: PublicUser | null = null;
    let state = new Map<string, LoadedSource>();
    let profiles: SavedProfile[] = [];
    let streamFields: StreamFieldDefinition[] = [];
    let activeView: AppView = "configure";
    let activeMiddlewareTab: MiddlewareTab = "filters";
    let pluginUrl = "";
    let manifestPath = "";
    let isSaving = false;
    let formatterPreviewTimer = 0;
    let formatterPreviewRequest = 0;
    const defaultNameFormat = DEFAULT_STREAM_NAME_FORMAT;
    const defaultDescriptionFormat = DEFAULT_STREAM_DESCRIPTION_FORMAT;
    const streamFormatPresets: Record<string, string> = {
      detailed: defaultDescriptionFormat,
      compact: "{stream.title}{? · {stream.resolution}?}{? · {stream.size::sbytes}?}",
      title: "{stream.title}"
    };

    const catalog = $("#catalog");
    const status = $("#status");
    const saveStatus = $("#save-status");
    const authStatus = $("#auth-status");
    const discoverButton = $<HTMLButtonElement>("#discover");
    const applyButton = $<HTMLButtonElement>("#apply");
    const goSaveButton = $<HTMLButtonElement>("#go-save");
    const searchInput = $<HTMLInputElement>("#search");
    const selectFilteredButton = $<HTMLButtonElement>("#select-filtered");
    const pluginUrlButton = $<HTMLButtonElement>("#plugin-url");
    const copyUrlButton = $<HTMLButtonElement>("#copy-plugin-url");
    const copyFeedback = $("#copy-feedback");
    const manifestPreview = $("#manifest-preview");
    const outputState = $("#output-state");
    const middlewareSaveButton = $<HTMLButtonElement>("#save-middleware");
    const copyrightYear = document.querySelector<HTMLElement>("#copyright-year");

    if (copyrightYear) {
      copyrightYear.textContent = String(new Date().getFullYear());
    }
    
    async function loadAppVersion() {
      try {
        const response = await fetch("/version.json", {
          cache: "no-store"
        });

        if (!response.ok) return;

        const data: unknown = await response.json();

        if (isRecord(data) && typeof data.version === "string" && data.version.trim()) {
          const badge = $("#app-version");
          badge.textContent = data.version;
          badge.hidden = false;
        }
      } catch {
        // Version information is optional.
      }
    }

    async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
      const request: RequestInit = {
        method: method ?? (body === undefined ? "GET" : "POST")
      };
      if (body !== undefined) {
        request.headers = { "content-type": "application/json" };
        request.body = JSON.stringify(body);
      }

      const response = await fetch(path, request);

      const result: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message = isRecord(result) && typeof result.error === "string"
          ? result.error
          : `Request failed (${response.status})`;
        throw new Error(message);
      }

      return result as T;
    }

    function setStatus(message: string, kind = "") {
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

    async function copyText(text: string, onDone: () => void, onFail: () => void) {
      try {
        await navigator.clipboard.writeText(text);
        onDone();
      } catch {
        onFail();
      }
    }

    function showAuthTab(tab: "login" | "register") {
      const login = tab === "login";
      $("#login-form").hidden = !login;
      $("#register-form").hidden = login;
      $("#login-tab").setAttribute("aria-selected", String(login));
      $("#register-tab").setAttribute("aria-selected", String(!login));
      authStatus.textContent = "";
    }

    function showView(view: AppView) {
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
        const button = $<HTMLButtonElement>(`#${id}`);
        const active = name === activeNav;

        button.classList.toggle("active", active);
        button.setAttribute("aria-current", active ? "page" : "false");
      });

      const pageContent: Record<Exclude<AppView, "middleware">, { title: string; description: string }> = {
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

      const middlewareContent: Record<MiddlewareTab, { title: string; description: string }> = {
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

    function showMiddlewareTab(tab: MiddlewareTab) {
      activeMiddlewareTab = tab;
      showView("middleware");

      document.querySelectorAll<HTMLElement>(".middleware-panel").forEach((panel) => {
        panel.hidden = panel.id !== `middleware-${tab}`;
      });
      document.querySelectorAll<HTMLButtonElement>(".middleware-tab").forEach((button) => {
        const active = button.dataset.middlewareTab === tab;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      });
    }

    const filterOperatorOptions: Record<StreamFieldType, OperatorOption[]> = {
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

    function populateFieldSelect(select: HTMLSelectElement, includeProviderOrder = false) {
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

    function operatorsForField(fieldKey: string): OperatorOption[] {
      const field = streamFields.find((entry) => entry.key === fieldKey);
      return field ? filterOperatorOptions[field.type] : filterOperatorOptions.text;
    }

    function readFilterRows(includeIncomplete = false): StreamFilter[] {
      return [...document.querySelectorAll<HTMLElement>(".filter-rule")].map((row) => {
        const operatorValue = row.querySelector<HTMLSelectElement>(".filter-operator")?.value ?? "";
        return {
          field: row.querySelector<HTMLSelectElement>(".filter-field")?.value ?? "",
          operator: isStreamFilterOperator(operatorValue) ? operatorValue : "contains",
          value: row.querySelector<HTMLInputElement>(".filter-value")?.value.trim() ?? ""
        };
      }).filter((rule) =>
        includeIncomplete ||
        ["exists", "missing", "isTrue", "isFalse"].includes(rule.operator) ||
        Boolean(rule.value)
      );
    }

    function renderFilterRules(rules: StreamFilter[]) {
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
          const nextRule = nextRules[index];
          if (!nextRule) return;
          nextRule.field = field.value;
          const nextOperators = operatorsForField(field.value);
          if (!nextOperators.some(([value]) => value === nextRule.operator)) {
            nextRule.operator = nextOperators[0]?.[0] || "contains";
          }
          nextRule.value = "";
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

    function setMiddlewareSettings(value: unknown) {
      const settings = isRecord(value) ? value : {};
      $<HTMLSelectElement>("#stream-sort-field").value = typeof settings.sortField === "string" ? settings.sortField : "";
      $<HTMLSelectElement>("#stream-sort-direction").value = settings.sortDirection === "asc" ? "asc" : "desc";
      renderFilterRules(Array.isArray(settings.filters) ? settings.filters.filter(isStreamFilter) : []);
      $<HTMLTextAreaElement>("#stream-name-format").value = typeof settings.nameFormat === "string" && settings.nameFormat.trim()
        ? settings.nameFormat
        : defaultNameFormat;
      $<HTMLTextAreaElement>("#stream-description-format").value = typeof settings.descriptionFormat === "string" && settings.descriptionFormat.trim()
        ? settings.descriptionFormat
        : typeof settings.format === "string" && settings.format.trim()
          ? settings.format
          : defaultDescriptionFormat;
      scheduleFormatterPreview();
    }

    function readMiddlewareSettings() {
      return {
        filters: readFilterRows().slice(0, 30),
        sortField: $<HTMLSelectElement>("#stream-sort-field").value,
        sortDirection: $<HTMLSelectElement>("#stream-sort-direction").value as "asc" | "desc",
        nameFormat: $<HTMLTextAreaElement>("#stream-name-format").value,
        descriptionFormat: $<HTMLTextAreaElement>("#stream-description-format").value
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
      const name = $("#formatter-preview-name");
      const description = $("#formatter-preview-description");
      const state = $("#formatter-preview-state");

      try {
        const stream = parseJsonRecord(
          $<HTMLTextAreaElement>("#formatter-stream-data").value,
          "Stream data must be a JSON object."
        );
        const metadata = parseJsonRecord(
          $<HTMLTextAreaElement>("#formatter-metadata").value,
          "Metadata must be a JSON object."
        );
        stream.filename = $<HTMLInputElement>("#formatter-filename").value.trim();

        const result = await api<FormatterPreviewResponse>("/api/formatter/preview", {
          nameFormat: $<HTMLTextAreaElement>("#stream-name-format").value,
          descriptionFormat: $<HTMLTextAreaElement>("#stream-description-format").value,
          stream,
          metadata
        });
        if (requestId !== formatterPreviewRequest) return;

        name.textContent = result.name || "(empty output)";
        description.textContent = result.description || "(empty output)";
        $("#formatter-parsed-fields").textContent = JSON.stringify(result.parsed, null, 2);
        state.textContent = "Updated";
        state.className = "formatter-preview-state ready";
      } catch (error) {
        if (requestId !== formatterPreviewRequest) return;
        name.textContent = "Preview unavailable";
        description.textContent = "Preview unavailable";
        $("#formatter-parsed-fields").textContent = "{}";
        state.textContent = errorMessage(error);
        state.className = "formatter-preview-state error";
      }
    }

    function setUser(next: PublicUser | null) {
      user = next;
      state = new Map();

      const authed = Boolean(next);

      $("#auth-view").hidden = authed;
      $("#app-view").hidden = !authed;
      $("#session-bar").hidden = !authed;
      $("#server-state").hidden = authed;

      if (!next) {
        for (const input of document.querySelectorAll<HTMLInputElement>("#auth-view input, #delete-password")) {
          input.value = "";
          if (input.type === "checkbox") input.checked = false;
        }

        pendingUser = null;
        $("#new-account").hidden = true;
        $("#auth-tabs").hidden = false;
        $<HTMLButtonElement>("#continue").disabled = true;
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
      $<HTMLAnchorElement>("#open-manifest").href = manifestPath;
      copyUrlButton.disabled = false;

      showView("configure");
      loadProfilesList().then(() => restoreSelection());
    }

    async function enter(nextUser: PublicUser) {
      setUser(nextUser);
    }

    async function refreshManifestPreview() {
      if (!manifestPath) return;

      const response = await fetch(manifestPath, { cache: "no-store" });

      if (!response.ok) {
        throw new Error("Could not load the Nuvio manifest preview");
      }

      const manifestData: unknown = await response.json();
      const manifest: ManifestPreview = isRecord(manifestData) ? manifestData : {};
      manifestPreview.textContent = JSON.stringify(manifest, null, 2);

      const pluginCount = Array.isArray(manifest.scrapers) ? manifest.scrapers.length : 0;

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

      const selected: SelectedProvider[] = [];

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

    function matchingProviders(source: LoadedSource) {
      const query = searchInput.value.trim().toLowerCase();

      return source.providers.filter((provider) =>
        `${provider.name} ${provider.id} ${provider.description}`
          .toLowerCase()
          .includes(query)
      );
    }

    function toggleFilteredSelection() {
      const targets = [...state.values()].flatMap((source) =>
        matchingProviders(source)
          .filter((provider) => provider.enabled && provider.types.length > 0)
          .map((provider) => ({ source, provider }))
      );
      const shouldSelect = !targets.every(({ source, provider }) =>
        source.selected.has(provider.id)
      );

      for (const { source, provider } of targets) {
        if (shouldSelect) source.selected.add(provider.id);
        else source.selected.delete(provider.id);
      }

      render();
    }

    function render() {
      catalog.replaceChildren();

      if (state.size === 0) {
        catalog.className = "catalog-empty";
        selectFilteredButton.disabled = true;
        selectFilteredButton.textContent = "Select all";

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
      const selectable: { source: LoadedSource; id: string }[] = [];

      for (const [key, source] of state) {
        const providers = matchingProviders(source);

        if (providers.length === 0) continue;
        visible += providers.length;
        selectable.push(
          ...providers
            .filter((provider) => provider.enabled && provider.types.length > 0)
            .map((provider) => ({ source, id: provider.id }))
        );

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
        chooseAll.textContent = "Select visible";

        chooseAll.addEventListener("click", () => {
          for (const provider of providers) {
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
        message.textContent = searchInput.value.trim()
          ? "No plugins match this search."
          : "No available plugins found.";

        catalog.append(message);
      }

      const allSelected = selectable.length > 0 && selectable.every(
        ({ source, id }) => source.selected.has(id)
      );
      selectFilteredButton.disabled = selectable.length === 0;
      selectFilteredButton.textContent = allSelected
        ? "Deselect all"
        : "Select all";

      updateCounts();
    }

    async function inspect(
      repository: string,
      ref: string,
      options: { showStatus?: boolean; render?: boolean } = {}
    ): Promise<LoadedSource | null> {
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
        const source = await api<DiscoverResponse>("/api/discover", { repository, ref });
        const key = `${source.repository}@${source.ref}`;
        const prior = state.get(key);

        const loaded = {
          ...source,
          selected: prior?.selected ?? new Set<string>()
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
        if (showStatus) setStatus(errorMessage(error), "error");
        throw error;
      } finally {
        if (showStatus) {
          discoverButton.disabled = false;
          discoverButton.classList.remove("loading");
        }
      }
    }

    function suggestedSources() {
      return [...document.querySelectorAll<HTMLButtonElement>(".quick-source")]
        .flatMap((button) => button.dataset.repo
          ? [{ repository: button.dataset.repo, ref: "main" }]
          : []);
    }

    async function restoreSelection() {
      discoverButton.disabled = true;
      setStatus("Loading your plugin sources…");

      try {
        const saved = await api<ConfigResponse>("/api/config");
        streamFields = saved.fields;
        populateFieldSelect($<HTMLSelectElement>("#stream-sort-field"), true);
        populateFieldSelect($<HTMLSelectElement>("#format-field"));
        setMiddlewareSettings(saved.middleware);
        const savedSources = saved.sources || [];
        const wanted = new Map<string, SourceReference>();

        for (const source of [...suggestedSources(), ...savedSources]) {
          wanted.set(`${source.repository}@${source.ref}`, source);
        }

        const requestedSources = [...wanted.values()];

        const results = await Promise.allSettled(
          requestedSources.map((source) =>
            api<DiscoverResponse>("/api/discover", {
              repository: source.repository,
              ref: source.ref
            })
          )
        );

        const failed: string[] = [];

        results.forEach((result, index) => {
          const requested = requestedSources[index];
          if (!requested) return;

          if (result.status === "rejected") {
            failed.push(
              `${requested.repository.split("/").slice(-1)[0]}: ${errorMessage(result.reason)}`
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
        setStatus(errorMessage(error), "error");
      } finally {
        discoverButton.disabled = false;
      }
    }

    // Profiles
    async function loadProfilesList() {
      try {
        const res = await api<ProfilesResponse>("/api/profiles");
        profiles = res.profiles;

        const select = $<HTMLSelectElement>("#profile-select");
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

        $<HTMLButtonElement>("#delete-profile").disabled = profiles.length === 0;
      } catch (error) {
        console.error("Could not load profiles:", error);
      }
    }

    const profileSelect = $<HTMLSelectElement>("#profile-select");
    profileSelect.addEventListener("change", async () => {
      const profileId = profileSelect.value;
      const found = profiles.find((profile) => profile.id === profileId);
      if (!found) return;

      setStatus("Switching profile…");

      const nextState = new Map<string, LoadedSource>();
      const failed: string[] = [];

      for (const sourceInfo of found.sources || []) {
        try {
          const source = await api<DiscoverResponse>("/api/discover", {
            repository: sourceInfo.repository,
            ref: sourceInfo.ref
          });

          const key = `${source.repository}@${source.ref}`;

          nextState.set(key, {
            ...source,
            selected: new Set(sourceInfo.providerIds || [])
          });
        } catch (error) {
          failed.push(errorMessage(error));
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
        await api<unknown>("/api/profiles", { name: name.trim(), sources });
        await loadProfilesList();
        setStatus("Profile saved successfully.", "success");
      } catch (error) {
        setStatus(errorMessage(error), "error");
      }
    });

    $("#delete-profile").addEventListener("click", async () => {
      const profileId = profileSelect.value;

      if (!profileId) return alert("Select a profile to delete.");
      if (!confirm("Are you sure you want to delete this profile?")) return;

      try {
        await api(`/api/profiles/${profileId}`, undefined, "DELETE");
        await loadProfilesList();
        setStatus("Profile deleted.", "success");
      } catch (error) {
        setStatus(errorMessage(error), "error");
      }
    });

    // Authentication
    $("#login-tab").addEventListener("click", () => showAuthTab("login"));
    $("#register-tab").addEventListener("click", () => showAuthTab("register"));

    $("#login-form").addEventListener("submit", async (event) => {
      event.preventDefault();

      try {
        const result = await api<UserResponse>("/api/login", {
          uuid: $<HTMLInputElement>("#login-uuid").value.trim(),
          password: $<HTMLInputElement>("#login-password").value
        });

        await enter(result.user);
      } catch (error) {
        setStatus(errorMessage(error), "error");
      }
    });

    $("#register-form").addEventListener("submit", async (event) => {
      event.preventDefault();

      const password = $<HTMLInputElement>("#register-password").value;

      if (password.length < 8) {
        return setStatus("Password must be at least 8 characters.", "error");
      }

      if (password !== $<HTMLInputElement>("#register-confirm").value) {
        return setStatus("Passwords do not match.", "error");
      }

      try {
        const result = await api<UserResponse>("/api/register", { password });

        pendingUser = result.user;
        $("#new-uuid").textContent = result.user.id;
        $("#register-form").hidden = true;
        $("#auth-tabs").hidden = true;
        $("#new-account").hidden = false;
        authStatus.textContent = "";
      } catch (error) {
        setStatus(errorMessage(error), "error");
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

    const savedAck = $<HTMLInputElement>("#saved-ack");
    const continueButton = $<HTMLButtonElement>("#continue");
    savedAck.addEventListener("change", () => {
      continueButton.disabled = !savedAck.checked;
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
      const password = $<HTMLInputElement>("#delete-password").value;

      if (!password) {
        return setStatus("Enter your password to delete your account.", "error");
      }

      if (!confirm("Permanently delete this account and its saved selection?")) return;

      try {
        await api("/api/account", { password }, "DELETE");
        setUser(null);
        setStatus("Account deleted.", "success");
      } catch (error) {
        setStatus(errorMessage(error), "error");
      }
    });

    // Discover custom sources
    discoverButton.addEventListener("click", () => {
      inspect(
        $<HTMLInputElement>("#repository").value.trim(),
        $<HTMLInputElement>("#ref").value.trim() || "main"
      );
    });

    document.querySelectorAll<HTMLButtonElement>(".quick-source").forEach((button) => {
      button.addEventListener("click", () => {
        const repository = button.dataset.repo;
        if (!repository) return;
        $<HTMLInputElement>("#repository").value = repository;
        $<HTMLInputElement>("#ref").value = "main";
        inspect(repository, "main");
      });
    });

    // Navigation
    searchInput.addEventListener("input", render);
    selectFilteredButton.addEventListener("click", toggleFilteredSelection);

    $("#configure-tab").addEventListener("click", () => showView("configure"));
    $("#filters-tab").addEventListener("click", () => showMiddlewareTab("filters"));
    $("#sorting-tab").addEventListener("click", () => showMiddlewareTab("sorting"));
    $("#formatting-tab").addEventListener("click", () => showMiddlewareTab("formatting"));
    document.querySelectorAll<HTMLButtonElement>(".middleware-tab").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.middlewareTab;
        if (tab === "filters" || tab === "sorting" || tab === "formatting") {
          showMiddlewareTab(tab);
        }
      });
    });
    ["#stream-name-format", "#stream-description-format", "#formatter-filename", "#formatter-stream-data", "#formatter-metadata"]
      .forEach((selector) => $(selector).addEventListener("input", scheduleFormatterPreview));
    $("#apply-format-preset").addEventListener("click", () => {
      const preset = $<HTMLSelectElement>("#format-preset").value;
      $<HTMLTextAreaElement>("#stream-description-format").value = streamFormatPresets[preset] || defaultDescriptionFormat;
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
      const target = $<HTMLSelectElement>("#format-target").value;
      const editor = target === "stream-name-format"
        ? $<HTMLTextAreaElement>("#stream-name-format")
        : $<HTMLTextAreaElement>("#stream-description-format");
      const token = `{stream.${$<HTMLSelectElement>("#format-field").value}}`;
      const start = editor.selectionStart ?? editor.value.length;
      const end = editor.selectionEnd ?? start;
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

    async function applySetup(button: HTMLButtonElement) {
      if (isSaving || selectionCount() === 0) return;

      isSaving = true;
      applyButton.disabled = true;
      middlewareSaveButton.disabled = true;
      const originalLabel = button.textContent;
      button.textContent = "Saving…";

      setStatus("Verifying selected providers and saving your setup…");

      const sources = [...state.values()].map((source) => ({
        repository: source.repository,
        ref: source.ref,
        commit: source.commit,
        providerIds: [...source.selected]
      })).filter((source) => source.providerIds.length);

      try {
        const result = await api<ApplyResponse>("/api/apply", {
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
          "Setup saved. Refresh the AIOPlugins source in Nuvio, or add the URL below if it is not installed yet.";

        if (button === applyButton) {
          $(".output-panel").scrollIntoView({
            behavior: "smooth",
            block: "start"
          });
        }
      } catch (error) {
        setStatus(errorMessage(error), "error");
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
        const saved = await api<ConfigResponse>("/api/config");

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

        if (!user) throw new Error("Log in to export your configuration.");

        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = `aioplugins-${user.id.slice(0, 8)}.json`;
        link.click();

        URL.revokeObjectURL(blobUrl);
        setStatus("Backup exported.", "success");
      } catch (error) {
        setStatus(errorMessage(error), "error");
      }
    });

    // Import backup
    const importConfigInput = $<HTMLInputElement>("#import-config-file");
    $("#import-config").addEventListener("click", () => {
      importConfigInput.click();
    });

    importConfigInput.addEventListener("change", async () => {
      const file = importConfigInput.files?.[0];
      if (!file) return;

      try {
        const backup = parseProfileBackup(JSON.parse(await file.text()) as unknown);

        setStatus("Restoring plugins…");
        await api("/api/apply", {
          sources: backup.sources,
          middleware: backup.middleware
        });
        setMiddlewareSettings(backup.middleware);

        const restoredState = new Map();

        for (const sourceInfo of backup.sources) {
          const source = await api<DiscoverResponse>("/api/discover", {
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
        setStatus(errorMessage(error), "error");
      } finally {
        importConfigInput.value = "";
      }
    });

    // Initial session check
    async function initialize() {
      try {
        const { user: current } = await api<SessionResponse>("/api/session");

        if (current) {
          await enter(current);
        } else {
          setUser(null);
        }
      } catch (error) {
        setUser(null);
        setStatus(errorMessage(error), "error");
      }
    }

    loadAppVersion();
    initialize();
