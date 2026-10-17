let DEBUG = false;
const debugPrefix = '[Pxv.UF]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

// Settings intended for cross-device sync
const SYNC_DEFAULTS = Object.freeze({
  removeSameAuthor: false,
  thumbnailFixer: false,
  limitRecommendations: false,
  maxRecommendations: 90,
  indicatorMode: 'counter', // 'counter' | 'indicator' | 'off'
  hideBlockedArtistProfileArtworks: true,
});

// Settings specific to the local browser installation
const LOCAL_DEFAULTS = Object.freeze({
  blacklist: [],
  autoBackup: false,
  debugMode: false,
});

const DEBOUNCE_DELAY = 400;
let autoSaveTimer;

// The buffer to hold gathered changes during the debounce window
let pendingChanges = {
  local: {},
  sync: {},
};

function setTextareaHeight() {
  const textarea = document.getElementById('blacklist');
  const lines = textarea.value.split('\n').length;
  const maxLines = 30;
  const lineHeight = 20; // Approximate line height in pixels
  textarea.style.height = `${Math.min(lines, maxLines) * lineHeight + 10}px`;
  textarea.style.overflowY = lines > maxLines ? 'auto' : 'hidden';
}

function parseBlacklist(input) {
  const lines = input.split('\n').filter((line) => line.trim());
  const ids = [];
  if (lines.length === 0) return { isValid: true, ids };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !/^\d+$/.test(line)) {
      return { isValid: false, lineNumber: i + 1, lineContent: line };
    }
    if (line) ids.push(line);
  }
  return { isValid: true, ids };
}

function showErrorMessage(validationResult) {
  const errorMessage = document.getElementById('error-message');
  const textarea = document.getElementById('blacklist');
  if (!validationResult.isValid) {
    errorMessage.textContent = `Invalid input on line ${validationResult.lineNumber}: '${validationResult.lineContent}'`;
    errorMessage.classList.add('visible');
    textarea.classList.add('invalid');
  } else {
    errorMessage.classList.remove('visible');
    textarea.classList.remove('invalid');
  }
}

function showStatusMessage(messageText, isSuccess) {
  const statusMessage = document.getElementById('status-message');
  statusMessage.textContent = messageText;
  statusMessage.style.color = isSuccess ? '' : 'var(--in-content-error-color, #c93434)';
  statusMessage.classList.add('visible');
  setTimeout(() => {
    statusMessage.classList.remove('visible');
  }, 3000);
}

