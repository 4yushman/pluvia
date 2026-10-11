(() => {
  "use strict";

  const fileInput = document.getElementById("card-file");
  const chooseButton = document.getElementById("choose-file");
  const loadStatus = document.getElementById("load-status");
  const explorer = document.getElementById("explorer");
  const eventSelect = document.getElementById("event-select");
  const selectionHint = document.getElementById("selection-hint");
  const selectionSummary = document.getElementById("selection-summary");
  const mapStage = document.getElementById("map-stage");
  const mapPoints = document.getElementById("map-points");
  const mapProvenance = document.getElementById("map-provenance");
  const cardRegion = document.getElementById("card-region");

  let cardData = null;
  let playbackTimer = null;

  chooseButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", onFileSelected);
  eventSelect.addEventListener("change", () => renderExplorer(eventSelect.value));

  async function onFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    setStatus("Reading card_data.json…");
    stopPlayback();
    explorer.hidden = true;
    cardRegion.replaceChildren();

    try {
      if (file.name !== "card_data.json") {
        throw new Error("Choose the generated card_data.json file.");
      }
      const parsed = JSON.parse(await file.text());
      validateCard(parsed);
      cardData = parsed;
      explorer.hidden = false;
      renderExplorer(cardData.defaultEventId);
      setStatus("Snapshot loaded. Select an event or map point.");
    } catch (error) {
      cardData = null;
      setStatus(error instanceof Error ? error.message : "Could not read this card file.", true);
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

  function renderExplorer(eventId) {
    if (!cardData) return;
    stopPlayback();
    const selected = cardData.events.find((item) => item.eventId === eventId)
      || cardData.events.find((item) => item.eventId === cardData.defaultEventId);
    if (!selected) return;

    eventSelect.innerHTML = cardData.events.map((item) => {
      const profileLabel = item.profileStatus === "available" ? "profile available" : "profile unavailable";
      return `<option value="${escapeHtml(item.eventId)}">${escapeHtml(item.rank)} · ${escapeHtml(item.sensorName)} · ${profileLabel}</option>`;
    }).join("");
    eventSelect.value = selected.eventId;
    renderSelectionSummary(selected);
    renderMap(selected.eventId);
    renderCard(selected);
  }

  function renderSelectionSummary(event) {
    const location = event.location || {};
    selectionHint.textContent = event.profileStatus === "available"
      ? "This event has a measured profile in the frozen snapshot."
      : "This event summary is present, but its profile is unavailable in the frozen snapshot.";
    selectionSummary.innerHTML = `
      <div class="selection-summary-top">
        <span class="rank-pill">${escapeHtml(event.rank)}</span>
        <span class="profile-state ${event.profileStatus === "available" ? "is-available" : "is-unavailable"}">${event.profileStatus === "available" ? "Profile available" : "Profile unavailable"}</span>
      </div>
      <strong>${escapeHtml(event.sensorName)}</strong>
      <span>${escapeHtml(known(location.borough))} · ZIP ${escapeHtml(known(location.zipcode))}</span>
      <span class="coordinate-line">${escapeHtml(coordinateText(location))}</span>`;
  }

  function coordinateText(location) {
    if (!location || location.latitude === null || location.latitude === undefined ||
        location.longitude === null || location.longitude === undefined) {
      return "Coordinates: [UNKNOWN]";
    }
    return `Coordinates: ${known(location.latitude)}, ${known(location.longitude)}`;
  }

  function renderMap(selectedEventId) {
    const locatedEvents = cardData.events.filter((event) => hasCoordinates(event.location));
    if (locatedEvents.length === 0) {
      mapStage.innerHTML = '<div class="map-empty">Map coordinates: [UNKNOWN]</div>';
      mapPoints.innerHTML = renderPointList(cardData.events, selectedEventId);
      attachPointSelection();
      renderMapProvenance();
      return;
    }

    const positions = mapPositions(locatedEvents);
    const grid = `<svg class="map-grid" viewBox="0 0 640 300" aria-hidden="true" focusable="false">
      <path d="M0 75H640 M0 150H640 M0 225H640 M160 0V300 M320 0V300 M480 0V300" />
    </svg>`;
    const markers = locatedEvents.map((event) => {
      const position = positions.get(event.eventId);
      const selected = event.eventId === selectedEventId;
      const statusClass = event.profileStatus === "available" ? "has-profile" : "no-profile";
      const label = shortRank(event.rank);
      const accessibleName = `${event.rank}, ${event.sensorName}, ${known(event.location.borough)}, ${coordinateText(event.location)}, ${event.profileStatus === "available" ? "profile available" : "profile unavailable"}`;
      return `<button class="map-marker ${statusClass} ${selected ? "is-selected" : ""}"
        type="button" data-map-event="${escapeHtml(event.eventId)}"
        style="left:${position.x.toFixed(3)}%;top:${position.y.toFixed(3)}%"
        aria-pressed="${selected}" aria-label="${escapeHtml(accessibleName)}">${escapeHtml(label)}</button>`;
    }).join("");
    mapStage.innerHTML = `${grid}<div class="map-marker-layer">${markers}</div>`;
    mapStage.querySelectorAll("[data-map-event]").forEach((button) => {
      button.addEventListener("click", () => renderExplorer(button.dataset.mapEvent));
    });
    mapPoints.innerHTML = renderPointList(cardData.events, selectedEventId);
    attachPointSelection();
    renderMapProvenance();
  }

  function hasCoordinates(location) {
    return location && Number.isFinite(Number(location.latitude)) &&
      location.latitude !== null && location.latitude !== "" &&
      Number.isFinite(Number(location.longitude)) &&
      location.longitude !== null && location.longitude !== "";
  }

  function mapPositions(events) {
    const meanLat = events.reduce((sum, event) => sum + Number(event.location.latitude), 0) / events.length;
    const scale = Math.cos(meanLat * Math.PI / 180);
    const points = events.map((event) => ({
      id: event.eventId,
      x: Number(event.location.longitude) * scale,
      y: Number(event.location.latitude),
    }));
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const pad = 12;
    const usable = 100 - pad * 2;
    return new Map(points.map((point) => ({
      id: point.id,
      x: spanX === 0 ? 50 : pad + ((point.x - minX) / spanX) * usable,
      y: spanY === 0 ? 50 : pad + ((maxY - point.y) / spanY) * usable,
    })).map((point) => [point.id, point]));
  }

  function renderPointList(events, selectedEventId) {
    return events.map((event) => {
      const location = event.location || {};
      const coordinate = hasCoordinates(location)
        ? `${known(location.latitude)}, ${known(location.longitude)}`
        : "[UNKNOWN]";
      const selected = event.eventId === selectedEventId;
      return `<button class="map-point-row ${selected ? "is-selected" : ""}"
        type="button" data-point-event="${escapeHtml(event.eventId)}" aria-pressed="${selected}">
        <span class="rank-pill">${escapeHtml(event.rank)}</span>
        <span class="map-point-copy"><strong>${escapeHtml(event.sensorName)}</strong>
          <span>${escapeHtml(known(location.borough))} · ${escapeHtml(coordinate)}</span></span>
        <span class="profile-state ${event.profileStatus === "available" ? "is-available" : "is-unavailable"}">${event.profileStatus === "available" ? "Replay" : "Unavailable"}</span>
      </button>`;
    }).join("");
  }

  function attachPointSelection() {
    mapPoints.querySelectorAll("[data-point-event]").forEach((button) => {
      button.addEventListener("click", () => renderExplorer(button.dataset.pointEvent));
    });
  }

  function renderMapProvenance() {
    const source = cardData.mapProvenance;
    const url = safeHttpsUrl(source.url);
    const sourceMarkup = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.datasetId)}</a>`
      : `<span>${escapeHtml(source.datasetId)}</span>`;
    mapProvenance.innerHTML = `Map source: ${sourceMarkup} · snapshot as of ${escapeHtml(formatUtc(source.snapshotAsOf))} · dataset updated ${escapeHtml(formatUtc(source.updatedAt))}.`;
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
