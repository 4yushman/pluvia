(() => {
  "use strict";

  const CARD_URL = "card_data.json";
  const GEO_URL = "nyc_boroughs.geojson";
  const ESRI_CREDIT = "Tiles &copy; Esri";
  const OSM_CREDIT = "Map data &copy; OpenStreetMap contributors";

  // Each basemap style is a chain. If a provider cannot be reached the next one
  // in its own chain is used, so one dead tile service never blanks the map.
  const BASEMAPS = {
    streets: {
      label: "Streets",
      chain: [
        {
          name: "Esri World Street Map",
          url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
          options: { maxZoom: 19, maxNativeZoom: 19, attribution: ESRI_CREDIT }
        },
        {
          name: "OpenStreetMap",
          url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          options: { maxZoom: 19, maxNativeZoom: 19, attribution: OSM_CREDIT }
        },
        {
          name: "Esri World Topographic",
          url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
          options: { maxZoom: 19, maxNativeZoom: 19, attribution: ESRI_CREDIT }
        }
      ]
    },
    satellite: {
      label: "Satellite",
      chain: [
        {
          name: "Esri World Imagery",
          url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          options: { maxZoom: 19, maxNativeZoom: 19, attribution: ESRI_CREDIT },
          labels: {
            url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
            options: { maxZoom: 19, maxNativeZoom: 19, pane: "shadowPane", opacity: 0.95 }
          }
        },
        {
          name: "Esri World Street Map",
          url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
          options: { maxZoom: 19, maxNativeZoom: 19, attribution: ESRI_CREDIT }
        }
      ]
    }
  };
  const DEFAULT_BASEMAP = "streets";
  const NYC_BOUNDS = { minLat: 40.47, maxLat: 40.95, minLon: -74.31, maxLon: -73.66 };
  const MAX_NEAREST = 6;
  const DEPTH_THRESHOLD_IN = 4;

  // Early warning watch. The forecast comes from a public weather service; the
  // probability attached to it comes only from what the sensor already recorded.
  const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
  const FORECAST_CREDIT = "Open-Meteo public forecast";
  const RAIN_THRESHOLDS = [1, 2, 5, 10, 15, 20, 30, 40, 60];
  const WATCH_KEY = "pluvia.watchlist.v1";
  const TRIGGER_MM = 10;
  const WATCH_MM = 5;
  // How deep the water usually gets here matters as much as how often it comes.
  // A corner that holds a puddle on half its rain days is not the same hazard as
  // one that goes knee deep twice a year, so the rate a warning needs falls as
  // the recorded depth rises. Every row of this ladder is printed on screen.
  const DEPTH_BANDS = [
    { minIn: 18, tier: 4, label: "knee deep or more", warnRate: 0.05 },
    { minIn: 12, tier: 3, label: "mid shin to knee", warnRate: 0.05 },
    { minIn: 6, tier: 2, label: "ankle to shin", warnRate: 0.10 },
    { minIn: 2, tier: 1, label: "over the sole of a shoe", warnRate: 0.40 },
    { minIn: 0, tier: 0, label: "surface water only", warnRate: null }
  ];
  const DRILL_MM = 30;
  const DRILL_HOURS = 6;
  const FORECAST_TIMEOUT_MS = 12000;
  // Set ?alerts=<https endpoint> to enable email delivery through the AWS stack.
  const ALERT_ENDPOINT = (() => {
    try {
      const raw = new URLSearchParams(window.location.search).get("alerts");
      if (!raw) return null;
      const parsed = new URL(raw);
      return parsed.protocol === "https:" ? `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}/alerts` : null;
    } catch (error) {
      return null;
    }
  })();

  const loadStatus = document.getElementById("load-status");
  const fallbackPanel = document.getElementById("fallback-panel");
  const fileInput = document.getElementById("card-file");
  const chooseButton = document.getElementById("choose-file");
  const explorer = document.getElementById("explorer");
  const locateForm = document.getElementById("locate-form");
  const placeSearch = document.getElementById("place-search");
  const clearPinButton = document.getElementById("clear-pin");
  const mapNotice = document.getElementById("map-notice");
  const sortSelect = document.getElementById("nearest-sort");
  const nearestList = document.getElementById("nearest-list");
  const nearestNote = document.getElementById("nearest-note");
  const eventSelect = document.getElementById("event-select");
  const selectionHint = document.getElementById("selection-hint");
  const selectionSummary = document.getElementById("selection-summary");
  const mapProvenance = document.getElementById("map-provenance");
  const cardRegion = document.getElementById("card-region");
  const scenarioPanel = document.getElementById("scenario-panel");
  const scenarioDuration = document.getElementById("scenario-duration");
  const scenarioRain = document.getElementById("scenario-rain");
  const recordsToggle = document.getElementById("records-toggle");
  const scenarioRecords = document.getElementById("scenario-records");
  const scenarioSensor = document.getElementById("scenario-sensor");
  const scenarioEvidence = document.getElementById("scenario-evidence");
  const scenarioVerdict = document.getElementById("scenario-verdict");
  const watchPanel = document.getElementById("watch-panel");
  const watchListEl = document.getElementById("watch-list");
  const watchStatus = document.getElementById("watch-status");
  const watchAddRow = document.getElementById("watch-add-row");
  const watchAddButton = document.getElementById("watch-add");
  const watchRefresh = document.getElementById("watch-refresh");

  let cardData = null;
  let boroughs = null;
  let sensors = [];
  let playbackTimer = null;
  let selectedSensorId = null;
  let pin = null;
  let map = null;
  let sensorLayer = null;
  let boroughLayer = null;
  let pinMarker = null;
  let tileFailures = 0;
  let currentTiles = null;
  let currentLabels = null;
  let basemapStyle = DEFAULT_BASEMAP;
  let basemapButtons = {};
  let locateButton = null;
  let accuracyCircle = null;
  let tileWatchdog = null;
  let basemapGeneration = 0;
  const lastAssessment = {};

  window.addEventListener("error", (event) => {
    const detail = event && event.message ? event.message : "unknown error";
    if (loadStatus) {
      loadStatus.textContent = `This page hit a script error: ${detail}. Reload with cache disabled.`;
      loadStatus.classList.add("is-error");
    }
  });

  boot();

  async function boot() {
    const [card, geo] = await Promise.all([fetchJson(CARD_URL), fetchJson(GEO_URL)]);
    if (geo.ok) boroughs = geo.value;
    if (card.ok) {
      start(card.value, "Snapshot loaded from this folder.");
      return;
    }
    fallbackPanel.hidden = false;
    setStatus("Could not load card_data.json automatically. Choose the file below.", true);
  }

  async function fetchJson(url) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { ok: true, value: await response.json() };
    } catch (error) {
      return { ok: false, error };
    }
  }

  function start(parsed, message) {
    try {
      validateCard(parsed);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read this card file.", true);
      return;
    }
    cardData = parsed;
    sensors = buildSensorIndex(cardData);
    fallbackPanel.hidden = true;
    explorer.hidden = false;
    try {
      initMap();
    } catch (error) {
      mapNotice.hidden = false;
      mapNotice.textContent = `The map could not be drawn: ${error && error.message ? error.message : "unknown error"}. Everything below still works.`;
    }
    renderExplorer(cardData.defaultEventId);
    const withReplay = cardData.events.filter((item) => item.profileStatus === "available").length;
    const withHistory = sensors.filter((item) => item.floodDays > 0).length;
    setStatus(`${message} ${sensors.length} sensor locations in this snapshot, ${withHistory} with recorded flood history, ${withReplay} with a minute-by-minute replay.`);
  }

  chooseButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", onFileSelected);
  eventSelect.addEventListener("change", () => renderExplorer(eventSelect.value));
  locateForm.addEventListener("submit", onSearch);
  sortSelect.addEventListener("change", renderNearest);
  watchAddButton.addEventListener("click", addWatch);
  watchRefresh.addEventListener("click", renderWatchlist);
  watchListEl.addEventListener("click", onWatchListClick);
  scenarioDuration.addEventListener("change", renderScenario);
  scenarioRain.addEventListener("change", renderScenario);
  recordsToggle.addEventListener("click", () => {
    const open = scenarioRecords.hidden;
    scenarioRecords.hidden = !open;
    recordsToggle.setAttribute("aria-expanded", String(open));
    recordsToggle.textContent = open ? "Hide the records" : "Show the records behind this";
  });
  clearPinButton.addEventListener("click", () => {
    pin = null;
    if (pinMarker) {
      map.removeLayer(pinMarker);
      pinMarker = null;
    }
    renderNearest();
    setStatus("Pin cleared. Click the map or search to set a location.");
  });

  async function onFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    stopPlayback();
    try {
      start(JSON.parse(await file.text()), "Snapshot loaded from the chosen file.");
    } catch (error) {
      setStatus("Could not read this card file.", true);
    } finally {
      fileInput.value = "";
    }
  }

  function validateCard(data) {
    if (!data || !Array.isArray(data.events) || data.events.length === 0) {
      throw new Error("The selected file has no snapshot events.");
    }
    if (!data.provenance || !data.mapProvenance || !data.context) {
      throw new Error("The card is missing provenance or context data.");
    }
    if (!data.events.some((item) => item.eventId === data.defaultEventId)) {
      throw new Error("The default event is not present in this snapshot.");
    }
    for (const item of data.events) {
      if (item.profileStatus === "available" && !Array.isArray(item.profile)) {
        throw new Error(`Profile data is missing for ${item.rank}.`);
      }
      if (item.profileStatus === "unavailable" && item.profile !== null) {
        throw new Error(`Unavailable profile state is inconsistent for ${item.rank}.`);
      }
    }
  }

  function setStatus(message, isError = false) {
    loadStatus.textContent = message;
    loadStatus.dataset.state = isError ? "error" : "ready";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function known(value) {
    return value === null || value === undefined || value === "" ? "[UNKNOWN]" : String(value);
  }

  function formatUtc(value, options = {}) {
    if (value === null || value === undefined || value === "") return "[UNKNOWN]";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHtml(value);
    return new Intl.DateTimeFormat("en", {
      year: "numeric",
      month: options.longMonth ? "long" : "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }).format(date) + " UTC";
  }

  function formatNumber(value, digits = 2) {
    if (value === null || value === undefined || value === "") return "[UNKNOWN]";
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : "[UNKNOWN]";
  }

  function safeHttpsUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function pill(label, kind) {
    const safeKind = ["measured", "forecast", "reported", "inferred", "unavailable"].includes(kind)
      ? kind
      : "unavailable";
    return `<span class="pill pill--${safeKind}">${escapeHtml(label)}</span>`;
  }

  function shortRank(rank) {
    return rank === "backup" ? "Backup" : String(rank).split("-")[0];
  }

  function buildSensorIndex(data) {
    const index = new Map();
    const history = new Map();
    if (data.history && Array.isArray(data.history.bySensor)) {
      for (const row of data.history.bySensor) history.set(row.sensorId, row);
    }
    const drainage = new Map();
    if (data.drainage && Array.isArray(data.drainage.bySensor)) {
      for (const row of data.drainage.bySensor) drainage.set(row.sensorId, row);
    }
    const network = data.network && Array.isArray(data.network.sensors) ? data.network.sensors : [];
    for (const row of network) {
      if (!hasCoordinates(row)) continue;
      index.set(row.sensorId, {
        sensorId: row.sensorId,
        sensorName: row.sensorName,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        borough: row.borough,
        zipcode: row.zipcode,
        streetName: row.streetName,
        neighborhood: row.neighborhood,
        tidal: row.tidallyInfluenced === "Yes",
        eventId: null,
        profileStatus: null
      });
    }
    for (const event of data.events) {
      const location = event.location || {};
      if (!hasCoordinates(location)) continue;
      const existing = index.get(event.sensorId) || {};
      index.set(event.sensorId, {
        ...existing,
        sensorId: event.sensorId,
        sensorName: event.sensorName,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        borough: location.borough || existing.borough || null,
        zipcode: location.zipcode || existing.zipcode || null,
        tidal: event.tidalInfluence === "Yes",
        eventId: event.eventId,
        profileStatus: event.profileStatus
      });
    }
    const out = [...index.values()];
    for (const item of out) {
      const row = history.get(item.sensorId) || null;
      item.history = row;
      item.drainage = drainage.get(item.sensorId) || null;
      item.floodCount = row ? row.floodCount : 0;
      item.floodDays = row ? (row.floodDays || 0) : 0;
      item.recordedMaxDepthIn = row ? row.maxDepthIn : null;
    }
    out.sort((a, b) => (a.floodDays || 0) - (b.floodDays || 0));
    return out;
  }

  function hotTier(days) {
    if (!days) return 0;
    if (days >= 31) return 3;
    if (days >= 6) return 2;
    return 1;
  }

  const TIER_FILL = ["#9aabb2", "#4fb8ac", "#e0a32b", "#d2562f"];

  function hasCoordinates(location) {
    return Boolean(location)
      && location.latitude !== null && location.latitude !== undefined && Number.isFinite(Number(location.latitude))
      && location.longitude !== null && location.longitude !== undefined && Number.isFinite(Number(location.longitude));
  }

  function coordinateText(location) {
    if (!hasCoordinates(location)) return "Coordinates: [UNKNOWN]";
    return `Coordinates: ${known(location.latitude)}, ${known(location.longitude)}`;
  }

  function haversineKm(aLat, aLon, bLat, bLon) {
    const toRad = (value) => (value * Math.PI) / 180;
    const radius = 6371;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function initMap() {
    if (typeof L === "undefined") {
      mapNotice.hidden = false;
      mapNotice.textContent = "The bundled map library did not load, so the map is unavailable. Search and the evidence card still work.";
      return;
    }
    L.Icon.Default.imagePath = "vendor/leaflet/images/";
    map = L.map("nyc-map", {
      minZoom: 9,
      maxZoom: 19,
      worldCopyJump: false,
      zoomControl: false
    });
    map.setView([40.7128, -73.94], 11);
    L.control.zoom({ position: "topleft" }).addTo(map);

    attachBasemap(basemapStyle, 0);

    if (boroughs) {
      boroughLayer = L.geoJSON(boroughs, {
        interactive: false,
        style: { color: "#1f6f78", weight: 1, fillColor: "#9fd4cd", fillOpacity: 0.1 }
      }).addTo(map);
      const bounds = boroughLayer.getBounds();
      if (bounds && bounds.isValid()) map.fitBounds(bounds, { padding: [14, 14] });
    }

    addMapControls();

    sensorLayer = L.layerGroup().addTo(map);
    map.on("click", (event) => {
      setPin(event.latlng.lat, event.latlng.lng, "Pin dropped on the map.");
    });
    map.on("locationfound", onLocationFound);
    map.on("locationerror", onLocationError);
    drawSensors();
    renderMapProvenance();
    window.setTimeout(() => map.invalidateSize(), 150);
  }

  function clearTileLayers() {
    if (tileWatchdog) {
      window.clearTimeout(tileWatchdog);
      tileWatchdog = null;
    }
    if (currentLabels) {
      map.removeLayer(currentLabels);
      currentLabels = null;
    }
    if (currentTiles) {
      map.removeLayer(currentTiles);
      currentTiles = null;
    }
  }

  function showBundledOutlines() {
    mapNotice.hidden = false;
    mapNotice.textContent = "No street tile service could be reached from this browser, so the bundled borough outlines are drawn instead. Every sensor, distance, record and verdict below is computed locally and is unaffected.";
    if (boroughLayer) boroughLayer.setStyle({ fillOpacity: 0.6, weight: 1.5, fillColor: "#bcdcd6" });
  }

  function attachBasemap(styleKey, index) {
    const style = BASEMAPS[styleKey] || BASEMAPS[DEFAULT_BASEMAP];
    const position = index || 0;
    basemapGeneration += 1;
    const generation = basemapGeneration;
    clearTileLayers();
    if (position >= style.chain.length) {
      showBundledOutlines();
      return;
    }
    const source = style.chain[position];
    tileFailures = 0;
    let settled = false;
    const layer = L.tileLayer(source.url, source.options);

    const advance = () => {
      if (settled || generation !== basemapGeneration) return;
      settled = true;
      attachBasemap(styleKey, position + 1);
    };

    layer.on("tileerror", () => {
      tileFailures += 1;
      if (tileFailures >= 4) advance();
    });
    layer.on("load", () => {
      if (settled || generation !== basemapGeneration) return;
      settled = true;
      if (tileWatchdog) {
        window.clearTimeout(tileWatchdog);
        tileWatchdog = null;
      }
      mapNotice.hidden = true;
      if (boroughLayer) boroughLayer.setStyle({ fillOpacity: 0, weight: 1, color: "#1f6f78" });
    });

    layer.addTo(map);
    currentTiles = layer;

    if (source.labels) {
      currentLabels = L.tileLayer(source.labels.url, source.labels.options).addTo(map);
    }

    // A provider that answers with a placeholder image never fires tileerror,
    // and one that hangs never fires load. Both are caught here.
    tileWatchdog = window.setTimeout(advance, 9000);
  }

  function setBasemap(styleKey) {
    if (!BASEMAPS[styleKey] || styleKey === basemapStyle) return;
    basemapStyle = styleKey;
    Object.keys(basemapButtons).forEach((key) => {
      const button = basemapButtons[key];
      const active = key === styleKey;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    attachBasemap(styleKey, 0);
    renderMapProvenance();
  }

  function addMapControls() {
    L.control.scale({ position: "bottomleft", imperial: true, metric: true }).addTo(map);

    const BasemapControl = L.Control.extend({
      options: { position: "topright" },
      onAdd() {
        const container = L.DomUtil.create("div", "map-switch");
        Object.keys(BASEMAPS).forEach((key) => {
          const button = L.DomUtil.create("button", "map-switch-button", container);
          button.type = "button";
          button.textContent = BASEMAPS[key].label;
          button.setAttribute("aria-pressed", key === basemapStyle ? "true" : "false");
          if (key === basemapStyle) button.classList.add("is-active");
          L.DomEvent.on(button, "click", (ev) => {
            L.DomEvent.stop(ev);
            setBasemap(key);
          });
          basemapButtons[key] = button;
        });
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);
        return container;
      }
    });

    const LocateControl = L.Control.extend({
      options: { position: "bottomright" },
      onAdd() {
        const container = L.DomUtil.create("div", "map-locate");
        const button = L.DomUtil.create("button", "map-locate-button", container);
        button.type = "button";
        button.title = "Use my current location";
        button.setAttribute("aria-label", "Use my current location");
        button.innerHTML = '<span class="locate-glyph" aria-hidden="true"></span>';
        L.DomEvent.on(button, "click", (ev) => {
          L.DomEvent.stop(ev);
          requestGeolocation();
        });
        L.DomEvent.disableClickPropagation(container);
        locateButton = button;
        return container;
      }
    });

    map.addControl(new BasemapControl());
    map.addControl(new LocateControl());
  }

  function setLocateBusy(busy) {
    if (locateButton) locateButton.classList.toggle("is-busy", Boolean(busy));
  }

  function requestGeolocation() {
    if (!map) return;
    if (!navigator.geolocation) {
      setStatus("This browser does not offer a location service. Zoom the map to your street and click it to drop the pin.", true);
      return;
    }
    if (!window.isSecureContext) {
      setStatus("Browsers only share location on a secure page. Open this page over http://localhost or https, or click the map to drop the pin.", true);
      return;
    }
    setLocateBusy(true);
    setStatus("Asking your browser for your current location\u2026");
    map.locate({ setView: false, enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  function onLocationFound(event) {
    setLocateBusy(false);
    const latitude = event.latlng.lat;
    const longitude = event.latlng.lng;
    const inside = latitude >= NYC_BOUNDS.minLat && latitude <= NYC_BOUNDS.maxLat
      && longitude >= NYC_BOUNDS.minLon && longitude <= NYC_BOUNDS.maxLon;

    if (accuracyCircle) {
      map.removeLayer(accuracyCircle);
      accuracyCircle = null;
    }

    if (!inside) {
      setStatus(`Your device reports ${formatNumber(latitude, 4)}, ${formatNumber(longitude, 4)}, which is outside the New York City area this snapshot covers. Zoom the map to a New York street and click it to drop the pin.`, true);
      return;
    }

    const accuracy = Number(event.accuracy);
    if (Number.isFinite(accuracy) && accuracy > 0) {
      accuracyCircle = L.circle(event.latlng, {
        radius: Math.min(accuracy, 2000),
        color: "#1f6f78",
        weight: 1,
        fillColor: "#4fb8ac",
        fillOpacity: 0.12,
        interactive: false
      }).addTo(map);
    }
    map.setView(event.latlng, 17);
    const precision = Number.isFinite(accuracy)
      ? ` Your browser reports this to about ${formatNumber(accuracy, 0)} m.`
      : "";
    setPin(latitude, longitude, `Pin set from your device location.${precision}`);
  }

  function onLocationError(event) {
    setLocateBusy(false);
    const reason = event && event.code === 1
      ? "You declined the location request."
      : "Your browser could not fix a location.";
    setStatus(`${reason} Zoom the map to your street and click it to drop the pin instead.`, true);
  }

  function markerRadius(item) {
    const growth = Math.min(2.3, 0.8 + 0.2 * Math.sqrt(item.floodDays || 0));
    const base = item.eventId ? 6 : 4.2;
    return base * growth;
  }

  function drawSensors() {
    if (!sensorLayer) return;
    sensorLayer.clearLayers();
    for (const item of sensors) {
      const tier = hotTier(item.floodDays);
      const selected = item.sensorId === selectedSensorId;
      const marker = L.circleMarker([item.latitude, item.longitude], {
        radius: markerRadius(item),
        color: selected ? "#102a43" : "#ffffff",
        weight: selected ? 3 : 1.4,
        fillColor: TIER_FILL[tier],
        fillOpacity: 0.92
      });
      marker.bindTooltip(sensorTooltip(item), { direction: "top", offset: [0, -4] });
      marker.on("click", (event) => {
        L.DomEvent.stopPropagation(event);
        onSensorPicked(item.sensorId);
      });
      marker.addTo(sensorLayer);
    }
  }

  function sensorTooltip(item) {
    const floods = item.floodDays
      ? `${item.floodDays} day${item.floodDays === 1 ? "" : "s"} with recorded water, deepest ${item.recordedMaxDepthIn === null ? "[UNKNOWN]" : `${item.recordedMaxDepthIn} in`}`
      : "No recorded flood rows in this snapshot";
    const tidal = item.tidal ? "<br>Tidally influenced sensor" : "";
    const replay = item.eventId
      ? `<br>Minute-by-minute replay ${item.profileStatus === "available" ? "available" : "unavailable"}`
      : "";
    const street = item.streetName ? `<br>${escapeHtml(item.streetName)}` : "";
    return `<strong>${escapeHtml(item.sensorName)}</strong>${street}<br>${escapeHtml(known(item.borough))} &middot; ZIP ${escapeHtml(known(item.zipcode))}<br>${escapeHtml(floods)}${tidal}${replay}`;
  }

  function onSensorPicked(sensorId) {
    const picked = sensors.find((item) => item.sensorId === sensorId);
    if (picked) {
      placeSearch.value = picked.sensorName || "";
      setPin(picked.latitude, picked.longitude, `Pin moved to ${picked.sensorName}.`);
      if (map) map.setView([picked.latitude, picked.longitude], Math.max(map.getZoom(), 16));
    }
    const sensor = sensors.find((item) => item.sensorId === sensorId);
    if (!sensor) return;
    selectedSensorId = sensorId;
    if (sensor.eventId) {
      renderExplorer(sensor.eventId);
      setStatus(`${sensor.sensorName}: storm event ${sensor.eventId} selected.`);
    } else {
      drawSensors();
      renderNearest();
      renderScenario();
      setStatus(`${sensor.sensorName} selected. No minute-by-minute replay is stored for it in this package, so the card below still shows the last selected event.`);
    }
  }

  function setPin(latitude, longitude, message) {
    pin = { latitude, longitude };
    if (map) {
      if (pinMarker) map.removeLayer(pinMarker);
      pinMarker = L.marker([latitude, longitude], {
        title: "Your location pin, drag to move it",
        draggable: true,
        autoPan: true,
        keyboard: true
      }).addTo(map);
      pinMarker.bindTooltip("Your pin, drag to fine tune", { direction: "top", offset: [0, -34] });
      pinMarker.on("dragend", () => {
        const moved = pinMarker.getLatLng();
        setPin(moved.lat, moved.lng, "Pin moved.");
      });
    }
    const inside = latitude >= NYC_BOUNDS.minLat && latitude <= NYC_BOUNDS.maxLat
      && longitude >= NYC_BOUNDS.minLon && longitude <= NYC_BOUNDS.maxLon;
    renderNearest();
    setStatus(inside
      ? `${message} ${formatNumber(latitude, 5)}, ${formatNumber(longitude, 5)}.`
      : `${message} This point is outside the New York City area covered by this snapshot.`, !inside);
  }

  function onSearch(event) {
    event.preventDefault();
    const query = placeSearch.value.trim();
    if (!query) {
      setStatus("Enter a ZIP code, a borough, or a sensor name.", true);
      return;
    }
    const coords = query.match(/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
    if (coords) {
      setPin(Number(coords[1]), Number(coords[2]), "Pin set from the coordinates you entered.");
      if (map) map.setView([Number(coords[1]), Number(coords[2])], 15);
      return;
    }
    const needle = query.toLowerCase();
    const matches = sensors.filter((item) => {
      const zip = String(item.zipcode || "");
      const borough = String(item.borough || "").toLowerCase();
      const name = String(item.sensorName || "").toLowerCase();
      const street = String(item.streetName || "").toLowerCase();
      return zip === needle || borough === needle || name.includes(needle)
        || street.includes(needle) || zip.startsWith(needle);
    });
    if (matches.length === 0) {
      setStatus(`No sensor in this snapshot matches "${query}". Zoom the map to your street and click it to drop a pin instead.`, true);
      return;
    }
    const centre = {
      latitude: matches.reduce((sum, item) => sum + item.latitude, 0) / matches.length,
      longitude: matches.reduce((sum, item) => sum + item.longitude, 0) / matches.length
    };
    setPin(centre.latitude, centre.longitude, `${matches.length} matching sensor${matches.length === 1 ? "" : "s"} found.`);
    if (map) {
      const bounds = L.latLngBounds(matches.map((item) => [item.latitude, item.longitude]));
      map.fitBounds(bounds.pad(0.35), { maxZoom: 16 });
    }
  }

  function rankedSensors() {
    const mode = sortSelect.value;
    const list = sensors.map((item) => ({
      ...item,
      km: pin ? haversineKm(pin.latitude, pin.longitude, item.latitude, item.longitude) : null
    }));
    if (mode === "floods") {
      list.sort((a, b) => (b.floodDays - a.floodDays)
        || ((b.recordedMaxDepthIn || 0) - (a.recordedMaxDepthIn || 0))
        || ((a.km === null ? 0 : a.km) - (b.km === null ? 0 : b.km)));
    } else {
      list.sort((a, b) => (a.km === null ? 0 : a.km) - (b.km === null ? 0 : b.km));
    }
    return list.slice(0, MAX_NEAREST);
  }

  function renderNearest() {
    watchAddRow.hidden = !pin;
    if (!pin && sortSelect.value === "distance") {
      nearestNote.textContent = "Drop a pin on the map or search to rank sensors by distance.";
      nearestList.innerHTML = "";
      return;
    }
    const ranked = rankedSensors();
    if (ranked.length === 0) {
      nearestNote.textContent = "No sensor coordinates are present in this snapshot.";
      nearestList.innerHTML = "";
      return;
    }
    nearestNote.textContent = sortSelect.value === "floods"
      ? "Ranked by how many flood events each sensor actually recorded in this snapshot."
      : "Straight-line distance from your pin to each sensor in the snapshot.";
    nearestList.innerHTML = ranked.map((item) => {
      const replay = item.eventId && item.profileStatus === "available";
      const state = replay ? "Replay stored" : item.eventId ? "Replay unavailable" : "No stored replay";
      const stateClass = replay ? "is-available" : "is-unavailable";
      const floodLine = item.floodDays
        ? `${item.floodDays} day${item.floodDays === 1 ? "" : "s"} with water &middot; deepest ${item.recordedMaxDepthIn === null ? "[UNKNOWN]" : `${formatNumber(item.recordedMaxDepthIn)} in`}${item.tidal ? " &middot; tidal" : ""}`
        : "No recorded flood rows in this snapshot";
      const distance = item.km === null ? "&mdash;" : `${formatNumber(item.km, 2)} km`;
      return `<li>
          <button class="nearest-row${item.sensorId === selectedSensorId ? " is-selected" : ""}" type="button" data-pick="${escapeHtml(item.sensorId)}">
            <span class="nearest-main">
              <strong>${escapeHtml(item.sensorName)}</strong>
              <span>${escapeHtml(known(item.borough))} &middot; ZIP ${escapeHtml(known(item.zipcode))}</span>
              <span class="nearest-history tier-text-${hotTier(item.floodDays)}">${floodLine}</span>
            </span>
            <span class="nearest-meta">
              <span class="nearest-distance">${distance}</span>
              <span class="profile-state ${stateClass}">${state}</span>
            </span>
          </button>
        </li>`;
    }).join("");
    nearestList.querySelectorAll("[data-pick]").forEach((node) => {
      node.addEventListener("click", () => onSensorPicked(node.dataset.pick));
    });
    renderScenario();
  }

  function selectedSensor() {
    return sensors.find((item) => item.sensorId === selectedSensorId) || null;
  }

  function evidenceRow(label, value, state) {
    const cls = state === "missing" ? "is-missing" : state === "strong" ? "is-strong" : "";
    return `<div class="evidence-row ${cls}"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
  }


  /* ------------------------------------------------------------------ */
  /* Early warning watch                                                 */
  /*                                                                     */
  /* The rule is deliberately small enough to print on screen. Take the  */
  /* forecast rainfall for a day. Find the largest recorded threshold it */
  /* reaches. Look up how many city days have reached that threshold     */
  /* since this sensor was installed, and how many of those days ended   */
  /* with water at this sensor. The ratio is the number shown. Nothing   */
  /* is modelled, smoothed or estimated.                                 */
  /* ------------------------------------------------------------------ */

  function loadWatchlist() {
    try {
      const raw = window.localStorage.getItem(WATCH_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function saveWatchlist(list) {
    try {
      window.localStorage.setItem(WATCH_KEY, JSON.stringify(list));
    } catch (error) {
      setStatus("This browser refused to save the watch list, so it will be lost on reload.", true);
    }
  }

  function thresholdFor(mm) {
    let picked = null;
    for (const value of RAIN_THRESHOLDS) {
      if (mm >= value) picked = value;
    }
    return picked;
  }

  function inchesToCm(inches) {
    return Math.round(Number(inches) * 2.54);
  }

  function depthBand(sensor) {
    const history = sensor && sensor.history;
    const depth = history && history.medianDepthIn !== null && history.medianDepthIn !== undefined
      ? Number(history.medianDepthIn)
      : null;
    if (depth === null || Number.isNaN(depth)) return { band: null, depth: null };
    return { band: DEPTH_BANDS.find((item) => depth >= item.minIn) || DEPTH_BANDS[DEPTH_BANDS.length - 1], depth };
  }

  function rateAt(sensor, threshold) {
    const history = sensor && sensor.history;
    if (!history || threshold === null) return null;
    const key = String(threshold);
    const cityDays = history.cityDaysAtOrAbove ? history.cityDaysAtOrAbove[key] : null;
    const sensorDays = history.floodDaysAtOrAbove ? history.floodDaysAtOrAbove[key] : null;
    if (!cityDays || sensorDays === null || sensorDays === undefined) return null;
    return { threshold, cityDays, sensorDays, rate: sensorDays / cityDays };
  }

  function assessDay(sensor, mm, hours) {
    const base = { mm, hours, threshold: null, cityDays: null, sensorDays: null, rate: null, depth: null, band: null };
    if (sensor.tidal) return { ...base, level: "refused" };
    if (!sensor.history || !sensor.history.floodDays) return { ...base, level: "no-history" };
    const threshold = thresholdFor(mm);
    if (threshold === null) return { ...base, level: "quiet" };
    const found = rateAt(sensor, threshold);
    if (!found) return { ...base, threshold, level: "unknown" };
    const { band, depth } = depthBand(sensor);
    const result = { ...base, ...found, depth, band };
    if (!band || band.warnRate === null) {
      result.level = "shallow";
      return result;
    }
    if (mm >= TRIGGER_MM && found.rate >= band.warnRate) result.level = "warning";
    else if (mm >= WATCH_MM && found.rate >= band.warnRate / 2) result.level = "watch";
    else result.level = "quiet";
    return result;
  }

  function fetchForecast(latitude, longitude) {
    const url = `${FORECAST_ENDPOINT}?latitude=${latitude.toFixed(4)}&longitude=${longitude.toFixed(4)}`
      + "&daily=precipitation_sum,precipitation_hours&timezone=America%2FNew_York&forecast_days=7";
    // Without a deadline one unreachable request leaves every card spinning,
    // so the request is abandoned after FORECAST_TIMEOUT_MS and reported.
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? window.setTimeout(() => controller.abort(), FORECAST_TIMEOUT_MS)
      : null;
    const options = { cache: "no-store" };
    if (controller) options.signal = controller.signal;
    return fetch(url, options)
      .finally(() => { if (timer) window.clearTimeout(timer); })
      .then((response) => {
        if (!response.ok) throw new Error(`forecast service answered ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        const daily = payload && payload.daily;
        if (!daily || !Array.isArray(daily.time)) throw new Error("forecast payload had no daily block");
        return daily.time.map((date, position) => ({
          date,
          mm: Number(daily.precipitation_sum[position]) || 0,
          hours: Number(daily.precipitation_hours[position]) || 0
        }));
      });
  }

  function watchSensorFor(entry) {
    const exact = sensors.find((item) => item.sensorId === entry.sensorId);
    if (exact) return exact;
    let best = null;
    let bestKm = Infinity;
    for (const item of sensors) {
      if (item.tidal) continue;
      const km = haversineKm(entry.latitude, entry.longitude, item.latitude, item.longitude);
      if (km < bestKm) { bestKm = km; best = item; }
    }
    return best;
  }

  function addWatch() {
    if (!pin) {
      setStatus("Drop a pin or search for a place first, then watch it.", true);
      return;
    }
    const ranked = rankedSensors().filter((item) => !item.tidal && item.history && item.history.floodDays);
    const chosen = ranked[0] || rankedSensors()[0];
    if (!chosen) {
      setStatus("No sensor near this point can be watched.", true);
      return;
    }
    const list = loadWatchlist();
    const id = `${pin.latitude.toFixed(5)},${pin.longitude.toFixed(5)}`;
    if (list.some((item) => item.id === id)) {
      setStatus("This place is already on your watch list.", true);
      renderWatchlist();
      return;
    }
    const label = chosen.streetName || chosen.sensorName || "Saved place";
    list.push({
      id,
      label,
      latitude: pin.latitude,
      longitude: pin.longitude,
      sensorId: chosen.sensorId,
      sensorName: chosen.sensorName,
      addedUtc: new Date().toISOString()
    });
    saveWatchlist(list);
    setStatus(`${label} added to your watch list. Checking the rain forecast there now.`);
    renderWatchlist();
  }

  function removeWatch(id) {
    saveWatchlist(loadWatchlist().filter((item) => item.id !== id));
    renderWatchlist();
  }

  function runDrill(id) {
    const card = watchListEl.querySelector(`[data-drill-target="${CSS.escape(id)}"]`);
    const entry = loadWatchlist().find((item) => item.id === id);
    if (!card || !entry) return;
    const sensor = watchSensorFor(entry);
    if (!sensor) return;
    const verdict = assessDay(sensor, DRILL_MM, DRILL_HOURS);
    card.hidden = false;
    card.innerHTML = `<p class="watch-drill-head">Drill, not a forecast. Feeding ${DRILL_MM} mm over ${DRILL_HOURS} hours into the same rule.</p>`
      + dayRowMarkup({ ...verdict, date: "Drill" }, sensor, true);
  }

  function levelCopy(level) {
    if (level === "warning") return { flag: "Warning triggered", kind: "is-warning" };
    if (level === "watch") return { flag: "Worth watching", kind: "is-watch" };
    if (level === "shallow") return { flag: "Surface water only", kind: "is-quiet" };
    if (level === "refused") return { flag: "Refused", kind: "is-refused" };
    if (level === "no-history") return { flag: "No record here", kind: "is-refused" };
    if (level === "unknown") return { flag: "Not enough record", kind: "is-refused" };
    return { flag: "Below the trigger", kind: "is-quiet" };
  }

  function dayLabel(date) {
    if (date === "Drill") return "Drill";
    const parsed = new Date(`${date}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return date;
    return parsed.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }

  function dayRowMarkup(day, sensor, expanded) {
    const copy = levelCopy(day.level);
    const percent = day.rate === null ? null : Math.round(day.rate * 100);
    let detail;
    if (day.level === "refused") {
      detail = `${escapeHtml(sensor.sensorName)} is tidally influenced, so a rainfall warning is refused here.`;
    } else if (day.level === "no-history") {
      detail = `This snapshot holds no recorded flood for ${escapeHtml(sensor.sensorName)}. No record is not the same as safe.`;
    } else if (day.level === "unknown") {
      detail = "The record does not cover this much rain at this sensor, so no number is claimed.";
    } else if (percent === null) {
      detail = "No comparable rain days are recorded for this sensor.";
    } else if (day.level === "shallow") {
      detail = `Water does reach this sensor, but the typical depth recorded here is `
        + `${formatNumber(day.depth, 1)} in (${inchesToCm(day.depth)} cm). PLUVIA does not raise a `
        + `warning for water that shallow, however often it appears.`;
    } else {
      const depthPart = day.depth === null
        ? ""
        : ` When water does arrive here the usual depth is ${formatNumber(day.depth, 1)} in `
          + `(${inchesToCm(day.depth)} cm), which is ${day.band.label}.`;
      detail = `${day.sensorDays} of the ${day.cityDays} days that reached ${day.threshold} mm since this `
        + `sensor was installed ended with water here. That is ${percent} percent.${depthPart}`;
    }
    const thin = day.cityDays !== null && day.cityDays < 20
      ? `<span class="watch-thin">Thin evidence: only ${day.cityDays} comparable days exist.</span>`
      : "";
    return `<div class="watch-day ${copy.kind}${expanded ? " is-expanded" : ""}">
        <div class="watch-day-head">
          <strong>${escapeHtml(dayLabel(day.date))}</strong>
          <span class="watch-mm">${formatNumber(day.mm, 1)} mm forecast over ${formatNumber(day.hours, 0)} h</span>
          <span class="watch-flag">${copy.flag}</span>
        </div>
        <p class="watch-detail">${detail} ${thin}</p>
      </div>`;
  }

  function watchCardMarkup(entry, sensor, days, failure) {
    const safeId = escapeHtml(entry.id);
    const head = `<div class="watch-card-head">
        <div>
          <h3>${escapeHtml(entry.label)}</h3>
          <p class="watch-sub">Nearest usable sensor: ${escapeHtml(sensor ? sensor.sensorName : "[UNKNOWN]")}
            &middot; ${escapeHtml(formatNumber(entry.latitude, 4))}, ${escapeHtml(formatNumber(entry.longitude, 4))}</p>
        </div>
        <div class="watch-card-actions">
          <button type="button" class="ghost-button is-small" data-drill="${safeId}">Run a drill</button>
          <button type="button" class="ghost-button is-small" data-remove="${safeId}">Stop watching</button>
        </div>
      </div>`;

    if (failure) {
      return `<article class="watch-card">${head}
        <p class="watch-failure">The public forecast service could not be reached from this browser, so no
        forecast is claimed for this place. ${escapeHtml(failure)}. The recorded history below the map is
        unaffected, and the drill button still shows how the rule behaves.</p>
        <div class="watch-drill" data-drill-target="${safeId}" hidden></div>
      </article>`;
    }

    if (!sensor) {
      return `<article class="watch-card">${head}
        <p class="watch-failure">No sensor in this snapshot can be matched to this place.</p></article>`;
    }

    const triggered = days.filter((day) => day.level === "warning");
    const watched = days.filter((day) => day.level === "watch");
    let banner;
    if (triggered.length) {
      const first = triggered[0];
      const depthLine = first.depth === null
        ? ""
        : ` When water arrives here it usually reaches <strong>${formatNumber(first.depth, 1)} in
          (${inchesToCm(first.depth)} cm)</strong>, ${escapeHtml(first.band.label)}, and the deepest ever recorded
          at this sensor is ${formatNumber(sensor.history.maxDepthIn, 1)} in
          (${inchesToCm(sensor.history.maxDepthIn)} cm).`;
      banner = `<div class="watch-banner is-warning">
          <span class="watch-banner-flag">Early warning</span>
          <p><strong>${escapeHtml(dayLabel(first.date))}</strong>: ${formatNumber(first.mm, 1)} mm of rain is forecast.
          At ${escapeHtml(sensor.sensorName)}, ${first.sensorDays} of ${first.cityDays} comparable past rain days
          ended with standing water, which is ${Math.round(first.rate * 100)} percent.${depthLine}
          A site this deep needs only ${Math.round(first.band.warnRate * 100)} percent to be flagged, so this
          place is flagged.</p>
        </div>`;
    } else if (watched.length) {
      const first = watched[0];
      banner = `<div class="watch-banner is-watch">
          <span class="watch-banner-flag">Worth watching</span>
          <p><strong>${escapeHtml(dayLabel(first.date))}</strong>: ${formatNumber(first.mm, 1)} mm forecast.
          ${first.sensorDays} of ${first.cityDays} comparable past days ended with water here
          (${Math.round(first.rate * 100)} percent). That is below the warning trigger of
          ${Math.round(TRIGGER_RATE * 100)} percent.</p>
        </div>`;
    } else {
      banner = `<div class="watch-banner is-quiet">
          <span class="watch-banner-flag">Quiet</span>
          <p>No day in the next seven reaches both ${TRIGGER_MM} mm of forecast rain and the
          ${Math.round(TRIGGER_RATE * 100)} percent record trigger at ${escapeHtml(sensor.sensorName)}.
          The watch stays on and nothing is sent.</p>
        </div>`;
    }

    const ladder = DEPTH_BANDS.map((item) => {
      const active = days.length && days[0].band && days[0].band.tier === item.tier;
      const need = item.warnRate === null
        ? "never warned on depth alone"
        : `needs ${Math.round(item.warnRate * 100)}% of comparable days`;
      return `<li${active ? ' class="is-active"' : ""}>${item.minIn === 0 ? "under 2" : `${item.minIn}+`} in
        &middot; ${escapeHtml(item.label)} &middot; ${need}</li>`;
    }).join("");
    const emailButton = triggered.length && ALERT_ENDPOINT
      ? `<div class="watch-email"><button type="button" class="load-button" data-email="${safeId}">Email me this warning</button>
          <span class="load-hint">Sent through the PLUVIA alert stack on AWS to the confirmed address.</span>
          <span class="watch-email-status" data-email-status="${safeId}"></span></div>`
      : "";
    return `<article class="watch-card">${head}${banner}${emailButton}
      <div class="watch-days">${days.map((day) => dayRowMarkup(day, sensor, false)).join("")}</div>
      <div class="watch-drill" data-drill-target="${safeId}" hidden></div>
      <details class="watch-rule-box">
        <summary>How this warning is decided</summary>
        <p>The forecast has to reach ${TRIGGER_MM} mm, and this sensor's own record has to clear the bar for how
        deep the water usually gets here. Deeper places are flagged on far fewer repeats.</p>
        <ul class="watch-ladder">${ladder}</ul>
        <p>Forecast by ${FORECAST_CREDIT}. Every depth and percentage is counted from the stored snapshot.
        Nothing is modelled or estimated.</p>
      </details>
    </article>`;
  }

  function renderWatchlist() {
    const list = loadWatchlist();
    watchPanel.hidden = list.length === 0;
    if (!list.length) {
      watchListEl.innerHTML = "";
      watchStatus.textContent = "";
      return;
    }
    watchStatus.textContent = "Checking the public rain forecast for each watched place\u2026";
    watchListEl.innerHTML = list
      .map((entry) => `<article class="watch-card is-loading"><h3>${escapeHtml(entry.label)}</h3>
        <p class="watch-sub">Reading the forecast\u2026</p></article>`)
      .join("");

    Promise.all(list.map((entry) => {
      const sensor = watchSensorFor(entry);
      return fetchForecast(entry.latitude, entry.longitude)
        .then((days) => ({
          entry,
          sensor,
          days: days.map((day) => ({ ...assessDay(sensor, day.mm, day.hours), date: day.date })),
          failure: null
        }))
        .catch((error) => ({ entry, sensor, days: [], failure: error.message || String(error) }));
    })).then((results) => {
      results.forEach((item) => {
        const hit = item.days.find((day) => day.level === "warning");
        if (hit) lastAssessment[item.entry.id] = hit;
      });
      watchListEl.innerHTML = results
        .map((item) => watchCardMarkup(item.entry, item.sensor, item.days, item.failure))
        .join("");
      const flagged = results.filter((item) => item.days.some((day) => day.level === "warning")).length;
      const failed = results.filter((item) => item.failure).length;
      const parts = [`${results.length} place${results.length === 1 ? "" : "s"} watched`];
      if (flagged) parts.push(`${flagged} flagged in the next seven days`);
      if (failed) parts.push(`${failed} could not reach the forecast service`);
      watchStatus.textContent = `${parts.join(" \u00b7 ")}.`;
    });
  }

  function sendWarningEmail(id, button) {
    const entry = loadWatchlist().find((item) => item.id === id);
    const sensor = entry ? watchSensorFor(entry) : null;
    const note = watchListEl.querySelector(`[data-email-status="${CSS.escape(id)}"]`);
    if (!entry || !sensor || !ALERT_ENDPOINT) return;
    const day = lastAssessment[id];
    if (!day) return;
    button.disabled = true;
    if (note) note.textContent = "Sending\u2026";
    const detail = `${formatNumber(day.mm, 1)} mm of rain is forecast. `
      + `${day.sensorDays} of the ${day.cityDays} days that reached ${day.threshold} mm since this sensor `
      + `was installed ended with standing water here, which is ${Math.round(day.rate * 100)} percent. `
      + (day.depth === null ? "" : `Water here usually reaches ${formatNumber(day.depth, 1)} in `
        + `(${inchesToCm(day.depth)} cm), ${day.band.label}.`);
    fetch(ALERT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        place: entry.label,
        sensor: sensor.sensorName,
        day: String(day.date),
        rainMm: Number(day.mm.toFixed(1)),
        percent: Math.round(day.rate * 100),
        depthCm: day.depth === null ? 0 : inchesToCm(day.depth),
        detail
      })
    }).then((response) => response.json().then((payload) => ({ ok: response.ok, payload })))
      .then(({ ok, payload }) => {
        if (note) {
          note.textContent = ok
            ? `Queued on AWS. Message id ${payload.messageId}.`
            : `Refused: ${payload.error || "unknown"}.`;
          note.classList.toggle("is-good", ok);
        }
        button.disabled = !ok;
      })
      .catch((error) => {
        if (note) note.textContent = `Could not reach the alert endpoint. ${error.message || error}`;
        button.disabled = false;
      });
  }

  function onWatchListClick(event) {
    const removeTarget = event.target.closest("[data-remove]");
    if (removeTarget) {
      removeWatch(removeTarget.getAttribute("data-remove"));
      return;
    }
    const drillTarget = event.target.closest("[data-drill]");
    if (drillTarget) {
      runDrill(drillTarget.getAttribute("data-drill"));
      return;
    }
    const emailTarget = event.target.closest("[data-email]");
    if (emailTarget) sendWarningEmail(emailTarget.getAttribute("data-email"), emailTarget);
  }

  function renderScenario() {
    const sensor = selectedSensor();
    if (!sensor) {
      scenarioPanel.hidden = true;
      return;
    }
    scenarioPanel.hidden = false;
    const thresholdMm = Number(scenarioRain.value);
    const scenarioHours = Number(scenarioDuration.value);
    const history = sensor.history;
    const rain = cardData.rain || null;
    scenarioSensor.textContent = sensor.sensorName;

    const key = String(thresholdMm);
    const cityDays = history && history.cityDaysAtOrAbove
      ? history.cityDaysAtOrAbove[key]
      : (rain && rain.daysAtOrAbove ? rain.daysAtOrAbove[key] : null);
    const sensorDays = history && history.floodDaysAtOrAbove ? history.floodDaysAtOrAbove[key] : null;
    const rate = cityDays && sensorDays !== null && cityDays > 0 ? sensorDays / cityDays : null;

    const lastEnd = history && history.lastFloodEndUtc ? formatUtc(history.lastFloodEndUtc) : null;
    const rainRange = history && history.minRainMm !== null && history.maxRainMm !== null
      ? `${formatNumber(history.medianRainMm)} mm median, ${formatNumber(history.minRainMm)} to ${formatNumber(history.maxRainMm)} mm`
      : "[UNKNOWN]";

    scenarioEvidence.innerHTML = [
      evidenceRow("Separate days with recorded water here", history ? String(history.floodDays) : "0", history && history.floodDays ? "strong" : "missing"),
      evidenceRow("Deepest water ever recorded here", history && history.maxDepthIn !== null ? `${formatNumber(history.maxDepthIn)} in` : "[UNKNOWN]", history && history.maxDepthIn !== null ? "" : "missing"),
      evidenceRow("Rain measured on those days", rainRange, history && history.medianRainMm !== null ? "strong" : "missing"),
      evidenceRow("Hours of rain on those days", history && history.medianRainHours !== null ? `${formatNumber(history.medianRainHours, 1)} h median` : "[UNKNOWN]", history && history.medianRainHours !== null ? "" : "missing"),
      evidenceRow(`Rain days at or above ${thresholdMm} mm since ${history && history.eligibleFrom ? history.eligibleFrom : "[UNKNOWN]"}`, cityDays === null || cityDays === undefined ? "[UNKNOWN]" : String(cityDays), cityDays ? "" : "missing"),
      evidenceRow("Sensor installed on", history && history.installedDate ? history.installedDate : "[UNKNOWN]", history && history.installedDate ? "" : "missing"),
      evidenceRow("Of those, days water was recorded here", sensorDays === null ? "[UNKNOWN]" : String(sensorDays), sensorDays ? "strong" : ""),
      evidenceRow("Median time to drain once water appears", history && history.medianDrainMin !== null ? `${formatNumber(history.medianDrainMin, 0)} min` : "[UNKNOWN]", history && history.medianDrainMin !== null ? "" : "missing"),
      evidenceRow("Last recorded flood finished draining", lastEnd || "[UNKNOWN]", lastEnd ? "" : "missing"),
      evidenceRow("Tidally influenced sensor", sensor.tidal ? "Yes" : "No", sensor.tidal ? "missing" : ""),
      drainageRow(sensor)
    ].join("");

    scenarioVerdict.innerHTML = buildVerdict(sensor, history, rain, thresholdMm, scenarioHours, cityDays, sensorDays, rate);
    renderRecords(history);
  }

  function buildVerdict(sensor, history, rain, thresholdMm, scenarioHours, cityDays, sensorDays, rate) {
    const footer = `<p class="verdict-warning">This check counts recorded history only. The early warning watch above adds a public rain forecast to the same counts; nothing here is modelled or estimated.</p>`;

    if (sensor.tidal) {
      const median = history && history.medianRainMm !== null ? `${formatNumber(history.medianRainMm)} mm` : "[UNKNOWN]";
      return `<div class="verdict is-unknown">
          <span class="verdict-flag">Rain scenario refused</span>
          <p>${escapeHtml(sensor.sensorName)} is a tidally influenced sensor. Water here is driven by the tide, not only by rainfall, and the median rain on its recorded flood days is ${median}.</p>
          <p>Running a rainfall scenario against it would produce a confident number from the wrong cause, so PLUVIA will not do it.</p>
          <p class="verdict-rule">Rule applied: separate tidal sensors from rainfall reasoning.</p>
          ${footer}
        </div>`;
    }

    if (!history || !history.floodDays) {
      return `<div class="verdict is-unknown">
          <span class="verdict-flag">Verdict unavailable</span>
          <p>This snapshot holds no recorded flood event for ${escapeHtml(sensor.sensorName)}, so PLUVIA will not produce a verdict for it. A sensor with no history is not the same as a safe location.</p>
          <p class="verdict-rule">Rule applied: refuse to answer when the evidence is absent.</p>
          ${footer}
        </div>`;
    }

    if (rate === null) {
      return `<div class="verdict is-unknown">
          <span class="verdict-flag">Verdict unavailable</span>
          <p>No daily rainfall series is loaded, so the recorded floods here cannot be matched to rain days.</p>
          <p class="verdict-rule">Rule applied: refuse to answer when the evidence is absent.</p>
          ${footer}
        </div>`;
    }

    const percent = Math.round(rate * 100);
    const kind = rate >= 0.4 ? "is-high" : rate >= 0.15 ? "is-medium" : "is-low";
    const flag = rate >= 0.4 ? "Alert would be justified"
      : rate >= 0.15 ? "Borderline, worth watching"
        : "History does not justify an alert";

    const thin = cityDays < 20
      ? `<p class="verdict-rule">Caution: only ${cityDays} days in the record reached ${thresholdMm} mm, so this percentage rests on thin evidence.</p>`
      : "";

    const hoursLine = history.medianRainHours === null
      ? `The hours of rain on those days are [UNKNOWN] in this snapshot.`
      : scenarioHours >= history.medianRainHours
        ? `The ${scenarioHours} hour${scenarioHours === 1 ? "" : "s"} you chose is at or above the ${formatNumber(history.medianRainHours, 1)} hour median on the days water actually appeared here.`
        : `The ${scenarioHours} hour${scenarioHours === 1 ? "" : "s"} you chose is below the ${formatNumber(history.medianRainHours, 1)} hour median on the days water actually appeared here.`;

    const drain = history.medianDrainMin === null ? "[UNKNOWN]" : `${formatNumber(history.medianDrainMin, 0)} min`;
    const depth = history.maxDepthIn === null ? "[UNKNOWN]" : `${formatNumber(history.maxDepthIn)} in`;

    return `<div class="verdict ${kind}">
        <span class="verdict-flag">${flag}</span>
        <p class="verdict-headline">${percent}% of comparable rain days ended with water at this sensor.</p>
        <p>This sensor has been in the ground since ${escapeHtml(String(history.installedDate || rain.firstDay))}. In that time the city recorded ${cityDays} days with ${thresholdMm} mm of rain or more, and on ${sensorDays} of them this sensor measured standing water.</p>
        <p>${escapeHtml(hoursLine)}</p>
        <p>When water does appear here it has reached ${depth} at its deepest and has taken a median of ${drain} to drain away.</p>
        ${drainageSentence(sensor)}
        ${thin}
        <p class="verdict-rule">Rule applied: count only the rain days after this sensor was installed, count how many of those days it recorded water, divide. Nothing is modelled or estimated. Press "Show the records behind this" to read the rows.</p>
        ${footer}
      </div>`;
  }

  function drainageRow(sensor) {
    const drain = sensor.drainage;
    if (!drain) {
      return evidenceRow("311 drainage complaints near this sensor", "Not in this package", "missing");
    }
    const cleared = drain.lastClosedDate ? drain.lastClosedDate : "[UNKNOWN]";
    return evidenceRow(
      `311 drainage complaints within ${cardData.drainage.radiusMetres} m`,
      `${drain.complaintCount}, last cleared ${cleared}`,
      drain.complaintCount ? "strong" : ""
    );
  }

  function drainageSentence(sensor) {
    const drain = sensor.drainage;
    if (!drain) return "";
    const median = drain.medianDaysToClose === null || drain.medianDaysToClose === undefined
      ? "[UNKNOWN]"
      : `${formatNumber(drain.medianDaysToClose, 1)} days`;
    return `<p>Separately from the sensor, the city logged ${drain.complaintCount} drainage complaint${drain.complaintCount === 1 ? "" : "s"} within ${cardData.drainage.radiusMetres} m of this point. ${drain.closedCount} of them were closed, taking a median of ${median}. The most recent was cleared on ${escapeHtml(String(drain.lastClosedDate || "[UNKNOWN]"))}.</p>`;
  }

  function renderRecords(history) {
    renderRecordsInner(history);
    const sensor = selectedSensor();
    if (sensor && sensor.drainage && Array.isArray(sensor.drainage.records) && sensor.drainage.records.length) {
      const rows = sensor.drainage.records.map((row) => `<tr>
          <td>${escapeHtml(String(row.created || "[UNKNOWN]"))}</td>
          <td>${escapeHtml(String(row.closed || "still open"))}</td>
          <td style="text-align:left">${escapeHtml(String(row.descriptor || "[UNKNOWN]"))}</td>
          <td>${row.metres === null || row.metres === undefined ? "[UNKNOWN]" : `${row.metres} m`}</td>
        </tr>`).join("");
      scenarioRecords.innerHTML += `
        <p class="panel-kicker" style="margin-top:16px">311 drainage complaints near this sensor</p>
        <p class="selection-hint">Official city service requests. The closed date is when the city recorded the work as done.</p>
        <div class="records-scroll">
          <table class="records-table">
            <thead><tr><th>Reported</th><th>Cleared</th><th style="text-align:left">What was reported</th><th>Distance</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }
  }

  function renderRecordsInner(history) {
    if (!history || !Array.isArray(history.records) || history.records.length === 0) {
      scenarioRecords.innerHTML = '<p class="selection-hint">No individual rows are stored for this sensor in the snapshot.</p>';
      return;
    }
    const rows = history.records.map((row) => `<tr>
        <td>${escapeHtml(row.date)}</td>
        <td>${row.rainMm === null ? "[UNKNOWN]" : formatNumber(row.rainMm)}</td>
        <td>${row.rainHours === null ? "[UNKNOWN]" : formatNumber(row.rainHours, 1)}</td>
        <td>${row.maxDepthIn === null ? "[UNKNOWN]" : formatNumber(row.maxDepthIn)}</td>
        <td>${row.durationMin === null ? "[UNKNOWN]" : formatNumber(row.durationMin, 0)}</td>
        <td>${row.drainMin === null ? "[UNKNOWN]" : formatNumber(row.drainMin, 0)}</td>
      </tr>`).join("");
    scenarioRecords.innerHTML = `
      <p class="panel-kicker">The rows this verdict is built from</p>
      <p class="selection-hint">Most recent ${history.records.length} recorded events at this sensor. Rain columns come from the daily archive for that date.</p>
      <div class="records-scroll">
        <table class="records-table">
          <thead><tr><th>Date</th><th>Rain mm</th><th>Rain h</th><th>Max depth in</th><th>Duration min</th><th>Drain min</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderExplorer(eventId) {
    if (!cardData) return;
    stopPlayback();
    const selected = cardData.events.find((item) => item.eventId === eventId)
      || cardData.events.find((item) => item.eventId === cardData.defaultEventId);
    if (!selected) return;
    selectedSensorId = selected.sensorId;

    eventSelect.innerHTML = cardData.events.map((item) => {
      const profileLabel = item.profileStatus === "available" ? "replay available" : "replay unavailable";
      return `<option value="${escapeHtml(item.eventId)}">${escapeHtml(item.rank)} &middot; ${escapeHtml(item.sensorName)} &middot; ${profileLabel}</option>`;
    }).join("");
    eventSelect.value = selected.eventId;
    renderSelectionSummary(selected);
    drawSensors();
    renderNearest();
    renderScenario();
    renderCard(selected);
    renderWatchlist();
    const link = document.getElementById("report-link");
    if (link) link.setAttribute("href", `../aws/form.html#${encodeURIComponent(selected.eventId)}`);
  }

  function renderSelectionSummary(event) {
    const location = event.location || {};
    selectionHint.textContent = event.profileStatus === "available"
      ? "This event has a measured minute-by-minute profile in the frozen snapshot."
      : "This event summary is present, but its profile is unavailable in the frozen snapshot.";
    selectionSummary.innerHTML = `
      <div class="selection-summary-top">
        <span class="rank-pill">${escapeHtml(event.rank)}</span>
        <span class="profile-state ${event.profileStatus === "available" ? "is-available" : "is-unavailable"}">${event.profileStatus === "available" ? "Replay available" : "Replay unavailable"}</span>
      </div>
      <strong>${escapeHtml(event.sensorName)}</strong>
      <span>${escapeHtml(known(location.borough))} &middot; ZIP ${escapeHtml(known(location.zipcode))}</span>
      <span class="coordinate-line">${escapeHtml(coordinateText(location))}</span>`;
  }

  function renderMapProvenance() {
    const source = cardData.mapProvenance;
    const url = safeHttpsUrl(source.url);
    const sourceMarkup = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.datasetId)}</a>`
      : `<span>${escapeHtml(source.datasetId)}</span>`;
    const history = cardData.history;
    const historyLine = history
      ? ` Marker size and colour show the number of separate days each sensor recorded standing water: ${history.eventRows} event rows across ${history.sensorsWithFloods} sensors from dataset ${escapeHtml(history.datasetId)}, covering ${escapeHtml(history.coverageNote)}.`
      : " Recorded flood counts: [UNKNOWN].";
    mapProvenance.innerHTML = `Sensor locations: ${sourceMarkup} &middot; snapshot as of ${escapeHtml(formatUtc(source.snapshotAsOf))} &middot; dataset updated ${escapeHtml(formatUtc(source.updatedAt))}.${historyLine} Street tiles are background context only; every number on this page is computed from the local snapshot files.`;
  }

  function renderCard(event) {
    const provenance = cardData.provenance;
    const context = cardData.context;
    const location = event.location || {};
    const sourceUrl = safeHttpsUrl(provenance.url);
    const sourceMarkup = sourceUrl
      ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(provenance.dataset)}</a>`
      : `<strong>${escapeHtml(provenance.dataset)}</strong>`;
    const chart = buildProfileChart(event);
    const weather = context.weather || {};
    const reports = context.reports || {};
    const inference = context.inference || {};
    const refusalNote = context.refusalNote || "This historical view does not establish present road passability or drainage condition.";

    cardRegion.innerHTML = `
      <article class="event-card">
        <header class="card-header">
          <div class="card-kicker">
            ${pill(event.evidenceLabel || "measured", "measured")}
            <span class="rank-pill">${escapeHtml(event.rank)}</span>
            <span class="event-date">${escapeHtml(formatUtc(event.startUtc, { longMonth: true }))}</span>
          </div>
          <h2>${escapeHtml(event.sensorName)}</h2>
          <p class="sensor-line">Historical FloodNet event · ${escapeHtml(known(location.borough))} · ${escapeHtml(coordinateText(location))}</p>
        </header>

        <section class="stats-grid" aria-label="Event measurements">
          <div class="stat-card">
            <span class="stat-label">Maximum measured depth</span>
            <strong class="stat-value">${escapeHtml(formatNumber(event.maxDepthIn))} <span class="stat-unit">in</span></strong>
          </div>
          <div class="stat-card">
            <span class="stat-label">Event duration</span>
            <strong class="stat-value">${escapeHtml(formatNumber(event.durationMin))} <span class="stat-unit">min</span></strong>
          </div>
        </section>

        <section class="profile-section" aria-labelledby="profile-heading">
          <div class="section-heading">
            <div>
              <h3 id="profile-heading">Flood-depth timeline</h3>
              <p>${event.profileStatus === "available" ? `Measured profile · ${event.profile.length} recorded points` : "Profile status: unavailable"}</p>
            </div>
            ${event.profileStatus === "available" ? pill("measured", "measured") : pill("unavailable", "unavailable")}
          </div>
          <div class="chart-wrap">${chart.markup}</div>
          ${event.profileStatus === "available" ? `
            <div class="replay-controls">
              <button id="replay-toggle" class="replay-button" type="button">Play replay</button>
              <button id="replay-reset" class="replay-reset" type="button">Reset</button>
              <label class="visually-hidden" for="profile-range">Replay recorded FloodNet profile</label>
              <input id="profile-range" class="profile-range" type="range" min="0" max="${event.profile.length - 1}" step="1" value="0" aria-valuetext="First recorded point">
              <output id="profile-readout" class="profile-readout"></output>
            </div>
            <p class="chart-caption">Elapsed time follows the stored profile timestamps. Playback visits recorded points only.</p>
          ` : `
            <div class="profile-unavailable" role="status">
              <span class="pill pill--unavailable">unavailable</span>
              <p>This candidate has an event summary, but its depth profile is not included in the frozen profile snapshot. No curve or playback values are shown.</p>
            </div>
          `}
        </section>

        <section class="evidence-section" aria-labelledby="evidence-heading">
          <h3 id="evidence-heading" class="evidence-title">Evidence context</h3>
          ${renderUnavailableRow("Weather context", weather.evidenceType || "forecast", weather.label || "unavailable", weather.reason || "No weather snapshot is attached to this card.")}
          ${renderUnavailableRow("Reported evidence", reports.evidenceType || "reported", reports.label || "unavailable", reports.reason || "No location-level report rows are attached to this card.")}
          <div class="evidence-row">
            <div class="evidence-labels">${pill(inference.label || "inferred", "inferred")}</div>
            <div class="evidence-copy">
              <strong>${escapeHtml(inference.status === "not_used" ? "Not used for an impact claim" : "Inference status")}</strong>
              <p>${escapeHtml(inference.reason || "No present-condition inference is included.")}</p>
            </div>
          </div>
        </section>

        <section class="provenance-section" aria-label="Source and as-of details">
          <div class="provenance-item">
            <span>Event source</span>
            ${sourceMarkup}
            <strong>Dataset ${escapeHtml(provenance.datasetId)}</strong>
          </div>
          <div class="provenance-item">
            <span>Event window · UTC</span>
            <strong>${escapeHtml(formatUtc(event.startUtc))}<br>to ${escapeHtml(formatUtc(event.endUtc))}</strong>
          </div>
          <div class="provenance-item">
            <span>Event snapshot as of</span>
            <strong>${escapeHtml(formatUtc(provenance.snapshotAsOf))}</strong>
          </div>
          <div class="provenance-item">
            <span>Event dataset updated</span>
            <strong>${escapeHtml(formatUtc(provenance.updatedAt))}</strong>
          </div>
          <div class="provenance-item">
            <span>Sensor coordinates</span>
            <strong>${escapeHtml(coordinateText(location))}</strong>
          </div>
          <div class="provenance-item">
            <span>Sensor metadata source</span>
            <strong>${escapeHtml(cardData.mapProvenance.datasetId)} · ${escapeHtml(formatUtc(cardData.mapProvenance.snapshotAsOf))}</strong>
          </div>
        </section>

        <aside class="refusal-note" aria-label="What this card does not establish">
          <span class="refusal-icon" aria-hidden="true">i</span>
          <div>
            <strong>What this card does not establish</strong>
            <p>${escapeHtml(refusalNote)}</p>
          </div>
        </aside>
      </article>`;

    if (event.profileStatus === "available") attachReplayControls(event, chart.positions);
  }

  function renderUnavailableRow(title, evidenceType, status, reason) {
    const type = ["forecast", "reported"].includes(evidenceType) ? evidenceType : "unavailable";
    const statusType = status === "unavailable" ? "unavailable" : type;
    return `
      <div class="evidence-row">
        <div class="evidence-labels">
          ${pill(type, type)}
          ${pill(status, statusType)}
        </div>
        <div class="evidence-copy">
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(reason)}</p>
        </div>
      </div>`;
  }

  function buildProfileChart(event) {
    if (event.profileStatus !== "available" || !Array.isArray(event.profile) || event.profile.length === 0) {
      return { markup: '<div class="map-empty">Depth profile: [UNKNOWN]</div>', positions: [] };
    }

    const points = event.profile;
    const valid = points.filter((point) => point.elapsedSeconds !== null && point.depthInches !== null &&
      Number.isFinite(Number(point.elapsedSeconds)) && Number.isFinite(Number(point.depthInches)));
    if (valid.length === 0) {
      return { markup: '<div class="map-empty">Depth profile: [UNKNOWN]</div>', positions: [] };
    }

    const width = 640;
    const height = 280;
    const margin = { top: 18, right: 18, bottom: 43, left: 54 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const durationSeconds = event.durationMin === null || event.durationMin === undefined
      ? NaN
      : Number(event.durationMin) * 60;
    const profileTimes = points
      .map((point) => point.elapsedSeconds === null || point.elapsedSeconds === undefined ? NaN : Number(point.elapsedSeconds))
      .filter(Number.isFinite);
    const maxX = Math.max(...profileTimes, Number.isFinite(durationSeconds) ? durationSeconds : 0, 1);
    const publishedMax = event.maxDepthIn === null || event.maxDepthIn === undefined ? NaN : Number(event.maxDepthIn);
    const profileMax = Math.max(...valid.map((point) => Number(point.depthInches)));
    const maxY = Math.max(5, Math.ceil((Number.isFinite(publishedMax) ? publishedMax : profileMax) / 5) * 5);
    const x = (seconds) => margin.left + (seconds / maxX) * plotWidth;
    const y = (depth) => margin.top + plotHeight - (depth / maxY) * plotHeight;
    const xTicks = [0, maxX / 2, maxX];
    const yTicks = [0, maxY / 2, maxY];
    const grid = [
      ...yTicks.map((tick) => `<line class="chart-grid" x1="${margin.left}" y1="${y(tick)}" x2="${width - margin.right}" y2="${y(tick)}" />`),
      ...xTicks.map((tick) => `<line class="chart-grid" x1="${x(tick)}" y1="${margin.top}" x2="${x(tick)}" y2="${margin.top + plotHeight}" />`),
    ].join("");
    const yLabels = yTicks.map((tick) => `<text x="${margin.left - 10}" y="${y(tick) + 4}" text-anchor="end">${formatTick(tick)}</text>`).join("");
    const xLabels = xTicks.map((tick) => `<text x="${x(tick)}" y="${height - 19}" text-anchor="middle">${formatTick(tick / 60)}</text>`).join("");

    const positions = [];
    const segments = [];
    let segment = [];
    for (const point of points) {
      const seconds = point.elapsedSeconds === null || point.elapsedSeconds === undefined ? NaN : Number(point.elapsedSeconds);
      const depth = point.depthInches === null || point.depthInches === undefined ? NaN : Number(point.depthInches);
      if (!Number.isFinite(seconds) || !Number.isFinite(depth)) {
        if (segment.length) segments.push(segment);
        segment = [];
        positions.push(null);
        continue;
      }
      const projected = { x: x(seconds), y: y(depth) };
      segment.push(projected);
      positions.push(projected);
    }
    if (segment.length) segments.push(segment);

    const paths = segments.filter((part) => part.length > 1).map((part) => {
      const commands = part.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`);
      return `<path class="chart-profile" d="${commands.join(" ")}" />`;
    }).join("");
    const firstPosition = positions.find(Boolean);
    const playhead = firstPosition
      ? `<circle id="profile-playhead" class="chart-playhead" cx="${firstPosition.x.toFixed(2)}" cy="${firstPosition.y.toFixed(2)}" r="6" />`
      : "";
    const markup = `<svg class="profile-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Flood depth in inches over elapsed minutes, with ${points.length} snapshot profile points">
      <title>Flood depth over event time</title>
      <desc>FloodNet measured profile. Gaps in the snapshot are left open.</desc>
      ${grid}
      <line class="chart-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" />
      <line class="chart-axis" x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${width - margin.right}" y2="${margin.top + plotHeight}" />
      ${paths}
      ${playhead}
      ${yLabels}
      ${xLabels}
      <text x="${margin.left + plotWidth / 2}" y="${height - 3}" text-anchor="middle">Elapsed time (min)</text>
      <text x="15" y="${margin.top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 15 ${margin.top + plotHeight / 2})">Depth (in)</text>
    </svg>`;
    return { markup, positions };
  }

  function attachReplayControls(event, positions) {
    const range = document.getElementById("profile-range");
    const readout = document.getElementById("profile-readout");
    const playButton = document.getElementById("replay-toggle");
    const resetButton = document.getElementById("replay-reset");
    const playhead = document.getElementById("profile-playhead");
    let index = 0;

    const update = (nextIndex) => {
      index = Math.max(0, Math.min(event.profile.length - 1, nextIndex));
      range.value = String(index);
      const point = event.profile[index];
      const elapsed = point.elapsedSeconds === null || point.elapsedSeconds === undefined
        ? "[UNKNOWN]"
        : formatNumber(Number(point.elapsedSeconds) / 60);
      const depth = point.depthInches === null || point.depthInches === undefined
        ? "[UNKNOWN]"
        : formatNumber(point.depthInches);
      readout.textContent = `${elapsed} min · ${depth} in`;
      range.setAttribute("aria-valuetext", `${elapsed} minutes elapsed, depth ${depth} inches`);
      const position = positions[index];
      if (playhead && position) {
        playhead.setAttribute("cx", position.x.toFixed(2));
        playhead.setAttribute("cy", position.y.toFixed(2));
        playhead.style.display = "";
      } else if (playhead) {
        playhead.style.display = "none";
      }
    };

    range.addEventListener("input", () => update(Number(range.value)));
    resetButton.addEventListener("click", () => {
      stopPlayback();
      playButton.textContent = "Play replay";
      update(0);
    });
    playButton.addEventListener("click", () => {
      if (playbackTimer !== null) {
        stopPlayback();
        playButton.textContent = "Play replay";
        return;
      }
      if (index >= event.profile.length - 1) update(0);
      playButton.textContent = "Pause replay";
      playbackTimer = window.setInterval(() => {
        if (index >= event.profile.length - 1) {
          stopPlayback();
          playButton.textContent = "Play replay";
          return;
        }
        update(index + 1);
      }, 110);
    });
    update(0);
  }

  function stopPlayback() {
    if (playbackTimer !== null) {
      window.clearInterval(playbackTimer);
      playbackTimer = null;
    }
  }

  function formatTick(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
})();
