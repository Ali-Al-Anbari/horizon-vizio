(() => {
  "use strict";
  const codeField = document.getElementById("code");
  const review = document.getElementById("review");
  const details = document.getElementById("details");
  const status = document.getElementById("status");
  const devices = document.getElementById("devices");
  let selection = null;

  async function api(path, body) {
    const response = await fetch(path, {
      method: body ? "POST" : "GET", cache: "no-store",
      headers: body ? { "Content-Type": "application/json", "X-Horizon-Action": "owner-pair" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.code || "Request failed");
    return data;
  }

  document.getElementById("lookup").addEventListener("click", async () => {
    review.hidden = true;
    selection = null;
    const code = codeField.value.trim().toUpperCase().replace(/[\s-]/g, "");
    if (!/^[A-HJ-NP-Z2-9]{10}$/.test(code)) { status.textContent = "Enter the ten-character code shown on the TV."; return; }
    try {
      const result = await api("/api/owner/lookup", { code });
      selection = { id: result.id, code };
      details.textContent = `${result.details.label}. Browser: ${result.details.userAgent || "Unknown"}. Requested ${new Date(result.createdAt).toLocaleString()}. Expires ${new Date(result.expiresAt).toLocaleString()}.`;
      review.hidden = false;
      status.textContent = "Check the TV code, then explicitly approve or reject.";
    } catch (error) { status.textContent = `Could not review request: ${error.message}`; }
  });

  async function decide(decision) {
    if (!selection) return;
    const selected = selection;
    selection = null;
    review.hidden = true;
    codeField.value = "";
    try {
      await api("/api/owner/decide", { ...selected, decision });
      status.textContent = decision === "approve" ? "TV approved. It should connect shortly." : "Request rejected.";
      await refresh();
    } catch (error) { status.textContent = `Could not ${decision}: ${error.message}`; }
  }

  async function refresh() {
    try {
      const result = await api("/api/owner/devices");
      devices.replaceChildren();
      for (const device of result.devices) {
        const item = document.createElement("li");
        item.textContent = `${device.label} — ${device.revoked ? "revoked" : `expires ${new Date(device.expiresAt).toLocaleString()}`} `;
        if (!device.revoked) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Revoke";
          button.addEventListener("click", async () => {
            try { await api("/api/owner/revoke", { id: device.id }); await refresh(); }
            catch (error) { status.textContent = `Could not revoke: ${error.message}`; }
          });
          item.append(button);
        }
        devices.append(item);
      }
      status.textContent = result.devices.length
        ? "Approved device list loaded."
        : "Approved device list loaded; no devices are enrolled.";
    } catch (error) { status.textContent = `Could not load devices: ${error.message}`; }
  }

  document.getElementById("approve").addEventListener("click", () => decide("approve"));
  document.getElementById("reject").addEventListener("click", () => decide("reject"));
  document.getElementById("refresh").addEventListener("click", refresh);
  refresh();
})();
