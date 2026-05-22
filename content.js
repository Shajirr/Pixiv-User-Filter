let DEBUG = false;
const debugPrefix = '[Pxv.UF]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

const DEFAULT_MAX_RECOMMENDATIONS = 90;

let settings = {
  blacklist: new Set(),
  removeSameAuthor: false,
  counterPos: { top: 'auto', bottom: '2%', left: '2%', right: 'auto' },
};
let removedCount = 0;
let counterElement = null;
let updateArtworksTimeout = null;
let recommendationObservers = [];
let pageContentObserver = null;
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
    const result = await browser.storage.local.get({
      blacklist: [],
      removeSameAuthor: false,
      thumbnailFixer: false,
      limitRecommendations: false,
      maxRecommendations: DEFAULT_MAX_RECOMMENDATIONS,
      DEBUG: false,
      counterPos: { top: 'auto', bottom: '2%', left: '2%', right: 'auto' },
    });
    settings.blacklist = new Set(result.blacklist);
    settings.removeSameAuthor = result.removeSameAuthor;
    settings.counterPos = result.counterPos;
    thumbnailFixerEnabled = result.thumbnailFixer;
    limitRecommendations = result.limitRecommendations;
    maxRecommendations = result.maxRecommendations;
    DEBUG = result.DEBUG;

    logDebug('Debug mode set to:', DEBUG);
    logDebug(`[loadSettings] limitRecommendations=${limitRecommendations}, maxRecommendations=${maxRecommendations}`);
    logDebug(
      `[loadSettings] Loaded settings: blacklist=${[...settings.blacklist].join(', ')}, removeSameAuthor=${settings.removeSameAuthor}, thumbnailFixer=${thumbnailFixerEnabled}`,
    );
    // Update thumbnail fixer after loading settings
    if (typeof ThumbnailFixer !== 'undefined') {
      ThumbnailFixer.setEnabled(thumbnailFixerEnabled);
    }
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
    if (!counterElement) {
      logDebug('[updateCounter] Counter element not found, re-creating');
      createCounter();
    } else if (!document.body.contains(counterElement)) {
      // If counter was somehow detached, reattach it
      logDebug('[updateCounter] Counter element detached from DOM, reattaching');
      document.body.appendChild(counterElement);
    }

    if (counterElement) {
      counterElement.textContent = `Removed: ${removedCount}`;
      // Hide counter if it's a non-filterable page, show if filterable
      counterElement.style.display = isFilterablePage() ? 'flex' : 'none';
      logDebug(`[updateCounter] Updated floating counter: Removed: ${removedCount}`);
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

    // // Only need the links to perform filtering; images might load later.
    // if (artworkLinks.length > 0) {
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

function findHomePageFeed() {
  const containers = [];

  // 1. Top showcase / horizontal scrolling lists before the main feed
  const page_root = document.querySelector('div[data-ga4-label="page_root"]');
  if (page_root) {
    logDebug(`[findHomePageFeed] Found page_root container with ${page_root.children.length} items`);

    const uls = page_root.querySelectorAll('ul');
    for (const ul of uls) {
      // Verify that the UL contains artwork links
      if (ul.querySelector('li a[href*="/artworks/"]')) {
        containers.push(ul);
        logDebug(`[findHomePageFeed] Found page_root UL container with ${ul.children.length} items`);
      }
    }
  }

  // 2. The main infinite scroll feed container (div[data-ga4-label="home_recommend"])
  // Individual feed items are direct div children
  const mainFeed = document.querySelector('div[data-ga4-label="home_recommend"]');
  if (mainFeed) {
    containers.push(mainFeed);
    logDebug('[findHomePageFeed] Found main home_recommend container');
  }

  return containers;
}

function findDiscoveryFeed() {
  // Discovery page uses div.gtm-illust-recommend-zone[data-gtm-recommend-zone="discovery"] as the outer wrapper.
  // Inside, each <ul> contains direct <li> children — these are the individual items to filter.
  const zone = document.querySelector('div.gtm-illust-recommend-zone[data-gtm-recommend-zone="discovery"]');
  if (!zone) return [];
  const uls = [...zone.querySelectorAll('ul')].filter((ul) => ul.querySelector('li a[href*="/artworks/"]'));
  logDebug(`[findDiscoveryFeed] Found ${uls.length} UL row(s) in discovery zone`);
  return uls;
}

// Find grids that might have lazy-loaded images
function findLazyLoadGrids() {
  // /illustration and /manga pages may have lazy-loaded images, so we can't use the
  // image-presence check from findArtworkGridsByContent.
  const candidates = [];
  for (const ul of document.querySelectorAll('ul')) {
    const directArtworkLinks = ul.querySelectorAll(':scope > li a[href*="/artworks/"]');
    if (directArtworkLinks.length >= 3) {
      candidates.push(ul);
      logDebug(`[findLazyLoadGrids] Candidate with ${directArtworkLinks.length} artwork links`, ul);
    }
  }
  logDebug(`[findLazyLoadGrids] Found ${candidates.length} grid(s)`);
  return candidates;
}

function getArtworkGridContainers() {
  const pageType = getPageType();
  const isArtworkPage = pageType === 'artwork';

  logDebug(`[getArtworkGridContainers] Detecting grids on ${pageType} page:${window.location.pathname}`);

  let grids = [];

  if (pageType === 'home') {
    // Home page uses div[data-ga4-label="home_recommend"] as the single feed container
    grids = findHomePageFeed();
    logDebug(`[getArtworkGridContainers] Home page: ${grids.length} container(s) found`);
  } else if (pageType === 'illustration' || pageType === 'manga') {
    // /illustration and /manga have multiple <ul> containers with <li> children
    grids = findLazyLoadGrids();
    logDebug(`[getArtworkGridContainers] ${pageType} page: ${grids.length} container(s) found`);
  } else if (pageType === 'discovery') {
    // Discovery page: infinite loading feed, one <ul> per row inside the discovery recommend zone
    grids = findDiscoveryFeed();
    logDebug(`[getArtworkGridContainers] Discovery page: ${grids.length} container(s) found`);
  } else if (isArtworkPage) {
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
    // Tag page
    grids = findTagPageGrids();
    if (grids.length === 0) {
      logDebug(
        `[getArtworkGridContainers] No "div.col-span-2" grid found on ${pageType}, falling back to ul/li (base tag pages)`,
      );
      grids = findArtworkGridsByContent();
    } else {
      logDebug(`[getArtworkGridContainers] Found "div.col-span-2" grid on ${pageType}`);
    }
  }

  // Dedupe
  grids = [...new Set(grids)];
  logDebug(`[getArtworkGridContainers] Final: ${grids.length} grid(s) found`);
  return grids;
}

function updateAllArtworks(attempt = 1, maxAttempts = 3) {
  try {
    // Cancel any pending fallback retries if this function is called again
    if (updateArtworksTimeout) {
      clearTimeout(updateArtworksTimeout);
      updateArtworksTimeout = null;
    }

    logDebug('[updateAllArtworks] Starting artwork update');
    const containers = getArtworkGridContainers();
    let totalProcessed = 0;
    let totalBlocked = 0;
    let newlyProcessed = 0;

    // Collect elements for batch DOM style changes
    const elementsToHide = [];
    const elementsToShow = [];

    containers.forEach((container) => {
      // const pageType = getPageType();
      // const isArtworkPage = pageType === 'artwork';
      //// Tag pages use div.col-span-2 cells; artwork pages use li elements
      //const items = isArtworkPage ? container.querySelectorAll('li') : container.querySelectorAll('div.col-span-2');

      // Explicitly choose the correct child selector based on the actual container type
      let items;
      if (container.tagName === 'UL') {
        // Artwork pages + base tag pages (/tags/BlueArchive, etc.) use <ul><li>...
        items = container.querySelectorAll('li');
        logDebug(`[updateAllArtworks] UL container -> using 'li' selector (${items.length} items)`);
      } else if (container.dataset?.ga4Label === 'home_recommend') {
        // Home page feed items are direct div children of the home_recommend container
        items = container.querySelectorAll(':scope > div');
        logDebug(`[updateAllArtworks] Home feed container -> using ':scope > div' selector (${items.length} items)`);
      } else {
        // Newer tag pages use div.col-span-2 grid
        items = container.querySelectorAll('div.col-span-2');
        logDebug(`[updateAllArtworks] Grid container -> using 'div.col-span-2' selector (${items.length} items)`);
      }

      totalProcessed += items.length;

      items.forEach((item) => {
        // item = <li> OR <div class="col-span-2">
        const result = processLi(item, settings.blacklist, currentAuthorId, settings.removeSameAuthor);
        const { shouldBlock, alreadyProcessed } = result;

        if (shouldBlock) {
          totalBlocked++;
          // Only add to batch if current display doesn't match desired state
          if (item.style.display !== 'none') elementsToHide.push(item);
        } else {
          // Only add to batch if current display doesn't match desired state
          if (item.style.display === 'none') elementsToShow.push(item);
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
      updateArtworksTimeout = setTimeout(() => updateAllArtworks(attempt + 1, maxAttempts), 1000);
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

function makeDraggable(el) {
  let pos1 = 0,
    pos2 = 0,
    pos3 = 0,
    pos4 = 0;
  el.onmousedown = dragMouseDown;

  function dragMouseDown(e) {
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
    el.style.cursor = 'grabbing';
  }

  function elementDrag(e) {
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;

    // Use clientWidth/Height (excludes scrollbars) for accurate fixed positioning limits
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;

    // Bounds checking in px to keep it on screen while dragging
    let newTop = Math.max(0, Math.min(viewportHeight - el.offsetHeight, el.offsetTop - pos2));
    let newLeft = Math.max(0, Math.min(viewportWidth - el.offsetWidth, el.offsetLeft - pos1));

    el.style.top = newTop + 'px';
    el.style.left = newLeft + 'px';
    el.style.bottom = 'auto';
    el.style.right = 'auto';
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
    el.style.cursor = 'grab';

    // Use clientWidth/Height (excludes scrollbars) for accurate percentage math
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;

    // Calculate quadrant to anchor to the nearest edge using %
    const isRightHalf = el.offsetLeft + el.offsetWidth / 2 > viewportWidth / 2;
    const isBottomHalf = el.offsetTop + el.offsetHeight / 2 > viewportHeight / 2;

    let newPos = { top: 'auto', bottom: 'auto', left: 'auto', right: 'auto' };

    if (isBottomHalf) {
      let bottomPx = viewportHeight - (el.offsetTop + el.offsetHeight);
      newPos.bottom = (bottomPx / viewportHeight) * 100 + '%';
    } else {
      newPos.top = (el.offsetTop / viewportHeight) * 100 + '%';
    }

    if (isRightHalf) {
      let rightPx = viewportWidth - (el.offsetLeft + el.offsetWidth);
      newPos.right = (rightPx / viewportWidth) * 100 + '%';
    } else {
      newPos.left = (el.offsetLeft / viewportWidth) * 100 + '%';
    }

    // Apply the responsive percentage styles
    Object.assign(el.style, newPos);

    // Save position to storage
    settings.counterPos = newPos;
    browser.storage.local.set({ counterPos: settings.counterPos });
    logDebug('[Pxv.UF] Saved new responsive counter position:', settings.counterPos);
  }
}

function createCounter() {
  if (counterElement) return;

  logDebug('[createCounter] Creating floating counter');
  counterElement = document.createElement('div');
  counterElement.className = 'pixiv-recommendation-counter';

  Object.assign(counterElement.style, {
    position: 'fixed',
    top: settings.counterPos.top,
    bottom: settings.counterPos.bottom,
    left: settings.counterPos.left,
    right: settings.counterPos.right,
    zIndex: '999999',
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    color: '#fff',
    padding: '6px 12px',
    borderRadius: '20px',
    fontSize: '14px',
    cursor: 'grab',
    userSelect: 'none',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    backdropFilter: 'blur(4px)',
    display: isFilterablePage() ? 'flex' : 'none',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
  });

  counterElement.textContent = `Removed: ${removedCount}`;
  document.body.appendChild(counterElement);
  makeDraggable(counterElement);
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

  // Base tag page (exactly /tags/tag_name or /en/tags/tag_name)
  if (/^\/(?:en\/)?tags\/[^\/]+\/?$/.test(pathname)) {
    logDebug(`[getPageType] Detected: Base Tag page`);
    return 'tag-base';
  }

  // Sub tag pages (/tags/tag_name/artworks, /illustrations, /manga)
  if (/^\/(?:en\/)?tags\/[^\/]+\/(artworks|illustrations|manga)\/?$/.test(pathname)) {
    logDebug(`[getPageType] Detected: Tag subpage`);
    return 'tag';
  }

  // Tag search page (e.g. /search?q=search_term&s_mode=tag)
  if (pathname.includes('/search') && search.includes('s_mode=tag')) {
    logDebug(`[getPageType] Detected: Tag Search page`);
    return 'tag-search';
  }

  // Main/home page (www.pixiv.net or /en/)
  if (pathname === '/' || /^\/en\/?$/.test(pathname)) {
    logDebug(`[getPageType] Detected: Home page`);
    return 'home';
  }

  // Illustration feed page
  if (pathname === '/illustration') {
    logDebug(`[getPageType] Detected: Illustration page`);
    return 'illustration';
  }

  // Manga feed page
  if (pathname === '/manga') {
    logDebug(`[getPageType] Detected: Manga page`);
    return 'manga';
  }

  // Discovery page
  if (/^\/(?:en\/)?discovery\/?$/.test(pathname)) {
    logDebug(`[getPageType] Detected: Discovery page`);
    return 'discovery';
  }

  logDebug(`[getPageType] Non-filterable page: ${pathname}${search}`);
  return false;
}

function isFilterablePage() {
  const pageType = getPageType();
  return !!pageType; // convert to boolean (true if any page type, false otherwise)
}

function waitForRecommendationGrid() {
  const pageType = getPageType();

  const checkGrids = () => {
    // Use the centralized grid detection logic
    const grids = getArtworkGridContainers();
    if (grids.length > 0) {
      logDebug(
        `[waitForRecommendationGrid] ${grids.length} grid(s) detected via mutation, setting up artwork observer`,
      );
      observer.disconnect();
      setupArtworkObserver();
      updateAllArtworks();
    }
  };

  // Debounce the grids check
  const debouncedGridsCheck = debounce(checkGrids, 500);

  // Observer uses the debounced grids check
  const observer = new MutationObserver(() => {
    debouncedGridsCheck();
  });

  // Watch the body for structural changes (like the scroll-triggered injection)
  observer.observe(document.body, { childList: true, subtree: true });
  recommendationObservers.push(observer);
  logDebug(
    `[waitForRecommendationGrid] Watching for recommendation artwork grids grid on ${pageType} page: ${window.location.pathname}`,
  );
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
      // Home feed items are direct div children; other grids use li elements
      const isHomeContainer = container.dataset?.ga4Label === 'home_recommend';
      const observer = new MutationObserver((mutations) => {
        // Only trigger if new elements were actually added
        let hasNewElements = false;

        // More efficient mutation checking
        for (const mutation of mutations) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                if (
                  node.tagName === 'LI' ||
                  node.querySelector?.('li') ||
                  (isHomeContainer && node.tagName === 'DIV')
                ) {
                  hasNewElements = true;
                  break;
                }
              }
            }
            if (hasNewElements) break;
          }
        }

        if (hasNewElements) {
          logDebug('[setupArtworkObserver] New elements detected, processing');
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

function waitForHomeContainers(attempt = 1) {
  const bg1 = document.querySelector('.bg-background1');

  // If the wrapper isn't rendered yet, retry a few times
  if (!bg1) {
    if (attempt < 5) setTimeout(() => waitForHomeContainers(attempt + 1), 500);
    return;
  }

  // If the containers are already populated, don't need to wait
  if (bg1.querySelector('ul li a[href*="/artworks/"]')) return;

  logDebug('[waitForHomeContainers] Watching bg-background1 for late containers...');

  const observer = new MutationObserver((mutations, obs) => {
    // Wait until the ULs actually contain artwork links
    if (bg1.querySelector('ul li a[href*="/artworks/"]')) {
      logDebug('[waitForHomeContainers] Containers populated! Self-destructing observer.');
      obs.disconnect(); // Kill this observer permanently

      // Re-run setup to grab all containers and bind standard observers
      setupArtworkObserver();
      updateAllArtworks();
    }
  });

  // Watch only the specific background wrapper
  observer.observe(bg1, { childList: true, subtree: true });
}

function setupPageContentObserver() {
  if (pageContentObserver) {
    pageContentObserver.disconnect();
    pageContentObserver = null;
  }

  const pageType = getPageType();
  // Only pages with infinite/pagination loading need this observer
  // Base tag pages (tag-base) have no infinite loading -> skip observer
  if (!['tag', 'tag-search', 'illustration', 'manga', 'discovery'].includes(pageType)) return;

  // Discovery page: watch the recommend zone for new <ul> rows injected on scroll
  if (pageType === 'discovery') {
    const zone = document.querySelector('div.gtm-illust-recommend-zone[data-gtm-recommend-zone="discovery"]');
    if (!zone) {
      logDebug('[pageContentObserver] Discovery zone not found yet -> retrying in 800ms');
      setTimeout(setupPageContentObserver, 800);
      return;
    }

    pageContentObserver = new MutationObserver((mutations) => {
      // Detect new <ul> rows or <li> items injected by scroll
      let hasNewContent = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (
              node.nodeType === Node.ELEMENT_NODE &&
              (node.tagName === 'UL' ||
                node.tagName === 'LI' ||
                node.querySelector?.('ul') ||
                node.querySelector?.('li'))
            ) {
              hasNewContent = true;
              break;
            }
          }
          if (hasNewContent) break;
        }
      }

      if (hasNewContent) {
        logDebug('[pageContentObserver] New scroll content detected on discovery page -> updating');
        if (window._pixivDebounce) clearTimeout(window._pixivDebounce);
        window._pixivDebounce = setTimeout(() => {
          setupArtworkObserver(); // Attach observers to newly spawned UL rows
          updateAllArtworks(); // Process the new items (WeakMap will skip old ones)
        }, 300);
      }
    });

    pageContentObserver.observe(zone, { childList: true, subtree: true });
    logDebug('[pageContentObserver] Attached to discovery zone for scroll detection');
    return;
  }

  // illustration and manga: multiple <ul> containers load on scroll, no stable single parent
  // -> watch document.body for new <ul>/<li> nodes being injected
  if (pageType === 'illustration' || pageType === 'manga') {
    const grids = findArtworkGridsByContent();
    if (grids.length === 0) {
      logDebug(`[pageContentObserver] No grids found yet on ${pageType} page -> retrying in 800ms`);
      setTimeout(setupPageContentObserver, 800);
      return;
    }

    pageContentObserver = new MutationObserver((mutations) => {
      // Detect new <ul> containers or <li> items injected by scroll
      let hasNewContent = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (
              node.nodeType === Node.ELEMENT_NODE &&
              (node.tagName === 'LI' ||
                node.tagName === 'UL' ||
                node.querySelector?.('li') ||
                node.querySelector?.('ul'))
            ) {
              hasNewContent = true;
              break;
            }
          }
          if (hasNewContent) break;
        }
      }

      if (hasNewContent) {
        logDebug(`[pageContentObserver] New scroll content detected on ${pageType} page -> updating`);
        if (window._pixivDebounce) clearTimeout(window._pixivDebounce);
        window._pixivDebounce = setTimeout(() => {
          setupArtworkObserver(); // Attach observers to newly spawned grids
          updateAllArtworks(); // Process the items (WeakMap will skip old ones)
        }, 300);
      }
    });

    pageContentObserver.observe(document.body, { childList: true, subtree: true });
    logDebug(`[pageContentObserver] Attached to document.body for ${pageType} scroll detection`);
    return;
  }

  // tag and tag-search pages: find the grid and watch its stable parent for pagination
  let grids = findTagPageGrids();
  if (grids.length === 0) {
    logDebug('[pageContentObserver] No col-span-2 grid, checking for ul/li (base tag pages)');
    grids = findArtworkGridsByContent();
  }

  if (grids.length === 0) {
    logDebug('[pageContentObserver] Grid not found yet -> retrying in 800ms');
    setTimeout(setupPageContentObserver, 800);
    return;
  }

  const gridContainer = grids[0];

  // Go up 1–2 levels to a parent that survives pagination (the grid itself gets replaced)
  let targetContainer = gridContainer.parentElement || gridContainer;
  if (targetContainer.children.length < 5) {
    targetContainer = targetContainer.parentElement || targetContainer;
  }

  pageContentObserver = new MutationObserver((mutations) => {
    // Detect both new col-span-2 cells and new <li> elements
    let hasNewArtworkCells = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            (node.classList?.contains('col-span-2') ||
              node.querySelector?.('div.col-span-2') ||
              node.tagName === 'LI' ||
              node.querySelector?.('li'))
          ) {
            hasNewArtworkCells = true;
            break;
          }
        }
        if (hasNewArtworkCells) break;
      }
      if (hasNewArtworkCells) break;
    }

    if (hasNewArtworkCells) {
      logDebug('[pageContentObserver] Real pagination detected (new cells added) -> refreshing');
      if (window._pixivDebounce) clearTimeout(window._pixivDebounce);
      window._pixivDebounce = setTimeout(() => {
        refreshArtworks(true);
      }, 300);
    }
  });

  pageContentObserver.observe(targetContainer, { childList: true, subtree: true });

  logDebug(
    `[pageContentObserver] Attached to stable parent of grid (${targetContainer.tagName}, ${targetContainer.children.length} children)`,
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
      if (!isFilterablePage()) return;

      // Clear processed elements cache when blacklist changes, not on pagination
      if (!isPagination) {
        processedLiElements = new WeakMap();
        logDebug('[refreshArtworks] Cleared processed elements cache');
      }

      removedCount = 0; // Reset for all pages during blacklist update
      logDebug('[refreshArtworks] Reset removedCount to 0 for blacklist update');

      recommendationObservers.forEach((observer) => observer.disconnect());
      recommendationObservers = [];
      logDebug('[refreshArtworks] Disconnected previous artwork observers');

      // Process artworks immediately without waiting for counter
      processArtworks(settings.blacklist, currentAuthorId, settings.removeSameAuthor);

      setupArtworkObserver();

      // Ensure counter exists and reflects the latest state
      updateCounter();
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

    if (isFilterablePage()) {
      logDebug(`[updatePage] Filterable page detected: ${pageType}, processing`);

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

          processArtworks(settings.blacklist, currentAuthorId, settings.removeSameAuthor && isArtworkPage);
          if (isArtworkPage) {
            waitForRecommendationGrid(); // only wait on artwork pages
          } else {
            setupArtworkObserver();
            updateAllArtworks();

            if (pageType === 'home') {
              waitForHomeContainers();
            }
          }
          updateCounter();
        })
        .catch((error) => {
          console.error('[updatePage] Error resolving getPageAuthorId:', error);
        });

      setupPageContentObserver();
    } else {
      logDebug('[updatePage] Non-filterable page, skipping recommendation processing');
      removedCount = 0;
      currentAuthorId = null;
      updateCounter(); // Hide the counter
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
      updateCounter(); // Hide the counter
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
          updateCounter(); // Hide the counter
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
      if (pageContentObserver) pageContentObserver.disconnect();
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
        updateCounter(); // Hide the counter
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

// Listen for storage changes
browser.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.DEBUG) {
    DEBUG = changes.DEBUG.newValue ?? false;
    logDebug('Debug mode changed to:', DEBUG);
  }
});

main();
