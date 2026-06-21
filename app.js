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
  }

  document.getElementById('addManualBtn').addEventListener('click', () => {
    showManualAddForm();
  });

  document.getElementById('geocodeBtn').addEventListener('click', () => geocodeAllPending());
}

function showEditAddressForm(addrId){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">Editează adresa</div>
      <div class="field" style="margin-bottom:7px;">
        <label>Nume client</label>
        <input type="text" id="eaName" value="${escapeHtml(addr.clientName)}">
      </div>
      <div class="field" style="margin-bottom:7px;">
        <label>Telefon</label>
        <input type="text" id="eaPhone" value="${escapeHtml(addr.phone)}">
      </div>
      <div class="field" style="margin-bottom:7px;">
        <label>Adresă (oraș, stradă, nr)</label>
        <input type="text" id="eaAddress" value="${escapeHtml(addr.raw)}">
      </div>
      <div class="field" style="margin-bottom:7px;">
        <label>Detalii (bloc/scară/ap/interfon)</label>
        <input type="text" id="eaDetails" value="${escapeHtml(addr.details)}">
      </div>
      <div class="field-row" style="margin-bottom:7px;">
        <div class="field">
          <label>Sumă (lei)</label>
          <input type="text" id="eaAmount" value="${addr.amount != null ? addr.amount : ''}">
        </div>
        <div class="field">
          <label>Metodă plată</label>
          <select id="eaPayment">
            ${PAYMENT_METHODS.map(m => `<option value="${m}" ${addr.paymentMethod === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="display:flex; gap:6px; margin-top:14px;">
        <button class="btn btn-secondary btn-sm" id="eaCancelBtn" style="flex:1;">Anulează</button>
        <button class="btn btn-primary btn-sm" id="eaSaveBtn" style="flex:1;">Salvează</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('eaAddress').focus();

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('eaCancelBtn').addEventListener('click', close);

  document.getElementById('eaSaveBtn').addEventListener('click', () => {
    const newAddressInput = document.getElementById('eaAddress').value.trim();
    if (!newAddressInput){
      showToast('Adresa este obligatorie.', true);
      return;
    }
    const newAddress = /rom[aâ]nia/i.test(newAddressInput) ? newAddressInput : `${newAddressInput}, România`;
    const addressChanged = newAddress !== addr.raw;

    addr.clientName = document.getElementById('eaName').value.trim();
    addr.phone = document.getElementById('eaPhone').value.trim();
    addr.details = document.getElementById('eaDetails').value.trim();
    addr.amount = parseAmount(document.getElementById('eaAmount').value);
    addr.paymentMethod = document.getElementById('eaPayment').value;
    addr.raw = newAddress;

    if (addressChanged){
      addr.lat = null;
      addr.lng = null;
      addr.status = 'pending';
      Object.keys(state.routes).forEach(courierId => {
        const route = state.routes[courierId];
        const i = route.order.indexOf(addr.id);
        if (i !== -1){
          route.order.splice(i, 1);
          if (route.order.length) recalcRouteDistance(parseInt(courierId));
          else delete state.routes[courierId];
        }
      });
    }

    close();
    renderAddresses();
    renderCouriers();
    renderRouteSummary();
    maybeShowGeocodeButton();
    redrawMap();
  });
}

function showManualAddForm(){
  const picker = document.getElementById('columnPicker');
  picker.style.display = 'block';
  picker.innerHTML = `
    <div style="margin-bottom:8px; font-weight:600; color:#1e293b; font-size:12.5px;">Adaugă adresă manual</div>
    <div class="field" style="margin-bottom:7px;">
      <label>Nume client</label>
      <input type="text" id="maName" placeholder="ex: Ana Popescu">
    </div>
    <div class="field" style="margin-bottom:7px;">
      <label>Telefon</label>
      <input type="text" id="maPhone" placeholder="ex: 07xx xxx xxx">
    </div>
    <div class="field" style="margin-bottom:7px;">
      <label>Adresă (oraș, stradă, nr)</label>
      <input type="text" id="maAddress" placeholder="ex: Str. Mihai Eminescu nr 10, Bucuresti">
    </div>
    <div class="field" style="margin-bottom:7px;">
      <label>Detalii (bloc/scară/ap)</label>
      <input type="text" id="maDetails" placeholder="ex: Bl. A, Ap. 12">
    </div>
    <div class="field-row" style="margin-bottom:7px;">
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
    <div style="display:flex; gap:6px; margin-top:4px;">
      <button class="btn btn-secondary btn-sm" id="maCancelBtn" style="flex:1;">Anulează</button>
      <button class="btn btn-primary btn-sm" id="maConfirmBtn" style="flex:1;">Adaugă</button>
    </div>
  `;
  document.getElementById('maAddress').focus();
  document.getElementById('maCancelBtn').addEventListener('click', () => { picker.style.display = 'none'; });
  document.getElementById('maConfirmBtn').addEventListener('click', () => {
    const addressInput = document.getElementById('maAddress').value.trim();
    if (!addressInput){
      showToast('Adresa este obligatorie.', true);
      return;
    }
    const address = /rom[aâ]nia/i.test(addressInput) ? addressInput : `${addressInput}, România`;
    addAddress({
      raw: address,
      details: document.getElementById('maDetails').value.trim(),
      clientName: document.getElementById('maName').value.trim(),
      phone: document.getElementById('maPhone').value.trim(),
      amount: parseAmount(document.getElementById('maAmount').value),
      paymentMethod: document.getElementById('maPayment').value
    });
    picker.style.display = 'none';
    renderAddresses();
    switchToTab('panel-adrese');
    maybeShowGeocodeButton();
  });
}

function handleFile(file){
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')){
    Papa.parse(file, {
      complete: res => onParsedRows(res.data),
      skipEmptyLines: true
    });
  } else if (name.endsWith('.xlsx') || name.endsWith('.xls')){
    const reader = new FileReader();
    reader.onload = e => {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type:'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header:1, defval:'' });
      onParsedRows(rows);
    };
    reader.readAsArrayBuffer(file);
  } else {
    showToast('Format neacceptat. Folosește CSV sau XLSX.', true);
  }
}

function onParsedRows(rows){
  if (!rows || !rows.length){
    showToast('Fișierul este gol.', true);
    return;
  }
  showColumnMapper(rows);
}

const FIELD_DEFS = [
  { key: 'orderNumber', label: 'Nr. Comandă', required: false, patterns: /order.?number|nr\.?\s*comand/i },
  { key: 'firstName', label: 'Prenume', required: false, patterns: /first.?name|prenume/i },
  { key: 'lastName', label: 'Nume', required: false, patterns: /last.?name|^nume$|de familie/i },
  { key: 'phone', label: 'Telefon', required: false, patterns: /phone|telefon|tel\b|mobil/i },
  { key: 'city', label: 'Oraș', required: false, patterns: /^city|ora[sș]|localitate/i },
  { key: 'street', label: 'Stradă', required: true, patterns: /^strada$|^street$|^stradă$/i },
  { key: 'number', label: 'Număr', required: false, patterns: /^nr\.?$|^number$|num[aă]r/i },
  { key: 'details', label: 'Detalii (bloc/scară/ap)', required: false, patterns: /detalii|detail|^bloc$|scar[aă]|interfon/i },
  { key: 'paymentMethod', label: 'Metodă de plată', required: false, patterns: /payment.?method|metod[aă].*plat[aă]|modalitate/i },
  { key: 'amount', label: 'Sumă de plată', required: false, patterns: /amount|total|sum[aă]|valoare|pret|preț/i },
];

function guessColumnMapping(header){
  const mapping = {};
  FIELD_DEFS.forEach(field => {
    const idx = header.findIndex(h => field.patterns.test(String(h)));
    mapping[field.key] = idx !== -1 ? idx : null;
  });
  return mapping;
}

function showColumnMapper(rows){
  const picker = document.getElementById('columnPicker');
  if(!picker) return;
  const looksLikeHeader = rows.length > 1 && rows[0].every(c => isNaN(parseFloat(c)) || c === '');
  const header = looksLikeHeader ? rows[0].map(h => String(h)) : rows[0].map((_, i) => `Coloana ${i+1}`);
  const guess = guessColumnMapping(header);

  const colOptions = (selectedIdx) => {
    let opts = `<option value="">— nefolosit —</option>`;
    header.forEach((h, i) => {
      opts += `<option value="${i}" ${i === selectedIdx ? 'selected' : ''}>${escapeHtml(h)}</option>`;
    });
    return opts;
  };

  picker.style.display = 'block';
  picker.innerHTML = `
    <div style="margin-bottom:8px; font-weight:600; color:#1e293b; font-size:12.5px;">Asociază coloanele din fișier</div>
    <label style="display:flex; align-items:center; gap:5px; margin-bottom:9px; font-weight:400;">
      <input type="checkbox" id="hasHeaderCb" ${looksLikeHeader ? 'checked' : ''}> prima linie este antet
    </label>
    ${FIELD_DEFS.map(field => `
      <div class="field" style="margin-bottom:7px;">
        <label>${field.label}${field.required ? ' *' : ''}</label>
        <select id="map_${field.key}" style="width:100%; padding:5px; border:1px solid #cbd5e1; border-radius:4px; font-size:13px;">
          ${colOptions(guess[field.key])}
        </select>
      </div>
    `).join('')}
    <button class="btn btn-primary btn-block btn-sm" id="confirmColBtn" style="margin-top:6px;">Importă ${rows.length - (looksLikeHeader ? 1 : 0)} rânduri</button>
  `;

  document.getElementById('confirmColBtn').addEventListener('click', () => {
    const hasHeader = document.getElementById('hasHeaderCb').checked;
    const startIdx = hasHeader ? 1 : 0;
    const colMap = {};
    FIELD_DEFS.forEach(field => {
      const val = document.getElementById(`map_${field.key}`).value;
      colMap[field.key] = val === '' ? null : parseInt(val);
    });

    if (colMap.street === null){
      showToast('Trebuie să selectezi coloana cu strada.', true);
      return;
    }

    const getCell = (row, key) => colMap[key] !== null ? String(row[colMap[key]] ?? '').trim() : '';

    let imported = 0;
    for (let i = startIdx; i < rows.length; i++){
      const row = rows[i];
      const firstName = getCell(row, 'firstName');
      const lastName = getCell(row, 'lastName');
      const clientName = [firstName, lastName].filter(Boolean).join(' ');
      const city = getCell(row, 'city') || 'Bucuresti';
      const streetRaw = getCell(row, 'street');
      const number = getCell(row, 'number');
      const details = getCell(row, 'details');

      if (!streetRaw) continue;

      const streetPart = [streetRaw, number].filter(Boolean).join(' ');
      const fullAddress = [streetPart, city, 'Romania'].filter(Boolean).join(', ');

      addAddress({
        orderNumber: getCell(row, 'orderNumber'),
        raw: fullAddress,
        details,
        clientName,
        phone: getCell(row, 'phone'),
        amount: colMap.amount !== null ? parseAmount(row[colMap.amount]) : null,
        paymentMethod: colMap.paymentMethod !== null ? normalizePaymentMethod(row[colMap.paymentMethod]) : ''
      });
      imported++;
    }

    picker.style.display = 'none';
    renderAddresses();
    switchToTab('panel-adrese');
    maybeShowGeocodeButton();
  });
}

function parseAmount(val){
  if (val === null || val === undefined || val === '') return null;
  const cleaned = String(val).replace(/[^\d.,-]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function normalizePaymentMethod(val){
  const str = String(val || '').trim();
  if (!str) return '';
  const lower = str.toLowerCase();
  const exact = PAYMENT_METHODS.find(m => m.toLowerCase() === lower);
  if (exact) return exact;
  const contains = PAYMENT_METHODS.find(m => lower.includes(m.toLowerCase()));
  if (contains) return contains;
  return str;
}

function addAddress(data){
  state.addresses.push({
    id: state.nextAddrId++,
    orderNumber: data.orderNumber || '',
    raw: data.raw,
    details: data.details || '',
    clientName: data.clientName || '',
    phone: data.phone || '',
    amount: data.amount ?? null,
    paymentMethod: data.paymentMethod || '',
    lat: null,
    lng: null,
    status: 'pending',
    courierId: null
  });
}

function maybeShowGeocodeButton(){
  const section = document.getElementById('geocodeSection');
  const btn = document.getElementById('geocodeBtn');
  const statusRow = document.getElementById('geocodeStatus');
  if(!section) return;
  const pending = state.addresses.filter(a => a.status === 'pending').length;

  if (pending > 0){
    section.style.display = 'block';
    statusRow.style.display = 'none';
    btn.style.display = 'block';
  } else {
    section.style.display = 'none';
  }
}

function renderAddresses(){
  const list = document.getElementById('addrList');
  if (!list) return;
  list.innerHTML = '';

  state.addresses.forEach(a => {
    const card = document.createElement('div');
    card.className = `address-card status-${a.status}`;

    let statusText = 'În așteptare';
    if (a.status === 'ok') statusText = 'Localizat';
    if (a.status === 'error') statusText = 'Eroare localizare';

    const courierOptions = state.couriers.map(c => `
      <option value="${c.id}" ${a.courierId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>
    `).join('');

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:11px; color:#64748b;">
        <span>ID #${a.id} ${a.orderNumber ? `· Comandă: ${escapeHtml(a.orderNumber)}` : ''}</span>
        <strong>${statusText}</strong>
      </div>
      <div style="font-weight:600; font-size:13px; color:#1e293b;">${escapeHtml(a.clientName || 'Client Anonim')}</div>
      <div style="font-size:12px; margin:2px 0; color:#334155;">${escapeHtml(a.raw)}</div>
      ${a.details ? `<div style="font-size:11px; color:#64748b; margin-bottom:4px;">Detalii: ${escapeHtml(a.details)}</div>` : ''}
      
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:6px; border-top:1px solid #e2e8f0;">
        <div style="font-size:11px;">
          ${a.phone ? `📞 ${escapeHtml(a.phone)} ` : ''}
          ${a.amount ? `💰 <strong>${a.amount} lei</strong> (${escapeHtml(a.paymentMethod)})` : ''}
        </div>
        <div style="display:flex; gap:4px;">
          <button class="btn btn-secondary btn-sm" onclick="showEditAddressForm(${a.id})">✏️</button>
          <button class="btn btn-danger btn-sm" onclick="deleteAddress(${a.id})">×</button>
        </div>
      </div>

      ${a.status === 'ok' ? `
        <div style="margin-top:6px;">
          <select class="courier-assign-select" data-addr="${a.id}" style="width:100%; padding:4px; font-size:12px;">
            <option value="">— Nerepartizat —</option>
            ${courierOptions}
          </select>
        </div>
      ` : ''}
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('.courier-assign-select').forEach(select => {
    select.addEventListener('change', () => {
      const addrId = parseInt(select.dataset.addr);
      const courierId = select.value ? parseInt(select.value) : null;
      assignAddressToCourier(addrId, courierId);
    });
  });

  updateMapTopBar();
}

function deleteAddress(id){
  state.addresses = state.addresses.filter(a => a.id !== id);
  Object.keys(state.routes).forEach(cId => {
    const r = state.routes[cId];
    r.order = r.order.filter(aId => aId !== id);
    if (r.order.length === 0) delete state.routes[cId];
    else recalcRouteDistance(parseInt(cId));
  });
  renderAddresses();
  renderRouteSummary();
  maybeShowGeocodeButton();
  redrawMap();
}

function assignAddressToCourier(addrId, courierId){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr) return;

  const oldCourierId = addr.courierId;
  addr.courierId = courierId;

  if (oldCourierId && state.routes[oldCourierId]) {
    state.routes[oldCourierId].order = state.routes[oldCourierId].order.filter(id => id !== addrId);
    if (state.routes[oldCourierId].order.length === 0) delete state.routes[oldCourierId];
    else recalcRouteDistance(oldCourierId);
  }

  if (courierId) {
    if (!state.routes[courierId]) {
      state.routes[courierId] = { order: [], legs: [], totalKm: 0, totalMin: 0 };
    }
    if (!state.routes[courierId].order.includes(addrId)) {
      state.routes[courierId].order.push(addrId);
    }
    recalcRouteDistance(courierId);
  }

  renderAddresses();
  renderCouriers();
  renderRouteSummary();
  redrawMap();
}

// -------------------------------------------------------------------
// GEOCODING (Nominatim API)
// -------------------------------------------------------------------
async function geocodeOne(addressStr){
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(addressStr)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'CourierRoutePlannerApp/1.0' } });
    const data = await res.json();
    if (data && data.length > 0){
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon)
      };
    }
  } catch (e) {
    console.error('Eroare geocodare pentru: ' + addressStr, e);
  }
  return null;
}

async function geocodeAllPending(){
  const pending = state.addresses.filter(a => a.status === 'pending');
  if (!pending.length) return;

  const btn = document.getElementById('geocodeBtn');
  const statusRow = document.getElementById('geocodeStatus');
  btn.style.display = 'none';
  statusRow.style.display = 'flex';

  for (let i = 0; i < pending.length; i++){
    const a = pending[i];
    const res = await geocodeOne(a.raw);
    if (res){
      a.lat = res.lat;
      a.lng = res.lng;
      a.status = 'ok';
    } else {
      a.status = 'error';
    }
    await new Promise(r => setTimeout(r, 1000)); // rate limiting obligatoriu
  }

  btn.style.display = 'block';
  statusRow.style.display = 'none';
  maybeShowGeocodeButton();
  renderAddresses();
  redrawMap();
}

// -------------------------------------------------------------------
// ROUTING (OSRM API) & OPTIMIZATION
// -------------------------------------------------------------------
async function recalcRouteDistance(courierId){
  const courier = state.couriers.find(c => c.id === courierId);
  const route = state.routes[courierId];
  if (!courier || !route || !route.order.length) return;

  const points = [];
  if (courier.start.lat) points.push(courier.start);
  
  route.order.forEach(id => {
    const addr = state.addresses.find(a => a.id === id);
    if (addr && addr.lat) points.push(addr);
  });

  if (!courier.sameAsStart && courier.end.lat) points.push(courier.end);
  else if (courier.start.lat) points.push(courier.start);

  if (points.length < 2) return;

  const coordStr = points.map(p => `${p.lng},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.code === 'Ok' && data.routes.length > 0){
      const rData = data.routes[0];
      route.totalKm = rData.distance / 1000;
      route.totalMin = rData.duration / 60;
      route.geometry = rData.geometry;
      route.totalMin += route.order.length * 5; 
    }
  } catch (e) {
    console.error('Eroare calcul rute OSRM pentru curierul ' + courierId, e);
  }

  renderCouriers();
  renderRouteSummary();
  redrawMap();
}

function initActionBar(){
  document.getElementById('autoAssignBtn').addEventListener('click', () => {
    autoDistributeAddresses();
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (confirm('Sigur vrei să ștergi toate datele?')) {
      state.couriers = [];
      state.addresses = [];
      state.routes = {};
      state.nextCourierId = 1;
      state.nextAddrId = 1;
      addCourier();
      renderCouriers();
      renderAddresses();
      renderRouteSummary();
      maybeShowGeocodeButton();
      redrawMap();
    }
  });

  document.getElementById('exportBtn').addEventListener('click', () => {
    exportToExcel();
  });
}

function autoDistributeAddresses(){
  const confirmedCouriers = state.couriers.filter(c => c.confirmed && c.start.lat);
  const okAddresses = state.addresses.filter(a => a.status === 'ok');

  if (!confirmedCouriers.length){
    showToast('Nu ai niciun curier validat/confirmat cu punct de plecare stabilit!', true);
    switchToTab('panel-curieri');
    return;
  }
  if (!okAddresses.length){
    showToast('Nu există adrese localizate corect pentru repartizare!', true);
    return;
  }

  okAddresses.forEach(addr => {
    let minDist = Infinity;
    let bestCourierId = confirmedCouriers[0].id;

    confirmedCouriers.forEach(c => {
      const d = Math.getDistance(addr.lat, addr.lng, c.start.lat, c.start.lng);
      if (d < minDist){
        minDist = d;
        bestCourierId = c.id;
      }
    });

    addr.courierId = bestCourierId;
    if (!state.routes[bestCourierId]) {
      state.routes[bestCourierId] = { order: [], legs: [], totalKm: 0, totalMin: 0 };
    }
    if (!state.routes[bestCourierId].order.includes(addr.id)) {
      state.routes[bestCourierId].order.push(addr.id);
    }
  });

  confirmedCouriers.forEach(c => {
    const r = state.routes[c.id];
    if (!r || !r.order.length) return;

    let currentLat = c.start.lat;
    let currentLng = c.start.lng;
    const remaining = [...r.order];
    const sortedOrder = [];

    while (remaining.length > 0) {
      let closestIdx = 0;
      let closestDist = Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const addr = state.addresses.find(a => a.id === remaining[i]);
        const d = Math.getDistance(currentLat, currentLng, addr.lat, addr.lng);
        if (d < closestDist) {
          closestDist = d;
          closestIdx = i;
        }
      }

      const nextId = remaining.splice(closestIdx, 1)[0];
      sortedOrder.push(nextId);
      const nextAddr = state.addresses.find(a => a.id === nextId);
      currentLat = nextAddr.lat;
      currentLng = nextAddr.lng;
    }

    r.order = sortedOrder;
    recalcRouteDistance(c.id);
  });

  renderAddresses();
  renderCouriers();
  renderRouteSummary();
  redrawMap();
  document.getElementById('exportBtn').removeAttribute('disabled');
  showToast('Repartizarea și optimizarea automată s-au încheiat.');
}

