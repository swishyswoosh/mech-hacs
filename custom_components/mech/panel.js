/** The authenticated HA host owns callWS; the controller frame receives results only. */
class MechControllerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: "open"});
    this.clients = new Map();
    this.onMessage = event => this.receive(event);
    this.onHidden = () => { if (document.hidden) void this.release(); };
  }
  set hass(value) {
    const previous = this._hass;
    this._hass = value;
    if (previous?.connection && (!value?.connection || previous.connection !== value.connection)) void this.release(previous);
  }
  connectedCallback() {
    if (!this.frame) {
      const style = document.createElement("style");
      // HA's custom-panel host has auto height; percentage sizing collapses to
      // the iframe's 150px default. Use the viewport minus HA's safe-area padding.
      style.textContent = `
        :host{display:flex;box-sizing:border-box;min-height:0;
          height:calc(100vh - var(--safe-area-inset-top,0px) - var(--safe-area-inset-bottom,0px));
          height:calc(100dvh - var(--safe-area-inset-top,0px) - var(--safe-area-inset-bottom,0px))}
        iframe{display:block;flex:1;width:100%;min-width:0;min-height:0;border:0;background:#070b10}
      `;
      this.frame = document.createElement("iframe");
      this.frame.title = "Mech droid controller";
      this.frame.src = "/mech/controller/index.html?ha=1";
      if (this.panel?.config?.controller_version) {
        this.frame.src += `&v=${encodeURIComponent(this.panel.config.controller_version)}`;
      }
      this.shadowRoot.append(style, this.frame);
    }
    window.addEventListener("message", this.onMessage);
    document.addEventListener("visibilitychange", this.onHidden);
  }
  disconnectedCallback() {
    window.removeEventListener("message", this.onMessage);
    document.removeEventListener("visibilitychange", this.onHidden);
    void this.release();
  }
  async release(hass = this._hass) {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map(body => hass?.callWS({type: "mech/request", method: "POST", path: "ui/release", body})));
  }
  async receive(event) {
    if (event.origin !== location.origin || event.source !== this.frame?.contentWindow || event.data?.type !== "mech:request") return;
    const {id, request} = event.data;
    if (typeof id !== "string" || id.length > 128 || !request || typeof request.path !== "string" || !["GET", "POST", "PUT"].includes(request.method)) return;
    let response;
    try {
      if (!this._hass?.user?.is_admin) throw Error("An authenticated Home Assistant administrator is required.");
      // Construct the permitted command explicitly; never forward arbitrary WS types.
      response = await this._hass.callWS({type: "mech/request", path: request.path, method: request.method,
        ...(request.body === undefined ? {} : {body: request.body}), ...(request.key === undefined ? {} : {key: request.key})});
      if (request.path === "ui/heartbeat" && response.status === 200) {
        const body = request.body;
        this.clients.set(`${body.droid_id}:${body.client_id}`, {droid_id: body.droid_id, client_id: body.client_id});
      }
      if (request.path === "ui/release") this.clients.delete(`${request.body?.droid_id}:${request.body?.client_id}`);
    } catch (error) {
      response = {status: 503, body: {error: {message: error?.message || "Home Assistant connection unavailable"}}};
    }
    event.source.postMessage({type: "mech:response", id, response}, location.origin);
  }
}
if (!customElements.get("mech-controller-panel")) customElements.define("mech-controller-panel", MechControllerPanel);
