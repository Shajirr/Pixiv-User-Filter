// console.log('Pixiv Recommendation Filter content script loaded');

let removedCount = 0;
let counterElement = null;
let recommendationObserver = null;
let navigationObserver = null;
let lastPathname = window.location.pathname;
let currentAuthorId = null;

function updateCounter() {
  try {
    if (counterElement) {
      counterElement.textContent = `Removed: ${removedCount}`;
      // console.log(`Updated counter to display: Removed: ${removedCount}`);
    } else {
      // console.log('Counter element not found, cannot update counter');
    }
  } catch (error) {
    console.error('Error in updateCounter:', error);
  }
}

function createCounter(attempt = 1, maxAttempts = 10) {
  return new Promise(resolve => {
    // console.log(`createCounter attempt ${attempt}/${maxAttempts}`);
    try {
      // Remove any existing counter to prevent duplicates
      const existingCounters = document.querySelectorAll('span.pixiv-recommendation-counter');
      existingCounters.forEach(counter => counter.remove());
      // Try "Related works" header first, fallback to recommendation container parent or body
      const heading = document.querySelector('h2.sc-a6755c3a-3.glkuHK');
      const container = document.querySelector('ul.sc-bf8cea3f-1.bCxfvI');
      const parent = container ? container.parentElement : null;
      const anchor = heading || parent || document.body;
      if (anchor) {
        counterElement = document.createElement('span');
        counterElement.className = 'pixiv-recommendation-counter';
        counterElement.style.marginLeft = '10px';
        counterElement.style.fontSize = '14px';
        counterElement.style.color = '#555';
        counterElement.textContent = `Removed: ${removedCount}`;
        anchor.insertAdjacentElement(heading ? 'afterend' : 'beforebegin', counterElement);
        // console.log(`Counter element created near ${anchor.tagName.toLowerCase()}${heading ? ' (Related works header)' : ''}`);
        resolve(true);
      } else {
        // console.log('No suitable anchor found for counter');
        if (attempt < maxAttempts) {
          // console.log(`Retrying counter creation in 1000ms...`);
          setTimeout(() => {
            resolve(createCounter(attempt + 1, maxAttempts));
          }, 1000);
        } else {
          // console.log('Max attempts reached, failed to create counter');
          resolve(false);
        }
      }
    } catch (error) {
      console.error('Error in createCounter:', error);
      resolve(false);
    }
  });
}

function getPageAuthorId(attempt = 1, maxAttempts = 5) {
  // console.log(`getPageAuthorId attempt ${attempt}/${maxAttempts}`);
  try {
    // Try Follow button first
    const followButton = document.querySelector('button[data-gtm-user-id]');
    if (followButton) {
      const id = followButton.getAttribute('data-gtm-user-id');
      // console.log(`Author ID found from button: ${id}`);
      return Promise.resolve(id);
    }
    // Fallback to <a> tag in section
    const link = document.querySelector('section.sc-7d1a8035-1 a[data-gtm-value]');
    if (link) {
      const id = link.getAttribute('data-gtm-value');
      // console.log(`Author ID found from link: ${id}`);
      return Promise.resolve(id);
    }
    // console.log('Author ID not found');
    if (attempt < maxAttempts) {
      // console.log(`Retrying in 500ms...`);
      return new Promise(resolve => {
        setTimeout(() => {
          resolve(getPageAuthorId(attempt + 1, maxAttempts));
        }, 500);
      });
    }
    // console.log(`Max attempts reached, no author ID found`);
    return Promise.resolve(null);
  } catch (error) {
    console.error(`Error in getPageAuthorId (attempt ${attempt}):`, error);
    return Promise.resolve(null);
  }
}

function processLi(li, blacklist, authorId, removeSameAuthor) {
  try {
    const a = li.querySelector('a[data-gtm-user-id]');
    if (a) {
      const userId = a.getAttribute('data-gtm-user-id');
      if (blacklist.has(userId) || (removeSameAuthor && authorId && userId === authorId)) {
        li.style.display = 'none';
        removedCount++;
        // console.log(`Removed recommendation for user ID: ${userId}`);
      } else {
        li.style.display = '';
      }
    }
  } catch (error) {
    console.error('Error in processLi:', error);
  }
}

function processRecommendations(blacklist, authorId, removeSameAuthor) {
  try {
    removedCount = 0;
    // console.log('Processing recommendations, resetting removedCount to 0');
    const container = document.querySelector('ul.sc-bf8cea3f-1.bCxfvI');
    if (container) {
      const lis = container.querySelectorAll('li');
      // console.log(`Found ${lis.length} recommendation items`);
      lis.forEach(li => processLi(li, blacklist, authorId, removeSameAuthor));
    } else {
      // console.log('Recommendation container not found');
    }
    updateCounter();
  } catch (error) {
    console.error('Error in processRecommendations:', error);
  }
}

function isArtworkPage() {
  const regex = /\/en\/artworks\/\d+$/;
  return regex.test(window.location.pathname);
}

