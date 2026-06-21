<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Planificator Trasee Curieri</title>
  
  <!-- Leaflet CSS pentru Hartă -->
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  
  <!-- Google Fonts & JetBrains Mono (cerut în JS pentru afișarea sumelor) -->
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  
  <link rel="stylesheet" href="styles.css">
</head>
<body>

  <div class="app-container">
    
    <!-- HEADER / BARA DE SUS -->
    <header class="app-header">
      <div class="header-main">
        <h1 id="mapTitle">Niciun traseu activ</h1>
        <span id="dateStamp" class="date-stamp">Manifest de livrare...</span>
        <div id="mapSub" style="font-size: 12px; color: #64748b; margin-top: 4px;">0 adrese · 0 curieri</div>
      </div>
      <div class="action-bar">
        <button id="exportBtn" class="btn btn-secondary" disabled>Exportă Excel</button>
        <button id="resetBtn" class="btn btn-danger">Resetează Tot</button>
      </div>
    </header>

    <!-- NAVIGARE NAV (TAB-URI) -->
    <div class="tabs-nav">
      <button class="tab tab-btn active" data-panel="panel-curieri">Curieri (<span id="courierCount">0</span>)</button>
      <button class="tab tab-btn" data-panel="panel-adrese">Adrese / Import</button>
      <button class="tab tab-btn" data-panel="panel-trasee">Trasee Active</button>
    </div>

    <!-- CONȚINUT PRINCIPAL (Zonă Split: Stânga Panouri / Dreapta Hartă) -->
    <div class="main-layout" style="display: grid; grid-template-columns: 450px 1fr; gap: 20px; align-items: start;">
      
      <!-- COLOANA STÂNGA: PANOURILE DINAMICE -->
      <div class="panels-column">
        
        <!-- TAB 1: PANOU CURIERI -->
        <div id="panel-curieri" class="panel active">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
            <h2 style="margin:0; font-size:16px;">Gestionare Curieri</h2>
            <button id="addCourierBtn" class="btn btn-primary btn-sm">+ Adaugă Curier</button>
          </div>
          <div id="courierList" class="list-container">
            <!-- Cardurile de curieri se generează din JS -->
          </div>
        </div>

        <!-- TAB 2: PANOU ADRESE & IMPORT -->
        <div id="panel-adrese" class="panel">
          <h2 style="font-size:16px; margin-bottom:15px;">Import și Listă Adrese</h2>
          
          <!-- Zonă Dropzone pentru Excel / CSV -->
          <div id="dropzone" class="dropzone" style="border: 2px dashed #cbd5e1; padding: 20px; text-align: center; border-radius: 6px; cursor: pointer; background: #f8fafc; margin-bottom: 15px;">
            <div class="es-icon" style="font-size: 24px; margin-bottom: 8px;">📁</div>
            <div style="font-weight: 500; font-size: 13px;">Trage fișierul Excel / CSV aici sau dă click</div>
            <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Suportă .xlsx, .xls, .csv</div>
            <input type="file" id="fileInput" accept=".csv, .xlsx, .xls" style="display: none;">
          </div>

          <div style="display: flex; gap: 10px; margin-bottom: 15px;">
            <button id="addManualBtn" class="btn btn-secondary btn-sm" style="flex: 1;">+ Adaugă Manual</button>
            <button id="autoAssignBtn" class="btn btn-success btn-sm" style="flex: 1;">⚡ Repartizează automat</button>
          </div>

          <!-- Secțiune Geocodare (Apare doar când sunt adrese în așteptare) -->
          <div id="geocodeSection" style="display: none; background: #eff6ff; padding: 12px; border-radius: 6px; margin-bottom: 15px; border: 1px solid #bfdbfe;">
            <button id="geocodeBtn" class="btn btn-primary btn-block btn-sm" style="width: 100%;">Localizează adresele</button>
            <div id="geocodeStatus" style="display: none; align-items: center; justify-content: center; gap: 8px; font-size: 13px; color: #1e40af;">
              <span class="spinner">⏳</span> <span>Se procesează...</span>
            </div>
          </div>

          <!-- Listă Adrese brute -->
          <div id="addrList" class="list-container">
            <!-- Adresele se încarcă din JS -->
          </div>
        </div>

        <!-- TAB 3: PANOU SUMAR TRASEE OPTIMIZATE -->
        <div id="panel-trasee" class="panel">
          <h2 style="font-size:16px; margin-bottom:15px;">Ordine Oprire pe Traseu</h2>
          <div id="routeSummary">
            <!-- Traseele ordonate și timpii estimați apar aici din JS -->
          </div>
        </div>

        <!-- Pop-up Selector Coloane / Formular Adăugare Manuală (Folosit masiv în JS) -->
        <div id="columnPicker" class="panel" style="display: none; margin-top: 15px; background: #fff; border: 1px solid #cbd5e1; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
          <!-- Se injectează din JS în showColumnMapper() și showManualAddForm() -->
        </div>

      </div>

      <!-- COLOANA DREAPTA: HARTA ȘI LEGENDA -->
      <div class="map-column" style="position: sticky; top: 20px;">
        <div id="map-container" style="background: #ffffff; padding: 10px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); position: relative;">
          
          <!-- Elementul fizic al hărții cerut de Leaflet -->
          <div id="map" style="width: 100%; height: calc(100vh - 180px); min-height: 500px; border-radius: 6px;"></div>
          
          <!-- Legendă Trasee pe Hartă -->
          <div id="mapLegend" style="display: none; position: absolute; bottom: 25px; left: 25px; z-index: 1000; background: rgba(255,255,255,0.95); padding: 12px; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); max-width: 250px; font-size: 12px;">
            <!-- Se generează din JS în redrawMap() -->
          </div>

        </div>
      </div>

    </div>
  </div>

  <!-- TOAST NOTIFICATIONS (Elementul cerut de showToast din JS) -->
  <div id="toast" class="toast" style="position: fixed; bottom: 20px; right: 20px; z-index: 9999; background: #1e293b; color: #fff; padding: 12px 20px; border-radius: 6px; font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); display: none; transition: all 0.3s;"></div>

  <!-- DEPENDENȚE EXTERNE -->
  <!-- PapaParse pentru fisierele CSV -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js"></script>
  <!-- SheetJS pentru Excel (.xlsx) -->
  <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
  <!-- Leaflet JS pentru Hartă -->
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  
  <!-- Codul aplicației tale -->
  <script src="app.js"></script>
</body>
</html>