// -------------------------------------------------------------------
// SUMMARY & RENDERING UTILS
// -------------------------------------------------------------------
function initRoutePanel(){}

function renderRouteSummary(){
  const container = document.getElementById('routeSummary');
  if (!container) return;
  container.innerHTML = '';

  let hasAnyRoute = false;

  state.couriers.forEach(c => {
    const r = state.routes[c.id];
    if (!r || !r.order.length) return;
    hasAnyRoute = true;

    const div = document.createElement('div');
    div.className = 'route-summary-item';
    div.style.borderLeftColor = c.color;

    let stopsHtml = '';
    let currentMin = timeToMinutes(c.departureTime || '10:00');

    r.order.forEach((addrId, idx) => {
      const addr = state.addresses.find(a => a.id === addrId);
      if (!addr) return;
      
      if (idx > 0 && r.totalMin) {
        currentMin += (r.totalMin / r.order.length);
      } else {
        currentMin += 10;
      }

      stopsHtml += `
        <div style="font-size:12px; margin:4px 0; padding-left:12px; border-left:2px solid #cbd5e1;">
          <strong>${idx + 1}. ${minutesToTime(currentMin)}</strong> — ${escapeHtml(addr.clientName)} (${escapeHtml(addr.raw)})
        </div>
      `;
    });

    div.innerHTML = `
      <div style="font-weight:700; font-size:14px; margin-bottom:6px; color:#1e293b;">${escapeHtml(c.name)}</div>
      <div style="font-size:12px; color:#64748b; margin-bottom:8px;">
        Pornire la ${c.departureTime} · Total: ${r.totalKm.toFixed(1)} km · ~ ${formatMinutes(r.totalMin)}
      </div>
      <div>${stopsHtml}</div>
    `;
    container.appendChild(div);
  });

  if (!hasAnyRoute) {
    container.innerHTML = '<div style="font-size:12px; color:#64748b; text-align:center; padding:20px;">Nu există trasee active calculate.</div>';
  }
}

