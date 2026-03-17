// Calendar Slots Picker - Content Script
// Intercepts mouse events on Google Calendar via a capture overlay

(function () {
  'use strict';

  const DEBUG = true;
  function log(...args) { if (DEBUG) console.log('[CSP]', ...args); }

  const state = {
    slots: [],
    isActive: false,
    drag: null,
    overlay: null,
    gridBounds: null,   // {top, left, width, height} of the actual time grid
    timeAxis: null,
    dayColumns: null,
    highlights: new Map(),
  };

  // ── DOM Detection ────────────────────────────────────────────────

  function parseTimeText(text) {
    text = text.trim();

    // Pattern: "9 AM", "12 PM", "9AM"
    let m = text.match(/^(1[0-2]|[1-9])\s*(AM|PM)$/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const pm = m[2].toUpperCase() === 'PM';
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;
      return h * 60;
    }

    // Pattern: "9:00 AM", "12:00 PM", "9:00", "9:00am"
    m = text.match(/^(1[0-2]|[1-9]):(\d{2})\s*(AM|PM)?$/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const mins = parseInt(m[2], 10);
      const meridiem = m[3]?.toUpperCase();
      if (meridiem === 'PM' && h !== 12) h += 12;
      if (meridiem === 'AM' && h === 12) h = 0;
      return h * 60 + mins;
    }

    // Pattern: "09:00", "14:00" (24-hour)
    m = text.match(/^(0?[0-9]|1[0-9]|2[0-3]):(\d{2})$/);
    if (m) {
      return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }

    // Pattern: "9a", "12p"
    m = text.match(/^(1[0-2]|[1-9])\s*([ap])$/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const pm = m[2].toLowerCase() === 'p';
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;
      return h * 60;
    }

    return null;
  }

  // Find the main calendar grid bounds (excluding sidebar, mini-calendar, toolbar)
  function findGridBounds() {
    // The main grid in Google Calendar week view is typically:
    // - To the right of the sidebar (x > 250)
    // - Below the toolbar (y > 150)
    // - Contains the scrollable time grid

    // Look for role="main" which contains the calendar grid
    const main = document.querySelector('[role="main"]');
    if (main) {
      const rect = main.getBoundingClientRect();
      // The time column is about 60-80px wide on the left of main
      const timeColWidth = 80;
      return {
        top: rect.top,
        left: rect.left + timeColWidth,
        width: rect.width - timeColWidth,
        height: rect.height,
        fullLeft: rect.left, // Include time column for scroll container
      };
    }

    // Fallback: use viewport minus estimated sidebar
    return {
      top: 150,
      left: 300,
      width: window.innerWidth - 300,
      height: window.innerHeight - 150,
      fullLeft: 250,
    };
  }

  function findTimeLabels() {
    const gridBounds = findGridBounds();
    const results = [];
    const checked = new Set();

    // Only look for time labels near the left edge of the main grid
    // (the time axis is typically at x = gridBounds.fullLeft to gridBounds.left)
    const minX = gridBounds.fullLeft - 50;
    const maxX = gridBounds.left + 50;

    const checkElement = (el, text) => {
      if (checked.has(el)) return;
      const mins = parseTimeText(text);
      if (mins === null) return;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      // Filter: must be in the time axis area (left side of main grid)
      if (rect.left < minX || rect.left > maxX) return;
      // Filter: must be below toolbar
      if (rect.top < 100) return;

      results.push({ el, totalMinutes: mins, clientY: rect.top + rect.height / 2, text });
      checked.add(el);
    };

    // Strategy 1: aria-hidden elements (Google Calendar uses these)
    document.querySelectorAll('[aria-hidden="true"]').forEach(el => {
      const text = el.textContent?.trim();
      if (text && text.length <= 10) checkElement(el, text);
    });

    // Strategy 2: data-time attributes
    document.querySelectorAll('[data-time]').forEach(el => {
      checkElement(el, el.getAttribute('data-time'));
    });

    // Strategy 3: small leaf elements with time text
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length > 2) return;
      const text = el.textContent?.trim();
      if (text && text.length <= 10) checkElement(el, text);
    });

    // Sort by Y position and deduplicate by hour
    results.sort((a, b) => a.clientY - b.clientY);

    const byHour = new Map();
    for (const r of results) {
      const hour = Math.floor(r.totalMinutes / 60);
      if (!byHour.has(hour)) {
        byHour.set(hour, r);
      }
    }

    const final = Array.from(byHour.values()).sort((a, b) => a.clientY - b.clientY);
    log('Found time labels:', final.length, final.slice(0, 3).map(r => ({ text: r.text, y: Math.round(r.clientY) })));
    return final;
  }

  function findScrollContainer() {
    const gridBounds = findGridBounds();

    // Find a scrollable container that:
    // 1. Is in the main grid area (not sidebar)
    // 2. Is tall enough to hold the time grid (> 400px)
    // 3. Has overflow-y: auto or scroll

    let best = null;
    let bestScore = 0;

    document.querySelectorAll('*').forEach(el => {
      const s = getComputedStyle(el);
      if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') return;

      const rect = el.getBoundingClientRect();

      // Must be reasonably sized
      if (rect.width < 300 || rect.height < 400) return;

      // Must be in the main area (not the left sidebar)
      if (rect.left < 200) return;

      // Score by area, preferring taller containers
      const score = rect.width * rect.height + rect.height * 100;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });

    if (best) {
      const rect = best.getBoundingClientRect();
      log('Found scroll container:', { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) });
      return best;
    }

    // Fallback: use role="main"
    const main = document.querySelector('[role="main"]');
    if (main) {
      log('Using role=main as scroll container');
      return main;
    }

    log('No scroll container found');
    return null;
  }

  function findDayColumns() {
    const gridBounds = findGridBounds();
    const cols = [];

    // Strategy 1: role="columnheader" elements in the main grid area
    document.querySelectorAll('[role="columnheader"]').forEach(el => {
      const rect = el.getBoundingClientRect();

      // Filter: must be in main grid area (not mini-calendar)
      if (rect.left < gridBounds.left - 20) return;
      // Filter: must have reasonable width for a day column (> 60px)
      if (rect.width < 60) return;

      const date = extractDate(el);
      if (date) cols.push({ clientX: rect.left, width: rect.width, date });
    });

    if (cols.length >= 1 && cols.length <= 7) {
      log('Found day columns via columnheader:', cols.length);
      return cols.sort((a, b) => a.clientX - b.clientX);
    }

    // Strategy 2: data-datekey/data-date elements in main grid area
    const dateCols = [];
    document.querySelectorAll('[data-datekey],[data-date]').forEach(el => {
      const key = el.getAttribute('data-datekey') || el.getAttribute('data-date');
      const m = key && key.match(/(\d{4})-?(\d{2})-?(\d{2})/);
      if (!m) return;

      const rect = el.getBoundingClientRect();

      // Filter: must be in main grid area
      if (rect.left < gridBounds.left - 20) return;
      // Filter: must have reasonable width (> 60px to exclude mini-cal)
      if (rect.width < 60) return;
      // Filter: must be near top (header row)
      if (rect.top > 250) return;

      dateCols.push({
        clientX: rect.left,
        width: rect.width,
        date: new Date(+m[1], +m[2] - 1, +m[3]),
      });
    });

    if (dateCols.length >= 1 && dateCols.length <= 7) {
      log('Found day columns via data attributes:', dateCols.length);
      return dateCols.sort((a, b) => a.clientX - b.clientX);
    }

    // Strategy 3: Create synthetic columns
    log('Creating synthetic day columns');
    const container = findScrollContainer();
    const rect = container ? container.getBoundingClientRect() : gridBounds;

    const today = new Date();
    const dayOfWeek = today.getDay();
    const numCols = 7;
    const colWidth = rect.width / numCols;

    for (let i = 0; i < numCols; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() - dayOfWeek + i);
      cols.push({
        clientX: rect.left + i * colWidth,
        width: colWidth,
        date,
      });
    }

    return cols;
  }

  function extractDate(el) {
    const key = el.getAttribute('data-datekey') || el.getAttribute('data-date');
    if (key) {
      const m = key.match(/(\d{4})-?(\d{2})-?(\d{2})/);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    }

    const label = el.getAttribute('aria-label') || '';
    const dateFromLabel = new Date(label);
    if (!isNaN(dateFromLabel.getTime())) return dateFromLabel;

    const numM = (el.textContent || '').match(/\b(\d{1,2})\b/);
    if (numM) {
      const day = parseInt(numM[1], 10);
      const today = new Date();
      for (let offset = -14; offset <= 14; offset++) {
        const cand = new Date(today);
        cand.setDate(today.getDate() + offset);
        if (cand.getDate() === day) return cand;
      }
    }
    return null;
  }

  // ── Calibration ──────────────────────────────────────────────────

  function calibrate() {
    state.gridBounds = findGridBounds();
    const labels = findTimeLabels();

    if (labels.length >= 2) {
      // Calculate pixels per minute from consecutive labels
      const samples = [];
      for (let i = 1; i < labels.length; i++) {
        const dm = labels[i].totalMinutes - labels[i - 1].totalMinutes;
        const dy = labels[i].clientY - labels[i - 1].clientY;
        if (dm > 0 && dy > 0) samples.push(dy / dm);
      }
      if (samples.length > 0) {
        const pxPerMin = samples.reduce((a, b) => a + b, 0) / samples.length;
        state.timeAxis = { labels, pxPerMin };
        log('Calibrated time axis:', { labelCount: labels.length, pxPerMin: pxPerMin.toFixed(2) });
      }
    }

    // Fallback: use typical Google Calendar ratio (~0.8 px/min)
    if (!state.timeAxis) {
      const container = findScrollContainer();
      const height = container ? container.scrollHeight : 1200;
      const pxPerMin = height / (24 * 60);

      // Create synthetic labels
      const topY = state.gridBounds?.top || 200;
      const syntheticLabels = [];
      for (let h = 0; h < 24; h++) {
        syntheticLabels.push({
          totalMinutes: h * 60,
          clientY: topY + h * 60 * pxPerMin,
        });
      }
      state.timeAxis = { labels: syntheticLabels, pxPerMin };
      log('Using fallback time axis:', { pxPerMin: pxPerMin.toFixed(2) });
    }

    state.dayColumns = findDayColumns();
    return true;
  }

  function getTimeFromY(clientY) {
    if (!state.timeAxis) return 9 * 60;

    const { labels, pxPerMin } = state.timeAxis;

    // Find nearest label
    let best = labels[0];
    for (const l of labels) {
      if (Math.abs(l.clientY - clientY) < Math.abs(best.clientY - clientY)) best = l;
    }

    const deltaMins = (clientY - best.clientY) / pxPerMin;
    const snapped = Math.round(deltaMins / 15) * 15;
    return Math.max(0, Math.min(23 * 60 + 45, best.totalMinutes + snapped));
  }

  function getClientYFromTime(totalMinutes) {
    if (!state.timeAxis) return 200;

    const { labels, pxPerMin } = state.timeAxis;
    const best = labels.reduce((a, b) =>
      Math.abs(b.totalMinutes - totalMinutes) < Math.abs(a.totalMinutes - totalMinutes) ? b : a
    );
    return best.clientY + (totalMinutes - best.totalMinutes) * pxPerMin;
  }

  function getDateFromX(clientX) {
    const cols = state.dayColumns;
    if (!cols || !cols.length) return new Date();

    const found = cols.find(c => clientX >= c.clientX && clientX < c.clientX + c.width);
    if (found) return found.date;

    return cols.reduce((a, b) => {
      const aMid = a.clientX + a.width / 2;
      const bMid = b.clientX + b.width / 2;
      return Math.abs(bMid - clientX) < Math.abs(aMid - clientX) ? b : a;
    }).date;
  }

  // ── Overlay ──────────────────────────────────────────────────────

  function buildOverlay() {
    const container = findScrollContainer();

    const overlay = document.createElement('div');
    overlay.id = 'csp-capture-overlay';

    overlay.addEventListener('mousedown', onMousedown);
    overlay.addEventListener('mousemove', onMousemove);
    overlay.addEventListener('mouseup', onMouseup);
    overlay.addEventListener('mouseleave', onMouseleave);
    overlay.addEventListener('wheel', onWheel, { passive: false });
    overlay.addEventListener('contextmenu', e => e.preventDefault());

    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.scrollContainer = container;
    positionOverlay();
    return true;
  }

  function positionOverlay() {
    if (!state.overlay) return;

    const container = state.scrollContainer;
    let rect;

    if (container) {
      rect = container.getBoundingClientRect();
    } else {
      // Fallback based on grid bounds
      const gb = state.gridBounds || findGridBounds();
      rect = {
        top: gb.top,
        left: gb.fullLeft,
        width: gb.width + (gb.left - gb.fullLeft),
        height: gb.height,
      };
    }

    Object.assign(state.overlay.style, {
      position: 'fixed',
      top: rect.top + 'px',
      left: rect.left + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      zIndex: '999998',
      cursor: 'crosshair',
      background: 'rgba(26, 115, 232, 0.02)',
      border: '2px dashed rgba(26, 115, 232, 0.2)',
      boxSizing: 'border-box',
    });

    log('Overlay positioned:', { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) });
  }

  // ── Mouse Handlers ───────────────────────────────────────────────

  function onMousedown(e) {
    e.preventDefault();
    e.stopPropagation();

    calibrate();

    const startMin = getTimeFromY(e.clientY);
    const date = getDateFromX(e.clientX);

    state.drag = {
      startMin,
      endMin: startMin + 60,
      date,
      clientX: e.clientX,
    };

    log('Drag started:', { time: fmtMin(startMin), date: date.toDateString() });
    renderPreview();
  }

  function onMousemove(e) {
    if (!state.drag) return;
    const newEnd = getTimeFromY(e.clientY);
    if (newEnd > state.drag.startMin) {
      state.drag.endMin = newEnd;
    }
    state.drag.clientX = e.clientX;
    renderPreview();
  }

  function onMouseup(e) {
    if (!state.drag) return;
    commitDrag();
    state.drag = null;
  }

  function onMouseleave(e) {
    if (state.drag) {
      commitDrag();
      state.drag = null;
    }
  }

  function onWheel(e) {
    e.preventDefault();
    if (state.scrollContainer) {
      state.scrollContainer.scrollTop += e.deltaY;
    }
    requestAnimationFrame(() => {
      calibrate();
      refreshHighlights();
    });
  }

  // ── Drag Preview ─────────────────────────────────────────────────

  function renderPreview() {
    if (!state.drag || !state.overlay) return;

    let preview = state.overlay.querySelector('#csp-drag-preview');
    if (!preview) {
      preview = document.createElement('div');
      preview.id = 'csp-drag-preview';
      Object.assign(preview.style, {
        position: 'absolute',
        background: 'rgba(26, 115, 232, 0.35)',
        border: '2px solid #1a73e8',
        borderRadius: '4px',
        pointerEvents: 'none',
        padding: '3px 5px',
        fontSize: '12px',
        fontWeight: '600',
        color: '#1a73e8',
        overflow: 'hidden',
        fontFamily: 'sans-serif',
      });
      state.overlay.appendChild(preview);
    }

    const pos = getSlotPosition(state.drag.date, state.drag.startMin, state.drag.endMin);
    if (!pos) return;

    Object.assign(preview.style, {
      top: pos.top + 'px',
      left: pos.left + 'px',
      width: pos.width + 'px',
      height: Math.max(24, pos.height) + 'px',
    });
    preview.textContent = `${fmtMin(state.drag.startMin)} – ${fmtMin(state.drag.endMin)}`;
  }

  function clearPreview() {
    state.overlay?.querySelector('#csp-drag-preview')?.remove();
  }

  // ── Slot Management ──────────────────────────────────────────────

  function commitDrag() {
    clearPreview();
    if (!state.drag) return;

    let { startMin, endMin, date } = state.drag;
    if (endMin - startMin < 15) endMin = startMin + 30;

    const startTime = minsToTime(startMin);
    const endTime = minsToTime(endMin);

    const slot = {
      id: `${date.toISOString().slice(0, 10)}-${startMin}-${endMin}`,
      date,
      startTime,
      endTime,
      dateString: fmtDate(date),
      startTimeString: fmtTime(startTime.hours, startTime.minutes),
      endTimeString: fmtTime(endTime.hours, endTime.minutes),
    };

    const idx = state.slots.findIndex(s => s.id === slot.id);
    if (idx !== -1) {
      state.slots.splice(idx, 1);
      removeHighlight(slot.id);
    } else {
      state.slots.push(slot);
      state.slots.sort((a, b) => {
        const dd = a.date - b.date;
        return dd !== 0 ? dd : (a.startTime.hours * 60 + a.startTime.minutes) - (b.startTime.hours * 60 + b.startTime.minutes);
      });
      addHighlight(slot);
    }

    notify();
  }

  function removeSlot(slotId) {
    const idx = state.slots.findIndex(s => s.id === slotId);
    if (idx !== -1) {
      removeHighlight(slotId);
      state.slots.splice(idx, 1);
      notify();
    }
  }

  function clearAll() {
    state.slots = [];
    state.highlights.forEach(el => el.remove());
    state.highlights.clear();
    notify();
  }

  // ── Highlights ───────────────────────────────────────────────────

  function getSlotPosition(date, startMin, endMin) {
    if (!state.overlay) return null;

    const overlayRect = state.overlay.getBoundingClientRect();
    const startY = getClientYFromTime(startMin) - overlayRect.top;
    const endY = getClientYFromTime(endMin) - overlayRect.top;
    const height = Math.max(24, endY - startY);

    const cols = state.dayColumns || [];
    let left = 10, width = 100;

    if (cols.length > 0 && date) {
      const col = cols.find(c =>
        c.date.getFullYear() === date.getFullYear() &&
        c.date.getMonth() === date.getMonth() &&
        c.date.getDate() === date.getDate()
      );
      if (col) {
        left = col.clientX - overlayRect.left + 2;
        width = col.width - 4;
      }
    }

    return { top: startY, left, width, height };
  }

  function addHighlight(slot) {
    if (!state.overlay) return;

    const startMin = slot.startTime.hours * 60 + slot.startTime.minutes;
    const endMin = slot.endTime.hours * 60 + slot.endTime.minutes;
    const pos = getSlotPosition(slot.date, startMin, endMin);
    if (!pos) return;

    const el = document.createElement('div');
    el.className = 'csp-slot-highlight';
    el.setAttribute('data-slot-id', slot.id);
    Object.assign(el.style, {
      position: 'absolute',
      background: 'rgba(26, 115, 232, 0.25)',
      border: '2px solid #1a73e8',
      borderRadius: '4px',
      pointerEvents: 'none',
      padding: '2px 4px',
      fontSize: '11px',
      fontWeight: '600',
      color: '#1a73e8',
      overflow: 'hidden',
      fontFamily: 'sans-serif',
      boxShadow: '0 1px 3px rgba(26,115,232,0.3)',
      top: pos.top + 'px',
      left: pos.left + 'px',
      width: pos.width + 'px',
      height: pos.height + 'px',
    });
    el.textContent = `${slot.startTimeString} – ${slot.endTimeString}`;

    state.highlights.set(slot.id, el);
    state.overlay.appendChild(el);
  }

  function removeHighlight(slotId) {
    const el = state.highlights.get(slotId);
    if (el) { el.remove(); state.highlights.delete(slotId); }
  }

  function refreshHighlights() {
    if (!state.overlay) return;

    state.highlights.forEach((el, slotId) => {
      const slot = state.slots.find(s => s.id === slotId);
      if (!slot) return;
      const startMin = slot.startTime.hours * 60 + slot.startTime.minutes;
      const endMin = slot.endTime.hours * 60 + slot.endTime.minutes;
      const pos = getSlotPosition(slot.date, startMin, endMin);
      if (!pos) return;

      Object.assign(el.style, {
        top: pos.top + 'px',
        left: pos.left + 'px',
        width: pos.width + 'px',
        height: pos.height + 'px',
      });
    });
  }

  // ── Utilities ────────────────────────────────────────────────────

  function minsToTime(totalMins) {
    return { hours: Math.floor(totalMins / 60), minutes: totalMins % 60 };
  }

  function fmtMin(totalMins) {
    return fmtTime(Math.floor(totalMins / 60), totalMins % 60);
  }

  function fmtTime(h, m) {
    const mer = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${mer}`;
  }

  function fmtDate(d) {
    return d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
  }

  function notify() {
    chrome.runtime.sendMessage({ type: 'SLOTS_UPDATED', slots: state.slots }).catch(() => {});
  }

  // ── Enable / Disable ─────────────────────────────────────────────

  function enable() {
    if (state.isActive) return;

    calibrate();
    buildOverlay();
    state.isActive = true;

    state.slots.forEach(slot => addHighlight(slot));
    document.body.classList.add('csp-selection-active');
    log('Selection mode enabled');
  }

  function disable() {
    if (!state.isActive) return;
    state.isActive = false;
    if (state.overlay) {
      state.overlay.remove();
      state.overlay = null;
    }
    state.highlights.clear();
    document.body.classList.remove('csp-selection-active');
    log('Selection mode disabled');
  }

  // ── Init ─────────────────────────────────────────────────────────

  function init() {
    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      switch (msg.type) {
        case 'TOGGLE_SELECTION_MODE':
          msg.enabled ? enable() : disable();
          respond({ success: true, enabled: state.isActive });
          break;
        case 'GET_SELECTED_SLOTS':
          respond({ slots: state.slots });
          break;
        case 'CLEAR_SELECTIONS':
          clearAll();
          respond({ success: true });
          break;
        case 'REMOVE_SLOT':
          removeSlot(msg.slotId);
          respond({ success: true });
          break;
      }
      return true;
    });

    document.addEventListener('keydown', e => {
      if (e.altKey && e.key === 's') state.isActive ? disable() : enable();
      if (e.key === 'Escape' && state.isActive) disable();
    });

    window.addEventListener('resize', () => {
      if (state.isActive) {
        calibrate();
        positionOverlay();
        refreshHighlights();
      }
    });

    // Recalibrate on SPA navigation
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => {
          if (state.isActive) {
            calibrate();
            positionOverlay();
            refreshHighlights();
          }
        }, 600);
      }
    }).observe(document.body, { childList: true, subtree: true });

    log('Calendar Slots Picker ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
