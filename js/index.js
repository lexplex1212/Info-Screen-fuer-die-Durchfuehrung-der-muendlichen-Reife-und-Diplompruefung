const express = require('express');
const app = express();
const port = 3000;

// Zusätzliche Imports:
const session = require('express-session');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
require('dotenv').config({override: true});

let isLoggedIn = false;

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Eine Ebene hoch aus /js, dann in /termineordner
const dbPath = path.join(__dirname, '..', 'termineordner', 'termine.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Fehler beim Öffnen der DB:', err.message);
        console.error('Geprüfter Pfad:', dbPath);
    } else {
        console.log('Verbindung zur Datenbank termine.db erfolgreich hergestellt');
        // Timer-Tabelle erstellen falls nicht vorhanden
        db.run(`CREATE TABLE IF NOT EXISTS timer_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            schueler_id TEXT UNIQUE NOT NULL,
            started_at INTEGER,
            paused_at INTEGER,
            remaining_seconds REAL NOT NULL DEFAULT 1200,
            state TEXT NOT NULL DEFAULT 'idle'
        )`, (err) => {
            if (err) console.error('Fehler beim Erstellen der timer_status Tabelle:', err.message);
            else console.log('timer_status Tabelle bereit');
        });
    }
});

// JSON Body Parser für Timer-API
app.use(express.json());

// Session speichern (damit Login "merkt", dass man drin ist)
app.use(session({
    secret: process.env.SESSION_SECRET || 'BITTE_IN_.env_SETZEN',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, sameSite: 'lax' }
}));

// Schutz: Nur eingeloggte dürfen /home, /zweig, /klasse sehen
function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.redirect('/');
}

// Helper: JWT payload (Base64URL) decodieren
function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString('utf8');
}

// Klassen-Zuordnung zu den Zweigen (als Backup/Fallback)
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
            if (err) {
                console.error('Fehler beim Auslesen der Klassen:', err.message);
                return resolve(null);
            }
            const struktur = {
                elektronik: {},
                elektrotechnik: {},
                maschinenbau: {},
                wirtschaft: {}
            };
            rows.forEach(row => {
                const klassenname = row.klasse;
                const zweig = zweigZuordnung[klassenname];
                if (zweig) {
                    struktur[zweig][klassenname] = [];
                }
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
        const query = `
            SELECT rowid, * FROM termine 
            WHERE klasse IN (${placeholders})
            ORDER BY klasse, nachname, vorname
        `;
        db.all(query, klassenListe, (err, rows) => {
            if (err) {
                console.error('Fehler beim Laden der Schüler:', err.message);
                return resolve([]);
            }
            resolve(rows);
        });
    });
}

// ==================== TIMER API ROUTES ====================

app.get('/api/timer/:schuelerId', requireAuth, (req, res) => {
    const id = req.params.schuelerId;
    db.get('SELECT * FROM timer_status WHERE schueler_id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json({ state: 'idle', remaining_seconds: 1200 });
        if (row.state === 'running' && row.started_at) {
            const now = Date.now();
            const elapsed = (now - row.started_at) / 1000;
            const remaining = Math.max(0, row.remaining_seconds - elapsed);
            return res.json({
                state: remaining <= 0 ? 'finished' : 'running',
                remaining_seconds: remaining,
                started_at: row.started_at
            });
        }
        res.json({
            state: row.state,
            remaining_seconds: row.remaining_seconds,
            started_at: row.started_at,
            paused_at: row.paused_at
        });
    });
});

app.post('/api/timer/:schuelerId/start', requireAuth, (req, res) => {
    const id = req.params.schuelerId;
    const now = Date.now();
    db.run(`INSERT INTO timer_status (schueler_id, started_at, remaining_seconds, state)
            VALUES (?, ?, 1200, 'running')
            ON CONFLICT(schueler_id) DO UPDATE SET
                started_at = ?,
                remaining_seconds = 1200,
                state = 'running',
                paused_at = NULL`,
        [id, now, now], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ state: 'running', started_at: now, remaining_seconds: 1200 });
        });
});

