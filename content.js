const DEBUG = true; // Toggle for debug logging

function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

const DEFAULT_MAX_RECOMMENDATIONS = 90;

let settings = { blacklist: new Set(), removeSameAuthor: false };
let removedCount = 0;
let counterElement = null;
let recommendationObservers = [];
let tagContentObserver = null;
let lastGridRefreshTime = 0;
let lastPathname = window.location.href;
let currentAuthorId = null;
let processedLiElements = new WeakMap();
let thumbnailFixerEnabled = false;
let limitRecommendations = false;
let maxRecommendations = 90;

function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

async function loadSettings() {
  try {
    const result = await browser.storage.local.get([
      'blacklist',
      'removeSameAuthor',
      'thumbnailFixer',
      'limitRecommendations',
      'maxRecommendations',
    ]);
    settings.blacklist = new Set(result.blacklist || []);
    settings.removeSameAuthor = result.removeSameAuthor || false;
    thumbnailFixerEnabled = result.thumbnailFixer || false;

    limitRecommendations = result.limitRecommendations || false;
    maxRecommendations =
      result.maxRecommendations !== undefined ? result.maxRecommendations : DEFAULT_MAX_RECOMMENDATIONS;

    logDebug(`[loadSettings] limitRecommendations=${limitRecommendations}, maxRecommendations=${maxRecommendations}`);

    logDebug(
      `[loadSettings] Loaded settings: blacklist=${[...settings.blacklist].join(', ')}, removeSameAuthor=${settings.removeSameAuthor}, thumbnailFixer=${thumbnailFixerEnabled}`,
    );

    // Update thumbnail fixer after loading settings
    ThumbnailFixer.setEnabled(thumbnailFixerEnabled);
  } catch (error) {
    console.error('[loadSettings] Error:', error);
  }
}

