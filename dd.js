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
    dailyChart: document.getElementById("dailyChart"),
    totalRegistrationsPie: document.getElementById("totalRegistrationsPie"),
    avgDailyUsersPie: document.getElementById("avgDailyUsersPie"),
    avgUsagePie: document.getElementById("avgUsagePie"),
    frequentUsersBar: document.getElementById("frequentUsersBar"),
    avgUsageChart: document.getElementById("avgUsageChart"),
    gpuTrafficChart: document.getElementById("gpuTrafficChart"),
    gpuTrafficCanvas: document.getElementById("gpuTrafficCanvas"),
    gpuStatusBadge: document.getElementById("gpuStatusBadge"),
    gpuLaneBadge: document.getElementById("gpuLaneBadge"),
    gpuMetricLoad: document.getElementById("gpuMetricLoad"),
    gpuMetricPeak: document.getElementById("gpuMetricPeak"),
    gpuMetricStability: document.getElementById("gpuMetricStability"),
    gpuMetricCadence: document.getElementById("gpuMetricCadence"),
    gpuMetricWindow: document.getElementById("gpuMetricWindow"),
    gpuTrafficMeta: document.getElementById("gpuTrafficMeta"),
  };
  const state = {
    refreshSeconds: 30,
    autoRefresh: true,
    timerId: null,
    resizeTimerId: null,
    lastVisibilityWakeAt: 0,
    loading: false,
    isAuthenticated: false,
    timezone: String(cfg.TIMEZONE || "Asia/Ho_Chi_Minh"),
    dataFilePath: String(cfg.DATA_FILE_PATH || "./daily_metrics.txt"),
    displayStartDayKey: isDayKey(cfg.DISPLAY_START_DATE) ? String(cfg.DISPLAY_START_DATE) : "",
    days: [],
    summary: emptySummary(),
    gpuTraffic: createGpuTrafficState(),
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
      if (!state.isAuthenticated) return;
      if (Date.now() - state.lastVisibilityWakeAt < 480) return;
      refreshDashboard();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") {
        stopGpuTrafficVisualizer();
        return;
      }
      if (document.visibilityState === "visible" && state.isAuthenticated) {
        state.lastVisibilityWakeAt = Date.now();
        refreshDashboard(false, true);
        startGpuTrafficVisualizer();
      }
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
    refreshDashboard(true, true);
    setupAutoRefresh();
    startGpuTrafficVisualizer();
  }

  function stopDashboardSession() {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    stopGpuTrafficVisualizer();
    state.loading = false;
  }

  function handleWindowResize() {
    if (!state.isAuthenticated) return;
    clearTimeout(state.resizeTimerId);
    state.resizeTimerId = setTimeout(() => {
      renderDashboard(false);
      resizeGpuTrafficVisualizer();
    }, 120);
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

  async function refreshDashboard(showToastOnError = false, animateCharts = false) {
    if (!state.isAuthenticated || state.loading) return;
    state.loading = true;
    try {
      const payload = await loadPayload();
      state.days = payload.days;
      state.summary = payload.summary;
      renderDashboard(animateCharts);
    } catch (error) {
      const hasExistingData = state.days.length > 0;
      if (!hasExistingData) {
        state.summary = emptySummary();
        renderDashboard(false);
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

  function renderDashboard(animateCharts = false) {
    if (!state.days.length) {
      setChartAnimationState(refs.dailyChart, false);
      refs.dailyChart.innerHTML = `<p class="empty-note">No chart data.</p>`;
      renderTotalRegistrationsPie(0, "", animateCharts);
      renderAverageDailyUsersPie(0, 0, "", 0, animateCharts);
      renderAverageUsageInsightPie(0, 0, "", 0, "", 0, animateCharts);
      renderActiveBar([], animateCharts);
      renderUsageMinutesChart([], "", animateCharts);
      ensureGpuTrafficVisualizer();
      return;
    }
    const visibleDays = state.days.slice();
    renderLineChart(toSeries(visibleDays, "newUsers"), "new users", animateCharts);
    renderTotalRegistrationsPie(state.summary.latestTotalUsers, state.summary.latestDateKey, animateCharts);
    renderAverageDailyUsersPie(
      state.summary.averageDailyActiveUsers,
      state.summary.peakDailyActiveUsers,
      state.summary.peakDailyActiveDateKey,
      state.summary.trackedDays,
      animateCharts
    );
    renderAverageUsageInsightPie(
      state.summary.averageUsageMinutes,
      state.summary.peakAverageUsageMinutes,
      state.summary.peakAverageUsageDateKey,
      state.summary.latestAverageUsageMinutes,
      state.summary.latestDateKey,
      state.summary.trackedDays,
      animateCharts
    );
    renderActiveBar(toSeries(visibleDays, "dailyActiveUsers"), animateCharts);
    renderUsageMinutesChart(toSeries(visibleDays, "averageUsageMinutes"), "min", animateCharts);
    ensureGpuTrafficVisualizer();
  }

  function ensureGpuTrafficVisualizer() {
    if (!refs.gpuTrafficChart || !refs.gpuTrafficCanvas) return;
    const gpu = state.gpuTraffic;
    if (!gpu.canvas || gpu.canvas !== refs.gpuTrafficCanvas) {
      gpu.canvas = refs.gpuTrafficCanvas;
      gpu.ctx = gpu.canvas.getContext("2d", { alpha: true });
    }
    if (!gpu.ctx) return;
    resizeGpuTrafficVisualizer();
    if (!gpu.series.length) {
      seedGpuTrafficSeries();
    }
    drawGpuTrafficVisualizer();
    updateGpuTrafficMetrics(true);
    startGpuTrafficVisualizerLoop();
  }

  function startGpuTrafficVisualizer() {
    ensureGpuTrafficVisualizer();
  }

  function startGpuTrafficVisualizerLoop() {
    const gpu = state.gpuTraffic;
    if (!gpu.ctx || !state.isAuthenticated || document.visibilityState !== "visible" || prefersReducedMotion()) {
      return;
    }
    if (gpu.rafId) return;
    gpu.lastFrameAt = performance.now();
    gpu.rafId = requestAnimationFrame(stepGpuTrafficVisualizer);
  }

  function stopGpuTrafficVisualizer() {
    const gpu = state.gpuTraffic;
    if (gpu.rafId) {
      cancelAnimationFrame(gpu.rafId);
      gpu.rafId = 0;
    }
    gpu.lastFrameAt = 0;
  }

  function stepGpuTrafficVisualizer(timestamp) {
    const gpu = state.gpuTraffic;
    if (!gpu.ctx || !state.isAuthenticated || document.visibilityState !== "visible") {
      stopGpuTrafficVisualizer();
      return;
    }
    if (!gpu.lastFrameAt) gpu.lastFrameAt = timestamp;
    const delta = Math.max(0, Math.min(64, timestamp - gpu.lastFrameAt));
    gpu.lastFrameAt = timestamp;
    const speedPxPerMs = gpu.sampleGap / gpu.stepMs;
    gpu.scrollOffset += delta * speedPxPerMs;
    let stepCount = 0;
    while (gpu.scrollOffset >= gpu.sampleGap) {
      gpu.scrollOffset -= gpu.sampleGap;
      stepCount += 1;
    }
    if (stepCount > 0) {
      advanceGpuTrafficSeries(stepCount);
    }
    drawGpuTrafficVisualizer();
    updateGpuTrafficMetrics();
    gpu.rafId = requestAnimationFrame(stepGpuTrafficVisualizer);
  }

  function resizeGpuTrafficVisualizer() {
    const gpu = state.gpuTraffic;
    const host = refs.gpuTrafficChart;
    const canvas = refs.gpuTrafficCanvas;
    if (!host || !canvas || !gpu.ctx) return;
    const width = Math.max(320, Math.floor(host.clientWidth || 0));
    const height = Math.max(220, Math.floor(host.clientHeight || 0));
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    const nextGap = Math.round(clamp(width / 44, 16, 24));
    const needsResize = gpu.width !== width || gpu.height !== height || gpu.dpr !== dpr || gpu.sampleGap !== nextGap;
    if (!needsResize) return;
    gpu.width = width;
    gpu.height = height;
    gpu.dpr = dpr;
    gpu.sampleGap = nextGap;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    gpu.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gpu.ctx.imageSmoothingEnabled = true;
    seedGpuTrafficSeries();
    updateGpuTrafficMetrics(true);
  }

  function seedGpuTrafficSeries() {
    const gpu = state.gpuTraffic;
    if (!gpu.width || !gpu.height) return;
    const sampleCount = Math.max(28, Math.ceil(gpu.width / Math.max(gpu.sampleGap, 1)) + 8);
    const palette = [
      {
        stroke: "#67f0c8",
        fillTop: "rgba(103, 240, 200, 0.18)",
        fillBottom: "rgba(103, 240, 200, 0.01)",
        glow: "rgba(103, 240, 200, 0.34)",
        baseline: 0.18,
        amplitude: 0.09,
        secondary: 0.05,
        swing: 0.92,
        noise: 0.038,
      },
      {
        stroke: "#6ec8ff",
        fillTop: "rgba(110, 200, 255, 0.16)",
        fillBottom: "rgba(110, 200, 255, 0.01)",
        glow: "rgba(110, 200, 255, 0.3)",
        baseline: 0.34,
        amplitude: 0.11,
        secondary: 0.06,
        swing: 0.86,
        noise: 0.04,
      },
      {
        stroke: "#ff9e5c",
        fillTop: "rgba(255, 158, 92, 0.14)",
        fillBottom: "rgba(255, 158, 92, 0.01)",
        glow: "rgba(255, 158, 92, 0.26)",
        baseline: 0.5,
        amplitude: 0.1,
        secondary: 0.055,
        swing: 1.04,
        noise: 0.044,
      },
      {
        stroke: "#c297ff",
        fillTop: "rgba(194, 151, 255, 0.13)",
        fillBottom: "rgba(194, 151, 255, 0.01)",
        glow: "rgba(194, 151, 255, 0.24)",
        baseline: 0.65,
        amplitude: 0.085,
        secondary: 0.05,
        swing: 0.78,
        noise: 0.035,
      },
      {
        stroke: "#4d8dff",
        fillTop: "rgba(77, 141, 255, 0.12)",
        fillBottom: "rgba(77, 141, 255, 0.01)",
        glow: "rgba(77, 141, 255, 0.24)",
        baseline: 0.79,
        amplitude: 0.072,
        secondary: 0.044,
        swing: 0.72,
        noise: 0.03,
      },
    ];
    gpu.series = palette.map((tone, index) => {
      const series = {
        ...tone,
        drift: 0,
        surge: 0,
        phase: Math.random() * Math.PI * 2,
        seed: Math.random() * 7 + index * 0.8,
        values: [],
      };
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        series.values.push(nextGpuTrafficValue(series));
      }
      return series;
    });
    gpu.scrollOffset = 0;
  }

  function advanceGpuTrafficSeries(stepCount = 1) {
    const gpu = state.gpuTraffic;
    if (!gpu.series.length) return;
    const targetLength = Math.max(28, Math.ceil(gpu.width / Math.max(gpu.sampleGap, 1)) + 8);
    for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
      gpu.series.forEach((series) => {
        series.values.push(nextGpuTrafficValue(series));
        while (series.values.length > targetLength) {
          series.values.shift();
        }
      });
    }
  }

  function updateGpuTrafficMetrics(force = false) {
    const gpu = state.gpuTraffic;
    if (!gpu.series.length) return;
    const now = performance.now();
    if (!force && now - gpu.metricsUpdatedAt < 240) return;
    gpu.metricsUpdatedAt = now;
    const lastValues = gpu.series.map((series) => Number(series.values[series.values.length - 1] || 0));
    const previousValues = gpu.series.map((series) => Number(series.values[Math.max(0, series.values.length - 4)] || 0));
    const compositeLoad = lastValues.reduce((sum, value) => sum + value, 0) / Math.max(lastValues.length, 1);
    const peakValue = Math.max(...lastValues, 0);
    const peakIndex = Math.max(0, lastValues.findIndex((value) => value === peakValue));
    const spread = Math.max(...lastValues, 0) - Math.min(...lastValues, 0);
    const drift = lastValues.reduce((sum, value, index) => sum + Math.abs(value - previousValues[index]), 0) / Math.max(lastValues.length, 1);
    const windowSeconds = Math.max(1, Math.round(((gpu.series[0]?.values.length || 0) * gpu.stepMs) / 1000));
    const stability =
      drift < 0.018 && spread < 0.22
        ? { label: "Stable", badgeClass: "gpu-badge gpu-badge-live" }
        : drift < 0.04 && spread < 0.34
          ? { label: "Adaptive", badgeClass: "gpu-badge gpu-badge-warn" }
          : { label: "Elevated", badgeClass: "gpu-badge gpu-badge-alert" };

    if (refs.gpuMetricLoad) refs.gpuMetricLoad.textContent = `${formatNumber(compositeLoad * 100)}%`;
    if (refs.gpuMetricPeak) refs.gpuMetricPeak.textContent = `L${peakIndex + 1} · ${formatNumber(peakValue * 100)}%`;
    if (refs.gpuMetricStability) refs.gpuMetricStability.textContent = stability.label;
    if (refs.gpuMetricCadence) refs.gpuMetricCadence.textContent = `${formatNumber(gpu.stepMs)} ms`;
    if (refs.gpuMetricWindow) refs.gpuMetricWindow.textContent = `${formatNumber(windowSeconds)} s`;
    if (refs.gpuStatusBadge) {
      refs.gpuStatusBadge.className = stability.badgeClass;
      refs.gpuStatusBadge.textContent = stability.label;
    }
    if (refs.gpuLaneBadge) refs.gpuLaneBadge.textContent = `${formatNumber(gpu.series.length)} lanes`;
    if (refs.gpuTrafficMeta) refs.gpuTrafficMeta.textContent = `Spread ${formatNumber(spread * 100)}% · Drift ${formatNumber(drift * 100, 1)} pts`;
  }

  function nextGpuTrafficValue(series) {
    series.phase += series.swing * 0.085;
    series.drift = clamp(series.drift + (Math.random() - 0.5) * series.noise * 1.6, -0.24, 0.24);
    series.surge = Math.max(0, series.surge * 0.82 - 0.006);
    if (Math.random() > 0.988) {
      series.surge = 0.04 + Math.random() * 0.09;
    }
    const primaryWave = Math.sin(series.phase + series.seed) * series.amplitude;
    const secondaryWave = Math.sin(series.phase * 0.43 + series.seed * 1.7) * series.secondary;
    const longWave = Math.sin(series.phase * 0.11 + series.seed * 2.8) * 0.048;
    const microNoise = (Math.random() - 0.5) * series.noise;
    return clamp(series.baseline + primaryWave + secondaryWave + longWave + series.drift * 0.34 + series.surge + microNoise, 0.04, 0.96);
  }

  function drawGpuTrafficVisualizer() {
    const gpu = state.gpuTraffic;
    if (!gpu.ctx || !gpu.width || !gpu.height || !gpu.series.length) return;
    const ctx = gpu.ctx;
    const width = gpu.width;
    const height = gpu.height;
    const plotTop = 16;
    const plotBottom = height - 18;
    const plotHeight = plotBottom - plotTop;
    ctx.clearRect(0, 0, width, height);

    const ambientGlow = ctx.createRadialGradient(width * 0.18, height * 0.08, 0, width * 0.18, height * 0.08, width * 0.72);
    ambientGlow.addColorStop(0, "rgba(102, 241, 196, 0.05)");
    ambientGlow.addColorStop(0.58, "rgba(91, 166, 255, 0.035)");
    ambientGlow.addColorStop(1, "rgba(8, 16, 23, 0)");
    ctx.fillStyle = ambientGlow;
    ctx.fillRect(0, 0, width, height);

    for (let guideIndex = 1; guideIndex <= 4; guideIndex += 1) {
      const y = plotTop + (plotHeight / 5) * guideIndex;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.strokeStyle = guideIndex === 4 ? "rgba(194, 221, 231, 0.065)" : "rgba(194, 221, 231, 0.045)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    gpu.series.forEach((series) => {
      const points = series.values.map((value, index) => ({
        x: width - (series.values.length - 1 - index) * gpu.sampleGap - gpu.scrollOffset,
        y: plotTop + (1 - value) * plotHeight,
      }));
      drawGpuTrafficArea(ctx, points, plotBottom, series);
      drawGpuTrafficLine(ctx, points, series);
      drawGpuTrafficPulse(ctx, points[points.length - 1], series);
    });

    const edgeGlow = ctx.createLinearGradient(width - 68, 0, width, 0);
    edgeGlow.addColorStop(0, "rgba(255, 255, 255, 0)");
    edgeGlow.addColorStop(1, "rgba(255, 255, 255, 0.08)");
    ctx.fillStyle = edgeGlow;
    ctx.fillRect(width - 68, 0, 68, height);
  }

  function drawGpuTrafficArea(ctx, points, baseY, series) {
    if (points.length < 2) return;
    const fillGradient = ctx.createLinearGradient(0, 0, 0, baseY);
    fillGradient.addColorStop(0, series.fillTop);
    fillGradient.addColorStop(1, series.fillBottom);
    ctx.save();
    ctx.beginPath();
    traceGpuTrafficPath(ctx, points);
    ctx.lineTo(points[points.length - 1].x, baseY);
    ctx.lineTo(points[0].x, baseY);
    ctx.closePath();
    ctx.fillStyle = fillGradient;
    ctx.fill();
    ctx.restore();
  }

  function drawGpuTrafficLine(ctx, points, series) {
    if (points.length < 2) return;
    ctx.save();
    ctx.beginPath();
    traceGpuTrafficPath(ctx, points);
    ctx.lineWidth = 2;
    ctx.strokeStyle = series.stroke;
    ctx.shadowColor = series.glow;
    ctx.shadowBlur = 12;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
  }

  function drawGpuTrafficPulse(ctx, point, series) {
    if (!point) return;
    ctx.save();
    const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, 10);
    glow.addColorStop(0, "rgba(255, 255, 255, 0.88)");
    glow.addColorStop(0.28, series.stroke);
    glow.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f8feff";
    ctx.beginPath();
    ctx.arc(point.x, point.y, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function traceGpuTrafficPath(ctx, points) {
    if (!points.length) return;
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) return;
    if (points.length === 2) {
      ctx.lineTo(points[1].x, points[1].y);
      return;
    }
    for (let index = 1; index < points.length - 1; index += 1) {
      const midX = (points[index].x + points[index + 1].x) / 2;
      const midY = (points[index].y + points[index + 1].y) / 2;
      ctx.quadraticCurveTo(points[index].x, points[index].y, midX, midY);
    }
    const penultimate = points[points.length - 2];
    const last = points[points.length - 1];
    ctx.quadraticCurveTo(penultimate.x, penultimate.y, last.x, last.y);
  }

  function renderTotalRegistrationsPie(totalUsers, latestDateKey, animate = false) {
    const total = clampNumber(totalUsers, 0, 1000000000);
    const target = buildMilestoneTarget(total);
    const remaining = Math.max(target - total, 0);
    const ratio = target > 0 ? clamp(total / target, 0, 1) : 0;
    renderInsightPie(
      refs.totalRegistrationsPie,
      {
        ariaLabel: "Registered users to date chart",
        tone: {
          start: "#0e9f90",
          end: "#09746a",
          soft: "rgba(14, 159, 144, 0.16)",
          softAlt: "rgba(14, 159, 144, 0.1)",
          glow: "rgba(14, 159, 144, 0.24)",
        },
        ratio,
        valueText: formatNumber(total),
        caption: "Registered users",
        badge: `${formatNumber(ratio * 100, 1)}% to ${formatNumber(target)}`,
        rows: [
          {
            label: "Current total",
            value: `${formatNumber(total)} cumulative users`,
            note: latestDateKey ? `Latest report ${formatDayKeyLabel(latestDateKey)}` : "Waiting for the first report",
          },
          {
            label: "Next milestone",
            value: `${formatNumber(remaining)} users remaining`,
            note: `Target ${formatNumber(target)} users`,
          },
        ],
      },
      animate
    );
  }

  function renderAverageDailyUsersPie(averageDailyUsers, peakDailyUsers, peakDayKey, trackedDays, animate = false) {
    const average = Math.max(0, Number(averageDailyUsers) || 0);
    const roundedAverage = clampNumber(Math.round(average), 0, 1000000000);
    const peak = clampNumber(peakDailyUsers, 0, 1000000000);
    const chartMax = Math.max(peak, roundedAverage, 1);
    const ratio = chartMax > 0 ? clamp(average / chartMax, 0, 1) : 0;
    renderInsightPie(
      refs.avgDailyUsersPie,
      {
        ariaLabel: "Average daily users chart",
        tone: {
          start: "#2e78ff",
          end: "#1750b8",
          soft: "rgba(46, 120, 255, 0.14)",
          softAlt: "rgba(23, 80, 184, 0.08)",
          glow: "rgba(46, 120, 255, 0.22)",
        },
        ratio,
        valueText: formatNumber(roundedAverage),
        caption: "Avg users / day",
        badge: `${formatNumber(ratio * 100, 1)}% of peak day`,
        rows: [
          {
            label: "Rounded average",
            value: `${formatNumber(roundedAverage)} users per day`,
            note: `Across ${formatNumber(trackedDays)} reported days`,
          },
          {
            label: "Precise average",
            value: `${formatNumber(average, 1)} active users`,
            note: "Rounded visually to the nearest whole user",
          },
          {
            label: "Peak daily activity",
            value: `${formatNumber(peak)} users`,
            note: peakDayKey ? formatDayKeyLabel(peakDayKey) : "No peak day yet",
          },
        ],
      },
      animate
    );
  }

  function renderAverageUsageInsightPie(averageUsageMinutes, peakUsageMinutes, peakDayKey, latestUsageMinutes, latestDateKey, trackedDays, animate = false) {
    const averageUsage = Math.max(0, Number(averageUsageMinutes) || 0);
    const peakUsage = clampNumber(peakUsageMinutes, 0, 1000000000);
    const latestUsage = clampNumber(latestUsageMinutes, 0, 1000000000);
    const chartMax = Math.max(peakUsage, Math.ceil(averageUsage), 1);
    const ratio = chartMax > 0 ? clamp(averageUsage / chartMax, 0, 1) : 0;
    renderInsightPie(
      refs.avgUsagePie,
      {
        ariaLabel: "Average usage time chart",
        tone: {
          start: "#de7d32",
          end: "#b35f1d",
          soft: "rgba(222, 125, 50, 0.16)",
          softAlt: "rgba(179, 95, 29, 0.09)",
          glow: "rgba(222, 125, 50, 0.24)",
        },
        ratio,
        valueText: `${formatMetricNumber(averageUsage)}m`,
        caption: "Avg usage time",
        badge: `${formatNumber(ratio * 100, 1)}% of best usage day`,
        rows: [
          {
            label: "Average usage",
            value: `${formatMetricNumber(averageUsage)} min / day`,
            note: `Across ${formatNumber(trackedDays)} reported days`,
          },
          {
            label: "Peak usage day",
            value: `${formatNumber(peakUsage)} min`,
            note: peakDayKey ? formatDayKeyLabel(peakDayKey) : "No peak day yet",
          },
          {
            label: "Latest reported day",
            value: `${formatNumber(latestUsage)} min`,
            note: latestDateKey ? formatDayKeyLabel(latestDateKey) : "Waiting for the first report",
          },
        ],
      },
      animate
    );
  }

  function renderInsightPie(container, config, animate = false) {
    if (!container) return;
    setChartAnimationState(container, animate);
    const tone = config?.tone || {};
    const ratio = clamp(config?.ratio || 0, 0, 1);
    const radius = 74;
    const cx = 120;
    const cy = 120;
    const circumference = 2 * Math.PI * radius;
    const activeArc = Math.max(0, Math.min(circumference, circumference * ratio));
    const gapArc = Math.max(0, circumference - activeArc);
    const gradientId = `${container.id || "insightPie"}Gradient`;
    const rows = Array.isArray(config?.rows) ? config.rows : [];
    container.innerHTML = `
      <div
        class="radial-stat-shell"
        style="
          --tone-start:${escapeHtml(tone.start || "#0e9f90")};
          --tone-end:${escapeHtml(tone.end || "#09746a")};
          --tone-soft:${escapeHtml(tone.soft || "rgba(14, 159, 144, 0.16)")};
          --tone-soft-alt:${escapeHtml(tone.softAlt || tone.soft || "rgba(14, 159, 144, 0.1)")};
          --tone-glow:${escapeHtml(tone.glow || "rgba(14, 159, 144, 0.24)")};
        "
      >
        <div class="radial-stat-orbit">
          <svg class="radial-stat-svg" viewBox="0 0 240 240" role="img" aria-label="${escapeHtml(config?.ariaLabel || "Insight chart")}">
            <defs>
              <linearGradient id="${escapeHtml(gradientId)}" x1="12%" y1="8%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="${escapeHtml(tone.start || "#0e9f90")}"></stop>
                <stop offset="100%" stop-color="${escapeHtml(tone.end || "#09746a")}"></stop>
              </linearGradient>
            </defs>
            <circle class="radial-stat-inner-track" cx="${cx}" cy="${cy}" r="${radius - 28}"></circle>
            <circle class="radial-stat-track" cx="${cx}" cy="${cy}" r="${radius}"></circle>
            <circle
              class="radial-stat-arc"
              cx="${cx}"
              cy="${cy}"
              r="${radius}"
              stroke="url(#${escapeHtml(gradientId)})"
              stroke-dasharray="${activeArc} ${gapArc}"
            ></circle>
            <text class="radial-stat-value" x="${cx}" y="${cy - 2}" text-anchor="middle">${escapeHtml(config?.valueText || "-")}</text>
            <text class="radial-stat-caption" x="${cx}" y="${cy + 24}" text-anchor="middle">${escapeHtml(config?.caption || "")}</text>
          </svg>
          <div class="radial-stat-badge">${escapeHtml(config?.badge || "")}</div>
        </div>
        <div class="radial-stat-meta">
          ${rows
            .map(
              (row, index) => `
                <div class="radial-stat-row" style="--item-index:${index}">
                  <span class="radial-stat-dot"></span>
                  <div>
                    <span class="radial-stat-label">${escapeHtml(row?.label || "")}</span>
                    <span class="radial-stat-text">${escapeHtml(row?.value || "-")}</span>
                    <span class="radial-stat-note">${escapeHtml(row?.note || "")}</span>
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      </div>
    `;
    if (animate) {
      primeSvgMotion(container, {
        drawSelectors: [],
        arcSelectors: [".radial-stat-arc"],
      });
    }
  }

  function buildMilestoneTarget(totalUsers) {
    const total = clampNumber(totalUsers, 0, 1000000000);
    if (total < 50) return 50;
    if (total < 100) return 100;
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(total, 1)));
    const step = total / magnitude < 3 ? magnitude / 2 : magnitude;
    let target = Math.ceil(total / step) * step;
    if (target <= total) target += step;
    return clampNumber(target, 1, 1000000000);
  }

  function formatMetricNumber(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "-";
    const decimals = Math.abs(numeric - Math.round(numeric)) < 0.05 ? 0 : 1;
    return formatNumber(numeric, decimals);
  }

  function renderLineChart(series, unitLabel, animate = false) {
    if (!series.length) {
      setChartAnimationState(refs.dailyChart, false);
      refs.dailyChart.innerHTML = `<p class="empty-note">No chart data.</p>`;
      return;
    }
    setChartAnimationState(refs.dailyChart, animate);
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
        <circle class="chart-point ${idx === peakIndex ? "is-peak" : ""} ${idx === latestIndex ? "is-latest" : ""}" style="--item-index:${idx}" cx="${point.x}" cy="${point.y}" r="${
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
    if (animate) {
      primeSvgMotion(refs.dailyChart, {
        drawSelectors: [".line-path"],
        arcSelectors: [],
      });
    }
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

  function renderActiveBar(series, animate = false) {
    if (!refs.frequentUsersBar) return;
    if (!series.length) {
      setChartAnimationState(refs.frequentUsersBar, false);
      refs.frequentUsersBar.innerHTML = `<p class="empty-note">No chart data.</p>`;
      return;
    }
    setChartAnimationState(refs.frequentUsersBar, animate);
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
          <rect class="bar-rect" style="--item-index:${idx}" x="${x}" y="${y}" width="${barWidth}" height="${Math.max(barHeight, 0)}" rx="8" ry="8" tabindex="0" data-tooltip="${escapeHtml(
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
          <circle class="bar-trend-point ${idx === trendPoints.length - 1 ? "is-latest" : ""}" style="--item-index:${idx}" cx="${point.x}" cy="${point.y}" r="${
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
    if (animate) {
      primeSvgMotion(refs.frequentUsersBar, {
        drawSelectors: [],
        arcSelectors: [],
      });
    }
    bindChartPointTooltips(refs.frequentUsersBar, ".bar-rect, .bar-trend-point");
  }

  function renderUsageMinutesChart(series, unitLabel, animate = false) {
    if (!refs.avgUsageChart) return;
    if (!series.length) {
      setChartAnimationState(refs.avgUsageChart, false);
      refs.avgUsageChart.innerHTML = `<p class="empty-note">No chart data.</p>`;
      return;
    }
    setChartAnimationState(refs.avgUsageChart, animate);
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
          <circle class="usage-chart-point ${idx === latestIndex ? "is-latest" : ""}" style="--item-index:${idx}" cx="${point.x}" cy="${point.y}" r="${
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
    if (animate) {
      primeSvgMotion(refs.avgUsageChart, {
        drawSelectors: [".usage-line-path"],
        arcSelectors: [],
      });
    }
    bindChartPointTooltips(refs.avgUsageChart, ".usage-chart-point");
  }

  function toSeries(days, field) {
    return days.map((day) => ({
      count: clampNumber(Number(day[field]) || 0, 0, 1000000000),
      shortLabel: formatCompactDate(day.dateMs),
      tooltipLabel: formatDateOnly(day.dateMs),
    }));
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

  function primeSvgMotion(containerEl, options = {}) {
    if (!containerEl || prefersReducedMotion()) return;

    const drawSelectors = Array.isArray(options.drawSelectors) ? options.drawSelectors : [];
    drawSelectors.forEach((selector, groupIndex) => {
      const pathEls = containerEl.querySelectorAll(selector);
      pathEls.forEach((pathEl, itemIndex) => {
        if (typeof pathEl.getTotalLength !== "function") return;
        try {
          const pathLength = Math.max(1, Math.ceil(pathEl.getTotalLength()));
          pathEl.style.setProperty("--path-length", String(pathLength));
          pathEl.style.setProperty("--path-delay", `${120 + groupIndex * 120 + itemIndex * 40}ms`);
          pathEl.classList.add("is-path-animated");
        } catch (_error) {}
      });
    });

    const arcSelectors = Array.isArray(options.arcSelectors) ? options.arcSelectors : [];
    arcSelectors.forEach((selector, groupIndex) => {
      const arcEls = containerEl.querySelectorAll(selector);
      arcEls.forEach((arcEl, itemIndex) => {
        const dashValues = String(arcEl.getAttribute("stroke-dasharray") || "")
          .split(/[\s,]+/)
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value));
        if (!dashValues.length) return;
        const totalLength = dashValues.reduce((sum, value) => sum + value, 0);
        const targetOffset = Number(arcEl.getAttribute("stroke-dashoffset") || 0);
        arcEl.style.setProperty("--arc-start", String(targetOffset + totalLength));
        arcEl.style.setProperty("--arc-end", String(targetOffset));
        arcEl.style.setProperty("--arc-delay", `${160 + groupIndex * 120 + itemIndex * 90}ms`);
        arcEl.classList.add("is-arc-animated");
      });
    });
  }

  function prefersReducedMotion() {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function setChartAnimationState(containerEl, shouldAnimate) {
    if (!containerEl) return;
    containerEl.classList.add("chart-motion-host");
    containerEl.classList.toggle("chart-animating", Boolean(shouldAnimate) && !prefersReducedMotion());
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

  function createGpuTrafficState() {
    return {
      rafId: 0,
      canvas: null,
      ctx: null,
      width: 0,
      height: 0,
      dpr: 1,
      sampleGap: 22,
      stepMs: 680,
      scrollOffset: 0,
      lastFrameAt: 0,
      metricsUpdatedAt: 0,
      series: [],
    };
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
