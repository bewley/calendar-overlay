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
    scrollContainer: null,
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

    return null;
  }

  function findTimeLabels() {
    const allLabels = [];

    const checkElement = (el, text) => {
      const mins = parseTimeText(text);
      if (mins === null) return;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // Must be visible
      if (rect.top < 50 || rect.top > window.innerHeight) return;

      allLabels.push({
        el,
        totalMinutes: mins,
        clientX: rect.left,
        clientY: rect.top + rect.height / 2,
        text
      });
    };

    // Find all time-like text elements
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length > 2) return;
      const text = el.textContent?.trim();
      if (text && text.length <= 10) checkElement(el, text);
    });

    if (allLabels.length < 2) {
      log('No time labels found');
      return [];
    }

    // Group labels by X position (to separate multiple timezone columns)
    // Use a tolerance of 30px
    const xGroups = [];
    for (const label of allLabels) {
      let found = false;
      for (const group of xGroups) {
        if (Math.abs(group.x - label.clientX) < 30) {
          group.labels.push(label);
          found = true;
          break;
        }
      }
      if (!found) {
        xGroups.push({ x: label.clientX, labels: [label] });
      }
    }

    // Pick the rightmost group (closest to the calendar grid)
    // This handles multiple timezone columns - we want the primary one
    xGroups.sort((a, b) => b.x - a.x);

    // Find the group with the most labels that's reasonably positioned
    let bestGroup = xGroups[0];
    for (const group of xGroups) {
      if (group.labels.length >= bestGroup.labels.length && group.x > 200) {
        bestGroup = group;
        break; // Take the rightmost one with enough labels
      }
    }

    if (!bestGroup || bestGroup.labels.length < 2) {
      log('No suitable time label group found');
      return [];
    }

    // Sort by Y and deduplicate by hour
    const labels = bestGroup.labels.sort((a, b) => a.clientY - b.clientY);
    const byHour = new Map();
    for (const l of labels) {
      const hour = Math.floor(l.totalMinutes / 60);
      if (!byHour.has(hour)) byHour.set(hour, l);
    }

    const final = Array.from(byHour.values()).sort((a, b) => a.clientY - b.clientY);
    log('Time labels:', {
      count: final.length,
      xPos: Math.round(bestGroup.x),
      samples: final.slice(0, 3).map(l => `${l.text}@y${Math.round(l.clientY)}`)
    });
    return final;
  }

  function findScrollContainer() {
    // Look for the main scrollable grid container
    // It should be tall (> 400px) and in the main content area (x > 200)

    let best = null;
    let bestScore = 0;

    document.querySelectorAll('*').forEach(el => {
      const s = getComputedStyle(el);
      const hasScroll = s.overflowY === 'auto' || s.overflowY === 'scroll' ||
                       (el.scrollHeight > el.clientHeight + 50);
      if (!hasScroll) return;

      const rect = el.getBoundingClientRect();
      if (rect.height < 400 || rect.width < 300) return;
      if (rect.left < 150) return; // Exclude sidebar

      // Score by height (prefer taller containers)
      const score = rect.height * 2 + rect.width;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });

    if (best) {
      const rect = best.getBoundingClientRect();
      log('Scroll container:', { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) });
      return best;
    }

    // Fallback to role="main"
    const main = document.querySelector('[role="main"]');
    if (main) {
      log('Using role=main as fallback');
      return main;
    }

    return null;
  }

  function findDayColumns() {
    const cols = [];

    // Strategy 1: Find column headers by role
    document.querySelectorAll('[role="columnheader"]').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 50 || rect.left < 300) return; // Skip time column and sidebar

      const date = extractDate(el);
      if (date) {
        cols.push({ clientX: rect.left, width: rect.width, date });
      }
    });

    if (cols.length >= 1 && cols.length <= 7) {
      cols.sort((a, b) => a.clientX - b.clientX);
      log('Day columns via headers:', cols.length, cols.map(c => `${c.date.getDate()}@x${Math.round(c.clientX)}`));
      return cols;
    }

    // Strategy 2: Find by data attributes, filtering carefully
    document.querySelectorAll('[data-datekey],[data-date]').forEach(el => {
      const key = el.getAttribute('data-datekey') || el.getAttribute('data-date');
      const m = key && key.match(/(\d{4})-?(\d{2})-?(\d{2})/);
      if (!m) return;

      const rect = el.getBoundingClientRect();
      // Must be wide enough to be a day column header (not mini-cal)
      if (rect.width < 50) return;
      // Must be in main area
      if (rect.left < 300) return;
      // Must be near top (header row)
      if (rect.top > 200) return;

      const date = new Date(+m[1], +m[2] - 1, +m[3]);
      // Avoid duplicates
      if (!cols.find(c => c.date.getTime() === date.getTime())) {
        cols.push({ clientX: rect.left, width: rect.width, date });
      }
    });

    if (cols.length >= 1 && cols.length <= 7) {
      cols.sort((a, b) => a.clientX - b.clientX);
      log('Day columns via data attrs:', cols.length);
      return cols;
    }

    // Strategy 3: Create from visible grid based on scroll container
    log('Creating synthetic columns from grid');
    const container = state.scrollContainer || findScrollContainer();
    if (!container) return [];

    const rect = container.getBoundingClientRect();
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 = Sunday

    // For week view: 7 columns, accounting for time labels column (~80px)
    const timeColWidth = 80;
    const gridLeft = rect.left + timeColWidth;
    const gridWidth = rect.width - timeColWidth;
    const numCols = 7;
    const colWidth = gridWidth / numCols;

    for (let i = 0; i < numCols; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() - dayOfWeek + i);
      cols.push({
        clientX: gridLeft + i * colWidth,
        width: colWidth,
        date,
      });
    }

    log('Synthetic columns:', cols.length, `width=${Math.round(colWidth)}`);
    return cols;
  }

  function extractDate(el) {
    const key = el.getAttribute('data-datekey') || el.getAttribute('data-date');
    if (key) {
      const m = key.match(/(\d{4})-?(\d{2})-?(\d{2})/);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    }

    // Try aria-label
    const label = el.getAttribute('aria-label') || '';
    // Look for patterns like "Monday, March 16, 2026"
    const dateMatch = label.match(/(\w+),?\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (dateMatch) {
      const parsed = new Date(label);
      if (!isNaN(parsed.getTime())) return parsed;
    }

    // Try to find day number in text
    const text = el.textContent || '';
    const numM = text.match(/\b(\d{1,2})\b/);
    if (numM) {
      const day = parseInt(numM[1], 10);
      if (day >= 1 && day <= 31) {
        const today = new Date();
        for (let offset = -14; offset <= 14; offset++) {
          const cand = new Date(today);
          cand.setDate(today.getDate() + offset);
          if (cand.getDate() === day) return cand;
        }
      }
    }

    return null;
  }

  // ── Calibration ──────────────────────────────────────────────────

  function calibrate() {
    const labels = findTimeLabels();

    if (labels.length >= 2) {
      // Calculate pixels per minute from consecutive hour labels
      const samples = [];
      for (let i = 1; i < labels.length; i++) {
        const dm = labels[i].totalMinutes - labels[i - 1].totalMinutes;
        const dy = labels[i].clientY - labels[i - 1].clientY;
        if (dm > 0 && dy > 0) {
          samples.push(dy / dm);
        }
      }

      if (samples.length > 0) {
        // Use median to avoid outliers
        samples.sort((a, b) => a - b);
        const pxPerMin = samples[Math.floor(samples.length / 2)];
        state.timeAxis = { labels, pxPerMin };
        log('Calibrated:', { pxPerMin: pxPerMin.toFixed(2), samples: samples.length });
      }
    }

    // Fallback if calibration failed
    if (!state.timeAxis) {
      const container = state.scrollContainer;
      const height = container ? container.scrollHeight : 1200;
      const pxPerMin = height / (24 * 60); // Assume 24 hours

      // Create synthetic labels based on container
      const topY = container ? container.getBoundingClientRect().top : 150;
      const syntheticLabels = [];
      for (let h = 0; h < 24; h++) {
        syntheticLabels.push({
          totalMinutes: h * 60,
          clientY: topY + h * 60 * pxPerMin,
        });
      }
      state.timeAxis = { labels: syntheticLabels, pxPerMin };
      log('Fallback calibration:', { pxPerMin: pxPerMin.toFixed(2) });
    }

    state.dayColumns = findDayColumns();
    return true;
  }

  function getTimeFromY(clientY) {
    if (!state.timeAxis) return 9 * 60;

    const { labels, pxPerMin } = state.timeAxis;

    // Find the two labels that bracket this Y position
    let before = labels[0];
    let after = labels[labels.length - 1];

    for (let i = 0; i < labels.length - 1; i++) {
      if (labels[i].clientY <= clientY && labels[i + 1].clientY >= clientY) {
        before = labels[i];
        after = labels[i + 1];
        break;
      }
    }

    // Interpolate
    const ratio = (clientY - before.clientY) / (after.clientY - before.clientY || 1);
    const mins = before.totalMinutes + ratio * (after.totalMinutes - before.totalMinutes);

    // Snap to 15-minute intervals
    const snapped = Math.round(mins / 15) * 15;
    return Math.max(0, Math.min(23 * 60 + 45, snapped));
  }

  function getClientYFromTime(totalMinutes) {
    if (!state.timeAxis) return 200;

    const { labels, pxPerMin } = state.timeAxis;

    // Find bracketing labels
    for (let i = 0; i < labels.length - 1; i++) {
      if (labels[i].totalMinutes <= totalMinutes && labels[i + 1].totalMinutes >= totalMinutes) {
        const ratio = (totalMinutes - labels[i].totalMinutes) / (labels[i + 1].totalMinutes - labels[i].totalMinutes || 1);
        return labels[i].clientY + ratio * (labels[i + 1].clientY - labels[i].clientY);
      }
    }

    // Extrapolate from nearest label
    const nearest = labels.reduce((a, b) =>
      Math.abs(b.totalMinutes - totalMinutes) < Math.abs(a.totalMinutes - totalMinutes) ? b : a
    );
    return nearest.clientY + (totalMinutes - nearest.totalMinutes) * pxPerMin;
  }

  function getDateFromX(clientX) {
    const cols = state.dayColumns;
    if (!cols || !cols.length) return new Date();

    // Find column containing this X
    for (const col of cols) {
      if (clientX >= col.clientX && clientX < col.clientX + col.width) {
        return col.date;
      }
    }

    // Return nearest
    return cols.reduce((a, b) => {
      const aMid = a.clientX + a.width / 2;
      const bMid = b.clientX + b.width / 2;
      return Math.abs(bMid - clientX) < Math.abs(aMid - clientX) ? b : a;
    }).date;
  }

  function getColumnBounds(date) {
    const cols = state.dayColumns;
    if (!cols || !cols.length || !date) return null;

    const col = cols.find(c =>
      c.date.getFullYear() === date.getFullYear() &&
      c.date.getMonth() === date.getMonth() &&
      c.date.getDate() === date.getDate()
    );

    return col || null;
  }

  // ── Overlay ──────────────────────────────────────────────────────

  function buildOverlay() {
    state.scrollContainer = findScrollContainer();

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
    positionOverlay();
    return true;
  }

  function positionOverlay() {
    if (!state.overlay) return;

    const container = state.scrollContainer;
    const rect = container
      ? container.getBoundingClientRect()
      : { top: 150, left: 350, width: window.innerWidth - 400, height: window.innerHeight - 200 };

    Object.assign(state.overlay.style, {
      position: 'fixed',
      top: rect.top + 'px',
      left: rect.left + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      zIndex: '999998',
      cursor: 'crosshair',
      background: 'rgba(26, 115, 232, 0.02)',
      border: '2px dashed rgba(26, 115, 232, 0.15)',
      boxSizing: 'border-box',
    });

    log('Overlay:', { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) });
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
      endMin: startMin + 30,
      date,
      startY: e.clientY,
    };

    log('Drag:', { time: fmtMin(startMin), date: `${date.getMonth()+1}/${date.getDate()}` });
    renderPreview();
  }

  function onMousemove(e) {
    if (!state.drag) return;

    const currentMin = getTimeFromY(e.clientY);
    if (currentMin > state.drag.startMin) {
      state.drag.endMin = currentMin;
    } else if (currentMin < state.drag.startMin) {
      // Allow dragging up
      state.drag.endMin = state.drag.startMin;
      state.drag.startMin = currentMin;
    }

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
    // Recalibrate after scroll since Y positions change
    requestAnimationFrame(() => {
      calibrate();
      refreshHighlights();
      if (state.drag) renderPreview();
    });
  }

  // ── Preview & Highlights ─────────────────────────────────────────

  function getSlotVisualBounds(date, startMin, endMin) {
    if (!state.overlay) return null;

    const overlayRect = state.overlay.getBoundingClientRect();

    // Get Y positions from time
    const startY = getClientYFromTime(startMin);
    const endY = getClientYFromTime(endMin);

    const top = startY - overlayRect.top;
    const height = Math.max(20, endY - startY);

    // Get X bounds from column
    const col = getColumnBounds(date);
    let left, width;

    if (col) {
      left = col.clientX - overlayRect.left + 2;
      width = col.width - 4;
    } else {
      // Fallback - use click position area
      left = 50;
      width = 100;
    }

    return { top, left, width, height };
  }

  function renderPreview() {
    if (!state.drag || !state.overlay) return;

    let preview = state.overlay.querySelector('#csp-drag-preview');
    if (!preview) {
      preview = document.createElement('div');
      preview.id = 'csp-drag-preview';
      Object.assign(preview.style, {
        position: 'absolute',
        background: 'rgba(26, 115, 232, 0.4)',
        border: '2px solid #1a73e8',
        borderRadius: '4px',
        pointerEvents: 'none',
        padding: '2px 4px',
        fontSize: '11px',
        fontWeight: '600',
        color: 'white',
        overflow: 'hidden',
        fontFamily: 'sans-serif',
        textShadow: '0 1px 2px rgba(0,0,0,0.3)',
      });
      state.overlay.appendChild(preview);
    }

    const bounds = getSlotVisualBounds(state.drag.date, state.drag.startMin, state.drag.endMin);
    if (!bounds) return;

    Object.assign(preview.style, {
      top: bounds.top + 'px',
      left: bounds.left + 'px',
      width: bounds.width + 'px',
      height: bounds.height + 'px',
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

    const startTime = { hours: Math.floor(startMin / 60), minutes: startMin % 60 };
    const endTime = { hours: Math.floor(endMin / 60), minutes: endMin % 60 };

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

  function addHighlight(slot) {
    if (!state.overlay) return;

    const startMin = slot.startTime.hours * 60 + slot.startTime.minutes;
    const endMin = slot.endTime.hours * 60 + slot.endTime.minutes;
    const bounds = getSlotVisualBounds(slot.date, startMin, endMin);
    if (!bounds) return;

    const el = document.createElement('div');
    el.className = 'csp-slot-highlight';
    el.setAttribute('data-slot-id', slot.id);
    Object.assign(el.style, {
      position: 'absolute',
      background: 'rgba(26, 115, 232, 0.3)',
      border: '2px solid #1a73e8',
      borderRadius: '4px',
      pointerEvents: 'none',
      padding: '2px 4px',
      fontSize: '10px',
      fontWeight: '600',
      color: '#1a73e8',
      overflow: 'hidden',
      fontFamily: 'sans-serif',
      top: bounds.top + 'px',
      left: bounds.left + 'px',
      width: bounds.width + 'px',
      height: bounds.height + 'px',
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
    state.highlights.forEach((el, slotId) => {
      const slot = state.slots.find(s => s.id === slotId);
      if (!slot) return;

      const startMin = slot.startTime.hours * 60 + slot.startTime.minutes;
      const endMin = slot.endTime.hours * 60 + slot.endTime.minutes;
      const bounds = getSlotVisualBounds(slot.date, startMin, endMin);
      if (!bounds) return;

      Object.assign(el.style, {
        top: bounds.top + 'px',
        left: bounds.left + 'px',
        width: bounds.width + 'px',
        height: bounds.height + 'px',
      });
    });
  }

  // ── Utilities ────────────────────────────────────────────────────

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
    state.overlay?.remove();
    state.overlay = null;
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

    // Recalibrate on navigation
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
