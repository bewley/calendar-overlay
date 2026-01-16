// Calendar Slots Picker - Background Service Worker

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  // Check if we're on Google Calendar
  if (tab.url?.includes('calendar.google.com')) {
    chrome.sidePanel.open({ tabId: tab.id });
  } else {
    // Optionally navigate to Google Calendar or show a message
    chrome.tabs.create({ url: 'https://calendar.google.com' });
  }
});

// Set up side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Error setting panel behavior:', error));

// Listen for tab updates to manage side panel availability
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Enable side panel only on Google Calendar
    if (tab.url.includes('calendar.google.com')) {
      chrome.sidePanel.setOptions({
        tabId,
        path: 'sidepanel.html',
        enabled: true
      });
    } else {
      chrome.sidePanel.setOptions({
        tabId,
        enabled: false
      });
    }
  }
});

// Forward messages between content script and side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Forward slot updates from content script to side panel
  if (message.type === 'SLOTS_UPDATED') {
    // The side panel will receive this through its own listener
    return;
  }

  // Handle any background-specific messages here
  if (message.type === 'GET_CALENDAR_TAB') {
    chrome.tabs.query({ url: 'https://calendar.google.com/*' }, (tabs) => {
      sendResponse({ tabId: tabs.length > 0 ? tabs[0].id : null });
    });
    return true; // Keep channel open for async response
  }
});

// Initialize extension on install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Calendar Slots Picker installed');
    // Could open onboarding page here if desired
  } else if (details.reason === 'update') {
    console.log('Calendar Slots Picker updated to version', chrome.runtime.getManifest().version);
  }
});
