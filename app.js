// ===================================================================
// Planificator trasee curieri — logică principală
// Geocodare: Nominatim (OpenStreetMap) · Rutare: OSRM (router.project-osrm.org)
// ===================================================================

const COURIER_COLORS = ['#FF5A1F', '#8B5CF6', '#1D7FBF', '#2D6A4F', '#C2347E', '#B8860B'];
const state = {
  couriers: [], // {id, name, start:{address,lat,lng,status}, end:{address,lat,lng,status}, sameAsStart, departureTime, endTimeLimit, confirmed, color}
  addresses: [], // {id, raw, details, clientName, phone, amount, paymentMethod, lat, lng, status:'pending'|'ok'|'error', courierId:null}
  routes: {}, // courierId -> {order:[addressId...], legs:[{distKm,durMin}], totalKm, totalMin}
  nextCourierId: 1,
  nextAddrId: 1,
};

const PAYMENT_METHODS = ['Ramburs', 'Revolut', 'OP'];
let map, markersLayer, routeLinesLayer;
let geocodeCache = new Map();

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initTabs();
  initCourierPanel();
  initAddressPanel();
  initRoutePanel();
  initActionBar();
  setDateStamp();
  addCourier();
  renderCouriers();
  renderAddresses();
  renderRouteSummary();
  redrawMap();
});

function setDateStamp(){
  const d = new Date();
  const fmt = d.toLocaleDateString('ro-RO', { weekday:'long', day:'numeric', month:'long' });
  const el = document.getElementById('dateStamp');
  if (el) el.textContent = `Manifest de livrare · ${fmt}`;
}

function showToast(msg, isError=false){
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

// -------------------------------------------------------------------
// MAP
// -------------------------------------------------------------------

function initMap(){
  map = L.map('map', { zoomControl:true }).setView([45.9432, 24.9668], 7);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap, © CARTO'
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  routeLinesLayer = L.layerGroup().addTo(map);
}

function updateMapTopBar(){
  const geocoded = state.addresses.filter(a => a.status === 'ok').length;
  const sub = document.getElementById('mapSub');
  const title = document.getElementById('mapTitle');
  if (sub) sub.textContent = `${geocoded} adrese · ${state.couriers.length} curieri`;
  if (title) title.textContent = Object.keys(state.routes).length > 0 ? 'Trasee active' : 'Niciun traseu activ';
}

// -------------------------------------------------------------------
// TABS
// -------------------------------------------------------------------

function initTabs(){
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById(tab.dataset.panel);
      if (panel) panel.classList.add('active');
    });
  });
}

function switchToTab(panelId){
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.panel === panelId));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === panelId));
}

// -------------------------------------------------------------------
// COURIERS
// -------------------------------------------------------------------

function initCourierPanel(){
  const btn = document.getElementById('addCourierBtn');
  if (btn) btn.addEventListener('click', () => { addCourier(); renderCouriers(); renderRouteSummary(); redrawMap(); });
}

function addCourier(){
  const id = state.nextCourierId++;
  const color = COURIER_COLORS[(id - 1) % COURIER_COLORS.length];
  state.couriers.push({
    id,
    name: `Curier ${id}`,
    start: { address: 'București', lat: null, lng: null, status: 'pending' },
    end: { address: '', lat: null, lng: null, status: 'pending' },
    sameAsStart: true,
    departureTime: '10:00',
    endTimeLimit: '',
    confirmed: false,
    color
  });
}

function removeCourier(id){
  state.couriers = state.couriers.filter(c => c.id !== id);
  state.addresses.forEach(a => {
    if (a.courierId === id) a.courierId = null;
  });
  delete state.routes[id];
  renderCouriers();
  renderAddresses();
  renderRouteSummary();
  redrawMap();
}

async function confirmCourier(courierId){
  const courier = state.couriers.find(c => c.id === courierId);
  if (!courier) return;

  const card = document.querySelector(`[data-confirm="${courierId}"]`)?.closest('.courier-card');
  if (card){
    const startInput = card.querySelector('.start-input');
    const endInput = card.querySelector('.end-input');
    const departureInput = card.querySelector('.departure-input');
    const endLimitInput = card.querySelector('.endlimit-input');

    if (startInput && startInput.value.trim() !== courier.start.address){
      courier.start.address = startInput.value.trim();
      courier.start.status = 'pending';
      courier.start.lat = null;
      courier.start.lng = null;
    }
    if (endInput && endInput.value.trim() !== courier.end.address){
      courier.end.address = endInput.value.trim();
      courier.end.status = 'pending';
      courier.end.lat = null;
      courier.end.lng = null;
    }
    if (departureInput) courier.departureTime = normalizeTime(departureInput.value);
    if (endLimitInput) courier.endTimeLimit = endLimitInput.value.trim() ? normalizeTime(endLimitInput.value) : '';
  }

  const btn = document.querySelector(`[data-confirm="${courierId}"]`);
  if (btn){
    btn.disabled = true;
    btn.textContent = 'Se validează…';
  }

  for (const pointKey of ['start', 'end']){
    const point = courier[pointKey];
    if (point.address && point.status === 'pending'){
      const result = await geocodeOne(point.address);
      if (result && result.outOfArea){
        point.status = 'error';
      } else if (result){
        point.lat = result.lat;
        point.lng = result.lng;
        point.status = 'ok';
      } else {
        point.status = 'error';
      }
    }
  }

  const errors = [];
  if (!courier.name.trim()) errors.push('numele curierului');
  if (!courier.start.address) errors.push('punctul de plecare');
  else if (courier.start.status === 'error') errors.push('punctul de plecare nu a putut fi localizat — verifică adresa');
  if (!courier.sameAsStart){
    if (!courier.end.address) errors.push('punctul de finalizare');
    else if (courier.end.status === 'error') errors.push('punctul de finalizare nu a putut fi localizat — verifică adresa');
  }
  if (!courier.departureTime) errors.push('ora de plecare');

  if (errors.length){
    courier.confirmed = false;
    showToast(`Nu pot confirma ${courier.name}: completează ${errors.join(', ')}.`, true);
  } else {
    courier.confirmed = true;
    showToast(`${courier.name} a fost confirmat.`);
  }
  renderCouriers();
  renderRouteSummary();
  redrawMap();
}