app.post('/api/timer/:schuelerId/pause', requireAuth, (req, res) => {
    const id = req.params.schuelerId;
    const { remaining_seconds } = req.body;
    const now = Date.now();
    db.run(`UPDATE timer_status SET state = 'paused', paused_at = ?, remaining_seconds = ?, started_at = NULL
            WHERE schueler_id = ?`,
        [now, remaining_seconds, id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ state: 'paused', remaining_seconds });
        });
});

app.post('/api/timer/:schuelerId/resume', requireAuth, (req, res) => {
    const id = req.params.schuelerId;
    const now = Date.now();
    db.get('SELECT remaining_seconds FROM timer_status WHERE schueler_id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        const remaining = row ? row.remaining_seconds : 1200;
        db.run(`UPDATE timer_status SET state = 'running', started_at = ?, paused_at = NULL
                WHERE schueler_id = ?`,
            [now, id], function(err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json({ state: 'running', started_at: now, remaining_seconds: remaining });
            });
    });
});

app.post('/api/timer/:schuelerId/reset', requireAuth, (req, res) => {
    const id = req.params.schuelerId;
    db.run(`UPDATE timer_status SET state = 'idle', started_at = NULL, paused_at = NULL, remaining_seconds = 1200
            WHERE schueler_id = ?`,
        [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ state: 'idle', remaining_seconds: 1200 });
        });
});

// Bulk: Alle Timer für einen Zweig
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
                timers[row.schueler_id] = {
                    state: remaining <= 0 ? 'finished' : 'running',
                    remaining_seconds: remaining,
                    started_at: row.started_at
                };
            } else {
                timers[row.schueler_id] = {
                    state: row.state,
                    remaining_seconds: row.remaining_seconds
                };
            }
        });
        res.json(timers);
    });
});

// ==================== EXISTING ROUTES (unchanged) ====================

app.get('/debug/db', requireAuth, (req, res) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
        if (err) return res.status(500).json({ error: err.message });
        const promises = tables.map(table => {
            return new Promise((resolve) => {
                db.all(`SELECT * FROM ${table.name} LIMIT 5`, [], (err, rows) => {
                    resolve(err ? { table: table.name, error: err.message } : { table: table.name, rows });
                });
            });
        });
        Promise.all(promises).then(results => {
            res.json({ database: dbPath, tables: results });
        });
    });
});

