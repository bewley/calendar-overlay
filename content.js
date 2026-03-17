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

  // Multiple patterns to match time labels in Google Calendar
  const TIME_PATTERNS = [
    /^(1[0-2]|[1-9])\s*(AM|PM)$/i,           // "9 AM", "12 PM"
    /^(1[0-2]|[1-9]):00\s*(AM|PM)?$/i,       // "9:00 AM", "9:00"
    /^(0?[0-9]|1[0-9]|2[0-3]):00$/,          // "09:00", "14:00" (24h)
    /^(1[0-2]|[1-9])\s*[ap]$/i,              // "9a", "12p"
  ];

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
      // If no meridiem and hour <= 12, assume AM for morning, PM for afternoon context
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

  function findTimeLabels() {
    const results = [];
    const checked = new Set();

    // Strategy 1: Look for elements with aria-hidden="true" containing time text
    // (Google Calendar often uses these for the time axis)
    document.querySelectorAll('[aria-hidden="true"]').forEach(el => {
      const text = el.textContent?.trim();
      if (!text || text.length > 10 || checked.has(el)) return;
      checked.add(el);
      const mins = parseTimeText(text);
      if (mins !== null) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          results.push({ el, totalMinutes: mins, clientY: rect.top + rect.height / 2, text });
        }
      }
    });

    // Strategy 2: Look for any small leaf elements with time-like text
    document.querySelectorAll('*').forEach(el => {
      if (checked.has(el)) return;
      if (el.children.length > 2) return;
      const text = el.textContent?.trim();
      if (!text || text.length > 10) return;

      const mins = parseTimeText(text);
      if (mins !== null) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.width < 100) {
          results.push({ el, totalMinutes: mins, clientY: rect.top + rect.height / 2, text });
          checked.add(el);
        }
      }
    });

    // Strategy 3: Check data-time attributes
    document.querySelectorAll('[data-time]').forEach(el => {
      if (checked.has(el)) return;
      const dataTime = el.getAttribute('data-time');
      const mins = parseTimeText(dataTime);
      if (mins !== null) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          results.push({ el, totalMinutes: mins, clientY: rect.top + rect.height / 2, text: dataTime });
          checked.add(el);
        }
      }
    });

    // Sort by Y position
    results.sort((a, b) => a.clientY - b.clientY);

    // Deduplicate: keep only one label per hour, prefer ones on the left side
    const byHour = new Map();
    for (const r of results) {
      const hour = Math.floor(r.totalMinutes / 60);
      const existing = byHour.get(hour);
      if (!existing) {
        byHour.set(hour, r);
      } else {
        // Prefer element further to the left (time axis)
        const existingX = existing.el.getBoundingClientRect().left;
        const newX = r.el.getBoundingClientRect().left;
        if (newX < existingX) {
          byHour.set(hour, r);
        }
      }
    }

    const dedupedResults = Array.from(byHour.values()).sort((a, b) => a.clientY - b.clientY);
    log('Found time labels:', dedupedResults.map(r => ({ text: r.text, mins: r.totalMinutes, y: r.clientY })));
    return dedupedResults;
  }

  function findScrollContainer() {
    // Strategy 1: Find from time labels
    const labels = findTimeLabels();
    if (labels.length > 0) {
      let el = labels[0].el.parentElement;
      while (el && el !== document.body) {
        const s = getComputedStyle(el);
        const isScrollable = s.overflowY === 'auto' || s.overflowY === 'scroll';
        const rect = el.getBoundingClientRect();
        if (isScrollable && rect.width > 200 && rect.height > 200) {
          log('Found scroll container via time labels:', el);
          return el;
        }
        el = el.parentElement;
      }
    }

    // Strategy 2: Look for the main calendar grid area by role
    const mainGrid = document.querySelector('[role="main"] [role="grid"]');
    if (mainGrid) {
      let el = mainGrid;
      while (el && el !== document.body) {
        const s = getComputedStyle(el);
        const isScrollable = s.overflowY === 'auto' || s.overflowY === 'scroll';
        const rect = el.getBoundingClientRect();
        if (isScrollable && rect.width > 200 && rect.height > 200) {
          log('Found scroll container via role grid:', el);
          return el;
        }
        el = el.parentElement;
      }
    }

    // Strategy 3: Find the largest scrollable container in the page
    let best = null;
    let bestArea = 0;
    document.querySelectorAll('*').forEach(el => {
      const s = getComputedStyle(el);
      if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 300 || rect.height < 300) return;
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    });
    if (best) {
      log('Found scroll container via largest scrollable:', best);
      return best;
    }

    // Strategy 4: Just use the main content area
    const main = document.querySelector('[role="main"]');
    if (main) {
      const rect = main.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 200) {
        log('Using role=main as container');
        return main;
      }
    }

    log('Could not find scroll container, will use viewport fallback');
    return null;
  }

  function findDayColumns() {
    const cols = [];

    // Strategy 1: role="columnheader" elements
    document.querySelectorAll('[role="columnheader"]').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 30) return;
      const date = extractDate(el);
      if (date) cols.push({ clientX: rect.left, width: rect.width, date });
    });
    if (cols.length) {
      log('Found day columns via columnheader:', cols.length);
      return cols;
    }

    // Strategy 2: elements with data-datekey / data-date
    document.querySelectorAll('[data-datekey],[data-date]').forEach(el => {
      const key = el.getAttribute('data-datekey') || el.getAttribute('data-date');
      const m = key && key.match(/(\d{4})-?(\d{2})-?(\d{2})/);
      if (!m) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 30) return;
      cols.push({
        clientX: rect.left,
        width: rect.width,
        date: new Date(+m[1], +m[2] - 1, +m[3]),
      });
    });
    if (cols.length) {
      log('Found day columns via data attributes:', cols.length);
      return cols;
    }

    // Strategy 3: Create synthetic columns based on visible grid
    // If in week view, assume 7 columns; if day view, 1 column
    const container = state.scrollContainer;
    if (container) {
      const rect = container.getBoundingClientRect();
      const today = new Date();
      const dayOfWeek = today.getDay(); // 0 = Sunday

      // Assume week view with time column on left (~60px)
      const timeColWidth = 60;
      const gridWidth = rect.width - timeColWidth;
      const numCols = 7; // week view
      const colWidth = gridWidth / numCols;

      for (let i = 0; i < numCols; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() - dayOfWeek + i);
        cols.push({
          clientX: rect.left + timeColWidth + i * colWidth,
          width: colWidth,
          date,
        });
      }
      log('Created synthetic day columns:', cols.length);
    }

    return cols;
  }

  function extractDate(el) {
    // data attribute
    const key = el.getAttribute('data-datekey') || el.getAttribute('data-date');
    if (key) {
      const m = key.match(/(\d{4})-?(\d{2})-?(\d{2})/);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    }

    // aria-label with full date
    const label = el.getAttribute('aria-label') || '';
    // Try parsing as date string
    const dateFromLabel = new Date(label);
    if (!isNaN(dateFromLabel.getTime())) return dateFromLabel;

    // Look for day number
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
    const labels = findTimeLabels();

    if (labels.length >= 2) {
      const samples = [];
      for (let i = 1; i < labels.length; i++) {
        const dm = labels[i].totalMinutes - labels[i - 1].totalMinutes;
        const dy = labels[i].clientY - labels[i - 1].clientY;
        if (dm > 0 && dy > 0) samples.push(dy / dm);
      }
      if (samples.length > 0) {
        const pxPerMin = samples.reduce((a, b) => a + b, 0) / samples.length;
        state.timeAxis = { labels, pxPerMin };
        log('Calibrated time axis:', { labelCount: labels.length, pxPerMin });
      }
    }

    // Fallback: use default pixels-per-minute based on typical calendar
    if (!state.timeAxis) {
      // Typical calendar: ~48px per hour = 0.8 px/min
      // Create synthetic labels for reference
      const container = state.scrollContainer;
      if (container) {
        const rect = container.getBoundingClientRect();
        const scrollHeight = container.scrollHeight || rect.height;
        // Assume 24 hours visible in scrollHeight
        const pxPerMin = scrollHeight / (24 * 60);
        const syntheticLabels = [];
        for (let h = 0; h < 24; h++) {
          syntheticLabels.push({
            totalMinutes: h * 60,
            clientY: rect.top + h * 60 * pxPerMin - (container.scrollTop || 0),
          });
        }
        state.timeAxis = { labels: syntheticLabels, pxPerMin };
        log('Using fallback time axis:', { pxPerMin });
      }
    }

    state.dayColumns = findDayColumns();
    return !!state.timeAxis;
  }

  function getTimeFromY(clientY) {
    if (!state.timeAxis) return 9 * 60; // Default to 9 AM

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

    // Return nearest column
    return cols.reduce((a, b) => {
      const aMid = a.clientX + a.width / 2;
      const bMid = b.clientX + b.width / 2;
      return Math.abs(bMid - clientX) < Math.abs(aMid - clientX) ? b : a;
    }).date;
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

    let rect;
    if (state.scrollContainer) {
      rect = state.scrollContainer.getBoundingClientRect();
    } else {
      // Fallback: cover most of viewport, leaving toolbar area
      rect = {
        top: 64, // Leave space for toolbar
        left: 0,
        width: window.innerWidth,
        height: window.innerHeight - 64,
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
      background: 'rgba(26, 115, 232, 0.03)',
      border: '2px dashed rgba(26, 115, 232, 0.3)',
      boxSizing: 'border-box',
    });

    log('Overlay positioned:', rect);
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
      moved: false,
    };

    log('Drag started:', { startMin, date: date.toDateString() });
    renderPreview();
  }

  function onMousemove(e) {
    if (!state.drag) return;
    const newEnd = getTimeFromY(e.clientY);
    if (newEnd > state.drag.startMin) {
      state.drag.endMin = newEnd;
      state.drag.moved = true;
    }
    state.drag.clientX = e.clientX;
    renderPreview();
  }

  function onMouseup(e) {
    if (!state.drag) return;
    log('Drag ended');
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
    requestAnimationFrame(refreshHighlights);
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

    // If barely dragged, treat as a 30-min click
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

    log('Committing slot:', slot.id);

    const idx = state.slots.findIndex(s => s.id === slot.id);
    if (idx !== -1) {
      state.slots.splice(idx, 1);
      removeHighlight(slot.id);
    } else {
      state.slots.push(slot);
      state.slots.sort((a, b) => {
        const dd = a.date - b.date;
        return dd !== 0 ? dd :
          (a.startTime.hours * 60 + a.startTime.minutes) -
          (b.startTime.hours * 60 + b.startTime.minutes);
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
    let left = 60, width = 100;

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

    calibrate();
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
    if (!state.overlay || !state.timeAxis) return;
    calibrate();

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
    chrome.runtime.sendMessage({ type: 'SLOTS_UPDATED', slots: state.slots })
      .catch(() => {});
  }

  // ── Enable / Disable ─────────────────────────────────────────────

  function enable() {
    if (state.isActive) return;

    calibrate(); // Try to calibrate, but continue even if it fails
    buildOverlay();
    state.isActive = true;

    // Re-render any previously selected slots
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
      positionOverlay();
      requestAnimationFrame(refreshHighlights);
    });

    // Recalibrate when Google Calendar navigates (SPA)
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => {
          calibrate();
          if (state.isActive) {
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
