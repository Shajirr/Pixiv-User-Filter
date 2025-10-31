const DEBUG = true; // Toggle for debug logging

function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

let settings = { blacklist: new Set(), removeSameAuthor: false };
let removedCount = 0;
let counterElement = null;
let recommendationObservers = [];
let lastPathname = window.location.pathname;
let currentAuthorId = null;
let processedLiElements = new WeakSet();
let thumbnailFixerEnabled = false;

function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

async function loadSettings() {
  try {
    const result = await browser.storage.local.get(['blacklist', 'removeSameAuthor', 'thumbnailFixer']);
    settings.blacklist = new Set(result.blacklist || []);
    settings.removeSameAuthor = result.removeSameAuthor || false;
    thumbnailFixerEnabled = result.thumbnailFixer || false;
    
    logDebug(`[loadSettings] Loaded settings: blacklist=${[...settings.blacklist].join(', ')}, removeSameAuthor=${settings.removeSameAuthor}, thumbnailFixer=${thumbnailFixerEnabled}`);
        
    // Update thumbnail fixer after loading settings
    ThumbnailFixer.setEnabled(thumbnailFixerEnabled);
    
  } catch (error) {
    console.error('[loadSettings] Error:', error);
  }
}

const selectors = {
  userLink: 'a[data-gtm-user-id], a[href*="/users/"], a[href*="/en/users/"]',
  artworkHeader: 'div div h2, div div h3', // Target both h2 and h3 within nested divs
  tagOuterDiv: 'div', // Generic to catch any outer div
  tagHeader: 'h3', // Generic to catch any h3
  tagInnerDiv: 'div', // Generic to catch any inner div
  tagAnchor: 'div', // Generic to catch any anchor div
  tagCount: 'div span', // Generic to catch count spans
  followButton: 'button[data-gtm-user-id]',
  profileLink: 'section a[data-gtm-value]'
};

function updateCounter() {
  try {
    if (counterElement) {
      counterElement.textContent = `Removed: ${removedCount}`;
      logDebug(`[updateCounter] Updated counter to display: Removed: ${removedCount}`);
    } else {
      logDebug('[updateCounter] Counter element not found, cannot update counter');
    }
    if (document.visibilityState === 'visible') {
      browser.runtime.sendMessage({ action: "setBadge", count: removedCount });
      logDebug(`[updateCounter] Updated badge with count: ${removedCount} (tab is visible)`);
    } else {
      logDebug(`[updateCounter] Skipped badge update (tab is not visible)`);
    }
  } catch (error) {
    console.error('[updateCounter] Error:', error);
  }
}

function findArtworkGridsByContent() {
    const allULs = document.querySelectorAll('ul');
    const candidates = [];
    
    for (const ul of allULs) {
      const artworkLinks = ul.querySelectorAll('a[href*="/artworks/"]');
      const hasImages = ul.querySelector('li img');
      // Must have at least 1 artwork link and contain images
      if (artworkLinks.length > 0 && hasImages) {
        candidates.push(ul);
        logDebug(`[findArtworkGridsByContent] Candidate grid with ${artworkLinks.length} artworks`, ul);
      }
    }
  logDebug(`[findArtworkGridsByContent] Found ${candidates.length} valid grid(s)`);
  return candidates;
}

function getArtworkGridContainers() {
  const isArtworkPage = /\/en\/artworks\/\d+$/.test(window.location.pathname);
  logDebug(`[getArtworkGridContainers] Detecting grids on ${isArtworkPage ? 'artwork' : 'tag'} page`);

  let grids = [];

  if (isArtworkPage) {
    // First use stable GTM class
    const gtmContainer = document.querySelector('div.gtm-illust-recommend-zone');
    if (gtmContainer) {
      const ul = gtmContainer.querySelector('ul');
      if (ul && ul.querySelector('li a[href*="/artworks/"]')) {
        grids.push(ul);
        logDebug('[getArtworkGridContainers] Found grid via gtm-illust-recommend-zone');
      }
    }

    // Fallback - content-based search
    if (grids.length === 0) {
      logDebug('[getArtworkGridContainers] Falling back to content-based detection');
      grids = findArtworkGridsByContent();
    }
  } else {
    // Tag page - content-based search only
    grids = findArtworkGridsByContent();
  }

  // Dedupe
  grids = [...new Set(grids)];
  logDebug(`[getArtworkGridContainers] Final: ${grids.length} grid(s) found`);
  return grids;
}

