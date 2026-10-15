import { appId, firebaseConfig, SUPABASE_CONFIG } from './config.js';
import { AlightMotionAuthBrowser } from './auth.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

let supabaseClient = null;
try {
    if (window.supabase && SUPABASE_CONFIG.URL.includes("supabase.co")) {
        supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.URL, SUPABASE_CONFIG.SBP_KEY);
    }
} catch (e) {
    console.warn("Supabase init note:", e);
}

const ampAuth = new AlightMotionAuthBrowser();
let activeTabName = 'dashboard';
let verifiedEmailTemp = '';
let historyLogs = [];
let app, db, auth, userId = null;

let startTime = localStorage.getItem('ayaka_uptime_start');
if (!startTime) {
    startTime = Date.now();
    localStorage.setItem('ayaka_uptime_start', startTime);
} else {
    startTime = parseInt(startTime, 10);
}

window.setActiveTab = function(tab) {
    activeTabName = tab;
    ['dashboard', 'aktivasi', 'riwayat', 'laporan'].forEach(t => {
        const view = document.getElementById(`view-${t}`);
        const btn = document.getElementById(`nav-${t}`);
        if (view) view.classList.toggle('hidden', t !== tab);
        if (btn) {
            btn.className = (t === tab) 
                ? "neo-btn-yellow py-2 text-[10px] flex flex-col items-center justify-center gap-0.5" 
                : "neo-btn py-2 text-[10px] flex flex-col items-center justify-center gap-0.5";
        }
    });
    if (tab === 'riwayat') renderHistory();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.switchActivationStep = function(step) {
    const s1 = document.getElementById('neo-step-1');
    const s2 = document.getElementById('neo-step-2');
    const b1 = document.getElementById('tab-btn-kirim');
    const b2 = document.getElementById('tab-btn-verifikasi');
    if (step === 1) {
        s1.classList.remove('hidden');
        s2.classList.add('hidden');
        b1.className = "neo-btn-dark py-2.5 text-xs flex items-center justify-center gap-2";
        b2.className = "neo-btn py-2.5 text-xs flex items-center justify-center gap-2";
    } else {
        s1.classList.add('hidden');
        s2.classList.remove('hidden');
        b1.className = "neo-btn py-2.5 text-xs flex items-center justify-center gap-2";
        b2.className = "neo-btn-dark py-2.5 text-xs flex items-center justify-center gap-2";
    }
}

window.handleSendMagicLink = async function() {
    const email = document.getElementById('amp-email').value.trim();
    if (!email) {
        showToast("Masukkan email terlebih dahulu!");
        return;
    }
    const btn = document.getElementById('btn-send-link');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner animate-spin"></i> Mengirim...`;

    const res = await ampAuth.sendMagicLink(email);
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Kirim Magic Link ke Email`;

    if (res.success) {
        verifiedEmailTemp = email;
        showToast("Magic Link berhasil dikirim ke email!");
        switchActivationStep(2);
    } else {
        showToast("Gagal: " + res.error);
    }
}

window.handleVerifyAndApply = async function() {
    const email = verifiedEmailTemp || document.getElementById('amp-email').value.trim();
    const link = document.getElementById('amp-magic-link').value.trim();
    const pkg = document.getElementById('amp-package').value;

    if (!email || !link) {
        showToast("Email dan Magic Link wajib diisi!");
        return;
    }

    const btn = document.getElementById('btn-verify-apply');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner animate-spin"></i> Memproses...`;

    const res = await ampAuth.verifyAndApply(email, link, pkg);
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-bolt"></i> Verifikasi & Aktifkan Sekarang`;

    if (res.success) {
        showToast("Akun Berhasil Diaktifkan ke Premium!");
        const todayStr = new Date().toDateString();
        const logData = {
            user: email,
            type: pkg.includes('annual') ? '1 Tahun Premium' : '1 Bulan Premium',
            timestamp: Date.now(),
            dateString: todayStr,
            senderId: userId
        };

        // Simpan ke Supabase SQL Database
        if (supabaseClient) {
            try {
                const { error } = await supabaseClient.from('activations').insert([logData]);
                if (!error) {
                    await fetchSupabaseActivations(); // Langsung tarik data terbaru agar riwayat terupdate
                }
            } catch (supErr) {
                console.warn("Supabase insert note:", supErr);
            }
        }

        // Simpan ke Firestore Firebase secara Real-time
        if (db && userId) {
            try {
                await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'activations'), logData);
            } catch (e) {
                console.error("Firestore sync error:", e);
            }
        }

        // Reset form tanpa mengalihkan halaman ke tab riwayat
        document.getElementById('amp-email').value = '';
        document.getElementById('amp-magic-link').value = '';
        switchActivationStep(1);
    } else {
        showToast("Gagal: " + res.error);
    }
}

