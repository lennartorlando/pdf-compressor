import { webCompressionProfiles, type CompressionProfileName } from "../profiles.js";

export function createProfileSelector(onChange: (profile: CompressionProfileName) => void): HTMLElement {
  const group = document.createElement("fieldset");
  group.className = "profiles";
  const legend = document.createElement("legend");
  legend.textContent = "Compression";
  group.append(legend);

  for (const profile of webCompressionProfiles) {
    const label = document.createElement("label");
    label.className = "profile";
    label.innerHTML = `
      <input type="radio" name="profile" value="${profile.name}" ${profile.name === "balanced" ? "checked" : ""} />
      <strong>${profile.label}</strong>
      <span>${profile.description}</span>
    `;
    label.querySelector("input")!.addEventListener("change", () => onChange(profile.name));
    group.append(label);
  }

  return group;
}
