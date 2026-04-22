
    const C_CHART = '#6366f1';
    const C_TEAL = '#14b8a6';
    const ST_COLORS = { YEST: '#6B7280' };
    const TL_COLORS = {
      RUN: '#008000',
      STOP: '#FFD700',
      ALARM: '#FF0000',
      MEAL: '#505763',
      ONLINE: '#66d4cf',
      OFFLINE: '#3f4650',
      NO_DATA: '#2f3440',
      OFF: '#2c2c2e'
    };
    const CHART_DATA = {};
    const STRIP_LABEL_GUTTER = 36;
    const STRIP_RIGHT_GUTTER = 24;
    const STATUS_STRIP_HEIGHT = 15;
    const STATUS_STRIP_GAP = 3;
    const STATUS_AXIS_HEIGHT = 18;
    const STATUS_STRIP_REVEAL_MS = 320;
    const STATUS_STRIP_HIDE_DELAY_MS = 360;
    const MEAL_BREAKS = [
      { label: '식사', start: '12:00', end: '13:00' },
      { label: '식사', start: '17:00', end: '17:30' },
      { label: '식사', start: '00:00', end: '01:00' }
    ];
    const ALARM_LOSS_DENOMINATOR_SEC = 21.5 * 3600;
    const HISTORY_SUMMARY_TTL_MS = 60000;
    const VIEWER_CLIENT_ID = getViewerClientId();
    const HISTORY_PERIODS = [
      { key: 'today', label: '금일' },
      { key: 'yesterday', label: '전일' },
      { key: 'month', label: '월간/기간' }
    ];
    let DAY_START_MINUTE = 8 * 60;
    let DAY_START_HOUR = 8;
    let LINES = [];
    let HISTORY_MODAL_STATE = { mode: 'production', period: 'today', data: null };
    let PRODUCTION_RANGE_VIEW = 'summary';
    let ALARM_DAY_DETAIL_CACHE = {};
    let PRODUCTION_DAY_DETAIL_CACHE = {};
    let HISTORY_SUMMARY_CACHE = {};

    document.addEventListener('DOMContentLoaded', async () => {
      startClock();
      startViewerHeartbeat();
      await loadDashboard();
      setInterval(loadDashboard, 2000);
    });

    function getViewerClientId() {
      const key = 'dx-monitor-viewer-client-id';
      try {
        const existing = localStorage.getItem(key);
        if (existing) return existing;
        const created = crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        localStorage.setItem(key, created);
        return created;
      } catch (error) {
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      }
    }

    async function sendViewerHeartbeat() {
      try {
        const response = await fetch('/api/viewers/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: VIEWER_CLIENT_ID }),
          cache: 'no-store'
        });
        if (!response.ok) return;
        const payload = await response.json();
        updateServerState(true, payload.viewer_count);
      } catch (error) {
        // Dashboard polling handles the offline state.
      }
    }

    function startViewerHeartbeat() {
      sendViewerHeartbeat();
      setInterval(sendViewerHeartbeat, 5000);
    }

    function updateServerState(online, viewerCount = null) {
      const serverStateEl = document.getElementById('serverState');
      if (!serverStateEl) return;
      if (online) {
        const count = Number(viewerCount || 0);
        serverStateEl.textContent = count > 0 ? `ONLINE · ${count}명` : 'ONLINE';
        serverStateEl.className = 'header-status header-status-online';
      } else {
        serverStateEl.textContent = 'OFFLINE';
        serverStateEl.className = 'header-status header-status-offline';
      }
    }

    function handleTargetKey(event, lineId) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      saveLineTarget(lineId);
    }

    async function saveLineTarget(lineId) {
      const panel = document.getElementById(`panel-${lineId}`);
      const input = panel?.querySelector('[data-ref="target-input"]');
      const button = panel?.querySelector('[data-ref="target-save"]');
      if (!input) return;
      const daily = Math.max(0, Math.floor(Number(input.value || 0)));
      if (!Number.isFinite(daily)) return;
      input.value = daily;
      if (button) {
        button.disabled = true;
        button.textContent = '저장중';
      }
      try {
        const response = await fetch(`/api/lines/${lineId}/target`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ daily }),
          cache: 'no-store'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await loadDashboard();
        if (button) button.textContent = '저장됨';
        setTimeout(() => {
          if (button) button.textContent = '저장';
        }, 1200);
      } catch (error) {
        if (button) button.textContent = '오류';
        setTimeout(() => {
          if (button) button.textContent = '저장';
        }, 1600);
      } finally {
        if (button) button.disabled = false;
      }
    }

    function getDonutSvg(id) {
      return `<svg class="donut-chart" viewBox="0 0 100 100"><circle class="donut-bg" cx="50" cy="50" r="40"></circle><circle class="donut-fill" id="donut-${id}" cx="50" cy="50" r="40" stroke="${C_CHART}" stroke-dasharray="251.3" stroke-dashoffset="251.3"></circle></svg>`;
    }

    function slotClockMinute(hourIndex, startMinute = DAY_START_MINUTE) {
      return (Number(startMinute || 0) + (Number(hourIndex || 0) * 60)) % 1440;
    }

    function slotHourIndex(hourIndex, startMinute = DAY_START_MINUTE) {
      return Math.floor(slotClockMinute(hourIndex, startMinute) / 60);
    }

    function normalizeHourlyArray(values, startMinute = DAY_START_MINUTE, preserveNull = false) {
      const src = Array.isArray(values) ? values : [];
      return Array.from({ length: 24 }, (_, idx) => {
        const value = src[slotHourIndex(idx, startMinute)];
        if (preserveNull && (value === null || value === undefined)) return null;
        return Number(value || 0);
      });
    }

    function slotLabel(hourIndex, startMinute = DAY_START_MINUTE) {
      const minute = slotClockMinute(hourIndex, startMinute);
      return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    }

    function currentProductionDaySeconds() {
      const now = new Date();
      const start = new Date(now);
      start.setHours(Math.floor(DAY_START_MINUTE / 60), DAY_START_MINUTE % 60, 0, 0);
      if (now < start) start.setDate(start.getDate() - 1);
      return Math.max(0, Math.min(86399, Math.floor((now.getTime() - start.getTime()) / 1000)));
    }

    function currentAsOfLabel() {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      return `Same-time comparison ${hh}:${mm}:${ss}`;
    }

    function formatProdSecond(seconds, startMinute = DAY_START_MINUTE) {
      const totalMinutes = Math.floor(Math.max(0, Math.min(86400, Number(seconds || 0))) / 60);
      const minute = (Number(startMinute || 0) + totalMinutes) % 1440;
      return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    }

    function clockTimeToProductionSecond(timeText) {
      const [hourText, minuteText] = String(timeText || '00:00').split(':');
      const hour = Number(hourText || 0);
      const minute = Number(minuteText || 0);
      const dayStartMinute = DAY_START_MINUTE;
      const clockMinute = (hour * 60) + minute;
      const offsetMinute = (clockMinute - dayStartMinute + 1440) % 1440;
      return offsetMinute * 60;
    }

    function mealBreakBlocks() {
      return MEAL_BREAKS.map(item => {
        const startSec = clockTimeToProductionSecond(item.start);
        const endSec = clockTimeToProductionSecond(item.end);
        const duration = endSec > startSec ? endSec - startSec : (86400 - startSec) + endSec;
        return { ...item, startSec, duration };
      });
    }

    function findMealBreak(seconds) {
      const sec = Math.max(0, Math.min(86399, Number(seconds || 0)));
      return mealBreakBlocks().find(item => sec >= item.startSec && sec < item.startSec + item.duration) || null;
    }

    function splitTimelineBlockByMeal(block) {
      const start = Math.max(0, Math.min(86400, Number(block.startSec || 0)));
      const end = Math.max(start, Math.min(86400, start + Number(block.duration || 0)));
      let segments = [{ ...block, startSec: start, duration: end - start }];
      mealBreakBlocks().forEach(meal => {
        const mealStart = Number(meal.startSec || 0);
        const mealEnd = Math.min(86400, mealStart + Number(meal.duration || 0));
        const next = [];
        segments.forEach(segment => {
          const segStart = Number(segment.startSec || 0);
          const segEnd = segStart + Number(segment.duration || 0);
          const overlapStart = Math.max(segStart, mealStart);
          const overlapEnd = Math.min(segEnd, mealEnd);
          if (overlapStart >= overlapEnd) {
            next.push(segment);
            return;
          }
          if (segStart < overlapStart) next.push({ ...segment, startSec: segStart, duration: overlapStart - segStart });
          next.push({ status: 'MEAL', startSec: overlapStart, duration: overlapEnd - overlapStart });
          if (overlapEnd < segEnd) next.push({ ...segment, startSec: overlapEnd, duration: segEnd - overlapEnd });
        });
        segments = next;
      });
      return segments.filter(segment => Number(segment.duration || 0) > 0);
    }

    function timelineBlocksForDisplay(blocks) {
      return (blocks || []).flatMap(block => splitTimelineBlockByMeal(block));
    }

    function statusNameKo(status) {
      if (status === 'RUN' || status === 'ONLINE') return '가동';
      if (status === 'STOP') return '비가동';
      if (status === 'ALARM') return '알람';
      if (status === 'MEAL') return '식사시간';
      if (status === 'NO_DATA') return '서버 OFF';
      if (status === 'OFFLINE') return '오프라인';
      return status || '-';
    }

    function statusColor(status) {
      if (status === 'RUN' || status === 'ONLINE') return TL_COLORS.RUN;
      if (status === 'STOP') return TL_COLORS.STOP;
      if (status === 'ALARM') return TL_COLORS.ALARM;
      if (status === 'MEAL') return TL_COLORS.MEAL;
      if (status === 'OFFLINE' || status === 'NO_DATA') return TL_COLORS.OFFLINE;
      return '#fff';
    }

    function tooltipStatusColor(status) {
      return statusColor(status);
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

    function fixedYAxisMax(lineId) {
      if (Number(lineId) === 1) return 400;
      if (Number(lineId) === 3) return 250;
      return 500;
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
            <div class="panel-actions">
              <div class="target-control">
                <span class="target-label">목표</span>
                <input class="target-input" type="number" min="0" step="1" inputmode="numeric" data-ref="target-input" onkeydown="handleTargetKey(event, ${line.id})" aria-label="${line.name} 일일 목표 수량">
                <button class="target-save" type="button" data-ref="target-save" onclick="saveLineTarget(${line.id})">저장</button>
              </div>
              <div class="status-inline" data-ref="ctx-panel"><span class="status-inline-label">STATUS</span><span class="status-inline-dot" aria-hidden="true"></span><span class="status-inline-value" data-ref="ctx-status">-</span></div>
            </div>
          </div>
          <div class="kpi-section">
            <div class="kpi-section-head">
              <div class="kpi-section-title-wrap"><span class="kpi-section-title">주요 KPI</span></div>
              <span class="kpi-section-legend"><span class="legend-good"><span class="legend-dot legend-dot-good"></span>Good</span><span class="legend-bad"><span class="legend-dot legend-dot-bad"></span>Bad</span></span>
            </div>
            <div class="kpi-row">
            <div class="kpi-card kpi-card-action" role="button" tabindex="0" onclick="openKpiHistory(${line.id}, 'production')" onkeydown="handleKpiLinkKey(event, () => openKpiHistory(${line.id}, 'production'))" aria-label="생산 수량 이력 보기">
              <div class="compare-head"><span class="kpi-label">생산 수량</span></div>
              <div class="compare-main"><span class="compare-main-value" data-ref="cmp-production-today">0</span><span class="compare-main-unit">EA</span></div>
              <div class="compare-delta-list">
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">전일</span><span class="compare-delta-meta" data-ref="cmp-production-yesterday">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-production-delta-yesterday">-</span></div>
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">주간</span><span class="compare-delta-meta" data-ref="cmp-production-week">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-production-delta-week">-</span></div>
              </div>
            </div>
            <div class="kpi-card kpi-card-action" role="button" tabindex="0" onclick="openKpiHistory(${line.id}, 'yield')" onkeydown="handleKpiLinkKey(event, () => openKpiHistory(${line.id}, 'yield'))" aria-label="직행률 이력 보기">
              <div class="compare-head"><span class="kpi-label">직행률</span></div>
              <div class="compare-main"><span class="compare-main-group"><span class="compare-main-value" data-ref="cmp-direct-yield-today">-</span><span class="compare-main-unit">%</span></span></div>
              <div class="compare-delta-list">
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">전일</span><span class="compare-delta-meta" data-ref="cmp-direct-yield-yesterday">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-direct-yield-delta-yesterday">-</span></div>
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">주간</span><span class="compare-delta-meta" data-ref="cmp-direct-yield-week">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-direct-yield-delta-week">-</span></div>
              </div>
            </div>
            <div class="kpi-card kpi-card-action" role="button" tabindex="0" onclick="openKpiHistory(${line.id}, 'availability')" onkeydown="handleKpiLinkKey(event, () => openKpiHistory(${line.id}, 'availability'))" aria-label="가동률 이력 보기">
              <div class="compare-head"><span class="kpi-label">가동률</span></div>
              <div class="compare-main"><span class="compare-main-value" data-ref="cmp-run-today">0</span><span class="compare-main-unit">%</span></div>
              <div class="compare-delta-list">
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">전일</span><span class="compare-delta-meta" data-ref="cmp-run-yesterday">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-run-delta-yesterday">-</span></div>
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">주간</span><span class="compare-delta-meta" data-ref="cmp-run-week">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-run-delta-week">-</span></div>
              </div>
            </div>
            <div class="kpi-card kpi-card-action" role="button" tabindex="0" onclick="openKpiHistory(${line.id}, 'mttr')" onkeydown="handleKpiLinkKey(event, () => openKpiHistory(${line.id}, 'mttr'))" aria-label="MTTR 알람 이력 보기">
              <div class="compare-head"><span class="kpi-label">MTTR</span></div>
              <div class="compare-main"><span class="compare-main-value" data-ref="cmp-mttr-today">-</span><span class="compare-main-unit">hr</span></div>
              <div class="compare-delta-list">
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">전일</span><span class="compare-delta-meta" data-ref="cmp-mttr-yesterday">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-mttr-delta-yesterday">-</span></div>
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">주간</span><span class="compare-delta-meta" data-ref="cmp-mttr-week">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-mttr-delta-week">-</span></div>
              </div>
            </div>
            <div class="kpi-card kpi-card-action" role="button" tabindex="0" onclick="openKpiHistory(${line.id}, 'mtbf')" onkeydown="handleKpiLinkKey(event, () => openKpiHistory(${line.id}, 'mtbf'))" aria-label="MTBF 알람 이력 보기">
              <div class="compare-head"><span class="kpi-label">MTBF</span></div>
              <div class="compare-main"><span class="compare-main-value" data-ref="cmp-mtbf-today">-</span><span class="compare-main-unit">hr</span></div>
              <div class="compare-delta-list">
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">전일</span><span class="compare-delta-meta" data-ref="cmp-mtbf-yesterday">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-mtbf-delta-yesterday">-</span></div>
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">주간</span><span class="compare-delta-meta" data-ref="cmp-mtbf-week">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-mtbf-delta-week">-</span></div>
              </div>
            </div>
            <div class="kpi-card kpi-card-action" role="button" tabindex="0" onclick="openKpiHistory(${line.id}, 'alarm')" onkeydown="handleKpiLinkKey(event, () => openKpiHistory(${line.id}, 'alarm'))" aria-label="고장률 알람 이력 보기">
              <div class="compare-head"><span class="kpi-label">고장률</span></div>
              <div class="compare-main"><span class="compare-main-value" data-ref="cmp-alarm-today">0</span><span class="compare-main-unit">%</span></div>
              <div class="compare-delta-list">
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">전일</span><span class="compare-delta-meta" data-ref="cmp-alarm-yesterday">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-alarm-delta-yesterday">-</span></div>
                <div class="compare-delta"><span class="compare-delta-left"><span class="compare-delta-label">주간</span><span class="compare-delta-meta" data-ref="cmp-alarm-week">-</span></span><span class="compare-delta-value delta-neutral" data-ref="cmp-alarm-delta-week">-</span></div>
              </div>
            </div>
            </div>
          </div>
          <div class="middle-section">
            <div class="list-section"><div class="list-header header-alarm"><div class="kpi-section-title-wrap title-wrap-alarm"><span class="kpi-section-title">실시간 알람 현황</span></div><button class="alarm-history-button" type="button" onclick="openKpiHistory(${line.id}, 'alarmDetail')">알람 이력</button></div><ul class="list-body space-y-0" data-ref="alarm-list"><li class="list-item justify-center text-[#5E6673] border-none">알람 이력이 없습니다</li></ul></div>
          </div>
          <div class="chart-section">
            <div class="chart-header-bar"><div class="kpi-section-title-wrap title-wrap-chart"><span class="chart-title">시간대별 생산현황</span></div><div class="flex items-center gap-3"><span class="compare-range-label" data-ref="compare-range-label">선택기간: -</span><div class="chart-mode-tabs"><button class="chart-mode-tab active" data-chart-mode-tab="trend" onclick="setChartMode(${line.id}, 'trend')">금일/전일</button><button class="chart-mode-tab" data-chart-mode-tab="compare" onclick="setChartMode(${line.id}, 'compare')">구간 비교</button></div></div></div>
            <div class="chart-wrapper group" id="wrapper-${line.id}"><canvas id="canvas-main-${line.id}"></canvas><div class="chart-overlay-legend" data-ref="trend-legend"><div class="legend-item"><div class="legend-line" style="background:var(--c-chart)"></div>금일</div><div class="legend-item"><div class="legend-line-dash"></div>전일</div></div><div class="chart-overlay-legend" data-ref="compare-legend" style="display:none;"><div class="legend-item"><div class="legend-line" style="background:#6366f1"></div>금일</div><div class="legend-item"><div class="legend-line-dash"></div>전일</div><div class="legend-item"><div class="legend-line" style="background:#22c55e"></div>주간평균</div><div class="legend-item"><div class="legend-line" style="background:#38bdf8"></div>월간평균</div><div class="legend-item"><div class="legend-line" style="background:#facc15"></div>선택기간평균</div></div><div class="time-marker now-marker" data-ref="now-marker"><span class="time-marker-label">NOW</span></div><div class="time-marker hover-marker" data-ref="hover-marker"><span class="time-marker-label" data-ref="hover-time">--:--</span></div><span class="strip-label" data-strip-label="yesterday">전일</span><span class="strip-label" data-strip-label="today" style="color: var(--c-timeline);">금일</span><div class="chart-tooltip" id="tooltip-${line.id}"><div class="tooltip-time">00:00</div><div class="tooltip-row"><span class="val-label">어제</span><span class="val-yest">0</span></div><div class="tooltip-row"><span class="val-label">오늘</span><span class="val-today">0</span></div><div class="tooltip-row border-t border-[#3A3A3C] pt-1 mt-1"><span class="val-label">Avg C/T</span><span class="val-ct">-</span></div></div></div>
            <div class="hourly-compare-panel" data-ref="hourly-compare-panel">
              <div class="hourly-compare-tools">
                <span>특정기간 평균</span>
                <input type="date" data-ref="compare-start">
                <span>~</span>
                <input type="date" data-ref="compare-end">
                <button type="button" onclick="applyHourlyCompareRange(${line.id})">적용</button>
                <button type="button" onclick="resetHourlyCompareRange(${line.id})">초기화</button>
              </div>
            </div>
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
      if (unit === 'pct2') return numeric.toFixed(2);
      if (unit === 'pct') return numeric.toFixed(1);
      return numeric.toLocaleString();
    }

    function formatCompareDelta(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (unit === 'ea') return `${Math.abs(numeric).toLocaleString()}`;
      if (unit === 'min') return `${Math.abs(numeric).toLocaleString()}분`;
      if (unit === 'pct2') return `${Math.abs(numeric).toFixed(2)}`;
      if (unit === 'pct') return `${Math.abs(numeric).toFixed(1)}`;
      return `${Math.abs(numeric).toLocaleString()}`;
    }

    function formatCompareRowValue(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      if (unit === 'pct2') return `${Number(value).toFixed(2)}%`;
      if (unit === 'pct') return `${Number(value).toFixed(1)}%`;
      return Number(value).toLocaleString();
    }

    function formatCompareRowDelta(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (unit === 'pct2') return `${Math.abs(numeric).toFixed(2)}`;
      if (unit === 'pct') return `${Math.abs(numeric).toFixed(1)}`;
      return `${Math.abs(numeric).toLocaleString()}`;
    }

    function formatCompareValue(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (unit === 'ea') return numeric.toLocaleString();
      if (unit === 'hour') return (numeric / 60).toFixed(2);
      if (unit === 'min') return numeric.toLocaleString();
      if (unit === 'pct2') return numeric.toFixed(2);
      if (unit === 'pct') return numeric.toFixed(1);
      return numeric.toLocaleString();
    }

    function formatCompareDelta(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (unit === 'ea') return `${Math.abs(numeric).toLocaleString()}`;
      if (unit === 'hour') return `${(Math.abs(numeric) / 60).toFixed(2)} hr`;
      if (unit === 'min') return `${Math.abs(numeric).toLocaleString()}분`;
      if (unit === 'pct2') return `${Math.abs(numeric).toFixed(2)}`;
      if (unit === 'pct') return `${Math.abs(numeric).toFixed(1)}`;
      return `${Math.abs(numeric).toLocaleString()}`;
    }

    function formatCompareRowValue(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      if (unit === 'pct2') return `${Number(value).toFixed(2)}%`;
      if (unit === 'pct') return `${Number(value).toFixed(1)}%`;
      if (unit === 'hour') return `${(Number(value) / 60).toFixed(2)} hr`;
      return Number(value).toLocaleString();
    }

    function formatCompareRowDelta(value, unit) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (unit === 'pct2') return `${Math.abs(numeric).toFixed(2)}`;
      if (unit === 'pct') return `${Math.abs(numeric).toFixed(1)}`;
      if (unit === 'hour') return `${(Math.abs(numeric) / 60).toFixed(2)}`;
      return `${Math.abs(numeric).toLocaleString()}`;
    }

    function deltaArrow(value, betterWhenLower = false) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      const numeric = Number(value);
      if (numeric === 0) return '=';
      return numeric > 0 ? '▲' : '▼';
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
      yestEl.textContent = formatDeltaDisplay(metric.deltaYesterday, unit, betterWhenLower);
      yestEl.className = `compare-delta-value ${getDeltaClass(metric.deltaYesterday, betterWhenLower)}`;

      const weekEl = panelEl.querySelector(`[data-ref="cmp-${key}-delta-week"]`);
      weekEl.textContent = formatDeltaDisplay(metric.deltaWeek, unit, betterWhenLower);
      weekEl.className = `compare-delta-value ${getDeltaClass(metric.deltaWeek, betterWhenLower)}`;
    }

    function formatDeltaDisplay(value, unit, betterWhenLower = false) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      if (Number(value) === 0) return '-';
      return `${deltaArrow(value, betterWhenLower)} ${formatCompareRowDelta(value, unit)}`;
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

    function extractBlockAlarmSeconds(block) {
      const intervals = mergeSecondIntervals(normalizeAlarmGroups(block || {}).map(group => eventIntervalForDay(group, block)).filter(Boolean));
      return intervals.reduce((sum, item) => sum + Math.max(0, Number(item.end || 0) - Number(item.start || 0)), 0);
    }

    function extractBlockRunSeconds(block) {
      const maxSec = availabilityTimelineLimit(block?.day_key);
      return hourlyTimelineStats(block?.timeline || [], { maxSec }).reduce((sum, item) => sum + Number(item.run_sec || 0), 0);
    }

    function extractRangeAlarmSeconds(block) {
      const dailyBlocks = Array.isArray(block?.daily_hourly_blocks) ? block.daily_hourly_blocks : [];
      if (dailyBlocks.length) {
        return dailyBlocks.reduce((sum, item) => sum + extractBlockAlarmSeconds(item), 0);
      }
      return 0;
    }

    function buildKpiHistorySummary(historyData) {
      if (!historyData) return null;
      const todayRows = buildProductionHourlyRows(historyData.today || {});
      const todayAvailabilityRows = buildProductionHourlyRows(historyData.today || {}, {
        maxSec: availabilityTimelineLimit(historyData.today?.day_key)
      });
      const todayProduction = summarizeProductionHistoryRows(todayRows);
      const todayAvailability = summarizeAvailabilityHistory(historyData.today || {}, todayAvailabilityRows);
      const todayAlarmKpi = summarizeAlarmKpiHistory(historyData.today || {}, 1);

      const yesterdayRows = buildProductionHourlyRows(historyData.yesterday || {});
      const yesterdayProduction = summarizeProductionHistoryRows(yesterdayRows);
      const yesterdayAvailabilityRows = buildProductionHourlyRows(historyData.yesterday || {});
      const yesterdayAvailability = summarizeAvailabilityHistory(historyData.yesterday || {}, yesterdayAvailabilityRows);
      const yesterdayAlarmKpi = summarizeAlarmKpiHistory(historyData.yesterday || {}, 1);

      const todayDuration = extractBlockAlarmSeconds(historyData.today || {});
      const yesterdayDuration = extractBlockAlarmSeconds(historyData.yesterday || {});
      const weekDailyStats = historyData.week?.alarm_daily_stats || [];
      const weekDailyMetrics = historyData.week?.daily_metrics || [];
      const weekDayCount = countActiveDaysFromDailyStats(weekDailyMetrics, weekDailyStats);
      const weekTotalDuration = extractRangeAlarmSeconds(historyData.week || {});
      const weekAvailabilityRows = buildProductionDailyRows(historyData.week || {});
      const weekAvailability = summarizeAvailabilityHistory(historyData.week || {}, weekAvailabilityRows);
      return {
        today: {
          production: todayProduction.total_count,
          direct_yield: todayProduction.direct_yield,
          availability: todayAvailability.availability,
          mttr_min: todayAlarmKpi.mttr_min,
          mtbf_min: todayAlarmKpi.mtbf_min,
          alarm_loss: alarmLossRate(todayDuration, 1)
        },
        yesterday: {
          production: yesterdayProduction.total_count,
          direct_yield: yesterdayProduction.direct_yield,
          availability: yesterdayAvailability.availability,
          mttr_min: yesterdayAlarmKpi.mttr_min,
          mtbf_min: yesterdayAlarmKpi.mtbf_min,
          alarm_loss: alarmLossRate(yesterdayDuration, 1)
        },
        week: {
          availability: weekAvailability.availability,
          alarm_loss: alarmLossRate(weekTotalDuration, weekDayCount)
        }
      };
    }

    function summarizeProductionHistoryRows(rows) {
      const hasData = hasAnyHistoryData(rows);
      const totalCount = rows.reduce((sum, item) => sum + Number(item.total_count || 0), 0);
      const okCount = rows.reduce((sum, item) => sum + Number(item.ok_count || 0), 0);
      const ngCount = rows.reduce((sum, item) => sum + Number(item.ng_count || 0), 0);
      return {
        total_count: hasData ? totalCount : null,
        direct_yield: hasData ? calcDirectYield(okCount, ngCount) : null
      };
    }

    function summarizeAvailabilityHistory(block, rows) {
      const summary = block?.availability_summary || null;
      if (summary) {
        return {
          availability: summary.avail === null || summary.avail === undefined ? null : Number(summary.avail)
        };
      }
      const hasData = hasAnyHistoryData(rows);
      const runSeconds = rows.reduce((sum, item) => sum + Number(item.run_seconds || 0), 0);
      const stopSeconds = rows.reduce((sum, item) => sum + Number(item.stop_seconds || 0), 0);
      const alarmSeconds = rows.reduce((sum, item) => sum + Number(item.alarm_seconds || 0), 0);
      return {
        availability: hasData ? calcUtilizationRate(runSeconds, stopSeconds, alarmSeconds) : null
      };
    }

    function summarizeAlarmKpiHistory(block) {
      const groups = normalizeAlarmGroups(block || {});
      const rows = buildAlarmKpiRows(groups);
      const runSeconds = extractBlockRunSeconds(block || {});
      const count = rows.reduce((sum, item) => sum + Number(item.incident_count ?? item.count ?? 0), 0);
      const duration = rows.reduce((sum, item) => sum + Number(item.duration_sec || 0), 0);
      return {
        mttr_min: count > 0 ? (duration / count) / 60 : null,
        mtbf_min: count > 0 && runSeconds > 0 ? (runSeconds / count) / 60 : null
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
          const summary = buildKpiHistorySummary(historyData);
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
      const headerCompareTimeEl = document.getElementById('headerCompareTime');
      if (headerCompareTimeEl) headerCompareTimeEl.textContent = currentAsOfLabel();
      const mttrUnitEl = panelEl.querySelector('[data-ref="cmp-mttr-today"]')?.nextElementSibling;
      const mtbfUnitEl = panelEl.querySelector('[data-ref="cmp-mtbf-today"]')?.nextElementSibling;
      if (mttrUnitEl) mttrUnitEl.textContent = 'hr';
      if (mtbfUnitEl) mtbfUnitEl.textContent = 'hr';
      const today = comparisons.today || {};
      const yesterday = comparisons.yesterday || {};
      const weekAvg = comparisons.week_avg || {};
      const availabilityHistory = comparisons.availability_history || {};
      const elapsedMinutes = Number(comparisons.elapsed_minutes || 0);
      const runTodayRate = toRate(today.run_minutes, elapsedMinutes);
      const runYesterdayRate = toRate(yesterday.run_minutes, elapsedMinutes);
      const runWeekRate = toRate(weekAvg.run_minutes, elapsedMinutes);
      const alarmTodayRate = historySummary?.today?.alarm_loss ?? alarmLossRate(Number(today.alarm_minutes || 0) * 60, 1);
      const alarmYesterdayRate = historySummary?.yesterday?.alarm_loss ?? alarmLossRate(Number(yesterday.alarm_minutes || 0) * 60, 1);
      const alarmWeekRate = historySummary?.week?.alarm_loss ?? alarmLossRate(Number(weekAvg.alarm_minutes || 0) * 60, Number(weekAvg.sample_size || 1));
      const productionToday = today.production;
      const productionYesterday = yesterday.production;
      const availabilityToday = historySummary?.today?.availability ?? availabilityHistory.today?.availability ?? runTodayRate;
      const availabilityYesterday = historySummary?.yesterday?.availability ?? availabilityHistory.yesterday?.availability ?? runYesterdayRate;
      const availabilityWeek = historySummary?.week?.availability ?? availabilityHistory.week_avg?.availability ?? runWeekRate;
      const alarmLossToday = alarmTodayRate;
      const alarmLossYesterday = alarmYesterdayRate;
      const alarmLossWeek = alarmWeekRate;
      const mttrToday = today.mttr_min;
      const mttrYesterday = yesterday.mttr_min;
      const mtbfToday = today.mtbf_min;
      const mtbfYesterday = yesterday.mtbf_min;
      const directYieldToday = today.direct_yield;
      const directYieldYesterday = yesterday.direct_yield;

      updateCompareMetric(panelEl, 'production', {
        as_of: asOf,
        today: productionToday,
        yesterday: productionYesterday,
        week: weekAvg.production,
        deltaYesterday: productionToday === null || productionToday === undefined || productionYesterday === null || productionYesterday === undefined ? null : productionToday - productionYesterday,
        deltaWeek: productionToday === null || productionToday === undefined || weekAvg.production === null || weekAvg.production === undefined ? null : productionToday - weekAvg.production
      }, 'ea');
      updateCompareMetric(panelEl, 'run', {
        as_of: asOf,
        today: availabilityToday,
        yesterday: availabilityYesterday,
        week: availabilityWeek,
        deltaYesterday: availabilityToday === null || availabilityYesterday === null ? null : availabilityToday - availabilityYesterday,
        deltaWeek: availabilityToday === null || availabilityWeek === null ? null : availabilityToday - availabilityWeek
      }, 'pct');
      updateCompareMetric(panelEl, 'alarm', {
        as_of: asOf,
        today: alarmLossToday,
        yesterday: alarmLossYesterday,
        week: alarmLossWeek,
        deltaYesterday: alarmLossToday === null || alarmLossYesterday === null ? null : alarmLossToday - alarmLossYesterday,
        deltaWeek: alarmLossToday === null || alarmLossWeek === null ? null : alarmLossToday - alarmLossWeek
      }, 'pct2', true);
      updateCompareMetric(panelEl, 'mttr', {
        today: mttrToday,
        yesterday: mttrYesterday,
        week: weekAvg.mttr_min,
        deltaYesterday: mttrToday === null || mttrYesterday === null ? null : mttrToday - mttrYesterday,
        deltaWeek: mttrToday === null || weekAvg.mttr_min === null || weekAvg.mttr_min === undefined ? null : mttrToday - weekAvg.mttr_min
      }, 'hour', true);
      updateCompareMetric(panelEl, 'mtbf', {
        today: mtbfToday,
        yesterday: mtbfYesterday,
        week: weekAvg.mtbf_min,
        deltaYesterday: mtbfToday === null || mtbfYesterday === null ? null : mtbfToday - mtbfYesterday,
        deltaWeek: mtbfToday === null || weekAvg.mtbf_min === null || weekAvg.mtbf_min === undefined ? null : mtbfToday - weekAvg.mtbf_min
      }, 'hour');
      updateCompareMetric(panelEl, 'direct-yield', {
        today: directYieldToday,
        yesterday: directYieldYesterday,
        week: weekAvg.direct_yield,
        deltaYesterday: directYieldToday === null || directYieldYesterday === null ? null : directYieldToday - directYieldYesterday,
        deltaWeek: directYieldToday === null || weekAvg.direct_yield === null || weekAvg.direct_yield === undefined ? null : directYieldToday - weekAvg.direct_yield
      }, 'pct');
    }

    function updatePanel(id, data) {
      const previousChart = CHART_DATA[id] || {};
      const startMinute = Number(data.day_start_minute ?? DAY_START_MINUTE);
      Object.assign(previousChart, {
        dayStartMinute: startMinute,
        yest: normalizeHourlyArray(data.hourly_yesterday || [], startMinute, true),
        today: normalizeHourlyArray(data.hourly_today || [], startMinute),
        run_mins: normalizeHourlyArray(data.hourly_run_mins || [], startMinute),
        timeline_yesterday: data.timeline_yesterday || [],
        timeline_today: data.timeline_today || [],
        chartMode: previousChart.chartMode || 'trend',
        hourlyComparison: previousChart.hourlyComparison || null,
        hourlyComparisonLoadedAt: previousChart.hourlyComparisonLoadedAt || 0,
        hourlyCompareRange: previousChart.hourlyCompareRange || null,
        hourlyCompareLoading: previousChart.hourlyCompareLoading || false,
        stripReveal: Number(previousChart.stripReveal ?? 0),
        stripRevealTarget: Number(previousChart.stripRevealTarget ?? 0),
        stripRevealFrame: previousChart.stripRevealFrame || null,
        stripHideTimer: previousChart.stripHideTimer || null
      });
      CHART_DATA[id] = previousChart;
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
      const targetInput = el.querySelector('[data-ref="target-input"]');
      if (targetInput && document.activeElement !== targetInput) {
        targetInput.value = Number(data.sub?.target || 0);
      }
      const cachedHistorySummary = HISTORY_SUMMARY_CACHE[id]?.data || null;
      updateComparisonCards(el, data, cachedHistorySummary);
      ensureHistorySummary(id).then(summary => {
        const panel = document.getElementById(`panel-${id}`);
        if (panel) updateComparisonCards(panel, data, summary);
      });
      renderAlarmList(el, data.active_alarms || []);
      updateChartModeUi(id);
      if (CHART_DATA[id].chartMode === 'compare') {
        const stale = Date.now() - Number(CHART_DATA[id].hourlyComparisonLoadedAt || 0) > 60000;
        ensureHourlyComparison(id, stale).then(() => renderHourlyComparison(id));
      } else {
        drawCombinedChart(id, CHART_DATA[id].yest, CHART_DATA[id].today, data.timeline_yesterday || [], data.timeline_today || []);
      }
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
            <span class="alarm-meta"><span class="alarm-meta-label">경과</span><span class="alarm-meta-value">${formatElapsedSince(alarm.started_at)}</span></span>
          </span>
        </li>
      `).join('');
    }

    function setChartMode(id, mode) {
      if (!CHART_DATA[id]) CHART_DATA[id] = {};
      CHART_DATA[id].chartMode = mode;
      updateChartModeUi(id);
      if (mode === 'compare') {
        ensureHourlyComparison(id).then(() => renderHourlyComparison(id));
      } else {
        const d = CHART_DATA[id];
        drawCombinedChart(id, d.yest || [], d.today || [], d.timeline_yesterday || [], d.timeline_today || []);
      }
    }

    function updateChartModeUi(id) {
      const panel = document.getElementById(`panel-${id}`);
      const data = CHART_DATA[id];
      if (!panel || !data) return;
      const mode = data.chartMode || 'trend';
      panel.querySelectorAll('[data-chart-mode-tab]').forEach(button => {
        button.classList.toggle('active', button.dataset.chartModeTab === mode);
      });
      const comparePanel = panel.querySelector('[data-ref="hourly-compare-panel"]');
      const trendLegend = panel.querySelector('[data-ref="trend-legend"]');
      const compareLegend = panel.querySelector('[data-ref="compare-legend"]');
      panel.classList.toggle('compare-mode', mode === 'compare');
      if (comparePanel) comparePanel.classList.toggle('open', mode === 'compare');
      if (trendLegend) trendLegend.style.display = mode === 'compare' ? 'none' : 'flex';
      if (compareLegend) compareLegend.style.display = mode === 'compare' ? 'flex' : 'none';
      if (mode === 'compare') {
        if (data.stripHideTimer) {
          clearTimeout(data.stripHideTimer);
          data.stripHideTimer = null;
        }
        setStatusStripReveal(id, false);
      }
      panel.querySelectorAll('.strip-label').forEach(label => {
        label.style.display = mode === 'compare' ? 'none' : 'flex';
      });
      updateHourlyCompareRangeLabel(id);
    }

    function formatDateRangeLabel(start, end) {
      if (!start || !end) return '선택기간: 기본';
      return `선택기간: ${start} ~ ${end}`;
    }

    function updateHourlyCompareRangeLabel(id) {
      const panel = document.getElementById(`panel-${id}`);
      const label = panel?.querySelector('[data-ref="compare-range-label"]');
      const data = CHART_DATA[id];
      if (!label || !data) return;
      const range = data.hourlyCompareRange;
      if (range?.start_day && range?.end_day) {
        label.textContent = formatDateRangeLabel(range.start_day, range.end_day);
        return;
      }
      const payload = data.hourlyComparison;
      const start = payload?.week_avg?.start_day_key;
      const end = payload?.today_day_key;
      label.textContent = formatDateRangeLabel(start, end);
    }

    function hourlyComparisonUrl(id, range = null) {
      const params = new URLSearchParams();
      if (range?.start_day) params.set('start_day', range.start_day);
      if (range?.end_day) params.set('end_day', range.end_day);
      const query = params.toString();
      return `/api/hourly-comparison/${id}${query ? `?${query}` : ''}`;
    }

    async function ensureHourlyComparison(id, force = false) {
      const data = CHART_DATA[id];
      if (!data || data.hourlyCompareLoading) return;
      if (!force && data.hourlyComparison) return;
      data.hourlyCompareLoading = true;
      try {
        const response = await fetch(hourlyComparisonUrl(id, data.hourlyCompareRange), { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        data.hourlyComparison = payload;
        data.hourlyComparisonLoadedAt = Date.now();
      } catch (error) {
        data.hourlyComparison = { error: error.message };
        data.hourlyComparisonLoadedAt = Date.now();
      } finally {
        data.hourlyCompareLoading = false;
      }
    }

    async function applyHourlyCompareRange(id) {
      const panel = document.getElementById(`panel-${id}`);
      const start = panel?.querySelector('[data-ref="compare-start"]')?.value;
      const end = panel?.querySelector('[data-ref="compare-end"]')?.value;
      if (!start || !end) {
        alert('시작일과 종료일을 선택해 주세요.');
        return;
      }
      if (start > end) {
        alert('시작일은 종료일보다 늦을 수 없습니다.');
        return;
      }
      CHART_DATA[id].hourlyCompareRange = { start_day: start, end_day: end };
      CHART_DATA[id].hourlyComparison = null;
      await ensureHourlyComparison(id, true);
      updateHourlyCompareRangeLabel(id);
      renderHourlyComparison(id);
    }

    async function resetHourlyCompareRange(id) {
      CHART_DATA[id].hourlyCompareRange = null;
      CHART_DATA[id].hourlyComparison = null;
      await ensureHourlyComparison(id, true);
      const panel = document.getElementById(`panel-${id}`);
      const startInput = panel?.querySelector('[data-ref="compare-start"]');
      const endInput = panel?.querySelector('[data-ref="compare-end"]');
      if (startInput) startInput.value = '';
      if (endInput) endInput.value = '';
      updateHourlyCompareRangeLabel(id);
      renderHourlyComparison(id);
    }

    function normalizeOptionalHourlyArray(values, startMinute = DAY_START_MINUTE) {
      const src = Array.isArray(values) ? values : [];
      return Array.from({ length: 24 }, (_, idx) => {
        const value = src[slotHourIndex(idx, startMinute)];
        return value === null || value === undefined ? null : Number(value || 0);
      });
    }

    function hourlyCompareRows(payload) {
      const startMinute = Number(payload.day_start_minute ?? DAY_START_MINUTE);
      const today = normalizeHourlyArray(payload.today_counts || [], startMinute);
      const yesterday = normalizeOptionalHourlyArray(payload.yesterday_counts || [], startMinute);
      const week = normalizeOptionalHourlyArray(payload.week_avg?.counts || [], startMinute);
      const month = normalizeOptionalHourlyArray(payload.month_avg?.counts || [], startMinute);
      const custom = payload.custom_avg ? normalizeOptionalHourlyArray(payload.custom_avg.counts || [], startMinute) : Array.from({ length: 24 }, () => null);
      const run = normalizeHourlyArray(payload.today_run_seconds || [], startMinute);
      const alarm = normalizeHourlyArray(payload.today_alarm_seconds || [], startMinute);
      const stop = normalizeHourlyArray(payload.today_stop_seconds || [], startMinute);
      const meal = normalizeHourlyArray(payload.today_meal_seconds || [], startMinute);
      const threshold = Number(payload.low_threshold_pct || 70);
      return Array.from({ length: 24 }, (_, index) => {
        const baseline = custom[index] ?? week[index] ?? month[index] ?? null;
        const achievement = baseline && baseline > 0 ? (Number(today[index] || 0) / baseline) * 100 : null;
        let judge = '정상';
        let judgeClass = 'judge-ok-text';
        if (Number(meal[index] || 0) >= 1800) {
          judge = '식사시간';
          judgeClass = 'judge-muted';
        } else if (Number(alarm[index] || 0) >= 900) {
          judge = '알람 영향';
          judgeClass = 'judge-info-text';
        } else if (Number(run[index] || 0) < 1800) {
          judge = '가동 부족';
          judgeClass = 'judge-muted';
        } else if (achievement !== null && achievement < threshold) {
          judge = '저생산 의심';
          judgeClass = 'judge-low-text';
        }
        return {
          key: slotLabel(index, startMinute),
          today: today[index],
          yesterday: yesterday[index],
          week: week[index],
          month: month[index],
          custom: custom[index],
          run_seconds: run[index],
          stop_seconds: stop[index],
          alarm_seconds: alarm[index],
          achievement,
          judge,
          judgeClass
        };
      });
    }

    function renderHourlyComparison(id) {
      const panel = document.getElementById(`panel-${id}`);
      const data = CHART_DATA[id];
      if (!panel || !data) return;
      if (data.hourlyCompareLoading) {
        return;
      }
      const payload = data.hourlyComparison;
      if (!payload || payload.error) {
        drawHourlyComparisonChart(id, []);
        return;
      }
      const startInput = panel.querySelector('[data-ref="compare-start"]');
      const endInput = panel.querySelector('[data-ref="compare-end"]');
      if (startInput && !startInput.value) startInput.value = payload.week_avg?.start_day_key || payload.today_day_key || '';
      if (endInput && !endInput.value) endInput.value = payload.today_day_key || '';
      updateHourlyCompareRangeLabel(id);
      const rows = hourlyCompareRows(payload);
      drawHourlyComparisonChart(id, rows);
    }

    async function loadDashboard() {
      try {
        const response = await fetch('/api/dashboard', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        DAY_START_MINUTE = Number(payload.day_start_minute ?? ((payload.day_start_hour || 8) * 60));
        DAY_START_HOUR = Math.floor(DAY_START_MINUTE / 60);
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
        updateServerState(true, payload.viewer_count);
      } catch (error) {
        updateServerState(false);
      }
    }

    function startClock() {
      const render = () => {
        const headerCompareTimeEl = document.getElementById('headerCompareTime');
        if (headerCompareTimeEl) headerCompareTimeEl.textContent = currentAsOfLabel();
      };
      render();
      setInterval(render, 1000);
    }

    async function loadAlarmDayGroups(lineId, day) {
      const response = await fetch(`/api/history/${lineId}/alarms/${encodeURIComponent(day)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      return payload.alarm_groups || [];
    }

    async function openYieldHistory(id) {
      const modal = document.getElementById('historyModal');
      const body = document.getElementById('modalBody');
      modal.classList.add('open');
      body.textContent = 'Loading...';
      try {
        const response = await fetch(historyUrl(id), { cache: 'no-store' });
        const data = await response.json();
        HISTORY_MODAL_STATE = { mode: 'yield', period: 'today', data };
        renderHistoryModal();
      } catch (error) {
        body.innerHTML = `<div class="muted">History fetch failed: ${error.message}</div>`;
      }
    }

    async function openKpiHistory(id, mode) {
      const modal = document.getElementById('historyModal');
      const body = document.getElementById('modalBody');
      modal.classList.add('open');
      body.textContent = 'Loading...';
      try {
        const response = await fetch(historyUrl(id), { cache: 'no-store' });
        const data = await response.json();
        HISTORY_MODAL_STATE = { mode, period: 'today', data };
        renderHistoryModal();
      } catch (error) {
        body.innerHTML = `<div class="muted">이력 조회 실패: ${error.message}</div>`;
      }
    }

    function historyUrl(lineId, options = null) {
      const params = new URLSearchParams();
      if (typeof options === 'string' && options) {
        params.set('month', options);
      } else if (options && typeof options === 'object') {
        if (options.month) params.set('month', options.month);
        if (options.start_day) params.set('start_day', options.start_day);
        if (options.end_day) params.set('end_day', options.end_day);
      }
      const query = params.toString();
      return `/api/history/${lineId}${query ? `?${query}` : ''}`;
    }

    async function changeHistoryMonth(month) {
      const { mode, period, data } = HISTORY_MODAL_STATE;
      if (!data || period !== 'month' || !month) return;
      const body = document.getElementById('modalBody');
      body.textContent = 'Loading...';
      try {
        const response = await fetch(historyUrl(data.line_id, month), { cache: 'no-store' });
        const nextData = await response.json();
        HISTORY_MODAL_STATE = { mode, period, data: nextData };
        renderHistoryModal();
      } catch (error) {
        body.innerHTML = `<div class="muted">이력 조회 실패: ${error.message}</div>`;
      }
    }

    async function changeHistoryRange() {
      const { mode, period, data } = HISTORY_MODAL_STATE;
      if (!data || period !== 'month') return;
      const start = document.getElementById('historyRangeStart')?.value;
      const end = document.getElementById('historyRangeEnd')?.value;
      if (!start || !end) {
        alert('시작일과 종료일을 선택해 주세요.');
        return;
      }
      if (start > end) {
        alert('시작일은 종료일보다 늦을 수 없습니다.');
        return;
      }
      const body = document.getElementById('modalBody');
      body.textContent = 'Loading...';
      try {
        const response = await fetch(historyUrl(data.line_id, { start_day: start, end_day: end }), { cache: 'no-store' });
        const nextData = await response.json();
        if (!response.ok) throw new Error(nextData.error || `HTTP ${response.status}`);
        HISTORY_MODAL_STATE = { mode, period, data: nextData };
        renderHistoryModal();
      } catch (error) {
        body.innerHTML = `<div class="muted">이력 조회 실패: ${error.message}</div>`;
      }
    }

    async function resetHistoryRange() {
      const { mode, period, data } = HISTORY_MODAL_STATE;
      if (!data || period !== 'month') return;
      const todayText = data.today?.day_key;
      const today = todayText ? new Date(`${todayText}T00:00:00`) : new Date();
      const day = today.getDay();
      const diffToMonday = day === 0 ? -6 : 1 - day;
      const start = new Date(today);
      start.setDate(today.getDate() + diffToMonday);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      const fmt = (value) => value.toISOString().slice(0, 10);
      const body = document.getElementById('modalBody');
      body.textContent = 'Loading...';
      try {
        const response = await fetch(historyUrl(data.line_id, { start_day: fmt(start), end_day: fmt(end) }), { cache: 'no-store' });
        const nextData = await response.json();
        HISTORY_MODAL_STATE = { mode, period, data: nextData };
        renderHistoryModal();
      } catch (error) {
        body.innerHTML = `<div class="muted">이력 조회 실패: ${error.message}</div>`;
      }
    }

    async function resetHistoryMonth() {
      const { data } = HISTORY_MODAL_STATE;
      if (!data) return;
      const todayText = data.today?.day_key || new Date().toISOString().slice(0, 10);
      const currentMonth = todayText.slice(0, 7);
      await changeHistoryMonth(currentMonth);
    }

    function renderMonthPeriodControls() {
      const { period, data } = HISTORY_MODAL_STATE;
      if (!data || period !== 'month') return '';
      const selectedMonth = data.month?.selected_month || data.month?.start_day_key?.slice(0, 7) || new Date().toISOString().slice(0, 7);
      const rangeStart = data.week?.is_custom_range ? (data.week?.start_day_key || '') : (data.month?.start_day_key || data.today?.day_key || '');
      const rangeEnd = data.week?.is_custom_range ? (data.week?.end_day_key || '') : (data.month?.end_day_key || data.today?.day_key || '');
      const maxDay = data.today?.day_key || new Date().toISOString().slice(0, 10);
      return `
        <div class="range-controls-panel">
          <div class="range-controls-month-row">
            <label class="month-picker-wrap"><span class="range-label-chip">월 선택</span>
              <input class="month-picker" type="month" value="${selectedMonth}" max="${new Date().toISOString().slice(0, 7)}" onchange="changeHistoryMonth(this.value)">
            </label>
            <div class="range-controls-shortcuts">
              <button class="range-picker-button range-shortcut-button range-month-button" type="button" onclick="resetHistoryMonth()">이번달</button>
              <button class="range-picker-button range-shortcut-button range-week-button" type="button" onclick="resetHistoryRange()">이번주</button>
            </div>
          </div>
          <div class="range-controls-range-row">
            <div class="range-picker-wrap">
              <span class="range-label-chip">기간 선택</span>
              <input id="historyRangeStart" class="month-picker" type="date" value="${rangeStart}" max="${maxDay}">
              <span>~</span>
              <input id="historyRangeEnd" class="month-picker" type="date" value="${rangeEnd}" max="${maxDay}">
              <button class="range-picker-button range-apply-button" type="button" onclick="changeHistoryRange()">적용</button>
            </div>
          </div>
        </div>
      `;
    }

    function renderMonthPeriodHeader(title) {
      const controls = renderMonthPeriodControls();
      if (!controls) return `<div class="period-heading"><h4 class="period-title">${title}</h4></div>`;
      return `<div class="period-grid-compact"><h4 class="period-title">${title}</h4>${controls}</div>`;
    }

    function renderMonthPeriodHeaderWithTabs(title, tabsHtml) {
      const controls = renderMonthPeriodControls();
      if (!controls) {
        return `<div><div class="period-heading"><h4 class="period-title">${title}</h4></div>${tabsHtml}</div>`;
      }
      return `<div class="period-grid-header">
        <div class="period-grid-title"><h4 class="period-title">${title}</h4></div>
        <div class="period-grid-controls">${controls}</div>
        <div class="period-grid-tabs">${tabsHtml}</div>
      </div>`;
    }

    function renderMonthPeriodHeaderWithContent(title, contentHtml) {
      const controls = renderMonthPeriodControls();
      if (!controls) {
        return `<div><div class="period-heading"><h4 class="period-title">${title}</h4></div>${contentHtml}</div>`;
      }
      return `<div class="period-grid-header">
        <div class="period-grid-title"><h4 class="period-title">${title}</h4></div>
        <div class="period-grid-controls">${controls}</div>
        <div class="period-grid-tabs">${contentHtml}</div>
      </div>`;
    }

    function handleKpiLinkKey(event, action) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        action();
      }
    }

    function renderHistoryModal() {
      let { mode, period, data } = HISTORY_MODAL_STATE;
      if (!data) return;
      ALARM_DAY_DETAIL_CACHE = {};
      PRODUCTION_DAY_DETAIL_CACHE = {};
      document.getElementById('modalTitle').textContent = historyModalTitle(mode, data.line_name);
      const visiblePeriods = HISTORY_PERIODS;
      const tabs = visiblePeriods.map(item => `
        <button class="history-tab ${item.key === period ? 'active' : ''}" onclick="setHistoryPeriod('${item.key}')">${item.label}</button>
      `).join('');
      const content = renderHistoryContent(mode, period, data);
      const toolbarClass = mode === 'production' ? 'history-toolbar production-history-toolbar' : 'history-toolbar';
      const toolbarContent = mode === 'production'
        ? `<div class="production-toolbar-tabs"><div class="history-tabs">${tabs}</div></div>`
        : `<div class="history-tabs">${tabs}</div>`;
      document.getElementById('modalBody').innerHTML = `<div class="${toolbarClass}">${toolbarContent}</div>${content}`;
    }

    function productionExportRange(data, period) {
      const today = data.today?.day_key || new Date().toISOString().slice(0, 10);
      if (period === 'month') return {
        start: data.week?.is_custom_range ? (data.week?.start_day_key || today) : (data.month?.start_day_key || today),
        end: data.week?.is_custom_range ? (data.week?.end_day_key || today) : (data.month?.end_day_key || today),
        max: today
      };
      if (period === 'yesterday') return {
        start: data.yesterday?.day_key || today,
        end: data.yesterday?.day_key || today,
        max: today
      };
      return { start: today, end: today, max: today };
    }

    async function exportProductionCsv() {
      const { data } = HISTORY_MODAL_STATE;
      if (!data) return;
      const button = document.getElementById('productionExportButton');
      const result = document.getElementById('productionExportResult');
      const start = data.month?.start_day_key;
      const end = data.month?.end_day_key;
      if (!start || !end) {
        alert('저장할 월간 데이터 범위를 찾지 못했습니다.');
        return;
      }
      if (button) button.disabled = true;
      if (result) {
        result.className = 'export-result-note show';
        result.textContent = '데이터 저장 중...';
      }
      try {
        const response = await fetch(`/api/history/${data.line_id}/production-export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start_day: start, end_day: end })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        if (result) {
          result.className = 'export-result-note show';
          result.textContent = '저장 완료_위치 : 바탕화면';
        }
      } catch (error) {
        if (result) {
          result.className = 'export-result-note show error';
          result.textContent = `CSV 저장 실패: ${error.message}`;
        }
      } finally {
        if (button) button.disabled = false;
      }
    }

    function historyModalTitle(mode, lineName) {
      const titles = {
        alarm: '고장률',
        production: '생산 수량',
        yield: '직행률',
        availability: '가동률',
        mttr: 'MTTR',
        mtbf: 'MTBF',
        alarmDetail: '알람 이력',
        alarmLoss: '고장 이력'
      };
      return `${lineName} ${titles[mode] || '생산 / 가동 이력'}`;
    }

    function renderHistoryContent(mode, period, data) {
      if (mode === 'alarm') return renderAlarmPeriodContent(period, data);
      if (mode === 'alarmDetail') return renderAlarmDetailPeriodContent(period, data);
      if (mode === 'yield') return renderYieldPeriodContent(period, data);
      if (mode === 'availability') return renderAvailabilityPeriodContent(period, data);
      if (mode === 'mttr') return renderMttrPeriodContent(period, data);
      if (mode === 'mtbf') return renderMtbfPeriodContent(period, data);
      if (mode === 'alarmLoss') return renderAlarmLossPeriodContent(period, data);
      return renderProductionPeriodContent(period, data);
    }

    function setHistoryPeriod(period) {
      HISTORY_MODAL_STATE.period = period;
      if (period !== 'month') PRODUCTION_RANGE_VIEW = 'summary';
      renderHistoryModal();
    }

    function setProductionRangeView(view) {
      PRODUCTION_RANGE_VIEW = view === 'matrix' ? 'matrix' : 'summary';
      renderHistoryModal();
    }

    async function refreshHistoryModalData() {
      const { mode, period, data } = HISTORY_MODAL_STATE;
      if (!data) return;
      const selectedMonth = period === 'month' ? data.month?.selected_month : null;
      const selectedRange = period === 'month' && data.week?.is_custom_range
        ? { start_day: data.week.start_day_key, end_day: data.week.end_day_key }
        : null;
      const response = await fetch(historyUrl(data.line_id, selectedMonth || selectedRange), { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nextData = await response.json();
      HISTORY_MODAL_STATE = { mode, period, data: nextData };
      renderHistoryModal();
    }

    function renderProductionHistoryBlock(title, block) {
      const rows = buildProductionHourlyRows(block);
      return `<div class="mb-8">
        <h4 class="period-title">${block.day_key}</h4>
        ${renderProductionSummary(rows)}
        <div class="section-title">생산 이력</div>
        <table class="history-table production-history-table mb-4">
          ${renderProductionHead('시간')}
          <tbody>${renderProductionRows(rows, 'slot')}</tbody>
        </table>
      </div>`;
    }

    function renderProductionRangeBlock(title, block) {
      const rows = buildProductionDailyRows(block);
      const activeView = PRODUCTION_RANGE_VIEW === 'matrix' ? 'matrix' : 'summary';
      const viewTabs = renderProductionRangeViewTabs(activeView);
      const monthHeaderAction = title === '월간' ? `
        <div class="section-title-action">
          <button id="productionExportButton" class="range-picker-button csv-export-button" type="button" onclick="exportProductionCsv()">데이터 저장</button>
          <span id="productionExportResult" class="export-result-note"></span>
        </div>
      ` : '';
      if (activeView === 'matrix') {
        return `<div class="mb-8">
          ${renderMonthPeriodHeaderWithTabs(`${block.start_day_key} ~ ${block.end_day_key}`, viewTabs)}
          ${renderProductionQuantityMatrix(block)}
        </div>`;
      }
      return `<div class="mb-8">
        ${renderMonthPeriodHeaderWithTabs(`${block.start_day_key} ~ ${block.end_day_key}`, viewTabs)}
        <div class="section-title section-title-with-action"><span class="section-title-text">생산 이력</span>${monthHeaderAction}</div>
        <table class="history-table production-history-table mb-4">
          ${renderProductionHead('날짜', true)}
          <tbody>${renderProductionRangeRows(rows, block, title)}</tbody>
        </table>
      </div>`;
    }

    function renderProductionRangeViewTabs(activeView) {
      return `<div class="history-view-tabs">
        <button class="history-view-tab ${activeView === 'summary' ? 'active' : ''}" type="button" onclick="setProductionRangeView('summary')">일자별 요약</button>
        <button class="history-view-tab ${activeView === 'matrix' ? 'active' : ''}" type="button" onclick="setProductionRangeView('matrix')">시간대별 수량</button>
      </div>`;
    }

    function renderProductionQuantityMatrix(block) {
      const dayBlocks = [...(block.daily_hourly_blocks || [])].sort((a, b) => String(a.day_key || '').localeCompare(String(b.day_key || '')));
      if (!dayBlocks.length) return `<div class="muted">시간대별 생산 데이터가 없습니다.</div>`;
      const basisSet = new Set(dayBlocks.map(item => Number(item.day_start_minute ?? DAY_START_MINUTE)));
      const mixedNote = basisSet.size > 1
        ? `<div class="history-note">기준 시간이 다른 날짜가 포함되어 있습니다. 기준 변경 전 날짜는 기존 기준으로 집계된 값입니다.</div>`
        : '';
      const columns = dayBlocks.map(dayBlock => {
        const startMinute = Number(dayBlock.day_start_minute ?? DAY_START_MINUTE);
        const rows = buildProductionHourlyRows(dayBlock);
        return {
          dayKey: dayBlock.day_key,
          startMinute,
          values: rows.map(row => Number(row.total_count || 0))
        };
      });
      const currentStartMinute = columns.some(item => item.startMinute === DAY_START_MINUTE)
        ? DAY_START_MINUTE
        : Number(columns[columns.length - 1]?.startMinute ?? DAY_START_MINUTE);
      const hours = Array.from({ length: 24 }, (_, hourIndex) => hourIndex);
      const maxValue = Math.max(0, ...columns.flatMap(item => item.values.map(value => Number(value || 0))));
      const dayTotals = columns.map(item => item.values.reduce((sum, value) => sum + Number(value || 0), 0));
      const header = columns.map(item => `<th class="matrix-day-head">${String(item.dayKey || '').slice(8)}</th>`).join('');
      const body = hours.map(hourIndex => {
        const values = columns.map(item => Number(item.values[hourIndex] || 0));
        const nonZero = values.filter(value => value > 0);
        const average = nonZero.length ? Math.round(nonZero.reduce((sum, value) => sum + value, 0) / nonZero.length) : 0;
        const cells = values.map(value => renderProductionMatrixCell(value, maxValue)).join('');
        return `<tr><td>${slotLabel(hourIndex, currentStartMinute)}</td>${cells}<td>${average > 0 ? average.toLocaleString() : '-'}</td></tr>`;
      }).join('');
      const totalCells = dayTotals.map(value => `<td>${value > 0 ? compactNumber(value) : '-'}</td>`).join('');
      const grandAverage = dayTotals.filter(value => value > 0);
      const averageTotal = grandAverage.length
        ? Math.round(grandAverage.reduce((sum, value) => sum + value, 0) / grandAverage.length)
        : 0;
      return `
        ${mixedNote}
        <div class="section-title">시간대별 생산 수량</div>
        <div class="matrix-fit">
          <table class="history-table production-history-table production-matrix-table production-matrix-compact">
            <thead>
              <tr><th rowspan="2">시간</th><th class="matrix-axis-title" colspan="${columns.length}">일자</th><th rowspan="2">평균</th></tr>
              <tr>${header}</tr>
            </thead>
            <tbody>
              ${body}
              <tr class="matrix-total-row"><td>합계</td>${totalCells}<td>${averageTotal > 0 ? compactNumber(averageTotal) : '-'}</td></tr>
            </tbody>
          </table>
        </div>
      `;
    }

    function renderProductionMatrixCell(value, maxValue) {
      const count = Number(value || 0);
      if (count <= 0) return `<td class="matrix-cell matrix-cell-empty">-</td>`;
      let background = 'rgba(21,128,61,0.12)';
      let color = '#d8dce5';
      if (count > 300) {
        background = 'rgba(34,197,94,0.42)';
      } else if (count > 200) {
        background = 'rgba(34,197,94,0.34)';
      } else if (count > 100) {
        background = 'rgba(34,197,94,0.27)';
      } else if (count > 50) {
        background = 'rgba(34,197,94,0.19)';
      }
      return `<td class="matrix-cell" style="background:${background}; color:${color};">${compactNumber(count)}</td>`;
    }

    function compactNumber(value) {
      const count = Number(value || 0);
      if (Math.abs(count) >= 10000) return `${(count / 1000).toFixed(0)}k`;
      if (Math.abs(count) >= 1000) return `${(count / 1000).toFixed(1)}k`;
      return count.toLocaleString();
    }

    function renderProductionHead(firstLabel, includeDetail = false) {
      return `<thead>
        <tr class="group-head">
          <th class="head-sticky" rowspan="2">${firstLabel}</th>
          <th colspan="2">생산 현황</th>
          <th class="production-group-start" colspan="3">품질</th>
          <th class="production-group-start" colspan="5">가동 상태</th>
          <th class="head-sticky production-group-start" rowspan="2">알람 발생수</th>
          ${includeDetail ? '<th class="head-sticky production-group-start" rowspan="2">세부</th>' : ''}
        </tr>
        <tr class="sub-head">
          <th>생산 수량</th>
          <th>평균 C/T</th>
          <th class="production-group-start">OK</th>
          <th>NG</th>
          <th>직행률</th>
          <th class="production-group-start">가동시간</th>
          <th>비가동시간</th>
          <th>알람시간</th>
          <th>식사시간</th>
          <th>가동률</th>
        </tr>
      </thead>`;
    }

    function buildProductionHourlyRows(block, options = {}) {
      const startMinute = Number(block.day_start_minute ?? DAY_START_MINUTE);
      const counts = normalizeHourlyArray(block.hourly_counts || [], startMinute);
      const okCounts = normalizeHourlyArray(block.hourly_ok_counts || [], startMinute);
      const ngCounts = normalizeHourlyArray(block.hourly_ng_counts || [], startMinute);
      const timelineStats = hourlyTimelineStats(block.timeline || [], options);
      const alarmCounts = hourlyAlarmCounts(block.day_key, block.alarm_groups || [], startMinute);
      const eventAlarmSeconds = hourlyAlarmDurations(block.day_key, block.alarm_groups || [], startMinute);
      return counts.map((count, hour) => {
        let runSec = Number(timelineStats[hour]?.run_sec || 0);
        let stopSec = Number(timelineStats[hour]?.stop_sec || 0);
        const timelineAlarmSec = Number(timelineStats[hour]?.alarm_sec || 0);
        const alarmSec = Math.max(timelineAlarmSec, Number(eventAlarmSeconds[hour] || 0));
        let extraAlarmSec = Math.max(0, alarmSec - timelineAlarmSec);
        const runDeduct = Math.min(runSec, extraAlarmSec);
        runSec -= runDeduct;
        extraAlarmSec -= runDeduct;
        const stopDeduct = Math.min(stopSec, extraAlarmSec);
        stopSec -= stopDeduct;
        const okCount = Number(okCounts[hour] || 0);
        const ngCount = Number(ngCounts[hour] || 0);
        const qualityTotal = okCount + ngCount;
        const totalCount = qualityTotal > 0 ? qualityTotal : Number(count || 0);
        const mealSec = Number(timelineStats[hour]?.meal_sec || 0);
        const cycleBasisSec = runSec + mealSec;
        return {
          key: slotLabel(hour, startMinute),
          total_count: totalCount,
          ok_count: okCount,
          ng_count: ngCount,
          run_seconds: runSec,
          stop_seconds: stopSec,
          alarm_seconds: alarmSec,
          meal_seconds: mealSec,
          no_data_seconds: Number(timelineStats[hour]?.no_data_sec || 0),
          alarm_count: Number(alarmCounts[hour] || 0),
          avg_ct_sec: totalCount > 0 && cycleBasisSec > 0 ? cycleBasisSec / totalCount : null
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
        ...alarmMap.keys(),
        ...(block.daily_hourly_blocks || []).map(item => item.day_key)
      ])).sort();
      return dayKeys.map(dayKey => {
        const metrics = metricsMap.get(dayKey) || {};
        const status = statusMap.get(dayKey) || {};
        const alarm = alarmMap.get(dayKey) || {};
        const okCount = metrics.ok_count === null || metrics.ok_count === undefined ? null : Number(metrics.ok_count);
        const ngCount = metrics.ng_count === null || metrics.ng_count === undefined ? null : Number(metrics.ng_count);
        const qualityTotal = okCount === null || ngCount === null ? 0 : okCount + ngCount;
        const totalCount = qualityTotal > 0 ? qualityTotal : Number(metrics.total_count || 0);
        const runSeconds = Number(status.run_seconds || 0);
        const mealSeconds = Number(status.meal_seconds || 0);
        const cycleBasisSeconds = runSeconds + mealSeconds;
        return {
          key: dayKey,
          total_count: totalCount,
          ok_count: okCount,
          ng_count: ngCount,
          run_seconds: runSeconds,
          stop_seconds: Number(status.stop_seconds || 0),
          alarm_seconds: Number(status.alarm_seconds || 0),
          meal_seconds: mealSeconds,
          no_data_seconds: Number(status.no_data_seconds || 0),
          alarm_count: Number(alarm.count || 0),
          avg_ct_sec: totalCount > 0 && cycleBasisSeconds > 0 ? cycleBasisSeconds / totalCount : null
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

    function hasHistoryData(item) {
      return Number(item.total_count || 0) > 0
        || Number(item.ok_count || 0) > 0
        || Number(item.ng_count || 0) > 0
        || Number(item.run_seconds || 0) > 0
        || Number(item.stop_seconds || 0) > 0
        || Number(item.alarm_seconds || 0) > 0
        || Number(item.meal_seconds || 0) > 0
        || Number(item.no_data_seconds || 0) > 0
        || Number(item.alarm_count || 0) > 0
        || Number(item.count || 0) > 0
        || Number(item.duration_sec || 0) > 0;
    }

    function hasAnyHistoryData(rows) {
      return (rows || []).some(item => hasHistoryData(item));
    }

    function formatNumberOrDash(value, hasData) {
      if (!hasData || value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      return Number(value || 0).toLocaleString();
    }

    function formatPercentOrDash(value, hasData) {
      if (!hasData || value === null || value === undefined || Number.isNaN(Number(value))) return '-';
      return `${Number(value).toFixed(1)}%`;
    }

    function formatHoursWithMinutes(seconds) {
      if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '-';
      const totalSeconds = Math.max(0, Number(seconds || 0));
      const hours = totalSeconds / 3600;
      const minutes = Math.round(totalSeconds / 60);
      return `${hours.toFixed(2)} hr <span class="time-min-note">(${minutes.toLocaleString()} min)</span>`;
    }

    function renderProductionRows(rows, keyType) {
      if (!rows.length) return `<tr><td colspan="12" class="muted">집계 데이터가 없습니다.</td></tr>`;
      return rows.map(item => {
        const hasData = hasHistoryData(item);
        return `
        <tr>
          <td>${item.key}</td>
          <td>${formatNumberOrDash(item.total_count, hasData)}</td>
          <td class="metric-ct">${item.avg_ct_sec ? `${item.avg_ct_sec.toFixed(1)}s` : '-'}</td>
          <td>${formatNumberOrDash(item.ok_count, hasData)}</td>
          <td>${formatNumberOrDash(item.ng_count, hasData)}</td>
          <td class="metric-yield history-metric-yield">${formatPercentOrDash(calcDirectYield(item.ok_count, item.ng_count), hasData)}</td>
          <td>${formatDuration(item.run_seconds)}</td>
          <td>${formatDuration(item.stop_seconds)}</td>
          <td>${formatDuration(item.alarm_seconds)}</td>
          <td>${formatDuration(item.meal_seconds)}</td>
          <td class="metric-avail history-metric-avail">${formatPercentOrDash(calcUtilizationRate(item.run_seconds, item.stop_seconds, item.alarm_seconds), hasData)}</td>
          <td>${formatNumberOrDash(item.alarm_count, hasData)}</td>
        </tr>
      `;
      }).join('');
    }

    function renderProductionRangeRows(rows, block, title) {
      if (!rows.length) return `<tr><td colspan="13" class="muted">집계 데이터가 없습니다.</td></tr>`;
      const hourlyBlockMap = new Map((block.daily_hourly_blocks || []).map(item => [item.day_key, item]));
      const idPrefix = `${title}-${block.start_day_key}-${block.end_day_key}`;
      return [...rows].map(item => {
        const hasData = hasHistoryData(item);
        const dayBlock = hourlyBlockMap.get(item.key);
        const detailRows = dayBlock ? buildProductionHourlyRows(dayBlock) : [];
        const hasDetailData = hasAnyHistoryData(detailRows);
        const detailId = `production-day-${safeDomId(idPrefix)}-${safeDomId(item.key)}`;
        if (hasDetailData) PRODUCTION_DAY_DETAIL_CACHE[detailId] = { day: item.key };
        return `
        <tr>
          <td>${item.key}</td>
          <td>${formatNumberOrDash(item.total_count, hasData)}</td>
          <td class="metric-ct">${item.avg_ct_sec ? `${item.avg_ct_sec.toFixed(1)}s` : '-'}</td>
          <td>${formatNumberOrDash(item.ok_count, hasData)}</td>
          <td>${formatNumberOrDash(item.ng_count, hasData)}</td>
          <td class="metric-yield history-metric-yield">${formatPercentOrDash(calcDirectYield(item.ok_count, item.ng_count), hasData)}</td>
          <td>${formatDuration(item.run_seconds)}</td>
          <td>${formatDuration(item.stop_seconds)}</td>
          <td>${formatDuration(item.alarm_seconds)}</td>
          <td>${formatDuration(item.meal_seconds)}</td>
          <td class="metric-avail history-metric-avail">${formatPercentOrDash(calcUtilizationRate(item.run_seconds, item.stop_seconds, item.alarm_seconds), hasData)}</td>
          <td>${formatNumberOrDash(item.alarm_count, hasData)}</td>
          <td class="production-group-start">${hasDetailData ? `<button class="detail-toggle" onclick="toggleProductionDayDetail('${detailId}')">보기</button>` : '-'}</td>
        </tr>
        ${hasDetailData ? `
        <tr class="production-day-detail" id="${detailId}" style="display:none;">
          <td colspan="13">
            <div class="section-title">${item.key} 시간대별 생산 이력</div>
            <table class="history-table production-history-table">
              ${renderProductionHead('시간')}
              <tbody>${renderProductionRows(detailRows, 'slot')}</tbody>
            </table>
          </td>
        </tr>` : ''}
      `;
      }).join('');
    }

    function renderProductionSummary(rows) {
      const hasData = hasAnyHistoryData(rows);
      const totalCount = rows.reduce((sum, item) => sum + Number(item.total_count || 0), 0);
      const okCount = rows.reduce((sum, item) => sum + Number(item.ok_count || 0), 0);
      const ngCount = rows.reduce((sum, item) => sum + Number(item.ng_count || 0), 0);
      const runSeconds = rows.reduce((sum, item) => sum + Number(item.run_seconds || 0), 0);
      const mealSeconds = rows.reduce((sum, item) => sum + Number(item.meal_seconds || 0), 0);
      const cycleBasisSeconds = runSeconds + mealSeconds;
      const avgCt = totalCount > 0 && cycleBasisSeconds > 0 ? cycleBasisSeconds / totalCount : null;
      return renderPrimaryKpiCard('총 생산수량', `${formatNumberOrDash(totalCount, hasData)} EA`, [
        { label: '총 OK', value: formatNumberOrDash(okCount, hasData) },
        { label: '총 NG', value: formatNumberOrDash(ngCount, hasData) },
        { label: '평균 C/T', value: avgCt ? `${avgCt.toFixed(1)}s` : '-' }
      ], '', '계산식 : 총 OK 수량 + 총 NG 수량');
    }

    function renderMetricCards(cards) {
      return `<div class="loss-summary">${cards.map(card => `
        <div class="loss-card"><span class="loss-label">${card.label}</span><span class="loss-value">${card.value}</span></div>
      `).join('')}</div>`;
    }

    function renderPrimaryKpiCard(label, value, details, refPrefix = '', formula = '') {
      const metaCols = Math.min(Math.max(details.length, 1), 3);
      const valueClass = primaryKpiValueClass(label);
      return `<div class="primary-kpi-card">
        <div class="primary-kpi-head">
          <div class="primary-kpi-title">
            <span class="primary-kpi-label">${label}</span>
          </div>
          <span class="primary-kpi-value ${valueClass}"${refPrefix ? ` data-ref="${refPrefix}-value"` : ''}>${value}</span>
        </div>
        <div class="primary-kpi-meta" style="--primary-meta-cols:${metaCols}">
          ${details.map((item, index) => `
            <div class="primary-kpi-meta-item">
              <span class="primary-kpi-meta-label">${item.label}</span>
              <span class="primary-kpi-meta-value"${refPrefix ? ` data-ref="${refPrefix}-detail-${index}"` : ''}>${item.value}</span>
            </div>
          `).join('')}
        </div>
      </div>`;
    }

    function primaryKpiValueClass(label) {
      if (label === '직행률') return 'history-metric-yield';
      if (label === '가동률') return 'history-metric-avail';
      if (label === '고장률' || label === '고장 이력') return 'history-metric-fault';
      return '';
    }

    function formulaNote(text) {
      return `<span class="formula-note">${text}</span>`;
    }

    function alarmKpiFormula(metric) {
      if (metric === 'mttr') return '계산식: 알람 지속시간 / 알람 발생수';
      if (metric === 'mtbf') return '계산식: 가동시간 / 알람 발생수';
      return '계산식: 알람 지속시간 / 기준시간';
    }

    function renderAvailabilityHistoryBlock(title, block) {
      const rows = buildProductionHourlyRows(block, {
        maxSec: availabilityTimelineLimit(block.day_key)
      });
      return `<div class="mb-8">
        <h4 class="period-title">${block.day_key}</h4>
        ${renderAvailabilitySummary(rows, block.availability_summary)}
        <div class="section-title">가동률</div>
        <table class="history-table mb-4">
          <thead><tr><th>시간</th><th>가동시간</th><th>비가동시간</th><th>알람시간</th><th>식사시간</th><th>서버 OFF</th><th>가동률</th><th>알람 발생수</th></tr></thead>
          <tbody>${renderAvailabilityRows(rows, block.availability_summary)}</tbody>
        </table>
      </div>`;
    }

    function renderAvailabilityRangeBlock(title, block) {
      const rows = buildProductionDailyRows(block);
      return `<div class="mb-8">
        ${renderMonthPeriodHeaderWithContent(`${block.start_day_key} ~ ${block.end_day_key}`, renderAvailabilitySummary(rows))}
        <div class="section-title">날짜별 가동률</div>
        <table class="history-table mb-4">
          <thead><tr><th>날짜</th><th>가동시간</th><th>비가동시간</th><th>알람시간</th><th>식사시간</th><th>서버 OFF</th><th>가동률</th><th>알람 발생수</th></tr></thead>
          <tbody>${renderAvailabilityRows(rows)}</tbody>
        </table>
      </div>`;
    }

    function renderAvailabilitySummary(rows, summary = null) {
      const hasData = hasAnyHistoryData(rows);
      const runSeconds = summary ? Number(summary.run_seconds || 0) : rows.reduce((sum, item) => sum + Number(item.run_seconds || 0), 0);
      const stopSeconds = summary ? Number(summary.stop_seconds || 0) : rows.reduce((sum, item) => sum + Number(item.stop_seconds || 0), 0);
      const alarmSeconds = summary ? Number(summary.alarm_seconds || 0) : rows.reduce((sum, item) => sum + Number(item.alarm_seconds || 0), 0);
      const mealSeconds = summary ? Number(summary.meal_seconds || 0) : rows.reduce((sum, item) => sum + Number(item.meal_seconds || 0), 0);
      const noDataSeconds = summary ? Number(summary.no_data_seconds || 0) : rows.reduce((sum, item) => sum + Number(item.no_data_seconds || 0), 0);
      const rate = summary && summary.avail !== null && summary.avail !== undefined ? Number(summary.avail) : calcUtilizationRate(runSeconds, stopSeconds, alarmSeconds);
      return renderPrimaryKpiCard('가동률', formatPercentOrDash(rate, hasData || !!summary), [
        { label: '총 가동시간', value: formatDuration(runSeconds) },
        { label: '총 비가동시간', value: formatDuration(stopSeconds) },
        { label: '총 알람시간', value: formatDuration(alarmSeconds) },
        { label: '식사시간', value: formatDuration(mealSeconds) },
        { label: '서버 OFF', value: formatDuration(noDataSeconds) }
      ], 'availability-summary', '계산식: 가동시간 / (가동시간 + 비가동시간 + 알람시간), 식사시간/서버 OFF 제외');
    }

    function renderAvailabilityRows(rows, summary = null) {
      if (!rows.length) return `<tr><td colspan="8" class="muted">집계 데이터가 없습니다.</td></tr>`;
      const summaryRow = summary ? `
        <tr class="history-summary-row">
          <td>금일 합계</td>
          <td>${formatDuration(summary.run_seconds)}</td>
          <td>${formatDuration(summary.stop_seconds)}</td>
          <td>${formatDuration(summary.alarm_seconds)}</td>
          <td>${formatDuration(summary.meal_seconds)}</td>
          <td>${formatDuration(summary.no_data_seconds)}</td>
          <td class="history-metric-avail">${formatPercentOrDash(summary.avail, true)}</td>
          <td>-</td>
        </tr>
      ` : '';
      return summaryRow + rows.map(item => {
        const hasData = hasHistoryData(item);
        const rate = calcUtilizationRate(item.run_seconds, item.stop_seconds, item.alarm_seconds);
        return `<tr>
          <td>${item.key}</td>
          <td>${formatDuration(item.run_seconds)}</td>
          <td>${formatDuration(item.stop_seconds)}</td>
          <td>${formatDuration(item.alarm_seconds)}</td>
          <td>${formatDuration(item.meal_seconds)}</td>
          <td>${formatDuration(item.no_data_seconds)}</td>
          <td class="history-metric-avail">${formatPercentOrDash(rate, hasData)}</td>
          <td>${formatNumberOrDash(item.alarm_count, hasData)}</td>
        </tr>`;
      }).join('');
    }

    function renderAlarmKpiHistoryBlock(title, block, metric) {
      const groups = normalizeAlarmGroups(block);
      const rows = buildAlarmKpiRows(groups);
      const runSeconds = extractBlockRunSeconds(block || {});
      const alarmSeconds = extractBlockAlarmSeconds(block || {});
      return `<div class="mb-8">
        <h4 class="period-title">${block.day_key}</h4>
        ${renderAlarmKpiSummary(rows, metric, 1, runSeconds, alarmSeconds)}
        <div class="section-title">${alarmKpiSectionTitle(metric)}</div>
        <table class="history-table mb-4">
          ${renderAlarmKpiHead(metric)}
          <tbody>${renderAlarmKpiRows(rows, metric)}</tbody>
        </table>
      </div>`;
    }

    function renderAlarmKpiRangeBlock(title, block, metric) {
      const dailyStats = normalizeAlarmDailyStats(block);
      const statusStats = block.status_daily_stats || [];
      const dayCount = countActiveDaysFromDailyStats(block.daily_metrics || [], dailyStats);
      const rows = dailyStats.map(item => {
        const status = statusStats.find(row => row.day_key === item.day_key) || {};
        return {
          key: item.day_key,
          count: Number(item.count || 0),
          duration_sec: Number(item.duration_sec || 0),
          run_seconds: Number(status.run_seconds || 0),
          alarm_seconds: Number(status.alarm_seconds || 0)
        };
      });
      const totalAlarmSeconds = rows.reduce((sum, item) => sum + Number(item.alarm_seconds || 0), 0);
      return `<div class="mb-8">
        ${renderMonthPeriodHeaderWithContent(`${block.start_day_key} ~ ${block.end_day_key}`, renderAlarmKpiSummary(rows, metric, dayCount, null, totalAlarmSeconds))}
        <div class="section-title">날짜별 ${alarmKpiSectionTitle(metric)}</div>
        <table class="history-table mb-4">
          ${renderAlarmKpiDailyHead(metric)}
          <tbody>${renderAlarmKpiDailyRows(rows, metric)}</tbody>
        </table>
      </div>`;
    }

    function buildAlarmKpiRows(groups) {
      return (groups || []).map(group => ({
        key: alarmGroupLabel(group),
        started_at: group.started_at,
        ended_at: group.ended_at,
        count: Number(group.items?.length || 1),
        incident_count: 1,
        duration_sec: Number(group.duration_sec || 0),
        run_seconds: 0
      }));
    }

    function renderAlarmKpiSummary(rows, metric, dayCount, runSecondsOverride = null, alarmSecondsOverride = null) {
      const hasData = hasAnyHistoryData(rows) || Number(runSecondsOverride || 0) > 0 || Number(alarmSecondsOverride || 0) > 0;
      const count = rows.reduce((sum, item) => sum + Number(item.incident_count ?? item.count ?? 0), 0);
      const duration = rows.reduce((sum, item) => sum + Number(item.duration_sec || 0), 0);
      const runSeconds = runSecondsOverride === null ? rows.reduce((sum, item) => sum + Number(item.run_seconds || 0), 0) : Number(runSecondsOverride || 0);
      const alarmSeconds = alarmSecondsOverride === null ? rows.reduce((sum, item) => sum + Number(item.alarm_seconds ?? item.duration_sec ?? 0), 0) : Number(alarmSecondsOverride || 0);
      const mttr = count > 0 ? duration / count : null;
      const mtbf = count > 0 && runSeconds > 0 ? runSeconds / count : null;
      const denominator = ALARM_LOSS_DENOMINATOR_SEC * Math.max(1, Number(dayCount || 1));
      const lossRate = denominator > 0 ? (alarmSeconds / denominator) * 100 : 0;
      if (metric === 'mttr') {
        return renderPrimaryKpiCard('MTTR', mttr === null ? '-' : formatHoursWithMinutes(mttr), [
          { label: '알람 발생수', value: formatNumberOrDash(count, hasData) },
          { label: '알람 지속시간', value: formatDuration(duration) }
        ], '', alarmKpiFormula(metric));
      }
      if (metric === 'mtbf') {
        return renderPrimaryKpiCard('MTBF', mtbf === null ? '-' : formatHoursWithMinutes(mtbf), [
          { label: '총 가동시간', value: runSeconds ? formatDuration(runSeconds) : '-' },
          { label: '알람 발생수', value: formatNumberOrDash(count, hasData) }
        ], '', alarmKpiFormula(metric));
      }
      return renderPrimaryKpiCard('고장률', hasData ? `${lossRate.toFixed(2)}%` : '-', [
        { label: '총 고장시간', value: formatDurationWithHours(alarmSeconds) },
        { label: '기준시간', value: formatDuration(denominator) }
      ], '', '계산식: ALARM 상태시간 / 기준시간');
    }

    function alarmKpiSectionTitle(metric) {
      if (metric === 'mttr') return 'MTTR';
      if (metric === 'mtbf') return 'MTBF';
      return '고장률';
    }

    function renderAlarmKpiHead(metric) {
      if (metric === 'alarmLoss') return '<thead><tr><th>발생 알람명</th><th>시작</th><th>해제</th><th>고장시간</th><th>비중</th></tr></thead>';
      return '<thead><tr><th>발생 알람명</th><th>시작</th><th>해제</th><th>지속</th><th>발생횟수</th></tr></thead>';
    }

    function renderAlarmKpiRows(rows, metric) {
      const colspan = metric === 'alarmLoss' ? 5 : 5;
      if (!rows.length) return `<tr><td colspan="${colspan}" class="muted">저장된 알람 사건 이력이 없습니다.</td></tr>`;
      const totalDuration = rows.reduce((sum, item) => sum + Number(item.duration_sec || 0), 0);
      return rows.map(item => `
        <tr>
          <td>${item.key}</td>
          <td>${formatTimeOnly(item.started_at)}</td>
          <td>${formatTimeOnly(item.ended_at)}</td>
          <td>${formatDuration(item.duration_sec)}</td>
          ${metric === 'alarmLoss'
            ? `<td class="history-metric-fault">${formatShareRate(item.duration_sec, totalDuration)}</td>`
            : `<td>${Number(item.count || 0).toLocaleString()}</td>`}
        </tr>
      `).join('');
    }

    function renderAlarmKpiDailyHead(metric) {
      if (metric === 'mttr') return '<thead><tr><th>날짜</th><th>알람 발생수</th><th>알람 지속시간</th><th>MTTR</th></tr></thead>';
      if (metric === 'mtbf') return '<thead><tr><th>날짜</th><th>총 가동시간</th><th>알람 발생수</th><th>MTBF</th></tr></thead>';
      return '<thead><tr><th>날짜</th><th>알람 시간</th><th>고장률</th></tr></thead>';
    }

    function renderAlarmKpiDailyRows(rows, metric) {
      const colspan = metric === 'alarmLoss' ? 3 : 4;
      if (!rows.length) return `<tr><td colspan="${colspan}" class="muted">집계 데이터가 없습니다.</td></tr>`;
      return rows.map(item => {
        const hasData = hasHistoryData(item);
        const count = Number(item.count || 0);
        const mttr = count > 0 ? Number(item.duration_sec || 0) / count : null;
        const mtbf = count > 0 && Number(item.run_seconds || 0) > 0 ? Number(item.run_seconds || 0) / count : null;
        const alarmSeconds = Number(item.alarm_seconds ?? item.duration_sec ?? 0);
        if (metric === 'mttr') {
          return `<tr>
            <td>${item.key}</td>
            <td>${formatNumberOrDash(count, hasData)}</td>
            <td>${formatDuration(item.duration_sec)}</td>
            <td>${mttr === null ? '-' : formatHoursWithMinutes(mttr)}</td>
          </tr>`;
        }
        if (metric === 'mtbf') {
          return `<tr>
            <td>${item.key}</td>
            <td>${formatDuration(item.run_seconds)}</td>
            <td>${formatNumberOrDash(count, hasData)}</td>
            <td>${mtbf === null ? '-' : formatHoursWithMinutes(mtbf)}</td>
          </tr>`;
        }
        return `<tr>
          <td>${item.key}</td>
          <td>${formatDuration(alarmSeconds)}</td>
          <td class="history-metric-fault">${hasData ? formatAlarmLossRate(alarmSeconds) : '-'}</td>
        </tr>`;
      }).join('');
    }

    function availabilityTimelineLimit(dayKey) {
      const todayKey = HISTORY_MODAL_STATE.data?.today?.day_key;
      return dayKey && todayKey && dayKey === todayKey ? currentProductionDaySeconds() : 86400;
    }

    function hourlyTimelineStats(blocks, options = {}) {
      const slots = Array.from({ length: 24 }, () => ({ run_sec: 0, stop_sec: 0, alarm_sec: 0, meal_sec: 0, no_data_sec: 0 }));
      const maxSec = Math.max(0, Math.min(86400, Number(options.maxSec || 86400)));
      timelineBlocksForDisplay(blocks || []).forEach(block => {
        const status = String(block.status || '');
        if (!['RUN', 'STOP', 'ONLINE', 'OFFLINE', 'ALARM', 'MEAL', 'NO_DATA'].includes(status)) return;
        const start = Number(block.startSec || 0);
        const end = Math.min(maxSec, start + Number(block.duration || 0));
        if (start >= maxSec) return;
        for (let hour = 0; hour < 24; hour++) {
          const slotStart = hour * 3600;
          const slotEnd = slotStart + 3600;
          const overlap = Math.max(0, Math.min(end, slotEnd) - Math.max(start, slotStart));
          if (!overlap) continue;
          if (status === 'RUN') slots[hour].run_sec += overlap;
          else if (status === 'ALARM') slots[hour].alarm_sec += overlap;
          else if (status === 'MEAL') slots[hour].meal_sec += overlap;
          else if (status === 'NO_DATA') slots[hour].no_data_sec += overlap;
          else slots[hour].stop_sec += overlap;
        }
      });
      return slots;
    }

    function eventIntervalForDay(event, block) {
      const dayKey = String(block?.day_key || '');
      const startMinute = Number(block?.day_start_minute ?? DAY_START_MINUTE);
      const base = Date.parse(`${dayKey}T${String(Math.floor(startMinute / 60)).padStart(2, '0')}:${String(startMinute % 60).padStart(2, '0')}:00`);
      if (!Number.isFinite(base)) return null;
      const dayEnd = base + 86400000;
      const started = Date.parse(String(event?.started_at || ''));
      if (!Number.isFinite(started)) return null;
      let ended = Date.parse(String(event?.ended_at || ''));
      if (!Number.isFinite(ended)) {
        ended = started + (Math.max(0, Number(event?.duration_sec || 0)) * 1000);
      }
      const startMs = Math.max(base, started);
      const endMs = Math.min(dayEnd, Math.max(ended, startMs));
      if (endMs <= startMs) return null;
      return {
        start: Math.floor((startMs - base) / 1000),
        end: Math.ceil((endMs - base) / 1000)
      };
    }

    function mergeSecondIntervals(intervals) {
      const sorted = [...(intervals || [])]
        .filter(item => item && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
        .sort((left, right) => left.start - right.start);
      const merged = [];
      sorted.forEach(item => {
        const last = merged[merged.length - 1];
        if (!last || item.start > last.end) {
          merged.push({ ...item });
          return;
        }
        last.end = Math.max(last.end, item.end);
      });
      return merged;
    }

    function hourlyAlarmCounts(dayKey, groups, startMinute = DAY_START_MINUTE) {
      const counts = Array.from({ length: 24 }, () => 0);
      const base = Date.parse(`${dayKey}T${String(Math.floor(startMinute / 60)).padStart(2, '0')}:${String(startMinute % 60).padStart(2, '0')}:00`);
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

    function hourlyAlarmDurations(dayKey, groups, startMinute = DAY_START_MINUTE) {
      const seconds = Array.from({ length: 24 }, () => 0);
      const base = Date.parse(`${dayKey}T${String(Math.floor(startMinute / 60)).padStart(2, '0')}:${String(startMinute % 60).padStart(2, '0')}:00`);
      if (!Number.isFinite(base)) return seconds;
      const dayEnd = base + 86400000;
      (groups || []).forEach(group => {
        const started = Date.parse(String(group.started_at || ''));
        if (!Number.isFinite(started)) return;
        let ended = Date.parse(String(group.ended_at || ''));
        if (!Number.isFinite(ended)) {
          const durationMs = Math.max(0, Number(group.duration_sec || 0) * 1000);
          ended = started + durationMs;
        }
        const startMs = Math.max(started, base);
        const endMs = Math.min(Math.max(ended, started), dayEnd);
        if (endMs <= startMs) return;
        for (let hour = 0; hour < 24; hour++) {
          const slotStart = base + (hour * 3600000);
          const slotEnd = slotStart + 3600000;
          const overlapMs = Math.max(0, Math.min(endMs, slotEnd) - Math.max(startMs, slotStart));
          if (overlapMs > 0) seconds[hour] += Math.ceil(overlapMs / 1000);
        }
      });
      return seconds;
    }

    function renderAlarmHistoryBlock(title, block, options = {}) {
      const alarmGroups = normalizeAlarmGroups(block);
      const alarmSummaryRows = renderAlarmGroupSummaryRows(alarmGroups);
      const deleteScope = safeDomId(`alarm-${block.day_key}`);
      const alarmEventRows = renderAlarmGroupRows(alarmGroups, deleteScope);
      return `<div class="mb-8">
        <h4 class="period-title">${block.day_key}</h4>
        ${renderLossSummary(block, alarmGroups, 1)}
        ${options.hideWorst ? '' : renderAlarmImprovementBlock(alarmGroups, 1)}
        <div class="section-title">고장 이력</div>
        <table class="history-table mb-4">
          <thead><tr><th>발생 알람명</th><th>발생횟수</th><th>총 지속시간</th><th>비중</th></tr></thead>
          <tbody>${alarmSummaryRows}</tbody>
        </table>
        <div class="section-title">세부 내역(시간대별)</div>
        ${renderAlarmDeleteToolbar(deleteScope)}
        <table class="history-table">
          <thead><tr><th class="alarm-select-cell">선택</th><th>발생 알람명</th><th>시작</th><th>해제</th><th>지속</th><th>발생횟수</th><th>상태</th></tr></thead>
          <tbody>${alarmEventRows}</tbody>
        </table>
      </div>`;
    }

    function renderAlarmRangeBlock(title, block, options = {}) {
      const dailyStats = normalizeAlarmDailyStats(block);
      const alarmGroups = normalizeAlarmGroups(block);
      const dayCount = countActiveDaysFromDailyStats(block.daily_metrics || [], dailyStats);
      const dailyRows = renderAlarmGroupDailyRows(block, dailyStats, `${block.start_day_key}-${block.end_day_key}`);
      return `<div class="mb-8">
        ${renderMonthPeriodHeaderWithContent(`${block.start_day_key} ~ ${block.end_day_key}`, renderLossSummaryFromDailyStats(block, dailyStats, dayCount))}
        ${options.hideWorst ? '' : renderAlarmImprovementBlock(alarmGroups, dayCount)}
        <div class="section-title">날짜별 고장 이력</div>
        <table class="history-table mb-4">
          <thead><tr><th>날짜</th><th>발생 수</th><th>고장시간</th><th>고장률</th><th>세부</th></tr></thead>
          <tbody>${dailyRows}</tbody>
        </table>
      </div>`;
    }

    function renderAlarmGroupDailyRows(block, dayRows, idPrefix) {
      if (!dayRows.length) return `<tr><td colspan="5" class="muted">집계 데이터가 없습니다.</td></tr>`;
      const dailyBlocks = new Map((block?.daily_hourly_blocks || []).map(item => [item.day_key, item]));
      return [...dayRows].map(item => {
        const hasData = hasHistoryData(item);
        const day = item.day_key;
        const alarmSeconds = extractBlockAlarmSeconds(dailyBlocks.get(day) || { day_key: day, day_start_minute: block?.day_start_minute, alarm_groups: [] });
        const lossRate = ALARM_LOSS_DENOMINATOR_SEC > 0 ? (alarmSeconds / ALARM_LOSS_DENOMINATOR_SEC) * 100 : 0;
        const detailId = `alarm-day-${safeDomId(idPrefix)}-${safeDomId(day)}`;
        ALARM_DAY_DETAIL_CACHE[detailId] = { lineId: HISTORY_MODAL_STATE.data.line_id, day };
        return `
        <tr>
          <td>${day}</td>
          <td>${formatNumberOrDash(item.count, hasData)}</td>
          <td>${formatDuration(alarmSeconds)}</td>
          <td class="history-metric-fault">${hasData ? `${lossRate.toFixed(2)}%` : '-'}</td>
          <td>${item.count ? `<button class="detail-toggle" onclick="toggleAlarmDayDetail('${detailId}')">보기</button>` : '-'}</td>
        </tr>
        <tr class="alarm-day-detail" id="${detailId}" style="display:none;">
          <td colspan="5"><div class="muted">세부 내용을 여는 중입니다.</div></td>
        </tr>
      `;
      }).join('');
    }

    function renderAlarmImprovementBlock(groups, dayCount = 1) {
      const items = buildAlarmImprovementItems(groups, dayCount);
      if (!items.length) {
        return `<div class="improvement-panel"><div class="section-title">Worst 고장 이력</div>
          <table class="history-table mb-4">
            <tbody><tr><td class="muted">Worst 고장 이력을 산출할 고장 이력이 없습니다.</td></tr></tbody>
          </table></div>`;
      }
      return `<div class="improvement-panel"><div class="section-title">Worst 고장 이력</div>
        <table class="history-table mb-4">
          <thead><tr><th>순위</th><th>알람명</th><th>발생횟수</th><th>총 고장시간</th><th>비중</th></tr></thead>
          <tbody>${items.slice(0, 5).map((item, index) => `
            <tr>
              <td>${index + 1}</td>
              <td>${item.label}</td>
              <td>${item.count.toLocaleString()}회</td>
              <td>${formatDuration(item.duration_sec)}</td>
              <td class="history-metric-fault">${item.share.toFixed(1)}%</td>
            </tr>
          `).join('')}</tbody>
        </table></div>`;
    }

    function buildAlarmImprovementItems(groups, dayCount = 1) {
      const summary = new Map();
      (groups || []).forEach(group => {
        const label = alarmGroupLabel(group);
        const current = summary.get(label) || { label, count: 0, duration_sec: 0 };
        current.count += 1;
        current.duration_sec += Number(group.duration_sec || 0);
        summary.set(label, current);
      });
      const totalDuration = [...summary.values()].reduce((sum, item) => sum + Number(item.duration_sec || 0), 0);
      const denominator = ALARM_LOSS_DENOMINATOR_SEC * Math.max(1, Number(dayCount || 1));
      return [...summary.values()]
        .filter(item => item.count > 0 || item.duration_sec > 0)
        .map(item => {
          const avgSec = item.count > 0 ? item.duration_sec / item.count : 0;
          const share = totalDuration > 0 ? (item.duration_sec / totalDuration) * 100 : 0;
          return {
            ...item,
            avg_sec: avgSec,
            share,
            type: alarmImprovementType(item.count, avgSec)
          };
        })
        .sort((left, right) => {
          if (right.duration_sec !== left.duration_sec) return right.duration_sec - left.duration_sec;
          if (right.count !== left.count) return right.count - left.count;
          return left.label.localeCompare(right.label);
        });
    }

    function alarmImprovementType(count, avgSec) {
      if (count >= 3 && avgSec >= 300) return '복합형';
      if (count >= 3) return '빈발형';
      if (avgSec >= 300) return '장시간형';
      return '관찰형';
    }

    function safeDomId(value) {
      return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-');
    }

    function normalizeAlarmGroups(block) {
      return Array.isArray(block?.alarm_groups) ? block.alarm_groups : groupAlarmEvents(block?.alarm_events || []);
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

    function renderLossSummary(block, groups, dayCount) {
      const totalDuration = extractBlockAlarmSeconds(block || {});
      const hasData = (groups || []).some(group => Number(group.duration_sec || 0) > 0 || Number(group.count || group.items?.length || 0) > 0) || totalDuration > 0;
      const totalCount = (groups || []).reduce((sum, group) => sum + Number(group.count || group.items?.length || 1), 0);
      const denominator = ALARM_LOSS_DENOMINATOR_SEC * Math.max(1, Number(dayCount || 1));
      return renderAlarmLossSummaryCard(totalDuration, denominator, totalCount, hasData);
    }

    function renderLossSummaryFromDailyStats(block, dailyStats, dayCount) {
      const totalDuration = extractRangeAlarmSeconds(block || {});
      const hasData = (dailyStats || []).some(item => Number(item.duration_sec || 0) > 0 || Number(item.count || 0) > 0) || totalDuration > 0;
      const totalCount = (dailyStats || []).reduce((sum, item) => sum + Number(item.count || 0), 0);
      const denominator = ALARM_LOSS_DENOMINATOR_SEC * Math.max(1, Number(dayCount || 1));
      return renderAlarmLossSummaryCard(totalDuration, denominator, totalCount, hasData);
    }

    function renderAlarmLossSummaryCard(totalDuration, denominator, totalCount, hasData) {
      const lossRate = denominator > 0 ? (totalDuration / denominator) * 100 : 0;
      return renderPrimaryKpiCard('고장률', hasData ? `${lossRate.toFixed(2)}%` : '-', [
        { label: '총 고장시간', value: formatDurationWithHours(totalDuration) },
        { label: '기준시간', value: formatDuration(denominator) },
        { label: '알람 발생수', value: formatNumberOrDash(totalCount, hasData) }
      ], '', '계산식: ALARM 상태시간 / 기준시간');
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
      const totalDuration = [...summary.values()].reduce((sum, item) => sum + Number(item.duration_sec || 0), 0);
      return [...summary.entries()].map(([label, item]) => {
        return `
        <tr>
          <td>${label}</td>
          <td>${Number(item.count || 0).toLocaleString()}</td>
          <td>${formatDuration(item.duration_sec)}</td>
          <td class="history-metric-fault">${formatShareRate(item.duration_sec, totalDuration)}</td>
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

    function formatDurationWithHours(seconds) {
      const total = Number(seconds || 0);
      if (total <= 0) return '-';
      return `${formatDuration(total)}<span class="value-subline">${(total / 3600).toFixed(2)} hr</span>`;
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

    function alarmGroupEventIds(group) {
      return (group.items || [])
        .map(item => Number(item.id || 0))
        .filter(id => Number.isFinite(id) && id > 0);
    }

    function renderAlarmDeleteToolbar(scopeId) {
      return `<div class="alarm-delete-toolbar">
        <span class="alarm-delete-hint">점검/검사 알람은 선택 삭제로 집계에서 제외</span>
        <button class="alarm-delete-button" type="button" onclick="deleteSelectedAlarmEvents('${scopeId}')">선택 삭제</button>
      </div>`;
    }

    async function deleteSelectedAlarmEvents(scopeId) {
      const checked = [...document.querySelectorAll(`.alarm-select-check[data-alarm-delete-scope="${scopeId}"]:checked`)];
      const eventIds = checked.flatMap(input => {
        try {
          return JSON.parse(input.dataset.eventIds || '[]');
        } catch {
          return [];
        }
      }).map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0);
      const uniqueIds = [...new Set(eventIds)];
      if (!uniqueIds.length) {
        alert('삭제할 알람을 선택해 주세요.');
        return;
      }
      if (!confirm(`선택한 알람 ${uniqueIds.length}건을 이력에서 삭제할까요? 삭제 후 집계에서 제외됩니다.`)) return;
      const response = await fetch('/api/alarm-events/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line_id: HISTORY_MODAL_STATE.data?.line_id, event_ids: uniqueIds })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        alert(`삭제 실패: ${payload.error || response.status}`);
        return;
      }
      await refreshHistoryModalData();
    }

    function renderAlarmGroupRows(groups, idPrefix = 'alarm-detail', showLossRate = false) {
      if (!groups.length) return `<tr><td colspan="7" class="muted">저장된 알람 사건 이력이 없습니다.</td></tr>`;
      const totalDuration = groups.reduce((sum, group) => sum + Number(group.duration_sec || 0), 0);
      return groups.map((group, index) => {
        const detailId = `${safeDomId(idPrefix)}-${index}-${String(group.started_at || '').replace(/[^0-9]/g, '')}`;
        const eventIds = alarmGroupEventIds(group);
        const disabled = eventIds.length ? '' : ' disabled';
        return `
        <tr>
          <td class="alarm-select-cell"><input class="alarm-select-check" type="checkbox" data-alarm-delete-scope="${safeDomId(idPrefix)}" data-event-ids="${JSON.stringify(eventIds)}"${disabled}></td>
          <td>${alarmGroupLabel(group)}</td>
          <td>${formatTimeOnly(group.started_at)}</td>
          <td>${formatTimeOnly(group.ended_at)}</td>
          <td>${formatDuration(group.duration_sec)}</td>
          <td>${Number(group.items.length || 0).toLocaleString()}${group.items.length > 1 ? `<button class="detail-toggle" onclick="toggleAlarmDetail('${detailId}')">보기</button>` : ''}</td>
          <td${showLossRate ? ' class="history-metric-fault"' : ''}>${showLossRate ? formatShareRate(group.duration_sec, totalDuration) : (group.active ? '진행중' : '해제')}</td>
        </tr>
        ${group.items.length > 1 ? `
          <tr class="alarm-group-detail" id="${detailId}" style="display:none;">
            <td colspan="7">${group.items.map(item => `<span>${item.label}</span>`).join('')}</td>
          </tr>
        ` : ''}
      `;
      }).join('');
    }

    function formatShareRate(durationSec, totalDuration) {
      const share = Number(totalDuration || 0) > 0 ? (Number(durationSec || 0) / Number(totalDuration || 0)) * 100 : 0;
      return `${share.toFixed(1)}%`;
    }

    function toggleAlarmDetail(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = el.style.display === 'none' ? 'table-row' : 'none';
    }

    function toggleProductionDayDetail(id) {
      const el = document.getElementById(id);
      if (!el || !PRODUCTION_DAY_DETAIL_CACHE[id]) return;
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
          const deleteScope = safeDomId(`${id}-group`);
          el.querySelector('td').innerHTML = `
            ${renderAlarmDeleteToolbar(deleteScope)}
            <table class="history-table">
              <thead><tr><th class="alarm-select-cell">선택</th><th>발생 알람명</th><th>시작</th><th>해제</th><th>지속</th><th>발생횟수</th><th>비중</th></tr></thead>
              <tbody>${renderAlarmGroupRows(groups, deleteScope, true)}</tbody>
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
      return data.week?.is_custom_range
        ? renderProductionRangeBlock('기간', data.week)
        : renderProductionRangeBlock('월간', data.month);
    }

    function renderAvailabilityPeriodContent(period, data) {
      if (period === 'today') return renderAvailabilityHistoryBlock('금일', data.today);
      if (period === 'yesterday') return renderAvailabilityHistoryBlock('전일', data.yesterday);
      return data.week?.is_custom_range
        ? renderAvailabilityRangeBlock('기간', data.week)
        : renderAvailabilityRangeBlock('월간', data.month);
    }

    function renderAlarmPeriodContent(period, data) {
      if (period === 'today') return renderAlarmHistoryBlock('금일', data.today);
      if (period === 'yesterday') return renderAlarmHistoryBlock('전일', data.yesterday);
      return data.week?.is_custom_range
        ? renderAlarmRangeBlock('기간', data.week)
        : renderAlarmRangeBlock('월간', data.month);
    }

    function renderAlarmDetailPeriodContent(period, data) {
      const options = { hideWorst: true };
      if (period === 'today') return renderAlarmHistoryBlock('금일', data.today, options);
      if (period === 'yesterday') return renderAlarmHistoryBlock('전일', data.yesterday, options);
      return data.week?.is_custom_range
        ? renderAlarmRangeBlock('기간', data.week, options)
        : renderAlarmRangeBlock('월간', data.month, options);
    }

    function renderMttrPeriodContent(period, data) {
      if (period === 'today') return renderAlarmKpiHistoryBlock('금일', data.today, 'mttr');
      if (period === 'yesterday') return renderAlarmKpiHistoryBlock('전일', data.yesterday, 'mttr');
      return data.week?.is_custom_range
        ? renderAlarmKpiRangeBlock('기간', data.week, 'mttr')
        : renderAlarmKpiRangeBlock('월간', data.month, 'mttr');
    }

    function renderMtbfPeriodContent(period, data) {
      if (period === 'today') return renderAlarmKpiHistoryBlock('금일', data.today, 'mtbf');
      if (period === 'yesterday') return renderAlarmKpiHistoryBlock('전일', data.yesterday, 'mtbf');
      return data.week?.is_custom_range
        ? renderAlarmKpiRangeBlock('기간', data.week, 'mtbf')
        : renderAlarmKpiRangeBlock('월간', data.month, 'mtbf');
    }

    function renderAlarmLossPeriodContent(period, data) {
      if (period === 'today') return renderAlarmKpiHistoryBlock('금일', data.today, 'alarmLoss');
      if (period === 'yesterday') return renderAlarmKpiHistoryBlock('전일', data.yesterday, 'alarmLoss');
      return data.week?.is_custom_range
        ? renderAlarmKpiRangeBlock('기간', data.week, 'alarmLoss')
        : renderAlarmKpiRangeBlock('월간', data.month, 'alarmLoss');
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
        ${renderMonthPeriodHeaderWithContent(`${block.start_day_key} ~ ${block.end_day_key}`, renderYieldSummary(rows))}
        <div class="section-title">OK / NG 이력</div>
        <table class="history-table mb-4">
          <thead><tr><th>날짜</th><th>생산 수량</th><th>OK</th><th>NG</th><th>직행률</th></tr></thead>
          <tbody>${renderYieldRows(rows)}</tbody>
        </table>
      </div>`;
    }

    function renderYieldRows(rows) {
      if (!rows.length) return `<tr><td colspan="5" class="muted">집계 데이터가 없습니다.</td></tr>`;
      return rows.map(item => {
        const hasData = hasHistoryData(item);
        return `
        <tr>
          <td>${item.key}</td>
          <td>${formatNumberOrDash(item.total_count, hasData)}</td>
          <td>${formatNumberOrDash(item.ok_count, hasData)}</td>
          <td>${formatNumberOrDash(item.ng_count, hasData)}</td>
          <td class="history-metric-yield">${formatPercentOrDash(calcDirectYield(item.ok_count, item.ng_count), hasData)}</td>
        </tr>
      `;
      }).join('');
    }

    function renderYieldSummary(rows) {
      const hasData = hasAnyHistoryData(rows);
      const totalCount = rows.reduce((sum, item) => sum + Number(item.total_count || 0), 0);
      const okCount = rows.reduce((sum, item) => sum + Number(item.ok_count || 0), 0);
      const ngCount = rows.reduce((sum, item) => sum + Number(item.ng_count || 0), 0);
      const directYield = calcDirectYield(okCount, ngCount);
      return renderPrimaryKpiCard('직행률', formatPercentOrDash(directYield, hasData), [
        { label: '총 생산수량', value: formatNumberOrDash(totalCount, hasData) },
        { label: '총 OK', value: formatNumberOrDash(okCount, hasData) },
        { label: '총 NG', value: formatNumberOrDash(ngCount, hasData) }
      ], '', '계산식: OK / (OK + NG)');
    }

    function renderYieldPeriodContent(period, data) {
      if (period === 'today') return renderYieldHistoryBlock('금일', data.today);
      if (period === 'yesterday') return renderYieldHistoryBlock('전일', data.yesterday);
      return data.week?.is_custom_range
        ? renderYieldRangeBlock('기간', data.week)
        : renderYieldRangeBlock('월간', data.month);
    }

    function closeModal() { document.getElementById('historyModal').classList.remove('open'); }

    function setStatusStripReveal(id, expanded) {
      const d = CHART_DATA[id];
      if (!d) return;
      if ((d.chartMode || 'trend') === 'compare') expanded = false;
      const target = expanded ? 1 : 0;
      if ((d.stripRevealTarget ?? 0) === target) return;
      d.stripRevealTarget = target;
      if (d.stripRevealFrame) cancelAnimationFrame(d.stripRevealFrame);
      const from = Number(d.stripReveal ?? 0);
      const startedAt = performance.now();
      const duration = STATUS_STRIP_REVEAL_MS;
      const ease = progress => 1 - Math.pow(1 - progress, 3);
      const step = now => {
        const progress = Math.min(1, (now - startedAt) / duration);
        d.stripReveal = from + ((target - from) * ease(progress));
        drawCombinedChart(id, d.yest || [], d.today || [], d.timeline_yesterday || [], d.timeline_today || []);
        if (progress < 1) {
          d.stripRevealFrame = requestAnimationFrame(step);
        } else {
          d.stripReveal = target;
          d.stripRevealFrame = null;
          drawCombinedChart(id, d.yest || [], d.today || [], d.timeline_yesterday || [], d.timeline_today || []);
        }
      };
      d.stripRevealFrame = requestAnimationFrame(step);
    }

    function setupInteractions(id) {
      const w = document.getElementById(`wrapper-${id}`);
      const tt = document.getElementById(`tooltip-${id}`);
      w.addEventListener('mouseenter', () => {
        const d = CHART_DATA[id];
        if (d?.stripHideTimer) {
          clearTimeout(d.stripHideTimer);
          d.stripHideTimer = null;
        }
        if ((d?.chartMode || 'trend') === 'compare') return;
        setStatusStripReveal(id, true);
      });
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

        if (d.chartMode === 'compare') {
          const rows = d.hourlyComparison ? hourlyCompareRows(d.hourlyComparison) : [];
          const row = rows[h];
          if (!row) return;
          const hoverMarker = w.querySelector('[data-ref="hover-marker"]');
          const hoverTime = w.querySelector('[data-ref="hover-time"]');
          if (hoverMarker) {
            hoverMarker.style.left = `${plotX + xInPlot}px`;
            hoverMarker.style.display = 'block';
          }
          if (hoverTime) hoverTime.textContent = row.key;
          tt.innerHTML = `
            <div class="tooltip-time">${row.key} 평균 비교</div>
            <div class="tooltip-row"><span>금일</span><span class="val-today">${Number(row.today || 0).toLocaleString()}</span></div>
            <div class="tooltip-row"><span>전일</span><span class="val-yest">${Number(row.yesterday || 0).toLocaleString()}</span></div>
            <div class="tooltip-row"><span>주간평균</span><span class="val-ct">${row.week === null ? '-' : Number(row.week).toFixed(1)}</span></div>
            <div class="tooltip-row"><span>월간평균</span><span class="val-ct">${row.month === null ? '-' : Number(row.month).toFixed(1)}</span></div>
            <div class="tooltip-row"><span>선택평균</span><span class="val-ct">${row.custom === null ? '-' : Number(row.custom).toFixed(1)}</span></div>
          `;
          let left = x + 15;
          if (left + 170 > r.width) left = x - 180;
          tt.style.left = `${left}px`;
          tt.style.top = '10px';
          tt.style.display = 'block';
          return;
        }

        const cursorSec = Math.floor((xInPlot / plotW) * 86400);
        const hoverMarker = w.querySelector('[data-ref="hover-marker"]');
        const hoverTime = w.querySelector('[data-ref="hover-time"]');
        if (hoverMarker) {
          hoverMarker.style.left = `${plotX + xInPlot}px`;
          hoverMarker.style.display = 'block';
        }
        if (hoverTime) hoverTime.textContent = formatProdSecond(cursorSec, d.dayStartMinute);
        const strips = d.stripMeta || {};
        const reveal = Number(d.stripReveal ?? 0);
        const stripHeight = STATUS_STRIP_HEIGHT * reveal;
        const isYestStrip = reveal > 0.12 && y >= (strips.yesterdayY || -1) && y <= (strips.yesterdayY || -1) + stripHeight;
        const isTodayStrip = reveal > 0.12 && y >= (strips.todayY || -1) && y <= (strips.todayY || -1) + stripHeight;
        if (isYestStrip || isTodayStrip) {
          const rowLabel = isTodayStrip ? '금일' : '전일';
          const blocks = timelineBlocksForDisplay(isTodayStrip ? d.timeline_today : d.timeline_yesterday);
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
            <div class="tooltip-time">${rowLabel} 상태</div>
            <div class="tooltip-row"><span>구간</span><span class="val-ct">${formatProdSecond(startSec, d.dayStartMinute)}~${formatProdSecond(endSec, d.dayStartMinute)}</span></div>
            <div class="tooltip-row"><span>상태</span><span style="color:${tooltipStatusColor(block.status)}; font-weight:700;">${statusNameKo(block.status)}</span></div>
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
            <div class="tooltip-time">${slotLabel(h, d.dayStartMinute)}</div>
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
        if (d?.stripHideTimer) clearTimeout(d.stripHideTimer);
        if (d) {
          d.stripHideTimer = setTimeout(() => {
            d.stripHideTimer = null;
            setStatusStripReveal(id, false);
          }, STATUS_STRIP_HIDE_DELAY_MS);
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
      const reveal = Math.max(0, Math.min(1, Number(CHART_DATA[id]?.stripReveal ?? 0)));
      const W = rect.width, H = rect.height, stH = STATUS_STRIP_HEIGHT, stGap = STATUS_STRIP_GAP;
      const stripReserve = reveal * ((stH * 2) + stGap + 4);
      const cH = H - stripReserve - STATUS_AXIS_HEIGHT - 12;
      const plotX = STRIP_LABEL_GUTTER;
      const plotW = Math.max(W - STRIP_LABEL_GUTTER - STRIP_RIGHT_GUTTER, 1);
      const startMinute = CHART_DATA[id]?.dayStartMinute ?? DAY_START_MINUTE;
      const max = fixedYAxisMax(id);
      ctx.fillStyle = '#111113'; ctx.fillRect(0, 0, W, H);
      const step = plotW / 23;
      const gp = (i, v) => ({ x: plotX + (i * step), y: 10 + cH - ((v / max) * cH) });

      const yestSeries = buildPlotSeries(yest, tYest, false);
      const todaySeries = buildPlotSeries(today, tToday, true);
      const gpv = (i, v) => ({ x: plotX + (i * step), y: 10 + cH - ((v / max) * cH) });

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
          ctx.globalAlpha = 1;
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
      const yestStripY = H - STATUS_AXIS_HEIGHT - stripReserve + (reveal * 1);
      const todayStripY = yestStripY + (reveal * (stH + stGap));
      if (reveal > 0.02) {
        drawStrip(timelineBlocksForDisplay(tYest), yestStripY, true, 'yesterday');
        drawStrip(timelineBlocksForDisplay(tToday), todayStripY, false, 'today');
      }
      const wrapper = cvs.parentElement;
      const yestLabel = wrapper.querySelector('[data-strip-label="yesterday"]');
      const todayLabel = wrapper.querySelector('[data-strip-label="today"]');
      if (yestLabel) {
        yestLabel.style.top = `${yestStripY}px`;
        yestLabel.style.opacity = `${reveal}`;
        yestLabel.style.display = reveal > 0.02 ? 'block' : 'none';
      }
      if (todayLabel) {
        todayLabel.style.top = `${todayStripY}px`;
        todayLabel.style.opacity = `${reveal}`;
        todayLabel.style.display = reveal > 0.02 ? 'block' : 'none';
      }
      CHART_DATA[id].stripMeta = { yesterdayY: yestStripY, todayY: todayStripY };

      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#6b7280';
      ctx.strokeStyle = '#3a3a3c';
      ctx.lineWidth = 1;
      for (let hour = 0; hour <= 24; hour += 2) {
        const x = plotX + (hour / 24) * plotW;
        ctx.beginPath();
        const axisBaseY = H - STATUS_AXIS_HEIGHT;
        ctx.moveTo(x, axisBaseY + 2);
        ctx.lineTo(x, axisBaseY + 6);
        ctx.stroke();
        ctx.fillText(slotLabel(hour, startMinute), x, axisBaseY + 7);
      }

      const currentSec = latestDataSecond(tToday);
      const cX = plotX + (currentSec / 86400) * plotW;
      const nowMarker = wrapper.querySelector('[data-ref="now-marker"]');
      if (nowMarker) nowMarker.style.left = `${cX}px`;
    }

    function drawHourlyComparisonChart(id, rows) {
      const cvs = document.getElementById(`canvas-main-${id}`);
      if (!cvs) return;
      const ctx = cvs.getContext('2d');
      const rect = cvs.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (cvs.width !== rect.width * dpr || cvs.height !== rect.height * dpr) {
        cvs.width = rect.width * dpr;
        cvs.height = rect.height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      const W = rect.width;
      const H = rect.height;
      const plotX = STRIP_LABEL_GUTTER;
      const plotW = Math.max(W - STRIP_LABEL_GUTTER - STRIP_RIGHT_GUTTER, 1);
      const startMinute = CHART_DATA[id]?.hourlyComparison?.day_start_minute ?? CHART_DATA[id]?.dayStartMinute ?? DAY_START_MINUTE;
      const plotTop = 10;
      const plotH = Math.max(40, H - STATUS_AXIS_HEIGHT - 20);
      const maxValue = fixedYAxisMax(id);
      ctx.fillStyle = '#111113';
      ctx.fillRect(0, 0, W, H);
      const seriesDefs = [
        { key: 'today', color: C_CHART, width: 2, dash: [] },
        { key: 'yesterday', color: '#8B93A1', width: 1.2, dash: [4, 3] },
        { key: 'week', color: '#22c55e', width: 1.4, dash: [] },
        { key: 'month', color: '#38bdf8', width: 1.4, dash: [] },
        { key: 'custom', color: '#facc15', width: 1.4, dash: [2, 3] }
      ];
      const step = plotW / 23;
      const point = (index, value) => ({
        x: plotX + (index * step),
        y: plotTop + plotH - ((Number(value || 0) / maxValue) * plotH)
      });
      seriesDefs.forEach(def => {
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = def.color;
        ctx.lineWidth = def.width;
        ctx.setLineDash(def.dash);
        let drawing = false;
        rows.forEach((row, index) => {
          const value = row[def.key];
          if (value === null || value === undefined) {
            drawing = false;
            return;
          }
          const p = point(index, value);
          if (!drawing) {
            ctx.moveTo(p.x, p.y);
            drawing = true;
          } else {
            ctx.lineTo(p.x, p.y);
          }
        });
        ctx.stroke();
        ctx.restore();
      });
      rows.forEach((row, index) => {
        if (row.judge !== '저생산 의심') return;
        const x = plotX + (index * step);
        ctx.save();
        ctx.fillStyle = 'rgba(239,68,68,0.16)';
        ctx.fillRect(x - (step / 2), plotTop, Math.max(step, 2), plotH);
        ctx.restore();
      });
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#6b7280';
      ctx.strokeStyle = '#3a3a3c';
      for (let hour = 0; hour <= 24; hour += 2) {
        const x = plotX + (hour / 24) * plotW;
        ctx.beginPath();
        ctx.moveTo(x, H - STATUS_AXIS_HEIGHT + 2);
        ctx.lineTo(x, H - STATUS_AXIS_HEIGHT + 6);
        ctx.stroke();
        ctx.fillText(slotLabel(hour, startMinute), x, H - STATUS_AXIS_HEIGHT + 7);
      }
      const wrapper = cvs.parentElement;
      const nowMarker = wrapper.querySelector('[data-ref="now-marker"]');
      if (nowMarker) nowMarker.style.left = '-999px';
      CHART_DATA[id].stripMeta = {};
    }

  
