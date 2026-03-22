// Admin-only console for OptixCrafter
(function() {
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

    function initFirebase() {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        db = firebase.firestore();
    }

    function setStatus(msg) {
        const chip = document.getElementById('adminUserChip');
        if (chip) chip.textContent = msg;
    }

    function requireAdmin() {
        firebase.auth().onAuthStateChanged(async (user) => {
            if (!user) {
                setStatus("Not signed in");
                window.location.href = 'login.html';
                return;
            }
            try {
                const token = await user.getIdTokenResult(true);
                if (!token.claims.isAdmin) {
                    setStatus("Not authorized");
                    window.location.href = 'login.html';
                    return;
                }
                setStatus(user.email || "Admin");
                loadStores();
            } catch (err) {
                console.error(err);
                setStatus("Auth error");
                window.location.href = 'login.html';
            }
        });
    }

    async function loadStores() {
        const tbody = document.getElementById('storeTableBody');
        if (!db) return;
        try {
            const snap = await db.collection('admin_stores').orderBy('name').get();
            const rows = [];
            snap.forEach(doc => {
                const d = doc.data() || {};
                const plan = (d.plan || 'lite').toUpperCase();
                const status = (d.status || 'active').toLowerCase();
                const updated = d.updatedAt?.toDate ? d.updatedAt.toDate().toLocaleString() : '-';
                rows.push(`
                    <tr>
                        <td><strong>${doc.id}</strong><div class="text-muted">${d.name || ''}</div></td>
                        <td>${d.ownerEmail || '-'}</td>
                        <td>${plan}</td>
                        <td><span class="pill ${status === 'active' ? 'active' : 'inactive'}">${status}</span></td>
                        <td>${d.activeUntil || '-'}</td>
                        <td>${updated}</td>
                        <td class="actions">
                            <button onclick="window.editStore('${doc.id}')">Edit</button>
                        </td>
                    </tr>
                `);
            });
            tbody.innerHTML = rows.join('') || `<tr><td colspan="7" class="text-muted">No stores yet.</td></tr>`;
            const count = document.getElementById('storeCount');
            if (count) count.textContent = `${snap.size} store(s)`;
        } catch (err) {
            console.error(err);
            tbody.innerHTML = `<tr><td colspan="7" class="text-muted">Error loading stores.</td></tr>`;
        }
    }

    async function saveStore() {
        const storeId = document.getElementById('storeId').value.trim();
        if (!storeId) return showFormMsg("Store ID is required.");
        const payload = {
            name: document.getElementById('storeName').value.trim(),
            ownerEmail: document.getElementById('ownerEmail').value.trim(),
            plan: document.getElementById('plan').value,
            status: document.getElementById('status').value,
            activeUntil: document.getElementById('activeUntil').value.trim(),
            notes: document.getElementById('notes').value.trim(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        try {
            await db.collection('admin_stores').doc(storeId).set(payload, { merge: true });
            showFormMsg(`Saved ${storeId}`);
            loadStores();
        } catch (err) {
            console.error(err);
            showFormMsg("Error saving store: " + err.message);
        }
    }

    function showFormMsg(msg) {
        const el = document.getElementById('formMessage');
        if (el) el.textContent = msg;
    }

    async function editStore(storeId) {
        try {
            const doc = await db.collection('admin_stores').doc(storeId).get();
            if (!doc.exists) return showFormMsg("Store not found.");
            const d = doc.data() || {};
            document.getElementById('storeId').value = storeId;
            document.getElementById('storeName').value = d.name || '';
            document.getElementById('ownerEmail').value = d.ownerEmail || '';
            document.getElementById('plan').value = d.plan || 'lite';
            document.getElementById('status').value = d.status || 'active';
            document.getElementById('activeUntil').value = d.activeUntil || '';
            document.getElementById('notes').value = d.notes || '';
            showFormMsg(`Loaded ${storeId} for editing.`);
        } catch (err) {
            console.error(err);
            showFormMsg("Error loading store: " + err.message);
        }
    }

    // expose minimal functions
    window.saveStore = saveStore;
    window.editStore = editStore;

    // bootstrap
    initFirebase();
    requireAdmin();
})();