function updateAllArtworks(attempt = 1, maxAttempts = 3) {
  try {
    logDebug('[updateAllArtworks] Starting artwork update');
    const containers = getArtworkGridContainers();
    let totalProcessed = 0;
    let totalBlocked = 0;
    let newlyProcessed = 0;
    
    // Collect elements for batch DOM style changes
    const elementsToHide = [];
    const elementsToShow = [];
    containers.forEach(container => {
      const lis = container.querySelectorAll('li');
      totalProcessed += lis.length;
      lis.forEach(li => {
        const result = processLi(li, settings.blacklist, currentAuthorId, settings.removeSameAuthor);
        const { shouldBlock, alreadyProcessed } = result;
        if (shouldBlock) {
          totalBlocked++;
		  // Only add to batch if current display doesn't match desired state
          if (li.style.display !== 'none') {
            elementsToHide.push(li);
          }
        } else {
          // Only add to batch if current display doesn't match desired state
          if (li.style.display === 'none') {
            elementsToShow.push(li);
          }
        }
        
        if (!alreadyProcessed) newlyProcessed++;
      });
    });
    
    // Apply DOM changes in batches using requestAnimationFrame
    if (elementsToHide.length > 0 || elementsToShow.length > 0) {
      requestAnimationFrame(() => {
        logDebug(`[updateAllArtworks] Batching style changes: hiding ${elementsToHide.length}, unhiding ${elementsToShow.length}`);
        elementsToHide.forEach(el => el.style.display = 'none');
        elementsToShow.forEach(el => el.style.display = '');
      });
    }
    if (totalProcessed === 0 && attempt < maxAttempts) {
      logDebug(`[updateAllArtworks] No items found, retrying attempt ${attempt}/${maxAttempts}`);
      setTimeout(() => updateAllArtworks(attempt + 1, maxAttempts), 1000);
      return;
    }
    
    removedCount = totalBlocked;
    logDebug(`[updateAllArtworks] Processed ${totalProcessed} items (${newlyProcessed} new), blocked ${totalBlocked} total`);
    updateCounter();
  } catch (error) {
    console.error('[updateAllArtworks] Error:', error);
  }
}

function createCounter(attempt = 1, maxAttempts = 4) {
  return new Promise(resolve => {
    const delay = attempt === 1 ? 1500 : 2000;
    logDebug(`[createCounter] Scheduling attempt ${attempt}/${maxAttempts} in ${delay}ms at ${new Date().toISOString()}`);
    setTimeout(() => {
      logDebug(`[createCounter] Attempt ${attempt}/${maxAttempts} started at ${new Date().toISOString()}`);
      try {
        // Remove existing counters
        const existingCounters = document.querySelectorAll('span.pixiv-recommendation-counter');
        existingCounters.forEach(counter => counter.remove());

        const isArtwork = /\/en\/artworks\/\d+$/.test(window.location.pathname);
        logDebug(`[createCounter] Page type: ${isArtwork ? 'Artwork' : 'Tag'} (URL: ${window.location.pathname})`);
        
        let anchor = null;
        if (isArtwork) {
          const headers = document.querySelectorAll(selectors.artworkHeader);
          for (const header of headers) {
            const text = header.textContent.trim();
            if (['Recommended works', 'Related works', 'Works', 'Illustrations'].includes(text)) {
              anchor = header;
              logDebug(`[createCounter] Artwork page: Found ${header.tagName.toLowerCase()} with text "${text}"`);
              break;
            }
          }
          logDebug(`[createCounter] Artwork page: anchor ${anchor ? 'found' : 'not found'}`);
        } else {
          const outerDivs = document.querySelectorAll(selectors.tagOuterDiv);
          for (const outerDiv of outerDivs) {
            const h3 = outerDiv.querySelector(selectors.tagHeader);
            if (h3) {
              const h3Text = h3.textContent.trim();
              if (h3Text.includes('Works') || h3Text.includes('Illustrations') || h3Text.includes('Manga')) {
                anchor = h3;
                logDebug(`[createCounter] Tag page: Selected h3 with text "${h3Text}" as anchor`);
                break;
              }
            }
          }
        }

        if (!anchor) {
          // Fallback: try finding any h3 with "Works" or "Illustrations"
          const headers = document.querySelectorAll('h3');
          for (const header of headers) {
            const text = header.textContent.trim();
            if (text.includes('Works') || text.includes('Illustrations') || text.includes('Manga')) {
              anchor = header;
              logDebug(`[createCounter] Fallback: Found h3 with text "${text}"`);
              break;
            }
          }
        }
        if (anchor) {
          counterElement = document.createElement('span');
          counterElement.className = 'pixiv-recommendation-counter';
          counterElement.style.marginLeft = '10px';
          counterElement.style.fontSize = '14px';
          counterElement.style.color = '#555';
          counterElement.style.display = 'inline-block';
          counterElement.style.verticalAlign = 'middle';
          counterElement.textContent = `Removed: ${removedCount}`;
          anchor.insertAdjacentElement('afterend', counterElement);
          logDebug(`[createCounter] Inserted counter after ${anchor.tagName.toLowerCase()}`);

          // Observe a higher-level parent (e.g., <main> or <body>) for DOM changes
          const parent = document.querySelector('main') || document.body;
          if (parent) {
            const observer = new MutationObserver((mutations) => {
              if (!parent.querySelector('span.pixiv-recommendation-counter')) {
                logDebug('[createCounter] Counter removed, scheduling recreation');
                setTimeout(() => createCounter(1, maxAttempts), 1000);
              } else {
                logDebug('[createCounter] Counter still present');
              }
            });
            observer.observe(parent, { childList: true, subtree: true });
            recommendationObservers.push(observer);
            logDebug('[createCounter] Set up observer on main/body for counter persistence');
          }
          resolve(true);
        } else {
          logDebug(`[createCounter] No suitable anchor found`);
          if (attempt < maxAttempts) {
            resolve(createCounter(attempt + 1, maxAttempts));
          } else {
            console.error(`[createCounter] Max attempts (${maxAttempts}) reached`);
            resolve(false);
          }
        }
      } catch (error) {
        console.error(`[createCounter] Error: ${error.message}`, error.stack);
        resolve(false);
      }
    }, delay);
  });
}