function renderCouriers(){
  const list = document.getElementById('courierList');
  const count = document.getElementById('courierCount');
  if (count) count.textContent = state.couriers.length;
  if (!list) return;

  list.innerHTML = '';
  state.couriers.forEach(c => {
    const card = document.createElement('div');
    card.className = 'courier-card';

    const assignedCount = state.addresses.filter(a => a.courierId === c.id).length;
    const route = state.routes[c.id];
    const assignedAddrs = state.addresses.filter(a => a.courierId === c.id);
    const totalToCollect = assignedAddrs.reduce((sum, a) => sum + (a.amount || 0), 0);

    card.innerHTML = `
      <div class="courier-title">
        <strong contenteditable="true" data-name="${c.id}">${escapeHtml(c.name)}</strong>
        <div class="courier-actions">
          <button class="btn btn-sm btn-secondary" data-confirm="${c.id}">Confirmă</button>
        </div>
      </div>

      <div class="field">
        <label>Start</label>
        <input class="start-input" type="text" value="${escapeHtml(c.start.address)}" placeholder="Adresa start">
      </div>

      <div class="field">
        <label>Final</label>
        <input class="end-input" type="text" value="${escapeHtml(c.end.address)}" placeholder="Adresa final">
      </div>

      <div class="field-row">
        <div class="field">
          <label>Ora plecare</label>
          <input class="departure-input" type="time" value="${escapeHtml(c.departureTime)}">
        </div>
        <div class="field">
          <label>Ora limită</label>
          <input class="endlimit-input" type="time" value="${escapeHtml(c.endTimeLimit)}">
        </div>
      </div>

      <div class="courier-stats">
        <span class="chip green">${assignedCount} adrese</span>
        <span class="chip orange">${totalToCollect.toFixed(0)} lei</span>
        ${route ? `<span class="chip violet">${route.totalKm.toFixed(1)} km</span>` : `<span class="chip violet">0 km</span>`}
      </div>
    `;

    list.appendChild(card);

    const nameEl = card.querySelector('[data-name]');
    if (nameEl){
      nameEl.addEventListener('input', () => {
        c.name = nameEl.textContent.trim() || `Curier ${c.id}`;
        renderAddresses();
        renderRouteSummary();
        redrawMap();
      });
    }

    const confirmBtn = card.querySelector(`[data-confirm="${c.id}"]`);
    if (confirmBtn) confirmBtn.addEventListener('click', () => confirmCourier(c.id));

    const startInput = card.querySelector('.start-input');
    const endInput = card.querySelector('.end-input');
    const departureInput = card.querySelector('.departure-input');
    const endlimitInput = card.querySelector('.endlimit-input');

    const onChange = () => {
      c.start.address = startInput.value.trim();
      c.end.address = endInput.value.trim();
      c.sameAsStart = !c.end.address;
      c.departureTime = normalizeTime(departureInput.value);
      c.endTimeLimit = endlimitInput.value.trim() ? normalizeTime(endlimitInput.value) : '';
      c.start.status = 'pending';
      c.end.status = 'pending';
      renderRouteSummary();
      redrawMap();
    };

    startInput.addEventListener('change', onChange);
    endInput.addEventListener('change', onChange);
    departureInput.addEventListener('change', onChange);
    endlimitInput.addEventListener('change', onChange);
  });
}

// -------------------------------------------------------------------
// ADDRESSES
// -------------------------------------------------------------------

function initAddressPanel(){
  const dz = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');

  if (dz && fileInput){
    dz.addEventListener('click', () => fileInput.click());
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('drag');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) handleFile(fileInput.files[0]);
    });
  }

  document.getElementById('addManualBtn')?.addEventListener('click', () => showManualAddForm());
  document.getElementById('geocodeBtn')?.addEventListener('click', () => geocodeAllPending());
}

