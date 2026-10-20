import { BackupManager } from './backup-manager.js';

let DEBUG = false;
const debugPrefix = '[Pxv.UF]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

const DEFAULT_MAX_RECOMMENDATIONS = 90;

let batchCounts = new Map();
let tabUrls = new Map(); // Track current tab URLs from content script
let tabArtworkAuthors = new Map(); // Track current artwork page author ID per tab

// Serializes blacklist mutations so each update always re-reads the latest stored blacklist.
let blacklistUpdateQueue = Promise.resolve();
let settings = {
  limitRecommendations: false,
  maxRecommendations: DEFAULT_MAX_RECOMMENDATIONS,
  hideBlockedArtistProfileArtworks: true,
  blacklist: new Set(),
};
let autoBackupEnabled = false;
let webRequestListener = null; // store reference to the webRequest listener for recommendation limiting
let profileImageBlockListener = null; // store reference to the profile image blocker listener

async function loadSettings() {
  try {
    const syncResult = await browser.storage.sync.get({
      limitRecommendations: false,
      maxRecommendations: DEFAULT_MAX_RECOMMENDATIONS,
      hideBlockedArtistProfileArtworks: true,
    });
    const localResult = await browser.storage.local.get({
      autoBackup: false,
      debugMode: false,
      blacklist: [],
    });

    settings.limitRecommendations = syncResult.limitRecommendations;
    settings.maxRecommendations = syncResult.maxRecommendations;
    settings.hideBlockedArtistProfileArtworks = syncResult.hideBlockedArtistProfileArtworks;
    settings.blacklist = new Set((localResult.blacklist || []).map((id) => String(id).trim()));
    autoBackupEnabled = localResult.autoBackup;
    DEBUG = localResult.debugMode;

    logDebug('Debug mode set to:', DEBUG);
    logDebug(
      `Loaded settings: limitRecommendations=${settings.limitRecommendations}, 
      maxRecommendations=${settings.maxRecommendations}, 
      hideBlockedArtistProfileArtworks=${settings.hideBlockedArtistProfileArtworks}, 
      blacklistSize=${settings.blacklist.size}, 
      autoBackup=${autoBackupEnabled}`,
    );

    // Update web request listeners based on settings
    updateWebRequestListener();
    updateProfileImageBlockListener();

    // Propagate state to backup manager
    await backupManager.updateAlarmState(autoBackupEnabled);
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

function showNotification(title, message) {
  browser.notifications.create({
    type: 'basic',
    title,
    message,
    iconUrl: 'icons/icon.svg',
  });
}

async function updateBlacklist(userId, action, tabId) {
  // Enqueue behind any earlier mutations and await completion so callers can
  // rely on the update being applied. Each call re-reads storage before
  // mutating.
  blacklistUpdateQueue = blacklistUpdateQueue.then(async () => {
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
      // Keep the in-memory copy in sync immediately
      settings.blacklist = blacklistSet;
      await browser.tabs.sendMessage(tabId, { action: 'refreshBlacklist' });
    } catch (error) {
      console.error(`Error ${action}ing user ID ${userId}:`, error);
      showNotification('Pixiv User Filter', `Failed to ${action} user ID ${userId}: ${error.message}`);
    }
  });
  await blacklistUpdateQueue;
}

function createWebRequestListener() {
  return async function (details) {
    logDebug(`webRequest fired: ${details.url}, tabId=${details.tabId}`);

    if (details.tabId < 0) {
      logDebug(`Invalid tabId, allowing request, tabId=${details.tabId}`);
      return { cancel: false };
    }

    if (!settings.limitRecommendations) {
      logDebug(`Limiting disabled, allowing request, limitRecommendations=${settings.limitRecommendations}`);
      return { cancel: false };
    }

    // Check if the request is from an artwork page
    try {
      const tab = await browser.tabs.get(details.tabId);
      const tabUrl = tab.url || tabUrls.get(details.tabId) || details.documentUrl || details.originUrl || '';
      const isArtworkPage = /\/(?:en\/)?artworks\/\d+/.test(tabUrl);

      if (!isArtworkPage) {
        logDebug(`Request not from artwork page (${tabUrl}), allowing`);
        return { cancel: false };
      }
    } catch (error) {
      console.error('Error getting tab info:', error);
      return { cancel: false };
    }

    const maxBatches = Math.floor(settings.maxRecommendations / 18);
    const url = details.url;

    // Match initial recommendation requests
    if (url.match(/\/ajax\/illust\/\d+\/recommend\/init\?limit=18/) || url.includes('/ajax/illust/discovery?mode=')) {
      // Initial batch
      const shouldBlock = maxBatches <= 0;
      logDebug(`Initial discovery request: ${shouldBlock ? 'blocked' : 'allowed'} (maxBatches=${maxBatches})`);
      return { cancel: shouldBlock };
    } else if (url.includes('/ajax/illust/recommend/illusts?')) {
      // Match subsequent batches
      let count = batchCounts.get(details.tabId) || 0;
      const shouldBlock = count >= maxBatches - 1;
      if (!shouldBlock) {
        count++;
        batchCounts.set(details.tabId, count);
      }
      logDebug(`Recommend request: ${shouldBlock ? 'blocked' : 'allowed'} (count=${count}, maxBatches=${maxBatches})`);
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
    logDebug('Added webRequest listener');
  } else if (!settings.limitRecommendations && webRequestListener) {
    // Remove listener if not needed and present
    browser.webRequest.onBeforeRequest.removeListener(webRequestListener);
    webRequestListener = null;
    logDebug('Removed webRequest listener');
  }
}

// Match only the artist's own profile tabs (excludes /bookmarks)
const PROFILE_URL_REGEX = /pixiv\.net\/(?:en\/)?users\/(\d+)(?:\/(?:artworks|illustrations|manga|novels))?(?:[/?#]|$)/i;

// Match Pixiv artwork files only.
// Examples include .../custom-thumb/img/YYYY/MM/DD/HH/MM/SS/123456_p0_custom1200.jpg
// and the equivalent img-master/img or img-original/img artwork paths.
function isPixivArtworkImageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() !== 'i.pximg.net') return false;

    return /\/(?:custom-thumb|img-master|img-original)\/img\/(?:\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/)?\d+_p\d+_[^/]+\.(?:jpe?g|png|webp|gif)$/i.test(
      url.pathname,
    );
  } catch {
    return false;
  }
}

function createProfileImageBlockListener() {
  return async function (details) {
    //logDebug(`webRequest fired: url=${details.url}, ` + `tabId=${details.tabId}, type=${details.type}`,);

    if (details.tabId < 0 || !settings.hideBlockedArtistProfileArtworks || settings.blacklist.size === 0) {
      logDebug('Skipped by initial guard, either invalid tabId, feature disabled, or empty blacklist');
      return { cancel: false };
    }

    // Only consider known Pixiv artwork-file URL patterns.
    if (!isPixivArtworkImageUrl(details.url)) {
      logDebug(`Allowed non-artwork image: ${details.url}`);
      return { cancel: false };
    }

    // Allow user avatars, profile header backgrounds, and static UI assets
    if (
      details.url.includes('/user-profile/') ||
      details.url.includes('/background/') ||
      details.url.includes('/common/')
    ) {
      logDebug('Allowed profile/UI asset');
      return { cancel: false };
    }

    // Resolve the URL of the page this request belongs to. Prefer the live tab URL
    // (which reflects in-page/SPA navigation), then Firefox's documentUrl/originUrl,
    // and finally the content-script-tracked tabUrls map as a last resort.
    let pageUrl = '';
    try {
      const tab = await browser.tabs.get(details.tabId);
      pageUrl = tab.url || '';
    } catch (error) {
      logDebug(`tabs.get failed for tabId=${details.tabId}: ${error.message}`);
    }
    if (!pageUrl) {
      pageUrl = details.documentUrl || details.originUrl || tabUrls.get(details.tabId) || '';
    }

    const candidateUrls = [
      pageUrl,
      details.documentUrl || '',
      details.originUrl || '',
      tabUrls.get(details.tabId) || '',
    ];

    const isBookmarksPage = (rawUrl) => {
      try {
        const url = new URL(rawUrl);
        return url.hostname === 'www.pixiv.net' && /\/(?:en\/)?users\/\d+\/bookmarks(?:\/|$)/i.test(url.pathname);
      } catch {
        return false;
      }
    };

    if (candidateUrls.some(isBookmarksPage)) {
      logDebug('Bookmarks page detected; allowing request');
      return { cancel: false };
    }

    const match = pageUrl.match(PROFILE_URL_REGEX);

    if (match && settings.blacklist.has(match[1])) {
      const msg = `Blocked profile artwork image for blacklisted user ${match[1]}: ${details.url}`;
      logDebug(msg);
      return { cancel: true };
    }

    // Block main artwork image requests on a blacklisted artist's artwork page
    const artworkMatch = pageUrl.match(/pixiv\.net\/(?:en\/)?artworks\/(\d+)/i);
    if (artworkMatch) {
      const artworkId = artworkMatch[1];
      const authorId = tabArtworkAuthors.get(details.tabId);
      // Block if the image URL belongs to the current artwork ID and the author is blacklisted
      if (authorId && settings.blacklist.has(authorId) && details.url.includes(`/${artworkId}_p`)) {
        logDebug(`Blocked main artwork image for blacklisted user ${authorId}: ${details.url}`);
        return { cancel: true };
      }
    }

    return { cancel: false };
  };
}

function updateProfileImageBlockListener() {
  const shouldListen = settings.hideBlockedArtistProfileArtworks && settings.blacklist.size > 0;
  logDebug(
    `[background] updateProfileImageBlockListener: hideBlockedArtistProfileArtworks=${settings.hideBlockedArtistProfileArtworks}, blacklistSize=${settings.blacklist.size}, shouldListen=${shouldListen}`,
  );
  if (shouldListen && !profileImageBlockListener) {
    try {
      profileImageBlockListener = createProfileImageBlockListener();
      browser.webRequest.onBeforeRequest.addListener(
        profileImageBlockListener,
        {
          urls: ['*://*.pximg.net/*'],
          types: ['image', 'imageset'],
        },
        ['blocking'],
      );
      browser.webRequest.handlerBehaviorChanged?.();
      logDebug('Added profile image webRequest blocker');
    } catch (error) {
      console.error('[background] Failed to add profile image webRequest blocker:', error);
    }
  } else if (!shouldListen && profileImageBlockListener) {
    browser.webRequest.onBeforeRequest.removeListener(profileImageBlockListener);
    profileImageBlockListener = null;
    browser.webRequest.handlerBehaviorChanged?.();
    logDebug('Removed profile image webRequest blocker');
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

    logDebug('Context menus created successfully');
  } catch (error) {
    console.error('Critical error setting up context menus:', error);
  }
}

// Initial menu setup on installation or update
browser.runtime.onInstalled.addListener(setupContextMenus);

// Fallback: Re-create menus when the browser profile starts
browser.runtime.onStartup.addListener(setupContextMenus);

browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.tab && sender.tab.id && sender.url) {
    tabUrls.set(sender.tab.id, sender.url);
  }

  if (message.action === 'updateTabUrl') {
    if (sender.tab && sender.tab.id) {
      tabUrls.set(sender.tab.id, message.url || sender.url);
      logDebug(`Updated tabUrl for tab ${sender.tab.id}: ${message.url}`);
    }
  } else if (message.action === 'setBadge') {
    const text = message.count > 0 ? message.count.toString() : '';
    browser.action.setBadgeText({ text });
    if (message.count > 0) {
      browser.action.setBadgeBackgroundColor({ color: '#666' });
    }
    logDebug(`Badge set to "${text}"`);
  } else if (message.action === 'refreshBlacklist') {
    loadSettings();
  } else if (message.action === 'resetBatchCount') {
    if (sender.tab && sender.tab.id) {
      batchCounts.set(sender.tab.id, 0);
      logDebug(`Reset batch count for tab ${sender.tab.id}`);
    }
  } else if (message.action === 'getManualBackup') {
    // Return the payload Promise directly to options.js
    return backupManager.getManualBackupPayload();
  } else if (message.action === 'setArtworkAuthor') {
    if (sender.tab && sender.tab.id) {
      tabArtworkAuthors.set(sender.tab.id, message.authorId);
      logDebug(`Updated artwork author for tab ${sender.tab.id}: ${message.authorId}`);
    }
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

// Clean up tab-specific data when a tab is closed
browser.tabs.onRemoved.addListener((tabId) => {
  tabUrls.delete(tabId);
  tabArtworkAuthors.delete(tabId);
  batchCounts.delete(tabId);
});

// Open options page when toolbar icon is clicked
browser.action.onClicked.addListener(() => {
  browser.runtime.openOptionsPage();
});

// Handle global permission revocation
browser.permissions.onRemoved.addListener((permissions) => {
  if (permissions.permissions && permissions.permissions.includes('downloads')) {
    logDebug('Downloads permission revoked. Disabling auto-backup.');
    // Writing to storage will automatically propagate to options UI and the backupManager
    browser.storage.local.set({ autoBackup: false });
  }
});

// Listen for storage changes
browser.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.debugMode) {
      DEBUG = changes.debugMode.newValue ?? false;
      logDebug('Debug mode changed to:', DEBUG);
    }
    if (changes.autoBackup !== undefined) {
      autoBackupEnabled = changes.autoBackup.newValue ?? false;
      logDebug('Auto backup state changed to:', autoBackupEnabled);
      backupManager.updateAlarmState(autoBackupEnabled);
    }
    if (changes.blacklist !== undefined) {
      settings.blacklist = new Set((changes.blacklist.newValue || []).map((id) => String(id).trim()));
      updateProfileImageBlockListener();
      browser.webRequest.handlerBehaviorChanged?.();
    }
  } else if (namespace === 'sync') {
    if (changes.limitRecommendations !== undefined) {
      settings.limitRecommendations = changes.limitRecommendations.newValue;
      updateWebRequestListener(); // Refresh listener if needed
    }
    if (changes.maxRecommendations !== undefined) {
      settings.maxRecommendations = changes.maxRecommendations.newValue;
    }
    if (changes.hideBlockedArtistProfileArtworks !== undefined) {
      settings.hideBlockedArtistProfileArtworks = changes.hideBlockedArtistProfileArtworks.newValue;
      updateProfileImageBlockListener();
      browser.webRequest.handlerBehaviorChanged?.();
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
    // Fetch all current storage data from both areas
    const syncData = await browser.storage.sync.get(null);
    const localData = await browser.storage.local.get(null);

    // Remove the backup manager's internal history state so it's not included in the backup
    delete localData.backup_manager_state;

    // Combine them into a single payload
    return { ...syncData, ...localData };
  },
);

backupManager.init();

// Load settings after everything else is set up
loadSettings();
