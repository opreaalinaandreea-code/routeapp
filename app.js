// ===================================================================
// Planificator trasee curieri — logică principală
// Geocodare: Nominatim (OpenStreetMap) · Rutare: OSRM (router.project-osrm.org)
// ===================================================================

const COURIER_COLORS = ['#FF5A1F', '#8B5CF6', '#1D7FBF', '#2D6A4F', '#C2347E', '#B8860B'];

const state = {
  couriers: [],      // {id, name, start:{address,lat,lng}, end:{address,lat,lng}, color}
  addresses: [],      // {id, raw, details, clientName, phone, amount, paymentMethod, lat, lng, status:'pending'|'ok'|'error', courierId:null}
  routes: {},         // courierId -> {order:[addressId...], legs:[{distKm,durMin}], totalKm, totalMin}
  nextCourierId: 1,
  nextAddrId: 1,
};

const PAYMENT_METHODS = ['Ramburs', 'Revolut', 'OP'];

let map, markersLayer, routeLinesLayer;

// -------------------------------------------------------------------
// INIT
// -------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initTabs();
  initCourierPanel();
  initAddressPanel();
  initRoutePanel();
  initActionBar();
  setDateStamp();
  addCourier(); // start with one courier by default
});

function setDateStamp(){
  const d = new Date();
  const fmt = d.toLocaleDateString('ro-RO', { weekday:'long', day:'numeric', month:'long' });
  document.getElementById('dateStamp').textContent = `Manifest de livrare · ${fmt}`;
}

function showToast(msg, isError=false){
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

// -------------------------------------------------------------------
// MAP
// -------------------------------------------------------------------
function initMap(){
  map = L.map('map', { zoomControl:true }).setView([44.4323, 26.1063], 11); // Bucuresti/Ilfov implicit
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap, © CARTO'
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  routeLinesLayer = L.layerGroup().addTo(map);
}

function updateMapTopBar(){
  const geocoded = state.addresses.filter(a => a.status === 'ok').length;
  document.getElementById('mapSub').textContent = `${geocoded} adrese · ${state.couriers.length} curieri`;
  const hasRoutes = Object.keys(state.routes).length > 0;
  document.getElementById('mapTitle').textContent = hasRoutes ? 'Trasee active' : 'Niciun traseu activ';
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
      document.getElementById(tab.dataset.panel).classList.add('active');
    });
  });
}

function switchToTab(panelId){
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.panel === panelId));
  document.querySelectorAll('.panel').forEach(p => p.toggle('active', p.id === panelId));
}

// -------------------------------------------------------------------
// COURIERS
// -------------------------------------------------------------------
function initCourierPanel(){
  document.getElementById('addCourierBtn').addEventListener('click', () => {
    addCourier();
    renderCouriers();
  });
}

function addCourier(){
  const id = state.nextCourierId++;
  const color = COURIER_COLORS[(id - 1) % COURIER_COLORS.length];
  state.couriers.push({
    id,
    name: `Curier ${id}`,
    start: { address: '', lat: null, lng: null, status: 'pending' },
    end: { address: '', lat: null, lng: null, status: 'pending' },
    sameAsStart: true,
    departureTime: '10:00',
    endTimeLimit: '',       
    confirmed: false,       
    color
  });
  renderCouriers();
}

