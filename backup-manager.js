export class BackupManager {
  /**
   * @param {Object} config - Configuration options
   * @param {string} config.backupFolderName - Used for the backup folder name
   * @param {string} config.addonName - Name of the addon for log prefixing
   * @param {Function} config.getDebugState - Function returning current boolean DEBUG state
   * @param {Object} [config.retention] - How many of each type to keep
   * @param {Function} getDataCallback - An async function returning the data object
   */
  constructor(config, getDataCallback) {
    this.rootFolder = '[FF-addon-backups]';
    this.folderName = config.backupFolderName;
    this.retention = config.retention || { hourly: 4, daily: 3, weekly: 3, monthly: 3 };
    this.getData = getDataCallback;

    // Logging configuration
    this.addonName = config.addonName || 'Addon';
    this.getDebugState = config.getDebugState || (() => false);

    // Time constants in milliseconds
    this.intervals = {
      hourly: 60 * 60 * 1000,
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 30 * 24 * 60 * 60 * 1000,
    };
  }

  // Internal logging methods
  #log(...args) {
    if (this.getDebugState()) {
      console.log(`[${this.addonName}][BackupManager]`, ...args);
    }
  }

  #warn(...args) {
    if (this.getDebugState()) {
      console.warn(`[${this.addonName}][BackupManager]`, ...args);
    }
  }

  #error(...args) {
    // Always log errors
    console.error(`[${this.addonName}][BackupManager]`, ...args);
  }

  async init() {
    this.#log(`Initializing for ${this.folderName}...`);

    // Listen for the coordinator alarm
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'backup_coordinator') {
        this.evaluateBackups();
      }
    });
  }

  // Toggles the backup alarm depending on user settings
  async updateAlarmState(isEnabled) {
    if (isEnabled) {
      // Final security check before starting engine
      const hasPerm = await browser.permissions.contains({ permissions: ['downloads'] });
      if (!hasPerm) {
        this.#log('Cannot enable auto-backup: missing downloads permission.');
        return;
      }

      const alarm = await browser.alarms.get('backup_coordinator');
      if (!alarm) {
        this.#log('Starting auto-backup alarm.');
        await browser.alarms.create('backup_coordinator', { periodInMinutes: 61 });
      }

      // Run an evaluation immediately on startup/enable to catch up
      await this.evaluateBackups();
    } else {
      this.#log('Stopping auto-backup alarm.');
      await browser.alarms.clear('backup_coordinator');
    }
  }

  // Check if the coordinator alarm is currently running
  async isAutoBackupActive() {
    try {
      const alarm = await browser.alarms.get('backup_coordinator');
      return !!alarm;
    } catch (e) {
      this.#error('Error checking alarm status:', e);
      return false;
    }
  }

  async evaluateBackups() {
    // Failsafe: if the permission was pulled but the alarm hasn't halted yet
    const hasPerm = await browser.permissions.contains({ permissions: ['downloads'] });
    if (!hasPerm) {
      this.#log('Downloads permission missing. Aborting evaluateBackups().');
      return;
    }

    const now = Date.now();

    // Check each type to see if enough time has passed since its last successful run
    for (const type of ['hourly', 'daily', 'weekly', 'monthly']) {
      const state = await this.#getState();
      const lastRun = state.lastRunTimes[type] || 0;

      if (now - lastRun >= this.intervals[type]) {
        this.#log(`Time threshold met for ${type} backup.`);

        // performBackup now handles all state saving internally
        await this.performBackup(type);
      }
    }
  }

  async performBackup(type) {
    // Failsafe before using browser.downloads
    if (!browser.downloads) {
      this.#error('browser.downloads API not available. Permission missing.');
      return false;
    }

    try {
      const rawData = await this.getData();
      const dataString = JSON.stringify(rawData, null, 2);
      const currentHash = this.#generateHash(dataString);

      const state = await this.#getState();

      // Duplicate check: if the data hasn't changed since the last backup
      // of this specific type, skip creating a new file.
      if (state.lastHashes[type] === currentHash) {
        this.#log(`No changes detected for ${type} backup. Skipping file creation.`);

        // Update the run time
        state.lastRunTimes[type] = Date.now();
        await browser.storage.local.set({ backup_manager_state: state });

        return true;
      }

      // Data is new, proceed with download
      const dateStr = this.#getFormattedDate();
      const filename = `${this.rootFolder}/${this.folderName}/[${this.addonName}] ${type}_${dateStr}.json`;

      // Create a native Blob from the string data
      const blob = new Blob([dataString], { type: 'application/json' });
      // Generate a local blob:// URL that Firefox security permits
      const url = URL.createObjectURL(blob);

      this.#log(`Writing backup file to: ${filename}`);
      const downloadId = await browser.downloads.download({
        url: url,
        filename: filename,
        conflictAction: 'overwrite',
        saveAs: false,
      });

      // Wait 20 seconds before clearing the URL from RAM.
      // This ensures Firefox has completely finished streaming the file to disk.
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 20000);

      // Update history, enforce retention, and save the new hash
      await this.#enforceRetention(type, downloadId, state);
      state.lastHashes[type] = currentHash;
      state.lastRunTimes[type] = Date.now();
      await browser.storage.local.set({ backup_manager_state: state });

      this.#log(`${type} backup created successfully: ${filename}`);
      return true;
    } catch (error) {
      this.#error(`Failed to create ${type} backup:`, error);
      return false; // Return false so the coordinator tries again next hour
    }
  }

  async getManualBackupPayload() {
    try {
      this.#log('Generating manual backup payload...');
      const rawData = await this.getData();
      const dataString = JSON.stringify(rawData, null, 2);

      const dateStr = this.#getFormattedDate();
      const filename = `[${this.addonName}] manual_${dateStr}.json`;

      return {
        success: true,
        content: dataString,
        filename: filename,
      };
    } catch (error) {
      this.#error(`Failed to generate manual backup payload:`, error);
      return { success: false };
    }
  }

  async #enforceRetention(type, newDownloadId, state) {
    if (!state.history[type]) state.history[type] = [];

    // Add the new file to the record
    state.history[type].push(newDownloadId);

    // Enforce the retention limit
    const limit = this.retention[type];
    while (state.history[type].length > limit) {
      const oldestId = state.history[type].shift();
      await this.#removeFileSilently(oldestId);
    }
  }

  async #removeFileSilently(downloadId) {
    try {
      const downloads = await browser.downloads.search({ id: downloadId });
      const downloadItem = downloads[0];

      if (downloadItem && downloadItem.filename) {
        // Regex validates the path to confirm that this is actually a backup file.
        const escapedRoot = this.rootFolder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedFolder = this.folderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedAddon = this.addonName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const backupFileRegex = new RegExp(
          `${escapedRoot}.*${escapedFolder}.*\\[${escapedAddon}\\]\\s*(hourly|daily|weekly|monthly|manual)_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}\\.json$`,
          'i',
        );
        if (backupFileRegex.test(downloadItem.filename)) {
          await browser.downloads.removeFile(downloadId);
          await browser.downloads.erase({ id: downloadId });
          this.#log(`Removed old backup file: ${downloadItem.filename} (ID: ${downloadId})`);
        } else {
          this.#warn(
            `Download ID ${downloadId} refers to a file (${downloadItem.filename}) that does not appear to be a backup. Skipping removal.`,
          );
        }
      } else {
        this.#warn(
          `Could not find download item for ID ${downloadId}. It may have been deleted manually by the user or is not a valid download.`,
        );
      }
    } catch (e) {
      this.#warn(
        `Error removing old backup file with ID ${downloadId}: ${e.message}. It may have been deleted manually by the user.`,
      );
    }
  }

  async #getState() {
    const result = await browser.storage.local.get('backup_manager_state');
    return (
      result.backup_manager_state || {
        history: { hourly: [], daily: [], weekly: [], monthly: [] },
        lastHashes: { hourly: null, daily: null, weekly: null, monthly: null },
        lastRunTimes: { hourly: 0, daily: 0, weekly: 0, monthly: 0 },
      }
    );
  }

  #generateHash(str) {
    let hash = 0;
    for (let i = 0, len = str.length; i < len; i++) {
      let chr = str.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0;
    }
    return hash.toString();
  }

  #getFormattedDate() {
    const now = new Date();

    // Helper function to pad single-digit numbers with a leading zero
    const pad = (num) => String(num).padStart(2, '0');

    const yyyy = now.getFullYear();
    const mm = pad(now.getMonth() + 1); // Months are 0-indexed
    const dd = pad(now.getDate());
    const hh = pad(now.getHours());
    const min = pad(now.getMinutes());

    return `${yyyy}-${mm}-${dd}_${hh}-${min}`;
  }
}
