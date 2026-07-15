import { Deck } from '@deck.gl/core';
import { BASEMAP, VectorTileLayer, colorCategories, colorBins } from '@deck.gl/carto';
import maplibregl from 'maplibre-gl';
import {
  vectorTableSource,
  addFilter,
  removeFilter,
  FilterType,
  type Filters,
} from '@carto/api-client';
import * as cartoColors from 'cartocolor';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const cartoConfig = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
  accessToken: import.meta.env.VITE_API_ACCESS_TOKEN,
  connectionName: import.meta.env.VITE_CONNECTION_NAME,
};

const TABLES = {
  customers: import.meta.env.VITE_TABLE_CUSTOMERS,
  existing: import.meta.env.VITE_TABLE_EXISTING,
  scoring: import.meta.env.VITE_TABLE_SCORING,
};

const TIER_DOMAIN = ['GOLD', 'SILVER', 'BRONZE'];
const TIER_PALETTE = 'Vivid';
const SCORE_DOMAIN = [30, 40, 50, 60]; // 4 edges -> 5 buckets
const SCORE_PALETTE = 'Sunset';
const EXISTING_COLOR: [number, number, number] = [71, 219, 153]; // --color-secondary

const INITIAL_VIEW_STATE = {
  longitude: -99.145,
  latitude: 19.38,
  zoom: 10.3,
  pitch: 0,
  bearing: 0,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tierFilter: Filters = {};
let activeTier: string | null = null; // null = all
let selectedSiteId: string | null = null;
let rankingRows: any[] = [];

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function buildCustomersSource() {
  return vectorTableSource({
    ...cartoConfig,
    tableName: TABLES.customers,
    columns: ['customer_id', 'borough', 'tier', 'monthly_orders', 'geom'],
    filters: tierFilter,
  });
}

const existingSource = vectorTableSource({
  ...cartoConfig,
  tableName: TABLES.existing,
  columns: ['hub_id', 'name', 'borough', 'opened_on', 'status', 'geom'],
});

const scoringSource = vectorTableSource({
  ...cartoConfig,
  tableName: TABLES.scoring,
  columns: [
    'site_id', 'name', 'type', 'borough', 'lat', 'lon', 'assigned_customers', 'weighted_demand',
    'avg_distance_km', 'pct_within_8km', 'total_monthly_orders',
    'composite_score', 'ranking', 'geom',
  ],
});

let customersSource = buildCustomersSource();

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function buildLayers() {
  const customersLayer = new VectorTileLayer({
    id: 'customers',
    data: customersSource,
    pickable: true,
    pointRadiusMinPixels: 2,
    getPointRadius: 20,
    pointRadiusUnits: 'meters',
    getFillColor: colorCategories({
      attr: 'tier',
      domain: TIER_DOMAIN,
      colors: TIER_PALETTE,
    }),
    opacity: 0.55,
  });

  const existingLayer = new VectorTileLayer({
    id: 'existing',
    data: existingSource,
    pickable: true,
    filled: true,
    stroked: true,
    getFillColor: EXISTING_COLOR,
    getLineColor: [255, 255, 255],
    lineWidthMinPixels: 2,
    pointRadiusUnits: 'pixels',
    getPointRadius: 12,
    pointRadiusMinPixels: 12,
  });

  const scoringLayer = new VectorTileLayer({
    id: 'scoring',
    data: scoringSource,
    pickable: true,
    filled: true,
    stroked: true,
    getFillColor: colorBins({
      attr: 'composite_score',
      domain: SCORE_DOMAIN,
      colors: SCORE_PALETTE,
    }),
    getLineColor: (f: any) =>
      f.properties.site_id === selectedSiteId ? [22, 41, 69, 255] : [255, 255, 255, 220],
    getLineWidth: (f: any) => (f.properties.site_id === selectedSiteId ? 3 : 1),
    lineWidthUnits: 'pixels',
    lineWidthMinPixels: 1,
    pointRadiusUnits: 'pixels',
    getPointRadius: (f: any) => 6 + Math.max(0, f.properties.composite_score || 0) * 0.35,
    pointRadiusMinPixels: 6,
    updateTriggers: {
      getLineColor: [selectedSiteId],
      getLineWidth: [selectedSiteId],
    },
    onClick: ({ object }: any) => {
      if (object) selectSite(object.properties.site_id);
    },
  });

  return [customersLayer, scoringLayer, existingLayer];
}

// ---------------------------------------------------------------------------
// Deck + MapLibre
// ---------------------------------------------------------------------------

const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAP.POSITRON,
  interactive: false,
  ...INITIAL_VIEW_STATE,
});

