function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

function setTextareaHeight() {
  const textarea = document.getElementById('blacklist');
  const lines = textarea.value.split('\n').length;
  const maxLines = 30;
  const lineHeight = 20; // Approximate line height in pixels
  textarea.style.height = `${Math.min(lines, maxLines) * lineHeight + 30}px`;
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

const textarea = document.getElementById('blacklist');
const form = document.getElementById('options-form');

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
    browser.storage.local.set({ blacklist: result.ids, removeSameAuthor }).then(() => {
      showSaveMessage('Settings saved', true);
      browser.runtime.sendMessage({ action: "refreshBlacklist" });
    });
  } else {
    showSaveMessage('Settings not saved, error in the Blacklisted User ID list', false);
  }
});

browser.storage.local.get(['blacklist', 'removeSameAuthor']).then(result => {
  textarea.value = (result.blacklist || []).join('\n');
  document.getElementById('removeSameAuthor').checked = result.removeSameAuthor || false;
  setTextareaHeight();
  const validationResult = parseBlacklist(textarea.value);
  showErrorMessage(validationResult);
});