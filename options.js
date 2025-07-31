function setTextareaHeight() {
  const textarea = document.getElementById('blacklist');
  const lines = textarea.value.split('\n').length;
  const maxLines = 30;
  const lineHeight = 20; // Approximate line height in pixels
  textarea.style.height = `${Math.min(lines, maxLines) * lineHeight + 30}px`;
  if (lines > maxLines) {
    textarea.style.overflowY = 'auto';
  } else {
    textarea.style.overflowY = 'hidden';
  }
}

function validateBlacklist(input) {
  const lines = input.split('\n').filter(line => line.trim());
  if (lines.length === 0) return { isValid: true };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !/^\d+$/.test(line)) {
      return { isValid: false, lineNumber: i + 1, lineContent: line };
    }
  }
  return { isValid: true };
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

document.getElementById('blacklist').addEventListener('input', () => {
  setTextareaHeight();
  const input = document.getElementById('blacklist').value;
  const validationResult = validateBlacklist(input);
  showErrorMessage(validationResult);
});

document.getElementById('save').addEventListener('click', () => {
  const textarea = document.getElementById('blacklist');
  const input = textarea.value;
  const validationResult = validateBlacklist(input);
  if (validationResult.isValid) {
    const blacklist = input.split('\n').filter(id => id.trim() && /^\d+$/.test(id.trim()));
    const removeSameAuthor = document.getElementById('removeSameAuthor').checked;
    browser.storage.local.set({ blacklist, removeSameAuthor }).then(() => {
      showSaveMessage('Settings saved', true);
      browser.runtime.sendMessage({ action: "refreshBlacklist" });
      showErrorMessage({ isValid: true });
    });
  } else {
    showSaveMessage('Settings not saved, error in the Blacklisted User ID list', false);
    showErrorMessage(validationResult);
  }
});

browser.storage.local.get(['blacklist', 'removeSameAuthor']).then(result => {
  document.getElementById('blacklist').value = (result.blacklist || []).join('\n');
  document.getElementById('removeSameAuthor').checked = result.removeSameAuthor || false;
  setTextareaHeight();
  const validationResult = validateBlacklist(document.getElementById('blacklist').value);
  showErrorMessage(validationResult);
});