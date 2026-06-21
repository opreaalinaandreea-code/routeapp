const state = {
  couriers: [
    { id: 1, name: "Curier 1", start: "București", end: "", startTime: "10:00" }
  ],
  addresses: [],
  routes: []
};

const fileInput = document.getElementById("fileInput");
const couriersList = document.getElementById("couriersList");
const addressesList = document.getElementById("addressesList");
const routesList = document.getElementById("routesList");
const addCourierBtn = document.getElementById("addCourierBtn");
const autoAssignBtn = document.getElementById("autoAssignBtn");
const exportBtn = document.getElementById("exportBtn");

const map = L.map("map").setView([44.43, 26.10], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

let mapLayers = [];

function normalizeCityForGeocoding(city) {
  if (!city) return "";
  const c = String(city).trim();
  if (/^sector\s*\d+$/i.test(c) && !/bucure/i.test(c)) return `${c}, București`;
  return c;
}

function normalizePaymentMethod(v) {
  const s = String(v || "").toLowerCase();
  if (s.includes("revolut")) return "Revolut";
  if (s.includes("op")) return "OP";
  if (s.includes("ramburs")) return "Ramburs";
  return v || "";
}

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/);
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.slice(-1).join(" ")
  };
}

function buildAddress(row) {
  const city = normalizeCityForGeocoding(row.city);
  const street = row.street || "";
  const nr = row.nr || "";
  const details = row.details || "";
  return [city, street, nr, details].filter(Boolean).join(", ");
}

function addAddress(row) {
  const address = {
    id: Date.now() + Math.random(),
    orderNumber: row.orderNumber || "",
    firstName: row.firstName || "",
    lastName: row.lastName || "",
    clientName: [row.firstName, row.lastName].filter(Boolean).join(" "),
    phone: row.phone || "",
    city: row.city || "",
    street: row.street || "",
    nr: row.nr || "",
    details: row.details || "",
    paymentMethod: normalizePaymentMethod(row.paymentMethod || ""),
    amount: Number(row.amount || 0),
    customerNote: row.customerNote || "",
    rawAddress: buildAddress(row),
    lat: null,
    lng: null,
    assignedCourierId: null
  };
  state.addresses.push(address);
}

function renderCouriers() {
  couriersList.innerHTML = state.couriers.map(c => `
    <div class="item">
      <strong>${c.name}</strong>
      <div class="small">Start: ${c.start || "-"}</div>
      <div class="small">Final: ${c.end || "-"}</div>
      <div class="small">Plecare: ${c.startTime || "10:00"}</div>
    </div>
  `).join("");
}

function renderAddresses() {
  addressesList.innerHTML = state.addresses.map(a => `
    <div class="item">
      <strong>${a.orderNumber || "—"} · ${a.clientName || "Client"}</strong>
      <div class="small">${a.phone || ""}</div>
      <div class="small">${a.rawAddress || ""}</div>
      <div class="small">${a.details || ""}</div>
      <div class="badge">${a.paymentMethod || "—"} · ${a.amount || 0} lei</div>
      <div class="small">${a.customerNote || ""}</div>
    </div>
  `).join("");
}

function renderRoutes() {
  routesList.innerHTML = state.routes.map(r => `
    <div class="item">
      <strong>${r.courierName}</strong>
      <div class="small">${r.addresses.length} stopuri</div>
    </div>
  `).join("");
}

function redrawMap() {
  mapLayers.forEach(l => map.removeLayer(l));
  mapLayers = [];
  state.addresses.forEach(a => {
    if (a.lat && a.lng) {
      const marker = L.marker([a.lat, a.lng]).addTo(map).bindPopup(
        `<strong>${a.clientName}</strong><br>${a.rawAddress}<br>${a.paymentMethod} · ${a.amount} lei`
      );
      mapLayers.push(marker);
    }
  });
}

async function geocodeAddress(addr) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(addr.rawAddress + ", Romania")}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data && data[0]) {
    addr.lat = parseFloat(data[0].lat);
    addr.lng = parseFloat(data[0].lon);
  }
}

async function geocodeAll() {
  for (const a of state.addresses) {
    await geocodeAddress(a);
    renderAddresses();
    redrawMap();
    await new Promise(r => setTimeout(r, 1000));
  }
}

function autoAssign() {
  state.routes = state.couriers.map(c => ({
    courierId: c.id,
    courierName: c.name,
    addresses: []
  }));

  state.addresses.forEach((a, i) => {
    const idx = i % state.routes.length;
    state.routes[idx].addresses.push(a);
    a.assignedCourierId = state.routes[idx].courierId;
  });

  renderRoutes();
}

function exportExcel() {
  const rows = [];
  state.routes.forEach(r => {
    r.addresses.forEach((a, idx) => {
      const name = splitName(a.clientName);
      rows.push({
        "Curier": r.courierName,
        "Interval Livrare": "10:00 - 12:00",
        "Nr. Comanda": a.orderNumber || (idx + 1),
        "First Name": name.firstName,
        "Last Name": name.lastName,
        "Phone": a.phone,
        "Adresa": a.rawAddress,
        "Detalii": a.details,
        "Payment Method Title": a.paymentMethod,
        "Order Total Amount": a.amount,
        "Customer Note": a.customerNote || ""
      });
    });
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Orders");
  XLSX.writeFile(wb, "trasee_curieri.xlsx");
}

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const ext = file.name.split(".").pop().toLowerCase();

  if (ext === "xlsx" || ext === "xls") {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

    state.addresses = rows.map(r => ({
      orderNumber: r["Order Number"],
      firstName: r["First Name (Shipping)"],
      lastName: r["Last Name (Shipping)"],
      clientName: [r["First Name (Shipping)"], r["Last Name (Shipping)"]].filter(Boolean).join(" "),
      phone: r["Phone (Billing)"],
      city: r["City (Shipping)"],
      street: r["Strada"],
      nr: r["Nr"],
      details: r["Detalii"],
      paymentMethod: r["Payment Method Title"],
      amount: r["Order Total Amount"],
      customerNote: r["Customer Note"],
      rawAddress: buildAddress({
        city: r["City (Shipping)"],
        street: r["Strada"],
        nr: r["Nr"],
        details: r["Detalii"]
      }),
      lat: null,
      lng: null,
      assignedCourierId: null
    }));
    renderAddresses();
    await geocodeAll();
  } else if (ext === "csv") {
    const text = await file.text();
    const wb = XLSX.read(text, { type: "string" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    state.addresses = rows;
    renderAddresses();
  } else {
    alert("Format neacceptat în acest test. Folosește .xlsx sau .csv.");
  }
});

addCourierBtn.addEventListener("click", () => {
  state.couriers.push({
    id: Date.now(),
    name: `Curier ${state.couriers.length + 1}`,
    start: "",
    end: "",
    startTime: "10:00"
  });
  renderCouriers();
});

autoAssignBtn.addEventListener("click", autoAssign);
exportBtn.addEventListener("click", exportExcel);

renderCouriers();
renderAddresses();
renderRoutes();
