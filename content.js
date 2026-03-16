// Calendar Slots Picker - Content Script
// Intercepts mouse events on Google Calendar via a capture overlay

(function () {
  'use strict';

  const state = {
    slots: [],
    isActive: false,
    drag: null,          // { startMin, endMin, date, clientX }
    overlay: null,       // the fixed capture div
    scrollContainer: null,
    timeAxis: null,      // { labels:[{clientY, totalMinutes}], pxPerMin }
    dayColumns: null,    // [{clientX, width, date}]
    highlights: new Map(), // slotId -> HTMLElement
  };

  // ── DOM Detection ────────────────────────────────────────────────

  // Walk ALL elements looking for short text matching "1 AM", "2 PM", etc.
  function findTimeLabels() {
    const pattern = /^(1[0-2]|[1-9])\s*(AM|PM)$/i;
    const results = [];

    document.querySelectorAll('*').forEach(el => {
      // Only look at leaf-ish nodes
      if (el.children.length > 2) return;
      const text = (el.innerText || el.textContent || '').trim();
      if (!pattern.test(text)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const m = text.match(pattern);
      let h = parseInt(m[1], 10);
      const pm = m[2].toUpperCase() === 'PM';
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;

      results.push({ el, totalMinutes: h * 60, clientY: rect.top + rect.height / 2 });
    });

    results.sort((a, b) => a.clientY - b.clientY);
    // Deduplicate by totalMinutes (keep first occurrence per hour)
    const seen = new Set();
    return results.filter(r => {
      if (seen.has(r.totalMinutes)) return false;
      seen.add(r.totalMinutes);
      return true;
    });
  }

  function findScrollContainer() {
    const labels = findTimeLabels();
    if (!labels.length) return null;

    // Walk up from the first label to find a scrollable ancestor that is
    // wider than just the time column
    let el = labels[0].el.parentElement;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      const isScrollable = s.overflowY === 'auto' || s.overflowY === 'scroll';
      const rect = el.getBoundingClientRect();
      if (isScrollable && rect.width > 200 && rect.height > 200) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function findDayColumns() {
    const cols = [];

    // Strategy 1: role="columnheader" elements
    document.querySelectorAll('[role="columnheader"]').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 30) return; // skip narrow time-axis cell
      const date = extractDate(el);
      if (date) cols.push({ clientX: rect.left, width: rect.width, date });
    });
    if (cols.length) return cols;

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
    return cols;
  }

  function extractDate(el) {
    // data attribute
    const key = el.getAttribute('data-datekey') || el.getAttribute('data-date');
    if (key) {
      const m = key.match(/(\d{4})-?(\d{2})-?(\d{2})/);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    // aria-label with day number
    const label = el.getAttribute('aria-label') || el.textContent || '';
    const numM = label.match(/\b(\d{1,2})\b/);
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
    if (labels.length < 2) return false;

    const samples = [];
    for (let i = 1; i < labels.length; i++) {
      const dm = labels[i].totalMinutes - labels[i - 1].totalMinutes;
      const dy = labels[i].clientY - labels[i - 1].clientY;
      if (dm > 0 && dy > 0) samples.push(dy / dm);
    }
    const pxPerMin = samples.reduce((a, b) => a + b, 0) / samples.length;

    state.timeAxis = { labels, pxPerMin };
    state.dayColumns = findDayColumns();
    return true;
  }

  function getTimeFromY(clientY) {
    const { labels, pxPerMin } = state.timeAxis;
    // Find nearest label
    let best = labels[0];
    for (const l of labels) {
      if (Math.abs(l.clientY - clientY) < Math.abs(best.clientY - clientY)) best = l;
    }
    const deltaMins = (clientY - best.clientY) / pxPerMin;
    // Snap to 15-minute intervals
    const snapped = Math.round(deltaMins / 15) * 15;
    return Math.max(0, Math.min(23 * 60 + 45, best.totalMinutes + snapped));
  }

  function getClientYFromTime(totalMinutes) {
    const { labels, pxPerMin } = state.timeAxis;
    const best = labels.reduce((a, b) =>
      Math.abs(b.totalMinutes - totalMinutes) < Math.abs(a.totalMinutes - totalMinutes) ? b : a
    );
    return best.clientY + (totalMinutes - best.totalMinutes) * pxPerMin;
  }

  function getDateFromX(clientX) {
    const cols = state.dayColumns;
    if (!cols.length) return new Date();
    return (
      cols.find(c => clientX >= c.clientX && clientX < c.clientX + c.width) ||
      cols.reduce((a, b) => {
        const aMid = a.clientX + a.width / 2;
        const bMid = b.clientX + b.width / 2;
        return Math.abs(bMid - clientX) < Math.abs(aMid - clientX) ? b : a;
      })
    ).date;
  }

  // ── Overlay ──────────────────────────────────────────────────────

  function buildOverlay() {
    state.scrollContainer = findScrollContainer();
    if (!state.scrollContainer) {
      console.warn('CSP: could not find scroll container');
      return false;
    }

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
    if (!state.overlay || !state.scrollContainer) return;
    const rect = state.scrollContainer.getBoundingClientRect();
    Object.assign(state.overlay.style, {
      position: 'fixed',
      top: rect.top + 'px',
      left: rect.left + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      zIndex: '999998',
      cursor: 'crosshair',
      background: 'transparent',
    });
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
    // Refresh highlight positions after scroll
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
        fontSize: '11px',
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
      height: Math.max(18, pos.height) + 'px',
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
    if (!state.timeAxis || !state.overlay) return null;
    const overlayRect = state.overlay.getBoundingClientRect();
    const startY = getClientYFromTime(startMin) - overlayRect.top;
    const endY = getClientYFromTime(endMin) - overlayRect.top;
    const height = Math.max(18, endY - startY);

    const cols = state.dayColumns || [];
    let left = 60, width = 80;

    if (cols.length > 0) {
      const col = date
        ? cols.find(c =>
            c.date.getFullYear() === date.getFullYear() &&
            c.date.getMonth() === date.getMonth() &&
            c.date.getDate() === date.getDate()
          )
        : null;
      if (col) {
        left = col.clientX - overlayRect.left + 2;
        width = col.width - 4;
      }
    }

    return { top: startY, left, width, height };
  }

  function addHighlight(slot) {
    if (!state.overlay || !state.timeAxis) return;

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
    const overlayRect = state.overlay.getBoundingClientRect();

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
    if (!calibrate()) {
      console.warn('CSP: Could not find time labels — are you in week/day view?');
    }
    if (!buildOverlay()) return;
    state.isActive = true;

    // Re-render any previously selected slots
    state.slots.forEach(slot => addHighlight(slot));
    document.body.classList.add('csp-selection-active');
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

    console.log('Calendar Slots Picker ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