app.get('/klassenstruktur', requireAuth, async (req, res) => {
    try {
        const struktur = await getKlassenStrukturAusDB();
        if (!struktur) return res.json({ message: 'Keine Klassen in DB gefunden, verwende statische Klassen', struktur: klassen });
        res.json(struktur);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/zweige', requireAuth, async (req, res) => {
    try {
        const struktur = await getKlassenStrukturAusDB();
        if (!struktur) return res.json({ message: 'Keine Klassen in DB gefunden', zweige: Object.keys(klassen), klassen });
        const result = {};
        for (const [zweig, klassenObj] of Object.entries(struktur)) {
            result[zweig] = Object.keys(klassenObj);
        }
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/home');
    res.send(`
    <!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>HTL - Login</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #07175e 0%, #07175e 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
        .container { background: white; border-radius: 20px; padding: 60px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 500px; width: 100%; text-align: center; }
        h1 { color: #333; margin-bottom: 20px; font-size: 2.5em; }
        p { color: #666; margin-bottom: 40px; font-size: 1.2em; }
        .login-button { display: inline-block; padding: 15px 40px; background-color: #0078d4; color: white; text-decoration: none; border-radius: 8px; font-size: 1.2em; font-weight: bold; transition: all 0.3s ease; box-shadow: 0 5px 15px rgba(0,0,0,0.2); }
        .login-button:hover { background-color: #005a9e; transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,0.3); }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Willkommen</h1>
        <p>Bitte loggen Sie sich ein</p>
        <a href="/microsoft-login" class="login-button">Mit Microsoft einloggen</a>
      </div>
    </body>
    </html>
  `);
});

app.get('/microsoft-login', (req, res) => {
    const authUrl =
        `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize` +
        `?client_id=${process.env.CLIENT_ID}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
        `&response_mode=query` +
        `&scope=openid%20email%20profile`;
    res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send(`<h1>Login abgebrochen</h1><p>Kein Code erhalten.</p><a href="/">Zurück</a>`);

    try {
        const tokenResponse = await axios.post(
            'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
            new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: process.env.REDIRECT_URI
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const idToken = tokenResponse.data.id_token;
        if (!idToken) return res.status(500).send('Kein id_token erhalten.');

        const payload = JSON.parse(base64UrlDecode(idToken.split('.')[1]));
        const email = (payload.preferred_username || payload.upn || payload.email || '').toLowerCase();

        if (!email) return res.status(403).send('Keine Email im Token gefunden.');
        if (!email.endsWith('@ms.bulme.at')) {
            return res.status(403).send(`<h1>Zugriff verweigert</h1><p>Nur <b>@ms.bulme.at</b> Accounts sind erlaubt.</p><p>Du bist eingeloggt als: ${email}</p><a href="/">Zurück</a>`);
        }

        req.session.user = { email };
        return res.redirect('/home');
    } catch (err) {
        console.error(err.response?.data || err.message);
        return res.status(500).send(`<h1>Fehler beim Login</h1><p>Prüfe CLIENT_SECRET und ob REDIRECT_URI exakt mit Azure übereinstimmt.</p><a href="/">Zurück</a>`);
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.get('/home', requireAuth, async (req, res) => {
    try {
        const struktur = await getKlassenStrukturAusDB();
        const aktiveZweige = struktur ? Object.keys(struktur).filter(zweig => Object.keys(struktur[zweig]).length > 0) : Object.keys(klassen);

        res.send(`
    <!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>HTL - Zweigauswahl</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #07175e 0%, #07175e 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
        .container { background: white; border-radius: 20px; padding: 50px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 800px; width: 100%; }
        h1 { text-align: center; color: #333; margin-bottom: 50px; font-size: 2.5em; }
        .button-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
        .zweig-button { padding: 40px; font-size: 1.5em; font-weight: bold; border: none; border-radius: 15px; cursor: pointer; transition: all 0.3s ease; text-decoration: none; display: flex; align-items: center; justify-content: center; text-align: center; box-shadow: 0 5px 15px rgba(0,0,0,0.2); }
        .zweig-button:hover { transform: translateY(-5px); box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
        .elektronik { background-color: #2d5016; color: white; }
        .elektrotechnik { background-color: #e60505; color: white; }
        .maschinenbau { background-color: #4f56d0; color: white; }
        .wirtschaft { background-color: #ffeb3b; color: #333; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Wählen Sie Ihren Zweig aus</h1>
        <div class="button-grid">
          ${aktiveZweige.map(zweig => `<a href="/zweig/${zweig}" class="zweig-button ${zweig}">${zweigNamen[zweig]}</a>`).join('')}
        </div>
      </div>
    </body>
    </html>
  `);
    } catch (err) {
        console.error('Fehler beim Laden der Zweige:', err);
        res.status(500).send('Fehler beim Laden der Daten');
    }
});

// ==================== ZWEIG PAGE (expandierbare Cards + Timer) ====================

app.get('/zweig/:zweig', requireAuth, async (req, res) => {
    const zweig = req.params.zweig.toLowerCase();

    try {
        if (!klassen[zweig]) return res.redirect('/home');

        const schueler = await getSchuelerFuerZweig(zweig);
        const farbe = zweigFarben[zweig];
        const name = zweigNamen[zweig];
        const textFarbe = (zweig === 'elektrotechnik' || zweig === 'wirtschaft') ? '#333' : 'white';

        // Schüler-Cards HTML generieren
        const cardsHtml = schueler.map((s, index) => {
            const sid = zweig + '_' + (s.rowid || index);
            return `
            <div class="schueler-item" id="card-${sid}" onclick="toggleCard('${sid}', event)">
              <div class="timer-progress-bg" id="progress-${sid}"></div>
              <div class="schueler-header">
                <div class="schueler-name-container">
                  <div class="schueler-name">${s.vorname || 'Vorname'} ${s.nachname || 'Nachname'}</div>
                  ${s.klasse ? '<span class="klassen-badge">' + s.klasse + '</span>' : ''}
                  <span class="timer-badge" id="badge-${sid}"></span>
                </div>
                ${s.datum ? '<div class="schueler-datum">' + s.datum + '</div>' : ''}
              </div>
              <div class="schueler-details">
                ${s.fach ? '<div class="detail-item"><span class="detail-label">Fach:</span> ' + s.fach + '</div>' : ''}
                ${s.pruefer ? '<div class="detail-item"><span class="detail-label">Prüfer:</span> ' + s.pruefer + '</div>' : ''}
                ${s.beisitz ? '<div class="detail-item"><span class="detail-label">Beisitz:</span> ' + s.beisitz + '</div>' : ''}
                ${s.rep_start ? '<div class="detail-item"><span class="detail-label">Vorbereitung:</span> ' + s.rep_start + ' - ' + (s.prep_end || '?') + '</div>' : ''}
                ${s.exam_start ? '<div class="detail-item"><span class="detail-label">Prüfung:</span> ' + s.exam_start + ' - ' + (s.exam_end || '?') + '</div>' : ''}
              </div>
              <div class="expand-hint">▼ Klicken zum Öffnen</div>
              <div class="expanded-section">
                <div class="expanded-content">
                  <div class="timer-display">
                    <div class="timer-time" id="time-${sid}">20:00</div>
                    <div class="timer-label" id="label-${sid}">Vorbereitung</div>
                  </div>
                  <div class="timer-buttons" id="buttons-${sid}">
                    <button class="timer-btn btn-start" onclick="startTimer('${sid}', event)">Vorbereitung starten</button>
                    <button class="timer-btn btn-close" onclick="closeCard('${sid}', event)">Schließen</button>
                  </div>
                </div>
              </div>
            </div>`;
        }).join('');

        res.send(`
    <!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${name} - Schülerübersicht</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #07175e 0%, #07175e 100%); min-height: 100vh; padding: 40px 20px; }
        .container { background: white; border-radius: 20px; padding: 60px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 1000px; margin: 0 auto; }
        .back-button { display: inline-block; margin-bottom: 30px; padding: 12px 25px; background-color: #666; color: white; text-decoration: none; border-radius: 8px; transition: background-color 0.3s; }
        .back-button:hover { background-color: #444; }
        .zweig-badge { display: inline-block; padding: 30px 60px; background-color: ${farbe}; color: ${textFarbe}; font-size: 3em; font-weight: bold; border-radius: 15px; margin: 30px 0; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        h1 { color: #333; font-size: 2em; margin-top: 20px; text-align: center; }
        p.subtitle { color: #666; font-size: 1.2em; margin-top: 20px; text-align: center; }
        .schueler-liste { margin-top: 40px; }

        /* ===== Card ===== */
        .schueler-item { 
          position: relative;
          padding: 20px; 
          margin: 15px 0; 
          background: #f9f9f9; 
          border-radius: 10px; 
          border-left: 5px solid ${farbe}; 
          transition: all 0.3s ease;
          box-shadow: 0 2px 5px rgba(0,0,0,0.1);
          cursor: pointer;
          overflow: hidden;
        }
        .schueler-item:hover {
          transform: translateX(5px);
          box-shadow: 0 4px 10px rgba(0,0,0,0.15);
        }
        .schueler-item.expanded {
          cursor: default;
          transform: none;
          box-shadow: 0 6px 20px rgba(0,0,0,0.2);
        }

        /* ===== Timer-Fortschrittsbalken (Hintergrund der Card) ===== */
        .timer-progress-bg {
          position: absolute;
          top: 0;
          left: 0;
          height: 100%;
          width: 0%;
          border-radius: 10px 0 0 10px;
          transition: width 1s linear, background 1s linear;
          z-index: 0;
          pointer-events: none;
        }
        .schueler-item > *:not(.timer-progress-bg) {
          position: relative;
          z-index: 1;
        }

        /* ===== Header ===== */
        .schueler-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
          flex-wrap: wrap;
          gap: 10px;
        }
        .schueler-name-container {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .schueler-name { font-weight: bold; font-size: 1.3em; color: #333; }
        .klassen-badge {
          background: ${farbe};
          color: ${textFarbe};
          padding: 4px 12px;
          border-radius: 15px;
          font-size: 0.8em;
          font-weight: bold;
        }
        .schueler-datum {
          background: ${farbe};
          color: ${textFarbe};
          padding: 5px 15px;
          border-radius: 20px;
          font-size: 0.9em;
          font-weight: bold;
        }
        .schueler-details {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 10px;
          margin-top: 10px;
        }
        .detail-item { color: #555; font-size: 0.95em; padding: 5px; }
        .detail-label { font-weight: bold; color: #333; }

        /* ===== Timer Badge (collapsed) ===== */
        .timer-badge {
          display: none;
          padding: 4px 12px;
          border-radius: 15px;
          font-size: 0.85em;
          font-weight: bold;
          background: #f0ad4e;
          color: #333;
        }
        .timer-badge.active { display: inline-block; }
        .timer-badge.finished { background: #4caf50; color: white; }
        .timer-badge.paused { background: #ff9800; color: white; }

        /* ===== Expand hint ===== */
        .expand-hint {
          text-align: right;
          font-size: 0.8em;
          color: #aaa;
          margin-top: 5px;
        }
        .schueler-item.expanded .expand-hint { display: none; }

        /* ===== Expanded section ===== */
        .expanded-section {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.4s ease, padding 0.4s ease;
        }
        .schueler-item.expanded .expanded-section {
          max-height: 300px;
          padding-top: 15px;
        }
        .expanded-content {
          border-top: 2px solid #e0e0e0;
          padding-top: 20px;
        }

        /* ===== Timer display ===== */
        .timer-display { text-align: center; margin-bottom: 15px; }
        .timer-time {
          font-size: 2.5em;
          font-weight: bold;
          color: #333;
          font-variant-numeric: tabular-nums;
          letter-spacing: 2px;
        }
        .timer-label { font-size: 0.9em; color: #888; margin-top: 4px; }

        /* ===== Timer buttons ===== */
        .timer-buttons { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
        .timer-btn {
          padding: 10px 24px;
          border: none;
          border-radius: 8px;
          font-size: 1em;
          font-weight: bold;
          cursor: pointer;
          transition: all 0.2s ease;
          box-shadow: 0 2px 6px rgba(0,0,0,0.15);
        }
        .timer-btn:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        .timer-btn:active { transform: translateY(0); }
        .btn-start { background: #f0c230; color: #333; }
        .btn-start:hover { background: #e6b420; }
        .btn-pause { background: #ff9800; color: white; }
        .btn-pause:hover { background: #e68900; }
        .btn-resume { background: #4caf50; color: white; }
        .btn-resume:hover { background: #43a047; }
        .btn-reset { background: #f44336; color: white; }
        .btn-reset:hover { background: #d32f2f; }
        .btn-close { background: #9e9e9e; color: white; }
        .btn-close:hover { background: #757575; }

        @media (max-width: 600px) {
          .container { padding: 30px 20px; }
          .zweig-badge { padding: 20px 30px; font-size: 2em; }
          .timer-time { font-size: 2em; }
          .timer-btn { padding: 8px 16px; font-size: 0.9em; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <a href="/home" class="back-button">Zurück zur Zweigauswahl</a>
        <div style="text-align: center;">
          <div class="zweig-badge">${name}</div>
          <h1>Zweig ${name}</h1>
          ${schueler.length > 0 ? '<p class="subtitle">' + schueler.length + ' Schüler maturieren</p>' : '<p class="subtitle">Keine Schüler in der Datenbank gefunden.</p>'}
        </div>
        ${schueler.length > 0 ? '<div class="schueler-liste">' + cardsHtml + '</div>' : ''}
      </div>

      <script>
      (function() {
        // ===== Timer State pro Schüler =====
        var timers = {};
        var TOTAL = 1200;

        function getT(sid) {
          if (!timers[sid]) timers[sid] = { state: 'idle', remaining: TOTAL, iid: null };
          return timers[sid];
        }

        function fmt(sec) {
          var m = Math.floor(sec / 60);
          var s = Math.floor(sec % 60);
          return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
        }

        // Gelb → Grün interpolation
        function progColor(p) {
          var r = Math.round(240 + (76 - 240) * p);
          var g = Math.round(194 + (175 - 194) * p);
          var b = Math.round(48 + (80 - 48) * p);
          return 'rgba(' + r + ',' + g + ',' + b + ',0.35)';
        }

        function btnHtml(sid, state) {
          var h = '';
          if (state === 'idle') {
            h = '<button class="timer-btn btn-start" onclick="window._tm.start(\\'' + sid + '\\',event)">Vorbereitung starten</button>';
          } else if (state === 'running') {
            h = '<button class="timer-btn btn-pause" onclick="window._tm.pause(\\'' + sid + '\\',event)">Pause</button>' +
                '<button class="timer-btn btn-reset" onclick="window._tm.reset(\\'' + sid + '\\',event)">Reset</button>';
          } else if (state === 'paused') {
            h = '<button class="timer-btn btn-resume" onclick="window._tm.resume(\\'' + sid + '\\',event)">Fortsetzen</button>' +
                '<button class="timer-btn btn-reset" onclick="window._tm.reset(\\'' + sid + '\\',event)">Reset</button>';
          } else if (state === 'finished') {
            h = '<button class="timer-btn btn-reset" onclick="window._tm.reset(\\'' + sid + '\\',event)">Reset</button>';
          }
          h += '<button class="timer-btn btn-close" onclick="window._tm.close(\\'' + sid + '\\',event)">Schließen</button>';
          return h;
        }

        function updateUI(sid) {
          var t = getT(sid);
          var timeEl = document.getElementById('time-' + sid);
          var labelEl = document.getElementById('label-' + sid);
          var btnsEl = document.getElementById('buttons-' + sid);
          var progEl = document.getElementById('progress-' + sid);
          var badgeEl = document.getElementById('badge-' + sid);

          if (!timeEl) return;

          timeEl.textContent = fmt(t.remaining);

          var progress = 1 - (t.remaining / TOTAL);
          progEl.style.width = (progress * 100) + '%';
          progEl.style.background = progColor(progress);

          if (t.state === 'running') {
            badgeEl.className = 'timer-badge active';
            badgeEl.textContent = fmt(t.remaining) + ' ⏱';
            labelEl.textContent = 'Vorbereitung läuft...';
          } else if (t.state === 'paused') {
            badgeEl.className = 'timer-badge active paused';
            badgeEl.textContent = fmt(t.remaining) + ' ⏸';
            labelEl.textContent = 'Pausiert';
          } else if (t.state === 'finished') {
            badgeEl.className = 'timer-badge active finished';
            badgeEl.textContent = 'Fertig ✓';
            labelEl.textContent = 'Vorbereitung abgeschlossen!';
            progEl.style.width = '100%';
            progEl.style.background = 'rgba(76,175,80,0.35)';
          } else {
            badgeEl.className = 'timer-badge';
            badgeEl.textContent = '';
            labelEl.textContent = 'Vorbereitung';
            progEl.style.width = '0%';
          }

          btnsEl.innerHTML = btnHtml(sid, t.state);
        }

        function tick(sid) {
          var t = getT(sid);
          if (t.state !== 'running') return;
          t.remaining -= 1;
          if (t.remaining <= 0) {
            t.remaining = 0;
            t.state = 'finished';
            clearInterval(t.iid);
            t.iid = null;
          }
          updateUI(sid);
        }

        function apiCall(sid, action, body) {
          var opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
          if (body) opts.body = JSON.stringify(body);
          fetch('/api/timer/' + sid + '/' + action, opts).catch(function(e) { console.warn('Timer sync error:', e); });
        }

        // ===== Public API =====
        window._tm = {
          start: function(sid, ev) {
            ev.stopPropagation();
            var t = getT(sid);
            if (t.iid) clearInterval(t.iid);
            t.state = 'running';
            t.remaining = TOTAL;
            t.iid = setInterval(function() { tick(sid); }, 1000);
            updateUI(sid);
            apiCall(sid, 'start');
          },
          pause: function(sid, ev) {
            ev.stopPropagation();
            var t = getT(sid);
            t.state = 'paused';
            if (t.iid) { clearInterval(t.iid); t.iid = null; }
            updateUI(sid);
            apiCall(sid, 'pause', { remaining_seconds: t.remaining });
          },
          resume: function(sid, ev) {
            ev.stopPropagation();
            var t = getT(sid);
            t.state = 'running';
            if (t.iid) clearInterval(t.iid);
            t.iid = setInterval(function() { tick(sid); }, 1000);
            updateUI(sid);
            apiCall(sid, 'resume');
          },
          reset: function(sid, ev) {
            ev.stopPropagation();
            var t = getT(sid);
            if (t.iid) { clearInterval(t.iid); t.iid = null; }
            t.state = 'idle';
            t.remaining = TOTAL;
            updateUI(sid);
            apiCall(sid, 'reset');
          },
          close: function(sid, ev) {
            ev.stopPropagation();
            document.getElementById('card-' + sid).classList.remove('expanded');
          }
        };

        // ===== Toggle Card =====
        window.toggleCard = function(sid, ev) {
          if (ev.target.closest('.timer-btn')) return;
          var card = document.getElementById('card-' + sid);
          card.classList.toggle('expanded');
        };

        // ===== Beim Laden: gespeicherte Timer vom Server holen =====
        fetch('/api/timers/${zweig}')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            for (var sid in data) {
              if (!data.hasOwnProperty(sid)) continue;
              var info = data[sid];
              var t = getT(sid);
              t.remaining = Math.max(0, info.remaining_seconds);
              t.state = info.state;
              if (t.state === 'finished') t.remaining = 0;
              if (t.state === 'running' && t.remaining > 0) {
                t.iid = setInterval((function(id) { return function() { tick(id); }; })(sid), 1000);
              }
              updateUI(sid);
            }
          })
          .catch(function(e) { console.warn('Could not load timer state:', e); });
      })();
      </script>
    </body>
    </html>
  `);
    } catch (err) {
        console.error('Fehler beim Laden der Schüler:', err);
        res.status(500).send('Fehler beim Laden der Daten');
    }
});

// ==================== HTTPS Server ====================

const httpsOptions = {
    key: fs.readFileSync('./cert/key.pem'),
    cert: fs.readFileSync('./cert/cert.pem'),
};

https.createServer(httpsOptions, app).listen(process.env.PORT || port, () => {
    console.log(`HTTPS-Server läuft auf https://localhost:${process.env.PORT || port}`);
});

process.on('SIGINT', () => {
    db.close((err) => {
        if (err) console.error('Fehler beim Schließen der Datenbank:', err.message);
        else console.log('Datenbankverbindung geschlossen');
        process.exit(0);
    });
});
