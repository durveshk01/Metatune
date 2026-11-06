(() => {
  const DATABASE = "MetatuneDB";
  const VERSION = 2;
  let databasePromise;

  function database() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          const tx = request.transaction;
          let tracks;
          if (!db.objectStoreNames.contains("library")) {
            tracks = db.createObjectStore("library", { keyPath: "id", autoIncrement: true });
          } else {
            tracks = tx.objectStore("library");
          }
          for (const [name, keyPath] of [["date", "date"], ["artist", "artist"], ["album", "album"], ["genre", "genre"], ["format", "format"], ["favorite", "favorite"]]) {
            if (!tracks.indexNames.contains(name)) tracks.createIndex(name, keyPath, { unique: false });
          }
          createStore(db, "versions", "id", true, ["trackId"]);
          createStore(db, "activity", "id", true, ["createdAt", "trackId"]);
          createStore(db, "analysis", "trackId", false, []);
          createStore(db, "settings", "key", false, []);
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        request.onerror = () => reject(request.error || new Error("Could not open local music library."));
        request.onblocked = () => reject(new Error("Close other MetaTune tabs and reload this page to update local storage."));
      });
    }
    return databasePromise;
  }

  function createStore(db, name, keyPath, autoIncrement, indexes) {
    if (db.objectStoreNames.contains(name)) return;
    const store = db.createObjectStore(name, { keyPath, autoIncrement });
    for (const index of indexes) store.createIndex(index, index, { unique: false });
  }

  async function all(storeName) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveTrack(track) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["library", "activity"], "readwrite");
      const request = tx.objectStore("library").add(track);
      request.onsuccess = () => {
        tx.objectStore("activity").add({
          trackId: request.result,
          type: "processed",
          message: `Saved ${track.title || track.filename || "a track"}`,
          createdAt: new Date().toISOString(),
        });
      };
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error("Could not save the track to this device."));
    });
  }

  async function updateTrack(id, changes) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("library", "readwrite");
      const store = tx.objectStore("library");
      const request = store.get(id);
      request.onsuccess = () => {
        if (!request.result) return;
        store.put({ ...request.result, ...changes, id });
      };
      tx.oncomplete = () => resolve(Boolean(request.result));
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Could not update the local track."));
    });
  }

  async function getTrack(id) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = db.transaction("library", "readonly").objectStore("library").get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function deleteTrack(id) {
    const db = await database();
    const tx = db.transaction(["library", "versions", "activity", "analysis"], "readwrite");
    tx.objectStore("library").delete(id);
    const versions = tx.objectStore("versions");
    const versionRequest = versions.index("trackId").openCursor(IDBKeyRange.only(id));
    versionRequest.onsuccess = () => {
      const cursor = versionRequest.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    const activity = tx.objectStore("activity");
    const activityRequest = activity.index("trackId").openCursor(IDBKeyRange.only(id));
    activityRequest.onsuccess = () => {
      const cursor = activityRequest.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.objectStore("analysis").delete(id);
    return transactionDone(tx);
  }

  async function appendActivity(entry) {
    const db = await database();
    const tx = db.transaction("activity", "readwrite");
    tx.objectStore("activity").add({ ...entry, createdAt: entry.createdAt || new Date().toISOString() });
    return transactionDone(tx);
  }

  async function addVersion(trackId, snapshot) {
    const db = await database();
    const tx = db.transaction("versions", "readwrite");
    tx.objectStore("versions").add({ trackId, snapshot, createdAt: new Date().toISOString() });
    return transactionDone(tx);
  }

  async function versionsFor(trackId) {
    const values = await all("versions");
    return values.filter((item) => item.trackId === trackId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function saveAnalysis(trackId, analysis) {
    const db = await database();
    const tx = db.transaction("analysis", "readwrite");
    tx.objectStore("analysis").put({ trackId, analysis, updatedAt: new Date().toISOString() });
    return transactionDone(tx);
  }

  async function getSetting(key, fallback = null) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = db.transaction("settings", "readonly").objectStore("settings").get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : fallback);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveSettings(settings) {
    const db = await database();
    const tx = db.transaction("settings", "readwrite");
    const store = tx.objectStore("settings");
    for (const [key, value] of Object.entries(settings)) store.put({ key, value });
    return transactionDone(tx);
  }

  async function clearLibrary() {
    const db = await database();
    const tx = db.transaction(["library", "versions", "activity", "analysis"], "readwrite");
    tx.objectStore("library").clear();
    tx.objectStore("versions").clear();
    tx.objectStore("activity").clear();
    tx.objectStore("analysis").clear();
    return transactionDone(tx);
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Local storage operation failed."));
    });
  }

  window.MetatuneStore = { database, all, saveTrack, updateTrack, getTrack, appendActivity, addVersion,
    versionsFor, saveAnalysis, getSetting, saveSettings, deleteTrack, clearLibrary };
})();