function getPageAuthorId(attempt = 1, maxAttempts = 5) {
  logDebug(`[getPageAuthorId] Attempt ${attempt}/${maxAttempts}`);
  try {
    const followButton = document.querySelector(selectors.followButton);
    if (followButton) {
      const id = followButton.getAttribute('data-gtm-user-id');
      logDebug(`[getPageAuthorId] Author ID found from button: ${id}`);
      return Promise.resolve(id);
    }
    const link = document.querySelector(selectors.profileLink);
    if (link) {
      const id = link.getAttribute('data-gtm-value');
      logDebug(`[getPageAuthorId] Author ID found from link: ${id}`);
      return Promise.resolve(id);
    }
    logDebug('[getPageAuthorId] Author ID not found');
    if (attempt < maxAttempts) {
      logDebug(`[getPageAuthorId] Retrying in 1000ms...`);
      return new Promise(resolve => {
        setTimeout(() => {
          resolve(getPageAuthorId(attempt + 1, maxAttempts));
        }, attempt === 1 ? 1500 : 1000);
      });
    }
    logDebug(`[getPageAuthorId] Max attempts reached, no author ID found`);
    return Promise.resolve(null);
  } catch (error) {
    console.error(`[getPageAuthorId] Error (attempt ${attempt}):`, error);
    return Promise.resolve(null);
  }
}

function processLi(li, blacklist, authorId, removeSameAuthor) {
  // Skip if already processed
  if (processedLiElements.has(li)) {
    return { 
      userId: null, 
      shouldBlock: li.style.display === 'none',
      alreadyProcessed: true 
    };
  }

  let userId = null;
  let shouldBlock = false;
  try {
    const userLink = li.querySelector(selectors.userLink);
    if (!userLink) {
      processedLiElements.add(li);
      return { userId: null, shouldBlock: false, alreadyProcessed: false };
    }

    userId = userLink.getAttribute('data-gtm-user-id');
    if (!userId) {
      const match = userLink.href.match(/\/(?:en\/)?users\/(\d+)/);
      userId = match ? match[1] : null;
    }

    // Early return if no userId found
    if (!userId) {
      processedLiElements.add(li);
	  console.error('[processLi] Error: no userId found for ', li);
      return { userId: null, shouldBlock: false, alreadyProcessed: false };
    }

    // Check blacklist first (more common case)
    if (blacklist.has(userId)) {
      shouldBlock = true;
    } else if (removeSameAuthor && authorId && userId === authorId) {
      shouldBlock = true;
    }

    // Mark as processed
    processedLiElements.add(li);
  } catch (error) {
    console.error('[processLi] Error:', error);
    processedLiElements.add(li); // Mark as processed even on error
  }
  return { userId, shouldBlock, alreadyProcessed: false };
}

