import { BackupManager } from './backup-manager.js';

let DEBUG = false;
const debugPrefix = '[Pxv.UF]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

const DEFAULT_MAX_RECOMMENDATIONS = 90;

let batchCounts = new Map();
let settings = { limitRecommendations: false, maxRecommendations: DEFAULT_MAX_RECOMMENDATIONS };
let autoBackupEnabled = false;
let webRequestListener = null; // store reference to the listener

async function loadSettings() {
  try {
    const result = await browser.storage.local.get({
      limitRecommendations: false,
      maxRecommendations: DEFAULT_MAX_RECOMMENDATIONS,
      autoBackup: false,
      DEBUG: false,
    });
    settings.limitRecommendations = result.limitRecommendations;
    settings.maxRecommendations = result.maxRecommendations;
    autoBackupEnabled = result.autoBackup;
    DEBUG = result.DEBUG;

    logDebug('Debug mode set to:', DEBUG);
    logDebug(
      `[background] Loaded settings: limitRecommendations=${settings.limitRecommendations}, maxRecommendations=${settings.maxRecommendations}, autoBackup=${autoBackupEnabled}`,
    );
    // Update listener based on settings
    updateWebRequestListener();

    // Propagate state to backup manager
    await backupManager.updateAlarmState(autoBackupEnabled);
  } catch (error) {
    console.error('[background] Error loading settings:', error);
  }
}

function showNotification(title, message) {
  browser.notifications.create({
    type: 'basic',
    title,
    message,
    iconUrl: 'icon.svg',
  });
}

async function updateBlacklist(userId, action, tabId) {
  try {
    const { blacklist = [] } = await browser.storage.local.get('blacklist');
    const blacklistSet = new Set(blacklist);
    if (action === 'add') {
      if (blacklistSet.has(userId)) {
        logDebug(`User ID ${userId} already in blacklist`);
        showNotification('Pixiv User Filter', `User ID ${userId} is already in the blacklist`);
        return;
      }
      blacklistSet.add(userId);
      logDebug(`Added user ID ${userId} to blacklist`);
      showNotification('Pixiv User Filter', `User ID ${userId} added to blacklist`);
    } else if (action === 'remove') {
      if (!blacklistSet.has(userId)) {
        logDebug(`User ID ${userId} not in blacklist`);
        showNotification('Pixiv User Filter', `User ID ${userId} is not in the blacklist`);
        return;
      }
      blacklistSet.delete(userId);
      logDebug(`Removed user ID ${userId} from blacklist`);
      showNotification('Pixiv User Filter', `User ID ${userId} removed from blacklist`);
    }
    await browser.storage.local.set({ blacklist: Array.from(blacklistSet) });
    await browser.tabs.sendMessage(tabId, { action: 'refreshBlacklist' });
  } catch (error) {
    console.error(`Error ${action}ing user ID ${userId}:`, error);
    showNotification('Pixiv User Filter', `Failed to ${action} user ID ${userId}: ${error.message}`);
  }
}