function exportBlacklist() {
  browser.storage.local
    .get('blacklist')
    .then((result) => {
      const blacklist = result.blacklist || [];
      const content = blacklist.join('\n');
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const isoDate = new Date().toISOString().split('T')[0]; // Use only the date part (YYYY-MM-DD)
      a.download = `pixiv_blacklist_${isoDate}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showStatusMessage('Blacklist exported successfully', true);
    })
    .catch((error) => {
      console.error('[exportBlacklist] Error:', error);
      showStatusMessage('Failed to export blacklist', false);
    });
}

function updateMaxRecValue(value) {
  document.getElementById('maxRecValue').textContent = value;
}

function toggleSliderState(enabled) {
  const sliderContainer = document.querySelector('.slider-container');
  const maxRecSlider = document.getElementById('maxRecommendations');
  if (enabled) {
    sliderContainer.classList.remove('disabled');
    maxRecSlider.disabled = false;
  } else {
    sliderContainer.classList.add('disabled');
    maxRecSlider.disabled = true;
  }
}

const textarea = document.getElementById('blacklist');
const form = document.getElementById('options-form');
const exportButton = document.getElementById('exportBlacklist');
const saveBackupBtn = document.getElementById('saveBackup');
const loadBackupBtn = document.getElementById('loadBackup');
const loadBackupFile = document.getElementById('loadBackupFile');

// Textarea auto-resize and validation (runs on type, but does not auto-save)
textarea.addEventListener(
  'input',
  debounce(() => {
    setTextareaHeight();
    const validationResult = parseBlacklist(textarea.value);
    showErrorMessage(validationResult);
  }, 300),
);

// Listen to inputs, queue changes into a buffer, and autosave dynamically
document.addEventListener('input', async (e) => {
  const el = e.target;

  // Ignore inputs without a defined data-setting attribute
  if (!el.hasAttribute('data-setting')) return;

  const key = el.getAttribute('data-setting');
  let value;

  // Parse numbers safely and handle checkboxes
  if (el.type === 'checkbox') {
    value = el.checked;
  } else if (el.type === 'number' || el.type === 'range') {
    // Included range for the slider
    value = parseInt(el.value, 10);
  } else {
    value = el.value;
  }

  // Instant UI state updates (bypasses debounce wait)
  if (key === 'limitRecommendations') toggleSliderState(value);
  if (key === 'maxRecommendations') updateMaxRecValue(value);

  // Special permission check requires synchronous user interaction to trigger native browser prompt
  if (key === 'autoBackup') {
    if (value === true) {
      try {
        const granted = await browser.permissions.request({ permissions: ['downloads'] });
        if (!granted) {
          el.checked = false;
          showStatusMessage('Permission denied. Auto-backup disabled.', false);
          return; // Cancel saving this property to buffer
        }
        showStatusMessage('Auto-backup enabled', true);
      } catch (err) {
        console.error('Permission request error:', err);
        el.checked = false;
        return;
      }
    } else {
      showStatusMessage('Auto-backup disabled', true);
    }
  }

  // Route the change to the correct storage bucket inside the buffer
  if (['debugMode', 'autoBackup'].includes(key)) {
    pendingChanges.local[key] = value;
  } else {
    pendingChanges.sync[key] = value;
  }

  // Clear the saving timer every time the user types/clicks
  clearTimeout(autoSaveTimer);

  // Start a new countdown which triggers the master commit function
  autoSaveTimer = setTimeout(commitSaves, DEBOUNCE_DELAY);
});

// Execute pending saves
async function commitSaves() {
  const localUpdates = { ...pendingChanges.local };
  const syncUpdates = { ...pendingChanges.sync };

  // Cancel if nothing is queued
  if (Object.keys(localUpdates).length === 0 && Object.keys(syncUpdates).length === 0) return;

  // Instantly clear global queues so new inputs can buffer during the async save
  pendingChanges.local = {};
  pendingChanges.sync = {};

  try {
    const savePromises = [];

    if (Object.keys(localUpdates).length > 0) {
      savePromises.push(browser.storage.local.set(localUpdates));
      if ('debugMode' in localUpdates) DEBUG = localUpdates.debugMode;
    }

    if (Object.keys(syncUpdates).length > 0) {
      savePromises.push(browser.storage.sync.set(syncUpdates));
    }

    if (savePromises.length > 0) {
      await Promise.all(savePromises);
      const savedKeys = [...Object.keys(localUpdates), ...Object.keys(syncUpdates)];
      logDebug(`Auto-saved keys: ${savedKeys.join(', ')}`);
    }
  } catch (error) {
    console.error(error);
    showStatusMessage(`Failed to save some settings`, false);
  }
}

// Manual save for the blacklist
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const result = parseBlacklist(textarea.value);
  showErrorMessage(result);

  if (result.isValid) {
    // Blacklist must stay in local storage due to sync quota limits
    browser.storage.local.set({ blacklist: result.ids }).then(() => {
      showStatusMessage('Blacklist saved successfully', true);
      browser.runtime.sendMessage({ action: 'refreshBlacklist' });
    });
  } else {
    showStatusMessage('Error in blacklist, save failed', false);
  }
});

// Load settings from storage and update UI
async function loadOptions() {
  try {
    // TEMP - destroy old keys stuck in local storage from previous versions
    const obsoleteLocalKeys = ['DEBUG', 'showCounter', ...Object.keys(SYNC_DEFAULTS)];
    await browser.storage.local.remove(obsoleteLocalKeys);

    // Fetch from both sync and local areas
    const syncSettings = await browser.storage.sync.get(SYNC_DEFAULTS);
    const localSettings = await browser.storage.local.get(LOCAL_DEFAULTS);

    DEBUG = localSettings.debugMode; // Update local DEBUG state
    const settings = { ...syncSettings, ...localSettings }; // Merge for UI population
    logDebug('Debug mode set to:', DEBUG);

    // Populate generic fields dynamically
    document.querySelectorAll('[data-setting]').forEach((el) => {
      const key = el.getAttribute('data-setting');
      if (el.type === 'checkbox') {
        el.checked = settings[key];
      } else {
        el.value = settings[key];
      }
    });

    // Populate manual blacklist field
    textarea.value = settings.blacklist.join('\n');

    // Verify permissions for auto-backup visually
    const hasPerm = await browser.permissions.contains({ permissions: ['downloads'] });
    if (settings.autoBackup && !hasPerm) {
      await browser.storage.local.set({ autoBackup: false });
      document.querySelector('[data-setting="autoBackup"]').checked = false;
    }

    // Set initial UI constraints
    updateMaxRecValue(settings.maxRecommendations);
    toggleSliderState(settings.limitRecommendations);
    setTextareaHeight();
    const validationResult = parseBlacklist(textarea.value);
    showErrorMessage(validationResult);
  } catch (error) {
    console.error('Failed to load options:', error);
  }
}

exportButton.addEventListener('click', exportBlacklist);

saveBackupBtn.addEventListener('click', async () => {
  try {
    showStatusMessage('Creating backup...', true);

    // Ensure any pending slider/checkbox buffers are saved to storage before requesting backup
    clearTimeout(autoSaveTimer);
    await commitSaves();

    // Request the backup payload from the BackupManager module
    const payload = await browser.runtime.sendMessage({ action: 'getManualBackup' });

    if (payload && payload.success) {
      // Create a Blob from the formatted content provided by the module
      const blob = new Blob([payload.content], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      // Use the DOM to trigger the download (requires no permissions)
      const a = document.createElement('a');
      a.href = url;
      a.download = payload.filename; // Standardized filename from module

      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showStatusMessage('Backup created successfully', true);
    } else {
      showStatusMessage('Backup failed to generate', false);
    }
  } catch (error) {
    console.error('Manual backup error:', error);
    showStatusMessage('Backup failed', false);
  }
});

loadBackupBtn.addEventListener('click', () => {
  loadBackupFile.click(); // Trigger the hidden file input
});

loadBackupFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (event) {
    try {
      const data = JSON.parse(event.target.result);
      const blacklistCount = Array.isArray(data.blacklist) ? data.blacklist.length : 0;

      // The warning prompt
      const confirmed = confirm(
        `WARNING: Loading this backup will overwrite your current blacklist and settings.\n\n` +
          `The incoming blacklist contains ${blacklistCount} user IDs.\n\n` +
          `Do you want to proceed?`,
      );

      if (confirmed) {
        // Strip backup_manager_state just in case
        delete data.backup_manager_state;
        delete data.DEBUG; // TEMP, remove obsolete local key

        // Route data back to respective storage areas during restore
        const syncDataToRestore = {};
        const localDataToRestore = {};

        for (const [k, v] of Object.entries(data)) {
          if (k in LOCAL_DEFAULTS) localDataToRestore[k] = v;
          if (k in SYNC_DEFAULTS) syncDataToRestore[k] = v;
        }

        Promise.all([browser.storage.sync.set(syncDataToRestore), browser.storage.local.set(localDataToRestore)]).then(
          () => {
            showStatusMessage('Backup loaded successfully', true);
            browser.runtime.sendMessage({ action: 'refreshBlacklist' });
            // Reload the page after 1.5s to visually reflect the newly loaded settings
            setTimeout(() => window.location.reload(), 1500);
          },
        );
      }
    } catch (err) {
      console.error('[loadBackup] Error:', err);
      alert('Failed to parse backup file. Make sure it is a valid JSON file.');
    }
    // Reset the input value so the exact same file can be selected again if needed
    loadBackupFile.value = '';
  };

  reader.readAsText(file);
});

// Listen for storage changes in both namespaces to keep the options page in sync dynamically
browser.storage.onChanged.addListener((changes, namespace) => {
  for (const [key, { newValue }] of Object.entries(changes)) {
    // Handle the manual textarea specifically
    if (key === 'blacklist') {
      const newBlacklist = newValue || [];
      textarea.value = newBlacklist.join('\n');
      setTextareaHeight();
      const validationResult = parseBlacklist(textarea.value);
      showErrorMessage(validationResult);
      logDebug('Options page: Blacklist updated from storage');
      continue;
    }

    // Update bound DOM elements dynamically
    const el = document.querySelector(`[data-setting="${key}"]`);
    if (el) {
      if (el.type === 'checkbox') {
        el.checked = newValue ?? false;
      } else {
        el.value = newValue;
      }

      // Apply instant UI modifications tied to specific data sets if updated in background
      if (key === 'debugMode') {
        DEBUG = newValue ?? false;
        logDebug('Debug mode changed to:', DEBUG);
      }
      if (key === 'maxRecommendations') updateMaxRecValue(el.value);
      if (key === 'limitRecommendations') toggleSliderState(el.checked);
    }
  }
});

// Load options from storage when the page is loaded
document.addEventListener('DOMContentLoaded', loadOptions);
