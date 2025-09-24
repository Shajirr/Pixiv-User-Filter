function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

const ThumbnailFixer = {
  // Regular expression to match Pixiv thumbnail URLs
  srcRegexp: /https?:\/\/i[^.]*\.pximg\.net\/(?:c\/\d{3,4}x\d{3,4}(?:_\d+)?(?:_a2)?\/)?(custom-thumb|img-master)\/.*?(\d+_p\d+)_(custom|master|square)1200\.(\w{2,4})/,
  
  // Available quality prefixes, ordered from lowest to highest
  qualityPrefixes: [
    '100x100',
    '128x128',
    '150x150',
    '240x240',
    '240x480',
    '260x260_80',
    '360x360_70',
    '400x250_80',
    '540x540_70',
    '600x600',
    '600x1200_90',
    '768x1200_80'
  ],
  // Check if thumbnail fixing is enabled
  isEnabled: false,
  
  // Set of processed elements to avoid reprocessing
  processedElements: new WeakSet(),
  
  // Initialize the thumbnail fixer
  init(enabled = false) {
    this.isEnabled = enabled;
	logDebug(`[ThumbnailFixer.init] Initializing with enabled=${enabled}`);
    if (enabled) {
      this.processExistingThumbnails();
      this.setupObserver();
    }
  },
  
  // Update the enabled state
  setEnabled(enabled) {
    this.isEnabled = enabled;
    if (enabled) {
      // Clear processed elements cache when enabling
      this.processedElements = new WeakSet();
      this.processExistingThumbnails();
      this.setupObserver();
    } else {
      this.disconnect();
    }
  },
  
// Get the next best quality prefix
  getNextQuality(currentPrefix) {
    if (!currentPrefix) return currentPrefix;

    // Parse input prefix (e.g., '250x250_80' -> { width: 250, height: 250, suffix: '_80' })
    const inputMatch = currentPrefix.match(/(\d+)x(\d+)(_\d+)?/);
    if (!inputMatch) return currentPrefix;
    const inputWidth = parseInt(inputMatch[1], 10);
    const inputHeight = parseInt(inputMatch[2], 10);
    const inputSuffix = inputMatch[3] || '';

    // Find the prefix with the smallest width greater than inputWidth
    let bestPrefix = currentPrefix;
    let minWidthDiff = Infinity;

    for (const prefix of this.qualityPrefixes) {
      const match = prefix.match(/(\d+)x(\d+)(_\d+)?/);
      if (!match) continue;
      const width = parseInt(match[1], 10);
      const height = parseInt(match[2], 10);
      const suffix = match[3] || '';

      // Only consider prefixes with larger width and matching suffix
      if (width > inputWidth && suffix === inputSuffix) {
        const widthDiff = width - inputWidth;
        if (widthDiff < minWidthDiff) {
          minWidthDiff = widthDiff;
          bestPrefix = prefix;
        } else if (widthDiff === minWidthDiff) {
          // If widths are equal, choose the one with closest height
          const currentBestMatch = bestPrefix.match(/(\d+)x(\d+)/);
          const currentBestHeight = parseInt(currentBestMatch[2], 10);
          const heightDiff = Math.abs(height - inputHeight);
          const currentBestHeightDiff = Math.abs(currentBestHeight - inputHeight);
          if (heightDiff < currentBestHeightDiff) {
            bestPrefix = prefix;
          }
        }
      }
    }

    return bestPrefix;
  },
  

  // Check if URL is a thumbnail that needs fixing
  needsFixing(src) {
    if (!src || !this.isEnabled) {
      logDebug(`[ThumbnailFixer.needsFixing] Skipping: src=${src}, isEnabled=${this.isEnabled}`);
      return false;
    }
    const isThumbnail = this.srcRegexp.test(src);
    if (!isThumbnail) {
      logDebug(`[ThumbnailFixer.needsFixing] No match for URL: ${src}`);
      return false;
    }
    const needsFix = src.includes('_square1200') || src.includes('_custom1200') || src.includes('/custom-thumb/') || src.includes('_a2');
    logDebug(`[ThumbnailFixer.needsFixing] URL: ${src}, isThumbnail: ${isThumbnail}, Has _square1200: ${src.includes('_square1200')}, Has _custom1200: ${src.includes('_custom1200')}, Has custom-thumb: ${src.includes('/custom-thumb/')}, Has _a2: ${src.includes('_a2')}, Needs fixing: ${needsFix}`);
    return needsFix;
  },
  
  // Convert thumbnail URL to uncropped master URL
  fixThumbnailUrl(src) {
    if (!this.needsFixing(src)) return src;
    
    let newUrl = src;
    
    // Replace _square1200 or _custom1200 with _master1200
    if (newUrl.includes('_square1200')) {
      newUrl = newUrl.replace('_square1200', '_master1200');
      logDebug(`[ThumbnailFixer] Replaced _square1200 with _master1200: ${src} -> ${newUrl}`);
    } else if (newUrl.includes('_custom1200')) {
      newUrl = newUrl.replace('_custom1200', '_master1200');
      logDebug(`[ThumbnailFixer] Replaced _custom1200 with _master1200: ${src} -> ${newUrl}`);
    }
    
    // Replace custom-thumb with img-master
    if (newUrl.includes('/custom-thumb/')) {
      newUrl = newUrl.replace('/custom-thumb/', '/img-master/');
      logDebug(`[ThumbnailFixer] Replaced custom-thumb with img-master: ${src} -> ${newUrl}`);
    }
    
    // Replace _a2 quality with next best quality
    if (newUrl.includes('_a2')) {
      const qualityMatch = newUrl.match(/\/(\d{3,4}x\d{3,4}(?:_\d+)?(?:_a2)?)\//);
      if (qualityMatch) {
        const oldQuality = qualityMatch[1];
        const newQuality = this.getNextQuality(oldQuality.replace('_a2', ''));
        newUrl = newUrl.replace(oldQuality, newQuality);
        logDebug(`[ThumbnailFixer] Replaced quality ${oldQuality} with ${newQuality} due to _a2: ${src} -> ${newUrl}`);
      }
    }
    
    logDebug(`[ThumbnailFixer] Fixed URL: ${src} -> ${newUrl}`);
    return newUrl;
  },
  
  // Fix a single image element
  fixImageElement(img) {
    if (this.processedElements.has(img)) {
      logDebug(`[ThumbnailFixer.fixImageElement] Skipping already processed image: ${img.src}`);
      return;
    }
    
    const originalSrc = img.src;
	logDebug(`[ThumbnailFixer.fixImageElement] Processing image: ${originalSrc}`);
    const fixedSrc = this.fixThumbnailUrl(originalSrc);
    
    if (fixedSrc !== originalSrc) {
      img.src = fixedSrc;
      
      // Also fix srcset if present
      if (img.srcset) {
			logDebug(`[ThumbnailFixer.fixImageElement] Fixing srcset: ${img.srcset}`);
			img.srcset = img.srcset.replace(this.srcRegexp, (match, domain, quality, q1, a2, pathType, imageId) => {
			  let newQuality = quality;
			  if (a2) newQuality = this.getNextQuality(quality);
			  return `https://${domain}/${newQuality ? `c/${newQuality}/` : ''}img-master/${imageId}_master1200.jpg`;
        });
      }
      
      // Change object-fit from cover to contain
      const currentObjectFit = window.getComputedStyle(img).objectFit;
      if (currentObjectFit === 'cover' || img.style.objectFit === 'cover') {
        img.style.objectFit = 'contain';
		logDebug(`[ThumbnailFixer.fixImageElement] Changed object-fit to contain for: ${fixedSrc}`);
      }
    }
    
    this.processedElements.add(img);
  },
  
  // Fix CSS background images
  fixBackgroundImage(element) {
    if (this.processedElements.has(element)) return;
    
    const backgroundImage = element.style.backgroundImage;
    if (!backgroundImage) return;
    
    const urlMatch = backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    if (!urlMatch) return;
    
    const originalUrl = urlMatch[1];
    const fixedUrl = this.fixThumbnailUrl(originalUrl);
    
    if (fixedUrl !== originalUrl) {
      element.style.backgroundImage = `url("${fixedUrl}")`;
      element.style.backgroundSize = 'contain';
      element.style.backgroundPosition = 'center';
      element.style.backgroundRepeat = 'no-repeat';
    }
    
    this.processedElements.add(element);
  },
  
  // Process all existing thumbnails on the page
  processExistingThumbnails() {
    if (!this.isEnabled) {
      logDebug('[ThumbnailFixer.processExistingThumbnails] Skipping: ThumbnailFixer is disabled');
      return;
    }
	
	// Clear processed elements to ensure all images are rechecked
    this.processedElements = new WeakSet();
    logDebug('[ThumbnailFixer.processExistingThumbnails] Cleared processedElements cache');
    
    // Fix IMG elements
    const images = document.querySelectorAll('img[src*="pximg.net"]');
    logDebug(`[ThumbnailFixer.processExistingThumbnails] Found ${images.length} IMG elements`);
    images.forEach(img => {
      this.fixImageElement(img);
    });
    
    // Fix CSS background images
    const bgElements = document.querySelectorAll('[style*="background-image"]');
    logDebug(`[ThumbnailFixer.processExistingThumbnails] Found ${bgElements.length} background image elements`);
    bgElements.forEach(element => {
      this.fixBackgroundImage(element);
    });
  },
  
  // Set up mutation observer to catch new thumbnails
  setupObserver() {
    if (!this.isEnabled || this.observer) return;
    
    this.observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        // Handle added nodes
        if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          
          if (node.tagName === 'IMG' && node.src && node.src.includes('pximg.net')) {
            this.fixImageElement(node);
            } else if (node.style?.backgroundImage?.includes('pximg.net')) {
              this.fixBackgroundImage(node);
            }
            
            // Check child elements
            node.querySelectorAll?.('img[src*="pximg.net"]').forEach(img => {
              this.fixImageElement(img);
            });
            node.querySelectorAll?.('[style*="background-image"]').forEach(element => {
              this.fixBackgroundImage(element);
            });
          });
		  // Handle attribute changes
        } else if (mutation.type === 'attributes' && mutation.target.nodeType === Node.ELEMENT_NODE) { 
          const target = mutation.target;
          
          if (target.tagName === 'IMG' && (mutation.attributeName === 'src' || mutation.attributeName === 'srcset')) {
            // Remove from processed set to allow reprocessing with new src
            this.processedElements.delete(target);
            this.fixImageElement(target);
          } else if (mutation.attributeName === 'style' && target.style?.backgroundImage?.includes('pximg.net')) {
            this.processedElements.delete(target);
            this.fixBackgroundImage(target);
          }
        }
      });
    });
    
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'style']
    });
  },
  
  // Cleanup observer
  disconnect() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ThumbnailFixer;
}