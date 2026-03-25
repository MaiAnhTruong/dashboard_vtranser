(() => {
  const cfg = window.VT_DASHBOARD_CONFIG || {};
  const toastEl = document.getElementById("toast");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const AUTH_SESSION_KEY = "vtDashboardAuth";
  const AUTH_USERNAME = "admin";
  const AUTH_PASSWORD = "admin";
  const refs = {
    loginOverlay: document.getElementById("loginOverlay"),
    loginForm: document.getElementById("loginForm"),
    loginUsername: document.getElementById("loginUsername"),
    loginPassword: document.getElementById("loginPassword"),
    loginError: document.getElementById("loginError"),
    sidebarPanel: document.getElementById("sidebarPanel"),
    authSession: document.getElementById("authSession"),
    sessionUsername: document.getElementById("sessionUsername"),
    logoutBtn: document.getElementById("logoutBtn"),
    dashboardContent: document.getElementById("dashboardContent"),
    newTodayMetric: document.getElementById("newTodayMetric"),
    totalUsersMetric: document.getElementById("totalUsersMetric"),
    rangeUsersMetric: document.getElementById("rangeUsersMetric"),
    dailyAvgMetric: document.getElementById("dailyAvgMetric"),
    activeUsersMetric: document.getElementById("activeUsersMetric"),
    dayDeltaMetric: document.getElementById("dayDeltaMetric"),
    rangeLabelMetric: document.getElementById("rangeLabelMetric"),
    dailyChart: document.getElementById("dailyChart"),
    liveSessionPie: document.getElementById("liveSessionPie"),
    loginStatusPie: document.getElementById("loginStatusPie"),
    frequentUsersBar: document.getElementById("frequentUsersBar"),
    avgUsageChart: document.getElementById("avgUsageChart"),
    statusDistribution: document.getElementById("statusDistribution"),
    providerDistribution: document.getElementById("providerDistribution"),
  };
  const state = {
    refreshSeconds: 30,
    autoRefresh: true,
    timerId: null,
    resizeTimerId: null,
    loading: false,
    isAuthenticated: false,
    timezone: String(cfg.TIMEZONE || "Asia/Ho_Chi_Minh"),
    dataFilePath: String(cfg.DATA_FILE_PATH || "./daily_metrics.txt"),
    displayStartDayKey: isDayKey(cfg.DISPLAY_START_DATE) ? String(cfg.DISPLAY_START_DATE) : "",
    days: [],
    summary: emptySummary(),
  };

  init();

  function init() {
    state.refreshSeconds = clampNumber(Number(cfg.DEFAULT_REFRESH_SECONDS) || 2, 1, 600);
    state.isAuthenticated = readAuthSession();
    bindEvents();
    applyAuthState(state.isAuthenticated);
    if (state.isAuthenticated) {
      startDashboardSession();
    } else {
      stopDashboardSession();
    }
  }

  function bindEvents() {
    if (refs.loginForm) {
      refs.loginForm.addEventListener("submit", handleLoginSubmit);
    }
    if (refs.logoutBtn) {
      refs.logoutBtn.addEventListener("click", handleLogout);
    }
    window.addEventListener("resize", handleWindowResize);
    window.addEventListener("focus", () => {
      if (state.isAuthenticated) refreshDashboard();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.isAuthenticated) refreshDashboard();
    });
  }

  function handleLoginSubmit(event) {
    event.preventDefault();
    const username = String(refs.loginUsername?.value || "").trim();
    const password = String(refs.loginPassword?.value || "");
    if (username === AUTH_USERNAME && password === AUTH_PASSWORD) {
      state.isAuthenticated = true;
      persistAuthSession(username);
      clearAuthError();
      applyAuthState(true, username);
      startDashboardSession();
      return;
    }
    showAuthError("Incorrect username or password.");
    if (refs.loginPassword) refs.loginPassword.value = "";
    requestAnimationFrame(() => refs.loginPassword?.focus());
  }

  function handleLogout() {
    clearAuthSession();
    state.isAuthenticated = false;
    stopDashboardSession();
    applyAuthState(false);
  }

  function applyAuthState(isAuthenticated, username = AUTH_USERNAME) {
    document.body.classList.toggle("is-authenticated", isAuthenticated);
    document.body.classList.toggle("is-auth-required", !isAuthenticated);
    if (refs.loginOverlay) refs.loginOverlay.classList.toggle("hidden", isAuthenticated);
    if (refs.sidebarPanel) refs.sidebarPanel.classList.toggle("hidden", !isAuthenticated);
    if (refs.loginForm) refs.loginForm.classList.toggle("hidden", isAuthenticated);
    if (refs.authSession) refs.authSession.classList.toggle("hidden", !isAuthenticated);
    if (refs.dashboardContent) refs.dashboardContent.classList.toggle("hidden", !isAuthenticated);
    if (refs.sessionUsername) refs.sessionUsername.textContent = username;
    clearAuthError();
    if (isAuthenticated) {
      if (refs.loginPassword) refs.loginPassword.value = "";
      return;
    }
    if (refs.loginForm) refs.loginForm.reset();
    requestAnimationFrame(() => refs.loginUsername?.focus());
  }

  function startDashboardSession() {
    refreshDashboard(true);
    setupAutoRefresh();
  }

  function stopDashboardSession() {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    state.loading = false;
  }

  function handleWindowResize() {
    if (!state.isAuthenticated || !state.days.length) return;
    clearTimeout(state.resizeTimerId);
    state.resizeTimerId = setTimeout(() => renderDashboard(), 120);
  }

  function showAuthError(message) {
    if (!refs.loginError) return;
    refs.loginError.textContent = String(message || "");
    refs.loginError.classList.toggle("hidden", !message);
  }

  function clearAuthError() {
    showAuthError("");
  }

  function setupAutoRefresh() {
    if (state.timerId) clearInterval(state.timerId);
    if (!state.autoRefresh || !state.isAuthenticated) return;
    state.timerId = setInterval(() => refreshDashboard(), state.refreshSeconds * 1000);
  }

  async function refreshDashboard(showToastOnError = false) {
    if (!state.isAuthenticated || state.loading) return;
    state.loading = true;
    try {
      const payload = await loadPayload();
      state.days = payload.days;
      state.summary = payload.summary;
      renderDashboard();
    } catch (error) {
      const hasExistingData = state.days.length > 0;
      if (!hasExistingData) {
        state.summary = emptySummary();
        renderDashboard();
      }
      if (showToastOnError || !hasExistingData) {
        toast(`Dashboard refresh failed: ${error.message || error}`);
      }
      console.error(error);
    } finally {
      state.loading = false;
    }
  }

  async function loadPayload() {
    const text = await loadMetricsText();
    const entries = parseMetricsText(text);
    const days = buildTimeline(entries);
    return { days, summary: summarizeDays(days) };
  }

  async function loadMetricsText() {
    return loadMetricsTextViaScript(state.dataFilePath);
  }

  function loadMetricsTextViaScript(path) {
    return new Promise((resolve, reject) => {
      const globalKey = "VT_DAILY_METRICS_TEXT";
      const baseUrl = new URL(path, window.location.href);
      const sourceUrls = [];
      const freshUrl = new URL(baseUrl.toString());
      freshUrl.searchParams.set("_ts", String(Date.now()));
      sourceUrls.push(freshUrl.toString());
      if (window.location.protocol === "file:") {
        sourceUrls.push(baseUrl.toString());
      }

      try {
        delete window[globalKey];
      } catch (_error) {
        window[globalKey] = undefined;
      }

      const existingEl = document.getElementById("vtDailyMetricsScript");
      if (existingEl) {
        existingEl.remove();
      }

      const tryLoad = (sourceIndex) => {
        if (sourceIndex >= sourceUrls.length) {
          reject(new Error(`Unable to load ${path}.`));
          return;
        }

        const scriptEl = document.createElement("script");
        scriptEl.id = "vtDailyMetricsScript";
        scriptEl.async = true;
        scriptEl.src = sourceUrls[sourceIndex];
        scriptEl.onload = () => {
          const text = window[globalKey];
          if (typeof text !== "string") {
            reject(new Error(`Data file must define window.${globalKey} as a text block.`));
            return;
          }
          resolve(text);
        };
        scriptEl.onerror = () => {
          scriptEl.remove();
          tryLoad(sourceIndex + 1);
        };

        document.head.appendChild(scriptEl);
      };

      tryLoad(0);
    });
  }

  function parseMetricsText(text) {
    const byDay = new Map();
    const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const lineNo = idx + 1;
      const line = String(lines[idx] || "").trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      const parts = line.split("|").map((part) => part.trim());
      if (parts.length < 6) {
        throw new Error(
          `Invalid format at line ${lineNo}. Use: YYYY-MM-DD | new_users | daily_active_users | local_users | online_users | avg_usage_minutes`
        );
      }
      const dayKey = parts[0];
      if (!isDayKey(dayKey)) throw new Error(`Invalid date at line ${lineNo}: "${dayKey}"`);
      byDay.set(dayKey, {
        dayKey,
        newUsers: parseCount(parts[1], "new_users", lineNo),
        dailyActiveUsers: parseCount(parts[2], "daily_active_users", lineNo),
        localUsers: parseCount(parts[3], "local_users", lineNo),
        onlineUsers: parseCount(parts[4], "online_users", lineNo),
        averageUsageMinutes: parseCount(parts[5], "avg_usage_minutes", lineNo),
      });
    }
    const entries = [...byDay.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
    if (!entries.length) throw new Error(`No valid daily metrics found in ${state.dataFilePath}.`);
    return entries;
  }

  function parseCount(raw, field, lineNo) {
    const normalized = String(raw || "").trim().replace(/_/g, "");
    if (!/^\d+$/.test(normalized)) throw new Error(`Invalid ${field} at line ${lineNo}: "${raw}"`);
    return clampNumber(Number(normalized), 0, 1000000000);
  }

  function buildTimeline(entries) {
    if (!entries.length) return [];
    const byDay = new Map(entries.map((entry) => [entry.dayKey, entry]));
    const firstDayKey = entries[0].dayKey;
    const lastDayKey = entries[entries.length - 1].dayKey;
    const startDayKey =
      state.displayStartDayKey && state.displayStartDayKey.localeCompare(firstDayKey) < 0
        ? state.displayStartDayKey
        : firstDayKey;
    const startMs = dayKeyToUtcStartMs(startDayKey, 0, 0, 0);
    const endMs = dayKeyToUtcStartMs(lastDayKey, 0, 0, 0);
    const days = [];
    let carriedTotalUsers = 0;
    let carriedLocalUsers = 0;
    let carriedOnlineUsers = 0;
    for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
      const dayKey = formatDayKey(ms);
      const actual = byDay.get(dayKey);
      if (actual) {
        carriedTotalUsers += actual.newUsers;
        carriedLocalUsers = actual.localUsers;
        carriedOnlineUsers = actual.onlineUsers;
        days.push({ ...actual, totalUsers: carriedTotalUsers, dateMs: ms });
      } else {
        days.push({
          dayKey,
          dateMs: ms,
          newUsers: 0,
          dailyActiveUsers: 0,
          localUsers: carriedLocalUsers,
          onlineUsers: carriedOnlineUsers,
          averageUsageMinutes: 0,
          totalUsers: carriedTotalUsers,
        });
      }
    }
    return days;
  }

  function summarizeDays(days) {
    if (!days.length) return emptySummary();
    let totalNewUsers = 0;
    let totalDailyActiveUsers = 0;
    let totalUsageMinutes = 0;
    let peakNew = days[0];
    let peakActive = days[0];
    let peakUsage = days[0];
    for (const day of days) {
      totalNewUsers += day.newUsers;
      totalDailyActiveUsers += day.dailyActiveUsers;
      totalUsageMinutes += day.averageUsageMinutes;
      if (day.newUsers > peakNew.newUsers) peakNew = day;
      if (day.dailyActiveUsers > peakActive.dailyActiveUsers) peakActive = day;
      if (day.averageUsageMinutes > peakUsage.averageUsageMinutes) peakUsage = day;
    }
    const latest = days[days.length - 1];
    const prev = days.length > 1 ? days[days.length - 2] : null;
    return {
      latestDateKey: latest.dayKey,
      latestNewUsers: latest.newUsers,
      previousNewUsers: prev ? prev.newUsers : 0,
      latestDailyActiveUsers: latest.dailyActiveUsers,
      latestTotalUsers: latest.totalUsers,
      latestLocalUsers: latest.localUsers,
      latestOnlineUsers: latest.onlineUsers,
      latestAverageUsageMinutes: latest.averageUsageMinutes,
      totalNewUsers,
      averageNewUsers: days.length ? totalNewUsers / days.length : 0,
      averageDailyActiveUsers: days.length ? totalDailyActiveUsers / days.length : 0,
      averageUsageMinutes: days.length ? totalUsageMinutes / days.length : 0,
      peakNewUsers: peakNew.newUsers,
      peakNewDateKey: peakNew.dayKey,
      peakDailyActiveUsers: peakActive.dailyActiveUsers,
      peakDailyActiveDateKey: peakActive.dayKey,
      peakAverageUsageMinutes: peakUsage.averageUsageMinutes,
      peakAverageUsageDateKey: peakUsage.dayKey,
      trackedDays: days.length,
    };
  }

  function renderDashboard() {
    if (!state.days.length) {
      renderMetrics({
        latestNewUsers: 0,
        latestTotalUsers: 0,
        rangeNewUsers: 0,
        averagePerBucket: 0,
        latestDailyActiveUsers: 0,
        dayDeltaText: "0",
        rangeLabel: "No timeline data",
      });
      refs.dailyChart.innerHTML = `<p class="empty-note">No chart data.</p>`;
      renderSnapshotPie(0, 0, "");
      renderLoginStatusPie(0, 0, 0, "");
      renderActiveBar([]);
      renderUsageMinutesChart([]);
      renderSummaryStats(refs.statusDistribution, [], "No summary data");
      renderSummaryStats(refs.providerDistribution, [], "No summary data");
      return;
    }
    const visibleDays = state.days.slice();
    const rangeNewUsers = sumBy(visibleDays, "newUsers");
    renderMetrics({
      latestNewUsers: state.summary.latestNewUsers,
      latestTotalUsers: state.summary.latestTotalUsers,
      rangeNewUsers,
      averagePerBucket: visibleDays.length ? rangeNewUsers / visibleDays.length : 0,
      latestDailyActiveUsers: state.summary.latestDailyActiveUsers,
      dayDeltaText: buildDayDeltaText(state.summary.latestNewUsers, state.summary.previousNewUsers),
      rangeLabel: buildStaticRangeLabel(visibleDays),
    });
    renderLineChart(toSeries(visibleDays, "newUsers"), "new users");
    renderSnapshotPie(state.summary.latestDailyActiveUsers, state.summary.latestTotalUsers, state.summary.latestDateKey);
    renderLoginStatusPie(
      state.summary.latestLocalUsers,
      state.summary.latestOnlineUsers,
      state.summary.latestTotalUsers,
      state.summary.latestDateKey
    );
    renderActiveBar(toSeries(visibleDays, "dailyActiveUsers"));
    renderUsageMinutesChart(toSeries(visibleDays, "averageUsageMinutes"), "min");
    renderSummaryStats(
      refs.statusDistribution,
      buildRegistrationSummary(rangeNewUsers, buildStaticRangeLabel(visibleDays)),
      "No summary data"
    );
    renderSummaryStats(refs.providerDistribution, buildUsageSummary(), "No summary data");
  }

  function renderMetrics(data) {
    refs.newTodayMetric.textContent = formatNumber(data.latestNewUsers);
    refs.totalUsersMetric.textContent = formatNumber(data.latestTotalUsers);
    refs.rangeUsersMetric.textContent = formatNumber(data.rangeNewUsers);
    refs.dailyAvgMetric.textContent = formatNumber(data.averagePerBucket, 1);
    refs.activeUsersMetric.textContent = formatNumber(data.latestDailyActiveUsers);
    refs.dayDeltaMetric.textContent = data.dayDeltaText;
    refs.rangeLabelMetric.textContent = data.rangeLabel;
  }

  function renderLineChart(series, unitLabel) {
    if (!series.length) {
      refs.dailyChart.innerHTML = `<p class="empty-note">No chart data.</p>`;
      return;
    }
    const trend = buildMovingAverageSeries(series, 3);
    const yAxis = buildNiceYAxis(series.map((item) => item.count), 7);
    const height = 512;
    const margin = { top: 28, right: 42, bottom: 98, left: 76 };
    const width = measureChartWidth(refs.dailyChart, 320);
    const plotW = Math.max(width - margin.left - margin.right, 120);
    const plotH = height - margin.top - margin.bottom;
    const baseY = margin.top + plotH;
    const maxY = yAxis.maxY;
    const points = series.map((item, idx) => {
      const ratioX = series.length === 1 ? 0.5 : idx / (series.length - 1);
      return {
        ...item,
        x: margin.left + ratioX * plotW,
        y: margin.top + (1 - item.count / maxY) * plotH,
      };
    });
    const trendPoints = trend.values.map((item, idx) => ({
      ...item,
      x: points[idx].x,
      y: margin.top + (1 - item.count / maxY) * plotH,
    }));
    const linePath = buildSmoothLinePath(points, margin.top, baseY, 0.14);
    const trendPath = buildSmoothLinePath(trendPoints, margin.top, baseY, 0.18);
    const areaPath = `${linePath} L ${points[points.length - 1].x} ${baseY} L ${points[0].x} ${baseY} Z`;
    let yGuides = "";
    for (const tick of yAxis.ticks) {
      const y = margin.top + (1 - tick.value / maxY) * plotH;
      yGuides += `
        <line class="chart-grid" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"></line>
        <text class="axis-text" x="${margin.left - 10}" y="${y + 4}" text-anchor="end">${formatNumber(tick.value)}</text>
      `;
    }
    const xAxisMarkup = buildXAxisDecoration(points, height, baseY, { minPixelGap: 24 });
    const peakIndex = findPeakPointIndex(points);
    const latestIndex = points.length - 1;
    const dots = points
      .map(
        (point, idx) => `
        <circle class="chart-point ${idx === peakIndex ? "is-peak" : ""} ${idx === latestIndex ? "is-latest" : ""}" cx="${point.x}" cy="${point.y}" r="${
          idx === latestIndex ? 5.4 : idx === peakIndex ? 4.8 : 3.8
        }" tabindex="0" data-tooltip="${escapeHtml(
          `${point.tooltipLabel}: ${formatNumber(point.count)} ${unitLabel} | Trend (${trend.windowSize}d avg): ${formatNumber(
            trend.values[idx].count,
            1
          )}`
        )}">
          <title>${escapeHtml(point.tooltipLabel)}: ${formatNumber(point.count)} ${unitLabel} | Trend (${trend.windowSize}d avg): ${formatNumber(
            trend.values[idx].count,
            1
          )}</title>
        </circle>
      `
      )
      .join("");
    const trendLabel = `Trend (${trend.windowSize}d avg)`;
    const legendWidth = Math.max(194, 84 + trendLabel.length * 6.1);
    const legendHeight = 56;
    const legendX = width - margin.right - legendWidth;
    const legendY = margin.top + 10;
    const legend = `
      <g class="chart-legend">
        <rect class="chart-legend-card" x="${legendX}" y="${legendY}" width="${legendWidth}" height="${legendHeight}" rx="16" ry="16"></rect>
        <line class="chart-legend-line chart-legend-line-actual" x1="${legendX + 18}" y1="${legendY + 20}" x2="${legendX + 42}" y2="${legendY + 20}"></line>
        <text class="chart-legend-text" x="${legendX + 50}" y="${legendY + 24}">Daily Registrations</text>
        <line class="chart-legend-line chart-legend-line-trend" x1="${legendX + 18}" y1="${legendY + 40}" x2="${legendX + 42}" y2="${legendY + 40}"></line>
        <text class="chart-legend-text" x="${legendX + 50}" y="${legendY + 44}">${trendLabel}</text>
      </g>
    `;
    const defs = `
      <defs>
        <linearGradient id="chartAreaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#18a89c" stop-opacity="0.24"></stop>
          <stop offset="60%" stop-color="#18a89c" stop-opacity="0.08"></stop>
          <stop offset="100%" stop-color="#18a89c" stop-opacity="0"></stop>
        </linearGradient>
        <linearGradient id="chartLineGradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#149f92"></stop>
          <stop offset="100%" stop-color="#06766b"></stop>
        </linearGradient>
        <filter id="chartSoftGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="10" stdDeviation="8" flood-color="#0d8478" flood-opacity="0.12"></feDropShadow>
        </filter>
      </defs>
    `;
    refs.dailyChart.innerHTML = `
      <svg class="line-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Number of registrations chart">
        ${defs}
        ${yGuides}
        <line class="chart-axis" x1="${margin.left}" y1="${baseY}" x2="${width - margin.right}" y2="${baseY}"></line>
        <line class="chart-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${baseY}"></line>
        <path class="line-area" fill="url(#chartAreaGradient)" d="${areaPath}"></path>
        <path class="trend-line-path" d="${trendPath}"></path>
        <path class="line-path" stroke="url(#chartLineGradient)" filter="url(#chartSoftGlow)" d="${linePath}"></path>
        ${legend}
        ${dots}
        ${xAxisMarkup}
      </svg>
    `;
    bindChartPointTooltips(refs.dailyChart, ".chart-point");
  }

  function buildMovingAverageSeries(series, maxWindowSize = 7) {
    if (!series.length) return { windowSize: 0, values: [] };
    const windowSize = Math.min(maxWindowSize, Math.max(1, series.length));
    const values = [];
    let rollingSum = 0;
    for (let idx = 0; idx < series.length; idx += 1) {
      rollingSum += series[idx].count;
      if (idx >= windowSize) {
        rollingSum -= series[idx - windowSize].count;
      }
      const divisor = Math.min(idx + 1, windowSize);
      values.push({ ...series[idx], count: rollingSum / divisor });
    }
    return { windowSize, values };
  }

  function buildNiceYAxis(values, tickCount = 7) {
    const maxValue = Math.max(...values.map((value) => Number(value) || 0), 1);
    const steps = Math.max(2, tickCount - 1);
    if (maxValue <= steps) {
      const ticks = [];
      for (let idx = 0; idx <= steps; idx += 1) {
        ticks.push({ value: steps - idx });
      }
      return { maxY: steps, step: 1, ticks };
    }
    const rawStep = maxValue / steps;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
    const normalized = rawStep / magnitude;
    let niceNormalized = 1;
    if (normalized > 1) niceNormalized = 2;
    if (normalized > 2) niceNormalized = 5;
    if (normalized > 5) niceNormalized = 10;
    const step = niceNormalized * magnitude;
    const maxY = Math.max(step * steps, step);
    const ticks = [];
    for (let idx = 0; idx <= steps; idx += 1) {
      ticks.push({ value: maxY - idx * step });
    }
    return { maxY, step, ticks };
  }

  function buildSmoothLinePath(points, minY, maxY, tension = 0.16) {
    if (!points.length) return "";
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;

    let d = `M ${points[0].x} ${points[0].y}`;
    for (let idx = 0; idx < points.length - 1; idx += 1) {
      const p0 = points[idx - 1] || points[idx];
      const p1 = points[idx];
      const p2 = points[idx + 1];
      const p3 = points[idx + 2] || p2;
      const cp1x = p1.x + (p2.x - p0.x) * tension;
      const cp1y = clamp(p1.y + (p2.y - p0.y) * tension, minY, maxY);
      const cp2x = p2.x - (p3.x - p1.x) * tension;
      const cp2y = clamp(p2.y - (p3.y - p1.y) * tension, minY, maxY);
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  }

  function findPeakPointIndex(points) {
    let peakIndex = 0;
    let peakValue = Number.NEGATIVE_INFINITY;
    for (let idx = 0; idx < points.length; idx += 1) {
      if (points[idx].count >= peakValue) {
        peakValue = points[idx].count;
        peakIndex = idx;
      }
    }
    return peakIndex;
  }

  function bindChartPointTooltips(containerEl, pointSelector) {
    if (!containerEl) return;
    const pointEls = containerEl.querySelectorAll(pointSelector || ".chart-point");
    if (!pointEls.length) return;
    let tooltipEl = containerEl.querySelector(".chart-tooltip");
    if (!tooltipEl) {
      tooltipEl = document.createElement("div");
      tooltipEl.className = "chart-tooltip";
      containerEl.appendChild(tooltipEl);
    }
    const positionTooltip = (clientX, clientY) => {
      const rect = containerEl.getBoundingClientRect();
      tooltipEl.style.left = `${clamp(clientX - rect.left, 20, Math.max(20, rect.width - 20))}px`;
      tooltipEl.style.top = `${clamp(clientY - rect.top, 16, Math.max(16, rect.height - 16))}px`;
    };
    const showTooltip = (el, clientX, clientY) => {
      tooltipEl.textContent = el.getAttribute("data-tooltip") || "";
      positionTooltip(clientX, clientY);
      tooltipEl.classList.add("show");
    };
    const hideTooltip = () => tooltipEl.classList.remove("show");
    pointEls.forEach((el) => {
      el.addEventListener("mouseenter", (event) => showTooltip(el, event.clientX, event.clientY));
      el.addEventListener("mousemove", (event) => positionTooltip(event.clientX, event.clientY));
      el.addEventListener("mouseleave", hideTooltip);
      el.addEventListener("focus", () => {
        const rect = el.getBoundingClientRect();
        showTooltip(el, rect.left + rect.width / 2, rect.top);
      });
      el.addEventListener("blur", hideTooltip);
    });
  }

  function renderSnapshotPie(dailyActiveUsers, totalUsers, latestDateKey) {
    if (!refs.liveSessionPie) return;
    const active = clampNumber(dailyActiveUsers, 0, 1000000000);
    const total = clampNumber(totalUsers, 0, 1000000000);
    const chartTotal = Math.max(total, active, 1);
    const inactive = Math.max(total - active, 0);
    const ratio = chartTotal > 0 ? clamp(active / chartTotal, 0, 1) : 0;
    const percent = total > 0 ? (active / total) * 100 : 0;
    const radius = 68;
    const cx = 120;
    const cy = 114;
    const circumference = 2 * Math.PI * radius;
    const activeArc = Math.max(0, Math.min(circumference, circumference * ratio));
    const gapArc = Math.max(0, circumference - activeArc);
    refs.liveSessionPie.innerHTML = `
      <div class="pie-chart-shell">
        <svg class="pie-chart-svg" viewBox="0 0 240 228" role="img" aria-label="Current user snapshot chart">
          <circle class="pie-track" cx="${cx}" cy="${cy}" r="${radius}"></circle>
          <circle class="pie-active" cx="${cx}" cy="${cy}" r="${radius}" stroke-dasharray="${activeArc} ${gapArc}"></circle>
          <text class="pie-center-top" x="${cx}" y="${cy - 3}" text-anchor="middle">${formatNumber(active)}/${formatNumber(total)}</text>
          <text class="pie-center-bottom" x="${cx}" y="${cy + 21}" text-anchor="middle">${formatNumber(percent, 1)}% Active</text>
        </svg>
        <div class="pie-legend">
          <div class="pie-legend-row"><span class="pie-dot in-use"></span><span>Daily Active: ${formatNumber(active)}</span></div>
          <div class="pie-legend-row"><span class="pie-dot available"></span><span>Inactive Now: ${formatNumber(inactive)}</span></div>
          <div class="pie-legend-row"><span>Latest Report: ${escapeHtml(latestDateKey ? formatDayKeyLabel(latestDateKey) : "No data")}</span></div>
        </div>
      </div>
    `;
  }

  function renderLoginStatusPie(localUsers, onlineUsers, totalUsers, latestDateKey) {
    if (!refs.loginStatusPie) return;
    const total = clampNumber(totalUsers, 0, 1000000000);
    const local = clampNumber(localUsers, 0, 1000000000);
    const online = clampNumber(onlineUsers, 0, 1000000000);
    const chartTotal = Math.max(total, local + online, 1);
    const localRatio = chartTotal > 0 ? clamp(local / chartTotal, 0, 1) : 0;
    const onlineRatio = chartTotal > 0 ? clamp(online / chartTotal, 0, 1) : 0;
    const radius = 68;
    const cx = 120;
    const cy = 114;
    const circumference = 2 * Math.PI * radius;
    const localArc = Math.max(0, Math.min(circumference, circumference * localRatio));
    const onlineArc = Math.max(0, Math.min(circumference, circumference * onlineRatio));
    const localPercent = total > 0 ? (local / total) * 100 : 0;
    const onlinePercent = total > 0 ? (online / total) * 100 : 0;
    refs.loginStatusPie.innerHTML = `
      <div class="pie-chart-shell">
        <svg class="pie-chart-svg" viewBox="0 0 240 228" role="img" aria-label="Login status chart">
          <circle class="pie-track" cx="${cx}" cy="${cy}" r="${radius}"></circle>
          <circle class="pie-segment-local" cx="${cx}" cy="${cy}" r="${radius}" stroke-dasharray="${localArc} ${Math.max(
            circumference - localArc,
            0
          )}"></circle>
          <circle class="pie-segment-online" cx="${cx}" cy="${cy}" r="${radius}" stroke-dasharray="${onlineArc} ${Math.max(
            circumference - onlineArc,
            0
          )}" stroke-dashoffset="${-localArc}"></circle>
          <text class="pie-center-top" x="${cx}" y="${cy - 3}" text-anchor="middle">${formatNumber(total)}</text>
          <text class="pie-center-bottom" x="${cx}" y="${cy + 21}" text-anchor="middle">Total Users</text>
        </svg>
        <div class="pie-legend">
          <div class="pie-legend-row"><span class="pie-dot local-login"></span><span>Local: ${formatNumber(local)} (${formatNumber(localPercent, 1)}%)</span></div>
          <div class="pie-legend-row"><span class="pie-dot online-login"></span><span>Online: ${formatNumber(online)} (${formatNumber(onlinePercent, 1)}%)</span></div>
          <div class="pie-legend-row"><span>Latest Report: ${escapeHtml(latestDateKey ? formatDayKeyLabel(latestDateKey) : "No data")}</span></div>
        </div>
      </div>
    `;
  }

  function renderActiveBar(series) {
    if (!refs.frequentUsersBar) return;
    if (!series.length) {
      refs.frequentUsersBar.innerHTML = `<p class="empty-note">No chart data.</p>`;
      return;
    }
    const trend = buildMovingAverageSeries(series, 3);
    const height = 356;
    const margin = { top: 18, right: 28, bottom: 92, left: 60 };
    const width = measureChartWidth(refs.frequentUsersBar, 320);
    const plotW = Math.max(width - margin.left - margin.right, 120);
    const plotH = height - margin.top - margin.bottom;
    const baseY = margin.top + plotH;
    const yAxis = buildNiceYAxis(series.map((item) => item.count), 5);
    const maxY = yAxis.maxY;
    const barSlot = plotW / Math.max(series.length, 1);
    const barWidth = Math.max(6, Math.min(32, barSlot * 0.72));
    const points = [];
    const bars = series
      .map((item, idx) => {
        const xCenter = margin.left + barSlot * idx + barSlot / 2;
        const barHeight = (item.count / maxY) * plotH;
        const y = baseY - barHeight;
        const x = xCenter - barWidth / 2;
        points.push({
          x: xCenter,
          y,
          count: item.count,
          shortLabel: item.shortLabel,
          tooltipLabel: item.tooltipLabel,
        });
        const tooltipText = `${item.tooltipLabel}: ${formatNumber(item.count)} active users | Trend (${trend.windowSize}d avg): ${formatNumber(
          trend.values[idx].count,
          1
        )}`;
        return `
          <rect class="bar-rect" x="${x}" y="${y}" width="${barWidth}" height="${Math.max(barHeight, 0)}" rx="8" ry="8" tabindex="0" data-tooltip="${escapeHtml(
            tooltipText
          )}">
            <title>${escapeHtml(tooltipText)}</title>
          </rect>
        `;
      })
      .join("");
    const trendPoints = trend.values.map((item, idx) => ({
      ...item,
      x: points[idx].x,
      y: margin.top + (1 - item.count / maxY) * plotH,
    }));
    const trendPath = buildSmoothLinePath(trendPoints, margin.top, baseY, 0.18);
    const trendDots = trendPoints
      .map(
        (point, idx) => {
          const tooltipText = `${point.tooltipLabel}: ${formatNumber(points[idx].count)} active users | Trend (${trend.windowSize}d avg): ${formatNumber(
            point.count,
            1
          )}`;
          return `
          <circle class="bar-trend-point ${idx === trendPoints.length - 1 ? "is-latest" : ""}" cx="${point.x}" cy="${point.y}" r="${
            idx === trendPoints.length - 1 ? 4 : 3.2
          }" tabindex="0" data-tooltip="${escapeHtml(tooltipText)}">
            <title>${escapeHtml(tooltipText)}</title>
          </circle>
        `;
        }
      )
      .join("");
    let yGuides = "";
    for (const tick of yAxis.ticks) {
      const y = margin.top + (1 - tick.value / maxY) * plotH;
      yGuides += `
        <line class="bar-grid" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"></line>
        <text class="axis-text" x="${margin.left - 8}" y="${y + 4}" text-anchor="end">${formatNumber(tick.value)}</text>
      `;
    }
    const xAxisMarkup = buildXAxisDecoration(points, height, baseY, { minPixelGap: 24 });
    const trendLabel = `Trend (${trend.windowSize}d avg)`;
    const legendWidth = Math.max(184, 82 + trendLabel.length * 6.1);
    const legendHeight = 54;
    const legendX = width - margin.right - legendWidth;
    const legendY = margin.top + 8;
    const legend = `
      <g class="chart-legend">
        <rect class="chart-legend-card" x="${legendX}" y="${legendY}" width="${legendWidth}" height="${legendHeight}" rx="16" ry="16"></rect>
        <rect class="bar-legend-bar-marker" x="${legendX + 18}" y="${legendY + 14}" width="22" height="10" rx="5" ry="5"></rect>
        <text class="chart-legend-text" x="${legendX + 50}" y="${legendY + 24}">Daily Active</text>
        <line class="chart-legend-line chart-legend-line-trend" x1="${legendX + 18}" y1="${legendY + 38}" x2="${legendX + 42}" y2="${legendY + 38}"></line>
        <text class="chart-legend-text" x="${legendX + 50}" y="${legendY + 42}">${trendLabel}</text>
      </g>
    `;
    refs.frequentUsersBar.innerHTML = `
      <svg class="bar-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily active users chart">
        ${yGuides}
        <line class="bar-axis" x1="${margin.left}" y1="${baseY}" x2="${width - margin.right}" y2="${baseY}"></line>
        <line class="bar-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${baseY}"></line>
        ${bars}
        <path class="bar-trend-line" d="${trendPath}"></path>
        ${trendDots}
        ${legend}
        ${xAxisMarkup}
      </svg>
    `;
    bindChartPointTooltips(refs.frequentUsersBar, ".bar-rect, .bar-trend-point");
  }

  function renderUsageMinutesChart(series, unitLabel) {
    if (!refs.avgUsageChart) return;
    if (!series.length) {
      refs.avgUsageChart.innerHTML = `<p class="empty-note">No chart data.</p>`;
      return;
    }
    const trend = buildMovingAverageSeries(series, 3);
    const yAxis = buildNiceYAxis(series.map((item) => item.count), 6);
    const height = 392;
    const margin = { top: 28, right: 42, bottom: 98, left: 76 };
    const width = measureChartWidth(refs.avgUsageChart, 320);
    const plotW = Math.max(width - margin.left - margin.right, 120);
    const plotH = height - margin.top - margin.bottom;
    const baseY = margin.top + plotH;
    const maxY = yAxis.maxY;
    const points = series.map((item, idx) => {
      const ratioX = series.length === 1 ? 0.5 : idx / (series.length - 1);
      return {
        ...item,
        x: margin.left + ratioX * plotW,
        y: margin.top + (1 - item.count / maxY) * plotH,
      };
    });
    const trendPoints = trend.values.map((item, idx) => ({
      ...item,
      x: points[idx].x,
      y: margin.top + (1 - item.count / maxY) * plotH,
    }));
    const linePath = buildSmoothLinePath(points, margin.top, baseY, 0.16);
    const trendPath = buildSmoothLinePath(trendPoints, margin.top, baseY, 0.18);
    const areaPath = `${linePath} L ${points[points.length - 1].x} ${baseY} L ${points[0].x} ${baseY} Z`;
    let yGuides = "";
    for (const tick of yAxis.ticks) {
      const y = margin.top + (1 - tick.value / maxY) * plotH;
      yGuides += `
        <line class="chart-grid" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"></line>
        <text class="axis-text" x="${margin.left - 10}" y="${y + 4}" text-anchor="end">${formatNumber(tick.value)}</text>
      `;
    }
    const xAxisMarkup = buildXAxisDecoration(points, height, baseY, { minPixelGap: 24 });
    const latestIndex = points.length - 1;
    const dots = points
      .map(
        (point, idx) => `
          <circle class="usage-chart-point ${idx === latestIndex ? "is-latest" : ""}" cx="${point.x}" cy="${point.y}" r="${
            idx === latestIndex ? 5.2 : 3.6
          }" tabindex="0" data-tooltip="${escapeHtml(
            `${point.tooltipLabel}: ${formatNumber(point.count)} ${unitLabel} | Trend (${trend.windowSize}d avg): ${formatNumber(
              trend.values[idx].count,
              1
            )} ${unitLabel}`
          )}">
            <title>${escapeHtml(
              `${point.tooltipLabel}: ${formatNumber(point.count)} ${unitLabel} | Trend (${trend.windowSize}d avg): ${formatNumber(
                trend.values[idx].count,
                1
              )} ${unitLabel}`
            )}</title>
          </circle>
        `
      )
      .join("");
    const trendLabel = `Trend (${trend.windowSize}d avg)`;
    const legendWidth = Math.max(198, 96 + trendLabel.length * 6.1);
    const legendHeight = 56;
    const legendX = width - margin.right - legendWidth;
    const legendY = margin.top + 10;
    const legend = `
      <g class="chart-legend">
        <rect class="chart-legend-card" x="${legendX}" y="${legendY}" width="${legendWidth}" height="${legendHeight}" rx="16" ry="16"></rect>
        <line class="chart-legend-line usage-legend-line-actual" x1="${legendX + 18}" y1="${legendY + 20}" x2="${legendX + 42}" y2="${legendY + 20}"></line>
        <text class="chart-legend-text" x="${legendX + 50}" y="${legendY + 24}">Avg Usage (min)</text>
        <line class="chart-legend-line chart-legend-line-trend" x1="${legendX + 18}" y1="${legendY + 40}" x2="${legendX + 42}" y2="${legendY + 40}"></line>
        <text class="chart-legend-text" x="${legendX + 50}" y="${legendY + 44}">${trendLabel}</text>
      </g>
    `;
    const defs = `
      <defs>
        <linearGradient id="usageAreaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#de7d32" stop-opacity="0.22"></stop>
          <stop offset="64%" stop-color="#de7d32" stop-opacity="0.07"></stop>
          <stop offset="100%" stop-color="#de7d32" stop-opacity="0"></stop>
        </linearGradient>
        <linearGradient id="usageLineGradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#dd8734"></stop>
          <stop offset="100%" stop-color="#b35f1d"></stop>
        </linearGradient>
        <filter id="usageSoftGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="10" stdDeviation="8" flood-color="#b35f1d" flood-opacity="0.12"></feDropShadow>
        </filter>
      </defs>
    `;
    refs.avgUsageChart.innerHTML = `
      <svg class="line-chart-svg usage-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Average usage minutes chart">
        ${defs}
        ${yGuides}
        <line class="chart-axis" x1="${margin.left}" y1="${baseY}" x2="${width - margin.right}" y2="${baseY}"></line>
        <line class="chart-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${baseY}"></line>
        <path class="usage-line-area" fill="url(#usageAreaGradient)" d="${areaPath}"></path>
        <path class="trend-line-path" d="${trendPath}"></path>
        <path class="usage-line-path" stroke="url(#usageLineGradient)" filter="url(#usageSoftGlow)" d="${linePath}"></path>
        ${legend}
        ${dots}
        ${xAxisMarkup}
      </svg>
    `;
    bindChartPointTooltips(refs.avgUsageChart, ".usage-chart-point");
  }

  function renderSummaryStats(container, items, emptyText) {
    if (!container) return;
    if (!items.length) {
      container.innerHTML = `<p class="empty-note">${escapeHtml(emptyText)}</p>`;
      return;
    }
    container.innerHTML = items
      .map(
        (item) => `
          <div class="summary-row">
            <span class="summary-label">${escapeHtml(item.label)}</span>
            <span class="summary-value">${escapeHtml(item.value)}</span>
            <span class="summary-note">${escapeHtml(item.note)}</span>
          </div>
        `
      )
      .join("");
  }

  function buildRegistrationSummary(rangeNewUsers, rangeLabel) {
    return [
      { label: "Total New Users", value: formatNumber(state.summary.totalNewUsers), note: `Across ${formatNumber(state.summary.trackedDays)} tracked days` },
      { label: "Avg / Day", value: formatNumber(state.summary.averageNewUsers, 1), note: "Whole data file" },
      { label: "Peak Day", value: formatNumber(state.summary.peakNewUsers), note: formatDayKeyLabel(state.summary.peakNewDateKey) },
      { label: "Full Range", value: formatNumber(rangeNewUsers), note: rangeLabel },
    ];
  }

  function buildUsageSummary() {
    const activeRate =
      state.summary.latestTotalUsers > 0
        ? (state.summary.latestDailyActiveUsers / state.summary.latestTotalUsers) * 100
        : 0;
    const localRate = state.summary.latestTotalUsers > 0 ? (state.summary.latestLocalUsers / state.summary.latestTotalUsers) * 100 : 0;
    const onlineRate = state.summary.latestTotalUsers > 0 ? (state.summary.latestOnlineUsers / state.summary.latestTotalUsers) * 100 : 0;
    return [
      { label: "Latest Active Rate", value: `${formatNumber(activeRate, 1)}%`, note: formatDayKeyLabel(state.summary.latestDateKey) },
      { label: "Latest Avg Usage", value: `${formatNumber(state.summary.latestAverageUsageMinutes)} min`, note: `Daily average on ${formatDayKeyLabel(state.summary.latestDateKey)}` },
      { label: "Login Mix", value: `${formatNumber(state.summary.latestLocalUsers)} / ${formatNumber(state.summary.latestOnlineUsers)}`, note: `${formatNumber(localRate, 1)}% local, ${formatNumber(onlineRate, 1)}% online` },
      { label: "Peak Usage Day", value: `${formatNumber(state.summary.peakAverageUsageMinutes)} min`, note: formatDayKeyLabel(state.summary.peakAverageUsageDateKey) },
      { label: "Avg Active / Day", value: formatNumber(state.summary.averageDailyActiveUsers, 1), note: `Across ${formatNumber(state.summary.trackedDays)} tracked days` },
    ];
  }

  function buildStaticRangeLabel(days) {
    if (!Array.isArray(days) || !days.length) return "No timeline data";
    return `${formatDateOnly(days[0].dateMs)} -> ${formatDateOnly(days[days.length - 1].dateMs)} (full range)`;
  }

  function toSeries(days, field) {
    return days.map((day) => ({
      count: clampNumber(Number(day[field]) || 0, 0, 1000000000),
      shortLabel: formatCompactDate(day.dateMs),
      tooltipLabel: formatDateOnly(day.dateMs),
    }));
  }

  function sumBy(days, field) {
    let total = 0;
    for (const day of days) total += Number(day[field]) || 0;
    return total;
  }

  function buildDayDeltaText(todayCount, yesterdayCount) {
    const diff = todayCount - yesterdayCount;
    if (yesterdayCount === 0) return todayCount === 0 ? "0" : `+${formatNumber(diff)} / +100%`;
    const pct = (diff / yesterdayCount) * 100;
    const sign = diff >= 0 ? "+" : "";
    return `${sign}${formatNumber(diff)} / ${sign}${formatNumber(pct, 1)}%`;
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

  function formatCompactDate(input) {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: state.timezone,
      day: "2-digit",
      month: "2-digit",
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
    const year = parts.find((part) => part.type === "year")?.value || "";
    const month = parts.find((part) => part.type === "month")?.value || "";
    const day = parts.find((part) => part.type === "day")?.value || "";
    return year && month && day ? `${year}-${month}-${day}` : "";
  }

  function formatDayKeyLabel(dayKey) {
    if (!isDayKey(dayKey)) return "-";
    const utcMs = dayKeyToUtcStartMs(dayKey, 0, 0, 0);
    return Number.isFinite(utcMs) ? formatDateOnly(utcMs) : "-";
  }

  function formatNumber(value, fractionDigits = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "-";
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: fractionDigits,
      minimumFractionDigits: fractionDigits,
    }).format(numeric);
  }

  function buildXAxisLabelIndexes(points, labelStep, minPixelGap) {
    if (!points.length) return [];
    const step = Math.max(1, Number(labelStep) || 1);
    const indexes = [];
    for (let idx = 0; idx < points.length; idx += step) indexes.push(idx);
    const lastIndex = points.length - 1;
    if (indexes[indexes.length - 1] !== lastIndex) indexes.push(lastIndex);
    const gap = Math.max(22, Number(minPixelGap) || 24);
    let idx = 1;
    while (idx < indexes.length) {
      const pixelGap = points[indexes[idx]].x - points[indexes[idx - 1]].x;
      if (pixelGap >= gap) {
        idx += 1;
        continue;
      }
      if (indexes[idx] === lastIndex) {
        indexes.splice(idx - 1, 1);
        if (idx > 1) idx -= 1;
        continue;
      }
      indexes.splice(idx, 1);
    }
    return indexes;
  }

  function buildXAxisDecoration(points, height, baseY, options = {}) {
    if (!points.length) return "";
    const minPixelGap = Math.max(22, Number(options.minPixelGap) || 24);
    const minorTickSize = Math.max(4, Number(options.minorTickSize) || 4);
    const majorTickSize = Math.max(7, Number(options.majorTickSize) || 8);
    const labelIndexes = buildXAxisLabelIndexes(points, 1, minPixelGap);
    const minorTicks = points
      .map((point) => `<line class="axis-tick axis-tick-minor" x1="${point.x}" y1="${baseY}" x2="${point.x}" y2="${baseY + minorTickSize}"></line>`)
      .join("");
    const labels = labelIndexes
      .map((idx, order) => {
        const point = points[idx];
        const labelY = order % 2 === 0 ? height - 18 : height - 38;
        return `
          <line class="axis-tick axis-tick-major" x1="${point.x}" y1="${baseY}" x2="${point.x}" y2="${baseY + majorTickSize}"></line>
          <text class="axis-text axis-text-x ${order % 2 === 1 ? "axis-text-x-alt" : ""}" x="${point.x}" y="${labelY}" text-anchor="middle">${escapeHtml(
            point.shortLabel
          )}</text>
        `;
      })
      .join("");
    return `${minorTicks}${labels}`;
  }

  function toast(message, ms = 3200) {
    if (!toastEl) return;
    toastEl.textContent = String(message || "");
    toastEl.classList.remove("hidden");
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => toastEl.classList.add("hidden"), ms);
  }

  function readAuthSession() {
    try {
      return sessionStorage.getItem(AUTH_SESSION_KEY) === AUTH_USERNAME;
    } catch (_error) {
      return false;
    }
  }

  function persistAuthSession(username) {
    try {
      sessionStorage.setItem(AUTH_SESSION_KEY, String(username || AUTH_USERNAME));
    } catch (_error) {}
  }

  function clearAuthSession() {
    try {
      sessionStorage.removeItem(AUTH_SESSION_KEY);
    } catch (_error) {}
  }

  function isDayKey(input) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(input || ""));
  }

  function dayKeyToUtcStartMs(dayKey, hour = 0, minute = 0, second = 0) {
    if (!isDayKey(dayKey)) return Number.NaN;
    const match = String(dayKey).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return Number.NaN;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(hour) - 7, Number(minute), Number(second));
  }

  function clamp(value, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
  }

  function clampNumber(value, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : min;
  }

  function measureChartWidth(containerEl, minWidth = 320) {
    const width = Math.floor(containerEl?.clientWidth || containerEl?.getBoundingClientRect?.().width || 0);
    return Math.max(minWidth, width);
  }

  function emptySummary() {
    return {
      latestDateKey: "",
      latestNewUsers: 0,
      previousNewUsers: 0,
      latestDailyActiveUsers: 0,
      latestTotalUsers: 0,
      latestLocalUsers: 0,
      latestOnlineUsers: 0,
      latestAverageUsageMinutes: 0,
      totalNewUsers: 0,
      averageNewUsers: 0,
      averageDailyActiveUsers: 0,
      averageUsageMinutes: 0,
      peakNewUsers: 0,
      peakNewDateKey: "",
      peakDailyActiveUsers: 0,
      peakDailyActiveDateKey: "",
      peakAverageUsageMinutes: 0,
      peakAverageUsageDateKey: "",
      trackedDays: 0,
    };
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
