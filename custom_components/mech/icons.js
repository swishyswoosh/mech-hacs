/** Register the sidebar icon before the lazy controller panel is opened. */
let icon;
async function getIcon(name) {
  if (name !== "r2d2") return {path: ""};
  icon ??= fetch("/mech/sidebar.svg", {cache: "no-cache"})
    .then(response => {
      if (!response.ok) throw Error("Mech sidebar icon unavailable");
      return response.text();
    })
    .then(source => {
      const svg = new DOMParser().parseFromString(source, "image/svg+xml").documentElement;
      const path = svg.querySelector("path")?.getAttribute("d");
      if (!path) throw Error("Invalid Mech sidebar icon");
      return {path, viewBox: svg.getAttribute("viewBox")};
    })
    .catch(error => { icon = undefined; throw error; });
  return icon;
}
window.customIcons ??= {};
window.customIcons.mech = {getIcon, getIconList: async () => [{name: "r2d2"}]};
