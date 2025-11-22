const DEBUG = true; // Toggle for debug logging

function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

const DEFAULT_MAX_RECOMMENDATIONS = 90;

let batchCounts = new Map();
let settings = { limitRecommendations: false, maxRecommendations: DEFAULT_MAX_RECOMMENDATIONS };
let webRequestListener = null; // store reference to the listener

async function loadSettings() {
  try {
    const result = await browser.storage.local.get(['limitRecommendations', 'maxRecommendations']);
    settings.limitRecommendations = result.limitRecommendations || false;
    settings.maxRecommendations = result.maxRecommendations !== undefined ? result.maxRecommendations : DEFAULT_MAX_RECOMMENDATIONS;
    logDebug(`[background] Loaded settings: limitRecommendations=${settings.limitRecommendations}, maxRecommendations=${settings.maxRecommendations}`);
	// Update listener based on settings
    updateWebRequestListener();
  } catch (error) {
    console.error('[background] Error loading settings:', error);
  }
}

function showNotification(title, message) {
  browser.notifications.create({
    type: "basic",
    title,
    message,
    iconUrl: "icon.svg"
  });
}

async function updateBlacklist(userId, action, tabId) {
  try {
    const { blacklist = [] } = await browser.storage.local.get('blacklist');
    const blacklistSet = new Set(blacklist);
    if (action === "add") {
      if (blacklistSet.has(userId)) {
        logDebug(`User ID ${userId} already in blacklist`);
        showNotification("Pixiv User Filter", `User ID ${userId} is already in the blacklist`);
        return;
      }
      blacklistSet.add(userId);
      logDebug(`Added user ID ${userId} to blacklist`);
      showNotification("Pixiv User Filter", `User ID ${userId} added to blacklist`);
    } else if (action === "remove") {
      if (!blacklistSet.has(userId)) {
        logDebug(`User ID ${userId} not in blacklist`);
        showNotification("Pixiv User Filter", `User ID ${userId} is not in the blacklist`);
        return;
      }
      blacklistSet.delete(userId);
      logDebug(`Removed user ID ${userId} from blacklist`);
      showNotification("Pixiv User Filter", `User ID ${userId} removed from blacklist`);
    }
    await browser.storage.local.set({ blacklist: Array.from(blacklistSet) });
    await browser.tabs.sendMessage(tabId, { action: "refreshBlacklist" });
  } catch (error) {
    console.error(`Error ${action}ing user ID ${userId}:`, error);
    showNotification("Pixiv User Filter", `Failed to ${action} user ID ${userId}: ${error.message}`);
  }
}

function createWebRequestListener() {
  return async function(details) {
    logDebug(`[background] webRequest fired: ${details.url}, tabId=${details.tabId}`);
    
    if (details.tabId < 0) {
      logDebug(`[background] Invalid tabId, allowing request, tabId=${details.tabId}`);
      return { cancel: false };
    }
    
    if (!settings.limitRecommendations) {
        logDebug(`[background] Limiting disabled, allowing request, limitRecommendations=${settings.limitRecommendations}`);
        return { cancel: false };
    }
    
    // Check if the request is from an artwork page
    try {
      const tab = await browser.tabs.get(details.tabId);
      const tabUrl = tab.url;
      const isArtworkPage = /\/(?:en\/)?artworks\/\d+/.test(tabUrl);
      
      if (!isArtworkPage) {
        logDebug(`[background] Request not from artwork page (${tabUrl}), allowing`);
        return { cancel: false };
      }
    } catch (error) {
      console.error('[background] Error getting tab info:', error);
      return { cancel: false };
    }

    const maxBatches = Math.floor(settings.maxRecommendations / 18);
    const url = details.url;

	// Match initial recommendation requests
    if (url.match(/\/ajax\/illust\/\d+\/recommend\/init\?limit=18/) || 
    url.includes('/ajax/illust/discovery?mode=')){
      // Initial batch
      const shouldBlock = maxBatches <= 0;
      logDebug(`[background] Initial discovery request: ${shouldBlock ? 'blocked' : 'allowed'} (maxBatches=${maxBatches})`);
      return { cancel: shouldBlock };
    } else if (url.includes('/ajax/illust/recommend/illusts?')) {
      // Match subsequent batches
      let count = batchCounts.get(details.tabId) || 0;
      const shouldBlock = count >= (maxBatches - 1);
      if (!shouldBlock) {
        count++;
        batchCounts.set(details.tabId, count);
      }
      logDebug(`[background] Recommend request: ${shouldBlock ? 'blocked' : 'allowed'} (count=${count}, maxBatches=${maxBatches})`);
      return { cancel: shouldBlock };
    }
    return { cancel: false };
  };
}