const deck = new Deck({
  canvas: 'deck-canvas',
  initialViewState: INITIAL_VIEW_STATE,
  controller: true,
  layers: buildLayers(),
  getTooltip: ({ object, layer }: any) => {
    if (!object) return null;
    const p = object.properties;
    if (layer.id === 'customers') {
      return {
        html: `<b>${p.tier}</b><br>${p.borough}<br>${p.monthly_orders} orders/mo`,
        style: tooltipStyle,
      };
    }
    if (layer.id === 'existing') {
      return {
        html: `<b>${p.name}</b><br>${p.borough}<br>Active since ${p.opened_on}`,
        style: tooltipStyle,
      };
    }
    if (layer.id === 'scoring') {
      return {
        html: `<b>${p.name}</b><br>Score: ${Number(p.composite_score).toFixed(1)} · #${p.ranking}<br>${p.assigned_customers} assigned customers`,
        style: tooltipStyle,
      };
    }
    return null;
  },
  onViewStateChange: ({ viewState }: any) => {
    const { longitude, latitude, zoom, pitch, bearing } = viewState;
    map.jumpTo({ center: [longitude, latitude], zoom, pitch, bearing });
  },
});

const tooltipStyle = {
  background: '#fff',
  color: '#2C3032',
  padding: '8px 10px',
  borderRadius: '6px',
  boxShadow: '0 2px 8px rgba(0,0,0,.15)',
};

function rebuildLayers() {
  deck.setProps({ layers: buildLayers() });
}

// ---------------------------------------------------------------------------
// Tier filter (top bar chips)
// ---------------------------------------------------------------------------

const TIER_COLORS: Record<string, string> = {};
{
  const stops = (cartoColors as any)[TIER_PALETTE][TIER_DOMAIN.length] as string[];
  TIER_DOMAIN.forEach((s, i) => (TIER_COLORS[s] = stops[i]));
}

