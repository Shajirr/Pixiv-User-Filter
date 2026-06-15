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

const DEFAULT_MAX_RECOMMENDATIONS = 90;

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
const limitCheckbox = document.getElementById('limitRecommendations');
const maxRecSlider = document.getElementById('maxRecommendations');
const autoBackupCheckbox = document.getElementById('autoBackup');
const debugModeCheckbox = document.getElementById('debugMode');
const saveBackupBtn = document.getElementById('saveBackup');
const loadBackupBtn = document.getElementById('loadBackup');
const loadBackupFile = document.getElementById('loadBackupFile');

textarea.addEventListener(
  'input',
  debounce(() => {
    setTextareaHeight();
    const validationResult = parseBlacklist(textarea.value);
    showErrorMessage(validationResult);
  }, 300),
);

// Toggle auto-backup functionality and request permissions
autoBackupCheckbox.addEventListener('change', async (e) => {
  if (e.target.checked) {
    try {
      const granted = await browser.permissions.request({ permissions: ['downloads'] });
      if (granted) {
        await browser.storage.local.set({ autoBackup: true });
        showStatusMessage('Auto-backup enabled', true);
      } else {
        e.target.checked = false;
        await browser.storage.local.set({ autoBackup: false });
        showStatusMessage('Permission denied. Auto-backup disabled.', false);
      }
    } catch (err) {
      console.error('Permission request error:', err);
      e.target.checked = false;
    }
  } else {
    await browser.storage.local.set({ autoBackup: false });
    showStatusMessage('Auto-backup disabled', true);
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const result = parseBlacklist(textarea.value);
  showErrorMessage(result);
  if (result.isValid) {
    const removeSameAuthor = document.getElementById('removeSameAuthor').checked;
    const thumbnailFixer = document.getElementById('thumbnailFixer').checked;
    const limitRecommendations = limitCheckbox.checked;
    const maxRecommendations = parseInt(maxRecSlider.value, 10);
    const DEBUG = debugModeCheckbox.checked;

    browser.storage.local
      .set({
        blacklist: result.ids,
        removeSameAuthor,
        thumbnailFixer,
        limitRecommendations,
        maxRecommendations,
        DEBUG,
      })
      .then(() => {
        showStatusMessage('Settings saved', true);
        browser.runtime.sendMessage({ action: 'refreshBlacklist' });
      });
  } else {
    showStatusMessage('Settings not saved, error in the Blacklisted User ID list', false);
  }
});

exportButton.addEventListener('click', exportBlacklist);

saveBackupBtn.addEventListener('click', async () => {
  try {
    showStatusMessage('Creating backup...', true);

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

      showStatusMessage('Backup saved successfully', true);
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

        browser.storage.local.set(data).then(() => {
          showStatusMessage('Backup loaded successfully', true);
          browser.runtime.sendMessage({ action: 'refreshBlacklist' });
          // Reload the page after 1s to visually reflect the newly loaded settings
          setTimeout(() => window.location.reload(), 1500);
        });
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

maxRecSlider.addEventListener('input', (e) => {
  updateMaxRecValue(e.target.value);
});

limitCheckbox.addEventListener('change', (e) => {
  toggleSliderState(e.target.checked);
});

browser.storage.local
  .get({
    blacklist: [],
    removeSameAuthor: false,
    thumbnailFixer: false,
    limitRecommendations: false,
    maxRecommendations: DEFAULT_MAX_RECOMMENDATIONS,
    autoBackup: false,
    DEBUG: false,
  })
  .then(async (result) => {
    DEBUG = result.DEBUG;
    logDebug('Debug mode set to:', DEBUG);
    debugModeCheckbox.checked = DEBUG;
    textarea.value = result.blacklist.join('\n');
    document.getElementById('removeSameAuthor').checked = result.removeSameAuthor;
    document.getElementById('thumbnailFixer').checked = result.thumbnailFixer;
    limitCheckbox.checked = result.limitRecommendations;
    maxRecSlider.value = result.maxRecommendations;

    // Verify permissions for auto-backup visually
    const hasPerm = await browser.permissions.contains({ permissions: ['downloads'] });
    if (result.autoBackup && !hasPerm) {
      // Permission was revoked in browser settings while extension was inactive
      await browser.storage.local.set({ autoBackup: false });
      autoBackupCheckbox.checked = false;
    } else {
      autoBackupCheckbox.checked = result.autoBackup;
    }

    updateMaxRecValue(maxRecSlider.value);
    toggleSliderState(limitCheckbox.checked);
    setTextareaHeight();
    const validationResult = parseBlacklist(textarea.value);
    showErrorMessage(validationResult);
  });

// Listen for storage changes to keep the options page in sync
browser.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.blacklist) {
      const newBlacklist = changes.blacklist.newValue || [];
      textarea.value = newBlacklist.join('\n');
      setTextareaHeight();
      const validationResult = parseBlacklist(textarea.value);
      showErrorMessage(validationResult);
      logDebug('Options page: Blacklist updated from storage');
    }
    if (changes.DEBUG) {
      DEBUG = changes.DEBUG.newValue ?? false;
      debugModeCheckbox.checked = DEBUG;
      logDebug('Debug mode changed to:', DEBUG);
    }
    // Update checkbox if background script disables auto-backup dynamically
    if (changes.autoBackup !== undefined) {
      autoBackupCheckbox.checked = changes.autoBackup.newValue ?? false;
    }
  }
});