function showEditAddressForm(addrId){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">Editează adresa</div>
      <div class="field">
        <label>Nume client</label>
        <input type="text" id="eaName" value="${escapeHtml(addr.clientName)}">
      </div>
      <div class="field">
        <label>Telefon</label>
        <input type="text" id="eaPhone" value="${escapeHtml(addr.phone)}">
      </div>
      <div class="field">
        <label>Adresă (oraș, stradă, nr)</label>
        <input type="text" id="eaAddress" value="${escapeHtml(addr.raw)}">
        <div class="small">Dacă schimbi adresa, poziția se va recalcua.</div>
      </div>
      <div class="field">
        <label>Detalii (bloc/scară/ap/interfon)</label>
        <input type="text" id="eaDetails" value="${escapeHtml(addr.details)}">
      </div>
      <div class="field-row">
        <div class="field">
          <label>Sumă (lei)</label>
          <input type="text" id="eaAmount" value="${addr.amount != null ? addr.amount : ''}">
        </div>
        <div class="field">
          <label>Metodă plată</label>
          <select id="eaPayment">
            ${PAYMENT_METHODS.map(m => `<option value="${m}" ${addr.paymentMethod === m ? 'selected' : ''}>${m}</option>`).join('')}
            ${addr.paymentMethod && !PAYMENT_METHODS.includes(addr.paymentMethod) ? `<option value="${escapeHtml(addr.paymentMethod)}" selected>${escapeHtml(addr.paymentMethod)}</option>` : ''}
          </select>
        </div>
      </div>
      <div class="field">
        <label>Notă client</label>
        <input type="text" id="eaNote" value="${escapeHtml(addr.customerNote)}">
      </div>
      <div style="display:flex; gap:8px; margin-top:14px;">
        <button class="btn btn-secondary btn-sm" id="eaCancelBtn" style="flex:1;">Anulează</button>
        <button class="btn btn-primary btn-sm" id="eaSaveBtn" style="flex:1;">Salvează</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('eaCancelBtn').addEventListener('click', close);
  document.getElementById('eaSaveBtn').addEventListener('click', async () => {
    addr.clientName = document.getElementById('eaName').value.trim();
    const split = splitClientName(addr.clientName);
    addr.firstName = split.firstName;
    addr.lastName = split.lastName;
    addr.phone = document.getElementById('eaPhone').value.trim();
    addr.details = document.getElementById('eaDetails').value.trim();
    addr.amount = parseAmount(document.getElementById('eaAmount').value);
    addr.paymentMethod = normalizePaymentMethod(document.getElementById('eaPayment').value);
    addr.customerNote = document.getElementById('eaNote').value.trim();

    const newRaw = document.getElementById('eaAddress').value.trim();
    if (newRaw && newRaw !== addr.raw){
      addr.raw = /rom[aâ]nia/i.test(newRaw) ? newRaw : `${newRaw}, România`;
      addr.status = 'pending';
      addr.lat = null;
      addr.lng = null;
      addr.confidence = '';
      addr.outOfArea = false;
    }

    close();
    renderAddresses();
    renderRouteSummary();
    redrawMap();
    await geocodeAllPending();
  });
}

