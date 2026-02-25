const express = require('express');
const app = express();
const port = 3000;

const session = require('express-session');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
require('dotenv').config({override: true});

let isLoggedIn = false;

// ===== TIMER-DAUER HIER ÄNDERN (in Sekunden) =====
// 600 = 10 Min | 1200 = 20 Min | 1500 = 25 Min | 1800 = 30 Min
const VORBEREITUNGS_TIMER = 120;
// ================================================

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'termineordner', 'termine.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Fehler beim Öffnen der DB:', err.message);
        console.error('Geprüfter Pfad:', dbPath);
    } else {
        console.log('Verbindung zur Datenbank termine.db erfolgreich hergestellt');
        db.run(`CREATE TABLE IF NOT EXISTS timer_status (
                                                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                            schueler_id TEXT UNIQUE NOT NULL,
                                                            started_at INTEGER,
                                                            paused_at INTEGER,
                                                            remaining_seconds REAL NOT NULL DEFAULT ${VORBEREITUNGS_TIMER},
                                                            state TEXT NOT NULL DEFAULT 'idle'
                )`, (err) => {
            if (err) console.error('Fehler beim Erstellen der timer_status Tabelle:', err.message);
            else console.log('timer_status Tabelle bereit');
        });
    }
});

app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'BITTE_IN_.env_SETZEN',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, sameSite: 'lax' }
}));

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.redirect('/');
}

function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString('utf8');
}

const klassen = {
    elektronik: ['5AHEL', '5BHEL', '5CHEL'],
    elektrotechnik: ['5AHET', '5BHET', '5CHET'],
    maschinenbau: ['5AHMBS', '5BHMBZ', '5VHMBS'],
    wirtschaft: ['5AHWIE', '5BHWIE', '5DHWIE']
};

const zweigFarben = {
    elektronik: '#2d5016',
    elektrotechnik: '#e60505',
    maschinenbau: '#4f56d0',
    wirtschaft: '#ffeb3b'
};

const zweigNamen = {
    elektronik: 'Elektronik',
    elektrotechnik: 'Elektrotechnik',
    maschinenbau: 'Maschinenbau',
    wirtschaft: 'Wirtschaft'
};

const zweigZuordnung = {
    '5AHEL': 'elektronik',
    '5BHEL': 'elektronik',
    '5CHEL': 'elektronik',
    '5AHET': 'elektrotechnik',
    '5BHET': 'elektrotechnik',
    '5CHET': 'elektrotechnik',
    '5AHMBS': 'maschinenbau',
    '5BHMBZ': 'maschinenbau',
    '5VHMBS': 'maschinenbau',
    '5AHWIE': 'wirtschaft',
    '5BHWIE': 'wirtschaft',
    '5DHWIE': 'wirtschaft'
};

function getKlassenStrukturAusDB() {
    return new Promise((resolve, reject) => {
        const query = `SELECT DISTINCT klasse FROM termine WHERE klasse IS NOT NULL ORDER BY klasse`;
        db.all(query, [], (err, rows) => {
            if (err) { console.error('Fehler:', err.message); return resolve(null); }
            const struktur = { elektronik: {}, elektrotechnik: {}, maschinenbau: {}, wirtschaft: {} };
            rows.forEach(row => {
                const zweig = zweigZuordnung[row.klasse];
                if (zweig) struktur[zweig][row.klasse] = [];
            });
            resolve(struktur);
        });
    });
}

function getSchuelerFuerZweig(zweig) {
    return new Promise((resolve, reject) => {
        const klassenListe = klassen[zweig] || [];
        if (klassenListe.length === 0) return resolve([]);
        const placeholders = klassenListe.map(() => '?').join(',');
        const query = `SELECT rowid, * FROM termine WHERE klasse IN (${placeholders}) ORDER BY klasse, nachname, vorname`;
        db.all(query, klassenListe, (err, rows) => {
            if (err) { console.error('Fehler:', err.message); return resolve([]); }
            resolve(rows);
        });
    });
}

