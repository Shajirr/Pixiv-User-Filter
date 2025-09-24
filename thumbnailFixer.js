function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

const ThumbnailFixer = {
  // Regular expression to match Pixiv thumbnail URLs
  srcRegexp: /https?:\/\/(i[^.]*\.pximg\.net)(?:\/c\/(\d+)x(\d+)(?:_[^/]*)?)?\/(?:custom-thumb|img-master)\/(.*?)_(custom|master|square)1200\.jpg/,
  
  // Check if thumbnail fixing is enabled
  isEnabled: false,
  
  // Set of processed elements to avoid reprocessing
  processedElements: new WeakSet(),
  
  // Initialize the thumbnail fixer
  init(enabled = false) {
    this.isEnabled = enabled;
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
    }
  },
  
  // Check if URL is a square thumbnail that needs fixing
  needsFixing(src) {
    if (!src || !this.isEnabled) return false;
    const match = src.match(this.srcRegexp);
    return match && match[5] === 'square';
  },
  
  // Convert square thumbnail URL to uncropped master URL
  fixThumbnailUrl(src) {
    if (!this.needsFixing(src)) return src;
    return src.replace(/_square1200\.jpg$/, '_master1200.jpg');
  },
  
  // Fix a single image element
  fixImageElement(img) {
    if (this.processedElements.has(img)) return;
    
    const originalSrc = img.src;
    const fixedSrc = this.fixThumbnailUrl(originalSrc);
    
    if (fixedSrc !== originalSrc) {
      img.src = fixedSrc;
      
      // Also fix srcset if present
      if (img.srcset) {
        img.srcset = img.srcset.replace(/_square1200\.jpg/g, '_master1200.jpg');
      }
      
      // Change object-fit from cover to contain
      const currentObjectFit = window.getComputedStyle(img).objectFit;
      if (currentObjectFit === 'cover' || img.style.objectFit === 'cover') {
        img.style.objectFit = 'contain';
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
    if (!this.isEnabled) return;
    
    // Fix IMG elements
    document.querySelectorAll('img[src*="pximg.net"]').forEach(img => {
      this.fixImageElement(img);
    });
    
    // Fix CSS background images
    document.querySelectorAll('div[style*="background-image"], a[style*="background-image"]').forEach(element => {
      this.fixBackgroundImage(element);
    });
  },
  
  // Set up mutation observer to catch new thumbnails
  setupObserver() {
    if (!this.isEnabled || this.observer) return;
    
    this.observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        // Handle added nodes
        mutation.addedNodes.forEach(node => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          
          if (node.tagName === 'IMG' && node.src && node.src.includes('pximg.net')) {
            this.fixImageElement(node);
          } else if ((node.tagName === 'DIV' || node.tagName === 'A') && node.style.backgroundImage) {
            this.fixBackgroundImage(node);
          } else {
            // Check child elements
            node.querySelectorAll?.('img[src*="pximg.net"]').forEach(img => {
              this.fixImageElement(img);
            });
            node.querySelectorAll?.('div[style*="background-image"], a[style*="background-image"]').forEach(element => {
              this.fixBackgroundImage(element);
            });
          }
        });
        
        // Handle attribute changes
        if (mutation.type === 'attributes' && mutation.target.nodeType === Node.ELEMENT_NODE) {
          const target = mutation.target;
          
          if (target.tagName === 'IMG' && (mutation.attributeName === 'src' || mutation.attributeName === 'srcset')) {
            // Remove from processed set to allow reprocessing with new src
            this.processedElements.delete(target);
            this.fixImageElement(target);
          } else if ((target.tagName === 'DIV' || target.tagName === 'A') && mutation.attributeName === 'style') {
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