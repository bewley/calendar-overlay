// Calendar Slots Picker - Side Panel Script

(function() {
  'use strict';

  // State
  let selectedSlots = [];
  let isSelectionMode = false;
  let currentTabId = null;

  // DOM elements
  const toggleBtn = document.getElementById('toggleBtn');
  const toggleBtnText = document.getElementById('toggleBtnText');
  const clearBtn = document.getElementById('clearBtn');
  const copyBtn = document.getElementById('copyBtn');
  const slotsList = document.getElementById('slotsList');
  const emptyState = document.getElementById('emptyState');
  const slotCount = document.getElementById('slotCount');
  const previewSection = document.getElementById('previewSection');
  const previewContent = document.getElementById('previewContent');
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const toast = document.getElementById('toast');
  const formatRadios = document.querySelectorAll('input[name="format"]');

  // Initialize
  async function init() {
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url?.includes('calendar.google.com')) {
      currentTabId = tab.id;
      // Get current state from content script
      try {
        const response = await chrome.tabs.sendMessage(currentTabId, { type: 'GET_SELECTED_SLOTS' });
        if (response?.slots) {
          selectedSlots = response.slots;
          updateUI();
        }
      } catch (e) {
        console.log('Could not connect to content script:', e);
      }
    }

    setupEventListeners();
  }

  // Setup event listeners
  function setupEventListeners() {
    toggleBtn.addEventListener('click', toggleSelectionMode);
    clearBtn.addEventListener('click', clearSelections);
    copyBtn.addEventListener('click', copyToClipboard);

    // Format change listeners
    formatRadios.forEach(radio => {
      radio.addEventListener('change', updatePreview);
    });

    // Listen for messages from content script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'SLOTS_UPDATED') {
        selectedSlots = message.slots;
        updateUI();
      }
      if (message.type === 'SELECTION_MODE_CHANGED') {
        isSelectionMode = message.enabled;
        updateToggleButton();
        updateStatusIndicator();
      }
    });

    // Listen for tab changes
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (tab.url?.includes('calendar.google.com')) {
        currentTabId = tab.id;
        refreshState();
      }
    });
  }

  // Refresh state from content script
  async function refreshState() {
    if (!currentTabId) return;
    try {
      const response = await chrome.tabs.sendMessage(currentTabId, { type: 'GET_SELECTED_SLOTS' });
      if (response?.slots) {
        selectedSlots = response.slots;
        updateUI();
      }
    } catch (e) {
      console.log('Could not refresh state:', e);
    }
  }

  // Toggle selection mode
  async function toggleSelectionMode() {
    if (!currentTabId) {
      showToast('Please open Google Calendar first');
      return;
    }

    isSelectionMode = !isSelectionMode;

    try {
      await chrome.tabs.sendMessage(currentTabId, {
        type: 'TOGGLE_SELECTION_MODE',
        enabled: isSelectionMode
      });
      updateToggleButton();
      updateStatusIndicator();
    } catch (e) {
      console.log('Could not toggle selection mode:', e);
      showToast('Could not connect to Google Calendar');
      isSelectionMode = false;
    }
  }

  // Update toggle button state
  function updateToggleButton() {
    if (isSelectionMode) {
      toggleBtn.classList.add('active');
      toggleBtnText.textContent = 'Stop Selecting';
    } else {
      toggleBtn.classList.remove('active');
      toggleBtnText.textContent = 'Start Selecting';
    }
  }

  // Update status indicator
  function updateStatusIndicator() {
    if (isSelectionMode) {
      statusIndicator.classList.add('active');
      statusText.textContent = 'Selection mode is ON - Click calendar slots';
    } else {
      statusIndicator.classList.remove('active');
      statusText.textContent = 'Selection mode is off';
    }
  }

  // Clear all selections
  async function clearSelections() {
    if (!currentTabId) return;

    try {
      await chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_SELECTIONS' });
      selectedSlots = [];
      updateUI();
    } catch (e) {
      console.log('Could not clear selections:', e);
    }
  }

  // Remove a single slot
  async function removeSlot(slotId) {
    if (!currentTabId) return;

    try {
      await chrome.tabs.sendMessage(currentTabId, {
        type: 'REMOVE_SLOT',
        slotId: slotId
      });
      selectedSlots = selectedSlots.filter(s => s.id !== slotId);
      updateUI();
    } catch (e) {
      console.log('Could not remove slot:', e);
    }
  }

  // Update UI
  function updateUI() {
    updateSlotsList();
    updateSlotCount();
    updatePreview();
    updateCopyButton();
  }

  // Update slots list
  function updateSlotsList() {
    if (selectedSlots.length === 0) {
      slotsList.innerHTML = '';
      slotsList.appendChild(emptyState);
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';

    const html = selectedSlots.map(slot => `
      <div class="slot-item" data-slot-id="${slot.id}">
        <div class="slot-info">
          <div class="slot-date">${slot.dateString}</div>
          <div class="slot-time">${slot.startTimeString}${slot.endTimeString ? ' - ' + slot.endTimeString : ''}</div>
        </div>
        <button class="slot-remove" data-slot-id="${slot.id}" title="Remove this slot">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    `).join('');

    slotsList.innerHTML = html;

    // Add remove button listeners
    slotsList.querySelectorAll('.slot-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSlot(btn.dataset.slotId);
      });
    });
  }

  // Update slot count
  function updateSlotCount() {
    slotCount.textContent = selectedSlots.length;
  }

  // Update copy button state
  function updateCopyButton() {
    copyBtn.disabled = selectedSlots.length === 0;
  }

  // Get selected format
  function getSelectedFormat() {
    const selected = document.querySelector('input[name="format"]:checked');
    return selected ? selected.value : 'bullet';
  }

  // Format slots for output
  function formatSlots(slots, format) {
    if (slots.length === 0) return '';

    // Group slots by date
    const groupedByDate = {};
    slots.forEach(slot => {
      if (!groupedByDate[slot.dateString]) {
        groupedByDate[slot.dateString] = [];
      }
      groupedByDate[slot.dateString].push(slot);
    });

    switch (format) {
      case 'bullet':
        return formatBulletList(groupedByDate);
      case 'numbered':
        return formatNumberedList(groupedByDate);
      case 'prose':
        return formatProse(groupedByDate);
      default:
        return formatBulletList(groupedByDate);
    }
  }

  // Format as bullet list
  function formatBulletList(groupedByDate) {
    let output = 'I\'m available at the following times:\n\n';

    for (const [date, slots] of Object.entries(groupedByDate)) {
      output += `${date}\n`;
      slots.forEach(slot => {
        const timeStr = slot.endTimeString
          ? `${slot.startTimeString} - ${slot.endTimeString}`
          : slot.startTimeString;
        output += `  - ${timeStr}\n`;
      });
      output += '\n';
    }

    output += 'Please let me know which time works best for you!';
    return output.trim();
  }

  // Format as numbered list
  function formatNumberedList(groupedByDate) {
    let output = 'I\'m available at the following times:\n\n';
    let counter = 1;

    for (const [date, slots] of Object.entries(groupedByDate)) {
      slots.forEach(slot => {
        const timeStr = slot.endTimeString
          ? `${slot.startTimeString} - ${slot.endTimeString}`
          : slot.startTimeString;
        output += `${counter}. ${date}, ${timeStr}\n`;
        counter++;
      });
    }

    output += '\nPlease let me know which option works best for you!';
    return output.trim();
  }

  // Format as prose
  function formatProse(groupedByDate) {
    const dateEntries = Object.entries(groupedByDate);

    if (dateEntries.length === 0) return '';

    let output = 'I\'m available ';
    const parts = [];

    for (const [date, slots] of dateEntries) {
      // Extract shorter date format for prose
      const shortDate = formatShortDate(date);
      const times = slots.map(slot => {
        return slot.endTimeString
          ? `${slot.startTimeString} - ${slot.endTimeString}`
          : `at ${slot.startTimeString}`;
      });

      if (times.length === 1) {
        parts.push(`on ${shortDate} ${times[0]}`);
      } else {
        const lastTime = times.pop();
        parts.push(`on ${shortDate} ${times.join(', ')} or ${lastTime}`);
      }
    }

    if (parts.length === 1) {
      output += parts[0];
    } else if (parts.length === 2) {
      output += `${parts[0]}, or ${parts[1]}`;
    } else {
      const lastPart = parts.pop();
      output += `${parts.join(', ')}, or ${lastPart}`;
    }

    output += '. Let me know what works best for you!';
    return output;
  }

  // Format short date for prose
  function formatShortDate(dateString) {
    // Convert "Monday, January 15, 2024" to "Monday, Jan 15"
    const parts = dateString.split(', ');
    if (parts.length >= 2) {
      const dayOfWeek = parts[0];
      const monthDay = parts[1].split(' ');
      if (monthDay.length >= 2) {
        const month = monthDay[0].substring(0, 3);
        const day = monthDay[1];
        return `${dayOfWeek}, ${month} ${day}`;
      }
    }
    return dateString;
  }

  // Update preview
  function updatePreview() {
    if (selectedSlots.length === 0) {
      previewSection.style.display = 'none';
      return;
    }

    previewSection.style.display = 'block';
    const format = getSelectedFormat();
    const formattedText = formatSlots(selectedSlots, format);
    previewContent.textContent = formattedText;
  }

  // Copy to clipboard
  async function copyToClipboard() {
    const format = getSelectedFormat();
    const formattedText = formatSlots(selectedSlots, format);

    try {
      await navigator.clipboard.writeText(formattedText);
      showToast('Copied to clipboard!');
    } catch (e) {
      console.error('Failed to copy:', e);
      showToast('Failed to copy to clipboard');
    }
  }

  // Show toast notification
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2000);
  }

  // Initialize when DOM is ready
  document.addEventListener('DOMContentLoaded', init);
})();
