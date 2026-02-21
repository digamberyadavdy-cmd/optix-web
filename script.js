
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

// 2. Get current file name
const path = window.location.pathname;
const page = path.split("/").pop();

// 3. Check Authentication
const isLoggedIn = localStorage.getItem('optixLoggedIn') === 'true';
const settingsGate = getSettings();
const loginRequired = settingsGate.loginRequired !== false;

// 4. Redirect if not logged in AND trying to access a private page
if (loginRequired && !isLoggedIn && !publicPages.includes(page) && page !== "") {
    // Save where they were trying to go (optional)
    console.log("Unauthorized access. Redirecting to login.");
    window.location.href = 'login.html';
}

document.addEventListener("DOMContentLoaded", () => {
    initFirebaseServices();
    initCloudSync().then(async () => {
    await ensureProductsCache();
    applySettings();
    ensureSettingsModal();
    bindSettingsIcon();
    // 1. Initial Checks for Order Page
    const today = new Date().toISOString().split('T')[0];
    if(document.getElementById('orderDate')) document.getElementById('orderDate').value = today;
    if(document.getElementById('deliveryDate')) document.getElementById('deliveryDate').value = today;
    
    // Auto-add first row if on Order Page
    if(document.getElementById('billTableBody')) {
        const tbody = document.getElementById('billTableBody');
        if(tbody.children.length === 0) addNewRow();
    }

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
    }).catch((err) => {
        console.error("App init failed:", err);
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
    } catch (err) {
        console.error('Firebase init failed:', err);
    }
}

// --- SETTINGS & AUTH ---
const FIREBASE_PROJECT_ID = 'optixweb-68694';
const DEFAULT_CLOUD_SYNC_URL = `https://${FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com/optixSync.json`;
const CLOUD_SYNC_EXCLUDE_KEYS = ['optixLoggedIn', 'optixSessionStart', 'tempCustName', 'tempCustPhone'];
const FIRESTORE_STATE_EXCLUDE_KEYS = ['optixProducts'];
let cloudSyncTimer = null;
let cloudSyncBusy = false;
let cloudApplyMode = false;
let firestoreStateApplyMode = false;
let firestoreStateSyncBusy = false;
let firestoreStateSyncTimer = null;
const firestoreStateQueue = new Map();

function getSettings() {
    const defaults = {
        loginRequired: true,
        showWhatsapp: true,
        stockCheck: true,
        autoInvoiceNo: true,
        enableDiscounts: true,
        cloudSyncEnabled: false,
        cloudSyncUrl: DEFAULT_CLOUD_SYNC_URL,
        cloudSyncToken: ''
    };
    try {
        const raw = localStorage.getItem('optixSettings');
        const parsed = raw ? JSON.parse(raw) : {};
        return { ...defaults, ...parsed };
    } catch (e) {
        return { ...defaults };
    }
}

function saveSettings(settings) {
    localStorage.setItem('optixSettings', JSON.stringify(settings));
}

function shouldSyncKey(key) {
    return typeof key === 'string' && key.startsWith('optix') && !CLOUD_SYNC_EXCLUDE_KEYS.includes(key);
}

function shouldSyncFirestoreStateKey(key) {
    return shouldSyncKey(key) && !FIRESTORE_STATE_EXCLUDE_KEYS.includes(key);
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

function getCloudHeaders(token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

function buildSyncSnapshot() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (shouldSyncKey(key)) {
            data[key] = localStorage.getItem(key);
        }
    }
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
    const ok = await pushCloudSnapshot('manual');
    if (ok) alert("Cloud sync complete.");
}

async function pullNowFromCloud() {
    const ok = await pullCloudSnapshot(true);
    if (ok) location.reload();
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
            const ref = db.collection('app_state').doc(item.key);
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
    } catch (err) {
        console.error('Firestore state sync failed:', err);
    } finally {
        firestoreStateSyncBusy = false;
    }
}

async function seedFirestoreStateFromLocal() {
    if (!db) return;
    const batch = db.batch();
    let hasData = false;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!shouldSyncFirestoreStateKey(key)) continue;
        hasData = true;
        const ref = db.collection('app_state').doc(key);
        batch.set(ref, {
            value: localStorage.getItem(key),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }
    if (hasData) await batch.commit();
}

async function pullFirestoreState() {
    if (!db) return;
    try {
        const snapshot = await db.collection('app_state').get();
        if (snapshot.empty) {
            await seedFirestoreStateFromLocal();
            return;
        }
        firestoreStateApplyMode = true;
        snapshot.forEach((doc) => {
            const data = doc.data() || {};
            if (!shouldSyncFirestoreStateKey(doc.id)) return;
            if (typeof data.value === 'string') {
                localStorage.setItem(doc.id, data.value);
            }
        });
    } catch (err) {
        console.error('Firestore state pull failed:', err);
    } finally {
        firestoreStateApplyMode = false;
    }
}

function hookStorageForCloudSync() {
    if (window.__optixStorageHooked) return;
    window.__optixStorageHooked = true;
    const _setItem = localStorage.setItem.bind(localStorage);
    const _removeItem = localStorage.removeItem.bind(localStorage);
    const _clear = localStorage.clear.bind(localStorage);

    localStorage.setItem = function(key, value) {
        _setItem(key, value);
        if (shouldSyncKey(key)) scheduleCloudSync();
        if (!firestoreStateApplyMode) queueFirestoreStateSync(key, value, false);
    };
    localStorage.removeItem = function(key) {
        _removeItem(key);
        if (shouldSyncKey(key)) scheduleCloudSync();
        if (!firestoreStateApplyMode) queueFirestoreStateSync(key, null, true);
    };
    localStorage.clear = function() {
        _clear();
        scheduleCloudSync();
    };
}

async function initCloudSync() {
    hookStorageForCloudSync();
    await pullFirestoreState();
    await pullCloudSnapshot(false);
}

function applySettings() {
    const s = getSettings();
    window.__optixSettings = s;

    // Discounts on/off
    const discAmt = document.getElementById('txtDiscAmount');
    const discPct = document.getElementById('txtDiscPercent');
    if (discAmt) discAmt.disabled = !s.enableDiscounts;
    if (discPct) discPct.disabled = !s.enableDiscounts;
    if (!s.enableDiscounts) {
        if (discAmt) discAmt.value = "0";
        if (discPct) discPct.value = "0";
        document.querySelectorAll('.row-disc').forEach(el => {
            el.value = "0";
            if (typeof calcRow === 'function') calcRow(el);
        });
    }

    if (typeof calculateFinal === 'function') calculateFinal();
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

function saveSettingsFromModal() {
    const s = getSettings();
    const read = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
    s.loginRequired = read('set_login_required');
    s.showWhatsapp = read('set_show_whatsapp');
    s.stockCheck = read('set_stock_check');
    s.autoInvoiceNo = read('set_auto_invoice');
    s.enableDiscounts = read('set_enable_discounts');
    s.cloudSyncEnabled = read('set_cloud_sync');
    s.cloudSyncUrl = (document.getElementById('set_cloud_url')?.value || '').trim();
    s.cloudSyncToken = (document.getElementById('set_cloud_token')?.value || '').trim();
    saveSettings(s);
    applySettings();
    closeSettingsModal();

    if (typeof loadPendingOrders === 'function') loadPendingOrders();
    if (typeof loadSalesHistory === 'function') loadSalesHistory();
    scheduleCloudSync();
}

function bindSettingsIcon() {
    document.querySelectorAll('.nav-icon.bg-purple, .fa-cog').forEach(el => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', (e) => {
            e.preventDefault();
            openSettingsModal();
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
    localStorage.removeItem('optixLoggedIn');
    alert("All data cleared. The page will reload.");
    window.location.href = 'login.html';
}

function performLogin() {
    const user = document.getElementById('loginUser').value;
    const pass = document.getElementById('loginPass').value;
    const errorMsg = document.getElementById('loginError');

    // --- SET YOUR PASSWORD HERE ---
    // Currently set to: admin / admin123
    if (user === "admin" && pass === "admin123") {
        localStorage.setItem('optixLoggedIn', 'true');
        localStorage.setItem('optixSessionStart', new Date().toISOString());
        window.location.href = 'dashboard.html';
    } else {
        if (errorMsg) errorMsg.style.display = 'block';
        const card = document.querySelector('.login-card');
        if (card) {
            card.style.transform = "translateX(5px)";
            setTimeout(() => card.style.transform = "translateX(0)", 100);
        }
    }
}

function performLogout() {
    if(confirm("Are you sure you want to Logout?")) {
        localStorage.removeItem('optixLoggedIn');
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
    if (!db) return null;
    const ref = await db.collection("products").add(productData);
    return { ...productData, _docId: ref.id };
}

async function ensureProductsCache() {
    const cached = JSON.parse(localStorage.getItem('optixProducts')) || [];
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
    const snapshot = await db.collection("products").get();
    const products = [];
    snapshot.forEach((doc) => {
        products.push({ ...doc.data(), _docId: doc.id });
    });
    localStorage.setItem('optixProducts', JSON.stringify(products));
    return products;
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
            category: document.getElementById('nCat').value,
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
                console.error("Cloud save failed for product; saving locally.", err);
                products.push(newProd);
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

// --- UPDATED LOAD PRODUCTS (With Edit Button) ---
async function loadProducts() {
    const tbody = document.getElementById('productListBody');
    if (!tbody) return;
    tbody.innerHTML = "";

    const products = JSON.parse(localStorage.getItem('optixProducts')) || [];
    
    // Get Search Inputs
    const fCat = document.getElementById('fCat') ? document.getElementById('fCat').value.toLowerCase() : "";
    const fCode = document.getElementById('fCode') ? document.getElementById('fCode').value.toLowerCase() : "";
    const fName = document.getElementById('fName') ? document.getElementById('fName').value.toLowerCase() : "";
    const fBrand = document.getElementById('fBrand') ? document.getElementById('fBrand').value.toLowerCase() : "";

    products.forEach((p, index) => {
        // FILTER LOGIC
        if (fCat && p.category.toLowerCase() !== fCat) return;
        if (fCode && !p.code.toLowerCase().includes(fCode)) return;
        if (fName && !p.name.toLowerCase().includes(fName)) return;
        if (fBrand && !p.brand.toLowerCase().includes(fBrand)) return;

        const descParts = [p.brand, p.name, p.color, p.size].filter(Boolean).join(" - ");

        const row = `
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
                <td>${p.createdOn.split(',')[0]}</td>
                <td>
                    <i class="fas fa-edit" style="color:#ff9800; cursor:pointer; margin-right:10px; font-size:16px;" onclick="editProduct(${index})" title="Edit Item"></i>
                    
                    <i class="fas fa-trash" style="color:red; cursor:pointer; font-size:16px;" onclick="deleteProduct(${index})" title="Delete Item"></i>
                </td>
            </tr>
        `;
        tbody.insertAdjacentHTML('beforeend', row);
    });
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

    localStorage.setItem('optixProducts', JSON.stringify(products));
    if (db && p._docId) {
        try {
            const { _docId, ...cloudPayload } = p;
            await db.collection("products").doc(_docId).set(cloudPayload, { merge: true });
        } catch (err) {
            console.error("Cloud update failed; local update kept.", err);
        }
    }
    
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
        localStorage.setItem('optixProducts', JSON.stringify(products));
        if (db && deleted && deleted._docId) {
            try {
                await db.collection("products").doc(deleted._docId).delete();
            } catch (err) {
                console.error("Cloud delete failed; local delete kept.", err);
            }
        }
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
            total: total,
            rx: row.querySelector('.row-rx-data').value
                ? JSON.parse(row.querySelector('.row-rx-data').value)
                : null
        });
    });

    if(hasStockIssue) return; // Stop if stock error
    if(items.length === 0) { alert("Please add at least one valid item!"); return; }

    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
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
    const isFullyPaid = totalPaidNow >= payableNow;
    const nextStatus = (isEdit && editingOriginalOrder && editingOriginalOrder.status === "Confirmed" && isFullyPaid)
        ? "Confirmed"
        : "Pending";

    let invoiceNo = (isEdit && editingOriginalOrder && editingOriginalOrder.invoiceNo)
        ? editingOriginalOrder.invoiceNo
        : null;
    if (settings.autoInvoiceNo !== false) {
        if (!invoiceNo) invoiceNo = getNextInvoiceNo();
    }

    const updatedOrder = {
        id: orderId,
        invoiceNo: invoiceNo,
        name: name,
        phone: phone,
        amount: payableNow,
        paid: totalPaidNow,
        paidCash: paidCashTotal,
        paidUpi: paidUpiTotal,
        paidBank: paidBankTotal,
        date: document.getElementById('orderDate').value || new Date().toISOString(),
        baseTotal: baseTotal,
        grossTotal: grossTotal,
        discount: discountAmount,
        discountPercent: discountPercent,
        roundOff: roundOff,
        status: nextStatus,
        items: items
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

    localStorage.setItem('optixOrders', JSON.stringify(orders));
    localStorage.setItem('optixProducts', JSON.stringify(productsWorking));

    // Save Customer Data (Updates existing or adds new)
    const customers = JSON.parse(localStorage.getItem('optixCustomers')) || [];
    const custIndex = customers.findIndex(c => c.phone === phone);
    if (custIndex > -1) {
        customers[custIndex].name = name; 
        customers[custIndex].lastVisit = updatedOrder.date;
    } else {
        customers.push({ id: Date.now(), name: name, phone: phone, lastVisit: updatedOrder.date });
    }
    localStorage.setItem('optixCustomers', JSON.stringify(customers));

    // 5. SUCCESS
    if(openInNewTab) {
        window.open(`invoice.html?orderId=${updatedOrder.id}`, '_blank');
        if (!isEdit) location.reload(); 
    } else {
        window.location.href = `invoice.html?orderId=${updatedOrder.id}`;
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
    // 1. Get Current Date Info
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0]; // Format: YYYY-MM-DD
    const currentMonth = now.getMonth(); // 0-11
    const currentYear = now.getFullYear();

    // 2. Fetch Data from LocalStorage
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const expenses = JSON.parse(localStorage.getItem('optixExpenses')) || [];

    // 3. Initialize Counters
    let todaySales = 0;
    let monthSales = 0;
    let totalPending = 0;
    let monthBillCount = 0;
    let todayExpense = 0;

    // 4. Calculate Order Stats
    orders.forEach(o => {
        const oDate = new Date(o.date);
        const oDateStr = oDate.toISOString().split('T')[0];

        // Pending Balance (Total Amount - Paid Amount)
        totalPending += (o.amount - o.paid);

        // Today's Sales
        if (oDateStr === todayStr) {
            todaySales += o.amount;
        }

        // This Month's Data
        if (oDate.getMonth() === currentMonth && oDate.getFullYear() === currentYear) {
            monthSales += o.amount;
            monthBillCount++;
        }
    });

    // 5. Calculate Expense Stats (Today Only)
    expenses.forEach(e => {
        // Assuming expense object has a 'date' and 'amount'
        if (e.date === todayStr) {
            todayExpense += parseFloat(e.amount) || 0;
        }
    });

    // 6. Update the HTML Elements
    // Pending Task Panel
    if(document.getElementById('dash-pending-val')) {
        const pendingEl = document.getElementById('dash-pending-val');
        pendingEl.innerText = "Rs " + totalPending.toFixed(2);
        // Turn red if there is pending balance, green if 0
        pendingEl.style.color = totalPending > 0 ? "red" : "green";
    }

    // Today's Data Panel
    if(document.getElementById('dash-today-sales')) {
        document.getElementById('dash-today-sales').innerText = "Rs " + todaySales.toFixed(2);
    }
    if(document.getElementById('dash-expenses')) {
        document.getElementById('dash-expenses').innerText = "Rs " + todayExpense.toFixed(2);
    }

    // This Month Data Panel
    if(document.getElementById('dash-total-sales')) {
        document.getElementById('dash-total-sales').innerText = "Rs " + monthSales.toFixed(2);
    }
    if(document.getElementById('dash-bill-count')) {
        document.getElementById('dash-bill-count').innerText = monthBillCount;
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

// --- UPDATED SALES HISTORY LOADER (Fixes Print Button) ---
function loadSalesHistory() {
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const tbody = document.getElementById('salesHistoryBody');
    if(!tbody) return;
    
    tbody.innerHTML = "";
    
    // Sort orders so newest appears first
    orders.reverse().forEach(o => {
        const balance = o.amount - o.paid;
        const statusBadge = balance <= 0 
            ? '<span style="background:green; color:white; padding:2px 6px; border-radius:4px;">Paid</span>' 
            : '<span style="background:orange; padding:2px 6px; border-radius:4px;">Due</span>';

        tbody.insertAdjacentHTML('beforeend', `
            <tr>
                <td>${new Date(o.date).toLocaleDateString()}</td>
                <td>${o.name}</td>
                <td>Rs ${o.amount}</td>
                <td>Rs ${o.paid}</td>
                <td style="color:${balance > 0 ? 'red' : 'green'}; font-weight:bold;">Rs ${balance.toFixed(2)}</td>
                <td>
                    <button onclick="openInvoiceNewTab('${o.id}')" style="cursor:pointer; background:#2563eb; color:white; border:none; padding:5px 10px; border-radius:3px;">
                        <i class="fas fa-print"></i> Print
                    </button>
                </td>
            </tr>
        `);
    });
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
    // Opens invoice.html passing the Order ID in the URL
    window.open(`invoice.html?orderId=${orderId}`, '_blank');
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
                    console.error("Cloud save failed for product; saving locally.", err);
                    products.push(newProd);
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
                console.error("Cloud save failed for product; saving locally.", err);
                products.push(newProd);
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

function initOrderPage() {
    const orderDate = document.getElementById('orderDate');
    if (orderDate && !orderDate.value) {
        orderDate.valueAsDate = new Date();
    }

    const urlParams = new URLSearchParams(window.location.search);
    const editId = urlParams.get('editId');
    if (editId) {
        loadOrderForEdit(editId);
        return;
    }

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

function loadOrderForEdit(id) {
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const order = orders.find(o => o.id == id);
    if (!order) { alert("Order not found."); return; }

    editingOrderId = order.id;
    editingOriginalOrder = JSON.parse(JSON.stringify(order));
    setOrderHeaderForEdit(order);

    const orderDate = document.getElementById('orderDate');
    if (orderDate) orderDate.value = toLocalDateStr(new Date(order.date));

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

            row.querySelector('.barcode').value = barcode;
            row.querySelector('.p-type').value = item.type || "";
            row.querySelector('.p-code').value = code;
            row.querySelector('.desc').value = desc;
            row.querySelector('.qty').value = qty;
            row.querySelector('.price').value = price;
            row.querySelector('.row-disc').value = disc;

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
            
            <td><input type="number" class="row-disc" value="0" oninput="calcRow(this)" style="text-align:center; color:red;"></td>
            
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

    activeRow.querySelector('.p-code').value = code;
    activeRow.querySelector('.desc').value = `FRAME: ${brand} ${name}`;
    activeRow.querySelector('.price').value = price;
    
    calcRow(activeRow.querySelector('.price')); // Recalculate
    closeModal('modalFrame');
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

    if (cleanedRx) saveLensRxToDatabase(cleanedRx);

    calcRow(activeRow.querySelector('.price'));
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

function saveLensRxToDatabase(rxData) {
    const nameEl = document.getElementById('cName');
    const phoneEl = document.getElementById('cPhone');
    const dobEl = document.getElementById('cDob');
    const orderDateEl = document.getElementById('orderDate');

    const patName = nameEl ? nameEl.value.trim() : "";
    const patMobile = phoneEl ? phoneEl.value.trim() : "";
    if (!patName || !patMobile) return;

    const patAge = calculateAgeFromDob(dobEl ? dobEl.value : "");
    const rxDate = orderDateEl && orderDateEl.value ? orderDateEl.value : new Date().toISOString().slice(0, 10);

    const re = rxData.re || {};
    const le = rxData.le || {};

    const prescriptionData = {
        id: Date.now(),
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
    localStorage.setItem('optixPrescriptions', JSON.stringify(prescriptions));

    if (typeof loadRxDatabase === 'function') loadRxDatabase();
}

// 6. Recalculate Total (row-level discount %)
function calcRow(el) {
    if (!el) return;
    const row = el.closest('tr');
    if (!row) return;
    const qty = parseFloat(row.querySelector('.qty').value) || 0;
    const price = parseFloat(row.querySelector('.price').value) || 0;
    const discountsEnabled = getSettings().enableDiscounts !== false;
    const discPercent = discountsEnabled ? (parseFloat(row.querySelector('.row-disc').value) || 0) : 0;

    const subtotal = qty * price;
    const discAmt = (subtotal * discPercent) / 100;
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

// Save Final Prescription (Eyewear + Contact Lens)
function saveFinalRx() {
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
            va: document.getElementById('r_va').value,
            nvSph: document.getElementById('r_nv_sph').value,
            nvCyl: document.getElementById('r_nv_cyl').value,
            nvAxis: document.getElementById('r_nv_axis').value,
            nvVa: document.getElementById('r_nv_va').value,
            add: document.getElementById('r_add').value
        };
        prescriptionData.leftEye = {
            sph: document.getElementById('l_sph').value,
            cyl: document.getElementById('l_cyl').value,
            axis: document.getElementById('l_axis').value,
            va: document.getElementById('l_va').value,
            nvSph: document.getElementById('l_nv_sph').value,
            nvCyl: document.getElementById('l_nv_cyl').value,
            nvAxis: document.getElementById('l_nv_axis').value,
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
function deleteRx(rxId) {
    if(!confirm("Delete this prescription?")) return;
    
    let prescriptions = JSON.parse(localStorage.getItem('optixPrescriptions')) || [];
    prescriptions = prescriptions.filter(p => p.id !== rxId);
    localStorage.setItem('optixPrescriptions', JSON.stringify(prescriptions));
    
    loadRxDatabase();
    alert("Prescription deleted!");
}

// --- PART 4: STAFF MANAGEMENT ---
function saveStaff() {
    const name = document.getElementById('sName').value;
    const role = document.getElementById('sRole').value;
    if(!name) { alert("Name is required"); return; }

    const staff = JSON.parse(localStorage.getItem('optixStaff')) || [];
    staff.push({ id: Date.now(), name: name, role: role, date: new Date().toLocaleDateString() });
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

function deleteStaff(index) {
    const staff = JSON.parse(localStorage.getItem('optixStaff')) || [];
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
function addCustomer() {
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

    customers.push({
        id: Date.now(),
        name: name,
        phone: phone,
        city: city,
        gender: gender,
        joined: new Date().toLocaleDateString()
    });

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
function saveExpense() {
    const date = document.getElementById('expenseDate').value;
    const desc = document.getElementById('eDesc').value;
    const amount = parseFloat(document.getElementById('eAmount').value);

    if(!desc || !amount) { alert("Fill all details"); return; }

    const expenses = JSON.parse(localStorage.getItem('optixExpenses')) || [];
    expenses.push({ date: date || new Date().toISOString().split('T')[0], desc: desc, amount: amount });
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
        total += parseFloat(e.amount);
        tbody.insertAdjacentHTML('beforeend', `<tr><td>${e.date}</td><td>${e.desc}</td><td>${e.amount}</td></tr>`);
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

function renderOrderRow(o, index, options) {
    const status = o.status || "Pending";
    const orderDate = new Date(o.date).toLocaleString('en-IN', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const delDate = new Date(new Date(o.date).getTime() + 86400000).toLocaleString('en-IN', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });

    const amount = parseFloat(o.amount) || 0;
    const paid = parseFloat(o.paid) || 0;
    const balance = amount - paid;
    const totals = computeOrderTotals(o);
    const discount = totals.totalDiscount || 0;

    const actions = [];
    if (getSettings().showWhatsapp !== false) {
        actions.push(`<a class="act-btn ic-blue" onclick="sendWhatsapp('${o.phone}', '${o.name}', ${balance}, ${o.id})" title="Send WhatsApp"><i class="fas fa-paper-plane"></i></a>`);
        actions.push(`<a class="act-btn ic-whatsapp" onclick="sendWhatsappChat('${o.phone}', '${o.name}', ${balance}, ${o.id})" title="Chat WhatsApp"><i class="fab fa-whatsapp"></i></a>`);
    }

    if (options.showConfirm) {
        actions.push(`<a class="act-btn ic-check" onclick="confirmOrder(${o.id})" title="Confirm Order"><i class="fas fa-check"></i></a>`);
        actions.push(`<a class="act-btn ic-edit" href="#" onclick="editOrder(${o.id})" title="Edit Order"><i class="fas fa-pen"></i></a>`);
    }

    actions.push(`<a class="act-btn ic-rupee" onclick="viewPayments(${o.id})" title="Payment History"><i class="fas fa-rupee-sign"></i></a>`);

    if (options.showAdvanceReceipt) {
        actions.push(`<a class="act-btn ic-print" onclick="printReceipt(${o.id}, 'advance')" title="Print Advance Receipt"><i class="fas fa-file-invoice"></i></a>`);
    }

    actions.push(`<a class="act-btn ic-print" onclick="printReceipt(${o.id}, 'invoice')" title="Print Final Invoice"><i class="fas fa-print"></i></a>`);
    actions.push(`<a class="act-btn ic-eye" onclick="openRxEditor(${o.id})" title="View/Edit Rx"><i class="fas fa-eye"></i></a>`);

    if (options.showDelete) {
        actions.push(`<a class="act-btn ic-delete" onclick="deleteOrder(${o.id})" title="Delete Order"><i class="fas fa-times"></i></a>`);
    }

    const statusLabel = status === "Confirmed" ? `<div style="color:green; font-weight:bold; margin-top:4px;">Status: Confirmed</div>` : '';

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
        
        <td>Cleandekho.com</td>
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

    tbody.innerHTML = "";
    const filters = getSalesFilters();
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const filtered = filterOrders(orders, filters);

    filtered.reverse().forEach((o, index) => {
        const status = o.status || "Pending";
        if (status === "Confirmed") return;
        const row = renderOrderRow(o, index, {
            showConfirm: true,
            showAdvanceReceipt: true,
            showDelete: true
        });
        tbody.insertAdjacentHTML('beforeend', row);
    });
}

function loadSalesHistory() {
    const tbody = document.getElementById('historyTableBody');
    if(!tbody) return;

    tbody.innerHTML = "";
    const filters = getSalesFilters();
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const filtered = filterOrders(orders, filters);

    filtered.reverse().forEach((o, index) => {
        const status = o.status || "Pending";
        if (status !== "Confirmed") return;
        const row = renderOrderRow(o, index, {
            showConfirm: false,
            showAdvanceReceipt: false,
            showDelete: false
        });
        tbody.insertAdjacentHTML('beforeend', row);
    });
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

function buildDailyStatement() {
    const container = document.getElementById('statementContent');
    if (!container) return;

    const { from, to } = getStatementDateRange();
    lastStatementRange = { from, to };

    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const rows = [];
    let totalAmount = 0;
    let totalPaid = 0;

    orders.forEach(o => {
        const status = o.status || "Pending";
        if (status !== "Confirmed") return;
        const orderDate = toLocalDateStr(new Date(o.date));
        if (orderDate < from || orderDate > to) return;

        const amount = parseFloat(o.amount) || 0;
        const paid = parseFloat(o.paid) || 0;
        const balance = amount - paid;
        totalAmount += amount;
        totalPaid += paid;

        rows.push({
            date: orderDate,
            id: o.id,
            name: o.name,
            phone: o.phone,
            amount,
            paid,
            balance
        });
    });

    const totalBalance = totalAmount - totalPaid;

    const headerHtml = `
        <div style="text-align:center; margin-bottom:10px;">
            <div style="font-size:18px; font-weight:bold;">CITY OPTICAL CENTER</div>
            <div style="font-size:12px;">Daily Statement</div>
            <div style="font-size:12px; color:#555;">From ${from} To ${to}</div>
        </div>
        <div style="display:flex; gap:10px; font-size:12px; margin-bottom:10px;">
            <div style="flex:1; border:1px solid #eee; padding:8px;"><strong>Total Orders:</strong> ${rows.length}</div>
            <div style="flex:1; border:1px solid #eee; padding:8px;"><strong>Total Amount:</strong> Rs ${totalAmount.toFixed(2)}</div>
            <div style="flex:1; border:1px solid #eee; padding:8px;"><strong>Total Paid:</strong> Rs ${totalPaid.toFixed(2)}</div>
            <div style="flex:1; border:1px solid #eee; padding:8px;"><strong>Total Balance:</strong> Rs ${totalBalance.toFixed(2)}</div>
        </div>
    `;

    if (rows.length === 0) {
        container.innerHTML = headerHtml + `<div style="padding:10px; font-size:12px; color:#777;">No confirmed sales found in this date range.</div>`;
        return;
    }

    const tableRows = rows.map((r, i) => `
        <tr>
            <td>${i + 1}</td>
            <td>${r.date}</td>
            <td>${formatOrderNoShort(r)}</td>
            <td>${r.name}</td>
            <td>${r.phone}</td>
            <td style="text-align:right;">${r.amount.toFixed(2)}</td>
            <td style="text-align:right;">${r.paid.toFixed(2)}</td>
            <td style="text-align:right;">${r.balance.toFixed(2)}</td>
        </tr>
    `).join('');

    container.innerHTML = headerHtml + `
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead>
                <tr style="background:#f4f4f4;">
                    <th style="border:1px solid #ccc; padding:6px;">#</th>
                    <th style="border:1px solid #ccc; padding:6px;">Date</th>
                    <th style="border:1px solid #ccc; padding:6px;">Order No</th>
                    <th style="border:1px solid #ccc; padding:6px;">Customer</th>
                    <th style="border:1px solid #ccc; padding:6px;">Phone</th>
                    <th style="border:1px solid #ccc; padding:6px; text-align:right;">Amount</th>
                    <th style="border:1px solid #ccc; padding:6px; text-align:right;">Paid</th>
                    <th style="border:1px solid #ccc; padding:6px; text-align:right;">Balance</th>
                </tr>
            </thead>
            <tbody>
                ${tableRows}
            </tbody>
        </table>
    `;
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
    const orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
    const order = orders.find(o => o.id === orderId);
    const status = order && order.status ? order.status : "Pending";

    const baseUrl = window.location.origin + window.location.pathname.replace(/[^/]+$/, '');
    const docType = status === "Confirmed" ? "invoice" : "advance";
    const link = `${baseUrl}invoice.html?orderId=${orderId}&type=${docType}`;

    const label = status === "Confirmed" ? "Final Invoice" : "Advance Receipt";
    const msg = `Dear ${name}, your ${label} is ready. Balance amount is Rs ${balance}. Please collect it. ${link} - City Optical`;
    window.open(`https://wa.me/91${phone}?text=${encodeURIComponent(msg)}`, '_blank');
}

function sendWhatsappChat(phone, name, balance, orderId) {
    // Same message as Send WhatsApp, just used for the chat icon
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

function deleteOrder(id) {
    if(confirm("Are you sure you want to DELETE this order? This cannot be undone.")) {
        let orders = JSON.parse(localStorage.getItem('optixOrders')) || [];
        orders = orders.filter(o => o.id !== id);
        localStorage.setItem('optixOrders', JSON.stringify(orders));
        loadPendingOrders();
    }
}

function printReceipt(id, type) {
    // Opens the invoice page. You can customize invoice.html to show "Advance Receipt" header if needed
    window.open(`invoice.html?orderId=${id}&type=${type}`, '_blank');
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

        alert(
            `Payment Details for Order #${id}\n\n` +
            `Total: ${parseFloat(order.amount || 0).toFixed(2)}\n` +
            `Paid Total: ${paidTotal.toFixed(2)}\n` +
            ` - Cash: ${paidCash.toFixed(2)}\n` +
            ` - UPI: ${paidUpi.toFixed(2)}\n` +
            ` - Bank/Card: ${paidBank.toFixed(2)}\n` +
            `Balance: ${balance.toFixed(2)}`
        );
    }
}