function removeCourier(id){
  state.couriers = state.couriers.filter(c => c.id !== id);
  state.addresses.forEach(a => { if (a.courierId === id) a.courierId = null; });
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
  if (btn){ btn.disabled = true; btn.textContent = 'Se validează…'; }

  for (const pointKey of ['start', 'end']){
    const point = courier[pointKey];
    if (point.address && point.status === 'pending'){
      const result = await geocodeOne(point.address);
      if (result){
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
  else if (courier.start.status === 'error') errors.push('punctul de plecare nu a putut fi localizat');
  if (!courier.sameAsStart){
    if (!courier.end.address) errors.push('punctul de finalizare');
    else if (courier.end.status === 'error') errors.push('punctul de finalizare nu a putut fi localizat');
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
}

function renderCouriers(){
  const list = document.getElementById('courierList');
  if(!list) return;
  document.getElementById('courierCount').textContent = state.couriers.length;
  list.innerHTML = '';

  state.couriers.forEach(c => {
    const card = document.createElement('div');
    card.className = 'courier-card';

    const assignedCount = state.addresses.filter(a => a.courierId === c.id).length;
    const route = state.routes[c.id];
    const assignedAddrs = state.addresses.filter(a => a.courierId === c.id);
    const totalToCollect = assignedAddrs.reduce((sum, a) => sum + (a.amount || 0), 0);

    card.innerHTML = `
      <div class="courier-head">
        <span class="courier-dot" style="background:${c.color}"></span>
        <input type="text" class="courier-name-input" value="${escapeHtml(c.name)}"
          style="border:none;background:none;font-weight:600;font-size:13.5px;flex:1;font-family:inherit;color:inherit;padding:2px 0;">
        ${c.confirmed ? '<span class="courier-confirmed-badge" title="Curier confirmat">✓ confirmat</span>' : ''}
        <button class="btn-icon" title="Șterge curier" data-remove="${c.id}">×</button>
      </div>
      <div class="courier-body">
        <div class="courier-point-block">
          <div class="field" style="margin-bottom:6px;">
            <label>Punct de plecare</label>
            <input type="text" class="start-input" data-courier="${c.id}" placeholder="ex: Depozit, Str. Industriilor 5, București" value="${escapeHtml(c.start.address)}">
          </div>
          <div class="field" style="margin-bottom:0; max-width:120px;">
            <label>Ora de plecare</label>
            <input type="text" class="departure-input" data-courier="${c.id}" placeholder="10:00" value="${escapeHtml(c.departureTime || '')}">
          </div>
        </div>

        <div class="courier-point-block">
          <div class="field" style="margin-bottom:6px;">
            <label style="display:flex; justify-content:space-between; align-items:center;">
              <span>Punct de finalizare</span>
              <span style="text-transform:none; font-weight:400; display:flex; align-items:center; gap:4px;">
                <input type="checkbox" data-same="${c.id}" ${c.sameAsStart ? 'checked' : ''} style="margin:0;"> identic cu plecarea
              </span>
            </label>
            <input type="text" class="end-input" data-courier="${c.id}" placeholder="ex: acasă, sediu, alt depozit"
              value="${escapeHtml(c.end.address)}" style="${c.sameAsStart ? 'display:none;' : ''}">
          </div>
          <div class="field" style="margin-bottom:0; max-width:140px;">
            <label>Ora limită (opțional)</label>
            <input type="text" class="endlimit-input" data-courier="${c.id}" placeholder="18:00" value="${escapeHtml(c.endTimeLimit || '')}">
          </div>
        </div>

        <button class="btn ${c.confirmed ? 'btn-confirmed' : 'btn-accent'} btn-block btn-sm" data-confirm="${c.id}" style="margin-bottom:10px;">
          ${c.confirmed ? '✓ Curier confirmat' : 'Confirmă curier'}
        </button>

        <div class="stat-row">
          <div class="stat">
            <span class="stat-num" style="color:${c.color}">${assignedCount}</span>
            <span class="stat-label">Adrese</span>
          </div>
          <div class="stat">
            <span class="stat-num">${route ? route.totalKm.toFixed(1) : '—'}</span>
            <span class="stat-label">Km traseu</span>
          </div>
          <div class="stat">
            <span class="stat-num">${route ? formatMinutes(route.totalMin) : '—'}</span>
            <span class="stat-label">Durată</span>
          </div>
        </div>
        ${totalToCollect > 0 ? `
        <div style="margin-top:8px; padding-top:8px; border-top:1px solid #cbd5e1; font-size:11.5px; font-family:'JetBrains Mono',monospace;">
          de încasat: <strong style="color:#1e293b;">${totalToCollect.toFixed(2)} lei</strong>
        </div>` : ''}
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => removeCourier(parseInt(btn.dataset.remove)));
  });
  list.querySelectorAll('[data-confirm]').forEach(btn => {
    btn.addEventListener('click', () => confirmCourier(parseInt(btn.dataset.confirm)));
  });
  list.querySelectorAll('.courier-name-input').forEach((input, i) => {
    input.addEventListener('change', () => {
      state.couriers[i].name = input.value || `Curier ${state.couriers[i].id}`;
      state.couriers[i].confirmed = false;
      renderCouriers();
      renderRouteSummary();
      redrawMap();
    });
  });
  list.querySelectorAll('.start-input').forEach(input => {
    input.addEventListener('change', () => onCourierAddressChange(input, 'start'));
  });
  list.querySelectorAll('.end-input').forEach(input => {
    input.addEventListener('change', () => onCourierAddressChange(input, 'end'));
  });
  list.querySelectorAll('[data-same]').forEach(cb => {
    cb.addEventListener('change', () => {
      const courier = state.couriers.find(c => c.id === parseInt(cb.dataset.same));
      courier.sameAsStart = cb.checked;
      courier.confirmed = false;
      renderCouriers();
    });
  });
  list.querySelectorAll('.departure-input').forEach(input => {
    input.addEventListener('change', () => {
      const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
      const normalized = normalizeTime(input.value);
      courier.departureTime = normalized;
      courier.confirmed = false;
      input.value = normalized;
      renderCouriers();
    });
  });
  list.querySelectorAll('.endlimit-input').forEach(input => {
    input.addEventListener('change', () => {
      const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
      const normalized = input.value.trim() ? normalizeTime(input.value) : '';
      courier.endTimeLimit = normalized;
      courier.confirmed = false;
      input.value = normalized;
      renderCouriers();
      renderRouteSummary(); 
    });
  });
}

async function onCourierAddressChange(input, which){
  const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
  const addr = input.value.trim();
  courier[which].address = addr;
  courier[which].lat = null;
  courier[which].lng = null;
  courier[which].status = 'pending';
  courier.confirmed = false;
  if (!addr){ renderCouriers(); return; }

  input.style.opacity = '0.6';
  const result = await geocodeOne(addr);
  input.style.opacity = '1';
  if (result){
    courier[which].lat = result.lat;
    courier[which].lng = result.lng;
    courier[which].status = 'ok';
  } else {
    courier[which].status = 'error';
    showToast(`Nu am putut localiza: "${addr}"`, true);
  }
  renderCouriers();
}

// -------------------------------------------------------------------
// ADDRESSES — import & management
// -------------------------------------------------------------------
function initAddressPanel(){
  const dz = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');

  if(dz && fileInput) {
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