function BlacklistAreaCheck() { return false; } // fallback

function redrawMap(){
  markersLayer.clearLayers();
  routeLinesLayer.clearLayers();

  const bounds = [];

  state.couriers.forEach(c => {
    if (c.start.lat) {
      const p = [c.start.lat, c.start.lng];
      bounds.push(p);
      L.circleMarker(p, { radius: 8, fillColor: c.color, color: '#ffffff', weight: 2, fillOpacity: 1 }).addTo(markersLayer);
    }
  });

  state.addresses.forEach(a => {
    if (a.lat) {
      const p = [a.lat, a.lng];
      bounds.push(p);
      const courier = state.couriers.find(c => c.id === a.courierId);
      const color = courier ? courier.color : '#64748b';

      L.circleMarker(p, { radius: 6, fillColor: color, color: '#ffffff', weight: 1.5, fillOpacity: 0.9 }).addTo(markersLayer)
       .bindPopup(`<strong>${escapeHtml(a.clientName || 'Client')}</strong><br>${escapeHtml(a.raw)}`);
    }
  });

  state.couriers.forEach(c => {
    const r = state.routes[c.id];
    if (r && r.geometry) {
      L.geoJSON(r.geometry, { style: { color: c.color, weight: 4, opacity: 0.85 } }).addTo(routeLinesLayer);
    }
  });

  if (bounds.length > 0 && map) {
    map.fitBounds(bounds, { padding: [40, 40] });
  }
}

