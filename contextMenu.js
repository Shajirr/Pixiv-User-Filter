browser.contextMenus.removeAll(() => {
  // console.log('Cleared existing context menus');
  browser.contextMenus.create({
    id: "pixiv-blacklist",
    title: "Pixiv User Filter",
    contexts: ["link"]
  }, () => {
    if (browser.runtime.lastError) {
      // console.error("Error creating parent menu:", browser.runtime.lastError);
    } else {
      // console.log("Parent menu created successfully");
    }
  });

  browser.contextMenus.create({
    id: "add-to-blacklist",
    parentId: "pixiv-blacklist",
    title: "Add User to Blacklist",
    contexts: ["link"]
  }, () => {
    if (browser.runtime.lastError) {
      // console.error("Error creating add-to-blacklist submenu:", browser.runtime.lastError);
    } else {
      // console.log("Add-to-blacklist submenu created successfully");
    }
  });

  browser.contextMenus.create({
    id: "remove-from-blacklist",
    parentId: "pixiv-blacklist",
    title: "Remove User from Blacklist",
    contexts: ["link"]
  }, () => {
    if (browser.runtime.lastError) {
      // console.error("Error creating remove-from-blacklist submenu:", browser.runtime.lastError);
    } else {
      // console.log("Remove-from-blacklist submenu created successfully");
    }
  });
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  const linkUrl = info.linkUrl;
  const match = linkUrl.match(/\/en\/users\/(\d+)/);
  if (!match) {
    // console.log("Invalid user URL:", linkUrl);
    browser.notifications.create({
      type: "basic",
      title: "Pixiv User Filter",
      message: "Invalid user URL. Please select a valid user profile link.",
      iconUrl: "icon.svg"
    });
    return;
  }
  const userId = match[1];

  if (info.menuItemId === "add-to-blacklist") {
    browser.storage.local.get('blacklist').then(result => {
      const blacklist = new Set(result.blacklist || []);
      if (!blacklist.has(userId)) {
        blacklist.add(userId);
        browser.storage.local.set({ blacklist: Array.from(blacklist) }).then(() => {
          // console.log(`Added user ID ${userId} to blacklist`);
          browser.notifications.create({
            type: "basic",
            title: "Pixiv User Filter",
            message: `User ID ${userId} added to blacklist`,
            iconUrl: "icon.svg"
          });
          browser.tabs.sendMessage(tab.id, { action: "refreshBlacklist" });
        }).catch(error => {
          // console.error("Error saving blacklist:", error);
          browser.notifications.create({
            type: "basic",
            title: "Pixiv User Filter",
            message: `Failed to add user ID ${userId} to blacklist: ${error.message}`,
            iconUrl: "icon.svg"
          });
        });
      } else {
        // console.log(`User ID ${userId} already in blacklist`);
        browser.notifications.create({
          type: "basic",
          title: "Pixiv User Filter",
          message: `User ID ${userId} is already in the blacklist`,
          iconUrl: "icon.svg"
        });
      }
    }).catch(error => {
      // console.error("Error retrieving blacklist:", error);
      browser.notifications.create({
        type: "basic",
        title: "Pixiv User Filter",
        message: `Failed to retrieve blacklist: ${error.message}`,
        iconUrl: "icon.svg"
      });
    });
  } else if (info.menuItemId === "remove-from-blacklist") {
    browser.storage.local.get('blacklist').then(result => {
      const blacklist = new Set(result.blacklist || []);
      if (blacklist.has(userId)) {
        blacklist.delete(userId);
        browser.storage.local.set({ blacklist: Array.from(blacklist) }).then(() => {
          // console.log(`Removed user ID ${userId} from blacklist`);
          browser.notifications.create({
            type: "basic",
            title: "Pixiv User Filter",
            message: `User ID ${userId} removed from blacklist`,
            iconUrl: "icon.svg"
          });
          browser.tabs.sendMessage(tab.id, { action: "refreshBlacklist" });
        }).catch(error => {
          // console.error("Error saving blacklist:", error);
          browser.notifications.create({
            type: "basic",
            title: "Pixiv User Filter",
            message: `Failed to remove user ID ${userId} from blacklist: ${error.message}`,
            iconUrl: "icon.svg"
          });
        });
      } else {
        // console.log(`User ID ${userId} not in blacklist`);
        browser.notifications.create({
          type: "basic",
          title: "Pixiv User Filter",
          message: `User ID ${userId} is not in the blacklist`,
          iconUrl: "icon.svg"
        });
      }
    }).catch(error => {
      // console.error("Error retrieving blacklist:", error);
      browser.notifications.create({
        type: "basic",
        title: "Pixiv User Filter",
        message: `Failed to retrieve blacklist: ${error.message}`,
        iconUrl: "icon.svg"
      });
    });
  }
});