const selectors = {
  userLink: 'a[data-gtm-user-id], a[href*="/users/"]',
  followButton: 'button[data-gtm-user-id]',
  profileLink: 'section a[data-gtm-value]',
  recommendZone: 'div.gtm-illust-recommend-zone', // Recommendation section
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
      browser.runtime.sendMessage({ action: 'setBadge', count: removedCount });
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

function findTagPageGrids() {
  // Tag pages use a CSS grid of div.col-span-2 cells (no ul/li structure)
  const firstLink = document.querySelector('div.col-span-2 a[href*="/artworks/"]');
  if (!firstLink) return [];
  let cell = firstLink;
  while (cell && !cell.classList.contains('col-span-2')) {
    cell = cell.parentElement;
  }
  if (!cell || !cell.parentElement) return [];
  const gridContainer = cell.parentElement;
  const cells = gridContainer.querySelectorAll('div.col-span-2');
  if (cells.length === 0) return [];
  logDebug(`[findTagPageGrids] Found grid container with ${cells.length} cell(s)`);
  return [gridContainer];
}

function getArtworkGridContainers() {
  const pageType = getPageType();
  const isArtworkPage = pageType === 'artwork';

  logDebug(`[getArtworkGridContainers] Detecting grids on ${isArtworkPage ? 'artwork' : 'tag'} page`);

  let grids = [];

  if (isArtworkPage) {
    // First use stable GTM class
    const gtmContainer = document.querySelector(selectors.recommendZone);
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
    // Tag page - div.col-span-2 grid (no ul/li)
    grids = findTagPageGrids();
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
    containers.forEach((container) => {
      const pageType = getPageType();
      const isArtworkPage = pageType === 'artwork';
      // Tag pages use div.col-span-2 cells; artwork pages use li elements
      const items = isArtworkPage ? container.querySelectorAll('li') : container.querySelectorAll('div.col-span-2');
      totalProcessed += items.length;
      items.forEach((li) => {
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
        logDebug(
          `[updateAllArtworks] Batching style changes: hiding ${elementsToHide.length}, unhiding ${elementsToShow.length}`,
        );
        elementsToHide.forEach((el) => (el.style.display = 'none'));
        elementsToShow.forEach((el) => (el.style.display = ''));
      });
    }

    if (totalProcessed === 0 && attempt < maxAttempts) {
      logDebug(`[updateAllArtworks] No items found, retrying attempt ${attempt}/${maxAttempts}`);
      setTimeout(() => updateAllArtworks(attempt + 1, maxAttempts), 1000);
      return;
    }

    removedCount = totalBlocked;
    logDebug(
      `[updateAllArtworks] Processed ${totalProcessed} items (${newlyProcessed} new), blocked ${totalBlocked} total`,
    );
    updateCounter();
  } catch (error) {
    console.error('[updateAllArtworks] Error:', error);
  }
}

function findRecommendationHeader() {
  // 1. Try GTM first
  const recommendZone = document.querySelector(selectors.recommendZone);
  logDebug(`[findRecommendationHeader] recommendZone: ${recommendZone ? 'found' : 'not found'}`);
  if (recommendZone) {
    const headerContainer = recommendZone.previousElementSibling;
    logDebug(`[findRecommendationHeader] headerContainer: ${headerContainer ? 'found' : 'not found'}`);
    if (headerContainer) {
      const h2 = headerContainer.querySelector('h2');
      logDebug(`[findRecommendationHeader] h2: ${h2 ? 'found' : 'not found'}`);
      if (h2) return h2;
    }
  }

  // 2. Fallback - look relative to the actual artwork grid (Climbing search)
  logDebug('[findRecommendationHeader] Fallback to looking for header relative to artwork grid');
  const containers = getArtworkGridContainers();
  logDebug('[findRecommendationHeader] Grid search found ' + containers.length + ' containers');
  if (containers.length > 0) {
    let current = containers[0];
    logDebug(`[findRecommendationHeader] Starting climb from: ${current.tagName}.${current.className.split(' ')[0]}`);

    // Climb up to 5 levels
    for (let i = 0; i < 5; i++) {
      if (
        !current ||
        current === document.body ||
        current.getAttribute('data-overlay-container') === 'true' ||
        current.id === '__next'
      )
        break;

      // Look at all siblings "above" the current wrapper
      let sibling = current.previousElementSibling;
      while (sibling) {
        // Search the sibling and all its descendants for the H2
        const h2 = sibling.tagName === 'H2' ? sibling : sibling.querySelector('h2');
        if (h2) {
          logDebug(`[findRecommendationHeader] Success! Found H2 inside sibling at Level ${i}`);
          return h2;
        }
        sibling = sibling.previousElementSibling;
      }
      // Move up to the next outer layer
      current = current.parentElement;
    }
  }
  logDebug('[findRecommendationHeader] Looking for header relative to artwork grid: failed');

  // 3. Fallback - text-based search for Artwork pages
  logDebug('[findRecommendationHeader] Fallback to text-based search');
  const h2s = document.querySelectorAll('h2');
  for (const h2 of h2s) {
    const text = h2.textContent.toLowerCase();
    if (text.includes('recommend') || text.includes('related')) {
      return h2;
    }
  }

  logDebug('[findRecommendationHeader] No header found');
  return null;
}

function createCounter(attempt = 1, maxAttempts = 5) {
  const delays = {
    1: 250,
    2: 250,
    3: 500,
    4: 1000,
    5: 1000,
  };
  return new Promise((resolve) => {
    const delay = delays[attempt] || 1000;
    logDebug(
      `[createCounter] Scheduling attempt ${attempt}/${maxAttempts} in ${delay}ms at ${new Date().toISOString()}`,
    );
    setTimeout(() => {
      logDebug(`[createCounter] Attempt ${attempt}/${maxAttempts} started at ${new Date().toISOString()}`);
      try {
        // Remove any existing counters first
        document.querySelectorAll('span.pixiv-recommendation-counter').forEach((counter) => counter.remove());
        counterElement = null;

        const pageType = getPageType();
        const isArtworkPage = pageType === 'artwork';

        logDebug(`[createCounter] Page type: ${isArtworkPage ? 'Artwork' : 'Tag'} (URL: ${window.location.pathname})`);

        let anchor = null;

        if (isArtworkPage) {
          anchor = findRecommendationHeader();
          logDebug(`[createCounter] Artwork page: anchor ${anchor ? 'found' : 'not found'}`);
        } else {
          const worksContent = document.querySelector('div[data-ga4-label="works_content"]');
          if (worksContent) {
            const flexRow = worksContent.querySelector('div.flex.flex-row.justify-between.items-center');
            if (flexRow) {
              const numberSpan = flexRow.querySelector('span.bg-text3, span[class*="bg-text3"]');
              if (numberSpan) {
                // Create wrapper for number + counter (left side)
                const leftWrapper = document.createElement('div');
                leftWrapper.style.display = 'flex';
                leftWrapper.style.alignItems = 'center';
                leftWrapper.style.flexShrink = '0';

                // Move numberSpan into wrapper
                const originalParent = numberSpan.parentNode;
                originalParent.insertBefore(leftWrapper, numberSpan);
                leftWrapper.appendChild(numberSpan);

                // Create empty div to push everything else to the right
                const rightPusher = document.createElement('div');
                rightPusher.style.flexGrow = '1';
                flexRow.appendChild(rightPusher);

                anchor = leftWrapper;
                logDebug('[createCounter] Tag page: Found number span as anchor');
              }
            }
          }
        }

        if (anchor) {
          counterElement = document.createElement('span');
          counterElement.className = 'pixiv-recommendation-counter';
          counterElement.style.marginLeft = '12px';
          counterElement.style.fontSize = '14px';
          counterElement.style.color = '#888';
          counterElement.style.display = 'inline-block';
          counterElement.style.verticalAlign = 'bottom';
          counterElement.textContent = `Removed: ${removedCount}`;

          anchor.insertAdjacentElement('afterend', counterElement);
          logDebug(`[createCounter] Inserted counter after ${anchor.tagName}`);

          // Observe only the anchor's parent for persistence
          const observerTarget = anchor.parentNode;
          if (observerTarget) {
            const observer = new MutationObserver(() => {
              // Only react if the counter is actually missing
              if (!document.querySelector('span.pixiv-recommendation-counter')) {
                logDebug('[createCounter] Counter disappeared, recreating...');
                createCounter(1, maxAttempts);
              }
            });
            observer.observe(observerTarget, { childList: true, subtree: true });
            recommendationObservers.push(observer);
            logDebug('[createCounter] Set up targeted observer on anchor parent for counter persistence');
          }
          resolve(true);
        } else {
          logDebug(`[createCounter] No suitable anchor found (attempt ${attempt})`);
          if (attempt < maxAttempts) {
            resolve(createCounter(attempt + 1, maxAttempts));
          } else {
            console.error(`[createCounter] Max attempts (${maxAttempts}) reached - counter not created`);
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
      return new Promise((resolve) => {
        setTimeout(
          () => {
            resolve(getPageAuthorId(attempt + 1, maxAttempts));
          },
          attempt === 1 ? 1500 : 1000,
        );
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
      shouldBlock: processedLiElements.get(li), // Return the stored result
      alreadyProcessed: true,
    };
  }

  let userId = null;
  let shouldBlock = false;
  try {
    const userLink = li.querySelector(selectors.userLink);
    if (!userLink) {
      processedLiElements.set(li, false); // Store verdict
      return { userId: null, shouldBlock: false, alreadyProcessed: false };
    }

    userId = userLink.getAttribute('data-gtm-user-id');
    if (!userId) {
      const match = userLink.href.match(/pixiv\.net\/(?:en\/)?users\/(\d+)/i);
      userId = match ? match[1] : null;
    }

    // Early return if no userId found
    if (!userId) {
      processedLiElements.set(li, false);
      console.error('[processLi] Error: no userId found for ', li);
      return { userId: null, shouldBlock: false, alreadyProcessed: false };
    }

    // Check blacklist first (more common case)
    if (blacklist.has(userId)) {
      shouldBlock = true;
    } else if (removeSameAuthor && authorId && userId === authorId) {
      shouldBlock = true;
    }

    // Store the verdict in the Map
    processedLiElements.set(li, shouldBlock);
  } catch (error) {
    console.error('[processLi] Error:', error);
    processedLiElements.set(li, false); // Mark as processed even on error
  }
  return { userId, shouldBlock, alreadyProcessed: false };
}

function processArtworks(blacklist, authorId, removeSameAuthor) {
  try {
    logDebug('[processArtworks] Starting artwork processing');
    logDebug(`[processArtworks] Blacklist contains ${blacklist.size} user IDs`);
    logDebug(`[processArtworks] Author ID: ${authorId}, removeSameAuthor: ${removeSameAuthor}`);

    settings.blacklist = blacklist;
    currentAuthorId = authorId;
    settings.removeSameAuthor = removeSameAuthor;
    updateAllArtworks();
  } catch (error) {
    console.error('[processArtworks] Error:', error);
  }
}

function getPageType() {
  const pathname = window.location.pathname;
  const search = window.location.search;

  // Artwork page with recommendations grid
  if (/\/(?:en\/)?artworks\/\d+$/.test(pathname)) {
    logDebug(`[getPageType] Detected: Artwork page`);
    return 'artwork';
  }

  // Tag page (/tags/.../artworks, /illustrations, /manga)
  if (/\/(?:en\/)?tags\/[^/]+\/(artworks|illustrations|manga)/.test(pathname)) {
    logDebug(`[getPageType] Detected: Tag page`);
    return 'tag';
  }

  // Tag search page (e.g. /search?q=search_term&s_mode=tag)
  if (pathname.includes('/search') && search.includes('s_mode=tag')) {
    logDebug(`[getPageType] Detected: Tag Search page`);
    return 'tag-search';
  }

  logDebug(`[getPageType] Non-filterable page: ${pathname}${search}`);
  return false;
}

function isFilterablePage() {
  const pageType = getPageType();
  return !!pageType; // convert to boolean (true if any page type, false otherwise)
}

function waitForRecommendationGrid() {
  const observer = new MutationObserver(() => {
    const zone = document.querySelector(selectors.recommendZone);
    if (!zone) return;

    const ul = zone.querySelector('ul');
    if (ul && ul.querySelector('li a[href*="/artworks/"]')) {
      logDebug('[waitForRecommendationGrid] <ul> with artworks loaded -> setting up observer');
      observer.disconnect();
      setupArtworkObserver();
      updateAllArtworks();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  logDebug('[waitForRecommendationGrid] Watching for recommendation grid on artwork page');
}

function setupArtworkObserver() {
  try {
    recommendationObservers.forEach((observer) => observer.disconnect());
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
      setTimeout(() => {
        isProcessing = false;
      }, 100);
    }, 300);

    containers.forEach((container, index) => {
      logDebug(
        `[setupArtworkObserver] Setting up observer for container[${index}]: ${container.outerHTML.substring(0, 200)}...`,
      );
      const observer = new MutationObserver((mutations) => {
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

function setupTagPageContentObserver() {
  if (tagContentObserver) {
    tagContentObserver.disconnect();
    tagContentObserver = null;
  }

  const pageType = getPageType();
  const isTagPage = pageType === 'tag' || pageType === 'tag-search';

  if (!isTagPage) return;

  const grids = findTagPageGrids();
  if (grids.length === 0) {
    logDebug('[tagContentObserver] Grid not found yet -> retrying in 800ms');
    setTimeout(setupTagPageContentObserver, 800);
    return;
  }

  const gridContainer = grids[0];

  // Go up 1–2 levels to a parent that survives pagination (the grid itself gets replaced)
  let targetContainer = gridContainer.parentElement || gridContainer;
  if (targetContainer.children.length < 5) {
    targetContainer = targetContainer.parentElement || targetContainer;
  }

  tagContentObserver = new MutationObserver((mutations) => {
    const now = Date.now();
    if (now - lastGridRefreshTime < 1000) return; // longer cooldown

    // Only react to new col-span-2 elements being added
    let hasNewArtworkCells = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            (node.classList?.contains('col-span-2') || node.querySelector?.('div.col-span-2'))
          ) {
            hasNewArtworkCells = true;
            break;
          }
        }
      }
      if (hasNewArtworkCells) break;
    }

    if (hasNewArtworkCells) {
      logDebug('[tagContentObserver] Real pagination detected (new cells added) -> refreshing');

      lastGridRefreshTime = now;

      if (window._pixivDebounce) clearTimeout(window._pixivDebounce);
      window._pixivDebounce = setTimeout(() => {
        refreshArtworks(true);
      }, 300);
    }
  });

  tagContentObserver.observe(targetContainer, { childList: true, subtree: true });

  logDebug(
    `[tagContentObserver] Attached to stable parent of grid (${targetContainer.tagName}, ${targetContainer.children.length} children)`,
  );
}

function refreshArtworks(isPagination = false) {
  try {
    if (window._pixivRefreshDebounce) {
      clearTimeout(window._pixivRefreshDebounce);
    }
    window._pixivRefreshDebounce = setTimeout(() => {
      logDebug(`[refreshArtworks] Refreshing artworks (debounced, isPagination=${isPagination})`);

      // Return if the page is not filterable
      const pageType = getPageType();
      if (!pageType) return;

      // Clear processed elements cache when blacklist changes
      processedLiElements = new WeakMap();
      logDebug('[refreshArtworks] Cleared processed elements cache');
      removedCount = 0; // Reset for all pages during blacklist update
      logDebug('[refreshArtworks] Reset removedCount to 0 for blacklist update');

      recommendationObservers.forEach((observer) => observer.disconnect());
      recommendationObservers = [];
      logDebug('[refreshArtworks] Disconnected previous recommendation observers');

      // Process artworks immediately without waiting for counter
      processArtworks(settings.blacklist, currentAuthorId, settings.removeSameAuthor);

      setupArtworkObserver();

      const isTagPage = pageType === 'tag' || pageType === 'tag-search';

      if (isPagination && isTagPage) {
        // Tag/tag-search pages: header row is completely replaced on pagination -> always recreate
        if (counterElement) {
          counterElement.remove();
          counterElement = null;
        }
        logDebug('[refreshArtworks] Tag page -> forcing counter recreation');
        createCounter().then((success) => {
          if (!success) logDebug('[refreshArtworks] Counter creation failed');
        });
      } else {
        // Artwork page or blacklist update -> update existing counter
        if (!counterElement) {
          logDebug('[refreshArtworks] Artwork page -> creating counter (was missing)');
          createCounter().then((success) => {
            if (!success) logDebug('[refreshArtworks] Counter creation failed');
          });
        }
      }
    }, 250); // debounce timer
  } catch (error) {
    console.error('[refreshArtworks] Error:', error);
  }
}

function updatePage() {
  try {
    logDebug('[updatePage] Updating page for URL:', window.location.pathname);

    // Reset processed elements verdicts on page change
    processedLiElements = new WeakMap();
    logDebug('[updatePage] Cleared processed elements cache for new page');

    recommendationObservers.forEach((observer) => observer.disconnect());
    recommendationObservers = [];
    logDebug('[updatePage] Disconnected previous recommendation observers');

    const pageType = getPageType();
    const wasTagPage = counterElement && (pageType === 'tag' || pageType === 'tag-search');

    if (counterElement && !wasTagPage) {
      counterElement.remove();
      counterElement = null;
      logDebug('[updatePage] Removed previous counter element');
    } else if (counterElement) {
      logDebug('[updatePage] Keeping existing counter (tag/search pagination)');
    }

    if (isFilterablePage()) {
      logDebug('[updatePage] Filterable page detected, processing');
      logDebug(`[updatePage] Remove same author toggle: ${settings.removeSameAuthor}`);

      const pageType = getPageType();
      const isArtworkPage = pageType === 'artwork';

      const authorPromise = isArtworkPage ? getPageAuthorId() : Promise.resolve(null);

      if (isArtworkPage) {
        browser.runtime.sendMessage({ action: 'resetBatchCount' });
        logDebug('[updatePage] Sent resetBatchCount message for artwork page');
      }

      authorPromise
        .then((authorId) => {
          currentAuthorId = authorId;
          logDebug(`[updatePage] Final author ID: ${authorId}`);
          removedCount = 0;

          createCounter().then(() => {
            processArtworks(settings.blacklist, currentAuthorId, settings.removeSameAuthor && isArtworkPage);

            if (isArtworkPage) {
              waitForRecommendationGrid(); // only wait on artwork pages
            } else {
              setupArtworkObserver(); // tag pages - grids are already loaded
              updateAllArtworks(); // process immediately on tag pages
            }
            updateCounter();
          });
        })
        .catch((error) => {
          console.error('[updatePage] Error resolving getPageAuthorId:', error);
        });
      setupTagPageContentObserver();
    } else {
      logDebug('[updatePage] Non-filterable page, skipping recommendation processing');
      removedCount = 0;
      currentAuthorId = null;
      if (document.visibilityState === 'visible') {
        browser.runtime.sendMessage({ action: 'setBadge', count: 0 });
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
        await browser.runtime.sendMessage({ action: 'setBadge', count: 0 });
        logDebug('[main] Non-filterable page, reset badge to 0 (tab is visible)');
      }
    }

    browser.runtime.onMessage.addListener((message) => {
      if (message.action === 'refreshBlacklist') {
        logDebug('[main] Received refreshBlacklist message');
        loadSettings().then(() => {
          // Update thumbnail fixer on all pages
          ThumbnailFixer.setEnabled(thumbnailFixerEnabled);
          if (isFilterablePage()) {
            logDebug('[main] Processing refreshBlacklist on filterable page');
            refreshArtworks(false);
          }
        });
      }
    });

    // Function to check if the URL has changed
    const checkUrlChange = () => {
      if (window.location.href !== lastPathname) {
        logDebug('[main] URL change detected from:', lastPathname, 'to', window.location.href);
        lastPathname = window.location.href;

        // Reinitialize thumbnail fixer on navigation
        ThumbnailFixer.setEnabled(thumbnailFixerEnabled);

        if (isFilterablePage()) {
          updatePage();
        } else {
          logDebug('[main] Non-filterable page, resetting badge');
          removedCount = 0;
          currentAuthorId = null;
          if (document.visibilityState === 'visible') {
            browser.runtime.sendMessage({ action: 'setBadge', count: 0 });
            logDebug('[main] Non-filterable page, reset badge to 0 (tab is visible)');
          }
        }
      }
    };

    // Listen for browser back/forward
    window.addEventListener('popstate', checkUrlChange);

    window.addEventListener('unload', () => {
      if (tagContentObserver) tagContentObserver.disconnect();
    });

    const titleObserver = new MutationObserver(() => {
      logDebug('[titleObserver] Title changed, updating page');
      // Reinitialize thumbnail fixer on title change
      ThumbnailFixer.setEnabled(thumbnailFixerEnabled);
      if (isFilterablePage()) {
        updatePage();
      } else {
        logDebug('[titleObserver] Non-filterable page, resetting badge');
        removedCount = 0;
        currentAuthorId = null;
        if (document.visibilityState === 'visible') {
          browser.runtime.sendMessage({ action: 'setBadge', count: 0 });
          logDebug('[titleObserver] Non-filterable page, reset badge to 0 (tab is visible)');
        }
      }
    });

    titleObserver.observe(document.querySelector('title'), { childList: true });

    // Add visibilitychange listener to update badge when tab becomes active
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        logDebug('[main] Tab became visible, updating badge');
        browser.runtime.sendMessage({ action: 'setBadge', count: removedCount });
      }
    });

    logDebug('[main] Navigation and visibility listeners set up');
  } catch (error) {
    console.error('[main] Error:', error);
  }
}

main();
