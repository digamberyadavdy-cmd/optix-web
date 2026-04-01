
// --- SECURITY GATEKEEPER (Place at the VERY TOP of script.js) ---

// 1. List of files that are PUBLIC (No login required)
const publicPages = ['login.html', 'track_order.html'];
const firebaseConfig = {
    apiKey: "AIzaSyAjhZmLtNG2wQi-crQvmDpIzY66wLtmbz0",
    authDomain: "optixweb-68694.firebaseapp.com",
    projectId: "optixweb-68694",
    storageBucket: "optixweb-68694.firebasestorage.app",
    messagingSenderId: "901004471219",
    appId: "1:901004471219:web:084f95ebc3ebb792dcb9c6",
    measurementId: "G-1VMMR61PSX"
};
let db = null;
let productsRealtimeSubscribed = false;
let productsRealtimeStoreId = null;
let productsRealtimeUnsub = null;

// 2. Get current file name
const path = window.location.pathname;
const page = path.split("/").pop();

// Prevent double-trigger on mobile (ghost/double taps)
let __optixClickLock = false;
document.addEventListener('click', (e) => {
    if (__optixClickLock) {
        e.stopPropagation();
        e.preventDefault();
        return;
    }
    __optixClickLock = true;
    setTimeout(() => { __optixClickLock = false; }, 500);
}, true);

function enforceAccessGate(firebaseSignedIn) {
    const settingsGate = getSettings();
    const loginRequired = settingsGate.loginRequired !== false;
    const localSignedIn = localStorage.getItem('optixLoggedIn') === 'true';
    const sessionSignedIn = sessionStorage.getItem('optixLoggedIn') === 'true';
    const isSignedIn = !!firebaseSignedIn || localSignedIn || sessionSignedIn;
    if (loginRequired && !isSignedIn && !publicPages.includes(page) && page !== "") {
        console.log("Unauthorized access. Redirecting to login.");
        window.location.href = 'login.html';
    }
}

function currentStoreId() {
    return localStorage.getItem('optixStoreId') || sessionStorage.getItem('optixStoreId') || null;
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function isSuperAdminEmail(email) {
    return ['digamber.yadav.dy@gmail.com'].includes(normalizeEmail(email));
}

function hasLocalOptixSession() {
    return localStorage.getItem('optixLoggedIn') === 'true' || sessionStorage.getItem('optixLoggedIn') === 'true';
}

function clearStoredUserProfile() {
    localStorage.removeItem('optixUserProfile');
    sessionStorage.removeItem('optixUserProfile');
}

function setStoredUserProfile(profile) {
    const serialized = JSON.stringify(profile || {});
    localStorage.setItem('optixUserProfile', serialized);
    sessionStorage.setItem('optixUserProfile', serialized);
}

function getStoredUserProfile() {
    try {
        return JSON.parse(localStorage.getItem('optixUserProfile') || sessionStorage.getItem('optixUserProfile') || '{}') || {};
    } catch {
        return {};
    }
}

function clearAuthSessionState() {
    clearActiveStoreRuntimeMirror();
    stopStoreRealtimeSync();
    localStorage.removeItem('optixLoggedIn');
    sessionStorage.removeItem('optixLoggedIn');
    localStorage.removeItem('optixStoreId');
    sessionStorage.removeItem('optixStoreId');
    localStorage.removeItem('optixSessionStart');
    sessionStorage.removeItem('optixSessionStart');
    clearStoredUserProfile();
}

async function waitForInitialAuthState() {
    if (typeof firebase === 'undefined' || !firebase.auth) return null;
    const auth = firebase.auth();
    if (auth.currentUser) return auth.currentUser;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (user) => {
            if (settled) return;
            settled = true;
            resolve(user || auth.currentUser || null);
        };
        let unsubscribe = null;
        try {
            unsubscribe = auth.onAuthStateChanged((user) => {
                if (typeof unsubscribe === 'function') unsubscribe();
                finish(user);
            }, () => finish(auth.currentUser || null));
        } catch {
            finish(auth.currentUser || null);
            return;
        }
        setTimeout(() => {
            if (typeof unsubscribe === 'function') unsubscribe();
            finish(auth.currentUser || null);
        }, 1200);
    });
}

async function ensureFirebaseSession() {
    if (typeof firebase === 'undefined' || !firebase.auth) return null;
    return waitForInitialAuthState();
}

async function loadUserProfileByUid(uid) {
    if (!db || !uid) return null;
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return null;
    return { id: snap.id, ...snap.data() };
}

async function validateStoreSession(profile) {
    if (!db || !profile || !profile.storeId || profile.role === 'super_admin') return profile;
    const snap = await db.collection('admin_stores').doc(profile.storeId).get();
    if (!snap.exists) throw new Error("Store account not found.");
    const store = snap.data() || {};
    const status = String(store.status || 'trial').toLowerCase();
    if (!['active', 'trial'].includes(status)) {
        throw new Error(`Store access is ${status}.`);
    }
    const today = new Date().toISOString().slice(0, 10);
    if (store.activeUntil && String(store.activeUntil) < today) {
        throw new Error("Store subscription has expired.");
    }
    return {
        ...profile,
        storeStatus: status,
        activeUntil: store.activeUntil || '',
        storeName: store.name || profile.storeName || ''
    };
}

async function syncSessionFromAuthUser(user) {
    if (!user) {
        clearAuthSessionState();
        return null;
    }
    const previousStoreId = currentStoreId();
    const basicProfile = {
        uid: user.uid,
        email: normalizeEmail(user.email),
        name: user.displayName || '',
        role: isSuperAdminEmail(user.email) ? 'super_admin' : 'staff',
        storeId: null
    };
    if (basicProfile.role !== 'super_admin') {
        const profile = await loadUserProfileByUid(user.uid);
        if (!profile) throw new Error("Your account is not provisioned yet.");
        basicProfile.name = profile.name || user.displayName || '';
        basicProfile.role = profile.role || 'staff';
        basicProfile.storeId = profile.storeId || null;
        basicProfile.storeName = profile.storeName || '';
        basicProfile.status = profile.status || 'active';
        if (!basicProfile.storeId) throw new Error("Your account is missing a store assignment.");
        if (basicProfile.status && String(basicProfile.status).toLowerCase() !== 'active') {
            throw new Error(`Your account is ${basicProfile.status}.`);
        }
        const validated = await validateStoreSession(basicProfile);
        basicProfile.storeName = validated.storeName || basicProfile.storeName || '';
    }

    const nextStoreId = basicProfile.storeId || null;
    clearActiveStoreRuntimeMirror();
    stopStoreRealtimeSync();

    if (nextStoreId) {
        localStorage.setItem('optixStoreId', nextStoreId);
        sessionStorage.setItem('optixStoreId', nextStoreId);
    } else {
        localStorage.removeItem('optixStoreId');
        sessionStorage.removeItem('optixStoreId');
    }
    localStorage.setItem('optixLoggedIn', 'true');
    sessionStorage.setItem('optixLoggedIn', 'true');
    localStorage.setItem('optixSessionStart', new Date().toISOString());
    setStoredUserProfile(basicProfile);
    return basicProfile;
}

function initAuthGatekeeper() {
    if (typeof firebase === 'undefined' || !firebase.auth) {
        enforceAccessGate(false);
        return;
    }
    try {
        firebase.auth().onAuthStateChanged(async (user) => {
            if (!user) {
                clearAuthSessionState();
                enforceAccessGate(false);
                return;
            }
            try {
                await syncSessionFromAuthUser(user);
                enforceAccessGate(true);
            } catch (err) {
                console.error("Session bootstrap failed:", err);
                clearAuthSessionState();
                if (!publicPages.includes(page) && page !== "") {
                    window.location.href = 'login.html';
                    return;
                }
                enforceAccessGate(false);
            }
        });
    } catch (err) {
        console.error("Auth gate init failed:", err);
        enforceAccessGate(false);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    initFirebaseServices();
    initAuthGatekeeper();
    startCloudSyncStatusLoop();
    initCloudSync().then(async () => {
        await hydrateEssentialEntityDocs();
        await ensureProductsCache();
        applySettings();
        ensureSettingsModal();
        bindSettingsIcon();
        if(document.getElementById('rxDate')) {
            initPrescriptionDate();
            bindPrescriptionCalcs();
        }
        // 1. Initial Checks for Order Page
        if(document.getElementById('billTableBody')) {
            await initOrderPage();
        } else {
            initOrderDateInputs();
        }
        
        // Auto-add first row if on Order Page
        // 2. Page Loaders - CHECK AND RUN ALL
        if(document.getElementById('dash-total-sales')) loadDashboard();
        if(document.getElementById('productListBody')) loadProducts();
        if(document.getElementById('inventoryListBody')) loadInventory();
        if(document.getElementById('ledgerTable')) loadAccounts();
        if(document.getElementById('salesHistoryBody')) loadSalesHistory();
        
        // NEW LOADERS ADDED
        if(document.getElementById('staffList')) loadStaff();
        if(document.getElementById('stockTable')) loadStock();
        if(document.getElementById('customerTable')) loadCustomers();
        if(document.getElementById('expenseList')) loadExpenses();
        if(document.getElementById('settingsPage')) initSettingsPage();
    }).catch((err) => {
        console.error("App init failed:", err);
        applySettings();
        ensureSettingsModal();
        bindSettingsIcon();
        updateCloudSyncStatus();
    });
});

function initFirebaseServices() {
    try {
        if (typeof firebase === 'undefined') {
            console.warn('Firebase SDK not loaded on this page.');
            return;
        }
        if (!firebase.apps || firebase.apps.length === 0) {
            firebase.initializeApp(firebaseConfig);
        }
        db = firebase.firestore();
        window.db = db;
        if (firebase.auth) window.auth = firebase.auth();
    } catch (err) {
        console.error('Firebase init failed:', err);
    }
}

// --- SETTINGS & AUTH ---
const FIREBASE_PROJECT_ID = 'optixweb-68694';
const DEFAULT_CLOUD_SYNC_URL = `https://${'{'}FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com/optixSync.json`;
const CLOUD_SYNC_EXCLUDE_KEYS = ['optixLoggedIn', 'optixSessionStart', 'tempCustName', 'tempCustPhone'];
const FIRESTORE_STATE_EXCLUDE_KEYS = ['optixProducts'];
const OPTIX_BACKUP_PREFIX = '__optix_backup__:';
const DEFAULT_STORE_STATE_KEYS = ['optixInvoiceSeq', 'optixRx'];
const optixMemoryStore = Object.create(null);
const ENTITY_DOC_COLLECTIONS = {
    optixOrders: 'orders_state',
    optixCustomers: 'customers_state',
    optixExpenses: 'expenses_state',
    optixStaff: 'staff_state',
    optixPrescriptions: 'prescriptions_state',
    optixSettings: 'settings_state'
};
const ENTITY_ARRAY_KEYS = ['optixOrders', 'optixCustomers', 'optixExpenses', 'optixPrescriptions'];
const CLOUD_PRIMARY_KEYS = new Set([
    'optixProducts',
    'optixOrders',
    'optixCustomers',
    'optixExpenses',
    'optixStaff',
    'optixPrescriptions',
    'optixRx'
]);
const COLLECTION_SYNC_CONFIG = {
    optixOrders: { collection: 'orders', legacyCollection: 'orders_state' },
    optixCustomers: { collection: 'customers', legacyCollection: 'customers_state' },
    optixExpenses: { collection: 'expenses', legacyCollection: 'expenses_state' },
    optixStaff: { collection: 'staff', legacyCollection: 'staff_state' },
    optixPrescriptions: { collection: 'prescriptions', legacyCollection: 'prescriptions_state' }
};
const COLLECTION_SYNC_KEYS = new Set(Object.keys(COLLECTION_SYNC_CONFIG));
let entityViewRefreshTimer = null;
const pendingEntityViewRefreshKeys = new Set();
const collectionRealtimeUnsubs = Object.create(null);
const entityDocRealtimeUnsubs = Object.create(null);

function branchNameToStoreId(name) {
    const raw = String(name || '').trim().toLowerCase();
    if (!raw) return 'default';
    const slug = raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return slug || 'default';
}

function getLoginBranchId() {
    const branchName = getSettings().branchName || 'Main Branch';
    return branchNameToStoreId(branchName);
}

function isCollectionBackedKey(key) {
    return COLLECTION_SYNC_KEYS.has(key);
}

function shouldMirrorThroughSnapshot(key) {
    return !isCollectionBackedKey(key) && key !== 'optixProducts';
}

function shouldPersistOptixKey(key) {
    return isOptixKey(key) && !CLOUD_PRIMARY_KEYS.has(key);
}

function isStoreScopedCollectionKey(key) {
    return key === 'optixProducts' || isCollectionBackedKey(key);
}

function isStoreScopedStateKey(key) {
    return key === 'optixSettings' || DEFAULT_STORE_STATE_KEYS.includes(key);
}

function isStoreScopedKey(key) {
    return isStoreScopedCollectionKey(key) || isStoreScopedStateKey(key);
}

function getStoreScopeId(storeId = null) {
    return String(storeId || currentStoreId() || 'global');
}

function getOptixBackupKey(key, storeId = null) {
    return `${OPTIX_BACKUP_PREFIX}${getStoreScopeId(storeId)}:${key}`;
}

function sanitizeStoreScopedCollectionValue(key, value, storeId = null) {
    const raw = typeof value === 'string'
        ? value
        : value == null
            ? '[]'
            : JSON.stringify(value);
    const targetStoreId = storeId || currentStoreId();
    if (!targetStoreId) return raw;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return raw;
        const scoped = parsed.map((item) => {
            if (!item || typeof item !== 'object') return null;
            const itemStoreId = item.storeId ? String(item.storeId) : targetStoreId;
            if (itemStoreId !== targetStoreId) return null;
            return { ...item, storeId: itemStoreId };
        }).filter(Boolean);
        return JSON.stringify(scoped);
    } catch {
        return raw;
    }
}

function readPersistedOptixBackup(key, storeId = null) {
    try {
        return Storage.prototype.getItem.call(window.localStorage, getOptixBackupKey(key, storeId));
    } catch {
        return null;
    }
}

function writePersistedOptixBackup(key, value, storeId = null) {
    try {
        Storage.prototype.setItem.call(window.localStorage, getOptixBackupKey(key, storeId), String(value));
    } catch (err) {
        console.error(`Backup persist failed for ${key}:`, err);
    }
}

function removePersistedOptixBackup(key, storeId = null) {
    try {
        Storage.prototype.removeItem.call(window.localStorage, getOptixBackupKey(key, storeId));
    } catch (err) {
        console.error(`Backup removal failed for ${key}:`, err);
    }
}

function clearPersistedOptixBackups(storeId = null) {
    try {
        const keysToRemove = [];
        const scopePrefix = storeId ? `${OPTIX_BACKUP_PREFIX}${getStoreScopeId(storeId)}:` : OPTIX_BACKUP_PREFIX;
        for (let i = 0; i < window.localStorage.length; i++) {
            const key = Storage.prototype.key.call(window.localStorage, i);
            if (typeof key === 'string' && key.startsWith(scopePrefix)) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach((key) => Storage.prototype.removeItem.call(window.localStorage, key));
    } catch (err) {
        console.error('Failed to clear local Optix backups:', err);
    }
}

function readStoreScopedOptixValue(key, fallbackValue = null) {
    if (!isStoreScopedKey(key)) return fallbackValue;
    const storeId = currentStoreId();
    if (!storeId) {
        return isStoreScopedCollectionKey(key)
            ? sanitizeStoreScopedCollectionValue(key, fallbackValue, null)
            : fallbackValue;
    }
    const scopedBackup = readPersistedOptixBackup(key, storeId);
    if (scopedBackup !== null) {
        return isStoreScopedCollectionKey(key)
            ? sanitizeStoreScopedCollectionValue(key, scopedBackup, storeId)
            : scopedBackup;
    }
    if (isStoreScopedCollectionKey(key)) {
        return sanitizeStoreScopedCollectionValue(key, fallbackValue, storeId);
    }
    return null;
}

function clearActiveStoreRuntimeMirror() {
    const scopedKeys = [
        'optixProducts',
        'optixOrders',
        'optixCustomers',
        'optixExpenses',
        'optixStaff',
        'optixPrescriptions',
        'optixRx',
        'optixSettings',
        'optixInvoiceSeq'
    ];
    scopedKeys.forEach((key) => {
        delete optixMemoryStore[key];
        try {
            Storage.prototype.removeItem.call(window.localStorage, key);
        } catch {}
    });
    sessionStorage.removeItem('optixOrdersSnapshot');
}

function stopStoreRealtimeSync() {
    Object.keys(collectionRealtimeUnsubs).forEach((subscriptionKey) => {
        const unsub = collectionRealtimeUnsubs[subscriptionKey];
        if (typeof unsub === 'function') {
            try { unsub(); } catch {}
        }
        delete collectionRealtimeUnsubs[subscriptionKey];
    });
    Object.keys(entityDocRealtimeUnsubs).forEach((subscriptionKey) => {
        const unsub = entityDocRealtimeUnsubs[subscriptionKey];
        if (typeof unsub === 'function') {
            try { unsub(); } catch {}
        }
        delete entityDocRealtimeUnsubs[subscriptionKey];
    });
    if (typeof productsRealtimeUnsub === 'function') {
        try { productsRealtimeUnsub(); } catch {}
    }
    productsRealtimeUnsub = null;
    productsRealtimeStoreId = null;
    productsRealtimeSubscribed = false;
    window.__optixEntityDocsSubscribed = false;
}

function getStoreScopedEntityDocId(key) {
    if (isCollectionBackedKey(key)) return 'main';
    return getStoreScopeId(getCollectionStoreId());
}

function getStoreScopedStateDocId(key) {
    return `${getStoreScopeId(getCollectionStoreId())}__${key}`;
}

function getKnownStoreStateKeys() {
    const discovered = Object.keys(optixMemoryStore).filter((key) => shouldSyncFirestoreStateKey(key));
    return Array.from(new Set([...DEFAULT_STORE_STATE_KEYS, ...discovered]));
}

function clearStoreScopedRuntimeCache(storeId = null) {
    const scopedKeys = [
        'optixProducts',
        'optixOrders',
        'optixCustomers',
        'optixExpenses',
        'optixStaff',
        'optixPrescriptions',
        'optixRx',
        'optixSettings',
        'optixInvoiceSeq'
    ];
    scopedKeys.forEach((key) => {
        delete optixMemoryStore[key];
        if (shouldPersistOptixKey(key)) {
            try {
                Storage.prototype.removeItem.call(window.localStorage, key);
            } catch {}
        }
        removePersistedOptixBackup(key, storeId);
    });
    sessionStorage.removeItem('optixOrdersSnapshot');
}

function getCollectionConfig(key) {
    return COLLECTION_SYNC_CONFIG[key] || null;
}

function getCollectionStoreId() {
    return currentStoreId() || getLoginBranchId();
}

function getCollectionQuery(key) {
    if (!db) return null;
    const config = getCollectionConfig(key);
    const storeId = getCollectionStoreId();
    if (!config || !storeId) return null;
    return db.collection(config.collection).where('storeId', '==', storeId);
}

function getEntityId(key, item) {
    if (!item || typeof item !== 'object') return null;
    if (key === 'optixCustomers') return String(item.id || item.phone || '').trim() || null;
    if (key === 'optixExpenses') return String(item.id || '').trim() || null;
    if (key === 'optixPrescriptions') return String(item.id || '').trim() || null;
    if (key === 'optixStaff') return String(item.id || '').trim() || null;
    return String(item.id || '').trim() || null;
}

function normalizeEntityForCloud(key, item) {
    const normalized = JSON.parse(JSON.stringify(item || {}));
    const storeId = getCollectionStoreId();
    const entityId = getEntityId(key, normalized) || String(Date.now());
    normalized.id = normalized.id || entityId;
    normalized.storeId = normalized.storeId || storeId;
    delete normalized._docId;
    return normalized;
}

function sortCollectionItems(key, items) {
    const list = Array.isArray(items) ? [...items] : [];
    const toDateValue = (value) => {
        const time = value ? new Date(value).getTime() : NaN;
        return Number.isNaN(time) ? 0 : time;
    };
    return list.sort((a, b) => {
        if (key === 'optixOrders' || key === 'optixExpenses' || key === 'optixPrescriptions' || key === 'optixStaff') {
            const byDate = toDateValue(a.updatedAt || a.date || a.rxDate || a.joined) - toDateValue(b.updatedAt || b.date || b.rxDate || b.joined);
            if (byDate !== 0) return byDate;
        }
        const aId = parseInt(getEntityId(key, a), 10);
        const bId = parseInt(getEntityId(key, b), 10);
        if (!Number.isNaN(aId) && !Number.isNaN(bId) && aId !== bId) return aId - bId;
        return String(getEntityId(key, a) || '').localeCompare(String(getEntityId(key, b) || ''));
    });
}

function setEntityArrayCache(key, items) {
    const sorted = sortCollectionItems(key, items);
    localStorage.setItem(key, JSON.stringify(sorted));
    scheduleEntityViewRefresh(key);
    return sorted;
}

function upsertEntityInCache(key, item) {
    const list = JSON.parse(localStorage.getItem(key)) || [];
    const entityId = getEntityId(key, item);
    const next = Array.isArray(list) ? [...list] : [];
    const idx = next.findIndex((entry) => getEntityId(key, entry) === entityId);
    if (idx > -1) {
        next[idx] = { ...next[idx], ...item };
    } else {
        next.push(item);
    }
    return setEntityArrayCache(key, next);
}

function removeEntityFromCache(key, entityId) {
    const list = JSON.parse(localStorage.getItem(key)) || [];
    const next = (Array.isArray(list) ? list : []).filter((entry) => getEntityId(key, entry) !== String(entityId));
    return setEntityArrayCache(key, next);
}

async function ensureProductDocId(product) {
    if (!db || !product) return null;
    if (product._docId) return product._docId;
    const storeId = getCollectionStoreId();
    if (!storeId || !product.code) return null;
    const snap = await db.collection('products')
        .where('storeId', '==', storeId)
        .where('code', '==', product.code)
        .limit(1)
        .get();
    if (snap.empty) return null;
    return snap.docs[0].id;
}

async function syncChangedProductsToCloud(previousProducts, nextProducts) {
    if (!db) return;
    const changed = [];
    const previousByCode = new Map((Array.isArray(previousProducts) ? previousProducts : []).map((item) => [item.code, item]));
    (Array.isArray(nextProducts) ? nextProducts : []).forEach((product) => {
        const before = previousByCode.get(product.code);
        if (!before) return;
        if ((parseFloat(before.qty) || 0) !== (parseFloat(product.qty) || 0) || String(before.status || '') !== String(product.status || '')) {
            changed.push(product);
        }
    });
    if (!changed.length) return;

    const batch = db.batch();
    for (const product of changed) {
        const docId = await ensureProductDocId(product);
        if (!docId) continue;
        const { _docId, ...payload } = product;
        batch.set(db.collection('products').doc(docId), payload, { merge: true });
    }
    await batch.commit();
}

async function upsertEntityToCloud(key, item) {
    if (!db || !isCollectionBackedKey(key)) return item;
    const config = getCollectionConfig(key);
    const normalized = normalizeEntityForCloud(key, item);
    const docId = getEntityId(key, normalized);
    await db.collection(config.collection).doc(String(docId)).set({
        ...normalized,
        updatedAt: new Date().toISOString()
    }, { merge: true });
    return { ...normalized, _docId: String(docId) };
}

async function deleteEntityFromCloud(key, entityId) {
    if (!db || !isCollectionBackedKey(key)) return;
    const config = getCollectionConfig(key);
    if (!config || !entityId) return;
    await db.collection(config.collection).doc(String(entityId)).delete();
}

async function readLegacyEntityArray(key) {
    const current = JSON.parse(localStorage.getItem(key) || '[]');
    if (Array.isArray(current) && current.length) return current;
    if (!db) return [];
    const config = getCollectionConfig(key);
    const legacyCollection = config ? config.legacyCollection : ENTITY_DOC_COLLECTIONS[key];
    if (!legacyCollection) return [];
    try {
        const snap = await db.collection(legacyCollection).doc(getStoreScopedEntityDocId(key)).get();
        if (!snap.exists) return [];
        const data = snap.data() || {};
        if (typeof data.value !== 'string' || !data.value.trim()) return [];
        const parsed = JSON.parse(data.value);
        if (!Array.isArray(parsed)) return [];
        const targetStoreId = getCollectionStoreId();
        const allowUnscopedLegacy = !targetStoreId || targetStoreId === 'default';
        return parsed.filter((item) => {
            if (!item || typeof item !== 'object') return false;
            const itemStoreId = item.storeId ? String(item.storeId) : '';
            if (itemStoreId) return itemStoreId === targetStoreId;
            return allowUnscopedLegacy;
        });
    } catch (err) {
        console.error(`Legacy read failed for ${key}:`, err);
        return [];
    }
}

async function migrateLegacyCollectionData(key) {
    if (!db || !isCollectionBackedKey(key)) return;
    const query = getCollectionQuery(key);
    const config = getCollectionConfig(key);
    if (!query || !config) return;
    const targetStoreId = getCollectionStoreId();
    if (targetStoreId && targetStoreId !== 'default') {
        return;
    }
    const existing = await query.limit(1).get();
    if (!existing.empty) return;

    const legacyItems = await readLegacyEntityArray(key);
    if (!legacyItems.length) return;

    const batch = db.batch();
    legacyItems.forEach((item) => {
        const normalized = normalizeEntityForCloud(key, item);
        const docId = getEntityId(key, normalized);
        batch.set(db.collection(config.collection).doc(String(docId)), {
            ...normalized,
            updatedAt: normalized.updatedAt || normalized.date || normalized.rxDate || new Date().toISOString()
        }, { merge: true });
    });
    await batch.commit();
}

async function loadCollectionEntitiesFromCloud(key) {
    const query = getCollectionQuery(key);
    if (!query) return [];
    const snapshot = await query.get();
    const items = [];
    snapshot.forEach((doc) => {
        items.push({ ...doc.data(), _docId: doc.id });
    });
    setEntityArrayCache(key, items);
    firestoreOnline = true;
    firestoreLastError = "";
    return items;
}

function subscribeCollectionRealtime(key) {
    if (!db || !isCollectionBackedKey(key)) return;
    const storeId = getCollectionStoreId();
    const config = getCollectionConfig(key);
    if (!storeId || !config) return;
    const subscriptionKey = `${key}:${storeId}`;
    if (collectionRealtimeUnsubs[subscriptionKey]) return;

    const query = db.collection(config.collection).where('storeId', '==', storeId);
    collectionRealtimeUnsubs[subscriptionKey] = query.onSnapshot((snapshot) => {
        const items = [];
        snapshot.forEach((doc) => {
            items.push({ ...doc.data(), _docId: doc.id });
        });
        setEntityArrayCache(key, items);
        firestoreOnline = true;
        firestoreLastError = "";
    }, (err) => {
        console.error(`Realtime collection sync failed for ${key}:`, err);
        firestoreOnline = false;
        firestoreLastError = (err && err.message) ? err.message : String(err);
    });
}

async function initCollectionRealtimeSync() {
    if (!db) return;
    for (const key of Object.keys(COLLECTION_SYNC_CONFIG)) {
        await migrateLegacyCollectionData(key);
        await loadCollectionEntitiesFromCloud(key);
        subscribeCollectionRealtime(key);
    }
}

function flushEntityViewRefresh() {
    entityViewRefreshTimer = null;
    if (pendingEntityViewRefreshKeys.size === 0) return;

    const changedKeys = new Set(pendingEntityViewRefreshKeys);
    pendingEntityViewRefreshKeys.clear();

    const ordersChanged = changedKeys.has('optixOrders');
    const customersChanged = changedKeys.has('optixCustomers');
    const expensesChanged = changedKeys.has('optixExpenses');
    const staffChanged = changedKeys.has('optixStaff');
    const prescriptionsChanged = changedKeys.has('optixPrescriptions');
    const productsChanged = changedKeys.has('optixProducts');
    const dashboardChanged = ordersChanged || customersChanged || expensesChanged || prescriptionsChanged;

    if (dashboardChanged && document.getElementById('dash-total-sales') && typeof loadDashboard === 'function') {
        loadDashboard();
    }
    if (productsChanged && typeof refreshProductDrivenViews === 'function') {
        refreshProductDrivenViews();
    }
    if (ordersChanged) {
        if (document.getElementById('pendingTableBody') && typeof loadPendingOrders === 'function') loadPendingOrders();
        if ((document.getElementById('historyTableBody') || document.getElementById('salesHistoryBody')) && typeof loadSalesHistory === 'function') loadSalesHistory();
        if (document.getElementById('ledgerTable') && typeof loadAccounts === 'function') loadAccounts();
        if (window.currentSalesView === 'statement' && typeof buildDailyStatement === 'function') buildDailyStatement();
    }
    if (customersChanged && document.getElementById('customerTable') && typeof loadCustomers === 'function') {
        loadCustomers();
    }
    if (expensesChanged && document.getElementById('expenseList') && typeof loadExpenses === 'function') {
        loadExpenses();
    }
    if (staffChanged && document.getElementById('staffList') && typeof loadStaff === 'function') {
        loadStaff();
    }
    if (prescriptionsChanged && document.getElementById('rxDatabaseBody') && typeof loadRxDatabase === 'function') {
        loadRxDatabase();
    }
}

function scheduleEntityViewRefresh(key) {
    if (!key || !isOptixKey(key)) return;
    pendingEntityViewRefreshKeys.add(key);
    if (entityViewRefreshTimer) clearTimeout(entityViewRefreshTimer);
    entityViewRefreshTimer = setTimeout(flushEntityViewRefresh, 120);
}

function shouldHydrateEntityArray(raw) {
    if (!raw) return true;
    const trimmed = raw.trim();
    if (!trimmed) return true;
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return parsed.length === 0;
        }
        return false;
    } catch {
        return true;
    }
}