function setupRecommendationObserver() {
  try {
    if (!recommendationObserver) {
      const container = document.querySelector('ul.sc-bf8cea3f-1.bCxfvI');
      if (container) {
        recommendationObserver = new MutationObserver(mutations => {
          browser.storage.local.get(['blacklist', 'removeSameAuthor']).then(result => {
            const blacklist = new Set(result.blacklist || []);
            const removeSameAuthor = result.removeSameAuthor || false;
            // console.log(`Recommendation observer processing with removeSameAuthor: ${removeSameAuthor}`);
            mutations.forEach(mutation => {
              if (mutation.addedNodes) {
                mutation.addedNodes.forEach(node => {
                  if (node.nodeName === 'LI') {
                    processLi(node, blacklist, currentAuthorId, removeSameAuthor);
                    updateCounter();
                  }
                });
              }
            });
          }).catch(error => {
            console.error('Error retrieving storage in recommendation observer:', error);
          });
        });
        recommendationObserver.observe(container, { childList: true });
        // console.log('Recommendation observer set up');
      } else {
        // console.log('Recommendation container not found for observer');
      }
    }
  } catch (error) {
    console.error('Error setting up recommendation observer:', error);
  }
}

function refreshRecommendations() {
  try {
    // console.log('Refreshing recommendations due to blacklist update');
    if (isArtworkPage()) {
      browser.storage.local.get(['blacklist', 'removeSameAuthor']).then(result => {
        const blacklist = new Set(result.blacklist || []);
        const removeSameAuthor = result.removeSameAuthor || false;
        // console.log(`Remove same author toggle: ${removeSameAuthor}`);
        // Try to create counter if not present
        if (!counterElement) {
          createCounter().then(success => {
            if (!success) {
              // console.log('Proceeding with recommendation processing despite counter creation failure');
            }
            // Reset recommendation observer
            if (recommendationObserver) {
              recommendationObserver.disconnect();
              recommendationObserver = null;
              // console.log('Disconnected previous recommendation observer for blacklist update');
            }
            processRecommendations(blacklist, currentAuthorId, removeSameAuthor);
            setupRecommendationObserver();
          });
        } else {
          // Reset recommendation observer
          if (recommendationObserver) {
            recommendationObserver.disconnect();
            recommendationObserver = null;
            // console.log('Disconnected previous recommendation observer for blacklist update');
          }
          processRecommendations(blacklist, currentAuthorId, removeSameAuthor);
          setupRecommendationObserver();
        }
      }).catch(error => {
        console.error('Error retrieving storage for refresh:', error);
      });
    }
  } catch (error) {
    console.error('Error in refreshRecommendations:', error);
  }
}

function updatePage() {
  try {
    // console.log('Updating page for URL:', window.location.pathname);
    // Disconnect existing recommendation observer
    if (recommendationObserver) {
      recommendationObserver.disconnect();
      recommendationObserver = null;
      // console.log('Disconnected previous recommendation observer');
    }
    // Clear existing counter
    if (counterElement) {
      counterElement.remove();
      counterElement = null;
      // console.log('Removed previous counter element');
    }
    if (isArtworkPage()) {
      // console.log('Artwork page detected, processing recommendations');
      browser.storage.local.get(['blacklist', 'removeSameAuthor']).then(result => {
        const blacklist = new Set(result.blacklist || []);
        const removeSameAuthor = result.removeSameAuthor || false;
        // console.log(`Remove same author toggle: ${removeSameAuthor}`);
        getPageAuthorId().then(authorId => {
          currentAuthorId = authorId;
          // console.log(`Final author ID: ${authorId}`);
          // Reset counter
          removedCount = 0;
          createCounter().then(() => {
            processRecommendations(blacklist, currentAuthorId, removeSameAuthor);
            setupRecommendationObserver();
            updateCounter();
          });
        }).catch(error => {
          console.error('Error resolving getPageAuthorId:', error);
        });
      }).catch(error => {
        console.error('Error retrieving storage:', error);
      });
    } else {
      // console.log('Non-artwork page, skipping recommendation processing');
      removedCount = 0;
      currentAuthorId = null;
    }
  } catch (error) {
    console.error('Error in updatePage:', error);
  }
}

function main() {
  try {
    // console.log('main function started');
    updatePage();
    // Listen for blacklist updates
    browser.runtime.onMessage.addListener((message) => {
      if (message.action === "refreshBlacklist" && isArtworkPage()) {
        // console.log('Received refreshBlacklist message on artwork page');
        refreshRecommendations();
      }
    });
    // Detect navigation via MutationObserver
    const mainContainer = document.querySelector('main') || document.body;
    navigationObserver = new MutationObserver((mutations) => {
      if (window.location.pathname !== lastPathname) {
        // console.log('Navigation detected via URL change from', lastPathname, 'to', window.location.pathname);
        lastPathname = window.location.pathname;
        updatePage();
      }
    });
    navigationObserver.observe(mainContainer, { 
      childList: true, 
      subtree: true 
    });
    // console.log('Navigation observer set up');
  } catch (error) {
    console.error('Error in main:', error);
  }
}

main();