function exportToExcel(){
  const rows = [[
    'Curier', 'Fereastră Orară', 'Nr. Comandă', 'Prenume', 'Nume', 'Telefon',
    'Adresă Livrare', 'Detalii Locație', 'Metodă Plată', 'Sumă de Plată', 'Notă Client'
  ]];

  let fallbackOrderNo = 1001;

  state.couriers.forEach(c => {
    const route = state.routes[c.id];
    if (!route) return;
    let currentMin = timeToMinutes(c.departureTime || '10:00');

    route.order.forEach((id, index) => {
      const addr = state.addresses.find(a => a.id === id);
      if (!addr) return;

      if (index > 0 && route.totalMin) {
        currentMin += (route.totalMin / route.order.length);
      } else {
        currentMin += 10;
      }
      
      const timeEst = minutesToTime(currentMin);
      const orderNo = addr.orderNumber || fallbackOrderNo++;
      
      rows.push([
        c.name, timeEst, orderNo,
        addr.clientName.split(' ')[0] || '', addr.clientName.split(' ')[1] || '', addr.phone || '',
        addr.raw, addr.details || '',
        addr.paymentMethod || '', addr.amount != null ? addr.amount : '',
        ''
      ]);
    });
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Trasee');
  XLSX.writeFile(wb, `trasee_${new Date().toISOString().slice(0,10)}.xlsx`);
}

Math.getDistance = function(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

function normalizeTime(val){
  const str = String(val || '').trim();
  if (!str) return '10:00';
  if (/^\d{1,2}:\d{2}$/.test(str)) {
    const parts = str.split(':');
    return `${parts[0].padStart(2, '0')}:${parts[1]}`;
  }
  return '10:00';
}

function timeToMinutes(timeStr){
  const p = timeStr.split(':');
  return parseInt(p[0]) * 60 + parseInt(p[1]);
}

function minutesToTime(m){
  const h = Math.floor(m / 60) % 24;
  const mins = Math.floor(m % 60);
  return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function formatMinutes(m){
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const mins = Math.round(m % 60);
  return `${h}h ${mins}m`;
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
