const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.static('public'));

const DB_URL = process.env.FIREBASE_DB_URL;
const DB_SECRET = process.env.FIREBASE_DB_SECRET;

function fetchFirebase(path) {
    return new Promise((resolve) => {
        if (!DB_URL) return resolve(null);
        const url = `${DB_URL}/${path}.json?auth=${DB_SECRET || ''}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode === 200 && data !== 'null') resolve(JSON.parse(data));
                    else resolve(null);
                } catch(e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

function saveFirebase(path, payload) {
    return new Promise((resolve) => {
        if (!DB_URL) return resolve(false);
        const data = JSON.stringify(payload);
        const url = new URL(`${DB_URL}/${path}.json?auth=${DB_SECRET || ''}`);
        const req = https.request(url, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.write(data);
        req.end();
    });
}

function deleteFirebase(path) {
    return new Promise((resolve) => {
        if (!DB_URL) return resolve(false);
        const url = new URL(`${DB_URL}/${path}.json?auth=${DB_SECRET || ''}`);
        const req = https.request(url, {
            method: 'DELETE'
        }, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

function sanitizeUserData(userData) {
    if (!userData) return null;
    if (!userData.profile) userData.profile = { phone: '', pass: '', bizName: 'My Shop' };
    if (!userData.transactions) userData.transactions = [];
    if (!userData.parties) userData.parties = [];

    if (userData.profile.isApproved === undefined) userData.profile.isApproved = false;
    if (!userData.profile.expiryDate) userData.profile.expiryDate = null;
    if (!userData.profile.plan) userData.profile.plan = "Pending Approval";
    if (!userData.profile.adminNote) userData.profile.adminNote = "";
    if (userData.profile.forgotRequested === undefined) userData.profile.forgotRequested = false;

    userData.transactions = userData.transactions.map(t => ({
        id: t.id || Date.now() + Math.random(),
        role: t.role || 'Customer',
        name: t.name || 'Unknown',
        billNo: t.billNo || '-',
        type: t.type || 'SALE_CREDIT',
        amount: Number(t.amount) || 0,
        method: t.method || 'Cash',
        date: t.date || new Date().toISOString().split('T')[0],
        notes: t.notes || '',
        img: t.img || ''
    }));

    return userData;
}

async function initAdminConfig() {
    let admin = await fetchFirebase('admin');
    if (!admin) {
        await saveFirebase('admin', { phone: '03000000000', pass: 'admin123' });
    }
}
initAdminConfig();

app.post('/api/register', async (req, res) => {
    try {
        const { phone, pass, bizName } = req.body;
        if (!phone || !pass) return res.status(400).json({ error: "Phone aur Password zaroori hain!" });
        if (pass.length < 6) return res.status(400).json({ error: "Password kam az kam 6 digits/characters ka hona zaroori hai!" });

        const cleanPhone = phone.trim().replace(/[^0-9]/g, '');
        const existing = await fetchFirebase(`users/${cleanPhone}`);

        if (existing && existing.profile) {
            return res.status(400).json({ error: "Yeh phone number pehle se registered hai! Login karein." });
        }

        const newUser = {
            profile: {
                phone: cleanPhone,
                pass,
                bizName: bizName || 'My Shop',
                isApproved: false,
                expiryDate: null,
                plan: "Free Trial / Pending",
                adminNote: "",
                forgotRequested: false
            },
            transactions: [],
            parties: []
        };

        const ok = await saveFirebase(`users/${cleanPhone}`, newUser);
        if (ok) res.json({ success: true, user: newUser.profile });
        else res.status(500).json({ error: "Database Write Error" });
    } catch(err) {
        res.status(500).json({ error: "Server Registration Error" });
    }
});

app.post('/api/forgot-password-request', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ error: "Phone number zaroori hai!" });

        const cleanPhone = phone.trim().replace(/[^0-9]/g, '');
        let userData = await fetchFirebase(`users/${cleanPhone}`);

        if (!userData || !userData.profile) {
            return res.status(404).json({ error: "Yeh phone number registered nahi hai!" });
        }

        userData.profile.forgotRequested = true;
        await saveFirebase(`users/${cleanPhone}`, userData);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: "Request failed" });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { phone, pass } = req.body;
        if (!phone || !pass) return res.status(400).json({ error: "Credentials missing!" });

        const cleanPhone = phone.trim().replace(/[^0-9]/g, '');

        const admin = await fetchFirebase('admin');
        if (admin && cleanPhone === admin.phone && pass === admin.pass) {
            return res.json({ success: true, isAdmin: true, admin });
        }

        let userData = await fetchFirebase(`users/${cleanPhone}`);

        if (!userData || !userData.profile) {
            return res.status(404).json({ error: "Invalid Phone Number ya Password! Pehle account register karein." });
        }

        if (userData.profile.pass !== pass) {
            return res.status(401).json({ error: "Invalid Phone Number ya Password!" });
        }

        userData = sanitizeUserData(userData);

        if (!userData.profile.isApproved) {
            return res.status(403).json({ error: "Aapka account abhi active nahi hai. Access ke liye Super Admin (03243981059) se contact karein." });
        }

        if (userData.profile.expiryDate) {
            const today = new Date().toISOString().split('T')[0];
            if (today > userData.profile.expiryDate) {
                return res.status(403).json({ error: `Aapka plan (${userData.profile.plan}) expire ho gaya hai! Renew karwane ke liye Admin (03243981059) se contact karein.` });
            }
        }

        res.json({ success: true, isAdmin: false, data: userData });
    } catch(err) {
        res.status(500).json({ error: "Server Login Error" });
    }
});

app.get('/api/admin/get-users', async (req, res) => {
    try {
        const allUsers = await fetchFirebase('users') || {};
        const userList = [];
        for (let key in allUsers) {
            if (allUsers[key] && allUsers[key].profile) {
                userList.push(allUsers[key].profile);
            }
        }
        res.json({ success: true, users: userList });
    } catch(err) {
        res.status(500).json({ error: "Users list fetch error" });
    }
});

app.post('/api/admin/update-access', async (req, res) => {
    try {
        const { targetPhone, isApproved, days, planName, customDate, adminNote } = req.body;
        let userData = await fetchFirebase(`users/${targetPhone}`);

        if (!userData) return res.status(404).json({ error: "User nahi mila!" });

        userData.profile.isApproved = isApproved;
        if (planName) userData.profile.plan = planName;
        if (adminNote !== undefined) userData.profile.adminNote = adminNote;

        if (customDate) {
            userData.profile.expiryDate = customDate;
            userData.profile.plan = `Custom (${customDate})`;
        } else if (days > 0) {
            let expDate = new Date();
            expDate.setDate(expDate.getDate() + Number(days));
            userData.profile.expiryDate = expDate.toISOString().split('T')[0];
        } else if (days === 0) {
            userData.profile.expiryDate = null;
        }

        await saveFirebase(`users/${targetPhone}`, userData);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: "Access update failed" });
    }
});

app.post('/api/admin/edit-user', async (req, res) => {
    try {
        const { targetPhone, bizName, pass, expiryDate, isApproved, adminNote } = req.body;
        let userData = await fetchFirebase(`users/${targetPhone}`);

        if (!userData || !userData.profile) return res.status(404).json({ error: "User nahi mila!" });
        if (pass && pass.length < 6) return res.status(400).json({ error: "Password minimum 6 digits ka hona chahiye!" });

        if (bizName) userData.profile.bizName = bizName.trim();
        if (pass) {
            userData.profile.pass = pass.trim();
            userData.profile.forgotRequested = false;
        }
        userData.profile.expiryDate = expiryDate || null;
        userData.profile.plan = expiryDate ? `Custom (${expiryDate})` : "Lifetime / No Expiry";
        userData.profile.isApproved = Boolean(isApproved);
        userData.profile.adminNote = adminNote || "";

        await saveFirebase(`users/${targetPhone}`, userData);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: "User edit failed" });
    }
});

app.post('/api/admin/reset-user-pass', async (req, res) => {
    try {
        const { targetPhone, newPass } = req.body;
        if (!newPass || newPass.length < 6) return res.status(400).json({ error: "Password minimum 6 digits ka hona chahiye!" });

        let userData = await fetchFirebase(`users/${targetPhone}`);
        if (!userData || !userData.profile) return res.status(404).json({ error: "User nahi mila!" });

        userData.profile.pass = newPass.trim();
        userData.profile.forgotRequested = false;

        await saveFirebase(`users/${targetPhone}`, userData);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: "Password reset failed" });
    }
});

app.post('/api/admin/delete-user', async (req, res) => {
    try {
        const { targetPhone } = req.body;
        if (!targetPhone) return res.status(400).json({ error: "Phone ID missing!" });

        const ok = await deleteFirebase(`users/${targetPhone}`);
        if (ok) res.json({ success: true });
        else res.status(500).json({ error: "Delete failed in database" });
    } catch(err) {
        res.status(500).json({ error: "User delete failed" });
    }
});

app.post('/api/admin/update-password', async (req, res) => {
    try {
        const { newPass } = req.body;
        if (!newPass || newPass.length < 6) return res.status(400).json({ error: "Password minimum 6 digits ka hona chahiye!" });

        let admin = await fetchFirebase('admin') || { phone: '03000000000', pass: 'admin123' };
        admin.pass = newPass;
        await saveFirebase('admin', admin);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: "Password update failed" });
    }
});

app.post('/api/save-data', async (req, res) => {
    try {
        const { phone, transactions, parties } = req.body;
        if (!phone) return res.status(400).json({ error: "Phone ID missing!" });

        const cleanPhone = phone.trim().replace(/[^0-9]/g, '');
        let userData = await fetchFirebase(`users/${cleanPhone}`);

        if (!userData) {
            return res.status(404).json({ error: "User profile not found!" });
        }

        userData.transactions = transactions || [];
        userData.parties = parties || [];

        await saveFirebase(`users/${cleanPhone}`, userData);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: "Server Save Error" });
    }
});

// Keep-Alive Ping Route & Auto-Ping Timer (Every 10 Minutes)
app.get('/ping', (req, res) => {
    res.status(200).send('OK');
});

const RENDER_URL = 'https://pos-app-ypoc.onrender.com/ping';
setInterval(() => {
    https.get(RENDER_URL, (res) => {
        res.resume();
    }).on('error', () => {});
}, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`Secure Firebase REST POS Backend Running on port ${PORT}`));