// ==================== TIMER API ====================

app.get('/api/timer/:schuelerId', requireAuth, (req, res) => {
    const id = req.params.schuelerId;
    db.get('SELECT * FROM timer_status WHERE schueler_id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json({ state: 'idle', remaining_seconds: VORBEREITUNGS_TIMER });
        if (row.state === 'running' && row.started_at) {
            const elapsed = (Date.now() - row.started_at) / 1000;
            const remaining = Math.max(0, row.remaining_seconds - elapsed);
            return res.json({ state: remaining <= 0 ? 'finished' : 'running', remaining_seconds: remaining, started_at: row.started_at });
        }
        res.json({ state: row.state, remaining_seconds: row.remaining_seconds });
    });
});

app.post('/api/timer/:schuelerId/start', requireAuth, (req, res) => {
    const id = req.params.schuelerId;
    const now = Date.now();
    db.run(`INSERT INTO timer_status (schueler_id, started_at, remaining_seconds, state) VALUES (?, ?, ${VORBEREITUNGS_TIMER}, 'running')
                ON CONFLICT(schueler_id) DO UPDATE SET started_at = ?, remaining_seconds = ${VORBEREITUNGS_TIMER}, state = 'running', paused_at = NULL`,
        [id, now, now], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ state: 'running', started_at: now, remaining_seconds: VORBEREITUNGS_TIMER });
        });
});

app.post('/api/timer/:schuelerId/pause', requireAuth, (req, res) => {
    const id = req.params.schuelerId;
    const { remaining_seconds } = req.body;
    db.run(`UPDATE timer_status SET state = 'paused', paused_at = ?, remaining_seconds = ?, started_at = NULL WHERE schueler_id = ?`,
        [Date.now(), remaining_seconds, id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ state: 'paused', remaining_seconds });
        });
});

app.post('/api/timer/:schuelerId/resume', requireAuth, (req, res) => {
    const id = req.params.schuelerId;
    const now = Date.now();
    db.get('SELECT remaining_seconds FROM timer_status WHERE schueler_id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        const remaining = row ? row.remaining_seconds : VORBEREITUNGS_TIMER;
        db.run(`UPDATE timer_status SET state = 'running', started_at = ?, paused_at = NULL WHERE schueler_id = ?`,
            [now, id], function(err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json({ state: 'running', started_at: now, remaining_seconds: remaining });
            });
    });
});

app.post('/api/timer/:schuelerId/reset', requireAuth, (req, res) => {
    const id = req.params.schuelerId;
    db.run(`UPDATE timer_status SET state = 'idle', started_at = NULL, paused_at = NULL, remaining_seconds = ${VORBEREITUNGS_TIMER} WHERE schueler_id = ?`,
        [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ state: 'idle', remaining_seconds: VORBEREITUNGS_TIMER });
        });
});

app.get('/api/timers/:zweig', requireAuth, (req, res) => {
    const zweig = req.params.zweig.toLowerCase();
    db.all('SELECT * FROM timer_status WHERE schueler_id LIKE ?', [`${zweig}_%`], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const timers = {};
        const now = Date.now();
        (rows || []).forEach(row => {
            if (row.state === 'running' && row.started_at) {
                const elapsed = (now - row.started_at) / 1000;
                const remaining = Math.max(0, row.remaining_seconds - elapsed);
                timers[row.schueler_id] = { state: remaining <= 0 ? 'finished' : 'running', remaining_seconds: remaining };
            } else {
                timers[row.schueler_id] = { state: row.state, remaining_seconds: row.remaining_seconds };
            }
        });
        res.json(timers);
    });
});

// ==================== STANDARD ROUTES ====================

app.get('/debug/db', requireAuth, (req, res) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
        if (err) return res.status(500).json({ error: err.message });
        const promises = tables.map(table => new Promise((resolve) => {
            db.all(`SELECT * FROM ${table.name} LIMIT 5`, [], (err, rows) => {
                resolve(err ? { table: table.name, error: err.message } : { table: table.name, rows });
            });
        }));
        Promise.all(promises).then(results => res.json({ database: dbPath, tables: results }));
    });
});