async function hydrateEntityDocIfNeeded(key) {
    if (!db || !ENTITY_DOC_COLLECTIONS[key]) return;
    if (isCollectionBackedKey(key)) return;
    if (!shouldHydrateEntityArray(localStorage.getItem(key))) return;
    try {
        const snap = await db.collection(ENTITY_DOC_COLLECTIONS[key]).doc(getStoreScopedEntityDocId(key)).get();
        if (!snap.exists) return;
        const data = snap.data() || {};
        if (typeof data.value === 'string' && data.value.trim()) {
            localStorage.setItem(key, data.value);
        }
    } catch (err) {
        console.error(`Entity hydration failed for ${key}:`, err);
    }
}

async function hydrateEssentialEntityDocs() {
    if (!db) return;
    for (const key of ENTITY_ARRAY_KEYS) {
        await hydrateEntityDocIfNeeded(key);
    }
}
let cloudSyncTimer = null;
let cloudSyncBusy = false;
let cloudApplyMode = false;
let cloudSyncStatusTimer = null;
let firestoreStateApplyMode = false;
let firestoreStateSyncBusy = false;
let firestoreStateSyncTimer = null;
const firestoreStateQueue = new Map();
let entityDocApplyMode = false;
let entityDocSyncBusy = false;
let entityDocSyncTimer = null;
const entityDocQueue = new Map();
let firestoreOnline = false;
let firestoreLastError = "";
const PUBLIC_INVOICE_COLLECTION = 'public_invoices';
const PUBLIC_INVOICE_ORDER_COLLECTION = 'public_invoice_orders';

function getDefaultActionConfig() {
    return {
        sendWhatsapp: true,
        chatWhatsapp: true,
        confirmOrder: true,
        editOrder: true,
        paymentHistory: true,
        advanceReceipt: true,
        finalInvoice: true,
        viewRx: true,
        deleteOrder: true
    };
}

function getSettings() {
    const defaults = {
        loginRequired: true,
        showWhatsapp: true,
        stockCheck: true,
        autoInvoiceNo: true,
        enableDiscounts: true,
        cloudSyncEnabled: false,
        cloudSyncUrl: DEFAULT_CLOUD_SYNC_URL,
        cloudSyncToken: '',
        branchName: 'Cleandekho.com',
        dateFormat: 'DD/MM/YYYY',
        storeInvoiceName: '',
        storeAddress: '',
        storePhone: '',
        storeEmail: '',
        storeGst: '',
        storeLogoText: '',
        storeLogoSize: '150',
        storeLogoPlacement: 'left',
        actionsConfig: getDefaultActionConfig()
    };
    try {
        const raw = localStorage.getItem('optixSettings');
        const parsed = raw ? JSON.parse(raw) : {};
        return {
            ...defaults,
            ...parsed,
            actionsConfig: { ...getDefaultActionConfig(), ...(parsed.actionsConfig || {}) }
        };
    } catch (e) {
        return { ...defaults };
    }
}

function getStoreProfile(settings = null) {
    const s = settings || getSettings();
    const userProfile = getStoredUserProfile();
    const name = (s.storeInvoiceName || s.storeName || s.branchName || s.name || userProfile.storeName || 'OptixCrafter').trim() || 'OptixCrafter';
    return {
        storeName: name,
        name: name,
        address: (s.storeAddress || s.address || '').trim(),
        phone: (s.storePhone || s.phone || '').trim(),
        email: (s.storeEmail || s.email || '').trim(),
        gst: (s.storeGst || s.gst || '').trim(),
        logoText: (s.storeLogoText || s.logoText || '').trim()
    };
}

// STRICT PRIORITY FOR MULTIPLE STORE IDs:
// 1. Specific Settings (Invoice Name -> Store Name -> Branch Name)
// 2. Order Snapshot Fallback
// 3. Global User Profile Fallback
// 4. Ultimate Default
function mergeStoreProfileSources(settings, fallback) {
    const s = settings || {};
    const f = fallback || {};
    const userProfile = getStoredUserProfile();

    const pick = (...values) => {
        for (const value of values) {
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return '';
    };

    return {
        name: pick(
            s.storeInvoiceName,
            s.storeName,
            s.branchName,
            s.name,
            f.storeInvoiceName,
            f.storeName,
            f.branchName,
            f.name,
            userProfile.storeName,
            'OptixCrafter'
        ),
        address: pick(s.storeAddress, s.address, f.storeAddress, f.address),
        phone: pick(s.storePhone, s.phone, f.storePhone, f.phone),
        email: pick(s.storeEmail, s.email, f.storeEmail, f.email),
        gst: pick(s.storeGst, s.gst, f.storeGst, f.gst),
        logoText: pick(s.storeLogoText, s.logoText, f.storeLogoText, f.logoText),
        storeLogo: pick(s.storeLogo, f.storeLogo)
    };
}

function getStoreBadgeText(settings = null) {
    const profile = getStoreProfile(settings);
    const raw = profile.logoText || profile.name || 'OC';
    const parts = String(raw).trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase().slice(0, 3);
    }
    return String(raw).trim().slice(0, 3).toUpperCase() || 'OC';
}

function findOrderById(orderId) {
    const orders = JSON.parse(localStorage.getItem('optixOrders') || '[]');
    return orders.find((o) => String(o.id) === String(orderId)) || null;
}

function base64UrlEncodeJson(value) {
    try {
        const json = JSON.stringify(value);
        const bytes = new TextEncoder().encode(json);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    } catch (e) {
        console.error('Invoice payload encode failed:', e);
        return '';
    }
}

