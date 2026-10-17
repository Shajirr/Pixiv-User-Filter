let DEBUG = false;
const debugPrefix = '[Pxv.UF]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

// Debug switch: set to true to disable CSS hiding and placeholders on blocked profiles
const TEST_DISABLE_PLACEHOLDERS_AND_CSS = false;

const DEFAULT_MAX_RECOMMENDATIONS = 90;

let settings = {
  blacklist: new Set(),
  removeSameAuthor: false,
  indicatorPos: { top: 'auto', bottom: '2%', left: '2%', right: 'auto' },
  indicatorMode: 'counter', // 'counter' | 'indicator' | 'off'
};

// State management
const defaultState = {
  removedCount: 0,
  currentAuthorId: null,
  processedLiElements: new WeakMap(),
  observedContainers: new WeakSet(),
  recommendationObservers: [],
  pageContentObserver: null,
  updateArtworksTimeout: null,
  lastPathname: window.location.href,
};

// Clone default state into active appState object
const appState = { ...defaultState };

let pageContentDebounceTimer = null;
let refreshDebounceTimer = null;
let indicatorElement = null;
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

// Inject CSS for placeholders and instant pre-render image hiding on blocked profiles
function injectProfileBlockStyles() {
  if (document.getElementById('pxv-uf-profile-block-styles')) return;
  const style = document.createElement('style');
  style.id = 'pxv-uf-profile-block-styles';
  style.textContent = `
    /* Immediately prevent artwork thumbnails from flashing before JS processes the node */
    html.pxv-uf-block-profile ul li a[href*="/artworks/"] img:not(.pxv-uf-blocked-icon) {
      opacity: 0 !important;
      visibility: hidden !important;
    }
    .pxv-uf-blocked-icon {
      opacity: 1 !important;
      visibility: visible !important;
    }
    .pxv-uf-blocked-thumb-link {
      position: relative !important;
      display: block !important;
      width: 100% !important;
      min-width: 136px !important;
      min-height: 136px !important;
      aspect-ratio: 1 / 1 !important;
      background-color: rgba(128, 128, 128, 0.14) !important;
      border-radius: 4px !important;
      overflow: hidden !important;
    }
    .pxv-uf-blocked-thumb-link > *:not(.pxv-uf-blocked-placeholder) {
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    .pxv-uf-blocked-placeholder {
      position: absolute !important;
      inset: 0 !important;
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 6px !important;
      color: #858585 !important;
      font-size: 12px !important;
      font-weight: 500 !important;
      user-select: none !important;
      pointer-events: none !important;
      z-index: 10 !important;
      opacity: 1 !important;
      visibility: visible !important;
    }
    .pxv-uf-blocked-placeholder > span {
      font-weight: 700 !important;
      font-size: 14px !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// Toggle root class so CSS immediately masks profile artwork thumbnails before DOM observers fire
function updateProfileBlockCssState() {
  if (TEST_DISABLE_PLACEHOLDERS_AND_CSS) {
    document.documentElement.classList.remove('pxv-uf-block-profile');
    return;
  }
  injectProfileBlockStyles();
  const isProfile = getPageType() === 'profile';
  const ownerId = isProfile ? getProfileOwnerId() : null;
  const shouldBlock = Boolean(
    isProfile && settings.hideBlockedArtistProfileArtworks && ownerId && settings.blacklist.has(ownerId),
  );
  document.documentElement.classList.toggle('pxv-uf-block-profile', shouldBlock);
}

// Replace artwork thumbnail inside a profile <li> with a placeholder
function applyProfilePlaceholder(li) {
  if (TEST_DISABLE_PLACEHOLDERS_AND_CSS) return;

  // Remove bookmark button from blocked profile artwork cell
  li.querySelectorAll(selectors.bookmarkButton).forEach((btn) => btn.remove());

  const artworkLinks = li.querySelectorAll(selectors.artworkLink);
  if (artworkLinks.length === 0) return;

  // Find the thumbnail link (as opposed to the text title link below it)
  let thumbLink = null;
  for (const link of artworkLinks) {
    if (link.querySelector('img, div')) {
      thumbLink = link;
      break;
    }
  }
  if (!thumbLink) thumbLink = artworkLinks[0];

  thumbLink.classList.add('pxv-uf-blocked-thumb-link');

  if (!thumbLink.querySelector('.pxv-uf-blocked-placeholder')) {
    const placeholder = document.createElement('div');
    placeholder.className = 'pxv-uf-blocked-placeholder';

    const icon = document.createElement('img');
    icon.src = browser.runtime.getURL('icons/blocked.svg');
    icon.className = 'pxv-uf-blocked-icon';
    placeholder.appendChild(icon);

    const label = document.createElement('span');
    label.textContent = 'Blocked';
    placeholder.appendChild(label);

    thumbLink.appendChild(placeholder);
  }
  li.dataset.pxvBlocked = 'true';
}

// Restore original thumbnail if user is unblocked or setting is toggled off
function removeProfilePlaceholder(li) {
  if (!li.dataset.pxvBlocked) return;
  delete li.dataset.pxvBlocked;

  li.querySelectorAll('.pxv-uf-blocked-thumb-link').forEach((el) => {
    el.classList.remove('pxv-uf-blocked-thumb-link');
  });
  li.querySelectorAll('.pxv-uf-blocked-placeholder').forEach((el) => el.remove());
}

async function loadSettings() {
  try {
    // Synced settings
    const syncResult = await browser.storage.sync.get({
      removeSameAuthor: false,
      thumbnailFixer: false,
      limitRecommendations: false,
      maxRecommendations: DEFAULT_MAX_RECOMMENDATIONS,
      indicatorMode: 'counter', // 'counter' | 'indicator' | 'off'
      hideBlockedArtistProfileArtworks: true,
    });

    // Local machine-specific states
    const localResult = await browser.storage.local.get({
      blacklist: [],
      debugMode: false,
      indicatorPos: { top: 'auto', bottom: '2%', left: '2%', right: 'auto' },
    });

    // Set all initial values
    settings.blacklist = new Set(localResult.blacklist);
    settings.removeSameAuthor = syncResult.removeSameAuthor;
    settings.hideBlockedArtistProfileArtworks = syncResult.hideBlockedArtistProfileArtworks;
    settings.indicatorPos = localResult.indicatorPos;
    settings.indicatorMode = syncResult.indicatorMode;
    thumbnailFixerEnabled = syncResult.thumbnailFixer;
    limitRecommendations = syncResult.limitRecommendations;
    maxRecommendations = syncResult.maxRecommendations;
    DEBUG = localResult.debugMode;

    logDebug('Debug mode set to:', DEBUG);
    logDebug(`[loadSettings] limitRecommendations=${limitRecommendations}, maxRecommendations=${maxRecommendations}`);
    logDebug(
      `[loadSettings] Loaded settings: blacklist size=${settings.blacklist.size}, removeSameAuthor=${settings.removeSameAuthor}, hideBlockedArtistProfileArtworks=${settings.hideBlockedArtistProfileArtworks}, thumbnailFixer=${thumbnailFixerEnabled}, indicatorMode=${settings.indicatorMode}`,
    );
    updateProfileBlockCssState();
    // Update thumbnail fixer after loading settings
    if (typeof ThumbnailFixer !== 'undefined') {
      ThumbnailFixer.setEnabled(thumbnailFixerEnabled);
    }
  } catch (error) {
    console.error('[loadSettings] Error:', error);
  }
}

const selectors = {
  // User & Profile
  userLink: 'a[data-gtm-user-id], a[href*="/users/"]',
  followButton: 'button[data-gtm-user-id]',
  profileLink: 'section a[data-gtm-value]',

  // Containers & Wrappers
  recommendZone: 'div.gtm-illust-recommend-zone', // Recommendation section
  discoveryZone: 'div.gtm-illust-recommend-zone[data-gtm-recommend-zone="discovery"]',
  homeRecommend: 'div[data-ga4-label="home_recommend"]',
  pageRoot: 'div[data-ga4-label="page_root"]',
  bgBackground1: '.bg-background1',

  // Grids & Items
  tagGridCell: 'div.col-span-2',
  tagGridClass: 'col-span-2',
  artworkLink: 'a[href*="/artworks/"]',
  bookmarkButton: 'div[data-ga4-label="bookmark_button"]',
};

// Helper: optimized check for new artwork nodes in mutation loops.
// Avoids deep querySelector scans on every added node.
function hasNewArtworkNodes(addedNodes, isHomeFeed = false, isGrid = false) {
  for (const node of addedNodes) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = node.tagName;

    // 1. Fast, shallow tag checks
    if (tag === 'LI' || tag === 'UL') return true;

    // 2. Context-specific shallow checks
    if (isHomeFeed && tag === 'DIV') return true;
    if (isGrid && (node.classList?.contains(selectors.tagGridClass) || tag === 'DIV')) return true;

    // 3. Fallback: Only if a large wrapper was injected, check its children.
    // Restricting querySelector only to DIV/SECTION containers saves massive overhead.
    if (tag === 'DIV' || tag === 'SECTION') {
      if (isGrid && node.querySelector(selectors.tagGridCell)) return true;
      if (!isGrid && node.querySelector('li, ul')) return true;
    }
  }
  return false;
}

// Helper: Reset extension state for non-filterable pages or navigation
function resetExtensionState() {
  logDebug('[resetExtensionState] Resetting state and hiding UI');

  updateProfileBlockCssState();

  // Clear pending retry timeouts to avoid race conditions on navigation
  if (appState.updateArtworksTimeout) {
    clearTimeout(appState.updateArtworksTimeout);
    appState.updateArtworksTimeout = null;
  }

  // Disconnect and purge active observers to prevent zombie background leaks
  appState.recommendationObservers.forEach((observer) => observer.disconnect());
  appState.recommendationObservers = [];

  if (appState.pageContentObserver) {
    appState.pageContentObserver.disconnect();
    appState.pageContentObserver = null;
  }

  appState.removedCount = 0;
  appState.currentAuthorId = null;
  updateIndicator(); // This naturally hides the indicator because isFilterablePage() handles display logic

  if (document.visibilityState === 'visible') {
    browser.runtime.sendMessage({ action: 'setBadge', count: 0 });
    logDebug('[resetExtensionState] Reset badge to 0 (tab is visible)');
  }
}

function applyIndicatorModeStyles(el) {
  const isIndicator = settings.indicatorMode === 'indicator';

  // Apply styles based on the current indicator mode
  Object.assign(el.style, {
    position: 'fixed',
    top: settings.indicatorPos.top,
    bottom: settings.indicatorPos.bottom,
    left: settings.indicatorPos.left,
    right: settings.indicatorPos.right,
    zIndex: '999999',
    backgroundColor: isIndicator ? 'rgba(40, 167, 69, 0.85)' : 'rgba(0, 0, 0, 0.75)',
    color: '#fff',
    width: isIndicator ? '14px' : 'auto',
    height: isIndicator ? '14px' : 'auto',
    padding: isIndicator ? '0' : '6px 12px',
    borderRadius: isIndicator ? '50%' : '20px',
    fontSize: '14px',
    cursor: 'grab',
    userSelect: 'none',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    backdropFilter: 'blur(4px)',
    display: isFilterablePage() ? 'flex' : 'none', // Hide indicator if it's a non-filterable page, show if filterable
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
  });

  el.textContent = isIndicator ? '' : `Removed: ${appState.removedCount}`;
}

function updateIndicator() {
  try {
    // If indicator is disabled, ensure it's removed and don't recreate
    if (settings.indicatorMode === 'off') {
      if (indicatorElement && document.body.contains(indicatorElement)) {
        logDebug('[updateIndicator] Floating indicator disabled, removing element');
        indicatorElement.remove();
        indicatorElement = null; // Clear reference to allow GC and proper recreation
      }
      // Still update badge
      if (document.visibilityState === 'visible') {
        browser.runtime.sendMessage({ action: 'setBadge', count: appState.removedCount });
        logDebug(
          `[updateIndicator] Updated badge with count: ${appState.removedCount} (tab is visible, indicator disabled)`,
        );
      }
      return;
    }

    if (!indicatorElement) {
      logDebug('[updateIndicator] Indicator element not found, re-creating');
      createIndicator();
    } else if (!document.body.contains(indicatorElement)) {
      // If indicator was somehow detached, reattach it
      logDebug('[updateIndicator] Indicator element detached from DOM, reattaching');
      document.body.appendChild(indicatorElement);
    }

    if (indicatorElement) {
      applyIndicatorModeStyles(indicatorElement);
      logDebug(`[updateIndicator] Updated floating ${settings.indicatorMode}: Removed: ${appState.removedCount}`);
    }

    if (document.visibilityState === 'visible') {
      browser.runtime.sendMessage({ action: 'setBadge', count: appState.removedCount });
      logDebug(`[updateIndicator] Updated badge with count: ${appState.removedCount} (tab is visible)`);
    } else {
      logDebug(`[updateIndicator] Skipped badge update (tab is not visible)`);
    }
  } catch (error) {
    console.error('[updateIndicator] Error:', error);
  }
}

function findArtworkGridsByContent() {
  const allULs = document.querySelectorAll('ul');
  const candidates = [];

  for (const ul of allULs) {
    const artworkLinks = ul.querySelectorAll(selectors.artworkLink);
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
  const firstLink = document.querySelector(`${selectors.tagGridCell} ${selectors.artworkLink}`);
  if (!firstLink) return [];
  let cell = firstLink;
  while (cell && !cell.classList.contains(selectors.tagGridClass)) {
    cell = cell.parentElement;
  }
  if (!cell || !cell.parentElement) return [];
  const gridContainer = cell.parentElement;
  const cells = gridContainer.querySelectorAll(selectors.tagGridCell);
  if (cells.length === 0) return [];
  logDebug(`[findTagPageGrids] Found grid container with ${cells.length} cell(s)`);
  return [gridContainer];
}

// Get the profile owner's user ID from the current page URL
function getProfileOwnerId() {
  const match = window.location.pathname.match(/(?:\/en\/)?users\/(\d+)/);
  return match ? match[1] : null;
}

// Profile pages (/users/<id>, /illustrations, /manga, /request) have a single UI element hosting
// the entire image grid, with <li> grid cells. Detect it by finding the <ul> container whose
// direct children are <li> cells containing artwork links.
function findProfilePageGrids() {
  const allULs = document.querySelectorAll('ul');
  const grids = [];

  for (const ul of allULs) {
    const liCells = ul.querySelectorAll(`:scope > li ${selectors.artworkLink}`);
    if (liCells.length > 0) {
      grids.push(ul);
      logDebug(`[findProfilePageGrids] Found profile grid container with ${liCells.length} cell(s)`, ul);
    }
  }

  return grids;
}

function findHomePageFeed() {
  const containers = [];

  // 1. Top showcase / horizontal scrolling lists before the main feed
  const page_root = document.querySelector(selectors.pageRoot);
  if (page_root) {
    logDebug(`[findHomePageFeed] Found page_root container with ${page_root.children.length} items`);

    const uls = page_root.querySelectorAll('ul');
    for (const ul of uls) {
      // Verify that the UL contains artwork links
      if (ul.querySelector(`li ${selectors.artworkLink}`)) {
        containers.push(ul);
        logDebug(`[findHomePageFeed] Found page_root UL container with ${ul.children.length} items`);
      }
    }
  }

  // 2. The main infinite scroll feed container (div[data-ga4-label="home_recommend"])
  // Individual feed items are direct div children
  const mainFeed = document.querySelector(selectors.homeRecommend);
  if (mainFeed) {
    containers.push(mainFeed);
    logDebug('[findHomePageFeed] Found main home_recommend container');
  }

  return containers;
}

function findDiscoveryFeed() {
  // Discovery page uses div.gtm-illust-recommend-zone[data-gtm-recommend-zone="discovery"] as the outer wrapper.
  // Inside, each <ul> contains direct <li> children — these are the individual items to filter.
  const zone = document.querySelector(selectors.discoveryZone);
  if (!zone) return [];
  const uls = [...zone.querySelectorAll('ul')].filter((ul) => ul.querySelector(`li ${selectors.artworkLink}`));
  logDebug(`[findDiscoveryFeed] Found ${uls.length} UL row(s) in discovery zone`);
  return uls;
}

// Find grids that might have lazy-loaded images
function findLazyLoadGrids() {
  // /illustration and /manga pages may have lazy-loaded images, so we can't use the
  // image-presence check from findArtworkGridsByContent.
  const candidates = [];
  for (const ul of document.querySelectorAll('ul')) {
    const directArtworkLinks = ul.querySelectorAll(`:scope > li ${selectors.artworkLink}`);
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
      if (ul && ul.querySelector(`li ${selectors.artworkLink}`)) {
        grids.push(ul);
        logDebug('[getArtworkGridContainers] Found grid via gtm-illust-recommend-zone');
      }
    }

    // Fallback - content-based search
    if (grids.length === 0) {
      logDebug('[getArtworkGridContainers] Falling back to content-based detection');
      grids = findArtworkGridsByContent();
    }
  } else if (pageType === 'profile' || pageType === 'bookmarks') {
    // Profile & bookmarks pages: single element hosting the image grid of li cells
    grids = findProfilePageGrids();
    logDebug(`[getArtworkGridContainers] ${pageType} page: ${grids.length} container(s) found`);
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
    if (appState.updateArtworksTimeout) {
      clearTimeout(appState.updateArtworksTimeout);
      appState.updateArtworksTimeout = null;
    }

    logDebug('[updateAllArtworks] Starting artwork update');

    updateProfileBlockCssState();

    // Determine context for "removeSameAuthor" dynamically
    const pageType = getPageType();
    const isArtworkPage = pageType === 'artwork';
    const isProfilePage = pageType === 'profile';
    const shouldRemoveAuthor = settings.removeSameAuthor && isArtworkPage;

    const containers = getArtworkGridContainers();
    const ownerId = isProfilePage ? getProfileOwnerId() : null;
    const hideAllProfileArtworks =
      settings.hideBlockedArtistProfileArtworks && ownerId && settings.blacklist.has(ownerId);

    let totalProcessed = 0;
    let totalBlocked = 0;
    let newlyProcessed = 0;

    // Collect elements for batch DOM style changes
    const elementsToHide = [];
    const elementsToShow = [];
    const elementsToBlockPlaceholder = [];
    const elementsToUnblockPlaceholder = [];

    containers.forEach((container) => {
      // Explicitly choose the correct child selector based on the actual container type
      let items;
      if (container.tagName === 'UL') {
        // Artwork pages + base tag pages (/tags/<tag>, etc.) use <ul><li>...
        items = container.querySelectorAll(':scope > li');
        logDebug(`[updateAllArtworks] UL container -> using ':scope > li' selector (${items.length} items)`);
      } else if (container.dataset?.ga4Label === 'home_recommend') {
        // Home page feed items are direct div children of the home_recommend container
        items = container.querySelectorAll(':scope > div');
        logDebug(`[updateAllArtworks] Home feed container -> using ':scope > div' selector (${items.length} items)`);
      } else if (isProfilePage) {
        // Profile pages: the container hosts <li> grid cells
        items = container.querySelectorAll('li');
        logDebug(`[updateAllArtworks] Profile container -> using 'li' selector (${items.length} items)`);
      } else {
        // Newer tag pages use div.col-span-2 grid
        items = container.querySelectorAll(selectors.tagGridCell);
        logDebug(`[updateAllArtworks] Grid container -> using tagGridCell selector (${items.length} items)`);
      }

      totalProcessed += items.length;

      items.forEach((item) => {
        // Profile pages: all artworks belong to the profile owner.
        // Place placeholders over them when the owner is blacklisted and the setting is enabled.
        if (isProfilePage) {
          if (hideAllProfileArtworks) {
            if (item.querySelector(selectors.artworkLink)) {
              totalBlocked++;
              if (!item.dataset.pxvBlocked) newlyProcessed++;
              elementsToBlockPlaceholder.push(item);
            }
          } else if (item.dataset.pxvBlocked) {
            elementsToUnblockPlaceholder.push(item);
          }
          // Ensure item is not hidden via display:none from any other rule
          if (item.style.display === 'none') elementsToShow.push(item);
          return;
        }

        // item = <li> OR <div class="col-span-2">
        const result = processLi(item, settings.blacklist, appState.currentAuthorId, shouldRemoveAuthor);
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
    if (
      elementsToHide.length > 0 ||
      elementsToShow.length > 0 ||
      elementsToBlockPlaceholder.length > 0 ||
      elementsToUnblockPlaceholder.length > 0
    ) {
      requestAnimationFrame(() => {
        logDebug(
          `[updateAllArtworks] Batching changes: hiding ${elementsToHide.length}, unhiding ${elementsToShow.length}, blocking ${elementsToBlockPlaceholder.length}, unblocking ${elementsToUnblockPlaceholder.length}`,
        );
        elementsToHide.forEach((el) => (el.style.display = 'none'));
        elementsToShow.forEach((el) => (el.style.display = ''));
        elementsToBlockPlaceholder.forEach((el) => applyProfilePlaceholder(el));
        elementsToUnblockPlaceholder.forEach((el) => removeProfilePlaceholder(el));
      });
    }

    if (totalProcessed === 0 && attempt < maxAttempts) {
      logDebug(`[updateAllArtworks] No items found, retrying attempt ${attempt}/${maxAttempts}`);
      appState.updateArtworksTimeout = setTimeout(() => updateAllArtworks(attempt + 1, maxAttempts), 1000);
      return;
    }

    appState.removedCount = totalBlocked;
    logDebug(
      `[updateAllArtworks] Processed ${totalProcessed} items (${newlyProcessed} new), blocked ${totalBlocked} total`,
    );
    updateIndicator();
  } catch (error) {
    console.error('[updateAllArtworks] Error:', error);
  }
}

function makeDraggable(el) {
  let pos1 = 0,
    pos2 = 0,
    pos3 = 0,
    pos4 = 0;

  el.addEventListener('mousedown', dragMouseDown);

  function dragMouseDown(e) {
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;

    // Attach document listeners safely
    document.addEventListener('mouseup', closeDragElement);
    document.addEventListener('mousemove', elementDrag);
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
    // Safely remove the specific listeners to prevent memory leaks and ghost dragging
    document.removeEventListener('mouseup', closeDragElement);
    document.removeEventListener('mousemove', elementDrag);
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
    settings.indicatorPos = newPos;
    browser.storage.local.set({ indicatorPos: settings.indicatorPos });
    logDebug('[Pxv.UF] Saved new responsive indicator position:', settings.indicatorPos);
  }
}

function createIndicator() {
  if (indicatorElement) return;

  // Don't create indicator if disabled
  if (settings.indicatorMode === 'off') {
    logDebug('[createIndicator] Floating indicator is disabled, skipping creation');
    return;
  }

  logDebug('[createIndicator] Creating floating indicator');
  indicatorElement = document.createElement('div');
  indicatorElement.className = 'pixiv-recommendation-indicator';

  applyIndicatorModeStyles(indicatorElement);
  document.body.appendChild(indicatorElement);
  makeDraggable(indicatorElement);
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
  if (appState.processedLiElements.has(li)) {
    return {
      userId: null,
      shouldBlock: appState.processedLiElements.get(li), // Return the stored result
      alreadyProcessed: true,
    };
  }

  let userId = null;
  let shouldBlock = false;
  try {
    const userLink = li.querySelector(selectors.userLink);
    if (!userLink) {
      appState.processedLiElements.set(li, false); // Store verdict
      return { userId: null, shouldBlock: false, alreadyProcessed: false };
    }

    userId = userLink.getAttribute('data-gtm-user-id');
    if (!userId) {
      const match = userLink.href.match(/pixiv\.net\/(?:en\/)?users\/(\d+)/i);
      userId = match ? match[1] : null;
    }

    // Early return if no userId found
    if (!userId) {
      appState.processedLiElements.set(li, false);
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
    appState.processedLiElements.set(li, shouldBlock);
  } catch (error) {
    console.error('[processLi] Error:', error);
    appState.processedLiElements.set(li, false); // Mark as processed even on error
  }
  return { userId, shouldBlock, alreadyProcessed: false };
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

  // Profile page (/users/<id>, /users/<id>/artworks, /users/<id>/illustrations, /users/<id>/manga, /users/<id>/request)
  if (/^\/(?:en\/)?users\/\d+(\/(artworks|illustrations|manga|request))?\/?$/.test(pathname)) {
    logDebug(`[getPageType] Detected: Profile page`);
    return 'profile';
  }

  // User bookmarks page (/users/<id>/bookmarks/artworks) - contains works from various artists
  if (/^\/(?:en\/)?users\/\d+\/bookmarks(\/artworks)?\/?$/.test(pathname)) {
    logDebug(`[getPageType] Detected: Bookmarks page`);
    return 'bookmarks';
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
  appState.recommendationObservers.push(observer);
  logDebug(
    `[waitForRecommendationGrid] Watching for recommendation artwork grids on ${pageType} page: ${window.location.pathname}`,
  );
}

// Targeted debounced function for new items only for setupArtworkObserver
const debouncedProcessNewItems = debounce(() => {
  logDebug('[setupArtworkObserver] Processing new items');
  updateAllArtworks();
}, 300);

function setupArtworkObserver() {
  try {
    const containers = getArtworkGridContainers();
    let newlyObservedCount = 0;

    containers.forEach((container, index) => {
      // Only attach to containers which haven't been seen yet.
      if (appState.observedContainers.has(container)) return;

      logDebug(`[setupArtworkObserver] Setting up observer for new container[${index}]`);
      appState.observedContainers.add(container);

      const isHomeContainer = container.dataset?.ga4Label === 'home_recommend';

      const observer = new MutationObserver((mutations) => {
        // Only trigger if new elements were actually added
        let hasNewElements = false;

        // More efficient mutation checking
        for (const mutation of mutations) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            if (hasNewArtworkNodes(mutation.addedNodes, isHomeContainer, false)) {
              hasNewElements = true;
              break;
            }
          }
        }

        if (hasNewElements) {
          logDebug('[setupArtworkObserver] New elements detected, processing');
          debouncedProcessNewItems();
        }
      });

      observer.observe(container, { childList: true });
      appState.recommendationObservers.push(observer);
      newlyObservedCount++;
    });

    if (newlyObservedCount > 0) {
      logDebug(`[setupArtworkObserver] Added ${newlyObservedCount} new container observers`);
    }
  } catch (error) {
    console.error('[setupArtworkObserver] Error:', error);
  }
}

function waitForDiscoveryContainers(attempt = 1) {
  const zone = document.querySelector(selectors.discoveryZone);

  // If the top-level wrapper isn't rendered yet, retry a few times
  if (!zone) {
    if (attempt < 10) setTimeout(() => waitForDiscoveryContainers(attempt + 1), 500);
    return;
  }

  // If the containers are already populated with artworks, process them immediately
  if (zone.querySelector(`ul li ${selectors.artworkLink}`)) {
    logDebug('[waitForDiscoveryContainers] Zone already populated, processing...');
    setupArtworkObserver();
    updateAllArtworks();
    return;
  }

  logDebug('[waitForDiscoveryContainers] Watching discovery zone for late containers...');

  // Set up a temporary observer to catch the initial batch of elements
  const observer = new MutationObserver((mutations, obs) => {
    if (zone.querySelector(`ul li ${selectors.artworkLink}`)) {
      logDebug('[waitForDiscoveryContainers] Containers populated! Self-destructing observer.');
      obs.disconnect(); // Kill this observer permanently

      setupArtworkObserver();
      updateAllArtworks();
    }
  });

  // Watch the discovery wrapper for the initial injection
  observer.observe(zone, { childList: true, subtree: true });
}

function waitForHomeContainers(attempt = 1) {
  const bg1 = document.querySelector(selectors.bgBackground1);

  // If the wrapper isn't rendered yet, retry a few times
  if (!bg1) {
    if (attempt < 5) setTimeout(() => waitForHomeContainers(attempt + 1), 500);
    return;
  }

  // If the containers are already populated, don't need to wait
  if (bg1.querySelector(`ul li ${selectors.artworkLink}`)) return;

  logDebug('[waitForHomeContainers] Watching bg-background1 for late containers...');

  const observer = new MutationObserver((mutations, obs) => {
    // Wait until the ULs actually contain artwork links
    if (bg1.querySelector(`ul li ${selectors.artworkLink}`)) {
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
  if (appState.pageContentObserver) {
    appState.pageContentObserver.disconnect();
    appState.pageContentObserver = null;
  }

  const pageType = getPageType();
  // Only pages with infinite/pagination loading need this observer
  // Base tag pages (tag-base) have no infinite loading -> skip observer
  if (!['tag', 'tag-search', 'illustration', 'manga', 'discovery', 'profile', 'bookmarks'].includes(pageType)) return;

  let targetContainer = document.body;
  let checkIsGrid = false;

  // 1. Determine the target container and grid style based on page type
  if (pageType === 'discovery') {
    targetContainer = document.querySelector(selectors.discoveryZone);
    if (!targetContainer) {
      logDebug('[pageContentObserver] Discovery zone not found yet -> retrying in 800ms');
      setTimeout(setupPageContentObserver, 800);
      return;
    }
  } else if (pageType === 'tag' || pageType === 'tag-search') {
    // tag and tag-search pages: find the grid and watch its stable parent for pagination
    let grids = findTagPageGrids();
    if (grids.length === 0) {
      logDebug('[pageContentObserver] No col-span-2 grid, checking for ul/li fallback');
      grids = findArtworkGridsByContent();
    }
    if (grids.length === 0) {
      logDebug('[pageContentObserver] Grid not found yet -> retrying in 800ms');
      setTimeout(setupPageContentObserver, 800);
      return;
    }
    // Go up 1–2 levels to a stable parent that survives pagination (the grid itself gets replaced)
    targetContainer = grids[0].parentElement || grids[0];
    if (targetContainer.children.length < 5) {
      targetContainer = targetContainer.parentElement || targetContainer;
    }
    checkIsGrid = true;
  } else if (pageType === 'illustration' || pageType === 'manga') {
    let grids = findArtworkGridsByContent();
    if (grids.length === 0) {
      logDebug(`[pageContentObserver] No grids found yet on ${pageType} page -> retrying in 800ms`);
      setTimeout(setupPageContentObserver, 800);
      return;
    }
    // Keep targetContainer as document.body
  }

  // 2. Attach a unified, optimized observer
  appState.pageContentObserver = new MutationObserver((mutations) => {
    let hasNewContent = false;
    // Detect new <ul> rows or <li> items injected by scroll
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        // Use the optimized helper
        if (hasNewArtworkNodes(mutation.addedNodes, false, checkIsGrid)) {
          hasNewContent = true;
          break;
        }
      }
    }

    if (hasNewContent) {
      logDebug(`[pageContentObserver] New scroll/pagination content detected on ${pageType} -> updating`);
      if (pageContentDebounceTimer) clearTimeout(pageContentDebounceTimer);
      pageContentDebounceTimer = setTimeout(() => {
        if (checkIsGrid) {
          refreshArtworks(true); // Pagination
        } else {
          setupArtworkObserver(); // Attach observers to newly spawned grids
          updateAllArtworks(); // Process the items (WeakMap will skip old ones)
        }
      }, 300);
    }
  });

  appState.pageContentObserver.observe(targetContainer, { childList: true, subtree: true });
  logDebug(`[pageContentObserver] Attached to ${pageType} target container`);
}

function refreshArtworks(isPagination = false) {
  try {
    if (refreshDebounceTimer) {
      clearTimeout(refreshDebounceTimer);
    }
    // Clear retry fallback timer to avoid overlap
    if (appState.updateArtworksTimeout) {
      clearTimeout(appState.updateArtworksTimeout);
      appState.updateArtworksTimeout = null;
    }

    // Clear page content debounce timer
    if (pageContentDebounceTimer) {
      clearTimeout(pageContentDebounceTimer);
      pageContentDebounceTimer = null;
    }

    refreshDebounceTimer = setTimeout(() => {
      logDebug(`[refreshArtworks] Refreshing artworks (debounced, isPagination=${isPagination})`);

      updateProfileBlockCssState();

      // Return if the page is not filterable
      if (!isFilterablePage()) return;

      // Clear processed elements cache when blacklist changes, not on pagination
      if (!isPagination) {
        appState.processedLiElements = new WeakMap();
        logDebug('[refreshArtworks] Cleared processed elements cache');
        appState.observedContainers = new WeakSet();
      }

      appState.removedCount = 0; // Reset for all pages during blacklist update
      logDebug('[refreshArtworks] Reset appState.removedCount to 0 for blacklist update');

      appState.recommendationObservers.forEach((observer) => observer.disconnect());
      appState.recommendationObservers = [];
      logDebug('[refreshArtworks] Disconnected previous artwork observers');

      // Disconnect pageContentObserver to avoid duplicate observers
      if (appState.pageContentObserver) {
        appState.pageContentObserver.disconnect();
        appState.pageContentObserver = null;
        logDebug('[refreshArtworks] Disconnected pageContentObserver');
      }

      updateAllArtworks();
      setupArtworkObserver();
      setupPageContentObserver(); // Re-setup page content observer

      // Ensure indicator exists and reflects the latest state
      updateIndicator();
    }, 250); // debounce timer
  } catch (error) {
    console.error('[refreshArtworks] Error:', error);
  }
}

function updatePage() {
  try {
    logDebug('[updatePage] Updating page for URL:', window.location.pathname);

    // Keep background script's tabUrls map synchronized on SPA navigations
    browser.runtime.sendMessage({ action: 'updateTabUrl', url: window.location.href }).catch(() => {});

    updateProfileBlockCssState();

    // Clear active fallback retry timeouts to eliminate zombie race conditions
    if (appState.updateArtworksTimeout) {
      clearTimeout(appState.updateArtworksTimeout);
      appState.updateArtworksTimeout = null;
    }

    appState.processedLiElements = new WeakMap();
    logDebug('[updatePage] Cleared processed elements cache for new page');
    appState.observedContainers = new WeakSet(); // Clear cache of observed containers

    appState.recommendationObservers.forEach((observer) => observer.disconnect());
    appState.recommendationObservers = [];
    logDebug('[updatePage] Disconnected previous recommendation observers');

    const pageType = getPageType();

    if (pageType) {
      logDebug(`[updatePage] Filterable page detected: ${pageType}, processing`);

      const isArtworkPage = pageType === 'artwork';
      const isProfilePage = pageType === 'profile';
      const authorPromise = isArtworkPage
        ? getPageAuthorId()
        : Promise.resolve(isProfilePage ? getProfileOwnerId() : null);

      if (isArtworkPage) {
        browser.runtime.sendMessage({ action: 'resetBatchCount' });
        logDebug('[updatePage] Sent resetBatchCount message for artwork page');
      }

      authorPromise
        .then((authorId) => {
          appState.currentAuthorId = authorId;
          logDebug(`[updatePage] Final author ID: ${authorId}`);
          appState.removedCount = 0;

          if (isArtworkPage) {
            waitForRecommendationGrid(); // wait on artwork pages
          } else {
            setupArtworkObserver();
            updateAllArtworks();

            if (pageType === 'home') {
              waitForHomeContainers();
            } else if (pageType === 'discovery') {
              waitForDiscoveryContainers(); // wait on discovery page
            }
          }
          updateIndicator();
        })
        .catch((error) => {
          console.error('[updatePage] Error resolving getPageAuthorId:', error);
        });

      setupPageContentObserver();
    } else {
      logDebug('[updatePage] Non-filterable page, skipping recommendation processing');
      resetExtensionState();
    }
  } catch (error) {
    console.error('[updatePage] Error:', error);
  }
}

async function main() {
  try {
    logDebug('[main] main function started');
    browser.runtime.sendMessage({ action: 'updateTabUrl', url: window.location.href }).catch(() => {});
    await loadSettings();

    // Initialize thumbnail fixer for all Pixiv pages
    ThumbnailFixer.init(thumbnailFixerEnabled);

    // Process user filtering only on filterable pages
    if (isFilterablePage()) {
      updatePage();
    } else {
      logDebug('[main] Non-filterable page, skipping user filtering');
      resetExtensionState();
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
      if (window.location.href !== appState.lastPathname) {
        logDebug('[main] URL change detected from:', appState.lastPathname, 'to', window.location.href);
        appState.lastPathname = window.location.href;

        // Reinitialize thumbnail fixer on navigation
        ThumbnailFixer.setEnabled(thumbnailFixerEnabled);

        if (isFilterablePage()) {
          updatePage();
        } else {
          logDebug('[main] Non-filterable page, resetting badge');
          resetExtensionState();
        }
      }
    };

    // Listen for browser back/forward
    window.addEventListener('popstate', checkUrlChange);

    window.addEventListener('unload', () => {
      if (appState.pageContentObserver) appState.pageContentObserver.disconnect();
    });

    const titleObserver = new MutationObserver(() => {
      logDebug('[titleObserver] Title changed, updating page');
      // Reinitialize thumbnail fixer on title change
      ThumbnailFixer.setEnabled(thumbnailFixerEnabled);
      if (isFilterablePage()) {
        updatePage();
      } else {
        logDebug('[titleObserver] Non-filterable page, resetting badge');
        resetExtensionState();
      }
    });

    titleObserver.observe(document.querySelector('title'), { childList: true });

    // Add visibilitychange listener to update badge when tab becomes active
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        logDebug('[main] Tab became visible, updating badge');
        browser.runtime.sendMessage({ action: 'setBadge', count: appState.removedCount });
      }
    });

    logDebug('[main] Navigation and visibility listeners set up');
  } catch (error) {
    console.error('[main] Error:', error);
  }
}

// Listen for storage changes
browser.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.debugMode !== undefined) {
      DEBUG = changes.debugMode.newValue ?? false;
    }
    if (changes.blacklist !== undefined) {
      settings.blacklist = new Set(changes.blacklist.newValue);
      updateProfileBlockCssState();
      if (isFilterablePage()) refreshArtworks(false);
    }
    if (changes.indicatorPos !== undefined) {
      settings.indicatorPos = changes.indicatorPos.newValue;
      updateIndicator();
    }
  } else if (namespace === 'sync') {
    if (changes.removeSameAuthor !== undefined) settings.removeSameAuthor = changes.removeSameAuthor.newValue;

    if (changes.hideBlockedArtistProfileArtworks !== undefined) {
      settings.hideBlockedArtistProfileArtworks = changes.hideBlockedArtistProfileArtworks.newValue;
      updateProfileBlockCssState();
      if (isFilterablePage()) refreshArtworks(false);
    }

    if (changes.thumbnailFixer !== undefined) {
      thumbnailFixerEnabled = changes.thumbnailFixer.newValue;
      if (typeof ThumbnailFixer !== 'undefined') ThumbnailFixer.setEnabled(thumbnailFixerEnabled);
    }

    if (changes.limitRecommendations !== undefined) limitRecommendations = changes.limitRecommendations.newValue;
    if (changes.maxRecommendations !== undefined) maxRecommendations = changes.maxRecommendations.newValue;
    if (changes.indicatorMode !== undefined) {
      settings.indicatorMode = changes.indicatorMode.newValue;
      updateIndicator();
    }
  }
});

main();
