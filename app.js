(() => {
  const cfg = window.VT_DASHBOARD_CONFIG || {};
  const toastEl = document.getElementById("toast");

  const refs = {
    zoomResetBtn: document.getElementById("zoomResetBtn"),
    newTodayMetric: document.getElementById("newTodayMetric"),
    totalUsersMetric: document.getElementById("totalUsersMetric"),
    rangeUsersMetric: document.getElementById("rangeUsersMetric"),
    dailyAvgMetric: document.getElementById("dailyAvgMetric"),
    activeUsersMetric: document.getElementById("activeUsersMetric"),
    dayDeltaMetric: document.getElementById("dayDeltaMetric"),
    rangeLabelMetric: document.getElementById("rangeLabelMetric"),
    dailyChart: document.getElementById("dailyChart"),
    liveSessionPie: document.getElementById("liveSessionPie"),
    frequentUsersBar: document.getElementById("frequentUsersBar"),
    statusDistribution: document.getElementById("statusDistribution"),
    providerDistribution: document.getElementById("providerDistribution"),
  };

  const SUPA_URL = normalizeBaseUrl(cfg.SUPABASE_URL || "");
  const SUPA_KEY = String(cfg.SUPABASE_KEY || "").trim();
  const preDbConfig = normalizePreDbConfig(
    window.VT_PRE_DB_CONFIG || window.VT_HISTORICAL_DATA_CONFIG
  );
  let preDbRowsCache = null;

  const state = {
    search: "",
    autoRefresh: true,
    refreshSeconds: 30,
    maxAggregateRows: Number(cfg.MAX_AGGREGATE_ROWS) || 20000,
    timerId: null,
    loading: false,
    timezone: String(cfg.TIMEZONE || "Asia/Ho_Chi_Minh"),
    searchDebounceId: null,
    rowsForTimeline: [],
    summarySnapshot: {
      totalUsers: 0,
      newToday: 0,
      newYesterday: 0,
      activeUsers: 0,
      truncated: false,
    },
    zoom: {
      initialized: false,
      domainStartMs: 0,
      domainEndMs: 0,
      viewStartMs: 0,
      viewEndMs: 0,
      minWindowMs: 24 * 60 * 60 * 1000,
      maxWindowMs: 0,
    },
    pan: {
      active: false,
      startX: 0,
      startStartMs: 0,
      startEndMs: 0,
      targetEl: null,
    },
  };

  if (!SUPA_URL || !SUPA_KEY) {
    toast("Missing SUPABASE_URL or SUPABASE_KEY in config.js.");
    return;
  }

  init();

  function init() {
    applyDefaults();
    bindEvents();
    refreshDashboard();
    setupAutoRefresh();
  }

  function applyDefaults() {
    state.refreshSeconds = clampNumber(Number(cfg.DEFAULT_REFRESH_SECONDS) || 30, 5, 600);
    state.autoRefresh = true;
    updateZoomButtonsState();
  }

  function bindEvents() {
    if (refs.zoomResetBtn) {
      refs.zoomResetBtn.addEventListener("click", () => {
        resetZoomToRecentWeek();
      });
    }

    bindTimelineChartInteractions(refs.dailyChart);
    bindTimelineChartInteractions(refs.frequentUsersBar);

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerUp);
  }

  function bindTimelineChartInteractions(containerEl) {
    if (!containerEl) return;

    containerEl.addEventListener(
      "wheel",
      (event) => {
        handleChartWheel(event, containerEl);
      },
      { passive: false }
    );
    containerEl.addEventListener("pointerdown", (event) => {
      handleChartPointerDown(event, containerEl);
    });
  }

  function setupAutoRefresh() {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    if (!state.autoRefresh) return;
    state.timerId = setInterval(() => {
      refreshDashboard();
    }, state.refreshSeconds * 1000);
  }

  async function refreshDashboard(showToastOnError = false) {
    if (state.loading) return;
    state.loading = true;
    setLoadingState(true);

    try {
      const payload = preDbConfig.enabled
        ? await buildDashboardPayloadHybrid()
        : await buildDashboardPayloadFromSupabase();

      state.rowsForTimeline = payload.rowsForTimeline;
      state.summarySnapshot = {
        totalUsers: payload.totalUsers,
        newToday: payload.newToday,
        newYesterday: payload.newYesterday,
        activeUsers: payload.activeUsers,
        truncated: payload.truncated,
      };

      syncZoomDomainWithRows(state.rowsForTimeline);
      renderFromCurrentTimeline();
    } catch (error) {
      const msg = `Dashboard refresh failed: ${error.message || error}`;
      if (showToastOnError) toast(msg);
      console.error(error);
    } finally {
      setLoadingState(false);
      state.loading = false;
    }
  }

  async function buildDashboardPayloadFromSupabase() {
    const todayRange = getDayRange(0);
    const yesterdayRange = getDayRange(-1);
    const searchFilters = buildSearchFilterEntries(state.search);

    const [totalUsers, newToday, newYesterday, aggregateResult] = await Promise.all([
      fetchCount([]),
      fetchCount(rangeEntriesFor("created_at", todayRange.startIso, todayRange.endIso)),
      fetchCount(rangeEntriesFor("created_at", yesterdayRange.startIso, yesterdayRange.endIso)),
      fetchAggregateRows(searchFilters),
    ]);

    const rowsForTimeline = aggregateResult.rows.map((row) => ({
      ...row,
      status: "active",
      auth_provider: "local",
    }));

    return {
      totalUsers,
      newToday,
      newYesterday,
      activeUsers: totalUsers,
      rowsForTimeline,
      truncated: aggregateResult.truncated,
    };
  }

  async function buildDashboardPayloadHybrid() {
    const preDbRows = getPreDbRows();
    const preDbRowsForTimeline = applySearchFilterRows(preDbRows, state.search);
    const todayRange = getDayRange(0);
    const yesterdayRange = getDayRange(-1);
    const searchFilters = buildSearchFilterEntries(state.search);
    const cutoffStartIso = preDbConfig.dbFromStartIso;

    const todayDbFilters = buildDbRangeEntriesSinceCutoff(
      todayRange.startIso,
      todayRange.endIso,
      cutoffStartIso
    );
    const yesterdayDbFilters = buildDbRangeEntriesSinceCutoff(
      yesterdayRange.startIso,
      yesterdayRange.endIso,
      cutoffStartIso
    );

    const [dbTotalUsers, dbNewToday, dbNewYesterday, dbAggregateResult] = await Promise.all([
      fetchCount([["created_at", `gte.${cutoffStartIso}`]]),
      todayDbFilters ? fetchCount(todayDbFilters) : Promise.resolve(0),
      yesterdayDbFilters ? fetchCount(yesterdayDbFilters) : Promise.resolve(0),
      fetchAggregateRows([["created_at", `gte.${cutoffStartIso}`], ...searchFilters]),
    ]);

    const dbRowsForTimeline = dbAggregateResult.rows.map((row) => ({
      ...row,
      status: "active",
      auth_provider: "local",
    }));

    const rowsForTimeline = [...preDbRowsForTimeline, ...dbRowsForTimeline].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const preDbNewToday = countRowsInIsoRange(preDbRows, todayRange.startIso, todayRange.endIso);
    const preDbNewYesterday = countRowsInIsoRange(preDbRows, yesterdayRange.startIso, yesterdayRange.endIso);
    const totalUsers = preDbRows.length + dbTotalUsers;

    return {
      totalUsers,
      newToday: preDbNewToday + dbNewToday,
      newYesterday: preDbNewYesterday + dbNewYesterday,
      activeUsers: totalUsers,
      rowsForTimeline,
      truncated: dbAggregateResult.truncated,
    };
  }

  function renderFromCurrentTimeline() {
    const range = getRangeFromZoomState();
    if (!range) {
      renderMetrics({
        newToday: state.summarySnapshot.newToday,
        totalUsers: state.summarySnapshot.totalUsers,
        rangeUsersCount: 0,
        averagePerBucket: 0,
        activeUsers: state.summarySnapshot.activeUsers,
        dayDeltaText: buildDayDeltaText(state.summarySnapshot.newToday, state.summarySnapshot.newYesterday),
        rangeLabel: "No timeline data",
      });
      refs.dailyChart.innerHTML = `<p class="empty-note">No chart data.</p>`;
      renderLiveSessionPie();
      renderFrequentUsersBar(null);
      renderDistribution(refs.statusDistribution, {}, "No status data");
      renderDistribution(refs.providerDistribution, {}, "No provider data");
      updateZoomButtonsState();
      return;
    }

    const summary = summarizeRowsForRange(state.rowsForTimeline, range);
    const rangeUsersCount = countRowsInMsRange(state.rowsForTimeline, range.startMs, range.endMs);
    const averagePerBucket = summary.series.length ? rangeUsersCount / summary.series.length : 0;

    renderMetrics({
      newToday: state.summarySnapshot.newToday,
      totalUsers: state.summarySnapshot.totalUsers,
      rangeUsersCount,
      averagePerBucket,
      activeUsers: state.summarySnapshot.activeUsers,
      dayDeltaText: buildDayDeltaText(state.summarySnapshot.newToday, state.summarySnapshot.newYesterday),
      rangeLabel: range.label,
    });

    renderLineChart(summary.series, range, state.summarySnapshot.truncated);
    renderLiveSessionPie();
    renderFrequentUsersBar(range);
    renderDistribution(refs.statusDistribution, summary.statusCounts, "No status data");
    renderDistribution(refs.providerDistribution, summary.providerCounts, "No provider data");
    updateZoomButtonsState();
  }

  function renderMetrics(data) {
    refs.newTodayMetric.textContent = formatNumber(data.newToday);
    refs.totalUsersMetric.textContent = formatNumber(data.totalUsers);
    refs.rangeUsersMetric.textContent = formatNumber(data.rangeUsersCount);
    refs.dailyAvgMetric.textContent = formatNumber(data.averagePerBucket, 1);
    refs.activeUsersMetric.textContent = formatNumber(data.activeUsers);
    refs.dayDeltaMetric.textContent = data.dayDeltaText;
    refs.rangeLabelMetric.textContent = data.rangeLabel;
  }

  function renderLineChart(series, range, truncated) {
    if (!Array.isArray(series) || series.length === 0) {
      refs.dailyChart.innerHTML = `<p class="empty-note">No chart data.</p>`;
      return;
    }

    const width = Math.max(1080, Math.min(2800, series.length * 58));
    const height = 430;
    const margin = { top: 20, right: 34, bottom: 74, left: 84 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const baseY = margin.top + plotH;
    const maxY = Math.max(...series.map((item) => item.count), 1);
    const tickCount = 6;

    const points = series.map((item, idx) => {
      const ratioX = series.length === 1 ? 0.5 : idx / (series.length - 1);
      const x = margin.left + ratioX * plotW;
      const y = margin.top + (1 - item.count / maxY) * plotH;
      return { ...item, x, y };
    });

    const linePoints = points.map((p) => `${p.x},${p.y}`).join(" ");
    const areaPath =
      `M ${points[0].x} ${baseY} ` +
      points.map((p) => `L ${p.x} ${p.y}`).join(" ") +
      ` L ${points[points.length - 1].x} ${baseY} Z`;

    let yGuides = "";
    for (let i = 0; i < tickCount; i += 1) {
      const ratio = i / (tickCount - 1);
      const y = margin.top + ratio * plotH;
      const value = Math.round(maxY * (1 - ratio));
      yGuides += `
        <line class="chart-grid" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"></line>
        <text class="axis-text" x="${margin.left - 8}" y="${y + 4}" text-anchor="end">${formatNumber(value)}</text>
      `;
    }

    const labelStep = computeXAxisLabelStep(series.length, range.bucketSpec);
    const labelIndexes = buildXAxisLabelIndexes(points, labelStep, 118);
    const xLabels = labelIndexes
      .map((idx) => {
        const point = points[idx];
        return `<text class="axis-text" x="${point.x}" y="${height - 24}" text-anchor="middle">${escapeHtml(
          point.shortLabel
        )}</text>`;
      })
      .join("");

    const dots = points
      .map(
        (p) => `
        <circle class="chart-point" cx="${p.x}" cy="${p.y}" r="4" tabindex="0" data-tooltip="${escapeHtml(
          `${p.tooltipLabel}: ${formatNumber(p.count)} users`
        )}">
          <title>${escapeHtml(p.tooltipLabel)}: ${formatNumber(p.count)} users</title>
        </circle>
      `
      )
      .join("");

    refs.dailyChart.innerHTML = `
      <svg class="line-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Number of registrations chart">
        ${yGuides}
        <line class="chart-axis" x1="${margin.left}" y1="${baseY}" x2="${width - margin.right}" y2="${baseY}"></line>
        <line class="chart-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${baseY}"></line>
        <path class="line-area" d="${areaPath}"></path>
        <polyline class="line-path" points="${linePoints}"></polyline>
        ${dots}
        ${xLabels}
      </svg>
    `;

    bindChartPointTooltips();
  }

  function bindChartPointTooltips() {
    const pointEls = refs.dailyChart.querySelectorAll(".chart-point");
    if (!pointEls.length) return;

    let tooltipEl = refs.dailyChart.querySelector(".chart-tooltip");
    if (!tooltipEl) {
      tooltipEl = document.createElement("div");
      tooltipEl.className = "chart-tooltip";
      refs.dailyChart.appendChild(tooltipEl);
    }

    const positionTooltip = (clientX, clientY) => {
      const rect = refs.dailyChart.getBoundingClientRect();
      const x = clamp(clientX - rect.left, 20, Math.max(20, rect.width - 20));
      const y = clamp(clientY - rect.top, 16, Math.max(16, rect.height - 16));
      tooltipEl.style.left = `${x}px`;
      tooltipEl.style.top = `${y}px`;
    };

    const showTooltip = (el, clientX, clientY) => {
      tooltipEl.textContent = el.getAttribute("data-tooltip") || "";
      positionTooltip(clientX, clientY);
      tooltipEl.classList.add("show");
    };

    const hideTooltip = () => {
      tooltipEl.classList.remove("show");
    };

    pointEls.forEach((el) => {
      el.addEventListener("mouseenter", (event) => {
        showTooltip(el, event.clientX, event.clientY);
      });
      el.addEventListener("mousemove", (event) => {
        positionTooltip(event.clientX, event.clientY);
      });
      el.addEventListener("mouseleave", hideTooltip);
      el.addEventListener("focus", () => {
        const rect = el.getBoundingClientRect();
        showTooltip(el, rect.left + rect.width / 2, rect.top);
      });
      el.addEventListener("blur", hideTooltip);
    });
  }

  function renderLiveSessionPie() {
    if (!refs.liveSessionPie) return;

    const totalSessions = clampNumber(preDbConfig.liveSessionTotal, 1, 1000000);
    const activeSessions = clampNumber(preDbConfig.liveSessionActive, 0, totalSessions);
    const availableSessions = Math.max(totalSessions - activeSessions, 0);
    const ratio = totalSessions > 0 ? activeSessions / totalSessions : 0;
    const percent = Math.round(ratio * 100);

    const radius = 68;
    const cx = 120;
    const cy = 114;
    const circumference = 2 * Math.PI * radius;
    const activeArc = Math.max(0, Math.min(circumference, circumference * ratio));
    const gapArc = Math.max(0, circumference - activeArc);

    refs.liveSessionPie.innerHTML = `
      <div class="pie-chart-shell">
        <svg class="pie-chart-svg" viewBox="0 0 240 228" role="img" aria-label="Current session usage chart">
          <circle class="pie-track" cx="${cx}" cy="${cy}" r="${radius}"></circle>
          <circle
            class="pie-active"
            cx="${cx}"
            cy="${cy}"
            r="${radius}"
            stroke-dasharray="${activeArc} ${gapArc}"
          ></circle>
          <text class="pie-center-top" x="${cx}" y="${cy - 3}" text-anchor="middle">${formatNumber(
            activeSessions
          )}/${formatNumber(totalSessions)}</text>
          <text class="pie-center-bottom" x="${cx}" y="${cy + 21}" text-anchor="middle">${percent}% In Use</text>
        </svg>
        <div class="pie-legend">
          <div class="pie-legend-row">
            <span class="pie-dot in-use"></span>
            <span>In Use: ${formatNumber(activeSessions)}</span>
          </div>
          <div class="pie-legend-row">
            <span class="pie-dot available"></span>
            <span>Available: ${formatNumber(availableSessions)}</span>
          </div>
        </div>
      </div>
    `;
  }

  function renderFrequentUsersBar(range) {
    if (!refs.frequentUsersBar) return;
    if (!range) {
      refs.frequentUsersBar.innerHTML = `<p class="empty-note">No chart data.</p>`;
      return;
    }

    const series = buildFrequentUsersSeries(range);
    if (!series.length) {
      refs.frequentUsersBar.innerHTML = `<p class="empty-note">No chart data.</p>`;
      return;
    }

    const width = Math.max(760, Math.min(2400, series.length * 54));
    const height = 270;
    const margin = { top: 16, right: 24, bottom: 64, left: 58 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const baseY = margin.top + plotH;
    const maxY = Math.max(...series.map((item) => item.count), 1);
    const tickCount = 5;
    const barSlot = plotW / Math.max(series.length, 1);
    const barWidth = Math.max(6, Math.min(32, barSlot * 0.72));
    const points = [];

    const bars = series
      .map((item, idx) => {
        const xCenter = margin.left + barSlot * idx + barSlot / 2;
        const barHeight = (item.count / maxY) * plotH;
        const y = baseY - barHeight;
        const x = xCenter - barWidth / 2;
        points.push({ x: xCenter, shortLabel: item.shortLabel });
        return `
          <rect
            class="bar-rect"
            x="${x}"
            y="${y}"
            width="${barWidth}"
            height="${Math.max(barHeight, 0)}"
          >
            <title>${escapeHtml(item.tooltipLabel)}: ${formatNumber(item.count)} users</title>
          </rect>
        `;
      })
      .join("");

    let yGuides = "";
    for (let i = 0; i < tickCount; i += 1) {
      const ratio = i / (tickCount - 1);
      const y = margin.top + ratio * plotH;
      const value = Math.round(maxY * (1 - ratio));
      yGuides += `
        <line class="bar-grid" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"></line>
        <text class="axis-text" x="${margin.left - 8}" y="${y + 4}" text-anchor="end">${formatNumber(value)}</text>
      `;
    }

    const labelStep = computeXAxisLabelStep(series.length, range.bucketSpec);
    const labelIndexes = buildXAxisLabelIndexes(points, labelStep, 96);
    const xLabels = labelIndexes
      .map((idx) => {
        const point = points[idx];
        return `<text class="axis-text" x="${point.x}" y="${height - 22}" text-anchor="middle">${escapeHtml(
          point.shortLabel
        )}</text>`;
      })
      .join("");

    refs.frequentUsersBar.innerHTML = `
      <svg class="bar-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Frequent users by day chart">
        ${yGuides}
        <line class="bar-axis" x1="${margin.left}" y1="${baseY}" x2="${width - margin.right}" y2="${baseY}"></line>
        <line class="bar-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${baseY}"></line>
        ${bars}
        ${xLabels}
      </svg>
    `;
  }

  function buildFrequentUsersSeries(range) {
    const dailyMap = preDbConfig.dailyFrequentUsers || {};
    const series = [];
    const dayMs = 24 * 60 * 60 * 1000;
    const startMs = startOfDayMs(range.startMs);
    const endMs = startOfDayMs(range.endMs);

    for (let dayStartMs = startMs; dayStartMs < endMs; dayStartMs += dayMs) {
      const dayKey = formatDayKey(dayStartMs);
      const count = clampNumber(Number(dailyMap[dayKey]), 0, 1000000);
      const dayDate = new Date(dayStartMs);
      series.push({
        dayKey,
        count,
        shortLabel: formatDateOnly(dayDate),
        tooltipLabel: formatDateOnly(dayDate),
      });
    }

    return series;
  }

  function renderDistribution(container, counts, emptyText) {
    const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      container.innerHTML = `<p class="empty-note">${escapeHtml(emptyText)}</p>`;
      return;
    }

    const max = Math.max(...entries.map(([, value]) => value), 1);
    container.innerHTML = entries
      .map(([label, value]) => {
        const width = Math.round((value / max) * 100);
        return `
          <div class="dist-row">
            <span class="dist-label">${escapeHtml(label)}</span>
            <div class="dist-track"><div class="dist-fill" style="width:${width}%"></div></div>
            <span class="dist-value">${formatNumber(value)}</span>
          </div>
        `;
      })
      .join("");
  }

  function updateZoomButtonsState() {
    if (!refs.zoomResetBtn) return;

    if (!state.zoom.initialized) {
      refs.zoomResetBtn.disabled = true;
      return;
    }

    const recentWeekWindow = getRecentWeekWindow(
      state.zoom.domainStartMs,
      state.zoom.domainEndMs
    );
    const isResetView =
      nearlyEqual(state.zoom.viewStartMs, recentWeekWindow.startMs, 1000) &&
      nearlyEqual(state.zoom.viewEndMs, recentWeekWindow.endMs, 1000);

    refs.zoomResetBtn.disabled = isResetView;
  }

  function zoomByFactor(factor, anchorRatio = 0.5) {
    if (!state.zoom.initialized) return;

    const currentWindow = state.zoom.viewEndMs - state.zoom.viewStartMs;
    const nextWindow = scaleZoomWindowByDay(
      currentWindow,
      factor,
      state.zoom.minWindowMs,
      state.zoom.maxWindowMs
    );
    const anchor = clamp(anchorRatio, 0, 1);
    const anchorTime = state.zoom.viewStartMs + currentWindow * anchor;

    let nextStartMs = anchorTime - nextWindow * anchor;
    let nextEndMs = nextStartMs + nextWindow;
    const clamped = clampWindowToDomain(
      nextStartMs,
      nextEndMs,
      state.zoom.domainStartMs,
      state.zoom.domainEndMs
    );

    const normalized = normalizeDayWindow(
      clamped.startMs,
      clamped.endMs,
      state.zoom.domainStartMs,
      state.zoom.domainEndMs,
      state.zoom.minWindowMs,
      state.zoom.maxWindowMs
    );

    state.zoom.viewStartMs = normalized.startMs;
    state.zoom.viewEndMs = normalized.endMs;
    renderFromCurrentTimeline();
  }

  function resetZoomToRecentWeek() {
    if (!state.zoom.initialized) return;
    const recentWeekWindow = getRecentWeekWindow(
      state.zoom.domainStartMs,
      state.zoom.domainEndMs
    );
    state.zoom.viewStartMs = recentWeekWindow.startMs;
    state.zoom.viewEndMs = recentWeekWindow.endMs;
    renderFromCurrentTimeline();
  }

  function handleChartWheel(event, containerEl) {
    if (!state.zoom.initialized) return;
    if (!containerEl) return;

    const rect = containerEl.getBoundingClientRect();
    if (!rect.width) return;

    event.preventDefault();
    const anchorRatio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const factor = event.deltaY < 0 ? 0.86 : 1.16;
    zoomByFactor(factor, anchorRatio);
  }

  function handleChartPointerDown(event, containerEl) {
    if (!state.zoom.initialized || event.button !== 0) return;
    if (!containerEl) return;

    event.preventDefault();
    state.pan.active = true;
    state.pan.targetEl = containerEl;
    state.pan.startX = event.clientX;
    state.pan.startStartMs = state.zoom.viewStartMs;
    state.pan.startEndMs = state.zoom.viewEndMs;
    containerEl.classList.add("is-panning");
  }

  function handleWindowPointerMove(event) {
    if (!state.pan.active || !state.zoom.initialized) return;
    if (!state.pan.targetEl) return;

    const rect = state.pan.targetEl.getBoundingClientRect();
    const width = Math.max(rect.width, 1);
    const deltaPx = event.clientX - state.pan.startX;
    const msPerPx = (state.pan.startEndMs - state.pan.startStartMs) / width;

    const shiftedStartMs = state.pan.startStartMs - deltaPx * msPerPx;
    const shiftedEndMs = state.pan.startEndMs - deltaPx * msPerPx;
    const clamped = clampWindowToDomain(
      shiftedStartMs,
      shiftedEndMs,
      state.zoom.domainStartMs,
      state.zoom.domainEndMs
    );

    const normalized = normalizeDayWindow(
      clamped.startMs,
      clamped.endMs,
      state.zoom.domainStartMs,
      state.zoom.domainEndMs,
      state.zoom.minWindowMs,
      state.zoom.maxWindowMs
    );

    state.zoom.viewStartMs = normalized.startMs;
    state.zoom.viewEndMs = normalized.endMs;
    renderFromCurrentTimeline();
  }

  function handleWindowPointerUp() {
    if (!state.pan.active) return;
    if (state.pan.targetEl) {
      state.pan.targetEl.classList.remove("is-panning");
    }
    state.pan.active = false;
    state.pan.targetEl = null;
  }

  function syncZoomDomainWithRows(rows) {
    let minMs = Number.POSITIVE_INFINITY;
    let maxMs = Number.NEGATIVE_INFINITY;

    for (const row of rows) {
      const created = row?.created_at ? new Date(row.created_at) : null;
      if (!created || Number.isNaN(created.getTime())) continue;
      const ms = created.getTime();
      if (ms < minMs) minMs = ms;
      if (ms > maxMs) maxMs = ms;
    }

    const preDbStartMs = preDbConfig.enabled ? preDbConfig.displayStartMs : null;
    if (Number.isFinite(preDbStartMs)) {
      minMs = Number.isFinite(minMs) ? Math.min(minMs, preDbStartMs) : preDbStartMs;
      if (!Number.isFinite(maxMs)) {
        maxMs = preDbStartMs + 24 * 60 * 60 * 1000;
      }
    }

    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || maxMs <= minMs) {
      state.zoom.initialized = false;
      updateZoomButtonsState();
      return;
    }

    const oneDayMs = 24 * 60 * 60 * 1000;
    const domainStartMs = startOfDayMs(minMs);
    const domainEndMs = startOfDayMs(maxMs) + oneDayMs;
    const maxZoomWindowMs = 30 * oneDayMs;
    const domainWindowMs = Math.max(domainEndMs - domainStartMs, oneDayMs);
    const maxWindowMs = Math.min(domainWindowMs, maxZoomWindowMs);
    const minWindowMs = oneDayMs;
    const prevRecentWeek = state.zoom.initialized
      ? getRecentWeekWindow(state.zoom.domainStartMs, state.zoom.domainEndMs)
      : null;
    const wasAtRecentWeek =
      !!prevRecentWeek &&
      nearlyEqual(state.zoom.viewStartMs, prevRecentWeek.startMs, 1000) &&
      nearlyEqual(state.zoom.viewEndMs, prevRecentWeek.endMs, 1000);
    const nextRecentWeek = getRecentWeekWindow(domainStartMs, domainEndMs);

    if (!state.zoom.initialized) {
      state.zoom.initialized = true;
      state.zoom.domainStartMs = domainStartMs;
      state.zoom.domainEndMs = domainEndMs;
      state.zoom.maxWindowMs = maxWindowMs;
      state.zoom.minWindowMs = minWindowMs;
      state.zoom.viewStartMs = nextRecentWeek.startMs;
      state.zoom.viewEndMs = nextRecentWeek.endMs;
      updateZoomButtonsState();
      return;
    }

    const prevWindow = normalizeWindowMsToWholeDays(
      state.zoom.viewEndMs - state.zoom.viewStartMs,
      minWindowMs,
      maxWindowMs
    );
    const prevCenter = (state.zoom.viewStartMs + state.zoom.viewEndMs) / 2;

    state.zoom.domainStartMs = domainStartMs;
    state.zoom.domainEndMs = domainEndMs;
    state.zoom.maxWindowMs = maxWindowMs;
    state.zoom.minWindowMs = minWindowMs;

    if (wasAtRecentWeek) {
      state.zoom.viewStartMs = nextRecentWeek.startMs;
      state.zoom.viewEndMs = nextRecentWeek.endMs;
      updateZoomButtonsState();
      return;
    }

    const clamped = clampWindowAroundCenter(prevCenter, prevWindow, domainStartMs, domainEndMs);
    const normalized = normalizeDayWindow(
      clamped.startMs,
      clamped.endMs,
      domainStartMs,
      domainEndMs,
      minWindowMs,
      maxWindowMs
    );
    state.zoom.viewStartMs = normalized.startMs;
    state.zoom.viewEndMs = normalized.endMs;
    updateZoomButtonsState();
  }

  function getRangeFromZoomState() {
    if (!state.zoom.initialized) return null;

    const startMs = state.zoom.viewStartMs;
    const endMs = state.zoom.viewEndMs;
    const bucketSpec = pickBucketSpec(endMs - startMs);

    return {
      startMs,
      endMs,
      startDate: new Date(startMs),
      endDateExclusive: new Date(endMs),
      bucketSpec,
      axisLabel: bucketSpec.axisLabel,
      label: buildZoomRangeLabel(startMs, endMs, bucketSpec),
    };
  }

  function buildZoomRangeLabel(startMs, endMs, bucketSpec) {
    const start = formatDateOnly(new Date(startMs));
    const end = formatDateOnly(new Date(endMs - 1));
    return `${start} -> ${end} (${bucketSpec.label}/bucket)`;
  }

  function pickBucketSpec(windowMs) {
    void windowMs;
    const d = 24 * 60 * 60 * 1000;

    return {
      unit: "day",
      step: 1,
      sizeMs: d,
      axisLabel: "Date (Day/Month/Year)",
      label: "1d",
    };
  }

  function summarizeRowsForRange(rows, range) {
    const bucketBuild = buildBucketsForRange(range);
    const series = bucketBuild.buckets.map((bucket) => ({ ...bucket, count: 0 }));
    const statusCounts = {};
    const providerCounts = {};

    for (const row of rows) {
      const created = row?.created_at ? new Date(row.created_at) : null;
      if (!created || Number.isNaN(created.getTime())) continue;
      const ms = created.getTime();
      if (ms < range.startMs || ms >= range.endMs) continue;

      const index = Math.floor((ms - bucketBuild.anchorMs) / range.bucketSpec.sizeMs);
      if (index < 0 || index >= series.length) continue;

      series[index].count += 1;

      const status = String(row?.status || "unknown").toLowerCase();
      const provider = String(row?.auth_provider || "unknown").toLowerCase();
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      providerCounts[provider] = (providerCounts[provider] || 0) + 1;
    }

    return { series, statusCounts, providerCounts };
  }

  function buildBucketsForRange(range) {
    let anchorMs = alignTimestampToBucket(range.startMs, range.bucketSpec);
    while (anchorMs > range.startMs) {
      anchorMs -= range.bucketSpec.sizeMs;
    }

    const buckets = [];
    for (let startMs = anchorMs; startMs < range.endMs; startMs += range.bucketSpec.sizeMs) {
      const endMs = startMs + range.bucketSpec.sizeMs;
      if (endMs <= range.startMs) continue;

      const bucketStartDate = new Date(startMs);
      buckets.push({
        key: String(startMs),
        shortLabel: formatBucketShortLabel(bucketStartDate, range.bucketSpec),
        tooltipLabel: formatBucketTooltipLabel(startMs, endMs, range.bucketSpec),
      });
    }

    return { anchorMs, buckets };
  }

  function alignTimestampToBucket(ms, bucketSpec) {
    void bucketSpec;
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function formatBucketShortLabel(date, bucketSpec) {
    void bucketSpec;
    return formatDateOnly(date);
  }

  function formatBucketTooltipLabel(startMs, endMs, bucketSpec) {
    const startDate = new Date(startMs);
    void endMs;
    void bucketSpec;
    return formatDateOnly(startDate);
  }

  function countRowsInMsRange(rows, startMs, endMs) {
    let count = 0;
    for (const row of rows) {
      const created = row?.created_at ? new Date(row.created_at) : null;
      if (!created || Number.isNaN(created.getTime())) continue;
      const ms = created.getTime();
      if (ms >= startMs && ms < endMs) count += 1;
    }
    return count;
  }

  function buildSearchFilterEntries(searchText) {
    const token = sanitizeSearchToken(searchText);
    if (!token) return [];
    return [["or", `(email.ilike.*${token}*,phone.ilike.*${token}*)`]];
  }

  function applySearchFilterRows(rows, searchText) {
    const token = sanitizeSearchToken(searchText).toLowerCase();
    if (!token) return rows.slice();

    return rows.filter((row) => {
      const email = String(row?.email || "").toLowerCase();
      const phone = String(row?.phone || "").toLowerCase();
      return email.includes(token) || phone.includes(token);
    });
  }

  function getPreDbRows() {
    if (!preDbConfig.enabled) return [];
    if (!preDbRowsCache) {
      preDbRowsCache = buildHistoricalRows(preDbConfig.dailyNewUsers, preDbConfig.dbFromDayKey);
    }
    return preDbRowsCache;
  }

  function buildHistoricalRows(dailyNewUsers, dbFromDayKey) {
    const rows = [];
    const dayKeys = Object.keys(dailyNewUsers).sort();
    let userIndex = 0;

    for (const dayKey of dayKeys) {
      if (dbFromDayKey && dayKey >= dbFromDayKey) continue;
      const dailyCount = Number(dailyNewUsers[dayKey]) || 0;
      for (let i = 0; i < dailyCount; i += 1) {
        const hour = (i * 5 + userIndex * 3) % 24;
        const minute = (i * 11 + userIndex * 7) % 60;
        const second = (i * 17 + userIndex * 13) % 60;
        const id = userIndex + 1;

        rows.push({
          id,
          created_at: buildCreatedAtIso(dayKey, hour, minute, second),
          status: "active",
          auth_provider: "local",
          email: `user${String(id).padStart(4, "0")}@vtranser.test`,
          phone: `+849${String(10000000 + ((id * 3791) % 90000000)).padStart(8, "0")}`,
        });

        userIndex += 1;
      }
    }

    return rows;
  }

  function buildCreatedAtIso(dayKey, hour, minute, second) {
    const utcMs = dayKeyToUtcStartMs(dayKey, hour, minute, second);
    if (!Number.isFinite(utcMs)) return new Date().toISOString();
    return new Date(utcMs).toISOString();
  }

  function isDayKey(input) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(input || ""));
  }

  function dayKeyToUtcStartMs(dayKey, hour = 0, minute = 0, second = 0) {
    if (!isDayKey(dayKey)) return Number.NaN;

    const match = String(dayKey).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return Number.NaN;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return Date.UTC(year, month - 1, day, Number(hour) - 7, Number(minute), Number(second));
  }

  function countRowsInIsoRange(rows, startIso, endIso) {
    const startDate = new Date(startIso);
    const endDate = new Date(endIso);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;

    let count = 0;
    for (const row of rows) {
      const created = row?.created_at ? new Date(row.created_at) : null;
      if (!created || Number.isNaN(created.getTime())) continue;
      if (created >= startDate && created < endDate) count += 1;
    }

    return count;
  }

  async function fetchAggregateRows(filterEntries) {
    const rows = [];
    const batchSize = 1000;
    let offset = 0;

    while (offset < state.maxAggregateRows) {
      const params = [
        ["select", "created_at,status,auth_provider"],
        ["order", "created_at.asc"],
        ["limit", String(batchSize)],
        ["offset", String(offset)],
        ...filterEntries,
      ];
      const res = await supaRequest("/rest/v1/users", { params });
      if (!res.ok) throw new Error(await getErrorText(res));

      const chunk = await res.json();
      rows.push(...chunk);
      if (chunk.length < batchSize) {
        return { rows, truncated: false };
      }
      offset += batchSize;
    }

    return { rows, truncated: true };
  }

  async function fetchCount(filterEntries) {
    const baseParams = [["select", "id"], ...filterEntries];

    let res = await supaRequest("/rest/v1/users", {
      method: "HEAD",
      params: baseParams,
      headers: { Prefer: "count=exact" },
    });

    if (!res.ok || !res.headers.get("content-range")) {
      res = await supaRequest("/rest/v1/users", {
        method: "GET",
        params: [["select", "id"], ["limit", "1"], ...filterEntries],
        headers: { Prefer: "count=exact" },
      });
      if (!res.ok) throw new Error(await getErrorText(res));
      await res.text().catch(() => "");
    }

    return parseCountHeader(res.headers.get("content-range"));
  }

  async function supaRequest(path, { method = "GET", params = [], headers = {}, body } = {}) {
    const url = new URL(`${SUPA_URL}${path}`);
    appendQueryParams(url.searchParams, params);

    const requestHeaders = {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      ...headers,
    };
    if (body !== undefined) {
      requestHeaders["content-type"] = "application/json";
    }

    return fetch(url.toString(), {
      method,
      headers: requestHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  function getDayRange(offsetDaysFromToday) {
    const today = startOfDay(new Date());
    const target = addDays(today, offsetDaysFromToday);
    return {
      startIso: target.toISOString(),
      endIso: addDays(target, 1).toISOString(),
    };
  }

  function rangeEntriesFor(column, startIso, endIso) {
    return [
      [column, `gte.${startIso}`],
      [column, `lt.${endIso}`],
    ];
  }

  function buildDbRangeEntriesSinceCutoff(startIso, endIso, cutoffStartIso) {
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    const cutoffMs = new Date(cutoffStartIso).getTime();

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(cutoffMs)) {
      return null;
    }
    if (endMs <= cutoffMs) return null;

    const effectiveStartIso = startMs < cutoffMs ? cutoffStartIso : startIso;
    return rangeEntriesFor("created_at", effectiveStartIso, endIso);
  }

  function sanitizeSearchToken(raw) {
    return String(raw || "")
      .trim()
      .replace(/[%,()*]/g, "")
      .replace(/\s+/g, " ");
  }

  function buildDayDeltaText(todayCount, yesterdayCount) {
    const diff = todayCount - yesterdayCount;
    if (yesterdayCount === 0) {
      if (todayCount === 0) return "0";
      return `+${formatNumber(diff)} / +100%`;
    }
    const pct = (diff / yesterdayCount) * 100;
    const sign = diff >= 0 ? "+" : "";
    return `${sign}${formatNumber(diff)} / ${sign}${formatNumber(pct, 1)}%`;
  }

  function setLoadingState(_isLoading) {}

  function toast(message, ms = 3200) {
    if (!toastEl) return;
    toastEl.textContent = String(message || "");
    toastEl.classList.remove("hidden");
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => {
      toastEl.classList.add("hidden");
    }, ms);
  }

  function parseCountHeader(contentRange) {
    const raw = String(contentRange || "");
    const slash = raw.lastIndexOf("/");
    if (slash < 0) return 0;
    const total = Number(raw.slice(slash + 1));
    return Number.isFinite(total) ? total : 0;
  }

  async function getErrorText(res) {
    const body = await res.text().catch(() => "");
    if (body) return `HTTP ${res.status}: ${body}`;
    return `HTTP ${res.status}: ${res.statusText || "Unknown error"}`;
  }

  function appendQueryParams(searchParams, params) {
    if (Array.isArray(params)) {
      for (const [key, value] of params) {
        if (value === undefined || value === null || value === "") continue;
        searchParams.append(key, String(value));
      }
      return;
    }

    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === "") continue;
      searchParams.append(key, String(value));
    }
  }

  function formatDateOnly(input) {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: state.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }

  function formatDayKey(input) {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return "";

    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: state.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);

    const year = parts.find((p) => p.type === "year")?.value || "";
    const month = parts.find((p) => p.type === "month")?.value || "";
    const day = parts.find((p) => p.type === "day")?.value || "";
    if (!year || !month || !day) return "";
    return `${year}-${month}-${day}`;
  }

  function formatNumber(value, fractionDigits = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "-";
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: fractionDigits,
      minimumFractionDigits: fractionDigits,
    }).format(numeric);
  }

  function computeXAxisLabelStep(length, bucketSpec) {
    void bucketSpec;

    if (length > 90) return 10;
    if (length > 60) return 6;
    if (length > 40) return 4;
    if (length > 24) return 3;
    if (length > 10) return 2;
    return 1;
  }

  function buildXAxisLabelIndexes(points, labelStep, minPixelGap) {
    if (!Array.isArray(points) || points.length === 0) return [];

    const step = Math.max(1, Number(labelStep) || 1);
    const indexes = [];
    for (let idx = 0; idx < points.length; idx += step) {
      indexes.push(idx);
    }

    const lastIndex = points.length - 1;
    if (indexes[indexes.length - 1] !== lastIndex) {
      indexes.push(lastIndex);
    }

    const gap = Math.max(40, Number(minPixelGap) || 40);
    let idx = 1;
    while (idx < indexes.length) {
      const prevIndex = indexes[idx - 1];
      const currIndex = indexes[idx];
      const pixelGap = points[currIndex].x - points[prevIndex].x;
      if (pixelGap >= gap) {
        idx += 1;
        continue;
      }

      if (currIndex === lastIndex) {
        indexes.splice(idx - 1, 1);
        if (idx > 1) idx -= 1;
        continue;
      }

      indexes.splice(idx, 1);
    }

    return indexes;
  }

  function startOfDayMs(input) {
    const date = input instanceof Date ? new Date(input) : new Date(input);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function normalizeWindowMsToWholeDays(windowMs, minWindowMs, maxWindowMs) {
    const oneDayMs = 24 * 60 * 60 * 1000;
    const minDays = Math.max(1, Math.round(minWindowMs / oneDayMs));
    const maxDays = Math.max(minDays, Math.round(maxWindowMs / oneDayMs));
    const windowDays = Math.round(windowMs / oneDayMs);
    const clampedDays = clamp(windowDays, minDays, maxDays);
    return clampedDays * oneDayMs;
  }

  function scaleZoomWindowByDay(currentWindowMs, factor, minWindowMs, maxWindowMs) {
    const oneDayMs = 24 * 60 * 60 * 1000;
    const currentDays = Math.max(1, Math.round(currentWindowMs / oneDayMs));
    const scaledDaysRaw = factor >= 1 ? Math.ceil(currentDays * factor) : Math.floor(currentDays * factor);
    const scaledWindowMs = Math.max(oneDayMs, scaledDaysRaw * oneDayMs);
    return normalizeWindowMsToWholeDays(scaledWindowMs, minWindowMs, maxWindowMs);
  }

  function normalizeDayWindow(
    startMs,
    endMs,
    domainStartMs,
    domainEndMs,
    minWindowMs,
    maxWindowMs
  ) {
    const windowMs = normalizeWindowMsToWholeDays(endMs - startMs, minWindowMs, maxWindowMs);
    let normalizedStartMs = startOfDayMs(startMs);
    let normalizedEndMs = normalizedStartMs + windowMs;

    if (normalizedStartMs < domainStartMs) {
      normalizedStartMs = domainStartMs;
      normalizedEndMs = normalizedStartMs + windowMs;
    }

    if (normalizedEndMs > domainEndMs) {
      normalizedEndMs = domainEndMs;
      normalizedStartMs = normalizedEndMs - windowMs;
    }

    if (normalizedStartMs < domainStartMs) {
      normalizedStartMs = domainStartMs;
    }
    if (normalizedEndMs > domainEndMs) {
      normalizedEndMs = domainEndMs;
    }

    return { startMs: normalizedStartMs, endMs: normalizedEndMs };
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function addDays(date, offset) {
    const next = new Date(date);
    next.setDate(next.getDate() + offset);
    return next;
  }

  function normalizeBaseUrl(url) {
    return String(url || "")
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/rest\/v1$/i, "");
  }

  function normalizePreDbConfig(raw) {
    const liveSessionTotalRaw = Number(raw?.LIVE_SESSION_TOTAL);
    const liveSessionTotal = Number.isFinite(liveSessionTotalRaw)
      ? clampNumber(liveSessionTotalRaw, 1, 1000000)
      : 2;
    const liveSessionActiveRaw = Number(raw?.LIVE_SESSION_ACTIVE);
    const liveSessionActive = Number.isFinite(liveSessionActiveRaw)
      ? clampNumber(liveSessionActiveRaw, 0, liveSessionTotal)
      : Math.min(1, liveSessionTotal);
    const frequentUsersRaw = raw?.DAILY_FREQUENT_USERS || {};
    const dailyFrequentUsers = {};
    for (const [dayKey, countValue] of Object.entries(frequentUsersRaw)) {
      if (!isDayKey(dayKey)) continue;
      const count = clampNumber(Number(countValue), 0, 1000000);
      dailyFrequentUsers[dayKey] = count;
    }

    if (!raw || raw.ENABLED !== true) {
      return {
        enabled: false,
        dailyNewUsers: {},
        dbFromDayKey: "",
        dbFromStartIso: "",
        displayStartDayKey: "",
        displayStartMs: null,
        liveSessionTotal,
        liveSessionActive,
        dailyFrequentUsers,
      };
    }

    const dailyRaw = raw.DAILY_NEW_USERS || {};
    const dailyNewUsers = {};
    for (const [dayKey, countValue] of Object.entries(dailyRaw)) {
      if (!isDayKey(dayKey)) continue;
      const count = clampNumber(Number(countValue), 0, 1000000);
      if (count > 0) dailyNewUsers[dayKey] = count;
    }

    const dbFromDayKey = isDayKey(raw.DB_FROM_DATE) ? String(raw.DB_FROM_DATE) : "";
    if (!dbFromDayKey) {
      return {
        enabled: false,
        dailyNewUsers: {},
        dbFromDayKey: "",
        dbFromStartIso: "",
        displayStartDayKey: "",
        displayStartMs: null,
        liveSessionTotal,
        liveSessionActive,
        dailyFrequentUsers,
      };
    }

    const firstConfiguredDayKey =
      Object.keys(dailyNewUsers).sort((a, b) => a.localeCompare(b))[0] || "";
    const displayStartDayKey = isDayKey(raw.DISPLAY_START_DATE)
      ? String(raw.DISPLAY_START_DATE)
      : firstConfiguredDayKey;
    const displayStartMs = displayStartDayKey ? dayKeyToUtcStartMs(displayStartDayKey, 0, 0, 0) : null;

    return {
      enabled: true,
      dailyNewUsers,
      dbFromDayKey,
      dbFromStartIso: new Date(dayKeyToUtcStartMs(dbFromDayKey, 0, 0, 0)).toISOString(),
      displayStartDayKey,
      displayStartMs,
      liveSessionTotal,
      liveSessionActive,
      dailyFrequentUsers,
    };
  }

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function clampNumber(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  function nearlyEqual(a, b, tolerance = 1) {
    return Math.abs(Number(a) - Number(b)) <= tolerance;
  }

  function getRecentWeekWindow(domainStartMs, domainEndMs) {
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const domainWindow = Math.max(0, domainEndMs - domainStartMs);
    if (domainWindow <= weekMs) {
      return { startMs: domainStartMs, endMs: domainEndMs };
    }
    return { startMs: domainEndMs - weekMs, endMs: domainEndMs };
  }

  function clampWindowAroundCenter(centerMs, windowMs, domainStartMs, domainEndMs) {
    let startMs = centerMs - windowMs / 2;
    let endMs = centerMs + windowMs / 2;
    return clampWindowToDomain(startMs, endMs, domainStartMs, domainEndMs);
  }

  function clampWindowToDomain(startMs, endMs, domainStartMs, domainEndMs) {
    const domainWindow = domainEndMs - domainStartMs;
    let window = endMs - startMs;

    if (window >= domainWindow) {
      return { startMs: domainStartMs, endMs: domainEndMs };
    }

    if (startMs < domainStartMs) {
      const shift = domainStartMs - startMs;
      startMs += shift;
      endMs += shift;
    }

    if (endMs > domainEndMs) {
      const shift = endMs - domainEndMs;
      startMs -= shift;
      endMs -= shift;
    }

    startMs = Math.max(startMs, domainStartMs);
    endMs = Math.min(endMs, domainEndMs);

    window = endMs - startMs;
    if (window < 1000) {
      endMs = Math.min(domainEndMs, startMs + 1000);
    }

    return { startMs, endMs };
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
