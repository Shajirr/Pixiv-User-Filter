const DEBUG = false; // Toggle for debug logging

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

function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

async function loadSettings() {
  try {
    const result = await browser.storage.local.get(['blacklist', 'removeSameAuthor']);
    settings.blacklist = new Set(result.blacklist || []);
    settings.removeSameAuthor = result.removeSameAuthor || false;
    logDebug(`[loadSettings] Loaded settings: blacklist=${[...settings.blacklist].join(', ')}, removeSameAuthor=${settings.removeSameAuthor}`);
  } catch (error) {
    console.error('[loadSettings] Error:', error);
  }
}

const selectors = {
  artworkGrid: 'ul.sc-bf8cea3f-1.bCxfvI',
  tagGrid: 'ul.sc-98699d11-1.hHLaTl',
  userLink: 'a[data-gtm-user-id], a[href*="/users/"], a[href*="/en/users/"]',
  artworkHeader: 'h2.sc-a6755c3a-3.glkuHK',
  tagOuterDiv: 'div.sc-a6755c3a-0.dlidhK',
  tagHeader: 'h3.sc-a6755c3a-3.glkuHK',
  tagInnerDiv: 'div.sc-a6755c3a-1.fStzca',
  tagAnchor: 'div.sc-a6755c3a-2.eYChEb',
  tagCount: 'div.sc-b5e6ab10-0.hfQbJx',
  followButton: 'button[data-gtm-user-id]',
  profileLink: 'section.sc-7d1a8035-1 a[data-gtm-value]'
};

function updateCounter() {
  try {
    if (counterElement) {
      counterElement.textContent = `Removed: ${removedCount}`;
      logDebug(`[updateCounter] Updated counter to display: Removed: ${removedCount}`);
    } else {
      logDebug('[updateCounter] Counter element not found, cannot update counter');
    }
    browser.runtime.sendMessage({ action: "setBadge", count: removedCount });
  } catch (error) {
    console.error('[updateCounter] Error:', error);
  }
}

function getArtworkGridContainers() {
  const isArtwork = /\/en\/artworks\/\d+$/.test(window.location.pathname);
  logDebug(`[getArtworkGridContainers] Selecting artwork grid containers for ${isArtwork ? 'artwork' : 'tag'} page`);
  const selector = isArtwork ? selectors.artworkGrid : selectors.tagGrid;
  const containers = Array.from(document.querySelectorAll(selector));
  logDebug(`[getArtworkGridContainers] Found ${containers.length} grid containers`);
  return containers;
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

function createCounter(attempt = 1, maxAttempts = 3) {
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
          anchor = document.querySelector(selectors.artworkHeader);
          logDebug(`[createCounter] Artwork page: h2.glkuHK anchor ${anchor ? 'found' : 'not found'}`);
        } else {
          const outerDivs = document.querySelectorAll(selectors.tagOuterDiv);
          for (const outerDiv of outerDivs) {
            const h3 = outerDiv.querySelector(selectors.tagHeader);
            if (h3) {
              const h3Text = h3.textContent;
              if (/^(Illustrations and Manga|Works)$/i.test(h3Text) && !/popular/i.test(h3Text)) {
                anchor = h3;
                logDebug(`[createCounter] Tag page: Selected h3 with text "${h3Text}" as anchor`);
                break;
              }
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
          logDebug(`[createCounter] Inserted counter after ${isArtwork ? 'h2' : 'h3'}`);

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
    logDebug('[refreshArtworks] Refreshing artworks due to blacklist update');
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
    }
  } catch (error) {
    console.error('[updatePage] Error:', error);
  }
}

async function main() {
  try {
    logDebug('[main] main function started');
    await loadSettings();
    updatePage();
    browser.runtime.onMessage.addListener((message) => {
      if (message.action === "refreshBlacklist" && isFilterablePage()) {
        logDebug('[main] Received refreshBlacklist message on filterable page');
        loadSettings().then(() => refreshArtworks());
      }
    });
    window.addEventListener('popstate', () => {
      if (window.location.pathname !== lastPathname) {
        logDebug('[main] Navigation detected via URL change from', lastPathname, 'to', window.location.pathname);
        lastPathname = window.location.pathname;
        updatePage();
      }
    });
    const titleObserver = new MutationObserver(() => {
      logDebug('[titleObserver] Title changed, updating page');
      updatePage();
    });
    titleObserver.observe(document.querySelector('title'), { childList: true });
    logDebug('[main] Navigation listeners set up');
  } catch (error) {
    console.error('[main] Error:', error);
  }
}

main();