app.get('/klassenstruktur', requireAuth, async (req, res) => {
    try {
        const struktur = await getKlassenStrukturAusDB();
        if (!struktur) return res.json({ message: 'Keine Klassen in DB gefunden', struktur: klassen });
        res.json(struktur);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/zweige', requireAuth, async (req, res) => {
    try {
        const struktur = await getKlassenStrukturAusDB();
        if (!struktur) return res.json({ message: 'Keine Klassen in DB', zweige: Object.keys(klassen), klassen });
        const result = {};
        for (const [zweig, klassenObj] of Object.entries(struktur)) result[zweig] = Object.keys(klassenObj);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/home');
    res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>HTL - Login</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:linear-gradient(135deg,#07175e,#07175e);min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}.container{background:#fff;border-radius:20px;padding:60px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:500px;width:100%;text-align:center}h1{color:#333;margin-bottom:20px;font-size:2.5em}p{color:#666;margin-bottom:40px;font-size:1.2em}.login-button{display:inline-block;padding:15px 40px;background:#0078d4;color:#fff;text-decoration:none;border-radius:8px;font-size:1.2em;font-weight:700;transition:all .3s;box-shadow:0 5px 15px rgba(0,0,0,.2)}.login-button:hover{background:#005a9e;transform:translateY(-2px)}</style></head>
    <body><div class="container"><h1>Willkommen</h1><p>Bitte loggen Sie sich ein</p><a href="/microsoft-login" class="login-button">Mit Microsoft einloggen</a></div></body></html>`);
});

app.get('/microsoft-login', (req, res) => {
    res.redirect(`https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_mode=query&scope=openid%20email%20profile`);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('<h1>Login abgebrochen</h1><a href="/">Zurück</a>');
    try {
        const tokenResponse = await axios.post('https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
            new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.REDIRECT_URI }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const idToken = tokenResponse.data.id_token;
        if (!idToken) return res.status(500).send('Kein id_token erhalten.');
        const payload = JSON.parse(base64UrlDecode(idToken.split('.')[1]));
        const email = (payload.preferred_username || payload.upn || payload.email || '').toLowerCase();
        if (!email) return res.status(403).send('Keine Email im Token gefunden.');
        if (!email.endsWith('@ms.bulme.at')) return res.status(403).send('<h1>Zugriff verweigert</h1><p>Nur @ms.bulme.at Accounts erlaubt.</p><a href="/">Zurück</a>');
        req.session.user = { email };
        return res.redirect('/home');
    } catch (err) {
        console.error(err.response?.data || err.message);
        return res.status(500).send('<h1>Fehler beim Login</h1><a href="/">Zurück</a>');
    }
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

app.get('/home', requireAuth, async (req, res) => {
    try {
        const struktur = await getKlassenStrukturAusDB();
        const aktiveZweige = struktur ? Object.keys(struktur).filter(z => Object.keys(struktur[z]).length > 0) : Object.keys(klassen);
        res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>HTL - Zweigauswahl</title>
        <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:linear-gradient(135deg,#07175e,#07175e);min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}.container{background:#fff;border-radius:20px;padding:50px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:800px;width:100%}h1{text-align:center;color:#333;margin-bottom:50px;font-size:2.5em}.button-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}.zweig-button{padding:40px;font-size:1.5em;font-weight:700;border:none;border-radius:15px;cursor:pointer;transition:all .3s;text-decoration:none;display:flex;align-items:center;justify-content:center;box-shadow:0 5px 15px rgba(0,0,0,.2)}.zweig-button:hover{transform:translateY(-5px);box-shadow:0 10px 25px rgba(0,0,0,.3)}.elektronik{background:#2d5016;color:#fff}.elektrotechnik{background:#e60505;color:#fff}.maschinenbau{background:#4f56d0;color:#fff}.wirtschaft{background:#ffeb3b;color:#333}</style></head>
        <body><div class="container"><h1>Wählen Sie Ihren Zweig aus</h1><div class="button-grid">
        ${aktiveZweige.map(z => '<a href="/zweig/' + z + '" class="zweig-button ' + z + '">' + zweigNamen[z] + '</a>').join('')}
        </div></div></body></html>`);
    } catch (err) { res.status(500).send('Fehler'); }
});

// ==================== ZWEIG PAGE ====================

app.get('/zweig/:zweig', requireAuth, async (req, res) => {
    const zweig = req.params.zweig.toLowerCase();
    try {
        if (!klassen[zweig]) return res.redirect('/home');
        const schueler = await getSchuelerFuerZweig(zweig);
        const farbe = zweigFarben[zweig];
        const name = zweigNamen[zweig];
        const textFarbe = (zweig === 'elektrotechnik' || zweig === 'wirtschaft') ? '#333' : 'white';

        const cardsHtml = schueler.map((s, index) => {
            const sid = zweig + '_' + (s.rowid || index);
            return '<div class="schueler-item" id="card-' + sid + '" data-sid="' + sid + '">'
                + '<div class="timer-progress-bg" id="progress-' + sid + '"></div>'
                + '<div class="card-content">'
                +   '<div class="schueler-header">'
                +     '<div class="schueler-name-container">'
                +       '<div class="schueler-name">' + (s.vorname || 'Vorname') + ' ' + (s.nachname || 'Nachname') + '</div>'
                +       (s.klasse ? '<span class="klassen-badge">' + s.klasse + '</span>' : '')
                +       '<span class="timer-badge" id="badge-' + sid + '"></span>'
                +     '</div>'
                +     (s.datum ? '<div class="schueler-datum">' + s.datum + '</div>' : '')
                +   '</div>'
                +   '<div class="schueler-details">'
                +     (s.fach ? '<div class="detail-item"><span class="detail-label">Fach:</span> ' + s.fach + '</div>' : '')
                +     (s.pruefer ? '<div class="detail-item"><span class="detail-label">Prüfer:</span> ' + s.pruefer + '</div>' : '')
                +     (s.beisitz ? '<div class="detail-item"><span class="detail-label">Beisitz:</span> ' + s.beisitz + '</div>' : '')
                +     (s.exam_start ? '<div class="detail-item"><span class="detail-label">Prüfung:</span> ' + s.exam_start + ' - ' + (s.exam_end || '?') + '</div>' : '')
                +   '</div>'
                +   '<div class="expand-hint" id="hint-' + sid + '">▼ Klicken zum Öffnen</div>'
                +   '<div class="expanded-section" id="exp-' + sid + '">'
                +     '<div class="expanded-content">'
                +       '<div class="timer-display">'
                +         '<div class="timer-time" id="time-' + sid + '">20:00</div>'
                +         '<div class="timer-label" id="label-' + sid + '">Vorbereitung</div>'
                +       '</div>'
                +       '<div class="timer-buttons" id="buttons-' + sid + '"></div>'
                +     '</div>'
                +   '</div>'
                + '</div>'
                + '</div>';
        }).join('');

        res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} - Schülerübersicht</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: Arial, sans-serif;
      background: linear-gradient(135deg, #07175e, #07175e);
      min-height: 100vh;
      padding: 40px 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 60px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 1000px;
      margin: 0 auto;
    }
    .back-button {
      display: inline-block; margin-bottom: 30px; padding: 12px 25px;
      background: #666; color: white; text-decoration: none;
      border-radius: 8px; transition: background 0.3s;
    }
    .back-button:hover { background: #444; }
    .zweig-badge {
      display: inline-block; padding: 30px 60px;
      background: ${farbe}; color: ${textFarbe};
      font-size: 3em; font-weight: bold; border-radius: 15px;
      margin: 30px 0; box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    }
    h1 { color: #333; font-size: 2em; margin-top: 20px; text-align: center; }
    p.subtitle { color: #666; font-size: 1.2em; margin-top: 20px; text-align: center; }
    .schueler-liste { margin-top: 40px; }

    /* ===== CARD ===== */
    .schueler-item {
      position: relative;
      margin: 15px 0;
      border-radius: 12px;
      border-left: 5px solid ${farbe};
      box-shadow: 0 2px 5px rgba(0,0,0,0.1);
      cursor: pointer;
      overflow: hidden;
      transition: box-shadow 0.3s, transform 0.2s;
    }
    .schueler-item:hover {
      transform: translateX(5px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    .schueler-item.expanded {
      transform: none;
      box-shadow: 0 6px 25px rgba(0,0,0,0.2);
    }

    /* ===== FORTSCHRITTSBALKEN (füllt ganze Card) ===== */
    .timer-progress-bg {
      position: absolute;
      top: 0; left: 0;
      height: 100%;
      width: 0%;
      z-index: 0;
      pointer-events: none;
      transition: width 0.8s linear;
    }

    /* Card content sitzt ÜBER dem Fortschrittsbalken */
    .card-content {
      position: relative;
      z-index: 1;
      padding: 20px;
    }

    .schueler-header {
      display: flex; justify-content: space-between;
      align-items: center; margin-bottom: 10px;
      flex-wrap: wrap; gap: 10px;
    }
    .schueler-name-container {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    }
    .schueler-name { font-weight: bold; font-size: 1.3em; color: #222; }
    .klassen-badge {
      background: ${farbe}; color: ${textFarbe};
      padding: 4px 12px; border-radius: 15px;
      font-size: 0.8em; font-weight: bold;
    }
    .schueler-datum {
      background: ${farbe}; color: ${textFarbe};
      padding: 5px 15px; border-radius: 20px;
      font-size: 0.9em; font-weight: bold;
    }
    .schueler-details {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 10px; margin-top: 10px;
    }
    .detail-item { color: #444; font-size: 0.95em; padding: 5px; }
    .detail-label { font-weight: bold; color: #222; }

    /* ===== TIMER BADGE (sichtbar wenn Card zugeklappt) ===== */
    .timer-badge {
      display: none;
      padding: 4px 14px;
      border-radius: 15px;
      font-size: 0.85em;
      font-weight: bold;
    }
    .timer-badge.visible { display: inline-block; }
    .timer-badge.st-running { background: #fff3cd; color: #856404; }
    .timer-badge.st-paused { background: #ff9800; color: white; }
    .timer-badge.st-finished { background: #4caf50; color: white; }

    /* ===== EXPAND ===== */
    .expand-hint {
      text-align: right; font-size: 0.8em;
      color: #aaa; margin-top: 8px;
    }
    .schueler-item.expanded .expand-hint {
      opacity: 0; height: 0; margin: 0; overflow: hidden;
    }
    .expanded-section {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.4s ease;
    }
    .schueler-item.expanded .expanded-section {
      max-height: 250px;
    }
    .expanded-content {
      border-top: 2px solid rgba(0,0,0,0.08);
      padding-top: 20px; margin-top: 15px;
    }

    /* ===== TIMER DISPLAY ===== */
    .timer-display { text-align: center; margin-bottom: 15px; }
    .timer-time {
      font-size: 2.8em; font-weight: bold; color: #222;
      font-variant-numeric: tabular-nums; letter-spacing: 3px;
    }
    .timer-label { font-size: 0.95em; color: #555; margin-top: 4px; }

    /* ===== BUTTONS ===== */
    .timer-buttons {
      display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;
    }
    .timer-btn {
      padding: 12px 28px; border: none; border-radius: 10px;
      font-size: 1.05em; font-weight: bold; cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 3px 8px rgba(0,0,0,0.15);
    }
    .timer-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(0,0,0,0.25);
    }
    .timer-btn:active { transform: translateY(0); }
    .btn-start { background: #f0c230; color: #333; }
    .btn-start:hover { background: #e6b420; }
    .btn-pause { background: #ff9800; color: white; }
    .btn-pause:hover { background: #e68900; }
    .btn-resume { background: #4caf50; color: white; }
    .btn-resume:hover { background: #43a047; }
    .btn-reset { background: #f44336; color: white; }
    .btn-reset:hover { background: #d32f2f; }

    @media (max-width: 600px) {
      .container { padding: 30px 15px; }
      .zweig-badge { padding: 20px 30px; font-size: 2em; }
      .timer-time { font-size: 2em; }
      .timer-btn { padding: 10px 18px; font-size: 0.95em; }
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="/home" class="back-button">Zurück zur Zweigauswahl</a>
    <div style="text-align: center;">
      <div class="zweig-badge">${name}</div>
      <h1>Zweig ${name}</h1>
      ${schueler.length > 0 ? '<p class="subtitle">' + schueler.length + ' Schüler maturieren</p>' : '<p class="subtitle">Keine Schüler gefunden.</p>'}
    </div>
    ${schueler.length > 0 ? '<div class="schueler-liste">' + cardsHtml + '</div>' : ''}
  </div>

<script>
(function() {

  var TOTAL = ${VORBEREITUNGS_TIMER};
  var timers = {};

  function get(sid) {
    if (!timers[sid]) timers[sid] = { state: 'idle', rem: TOTAL, iid: null };
    return timers[sid];
  }

  function fmt(s) {
    var m = Math.floor(s / 60);
    var sc = Math.floor(s % 60);
    return (m < 10 ? '0' : '') + m + ':' + (sc < 10 ? '0' : '') + sc;
  }

  // Gelb(#f0c230) -> Grün(#4caf50) Verlauf je nach progress (0..1)
  function colorAt(p) {
    var r = Math.round(240 + (76 - 240) * p);
    var g = Math.round(194 + (175 - 194) * p);
    var b = Math.round(48 + (80 - 48) * p);
    return 'rgba(' + r + ',' + g + ',' + b + ',0.45)';
  }

  function render(sid) {
    var t = get(sid);
    var card = document.getElementById('card-' + sid);
    var prog = document.getElementById('progress-' + sid);
    var timeEl = document.getElementById('time-' + sid);
    var labEl = document.getElementById('label-' + sid);
    var btns = document.getElementById('buttons-' + sid);
    var badge = document.getElementById('badge-' + sid);
    if (!card) return;

    timeEl.textContent = fmt(t.rem);
    var p = Math.max(0, Math.min(1, 1 - (t.rem / TOTAL)));

    if (t.state === 'idle') {
      prog.style.width = '0%';
      prog.style.backgroundColor = 'transparent';
      labEl.textContent = 'Vorbereitung';
      badge.className = 'timer-badge';
      btns.innerHTML = '<button class="timer-btn btn-start" data-action="start" data-sid="' + sid + '">Vorbereitung starten</button>';

    } else if (t.state === 'running') {
      prog.style.width = (p * 100) + '%';
      prog.style.backgroundColor = colorAt(p);
      labEl.textContent = 'Vorbereitung läuft...';
      badge.className = 'timer-badge visible st-running';
      badge.textContent = fmt(t.rem) + ' ⏱';
      btns.innerHTML = '<button class="timer-btn btn-pause" data-action="pause" data-sid="' + sid + '">Pause</button>'
        + '<button class="timer-btn btn-reset" data-action="reset" data-sid="' + sid + '">Reset</button>';

    } else if (t.state === 'paused') {
      prog.style.width = (p * 100) + '%';
      prog.style.backgroundColor = colorAt(p);
      labEl.textContent = 'Pausiert';
      badge.className = 'timer-badge visible st-paused';
      badge.textContent = fmt(t.rem) + ' ⏸';
      btns.innerHTML = '<button class="timer-btn btn-resume" data-action="resume" data-sid="' + sid + '">Fortsetzen</button>'
        + '<button class="timer-btn btn-reset" data-action="reset" data-sid="' + sid + '">Reset</button>';

    } else if (t.state === 'finished') {
      prog.style.width = '100%';
      prog.style.backgroundColor = 'rgba(76, 175, 80, 0.5)';
      timeEl.textContent = '00:00';
      labEl.textContent = 'Vorbereitung abgeschlossen!';
      badge.className = 'timer-badge visible st-finished';
      badge.textContent = 'Fertig ✓';
      btns.innerHTML = '<button class="timer-btn btn-reset" data-action="reset" data-sid="' + sid + '">Reset</button>';
    }
  }

  function tick(sid) {
    var t = get(sid);
    if (t.state !== 'running') return;
    t.rem = Math.max(0, t.rem - 1);
    if (t.rem <= 0) {
      t.state = 'finished';
      if (t.iid) { clearInterval(t.iid); t.iid = null; }
    }
    render(sid);
  }

  function api(sid, action, body) {
    var opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    fetch('/api/timer/' + sid + '/' + action, opts).catch(function(e) { console.warn('Sync:', e); });
  }

  // ===== EVENT DELEGATION (ein einziger Listener) =====
  document.addEventListener('click', function(e) {

    // 1) Button geklickt?
    var btn = e.target.closest('.timer-btn');
    if (btn) {
      e.stopPropagation(); // Card nicht toggeln
      e.preventDefault();
      var action = btn.getAttribute('data-action');
      var sid = btn.getAttribute('data-sid');
      if (!action || !sid) return;

      var t = get(sid);

      if (action === 'start') {
        if (t.iid) clearInterval(t.iid);
        t.state = 'running';
        t.rem = TOTAL;
        t.iid = setInterval(function() { tick(sid); }, 1000);
        render(sid);
        api(sid, 'start');
      }
      else if (action === 'pause') {
        t.state = 'paused';
        if (t.iid) { clearInterval(t.iid); t.iid = null; }
        render(sid);
        api(sid, 'pause', { remaining_seconds: t.rem });
      }
      else if (action === 'resume') {
        t.state = 'running';
        if (t.iid) clearInterval(t.iid);
        t.iid = setInterval(function() { tick(sid); }, 1000);
        render(sid);
        api(sid, 'resume');
      }
      else if (action === 'reset') {
        if (t.iid) { clearInterval(t.iid); t.iid = null; }
        t.state = 'idle';
        t.rem = TOTAL;
        render(sid);
        api(sid, 'reset');
      }
      return;
    }

    // 2) Card geklickt (nicht Button) -> toggle expand
    var card = e.target.closest('.schueler-item');
    if (card) {
      card.classList.toggle('expanded');
    }
  });

  // ===== Initial render =====
  document.querySelectorAll('.schueler-item').forEach(function(c) {
    var sid = c.getAttribute('data-sid');
    if (sid) render(sid);
  });

  // ===== Gespeicherte Timer vom Server laden =====
  fetch('/api/timers/${zweig}')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      for (var sid in data) {
        if (!data.hasOwnProperty(sid)) continue;
        var info = data[sid];
        var t = get(sid);
        t.rem = Math.max(0, info.remaining_seconds);
        t.state = info.state;
        if (t.state === 'finished') t.rem = 0;
        if (t.state === 'running' && t.rem > 0) {
          (function(id) {
            t.iid = setInterval(function() { tick(id); }, 1000);
          })(sid);
        }
        render(sid);
      }
    })
    .catch(function(e) { console.warn('Timer load error:', e); });

})();
</script>
</body>
</html>`);
    } catch (err) {
        console.error('Fehler:', err);
        res.status(500).send('Fehler beim Laden');
    }
});

// ==================== HTTPS ====================

const httpsOptions = {
    key: fs.readFileSync('./cert/key.pem'),
    cert: fs.readFileSync('./cert/cert.pem'),
};

https.createServer(httpsOptions, app).listen(process.env.PORT || port, () => {
    console.log('HTTPS-Server läuft auf https://localhost:' + (process.env.PORT || port));
});

process.on('SIGINT', () => {
    db.close((err) => {
        if (err) console.error('DB close error:', err.message);
        else console.log('DB geschlossen');
        process.exit(0);
    });
});