
    const C_CHART = '#6366f1';
    const C_TEAL = '#14b8a6';
    const ST_COLORS = { YEST: '#6B7280' };
    const TL_COLORS = { RUN: C_TEAL, STOP: '#fbbf24', ALARM: '#ef4444', ONLINE: '#38bdf8', OFFLINE: '#6b7280', NO_DATA: '#374151', OFF: '#2C2C2E' };
    const CHART_DATA = {};
    const STRIP_LABEL_GUTTER = 36;
    const STRIP_RIGHT_GUTTER = 24;
    const STATUS_STRIP_HEIGHT = 15;
    const STATUS_STRIP_GAP = 3;
    const STATUS_AXIS_HEIGHT = 18;
    const ALARM_LOSS_DENOMINATOR_SEC = 21.5 * 3600;
    const HISTORY_SUMMARY_TTL_MS = 60000;
    const HISTORY_PERIODS = [
      { key: 'today', label: '금일' },
      { key: 'yesterday', label: '전일' },
      { key: 'week', label: '주간' },
      { key: 'month', label: '월간' }
    ];
    let DAY_START_HOUR = 8;
    let LINES = [];
    let HISTORY_MODAL_STATE = { mode: 'production', period: 'today', data: null };
    let ALARM_DAY_DETAIL_CACHE = {};
    let HISTORY_SUMMARY_CACHE = {};

    document.addEventListener('DOMContentLoaded', async () => {
      startClock();
      await loadDashboard();
      setInterval(loadDashboard, 2000);
    });

    function getDonutSvg(id) {
      return `<svg class="donut-chart" viewBox="0 0 100 100"><circle class="donut-bg" cx="50" cy="50" r="40"></circle><circle class="donut-fill" id="donut-${id}" cx="50" cy="50" r="40" stroke="${C_CHART}" stroke-dasharray="251.3" stroke-dashoffset="251.3"></circle></svg>`;
    }

    function normalizeHourlyArray(values) {
      const src = Array.isArray(values) ? values : [];
      return Array.from({ length: 24 }, (_, idx) => Number(src[(DAY_START_HOUR + idx) % 24] || 0));
    }

    function slotLabel(hourIndex) {
      return `${String((DAY_START_HOUR + hourIndex) % 24).padStart(2, '0')}:00`;
    }

    function currentProductionDaySeconds() {
      const now = new Date();
      const start = new Date(now);
      start.setHours(DAY_START_HOUR, 0, 0, 0);
      if (now < start) start.setDate(start.getDate() - 1);
      return Math.max(0, Math.min(86399, Math.floor((now.getTime() - start.getTime()) / 1000)));
    }

    function currentAsOfLabel() {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      return `현재 시간 기준 ${hh}:${mm}:${ss}`;
    }

    function formatProdSecond(seconds) {
      const totalMinutes = Math.floor(Math.max(0, Math.min(86400, Number(seconds || 0))) / 60);
      const hour = (DAY_START_HOUR + Math.floor(totalMinutes / 60)) % 24;
      const minute = totalMinutes % 60;
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }

    function statusNameKo(status) {
      if (status === 'RUN' || status === 'ONLINE') return '가동';
      if (status === 'STOP') return '비가동';
      if (status === 'ALARM') return '알람';
      if (status === 'OFFLINE' || status === 'NO_DATA') return '오프라인';
      return status || '-';
    }

    function statusColor(status) {
      if (status === 'RUN' || status === 'ONLINE') return TL_COLORS.RUN;
      if (status === 'STOP') return TL_COLORS.STOP;
      if (status === 'ALARM') return TL_COLORS.ALARM;
      if (status === 'OFFLINE' || status === 'NO_DATA') return TL_COLORS.OFFLINE;
      return '#fff';
    }

    function findTimelineBlock(blocks, seconds) {
      const sec = Math.max(0, Math.min(86399, Number(seconds || 0)));
      return (blocks || []).find(block => sec >= Number(block.startSec || 0) && sec < Number(block.startSec || 0) + Number(block.duration || 0)) || null;
    }

    function latestDataSecond(blocks) {
      const realBlocks = (blocks || []).filter(block => block.status !== 'NO_DATA');
      if (!realBlocks.length) return currentProductionDaySeconds();
      return Math.max(...realBlocks.map(block => {
        const start = Number(block.startSec || 0);
        const duration = Number(block.duration || 0);
        return Math.min(86400, start + duration);
      }));
    }

    function isNoDataSlot(blocks, hourIndex) {
      const startSec = hourIndex * 3600;
      const endSec = startSec + 3600;
      const relevant = (blocks || []).filter(block => {
        const blockStart = Number(block.startSec || 0);
        const blockEnd = blockStart + Number(block.duration || 0);
        return blockEnd > startSec && blockStart < endSec;
      });
      if (!relevant.length) return true;
      return relevant.every(block => block.status === 'NO_DATA');
    }

    function buildPlotSeries(values, timeline, isToday) {
      const nowSec = isToday ? latestDataSecond(timeline) : 86400;
      return Array.from({ length: 24 }, (_, idx) => {
        const slotStart = idx * 3600;
        if (isToday && slotStart > nowSec) return null;
        if (isNoDataSlot(timeline, idx)) return null;
        return Number(values[idx] || 0);
      });
    }

    function lastValidPoint(series, pointFactory) {
      for (let i = series.length - 1; i >= 0; i--) {
        if (series[i] !== null && series[i] !== undefined) return { index: i, value: Number(series[i]), point: pointFactory(i, Number(series[i])) };
      }
      return null;
    }

    function roundedRectPath(ctx, x, y, width, height, radius) {
      const r = Math.min(radius, width / 2, height / 2);
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
    }

    function renderPanels(lines) {
      const grid = document.getElementById('dashboardGrid');
      grid.innerHTML = lines.map(line => `
        <div id="panel-${line.id}" class="dashboard-card">
          <div class="panel-header">
            <div class="panel-title-wrap">
              <div class="panel-title-row">
                <h2 class="panel-title">${line.name}</h2>
              </div>
              <div class="panel-meta-row">
                <span class="panel-model-label">MODEL</span>
                <span class="panel-model-value" data-ref="ctx-model">-</span>
              </div>
            </div>
            <div class="status-inline" data-ref="ctx-panel"><span class="status-inline-label">STATUS</span><span class="status-inline-value" data-ref="ctx-status">-</span></div>
          </div>
          <div class="kpi-section">
            <div class="kpi-section-head">
              <div class="kpi-section-title-wrap"><span class="kpi-section-title">주요 KPI</span></div>
              <span class="kpi-section-time" data-ref="cmp-shared-time">현재 시간 기준</span>
            </div>
            <div class="kpi-row">
            <div class="kpi-card">
              <div class="compare-head"><span class="kpi-label">생산 수량</span></div>
              <div class="compare-main"><span class="compare-main-value" data-ref="cmp-production-today">0</span><span class="compare-main-unit">EA</span></div>
              <div class="compare-delta-list">
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">전일</span><span class="compare-delta-meta" data-ref="cmp-production-yesterday">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-production-delta-yesterday">-</span></div>
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">주간</span><span class="compare-delta-meta" data-ref="cmp-production-week">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-production-delta-week">-</span></div>
              </div>
            </div>
            <div class="kpi-card">
              <div class="compare-head"><span class="kpi-link" role="button" tabindex="0" onclick="openYieldHistory(${line.id})" onkeydown="handleKpiLinkKey(event, () => openYieldHistory(${line.id}))"><span class="kpi-label">직행률</span><span class="kpi-link-badge">OK/NG</span></span></div>
              <div class="compare-main"><span class="compare-main-group"><span class="compare-main-value" data-ref="cmp-direct-yield-today">-</span><span class="compare-main-unit">%</span></span></div>
              <div class="compare-delta-list">
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">전일</span><span class="compare-delta-meta" data-ref="cmp-direct-yield-yesterday">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-direct-yield-delta-yesterday">-</span></div>
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">주간</span><span class="compare-delta-meta" data-ref="cmp-direct-yield-week">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-direct-yield-delta-week">-</span></div>
              </div>
            </div>
            <div class="kpi-card">
              <div class="compare-head"><span class="kpi-label">가동률</span></div>
              <div class="compare-main"><span class="compare-main-value" data-ref="cmp-run-today">0</span><span class="compare-main-unit">%</span></div>
              <div class="compare-delta-list">
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">전일</span><span class="compare-delta-meta" data-ref="cmp-run-yesterday">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-run-delta-yesterday">-</span></div>
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">주간</span><span class="compare-delta-meta" data-ref="cmp-run-week">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-run-delta-week">-</span></div>
              </div>
            </div>
            <div class="kpi-card">
              <div class="compare-head"><span class="kpi-label">MTTR</span></div>
              <div class="compare-main"><span class="compare-main-value" data-ref="cmp-mttr-today">-</span><span class="compare-main-unit">hr</span></div>
              <div class="compare-delta-list">
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">전일</span><span class="compare-delta-meta" data-ref="cmp-mttr-yesterday">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-mttr-delta-yesterday">-</span></div>
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">주간</span><span class="compare-delta-meta" data-ref="cmp-mttr-week">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-mttr-delta-week">-</span></div>
              </div>
            </div>
            <div class="kpi-card">
              <div class="compare-head"><span class="kpi-label">MTBF</span></div>
              <div class="compare-main"><span class="compare-main-value" data-ref="cmp-mtbf-today">-</span><span class="compare-main-unit">hr</span></div>
              <div class="compare-delta-list">
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">전일</span><span class="compare-delta-meta" data-ref="cmp-mtbf-yesterday">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-mtbf-delta-yesterday">-</span></div>
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">주간</span><span class="compare-delta-meta" data-ref="cmp-mtbf-week">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-mtbf-delta-week">-</span></div>
              </div>
            </div>
            <div class="kpi-card">
              <div class="compare-head"><span class="kpi-label">고장 손실률</span></div>
              <div class="compare-main"><span class="compare-main-value" data-ref="cmp-alarm-today">0</span><span class="compare-main-unit">%</span></div>
              <div class="compare-delta-list">
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">전일</span><span class="compare-delta-meta" data-ref="cmp-alarm-yesterday">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-alarm-delta-yesterday">-</span></div>
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">주간</span><span class="compare-delta-meta" data-ref="cmp-alarm-week">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-alarm-delta-week">-</span></div>
              </div>
            </div>
            </div>
          </div>
          <div class="middle-section">
            <div class="list-section"><div class="list-header header-alarm"><div class="kpi-section-title-wrap title-wrap-alarm"><span class="kpi-section-title">실시간 알람 현황</span></div><button onclick="openAlarmHistory(${line.id})" class="history-button">Alarm History</button></div><ul class="list-body space-y-0" data-ref="alarm-list"><li class="list-item justify-center text-[#5E6673] border-none">알람 이력이 없습니다</li></ul></div>
          </div>
          <div class="chart-section">
            <div class="chart-header-bar"><div class="kpi-section-title-wrap title-wrap-chart"><span class="chart-title">시간대별 생산현황</span></div><div class="flex items-center gap-3"><div class="legend-box"><div class="legend-item"><div class="legend-line-dash"></div>전일</div><div class="legend-item"><div class="legend-line" style="background:var(--c-chart)"></div>금일</div></div><button onclick="openProductionHistory(${line.id})" class="history-button">Production History</button></div></div>
            <div class="chart-wrapper group" id="wrapper-${line.id}"><canvas id="canvas-main-${line.id}"></canvas><div class="time-marker now-marker" data-ref="now-marker"><span class="time-marker-label">NOW</span></div><div class="time-marker hover-marker" data-ref="hover-marker"><span class="time-marker-label" data-ref="hover-time">--:--</span></div><span class="strip-label" data-strip-label="yesterday">전일</span><span class="strip-label" data-strip-label="today" style="color: var(--c-timeline);">금일</span><div class="chart-tooltip" id="tooltip-${line.id}"><div class="tooltip-time">00:00</div><div class="tooltip-row"><span class="val-label">어제</span><span class="val-yest">0</span></div><div class="tooltip-row"><span class="val-label">오늘</span><span class="val-today">0</span></div><div class="tooltip-row border-t border-[#3A3A3C] pt-1 mt-1"><span class="val-label">Avg C/T</span><span class="val-ct">-</span></div></div></div>
          </div>
        </div>`).join('');
      lines.forEach(line => setupInteractions(line.id));
    }

    function getStatusStyle(label) {
      if (label === 'ALARM') return { textClass: 'tx-alarm', accentClass: 'accent-alarm' };
      if (label === 'RUN') return { textClass: 'tx-run', accentClass: 'accent-run' };
      if (label === 'STOP') return { textClass: 'tx-stop', accentClass: 'accent-stop' };
      if (label === 'ONLINE') return { textClass: 'tx-online', accentClass: 'accent-online' };
      return { textClass: 'tx-offline', accentClass: 'accent-offline' };
    }

    function formatCompareValue(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (unit === 'ea') return numeric.toLocaleString();
      if (unit === 'min') return numeric.toLocaleString();
      if (unit === 'pct') return numeric.toFixed(1);
      return numeric.toLocaleString();
    }

    function formatCompareDelta(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (unit === 'ea') return `${Math.abs(numeric).toLocaleString()}`;
      if (unit === 'min') return `${Math.abs(numeric).toLocaleString()}분`;
      if (unit === 'pct') return `${Math.abs(numeric).toFixed(1)}`;
      return `${Math.abs(numeric).toLocaleString()}`;
    }

    function formatCompareRowValue(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      if (unit === 'pct') return `${Number(value).toFixed(1)}%`;
      return Number(value).toLocaleString();
    }

    function formatCompareRowDelta(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (unit === 'pct') return `${Math.abs(numeric).toFixed(1)}`;
      return `${Math.abs(numeric).toLocaleString()}`;
    }

    function formatCompareValue(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (unit === 'ea') return numeric.toLocaleString();
      if (unit === 'hour') return (numeric / 60).toFixed(2);
      if (unit === 'min') return numeric.toLocaleString();
      if (unit === 'pct') return numeric.toFixed(1);
      return numeric.toLocaleString();
    }

    function formatCompareDelta(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (unit === 'ea') return `${Math.abs(numeric).toLocaleString()}`;
      if (unit === 'hour') return `${(Math.abs(numeric) / 60).toFixed(2)} hr`;
      if (unit === 'min') return `${Math.abs(numeric).toLocaleString()}분`;
      if (unit === 'pct') return `${Math.abs(numeric).toFixed(1)}`;
      return `${Math.abs(numeric).toLocaleString()}`;
    }

    function formatCompareRowValue(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      if (unit === 'pct') return `${Number(value).toFixed(1)}%`;
      if (unit === 'hour') return `${(Number(value) / 60).toFixed(2)} hr`;
      return Number(value).toLocaleString();
    }

    function formatCompareRowDelta(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (unit === 'pct') return `${Math.abs(numeric).toFixed(1)}`;
      if (unit === 'hour') return `${(Math.abs(numeric) / 60).toFixed(2)}`;
      return `${Math.abs(numeric).toLocaleString()}`;
    }

    function deltaArrow(value, betterWhenLower = false) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (numeric === 0) return '=';
      if (betterWhenLower) return numeric < 0 ? '↑' : '↓';
      return numeric > 0 ? '↑' : '↓';
    }

    function getDeltaClass(value, betterWhenLower = false) {
      if (value === null || value === undefined || Number(value) === 0) return 'delta-neutral';
      const numeric = Number(value);
      const good = betterWhenLower ? numeric < 0 : numeric > 0;
      return good ? 'delta-good' : 'delta-bad';
    }

    function updateCompareMetric(panelEl, key, metric, unit, betterWhenLower = false) {
      panelEl.querySelector(`[data-ref="cmp-${key}-today"]`).textContent = formatCompareValue(metric.today, unit);
      panelEl.querySelector(`[data-ref="cmp-${key}-yesterday"]`).textContent = formatCompareRowValue(metric.yesterday, unit);
      panelEl.querySelector(`[data-ref="cmp-${key}-week"]`).textContent = formatCompareRowValue(metric.week, unit);

      const yestEl = panelEl.querySelector(`[data-ref="cmp-${key}-delta-yesterday"]`);
      yestEl.textContent = `${deltaArrow(metric.deltaYesterday, betterWhenLower)} ${formatCompareRowDelta(metric.deltaYesterday, unit)}`;
      yestEl.className = `compare-delta-value ${getDeltaClass(metric.deltaYesterday, betterWhenLower)}`;

      const weekEl = panelEl.querySelector(`[data-ref="cmp-${key}-delta-week"]`);
      weekEl.textContent = `${deltaArrow(metric.deltaWeek, betterWhenLower)} ${formatCompareRowDelta(metric.deltaWeek, unit)}`;
      weekEl.className = `compare-delta-value ${getDeltaClass(metric.deltaWeek, betterWhenLower)}`;
    }

    function toRate(minutes, elapsedMinutes) {
      const elapsed = Number(elapsedMinutes || 0);
      const value = Number(minutes || 0);
      if (!elapsed || Number.isNaN(elapsed) || Number.isNaN(value)) return null;
      return (value / elapsed) * 100;
    }

    function alarmLossRate(durationSec, dayCount = 1) {
      const denominator = ALARM_LOSS_DENOMINATOR_SEC * Math.max(1, Number(dayCount || 1));
      if (!denominator) return null;
      return (Number(durationSec || 0) / denominator) * 100;
    }

    function buildAlarmLossSummary(historyData) {
      if (!historyData) return null;
      const todayDuration = (historyData.today?.alarm_groups || []).reduce((sum, item) => sum + Number(item.duration_sec || 0), 0);
      const yesterdayDuration = (historyData.yesterday?.alarm_groups || []).reduce((sum, item) => sum + Number(item.duration_sec || 0), 0);
      const weekDailyStats = historyData.week?.alarm_daily_stats || [];
      const weekDailyMetrics = historyData.week?.daily_metrics || [];
      const weekDayCount = countActiveDaysFromDailyStats(weekDailyMetrics, weekDailyStats);
      const weekTotalDuration = weekDailyStats.reduce((sum, item) => sum + Number(item.duration_sec || 0), 0);
      return {
        today: alarmLossRate(todayDuration, 1),
        yesterday: alarmLossRate(yesterdayDuration, 1),
        week: alarmLossRate(weekTotalDuration, weekDayCount)
      };
    }

    async function ensureHistorySummary(lineId) {
      const cache = HISTORY_SUMMARY_CACHE[lineId];
      const now = Date.now();
      if (cache?.data && now - Number(cache.fetchedAt || 0) < HISTORY_SUMMARY_TTL_MS) return cache.data;
      if (cache?.pending) return cache.pending;
      const pending = fetch(`/api/history/${lineId}`, { cache: 'no-store' })
        .then(response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then(historyData => {
          const summary = buildAlarmLossSummary(historyData);
          HISTORY_SUMMARY_CACHE[lineId] = { fetchedAt: Date.now(), data: summary, pending: null };
          return summary;
        })
        .catch(error => {
          console.error(`History summary fetch failed for line ${lineId}`, error);
          HISTORY_SUMMARY_CACHE[lineId] = { fetchedAt: 0, data: cache?.data || null, pending: null };
          return cache?.data || null;
        });
      HISTORY_SUMMARY_CACHE[lineId] = { fetchedAt: Number(cache?.fetchedAt || 0), data: cache?.data || null, pending };
      return pending;
    }

    function updateComparisonCards(panelEl, data, historySummary = null) {
      const comparisons = data.comparisons || {};
      const asOf = comparisons.as_of || null;
      panelEl.querySelector('[data-ref="cmp-shared-time"]').textContent = currentAsOfLabel();
      const mttrUnitEl = panelEl.querySelector('[data-ref="cmp-mttr-today"]')?.nextElementSibling;
      const mtbfUnitEl = panelEl.querySelector('[data-ref="cmp-mtbf-today"]')?.nextElementSibling;
      if (mttrUnitEl) mttrUnitEl.textContent = 'hr';
      if (mtbfUnitEl) mtbfUnitEl.textContent = 'hr';
      const today = comparisons.today || {};
      const yesterday = comparisons.yesterday || {};
      const weekAvg = comparisons.week_avg || {};
      const deltaYesterday = comparisons.delta_vs_yesterday || {};
      const deltaWeek = comparisons.delta_vs_week_avg || {};
      const elapsedMinutes = Number(comparisons.elapsed_minutes || 0);

      const runTodayRate = toRate(today.run_minutes, elapsedMinutes);
      const runYesterdayRate = toRate(yesterday.run_minutes, elapsedMinutes);
      const runWeekRate = toRate(weekAvg.run_minutes, elapsedMinutes);
      const alarmTodayRate = toRate(today.alarm_minutes, elapsedMinutes);
      const alarmYesterdayRate = toRate(yesterday.alarm_minutes, elapsedMinutes);
      const alarmWeekRate = toRate(weekAvg.alarm_minutes, elapsedMinutes);

      updateCompareMetric(panelEl, 'production', {
        as_of: asOf,
        today: today.production,
        yesterday: yesterday.production,
        week: weekAvg.production,
        deltaYesterday: deltaYesterday.production,
        deltaWeek: deltaWeek.production
      }, 'ea');
      updateCompareMetric(panelEl, 'run', {
        as_of: asOf,
        today: runTodayRate,
        yesterday: runYesterdayRate,
        week: runWeekRate,
        deltaYesterday: runTodayRate === null || runYesterdayRate === null ? null : runTodayRate - runYesterdayRate,
        deltaWeek: runTodayRate === null || runWeekRate === null ? null : runTodayRate - runWeekRate
      }, 'pct');
      updateCompareMetric(panelEl, 'alarm', {
        as_of: asOf,
        today: historySummary?.today ?? alarmTodayRate,
        yesterday: historySummary?.yesterday ?? alarmYesterdayRate,
        week: historySummary?.week ?? alarmWeekRate,
        deltaYesterday: (historySummary?.today ?? alarmTodayRate) === null || (historySummary?.yesterday ?? alarmYesterdayRate) === null ? null : (historySummary?.today ?? alarmTodayRate) - (historySummary?.yesterday ?? alarmYesterdayRate),
        deltaWeek: (historySummary?.today ?? alarmTodayRate) === null || (historySummary?.week ?? alarmWeekRate) === null ? null : (historySummary?.today ?? alarmTodayRate) - (historySummary?.week ?? alarmWeekRate)
      }, 'pct', true);
      updateCompareMetric(panelEl, 'mttr', {
        today: today.mttr_min,
        yesterday: yesterday.mttr_min,
        week: weekAvg.mttr_min,
        deltaYesterday: deltaYesterday.mttr_min,
        deltaWeek: deltaWeek.mttr_min
      }, 'hour', true);
      updateCompareMetric(panelEl, 'mtbf', {
        today: today.mtbf_min,
        yesterday: yesterday.mtbf_min,
        week: weekAvg.mtbf_min,
        deltaYesterday: deltaYesterday.mtbf_min,
        deltaWeek: deltaWeek.mtbf_min
      }, 'hour');
      updateCompareMetric(panelEl, 'direct-yield', {
        today: today.direct_yield,
        yesterday: yesterday.direct_yield,
        week: weekAvg.direct_yield,
        deltaYesterday: deltaYesterday.direct_yield,
        deltaWeek: deltaWeek.direct_yield
      }, 'pct');
    }

    function updatePanel(id, data) {
      CHART_DATA[id] = {
        yest: normalizeHourlyArray(data.hourly_yesterday || []),
        today: normalizeHourlyArray(data.hourly_today || []),
        run_mins: normalizeHourlyArray(data.hourly_run_mins || []),
        timeline_yesterday: data.timeline_yesterday || [],
        timeline_today: data.timeline_today || []
      };
      const el = document.getElementById(`panel-${id}`);
      if (!el) return;
      const style = getStatusStyle(data.status.label);
      const ctxPanel = el.querySelector('[data-ref="ctx-panel"]');
      const ctxStatus = el.querySelector('[data-ref="ctx-status"]');
      ctxStatus.textContent = data.status.label;
      ctxStatus.className = `status-inline-value ${style.textClass}`;
      ctxPanel.className = `status-inline ctx-status-panel ${style.accentClass}`;
      el.classList.remove('card-accent-run', 'card-accent-stop', 'card-accent-alarm', 'card-accent-online', 'card-accent-offline');
      if (data.status.label === 'ALARM') el.classList.add('card-accent-alarm');
      else if (data.status.label === 'RUN') el.classList.add('card-accent-run');
      else if (data.status.label === 'STOP') el.classList.add('card-accent-stop');
      else if (data.status.label === 'ONLINE') el.classList.add('card-accent-online');
      else el.classList.add('card-accent-offline');
      el.querySelector('[data-ref="ctx-model"]').textContent = data.model || '-';
      updateComparisonCards(el, data, HISTORY_SUMMARY_CACHE[id]?.data || null);
      ensureHistorySummary(id).then(summary => {
        const panel = document.getElementById(`panel-${id}`);
        if (panel) updateComparisonCards(panel, data, summary);
      });
      renderAlarmList(el, data.active_alarms || []);
      drawCombinedChart(id, CHART_DATA[id].yest, CHART_DATA[id].today, data.timeline_yesterday || [], data.timeline_today || []);
    }

    function renderAlarmList(panelEl, alarms) {
      const listEl = panelEl.querySelector('[data-ref="alarm-list"]');
      if (!listEl) return;
      if (!alarms.length) {
        listEl.innerHTML = '<li class="list-item justify-center text-[#5E6673] border-none">현재 활성 알람 없음</li>';
        return;
      }
      listEl.innerHTML = alarms.slice(0, 10).map(alarm => `
        <li class="list-item alarm-item">
          <span class="alarm-name" title="${alarm.label || '-'}">${alarm.label || '-'}</span>
          <span class="alarm-meta-group">
            <span class="alarm-meta"><span class="alarm-meta-label">발생</span><span class="alarm-meta-value">${formatTimeOnly(alarm.started_at)}</span></span>
            <span class="alarm-meta"><span class="alarm-meta-label">寃쎄낵</span><span class="alarm-meta-value">${formatElapsedSince(alarm.started_at)}</span></span>
          </span>
        </li>
      `).join('');
    }

    async function loadDashboard() {
      try {
        const response = await fetch('/api/dashboard', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        DAY_START_HOUR = Number(payload.day_start_hour || 8);
        if (!LINES.length) {
          LINES = payload.lines.map(line => ({ id: line.id, name: line.name, cycle_time_sec: line.cycle_time_sec }));
          renderPanels(LINES);
        }
        payload.lines.forEach(line => {
          try {
            updatePanel(line.id, line);
          } catch (lineError) {
            console.error(`Line render failed: ${line.name || line.id}`, lineError);
          }
        });
        const serverStateEl = document.getElementById('serverState');
        serverStateEl.textContent = 'ONLINE';
        serverStateEl.className = 'header-status header-status-online';
      } catch (error) {
        const serverStateEl = document.getElementById('serverState');
        serverStateEl.textContent = 'OFFLINE';
        serverStateEl.className = 'header-status header-status-offline';
      }
    }

    function startClock() {
      const render = () => {
        document.querySelectorAll('[data-ref="cmp-shared-time"]').forEach(el => {
          el.textContent = currentAsOfLabel();
        });
      };
      render();
      setInterval(render, 1000);
    }

    async function openAlarmHistory(id) {
      const modal = document.getElementById('historyModal');
      const body = document.getElementById('modalBody');
      modal.classList.add('open');
      body.textContent = 'Loading...';
      try {
        const response = await fetch(`/api/history/${id}`, { cache: 'no-store' });
        const data = await response.json();
        HISTORY_MODAL_STATE = { mode: 'alarm', period: 'today', data };
        renderHistoryModal();
      } catch (error) {
        body.innerHTML = `<div class="muted">?대젰 議고쉶 ?ㅽ뙣: ${error.message}</div>`;
      }
    }

    async function loadAlarmDayGroups(lineId, day) {
      const response = await fetch(`/api/history/${lineId}/alarms/${encodeURIComponent(day)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      return payload.alarm_groups || [];
    }

    async function openProductionHistory(id) {
      const modal = document.getElementById('historyModal');
      const body = document.getElementById('modalBody');
      modal.classList.add('open');
      body.textContent = 'Loading...';
      try {
        const response = await fetch(`/api/history/${id}`, { cache: 'no-store' });
        const data = await response.json();
        HISTORY_MODAL_STATE = { mode: 'production', period: 'today', data };
        renderHistoryModal();
      } catch (error) {
        body.innerHTML = `<div class="muted">?대젰 議고쉶 ?ㅽ뙣: ${error.message}</div>`;
      }
    }

    async function openYieldHistory(id) {
      const modal = document.getElementById('historyModal');
      const body = document.getElementById('modalBody');
      modal.classList.add('open');
      body.textContent = 'Loading...';
      try {
        const response = await fetch(`/api/history/${id}`, { cache: 'no-store' });
        const data = await response.json();
        HISTORY_MODAL_STATE = { mode: 'yield', period: 'today', data };
        renderHistoryModal();
      } catch (error) {
        body.innerHTML = `<div class="muted">History fetch failed: ${error.message}</div>`;
      }
    }

    function handleKpiLinkKey(event, action) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        action();
      }
    }

    function renderHistoryModal() {
      const { mode, period, data } = HISTORY_MODAL_STATE;
      if (!data) return;
      ALARM_DAY_DETAIL_CACHE = {};
      document.getElementById('modalTitle').textContent = mode === 'alarm' ? `${data.line_name} 알람 이력` : `${data.line_name} 생산 / 가동 이력`;
      const tabs = HISTORY_PERIODS.map(item => `
        <button class="history-tab ${item.key === period ? 'active' : ''}" onclick="setHistoryPeriod('${item.key}')">${item.label}</button>
      `).join('');
      if (mode === 'yield') {
        document.getElementById('modalTitle').textContent = `${data.line_name} OK / NG History`;
      }
      const content = mode === 'alarm' ? renderAlarmPeriodContent(period, data) : (mode === 'yield' ? renderYieldPeriodContent(period, data) : renderProductionPeriodContent(period, data));
      document.getElementById('modalBody').innerHTML = `<div class="history-tabs">${tabs}</div>${content}`;
    }

    function setHistoryPeriod(period) {
      HISTORY_MODAL_STATE.period = period;
      renderHistoryModal();
    }

    function renderProductionHistoryBlock(title, block) {
      const rows = buildProductionHourlyRows(block);
      return `<div class="mb-8">
        <h4 class="period-title">${block.day_key}</h4>
        ${renderProductionSummary(rows)}
        <div class="section-title">생산 이력</div>
        <table class="history-table mb-4">
          <thead><tr><th>시간</th><th>생산 수량</th><th>OK</th><th>NG</th><th>직행률</th><th>가동시간</th><th>가동률</th><th>비가동시간</th><th>알람시간</th><th>알람 발생수</th><th>평균 C/T</th></tr></thead>
          <tbody>${renderProductionRows(rows, 'slot')}</tbody>
        </table>
      </div>`;
    }

    function renderProductionRangeBlock(title, block) {
      const rows = buildProductionDailyRows(block);
      return `<div class="mb-8">
        <h4 class="period-title">${block.start_day_key} ~ ${block.end_day_key}</h4>
        <div class="section-title">생산 이력</div>
        <table class="history-table mb-4">
          <thead><tr><th>날짜</th><th>생산 수량</th><th>OK</th><th>NG</th><th>직행률</th><th>가동시간</th><th>가동률</th><th>비가동시간</th><th>알람시간</th><th>알람 발생수</th><th>평균 C/T</th></tr></thead>
          <tbody>${renderProductionRows(rows, 'day')}</tbody>
        </table>
      </div>`;
    }

    function buildProductionHourlyRows(block) {
      const counts = normalizeHourlyArray(block.hourly_counts || []);
      const okCounts = normalizeHourlyArray(block.hourly_ok_counts || []);
      const ngCounts = normalizeHourlyArray(block.hourly_ng_counts || []);
      const timelineStats = hourlyTimelineStats(block.timeline || []);
      const alarmCounts = hourlyAlarmCounts(block.day_key, block.alarm_groups || []);
      return counts.map((count, hour) => {
        const runSec = Number(timelineStats[hour]?.run_sec || 0);
        const stopSec = Number(timelineStats[hour]?.stop_sec || 0);
        const alarmSec = Number(timelineStats[hour]?.alarm_sec || 0);
        const okCount = Number(okCounts[hour] || 0);
        const ngCount = Number(ngCounts[hour] || 0);
        return {
          key: slotLabel(hour),
          total_count: Number(count || 0),
          ok_count: okCount,
          ng_count: ngCount,
          run_seconds: runSec,
          stop_seconds: stopSec,
          alarm_seconds: alarmSec,
          alarm_count: Number(alarmCounts[hour] || 0),
          avg_ct_sec: count > 0 && runSec > 0 ? runSec / count : null
        };
      });
    }

    function buildProductionDailyRows(block) {
      const metricsMap = new Map((block.daily_metrics || []).map(item => [item.day_key, item]));
      const statusMap = new Map((block.status_daily_stats || []).map(item => [item.day_key, item]));
      const alarmMap = new Map((block.alarm_daily_stats || []).map(item => [item.day_key, item]));
      const dayKeys = Array.from(new Set([
        ...metricsMap.keys(),
        ...statusMap.keys(),
        ...alarmMap.keys()
      ]));
      return dayKeys.map(dayKey => {
        const metrics = metricsMap.get(dayKey) || {};
        const status = statusMap.get(dayKey) || {};
        const alarm = alarmMap.get(dayKey) || {};
        const totalCount = Number(metrics.total_count || 0);
        const runSeconds = Number(status.run_seconds || 0);
        return {
          key: dayKey,
          total_count: totalCount,
          ok_count: metrics.ok_count === null || metrics.ok_count === undefined ? null : Number(metrics.ok_count),
          ng_count: metrics.ng_count === null || metrics.ng_count === undefined ? null : Number(metrics.ng_count),
          run_seconds: runSeconds,
          stop_seconds: Number(status.stop_seconds || 0),
          alarm_seconds: Number(status.alarm_seconds || 0),
          alarm_count: Number(alarm.count || 0),
          avg_ct_sec: totalCount > 0 && runSeconds > 0 ? runSeconds / totalCount : null
        };
      });
    }

    function calcUtilizationRate(runSeconds, stopSeconds, alarmSeconds) {
      const run = Number(runSeconds || 0);
      const stop = Number(stopSeconds || 0);
      const alarm = Number(alarmSeconds || 0);
      const total = run + stop + alarm;
      if (!total) return null;
      return (run / total) * 100;
    }

    function calcDirectYield(okCount, ngCount) {
      if (okCount === null || okCount === undefined || ngCount === null || ngCount === undefined) return null;
      const ok = Number(okCount || 0);
      const ng = Number(ngCount || 0);
      const total = ok + ng;
      if (!total) return null;
      return (ok / total) * 100;
    }

    function renderProductionRows(rows, keyType) {
      if (!rows.length) return `<tr><td colspan="11" class="muted">吏묎퀎 ?곗씠?곌? ?놁뒿?덈떎.</td></tr>`;
      return rows.map(item => `
        <tr>
          <td>${item.key}</td>
          <td>${Number(item.total_count || 0).toLocaleString()}</td>
          <td>${item.ok_count === null || item.ok_count === undefined ? '-' : Number(item.ok_count).toLocaleString()}</td>
          <td>${item.ng_count === null || item.ng_count === undefined ? '-' : Number(item.ng_count).toLocaleString()}</td>
          <td>${calcDirectYield(item.ok_count, item.ng_count)?.toFixed(1) ?? '-'}%</td>
          <td>${formatDuration(item.run_seconds)}</td>
          <td>${calcUtilizationRate(item.run_seconds, item.stop_seconds, item.alarm_seconds)?.toFixed(1) ?? '-'}%</td>
          <td>${formatDuration(item.stop_seconds)}</td>
          <td>${formatDuration(item.alarm_seconds)}</td>
          <td>${Number(item.alarm_count || 0).toLocaleString()}</td>
          <td>${item.avg_ct_sec ? `${item.avg_ct_sec.toFixed(1)}s` : '-'}</td>
        </tr>
      `).join('');
    }

    function renderProductionSummary(rows) {
      const totalCount = rows.reduce((sum, item) => sum + Number(item.total_count || 0), 0);
      const runSeconds = rows.reduce((sum, item) => sum + Number(item.run_seconds || 0), 0);
      const stopSeconds = rows.reduce((sum, item) => sum + Number(item.stop_seconds || 0), 0);
      const alarmSeconds = rows.reduce((sum, item) => sum + Number(item.alarm_seconds || 0), 0);
      const alarmCount = rows.reduce((sum, item) => sum + Number(item.alarm_count || 0), 0);
      const avgCt = totalCount > 0 && runSeconds > 0 ? runSeconds / totalCount : null;
      return `<div class="loss-summary">
        <div class="loss-card"><span class="loss-label">총 생산수량</span><span class="loss-value">${Number(totalCount).toLocaleString()}</span></div>
        <div class="loss-card"><span class="loss-label">총 가동시간</span><span class="loss-value">${formatDuration(runSeconds)}</span></div>
        <div class="loss-card"><span class="loss-label">총 비가동시간</span><span class="loss-value">${formatDuration(stopSeconds)}</span></div>
        <div class="loss-card"><span class="loss-label">총 알람시간</span><span class="loss-value">${formatDuration(alarmSeconds)}</span></div>
        <div class="loss-card"><span class="loss-label">총 알람 발생수</span><span class="loss-value">${Number(alarmCount).toLocaleString()}</span></div>
        <div class="loss-card"><span class="loss-label">평균 C/T</span><span class="loss-value">${avgCt ? `${avgCt.toFixed(1)}s` : '-'}</span></div>
      </div>`;
    }

    function hourlyTimelineStats(blocks) {
      const slots = Array.from({ length: 24 }, () => ({ run_sec: 0, stop_sec: 0, alarm_sec: 0 }));
      (blocks || []).forEach(block => {
        const status = String(block.status || '');
        if (!['RUN', 'STOP', 'ONLINE', 'OFFLINE', 'ALARM'].includes(status)) return;
        const start = Number(block.startSec || 0);
        const end = Math.min(86400, start + Number(block.duration || 0));
        for (let hour = 0; hour < 24; hour++) {
          const slotStart = hour * 3600;
          const slotEnd = slotStart + 3600;
          const overlap = Math.max(0, Math.min(end, slotEnd) - Math.max(start, slotStart));
          if (!overlap) continue;
          if (status === 'RUN') slots[hour].run_sec += overlap;
          else if (status === 'ALARM') slots[hour].alarm_sec += overlap;
          else slots[hour].stop_sec += overlap;
        }
      });
      return slots;
    }

    function hourlyAlarmCounts(dayKey, groups) {
      const counts = Array.from({ length: 24 }, () => 0);
      const base = Date.parse(`${dayKey}T${String(DAY_START_HOUR).padStart(2, '0')}:00:00`);
      if (!Number.isFinite(base)) return counts;
      (groups || []).forEach(group => {
        const started = Date.parse(String(group.started_at || ''));
        if (!Number.isFinite(started)) return;
        const diffSec = Math.floor((started - base) / 1000);
        if (diffSec < 0 || diffSec >= 86400) return;
        const hour = Math.floor(diffSec / 3600);
        counts[hour] += 1;
      });
      return counts;
    }

    function renderAlarmHistoryBlock(title, block) {
      const alarmGroups = normalizeAlarmGroups(block);
      const alarmSummaryRows = renderAlarmGroupSummaryRows(alarmGroups);
      const alarmEventRows = renderAlarmGroupRows(alarmGroups);
      return `<div class="mb-8">
        <h4 class="period-title">${block.day_key}</h4>
        ${renderLossSummary(alarmGroups, 1)}
        <div class="section-title">알람 이력</div>
        <table class="history-table mb-4">
          <thead><tr><th>발생 알람명</th><th>발생횟수</th><th>총 지속시간</th><th>가동 손실률</th></tr></thead>
          <tbody>${alarmSummaryRows}</tbody>
        </table>
        <div class="section-title">세부 내용</div>
        <table class="history-table">
          <thead><tr><th>발생 알람명</th><th>시작</th><th>해제</th><th>지속</th><th>발생횟수</th><th>상태</th></tr></thead>
          <tbody>${alarmEventRows}</tbody>
        </table>
      </div>`;
    }

    function renderAlarmRangeBlock(title, block) {
      const dailyStats = normalizeAlarmDailyStats(block);
      const dailyRows = renderAlarmGroupDailyRows(dailyStats, `${block.start_day_key}-${block.end_day_key}`);
      return `<div class="mb-8">
        <h4 class="period-title">${block.start_day_key} ~ ${block.end_day_key}</h4>
        ${renderLossSummaryFromDailyStats(dailyStats, countActiveDaysFromDailyStats(block.daily_metrics || [], dailyStats))}
        <div class="section-title">날짜별 알람 이력</div>
        <table class="history-table mb-4">
          <thead><tr><th>날짜</th><th>발생 수</th><th>지속시간</th><th>가동 손실률</th><th>세부</th></tr></thead>
          <tbody>${dailyRows}</tbody>
        </table>
      </div>`;
    }

    function renderAlarmGroupDailyRows(dayRows, idPrefix) {
      if (!dayRows.length) return `<tr><td colspan="5" class="muted">집계 데이터가 없습니다.</td></tr>`;
      return [...dayRows].reverse().map(item => {
        const day = item.day_key;
        const lossRate = ALARM_LOSS_DENOMINATOR_SEC > 0 ? (Number(item.duration_sec || 0) / ALARM_LOSS_DENOMINATOR_SEC) * 100 : 0;
        const detailId = `alarm-day-${safeDomId(idPrefix)}-${safeDomId(day)}`;
        ALARM_DAY_DETAIL_CACHE[detailId] = { lineId: HISTORY_MODAL_STATE.data.line_id, day };
        return `
        <tr>
          <td>${day}</td>
          <td>${Number(item.count || 0).toLocaleString()}</td>
          <td>${formatDuration(item.duration_sec)}</td>
          <td>${lossRate.toFixed(2)}%</td>
          <td>${item.count ? `<button class="detail-toggle" onclick="toggleAlarmDayDetail('${detailId}')">보기</button>` : '-'}</td>
        </tr>
        <tr class="alarm-day-detail" id="${detailId}" style="display:none;">
          <td colspan="5"><div class="muted">세부 내용을 여는 중입니다.</div></td>
        </tr>
      `;
      }).join('');
    }

    function safeDomId(value) {
      return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-');
    }

    function normalizeAlarmGroups(block) {
      if (Array.isArray(block.alarm_groups)) return block.alarm_groups;
      return groupAlarmEvents(block.alarm_events || []);
    }

    function normalizeAlarmDailyStats(block) {
      if (Array.isArray(block.alarm_daily_stats)) return block.alarm_daily_stats;
      const groups = normalizeAlarmGroups(block);
      const dayMap = new Map();
      (block.alarm_daily_counts || []).forEach(item => {
        dayMap.set(item.day_key, { day_key: item.day_key, count: 0, duration_sec: 0 });
      });
      groups.forEach(group => {
        const day = String(group.started_at || '').slice(0, 10);
        if (!day) return;
        const current = dayMap.get(day) || { day_key: day, count: 0, duration_sec: 0 };
        current.count += 1;
        current.duration_sec += Number(group.duration_sec || 0);
        dayMap.set(day, current);
      });
      return [...dayMap.values()];
    }

    function countActiveDays(dailyMetrics, groups) {
      const activeDays = new Set();
      (dailyMetrics || []).forEach(item => {
        if (Number(item.total_count || 0) > 0 || Number(item.run_minutes || 0) > 0) activeDays.add(item.day_key);
      });
      (groups || []).forEach(group => {
        const day = String(group.started_at || '').slice(0, 10);
        if (day) activeDays.add(day);
      });
      return Math.max(1, activeDays.size);
    }

    function countActiveDaysFromDailyStats(dailyMetrics, dailyStats) {
      const activeDays = new Set();
      (dailyMetrics || []).forEach(item => {
        if (Number(item.total_count || 0) > 0 || Number(item.run_minutes || 0) > 0) activeDays.add(item.day_key);
      });
      (dailyStats || []).forEach(item => {
        if (Number(item.count || 0) > 0) activeDays.add(item.day_key);
      });
      return Math.max(1, activeDays.size);
    }

    function renderLossSummary(groups, dayCount) {
      const totalDuration = (groups || []).reduce((sum, group) => sum + Number(group.duration_sec || 0), 0);
      const denominator = ALARM_LOSS_DENOMINATOR_SEC * Math.max(1, Number(dayCount || 1));
      const lossRate = denominator > 0 ? (totalDuration / denominator) * 100 : 0;
      return `<div class="loss-summary">
        <div class="loss-card"><span class="loss-label">총 알람 손실</span><span class="loss-value">${formatDuration(totalDuration)}</span></div>
        <div class="loss-card"><span class="loss-label">총 가동 손실률</span><span class="loss-value">${lossRate.toFixed(2)}%</span></div>
      </div>`;
    }

    function renderLossSummaryFromDailyStats(dailyStats, dayCount) {
      const totalDuration = (dailyStats || []).reduce((sum, item) => sum + Number(item.duration_sec || 0), 0);
      const denominator = ALARM_LOSS_DENOMINATOR_SEC * Math.max(1, Number(dayCount || 1));
      const lossRate = denominator > 0 ? (totalDuration / denominator) * 100 : 0;
      return `<div class="loss-summary">
        <div class="loss-card"><span class="loss-label">총 알람 손실</span><span class="loss-value">${formatDuration(totalDuration)}</span></div>
        <div class="loss-card"><span class="loss-label">총 가동 손실률</span><span class="loss-value">${lossRate.toFixed(2)}%</span></div>
      </div>`;
    }

    function groupAlarmEvents(items) {
      const sorted = [...items].sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
      const groups = [];
      sorted.forEach(item => {
        const startMs = Date.parse(item.started_at || '');
        const last = groups[groups.length - 1];
        const lastStartMs = last ? Date.parse(last.started_at || '') : NaN;
        if (last && Number.isFinite(startMs) && Number.isFinite(lastStartMs) && Math.abs(startMs - lastStartMs) <= 20000) {
          last.items.push(item);
          last.started_at = minIso(last.started_at, item.started_at);
          last.ended_at = mergeEndedAt(last.ended_at, item.ended_at);
          last.active = last.active || Boolean(item.active);
          last.duration_sec = groupDurationSeconds(last.started_at, last.ended_at, last.active);
          return;
        }
        groups.push({
          started_at: item.started_at,
          ended_at: item.ended_at,
          active: Boolean(item.active),
          duration_sec: Number(item.duration_sec || 0),
          items: [item]
        });
      });
      return groups.reverse();
    }

    function minIso(left, right) {
      if (!left) return right;
      if (!right) return left;
      return String(left) <= String(right) ? left : right;
    }

    function mergeEndedAt(left, right) {
      if (!left || !right) return null;
      return String(left) >= String(right) ? left : right;
    }

    function groupDurationSeconds(startedAt, endedAt, active) {
      if (!startedAt || !endedAt || active) return 0;
      const startMs = Date.parse(startedAt);
      const endMs = Date.parse(endedAt);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
      return Math.max(0, Math.floor((endMs - startMs) / 1000));
    }

    function alarmGroupLabel(group) {
      const first = group.items[0] || {};
      const extra = Math.max(0, group.items.length - 1);
      return extra > 0 ? `${first.label} 외 ${extra}건` : (first.label || '-');
    }

    function renderAlarmGroupSummaryRows(groups) {
      if (!groups.length) return `<tr><td colspan="4" class="muted">저장된 알람 사건 이력이 없습니다.</td></tr>`;
      const summary = new Map();
      groups.forEach(group => {
        const label = alarmGroupLabel(group);
        const current = summary.get(label) || { count: 0, duration_sec: 0 };
        current.count += 1;
        current.duration_sec += Number(group.duration_sec || 0);
        summary.set(label, current);
      });
      return [...summary.entries()].map(([label, item]) => {
        const lossRate = ALARM_LOSS_DENOMINATOR_SEC > 0 ? (Number(item.duration_sec || 0) / ALARM_LOSS_DENOMINATOR_SEC) * 100 : 0;
        return `
        <tr>
          <td>${label}</td>
          <td>${Number(item.count || 0).toLocaleString()}</td>
          <td>${formatDuration(item.duration_sec)}</td>
          <td>${lossRate.toFixed(2)}%</td>
        </tr>
      `;
      }).join('');
    }

    function formatDuration(seconds) {
      const total = Number(seconds || 0);
      if (total <= 0) return '-';
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const secs = total % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function formatTimeOnly(value) {
      if (!value) return '-';
      const text = String(value).replace('T', ' ');
      const timePart = text.split(' ')[1] || text;
      return timePart.slice(0, 8);
    }

    function formatElapsedSince(value) {
      if (!value) return '-';
      const startMs = Date.parse(String(value));
      if (!Number.isFinite(startMs)) return '-';
      return formatDuration(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
    }

    function renderAlarmEventRows(items) {
      if (!items.length) return `<tr><td colspan="5" class="muted">저장된 알람 이벤트 이력이 없습니다.</td></tr>`;
      return items.map(item => `
        <tr>
          <td>${item.label}</td>
          <td>${formatTimeOnly(item.started_at)}</td>
          <td>${formatTimeOnly(item.ended_at)}</td>
          <td>${formatDuration(item.duration_sec)}</td>
          <td>${item.active ? '진행중' : '해제'}</td>
        </tr>
      `).join('');
    }

    function renderAlarmGroupRows(groups, idPrefix = 'alarm-detail', showLossRate = false) {
      if (!groups.length) return `<tr><td colspan="6" class="muted">저장된 알람 사건 이력이 없습니다.</td></tr>`;
      return groups.map((group, index) => {
        const detailId = `${safeDomId(idPrefix)}-${index}-${String(group.started_at || '').replace(/[^0-9]/g, '')}`;
        return `
        <tr>
          <td>${alarmGroupLabel(group)}</td>
          <td>${formatTimeOnly(group.started_at)}</td>
          <td>${formatTimeOnly(group.ended_at)}</td>
          <td>${formatDuration(group.duration_sec)}</td>
          <td>${Number(group.items.length || 0).toLocaleString()}${group.items.length > 1 ? `<button class="detail-toggle" onclick="toggleAlarmDetail('${detailId}')">보기</button>` : ''}</td>
          <td>${showLossRate ? formatAlarmLossRate(group.duration_sec) : (group.active ? '진행중' : '해제')}</td>
        </tr>
        ${group.items.length > 1 ? `
          <tr class="alarm-group-detail" id="${detailId}" style="display:none;">
            <td colspan="6">${group.items.map(item => `<span>${item.label}</span>`).join('')}</td>
          </tr>
        ` : ''}
      `;
      }).join('');
    }

    function formatAlarmLossRate(durationSec) {
      const lossRate = ALARM_LOSS_DENOMINATOR_SEC > 0 ? (Number(durationSec || 0) / ALARM_LOSS_DENOMINATOR_SEC) * 100 : 0;
      return `${lossRate.toFixed(2)}%`;
    }

    function toggleAlarmDetail(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = el.style.display === 'none' ? 'table-row' : 'none';
    }

    async function toggleAlarmDayDetail(id) {
      const el = document.getElementById(id);
      if (!el) return;
      const willOpen = el.style.display === 'none';
      if (willOpen && !el.dataset.rendered) {
        const detail = ALARM_DAY_DETAIL_CACHE[id];
        try {
          const groups = await loadAlarmDayGroups(detail.lineId, detail.day);
          el.querySelector('td').innerHTML = `
            <table class="history-table">
              <thead><tr><th>발생 알람명</th><th>시작</th><th>해제</th><th>지속</th><th>발생횟수</th><th>가동 손실률</th></tr></thead>
              <tbody>${renderAlarmGroupRows(groups, `${id}-group`, true)}</tbody>
            </table>
          `;
          el.dataset.rendered = '1';
        } catch (error) {
          el.querySelector('td').innerHTML = `<div class="muted">세부 이력 조회 실패: ${error.message}</div>`;
        }
      }
      el.style.display = willOpen ? 'table-row' : 'none';
    }

    function renderProductionPeriodContent(period, data) {
      if (period === 'today') return renderProductionHistoryBlock('금일', data.today);
      if (period === 'yesterday') return renderProductionHistoryBlock('전일', data.yesterday);
      if (period === 'week') return renderProductionRangeBlock('주간', data.week);
      return renderProductionRangeBlock('월간', data.month);
    }

    function renderAlarmPeriodContent(period, data) {
      if (period === 'today') return renderAlarmHistoryBlock('금일', data.today);
      if (period === 'yesterday') return renderAlarmHistoryBlock('전일', data.yesterday);
      if (period === 'week') return renderAlarmRangeBlock('주간', data.week);
      return renderAlarmRangeBlock('월간', data.month);
    }
    function renderYieldHistoryBlock(title, block) {
      const rows = buildProductionHourlyRows(block);
      return `<div class="mb-8">
        <h4 class="period-title">${block.day_key}</h4>
        ${renderYieldSummary(rows)}
        <div class="section-title">OK / NG 이력</div>
        <table class="history-table mb-4">
          <thead><tr><th>시간</th><th>생산 수량</th><th>OK</th><th>NG</th><th>직행률</th></tr></thead>
          <tbody>${renderYieldRows(rows)}</tbody>
        </table>
      </div>`;
    }

    function renderYieldRangeBlock(title, block) {
      const rows = buildProductionDailyRows(block);
      return `<div class="mb-8">
        <h4 class="period-title">${block.start_day_key} ~ ${block.end_day_key}</h4>
        ${renderYieldSummary(rows)}
        <div class="section-title">OK / NG 이력</div>
        <table class="history-table mb-4">
          <thead><tr><th>날짜</th><th>생산 수량</th><th>OK</th><th>NG</th><th>직행률</th></tr></thead>
          <tbody>${renderYieldRows(rows)}</tbody>
        </table>
      </div>`;
    }

    function renderYieldRows(rows) {
      if (!rows.length) return `<tr><td colspan="5" class="muted">집계 데이터가 없습니다.</td></tr>`;
      return rows.map(item => `
        <tr>
          <td>${item.key}</td>
          <td>${Number(item.total_count || 0).toLocaleString()}</td>
          <td>${item.ok_count === null || item.ok_count === undefined ? '-' : Number(item.ok_count).toLocaleString()}</td>
          <td>${item.ng_count === null || item.ng_count === undefined ? '-' : Number(item.ng_count).toLocaleString()}</td>
          <td>${calcDirectYield(item.ok_count, item.ng_count)?.toFixed(1) ?? '-'}%</td>
        </tr>
      `).join('');
    }

    function renderYieldSummary(rows) {
      const totalCount = rows.reduce((sum, item) => sum + Number(item.total_count || 0), 0);
      const okCount = rows.reduce((sum, item) => sum + Number(item.ok_count || 0), 0);
      const ngCount = rows.reduce((sum, item) => sum + Number(item.ng_count || 0), 0);
      const directYield = calcDirectYield(okCount, ngCount);
      return `<div class="loss-summary">
        <div class="loss-card"><span class="loss-label">총 생산수량</span><span class="loss-value">${Number(totalCount).toLocaleString()}</span></div>
        <div class="loss-card"><span class="loss-label">총 OK</span><span class="loss-value">${Number(okCount).toLocaleString()}</span></div>
        <div class="loss-card"><span class="loss-label">총 NG</span><span class="loss-value">${Number(ngCount).toLocaleString()}</span></div>
        <div class="loss-card"><span class="loss-label">직행률</span><span class="loss-value">${directYield === null ? '-' : `${directYield.toFixed(1)}%`}</span></div>
      </div>`;
    }

    function renderYieldPeriodContent(period, data) {
      if (period === 'today') return renderYieldHistoryBlock('금일', data.today);
      if (period === 'yesterday') return renderYieldHistoryBlock('전일', data.yesterday);
      if (period === 'week') return renderYieldRangeBlock('주간', data.week);
      return renderYieldRangeBlock('월간', data.month);
    }

    function closeModal() { document.getElementById('historyModal').classList.remove('open'); }

    function setupInteractions(id) {
      const w = document.getElementById(`wrapper-${id}`);
      const tt = document.getElementById(`tooltip-${id}`);
      w.addEventListener('mousemove', e => {
        const r = w.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        const plotX = STRIP_LABEL_GUTTER;
        const plotW = Math.max(r.width - STRIP_LABEL_GUTTER - STRIP_RIGHT_GUTTER, 1);
        const xInPlot = Math.min(Math.max(x - plotX, 0), plotW);
        const h = Math.min(Math.max(Math.floor((xInPlot / plotW) * 24), 0), 23);
        const d = CHART_DATA[id];
        if (!d) return;

        const cursorSec = Math.floor((xInPlot / plotW) * 86400);
        const hoverMarker = w.querySelector('[data-ref="hover-marker"]');
        const hoverTime = w.querySelector('[data-ref="hover-time"]');
        if (hoverMarker) {
          hoverMarker.style.left = `${plotX + xInPlot}px`;
          hoverMarker.style.display = 'block';
        }
        if (hoverTime) hoverTime.textContent = formatProdSecond(cursorSec);
        const strips = d.stripMeta || {};
        const isYestStrip = y >= (strips.yesterdayY || -1) && y <= (strips.yesterdayY || -1) + STATUS_STRIP_HEIGHT;
        const isTodayStrip = y >= (strips.todayY || -1) && y <= (strips.todayY || -1) + STATUS_STRIP_HEIGHT;
        if (isYestStrip || isTodayStrip) {
          const rowLabel = isTodayStrip ? '금일' : '전일';
          const blocks = isTodayStrip ? d.timeline_today : d.timeline_yesterday;
          const block = findTimelineBlock(blocks, cursorSec) || { status: 'NO_DATA', startSec: 0, duration: 86400 };
          const hoverRow = isTodayStrip ? 'today' : 'yesterday';
          const hoverKey = `${hoverRow}:${block.status}:${Number(block.startSec || 0)}:${Number(block.duration || 0)}`;
          if (d.hoverStripKey !== hoverKey) {
            d.hoverStripKey = hoverKey;
            d.hoverStrip = { row: hoverRow, block };
            drawCombinedChart(id, d.yest, d.today, d.timeline_yesterday || [], d.timeline_today || []);
          }
          const startSec = Number(block.startSec || 0);
          const endSec = Math.min(86400, startSec + Number(block.duration || 0));
          tt.innerHTML = `
            <div class="tooltip-time">${rowLabel} ${formatProdSecond(cursorSec)}</div>
            <div class="tooltip-row"><span>구간</span><span class="val-ct">${formatProdSecond(startSec)}~${formatProdSecond(endSec)}</span></div>
            <div class="tooltip-row"><span>상태</span><span style="color:${statusColor(block.status)}; font-weight:700;">${statusNameKo(block.status)}</span></div>
                      `;
        } else {
          if (d.hoverStripKey) {
            d.hoverStripKey = null;
            d.hoverStrip = null;
            drawCombinedChart(id, d.yest, d.today, d.timeline_yesterday || [], d.timeline_today || []);
          }
          const yestSeries = buildPlotSeries(d.yest, d.timeline_yesterday || [], false);
          const todaySeries = buildPlotSeries(d.today, d.timeline_today || [], true);
          const yestValue = yestSeries[h];
          const todayValue = todaySeries[h];
          const prod = todayValue === null || todayValue === undefined ? 0 : Number(todayValue);
          const run = Number((d.run_mins && d.run_mins[h]) || 0);
          const ct = prod > 0 && run > 0 ? (run * 60) / prod : 0;
          tt.innerHTML = `
            <div class="tooltip-time">${slotLabel(h)}</div>
            <div class="tooltip-row"><span class="val-label">어제</span><span class="val-yest">${yestValue === null || yestValue === undefined ? '-' : Number(yestValue).toLocaleString()}</span></div>
            <div class="tooltip-row"><span class="val-label">오늘</span><span class="val-today">${todayValue === null || todayValue === undefined ? '-' : Number(todayValue).toLocaleString()}</span></div>
            <div class="tooltip-row border-t border-[#3A3A3C] pt-1 mt-1"><span class="val-label">Avg C/T</span><span class="val-ct">${ct > 0 ? `${ct.toFixed(1)}s` : '-'}</span></div>
          `;
        }
        let left = x + 15;
        if (left + 170 > r.width) left = x - 180;
        tt.style.left = `${left}px`;
        tt.style.top = '10px';
        tt.style.display = 'block';
      });
      w.addEventListener('mouseleave', () => {
        tt.style.display = 'none';
        const hoverMarker = w.querySelector('[data-ref="hover-marker"]');
        if (hoverMarker) hoverMarker.style.display = 'none';
        const d = CHART_DATA[id];
        if (d?.hoverStripKey) {
          d.hoverStripKey = null;
          d.hoverStrip = null;
          drawCombinedChart(id, d.yest, d.today, d.timeline_yesterday || [], d.timeline_today || []);
        }
      });
    }

    function drawCombinedChart(id, yest, today, tYest, tToday) {
      const cvs = document.getElementById(`canvas-main-${id}`);
      if (!cvs) return;
      const ctx = cvs.getContext('2d');
      const rect = cvs.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (cvs.width !== rect.width * dpr) { cvs.width = rect.width * dpr; cvs.height = rect.height * dpr; ctx.scale(dpr, dpr); }
      const W = rect.width, H = rect.height, stH = STATUS_STRIP_HEIGHT, stGap = STATUS_STRIP_GAP, cH = H - (stH * 2) - stGap - STATUS_AXIS_HEIGHT - 12;
      const plotX = STRIP_LABEL_GUTTER;
      const plotW = Math.max(W - STRIP_LABEL_GUTTER - STRIP_RIGHT_GUTTER, 1);
      ctx.fillStyle = '#111113'; ctx.fillRect(0, 0, W, H);
      const all = [...yest, ...today];
      const max = Math.max(...all, 100) * 1.35;
      const step = plotW / 23;
      const gp = (i, v) => ({ x: plotX + (i * step), y: 10 + cH - ((v / max) * cH) });

      const yestSeries = buildPlotSeries(yest, tYest, false);
      const todaySeries = buildPlotSeries(today, tToday, true);
      const visibleValues = [...yestSeries, ...todaySeries].filter(value => value !== null && value !== undefined);
      const visibleMax = Math.max(...visibleValues, 100) * 1.35;
      const gpv = (i, v) => ({ x: plotX + (i * step), y: 10 + cH - ((v / visibleMax) * cH) });

      function drawLineSeries(series, color, width, alpha, dash = []) {
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.setLineDash(dash);
        let drawing = false;
        series.forEach((value, i) => {
          if (value === null || value === undefined) {
            drawing = false;
            return;
          }
          const p = gpv(i, Number(value));
          if (!drawing) {
            ctx.moveTo(p.x, p.y);
            drawing = true;
          } else {
            ctx.lineTo(p.x, p.y);
          }
        });
        ctx.stroke();
        ctx.restore();
      }

      drawLineSeries(yestSeries, '#8B93A1', 1.35, 0.72, [4, 3]);
      drawLineSeries(todaySeries, C_CHART, 1.75, 0.75);

      ctx.save();
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      todaySeries.forEach((value, i) => {
        if (value === null || value === undefined) return;
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return;
        const point = gpv(i, numeric);
        const labelY = Math.max(10, point.y - 6);
        ctx.fillStyle = 'rgba(255,255,255,0.86)';
        ctx.fillText(numeric.toLocaleString(), point.x, labelY);
      });
      ctx.restore();
      const hoverStrip = CHART_DATA[id].hoverStrip || null;
      const drawStrip = (list, y, faded, rowKey) => {
        const stripX = STRIP_LABEL_GUTTER;
        const stripW = Math.max(W - STRIP_LABEL_GUTTER - STRIP_RIGHT_GUTTER, 1);
        ctx.fillStyle = '#2C2C2E';
        ctx.fillRect(stripX, y, stripW, stH);
        if (!list || !list.length) return;
        list.forEach(block => {
          const x = stripX + (block.startSec / 86400) * stripW;
          const w = Math.max((block.duration / 86400) * stripW, 1);
          const c = block.status === 'RUN' ? TL_COLORS.RUN : (TL_COLORS[block.status] || TL_COLORS.OFF);
          const isHovered = hoverStrip && hoverStrip.row === rowKey && Number(hoverStrip.block?.startSec || 0) === Number(block.startSec || 0) && Number(hoverStrip.block?.duration || 0) === Number(block.duration || 0) && String(hoverStrip.block?.status || '') === String(block.status || '');
          ctx.fillStyle = c;
          ctx.globalAlpha = isHovered ? 1 : (faded ? 0.4 : 0.9);
          ctx.fillRect(x, y, w, stH);
          if (isHovered) {
            ctx.save();
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 0.75, y + 0.75, Math.max(w - 1.5, 0.5), Math.max(stH - 1.5, 0.5));
            ctx.restore();
          }
          ctx.globalAlpha = 1;
        });
      };
      const yestStripY = H - STATUS_AXIS_HEIGHT - (stH * 2) - stGap - 4;
      const todayStripY = H - STATUS_AXIS_HEIGHT - stH - 4;
      drawStrip(tYest, yestStripY, true, 'yesterday');
      drawStrip(tToday, todayStripY, false, 'today');
      const wrapper = cvs.parentElement;
      const yestLabel = wrapper.querySelector('[data-strip-label="yesterday"]');
      const todayLabel = wrapper.querySelector('[data-strip-label="today"]');
      if (yestLabel) yestLabel.style.top = `${yestStripY}px`;
      if (todayLabel) todayLabel.style.top = `${todayStripY}px`;
      CHART_DATA[id].stripMeta = { yesterdayY: yestStripY, todayY: todayStripY };

      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#6b7280';
      ctx.strokeStyle = '#3a3a3c';
      ctx.lineWidth = 1;
      for (let hour = 0; hour <= 24; hour += 2) {
        const x = plotX + (hour / 24) * plotW;
        const labelHour = (DAY_START_HOUR + hour) % 24;
        ctx.beginPath();
        ctx.moveTo(x, todayStripY + stH + 2);
        ctx.lineTo(x, todayStripY + stH + 6);
        ctx.stroke();
        ctx.fillText(`${String(labelHour).padStart(2, '0')}:00`, x, todayStripY + stH + 7);
      }

      const currentSec = latestDataSecond(tToday);
      const cX = plotX + (currentSec / 86400) * plotW;
      const nowMarker = wrapper.querySelector('[data-ref="now-marker"]');
      if (nowMarker) nowMarker.style.left = `${cX}px`;
    }

  
