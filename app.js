const state = {
  couriers: [
    { id: 1, name: "Curier 1", start: "Depozit", end: "", startTime: "10:00" }
  ],
  addresses: [],
  routes: [],
  mapLayers: [],
  modal: null
};

const el = {
  fileInput: document.getElementById("fileInput"),
  couriersList: document.getElementById("couriersList"),
  addressesList: document.getElementById("addressesList"),
  routesList: document.getElementById("routesList"),
  addCourierBtn: document.getElementById("addCourierBtn"),
  geocodeBtn: document.getElementById("geocodeBtn"),
  autoAssignBtn: document.getElementById("autoAssignBtn"),
  exportBtn: document.getElementById("exportBtn"),
  modalRoot: document.getElementById("modalRoot")
};

const map = L.map("map").setView([44.43, 26.10], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

const colors = ["#ff5a1f", "#2d6a4f", "#8b5cf6", "#0ea5e9", "#ca8a04"];

function uid() {
  return Date.now() + Math.random();
}

function normalizeCityForGeocoding(city) {
  const c = String(city || "").trim();
  if (!c) return "";
  if (/^sector\s*\d+$/i.test(c) && !/bucure/i.test(c)) return `${c}, București`;
  return c;
}

function normalizePaymentMethod(v) {
  const s = String(v || "").toLowerCase();
  if (s.includes("revolut")) return "Revolut";
  if (s.includes("op")) return "OP";
  if (s.includes("ramburs")) return "Ramburs";
  return String(v || "").trim();
}

function cleanPhone(v) {
  return String(v || "").trim();
}

function parseAmount(v) {
  const n = parseFloat(String(v || "").replace(",", ".").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function splitName(fullName) {
  const s = String(fullName || "").trim().replace(/\s+/g, " ");
  if (!s) return { firstName: "", lastName: "" };
  const parts = s.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts.slice(-1).join(" ") };
}

function buildAddressFromRow(row) {
  const parts = [
    normalizeCityForGeocoding(row.city),
    row.street,
    row.nr,
    row.details
  ].map(v => String(v || "").trim()).filter(Boolean);
  return parts.join(", ");
}

function resetAddressGeo(addr) {
  addr.lat = null;
  addr.lng = null;
  addr.geocodeStatus = "pending";
}

function makeAddressFromImportedRow(r) {
  const firstName = String(r["First Name (Shipping)"] || "").trim();
  const lastName = String(r["Last Name (Shipping)"] || "").trim();
  const clientName = [firstName, lastName].filter(Boolean).join(" ").trim();

  const row = {
    id: uid(),
    orderNumber: String(r["Order Number"] || "").trim(),
    orderStatus: String(r["Order Status"] || "").trim(),
    orderDate: String(r["Order Date"] || "").trim(),
    firstName,
    lastName,
    clientName,
    phone: cleanPhone(r["Phone (Billing)"]),
    city: String(r["City (Shipping)"] || "").trim(),
    street: String(r["Strada"] || "").trim(),
    nr: String(r["Nr"] || "").trim(),
    details: String(r["Detalii"] || "").trim(),
    paymentMethod: normalizePaymentMethod(r["Payment Method Title"]),
    amount: parseAmount(r["Order Total Amount"]),
    customerNote: String(r["Customer Note"] || "").trim(),
    rawAddress: "",
    lat: null,
    lng: null,
    geocodeStatus: "pending",
    assignedCourierId: null,
    deliveryWindow: "",
    deliveryWindowStart: "",
    deliveryWindowEnd: ""
  };

  row.rawAddress = buildAddressFromRow(row);
  return row;
}

function addAddress(row) {
  const addr = {
    id: uid(),
    orderNumber: row.orderNumber || "",
    orderStatus: row.orderStatus || "",
    orderDate: row.orderDate || "",
    firstName: row.firstName || "",
    lastName: row.lastName || "",
    clientName: row.clientName || [row.firstName, row.lastName].filter(Boolean).join(" ").trim(),
    phone: row.phone || "",
    city: row.city || "",
    street: row.street || "",
    nr: row.nr || "",
    details: row.details || "",
    paymentMethod: normalizePaymentMethod(row.paymentMethod || ""),
    amount: parseAmount(row.amount),
    customerNote: row.customerNote || "",
    rawAddress: row.rawAddress || buildAddressFromRow(row),
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    geocodeStatus: row.lat && row.lng ? "ok" : "pending",
    assignedCourierId: row.assignedCourierId || null,
    deliveryWindow: row.deliveryWindow || "",
    deliveryWindowStart: row.deliveryWindowStart || "",
    deliveryWindowEnd: row.deliveryWindowEnd || ""
  };
  state.addresses.push(addr);
  return addr;
}

function setModal(contentHtml) {
  el.modalRoot.innerHTML = `
    <div class="modal-overlay open" id="modalOverlay">
      <div class="modal-box">${contentHtml}</div>
    </div>
  `;
  const overlay = document.getElementById("modalOverlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
}

function closeModal() {
  el.modalRoot.innerHTML = "";
}

function courierOptions(selectedId) {
  return `<option value="">Nealocat</option>` + state.couriers.map(c =>
    `<option value="${c.id}" ${String(selectedId || "") === String(c.id) ? "selected" : ""}>${c.name}</option>`
  ).join("");
}

function renderCouriers() {
  el.couriersList.innerHTML = state.couriers.map(c => {
    const route = state.routes.find(r => String(r.courierId) === String(c.id));
    const stops = route ? route.addresses.length : 0;
    const cash = route ? route.cashTotal.toFixed(0) : "0";
    return `
      <div class="item">
        <div class="item-main">
          <strong>${c.name}</strong>
          <div class="small">Start: ${c.start || "-"}</div>
          <div class="small">Final: ${c.end || "-"}</div>
          <div class="small">Plecare: ${c.startTime || "10:00"}</div>
          <div class="addr-meta">
            <span class="chip green">${stops} stopuri</span>
            <span class="chip orange">${cash} lei cash</span>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function renderAddresses() {
  el.addressesList.innerHTML = state.addresses.map(a => {
    const courier = state.couriers.find(c => String(c.id) === String(a.assignedCourierId));
    return `
      <div class="item" data-id="${a.id}">
        <div class="item-main">
          <strong>${a.orderNumber || "—"} · ${a.clientName || "Client"}</strong>
          <div class="small">${a.phone || ""}</div>
          <div class="small">${a.rawAddress || ""}</div>
          <div class="small">${a.details || ""}</div>
          <div class="addr-meta">
            <span class="chip">${a.paymentMethod || "—"}</span>
            <span class="chip">${a.amount || 0} lei</span>
            <span class="chip ${a.geocodeStatus === "ok" ? "green" : "violet"}">${a.geocodeStatus || "pending"}</span>
            ${a.deliveryWindow ? `<span class="chip orange">${a.deliveryWindow}</span>` : ""}
          </div>
          ${a.customerNote ? `<div class="addr-note">${a.customerNote}</div>` : ""}
          ${courier ? `<div class="addr-note">Curier: ${courier.name}</div>` : ""}
        </div>
        <div class="addr-actions">
          <button class="addr-edit" data-edit="${a.id}">✎ Editează</button>
          <select class="addr-courier-select" data-courier="${a.id}">
            ${courierOptions(a.assignedCourierId)}
          </select>
          <button data-geo="${a.id}">Re-geocodare</button>
        </div>
      </div>
    `;
  }).join("");

  document.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => showEditAddressModal(btn.dataset.edit));
  });

  document.querySelectorAll("[data-courier]").forEach(sel => {
    sel.addEventListener("change", () => {
      const addr = state.addresses.find(x => String(x.id) === String(sel.dataset.courier));
      addr.assignedCourierId = sel.value ? Number(sel.value) : null;
      syncRouteState();
      renderAll();
    });
  });

  document.querySelectorAll("[data-geo]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const addr = state.addresses.find(x => String(x.id) === String(btn.dataset.geo));
      await geocodeOne(addr);
      renderAll();
    });
  });
}

function renderRoutes() {
  if (!state.routes.length) {
    el.routesList.innerHTML = `<div class="small">Nicio rută generată încă.</div>`;
    return;
  }

  el.routesList.innerHTML = state.routes.map(r => {
    const courier = state.couriers.find(c => String(c.id) === String(r.courierId));
    const header = `
      <div class="item">
        <div class="item-main">
          <strong>${courier ? courier.name : "Curier"}</strong>
          <div class="small">${r.addresses.length} stopuri · ${r.distanceKm.toFixed(1)} km · ${r.durationMin.toFixed(0)} min</div>
          <div class="addr-meta">
            <span class="chip orange">${r.cashTotal.toFixed(0)} lei cash</span>
          </div>
        </div>
      </div>
    `;
    const stops = r.addresses.map((a, idx) => `
      <div class="item">
        <div class="item-main">
          <strong>${idx + 1}. ${a.orderNumber || "—"} · ${a.clientName}</strong>
          <div class="small">${a.phone || ""}</div>
          <div class="small">${a.rawAddress || ""}</div>
          <div class="small">${a.details || ""}</div>
          <div class="addr-meta">
            <span class="chip ${a.paymentMethod === "Ramburs" ? "green" : ""}">${a.paymentMethod || ""}</span>
            <span class="chip">${a.amount || 0} lei</span>
            ${a.deliveryWindow ? `<span class="chip violet">${a.deliveryWindow}</span>` : ""}
          </div>
        </div>
      </div>
    `).join("");
    return header + stops;
  }).join("");
}

function renderMap() {
  state.mapLayers.forEach(l => map.removeLayer(l));
  state.mapLayers = [];

  const bounds = [];
  state.routes.forEach((r, idx) => {
    const color = colors[idx % colors.length];
    const latlngs = r.addresses.filter(a => a.lat && a.lng).map(a => [a.lat, a.lng]);
    if (latlngs.length) {
      const poly = L.polyline(latlngs, { color, weight: 4 }).addTo(map);
      state.mapLayers.push(poly);
      bounds.push(...latlngs);

      r.addresses.forEach((a, i) => {
        if (a.lat && a.lng) {
          const marker = L.circleMarker([a.lat, a.lng], {
            radius: 7,
            color,
            fillColor: color,
            fillOpacity: 1
          }).addTo(map);
          marker.bindPopup(`
            <strong>${a.clientName}</strong><br>
            ${a.phone || ""}<br>
            ${a.rawAddress || ""}<br>
            ${a.details || ""}<br>
            ${a.paymentMethod || ""} · ${a.amount || 0} lei<br>
            ${a.deliveryWindow || ""}
          `);
          state.mapLayers.push(marker);
        }
      });
    }
  });

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function renderAll() {
  renderCouriers();
  renderAddresses();
  renderRoutes();
  renderMap();
}

function showEditAddressModal(id) {
  const a = state.addresses.find(x => String(x.id) === String(id));
  if (!a) return;

  setModal(`
    <h3 class="modal-title">Editează adresă</h3>
    <form id="editAddressForm">
      <div class="form-grid">
        <div class="field"><label>Order Number</label><input name="orderNumber" value="${escapeHtml(a.orderNumber)}"></div>
        <div class="field"><label>Client</label><input name="clientName" value="${escapeHtml(a.clientName)}"></div>
        <div class="field"><label>Telefon</label><input name="phone" value="${escapeHtml(a.phone)}"></div>
        <div class="field"><label>Oraș</label><input name="city" value="${escapeHtml(a.city)}"></div>
        <div class="field"><label>Stradă</label><input name="street" value="${escapeHtml(a.street)}"></div>
        <div class="field"><label>Nr</label><input name="nr" value="${escapeHtml(a.nr)}"></div>
        <div class="field"><label>Detalii</label><input name="details" value="${escapeHtml(a.details)}"></div>
        <div class="field"><label>Suma</label><input name="amount" value="${escapeHtml(a.amount)}"></div>
        <div class="field"><label>Metoda de plată</label>
          <select name="paymentMethod">
            <option ${a.paymentMethod === "Ramburs" ? "selected" : ""}>Ramburs</option>
            <option ${a.paymentMethod === "Revolut" ? "selected" : ""}>Revolut</option>
            <option ${a.paymentMethod === "OP" ? "selected" : ""}>OP</option>
          </select>
        </div>
        <div class="field full"><label>Customer Note</label><textarea name="customerNote">${escapeHtml(a.customerNote)}</textarea></div>
      </div>
      <div class="modal-actions">
        <button type="button" id="closeModalBtn">Renunță</button>
        <button class="primary" type="submit">Salvează</button>
      </div>
    </form>
  `);

  document.getElementById("closeModalBtn").onclick = closeModal;
  document.getElementById("editAddressForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    a.orderNumber = fd.get("orderNumber").toString().trim();
    a.clientName = fd.get("clientName").toString().trim();
    const split = splitName(a.clientName);
    a.firstName = split.firstName;
    a.lastName = split.lastName;
    a.phone = fd.get("phone").toString().trim();
    a.city = fd.get("city").toString().trim();
    a.street = fd.get("street").toString().trim();
    a.nr = fd.get("nr").toString().trim();
    a.details = fd.get("details").toString().trim();
    a.amount = parseAmount(fd.get("amount"));
    a.paymentMethod = normalizePaymentMethod(fd.get("paymentMethod"));
    a.customerNote = fd.get("customerNote").toString().trim();
    a.rawAddress = buildAddressFromRow(a);
    resetAddressGeo(a);
    closeModal();
    await geocodeOne(a);
    syncRouteState();
    renderAll();
  };
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function syncRouteState() {
  state.routes.forEach(r => {
    r.addresses = state.addresses.filter(a => String(a.assignedCourierId) === String(r.courierId));
    computeRouteStats(r);
  });
}

function computeRouteStats(route) {
  route.distanceKm = 0;
  route.durationMin = 0;
  route.cashTotal = route.addresses.reduce((sum, a) => sum + (a.paymentMethod === "Ramburs" ? Number(a.amount || 0) : 0), 0);
  route.addresses.forEach((a, i) => {
    const base = state.couriers.find(c => String(c.id) === String(route.courierId));
    const start = base ? base.startTime || "10:00" : "10:00";
    const deliveryStart = addMinutes(start, 30 + i * 20);
    const rounded = roundDownToHour(deliveryStart);
    a.deliveryWindowStart = rounded;
    a.deliveryWindowEnd = addMinutes(rounded, 120);
    a.deliveryWindow = `${a.deliveryWindowStart} - ${a.deliveryWindowEnd}`;
  });
}

function addMinutes(time, mins) {
  const [h, m] = String(time).split(":").map(Number);
  const d = new Date();
  d.setHours(h, m + mins, 0, 0);
  return d.toTimeString().slice(0, 5);
}

function roundDownToHour(time) {
  const [h] = String(time).split(":").map(Number);
  return `${String(h).padStart(2, "0")}:00`;
}

async function geocodeOne(a) {
  if (!a) return;
  const query = `${a.rawAddress}, Romania`;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data && data[0]) {
      a.lat = parseFloat(data[0].lat);
      a.lng = parseFloat(data[0].lon);
      a.geocodeStatus = "ok";
    } else {
      a.geocodeStatus = "missing";
    }
  } catch {
    a.geocodeStatus = "error";
  }
}

async function geocodeAll() {
  for (const a of state.addresses) {
    if (!a.lat || !a.lng) {
      await geocodeOne(a);
      renderAll();
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

function autoAssign() {
  const assigned = state.addresses.filter(a => a.lat && a.lng);
  state.routes = state.couriers.map(c => ({
    courierId: c.id,
    addresses: [],
    distanceKm: 0,
    durationMin: 0,
    cashTotal: 0
  }));

  assigned.forEach((a, idx) => {
    const ridx = idx % state.routes.length;
    a.assignedCourierId = state.routes[ridx].courierId;
    state.routes[ridx].addresses.push(a);
  });

  state.routes.forEach(computeRouteStats);
  renderAll();
}

function getExportRows() {
  const rows = [];
  const all = state.routes.length ? state.routes.flatMap(r => r.addresses.map(a => ({ a, courierId: r.courierId }))) : state.addresses.map(a => ({ a, courierId: a.assignedCourierId }));
  all.forEach((x, idx) => {
    const c = state.couriers.find(cc => String(cc.id) === String(x.courierId));
    const name = splitName(x.a.clientName);
    rows.push({
      "Curier": c ? c.name : "",
      "Interval Livrare": x.a.deliveryWindow || "",
      "Nr. Comanda": x.a.orderNumber || (idx + 1),
      "First Name": name.firstName,
      "Last Name": name.lastName,
      "Phone": x.a.phone,
      "Adresa": x.a.rawAddress,
      "Detalii": x.a.details,
      "Payment Method Title": x.a.paymentMethod,
      "Order Total Amount": x.a.amount,
      "Customer Note": x.a.customerNote
    });
  });
  return rows;
}

function exportExcel() {
  const rows = getExportRows();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Orders");
  XLSX.writeFile(wb, "trasee_curieri.xlsx");
}

function addCourier() {
  state.couriers.push({
    id: uid(),
    name: `Curier ${state.couriers.length + 1}`,
    start: "Depozit",
    end: "",
    startTime: "10:00"
  });
  renderAll();
}

async function parseFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();

  if (ext === "xlsx" || ext === "xls") {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    state.addresses = rows.map(makeAddressFromImportedRow);
    renderAll();
    await geocodeAll();
    return;
  }

  if (ext === "csv") {
    const text = await file.text();
    const wb = XLSX.read(text, { type: "string" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    state.addresses = rows.map(makeAddressFromImportedRow);
    renderAll();
    await geocodeAll();
    return;
  }

  alert("Format neacceptat. Folosește CSV/XLSX.");
}

el.fileInput.addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) parseFile(file);
});

el.addCourierBtn.addEventListener("click", addCourier);
el.geocodeBtn.addEventListener("click", geocodeAll);
el.autoAssignBtn.addEventListener("click", autoAssign);
el.exportBtn.addEventListener("click", exportExcel);

renderAll();