function createWebRequestListener() {
  return async function (details) {
    logDebug(`[background] webRequest fired: ${details.url}, tabId=${details.tabId}`);

    if (details.tabId < 0) {
      logDebug(`[background] Invalid tabId, allowing request, tabId=${details.tabId}`);
      return { cancel: false };
    }

    if (!settings.limitRecommendations) {
      logDebug(
        `[background] Limiting disabled, allowing request, limitRecommendations=${settings.limitRecommendations}`,
      );
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
    if (url.match(/\/ajax\/illust\/\d+\/recommend\/init\?limit=18/) || url.includes('/ajax/illust/discovery?mode=')) {
      // Initial batch
      const shouldBlock = maxBatches <= 0;
      logDebug(
        `[background] Initial discovery request: ${shouldBlock ? 'blocked' : 'allowed'} (maxBatches=${maxBatches})`,
      );
      return { cancel: shouldBlock };
    } else if (url.includes('/ajax/illust/recommend/illusts?')) {
      // Match subsequent batches
      let count = batchCounts.get(details.tabId) || 0;
      const shouldBlock = count >= maxBatches - 1;
      if (!shouldBlock) {
        count++;
        batchCounts.set(details.tabId, count);
      }
      logDebug(
        `[background] Recommend request: ${shouldBlock ? 'blocked' : 'allowed'} (count=${count}, maxBatches=${maxBatches})`,
      );
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
      {
        urls: [
          '*://*.pixiv.net/ajax/illust/*/recommend/init*',
          '*://*.pixiv.net/ajax/illust/discovery*',
          '*://*.pixiv.net/ajax/illust/recommend/illusts*',
        ],
      },
      ['blocking'],
    );
    logDebug('[background] Added webRequest listener');
  } else if (!settings.limitRecommendations && webRequestListener) {
    // Remove listener if not needed and present
    browser.webRequest.onBeforeRequest.removeListener(webRequestListener);
    webRequestListener = null;
    logDebug('[background] Removed webRequest listener');
  }
}

// Function to handle context menu creation
async function setupContextMenus() {
  logDebug('Pixiv User Filter: Setting up context menus');

  try {
    // Clear existing menus first to avoid duplicate ID errors
    await browser.contextMenus.removeAll();

    const targetPatterns = ['*://*.pixiv.net/*/users/*', '*://*.pixiv.net/users/*'];

    // Create parent menu
    await browser.contextMenus.create({
      id: 'pixiv-blacklist',
      title: 'Pixiv User Filter',
      contexts: ['link', 'image'],
      documentUrlPatterns: ['*://*.pixiv.net/*'],
      targetUrlPatterns: targetPatterns,
    });

    // Create submenus
    await Promise.all([
      browser.contextMenus.create({
        id: 'add-to-blacklist',
        parentId: 'pixiv-blacklist',
        title: 'Add User to Blacklist',
        contexts: ['link', 'image'],
        targetUrlPatterns: targetPatterns,
      }),
      browser.contextMenus.create({
        id: 'remove-from-blacklist',
        parentId: 'pixiv-blacklist',
        title: 'Remove User from Blacklist',
        contexts: ['link', 'image'],
        targetUrlPatterns: targetPatterns,
      }),
    ]);

    logDebug('Pixiv User Filter: Context menus created successfully');
  } catch (error) {
    console.error('Pixiv User Filter: Critical error setting up context menus:', error);
  }
}

// Initial menu setup on installation or update
browser.runtime.onInstalled.addListener(setupContextMenus);

// Fallback: Re-create menus when the browser profile starts
browser.runtime.onStartup.addListener(setupContextMenus);

browser.runtime.onMessage.addListener((message, sender) => {
  if (message.action === 'setBadge') {
    const text = message.count > 0 ? message.count.toString() : '';
    browser.action.setBadgeText({ text });
    if (message.count > 0) {
      browser.action.setBadgeBackgroundColor({ color: '#666' });
    }
    logDebug(`[setBadge] Badge set to "${text}"`);
  } else if (message.action === 'refreshBlacklist') {
    loadSettings();
  } else if (message.action === 'resetBatchCount') {
    if (sender.tab && sender.tab.id) {
      batchCounts.set(sender.tab.id, 0);
      logDebug(`[background] Reset batch count for tab ${sender.tab.id}`);
    }
  } else if (message.action === 'getManualBackup') {
    // Return the payload Promise directly to options.js
    return backupManager.getManualBackupPayload();
  }
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  const linkUrl = info.linkUrl;
  const match = linkUrl.match(/pixiv\.net\/(?:en\/)?users\/(\d+)/i);
  if (!match) {
    logDebug('Invalid user URL:', linkUrl);
    showNotification('Pixiv User Filter', 'Invalid user URL. Please select a valid user profile link.');
    return;
  }
  const userId = match[1];
  if (info.menuItemId === 'add-to-blacklist') {
    updateBlacklist(userId, 'add', tab.id);
  } else if (info.menuItemId === 'remove-from-blacklist') {
    updateBlacklist(userId, 'remove', tab.id);
  }
});

// Open options page when toolbar icon is clicked
browser.action.onClicked.addListener(() => {
  browser.runtime.openOptionsPage();
});

// Handle global permission revocation
browser.permissions.onRemoved.addListener((permissions) => {
  if (permissions.permissions && permissions.permissions.includes('downloads')) {
    logDebug('[background] Downloads permission revoked. Disabling auto-backup.');
    // Writing to storage will automatically propagate to options UI and the backupManager
    browser.storage.local.set({ autoBackup: false });
  }
});

// Listen for storage changes
browser.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.DEBUG) {
      DEBUG = changes.DEBUG.newValue ?? false;
      logDebug('Debug mode changed to:', DEBUG);
    }
    if (changes.autoBackup !== undefined) {
      autoBackupEnabled = changes.autoBackup.newValue ?? false;
      logDebug('Auto backup state changed to:', autoBackupEnabled);
      backupManager.updateAlarmState(autoBackupEnabled);
    }
  }
});

// Initialize the Backup Manager
const backupManager = new BackupManager(
  {
    backupFolderName: '[Pxv.UF-backups]',
    addonName: 'Pxv.UF',
    getDebugState: () => DEBUG,
    retention: { hourly: 4, daily: 3, weekly: 3, monthly: 3 },
  },
  async () => {
    // Fetch all current storage data
    const allData = await browser.storage.local.get(null);
    // Remove the backup manager's internal history state so it's not included in the backup
    delete allData.backup_manager_state;
    return allData;
  },
);

backupManager.init();

// Load settings after everything else is set up
loadSettings();
