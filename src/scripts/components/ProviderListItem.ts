export interface ProviderListItemData {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  types: string[];
}

export interface ProviderListItemOptions {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export function renderProviderListItem(
  provider: ProviderListItemData,
  options: ProviderListItemOptions
): HTMLLabelElement {
  const row = document.createElement("label");
  row.className = "provider-row";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = options.checked;
  checkbox.disabled = options.disabled ??
    (!provider.enabled || provider.types.length === 0);
  checkbox.addEventListener("change", () => {
    options.onChange(checkbox.checked);
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
  return row;
}