function processArtworks(blacklist, authorId, removeSameAuthor) {
  try {
    logDebug('[processArtworks] Starting artwork processing');
    logDebug(`[processArtworks] Blacklist contains ${blacklist.size} user IDs: ${[...blacklist].join(', ')}`);
    logDebug(`[processArtworks] Author ID: ${authorId}, removeSameAuthor: ${removeSameAuthor}`);
    
    settings.blacklist = blacklist;
    currentAuthorId = authorId;
    settings.removeSameAuthor = removeSameAuthor;
    updateAllArtworks();
  } catch (error) {
    console.error('[processArtworks] Error:', error);
  }
}

function isFilterablePage() {
  const regex = /\/en\/(artworks\/\d+|tags\/.*)$/;
  logDebug(`[isFilterablePage] Checking URL ${window.location.pathname}: ${regex.test(window.location.pathname) ? 'filterable' : 'non-filterable'}`);
  return regex.test(window.location.pathname);
}

function setupArtworkObserver() {
  try {
    recommendationObservers.forEach(observer => observer.disconnect());
    recommendationObservers = [];
    logDebug('[setupArtworkObserver] Cleared previous observers');

    const containers = getArtworkGridContainers();
    logDebug(`[setupArtworkObserver] Setting up observers for ${containers.length} grid containers`);
    
    // More targeted debounced function for new items only
    let isProcessing = false;
    const debouncedProcessNewItems = debounce(() => {
      if (isProcessing) {
        logDebug('[setupArtworkObserver] Already processing, skipping');
        return;
      }
      isProcessing = true;
      logDebug('[setupArtworkObserver] Processing potentially new items');
      updateAllArtworks();
      // Reset flag after a short delay
      setTimeout(() => { isProcessing = false; }, 100);
    }, 300);
    
    containers.forEach((container, index) => {
      logDebug(`[setupArtworkObserver] Setting up observer for container[${index}]: ${container.outerHTML.substring(0, 200)}...`);
      const observer = new MutationObserver(mutations => {
        // Only trigger if new li elements were actually added
        let hasNewLiElements = false;
        
        // More efficient mutation checking
        for (const mutation of mutations) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.tagName === 'LI' || node.querySelector?.('li')) {
                  hasNewLiElements = true;
                  break;
                }
              }
            }
            if (hasNewLiElements) break;
          }
        }
        
        if (hasNewLiElements) {
          logDebug('[setupArtworkObserver] New li elements detected, processing');
          debouncedProcessNewItems();
        }
      });
      observer.observe(container, { childList: true });
      recommendationObservers.push(observer);
    });
  } catch (error) {
    console.error('[setupArtworkObserver] Error:', error);
  }
}

function refreshArtworks() {
  try {
    logDebug('[refreshArtworks] Refreshing artworks due to settings update');

    if (isFilterablePage()) {
      // Clear processed elements cache when blacklist changes
      processedLiElements = new WeakSet();
      logDebug('[refreshArtworks] Cleared processed elements cache');
      
      logDebug(`[refreshArtworks] Remove same author toggle: ${settings.removeSameAuthor}`);
      logDebug(`[refreshArtworks] Blacklist: ${[...settings.blacklist].join(', ')}`);
      removedCount = 0; // Reset for all pages during blacklist update
      logDebug('[refreshArtworks] Reset removedCount to 0 for blacklist update');
      if (!counterElement) {
        createCounter().then(success => {
          if (!success) {
            logDebug('[refreshArtworks] Proceeding with artwork processing despite counter creation failure');
          }
          recommendationObservers.forEach(observer => observer.disconnect());
          recommendationObservers = [];
		  logDebug('[refreshArtworks] Disconnected previous recommendation observers for blacklist update');
          processArtworks(settings.blacklist, currentAuthorId, settings.removeSameAuthor);
          setupArtworkObserver();
        });
      } else {
        recommendationObservers.forEach(observer => observer.disconnect());
        recommendationObservers = [];
		logDebug('[refreshArtworks] Disconnected previous recommendation observers for blacklist update');
        processArtworks(settings.blacklist, currentAuthorId, settings.removeSameAuthor);
        setupArtworkObserver();
      }
    }
  } catch (error) {
    console.error('[refreshArtworks] Error:', error);
  }
}