function generateInvoiceShareToken() {
    try {
        const bytes = new Uint8Array(18);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 16)}`;
    }
}

function buildInvoiceSharePayload(order, settings = null) {
    if (!order) return '';
    const storeProfile = mergeStoreProfileSources(settings, order.storeProfileSnapshot);
    const payload = {
        order,
        storeProfile
    };
    return base64UrlEncodeJson(payload);
}

function persistOrderShareMeta(order) {
    if (!order || !order.id) return;
    try {
        const orders = JSON.parse(localStorage.getItem('optixOrders') || '[]');
        const idx = orders.findIndex((item) => String(item.id) === String(order.id));
        if (idx === -1) return;
        orders[idx] = { ...orders[idx], shareToken: order.shareToken };
        const serialized = JSON.stringify(orders);
        localStorage.setItem('optixOrders', serialized);
        sessionStorage.setItem('optixOrdersSnapshot', serialized);
        if (typeof upsertEntityInCache === 'function') {
            upsertEntityInCache('optixOrders', orders[idx]);
        }
    } catch (e) {
        console.error('Persisting invoice share token failed:', e);
    }
}

async function savePublicInvoiceSnapshot(order, settings = null) {
    if (!db || !order || !order.id) return '';
    const shareToken = order.shareToken || generateInvoiceShareToken();
    const storeProfile = mergeStoreProfileSources(settings, order.storeProfileSnapshot);
    const payload = {
        token: shareToken,
        active: true,
        orderId: String(order.id),
        storeId: order.storeId || getCollectionStoreId() || currentStoreId() || 'default',
        storeProfile,
        order: { ...order, shareToken },
        updatedAt: new Date().toISOString()
    };
    const batch = db.batch();
    batch.set(db.collection(PUBLIC_INVOICE_COLLECTION).doc(shareToken), payload, { merge: true });
    batch.set(db.collection(PUBLIC_INVOICE_ORDER_COLLECTION).doc(String(order.id)), payload, { merge: true });
    await batch.commit();
    return shareToken;
}

async function ensureShareableInvoiceToken(order, settings = null) {
    if (!order || !order.id) return '';
    const shareToken = order.shareToken || generateInvoiceShareToken();
    if (!order.shareToken) {
        order.shareToken = shareToken;
        persistOrderShareMeta(order);
        if (db) {
            try {
                await upsertEntityToCloud('optixOrders', order);
            } catch (e) {
                console.error('Order share token sync failed:', e);
            }
        }
    }
    if (!db) return shareToken;
    await savePublicInvoiceSnapshot(order, settings);
    return shareToken;
}

async function resolveShareableInvoiceUrl(orderId, options = {}) {
    const order = options.order || findOrderById(orderId);
    if (!order) return buildInvoiceUrl(orderId, options);
    const settings = options.settings || getSettings();
    if (db) {
        try {
            const shareToken = await ensureShareableInvoiceToken(order, settings);
            if (shareToken) {
                return buildInvoiceUrl(orderId, { ...options, order, token: shareToken, settings });
            }
        } catch (e) {
            console.error('Invoice share URL generation failed:', e);
        }
    }
    return buildInvoiceUrl(orderId, { ...options, order, includePayload: true, settings });
}

function buildInvoiceUrl(orderId, options = {}) {
    const params = new URLSearchParams();
    params.set('orderId', String(orderId));
    if (options.type) params.set('type', String(options.type));
    if (options.mode) params.set('mode', String(options.mode));
    const token = options.token || (options.order && options.order.shareToken) || '';
    if (token) params.set('token', String(token));
    const payload = (options.includePayload || !!options.order)
        ? buildInvoiceSharePayload(options.order, options.settings)
        : '';
    if (payload) params.set('payload', payload);
    const storeId = options.storeId || (options.order && options.order.storeId) || '';
    if (storeId) params.set('storeId', String(storeId));
    return `invoice.html?${params.toString()}`;
}

async function saveSettings(settings) {
    const serialized = JSON.stringify(settings);
    localStorage.setItem('optixSettings', serialized);
    if (!db) return false;
    await flushEntityDocQueue();
    return true;
}

async function checkCloudConnection() {
    try {
        if (!db) {
            alert("Cloud not connected: Firebase Firestore is not initialized.");
            return;
        }
        const ref = db.collection('app_state').doc('__healthcheck');
        await ref.set({
            pingAt: firebase.firestore.FieldValue.serverTimestamp(),
            clientAt: new Date().toISOString()
        }, { merge: true });
        const snap = await ref.get();
        if (!snap.exists) throw new Error("Healthcheck document missing after write.");
        firestoreOnline = true;
        firestoreLastError = "";
        alert("Cloud connected successfully (Firestore read/write OK).");
    } catch (err) {
        firestoreOnline = false;
        firestoreLastError = (err && err.message) ? err.message : String(err);
        alert("Cloud connection failed: " + firestoreLastError);
    }
}

function shouldSyncKey(key) {
    return typeof key === 'string'
        && key.startsWith('optix')
        && !CLOUD_SYNC_EXCLUDE_KEYS.includes(key)
        && shouldMirrorThroughSnapshot(key);
}

function isOptixKey(key) {
    return typeof key === 'string' && key.startsWith('optix');
}

function shouldSyncFirestoreStateKey(key) {
    return shouldSyncKey(key)
        && !FIRESTORE_STATE_EXCLUDE_KEYS.includes(key)
        && !ENTITY_DOC_COLLECTIONS[key];
}

function getCloudSyncConfig() {
    const s = getSettings();
    const rawUrl = (s.cloudSyncUrl || '').trim();
    let normalizedUrl = rawUrl;
    if (rawUrl && rawUrl.includes('firebaseio.com')) {
        const trimmed = rawUrl.replace(/\/+$/, '');
        normalizedUrl = trimmed.endsWith('.json') ? trimmed : `${trimmed}/optixSync.json`;
    }
    return {
        enabled: !!s.cloudSyncEnabled,
        url: normalizedUrl,
        token: (s.cloudSyncToken || '').trim()
    };
}

function describeCloudSyncState() {
    const config = getCloudSyncConfig();
    if (!config.enabled || !config.url) {
        return { text: 'Cloud sync disabled', state: 'disabled', url: config.url };
    }
    if (cloudSyncBusy || cloudApplyMode) {
        return { text: 'Cloud syncing…', state: 'syncing', url: config.url };
    }
    if (!firestoreOnline) {
        return { text: 'Cloud sync offline', state: 'offline', url: config.url };
    }
    return { text: 'Cloud sync online', state: 'online', url: config.url };
}

function updateCloudSyncStatus() {
    const status = describeCloudSyncState();
    document.querySelectorAll('.cloud-sync-pill').forEach(el => {
        el.innerText = status.text;
        el.setAttribute('data-state', status.state);
    });
    const settingsStatus = document.getElementById('settings-cloud-sync-status');
    if (settingsStatus) {
        settingsStatus.innerText = status.text;
        settingsStatus.dataset.state = status.state;
    }
    const urlText = document.getElementById('settings-cloud-sync-url');
    if (urlText) {
        urlText.innerText = status.url || 'Not set';
    }
}

function startCloudSyncStatusLoop() {
    updateCloudSyncStatus();
    if (!cloudSyncStatusTimer) {
        cloudSyncStatusTimer = setInterval(updateCloudSyncStatus, 2500);
    }
}

function getCloudHeaders(token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

function buildSyncSnapshot() {
    const data = {};
    Object.keys(optixMemoryStore).forEach((key) => {
        if (shouldSyncKey(key)) data[key] = optixMemoryStore[key];
    });
    return data;
}

async function pushCloudSnapshot(reason = 'auto') {
    const cfg = getCloudSyncConfig();
    if (!cfg.enabled || !cfg.url || cloudApplyMode) return false;
    try {
        const payload = {
            meta: {
                app: 'optixcrafter',
                reason: reason,
                updatedAt: new Date().toISOString()
            },
            data: buildSyncSnapshot()
        };
        const res = await fetch(cfg.url, {
            method: 'PUT',
            headers: getCloudHeaders(cfg.token),
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`Cloud push failed (${res.status})`);
        return true;
    } catch (err) {
        console.error(err);
        if (reason === 'manual') alert("Cloud sync failed. Check URL/token and internet.");
        return false;
    }
}

async function pullCloudSnapshot(showAlerts = false) {
    const cfg = getCloudSyncConfig();
    if (!cfg.enabled || !cfg.url) {
        if (showAlerts) alert("Enable cloud sync and set a cloud URL first.");
        return false;
    }
    try {
        const res = await fetch(cfg.url, {
            method: 'GET',
            headers: getCloudHeaders(cfg.token)
        });
        if (!res.ok) throw new Error(`Cloud fetch failed (${res.status})`);
        const snapshot = await res.json();
        const payloadData = snapshot && snapshot.data ? snapshot.data : snapshot;
        if (!payloadData || typeof payloadData !== 'object') {
            if (showAlerts) alert("No cloud data found yet.");
            return false;
        }
        cloudApplyMode = true;
        Object.keys(payloadData).forEach((key) => {
            if (shouldSyncKey(key)) {
                localStorage.setItem(key, payloadData[key]);
            }
        });
        cloudApplyMode = false;
        if (showAlerts) alert("Cloud data pulled successfully. Reloading...");
        return true;
    } catch (err) {
        cloudApplyMode = false;
        console.error(err);
        if (showAlerts) alert("Cloud pull failed. Check URL/token and internet.");
        return false;
    }
}

async function syncNowToCloud() {
    let okFirestore = false;
    let okRtdb = false;
    try {
        if (db) {
            await flushEntityDocQueue();
            await flushFirestoreStateQueue();
            okFirestore = true;
        }
    } catch (err) {
        console.error("Manual Firestore sync failed:", err);
    }
    // Use non-manual reason to avoid false-negative alert when RTDB is optional.
    okRtdb = await pushCloudSnapshot('auto');
    if (okFirestore || okRtdb) {
        alert("Cloud sync complete.");
    } else {
        alert("Cloud sync failed. Check Firebase rules/internet.");
    }
}

async function pullNowFromCloud() {
    let okFirestore = false;
    let okRtdb = false;
    try {
        if (db) {
            await initCollectionRealtimeSync();
            await pullEntityDocs();
            await pullFirestoreState();
            okFirestore = true;
        }
    } catch (err) {
        console.error("Manual Firestore pull failed:", err);
    }
    // RTDB pull is optional fallback; keep user alert if both fail.
    okRtdb = await pullCloudSnapshot(false);
    if (okFirestore || okRtdb) {
        alert("Cloud data pulled successfully. Reloading...");
        location.reload();
    } else {
        alert("Cloud pull failed. Check Firebase rules/internet.");
    }
}

function scheduleCloudSync() {
    const cfg = getCloudSyncConfig();
    if (!cfg.enabled || !cfg.url || cloudApplyMode || cloudSyncBusy) return;
    if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(async () => {
        cloudSyncBusy = true;
        await pushCloudSnapshot('auto');
        cloudSyncBusy = false;
    }, 1200);
}

function queueFirestoreStateSync(key, value, isDelete = false) {
    if (!db || firestoreStateApplyMode || !shouldSyncFirestoreStateKey(key)) return;
    firestoreStateQueue.set(key, { key, value, isDelete });
    if (firestoreStateSyncTimer) clearTimeout(firestoreStateSyncTimer);
    firestoreStateSyncTimer = setTimeout(async () => {
        await flushFirestoreStateQueue();
    }, 900);
}

async function flushFirestoreStateQueue() {
    if (!db || firestoreStateApplyMode || firestoreStateSyncBusy) return;
    if (firestoreStateQueue.size === 0) return;
    firestoreStateSyncBusy = true;
    try {
        const batch = db.batch();
        firestoreStateQueue.forEach((item) => {
            const ref = db.collection('app_state').doc(getStoreScopedStateDocId(item.key));
            if (item.isDelete) {
                batch.delete(ref);
            } else {
                batch.set(ref, {
                    value: item.value,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            }
        });
        firestoreStateQueue.clear();
        await batch.commit();
        firestoreOnline = true;
        firestoreLastError = "";
    } catch (err) {
        console.error('Firestore state sync failed:', err);
        firestoreOnline = false;
        firestoreLastError = (err && err.message) ? err.message : String(err);
    } finally {
        firestoreStateSyncBusy = false;
    }
}

function queueEntityDocSync(key, value, isDelete = false) {
    if (!db || entityDocApplyMode || !ENTITY_DOC_COLLECTIONS[key] || isCollectionBackedKey(key)) return;
    entityDocQueue.set(key, { key, value, isDelete });
    if (entityDocSyncTimer) clearTimeout(entityDocSyncTimer);
    entityDocSyncTimer = setTimeout(async () => {
        await flushEntityDocQueue();
    }, 600);
}

async function flushEntityDocQueue() {
    if (!db || entityDocApplyMode || entityDocSyncBusy) return;
    if (entityDocQueue.size === 0) return;
    entityDocSyncBusy = true;
    try {
        const batch = db.batch();
        entityDocQueue.forEach((item) => {
            const collection = ENTITY_DOC_COLLECTIONS[item.key];
            if (!collection) return;
            const ref = db.collection(collection).doc(getStoreScopedEntityDocId(item.key));
            batch.set(ref, {
                value: item.isDelete ? null : item.value,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });
        entityDocQueue.clear();
        await batch.commit();
        firestoreOnline = true;
        firestoreLastError = "";
    } catch (err) {
        console.error('Entity doc sync failed:', err);
        firestoreOnline = false;
        firestoreLastError = (err && err.message) ? err.message : String(err);
    } finally {
        entityDocSyncBusy = false;
    }
}

async function pullEntityDocs() {
    if (!db) return;
    try {
        entityDocApplyMode = true;
        const keys = Object.keys(ENTITY_DOC_COLLECTIONS).filter((key) => !isCollectionBackedKey(key));
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const collection = ENTITY_DOC_COLLECTIONS[key];
            const snap = await db.collection(collection).doc(getStoreScopedEntityDocId(key)).get();
            if (!snap.exists) continue;
            const data = snap.data() || {};
            if (typeof data.value === 'string') {
                localStorage.setItem(key, data.value);
                scheduleEntityViewRefresh(key);
            }
        }
        firestoreOnline = true;
        firestoreLastError = "";
    } catch (err) {
        console.error('Entity doc pull failed:', err);
        firestoreOnline = false;
        firestoreLastError = (err && err.message) ? err.message : String(err);
    } finally {
        entityDocApplyMode = false;
    }
}

function subscribeEntityDocsRealtime() {
    if (!db) return;
    Object.keys(ENTITY_DOC_COLLECTIONS).filter((key) => !isCollectionBackedKey(key)).forEach((key) => {
        const collection = ENTITY_DOC_COLLECTIONS[key];
        const subscriptionKey = `${key}:${getStoreScopedEntityDocId(key)}`;
        Object.keys(entityDocRealtimeUnsubs).forEach((existingKey) => {
            if (!existingKey.startsWith(`${key}:`) || existingKey === subscriptionKey) return;
            const unsub = entityDocRealtimeUnsubs[existingKey];
            if (typeof unsub === 'function') {
                try { unsub(); } catch {}
            }
            delete entityDocRealtimeUnsubs[existingKey];
        });
        if (entityDocRealtimeUnsubs[subscriptionKey]) return;
        entityDocRealtimeUnsubs[subscriptionKey] = db.collection(collection).doc(getStoreScopedEntityDocId(key)).onSnapshot((snap) => {
            const data = snap.exists ? (snap.data() || {}) : {};
            if (typeof data.value !== 'string') return;
            entityDocApplyMode = true;
            localStorage.setItem(key, data.value);
            entityDocApplyMode = false;
            scheduleEntityViewRefresh(key);
        }, (err) => {
            console.error(`Realtime sync failed for ${key}:`, err);
        });
    });
    window.__optixEntityDocsSubscribed = Object.keys(entityDocRealtimeUnsubs).length > 0;
}

async function seedFirestoreStateFromLocal() {
    if (!db) return;
    const batch = db.batch();
    let hasData = false;
    getKnownStoreStateKeys().forEach((key) => {
        if (!shouldSyncFirestoreStateKey(key)) return;
        const value = optixMemoryStore[key];
        if (typeof value !== 'string') return;
        hasData = true;
        const ref = db.collection('app_state').doc(getStoreScopedStateDocId(key));
        batch.set(ref, {
            value: value,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    });
    if (hasData) await batch.commit();
}

async function pullFirestoreState() {
    if (!db) return;
    try {
        firestoreStateApplyMode = true;
        const stateKeys = getKnownStoreStateKeys().filter((key) => shouldSyncFirestoreStateKey(key));
        let foundAny = false;
        for (const key of stateKeys) {
            const snap = await db.collection('app_state').doc(getStoreScopedStateDocId(key)).get();
            if (!snap.exists) continue;
            foundAny = true;
            const data = snap.data() || {};
            if (typeof data.value === 'string') {
                localStorage.setItem(key, data.value);
            }
        }
        if (!foundAny) {
            await seedFirestoreStateFromLocal();
        }
        firestoreOnline = true;
        firestoreLastError = "";
    } catch (err) {
        console.error('Firestore state pull failed:', err);
        firestoreOnline = false;
        firestoreLastError = (err && err.message) ? err.message : String(err);
    } finally {
        firestoreStateApplyMode = false;
    }
}

function hookStorageForCloudSync() {
    if (window.__optixStorageHooked) return;
    window.__optixStorageHooked = true;
    const _setItem = localStorage.setItem.bind(localStorage);
    const _removeItem = localStorage.removeItem.bind(localStorage);
    const _getItem = localStorage.getItem.bind(localStorage);
    const _key = localStorage.key.bind(localStorage);
    const _clear = localStorage.clear.bind(localStorage);

    // Migrate legacy local optix data to memory (keep persistent copies for standalone pages like invoice.html).
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = _key(i);
        if (!isOptixKey(key)) continue;
        const legacyValue = _getItem(key);
        if (legacyValue !== null) optixMemoryStore[key] = legacyValue;
        if (!shouldPersistOptixKey(key)) _removeItem(key);
    }

    localStorage.getItem = function(key) {
        if (isOptixKey(key)) {
            if (!Object.prototype.hasOwnProperty.call(optixMemoryStore, key)) {
                const backupValue = readPersistedOptixBackup(key);
                if (backupValue !== null) optixMemoryStore[key] = backupValue;
            }
            const rawValue = Object.prototype.hasOwnProperty.call(optixMemoryStore, key) ? optixMemoryStore[key] : null;
            const scopedValue = readStoreScopedOptixValue(key, rawValue);
            return scopedValue !== null ? scopedValue : rawValue;
        }
        return _getItem(key);
    };
    localStorage.setItem = function(key, value) {
        if (isOptixKey(key)) {
            const nextValue = isStoreScopedCollectionKey(key)
                ? sanitizeStoreScopedCollectionValue(key, value)
                : String(value);
            optixMemoryStore[key] = nextValue;
            if (shouldPersistOptixKey(key)) _setItem(key, nextValue);
            writePersistedOptixBackup(key, nextValue);
            if (shouldSyncKey(key)) scheduleCloudSync();
            if (!entityDocApplyMode) queueEntityDocSync(key, nextValue, false);
            if (!firestoreStateApplyMode) queueFirestoreStateSync(key, nextValue, false);
            return;
        }
        _setItem(key, value);
    };
    localStorage.removeItem = function(key) {
        if (isOptixKey(key)) {
            delete optixMemoryStore[key];
            if (shouldPersistOptixKey(key)) _removeItem(key);
            removePersistedOptixBackup(key);
            if (shouldSyncKey(key)) scheduleCloudSync();
            if (!entityDocApplyMode) queueEntityDocSync(key, null, true);
            if (!firestoreStateApplyMode) queueFirestoreStateSync(key, null, true);
            return;
        }
        _removeItem(key);
    };
    localStorage.clear = function() {
        Object.keys(optixMemoryStore).forEach((k) => { delete optixMemoryStore[k]; });
        clearPersistedOptixBackups();
        _clear();
        scheduleCloudSync();
    };
}

async function initCloudSync() {
    hookStorageForCloudSync();
    try {
        const user = await ensureFirebaseSession();
        if (user) await syncSessionFromAuthUser(user);
    } catch (err) {
        console.error("Firebase session restore failed:", err);
    }
    try {
        await initCollectionRealtimeSync();
    } catch (err) {
        console.error("Collection realtime init failed:", err);
        firestoreOnline = false;
        firestoreLastError = (err && err.message) ? err.message : String(err);
    }
    try {
        subscribeEntityDocsRealtime();
    } catch (err) {
        console.error("Entity realtime subscribe failed:", err);
    }
    try {
        await pullEntityDocs();
    } catch (err) {
        console.error("Entity doc pull failed during init:", err);
    }
    try {
        await pullFirestoreState();
    } catch (err) {
        console.error("Firestore state pull failed during init:", err);
    }
    try {
        await pullCloudSnapshot(false);
    } catch (err) {
        console.error("RTDB snapshot pull failed during init:", err);
    }
    updateCloudSyncStatus();
}

function applySettings() {
    const s = getSettings();
    window.__optixSettings = s;

    // Discounts on/off
    const discAmt = document.getElementById('txtDiscAmount');
    const discPct = document.getElementById('txtDiscPercent');
    if (discAmt) discAmt.disabled = !s.enableDiscounts;
    if (discPct) discPct.disabled = !s.enableDiscounts;
    document.querySelectorAll('.row-disc, .row-disc-amt').forEach(el => {
        el.disabled = !s.enableDiscounts;
    });
    if (!s.enableDiscounts) {
        if (discAmt) discAmt.value = "0";
        if (discPct) discPct.value = "0";
        document.querySelectorAll('.row-disc').forEach(el => {
            el.value = "0";
            if (typeof calcRow === 'function') calcRow(el);
        });
        document.querySelectorAll('.row-disc-amt').forEach(el => {
            el.value = "0";
        });
    }

    if (typeof calculateFinal === 'function') calculateFinal();
    updateBranchUI();
    applyStoreBranding();
}

function updateBranchUI() {
    const s = getSettings();
    const branchName = s.branchName || 'Main Branch';
    const branchSelect = document.querySelector('.branch-select');
    if (branchSelect) {
        branchSelect.innerHTML = `<option>Select Branch : ${branchName}</option>`;
    }
}

function ensureStoreBrandingStyle() {
    if (document.getElementById('optixStoreBrandStyle')) return;
    const style = document.createElement('style');
    style.id = 'optixStoreBrandStyle';
    style.textContent = `
        .optix-store-badge {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #fff;
            font-weight: 800;
            font-size: 22px;
            letter-spacing: 1px;
            text-transform: uppercase;
            line-height: 1;
        }
        .optix-store-badge.small {
            font-size: 15px;
            letter-spacing: 0.5px;
        }
    `;
    document.head.appendChild(style);
}

function applyStoreBranding() {
    ensureStoreBrandingStyle();
    const settings = window.__optixSettings || getSettings();
    const profile = getStoreProfile(settings);
    const badgeText = getStoreBadgeText(settings);
    document.querySelectorAll('.nav-icon.bg-black').forEach((el) => {
        el.setAttribute('title', profile.name);
        el.innerHTML = '';
        const badge = document.createElement('span');
        badge.className = `optix-store-badge${badgeText.length > 2 ? ' small' : ''}`;
        badge.textContent = badgeText;
        el.appendChild(badge);
    });
}

function injectSettingsStyles() {
    if (document.getElementById('optixSettingsStyle')) return;
    const style = document.createElement('style');
    style.id = 'optixSettingsStyle';
    style.textContent = `
        .optix-settings-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:3000; align-items:center; justify-content:center; }
        .optix-settings-card { background:#fff; width:520px; max-width:92vw; border-radius:6px; box-shadow:0 10px 30px rgba(0,0,0,0.25); overflow:hidden; }
        .optix-settings-header { background:#4a148c; color:#fff; padding:12px 16px; font-weight:bold; display:flex; justify-content:space-between; align-items:center; }
        .optix-settings-body { padding:16px; }
        .optix-settings-grid { display:grid; grid-template-columns: 1fr 1fr; gap:10px 16px; font-size:13px; }
        .optix-settings-row { display:flex; align-items:center; gap:8px; }
        .optix-settings-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
        .optix-btn { padding:6px 12px; font-size:12px; border:none; border-radius:4px; cursor:pointer; }
        .optix-btn-primary { background:#2563eb; color:#fff; }
        .optix-btn-warn { background:#f59e0b; color:#fff; }
        .optix-btn-danger { background:#ef4444; color:#fff; }
        .optix-btn-muted { background:#e5e7eb; color:#111; }
    `;
    document.head.appendChild(style);
}

function ensureSettingsModal() {
    if (document.getElementById('settingsModal')) return;
    injectSettingsStyles();
    const modal = document.createElement('div');
    modal.id = 'settingsModal';
    modal.className = 'optix-settings-modal';
    modal.innerHTML = `
        <div class="optix-settings-card">
            <div class="optix-settings-header">
                <span>Settings</span>
                <span style="cursor:pointer;" onclick="closeSettingsModal()">×</span>
            </div>
            <div class="optix-settings-body">
                <div class="optix-settings-grid">
                    <label class="optix-settings-row"><input type="checkbox" id="set_login_required"> Login Required</label>
                    <label class="optix-settings-row"><input type="checkbox" id="set_show_whatsapp"> Show WhatsApp Buttons</label>
                    <label class="optix-settings-row"><input type="checkbox" id="set_stock_check"> Stock Check</label>
                    <label class="optix-settings-row"><input type="checkbox" id="set_auto_invoice"> Auto Invoice Number</label>
                    <label class="optix-settings-row"><input type="checkbox" id="set_enable_discounts"> Enable Discounts</label>
                    <label class="optix-settings-row"><input type="checkbox" id="set_cloud_sync"> Enable Cloud Sync</label>
                </div>
                <div style="margin-top:10px; display:grid; gap:8px;">
                    <input id="set_cloud_url" placeholder="Cloud JSON URL (GET/PUT endpoint)" style="padding:8px; font-size:12px;">
                    <input id="set_cloud_token" placeholder="Bearer token (optional)" style="padding:8px; font-size:12px;">
                </div>

                <div class="optix-settings-actions">
                    <button class="optix-btn optix-btn-primary" onclick="saveSettingsFromModal()">Save Settings</button>
                    <button class="optix-btn optix-btn-muted" onclick="closeSettingsModal()">Close</button>
                    <button class="optix-btn optix-btn-primary" onclick="syncNowToCloud()">Sync Now</button>
                    <button class="optix-btn optix-btn-muted" onclick="pullNowFromCloud()">Pull From Cloud</button>
                    <button class="optix-btn optix-btn-primary" onclick="checkCloudConnection()">Test Cloud</button>
                    <button class="optix-btn optix-btn-warn" onclick="backupData()">Backup Data</button>
                    <button class="optix-btn optix-btn-warn" onclick="document.getElementById('restoreFile').click()">Restore Data</button>
                    <input type="file" id="restoreFile" style="display:none" onchange="restoreData(this)">
                    <button class="optix-btn optix-btn-danger" onclick="resetAllData()">Reset All Data</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

function openSettingsModal() {
    ensureSettingsModal();
    const s = getSettings();
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    set('set_login_required', s.loginRequired);
    set('set_show_whatsapp', s.showWhatsapp);
    set('set_stock_check', s.stockCheck);
    set('set_auto_invoice', s.autoInvoiceNo);
    set('set_enable_discounts', s.enableDiscounts);
    set('set_cloud_sync', s.cloudSyncEnabled);
    const cloudUrl = document.getElementById('set_cloud_url');
    const cloudToken = document.getElementById('set_cloud_token');
    if (cloudUrl) cloudUrl.value = s.cloudSyncUrl || '';
    if (cloudToken) cloudToken.value = s.cloudSyncToken || '';
    const modal = document.getElementById('settingsModal');
    if (modal) modal.style.display = 'flex';
}

function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.style.display = 'none';
}

async function saveSettingsFromModal() {
    const s = getSettings();
    const read = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
    s.loginRequired = read('set_login_required');
    s.showWhatsapp = read('set_show_whatsapp');
    s.stockCheck = read('set_stock_check');
    s.autoInvoiceNo = read('set_auto_invoice');
    s.enableDiscounts = read('set_enable_discounts');
    s.dateFormat = (document.getElementById('set_date_format')?.value || 'DD/MM/YYYY').trim();
    s.cloudSyncEnabled = read('set_cloud_sync');
    s.cloudSyncUrl = (document.getElementById('set_cloud_url')?.value || '').trim();
    s.cloudSyncToken = (document.getElementById('set_cloud_token')?.value || '').trim();
    const ok = await saveSettings(s);
    applySettings();
    closeSettingsModal();

    if (typeof loadPendingOrders === 'function') loadPendingOrders();
    if (typeof loadSalesHistory === 'function') loadSalesHistory();
    await flushFirestoreStateQueue();
    scheduleCloudSync();
    if (!ok) alert("Saved locally, but cloud settings sync failed.");
}

function initSettingsPage() {
    const s = getSettings();
    const actions = s.actionsConfig || getDefaultActionConfig();
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    const branchInput = document.getElementById('set_branch_name');
    if (branchInput) branchInput.value = s.branchName || '';
    const invoiceNameInput = document.getElementById('set_store_invoice_name');
    if (invoiceNameInput) invoiceNameInput.value = s.storeInvoiceName || s.branchName || '';
    const storeAddressInput = document.getElementById('set_store_address');
    if (storeAddressInput) storeAddressInput.value = s.storeAddress || '';
    const storePhoneInput = document.getElementById('set_store_phone');
    if (storePhoneInput) storePhoneInput.value = s.storePhone || '';
    const storeEmailInput = document.getElementById('set_store_email');
    if (storeEmailInput) storeEmailInput.value = s.storeEmail || '';
    const storeGstInput = document.getElementById('set_store_gst');
    if (storeGstInput) storeGstInput.value = s.storeGst || '';
    const storeLogoTextInput = document.getElementById('set_store_logo_text');
    if (storeLogoTextInput) storeLogoTextInput.value = s.storeLogoText || '';
    const dateFormatSelect = document.getElementById('set_date_format');
    if (dateFormatSelect) dateFormatSelect.value = s.dateFormat || 'DD/MM/YYYY';

    // Load existing logo (base64) into preview
    const logoBase64 = s.storeLogo || '';
    const logoPreview = document.getElementById('logoPreview');
    const logoHidden = document.getElementById('set_store_logo_base64');
    const logoInput = document.getElementById('storeLogoInput');
    if (logoHidden) logoHidden.value = logoBase64 || '';
    if (logoPreview && logoBase64) {
        logoPreview.src = logoBase64;
        logoPreview.style.display = 'block';
    }
    if (logoInput) {
        logoInput.addEventListener('change', (ev) => {
            const file = ev.target.files && ev.target.files[0];
            if (!file) return;
            if (file.size > 1024 * 1024) {
                alert('Please upload a logo smaller than 1MB.');
                return;
            }
            const reader = new FileReader();
            reader.onload = function(e) {
                const base64 = e.target.result;
                if (logoPreview) {
                    logoPreview.src = base64;
                    logoPreview.style.display = 'block';
                }
                if (logoHidden) logoHidden.value = base64 || '';
            };
            reader.readAsDataURL(file);
        });
    }

    // Add this to load the Size and Placement UI
    const logoSizeInput = document.getElementById('set_store_logo_size');
    const logoSizeVal = document.getElementById('logoSizeVal');
    if (logoSizeInput) {
        logoSizeInput.value = s.storeLogoSize || '150';
        if (logoSizeVal) logoSizeVal.innerText = logoSizeInput.value + 'px';
        if (logoPreview) {
            logoPreview.style.maxWidth = logoSizeInput.value + 'px';
            logoPreview.style.maxHeight = 'none';
        }
    }

    const logoPlacementInput = document.getElementById('set_store_logo_placement');
    if (logoPlacementInput) logoPlacementInput.value = s.storeLogoPlacement || 'left';

    set('set_page_show_whatsapp', s.showWhatsapp);
    set('set_action_send', actions.sendWhatsapp);
    set('set_action_chat', actions.chatWhatsapp);
    set('set_action_confirm', actions.confirmOrder);
    set('set_action_edit', actions.editOrder);
    set('set_action_payment', actions.paymentHistory);
    set('set_action_advance', actions.advanceReceipt);
    set('set_action_invoice', actions.finalInvoice);
    set('set_action_rx', actions.viewRx);
    set('set_action_delete', actions.deleteOrder);

    updateBranchUI();
}

function resetActionTogglesToDefault() {
    const defaults = getDefaultActionConfig();
    Object.entries(defaults).forEach(([key, val]) => {
        const idMap = {
            sendWhatsapp: 'set_action_send',
            chatWhatsapp: 'set_action_chat',
            confirmOrder: 'set_action_confirm',
            editOrder: 'set_action_edit',
            paymentHistory: 'set_action_payment',
            advanceReceipt: 'set_action_advance',
            finalInvoice: 'set_action_invoice',
            viewRx: 'set_action_rx',
            deleteOrder: 'set_action_delete'
        };
        const el = document.getElementById(idMap[key]);
        if (el) el.checked = !!val;
    });
}

async function saveSettingsPage() {
    const s = getSettings();
    const read = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
    const branchName = (document.getElementById('set_branch_name')?.value || '').trim();
    s.branchName = branchName || 'Main Branch';
    s.storeInvoiceName = (document.getElementById('set_store_invoice_name')?.value || '').trim();
    s.dateFormat = (document.getElementById('set_date_format')?.value || 'DD/MM/YYYY').trim();
    s.storeAddress = (document.getElementById('set_store_address')?.value || '').trim();
    s.storePhone = (document.getElementById('set_store_phone')?.value || '').trim();
    s.storeEmail = (document.getElementById('set_store_email')?.value || '').trim();
    s.storeGst = (document.getElementById('set_store_gst')?.value || '').trim();
    s.storeLogoText = (document.getElementById('set_store_logo_text')?.value || '').trim().slice(0, 3);
    // Add these two lines to save size and placement
    s.storeLogoSize = document.getElementById('set_store_logo_size')?.value || '150';
    s.storeLogoPlacement = document.getElementById('set_store_logo_placement')?.value || 'left';
    s.showWhatsapp = read('set_page_show_whatsapp');

    const actions = s.actionsConfig || getDefaultActionConfig();
    actions.sendWhatsapp = read('set_action_send');
    actions.chatWhatsapp = read('set_action_chat');
    actions.confirmOrder = read('set_action_confirm');
    actions.editOrder = read('set_action_edit');
    actions.paymentHistory = read('set_action_payment');
    actions.advanceReceipt = read('set_action_advance');
    actions.finalInvoice = read('set_action_invoice');
    actions.viewRx = read('set_action_rx');
    actions.deleteOrder = read('set_action_delete');
    s.actionsConfig = actions;
    // Include store logo (base64) if present in hidden input
    const existingLogoBase64 = document.getElementById('set_store_logo_base64');
    if (existingLogoBase64) s.storeLogo = existingLogoBase64.value || s.storeLogo || '';

    const ok = await saveSettings(s);
    applySettings();
    refreshOrderDateInputs();
    if (typeof loadPendingOrders === 'function') loadPendingOrders();
    if (typeof loadSalesHistory === 'function') loadSalesHistory();
    await flushFirestoreStateQueue();
    scheduleCloudSync();
    alert(ok ? "Settings saved." : "Saved locally, but cloud settings sync failed.");
}

function bindSettingsIcon() {
    document.querySelectorAll('.nav-icon.bg-purple, .fa-cog').forEach(el => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', (e) => {
            e.preventDefault();
            if (page !== 'settings.html') {
                window.location.href = 'settings.html';
            }
        });
    });
}

function resetAllData() {
    if (!confirm("This will delete ALL data (orders, products, customers, staff, expenses, prescriptions, settings). Continue?")) return;
    const keys = [
        'optixProducts','optixOrders','optixCustomers','optixExpenses','optixStaff',
        'optixPrescriptions','optixRx','optixSettings','optixInvoiceSeq'
    ];
    keys.forEach(k => localStorage.removeItem(k));
    clearAuthSessionState();
    alert("All data cleared. The page will reload.");
    window.location.href = 'login.html';
}

async function performLogin() {
    const user = normalizeEmail(document.getElementById('loginUser').value);
    const pass = document.getElementById('loginPass').value;
    const errorMsg = document.getElementById('loginError');
    if (errorMsg) {
        errorMsg.innerText = "";
        errorMsg.style.display = 'none';
    }
    if (!user || !pass) {
        if (errorMsg) {
            errorMsg.innerText = "Enter your email and password.";
            errorMsg.style.display = 'block';
        }
        return;
    }
    try {
        if (typeof firebase === 'undefined' || !firebase.auth) throw new Error("Firebase Auth is not available.");
        const auth = firebase.auth();
        const credential = await auth.signInWithEmailAndPassword(user, pass);
        const profile = await syncSessionFromAuthUser(credential.user);
        window.location.href = profile && profile.role === 'super_admin' ? 'admin.html' : 'dashboard.html';
    } catch (err) {
        console.error("Login failed:", err);
        clearAuthSessionState();
        if (errorMsg) {
            errorMsg.innerText = (err && err.message) ? err.message : "Login failed.";
            errorMsg.style.display = 'block';
        }
    }
}
async function performLogout() {
    if(confirm("Are you sure you want to Logout?")) {
        try {
            if (typeof firebase !== 'undefined' && firebase.auth) {
                await firebase.auth().signOut();
            }
        } catch (err) {
            console.error("Firebase signout failed:", err);
        }
        clearAuthSessionState();
        window.location.href = 'login.html';
    }
}
// --- PART 1: PRODUCT MANAGEMENT ---

// A. Generate Unique 8-Char Barcode
function generateBarcode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result; // e.g., "A7X29B1Z"
}

async function saveProductToCloud(productData) {
    if (!db) throw new Error("Firestore not initialized");
    const storeId = currentStoreId();
    if (!storeId) throw new Error("Missing store ID for cloud save");
    const ref = await db.collection("products").add({ ...productData, storeId });
    return { ...productData, _docId: ref.id };
}

async function ensureProductsCache() {
    const storeId = currentStoreId();
    const cachedAll = JSON.parse(localStorage.getItem('optixProducts')) || [];
    const cached = storeId ? cachedAll.filter(p => p.storeId === storeId) : [];
    if (cached.length > 0) return cached;
    if (!db) return cached;
    try {
        const cloudProducts = await loadProductsFromCloud();
        return Array.isArray(cloudProducts) ? cloudProducts : [];
    } catch (err) {
        console.error("Products cache warmup failed:", err);
        return cached;
    }
}

async function loadProductsFromCloud() {
    if (!db) return null;
    const storeId = currentStoreId();
    if (!storeId) return [];
    const snapshot = await db.collection("products").where("storeId", "==", storeId).get();
    const products = [];
    snapshot.forEach((doc) => {
        products.push({ ...doc.data(), _docId: doc.id });
    });
    localStorage.setItem('optixProducts', JSON.stringify(products));
    return products;
}

function refreshProductDrivenViews() {
    if (document.getElementById('productListBody')) loadProducts();
    if (document.getElementById('inventoryListBody')) loadInventory();
    if (document.getElementById('stockTable')) loadStock();
}

function subscribeProductsRealtime() {
    if (!db) return;
    const storeId = currentStoreId();
    if (!storeId) return;
    if (productsRealtimeSubscribed && productsRealtimeStoreId === storeId && typeof productsRealtimeUnsub === 'function') return;
    if (typeof productsRealtimeUnsub === 'function') {
        try { productsRealtimeUnsub(); } catch {}
    }
    productsRealtimeSubscribed = true;
    productsRealtimeStoreId = storeId;
    productsRealtimeUnsub = db.collection("products").where("storeId", "==", storeId).onSnapshot((snapshot) => {
        const products = [];
        snapshot.forEach((doc) => {
            products.push({ ...doc.data(), _docId: doc.id });
        });
        localStorage.setItem('optixProducts', JSON.stringify(products));
        refreshProductDrivenViews();
        firestoreOnline = true;
        firestoreLastError = "";
    }, (err) => {
        console.error("Realtime product sync failed:", err);
        firestoreOnline = false;
        firestoreLastError = (err && err.message) ? err.message : String(err);
    });
}

// --- FIX 1: Save Unique Barcodes for Each Quantity ---
async function saveProductDetailed() {
    const name = document.getElementById('nName').value;
    if (!name) { alert("Product Name is required!"); return; }
    
    // Get the quantity the user entered (e.g., 10)
    const totalQty = parseInt(document.getElementById('nQty').value) || 1;
    
    // Load existing products
    const products = JSON.parse(localStorage.getItem('optixProducts')) || [];

    // LOOP: Run this code 'totalQty' times
    for(let i = 0; i < totalQty; i++) {
        
        // Generate a new unique barcode for EACH item
        // Note: We ignore the manual 'nCode' input here to ensure uniqueness, 
        // or you can append numbers to it if you prefer.
        const uniqueCode = generateBarcode(); 

        const newProd = {
            id: Date.now() + i, // Unique ID for database
            category: document.getElementById('nType')?.value || document.getElementById('nCat')?.value || "Other",
            code: uniqueCode, // <--- UNIQUE BARCODE
            name: name,
            brand: document.getElementById('nBrand').value,
            color: document.getElementById('nColor').value,
            size: document.getElementById('nSize').value,
            gender: document.getElementById('nGender').value,
            material: document.getElementById('nMaterial').value,
            shape: document.getElementById('nShape').value,
            buyPrice: parseFloat(document.getElementById('nBuy').value) || 0,
            sellPrice: parseFloat(document.getElementById('nSell').value) || 0,
            qty: 1, // Each entry is now 1 single unit
            createdOn: new Date().toLocaleString(),
            status: 'Active'
        };
        
        if (db) {
            try {
                const cloudSaved = await saveProductToCloud(newProd);
                products.push(cloudSaved || newProd);
            } catch (err) {
                console.error("Cloud save failed for product.", err);
                alert("Cloud save failed. Product was not added.");
                return;
            }
        } else {
            products.push(newProd);
        }
    }

    localStorage.setItem('optixProducts', JSON.stringify(products));

    alert(`Success! Added ${totalQty} individual items with unique barcodes.`);
    
    // Close Modal and Reload
    const modal = document.getElementById('addModal');
    if (modal) modal.style.display = 'none';
    await loadProducts(); 
}

// --- HIGH SPEED PRODUCTS LOADER ---
async function loadProducts() {
    const tbody = document.getElementById('productListBody');
    if (!tbody) return;

    if (db) subscribeProductsRealtime();
    let products = JSON.parse(localStorage.getItem('optixProducts')) || [];
    if (db) {
        try {
            const cloudProducts = await loadProductsFromCloud();
            if (Array.isArray(cloudProducts)) products = cloudProducts;
        } catch (err) {
            console.error("Cloud load failed, using cached data.", err);
        }
    }
    
    const fCat = document.getElementById('fCat') ? document.getElementById('fCat').value.toLowerCase() : "";
    const fCode = document.getElementById('fCode') ? document.getElementById('fCode').value.toLowerCase() : "";
    const fName = document.getElementById('fName') ? document.getElementById('fName').value.toLowerCase() : "";
    const fBrand = document.getElementById('fBrand') ? document.getElementById('fBrand').value.toLowerCase() : "";

    let htmlContent = ""; // Build string

    products.forEach((p, index) => {
        if (fCat && p.category.toLowerCase() !== fCat) return;
        if (fCode && !p.code.toLowerCase().includes(fCode)) return;
        if (fName && !p.name.toLowerCase().includes(fName)) return;
        if (fBrand && !p.brand.toLowerCase().includes(fBrand)) return;

        const descParts = [p.brand, p.name, p.color, p.size].filter(Boolean).join(" - ");

        htmlContent += `
            <tr>
                <td><input type="checkbox"></td>
                <td>${index + 1}</td>
                <td style="font-family:monospace; font-weight:bold; color:#d32f2f; font-size:14px;">${p.code}</td>
                <td>
                    <span style="font-weight:bold; color:#2563eb">${p.category}</span><br>
                    ${descParts}
                </td>
                <td class="price-cell">
                    <div style="font-size:11px; color:#666;">Buy: ${p.buyPrice}</div>
                    <div style="font-size:12px; color:#000; font-weight:bold">Sell: ${p.sellPrice}</div>
                </td>
                <td style="text-align:center;">
                    <span style="background:${p.qty<3?'red':'green'}; color:white; padding:2px 6px; border-radius:10px; font-size:11px;">
                        ${p.qty} Units
                    </span>
                </td>
                <td style="color:green">${p.status}</td>
                <td>${(p.createdOn||'').split(',')[0]}</td>
                <td>
                    <i class="fas fa-edit" style="color:#ff9800; cursor:pointer; margin-right:10px; font-size:16px;" onclick="editProduct(${index})" title="Edit Item"></i>
                    <i class="fas fa-trash" style="color:red; cursor:pointer; font-size:16px;" onclick="deleteProduct(${index})" title="Delete Item"></i>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = htmlContent; // Inject once
}

// --- NEW FUNCTION: Edit Product ---
function editProduct(index) {
    const products = JSON.parse(localStorage.getItem('optixProducts')) || [];
    const p = products[index];

    // 1. Open Modal
    document.getElementById('addModal').style.display = 'block';

    // 2. Fill Fields with Existing Data
    document.getElementById('nType').value = p.category;
    document.getElementById('nCode').value = p.code;
    document.getElementById('nName').value = p.name;
    document.getElementById('nBrand').value = p.brand;
    document.getElementById('nColor').value = p.color || "";
    document.getElementById('nSize').value = p.size || "";
    document.getElementById('nGender').value = p.gender || "Unisex";
    document.getElementById('nMaterial').value = p.material || "";
    document.getElementById('nShape').value = p.shape || "";
    document.getElementById('nBuy').value = p.buyPrice;
    document.getElementById('nSell').value = p.sellPrice;
    document.getElementById('nQty').value = p.qty;

    // 3. Change Save Button Behavior to "Update"
    // We modify the onclick attribute of the save button temporarily
    const saveBtn = document.querySelector('#addModal button[onclick^="saveNewInventory"]');
    if(saveBtn) {
        saveBtn.innerText = "Update Product";
        saveBtn.setAttribute('onclick', `updateProductAtIndex(${index})`);
    }

    // Trigger field toggle to show correct inputs
    toggleFields();
}

// --- NEW FUNCTION: Save Updated Product ---
async function updateProductAtIndex(index) {
    const products = JSON.parse(localStorage.getItem('optixProducts')) || [];
    const p = products[index];
    if (!p) return;
    
    // Update the object at the specific index
    p.category = document.getElementById('nType').value;
    p.code = document.getElementById('nCode').value;
    p.name = document.getElementById('nName').value;
    p.brand = document.getElementById('nBrand').value;
    p.color = document.getElementById('nColor').value;
    p.size = document.getElementById('nSize').value;
    p.gender = document.getElementById('nGender').value;
    p.material = document.getElementById('nMaterial').value;
    p.shape = document.getElementById('nShape').value;
    p.buyPrice = parseFloat(document.getElementById('nBuy').value) || 0;
    p.sellPrice = parseFloat(document.getElementById('nSell').value) || 0;
    p.qty = parseInt(document.getElementById('nQty').value) || 0;

    if (db && p._docId) {
        try {
            const { _docId, ...cloudPayload } = p;
            await db.collection("products").doc(_docId).set(cloudPayload, { merge: true });
        } catch (err) {
            console.error("Cloud update failed.", err);
            alert("Cloud update failed. Product was not updated.");
            return;
        }
    }
    localStorage.setItem('optixProducts', JSON.stringify(products));
    
    alert("Product Updated Successfully!");
    document.getElementById('addModal').style.display = 'none';
    await loadProducts();

    // Reset Button back to "Add Mode" for next time
    const saveBtn = document.querySelector('#addModal button[onclick^="updateProductAtIndex"]');
    if(saveBtn) {
        saveBtn.innerText = "Add Inventory →";
        saveBtn.setAttribute('onclick', 'saveNewInventory()');
    }
}
// --- DELETE PRODUCT FUNCTION ---
async function deleteProduct(index) {
    if (confirm("Delete this product?")) {
        const products = JSON.parse(localStorage.getItem('optixProducts')) || [];
        const [deleted] = products.splice(index, 1);
        if (db && deleted && deleted._docId) {
            try {
                await db.collection("products").doc(deleted._docId).delete();
            } catch (err) {
                console.error("Cloud delete failed.", err);
                alert("Cloud delete failed. Product was not deleted.");
                return;
            }
        }
        localStorage.setItem('optixProducts', JSON.stringify(products));
        await loadProducts();
    }
}

function resetProductModalForAdd() {
    const saveBtn = document.querySelector('#addModal button[onclick^="updateProductAtIndex"]');
    if (saveBtn) {
        saveBtn.innerText = "Add Inventory ->";
        saveBtn.setAttribute('onclick', 'saveNewInventory()');
    }
}

// --- PART 2: ORDER & BARCODE SCANNER ---
// --- FIXED BARCODE SCANNER (DOM BASED) ---
function scanBarcode(input) {
    const code = input.value.trim();
    if (!code) return; // Do nothing if empty

    // 1. Find Product in Database
    const products = JSON.parse(localStorage.getItem('optixProducts')) || [];
    const product = products.find(p => p.code === code);

    if (!product) {
        alert("❌ Product not found!");
        input.value = ""; // Clear invalid code
        return;
    }

    if (product.qty <= 0) {
        alert("⚠️ Warning: Product is Out of Stock!");
    }

    // 2. Find the active row inputs
    const row = input.closest('tr');
    
    // 3. Fill the data directly into the inputs
    const typeSelect = row.querySelector('.p-type');
    const codeInput = row.querySelector('.p-code'); // Hidden or visible code field
    const descInput = row.querySelector('.desc');
    const priceInput = row.querySelector('.price');
    const qtyInput = row.querySelector('.qty');

    // Auto-select type if possible (Optional)
    if(product.category) typeSelect.value = product.category;
    
    // Fill Fields
    if(codeInput) codeInput.value = product.code; // Use barcode as product code
    descInput.value = `${product.brand} ${product.name} ${product.color || ''}`;
    priceInput.value = product.sellPrice;
    
    // 4. Calculate Totals
    calcRow(qtyInput); 
    
    // 5. Visual Feedback
    input.style.borderColor = "green";
}
async function saveOrder(openInNewTab = false) {
    // 1. Force Calculation
    calculateFinal();
    const name = document.getElementById('cName').value;
    const phone = document.getElementById('cPhone').value;
    const isEdit = editingOrderId !== null;
    const settings = getSettings();
    const stockCheckEnabled = settings.stockCheck !== false;
    const discountsEnabled = settings.enableDiscounts !== false;
    
    if(!name || !phone) { alert("Customer Name and Phone are required!"); return; }

    // 2. CAPTURE & VALIDATE ITEMS
    const itemRows = document.querySelectorAll('.item-row');
    const items = [];
    let products = JSON.parse(localStorage.getItem('optixProducts')) || [];
    try {
        if (db) {
            const cloudProducts = await loadProductsFromCloud();
            if (Array.isArray(cloudProducts)) products = cloudProducts;
        }
    } catch (err) {
        console.error("Cloud product load failed:", err);
    }
    const productsWorking = JSON.parse(JSON.stringify(products));
    let hasStockIssue = false;

    itemRows.forEach(row => {
        const itemBarcode = row.querySelector('.barcode').value.trim();
        const itemCode = row.querySelector('.p-code').value.trim();
        const type = row.querySelector('.p-type').value;
        const desc = row.querySelector('.desc').value;
        const itemQty = parseFloat(row.querySelector('.qty').value) || 0;
        const price = parseFloat(row.querySelector('.price').value) || 0;
        const total = parseFloat(row.querySelector('.row-total').value) || 0;

        // SKIP EMPTY ROWS
        if(!desc || total === 0) return;

        // INVENTORY DEDUCTION & VALIDATION (New Order Only)
        if(!isEdit && itemBarcode) {
            const productIndex = productsWorking.findIndex(p => p.code === itemBarcode);
            if(productIndex > -1) {
                if (stockCheckEnabled && productsWorking[productIndex].qty < itemQty) {
                    alert(`⚠️ Insufficient Stock for ${desc}.\nAvailable: ${productsWorking[productIndex].qty}`);
                    hasStockIssue = true;
                } else {
                    productsWorking[productIndex].qty -= itemQty;
                    // Mark as Sold Out if 0
                    if(productsWorking[productIndex].qty <= 0) {
                        productsWorking[productIndex].qty = 0;
                        productsWorking[productIndex].status = "Sold Out";
                    }
                }
            }
        }

        items.push({
            barcode: itemBarcode,
            code: itemCode,
            type: type,
            desc: desc,
            qty: itemQty,
            price: price,
            disc: parseFloat(row.querySelector('.row-disc').value) || 0, // SAVE DISCOUNT
            discAmt: parseFloat(row.querySelector('.row-disc-amt')?.value) || 0,
            total: total,
            rx: row.querySelector('.row-rx-data').value
                ? JSON.parse(row.querySelector('.row-rx-data').value)
                : null
        });
    });

    if(hasStockIssue) return; // Stop if stock error
    if(items.length === 0) { alert("Please add at least one valid item!"); return; }

    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const storeId = getCollectionStoreId();
    let orderId = Date.now();

    if (isEdit) {
        orderId = editingOrderId;

        // Restore inventory from previous items (if barcode exists)
        if (editingOriginalOrder && Array.isArray(editingOriginalOrder.items)) {
            editingOriginalOrder.items.forEach(item => {
                const oldBarcode = item.barcode || item.code || "";
                if (!oldBarcode) return;
                const idx = productsWorking.findIndex(p => p.code === oldBarcode);
                if (idx > -1) {
                    productsWorking[idx].qty += (parseFloat(item.qty) || 0);
                    if (productsWorking[idx].qty > 0) productsWorking[idx].status = "Active";
                }
            });
        }

        // Re-validate and deduct for new items after restoration
        items.forEach(item => {
            if (!item.barcode) return;
            const idx = productsWorking.findIndex(p => p.code === item.barcode);
            if (idx > -1) {
                if (stockCheckEnabled && productsWorking[idx].qty < item.qty) {
                    alert(`⚠️ Insufficient Stock for ${item.desc}.\nAvailable: ${productsWorking[idx].qty}`);
                    hasStockIssue = true;
                } else {
                    productsWorking[idx].qty -= item.qty;
                    if (productsWorking[idx].qty <= 0) {
                        productsWorking[idx].qty = 0;
                        productsWorking[idx].status = "Sold Out";
                    }
                }
            }
        });

        if (hasStockIssue) return;
    }

    const baseTotal = items.reduce((sum, it) => sum + (parseFloat(it.total) || 0), 0);
    const grossTotal = items.reduce((sum, it) => sum + ((parseFloat(it.qty) || 0) * (parseFloat(it.price) || 0)), 0);
    const discountAmount = discountsEnabled ? (parseFloat(document.getElementById('txtDiscAmount').value) || 0) : 0;
    const discountPercent = discountsEnabled ? (parseFloat(document.getElementById('txtDiscPercent').value) || 0) : 0;
    const roundOff = parseFloat(document.getElementById('txtRoundOff').value) || 0;

    const enteredCash = parseFloat(document.getElementById('payCash').value) || 0;
    const enteredUpi = parseFloat(document.getElementById('payUPI').value) || 0;
    const enteredBank = parseFloat(document.getElementById('payBank').value) || 0;
    const useIncrementPayment = isPendingPaymentIncrementMode() || isConfirmPaymentFlow();
    const existingCash = useIncrementPayment ? editingExistingPaidCash : 0;
    const existingUpi = useIncrementPayment ? editingExistingPaidUpi : 0;
    const existingBank = useIncrementPayment ? editingExistingPaidBank : 0;
    const paidCashTotal = existingCash + enteredCash;
    const paidUpiTotal = existingUpi + enteredUpi;
    const paidBankTotal = existingBank + enteredBank;
    const totalPaidNow = paidCashTotal + paidUpiTotal + paidBankTotal;
    const payableNow = parseFloat(document.getElementById('txtPayable').value) || 0;

    // Prevent overpayment beyond payable amount
    if (totalPaidNow > payableNow + 0.01) {
        alert(`Error: Total paid (Rs ${totalPaidNow.toFixed(2)}) exceeds the payable amount (Rs ${payableNow.toFixed(2)}). Please adjust the payment amounts.`);
        return;
    }
    const isFullyPaid = totalPaidNow >= payableNow;
    const nextStatus = (isEdit && editingOriginalOrder && editingOriginalOrder.status === "Confirmed" && isFullyPaid)
        ? "Confirmed"
        : "Pending";

    // Read the manual input from the UI
    const manualInvoiceNo = document.getElementById('orderNoDisplay').value.trim();

    // Check what the auto-generated number preview looks like
    let seq = parseInt(localStorage.getItem('optixInvoiceSeq'), 10) || 1;
    const expectedAutoNo = `INV-${String(seq).padStart(6, '0')}`;

    let invoiceNo = (isEdit && editingOriginalOrder && editingOriginalOrder.invoiceNo)
        ? editingOriginalOrder.invoiceNo
        : null;
        
    // 1. If user typed a CUSTOM number (different from the auto-preview)
    if (manualInvoiceNo && manualInvoiceNo !== expectedAutoNo && manualInvoiceNo !== "Auto-generated" && !manualInvoiceNo.startsWith("FY")) {
         invoiceNo = manualInvoiceNo;
    } 
    // 2. Otherwise, auto-generate it normally (this also increments your database counter)
    else if (settings.autoInvoiceNo !== false) {
        if (!invoiceNo) invoiceNo = getNextInvoiceNo();
    }
    const shareToken = (isEdit && editingOriginalOrder && editingOriginalOrder.shareToken)
        ? editingOriginalOrder.shareToken
        : generateInvoiceShareToken();

    // Build/extend payment history so we can show part-payments + mode in reports
    const prevHistory = (isEdit && editingOriginalOrder && Array.isArray(editingOriginalOrder.paymentHistory))
        ? [...editingOriginalOrder.paymentHistory]
        : [];
    const prevCash = isEdit && editingOriginalOrder ? (parseFloat(editingOriginalOrder.paidCash) || 0) : 0;
    const prevUpi = isEdit && editingOriginalOrder ? (parseFloat(editingOriginalOrder.paidUpi) || 0) : 0;
    const prevBank = isEdit && editingOriginalOrder ? (parseFloat(editingOriginalOrder.paidBank) || 0) : 0;
    const addedCash = Math.max(0, paidCashTotal - prevCash);
    const addedUpi = Math.max(0, paidUpiTotal - prevUpi);
    const addedBank = Math.max(0, paidBankTotal - prevBank);
    const addedTotal = addedCash + addedUpi + addedBank;
    if (addedTotal > 0.0001) {
        prevHistory.push({
            ts: new Date().toISOString(),
            cash: addedCash,
            upi: addedUpi,
            bank: addedBank,
            total: addedTotal
        });
    }

    const updatedOrder = {
        id: orderId,
        invoiceNo: invoiceNo,
        storeId: storeId,
        storeProfileSnapshot: getStoreProfile(settings),
        name: name,
        phone: phone,
        amount: payableNow,
        paid: totalPaidNow,
        paidCash: paidCashTotal,
        paidUpi: paidUpiTotal,
        paidBank: paidBankTotal,
        paymentHistory: prevHistory,
        date: getManagedDateValue('orderDate') || new Date().toISOString(),
        deliveryDate: getManagedDateValue('deliveryDate') || getManagedDateValue('orderDate') || '',
        baseTotal: baseTotal,
        grossTotal: grossTotal,
        discount: discountAmount,
        discountPercent: discountPercent,
        roundOff: roundOff,
        status: nextStatus,
        items: items,
        shareToken: shareToken,
        updatedAt: new Date().toISOString(),
        createdAt: (editingOriginalOrder && editingOriginalOrder.createdAt) || new Date().toISOString()
    };

    if (isEdit) {
        const idx = orders.findIndex(o => o.id === editingOrderId);
        if (idx > -1) {
            orders[idx] = updatedOrder;
        } else {
            orders.push(updatedOrder);
        }
    } else {
        orders.push(updatedOrder);
    }

    const ordersJson = JSON.stringify(orders);

    // Save Customer Data (Updates existing or adds new)
    const customers = JSON.parse(localStorage.getItem('optixCustomers')) || [];
    const custIndex = customers.findIndex(c => c.phone === phone);
    let customerRecord = null;
    if (custIndex > -1) {
        customers[custIndex].name = name; 
        customers[custIndex].lastVisit = updatedOrder.date;
        customers[custIndex].storeId = storeId;
        customerRecord = customers[custIndex];
    } else {
        customerRecord = { id: Date.now(), name: name, phone: phone, lastVisit: updatedOrder.date, storeId: storeId };
        customers.push(customerRecord);
    }

    localStorage.setItem('optixOrders', ordersJson);
    sessionStorage.setItem('optixOrdersSnapshot', ordersJson); // fallback for invoice.html if memory store inaccessible
    localStorage.setItem('optixProducts', JSON.stringify(productsWorking));
    localStorage.setItem('optixCustomers', JSON.stringify(customers));

    let cloudSaveError = null;
    try {
        if (db) {
            await ensureFirebaseSession();
            await syncChangedProductsToCloud(products, productsWorking);
            await upsertEntityToCloud('optixOrders', updatedOrder);
            if (customerRecord) await upsertEntityToCloud('optixCustomers', customerRecord);
            await savePublicInvoiceSnapshot(updatedOrder, settings);
            firestoreOnline = true;
            firestoreLastError = "";
        }
    } catch (err) {
        console.error("Cloud order save failed:", err);
        firestoreOnline = false;
        firestoreLastError = (err && err.message) ? err.message : String(err);
        cloudSaveError = firestoreLastError;
    }
    updateCloudSyncStatus();

    // Ensure entity/state docs are persisted before leaving the page.
    // invoice.html relies on Firestore orders_state when optix keys are memory-backed.
    try {
        await flushEntityDocQueue();
        await flushFirestoreStateQueue();
    } catch (err) {
        console.error("Pre-redirect cloud flush failed:", err);
    }

    if (cloudSaveError) {
        alert(`Bill saved locally. Cloud sync failed.\n${cloudSaveError}`);
    }

    // 5. SUCCESS
    if(openInNewTab) {
        window.open(buildInvoiceUrl(updatedOrder.id, { order: updatedOrder }), '_blank');
        if (!isEdit) location.reload(); 
    } else {
        window.location.href = buildInvoiceUrl(updatedOrder.id, { order: updatedOrder });
    }
}

function confirmAndSaveOrder() {
    if (!editingOrderId) return;
    if (!confirm("Confirm this order and save changes?")) return;
    const payable = parseFloat(document.getElementById('txtPayable').value) || 0;
    const paid = parseFloat(document.getElementById('txtTotalPaid').value) || 0;
    if (paid < payable) {
        alert("Cannot confirm. Full payment is required.");
        return;
    }
    if (editingOriginalOrder) editingOriginalOrder.status = "Confirmed";
    saveOrder(false);
}
// --- PART 3: INVENTORY, ACCOUNTS & DASHBOARD (Standard Loaders) ---

function loadInventory() {
    const tbody = document.getElementById('inventoryListBody');
    if (!tbody) return;
    const products = JSON.parse(localStorage.getItem('optixProducts')) || [];
    let totalItems = 0, totalValue = 0;
    tbody.innerHTML = "";

    products.forEach(p => {
        totalItems += p.qty;
        totalValue += (p.qty * p.sellPrice); // Value at Sell Price
        tbody.insertAdjacentHTML('beforeend', `
            <tr>
                <td>${p.brand} ${p.name}</td>
                <td>${p.category}</td>
                <td>${p.code}</td>
                <td style="font-weight:bold">${p.qty}</td>
                <td>${p.qty < 3 ? '<span style="color:red">Low</span>' : 'OK'}</td>
            </tr>
        `);
    });
    if(document.getElementById('invTotalItems')) document.getElementById('invTotalItems').value = totalItems;
    if(document.getElementById('invTotalValue')) document.getElementById('invTotalValue').value = totalValue.toFixed(2);
}

function loadAccounts() {
    // Simple Ledger Loader
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const tbody = document.getElementById('ledgerTable');
    if(!tbody) return;

    tbody.innerHTML = "";
    let totalSales = 0;
    orders.forEach(o => {
        totalSales += o.amount;
        tbody.insertAdjacentHTML('beforeend', `
            <tr><td>${new Date(o.date).toLocaleDateString()}</td><td>SALE</td><td>Order ${o.id}</td><td style="color:green">${o.amount}</td></tr>
        `);
    });
    if(document.getElementById('accTotalSales')) document.getElementById('accTotalSales').value = totalSales;
}

function loadDashboard() {
    try {
        const num = (v) => {
            if (typeof v === 'number' && !isNaN(v)) return v;
            const cleaned = String(v || '').replace(/[^0-9.\-]/g, '');
            const n = parseFloat(cleaned);
            return isNaN(n) ? 0 : n;
        };
        const parseDateLoose = (val) => {
            if (!val) return null;
            if (val instanceof Date && !isNaN(val)) return val;
            const d = new Date(val);
            if (!isNaN(d)) return d;
            const m = String(val).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
            if (m) {
                let dd = m[1].padStart(2, '0');
                let mm = m[2].padStart(2, '0');
                let yy = m[3].length === 2 ? '20' + m[3] : m[3];
                return new Date(`${yy}-${mm}-${dd}`);
            }
            return null;
        };

        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();

        const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
        const expenses = JSON.parse(localStorage.getItem('optixExpenses')) || [];

        let todaySales = 0;
        let todayCollection = 0;
        let monthSales = 0;
        let totalPending = 0;
        let pendingCount = 0;
        let monthBillCount = 0;
        let todayExpense = 0;

        orders.forEach(o => {
            const oDate = parseDateLoose(o.date);
            const validDate = oDate && !isNaN(oDate.getTime());
            const oDateStr = validDate ? oDate.toISOString().split('T')[0] : null;

            const amount = num(o.amount);
            const paid = num(o.paid);
            const balance = amount - paid;
            const status = (o.status || "").toLowerCase();
            if (balance > 0 && status !== "cancelled") {
                totalPending += balance;
                pendingCount += 1;
            }
            if (validDate && oDateStr === todayStr) {
                todaySales += amount;
                todayCollection += paid;
            }
            if (validDate && oDate.getMonth() === currentMonth && oDate.getFullYear() === currentYear) {
                monthSales += amount;
                monthBillCount++;
            }
        });

        expenses.forEach(e => {
            const eDate = parseDateLoose(e.date);
            const validDate = eDate && !isNaN(eDate.getTime());
            const eDateStr = validDate ? eDate.toISOString().split('T')[0] : null;
            if (eDateStr === todayStr) {
                todayExpense += num(e.amount);
            }
        });

        const pendingValEl = document.getElementById('dash-pending-val');
        const pendingBalEl = document.getElementById('dash-pending-balance');
        const pendingCountEl = document.getElementById('dash-pending-count');
        if(pendingValEl) {
            pendingValEl.innerText = "Rs " + totalPending.toFixed(2);
            pendingValEl.style.color = totalPending > 0 ? "red" : "green";
        }
        if(pendingBalEl) {
            pendingBalEl.innerText = "Rs " + totalPending.toFixed(2);
            pendingBalEl.style.color = totalPending > 0 ? "red" : "green";
        }
        if(pendingCountEl) {
            pendingCountEl.innerText = pendingCount;
            pendingCountEl.style.color = pendingCount > 0 ? "red" : "green";
        }

        const colEl = document.getElementById('dash-collection');
        if(colEl) {
            colEl.innerText = "Rs " + todayCollection.toFixed(2);
            colEl.style.color = todayCollection > 0 ? "green" : "red";
        }

        if(document.getElementById('dash-today-sales')) {
            document.getElementById('dash-today-sales').innerText = "Rs " + todaySales.toFixed(2);
        }
        if(document.getElementById('dash-expenses')) {
            document.getElementById('dash-expenses').innerText = "Rs " + todayExpense.toFixed(2);
        }
        if(document.getElementById('dash-total-sales')) {
            document.getElementById('dash-total-sales').innerText = "Rs " + monthSales.toFixed(2);
        }
        if(document.getElementById('dash-bill-count')) {
            document.getElementById('dash-bill-count').innerText = monthBillCount;
        }
    } catch (err) {
        console.error('loadDashboard error', err);
    }

    // --- Recompute dashboard metrics (robust parsing) ---
    try {
        const num = (v) => {
            if (typeof v === 'number' && !isNaN(v)) return v;
            const cleaned = String(v || '').replace(/[^0-9.\-]/g, '');
            const n = parseFloat(cleaned);
            return isNaN(n) ? 0 : n;
        };
        const parseDateLoose = (val) => {
            if (!val) return null;
            if (val instanceof Date && !isNaN(val)) return val;
            const d = new Date(val);
            if (!isNaN(d)) return d;
            const m = String(val).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
            if (m) {
                let dd = m[1].padStart(2, '0');
                let mm = m[2].padStart(2, '0');
                let yy = m[3].length === 2 ? '20' + m[3] : m[3];
                return new Date(`${yy}-${mm}-${dd}`);
            }
            return null;
        };

        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();

        const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
        const expenses = JSON.parse(localStorage.getItem('optixExpenses')) || [];
        const prescriptions = JSON.parse(localStorage.getItem('optixPrescriptions')) || [];

        let todaySales = 0;
        let todayCollection = 0;
        let monthSales = 0;
        let totalPending = 0;
        let pendingCount = 0;
        let monthBillCount = 0;
        let todayExpense = 0;
        let todayEyeTests = 0;

        orders.forEach(o => {
            const oDate = parseDateLoose(o.date);
            const validDate = oDate && !isNaN(oDate.getTime());
            const oDateStr = validDate ? oDate.toISOString().split('T')[0] : null;

            const amount = num(o.amount);
            const paid = num(o.paid);
            const balance = amount - paid;
            const status = (o.status || "").toLowerCase();
            if (balance > 0 && status !== "cancelled") {
                totalPending += balance;
                pendingCount += 1;
            }
            if (validDate && oDateStr === todayStr) {
                todaySales += amount;
                todayCollection += paid;
            }
            if (validDate && oDate.getMonth() === currentMonth && oDate.getFullYear() === currentYear) {
                monthSales += amount;
                monthBillCount++;
            }
        });

        expenses.forEach(e => {
            const eDate = parseDateLoose(e.date);
            const validDate = eDate && !isNaN(eDate.getTime());
            const eDateStr = validDate ? eDate.toISOString().split('T')[0] : null;
            if (eDateStr === todayStr) {
                todayExpense += num(e.amount);
            }
        });

        prescriptions.forEach(rx => {
            const rxDate = parseDateLoose(rx.rxDate || rx.rxDateTime);
            const validDate = rxDate && !isNaN(rxDate.getTime());
            const rxStr = validDate ? rxDate.toISOString().split('T')[0] : null;
            if (rxStr === todayStr) todayEyeTests += 1;
        });

        const pendingValEl = document.getElementById('dash-pending-val');
        const pendingBalEl = document.getElementById('dash-pending-balance');
        const pendingCountEl = document.getElementById('dash-pending-count');
        if(pendingValEl) {
            pendingValEl.innerText = "Rs " + totalPending.toFixed(2);
            pendingValEl.style.color = totalPending > 0 ? "red" : "green";
        }
        if(pendingBalEl) {
            pendingBalEl.innerText = "Rs " + totalPending.toFixed(2);
            pendingBalEl.style.color = totalPending > 0 ? "red" : "green";
        }
        if(pendingCountEl) {
            pendingCountEl.innerText = pendingCount;
            pendingCountEl.style.color = pendingCount > 0 ? "red" : "green";
        }

        const colEl = document.getElementById('dash-collection');
        if(colEl) {
            colEl.innerText = "Rs " + todayCollection.toFixed(2);
            colEl.style.color = todayCollection > 0 ? "green" : "red";
        }

        if(document.getElementById('dash-today-sales')) {
            document.getElementById('dash-today-sales').innerText = "Rs " + todaySales.toFixed(2);
        }
        if(document.getElementById('dash-expenses')) {
            document.getElementById('dash-expenses').innerText = "Rs " + todayExpense.toFixed(2);
        }
        const eyeEl = document.getElementById('dash-eye-tests');
        if (eyeEl) {
            eyeEl.innerText = todayEyeTests;
            eyeEl.style.color = todayEyeTests > 0 ? "green" : "red";
        }

        if(document.getElementById('dash-total-sales')) {
            document.getElementById('dash-total-sales').innerText = "Rs " + monthSales.toFixed(2);
        }
        if(document.getElementById('dash-bill-count')) {
            document.getElementById('dash-bill-count').innerText = monthBillCount;
        }
    } catch (err) {
        console.error('loadDashboard recompute error', err);
    }

    // --- BIRTHDAY LOGIC START ---
    const customers = JSON.parse(localStorage.getItem('optixCustomers')) || [];
    const birthdayListEl = document.getElementById('birthday-list');
    
    if (birthdayListEl) {
        birthdayListEl.innerHTML = ""; // Clear list
        let foundBirthday = false;

        customers.forEach(c => {
            if (!c.dob) return;

            const birthDate = new Date(c.dob);
            // We compare Month and Date only (ignoring year)
            const bMonth = birthDate.getMonth(); 
            const bDay = birthDate.getDate();

            // Check if birthday is today or within next 7 days
            // Note: Simple logic for same month/year transition
            const currentMonth = now.getMonth();
            const currentDay = now.getDate();
            
            // Check matching month
            if (bMonth === currentMonth) {
                const diff = bDay - currentDay;
                if (diff >= 0 && diff <= 7) {
                    foundBirthday = true;
                    let msg = diff === 0 ? "TODAY!" : `in ${diff} days`;
                    let color = diff === 0 ? "red" : "green";
                    
                    birthdayListEl.insertAdjacentHTML('beforeend', `
                        <div style="border-bottom:1px solid #eee; padding:5px; font-size:12px;">
                            <strong>${c.name}</strong> (${c.phone})<br>
                            <span style="color:${color}; font-weight:bold;">🎂 ${msg} (${bDay}/${bMonth + 1})</span>
                            <a href="https://wa.me/91${c.phone}?text=Happy Birthday ${c.name}! Wishing you clear vision and happiness." target="_blank" style="float:right; text-decoration:none;">🎈 Wish</a>
                        </div>
                    `);
                }
            }
        });

        if (!foundBirthday) {
            birthdayListEl.innerHTML = '<div style="padding:10px; text-align:center; color:#999; font-style:italic;">No birthdays in next 7 days</div>';
        }
    }
    // --- BIRTHDAY LOGIC END ---
}

// --- HIGH SPEED SALES HISTORY LOADER (HANDLES BOTH VIEWS) ---
function loadSalesHistory() {
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    
    // 1. Standalone Page View (Simple 6-Column Layout WITH Icons)
    const standaloneTbody = document.getElementById('salesHistoryBody');
    if (standaloneTbody) {
        let htmlContent = "";
        orders.reverse().forEach((o, index) => {
            const balance = o.amount - o.paid;
            
            // We use the action-grid classes here to bring back the colourful icons
            htmlContent += `
                <tr>
                    <td>${new Date(o.date).toLocaleDateString()}</td>
                    <td>${o.name}</td>
                    <td>Rs ${o.amount}</td>
                    <td>Rs ${o.paid}</td>
                    <td style="color:${balance > 0 ? 'red' : 'green'}; font-weight:bold;">Rs ${balance.toFixed(2)}</td>
                    <td>
                        <div class="action-grid" style="display:flex; gap:5px; justify-content:center;">
                            <button onclick="confirmOrder('${o.id}')" class="act-btn ic-check" title="Confirm" style="border:none;"><i class="fas fa-check"></i></button>
                            <button onclick="editOrder('${o.id}')" class="act-btn ic-edit" title="Edit" style="border:none;"><i class="fas fa-edit"></i></button>
                            <button onclick="sendInvoiceWhatsApp('${o.id}')" class="act-btn ic-whatsapp" title="Send WhatsApp" style="border:none;"><i class="fab fa-whatsapp"></i></button>
                            <button onclick="openInvoiceNewTab('${o.id}')" class="act-btn ic-print" title="Print" style="border:none;"><i class="fas fa-print"></i></button>
                        </div>
                    </td>
                </tr>
            `;
        });
        standaloneTbody.innerHTML = htmlContent;
        return; 
    }

    // 2. Dashboard Tab View (Advanced 10-Column Layout)
    const dashboardTbody = document.getElementById('historyTableBody');
    if (dashboardTbody) {
        const filters = typeof getSalesFilters === 'function' ? getSalesFilters() : {};
        const filtered = typeof filterOrders === 'function' ? filterOrders(orders, filters) : orders;
        
        let htmlContent = "";
        filtered.slice().reverse().forEach((o, index) => {
            const status = o.status || "Pending";
            if (status !== "Confirmed" && status !== "Paid") return; 

            if (typeof renderOrderRow === 'function') {
                htmlContent += renderOrderRow(o, index, {
                    showConfirm: false,
                    showAdvanceReceipt: false,
                    showDelete: false
                });
            }
        });
        dashboardTbody.innerHTML = htmlContent;
    }
}
// --- CUSTOMER SEARCH & AUTO-SUGGESTION ---

function openSearchModal() {
    document.getElementById('searchCustomerModal').style.display = 'flex';
    document.getElementById('searchResults').style.display = 'none';
    document.getElementById('searchName').value = '';
    document.getElementById('searchPhone').value = '';
    document.getElementById('searchName').focus();
}

function closeSearchModal() {
    document.getElementById('searchCustomerModal').style.display = 'none';
}

// Auto-Suggestion Logic
function suggestCustomer(type) {
    const inputVal = type === 'name' ? document.getElementById('searchName').value.toLowerCase() : document.getElementById('searchPhone').value;
    const box = type === 'name' ? document.getElementById('suggestName') : document.getElementById('suggestPhone');
    
    // Clear if empty
    if(inputVal.length < 1) {
        box.style.display = 'none';
        return;
    }

    // Get Data
    const customers = JSON.parse(localStorage.getItem('optixCustomers')) || [];
    
    // Filter Data
    const matches = customers.filter(c => {
        if(type === 'name') return c.name.toLowerCase().includes(inputVal);
        else return c.phone.includes(inputVal);
    });

    // Show Suggestions
    if(matches.length > 0) {
        box.innerHTML = matches.map(c => `
            <div class="suggestion-item" onclick="selectCustomer('${c.name}', '${c.phone}')">
                <strong>${c.name}</strong> - ${c.phone}
            </div>
        `).join('');
        box.style.display = 'block';
    } else {
        box.style.display = 'none';
    }
}

// When a suggestion is clicked
function selectCustomer(name, phone) {
    document.getElementById('searchName').value = name;
    document.getElementById('searchPhone').value = phone;
    document.querySelectorAll('.suggestion-box').forEach(b => b.style.display = 'none'); // Hide boxes
    performFullSearch(); // Auto trigger search
}

// --- ADVANCED CUSTOMER SEARCH ENGINE ---
function performFullSearch() {
    const nameInput = document.getElementById('searchName').value.toLowerCase().trim();
    const phoneInput = document.getElementById('searchPhone').value.trim();
    
    const customers = JSON.parse(localStorage.getItem('optixCustomers')) || [];
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const prescriptions = JSON.parse(localStorage.getItem('optixRx')) || []; // Assuming Rx is saved here
    const resultDiv = document.getElementById('searchResults');
    
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = '';

    // 1. Find Customer
    const found = customers.find(c => 
        (nameInput && c.name.toLowerCase().includes(nameInput)) || 
        (phoneInput && c.phone.includes(phoneInput))
    );

    if (!found) {
        resultDiv.innerHTML = '<div style="padding:20px; text-align:center; color:red;"><i class="fas fa-exclamation-circle"></i> Customer Not Found. <button onclick="window.location.href=\'customer.html\'">Add New Customer</button></div>';
        return;
    }

    // 2. Gather History Data
    // Filter orders for this customer
    const custOrders = orders.filter(o => o.phone === found.phone || o.name === found.name);
    
    // Filter Rx for this customer
    const custRx = prescriptions.filter(r => (r.mobile && r.mobile === found.phone) || r.name === found.name);
    const lastRx = custRx.length > 0 ? custRx[custRx.length - 1] : null; // Get latest Rx

    // Calculate Financials
    let totalPurchase = 0;
    let totalPaid = 0;
    custOrders.forEach(o => {
        totalPurchase += (parseFloat(o.amount) || 0);
        totalPaid += (parseFloat(o.paid) || 0);
    });
    const outstanding = totalPurchase - totalPaid;
    const balanceColor = outstanding > 0 ? 'red' : 'green';

    // 3. Build the "Professional View" HTML
    let html = `
        <div class="cust-profile-header">
            <h2><i class="fas fa-user-circle"></i> ${found.name}</h2>
            <div class="balance-tag" style="color:${balanceColor}">
                Outstanding Balance: Rs ${outstanding.toFixed(2)}
            </div>
        </div>

        <div class="cust-info-bar">
            <div><strong>Mobile:</strong> ${found.phone}</div>
            <div><strong>Location:</strong> ${found.city || 'N/A'}</div>
            <div><strong>Gender:</strong> ${found.gender || 'N/A'}</div>
            <div><strong>Created:</strong> ${new Date(found.id || Date.now()).toLocaleDateString()}</div>
        </div>
    `;

    // --- SECTION: ORDER HISTORY ---
    html += `<div class="section-title">📦 Order History</div>`;
    if (custOrders.length > 0) {
        html += `<table class="data-table">
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Order No</th>
                    <th>Amount</th>
                    <th>Paid</th>
                    <th>Balance</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>`;
        
        custOrders.forEach(o => {
            const bal = o.amount - o.paid;
            // UPDATED: Added onclick event to open specific invoice
            html += `<tr>
                <td>${new Date(o.date).toLocaleDateString()}</td>
                <td>
                    <a href="#" onclick="openInvoiceNewTab('${o.id}'); return false;" 
                       style="color:#0277bd; font-weight:bold; text-decoration:underline;">
                       ${o.id} <i class="fas fa-external-link-alt" style="font-size:10px;"></i>
                    </a>
                </td>
                <td>Rs ${o.amount}</td>
                <td>Rs ${o.paid}</td>
                <td style="color:${bal > 0 ? 'red' : 'green'}">Rs ${bal.toFixed(2)}</td>
                <td>${bal <= 0 ? '<span style="background:green; color:white; padding:1px 5px; border-radius:3px; font-size:10px">Paid</span>' : '<span style="background:orange; padding:1px 5px; border-radius:3px; font-size:10px">Due</span>'}</td>
            </tr>`;
        });
        html += `</tbody></table>`;
    } else {
        html += `<div style="padding:10px; color:#666; font-style:italic;">No previous orders found.</div>`;
    }

    // --- SECTION: EYEWEAR DETAILS (Latest Rx) ---
    if (lastRx) {
        html += `<div class="section-title">👓 Latest Eyewear Details (${new Date(lastRx.date).toLocaleDateString()})</div>
        <div class="eye-grid">
            <div class="eye-box">
                <div class="eye-header">RIGHT EYE (OD)</div>
                <div class="eye-row"><div class="eye-cell eye-label">DV</div><div class="eye-cell">${lastRx.r_sph || '-'}</div><div class="eye-cell">${lastRx.r_cyl || '-'}</div><div class="eye-cell">${lastRx.r_axis || '-'}</div><div class="eye-cell">${lastRx.r_va || '-'}</div></div>
                <div class="eye-row"><div class="eye-cell eye-label">NV</div><div class="eye-cell">${lastRx.r_nv_sph || '-'}</div><div class="eye-cell">${lastRx.r_nv_cyl || '-'}</div><div class="eye-cell">${lastRx.r_nv_axis || '-'}</div><div class="eye-cell">${lastRx.r_nv_va || '-'}</div></div>
            </div>
            <div class="eye-box">
                <div class="eye-header">LEFT EYE (OS)</div>
                <div class="eye-row"><div class="eye-cell eye-label">DV</div><div class="eye-cell">${lastRx.l_sph || '-'}</div><div class="eye-cell">${lastRx.l_cyl || '-'}</div><div class="eye-cell">${lastRx.l_axis || '-'}</div><div class="eye-cell">${lastRx.l_va || '-'}</div></div>
                <div class="eye-row"><div class="eye-cell eye-label">NV</div><div class="eye-cell">${lastRx.l_nv_sph || '-'}</div><div class="eye-cell">${lastRx.l_nv_cyl || '-'}</div><div class="eye-cell">${lastRx.l_nv_axis || '-'}</div><div class="eye-cell">${lastRx.l_nv_va || '-'}</div></div>
            </div>
        </div>`;
    }

    // --- ACTION BUTTONS ---
    html += `
        <div style="margin-top:15px; text-align:right; border-top:1px dashed #ccc; padding-top:10px;">
            <button onclick="loadCustomerToBill('${found.name}', '${found.phone}')" style="background:#4caf50; color:white; border:none; padding:8px 15px; font-size:13px; cursor:pointer; border-radius:3px;">
                <i class="fas fa-cart-plus"></i> Create New Order
            </button>
            <a href="https://wa.me/91${found.phone}" target="_blank" style="background:#25D366; color:white; text-decoration:none; padding:8px 15px; font-size:13px; border-radius:3px; margin-left:10px;">
                <i class="fab fa-whatsapp"></i> WhatsApp Chat
            </a>
        </div>
    `;

    resultDiv.innerHTML = html;
}

// Helper to start order
function loadCustomerToBill(name, phone) {
    localStorage.setItem('tempCustName', name);
    localStorage.setItem('tempCustPhone', phone);
    window.location.href = 'order.html';
}
// --- NEW FUNCTION: Open Invoice in New Tab ---
function openInvoiceNewTab(orderId) {
    const order = findOrderById(orderId);
    window.open(buildInvoiceUrl(orderId, { order }), '_blank');
}
// --- 1. TOGGLE FIELDS BASED ON TYPE ---
function toggleFields() {
    const type = document.getElementById('nType').value;
    const frameParams = document.getElementById('frameParams');
    
    // Hide frame specific details for Solution/Other/Box
    if(type === 'Solution' || type === 'Box' || type === 'Other') {
        frameParams.style.display = 'none';
        // Clear values to avoid confusion
        document.getElementById('nSize').value = "";
        document.getElementById('nShape').value = "";
    } else {
        frameParams.style.display = 'flex';
    }
}

// --- 2. ADVANCED SAVE INVENTORY ---
async function saveNewInventory() {
    const type = document.getElementById('nType').value;
    const name = document.getElementById('nName').value;
    const qty = parseInt(document.getElementById('nQty').value) || 1;
    const barcodeOpt = document.querySelector('input[name="barcodeOpt"]:checked').value;
    
    if(!name) { alert("Product Name is required"); return; }

    const products = JSON.parse(localStorage.getItem('optixProducts')) || [];
    const baseCode = document.getElementById('nCode').value;

    // --- LOGIC A: UNIQUE BARCODES (10 items = 10 rows) ---
    if (barcodeOpt === 'unique') {
        for(let i=0; i<qty; i++) {
            const newProd = {
                id: Date.now() + i,
                category: type,
                code: baseCode ? (baseCode + "-" + (i+1)) : generateBarcode(), // If manual code, append -1, -2
                name: name,
                brand: document.getElementById('nBrand').value,
                color: document.getElementById('nColor').value || "-",
                size: document.getElementById('nSize').value || "-",
                gender: document.getElementById('nGender').value,
                material: document.getElementById('nMaterial').value || "-",
                shape: document.getElementById('nShape').value || "-",
                buyPrice: parseFloat(document.getElementById('nBuy').value) || 0,
                sellPrice: parseFloat(document.getElementById('nSell').value) || 0,
                qty: 1, // Individual unit
                createdOn: new Date().toLocaleString(),
                status: 'Active'
            };
            if (db) {
                try {
                    const cloudSaved = await saveProductToCloud(newProd);
                    products.push(cloudSaved || newProd);
                } catch (err) {
                    console.error("Cloud save failed for product.", err);
                    alert("Cloud save failed. Product was not added.");
                    return;
                }
            } else {
                products.push(newProd);
            }
        }
        alert(`Success! Added ${qty} unique items.`);
    } 
    // --- LOGIC B: COMMON BARCODE (10 items = 1 row with qty 10) ---
    else {
        const newProd = {
            id: Date.now(),
            category: type,
            code: baseCode || generateBarcode(),
            name: name,
            brand: document.getElementById('nBrand').value,
            color: document.getElementById('nColor').value,
            size: document.getElementById('nSize').value,
            gender: document.getElementById('nGender').value,
            material: document.getElementById('nMaterial').value,
            shape: document.getElementById('nShape').value,
            buyPrice: parseFloat(document.getElementById('nBuy').value) || 0,
            sellPrice: parseFloat(document.getElementById('nSell').value) || 0,
            qty: qty, // Bulk quantity
            createdOn: new Date().toLocaleString(),
            status: 'Active'
        };
        if (db) {
            try {
                const cloudSaved = await saveProductToCloud(newProd);
                products.push(cloudSaved || newProd);
            } catch (err) {
                console.error("Cloud save failed for product.", err);
                alert("Cloud save failed. Product was not added.");
                return;
            }
        } else {
            products.push(newProd);
        }
        alert(`Success! Added 1 entry with ${qty} units.`);
    }

    localStorage.setItem('optixProducts', JSON.stringify(products));
    document.getElementById('addModal').style.display = 'none';
    resetProductModalForAdd();
    await loadProducts(); // Refresh list
}

// --- COMPLETE INVENTORY AUDIT SYSTEM (With Excel/PDF) ---

let auditData = []; // Stores the temporary audit session

// 1. Initialize Audit (Loads automatically when page opens)
function initAudit() {
    console.log("Audit Initialized"); // Debug check
    
    // Get Products
    const products = JSON.parse(localStorage.getItem('optixProducts')) || [];
    const tbody = document.getElementById('auditTableBody');
    
    // If we are not on the audit page, stop running
    if(!tbody) return;

    // Reset Data
    auditData = [];
    let stockMap = {};

    // Group Products by Barcode
    products.forEach(p => {
        // Use Barcode as key. If no barcode, use ID.
        const key = p.code ? p.code.trim() : "NO-CODE";
        
        if (!stockMap[key]) {
            stockMap[key] = { 
                code: key, 
                name: p.brand + ' ' + p.name, 
                sysQty: 0, 
                scanQty: 0 
            };
        }
        stockMap[key].sysQty += parseInt(p.qty) || 0;
    });

    auditData = Object.values(stockMap);
    renderAuditTable();
}

// 2. Handle Barcode Scan
function handleScan(input) {
    const code = input.value.trim();
    if(!code) return;

    // Find Item
    const item = auditData.find(i => i.code.toLowerCase() === code.toLowerCase());

    if (item) {
        item.scanQty++;
    } else {
        // Item not in system (Extra)
        auditData.unshift({
            code: code,
            name: "Unknown Item (Not in DB)",
            sysQty: 0,
            scanQty: 1
        });
        // Play error sound or alert
        // alert("Warning: Unknown Item!");
    }

    input.value = ""; // Clear Input
    input.focus(); // Keep Focus
    renderAuditTable();
}

// 3. Render the Table
function renderAuditTable() {
    const tbody = document.getElementById('auditTableBody');
    if(!tbody) return;
    tbody.innerHTML = "";

    let totalSys = 0;
    let totalScan = 0;
    let totalVar = 0;

    // Sort: Variance First
    auditData.sort((a, b) => {
        const diffA = Math.abs(a.sysQty - a.scanQty);
        const diffB = Math.abs(b.sysQty - b.scanQty);
        return diffB - diffA; 
    });

    auditData.forEach(item => {
        const variance = item.scanQty - item.sysQty;
        let status = "MATCHED";
        let rowClass = "status-match";
        let varColor = "green";

        if (variance < 0) {
            status = `MISSING (${Math.abs(variance)})`;
            rowClass = "status-missing";
            varColor = "red";
        } else if (variance > 0) {
            status = "EXTRA FOUND";
            rowClass = "status-extra";
            varColor = "blue";
        }

        totalSys += item.sysQty;
        totalScan += item.scanQty;
        if(variance !== 0) totalVar++;

        const row = `
            <tr class="${variance !== 0 ? rowClass : ''}">
                <td style="font-weight:bold">${item.code}</td>
                <td>${item.name}</td>
                <td>${item.sysQty}</td>
                <td style="font-weight:bold; font-size:14px; color:blue;">${item.scanQty}</td>
                <td style="font-weight:bold; color:${varColor}">${variance > 0 ? '+'+variance : variance}</td>
                <td>${status}</td>
            </tr>
        `;
        tbody.insertAdjacentHTML('beforeend', row);
    });

    // Update Top Stats
    if(document.getElementById('sysCount')) document.getElementById('sysCount').innerText = totalSys;
    if(document.getElementById('scanCount')) document.getElementById('scanCount').innerText = totalScan;
    if(document.getElementById('varCount')) document.getElementById('varCount').innerText = totalVar;
}

// --- NEW EXPORT FUNCTIONS ---

function exportToExcel() {
    if(typeof XLSX === 'undefined') { alert("Internet required for Excel export!"); return; }
    if(auditData.length === 0) { alert("No data to export!"); return; }

    const excelData = auditData.map(item => ({
        "Barcode": item.code,
        "Product Name": item.name,
        "System Qty": item.sysQty,
        "Scanned Qty": item.scanQty,
        "Variance": item.scanQty - item.sysQty,
        "Status": (item.scanQty - item.sysQty) === 0 ? "Matched" : "Discrepancy"
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(wb, ws, "Audit Report");
    XLSX.writeFile(wb, "Inventory_Audit_" + new Date().toLocaleDateString() + ".xlsx");
}

function exportToPDF() {
    if(typeof html2pdf === 'undefined') { alert("Internet required for PDF export!"); return; }
    
    const element = document.getElementById('reportContent');
    const opt = {
        margin: 0.2,
        filename: 'Audit_Report.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2 },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
    };
    html2pdf().set(opt).from(element).save();
}
// --- NEW ORDER PAGE LOGIC ---

let activeRow = null; // Tracks which row opened the modal
let editingOrderId = null;
let editingOriginalOrder = null;
let editingExistingPaidCash = 0;
let editingExistingPaidUpi = 0;
let editingExistingPaidBank = 0;
let activeRxOrderId = null;
let activeRxItemIndex = null;
let activeSavedLensPrescriptions = [];

function isPendingPaymentIncrementMode() {
    return editingOrderId !== null
        && editingOriginalOrder
        && (editingOriginalOrder.status || "").toLowerCase().trim() === "pending";
}

function isConfirmPaymentFlow() {
    try {
        const params = new URLSearchParams(window.location.search);
        return params.get('mode') === 'confirm';
    } catch (e) {
        return false;
    }
}

function formatFY(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    if (isNaN(d)) return "FY" + new Date().getFullYear() + "-" + String(new Date().getFullYear() + 1).slice(-2);
    const year = d.getFullYear();
    const month = d.getMonth(); // 0-based
    const startYear = month >= 3 ? year : year - 1; // FY starts in April
    const endYear = startYear + 1;
    return `FY${startYear}-${String(endYear).slice(-2)}`;
}

function formatOrderNo(order) {
    const fy = formatFY(order && order.date);
    const id = order && order.id ? order.id : "";
    return `${fy}/${id}`;
}

function formatOrderNoShort(order) {
    const settings = getSettings();
    const no = (settings.autoInvoiceNo !== false && order && order.invoiceNo) ? order.invoiceNo.toString() : "";
    if (no) return `INV-${no.padStart(6, '0')}`;
    const id = order && order.id ? order.id.toString() : "";
    return `INV-${id.slice(-6)}`;
}

function getNextInvoiceNo() {
    const key = 'optixInvoiceSeq';
    let seq = parseInt(localStorage.getItem(key), 10);
    if (!seq || seq < 1) seq = 1;
    localStorage.setItem(key, String(seq + 1));
    return seq;
}

function computeOrderTotals(order) {
    const items = (order && order.items) ? order.items : [];
    let gross = 0;
    let net = 0;
    items.forEach(item => {
        const qty = parseFloat(item.qty) || 0;
        const price = parseFloat(item.price) || 0;
        const total = parseFloat(item.total) || 0;
        gross += qty * price;
        net += total;
    });
    const rowDiscount = gross - net;
    const extraDiscount = parseFloat(order && order.discount) || 0;
    const totalDiscount = rowDiscount + extraDiscount;
    return { gross, net, rowDiscount, extraDiscount, totalDiscount };
}

async function initOrderPage() {
    const orderDate = document.getElementById('orderDate');
    if (orderDate && !getManagedDateValue(orderDate)) {
        setManagedDateValue(orderDate, new Date());
    }
    initOrderDateInputs();

    const urlParams = new URLSearchParams(window.location.search);
    const editId = urlParams.get('editId');
    if (editId) {
        await loadOrderForEdit(editId);
        return;
    }

    // --- NEW CODE: PREVIEW THE NEXT INVOICE NUMBER ---
    try {
        const settings = getSettings();
        if (settings.autoInvoiceNo !== false) {
            let seq = parseInt(localStorage.getItem('optixInvoiceSeq'), 10);
            if (!seq || seq < 1) seq = 1;
            const displayBox = document.getElementById('orderNoDisplay');
            if (displayBox) {
                displayBox.value = `INV-${String(seq).padStart(6, '0')}`;
            }
        }
    } catch (e) {
        console.error('Invoice preview failed:', e);
    }
    // -------------------------------------------------

    editingExistingPaidCash = 0;
    editingExistingPaidUpi = 0;
    editingExistingPaidBank = 0;

    const tbody = document.getElementById('billTableBody');
    if (tbody && tbody.children.length === 0) addNewRow();
}

function setOrderHeaderForEdit(order) {
    const title = document.getElementById('orderPageTitle');
    if (title) title.textContent = "Edit Pending Order";

    const orderNo = document.getElementById('orderNoDisplay');
    if (orderNo) orderNo.value = formatOrderNo(order);

    document.querySelectorAll('.edit-hide').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.edit-only').forEach(el => el.style.display = 'inline-block');
}

async function loadOrderForEdit(id) {
    let orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    let order = orders.find(o => o.id == id);
    if (!order && db) {
        try {
            const snap = await db.collection('orders').doc(String(id)).get();
            if (snap.exists) {
                order = { ...snap.data(), _docId: snap.id };
                upsertEntityInCache('optixOrders', order);
            }
        } catch (err) {
            console.error("Order cloud lookup failed:", err);
        }
    }
    if (!order) { alert("Order not found."); return; }

    editingOrderId = order.id;
    editingOriginalOrder = JSON.parse(JSON.stringify(order));
    setOrderHeaderForEdit(order);

    const orderDate = document.getElementById('orderDate');
    if (orderDate) setManagedDateValue(orderDate, toLocalDateStr(new Date(order.date)));
    const deliveryDate = document.getElementById('deliveryDate');
    if (deliveryDate) {
        const fallbackDelivery = order.date ? toLocalDateStr(new Date(new Date(order.date).getTime() + 86400000)) : '';
        setManagedDateValue(deliveryDate, order.deliveryDate || fallbackDelivery);
    }

    if (document.getElementById('cName')) document.getElementById('cName').value = order.name || "";
    if (document.getElementById('cPhone')) document.getElementById('cPhone').value = order.phone || "";

    const tbody = document.getElementById('billTableBody');
    if (tbody) tbody.innerHTML = "";

    if (order.items && order.items.length > 0) {
        order.items.forEach(item => {
            addNewRow();
            const row = tbody.lastElementChild;
            if (!row) return;

            const barcode = item.barcode || "";
            const code = item.code || "";
            const desc = item.desc || "";
            const qty = parseFloat(item.qty) || 0;
            const price = parseFloat(item.price) || 0;
            const disc = parseFloat(item.disc) || 0;
            const subtotal = qty * price;
            const discAmt = parseFloat(item.discAmt) || ((subtotal * disc) / 100);

            row.querySelector('.barcode').value = barcode;
            row.querySelector('.p-type').value = item.type || "";
            row.querySelector('.p-code').value = code;
            row.querySelector('.desc').value = desc;
            row.querySelector('.qty').value = qty;
            row.querySelector('.price').value = price;
            row.querySelector('.row-disc').value = disc;
            row.querySelector('.row-disc-amt').value = discAmt.toFixed(2);
            row.dataset.discountMode = discAmt > 0 ? 'amount' : 'percent';

            const rxData = item.rx ? (typeof item.rx === "string" ? item.rx : JSON.stringify(item.rx)) : "";
            row.querySelector('.row-rx-data').value = rxData;

            calcRow(row.querySelector('.price'));
        });
    } else {
        addNewRow();
    }

    editingExistingPaidCash = parseFloat(order.paidCash) || 0;
    editingExistingPaidUpi = parseFloat(order.paidUpi) || 0;
    editingExistingPaidBank = parseFloat(order.paidBank) || 0;
    const incrementMode = isPendingPaymentIncrementMode() || isConfirmPaymentFlow();
    if (document.getElementById('payCash')) {
        document.getElementById('payCash').value = incrementMode ? 0 : editingExistingPaidCash;
        document.getElementById('payCash').min = "0";
    }
    if (document.getElementById('payUPI')) {
        document.getElementById('payUPI').value = incrementMode ? 0 : editingExistingPaidUpi;
        document.getElementById('payUPI').min = "0";
    }
    if (document.getElementById('payBank')) {
        document.getElementById('payBank').value = incrementMode ? 0 : editingExistingPaidBank;
        document.getElementById('payBank').min = "0";
    }
    const baseTotal = (order.items || []).reduce((sum, it) => sum + (parseFloat(it.total) || 0), 0);
    const discAmt = parseFloat(order.discount) || 0;
    if (document.getElementById('txtDiscAmount')) document.getElementById('txtDiscAmount').value = discAmt.toFixed(2);
    if (document.getElementById('txtDiscPercent')) {
        const pct = baseTotal > 0 ? (discAmt / baseTotal) * 100 : 0;
        document.getElementById('txtDiscPercent').value = pct.toFixed(2);
    }
    if (document.getElementById('txtRoundOff')) document.getElementById('txtRoundOff').value = (parseFloat(order.roundOff) || 0).toFixed(2);

    calculateFinal();

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('rxEdit') === '1') {
        const modal = document.getElementById('modalLens');
        if (modal) {
            populateRxItemSelect();
            syncLensCustomerFieldsFromOrder(true);
            populateSavedLensPrescriptionSelect();
            modal.style.display = 'flex';
        }
    }
}

// 1. Add New Row
function addNewRow() {
    const tbody = document.getElementById('billTableBody');
    const count = tbody.children.length + 1;
    
    const row = `
        <tr class="item-row">
            <td>${count}</td>
            <td><input type="text" class="barcode" onchange="scanBarcode(this)" placeholder="Scan"></td>
            <td>
                <select class="p-type" onchange="handleProductType(this)">
                    <option value="">Type</option>
                    <option value="Frame">Frame</option>
                    <option value="Lens">Lens</option>
                    <option value="Contact Lens">CL</option>
                    <option value="Sunglasses">Sun GLS</option>
                    <option value="Solution">Soln</option>
                    <option value="Other">Other</option>
                </select>
            </td>
            <td><input type="text" class="p-code" readonly></td>
            <td>
                <input type="text" class="desc">
                <input type="hidden" class="row-rx-data">
            </td>
            <td><input type="number" class="qty" value="1" oninput="calcRow(this)" style="text-align:center"></td>
            <td><input type="number" class="price" value="0" oninput="calcRow(this)"></td>
            
            <td><input type="number" class="row-disc" value="0" oninput="calcRow(this, 'percent')" style="text-align:center; color:red;"></td>
            <td><input type="number" class="row-disc-amt" value="0" oninput="calcRow(this, 'amount')" style="text-align:right; color:red;"></td>
            
            <td><input type="text" class="row-total" readonly style="font-weight:bold"></td>
            <td style="text-align:center"><i class="fas fa-trash" style="color:red; cursor:pointer;" onclick="this.closest('tr').remove(); calculateFinal()"></i></td>
        </tr>
    `;
    tbody.insertAdjacentHTML('beforeend', row);
}

// 2. Handle Dropdown Change
function handleProductType(selectEl) {
    if (!selectEl) return;
    activeRow = selectEl.closest('tr');
    if (!activeRow) return;
    const type = selectEl.value;
    const setIfExists = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    };

    // Open FRAME Modal for both Frame AND Sunglasses
    if (type === 'Frame' || type === 'Sunglasses') {
        const modal = document.getElementById('modalFrame');
        if (modal) modal.style.display = 'flex';
        // Clear fields
        ['frCode','frBrand','frName','frSize','frColor','frMaterial','frPrice','frDisc'].forEach(id => setIfExists(id, ''));
    } 
    // Open LENS Modal for Lens AND Contact Lens
    else if (type === 'Lens' || type === 'Contact Lens') {
        const modal = document.getElementById('modalLens');
        if (modal) modal.style.display = 'flex';
        // Clear fields
        ['lnCode','lnBrand','lnIndex','lnCoating','lnDesign','lnPrice','lnDisc'].forEach(id => setIfExists(id, ''));
        const lnCustName = document.getElementById('lnCustName');
        const lnCustPhone = document.getElementById('lnCustPhone');
        if (lnCustName) lnCustName.value = "";
        if (lnCustPhone) lnCustPhone.value = "";
        ['rx_r_sph','rx_r_cyl','rx_r_axis','rx_r_pd','rx_r_va','rx_r_nv_sph','rx_r_nv_cyl','rx_r_nv_axis','rx_r_nv_pd','rx_r_nv_va','rx_r_add',
         'rx_l_sph','rx_l_cyl','rx_l_axis','rx_l_pd','rx_l_va','rx_l_nv_sph','rx_l_nv_cyl','rx_l_nv_axis','rx_l_nv_pd','rx_l_nv_va','rx_l_add'
        ].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        ['use_constant','use_distance','use_reading','use_computer'].forEach(id => { const el = document.getElementById(id); if (el) el.checked = false; });
        const rxWrap = document.getElementById('rxSelectWrap');
        if (rxWrap) rxWrap.style.display = 'none';
        syncLensCustomerFieldsFromOrder(true);
        populateSavedLensPrescriptionSelect();
        initLensRxAutoCalc();
    } else if (type === 'Solution' || type === 'Other' || type === 'Box') {
        const modal = document.getElementById('modalFrame');
        if (modal) modal.style.display = 'flex';
        ['frCode','frBrand','frName','frSize','frColor','frMaterial','frPrice','frDisc'].forEach(id => setIfExists(id, ''));
    }
}

// 3. Close Modals
function closeModal(id) {
    document.getElementById(id).style.display = 'none';
}

function initLensRxAutoCalc() {
    const bind = (id, eye) => {
        const el = document.getElementById(id);
        if (!el || el.dataset.bound === "1") return;
        el.addEventListener('input', () => updateNearVision(eye));
        el.dataset.bound = "1";
    };

    ['rx_r_sph','rx_r_cyl','rx_r_axis','rx_r_add'].forEach(id => bind(id, 'r'));
    ['rx_l_sph','rx_l_cyl','rx_l_axis','rx_l_add'].forEach(id => bind(id, 'l'));
    updateNearVision('r');
    updateNearVision('l');
}

function parseRxValue(val) {
    if (!val) return null;
    if (typeof val === "object") return val;
    if (typeof val === "string") {
        try {
            const first = JSON.parse(val);
            if (typeof first === "string") {
                return JSON.parse(first);
            }
            return first;
        } catch (e) {
            return null;
        }
    }
    return null;
}

function parseLensDesc(desc) {
    if (!desc) return {};
    const clean = desc.replace(/^LENS\s*-\s*/i, "");
    const parts = clean.split(" - ").map(p => p.trim()).filter(Boolean);
    return {
        brand: parts[0] || "",
        type: parts[1] || "",
        coating: parts[2] || "",
        index: parts[3] || ""
    };
}

function isEyewearPrescription(rx) {
    return !!rx && (
        String(rx.type || '').toLowerCase() === 'eyewear'
        || (rx.rightEye && rx.leftEye)
    );
}

function syncLensCustomerFieldsFromOrder(force = false) {
    const lnCustName = document.getElementById('lnCustName');
    const lnCustPhone = document.getElementById('lnCustPhone');
    const orderName = document.getElementById('cName');
    const orderPhone = document.getElementById('cPhone');

    if (lnCustName && orderName && (force || !lnCustName.value.trim())) {
        lnCustName.value = orderName.value.trim();
    }
    if (lnCustPhone && orderPhone && (force || !lnCustPhone.value.trim())) {
        lnCustPhone.value = orderPhone.value.trim();
    }
}

function formatSavedLensPrescriptionOption(rx) {
    const formatEye = (eye = {}) => `${eye.sph || '-'} / ${eye.cyl || '-'} / ${eye.axis || '-'}`;
    const rawDate = rx.rxDate || rx.rxDateTime || '';
    const parsedDate = new Date(rawDate);
    const displayDate = Number.isNaN(parsedDate.getTime())
        ? (rawDate || 'No Date')
        : parsedDate.toLocaleDateString('en-IN');

    return `${displayDate} | OD ${formatEye(rx.rightEye)} | OS ${formatEye(rx.leftEye)}`;
}

function populateSavedLensPrescriptionSelect() {
    const select = document.getElementById('savedRxSelect');
    const wrap = document.getElementById('savedRxWrap');
    if (!select || !wrap) return;

    const lnCustName = document.getElementById('lnCustName');
    const lnCustPhone = document.getElementById('lnCustPhone');
    const customerName = String(lnCustName?.value || '').trim().toLowerCase();
    const customerPhone = String(lnCustPhone?.value || '').replace(/\D/g, '');

    select.innerHTML = '';
    activeSavedLensPrescriptions = [];

    if (!customerName && !customerPhone) {
        wrap.style.display = 'none';
        return;
    }

    const prescriptions = JSON.parse(localStorage.getItem('optixPrescriptions')) || [];
    activeSavedLensPrescriptions = prescriptions
        .filter(rx => {
            if (!isEyewearPrescription(rx)) return false;

            const rxName = String(rx.patName || '').trim().toLowerCase();
            const rxPhone = String(rx.patMobile || '').replace(/\D/g, '');
            const phoneMatch = customerPhone
                ? (!!rxPhone && (rxPhone === customerPhone || rxPhone.endsWith(customerPhone) || customerPhone.endsWith(rxPhone)))
                : false;
            const nameMatch = customerName ? rxName.includes(customerName) : false;

            if (customerPhone && customerName) return phoneMatch || (nameMatch && !rxPhone);
            if (customerPhone) return phoneMatch;
            return nameMatch;
        })
        .sort((a, b) => {
            const aTime = new Date(a.rxDate || a.rxDateTime || 0).getTime();
            const bTime = new Date(b.rxDate || b.rxDateTime || 0).getTime();
            return bTime - aTime;
        });

    wrap.style.display = 'grid';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = activeSavedLensPrescriptions.length
        ? 'Select previous saved prescription'
        : 'No saved prescriptions found';
    select.appendChild(placeholder);

    if (!activeSavedLensPrescriptions.length) {
        select.disabled = true;
        select.selectedIndex = 0;
        return;
    }

    activeSavedLensPrescriptions.forEach((rx, idx) => {
        const option = document.createElement('option');
        option.value = String(idx);
        option.textContent = formatSavedLensPrescriptionOption(rx);
        select.appendChild(option);
    });

    select.disabled = false;
    select.selectedIndex = 0;
}

function fillLensModalFromSavedPrescription(rx) {
    if (!rx) return;

    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val || '';
    };

    setVal('lnCustName', rx.patName);
    setVal('lnCustPhone', rx.patMobile);

    const re = rx.rightEye || {};
    const le = rx.leftEye || {};

    setVal('rx_r_sph', re.sph);
    setVal('rx_r_cyl', re.cyl);
    setVal('rx_r_axis', re.axis);
    setVal('rx_r_pd', re.pd);
    setVal('rx_r_va', re.va);
    setVal('rx_r_nv_sph', re.nvSph);
    setVal('rx_r_nv_cyl', re.nvCyl);
    setVal('rx_r_nv_axis', re.nvAxis);
    setVal('rx_r_nv_pd', re.nvPd);
    setVal('rx_r_nv_va', re.nvVa);
    setVal('rx_r_add', re.add);

    setVal('rx_l_sph', le.sph);
    setVal('rx_l_cyl', le.cyl);
    setVal('rx_l_axis', le.axis);
    setVal('rx_l_pd', le.pd);
    setVal('rx_l_va', le.va);
    setVal('rx_l_nv_sph', le.nvSph);
    setVal('rx_l_nv_cyl', le.nvCyl);
    setVal('rx_l_nv_axis', le.nvAxis);
    setVal('rx_l_nv_pd', le.nvPd);
    setVal('rx_l_nv_va', le.nvVa);
    setVal('rx_l_add', le.add);

    const usage = Array.isArray(rx.usage) ? rx.usage : [];
    const useConstant = document.getElementById('use_constant');
    const useDistance = document.getElementById('use_distance');
    const useReading = document.getElementById('use_reading');
    const useComputer = document.getElementById('use_computer');
    if (useConstant) useConstant.checked = usage.includes("Constant Use");
    if (useDistance) useDistance.checked = usage.includes("Distance Wear");
    if (useReading) useReading.checked = usage.includes("Reading Wear");
    if (useComputer) useComputer.checked = usage.includes("Computer/Office");

    initLensRxAutoCalc();
}

function handleSavedRxSelectChange(selectEl) {
    const idx = parseInt(selectEl?.value, 10);
    if (!Number.isInteger(idx) || !activeSavedLensPrescriptions[idx]) return;
    fillLensModalFromSavedPrescription(activeSavedLensPrescriptions[idx]);
}

function fillLensModalFromRow(row) {
    if (!row) return;
    activeRow = row;

    const desc = row.querySelector('.desc')?.value || "";
    const price = row.querySelector('.price')?.value || "";
    const disc = row.querySelector('.row-disc')?.value || "";
    const rxRaw = row.querySelector('.row-rx-data')?.value || "";

    const info = parseLensDesc(desc);
    const rx = parseRxValue(rxRaw) || {};

    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val || "";
    };

    setVal('lnBrand', info.brand);
    setVal('lnType', info.type);
    setVal('lnCoating', info.coating);
    setVal('lnIndex', info.index);
    setVal('lnPrice', price);
    setVal('lnDisc', disc);

    const re = rx.re || {};
    const le = rx.le || {};

    setVal('rx_r_sph', re.sph);
    setVal('rx_r_cyl', re.cyl);
    setVal('rx_r_axis', re.axis);
    setVal('rx_r_pd', re.pd);
    setVal('rx_r_va', re.va);
    setVal('rx_r_nv_sph', re.nv_sph);
    setVal('rx_r_nv_cyl', re.nv_cyl);
    setVal('rx_r_nv_axis', re.nv_axis);
    setVal('rx_r_nv_pd', re.nv_pd);
    setVal('rx_r_nv_va', re.nv_va);
    setVal('rx_r_add', re.add);

    setVal('rx_l_sph', le.sph);
    setVal('rx_l_cyl', le.cyl);
    setVal('rx_l_axis', le.axis);
    setVal('rx_l_pd', le.pd);
    setVal('rx_l_va', le.va);
    setVal('rx_l_nv_sph', le.nv_sph);
    setVal('rx_l_nv_cyl', le.nv_cyl);
    setVal('rx_l_nv_axis', le.nv_axis);
    setVal('rx_l_nv_pd', le.nv_pd);
    setVal('rx_l_nv_va', le.nv_va);
    setVal('rx_l_add', le.add);

    const usage = Array.isArray(rx.usage) ? rx.usage : [];
    const useConstant = document.getElementById('use_constant');
    const useDistance = document.getElementById('use_distance');
    const useReading = document.getElementById('use_reading');
    const useComputer = document.getElementById('use_computer');
    if (useConstant) useConstant.checked = usage.includes("Constant Use");
    if (useDistance) useDistance.checked = usage.includes("Distance Wear");
    if (useReading) useReading.checked = usage.includes("Reading Wear");
    if (useComputer) useComputer.checked = usage.includes("Computer/Office");

    initLensRxAutoCalc();
}

function populateRxItemSelect() {
    const select = document.getElementById('rxItemSelect');
    const wrap = document.getElementById('rxSelectWrap');
    if (!select) return;
    select.innerHTML = '';

    const rows = Array.from(document.querySelectorAll('#billTableBody tr'));
    const eligible = rows.map((row, idx) => {
        const type = row.querySelector('.p-type')?.value || "";
        const rxVal = row.querySelector('.row-rx-data')?.value || "";
        const desc = row.querySelector('.desc')?.value || `Item ${idx + 1}`;
        if (type === 'Lens' || type === 'Contact Lens' || rxVal) {
            return { row, idx, desc };
        }
        return null;
    }).filter(Boolean);

    if (wrap) wrap.style.display = 'grid';

    if (eligible.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No lens items found';
        select.appendChild(opt);
        select.disabled = true;
        return;
    }

    eligible.forEach(item => {
        const opt = document.createElement('option');
        opt.value = String(item.idx);
        opt.textContent = `${item.idx + 1}. ${item.desc}`;
        select.appendChild(opt);
    });
    select.disabled = false;
    select.selectedIndex = 0;
    const firstIdx = parseInt(select.value, 10);
    fillLensModalFromRow(rows[firstIdx]);
}

function handleRxSelectChange(selectEl) {
    const idx = parseInt(selectEl.value, 10);
    const isOrderPage = !!document.getElementById('billTableBody');
    if (isOrderPage) {
        const rows = document.querySelectorAll('#billTableBody tr');
        fillLensModalFromRow(rows[idx]);
    } else {
        activeRxItemIndex = idx;
        const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
        const order = orders.find(o => o.id == activeRxOrderId);
        if (order && order.items && order.items[idx]) {
            fillLensModalFromOrderItem(order.items[idx]);
        }
    }
}

function openRxEditor(orderId) {
    const isOrderPage = !!document.getElementById('billTableBody');
    if (isOrderPage) {
        if (orderId && (!editingOrderId || editingOrderId != orderId)) {
            loadOrderForEdit(orderId);
        }
        const modal = document.getElementById('modalLens');
        if (modal) {
            populateRxItemSelect();
            syncLensCustomerFieldsFromOrder(true);
            populateSavedLensPrescriptionSelect();
            modal.style.display = 'flex';
        }
        return;
    }

    // Pending/Sales page: open modal here without navigating
    const modal = document.getElementById('modalLens');
    if (modal) {
        activeRxOrderId = orderId;
        populateRxItemSelectForOrder(orderId);
        modal.style.display = 'flex';
    }
}

function populateRxItemSelectForOrder(orderId) {
    const select = document.getElementById('rxItemSelect');
    const wrap = document.getElementById('rxSelectWrap');
    if (!select) return;
    select.innerHTML = '';
    if (wrap) wrap.style.display = 'grid';

    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const order = orders.find(o => o.id == orderId);
    if (!order || !order.items || order.items.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No items found';
        select.appendChild(opt);
        select.disabled = true;
        return;
    }

    const lnCustName = document.getElementById('lnCustName');
    const lnCustPhone = document.getElementById('lnCustPhone');
    if (lnCustName) lnCustName.value = order.name || "";
    if (lnCustPhone) lnCustPhone.value = order.phone || "";

    order.items.forEach((item, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = `${idx + 1}. ${item.desc || `Item ${idx + 1}`}`;
        select.appendChild(opt);
    });
    select.disabled = false;
    select.selectedIndex = 0;
    activeRxItemIndex = 0;
    fillLensModalFromOrderItem(order.items[0]);
}

function fillLensModalFromOrderItem(item) {
    if (!item) return;
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val || "";
    };

    const info = parseLensDesc(item.desc || "");
    const rx = parseRxValue(item.rx) || {};

    setVal('lnBrand', info.brand);
    setVal('lnType', info.type);
    setVal('lnCoating', info.coating);
    setVal('lnIndex', info.index);
    setVal('lnPrice', item.price);
    setVal('lnDisc', item.disc);

    const re = rx.re || {};
    const le = rx.le || {};
    setVal('rx_r_sph', re.sph);
    setVal('rx_r_cyl', re.cyl);
    setVal('rx_r_axis', re.axis);
    setVal('rx_r_pd', re.pd);
    setVal('rx_r_va', re.va);
    setVal('rx_r_nv_sph', re.nv_sph);
    setVal('rx_r_nv_cyl', re.nv_cyl);
    setVal('rx_r_nv_axis', re.nv_axis);
    setVal('rx_r_nv_pd', re.nv_pd);
    setVal('rx_r_nv_va', re.nv_va);
    setVal('rx_r_add', re.add);

    setVal('rx_l_sph', le.sph);
    setVal('rx_l_cyl', le.cyl);
    setVal('rx_l_axis', le.axis);
    setVal('rx_l_pd', le.pd);
    setVal('rx_l_va', le.va);
    setVal('rx_l_nv_sph', le.nv_sph);
    setVal('rx_l_nv_cyl', le.nv_cyl);
    setVal('rx_l_nv_axis', le.nv_axis);
    setVal('rx_l_nv_pd', le.nv_pd);
    setVal('rx_l_nv_va', le.nv_va);
    setVal('rx_l_add', le.add);

    const usage = Array.isArray(rx.usage) ? rx.usage : [];
    const useConstant = document.getElementById('use_constant');
    const useDistance = document.getElementById('use_distance');
    const useReading = document.getElementById('use_reading');
    const useComputer = document.getElementById('use_computer');
    if (useConstant) useConstant.checked = usage.includes("Constant Use");
    if (useDistance) useDistance.checked = usage.includes("Distance Wear");
    if (useReading) useReading.checked = usage.includes("Reading Wear");
    if (useComputer) useComputer.checked = usage.includes("Computer/Office");

    initLensRxAutoCalc();
}

function buildRxDataFromModal() {
    const getVal = (id) => {
        const el = document.getElementById(id);
        return el ? el.value : "";
    };
    const isChecked = (id) => {
        const el = document.getElementById(id);
        return !!(el && el.checked);
    };
    const rxData = {
        re: {
            sph: getVal('rx_r_sph'),
            cyl: getVal('rx_r_cyl'),
            axis: getVal('rx_r_axis'),
            pd: getVal('rx_r_pd'),
            va: getVal('rx_r_va'),
            nv_sph: getVal('rx_r_nv_sph'),
            nv_cyl: getVal('rx_r_nv_cyl'),
            nv_axis: getVal('rx_r_nv_axis'),
            nv_pd: getVal('rx_r_nv_pd'),
            nv_va: getVal('rx_r_nv_va'),
            add: getVal('rx_r_add')
        },
        le: {
            sph: getVal('rx_l_sph'),
            cyl: getVal('rx_l_cyl'),
            axis: getVal('rx_l_axis'),
            pd: getVal('rx_l_pd'),
            va: getVal('rx_l_va'),
            nv_sph: getVal('rx_l_nv_sph'),
            nv_cyl: getVal('rx_l_nv_cyl'),
            nv_axis: getVal('rx_l_nv_axis'),
            nv_pd: getVal('rx_l_nv_pd'),
            nv_va: getVal('rx_l_nv_va'),
            add: getVal('rx_l_add')
        },
        usage: []
    };

    if (isChecked('use_constant')) rxData.usage.push("Constant Use");
    if (isChecked('use_distance')) rxData.usage.push("Distance Wear");
    if (isChecked('use_reading')) rxData.usage.push("Reading Wear");
    if (isChecked('use_computer')) rxData.usage.push("Computer/Office");

    return pruneRxData(rxData);
}

function saveRxEditFromModal() {
    if (activeRxOrderId === null || activeRxItemIndex === null) return;
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const idx = orders.findIndex(o => o.id == activeRxOrderId);
    if (idx === -1) return;

    const order = orders[idx];
    const item = order.items[activeRxItemIndex];
    if (!item) return;

    const brand = document.getElementById('lnBrand').value;
    const type = document.getElementById('lnType').value;
    const coating = document.getElementById('lnCoating').value;
    const indexVal = document.getElementById('lnIndex').value;
    const price = parseFloat(document.getElementById('lnPrice').value) || 0;
    const disc = parseFloat(document.getElementById('lnDisc').value) || 0;

    let desc = `LENS - ${brand} - ${type}`;
    if (coating) desc += ` - ${coating}`;
    if (indexVal) desc += ` - ${indexVal}`;

    const cleanedRx = buildRxDataFromModal();
    const qty = parseFloat(item.qty) || 1;
    const subtotal = qty * price;
    const discAmt = (subtotal * disc) / 100;
    const total = subtotal - discAmt;

    item.desc = desc;
    item.price = price;
    item.disc = disc;
    item.total = total;
    item.rx = cleanedRx;

    orders[idx] = order;
    localStorage.setItem('optixOrders', JSON.stringify(orders));
    alert("Prescription updated.");
    const modal = document.getElementById('modalLens');
    if (modal) modal.style.display = 'none';
}

function parsePower(val) {
    if (val === "" || val === null || val === undefined) return null;
    const num = parseFloat(val);
    return Number.isFinite(num) ? num : null;
}

function formatPower(val) {
    return (Math.round(val * 100) / 100).toFixed(2);
}

function updateNearVision(eye) {
    const prefix = eye === 'r' ? 'rx_r_' : 'rx_l_';
    const dvSphEl = document.getElementById(prefix + 'sph');
    const dvCylEl = document.getElementById(prefix + 'cyl');
    const dvAxisEl = document.getElementById(prefix + 'axis');
    const addEl = document.getElementById(prefix + 'add');
    const nvSphEl = document.getElementById(prefix + 'nv_sph');
    const nvCylEl = document.getElementById(prefix + 'nv_cyl');
    const nvAxisEl = document.getElementById(prefix + 'nv_axis');

    if (!dvSphEl || !addEl || !nvSphEl) return;

    const dvSph = parsePower(dvSphEl.value);
    const add = parsePower(addEl.value);

    if (dvCylEl && nvCylEl && dvCylEl.value !== "") nvCylEl.value = dvCylEl.value;
    if (dvAxisEl && nvAxisEl && dvAxisEl.value !== "") nvAxisEl.value = dvAxisEl.value;

    if (dvSph !== null && add !== null) {
        nvSphEl.value = formatPower(dvSph + add);
    }
}

// 4. Save FRAME Data to Row
function saveFrameData() {
    if (!activeRow) return;
    
    const code = document.getElementById('frCode').value;
    const name = document.getElementById('frName').value;
    const brand = document.getElementById('frBrand').value;
    const price = document.getElementById('frPrice').value;
    const discPercentInput = parseFloat(document.getElementById('frDisc').value) || 0;
    const discAmtInput = parseFloat(document.getElementById('frDiscAmt') ? document.getElementById('frDiscAmt').value : 0) || 0;
    const qty = parseFloat(activeRow.querySelector('.qty').value) || 1;
    const subtotal = (parseFloat(price) || 0) * qty;
    const effectiveDiscPercent = subtotal > 0 && discAmtInput > 0 ? ((discAmtInput / subtotal) * 100) : discPercentInput;

    activeRow.querySelector('.p-code').value = code;
    activeRow.querySelector('.desc').value = `FRAME: ${brand} ${name}`;
    activeRow.querySelector('.price').value = price;
    activeRow.querySelector('.row-disc').value = effectiveDiscPercent.toFixed(2);
    activeRow.querySelector('.row-disc-amt').value = discAmtInput.toFixed(2);
    activeRow.dataset.discountMode = discAmtInput > 0 ? 'amount' : 'percent';

    calcRow(activeRow.querySelector(discAmtInput > 0 ? '.row-disc-amt' : '.row-disc')); // Recalculate
    closeModal('modalFrame');
}

// Keep frame discount amount and percent in sync within the modal
function updateFrameDiscount(mode) {
    const priceEl = document.getElementById('frPrice');
    const discEl = document.getElementById('frDisc');
    const discAmtEl = document.getElementById('frDiscAmt');
    if (!priceEl || !discEl || !discAmtEl) return;

    const price = parseFloat(priceEl.value) || 0;
    const qty = activeRow ? (parseFloat(activeRow.querySelector('.qty').value) || 1) : 1;
    const subtotal = price * qty;
    if (subtotal <= 0) {
        if (mode === 'percent') discAmtEl.value = '';
        else discEl.value = '';
        return;
    }

    if (mode === 'percent') {
        const percent = parseFloat(discEl.value) || 0;
        discAmtEl.value = ((subtotal * percent) / 100).toFixed(2);
    } else {
        const amt = parseFloat(discAmtEl.value) || 0;
        discEl.value = ((amt / subtotal) * 100).toFixed(2);
    }
}

// 5. Save LENS Data to Row
function saveLensData() {
    if (!activeRow) return;
    const getVal = (id) => {
        const el = document.getElementById(id);
        return el ? el.value : "";
    };
    const isChecked = (id) => {
        const el = document.getElementById(id);
        return !!(el && el.checked);
    };

    // 1. Capture Product Info
    const code = getVal('lnCode');
    const brand = getVal('lnBrand');
    const type = getVal('lnType');
    const coating = getVal('lnCoating');
    const indexVal = getVal('lnIndex');
    
    // 2. Capture Financials
    const price = getVal('lnPrice');
    const disc = getVal('lnDisc');

    // 3. Capture Prescription Data (Comprehensive)
    const rxData = {
        re: {
            sph: getVal('rx_r_sph'),
            cyl: getVal('rx_r_cyl'),
            axis: getVal('rx_r_axis'),
            pd: getVal('rx_r_pd'),
            va: getVal('rx_r_va'),
            // Near Vision
            nv_sph: getVal('rx_r_nv_sph'),
            nv_cyl: getVal('rx_r_nv_cyl'),
            nv_axis: getVal('rx_r_nv_axis'),
            add: getVal('rx_r_add')
        },
        le: {
            sph: getVal('rx_l_sph'),
            cyl: getVal('rx_l_cyl'),
            axis: getVal('rx_l_axis'),
            pd: getVal('rx_l_pd'),
            va: getVal('rx_l_va'),
            // Near Vision
            nv_sph: getVal('rx_l_nv_sph'),
            nv_cyl: getVal('rx_l_nv_cyl'),
            nv_axis: getVal('rx_l_nv_axis'),
            add: getVal('rx_l_add')
        },
        usage: []
    };

    // Capture Checkboxes
    if (isChecked('use_constant')) rxData.usage.push("Constant Use");
    if (isChecked('use_distance')) rxData.usage.push("Distance Wear");
    if (isChecked('use_reading')) rxData.usage.push("Reading Wear");
    if (isChecked('use_computer')) rxData.usage.push("Computer/Office");

    // 4. Create Description String (aligned with invoice output)
    // Format: LENS - [Brand] - [Type] - [Coating] - [Index]
    let desc = `LENS - ${brand} - ${type}`;
    if (coating) desc += ` - ${coating}`;
    if (indexVal) desc += ` - ${indexVal}`;

    // Remove empty Rx fields so invoice stays clean
    const cleanedRx = pruneRxData(rxData);

    // 5. Save to Row Inputs
    activeRow.querySelector('.row-rx-data').value = cleanedRx ? JSON.stringify(cleanedRx) : "";
    activeRow.querySelector('.p-code').value = code;
    activeRow.querySelector('.desc').value = desc;
    activeRow.querySelector('.price').value = price;
    activeRow.querySelector('.row-disc').value = disc;
    activeRow.querySelector('.row-disc-amt').value = "0.00";
    activeRow.dataset.discountMode = 'percent';

    if (cleanedRx) saveLensRxToDatabase(cleanedRx);

    calcRow(activeRow.querySelector('.row-disc'));
    closeModal('modalLens');
}

function pruneRxData(rxData) {
    const sanitize = (obj) => {
        Object.keys(obj).forEach((key) => {
            if (obj[key] === "" || obj[key] === null || obj[key] === undefined) {
                delete obj[key];
            }
        });
        return obj;
    };

    const re = sanitize({ ...rxData.re });
    const le = sanitize({ ...rxData.le });
    const usage = rxData.usage && rxData.usage.length ? rxData.usage : [];

    const hasRe = Object.keys(re).length > 0;
    const hasLe = Object.keys(le).length > 0;
    const hasUsage = usage.length > 0;

    if (!hasRe && !hasLe && !hasUsage) return null;

    const cleaned = {};
    if (hasRe) cleaned.re = re;
    if (hasLe) cleaned.le = le;
    if (hasUsage) cleaned.usage = usage;
    return cleaned;
}

function calculateAgeFromDob(dobStr) {
    if (!dobStr) return "";
    const dob = new Date(dobStr);
    if (Number.isNaN(dob.getTime())) return "";
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
    return age;
}

async function saveLensRxToDatabase(rxData) {
    const nameEl = document.getElementById('cName');
    const phoneEl = document.getElementById('cPhone');
    const dobEl = document.getElementById('cDob');
    const orderDateEl = document.getElementById('orderDate');

    const patName = nameEl ? nameEl.value.trim() : "";
    const patMobile = phoneEl ? phoneEl.value.trim() : "";
    if (!patName || !patMobile) return;

    const patAge = calculateAgeFromDob(dobEl ? dobEl.value : "");
    const rxDate = getManagedDateValue(orderDateEl) || new Date().toISOString().slice(0, 10);

    const re = rxData.re || {};
    const le = rxData.le || {};

    const prescriptionData = {
        id: Date.now(),
        storeId: getCollectionStoreId(),
        patName: patName,
        patMobile: patMobile,
        patAge: patAge,
        rxDate: rxDate,
        rxDateTime: new Date().toLocaleString(),
        type: 'Eyewear',
        rightEye: {
            sph: re.sph || "",
            cyl: re.cyl || "",
            axis: re.axis || "",
            va: re.va || "",
            nvSph: re.nv_sph || "",
            nvCyl: re.nv_cyl || "",
            nvAxis: re.nv_axis || "",
            nvVa: re.nv_va || "",
            add: re.add || "",
            pd: re.pd || ""
        },
        leftEye: {
            sph: le.sph || "",
            cyl: le.cyl || "",
            axis: le.axis || "",
            va: le.va || "",
            nvSph: le.nv_sph || "",
            nvCyl: le.nv_cyl || "",
            nvAxis: le.nv_axis || "",
            nvVa: le.nv_va || "",
            add: le.add || "",
            pd: le.pd || ""
        },
        usage: rxData.usage || []
    };

    const prescriptions = JSON.parse(localStorage.getItem('optixPrescriptions')) || [];
    prescriptions.push(prescriptionData);
    try {
        if (db) await upsertEntityToCloud('optixPrescriptions', prescriptionData);
    } catch (err) {
        console.error("Cloud prescription save failed:", err);
        alert("Cloud save failed. Prescription was not saved.");
        return;
    }
    localStorage.setItem('optixPrescriptions', JSON.stringify(prescriptions));

    if (typeof loadRxDatabase === 'function') loadRxDatabase();
}

// 6. Recalculate Total (row-level discount % / Rs)
function calcRow(el, mode = '') {
    if (!el) return;
    const row = el.closest('tr');
    if (!row) return;
    const qty = parseFloat(row.querySelector('.qty').value) || 0;
    const price = parseFloat(row.querySelector('.price').value) || 0;
    const discountsEnabled = getSettings().enableDiscounts !== false;
    const subtotal = qty * price;
    const discPercentEl = row.querySelector('.row-disc');
    const discAmtEl = row.querySelector('.row-disc-amt');

    let sourceMode = mode || row.dataset.discountMode || 'percent';
    if (el.classList.contains('row-disc')) sourceMode = 'percent';
    if (el.classList.contains('row-disc-amt')) sourceMode = 'amount';
    row.dataset.discountMode = sourceMode;

    let discPercent = 0;
    let discAmt = 0;

    if (discountsEnabled && subtotal > 0) {
        if (sourceMode === 'amount') {
            discAmt = parseFloat(discAmtEl?.value) || 0;
            discAmt = Math.max(0, Math.min(discAmt, subtotal));
            discPercent = (discAmt / subtotal) * 100;
        } else {
            discPercent = parseFloat(discPercentEl?.value) || 0;
            discPercent = Math.max(0, Math.min(discPercent, 100));
            discAmt = (subtotal * discPercent) / 100;
        }
    }

    if (discPercentEl) discPercentEl.value = discPercent.toFixed(2);
    if (discAmtEl) discAmtEl.value = discAmt.toFixed(2);
    const total = subtotal - discAmt;

    row.querySelector('.row-total').value = total.toFixed(2);
    calculateFinal();
}
// --- NEW: Discount Calculation Logic (Percent <-> Amount) ---
function calcDiscount(mode) {
    if (!document.getElementById('txtDiscPercent') || !document.getElementById('txtDiscAmount')) return;
    if (getSettings().enableDiscounts === false) return;
    let baseTotal = 0;
    document.querySelectorAll('.item-row').forEach(row => {
        baseTotal += parseFloat(row.querySelector('.row-total').value) || 0;
    });

    if (baseTotal === 0) return; // Prevent calculation on empty bill

    if (mode === 'percent') {
        // User typed %, calculate Amount
        const percent = parseFloat(document.getElementById('txtDiscPercent').value) || 0;
        const amt = (baseTotal * percent) / 100;
        document.getElementById('txtDiscAmount').value = amt.toFixed(2);
    } else {
        // User typed Amount, calculate %
        const amt = parseFloat(document.getElementById('txtDiscAmount').value) || 0;
        const percent = (amt / baseTotal) * 100;
        document.getElementById('txtDiscPercent').value = percent.toFixed(2);
    }
    
    calculateFinal(); // Update final totals
}

// --- UPDATED: Calculate Final Totals ---
function calculateFinal() {
    const requiredIds = ['txtDiscAmount','txtRoundOff','txtBaseTotal','txtPayable','payCash','payUPI','payBank','txtTotalPaid','lblPending'];
    const hasAll = requiredIds.every(id => document.getElementById(id));
    if (!hasAll) return;

    let baseTotal = 0;
    document.querySelectorAll('.item-row').forEach(row => {
        baseTotal += parseFloat(row.querySelector('.row-total').value) || 0;
    });

    // Get Discount from the AMOUNT field (it's auto-filled by the function above)
    const discountsEnabled = getSettings().enableDiscounts !== false;
    const discount = discountsEnabled ? (parseFloat(document.getElementById('txtDiscAmount').value) || 0) : 0;
    const roundOff = parseFloat(document.getElementById('txtRoundOff').value) || 0;
    
    // Calculate Payable
    const payable = baseTotal - discount + roundOff;

    document.getElementById('txtBaseTotal').value = baseTotal.toFixed(2);
    document.getElementById('txtPayable').value = payable.toFixed(2);

    // Calculate Total Paid
    const enteredCash = parseFloat(document.getElementById('payCash').value) || 0;
    const enteredUpi = parseFloat(document.getElementById('payUPI').value) || 0;
    const enteredBank = parseFloat(document.getElementById('payBank').value) || 0;
    const useIncrementPayment = isPendingPaymentIncrementMode() || isConfirmPaymentFlow();
    const existingCash = useIncrementPayment ? editingExistingPaidCash : 0;
    const existingUpi = useIncrementPayment ? editingExistingPaidUpi : 0;
    const existingBank = useIncrementPayment ? editingExistingPaidBank : 0;
    
    const totalPaid = enteredCash + enteredUpi + enteredBank + existingCash + existingUpi + existingBank;
    const balance = payable - totalPaid;

    document.getElementById('txtTotalPaid').value = totalPaid.toFixed(2);
    
    const pendingEl = document.getElementById('lblPending');
    pendingEl.innerText = "Rs " + balance.toFixed(2);
    pendingEl.style.color = balance > 0 ? "red" : "green";

    const confirmBtn = document.getElementById('btnConfirmOrder');
    if (confirmBtn) {
        confirmBtn.disabled = balance > 0;
        confirmBtn.style.opacity = balance > 0 ? '0.5' : '1';
        confirmBtn.style.cursor = balance > 0 ? 'not-allowed' : 'pointer';
    }
}

// --- PART 8: PRESCRIPTION MANAGEMENT ---

// Initialize prescription date
function initPrescriptionDate() {
    const rxDate = document.getElementById('rxDate');
    if(rxDate) {
        rxDate.valueAsDate = new Date();
    }
}

function bindPrescriptionCalcs() {
    const eyes = ['r','l'];
    const num = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const v = parseFloat(el.value);
        return isNaN(v) ? null : v;
    };
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = val;
    };
    eyes.forEach(eye => {
        const distId = `${eye}_sph`;
        const nearId = `${eye}_nv_sph`;
        const addId = `${eye}_add`;
        const recalcNear = () => {
            const d = num(distId);
            const a = num(addId);
            if (d === null || a === null) return;
            setVal(nearId, (d + a).toFixed(2));
        };
        const recalcAdd = () => {
            const d = num(distId);
            const n = num(nearId);
            if (d === null || n === null) return;
            setVal(addId, (n - d).toFixed(2));
        };
        ['input','change'].forEach(evt => {
            const distEl = document.getElementById(distId);
            const addEl = document.getElementById(addId);
            const nearEl = document.getElementById(nearId);
            if (distEl) distEl.addEventListener(evt, recalcNear);
            if (addEl) addEl.addEventListener(evt, recalcNear);
            if (nearEl) nearEl.addEventListener(evt, recalcAdd);
        });
    });
}

// Save Final Prescription (Eyewear + Contact Lens)
async function saveFinalRx() {
    const patName = document.getElementById('patName').value.trim();
    const patMobile = document.getElementById('patMobile').value.trim();
    const patAge = document.getElementById('patAge').value.trim();
    const rxDate = document.getElementById('rxDate').value;
    
    if(!patName || !patMobile || !patAge || !rxDate) {
        alert("Please fill all patient details!");
        return;
    }

    // Determine which tab is active
    const eyewearTab = document.getElementById('eyewear').style.display !== 'none';
    const clTab = document.getElementById('cl').style.display !== 'none';

    let prescriptionData = {
        id: Date.now(),
        storeId: getCollectionStoreId(),
        patName: patName,
        patMobile: patMobile,
        patAge: parseInt(patAge),
        rxDate: rxDate,
        rxDateTime: new Date().toLocaleString(),
        type: eyewearTab ? 'Eyewear' : 'ContactLens'
    };

    if(eyewearTab) {
        // Eyewear Prescription
        prescriptionData.rightEye = {
            sph: document.getElementById('r_sph').value,
            cyl: document.getElementById('r_cyl').value,
            axis: document.getElementById('r_axis').value,
            pd: document.getElementById('r_pd').value,
            va: document.getElementById('r_va').value,
            nvSph: document.getElementById('r_nv_sph').value,
            nvCyl: document.getElementById('r_nv_cyl').value,
            nvAxis: document.getElementById('r_nv_axis').value,
            nvPd: document.getElementById('r_nv_pd').value,
            nvVa: document.getElementById('r_nv_va').value,
            add: document.getElementById('r_add').value
        };
        prescriptionData.leftEye = {
            sph: document.getElementById('l_sph').value,
            cyl: document.getElementById('l_cyl').value,
            axis: document.getElementById('l_axis').value,
            pd: document.getElementById('l_pd').value,
            va: document.getElementById('l_va').value,
            nvSph: document.getElementById('l_nv_sph').value,
            nvCyl: document.getElementById('l_nv_cyl').value,
            nvAxis: document.getElementById('l_nv_axis').value,
            nvPd: document.getElementById('l_nv_pd').value,
            nvVa: document.getElementById('l_nv_va').value,
            add: document.getElementById('l_add').value
        };
    } else {
        // Contact Lens Prescription
        prescriptionData.rightCL = {
            sph: document.getElementById('cl_r_sph').value,
            cyl: document.getElementById('cl_r_cyl').value,
            axis: document.getElementById('cl_r_axis').value
        };
        prescriptionData.leftCL = {
            sph: document.getElementById('cl_l_sph').value,
            cyl: document.getElementById('cl_l_cyl').value,
            axis: document.getElementById('cl_l_axis').value
        };
    }

    // Save to localStorage
    let prescriptions = JSON.parse(localStorage.getItem('optixPrescriptions')) || [];
    prescriptions.push(prescriptionData);
    try {
        if (db) await upsertEntityToCloud('optixPrescriptions', prescriptionData);
    } catch (err) {
        console.error("Cloud prescription save failed:", err);
        alert("Cloud save failed. Prescription was not saved.");
        return;
    }
    localStorage.setItem('optixPrescriptions', JSON.stringify(prescriptions));

    alert("✓ Prescription saved successfully!");
    
    // Clear form
    clearPrescriptionForm();
    loadRxDatabase();
}

// Clear Prescription Form
function clearPrescriptionForm() {
    document.getElementById('patName').value = '';
    document.getElementById('patMobile').value = '';
    document.getElementById('patAge').value = '';
    document.getElementById('rxDate').valueAsDate = new Date();
    
    // Clear Eyewear fields
    document.querySelectorAll('#eyewear input[class="rx-input"]').forEach(el => el.value = '');
    
    // Clear Contact Lens fields
    document.querySelectorAll('#cl input[class="rx-input"]').forEach(el => el.value = '');
}

// Load Prescription Database
function loadRxDatabase() {
    const tbody = document.getElementById('rxDatabaseBody');
    if(!tbody) return;
    
    const prescriptions = JSON.parse(localStorage.getItem('optixPrescriptions')) || [];
    const searchTerm = document.getElementById('dbSearch') ? document.getElementById('dbSearch').value.toLowerCase() : '';
    
    tbody.innerHTML = '';
    
    prescriptions.filter(rx => {
        return rx.patName.toLowerCase().includes(searchTerm) || rx.patMobile.includes(searchTerm);
    }).reverse().forEach((rx, index) => {
        let rightEyeStr = '';
        let leftEyeStr = '';
        
        if(rx.type === 'Eyewear') {
            rightEyeStr = `${rx.rightEye.sph || '-'} / ${rx.rightEye.cyl || '-'} / ${rx.rightEye.axis || '-'}`;
            leftEyeStr = `${rx.leftEye.sph || '-'} / ${rx.leftEye.cyl || '-'} / ${rx.leftEye.axis || '-'}`;
        } else {
            rightEyeStr = `CL: ${rx.rightCL.sph || '-'} / ${rx.rightCL.cyl || '-'} / ${rx.rightCL.axis || '-'}`;
            leftEyeStr = `CL: ${rx.leftCL.sph || '-'} / ${rx.leftCL.cyl || '-'} / ${rx.leftCL.axis || '-'}`;
        }
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${new Date(rx.rxDate).toLocaleDateString('en-IN')}</td>
            <td><strong>${rx.patName}</strong><br><small>${rx.patMobile} | Age: ${rx.patAge}</small></td>
            <td>${rightEyeStr}</td>
            <td>${leftEyeStr}</td>
            <td>
                <button onclick="viewRxDetails(${rx.id})" style="padding:4px 8px; background:#2196f3; color:white; border:none; border-radius:3px; cursor:pointer; font-size:11px;">View</button>
                <button onclick="deleteRx(${rx.id})" style="padding:4px 8px; background:#f44336; color:white; border:none; border-radius:3px; cursor:pointer; font-size:11px;">Delete</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// --- Customer History (Search & Load) ---
async function getCustomerHistory(mobile) {
    if (!mobile) return [];
    const clean = String(mobile).replace(/\D/g, '');
    const results = [];

    try {
        // 1) Local cache
        const local = JSON.parse(localStorage.getItem('optixPrescriptions')) || [];
        (local || []).forEach(rx => {
            const rxPhone = String(rx.patMobile || rx.mobile || '').replace(/\D/g, '');
            if (!rxPhone) return;
            if (rxPhone === clean || rxPhone.endsWith(clean) || clean.endsWith(rxPhone)) {
                results.push(rx);
            }
        });

        // 2) Cloud lookup (if available)
        if (typeof db !== 'undefined' && db) {
            try {
                const storeId = getCollectionStoreId();
                let query = db.collection('prescriptions').where('patMobile', '==', String(mobile));
                if (storeId) query = query.where('storeId', '==', storeId);
                const snap = await query.limit(100).get();
                snap.forEach(doc => {
                    const d = { ...doc.data(), _docId: doc.id };
                    results.push(d);
                });
            } catch (err) {
                // If exact match by patMobile fails (different format), attempt a broader scan
                try {
                    const snap = await db.collection('prescriptions').where('storeId', '==', getCollectionStoreId()).limit(200).get();
                    snap.forEach(doc => {
                        const d = doc.data() || {};
                        const rxPhone = String(d.patMobile || d.mobile || '').replace(/\D/g, '');
                        if (rxPhone && (rxPhone === clean || rxPhone.endsWith(clean) || clean.endsWith(rxPhone))) {
                            results.push({ ...d, _docId: doc.id });
                        }
                    });
                } catch (e) {
                    console.warn('Cloud history fetch fallback failed', e);
                }
            }
        }
    } catch (err) {
        console.error('getCustomerHistory failed', err);
    }

    // Dedupe by id or rxDate+patMobile
    const seen = new Map();
    results.forEach(item => {
        const key = String(item.id || item._docId || (item.rxDate || item.rxDateTime || '') + '|' + (item.patMobile || '') );
        if (!seen.has(key)) seen.set(key, item);
    });

    const merged = Array.from(seen.values()).map(it => ({
        id: it.id || it._docId || Date.now(),
        rxDate: it.rxDate || it.rxDateTime || it.date || '',
        patName: it.patName || it.name || '',
        patMobile: it.patMobile || it.mobile || '',
        rightEye: it.rightEye || it.re || it.right || {},
        leftEye: it.leftEye || it.le || it.left || {},
        usage: it.usage || []
    })).sort((a,b)=>{
        const ta = new Date(a.rxDate).getTime()||0;
        const tb = new Date(b.rxDate).getTime()||0;
        return tb - ta;
    });

    return merged;
}

// Wire the History button on the Order page to fetch & display history
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btnSearchHistory');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const mobileEl = document.getElementById('cPhone');
        const historyContainer = document.getElementById('historyListContainer');
        const historyList = document.getElementById('historyList');
        if (!mobileEl || !historyContainer || !historyList) return;
        const mobile = String(mobileEl.value || '').trim();
        historyList.innerHTML = '';
        if (!mobile || mobile.replace(/\D/g, '').length < 6) {
            alert('Please enter a valid mobile number.');
            historyContainer.style.display = 'none';
            return;
        }

        const records = await getCustomerHistory(mobile);
        if (!records || !records.length) {
            alert('No previous history found for this number.');
            historyContainer.style.display = 'none';
            return;
        }

        // Build list
        records.forEach(rec => {
            const li = document.createElement('li');
            li.style.padding = '6px';
            li.style.borderBottom = '1px solid #eee';
            li.style.cursor = 'pointer';
            const d = rec.rxDate ? new Date(rec.rxDate).toLocaleDateString() : '';
            li.innerText = `${d} — ${rec.patName || ''} ${rec.patMobile ? ' ('+rec.patMobile+')' : ''}`.trim();
            li.addEventListener('click', () => {
                // If order page has fill function for lens modal, use it
                if (typeof fillLensModalFromSavedPrescription === 'function') {
                    fillLensModalFromSavedPrescription(rec);
                    const modal = document.getElementById('modalLens');
                    if (modal) modal.style.display = 'flex';
                }
                if (document.getElementById('cPhone')) document.getElementById('cPhone').value = rec.patMobile || '';
                if (document.getElementById('cName')) document.getElementById('cName').value = rec.patName || '';
                historyContainer.style.display = 'none';
            });
            historyList.appendChild(li);
        });

        historyContainer.style.display = 'block';
    });
});

// View Prescription Details
function viewRxDetails(rxId) {
    const prescriptions = JSON.parse(localStorage.getItem('optixPrescriptions')) || [];
    const rx = prescriptions.find(p => p.id === rxId);
    
    if(!rx) return;
    
    let details = `PATIENT: ${rx.patName}\nMobile: ${rx.patMobile}\nAge: ${rx.patAge}\nDate: ${rx.rxDate}\n\n`;
    
    if(rx.type === 'Eyewear') {
        details += `RIGHT EYE (OD):\n`;
        details += `Distance: SPH=${rx.rightEye.sph}, CYL=${rx.rightEye.cyl}, AXIS=${rx.rightEye.axis}\n`;
        details += `Near: SPH=${rx.rightEye.nvSph}, CYL=${rx.rightEye.nvCyl}, AXIS=${rx.rightEye.nvAxis}\n`;
        details += `Addition: ${rx.rightEye.add}\n\n`;
        
        details += `LEFT EYE (OS):\n`;
        details += `Distance: SPH=${rx.leftEye.sph}, CYL=${rx.leftEye.cyl}, AXIS=${rx.leftEye.axis}\n`;
        details += `Near: SPH=${rx.leftEye.nvSph}, CYL=${rx.leftEye.nvCyl}, AXIS=${rx.leftEye.nvAxis}\n`;
        details += `Addition: ${rx.leftEye.add}`;
    } else {
        details += `RIGHT CONTACT LENS (OD):\n`;
        details += `SPH=${rx.rightCL.sph}, CYL=${rx.rightCL.cyl}, AXIS=${rx.rightCL.axis}\n\n`;
        
        details += `LEFT CONTACT LENS (OS):\n`;
        details += `SPH=${rx.leftCL.sph}, CYL=${rx.leftCL.cyl}, AXIS=${rx.leftCL.axis}`;
    }
    
    alert(details);
}

// Delete Prescription
async function deleteRx(rxId) {
    if(!confirm("Delete this prescription?")) return;

    try {
        if (db) await deleteEntityFromCloud('optixPrescriptions', rxId);
    } catch (err) {
        console.error("Cloud prescription delete failed:", err);
        alert("Cloud delete failed.");
        return;
    }

    let prescriptions = JSON.parse(localStorage.getItem('optixPrescriptions')) || [];
    prescriptions = prescriptions.filter(p => String(p.id) !== String(rxId));
    localStorage.setItem('optixPrescriptions', JSON.stringify(prescriptions));
    
    loadRxDatabase();
    alert("Prescription deleted!");
}

// --- PART 4: STAFF MANAGEMENT ---
async function saveStaff() {
    const name = document.getElementById('sName').value;
    const role = document.getElementById('sRole').value;
    if(!name) { alert("Name is required"); return; }

    const staff = JSON.parse(localStorage.getItem('optixStaff')) || [];
    const staffMember = { id: Date.now(), name: name, role: role, date: new Date().toLocaleDateString(), storeId: getCollectionStoreId() };
    staff.push(staffMember);
    try {
        if (db) await upsertEntityToCloud('optixStaff', staffMember);
    } catch (err) {
        console.error("Cloud staff save failed:", err);
        alert("Cloud save failed. Staff was not saved.");
        return;
    }
    localStorage.setItem('optixStaff', JSON.stringify(staff));
    
    alert("Staff Added!");
    loadStaff();
}

function loadStaff() {
    const list = document.getElementById('staffList');
    if(!list) return;
    list.innerHTML = "";
    const staff = JSON.parse(localStorage.getItem('optixStaff')) || [];
    staff.forEach((s, index) => {
        list.insertAdjacentHTML('beforeend', `
            <li style="border-bottom:1px solid #eee; padding:5px;">
                <strong>${s.name}</strong> (${s.role}) 
                <span style="float:right; cursor:pointer; color:red;" onclick="deleteStaff(${index})">x</span>
            </li>
        `);
    });
}

async function deleteStaff(index) {
    const staff = JSON.parse(localStorage.getItem('optixStaff')) || [];
    const removed = staff[index];
    try {
        if (db && removed) await deleteEntityFromCloud('optixStaff', removed.id);
    } catch (err) {
        console.error("Cloud staff delete failed:", err);
        alert("Cloud delete failed.");
        return;
    }
    staff.splice(index, 1);
    localStorage.setItem('optixStaff', JSON.stringify(staff));
    loadStaff();
}

// --- PART 5: PURCHASE / QUICK STOCK ENTRY ---
function addStock() {
    // This is a simplified version of adding inventory directly
    const type = document.getElementById('pType').value;
    const desc = document.getElementById('pDesc').value;
    const buy = parseFloat(document.getElementById('pBuyPrice').value) || 0;
    const sell = parseFloat(document.getElementById('pSellPrice').value) || 0;
    const qty = parseInt(document.getElementById('pQty').value) || 1;
    const barcode = document.getElementById('pBarcode').value; // Optional

    if(!desc) { alert("Description is required"); return; }

    const products = JSON.parse(localStorage.getItem('optixProducts')) || [];
    const code = barcode || generateBarcode();
    
    // CHECK IF PRODUCT WITH SAME BARCODE EXISTS
    const existingProduct = products.find(p => p.code === code);
    
    if(existingProduct) {
        // UPDATE EXISTING PRODUCT QUANTITY
        existingProduct.qty = parseInt(existingProduct.qty) + qty;
        alert("Stock Updated! New Quantity: " + existingProduct.qty);
    } else {
        // CREATE NEW PRODUCT ENTRY
        const newProd = {
            id: Date.now(),
            category: type,
            code: code,
            name: desc,
            brand: "Generic", // Default
            buyPrice: buy,
            sellPrice: sell,
            qty: qty,
            createdOn: new Date().toLocaleString(),
            status: 'Active'
        };
        products.push(newProd);
        alert("Stock Added Successfully!");
    }

    localStorage.setItem('optixProducts', JSON.stringify(products));
    loadStock(); // Refresh table
}

function loadStock() {
    const tbody = document.getElementById('stockTable');
    if(!tbody) return;
    tbody.innerHTML = "";
    const products = JSON.parse(localStorage.getItem('optixProducts')) || [];
    
    // Show last 10 added items
    products.slice(-10).reverse().forEach(p => {
        tbody.insertAdjacentHTML('beforeend', `
            <tr>
                <td>${p.category}</td>
                <td>${p.name}</td>
                <td>${p.qty}</td>
                <td>${p.sellPrice}</td>
                <td>${p.code}</td>
                <td><button style="color:red; border:none; background:none; cursor:pointer" onclick="deleteProduct(${p.id})">Delete</button></td>
            </tr>
        `);
    });
}

// --- PART 6: REPORTING ENGINE ---
function runReport(type) {
    const output = document.getElementById('reportOutput');
    const title = document.getElementById('reportTitle');
    if(!output) return;

    let text = "";
    
    if(type === 'sales') {
        title.innerText = "Sales Report (All Time)";
        const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
        let total = 0;
        text += "DATE\t\tORDER NO\tAMOUNT\n";
        text += "-----------------------------------------\n";
        orders.forEach(o => {
            text += `${o.date}\t${o.id}\tRs ${o.amount}\n`;
            total += parseFloat(o.amount);
        });
        text += "-----------------------------------------\n";
        text += `TOTAL SALES: Rs ${total.toFixed(2)}`;
    }
    else if(type === 'inventory') {
        title.innerText = "Current Inventory Value";
        const products = JSON.parse(localStorage.getItem('optixProducts')) || [];
        let count = 0;
        let value = 0;
        products.forEach(p => {
            count += parseInt(p.qty);
            value += (parseInt(p.qty) * parseFloat(p.sellPrice));
        });
        text += `Total Items in Stock: ${count}\n`;
        text += `Total Retail Value: Rs ${value.toFixed(2)}`;
    }
    else if(type === 'pending') {
        title.innerText = "Pending Payments";
        const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
        text += "CUSTOMER\tPHONE\t\tPENDING\n";
        text += "-----------------------------------------\n";
        orders.forEach(o => {
            const due = o.amount - o.paid;
            if(due > 0) {
                text += `${o.name}\t${o.phone}\tRs ${due.toFixed(2)}\n`;
            }
        });
    }

    output.value = text;
    document.getElementById('reportResult').style.display = 'block';
}

// --- PART 7: CUSTOMER MANAGEMENT ---
async function addCustomer() {
    const name = document.getElementById('newCName').value;
    const phone = document.getElementById('newCPhone').value;
    const city = document.getElementById('newCCity').value;
    const gender = document.getElementById('newCGender').value;

    if(!name || !phone) { alert("Name and Phone are required!"); return; }

    const customers = JSON.parse(localStorage.getItem('optixCustomers')) || [];
    
    // Check duplicate
    if(customers.find(c => c.phone === phone)) {
        alert("Customer with this phone number already exists!");
        return;
    }

    const customer = {
        id: Date.now(),
        name: name,
        phone: phone,
        city: city,
        gender: gender,
        joined: new Date().toLocaleDateString(),
        storeId: getCollectionStoreId()
    };
    customers.push(customer);

    try {
        if (db) await upsertEntityToCloud('optixCustomers', customer);
    } catch (err) {
        console.error("Cloud customer save failed:", err);
        alert("Cloud save failed. Customer was not saved.");
        return;
    }

    localStorage.setItem('optixCustomers', JSON.stringify(customers));
    alert("Customer Saved!");
    loadCustomers();
}

function loadCustomers() {
    const tbody = document.getElementById('customerTable');
    if(!tbody) return;
    tbody.innerHTML = "";
    const customers = JSON.parse(localStorage.getItem('optixCustomers')) || [];

    customers.reverse().forEach(c => {
        tbody.insertAdjacentHTML('beforeend', `
            <tr>
                <td>${c.id}</td>
                <td>${c.name}</td>
                <td>${c.phone}</td>
                <td>${c.city}</td>
                <td>${c.gender}</td>
                <td><a href="https://wa.me/91${c.phone}" target="_blank" style="color:green"><i class="fab fa-whatsapp"></i></a></td>
            </tr>
        `);
    });
}

// --- PART 8: EXPENSE MANAGEMENT ---
async function saveExpense() {
    const date = document.getElementById('expenseDate').value;
    const desc = document.getElementById('eDesc').value;
    const amount = parseFloat(document.getElementById('eAmount').value);
    const modeEl = document.querySelector('input[name="eMode"]:checked');
    const mode = modeEl ? modeEl.value : 'cash';

    if(!desc || !amount) { alert("Fill all details"); return; }

    const expenses = JSON.parse(localStorage.getItem('optixExpenses')) || [];
    const expense = {
        id: Date.now(),
        date: date || new Date().toISOString().split('T')[0],
        desc: desc,
        amount: amount,
        mode: mode,
        storeId: getCollectionStoreId()
    };
    expenses.push(expense);
    try {
        if (db) await upsertEntityToCloud('optixExpenses', expense);
    } catch (err) {
        console.error("Cloud expense save failed:", err);
        alert("Cloud save failed. Expense was not saved.");
        return;
    }
    localStorage.setItem('optixExpenses', JSON.stringify(expenses));

    alert("Expense Added");
    loadExpenses();
}

function loadExpenses() {
    const tbody = document.getElementById('expenseList');
    if(!tbody) return;
    tbody.innerHTML = "";
    
    const expenses = JSON.parse(localStorage.getItem('optixExpenses')) || [];
    let total = 0;

    expenses.reverse().forEach(e => {
        const amt = parseFloat(e.amount) || 0;
        total += amt;
        tbody.insertAdjacentHTML('beforeend', `<tr><td>${e.date}</td><td>${e.desc}</td><td>${amt.toFixed(2)}</td><td>${e.mode || '-'}</td></tr>`);
    });
    
    if(document.getElementById('totalExp')) document.getElementById('totalExp').innerText = total.toFixed(2);
}

// --- DATA BACKUP & RESTORE ---
function backupData() {
    const data = {
        products: localStorage.getItem('optixProducts'),
        orders: localStorage.getItem('optixOrders'),
        customers: localStorage.getItem('optixCustomers'),
        expenses: localStorage.getItem('optixExpenses'),
        staff: localStorage.getItem('optixStaff'),
        rx: localStorage.getItem('optixPrescriptions')
    };
    
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "optix_backup_" + new Date().toISOString().slice(0,10) + ".json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
}

function restoreData(inputElement) {
    const file = inputElement.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if(data.products) localStorage.setItem('optixProducts', data.products);
            if(data.orders) localStorage.setItem('optixOrders', data.orders);
            if(data.customers) localStorage.setItem('optixCustomers', data.customers);
            if(data.expenses) localStorage.setItem('optixExpenses', data.expenses);
            if(data.staff) localStorage.setItem('optixStaff', data.staff);
            if(data.rx) localStorage.setItem('optixPrescriptions', data.rx);
            alert("Data Restored Successfully! Page will reload.");
            location.reload();
        } catch(err) {
            alert("Invalid Backup File");
        }
    };
    reader.readAsText(file);
}

// --- AUTO-FILL CUSTOMER DETAILS ON ORDER PAGE ---
function autoFillCustomer() {
    // 1. Get the phone number being typed
    const phone = document.getElementById('cPhone').value.trim();

    // 2. Only search if the phone number is substantial (e.g., 3+ digits) to avoid lag
    // You can change this to 10 if you only want it to trigger on a full number
    if(phone.length < 3) return; 

    // 3. Get existing customers from database
    const customers = JSON.parse(localStorage.getItem('optixCustomers')) || [];

    // 4. Find the customer with this phone number
    const found = customers.find(c => c.phone === phone);

    if (found) {
        // --- Populate Name ---
        const nameField = document.getElementById('cName');
        if(nameField) {
            nameField.value = found.name;
            // Visual feedback (flash green momentarily)
            nameField.style.backgroundColor = "#e8f5e9";
            setTimeout(() => nameField.style.backgroundColor = "white", 500);
        }

        // --- Populate City into Address Field ---
        const addrField = document.getElementById('cAddress');
        if(addrField && found.city) {
            addrField.value = found.city;
        }

        // --- Populate Gender ---
        if (found.gender) {
            const genderRadios = document.getElementsByName('gender');
            for (let radio of genderRadios) {
                if (radio.value === found.gender) {
                    radio.checked = true;
                }
            }
        }
    }
}

// --- GOOGLE-LIKE SEARCH & AUTO-FILL ---

function searchCustomer(type, evt) {
    if (evt && ['ArrowDown','ArrowUp','Enter','Escape','Tab'].includes(evt.key)) {
        return;
    }
    const inputId = type === 'phone' ? 'cPhone' : 'cName';
    const boxId = type === 'phone' ? 'phoneSug' : 'nameSug';
    
    const inputVal = document.getElementById(inputId).value.toLowerCase();
    const box = document.getElementById(boxId);

    // 1. Hide box if input is empty
    if (inputVal.length < 1) {
        box.style.display = 'none';
        return;
    }

    // 2. Get Data
    const customers = JSON.parse(localStorage.getItem('optixCustomers')) || [];
    
    // 3. Filter Matches
    const matches = customers.filter(c => {
        if (type === 'phone') return c.phone.includes(inputVal);
        return c.name.toLowerCase().includes(inputVal);
    });

    // 4. Generate HTML
    box.innerHTML = '';
    box.dataset.activeIndex = '-1';
    if (matches.length > 0) {
        box.style.display = 'block';
        
        matches.slice(0, 5).forEach(c => { // Show max 5 results
            const div = document.createElement('div');
            div.className = 'suggestion-item';
            
            // Highlight the matching text logic could go here, keeping it simple for now
            div.innerHTML = `
                <div>
                    <strong>${c.name}</strong><br>
                    <small>${c.city || 'No City'}</small>
                </div>
                <div style="font-weight:bold; color:#0277bd;">
                    ${c.phone}
                </div>
            `;
            
            // Click Event to Fill Data
            div.onclick = () => {
                fillOrderForm(c);
                box.style.display = 'none'; // Hide after selection
            };
            
            box.appendChild(div);
        });
    } else {
        box.style.display = 'none';
    }
}

function fillOrderForm(c) {
    document.getElementById('cName').value = c.name;
    document.getElementById('cPhone').value = c.phone;
    if(c.city) document.getElementById('cAddress').value = c.city;
    if(c.dob) document.getElementById('cDob').value = c.dob;

    // Auto-select Gender Radio Button
    if (c.gender) {
        const radios = document.getElementsByName('gender');
        for (const radio of radios) {
            if (radio.value === c.gender) radio.checked = true;
        }
    }

    // Clear both suggestion boxes just in case
    document.getElementById('phoneSug').style.display = 'none';
    document.getElementById('nameSug').style.display = 'none';
}

// Close dropdowns if user clicks anywhere else on the screen
document.addEventListener('click', function(e) {
    if (!e.target.closest('.order-group')) {
        hideAllSuggestions();
    }
});

// --- UNIFIED INVENTORY SEARCH ENGINE ---

async function searchInventory(inputId, searchField, categoryGroup, evt) {
    if (evt && ['ArrowDown','ArrowUp','Enter','Escape','Tab'].includes(evt.key)) {
        return;
    }
    const inputVal = document.getElementById(inputId).value.toLowerCase();
    const sugBox = document.getElementById('sug-' + inputId);
    
    // Hide if empty
    if(inputVal.length < 1) {
        sugBox.style.display = 'none';
        return;
    }

    // 1. Fetch Products
    let products = JSON.parse(localStorage.getItem('optixProducts')) || [];
    if (products.length === 0 && db) {
        const cloudProducts = await ensureProductsCache();
        if (Array.isArray(cloudProducts)) products = cloudProducts;
    }

    // 2. Filter Logic
    const results = products.filter(p => {
        // A. Filter by Category Group
        let isCatMatch = false;
        if(categoryGroup === 'Frame') isCatMatch = (p.category === 'Frame' || p.category === 'Sunglasses');
        else if(categoryGroup === 'Lens') isCatMatch = (p.category === 'Lens' || p.category === 'Contact Lens');
        else isCatMatch = true; // For global search

        if(!isCatMatch) return false;

        // B. Filter by Search Text (Code, Brand, or Name)
        if (searchField === 'code') return p.code.toLowerCase().includes(inputVal);
        if (searchField === 'brand') return p.brand.toLowerCase().includes(inputVal);
        if (searchField === 'name') return p.name.toLowerCase().includes(inputVal);
        return false;
    });

    // 3. Render Suggestions
    sugBox.innerHTML = '';
    sugBox.dataset.activeIndex = '-1';
    if(results.length > 0) {
        sugBox.style.display = 'block';
        results.slice(0, 6).forEach(p => {
            const div = document.createElement('div');
            div.className = 'suggestion-item';
            div.innerHTML = `
                <div style="display:flex; justify-content:space-between;">
                    <strong>${p.brand} ${p.name}</strong>
                    <span style="color:blue; font-weight:bold">${p.code}</span>
                </div>
                <div style="font-size:11px; color:#666;">
                    ${p.category} | ${p.color || ''} | ${p.size || ''} | Rs ${p.sellPrice}
                </div>
            `;
            
            // On Click -> Fill the Modal
            div.onclick = () => {
                if(categoryGroup === 'Frame') fillFrameModal(p);
                else if(categoryGroup === 'Lens') fillLensModal(p);
                sugBox.style.display = 'none';
            };
            sugBox.appendChild(div);
        });
    } else {
        sugBox.style.display = 'none';
    }
}

// --- FILL FRAME MODAL ---
function fillFrameModal(p) {
    document.getElementById('frCode').value = p.code;
    document.getElementById('frBrand').value = p.brand;
    document.getElementById('frName').value = p.name;
    document.getElementById('frSize').value = p.size || '';
    document.getElementById('frColor').value = p.color || '';
    document.getElementById('frMaterial').value = p.material || '';
    document.getElementById('frPrice').value = p.sellPrice;
    
    // Close all suggestions
    hideAllSuggestions();
}

// --- FILL LENS MODAL ---
function fillLensModal(p) {
    document.getElementById('lnCode').value = p.code;
    document.getElementById('lnBrand').value = p.brand;
    document.getElementById('lnIndex').value = p.name; // Assuming Index is stored in Name for Lens often
    // Or you can map p.material to Index if that's how you save it
    
    // Attempt to map extra fields if they exist in your product object
    if(p.design) document.getElementById('lnDesign').value = p.design;
    if(p.coating) document.getElementById('lnCoating').value = p.coating;
    
    document.getElementById('lnPrice').value = p.sellPrice;

    // Close all suggestions
    hideAllSuggestions();
}

// --- GLOBAL CLICK HANDLER (To close dropdowns) ---
document.addEventListener('click', function(e) {
    if (!e.target.closest('.popup-form-grid')) {
        hideAllSuggestions();
    }
});




function hideAllSuggestions() {
    document.querySelectorAll('.google-suggestions').forEach(el => el.style.display = 'none');
}

function getSuggestionBoxForInput(inputEl) {
    if (!inputEl || !inputEl.id) return null;
    if (inputEl.id === 'cPhone') return document.getElementById('phoneSug');
    if (inputEl.id === 'cName') return document.getElementById('nameSug');
    return document.getElementById('sug-' + inputEl.id);
}

function setActiveSuggestion(sugBox, items, index) {
    items.forEach((el, i) => el.classList.toggle('active', i === index));
    sugBox.dataset.activeIndex = String(index);
    if (index >= 0 && index < items.length) {
        items[index].scrollIntoView({ block: 'nearest' });
    }
}

// Keyboard navigation for suggestion lists
document.addEventListener('keydown', function(e) {
    const target = e.target;
    if (!target || target.tagName !== 'INPUT') return;

    const sugBox = getSuggestionBoxForInput(target);
    if (!sugBox || sugBox.style.display !== 'block') return;

    const items = Array.from(sugBox.querySelectorAll('.suggestion-item'));
    if (items.length === 0) return;

    let index = parseInt(sugBox.dataset.activeIndex || '-1', 10);

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        index = (index + 1) % items.length;
        setActiveSuggestion(sugBox, items, index);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        index = (index - 1 + items.length) % items.length;
        setActiveSuggestion(sugBox, items, index);
    } else if (e.key === 'Enter') {
        if (index >= 0 && index < items.length) {
            e.preventDefault();
            items[index].click();
        }
    } else if (e.key === 'Escape') {
        hideAllSuggestions();
    }
});







// --- SALES (PENDING / HISTORY) PAGE LOGIC ---

function getSalesViewFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const view = (params.get('view') || 'pending').toLowerCase();
    if (!['pending', 'history', 'return', 'statement'].includes(view)) return 'pending';
    return view;
}

function setSalesTabsActive(view) {
    const tabs = document.querySelectorAll('.sales-tab');
    tabs.forEach(btn => {
        const isActive = btn.dataset.view === view;
        btn.classList.toggle('active', isActive);
    });
}

function setSalesView(view) {
    const valid = ['pending', 'history', 'return', 'statement'];
    const safeView = valid.includes(view) ? view : 'pending';

    const params = new URLSearchParams(window.location.search);
    params.set('view', safeView);
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);

    window.currentSalesView = safeView;
    initSalesHistoryPage();
}

function initSalesHistoryPage() {
    const pendingWrap = document.getElementById('pendingWrapper');
    const historyWrap = document.getElementById('historyWrapper');
    const statementWrap = document.getElementById('statementWrapper');
    const placeholder = document.getElementById('salesPlaceholder');
    const titleEl = document.getElementById('salesPageTitle');

    if (!pendingWrap && !historyWrap && !statementWrap) return;

    const view = window.currentSalesView || getSalesViewFromUrl();
    window.currentSalesView = view;

    const titleMap = {
        pending: 'Pending Orders',
        history: 'Sales History',
        return: 'Sales Return',
        statement: 'Daily Statement PDF'
    };
    const pageTitle = titleMap[view] || 'Sales';
    if (titleEl) titleEl.textContent = pageTitle;
    document.title = pageTitle;
    setSalesTabsActive(view);

    if (view === 'pending') {
        pendingWrap.classList.remove('hidden');
        historyWrap.classList.add('hidden');
        if (statementWrap) statementWrap.classList.add('hidden');
        placeholder.classList.add('hidden');
        loadPendingOrders();
        return;
    }

    if (view === 'history') {
        pendingWrap.classList.add('hidden');
        historyWrap.classList.remove('hidden');
        if (statementWrap) statementWrap.classList.add('hidden');
        placeholder.classList.add('hidden');
        loadSalesHistory();
        return;
    }

    if (view === 'statement') {
        pendingWrap.classList.add('hidden');
        historyWrap.classList.add('hidden');
        if (statementWrap) statementWrap.classList.remove('hidden');
        placeholder.classList.add('hidden');
        setStatementDefaultDates();
        buildDailyStatement();
        return;
    }

    pendingWrap.classList.add('hidden');
    historyWrap.classList.add('hidden');
    if (statementWrap) statementWrap.classList.add('hidden');
    placeholder.classList.remove('hidden');
}

function getSalesFilters() {
    return {
        sName: document.getElementById('sCustName') ? document.getElementById('sCustName').value.toLowerCase() : "",
        sMobile: document.getElementById('sMobile') ? document.getElementById('sMobile').value : "",
        sOrderNo: document.getElementById('sOrderNo') ? document.getElementById('sOrderNo').value.toLowerCase() : "",
        sDateFrom: document.getElementById('sDateFrom') ? document.getElementById('sDateFrom').value : "",
        sDateTo: document.getElementById('sDateTo') ? document.getElementById('sDateTo').value : ""
    };
}

function filterOrders(orders, filters) {
    return orders.filter(o => {
        if(filters.sName && !o.name.toLowerCase().includes(filters.sName)) return false;
        if(filters.sMobile && !o.phone.includes(filters.sMobile)) return false;
        if(filters.sOrderNo && !o.id.toString().includes(filters.sOrderNo)) return false;
        return true;
    });
}

function formatDateBySetting(value) {
    if (!value) return '-';
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) return '-';
    const s = getSettings();
    const fmt = (s.dateFormat || 'DD/MM/YYYY').toUpperCase();
    const dd = String(parsed.getDate()).padStart(2, '0');
    const mm = String(parsed.getMonth() + 1).padStart(2, '0');
    const yyyy = parsed.getFullYear();
    switch (fmt) {
        case 'MM/DD/YYYY': return `${mm}/${dd}/${yyyy}`;
        case 'YYYY-MM-DD': return `${yyyy}-${mm}-${dd}`;
        case 'DD-MM-YYYY': return `${dd}-${mm}-${yyyy}`;
        default: return `${dd}/${mm}/${yyyy}`;
    }
}

function normalizeDateInputValue(value) {
    if (!value) return '';
    if (value instanceof Date) {
        return isNaN(value.getTime()) ? '' : toLocalDateStr(value);
    }

    const raw = String(value).trim();
    if (!raw) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

    const parts = raw.split(/[\/.\-]/).map(p => p.trim()).filter(Boolean);
    if (parts.length === 3) {
        const fmt = (getSettings().dateFormat || 'DD/MM/YYYY').toUpperCase();
        let dd = '';
        let mm = '';
        let yyyy = '';

        if (fmt === 'MM/DD/YYYY') {
            [mm, dd, yyyy] = parts;
        } else if (fmt === 'YYYY-MM-DD') {
            [yyyy, mm, dd] = parts;
        } else {
            [dd, mm, yyyy] = parts;
        }

        if (yyyy && yyyy.length === 4 && dd && mm) {
            return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
        }
    }

    const parsed = new Date(raw);
    return isNaN(parsed.getTime()) ? '' : toLocalDateStr(parsed);
}

function getManagedDateValue(inputOrId) {
    const el = typeof inputOrId === 'string' ? document.getElementById(inputOrId) : inputOrId;
    if (!el) return '';
    return normalizeDateInputValue(el.dataset.isoValue || el.value || '');
}

function refreshManagedDateInput(inputOrId) {
    const el = typeof inputOrId === 'string' ? document.getElementById(inputOrId) : inputOrId;
    if (!el || el.dataset.manageDateFormat !== '1') return;

    const iso = getManagedDateValue(el);
    el.dataset.isoValue = iso;
    el.placeholder = getSettings().dateFormat || 'DD/MM/YYYY';

    if (document.activeElement === el) {
        try { el.type = 'date'; } catch (e) {}
        el.value = iso;
        return;
    }

    try { el.type = 'text'; } catch (e) {}
    el.value = iso ? formatDateBySetting(iso) : '';
}

function setManagedDateValue(inputOrId, value) {
    const el = typeof inputOrId === 'string' ? document.getElementById(inputOrId) : inputOrId;
    if (!el) return;
    el.dataset.isoValue = normalizeDateInputValue(value);
    refreshManagedDateInput(el);
}

function initManagedDateInput(inputOrId, fallbackValue = '') {
    const el = typeof inputOrId === 'string' ? document.getElementById(inputOrId) : inputOrId;
    if (!el) return;

    if (el.dataset.manageDateFormat === '1') {
        if (!getManagedDateValue(el) && fallbackValue) {
            el.dataset.isoValue = normalizeDateInputValue(fallbackValue);
        }
        refreshManagedDateInput(el);
        return;
    }

    el.dataset.manageDateFormat = '1';

    const activateEditor = () => {
        const iso = getManagedDateValue(el) || normalizeDateInputValue(fallbackValue) || toLocalDateStr(new Date());
        el.dataset.isoValue = iso;
        try { el.type = 'date'; } catch (e) {}
        el.value = iso;
        if (typeof el.showPicker === 'function') {
            try { el.showPicker(); } catch (e) {}
        }
    };

    const showFormattedValue = () => {
        const iso = normalizeDateInputValue(el.value) || el.dataset.isoValue || normalizeDateInputValue(fallbackValue);
        el.dataset.isoValue = iso || '';
        try { el.type = 'text'; } catch (e) {}
        el.placeholder = getSettings().dateFormat || 'DD/MM/YYYY';
        el.value = iso ? formatDateBySetting(iso) : '';
    };

    el.addEventListener('focus', activateEditor);
    el.addEventListener('click', () => {
        if (el.type !== 'date') activateEditor();
    });
    el.addEventListener('change', () => {
        const iso = normalizeDateInputValue(el.value);
        if (iso) el.dataset.isoValue = iso;
    });
    el.addEventListener('blur', showFormattedValue);

    const startingValue = getManagedDateValue(el) || normalizeDateInputValue(fallbackValue);
    if (startingValue) el.dataset.isoValue = startingValue;
    showFormattedValue();
}

function initOrderDateInputs() {
    const today = toLocalDateStr(new Date());
    initManagedDateInput('orderDate', today);
    initManagedDateInput('deliveryDate', today);
}

function refreshOrderDateInputs() {
    refreshManagedDateInput('orderDate');
    refreshManagedDateInput('deliveryDate');
}

function formatDisplayDateOnly(value) {
    if (!value) return '-';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return formatDateBySetting(value);
    }
    return formatDateBySetting(value);
}

function formatDisplayDateTime(value) {
    if (!value) return '-';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return formatDateBySetting(value);
    }
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) {
        const datePart = formatDateBySetting(parsed);
        const timePart = parsed.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
        return `${datePart} ${timePart}`;
    }
    return String(value);
}

function renderOrderRow(o, index, options) {
    const status = o.status || "Pending";
    const orderDate = formatDisplayDateTime(o.createdAt || o.updatedAt || o.date);
    const fallbackDelivery = o.date ? toLocalDateStr(new Date(new Date(o.date).getTime() + 86400000)) : '';
    const delDate = formatDisplayDateOnly(o.deliveryDate || fallbackDelivery);

    const amount = parseFloat(o.amount) || 0;
    const paid = parseFloat(o.paid) || 0;
    const balance = amount - paid;
    const totals = computeOrderTotals(o);
    const discount = totals.totalDiscount || 0;
    const settings = getSettings();
    const actionsCfg = settings.actionsConfig || getDefaultActionConfig();

    const actions = [];
    if (settings.showWhatsapp !== false && actionsCfg.sendWhatsapp !== false) {
        actions.push(`<a class="act-btn ic-blue" onclick="sendWhatsapp('${o.phone}', '${o.name}', ${balance}, ${o.id})" title="Send WhatsApp"><i class="fas fa-paper-plane"></i></a>`);
    }
    if (settings.showWhatsapp !== false && actionsCfg.chatWhatsapp !== false) {
        actions.push(`<a class="act-btn ic-whatsapp" onclick="sendWhatsappChat('${o.phone}', '${o.name}', ${balance}, ${o.id})" title="Chat WhatsApp"><i class="fab fa-whatsapp"></i></a>`);
    }

    if (options.showConfirm && actionsCfg.confirmOrder !== false) {
        actions.push(`<a class="act-btn ic-check" onclick="confirmOrder(${o.id})" title="Confirm Order"><i class="fas fa-check"></i></a>`);
    }
    if (options.showConfirm && actionsCfg.editOrder !== false) {
        actions.push(`<a class="act-btn ic-edit" href="#" onclick="editOrder(${o.id})" title="Edit Order"><i class="fas fa-pen"></i></a>`);
    }

    if (actionsCfg.paymentHistory !== false) {
        actions.push(`<a class="act-btn ic-rupee" onclick="viewPayments(${o.id})" title="Payment History"><i class="fas fa-rupee-sign"></i></a>`);
    }

    if (options.showAdvanceReceipt && actionsCfg.advanceReceipt !== false) {
        actions.push(`<a class="act-btn ic-print" onclick="printReceipt(${o.id}, 'advance')" title="Print Advance Receipt"><i class="fas fa-file-invoice"></i></a>`);
    }

    if (actionsCfg.finalInvoice !== false) {
        actions.push(`<a class="act-btn ic-print" onclick="printReceipt(${o.id}, 'invoice')" title="Print Final Invoice"><i class="fas fa-print"></i></a>`);
    }
    if (actionsCfg.viewRx !== false) {
        actions.push(`<a class="act-btn ic-eye" onclick="openRxEditor(${o.id})" title="View/Edit Rx"><i class="fas fa-eye"></i></a>`);
    }

    if (options.showDelete && actionsCfg.deleteOrder !== false) {
        actions.push(`<a class="act-btn ic-delete" onclick="deleteOrder(${o.id})" title="Delete Order"><i class="fas fa-times"></i></a>`);
    }

    const statusLabel = status === "Confirmed" ? `<div style="color:green; font-weight:bold; margin-top:4px;">Status: Confirmed</div>` : '';
    const branchName = settings.branchName || 'Main Branch';

    return `
    <tr>
        <td>${index + 1}</td>
        <td>${orderDate}</td>
        <td>${delDate}</td>
        <td>${formatOrderNoShort(o)}</td>
        <td>
            <strong>Customer Name :</strong><br>
            <span style="color:#0277bd; text-transform:uppercase;">${o.name}</span> <span style="color:#666">(${o.phone.substr(-4)})</span>
        </td>
        <td>${o.phone}</td>
        
        <td class="col-details-money">
            <div class="money-row"><span>Order Value :</span> <span>${amount.toFixed(2)}</span></div>
            <div class="money-row"><span>Total Discount :</span> <span>${discount.toFixed(2)}</span></div>
            <div class="money-row" style="border-top:1px dashed #ccc; margin-top:2px; padding-top:2px;">
                <strong>Total Payable :</strong> <strong>${amount.toFixed(2)}</strong>
            </div>
            <div class="money-row"><span>Advance Paid :</span> <span style="color:green">${paid.toFixed(2)}</span></div>
            <div class="money-row"><span>Return Payment :</span> <span>0.00</span></div>
            <div class="money-row" style="background:${balance > 0 ? '#ffebee' : '#e8f5e9'}; padding:2px;">
                <strong>Balance Amount :</strong> <strong style="color:${balance > 0 ? 'red' : 'green'}">${balance.toFixed(2)}</strong>
            </div>
            ${statusLabel}
        </td>
        
        <td>${branchName}</td>
        <td>Admin</td>
        
        <td>
            <div class="action-grid">
                ${actions.join('')}
            </div>
        </td>
    </tr>
    `;
}

function loadPendingOrders() {
    const tbody = document.getElementById('pendingTableBody');
    if(!tbody) return;

    const filters = typeof getSalesFilters === 'function' ? getSalesFilters() : {};
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const filtered = typeof filterOrders === 'function' ? filterOrders(orders, filters) : orders;

    let htmlContent = ""; 
    filtered.slice().reverse().forEach((o, index) => {
        const status = o.status || "Pending";
        if (status === "Confirmed") return; 

        if (typeof renderOrderRow === 'function') {
            htmlContent += renderOrderRow(o, index, {
                showConfirm: true,
                showAdvanceReceipt: true,
                showDelete: true
            });
        }
    });
    tbody.innerHTML = htmlContent; 
}

function clearFilters() {
    ['sOrderNo', 'sCustName', 'sMobile', 'sSales', 'sDateFrom', 'sDateTo'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    if (window.currentSalesView === 'history') {
        loadSalesHistory();
    } else if (window.currentSalesView === 'statement') {
        setStatementDefaultDates();
        buildDailyStatement();
    } else {
        loadPendingOrders();
    }
}

function runSalesSearch() {
    if (window.currentSalesView === 'history') {
        loadSalesHistory();
    } else if (window.currentSalesView === 'statement') {
        buildDailyStatement();
    } else {
        loadPendingOrders();
    }
}

// --- DAILY STATEMENT PDF ---

let lastStatementRange = null;

function toLocalDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getStatementDateRange() {
    const filters = getSalesFilters();
    let from = filters.sDateFrom;
    let to = filters.sDateTo;
    const today = toLocalDateStr(new Date());

    if (!from && !to) {
        from = today;
        to = today;
    } else if (!from) {
        from = to;
    } else if (!to) {
        to = from;
    }

    if (from > to) {
        const tmp = from;
        from = to;
        to = tmp;
    }

    return { from, to };
}

function setStatementDefaultDates() {
    const fromEl = document.getElementById('sDateFrom');
    const toEl = document.getElementById('sDateTo');
    if (!fromEl || !toEl) return;

    const today = toLocalDateStr(new Date());
    if (!fromEl.value) fromEl.value = today;
    if (!toEl.value) toEl.value = today;
}

function ensureDailyStatementStyles() {
    if (document.getElementById('ds-style')) return;
    const style = document.createElement('style');
    style.id = 'ds-style';
    style.textContent = `
        .ds-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 12px;
            margin: 10px 0 16px;
        }
        .ds-card {
            border-radius: 10px;
            padding: 12px 14px;
            color: #0f172a;
            box-shadow: 0 4px 10px rgba(15, 23, 42, 0.08);
            border: 1px solid rgba(0,0,0,0.05);
            background: linear-gradient(135deg, #ffffff, #f8fafc);
        }
        .ds-card.ds-blue { background: linear-gradient(135deg, #e0f2fe, #ffffff); border-color:#bae6fd; }
        .ds-card.ds-purple { background: linear-gradient(135deg, #ede9fe, #ffffff); border-color:#ddd6fe; }
        .ds-card.ds-green { background: linear-gradient(135deg, #dcfce7, #ffffff); border-color:#bbf7d0; }
        .ds-card.ds-amber { background: linear-gradient(135deg, #fef3c7, #ffffff); border-color:#fde68a; }
        .ds-card.ds-red { background: linear-gradient(135deg, #fee2e2, #ffffff); border-color:#fecaca; }
        .ds-card.ds-teal { background: linear-gradient(135deg, #ccfbf1, #ffffff); border-color:#99f6e4; }
        .ds-card.ds-slate { background: linear-gradient(135deg, #e2e8f0, #ffffff); border-color:#cbd5e1; }
        .ds-card-title { font-size:13px; font-weight:700; letter-spacing:0.2px; color:#334155; }
        .ds-card-value { font-size:20px; font-weight:800; margin-top:4px; color:#0f172a; }
        .ds-card-sub { font-size:12px; color:#475569; margin-top:4px; line-height:1.4; }
        .ds-section-title { margin: 16px 0 8px; font-size:14px; font-weight:800; color:#0f172a; }
        .ds-table { width:100%; border-collapse:collapse; font-size:12px; box-shadow:0 3px 10px rgba(15,23,42,0.08); }
        .ds-table th { background:#f8fafc; color:#334155; font-weight:700; text-align:left; }
        .ds-table th, .ds-table td { border:1px solid #e2e8f0; padding:8px; }
        .ds-table tbody tr:nth-child(odd) { background:#f9fafb; }
        .ds-badge { display:inline-block; padding:2px 8px; border-radius:12px; font-size:10px; font-weight:700; }
        .ds-badge.pending { background:#fef3c7; color:#92400e; }
        .ds-badge.confirmed { background:#dcfce7; color:#166534; }
    `;
    document.head.appendChild(style);
}

function buildDailyStatement() {
    const container = document.getElementById('statementContent');
    if (!container) return;
    ensureDailyStatementStyles();

    const { from, to } = getStatementDateRange();
    lastStatementRange = { from, to };

    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const expenses = JSON.parse(localStorage.getItem('optixExpenses')) || [];
    const rows = [];
    let totalAmount = 0;
    let totalPaid = 0;
    let totalCash = 0;
    let totalUpi = 0;
    let totalBank = 0;
    let expCash = 0;
    let expUpi = 0;
    let expBank = 0;
    const expenseRows = [];

    const formatTsShort = (ts) => {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return ts || "";
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
    };

    orders.forEach(o => {
        const status = o.status || "Pending";
        const orderDate = toLocalDateStr(new Date(o.date));
        if (orderDate < from || orderDate > to) return;

        const amount = parseFloat(o.amount) || 0;
        const paid = parseFloat(o.paid) || 0;
        const paidCash = parseFloat(o.paidCash) || 0;
        const paidUpi = parseFloat(o.paidUpi) || 0;
        const paidBank = parseFloat(o.paidBank) || 0;
        const balance = amount - paid;
        totalAmount += amount;
        totalPaid += paid;
        totalCash += paidCash;
        totalUpi += paidUpi;
        totalBank += paidBank;

        rows.push({
            date: orderDate,
            id: o.id,
            name: o.name,
            phone: o.phone,
            amount,
            paid,
            balance,
            paidCash,
            paidUpi,
            paidBank,
            status,
            history: Array.isArray(o.paymentHistory) ? o.paymentHistory : []
        });
    });

    expenses.forEach(e => {
        const expDate = toLocalDateStr(new Date(e.date));
        if (expDate < from || expDate > to) return;
        const amt = parseFloat(e.amount) || 0;
        const mode = (e.mode || 'cash').toLowerCase();
        if (mode === 'upi') expUpi += amt;
        else if (mode === 'bank' || mode === 'card') expBank += amt;
        else expCash += amt;
        expenseRows.push({
            date: expDate,
            desc: e.desc || '',
            amount: amt,
            mode: mode
        });
    });

    const expTotal = expCash + expUpi + expBank;
    const netPaid = totalPaid - expTotal;
    const netCash = totalCash - expCash;
    const netUpi = totalUpi - expUpi;
    const netBank = totalBank - expBank;

    const totalBalance = totalAmount - totalPaid;

    const headerHtml = `
        <div style="text-align:center; margin:6px 0 4px;">
            <div style="font-size:20px; font-weight:800;">CITY OPTICAL CENTER</div>
            <div style="font-size:12px;">Daily Statement</div>
            <div style="font-size:12px; color:#555;">From ${from} To ${to}</div>
        </div>
        <div class="ds-cards">
            <div class="ds-card ds-blue">
                <div class="ds-card-title">Total Orders</div>
                <div class="ds-card-value">${rows.length}</div>
            </div>
            <div class="ds-card ds-purple">
                <div class="ds-card-title">Total Amount</div>
                <div class="ds-card-value">Rs ${totalAmount.toFixed(2)}</div>
            </div>
            <div class="ds-card ds-green">
                <div class="ds-card-title">Total Paid</div>
                <div class="ds-card-value">Rs ${totalPaid.toFixed(2)}</div>
                <div class="ds-card-sub">Cash: ${totalCash.toFixed(2)} | UPI: ${totalUpi.toFixed(2)} | Card/Bank: ${totalBank.toFixed(2)}</div>
            </div>
            <div class="ds-card ds-amber">
                <div class="ds-card-title">Total Balance</div>
                <div class="ds-card-value">Rs ${totalBalance.toFixed(2)}</div>
            </div>
            <div class="ds-card ds-red">
                <div class="ds-card-title">Expenses</div>
                <div class="ds-card-value">Rs ${expTotal.toFixed(2)}</div>
                <div class="ds-card-sub">Cash: ${expCash.toFixed(2)} | UPI: ${expUpi.toFixed(2)} | Card/Bank: ${expBank.toFixed(2)}</div>
            </div>
            <div class="ds-card ds-teal">
                <div class="ds-card-title">Net Collected (Paid - Expenses)</div>
                <div class="ds-card-value">Rs ${netPaid.toFixed(2)}</div>
            </div>
            <div class="ds-card ds-slate">
                <div class="ds-card-title">Net In Hand</div>
                <div class="ds-card-value">Cash: ${netCash.toFixed(2)}</div>
                <div class="ds-card-sub">UPI: ${netUpi.toFixed(2)} | Card/Bank: ${netBank.toFixed(2)}</div>
            </div>
        </div>
    `;

    const tableRows = rows.map((r, i) => `
        <tr>
            <td>${i + 1}</td>
            <td>${r.date}</td>
            <td>${formatOrderNoShort(r)}</td>
            <td>${r.name}</td>
            <td>${r.phone}</td>
            <td style="text-align:center;">${r.status ? `<span class="ds-badge ${r.status.toLowerCase()}">${r.status}</span>` : ''}</td>
            <td style="text-align:right;">${r.amount.toFixed(2)}</td>
            <td style="text-align:right;">${r.paid.toFixed(2)}</td>
            <td style="text-align:right;">
                <div>Cash: ${r.paidCash.toFixed(2)}</div>
                <div>UPI: ${r.paidUpi.toFixed(2)}</div>
                <div>Card/Bank: ${r.paidBank.toFixed(2)}</div>
            </td>
            <td style="text-align:right;">${r.balance.toFixed(2)}</td>
            <td style="font-size:11px; line-height:1.4;">
                ${
                    r.history.length
                        ? r.history.map((h, idx) => `${idx + 1}) ${formatTsShort(h.ts)} - Cash ${ (parseFloat(h.cash)||0).toFixed(2) }, UPI ${(parseFloat(h.upi)||0).toFixed(2)}, Card ${(parseFloat(h.bank)||0).toFixed(2)}`).join('<br>')
                        : '<span style="color:#777">No payment entries saved</span>'
                }
            </td>
        </tr>
    `).join('');

    const expensesTableRows = expenseRows.map((e, i) => `
        <tr>
            <td>${i + 1}</td>
            <td>${e.date}</td>
            <td>${e.desc}</td>
            <td style="text-align:right;">${e.amount.toFixed(2)}</td>
            <td style="text-transform:uppercase; text-align:center;">${e.mode}</td>
        </tr>
    `).join('');

    const ordersTableHtml = rows.length ? `
        <div class="ds-section-title">Sales</div>
        <table class="ds-table" style="margin-bottom:16px;">
            <thead>
                <tr style="background:#f4f4f4;">
                    <th style="padding:6px;">#</th>
                    <th style="padding:6px;">Date</th>
                    <th style="padding:6px;">Order No</th>
                    <th style="padding:6px;">Customer</th>
                    <th style="padding:6px;">Phone</th>
                    <th style="padding:6px;">Status</th>
                    <th style="padding:6px; text-align:right;">Amount</th>
                    <th style="padding:6px; text-align:right;">Paid</th>
                    <th style="padding:6px; text-align:right;">Paid Split</th>
                    <th style="padding:6px; text-align:right;">Balance</th>
                    <th style="padding:6px; text-align:left;">Payment History</th>
                </tr>
            </thead>
            <tbody>
                ${tableRows}
            </tbody>
        </table>
    ` : `<div style="padding:10px; font-size:12px; color:#777;">No sales found in this date range.</div>`;

    const expensesTableHtml = expenseRows.length ? `
        <div class="ds-section-title">Expenses</div>
        <table class="ds-table">
            <thead>
                <tr style="background:#f4f4f4;">
                    <th style="padding:6px;">#</th>
                    <th style="padding:6px;">Date</th>
                    <th style="padding:6px;">Description</th>
                    <th style="padding:6px; text-align:right;">Amount</th>
                    <th style="padding:6px; text-align:center;">Mode</th>
                </tr>
            </thead>
            <tbody>
                ${expensesTableRows}
            </tbody>
        </table>
    ` : `<div style="padding:10px; font-size:12px; color:#777;">No expenses found in this date range.</div>`;

    container.innerHTML = headerHtml + ordersTableHtml + expensesTableHtml;
}

function downloadDailyStatementPDF() {
    if (typeof html2pdf === 'undefined') { alert("Internet required for PDF export!"); return; }

    if (!lastStatementRange) {
        buildDailyStatement();
    }

    const element = document.getElementById('statementContent');
    if (!element) return;

    const range = lastStatementRange || getStatementDateRange();
    const opt = {
        margin: 0.2,
        filename: `Daily_Statement_${range.from}_to_${range.to}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2 },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
    };
    html2pdf().set(opt).from(element).save();
}

// --- ACTION FEATURES ---

function sendWhatsapp(phone, name, balance, orderId) {
    const popup = window.open('about:blank', '_blank');
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const order = orders.find(o => o.id === orderId);
    const status = order && order.status ? order.status : "Pending";

    const baseUrl = window.location.origin + window.location.pathname.replace(/[^/]+$/, '');
    const docType = status === "Confirmed" ? "invoice" : "advance";
    const label = status === "Confirmed" ? "Final Invoice" : "Advance Receipt";

    (async () => {
        const invoicePath = await resolveShareableInvoiceUrl(orderId, { type: docType, order, settings: getSettings() });
        const link = `${baseUrl}${invoicePath}`;
        const msg = `Dear ${name}, your ${label} is ready. Balance amount is Rs ${balance}. Please collect it. ${link} - City Optical`;
        const waUrl = `https://wa.me/91${phone}?text=${encodeURIComponent(msg)}`;
        if (popup) {
            popup.location = waUrl;
        } else {
            window.open(waUrl, '_blank');
        }
    })().catch((err) => {
        console.error('WhatsApp share failed:', err);
        if (popup) popup.close();
        alert('Unable to prepare invoice link right now.');
    });
}

function sendWhatsappChat(phone, name, balance, orderId) {
    // Same message as Send WhatsApp, just used for the chat icon
    sendWhatsapp(phone, name, balance, orderId);
}

// Helper: send invoice link via WhatsApp using only orderId
function sendInvoiceWhatsApp(orderId) {
    const order = findOrderById(orderId);
    if (!order) return alert('Order not found');
    const phone = order.phone || '';
    const name = order.name || '';
    const balance = (parseFloat(order.amount) || 0) - (parseFloat(order.paid) || 0);
    sendWhatsapp(phone, name, balance, orderId);
}

function editOrder(id) {
    window.location.href = `order.html?editId=${id}`;
}

function confirmOrder(id) {
    if(confirm("Open this order to add remaining amount/products and confirm?")) {
        let orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
        const idx = orders.findIndex(o => o.id === id);
        if (idx === -1) return;

        // Redirect to order edit page to update remaining amount/products, then confirm there
        window.location.href = `order.html?editId=${id}&mode=confirm`;
    }
}

async function deleteOrder(id) {
    if(confirm("Are you sure you want to DELETE this order? This cannot be undone.")) {
        try {
            if (db) await deleteEntityFromCloud('optixOrders', id);
        } catch (err) {
            console.error("Cloud order delete failed:", err);
            alert("Cloud delete failed.");
            return;
        }
        let orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
        orders = orders.filter(o => String(o.id) !== String(id));
        localStorage.setItem('optixOrders', JSON.stringify(orders));
        loadPendingOrders();
    }
}

function printReceipt(id, type) {
    const order = findOrderById(id);
    window.open(buildInvoiceUrl(id, { type, order }), '_blank');
}

function viewPayments(id) {
    // Determine info from ID
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const order = orders.find(o => o.id === id);
    if(order) {
        const paidCash = parseFloat(order.paidCash) || 0;
        const paidUpi = parseFloat(order.paidUpi) || 0;
        const paidBank = parseFloat(order.paidBank) || 0;
        const paidTotal = parseFloat(order.paid) || (paidCash + paidUpi + paidBank);
        const balance = (parseFloat(order.amount) || 0) - paidTotal;
        const history = Array.isArray(order.paymentHistory) ? order.paymentHistory : [];
        const historyText = history.length
            ? history.map((p, i) => {
                const d = new Date(p.ts);
                const ts = isNaN(d.getTime()) ? (p.ts || "") : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                return `${i+1}) ${ts} -> Cash ${ (parseFloat(p.cash)||0).toFixed(2) }, UPI ${ (parseFloat(p.upi)||0).toFixed(2) }, Card ${ (parseFloat(p.bank)||0).toFixed(2) }`;
            }).join('\n')
            : "No individual payment entries recorded.";

        alert(
            `Payment Details for Order #${id}\n\n` +
            `Total: ${parseFloat(order.amount || 0).toFixed(2)}\n` +
            `Paid Total: ${paidTotal.toFixed(2)}\n` +
            ` - Cash: ${paidCash.toFixed(2)}\n` +
            ` - UPI: ${paidUpi.toFixed(2)}\n` +
            ` - Bank/Card: ${paidBank.toFixed(2)}\n` +
            `Balance: ${balance.toFixed(2)}\n\n` +
            `Payment History:\n${historyText}`
        );
    }
}