function renderTierFilter() {
  const root = document.getElementById('segment-filter')!;
  const chips = ['All', ...TIER_DOMAIN];
  root.innerHTML = chips
    .map((s) => {
      const isAll = s === 'All';
      const active = isAll ? activeTier === null : activeTier === s;
      const dot = isAll ? '' : `<span class="dot" style="background:${TIER_COLORS[s]}"></span>`;
      return `<button class="segment-chip${active ? ' active' : ''}" data-tier="${isAll ? '' : s}">${dot}${s}</button>`;
    })
    .join('');

  root.querySelectorAll<HTMLButtonElement>('.segment-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tier = btn.dataset.tier || null;
      activeTier = tier;
      removeFilter(tierFilter, { column: 'tier', owner: 'tier-filter' });
      if (tier) {
        addFilter(tierFilter, {
          column: 'tier',
          type: FilterType.IN,
          values: [tier],
          owner: 'tier-filter',
        });
      }
      customersSource = buildCustomersSource();
      rebuildLayers();
      renderTierFilter();
    });
  });
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function renderLegend() {
  const scoreBuckets = SCORE_DOMAIN.length + 1;
  const scoreColors = (cartoColors as any)[SCORE_PALETTE][scoreBuckets] as string[];
  const scoreLabels = [
    `< ${SCORE_DOMAIN[0]}`,
    ...SCORE_DOMAIN.slice(0, -1).map((d, i) => `${d} – ${SCORE_DOMAIN[i + 1]}`),
    `≥ ${SCORE_DOMAIN[SCORE_DOMAIN.length - 1]}`,
  ];

  const root = document.getElementById('legend')!;
  root.innerHTML = `
    <div class="legend-group">
      <h4>Customers by tier</h4>
      ${TIER_DOMAIN.map(
        (s) => `<div class="legend-row"><span class="legend-swatch circle" style="background:${TIER_COLORS[s]}"></span><span class="legend-label">${s}</span></div>`
      ).join('')}
    </div>
    <div class="legend-group">
      <h4>Composite score (sites)</h4>
      ${scoreLabels
        .map(
          (label, i) =>
            `<div class="legend-row"><span class="legend-swatch" style="background:${scoreColors[i]}"></span><span class="legend-label">${label}</span></div>`
        )
        .join('')}
    </div>
    <div class="legend-group">
      <h4>Existing hub</h4>
      <div class="legend-row"><span class="legend-swatch circle" style="background:rgb(${EXISTING_COLOR.join(',')})"></span><span class="legend-label">Active</span></div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

async function renderKPIs() {
  const root = document.getElementById('kpis')!;
  const { widgetSource: customersWidgets } = await customersSource;
  const { widgetSource: scoringWidgets } = await scoringSource;

  const candidateFilter: Filters = {};
  addFilter(candidateFilter, {
    column: 'type',
    type: FilterType.IN,
    values: ['candidate'],
    owner: 'kpi-only',
  });

  const [totalCustomers, avgCoverage] = await Promise.all([
    customersWidgets.getFormula({ column: 'customer_id', operation: 'count' }),
    scoringWidgets.getFormula({
      column: 'pct_within_8km',
      operation: 'avg',
      filters: candidateFilter,
    }),
  ]);

  root.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-value">${(totalCustomers?.value ?? 0).toLocaleString()}</div>
      <div class="kpi-label">Total customers</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value">${(avgCoverage?.value ?? 0).toFixed(0)}%</div>
      <div class="kpi-label">Avg. coverage (8km, candidates)</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Ranking list
// ---------------------------------------------------------------------------

async function renderRanking() {
  const root = document.getElementById('ranking-list')!;
  const { widgetSource } = await scoringSource;
  const { rows } = await widgetSource.getTable({
    columns: [
      'site_id', 'name', 'type', 'borough', 'composite_score', 'ranking',
      'assigned_customers', 'weighted_demand', 'avg_distance_km', 'pct_within_8km',
      'total_monthly_orders', 'lat', 'lon',
    ],
    sortBy: 'ranking',
    sortDirection: 'asc',
    limit: 20,
  });
  rankingRows = rows;

  root.innerHTML = rankingRows
    .map(
      (r) => `
      <div class="ranking-row ${r.type}${r.site_id === selectedSiteId ? ' selected' : ''}" data-site-id="${r.site_id}">
        <div class="ranking-rank">${r.ranking}</div>
        <div class="ranking-info">
          <div class="ranking-name">${r.name}</div>
          <div class="ranking-meta">${r.type === 'existing' ? 'Active' : 'Candidate'} · ${r.borough}</div>
        </div>
        <div class="ranking-score">${Number(r.composite_score).toFixed(1)}</div>
      </div>`
    )
    .join('');

  root.querySelectorAll<HTMLDivElement>('.ranking-row').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.siteId!;
      selectSite(id);
      const site = rankingRows.find((r) => r.site_id === id);
      if (site) flyTo(Number(site.lon), Number(site.lat));
    });
  });

  renderScatter();
}

// ---------------------------------------------------------------------------
// Scatter chart: weighted demand vs. avg distance
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function scoreColorHex(score: number): string {
  const buckets = SCORE_DOMAIN.length + 1;
  const colors = (cartoColors as any)[SCORE_PALETTE][buckets] as string[];
  let idx = 0;
  while (idx < SCORE_DOMAIN.length && score >= SCORE_DOMAIN[idx]) idx++;
  return colors[idx];
}

function renderScatter() {
  const container = document.getElementById('scatter-chart')!;
  if (!rankingRows.length) return;

  const width = 300;
  const height = 220;
  const margin = { top: 12, right: 16, bottom: 30, left: 16 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const demands = rankingRows.map((r) => Number(r.weighted_demand));
  const distances = rankingRows.map((r) => Number(r.avg_distance_km));
  const maxDemand = Math.max(...demands) * 1.1 || 1;
  const maxDistance = Math.max(...distances) * 1.15 || 1;

  const xPos = (v: number) => margin.left + (v / maxDemand) * plotW;
  const yPos = (v: number) => margin.top + (v / maxDistance) * plotH;

  const medianDemand = median(demands);
  const medianDistance = median(distances);

  const points = rankingRows
    .map((r) => {
      const cx = xPos(Number(r.weighted_demand)).toFixed(1);
      const cy = yPos(Number(r.avg_distance_km)).toFixed(1);
      const radius = (4 + Math.max(0, Number(r.composite_score)) * 0.12).toFixed(1);
      const fill = scoreColorHex(Number(r.composite_score));
      const isExisting = r.type === 'existing';
      const isSelected = r.site_id === selectedSiteId;
      const stroke = isSelected ? '#162945' : isExisting ? '#162945' : '#FFFFFF';
      const strokeWidth = isSelected ? 3 : isExisting ? 2 : 1;
      const tooltip = `${r.name} (#${r.ranking}) — score ${Number(r.composite_score).toFixed(1)}\nDemand: ${r.weighted_demand} · Distance: ${Number(r.avg_distance_km).toFixed(2)} km`;
      return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" data-site-id="${r.site_id}" class="scatter-point"><title>${tooltip}</title></circle>`;
    })
    .join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
      <line x1="${margin.left}" y1="${yPos(medianDistance).toFixed(1)}" x2="${width - margin.right}" y2="${yPos(medianDistance).toFixed(1)}" class="scatter-guide" />
      <line x1="${xPos(medianDemand).toFixed(1)}" y1="${margin.top}" x2="${xPos(medianDemand).toFixed(1)}" y2="${height - margin.bottom}" class="scatter-guide" />
      <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" class="scatter-axis" />
      <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" class="scatter-axis" />
      ${points}
      <text x="${width - margin.right}" y="${height - margin.bottom + 12}" class="scatter-label" text-anchor="end">more demand →</text>
      <text x="${margin.left}" y="${margin.top - 2}" class="scatter-label" text-anchor="start">less distance ↑</text>
      <text x="${width - margin.right - 4}" y="${margin.top + 12}" class="scatter-quadrant-label" text-anchor="end">Best</text>
    </svg>
  `;

  container.querySelectorAll<SVGCircleElement>('.scatter-point').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.siteId!;
      selectSite(id);
      const site = rankingRows.find((r) => r.site_id === id);
      if (site) flyTo(Number(site.lon), Number(site.lat));
    });
  });
}

// ---------------------------------------------------------------------------
// Detail panel + selection
// ---------------------------------------------------------------------------

function selectSite(siteId: string) {
  selectedSiteId = siteId;
  rebuildLayers();
  renderRanking();
  renderDetail();
}

function renderDetail() {
  const section = document.getElementById('detail-section')!;
  const card = document.getElementById('detail-card')!;
  const site = rankingRows.find((r) => r.site_id === selectedSiteId);
  if (!site) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  card.innerHTML = `
    <h3>${site.name} <span class="badge ${site.type}">${site.type}</span></h3>
    <div class="detail-row"><span>Rank</span><span>#${site.ranking}</span></div>
    <div class="detail-row"><span>Composite score</span><span>${Number(site.composite_score).toFixed(1)}</span></div>
    <div class="detail-row"><span>Borough</span><span>${site.borough}</span></div>
    <div class="detail-row"><span>Assigned customers</span><span>${site.assigned_customers}</span></div>
    <div class="detail-row"><span>Avg. distance</span><span>${Number(site.avg_distance_km).toFixed(2)} km</span></div>
    <div class="detail-row"><span>% coverage (8km)</span><span>${Number(site.pct_within_8km).toFixed(1)}%</span></div>
    <div class="detail-row"><span>Total monthly orders</span><span>${site.total_monthly_orders}</span></div>
  `;
}

function flyTo(longitude: number, latitude: number) {
  if (longitude == null || latitude == null) return;
  const viewState = { ...INITIAL_VIEW_STATE, longitude, latitude, zoom: 13 };
  deck.setProps({ initialViewState: viewState });
  map.jumpTo({ center: [longitude, latitude], zoom: 13 });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

renderTierFilter();
renderLegend();
renderKPIs();
renderRanking();