function updatePage() {
  try {
    logDebug('[updatePage] Updating page for URL:', window.location.pathname);
    
    // Clear processed elements cache on page change
    processedLiElements = new WeakSet();
    logDebug('[updatePage] Cleared processed elements cache for new page');
    
    recommendationObservers.forEach(observer => observer.disconnect());
    recommendationObservers = [];
    logDebug('[updatePage] Disconnected previous recommendation observers');
    
    if (counterElement) {
      counterElement.remove();
      counterElement = null;
      logDebug('[updatePage] Removed previous counter element');
    }
    
    if (isFilterablePage()) {
      logDebug('[updatePage] Filterable page detected, processing recommendations');
      logDebug(`[updatePage] Remove same author toggle: ${settings.removeSameAuthor}`);
      logDebug(`[updatePage] Blacklist: ${[...settings.blacklist].join(', ')}`);
      
      const isArtwork = /\/en\/artworks\/\d+$/.test(window.location.pathname);
      const authorPromise = isArtwork ? getPageAuthorId() : Promise.resolve(null);
      
      authorPromise.then(authorId => {
        currentAuthorId = authorId;
        logDebug(`[updatePage] Final author ID: ${authorId}`);
        removedCount = 0;
        createCounter().then(() => {
          processArtworks(settings.blacklist, currentAuthorId, settings.removeSameAuthor && isArtwork);
          setupArtworkObserver();
          updateCounter();
        });
      }).catch(error => {
        console.error('[updatePage] Error resolving getPageAuthorId:', error);
      });
    } else {
      logDebug('[updatePage] Non-filterable page, skipping recommendation processing');
      removedCount = 0;
      currentAuthorId = null;
      if (document.visibilityState === 'visible') {
        browser.runtime.sendMessage({ action: "setBadge", count: 0 });
        logDebug('[updatePage] Non-filterable page, reset badge to 0 (tab is visible)');
      }
    }
  } catch (error) {
    console.error('[updatePage] Error:', error);
  }
}

async function main() {
  try {
    logDebug('[main] main function started');
    await loadSettings();
    
    // Initialize thumbnail fixer for all Pixiv pages
    ThumbnailFixer.init(thumbnailFixerEnabled);
    
    // Process user filtering only on filterable pages
    if (isFilterablePage()) {
      updatePage();
    } else {
      logDebug('[main] Non-filterable page, skipping user filtering');
      removedCount = 0;
      currentAuthorId = null;
      if (document.visibilityState === 'visible') {
        browser.runtime.sendMessage({ action: "setBadge", count: 0 });
        logDebug('[main] Non-filterable page, reset badge to 0 (tab is visible)');
      }
    }
    
    browser.runtime.onMessage.addListener((message) => {
      if (message.action === "refreshBlacklist") {
        logDebug('[main] Received refreshBlacklist message');
        loadSettings().then(() => {
          // Update thumbnail fixer on all pages
          ThumbnailFixer.setEnabled(thumbnailFixerEnabled);
            if (isFilterablePage()) {
              logDebug('[main] Processing refreshBlacklist on filterable page');
              refreshArtworks();
            }
        });
      }
    });
    
    window.addEventListener('popstate', () => {
      if (window.location.pathname !== lastPathname) {
        logDebug('[main] Navigation detected via URL change from', lastPathname, 'to', window.location.pathname);
        lastPathname = window.location.pathname;
        // Reinitialize thumbnail fixer on navigation
        ThumbnailFixer.setEnabled(thumbnailFixerEnabled);
        if (isFilterablePage()) {
          updatePage();
        } else {
          logDebug('[main] Non-filterable page, skipping user filtering');
          removedCount = 0;
          currentAuthorId = null;
          if (document.visibilityState === 'visible') {
            browser.runtime.sendMessage({ action: "setBadge", count: 0 });
            logDebug('[main] Non-filterable page, reset badge to 0 (tab is visible)');
          }
        }
      }
    });
    const titleObserver = new MutationObserver(() => {
      logDebug('[titleObserver] Title changed, updating page');
      // Reinitialize thumbnail fixer on title change
      ThumbnailFixer.setEnabled(thumbnailFixerEnabled);
      if (isFilterablePage()) {
        updatePage();
      } else {
        logDebug('[titleObserver] Non-filterable page, skipping user filtering');
        removedCount = 0;
        currentAuthorId = null;
        if (document.visibilityState === 'visible') {
          browser.runtime.sendMessage({ action: "setBadge", count: 0 });
          logDebug('[titleObserver] Non-filterable page, reset badge to 0 (tab is visible)');
        }
      }
    });
    titleObserver.observe(document.querySelector('title'), { childList: true });
    // Add visibilitychange listener to update badge when tab becomes active
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        logDebug('[main] Tab became visible, updating badge');
        browser.runtime.sendMessage({ action: "setBadge", count: removedCount });
      }
    });
    
    logDebug('[main] Navigation and visibility listeners set up');
  } catch (error) {
    console.error('[main] Error:', error);
  }
}

main();