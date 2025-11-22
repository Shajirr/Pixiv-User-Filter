const DEBUG = true;

function logDebug(...args) {
  if (DEBUG) console.log(...args);
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
  const lines = input.split('\n').filter(line => line.trim());
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

function showSaveMessage(messageText, isSuccess) {
  const saveMessage = document.getElementById('save-message');
  saveMessage.textContent = messageText;
  saveMessage.classList.add('visible');
  setTimeout(() => {
    saveMessage.classList.remove('visible');
  }, 3000);
}

function exportBlacklist() {
  browser.storage.local.get('blacklist').then(result => {
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
    showSaveMessage('Blacklist exported successfully', true);
  }).catch(error => {
    console.error('[exportBlacklist] Error:', error);
    showSaveMessage('Failed to export blacklist', false);
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

textarea.addEventListener('input', debounce(() => {
  setTextareaHeight();
  const validationResult = parseBlacklist(textarea.value);
  showErrorMessage(validationResult);
}, 300));

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const result = parseBlacklist(textarea.value);
  showErrorMessage(result);
  if (result.isValid) {
    const removeSameAuthor = document.getElementById('removeSameAuthor').checked;
    const thumbnailFixer = document.getElementById('thumbnailFixer').checked;
	const limitRecommendations = limitCheckbox.checked;
	const maxRecommendations = parseInt(maxRecSlider.value, 10);
	
    browser.storage.local.set({ 
      blacklist: result.ids, 
      removeSameAuthor,
      thumbnailFixer,
	  limitRecommendations, 
	  maxRecommendations
    }).then(() => {
      showSaveMessage('Settings saved', true);
      browser.runtime.sendMessage({ action: "refreshBlacklist" });
    });
  } else {
    showSaveMessage('Settings not saved, error in the Blacklisted User ID list', false);
  }
});

exportButton.addEventListener('click', exportBlacklist);

maxRecSlider.addEventListener('input', (e) => {
  updateMaxRecValue(e.target.value);
});

limitCheckbox.addEventListener('change', (e) => {
  toggleSliderState(e.target.checked);
});

browser.storage.local.get(['blacklist', 'removeSameAuthor', 'thumbnailFixer', 'limitRecommendations', 'maxRecommendations']).then(result => {
  textarea.value = (result.blacklist || []).join('\n');
  document.getElementById('removeSameAuthor').checked = result.removeSameAuthor || false;
  document.getElementById('thumbnailFixer').checked = result.thumbnailFixer || false;
  limitCheckbox.checked = result.limitRecommendations !== undefined ? result.limitRecommendations : false;
  maxRecSlider.value = result.maxRecommendations || DEFAULT_MAX_RECOMMENDATIONS;
  updateMaxRecValue(maxRecSlider.value);
  toggleSliderState(limitCheckbox.checked);
  setTextareaHeight();
  const validationResult = parseBlacklist(textarea.value);
  showErrorMessage(validationResult);
});

// Listen for storage changes to keep the options page in sync
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.blacklist) {
    const newBlacklist = changes.blacklist.newValue || [];
    textarea.value = newBlacklist.join('\n');
    setTextareaHeight();
    const validationResult = parseBlacklist(textarea.value);
    showErrorMessage(validationResult);
    logDebug('Options page: Blacklist updated from storage');
  }
});