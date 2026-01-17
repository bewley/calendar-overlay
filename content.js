// Calendar Slots Picker - Content Script
// Runs on Google Calendar pages to enable time slot selection

(function() {
  'use strict';

  // Store selected time slots
  let selectedSlots = [];
  let isSelectionMode = false;
  let selectionOverlay = null;

  // Initialize the extension
  function init() {
    createSelectionOverlay();
    setupEventListeners();
    listenForMessages();
    console.log('Calendar Slots Picker initialized');
  }

  // Create a visual overlay for selection feedback
  function createSelectionOverlay() {
    selectionOverlay = document.createElement('div');
    selectionOverlay.id = 'csp-selection-overlay';
    selectionOverlay.innerHTML = `
      <div class="csp-status-bar">
        <span class="csp-status-text">Click on time slots to select them</span>
        <span class="csp-slot-count">0 slots selected</span>
      </div>
    `;
    selectionOverlay.style.display = 'none';
    document.body.appendChild(selectionOverlay);
  }

  // Update the status bar
  function updateStatusBar() {
    const countEl = selectionOverlay.querySelector('.csp-slot-count');
    if (countEl) {
      const count = selectedSlots.length;
      countEl.textContent = `${count} slot${count !== 1 ? 's' : ''} selected`;
    }
  }

  // Toggle selection mode
  function toggleSelectionMode(enabled) {
    isSelectionMode = enabled;
    if (selectionOverlay) {
      selectionOverlay.style.display = enabled ? 'block' : 'none';
    }
    document.body.classList.toggle('csp-selection-active', enabled);

    if (enabled) {
      // Prevent default calendar interactions
      document.addEventListener('click', handleCalendarClick, true);
    } else {
      document.removeEventListener('click', handleCalendarClick, true);
    }
  }

  // Parse time from various formats
  function parseTimeString(timeStr) {
    if (!timeStr) return null;

    // Clean up the string
    timeStr = timeStr.trim().toLowerCase();

    // Match patterns like "9:00am", "9am", "14:00", "2:30pm"
    const timeMatch = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!timeMatch) return null;

    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3]?.toLowerCase();

    if (meridiem === 'pm' && hours !== 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;

    return { hours, minutes };
  }

  // Format time for display
  function formatTime(hours, minutes) {
    const meridiem = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    const displayMinutes = minutes.toString().padStart(2, '0');
    return `${displayHours}:${displayMinutes} ${meridiem}`;
  }

  // Get the date from the calendar view
  function getDateFromColumn(element) {
    // Try to find the date header for this column
    const columnIndex = getColumnIndex(element);

    // Look for date headers in week/day view
    const dateHeaders = document.querySelectorAll('[data-datekey], [data-date]');
    for (const header of dateHeaders) {
      const dateKey = header.getAttribute('data-datekey') || header.getAttribute('data-date');
      if (dateKey) {
        // Parse date from format like "20240115" or "2024-01-15"
        const match = dateKey.match(/(\d{4})-?(\d{2})-?(\d{2})/);
        if (match) {
          return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
        }
      }
    }

    // Try to get date from column headers
    const headers = document.querySelectorAll('[role="columnheader"]');
    if (headers[columnIndex]) {
      const headerText = headers[columnIndex].textContent;
      return parseDateFromHeader(headerText);
    }

    // Fallback to current visible date
    return getCurrentVisibleDate();
  }

  // Get column index for an element
  function getColumnIndex(element) {
    const gridCell = element.closest('[role="gridcell"]');
    if (gridCell) {
      const row = gridCell.parentElement;
      return Array.from(row.children).indexOf(gridCell);
    }
    return 0;
  }

  // Parse date from header text like "Mon 15"
  function parseDateFromHeader(headerText) {
    const today = new Date();
    const dayMatch = headerText.match(/\d+/);
    if (dayMatch) {
      const day = parseInt(dayMatch[0], 10);
      const date = new Date(today.getFullYear(), today.getMonth(), day);
      // Adjust if the day seems to be in the next/previous month
      if (day < today.getDate() - 15) {
        date.setMonth(date.getMonth() + 1);
      } else if (day > today.getDate() + 15) {
        date.setMonth(date.getMonth() - 1);
      }
      return date;
    }
    return today;
  }

  // Get currently visible date from calendar
  function getCurrentVisibleDate() {
    // Try to find date from URL
    const urlMatch = window.location.href.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (urlMatch) {
      return new Date(parseInt(urlMatch[1]), parseInt(urlMatch[2]) - 1, parseInt(urlMatch[3]));
    }

    // Try to find from the calendar header
    const headerEl = document.querySelector('[data-view-heading]');
    if (headerEl) {
      const text = headerEl.textContent;
      // Parse "January 2024" or "Jan 15, 2024" etc.
      const parsed = new Date(text);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return new Date();
  }

  // Extract time slot info from clicked element
  function extractSlotInfo(element) {
    let timeStart = null;
    let timeEnd = null;
    let date = null;

    // Strategy 1: Check for time in data attributes
    const dataTime = element.getAttribute('data-time') ||
                     element.closest('[data-time]')?.getAttribute('data-time');
    if (dataTime) {
      timeStart = parseTimeString(dataTime);
    }

    // Strategy 2: Check aria-label for time info
    const ariaLabel = element.getAttribute('aria-label') ||
                      element.closest('[aria-label]')?.getAttribute('aria-label');
    if (ariaLabel) {
      // Parse time ranges like "9:00 AM – 10:00 AM"
      const timeRange = ariaLabel.match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s*[–-]\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)/i);
      if (timeRange) {
        timeStart = parseTimeString(timeRange[1]);
        timeEnd = parseTimeString(timeRange[2]);
      } else {
        // Single time
        const singleTime = ariaLabel.match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i);
        if (singleTime) {
          timeStart = parseTimeString(singleTime[1]);
        }
      }

      // Try to extract date from aria-label
      const dateMatch = ariaLabel.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[,\s]+(\w+)\s+(\d{1,2})(?:[,\s]+(\d{4}))?/i);
      if (dateMatch) {
        const monthStr = dateMatch[1];
        const day = parseInt(dateMatch[2], 10);
        const year = dateMatch[3] ? parseInt(dateMatch[3], 10) : new Date().getFullYear();
        const months = ['january', 'february', 'march', 'april', 'may', 'june',
                       'july', 'august', 'september', 'october', 'november', 'december'];
        const monthIndex = months.findIndex(m => m.startsWith(monthStr.toLowerCase()));
        if (monthIndex !== -1) {
          date = new Date(year, monthIndex, day);
        }
      }
    }

    // Strategy 3: Calculate time from vertical position in day/week view
    if (!timeStart) {
      const timeSlot = findTimeSlotFromPosition(element);
      if (timeSlot) {
        timeStart = timeSlot;
      }
    }

    // Get date if not already found
    if (!date) {
      date = getDateFromColumn(element);
    }

    // Default end time to 30 minutes after start
    if (timeStart && !timeEnd) {
      let endMinutes = timeStart.minutes + 30;
      let endHours = timeStart.hours;
      if (endMinutes >= 60) {
        endMinutes -= 60;
        endHours += 1;
      }
      timeEnd = { hours: endHours, minutes: endMinutes };
    }

    if (timeStart && date) {
      return {
        id: generateSlotId(date, timeStart, timeEnd),
        date: date,
        startTime: timeStart,
        endTime: timeEnd,
        dateString: formatDate(date),
        startTimeString: formatTime(timeStart.hours, timeStart.minutes),
        endTimeString: timeEnd ? formatTime(timeEnd.hours, timeEnd.minutes) : null
      };
    }

    return null;
  }

  // Find time from element position in the calendar grid
  function findTimeSlotFromPosition(element) {
    // Find the calendar grid container
    const gridContainer = element.closest('[role="grid"], [role="main"]');
    if (!gridContainer) return null;

    // Find time labels on the left side
    const timeLabels = document.querySelectorAll('[data-time], [data-guidedhelpid="time_label"]');

    // Get element's vertical position
    const rect = element.getBoundingClientRect();
    const elementTop = rect.top;

    // Find the closest time label
    let closestTime = null;
    let closestDistance = Infinity;

    timeLabels.forEach(label => {
      const labelRect = label.getBoundingClientRect();
      const distance = Math.abs(labelRect.top - elementTop);
      if (distance < closestDistance) {
        closestDistance = distance;
        const timeAttr = label.getAttribute('data-time') || label.textContent;
        closestTime = parseTimeString(timeAttr);
      }
    });

    // Fallback: estimate from row position
    if (!closestTime) {
      const row = element.closest('[role="row"]');
      if (row) {
        const allRows = document.querySelectorAll('[role="row"]');
        const rowIndex = Array.from(allRows).indexOf(row);
        // Assuming each row is 30 minutes, starting from midnight
        const totalMinutes = rowIndex * 30;
        closestTime = {
          hours: Math.floor(totalMinutes / 60) % 24,
          minutes: totalMinutes % 60
        };
      }
    }

    return closestTime;
  }

  // Generate unique ID for a slot
  function generateSlotId(date, startTime, endTime) {
    const dateStr = date.toISOString().split('T')[0];
    const startStr = `${startTime.hours.toString().padStart(2, '0')}${startTime.minutes.toString().padStart(2, '0')}`;
    const endStr = endTime ? `${endTime.hours.toString().padStart(2, '0')}${endTime.minutes.toString().padStart(2, '0')}` : '';
    return `${dateStr}-${startStr}-${endStr}`;
  }

  // Format date for display
  function formatDate(date) {
    const options = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
    return date.toLocaleDateString('en-US', options);
  }

  // Handle click on calendar
  function handleCalendarClick(event) {
    if (!isSelectionMode) return;

    const target = event.target;

    // Check if clicked on a valid calendar area
    const isCalendarArea = target.closest('[role="grid"]') ||
                          target.closest('[role="gridcell"]') ||
                          target.closest('[data-eventid]') ||
                          target.closest('.csp-selectable-slot');

    if (!isCalendarArea) return;

    event.preventDefault();
    event.stopPropagation();

    const slotInfo = extractSlotInfo(target);
    if (slotInfo) {
      toggleSlotSelection(slotInfo, target);
    }
  }

  // Toggle selection of a time slot
  function toggleSlotSelection(slotInfo, element) {
    const existingIndex = selectedSlots.findIndex(s => s.id === slotInfo.id);

    if (existingIndex !== -1) {
      // Deselect
      selectedSlots.splice(existingIndex, 1);
      removeSelectionHighlight(slotInfo.id);
    } else {
      // Select
      selectedSlots.push(slotInfo);
      addSelectionHighlight(element, slotInfo.id);
    }

    // Sort slots by date and time
    selectedSlots.sort((a, b) => {
      const dateCompare = a.date - b.date;
      if (dateCompare !== 0) return dateCompare;
      const timeCompareStart = (a.startTime.hours * 60 + a.startTime.minutes) -
                               (b.startTime.hours * 60 + b.startTime.minutes);
      return timeCompareStart;
    });

    updateStatusBar();
    notifySelectionChange();
  }

  // Add visual highlight to selected slot
  function addSelectionHighlight(element, slotId) {
    // Find the best element to highlight
    let highlightTarget = element.closest('[role="gridcell"]') ||
                         element.closest('[role="button"]') ||
                         element;

    // Create highlight overlay
    const highlight = document.createElement('div');
    highlight.className = 'csp-slot-highlight';
    highlight.setAttribute('data-slot-id', slotId);

    const rect = highlightTarget.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    highlight.style.position = 'absolute';
    highlight.style.top = `${rect.top + scrollTop}px`;
    highlight.style.left = `${rect.left + scrollLeft}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    highlight.style.pointerEvents = 'none';

    document.body.appendChild(highlight);
  }

  // Remove highlight from deselected slot
  function removeSelectionHighlight(slotId) {
    const highlight = document.querySelector(`.csp-slot-highlight[data-slot-id="${slotId}"]`);
    if (highlight) {
      highlight.remove();
    }
  }

  // Clear all selections
  function clearAllSelections() {
    selectedSlots = [];
    document.querySelectorAll('.csp-slot-highlight').forEach(el => el.remove());
    updateStatusBar();
    notifySelectionChange();
  }

  // Notify side panel of selection changes
  function notifySelectionChange() {
    chrome.runtime.sendMessage({
      type: 'SLOTS_UPDATED',
      slots: selectedSlots
    });
  }

  // Listen for messages from background/sidepanel
  function listenForMessages() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      switch (message.type) {
        case 'TOGGLE_SELECTION_MODE':
          toggleSelectionMode(message.enabled);
          sendResponse({ success: true, enabled: isSelectionMode });
          break;

        case 'GET_SELECTED_SLOTS':
          sendResponse({ slots: selectedSlots });
          break;

        case 'CLEAR_SELECTIONS':
          clearAllSelections();
          sendResponse({ success: true });
          break;

        case 'REMOVE_SLOT':
          const index = selectedSlots.findIndex(s => s.id === message.slotId);
          if (index !== -1) {
            removeSelectionHighlight(message.slotId);
            selectedSlots.splice(index, 1);
            updateStatusBar();
            notifySelectionChange();
          }
          sendResponse({ success: true });
          break;
      }
      return true; // Keep message channel open for async response
    });
  }

  // Setup additional event listeners
  function setupEventListeners() {
    // Update highlights on scroll/resize
    let updateTimeout;
    const updateHighlights = () => {
      clearTimeout(updateTimeout);
      updateTimeout = setTimeout(() => {
        document.querySelectorAll('.csp-slot-highlight').forEach(el => el.remove());
        // Re-add highlights would require storing element references
        // For now, clear and let user re-select if needed after major scroll
      }, 200);
    };

    window.addEventListener('scroll', updateHighlights, { passive: true });
    window.addEventListener('resize', updateHighlights, { passive: true });

    // Keyboard shortcut to toggle selection mode (Alt+S)
    document.addEventListener('keydown', (event) => {
      if (event.altKey && event.key === 's') {
        toggleSelectionMode(!isSelectionMode);
        notifySelectionChange();
      }
      // Escape to exit selection mode
      if (event.key === 'Escape' && isSelectionMode) {
        toggleSelectionMode(false);
        notifySelectionChange();
      }
    });
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