function updateWebRequestListener() {
  if (settings.limitRecommendations && !webRequestListener) {
    // Add listener if needed and not present
    webRequestListener = createWebRequestListener();
    browser.webRequest.onBeforeRequest.addListener(
      webRequestListener,
      { urls: [
        "*://*.pixiv.net/ajax/illust/*/recommend/init*",
        "*://*.pixiv.net/ajax/illust/discovery*",
        "*://*.pixiv.net/ajax/illust/recommend/illusts*"
      ]},
      ["blocking"]
    );
    logDebug('[background] Added webRequest listener');
  } else if (!settings.limitRecommendations && webRequestListener) {
    // Remove listener if not needed and present
    browser.webRequest.onBeforeRequest.removeListener(webRequestListener);
    webRequestListener = null;
    logDebug('[background] Removed webRequest listener');
  }
}

// Initialize context menus
browser.runtime.onInstalled.addListener(() => {
  logDebug('Pixiv User Filter: Setting up context menus');
  
  // Remove only our specific menus to prevent duplicate ID errors
  browser.contextMenus.remove('pixiv-blacklist', () => {});
  browser.contextMenus.remove('add-to-blacklist', () => {});
  browser.contextMenus.remove('remove-from-blacklist', () => {});
  
  // Small delay to ensure removal completes first
  setTimeout(() => {
    browser.contextMenus.create({
      id: "pixiv-blacklist",
      title: "Pixiv User Filter",
      contexts: ["link"],
      documentUrlPatterns: ["*://*.pixiv.net/*"],
      targetUrlPatterns: ["*://*.pixiv.net/*/users/*", "*://*.pixiv.net/users/*"]
    }, () => {
      if (browser.runtime.lastError) {
        console.error("Error creating parent menu:", browser.runtime.lastError);
      } else {
        logDebug("Parent menu created successfully");
      }
    });

    browser.contextMenus.create({
      id: "add-to-blacklist",
      parentId: "pixiv-blacklist",
      title: "Add User to Blacklist",
      contexts: ["link"],
      documentUrlPatterns: ["*://*.pixiv.net/*"],
      targetUrlPatterns: ["*://*.pixiv.net/*/users/*", "*://*.pixiv.net/users/*"]
    }, () => {
      if (browser.runtime.lastError) {
        console.error("Error creating add-to-blacklist submenu:", browser.runtime.lastError);
      } else {
        logDebug("Add-to-blacklist submenu created successfully");
      }
    });

    browser.contextMenus.create({
      id: "remove-from-blacklist",
      parentId: "pixiv-blacklist",
      title: "Remove User from Blacklist",
      contexts: ["link"],
      documentUrlPatterns: ["*://*.pixiv.net/*"],
      targetUrlPatterns: ["*://*.pixiv.net/*/users/*", "*://*.pixiv.net/users/*"]
    }, () => {
      if (browser.runtime.lastError) {
        console.error("Error creating remove-from-blacklist submenu:", browser.runtime.lastError);
      } else {
        logDebug("Remove-from-blacklist submenu created successfully");
        logDebug('Pixiv User Filter: Context menus created successfully');
      }
    });
    
  }, 150);
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (message.action === "setBadge") {
    const text = message.count > 0 ? message.count.toString() : "";
    browser.action.setBadgeText({ text });
    if (message.count > 0) {
      browser.action.setBadgeBackgroundColor({ color: "#666" });
    }
    logDebug(`[setBadge] Badge set to "${text}"`);
  } else if (message.action === "refreshBlacklist") {
    loadSettings();
  } else if (message.action === "resetBatchCount") {
    if (sender.tab && sender.tab.id) {
      batchCounts.set(sender.tab.id, 0);
      console.log(`[background] Reset batch count for tab ${sender.tab.id}`);
    }
  }
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  const linkUrl = info.linkUrl;
  const match = linkUrl.match(/pixiv\.net\/(?:en\/)?users\/(\d+)/i);
  if (!match) {
    logDebug("Invalid user URL:", linkUrl);
    showNotification("Pixiv User Filter", "Invalid user URL. Please select a valid user profile link.");
    return;
  }
  const userId = match[1];
  if (info.menuItemId === "add-to-blacklist") {
    updateBlacklist(userId, "add", tab.id);
  } else if (info.menuItemId === "remove-from-blacklist") {
    updateBlacklist(userId, "remove", tab.id);
  }
});

// Open options page when toolbar icon is clicked
browser.action.onClicked.addListener(() => {
  browser.runtime.openOptionsPage();
});

// Load settings after everything else is set up
loadSettings();