(() => {
  "use strict";

  const fileInput = document.getElementById("card-file");
  const chooseButton = document.getElementById("choose-file");
  const loadStatus = document.getElementById("load-status");
  const cardRegion = document.getElementById("card-region");

  chooseButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", onFileSelected);

  async function onFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    setStatus("Reading card_data.json…");
    cardRegion.replaceChildren();

    try {
      if (file.name !== "card_data.json") {
        throw new Error("Choose the generated card_data.json file.");
      }
      const card = JSON.parse(await file.text());
      validateCard(card);
      renderCard(card);
      setStatus("Historical event card loaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read this card file.", true);
    } finally {
      fileInput.value = "";
    }
  }

  function validateCard(card) {
    if (!card || typeof card !== "object") throw new Error("The selected file is not a card object.");
    if (!card.event || !card.provenance || !card.context) {
      throw new Error("The card is missing event, provenance, or context data.");
    }
    if (!Array.isArray(card.event.profile) || card.event.profile.length === 0) {
      throw new Error("The card has no FloodNet depth profile.");
    }
    if (card.event.evidenceLabel !== "measured") {
      throw new Error("The event is not labelled as measured evidence.");
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

  function formatUtc(value, options = {}) {
    if (value === null || value === undefined || value === "") return "Unavailable";
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
    if (value === null || value === undefined || value === "") return "Unavailable";
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : "Unavailable";
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

  function renderCard(card) {
    const event = card.event;
    const provenance = card.provenance;
    const context = card.context;
    const sourceUrl = safeHttpsUrl(provenance.url);
    const sourceMarkup = sourceUrl
      ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(provenance.dataset)}</a>`
      : `<strong>${escapeHtml(provenance.dataset)}</strong>`;
    const profileSvg = buildProfileSvg(event.profile, event.maxDepthIn, event.durationMin);
    const weather = context.weather || {};
    const reports = context.reports || {};
    const inference = context.inference || {};
    const refusalNote = context.refusalNote || "This historical event does not establish present road passability or drainage condition, and does not describe locations without a selected sensor record.";

    cardRegion.innerHTML = `
      <article class="event-card">
        <header class="card-header">
          <div class="card-kicker">
            ${pill("Measured", "measured")}
            <span class="event-date">${escapeHtml(formatUtc(event.startUtc, { longMonth: true }))}</span>
          </div>
          <h2>${escapeHtml(event.sensorName)}</h2>
          <p class="sensor-line">Historical FloodNet event · non-tidal sensor · ${escapeHtml(event.sensorId)}</p>
        </header>

        <section class="stats-grid" aria-label="Event measurements">
          <div class="stat-card">
            <span class="stat-label">Maximum measured depth</span>
            <strong class="stat-value">${formatNumber(event.maxDepthIn)} <span class="stat-unit">in</span></strong>
          </div>
          <div class="stat-card">
            <span class="stat-label">Event duration</span>
            <strong class="stat-value">${formatNumber(event.durationMin)} <span class="stat-unit">min</span></strong>
          </div>
        </section>

        <section class="profile-section" aria-labelledby="profile-heading">
          <div class="section-heading">
            <div>
              <h3 id="profile-heading">Flood-depth timeline</h3>
              <p>Measured profile · ${event.profile.length} recorded points</p>
            </div>
            ${pill("measured", "measured")}
          </div>
          <div class="chart-wrap">${profileSvg}</div>
          <p class="chart-caption">Depth in inches by elapsed time from event start. Gaps are left open; no missing points are filled.</p>
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
            <span>Source</span>
            ${sourceMarkup}
            <strong>Dataset ${escapeHtml(provenance.datasetId)}</strong>
          </div>
          <div class="provenance-item">
            <span>Event window · UTC</span>
            <strong>${escapeHtml(formatUtc(event.startUtc))}<br>to ${escapeHtml(formatUtc(event.endUtc))}</strong>
          </div>
          <div class="provenance-item">
            <span>Snapshot as of</span>
            <strong>${escapeHtml(formatUtc(provenance.snapshotAsOf))}</strong>
          </div>
          <div class="provenance-item">
            <span>Source dataset updated</span>
            <strong>${escapeHtml(formatUtc(provenance.updatedAt))}</strong>
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
  }

  function renderUnavailableRow(title, evidenceType, status, reason) {
    const type = ["forecast", "reported"].includes(evidenceType) ? evidenceType : "unavailable";
    return `
      <div class="evidence-row">
        <div class="evidence-labels">
          ${pill(type, type)}
          ${pill(status, status === "unavailable" ? "unavailable" : type)}
        </div>
        <div class="evidence-copy">
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(reason)}</p>
        </div>
      </div>`;
  }

  function buildProfileSvg(points, publishedMax, durationMinutes) {
    const width = 640;
    const height = 280;
    const margin = { top: 18, right: 18, bottom: 43, left: 54 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const durationSeconds = durationMinutes === null || durationMinutes === undefined
      ? NaN
      : Number(durationMinutes) * 60;
    const profileTimes = points
      .map((point) => point.elapsedSeconds === null || point.elapsedSeconds === undefined
        ? NaN
        : Number(point.elapsedSeconds))
      .filter(Number.isFinite);
    const maxX = Math.max(
      ...profileTimes,
      Number.isFinite(durationSeconds) ? durationSeconds : 0,
      1,
    );
    const validDepthValues = points
      .map((point) => point.depthInches === null || point.depthInches === undefined ? NaN : Number(point.depthInches))
      .filter(Number.isFinite);
    const publishedMaxValue = publishedMax === null || publishedMax === undefined ? NaN : Number(publishedMax);
    const yExtent = Number.isFinite(publishedMaxValue)
      ? publishedMaxValue
      : Math.max(...validDepthValues, 0);
    const maxY = Math.max(5, Math.ceil(yExtent / 5) * 5);
    const validDepthCount = points.filter((point) =>
      point.elapsedSeconds !== null && point.elapsedSeconds !== undefined &&
      point.depthInches !== null && point.depthInches !== undefined &&
      Number.isFinite(Number(point.elapsedSeconds)) && Number.isFinite(Number(point.depthInches)),
    ).length;
    if (validDepthCount === 0) {
      return '<div class="profile-gap" role="status">Depth profile unavailable. No chart values are shown.</div>';
    }

    const x = (seconds) => margin.left + (seconds / maxX) * plotWidth;
    const y = (depth) => margin.top + plotHeight - (depth / maxY) * plotHeight;
    const xTicks = [0, maxX / 2, maxX];
    const yTicks = [0, maxY / 2, maxY];

    const grid = [
      ...yTicks.map((tick) => `<line class="chart-grid" x1="${margin.left}" y1="${y(tick)}" x2="${width - margin.right}" y2="${y(tick)}" />`),
      ...xTicks.map((tick) => `<line class="chart-grid" x1="${x(tick)}" y1="${margin.top}" x2="${x(tick)}" y2="${margin.top + plotHeight}" />`),
    ].join("");

    const yLabels = yTicks.map((tick) =>
      `<text x="${margin.left - 10}" y="${y(tick) + 4}" text-anchor="end">${formatTick(tick)}</text>`,
    ).join("");
    const xLabels = xTicks.map((tick) =>
      `<text x="${x(tick)}" y="${height - 19}" text-anchor="middle">${formatTick(tick / 60)}</text>`,
    ).join("");

    const segments = [];
    let segment = [];
    for (const point of points) {
      const seconds = point.elapsedSeconds === null || point.elapsedSeconds === undefined
        ? NaN
        : Number(point.elapsedSeconds);
      const depth = point.depthInches === null || point.depthInches === undefined
        ? NaN
        : Number(point.depthInches);
      if (!Number.isFinite(seconds) || !Number.isFinite(depth)) {
        if (segment.length) segments.push(segment);
        segment = [];
        continue;
      }
      segment.push({ x: x(seconds), y: y(depth) });
    }
    if (segment.length) segments.push(segment);

    const paths = segments
      .filter((part) => part.length > 1)
      .map((part) => {
        const commands = part.map((point, index) =>
          `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`,
        );
        return `<path class="chart-profile" d="${commands.join(" ")}" />`;
      })
      .join("");

    return `<svg class="profile-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Flood depth in inches over elapsed minutes, with ${points.length} measured profile points">
      <title>Flood depth over event time</title>
      <desc>FloodNet measured depth profile. Missing profile values are shown as breaks.</desc>
      ${grid}
      <line class="chart-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" />
      <line class="chart-axis" x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${width - margin.right}" y2="${margin.top + plotHeight}" />
      ${paths}
      ${yLabels}
      ${xLabels}
      <text x="${margin.left + plotWidth / 2}" y="${height - 3}" text-anchor="middle">Elapsed time (min)</text>
      <text x="15" y="${margin.top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 15 ${margin.top + plotHeight / 2})">Depth (in)</text>
    </svg>`;
  }

  function formatTick(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
})();
