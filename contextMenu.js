const DEBUG = true; // Toggle for debug logging

function logDebug(...args) {
  if (DEBUG) console.log(...args);
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

browser.contextMenus.removeAll().then(() => {
  logDebug('Cleared existing context menus');
  browser.contextMenus.create({
    id: "pixiv-blacklist",
    title: "Pixiv User Filter",
    contexts: ["link"]
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
    contexts: ["link"]
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
    contexts: ["link"]
  }, () => {
    if (browser.runtime.lastError) {
      console.error("Error creating remove-from-blacklist submenu:", browser.runtime.lastError);
    } else {
      logDebug("Remove-from-blacklist submenu created successfully");
    }
  });
}).catch(error => {
  console.error("Error initializing context menus:", error);
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  const linkUrl = info.linkUrl;
  const match = linkUrl.match(/\/en\/users\/(\d+)/);
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

browser.runtime.onMessage.addListener((message) => {
  if (message.action === "setBadge") {
    const text = message.count > 0 ? message.count.toString() : "";
    browser.action.setBadgeText({ text });
    if (message.count > 0) {
      browser.action.setBadgeBackgroundColor({ color: "#666" });
    }
    logDebug(`[setBadge] Badge set to "${text}"`);
  }
});