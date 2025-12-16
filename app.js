(() => {
  if (typeof CONFIG === "undefined") {
    throw new Error("CONFIG not found. Ensure config.js is loaded.");
  }

  if (!CONFIG.mapboxToken || CONFIG.mapboxToken.includes("YOUR_MAPBOX_TOKEN_HERE")) {
    console.warn("Mapbox token is missing. Add your token to config.js.");
  }

  mapboxgl.accessToken = CONFIG.mapboxToken;

  const map = new mapboxgl.Map({
    container: "map",
    style: CONFIG.mapStyle || "mapbox://styles/mapbox/light-v11",
    center: [-71.156, 42.415],
    zoom: 13.2,
    minZoom: 11.5,
  });

  const hoverCard = document.getElementById("hover-card");
  const details = document.getElementById("details-content");
  const landuseSelect = document.getElementById("landuse-filter");
  const searchStatus = document.getElementById("search-status");
  const clearSearchBtn = document.getElementById("clear-search");
  const detailsToggle = document.getElementById("details-toggle");
  const detailsContainer = document.getElementById("details-content");
  const legendToggle = document.getElementById("legend-toggle");
  const legendEl = document.getElementById("legend");

  let colorStops = [];
  let searchMarker = null;
  let geocoderCtrl = null;

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

  function computeBreaks(features) {
    const values = features
      .map((f) => Number(f.properties?.rev_per_acre))
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);

    if (!values.length) return [];

    // Deciles for a diverging scheme around the median.
    const qs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const deciles = qs.map((q) => quantile(values, q));
    return deciles;
  }

  function buildFillColorExpression(deciles) {
    // Diverging palette: salmon below median, green above, gray at median.
    const palette = [
      "#eb5a3c",
      "#f58a75",
      "#fbb7a8",
      "#fddbd2",
      "#e5e7eb", // median neutral
      "#c7ebc7",
      "#9cdda0",
      "#67c871",
      "#36a94c",
      "#1f7f38",
    ];
    // Ensure we have thresholds; if not, fall back to neutral.
    if (!deciles.length) {
      return ["case", ["==", ["get", "tax_exempt"], true], "#c7ccd6", "#2a3144"];
    }
    const thresholds = deciles; // p10..p90
    // Build a step expression using deciles.
    const stepExpr = ["step", ["get", "rev_per_acre"], palette[0]];
    thresholds.forEach((t, idx) => {
      stepExpr.push(t, palette[idx + 1]);
    });

    return [
      "case",
      ["==", ["get", "is_water"], true],
      "#8fc7ff",
      ["==", ["get", "tax_exempt"], true],
      "#111827",
      ["!", ["has", "rev_per_acre"]],
      "#2a3144",
      ["==", ["get", "rev_per_acre"], null],
      "#2a3144",
      stepExpr,
    ];
  }

  function renderLegend(deciles) {
    legendEl.innerHTML = `
      <div class="legend-header">
        <div>
          <h4>Revenue per acre</h4>
          <div class="legend-sub">Diverging (deciles)</div>
        </div>
      </div>
    `;
    if (!deciles.length) {
      legendEl.innerHTML += "<div class='legend-item'>No data</div>";
      return;
    }
    const palette = [
      "#eb5a3c",
      "#f58a75",
      "#fbb7a8",
      "#fddbd2",
      "#e5e7eb",
      "#c7ebc7",
      "#9cdda0",
      "#67c871",
      "#36a94c",
      "#1f7f38",
    ];

    const labels = [];
    const round = (n) => perAcre(Math.round(n));
    labels.push({ color: palette[0], text: `≤ ${round(deciles[0])}` });
    labels.push({ color: palette[1], text: `${round(deciles[0])} – ${round(deciles[1])}` });
    labels.push({ color: palette[2], text: `${round(deciles[1])} – ${round(deciles[2])}` });
    labels.push({ color: palette[3], text: `${round(deciles[2])} – ${round(deciles[3])}` });
    labels.push({ color: palette[4], text: `${round(deciles[3])} – ${round(deciles[4])}` }); // up to median band start
    labels.push({ color: palette[5], text: `~ Median (${round(deciles[4])})` });
    labels.push({ color: palette[6], text: `${round(deciles[4])} – ${round(deciles[5])}` });
    labels.push({ color: palette[7], text: `${round(deciles[5])} – ${round(deciles[6])}` });
    labels.push({ color: palette[8], text: `${round(deciles[6])} – ${round(deciles[7])}` });
    labels.push({ color: palette[9], text: `≥ ${round(deciles[8])}` });

    labels.reverse().forEach((entry) => {
      const item = document.createElement("div");
      item.className = "legend-item";
      item.innerHTML = `<span class="legend-swatch" style="background:${entry.color}"></span><span>${entry.text}</span>`;
      legendEl.appendChild(item);
    });

    const water = document.createElement("div");
    water.className = "legend-item";
    water.innerHTML = `<span class="legend-swatch" style="background:#8fc7ff"></span><span>Water / DCR</span>`;
    legendEl.appendChild(water);

    const exempt = document.createElement("div");
    exempt.className = "legend-item";
    exempt.innerHTML = `<span class="legend-swatch" style="background:#111827"></span><span>Tax-exempt (zeroed)</span>`;
    legendEl.appendChild(exempt);

    if (legendToggle) {
      if (window.innerWidth <= 960) {
        legendEl.classList.remove("mobile-visible");
        legendToggle.textContent = "Show legend";
      } else {
        legendEl.classList.add("mobile-visible");
        legendToggle.textContent = "";
      }
    }
  }

  function renderDetails(props) {
    if (!props) {
      details.innerHTML =
        '<div class="details-empty"><h3>Parcel details</h3><p>Click a parcel to see revenue per acre, assessed value, and use.</p></div>';
      return;
    }
    const addr = props["Full Address"] || props["MAP_PAR_ID"] || "Parcel";
    const useDesc = props["Landuse Description"] || props["Zoning Description"] || "—";
    const units =
      Number.isFinite(Number(props.unit_count)) && Number(props.unit_count) > 1
        ? Number(props.unit_count)
        : props["Number of Units"] || 1;
    details.innerHTML = `
      <div class="detail-header">
        <h3>${addr}</h3>
        <div class="pill">${useDesc}</div>
      </div>
      <div class="detail-grid">
        <div class="detail-card">
          <div class="detail-label">Revenue per acre</div>
          <div class="detail-value">${perAcre(props.rev_per_acre)}</div>
        </div>
        <div class="detail-card">
          <div class="detail-label">Estimated annual tax</div>
          <div class="detail-value">${currency(props.est_annual_tax)}</div>
        </div>
        <div class="detail-card">
          <div class="detail-label">Assessed value (total)</div>
          <div class="detail-value">${currency(props.total_value)}</div>
        </div>
        <div class="detail-card">
          <div class="detail-label">Parcel size (acres)</div>
          <div class="detail-value">${Number.isFinite(props.acres) ? props.acres.toFixed(3) : "—"}</div>
        </div>
        <div class="detail-card">
          <div class="detail-label">Units counted</div>
          <div class="detail-value">${units ?? "—"}</div>
        </div>
      </div>
    `;
  }

  function addMapLayers(geojson) {
    const breaks = computeBreaks(geojson.features);

    map.addSource("parcels", {
      type: "geojson",
      data: geojson,
      promoteId: "MAP_PAR_ID",
    });

    map.addLayer({
      id: "parcels-fill",
      type: "fill",
      source: "parcels",
      paint: {
        "fill-color": buildFillColorExpression(breaks),
        "fill-opacity": 0.8,
      },
    });

    map.addLayer({
      id: "parcels-line",
      type: "line",
      source: "parcels",
      paint: {
        "line-color": "#06182a",
        "line-width": 0.6,
      },
    });

    renderLegend(breaks);
  }

  function buildLandUseFilter(features) {
    const values = Array.from(
      new Set(
        features
          .map((f) => f.properties["Landuse Description"])
          .filter((v) => v && v.trim().length)
      )
    ).sort();

    values.forEach((val) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = val;
      landuseSelect.appendChild(opt);
    });
  }

  function extendBounds(coords, bounds) {
    if (!coords) return;
    if (typeof coords[0] === "number") {
      bounds.extend(coords);
      return;
    }
    coords.forEach((c) => extendBounds(c, bounds));
  }

  function fitToData(geojson) {
    const bounds = new mapboxgl.LngLatBounds();
    geojson.features.forEach((f) => {
      extendBounds(f.geometry?.coordinates, bounds);
    });
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 40, maxZoom: 16 });
    }
  }

  function applyLandUseFilter(value) {
    const filter =
      value === "all" ? ["has", "rev_per_acre"] : ["==", ["get", "Landuse Description"], value];
    ["parcels-fill", "parcels-line"].forEach((layer) => {
      if (map.getLayer(layer)) {
        map.setFilter(layer, ["all", filter]);
      }
    });
  }

  function wireInteractions() {
    map.on("mousemove", "parcels-fill", (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      map.getCanvas().style.cursor = "pointer";

      const props = feature.properties;
      hoverCard.classList.remove("hidden");
      hoverCard.style.left = `${e.point.x + 12}px`;
      hoverCard.style.top = `${e.point.y + 12}px`;
      hoverCard.innerHTML = `
        <div class="detail-label">${props["Full Address"] || props["MAP_PAR_ID"]}</div>
        <div class="detail-value">${perAcre(Number(props.rev_per_acre))}</div>
        <div class="detail-label">Assessed: ${currency(Number(props.total_value))}</div>
      `;
    });

    map.on("mouseleave", "parcels-fill", () => {
      map.getCanvas().style.cursor = "";
      hoverCard.classList.add("hidden");
    });

    map.on("click", "parcels-fill", (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      renderDetails(feature.properties);
    });
  }

  function selectParcelAtLngLat(lngLat) {
    if (!lngLat) return;
    const point = map.project(lngLat);
    const features = map.queryRenderedFeatures(point, { layers: ["parcels-fill"] });
    if (features && features.length) {
      renderDetails(features[0].properties);
    }
  }

  async function init() {
    geocoderCtrl = new MapboxGeocoder({
      accessToken: mapboxgl.accessToken,
      mapboxgl,
      marker: false,
      flyTo: { zoom: 16 },
      placeholder: "Search address",
    });
    document.getElementById("geocoder").appendChild(geocoderCtrl.onAdd(map));

    geocoderCtrl.on("result", (e) => {
      const center = e.result?.center;
      const label = e.result?.place_name || "Location";
      if (searchStatus) {
        searchStatus.textContent = label;
      }
      if (searchMarker) {
        searchMarker.remove();
      }
      if (center) {
        searchMarker = new mapboxgl.Marker({ color: "#111827", scale: 0.8 })
          .setLngLat(center)
          .addTo(map);
        selectParcelAtLngLat(center);
      }
    });

    geocoderCtrl.on("clear", () => {
      if (searchMarker) {
        searchMarker.remove();
        searchMarker = null;
      }
      if (searchStatus) searchStatus.textContent = "";
      renderDetails(null);
    });

    if (clearSearchBtn) {
      clearSearchBtn.onclick = () => {
        if (geocoderCtrl) geocoderCtrl.clear();
        if (searchMarker) {
          searchMarker.remove();
          searchMarker = null;
        }
        if (searchStatus) searchStatus.textContent = "";
        renderDetails(null);
      };
    }

    const response = await fetch(CONFIG.dataUrl);
    const geojson = await response.json();

    map.on("load", () => {
      addMapLayers(geojson);
      buildLandUseFilter(geojson.features);
      wireInteractions();
      fitToData(geojson);
    });

    landuseSelect.addEventListener("change", (e) => {
      applyLandUseFilter(e.target.value);
    });

    if (detailsToggle && detailsContainer) {
      detailsToggle.onclick = () => {
        const expanded = detailsContainer.classList.toggle("expanded");
        detailsToggle.textContent = expanded ? "Hide details ⌃" : "Show details ⌄";
      };
    }

    if (legendToggle && legendEl) {
      legendToggle.onclick = () => {
        const visible = legendEl.classList.toggle("mobile-visible");
        legendToggle.textContent = visible ? "Hide legend" : "Show legend";
      };
    }
  }

  init().catch((err) => {
    console.error(err);
    alert("Failed to load parcels data. Check console for details.");
  });
})();