function renderHistory() {
    const container = document.getElementById('history-feed-container');
    if (!historyLogs || historyLogs.length === 0) {
        container.innerHTML = `
            <div class="neo-card p-8 text-center space-y-2 bg-white">
                <i class="fa-solid fa-box-open text-3xl text-gray-400"></i>
                <p class="text-xs font-black">Belum Ada Riwayat Aktivasi</p>
            </div>
        `;
        return;
    }
    container.innerHTML = historyLogs.map(item => `
        <div class="neo-card p-3.5 flex items-center justify-between bg-white">
            <div>
                <p class="text-xs font-black">${item.user}</p>
                <p class="text-[10px] font-bold text-gray-500">${item.type}</p>
            </div>
            <span class="px-2.5 py-1 bg-emerald-400 border-2 border-black rounded-lg text-[10px] font-black">
                AKTIF
            </span>
        </div>
    `).join('');
}

window.clearHistoryFeed = function() {
    if (confirm("Hapus seluruh riwayat lokal?")) {
        historyLogs = [];
        renderHistory();
        updateCounts();
        showToast("Riwayat dibersihkan.");
    }
}

window.submitBugReport = function() {
    const category = document.getElementById('report-category').value;
    const description = document.getElementById('report-description').value.trim();

    if (!description) {
        showToast("Mohon isi deskripsi kendala terlebih dahulu!");
        return;
    }

    const message = `Halo Owner AYAKA MOTION,%0A%0ASaya ingin melaporkan kendala:%0A- *Kategori:* ${encodeURIComponent(category)}%0A- *Description:* ${encodeURIComponent(description)}`;
    const waUrl = `https://wa.me/6282339430604?text=${message}`;
    window.open(waUrl, '_blank');
}

function showToast(msg) {
    const toast = document.getElementById('toast-notif');
    document.getElementById('toast-message').textContent = msg;
    toast.classList.remove('opacity-0', 'pointer-events-none');
    setTimeout(() => toast.classList.add('opacity-0', 'pointer-events-none'), 3000);
}

function updateCounts() {
    const count = historyLogs.length;
    const visitorsEl = document.getElementById('visitors-count');
    const actEl = document.getElementById('activations-count');
    const actTotalEl = document.getElementById('act-total-count');
    const actTodayEl = document.getElementById('act-today-count');

    if (visitorsEl) visitorsEl.textContent = count;
    if (actEl) actEl.textContent = count;
    if (actTotalEl) actTotalEl.textContent = count;

    const todayStr = new Date().toDateString();
    const todayCount = historyLogs.filter(h => h.dateString === todayStr).length;
    if (actTodayEl) actTodayEl.textContent = todayCount;
}

async function fetchSupabaseActivations() {
    if (!supabaseClient) return;
    try {
        const { data, error } = await supabaseClient
            .from('activations')
            .select('*')
            .order('timestamp', { ascending: false });

        if (!error && data) {
            historyLogs = data;
            updateCounts();
            if (activeTabName === 'riwayat') renderHistory();
        }
    } catch (e) {
        console.error("Gagal mengambil data Supabase:", e);
    }
}

async function initDatabaseSync() {
    await fetchSupabaseActivations();
    setInterval(fetchSupabaseActivations, 5000);

    try {
        app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);

        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
            await signInWithCustomToken(auth, __initial_auth_token);
        } else {
            await signInAnonymously(auth);
        }
        userId = auth.currentUser?.uid || crypto.randomUUID();

        const activationsCol = collection(db, 'artifacts', appId, 'public', 'data', 'activations');
        onSnapshot(activationsCol, (snapshot) => {
            snapshot.forEach(docSnap => {
                const item = docSnap.data();
                if (!historyLogs.some(h => h.timestamp === item.timestamp && h.user === item.user)) {
                    historyLogs.push(item);
                }
            });
            historyLogs.sort((a, b) => b.timestamp - a.timestamp);
            updateCounts();
            if (activeTabName === 'riwayat') renderHistory();
        }, (error) => {
            console.error("Firestore snapshot error:", error);
        });

    } catch (e) {
        console.error("Firebase init error:", e);
    }
}

initDatabaseSync();

let batteryInstance = null;
if ('getBattery' in navigator) {
    navigator.getBattery().then(batt => {
        batteryInstance = batt;
        updateBatteryDisplay();
        batt.addEventListener('levelchange', updateBatteryDisplay);
        batt.addEventListener('chargingchange', updateBatteryDisplay);
    });
}

function updateBatteryDisplay() {
    const batTextEl = document.getElementById('battery-text');
    if (batteryInstance && batTextEl) {
        const levelPct = Math.round(batteryInstance.level * 100);
        const isCharging = batteryInstance.charging;
        batTextEl.textContent = levelPct + '%' + (isCharging ? ' ⚡' : '');
    } else {
        batTextEl.textContent = '100% (OK)';
    }
}

function updateLiveWidgets() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const clockEl = document.getElementById('live-clock');
    if (clockEl) clockEl.textContent = timeStr;

    const fullDateStr = now.toLocaleDateString('id-ID') + ' ' + now.toLocaleTimeString('id-ID');
    const dtEl = document.getElementById('current-date-time');
    if (dtEl) dtEl.textContent = fullDateStr;

    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsedSec / 60).toString().padStart(2, '0');
    const secs = (elapsedSec % 60).toString().padStart(2, '0');
    const uptimeEl = document.getElementById('live-uptime');
    if (uptimeEl) uptimeEl.textContent = `${mins}:${secs}`;
}

updateLiveWidgets();
setInterval(updateLiveWidgets, 1000);