function showManualAddForm(){
  const picker = document.getElementById('columnPicker');
  if (!picker) return;
  picker.style.display = 'block';
  picker.innerHTML = `
    <div style="margin-bottom:8px; font-weight:600; color:var(--ink); font-size:12.5px;">Adaugă adresă manual</div>
    <div class="field">
      <label>Nume client</label>
      <input type="text" id="maName" placeholder="ex: Ana Popescu">
    </div>
    <div class="field">
      <label>Telefon</label>
      <input type="text" id="maPhone" placeholder="ex: 07xx xxx xxx">
    </div>
    <div class="field">
      <label>Adresă (oraș, stradă, nr)</label>
      <input type="text" id="maAddress" placeholder="ex: Cluj-Napoca, Str. Mihai Eminescu, 10">
    </div>
    <div class="field">
      <label>Detalii (bloc/scară/ap/interfon)</label>
      <input type="text" id="maDetails" placeholder="ex: Bloc A2, et 3, ap 12, interfon 12">
    </div>
    <div class="field-row">
      <div class="field">
        <label>Sumă (lei)</label>
        <input type="text" id="maAmount" placeholder="ex: 150">
      </div>
      <div class="field">
        <label>Metodă plată</label>
        <select id="maPayment">
          ${PAYMENT_METHODS.map(m => `<option value="${m}">${m}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field">
      <label>Notă client</label>
      <input type="text" id="maNote" placeholder="ex: sună înainte de livrare">
    </div>
    <div style="display:flex; gap:8px; margin-top:6px;">
      <button class="btn btn-secondary btn-sm" id="maCancelBtn" style="flex:1;">Anulează</button>
      <button class="btn btn-primary btn-sm" id="maConfirmBtn" style="flex:1;">Adaugă</button>
    </div>
  `;

  document.getElementById('maCancelBtn').addEventListener('click', () => { picker.style.display = 'none'; });
  document.getElementById('maConfirmBtn').addEventListener('click', () => {
    const name = document.getElementById('maName').value.trim();
    const phone = document.getElementById('maPhone').value.trim();
    const addressInput = document.getElementById('maAddress').value.trim();
    if (!addressInput){
      showToast('Adresa este obligatorie.', true);
      return;
    }

    const address = /rom[aâ]nia/i.test(addressInput) ? addressInput : `${addressInput}, România`;
    addAddress({
      raw: address,
      clientName: name,
      phone,
      details: document.getElementById('maDetails').value.trim(),
      amount: parseAmount(document.getElementById('maAmount').value),
      paymentMethod: document.getElementById('maPayment').value,
      customerNote: document.getElementById('maNote').value.trim(),
      status: 'pending',
      courierId: null
    });
    picker.style.display = 'none';
    renderAddresses();
    renderRouteSummary();
    redrawMap();
  });
}

function addAddress(data){
  const fullName = String(data.clientName || '').trim();
  const split = splitClientName(fullName);

  const addr = {
    id: state.nextAddrId++,
    raw: String(data.raw || '').trim(),
    details: String(data.details || '').trim(),
    clientName: fullName,
    firstName: split.firstName,
    lastName: split.lastName,
    phone: String(data.phone || '').trim(),
    amount: parseAmount(data.amount),
    paymentMethod: normalizePaymentMethod(data.paymentMethod),
    lat: null,
    lng: null,
    status: data.status || 'pending',
    confidence: '',
    outOfArea: false,
    courierId: data.courierId || null,
    orderNumber: data.orderNumber || '',
    customerNote: String(data.customerNote || '').trim(),
    deliveryWindow: '',
    deliveryWindowStart: '',
    deliveryWindowEnd: '',
    manuallyAdjusted: false
  };

  state.addresses.push(addr);
  return addr;
}

function renderAddresses(){
  const list = document.getElementById('addrList');
  if (!list) return;

  if (!state.addresses.length){
    list.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">▦</div>
        <div class="es-title">Nicio adresă încărcată</div>
        <div class="es-sub">Importă un fișier CSV/Excel sau adaugă manual</div>
      </div>`;
    return;
  }

  list.innerHTML = '';
  state.addresses.forEach((a) => {
    const item = document.createElement('div');
    item.className = 'addr-item';
    item.draggable = true;
    item.dataset.id = a.id;

    let statusHtml = '';
    if (a.status === 'pending') statusHtml = `<div class="addr-status">în așteptare</div>`;
    else if (a.status === 'ok'){
      if (a.manuallyAdjusted && a.outOfArea){
        statusHtml = `<div class="addr-status warn">⚠ poziție în afara zonei București/Ilfov <button class="addr-locate-btn" data-locate="${a.id}">verifică pe hartă</button></div>`;
      } else if (a.manuallyAdjusted){
        statusHtml = `<div class="addr-status ok">✓ poziție ajustată manual</div>`;
      } else if (a.confidence === 'high'){
        statusHtml = `<div class="addr-status ok">✓ localizată precis</div>`;
      } else if (a.confidence === 'medium'){
        statusHtml = `<div class="addr-status warn">⚠ aproximativ (nivel stradă) <button class="addr-locate-btn" data-locate="${a.id}">verifică pe hartă</button></div>`;
      } else {
        statusHtml = `<div class="addr-status warn">⚠ incert (nivel zonă) <button class="addr-locate-btn" data-locate="${a.id}">verifică pe hartă</button></div>`;
      }
    } else if (a.status === 'error'){
      statusHtml = a.outOfArea
        ? `<div class="addr-status err">✕ în afara zonei (București/Ilfov) <button class="addr-action-link" data-edit="${a.id}" style="font-size:10.5px;">corectează</button></div>`
        : `<div class="addr-status err">✕ neidentificată</div>`;
    }

    const courier = state.couriers.find(c => c.id === a.courierId);
    const deliveryWindowHtml = a.deliveryWindow ? `<span class="chip orange">${escapeHtml(a.deliveryWindow)}</span>` : '';

    item.innerHTML = `
      <div class="addr-main">
        <div class="addr-title">
          <span class="chip">${escapeHtml(a.orderNumber || a.id)}</span>
          <span class="addr-client">${escapeHtml(a.clientName || '—')}</span>
        </div>
        <div class="small">${escapeHtml(a.phone || '')}</div>
        <div class="addr-sub">${escapeHtml(a.raw || '')}</div>
        ${a.details ? `<div class="addr-note">${escapeHtml(a.details)}</div>` : ''}
        <div class="addr-meta">
          <span class="chip">${escapeHtml(a.paymentMethod || '—')}</span>
          <span class="chip">${Number(a.amount || 0).toFixed(0)} lei</span>
          ${deliveryWindowHtml}
          ${a.status === 'ok' ? `<span class="chip green">${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}</span>` : ''}
        </div>
        ${a.customerNote ? `<div class="addr-note">${escapeHtml(a.customerNote)}</div>` : ''}
        ${courier ? `<div class="addr-note">Curier: ${escapeHtml(courier.name)}</div>` : ''}
        ${statusHtml}
      </div>

      <div class="addr-actions">
        <button class="btn btn-secondary btn-sm" data-edit="${a.id}">Editează</button>
        <select class="addr-courier-select" data-courier="${a.id}">
          <option value="">— nerepartizat —</option>
          ${state.couriers.map(c => `<option value="${c.id}" ${c.id === a.courierId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
        <button class="btn btn-secondary btn-sm" data-geo="${a.id}">Re-geocodare</button>
      </div>
    `;

    list.appendChild(item);
  });

  document.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => showEditAddressForm(Number(btn.dataset.edit)));
  });

  document.querySelectorAll('[data-courier]').forEach(sel => {
    sel.addEventListener('change', () => {
      const addr = state.addresses.find(x => x.id === Number(sel.dataset.courier));
      if (!addr) return;
      addr.courierId = sel.value ? Number(sel.value) : null;
      syncRouteState();
      renderCouriers();
      renderAddresses();
      renderRouteSummary();
      redrawMap();
    });
  });

  document.querySelectorAll('[data-geo]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const addr = state.addresses.find(x => x.id === Number(btn.dataset.geo));
      await geocodeOne(addr);
      renderAddresses();
      renderRouteSummary();
      redrawMap();
    });
  });

  document.querySelectorAll('[data-locate]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const addr = state.addresses.find(x => x.id === Number(btn.dataset.locate));
      if (!addr) return;
      await geocodeOne(addr);
      renderAddresses();
      redrawMap();
    });
  });
}

function updateAddressWindow(addr, courier){
  const base = normalizeTime(courier.departureTime || '10:00');
  const idx = (state.routes[courier.id]?.order || []).indexOf(addr.id);
  const minutes = 30 + Math.max(0, idx) * 20;
  const arrival = addMinutes(base, minutes);
  const start = roundDownToHour(arrival);
  addr.deliveryWindowStart = start;
  addr.deliveryWindowEnd = addMinutes(start, 120);
  addr.deliveryWindow = `${addr.deliveryWindowStart} - ${addr.deliveryWindowEnd}`;
}

function syncRouteState(){
  state.couriers.forEach(c => {
    if (!state.routes[c.id]) return;
    state.routes[c.id].order = state.addresses.filter(a => a.courierId === c.id).map(a => a.id);
    computeRouteStats(c.id);
  });
}

// -------------------------------------------------------------------
// GEO
// -------------------------------------------------------------------

function normalizeCityForGeocoding(city){
  const c = String(city || '').trim();
  if (!c) return '';
  if (/^sector\s*\d+$/i.test(c) && !/bucure/i.test(c)) return `${c}, București`;
  return c;
}

function normalizeTime(v){
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

function buildAddressVariants(address){
  const raw = String(address || '').trim();
  const city = normalizeCityForGeocoding(extractCityFromRaw(raw));
  const noRomania = raw.replace(/,\s*rom[aâ]nia\s*$/i, '').trim();
  const variants = [noRomania];
  if (city && !/^sector\s*\d+$/i.test(city)) variants.unshift(noRomania.includes(city) ? noRomania : `${city}, ${noRomania}`);
  if (!/rom[aâ]nia/i.test(noRomania)) variants.push(`${noRomania}, România`);
  if (city && !/rom[aâ]nia/i.test(noRomania)) variants.push(`${city}, România`);
  return [...new Set(variants.filter(Boolean))];
}

function extractCityFromRaw(raw){
  const parts = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
  return parts[0] || '';
}

function scoreResultConfidence(item){
  const text = String(item.display_name || '').toLowerCase();
  if (text.includes('romania') || text.includes('românia')) return 'high';
  if (text.includes('bucuresti') || text.includes('ilfov')) return 'medium';
  return 'low';
}

function isWithinServiceArea(lat, lng){
  return lat >= 44.0 && lat <= 45.8 && lng >= 25.7 && lng <= 26.5;
}

async function geocodeOne(address){
  if (!address) return null;

  const key = address.raw || address;
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const variants = address.raw ? buildAddressVariants(address.raw) : buildAddressVariants(address);
  let bestResult = null;
  let sawOutOfAreaResult = false;

  for (const variant of variants){
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&countrycodes=ro&q=${encodeURIComponent(variant)}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'ro' } });
      const data = await res.json();
      if (data && data.length){
        const lat = parseFloat(data[0].lat);
        const lng = parseFloat(data[0].lon);

        if (!isWithinServiceArea(lat, lng)){
          sawOutOfAreaResult = true;
          continue;
        }

        const confidence = scoreResultConfidence(data[0]);
        const result = {
          lat, lng,
          confidence,
          matchedQuery: variant,
          displayName: data[0].display_name || ''
        };
        if (confidence === 'high'){
          bestResult = result;
          break;
        }
        if (!bestResult) bestResult = result;
      }
    } catch (err) {
      console.warn('Geocode error', err);
    }
  }

  if (bestResult){
    if (address.raw) {
      address.lat = bestResult.lat;
      address.lng = bestResult.lng;
      address.status = 'ok';
      address.confidence = bestResult.confidence;
      address.outOfArea = false;
    }
    geocodeCache.set(key, bestResult);
    return bestResult;
  }

  const result = sawOutOfAreaResult ? { outOfArea: true } : null;
  if (address.raw) {
    address.status = 'error';
    address.outOfArea = !!sawOutOfAreaResult;
  }
  geocodeCache.set(key, result);
  return result;
}

async function geocodeAllPending(){
  const pending = state.addresses.filter(a => a.status !== 'ok');
  if (!pending.length){
    showToast('Nu există adrese de localizat.');
    return;
  }

  showToast('Se localizează adresele…');
  for (const addr of pending){
    await geocodeOne(addr);
    renderAddresses();
    renderRouteSummary();
    redrawMap();
    await sleep(1000);
  }
  updateMapTopBar();
  showToast('Localizarea s-a terminat.');
}

async function ensureAllCourierPointsGeocoded(){
  for (const courier of state.couriers){
    for (const key of ['start', 'end']){
      const point = courier[key];
      if (point.address && point.status === 'pending'){
        const result = await geocodeOne(point.address);
        if (result && !result.outOfArea){
          point.lat = result.lat;
          point.lng = result.lng;
          point.status = 'ok';
        } else if (result && result.outOfArea){
          point.status = 'error';
        } else {
          point.status = 'error';
        }
      }
    }
  }
}

// -------------------------------------------------------------------
// IMPORT
// -------------------------------------------------------------------

function handleFile(file){
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'csv'){
    const reader = new FileReader();
    reader.onload = e => parseImportedWorkbook(XLSX.read(e.target.result, { type:'string' }));
    reader.readAsText(file);
    return;
  }
  const reader = new FileReader();
  reader.onload = e => parseImportedWorkbook(XLSX.read(new Uint8Array(e.target.result), { type:'array' }));
  reader.readAsArrayBuffer(file);
}

function parseAmount(v){
  const n = parseFloat(String(v || '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function splitClientName(fullName){
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

function parseImportedWorkbook(wb){
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  state.addresses = rows.map(r => {
    const firstName = String(r['First Name (Shipping)'] || '').trim();
    const lastName = String(r['Last Name (Shipping)'] || '').trim();
    const clientName = [firstName, lastName].filter(Boolean).join(' ').trim();
    const raw = buildImportedRawAddress(r['City (Shipping)'], r['Strada'], r['Nr']);
    return {
      id: state.nextAddrId++,
      raw,
      details: String(r['Detalii'] || '').trim(),
      clientName,
      firstName,
      lastName,
      phone: String(r['Phone (Billing)'] || '').trim(),
      amount: parseAmount(r['Order Total Amount']),
      paymentMethod: normalizePaymentMethod(r['Payment Method Title']),
      lat: null,
      lng: null,
      status: 'pending',
      confidence: '',
      outOfArea: false,
      courierId: null,
      orderNumber: String(r['Order Number'] || '').trim(),
      customerNote: String(r['Customer Note'] || '').trim(),
      deliveryWindow: '',
      deliveryWindowStart: '',
      deliveryWindowEnd: '',
      manuallyAdjusted: false
    };
  });

  renderAddresses();
  renderRouteSummary();
  redrawMap();
  updateMapTopBar();
  showToast(`Importate ${state.addresses.length} adrese.`);
}

function buildImportedRawAddress(city, street, nr){
  const c = normalizeCityForGeocoding(city);
  const parts = [c, String(street || '').trim(), String(nr || '').trim()].filter(Boolean);
  let raw = parts.join(', ');
  if (!/rom[aâ]nia/i.test(raw)) raw += ', România';
  return raw;
}

function normalizePaymentMethod(v){
  const s = String(v || '').toLowerCase();
  if (s.includes('revolut')) return 'Revolut';
  if (s.includes('op')) return 'OP';
  if (s.includes('ramburs')) return 'Ramburs';
  return String(v || '').trim();
}

// -------------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------------

function initRoutePanel(){
  document.getElementById('autoAssignBtn')?.addEventListener('click', runAutoAssignAndRoute);
}

async function runAutoAssignAndRoute(){
  const geocodedAddrs = state.addresses.filter(a => a.status === 'ok');
  if (!geocodedAddrs.length){
    showToast('Nu există adrese localizate. Importă și geocodează mai întâi.', true);
    return;
  }

  await ensureAllCourierPointsGeocoded();

  const validCouriers = state.couriers.filter(c => c.start.status === 'ok');
  const invalidCouriers = state.couriers.filter(c => c.start.status !== 'ok');

  if (!validCouriers.length){
    showToast('Niciun curier nu are un punct de plecare valid. Completează adresa și încearcă din nou.', true);
    return;
  }
  if (invalidCouriers.length){
    const names = invalidCouriers.map(c => c.name).join(', ');
    showToast(`${names} ${invalidCouriers.length === 1 ? 'nu are' : 'nu au'} punct de plecare valid — exclus din repartizare.`, true);
  }

  showToast('Se repartizează adresele…');

  // assign round-robin over valid couriers
  state.routes = {};
  validCouriers.forEach(c => {
    state.routes[c.id] = { order: [], legs: [], totalKm: 0, totalMin: 0 };
  });

  const unassigned = geocodedAddrs.slice();
  validCouriers.forEach((c, idx) => {
    const perCourier = Math.ceil(unassigned.length / validCouriers.length);
    const slice = unassigned.splice(0, perCourier);
    slice.forEach(a => {
      a.courierId = c.id;
      state.routes[c.id].order.push(a.id);
    });
  });

  for (const c of validCouriers){
    await optimizeCourierRoute(c.id);
  }

  computeAllDeliveryWindows();
  syncRouteState();
  renderCouriers();
  renderAddresses();
  renderRouteSummary();
  redrawMap();
  updateMapTopBar();
  showToast('Repartizarea a fost finalizată.');
}

async function optimizeCourierRoute(courierId){
  const route = state.routes[courierId];
  if (!route) return;
  const courier = state.couriers.find(c => c.id === courierId);
  const stops = route.order.map(id => state.addresses.find(a => a.id === id)).filter(Boolean);

  if (!stops.length){
    route.legs = [];
    route.totalKm = 0;
    route.totalMin = 0;
    return;
  }

  // Keep existing order if OSRM isn't available or route is short; simple sort by coords otherwise
  stops.sort((a, b) => (a.lat || 0) - (b.lat || 0));
  route.order = stops.map(a => a.id);

  let totalKm = 0;
  let totalMin = 0;
  route.legs = stops.map((a, i) => {
    const prev = i === 0 ? courier.start : stops[i - 1];
    const leg = estimateLeg(prev, a);
    totalKm += leg.distKm;
    totalMin += leg.durMin;
    return leg;
  });

  route.totalKm = totalKm;
  route.totalMin = totalMin;
}

function estimateLeg(a, b){
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null){
    return { distKm: 0, durMin: 0 };
  }
  const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
  const min = km / 30 * 60;
  return { distKm: km, durMin: min };
}

function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function computeAllDeliveryWindows(){
  state.couriers.forEach(c => {
    const route = state.routes[c.id];
    if (!route) return;

    let current = normalizeTime(c.departureTime || '10:00') || '10:00';
    route.order.forEach((addrId, idx) => {
      const addr = state.addresses.find(a => a.id === addrId);
      if (!addr) return;
      const travelMins = 30 + idx * 20;
      const arrival = addMinutes(current, travelMins + 10);
      const start = roundDownToHour(arrival);
      addr.deliveryWindowStart = start;
      addr.deliveryWindowEnd = addMinutes(start, 120);
      addr.deliveryWindow = `${addr.deliveryWindowStart} - ${addr.deliveryWindowEnd}`;
      current = arrival;
    });
  });
}

function computeRouteStats(courierId){
  const route = state.routes[courierId];
  if (!route) return;
  const assigned = route.order.map(id => state.addresses.find(a => a.id === id)).filter(Boolean);
  route.totalKm = route.totalKm || 0;
  route.totalMin = route.totalMin || 0;
  route.cashTotal = assigned.filter(a => a.paymentMethod === 'Ramburs').reduce((s, a) => s + (a.amount || 0), 0);
  assigned.forEach(a => {
    const courier = state.couriers.find(c => c.id === courierId);
    if (courier) updateAddressWindow(a, courier);
  });
}

function renderRouteSummary(){
  const container = document.getElementById('routeSummary');
  if (!container) return;

  const hasAny = Object.keys(state.routes).length > 0;
  if (!hasAny){
    container.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">→</div>
        <div class="es-title">Niciun traseu generat</div>
        <div class="es-sub">Adaugă curieri și adrese, apoi repartizează</div>
      </div>`;
    return;
  }

  container.innerHTML = '';
  state.couriers.forEach(c => {
    const route = state.routes[c.id];
    if (!route) return;

    const assignedAddrs = route.order.map(id => state.addresses.find(a => a.id === id)).filter(Boolean);
    const totalToCollect = assignedAddrs.reduce((sum, a) => sum + (a.amount || 0), 0);
    const cashToCollect = assignedAddrs
      .filter(a => a.paymentMethod === 'Ramburs')
      .reduce((sum, a) => sum + (a.amount || 0), 0);

    const block = document.createElement('div');
    block.style.marginBottom = '18px';
    block.innerHTML = `
      <div style="display:flex; align-items:center; gap:7px; margin-bottom:4px;">
        <span class="courier-dot" style="background:${c.color}"></span>
        <span style="font-weight:600; font-size:14px;">${escapeHtml(c.name)}</span>
      </div>
      <div class="route-stats">
        <span class="chip">${assignedAddrs.length} stopuri</span>
        <span class="chip violet">${route.totalKm.toFixed(1)} km</span>
        <span class="chip green">${route.totalMin.toFixed(0)} min</span>
        <span class="chip orange">${totalToCollect.toFixed(0)} lei</span>
        <span class="chip red">${cashToCollect.toFixed(0)} lei cash</span>
      </div>
    `;

    assignedAddrs.forEach((a, idx) => {
      const row = document.createElement('div');
      row.className = 'addr-item';
      row.style.marginTop = '8px';
      row.innerHTML = `
        <div class="addr-main">
          <div class="addr-title">
            <span class="chip">${idx + 1}</span>
            <span class="addr-client">${escapeHtml(a.clientName)}</span>
          </div>
          <div class="small">${escapeHtml(a.phone || '')}</div>
          <div class="addr-sub">${escapeHtml(a.raw || '')}</div>
          ${a.details ? `<div class="addr-note">${escapeHtml(a.details)}</div>` : ''}
          <div class="addr-meta">
            <span class="chip">${escapeHtml(a.paymentMethod || '')}</span>
            <span class="chip">${Number(a.amount || 0).toFixed(0)} lei</span>
            ${a.deliveryWindow ? `<span class="chip orange">${escapeHtml(a.deliveryWindow)}</span>` : ''}
          </div>
          ${a.customerNote ? `<div class="addr-note">${escapeHtml(a.customerNote)}</div>` : ''}
        </div>
      `;
      block.appendChild(row);
    });

    container.appendChild(block);
  });
}

// -------------------------------------------------------------------
// MAP RENDER
// -------------------------------------------------------------------

function redrawMap(){
  if (!markersLayer || !routeLinesLayer) return;
  markersLayer.clearLayers();
  routeLinesLayer.clearLayers();

  const legend = document.getElementById('mapLegend');
  let legendHtml = '';
  const allPoints = [];

  state.couriers.forEach(c => {
    const route = state.routes[c.id];

    if (c.start.status === 'ok'){
      const m = L.circleMarker([c.start.lat, c.start.lng], {
        radius: 8, color: '#fff', weight: 2, fillColor: c.color, fillOpacity: 1
      }).addTo(markersLayer);
      m.bindPopup(`<div class="stop-popup"><div class="sp-title">${escapeHtml(c.name)} — start</div><div class="sp-meta">${escapeHtml(c.start.address)}</div></div>`);
      allPoints.push([c.start.lat, c.start.lng]);
    }

    if (!c.sameAsStart && c.end.status === 'ok'){
      const m = L.circleMarker([c.end.lat, c.end.lng], {
        radius: 8, color: c.color, weight: 2, fillColor: '#fff', fillOpacity: 1
      }).addTo(markersLayer);
      m.bindPopup(`<div class="stop-popup"><div class="sp-title">${escapeHtml(c.name)} — final</div><div class="sp-meta">${escapeHtml(c.end.address)}</div></div>`);
      allPoints.push([c.end.lat, c.end.lng]);
    }

    if (route){
      const pts = route.order.map(id => state.addresses.find(a => a.id === id)).filter(a => a && a.lat && a.lng);
      pts.forEach((a, i) => {
        const m = L.circleMarker([a.lat, a.lng], {
          radius: 7,
          color: c.color,
          weight: 2,
          fillColor: c.color,
          fillOpacity: 1
        }).addTo(markersLayer);

        const stopIdx = i + 1;
        m.bindPopup(`
          <div class="stop-popup">
            <div class="sp-title">${escapeHtml(c.name)} · stop ${stopIdx}</div>
            <div class="sp-meta">${escapeHtml(a.clientName || '')}</div>
            <div class="sp-meta">${escapeHtml(a.phone || '')}</div>
            <div class="sp-meta">${escapeHtml(a.raw || '')}</div>
            ${a.details ? `<div class="sp-meta">${escapeHtml(a.details)}</div>` : ''}
            <div class="sp-meta">${escapeHtml(a.paymentMethod || '')} · ${Number(a.amount || 0).toFixed(0)} lei</div>
            ${a.deliveryWindow ? `<div class="sp-meta">${escapeHtml(a.deliveryWindow)}</div>` : ''}
          </div>
        `);

        allPoints.push([a.lat, a.lng]);

        if (i > 0){
          const prev = pts[i - 1];
          L.polyline([[prev.lat, prev.lng], [a.lat, a.lng]], {
            color: c.color,
            weight: 4,
            opacity: .9
          }).addTo(routeLinesLayer);
        }
      });
    }
  });

  if (legend){
    legendHtml = state.couriers.map(c => `<span class="legend-item"><span class="legend-dot" style="background:${c.color}"></span>${escapeHtml(c.name)}</span>`).join('');
    legend.innerHTML = legendHtml;
  }

  if (allPoints.length){
    const bounds = L.latLngBounds(allPoints);
    map.fitBounds(bounds, { padding: [30, 30] });
  }

  updateMapTopBar();
}

// -------------------------------------------------------------------
// EXPORT / ACTIONS
// -------------------------------------------------------------------

function initActionBar(){
  document.getElementById('resetBtn')?.addEventListener('click', () => {
    if (!confirm('Sigur vrei să resetezi tot? Se vor șterge curierii, adresele și traseele.')) return;
    state.couriers = [];
    state.addresses = [];
    state.routes = {};
    state.nextCourierId = 1;
    state.nextAddrId = 1;
    geocodeCache = new Map();
    addCourier();
    renderCouriers();
    renderAddresses();
    renderRouteSummary();
    redrawMap();
    const exp = document.getElementById('exportBtn');
    if (exp) exp.disabled = false;
    const gs = document.getElementById('geocodeSection');
    if (gs) gs.style.display = 'none';
    map.setView([45.9432, 24.9668], 7);
  });

  document.getElementById('exportBtn')?.addEventListener('click', exportRoutesXlsx);
}

function exportRoutesXlsx(){
  const rows = [];
  const all = state.routes && Object.keys(state.routes).length
    ? state.couriers.flatMap(c => (state.routes[c.id]?.order || []).map(id => ({ addr: state.addresses.find(a => a.id === id), courier: c }))).filter(x => x.addr)
    : state.addresses.map(a => ({ addr: a, courier: state.couriers.find(c => c.id === a.courierId) || state.couriers[0] }));

  all.forEach((x, idx) => {
    const { firstName, lastName } = splitClientName(x.addr.clientName);
    rows.push({
      'Curier': x.courier ? x.courier.name : '',
      'Interval Livrare': x.addr.deliveryWindow || '',
      'Nr. Comanda': x.addr.orderNumber || (idx + 1),
      'First Name': firstName,
      'Last Name': lastName,
      'Phone': x.addr.phone || '',
      'Adresa': x.addr.raw || '',
      'Detalii': x.addr.details || '',
      'Payment Method Title': x.addr.paymentMethod || '',
      'Order Total Amount': x.addr.amount || 0,
      'Customer Note': x.addr.customerNote || ''
    });
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  XLSX.writeFile(wb, 'trasee_curieri.xlsx');
}

// -------------------------------------------------------------------
// UTILS
// -------------------------------------------------------------------

function addMinutes(time, mins){
  const [h, m] = String(time || '00:00').split(':').map(Number);
  const d = new Date();
  d.setHours(h || 0, (m || 0) + mins, 0, 0);
  return d.toTimeString().slice(0, 5);
}

function roundDownToHour(time){
  const [h] = String(time || '00:00').split(':').map(Number);
  return `${String(h || 0).padStart(2, '0')}:00`;
}

function sleep(ms){
  return new Promise(r => setTimeout(r, ms));
}

function escapeHtml(str){
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
