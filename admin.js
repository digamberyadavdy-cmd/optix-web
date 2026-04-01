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

    const SUPER_ADMIN_EMAILS = ['digamber.yadav.dy@gmail.com'];
    const SECONDARY_APP_NAME = 'optix-admin-secondary';
    const STORE_SCOPED_COLLECTIONS = ['products', 'orders', 'customers', 'expenses', 'prescriptions', 'staff'];

    let db = null;
    let editingStoreOriginalId = '';

    function normalizeEmail(value) {
        return String(value || '').trim().toLowerCase();
    }

    function isSuperAdminEmail(email) {
        return SUPER_ADMIN_EMAILS.includes(normalizeEmail(email));
    }

    function initFirebase() {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        db = firebase.firestore();
    }

    function getSecondaryApp() {
        const existing = firebase.apps.find((app) => app.name === SECONDARY_APP_NAME);
        return existing || firebase.initializeApp(firebaseConfig, SECONDARY_APP_NAME);
    }

    function setStatus(msg) {
        const chip = document.getElementById('adminUserChip');
        if (chip) chip.textContent = msg;
    }

    function showFormMsg(msg, isError = false) {
        const el = document.getElementById('formMessage');
        if (!el) return;
        el.textContent = msg;
        el.style.color = isError ? '#fca5a5' : '#94a3b8';
    }

    function toggleOwnerPasswordVisibility() {
        const input = document.getElementById('ownerPassword');
        const icon = document.getElementById('ownerPasswordIcon');
        if (!input) return;
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        if (icon) {
            icon.className = showing ? 'fas fa-eye' : 'fas fa-eye-slash';
        }
    }

    function resetEditState() {
        editingStoreOriginalId = '';
    }

    function clearStoreForm() {
        resetEditState();
        document.getElementById('storeId').value = '';
        document.getElementById('storeName').value = '';
        document.getElementById('ownerEmail').value = '';
        document.getElementById('ownerName').value = '';
        document.getElementById('ownerPassword').value = '';
        document.getElementById('ownerPassword').type = 'password';
        const icon = document.getElementById('ownerPasswordIcon');
        if (icon) icon.className = 'fas fa-eye';
        document.getElementById('plan').value = 'lite';
        document.getElementById('status').value = 'active';
        document.getElementById('activeUntil').value = '';
        document.getElementById('notes').value = '';
        showFormMsg('Ready to create a new store.');
    }

    function readStoreForm() {
        return {
            storeId: document.getElementById('storeId').value.trim().toLowerCase(),
            storeName: document.getElementById('storeName').value.trim(),
            ownerEmail: normalizeEmail(document.getElementById('ownerEmail').value),
            ownerName: document.getElementById('ownerName').value.trim(),
            ownerPassword: document.getElementById('ownerPassword').value,
            plan: document.getElementById('plan').value,
            status: document.getElementById('status').value,
            activeUntil: document.getElementById('activeUntil').value.trim(),
            notes: document.getElementById('notes').value.trim()
        };
    }

    async function requireAdmin() {
        firebase.auth().onAuthStateChanged(async (user) => {
            if (!user) {
                setStatus("Not signed in");
                window.location.href = 'login.html';
                return;
            }
            const email = normalizeEmail(user.email);
            if (!isSuperAdminEmail(email)) {
                setStatus("Not authorized");
                window.location.href = 'dashboard.html';
                return;
            }
            setStatus(user.email || "Super Admin");
            loadStores();
        });
    }

    async function loadStores() {
        const tbody = document.getElementById('storeTableBody');
        if (!db) return;
        try {
            const snap = await db.collection('admin_stores').orderBy('name').get();
            const rows = [];
            snap.forEach((doc) => {
                const d = doc.data() || {};
                const plan = (d.plan || 'lite').toUpperCase();
                const status = (d.status || 'active').toLowerCase();
                const updated = d.updatedAt?.toDate ? d.updatedAt.toDate().toLocaleString() : '-';
                rows.push(`
                    <tr>
                        <td><strong>${doc.id}</strong><div class="text-muted">${d.name || ''}</div></td>
                        <td>${d.ownerEmail || '-'}</td>
                        <td><span class="text-muted">Hidden in Firebase</span></td>
                        <td>${plan}</td>
                        <td><span class="pill ${status === 'active' || status === 'trial' ? 'active' : 'inactive'}">${status}</span></td>
                        <td>${d.activeUntil || '-'}</td>
                        <td>${updated}</td>
                        <td class="actions">
                            <button onclick="window.editStore('${doc.id}')">Edit</button>
                            <button class="btn-secondary" onclick="window.sendOwnerPasswordReset('${doc.id}')">Reset Password</button>
                            <button class="btn-danger" onclick="window.deleteStore('${doc.id}')">Delete</button>
                        </td>
                    </tr>
                `);
            });
            tbody.innerHTML = rows.join('') || `<tr><td colspan="8" class="text-muted">No stores yet.</td></tr>`;
            const count = document.getElementById('storeCount');
            if (count) count.textContent = `${snap.size} store(s)`;
        } catch (err) {
            console.error(err);
            tbody.innerHTML = `<tr><td colspan="8" class="text-muted">Error loading stores.</td></tr>`;
        }
    }

    async function createOwnerAuthUser(ownerEmail, ownerPassword, ownerName) {
        const secondaryApp = getSecondaryApp();
        const secondaryAuth = secondaryApp.auth();
        const credential = await secondaryAuth.createUserWithEmailAndPassword(ownerEmail, ownerPassword);
        if (ownerName) {
            await credential.user.updateProfile({ displayName: ownerName });
        }
        await secondaryAuth.signOut();
        return credential.user;
    }

    async function saveOwnerProfile(uid, form, storePayload, storeId, isNewUser) {
        const profilePayload = {
            email: form.ownerEmail,
            name: form.ownerName || storePayload.name,
            role: 'owner',
            status: 'active',
            storeId: storeId,
            storeName: storePayload.name,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (isNewUser) {
            profilePayload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        }
        await db.collection('users').doc(uid).set(profilePayload, { merge: true });
    }

    async function migrateCollectionStoreId(collectionName, fromStoreId, toStoreId) {
        if (!fromStoreId || !toStoreId || fromStoreId === toStoreId) return 0;
        const snapshot = await db.collection(collectionName).where('storeId', '==', fromStoreId).get();
        if (snapshot.empty) return 0;
        let moved = 0;
        let batch = db.batch();
        let batchCount = 0;
        for (const doc of snapshot.docs) {
            batch.update(doc.ref, { storeId: toStoreId });
            moved += 1;
            batchCount += 1;
            if (batchCount === 400) {
                await batch.commit();
                batch = db.batch();
                batchCount = 0;
            }
        }
        if (batchCount > 0) await batch.commit();
        return moved;
    }

    async function migrateUserStoreIds(fromStoreId, toStoreId) {
        return migrateCollectionStoreId('users', fromStoreId, toStoreId);
    }

    async function migrateStoreData(oldStoreId, newStoreId) {
        if (!oldStoreId || !newStoreId || oldStoreId === newStoreId) return;
        for (const collectionName of STORE_SCOPED_COLLECTIONS) {
            await migrateCollectionStoreId(collectionName, oldStoreId, newStoreId);
        }
        await migrateUserStoreIds(oldStoreId, newStoreId);
    }

    async function deleteCollectionDocsByStoreId(collectionName, storeId) {
        const snapshot = await db.collection(collectionName).where('storeId', '==', storeId).get();
        if (snapshot.empty) return 0;
        let deleted = 0;
        let batch = db.batch();
        let batchCount = 0;
        for (const doc of snapshot.docs) {
            batch.delete(doc.ref);
            deleted += 1;
            batchCount += 1;
            if (batchCount === 400) {
                await batch.commit();
                batch = db.batch();
                batchCount = 0;
            }
        }
        if (batchCount > 0) await batch.commit();
        return deleted;
    }

    async function deleteStoreData(storeId, ownerUid) {
        for (const collectionName of STORE_SCOPED_COLLECTIONS) {
            await deleteCollectionDocsByStoreId(collectionName, storeId);
        }
        await deleteCollectionDocsByStoreId('users', storeId);
        if (ownerUid) {
            await db.collection('users').doc(ownerUid).delete().catch(() => {});
        }
        await db.collection('admin_stores').doc(storeId).delete();
    }

    async function provisionOwnerAccount(existingStore, form, targetStoreId, storePayload) {
        const existingOwnerUid = existingStore && existingStore.ownerUid ? existingStore.ownerUid : '';
        const existingOwnerEmail = existingStore ? normalizeEmail(existingStore.ownerEmail) : '';

        if (!existingOwnerUid) {
            if (!form.ownerEmail) throw new Error("Owner email is required.");
            if (!form.ownerPassword) throw new Error("Owner password is required to provision the owner login.");
            const createdUser = await createOwnerAuthUser(form.ownerEmail, form.ownerPassword, form.ownerName || storePayload.name);
            await saveOwnerProfile(createdUser.uid, form, storePayload, targetStoreId, true);
            return {
                ownerUid: createdUser.uid,
                ownerEmail: form.ownerEmail,
                ownerName: form.ownerName || storePayload.name,
                message: `Provisioned owner login for ${form.ownerEmail}.`
            };
        }

        if (form.ownerEmail && form.ownerEmail !== existingOwnerEmail) {
            if (!form.ownerPassword) throw new Error("Enter a new password when changing the owner email.");
            const replacementUser = await createOwnerAuthUser(form.ownerEmail, form.ownerPassword, form.ownerName || storePayload.name);
            await saveOwnerProfile(replacementUser.uid, form, storePayload, targetStoreId, true);
            await db.collection('users').doc(existingOwnerUid).delete().catch(() => {});
            return {
                ownerUid: replacementUser.uid,
                ownerEmail: form.ownerEmail,
                ownerName: form.ownerName || storePayload.name,
                message: `Replaced owner login with ${form.ownerEmail}.`
            };
        }

        if (form.ownerPassword) {
            throw new Error("Password change for the same email is not supported from this admin page yet. Change the email too, or reset the password from Firebase Console.");
        }

        await saveOwnerProfile(existingOwnerUid, {
            ...form,
            ownerEmail: existingOwnerEmail || form.ownerEmail
        }, storePayload, targetStoreId, false);

        return {
            ownerUid: existingOwnerUid,
            ownerEmail: existingOwnerEmail || form.ownerEmail,
            ownerName: form.ownerName || (existingStore && existingStore.ownerName) || storePayload.name,
            message: "Updated owner profile."
        };
    }

    async function saveStore() {
        const form = readStoreForm();
        const originalStoreId = editingStoreOriginalId || form.storeId;
        if (!form.storeId) return showFormMsg("Store ID is required.", true);
        if (!form.storeName) return showFormMsg("Store name is required.", true);

        const originalStoreRef = db.collection('admin_stores').doc(originalStoreId);
        const originalSnap = await originalStoreRef.get();
        const existing = originalSnap.exists ? (originalSnap.data() || {}) : null;
        const storeIdChanged = !!existing && originalStoreId !== form.storeId;

        if (!existing && !form.ownerEmail) return showFormMsg("Owner email is required for a new store.", true);
        if (form.ownerPassword && form.ownerPassword.length < 6) return showFormMsg("Owner password must be at least 6 characters.", true);

        if (storeIdChanged) {
            const newStoreSnap = await db.collection('admin_stores').doc(form.storeId).get();
            if (newStoreSnap.exists) {
                return showFormMsg("That new Store ID already exists. Choose another Store ID.", true);
            }
        }

        const payload = {
            name: form.storeName,
            plan: form.plan,
            status: form.status,
            activeUntil: form.activeUntil,
            notes: form.notes,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        try {
            const ownerState = await provisionOwnerAccount(existing, form, form.storeId, payload);
            payload.ownerUid = ownerState.ownerUid;
            payload.ownerEmail = ownerState.ownerEmail;
            payload.ownerName = ownerState.ownerName;

            await db.collection('admin_stores').doc(form.storeId).set(payload, { merge: true });

            if (storeIdChanged) {
                await migrateStoreData(originalStoreId, form.storeId);
                await originalStoreRef.delete();
            }

            document.getElementById('ownerPassword').value = '';
            editingStoreOriginalId = form.storeId;
            const storeMsg = storeIdChanged
                ? `Store ID changed from ${originalStoreId} to ${form.storeId} and tenant data was migrated.`
                : `Saved ${form.storeId}.`;
            showFormMsg(`${storeMsg} ${ownerState.message}`);
            loadStores();
        } catch (err) {
            console.error(err);
            showFormMsg("Error saving store: " + err.message, true);
        }
    }

    async function editStore(storeId) {
        try {
            const doc = await db.collection('admin_stores').doc(storeId).get();
            if (!doc.exists) return showFormMsg("Store not found.", true);
            const d = doc.data() || {};
            editingStoreOriginalId = storeId;
            document.getElementById('storeId').value = storeId;
            document.getElementById('storeName').value = d.name || '';
            document.getElementById('ownerEmail').value = d.ownerEmail || '';
            document.getElementById('ownerName').value = d.ownerName || '';
            document.getElementById('ownerPassword').value = '';
            document.getElementById('ownerPassword').type = 'password';
            const icon = document.getElementById('ownerPasswordIcon');
            if (icon) icon.className = 'fas fa-eye';
            document.getElementById('plan').value = d.plan || 'lite';
            document.getElementById('status').value = d.status || 'active';
            document.getElementById('activeUntil').value = d.activeUntil || '';
            document.getElementById('notes').value = d.notes || '';
            showFormMsg(`Loaded ${storeId} for editing. You can change Store ID and owner email here. For password-only changes on the same email, use Firebase Console for now.`);
        } catch (err) {
            console.error(err);
            showFormMsg("Error loading store: " + err.message, true);
        }
    }

    async function deleteStore(storeId) {
        const doc = await db.collection('admin_stores').doc(storeId).get();
        if (!doc.exists) {
            showFormMsg("Store not found.", true);
            return;
        }
        const data = doc.data() || {};
        const ok = confirm(`Delete store "${storeId}" and its Firestore data? This removes orders, products, customers, expenses, prescriptions, staff, and user profiles for that store.`);
        if (!ok) return;
        try {
            await deleteStoreData(storeId, data.ownerUid || '');
            if (editingStoreOriginalId === storeId) clearStoreForm();
            showFormMsg(`Deleted ${storeId}. The Firebase Auth user for ${data.ownerEmail || 'the owner'} is not removed automatically; delete it from Firebase Console if needed.`);
            loadStores();
        } catch (err) {
            console.error(err);
            showFormMsg("Error deleting store: " + err.message, true);
        }
    }

    async function sendOwnerPasswordReset(storeId) {
        try {
            const doc = await db.collection('admin_stores').doc(storeId).get();
            if (!doc.exists) return showFormMsg("Store not found.", true);
            const data = doc.data() || {};
            const ownerEmail = normalizeEmail(data.ownerEmail);
            if (!ownerEmail) return showFormMsg("This store does not have an owner email yet.", true);
            await firebase.auth().sendPasswordResetEmail(ownerEmail);
            showFormMsg(`Password reset email sent to ${ownerEmail}.`);
        } catch (err) {
            console.error(err);
            showFormMsg("Could not send password reset email: " + err.message, true);
        }
    }

    window.saveStore = saveStore;
    window.editStore = editStore;
    window.deleteStore = deleteStore;
    window.newStoreForm = clearStoreForm;
    window.sendOwnerPasswordReset = sendOwnerPasswordReset;
    window.toggleOwnerPasswordVisibility = toggleOwnerPasswordVisibility;

    initFirebase();
    requireAdmin();
})();
