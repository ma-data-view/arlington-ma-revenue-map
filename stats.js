(() => {
  if (typeof CONFIG === "undefined") {
    throw new Error("CONFIG not found. Ensure config.js is loaded.");
  }

  const tableEl = document.getElementById("stats-table");
  const countEl = document.getElementById("stats-count");

  const currency = (n, prefix = "$") =>
    Number.isFinite(n) ? `${prefix}${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—";

  const perAcre = (n) =>
    Number.isFinite(n) ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}/acre` : "—";

  function quantile(sortedValues, q) {
    if (!sortedValues.length) return 0;
    const pos = (sortedValues.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sortedValues[base + 1] !== undefined) {
      return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
    }
    return sortedValues[base];
  }

  function computeStats(features) {
    const byLu = {};
    features.forEach((f) => {
      const lu = f.properties["Landuse Description"] || "Unknown";
      const v = Number(f.properties?.rev_per_acre);
      if (!Number.isFinite(v) || v <= 0) return;
      if (!byLu[lu]) byLu[lu] = [];
      byLu[lu].push(v);
    });
    const stats = [];
    let globalMax = 0;
    Object.entries(byLu).forEach(([lu, arr]) => {
      const sorted = arr.sort((a, b) => a - b);
      const s = {
        landuse: lu,
        count: sorted.length,
        p10: quantile(sorted, 0.1),
        p25: quantile(sorted, 0.25),
        median: quantile(sorted, 0.5),
        p75: quantile(sorted, 0.75),
        p90: quantile(sorted, 0.9),
        min: sorted[0],
        max: sorted[sorted.length - 1],
      };
      globalMax = Math.max(globalMax, s.p90, s.max);
      stats.push(s);
    });
    stats.sort((a, b) => b.median - a.median);
    return { stats, globalMax };
  }

  function render(stats, globalMax) {
    if (!tableEl) return;
    tableEl.innerHTML = "";
    stats.forEach((s) => {
      const width = 200;
      const scale = (val) => (globalMax > 0 ? Math.max(0, Math.min(width, (val / globalMax) * width)) : 0);
      const parts = {
        min: scale(s.min),
        p10: scale(s.p10),
        p25: scale(s.p25),
        median: scale(s.median),
        p75: scale(s.p75),
        p90: scale(s.p90),
        max: scale(s.max),
      };
      const row = document.createElement("div");
      row.className = "stats-row";
      row.innerHTML = `
        <div class="stats-row__lu">${s.landuse}</div>
        <div class="stats-row__count">${s.count.toLocaleString()}</div>
        <div class="stats-row__med">${perAcre(s.median)}</div>
        <div class="stats-row__spark">
          <svg viewBox="0 0 ${width} 32" preserveAspectRatio="none">
            <line x1="${parts.min}" y1="16" x2="${parts.max}" y2="16" stroke="#4b5563" stroke-width="2" />
            <rect x="${parts.p25}" y="8" width="${Math.max(parts.p75 - parts.p25, 2)}" height="16" fill="#9cdda0" opacity="0.6" stroke="#4b5563" />
            <line x1="${parts.median}" y1="6" x2="${parts.median}" y2="26" stroke="#1f7f38" stroke-width="2" />
            <line x1="${parts.p10}" y1="10" x2="${parts.p10}" y2="22" stroke="#9ca3af" stroke-width="1.5" />
            <line x1="${parts.p90}" y1="10" x2="${parts.p90}" y2="22" stroke="#9ca3af" stroke-width="1.5" />
          </svg>
        </div>
        <div class="stats-row__p10">${perAcre(s.p10)}</div>
        <div class="stats-row__p90">${perAcre(s.p90)}</div>
      `;
      tableEl.appendChild(row);
    });
  }

  async function init() {
    const response = await fetch(CONFIG.dataUrl);
    const geojson = await response.json();
    const { stats, globalMax } = computeStats(geojson.features);
    if (countEl) {
      const total = geojson.features.length.toLocaleString();
      countEl.textContent = `${stats.length} land uses · ${total} parcels`;
    }
    render(stats, globalMax);
  }

  init().catch((err) => {
    console.error(err);
    if (countEl) countEl.textContent = "Failed to load data";
  });
})();
