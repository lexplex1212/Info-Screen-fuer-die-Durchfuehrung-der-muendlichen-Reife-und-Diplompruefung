const express = require('express');
const app = express();
const port = 3000;

const session = require('express-session');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
require('dotenv').config({override: true});

// ===== TIMER-DAUER HIER ÄNDERN (in Sekunden) =====
const VORBEREITUNGS_TIMER = 1200; // 20 Min
const PRUEFUNGS_TIMER = 720;      // 12 Min
// ================================================

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'termineordner', 'termine.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Fehler beim Öffnen der DB:', err.message);
    } else {
        console.log('Verbindung zur Datenbank termine.db erfolgreich hergestellt');

        // timer_status: Timer-Logik + Ergebnis-Cache für Live-Anzeige
        db.run(`CREATE TABLE IF NOT EXISTS timer_status (
                                                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                            schueler_id TEXT UNIQUE NOT NULL,
                                                            started_at INTEGER,
                                                            paused_at INTEGER,
                                                            remaining_seconds REAL NOT NULL DEFAULT ${VORBEREITUNGS_TIMER},
                                                            state TEXT NOT NULL DEFAULT 'idle',
                                                            exam_started_at INTEGER,
                                                            exam_remaining REAL DEFAULT ${PRUEFUNGS_TIMER},
                                                            exam_state TEXT DEFAULT 'idle',
                                                            note INTEGER,
                                                            themenpool INTEGER,
                                                            kommentar TEXT,
                                                            tatsaechlich_gestartet TEXT,
                                                            pruefungsdauer TEXT
                )`, (err) => {
            if (err) console.error('timer_status:', err.message);
            // Spalten nachrüsten falls Tabelle schon existiert
            const newCols = [
                ['note', 'INTEGER'],
                ['themenpool', 'INTEGER'],
                ['kommentar', 'TEXT'],
                ['tatsaechlich_gestartet', 'TEXT'],
                ['pruefungsdauer', 'TEXT']
            ];
            let done = 0;
            newCols.forEach(([col, type]) => {
                db.run(`ALTER TABLE timer_status ADD COLUMN ${col} ${type}`, (err) => {
                    if (err && !err.message.includes('duplicate column'))
                        console.error('Spalte ' + col + ':', err.message);
                    done++;
                    if (done === newCols.length) setupAuswertungTabelle();
                });
            });
        });
    }
});

function setupAuswertungTabelle() {
    // ===== Pruefer_Auswertung: Saubere Export-Tabelle =====
    // KEIN schueler_id, KEIN zeit_differenz, KEIN abgeschlossen_am
    db.run(`CREATE TABLE IF NOT EXISTS Pruefer_Auswertung (
                                                              id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                              vorname TEXT,
                                                              nachname TEXT,
                                                              klasse TEXT,
                                                              fach TEXT,
                                                              pruefer TEXT,
                                                              beisitz TEXT,
                                                              datum TEXT,
                                                              note INTEGER NOT NULL,
                                                              themenpool INTEGER NOT NULL,
                                                              kommentar TEXT,
                                                              geplant_start TEXT,
                                                              tatsaechlich_gestartet TEXT,
                                                              pruefungsdauer TEXT,
                                                              UNIQUE(vorname, nachname, klasse)
        )`, (err) => {
        if (err && !err.message.includes('already exists'))
            console.error('Pruefer_Auswertung:', err.message);
        // Spalten nachrüsten falls Tabelle alt
        const newCols = [
            ['geplant_start', 'TEXT'],
            ['tatsaechlich_gestartet', 'TEXT'],
            ['pruefungsdauer', 'TEXT']
        ];
        let done = 0;
        newCols.forEach(([col, type]) => {
            db.run(`ALTER TABLE Pruefer_Auswertung ADD COLUMN ${col} ${type}`, (err) => {
                if (err && !err.message.includes('duplicate column'))
                    console.error('AW Spalte ' + col + ':', err.message);
                done++;
                if (done === newCols.length) {
                    console.log('Pruefer_Auswertung Tabelle bereit');
                    initAlleTimer();
                }
            });
        });
    });
}

const klassen = {
    elektronik: ['5AHEL', '5BHEL', '5CHEL'],
    elektrotechnik: ['5AHET', '5BHET', '5CHET'],
    maschinenbau: ['5AHMBS', '5BHMBZ', '5VHMBS'],
    wirtschaft: ['5AHWIE', '5BHWIE', '5DHWIE']
};
const zweigFarben = { elektronik: '#2d5016', elektrotechnik: '#e60505', maschinenbau: '#4f56d0', wirtschaft: '#ffeb3b' };
const zweigNamen = { elektronik: 'Elektronik', elektrotechnik: 'Elektrotechnik', maschinenbau: 'Maschinenbau', wirtschaft: 'Wirtschaft' };
const zweigZuordnung = {
    '5AHEL': 'elektronik', '5BHEL': 'elektronik', '5CHEL': 'elektronik',
    '5AHET': 'elektrotechnik', '5BHET': 'elektrotechnik', '5CHET': 'elektrotechnik',
    '5AHMBS': 'maschinenbau', '5BHMBZ': 'maschinenbau', '5VHMBS': 'maschinenbau',
    '5AHWIE': 'wirtschaft', '5BHWIE': 'wirtschaft', '5DHWIE': 'wirtschaft'
};

function initAlleTimer() {
    const alleKlassen = Object.values(klassen).flat();
    const placeholders = alleKlassen.map(() => '?').join(',');

    db.all(`SELECT rowid, klasse FROM termine WHERE klasse IN (${placeholders})`, alleKlassen, (err, rows) => {
        if (err) { console.error('Fehler beim Timer-Init:', err.message); return; }
        if (!rows || rows.length === 0) { console.log('Keine Schüler gefunden.'); return; }

        let neu = 0;
        const stmt = db.prepare(`INSERT OR IGNORE INTO timer_status 
            (schueler_id, remaining_seconds, state, exam_remaining, exam_state) 
            VALUES (?, ${VORBEREITUNGS_TIMER}, 'idle', ${PRUEFUNGS_TIMER}, 'idle')`);

        rows.forEach(row => {
            const zweig = zweigZuordnung[row.klasse];
            if (!zweig) return;
            stmt.run([zweig + '_' + row.rowid], function(err) {
                if (!err && this.changes > 0) neu++;
            });
        });

        stmt.finalize(() => {
            console.log('Timer-Init: ' + rows.length + ' Schüler, ' + neu + ' neue Einträge.');
        });
    });
}

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

function getAlleSchueler() {
    return new Promise((resolve) => {
        const alleKlassen = Object.values(klassen).flat();
        const ph = alleKlassen.map(() => '?').join(',');
        db.all(`SELECT rowid, * FROM termine WHERE klasse IN (${ph}) ORDER BY klasse, nachname, vorname`, alleKlassen, (err, rows) => {
            if (err) return resolve([]);
            resolve(rows);
        });
    });
}

// Schüler-Info aus termine anhand schueler_id (für Reset-Löschung)
function getSchuelerInfoFromSid(sid) {
    return new Promise((resolve) => {
        const parts = sid.split('_');
        const rowid = parseInt(parts[parts.length - 1]);
        if (isNaN(rowid)) return resolve(null);
        db.get('SELECT rowid, * FROM termine WHERE rowid = ?', [rowid], (err, row) => {
            resolve(err ? null : row);
        });
    });
}

// ==================== TIMER API ====================

app.get('/api/timer/:id', requireAuth, (req, res) => {
    const id = req.params.id;
    db.get('SELECT * FROM timer_status WHERE schueler_id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json({ state: 'idle', remaining_seconds: VORBEREITUNGS_TIMER, exam_state: 'idle', exam_remaining: PRUEFUNGS_TIMER });
        const now = Date.now();
        const result = {
            state: row.state, remaining_seconds: row.remaining_seconds,
            exam_state: row.exam_state || 'idle', exam_remaining: row.exam_remaining || PRUEFUNGS_TIMER,
            note: row.note, themenpool: row.themenpool, kommentar: row.kommentar,
            tatsaechlich_gestartet: row.tatsaechlich_gestartet, pruefungsdauer: row.pruefungsdauer
        };
        if (row.state === 'running' && row.started_at) {
            const elapsed = (now - row.started_at) / 1000;
            result.remaining_seconds = Math.max(0, row.remaining_seconds - elapsed);
            if (result.remaining_seconds <= 0) result.state = 'prep_done';
        }
        if (row.exam_state === 'running' && row.exam_started_at) {
            const elapsed = (now - row.exam_started_at) / 1000;
            result.exam_remaining = row.exam_remaining - elapsed;
        }
        res.json(result);
    });
});

app.post('/api/timer/:id/start', requireAuth, (req, res) => {
    const id = req.params.id; const now = Date.now();
    db.run(`INSERT INTO timer_status (schueler_id, started_at, remaining_seconds, state) VALUES (?, ?, ${VORBEREITUNGS_TIMER}, 'running')
                ON CONFLICT(schueler_id) DO UPDATE SET started_at=?, remaining_seconds=${VORBEREITUNGS_TIMER}, state='running', paused_at=NULL`,
        [id, now, now], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
});

app.post('/api/timer/:id/pause', requireAuth, (req, res) => {
    const id = req.params.id; const { remaining_seconds } = req.body;
    db.run(`UPDATE timer_status SET state='paused', paused_at=?, remaining_seconds=?, started_at=NULL WHERE schueler_id=?`,
        [Date.now(), remaining_seconds, id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
});

app.post('/api/timer/:id/resume', requireAuth, (req, res) => {
    const id = req.params.id; const now = Date.now();
    db.run(`UPDATE timer_status SET state='running', started_at=?, paused_at=NULL WHERE schueler_id=?`, [now, id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
    });
});

app.post('/api/timer/:id/reset', requireAuth, async (req, res) => {
    const id = req.params.id;
    const info = await getSchuelerInfoFromSid(id);
    db.run(`UPDATE timer_status SET state='idle', started_at=NULL, paused_at=NULL, remaining_seconds=${VORBEREITUNGS_TIMER},
                                    exam_state='idle', exam_started_at=NULL, exam_remaining=${PRUEFUNGS_TIMER},
                                    note=NULL, themenpool=NULL, kommentar=NULL, tatsaechlich_gestartet=NULL, pruefungsdauer=NULL WHERE schueler_id=?`,
        [id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            if (info) {
                db.run('DELETE FROM Pruefer_Auswertung WHERE vorname=? AND nachname=? AND klasse=?',
                    [info.vorname || '', info.nachname || '', info.klasse || ''], () => {});
            }
            res.json({ ok: true });
        });
});

app.post('/api/timer/:id/prep_done', requireAuth, (req, res) => {
    const id = req.params.id;
    db.run(`INSERT INTO timer_status (schueler_id, state, remaining_seconds) VALUES (?, 'prep_done', 0)
                ON CONFLICT(schueler_id) DO UPDATE SET state='prep_done', remaining_seconds=0, started_at=NULL, paused_at=NULL`,
        [id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
});

app.post('/api/timer/:id/exam_start', requireAuth, (req, res) => {
    const id = req.params.id; const now = Date.now();
    const d = new Date(now);
    const uhrzeitStr = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    db.run(`UPDATE timer_status SET exam_state='running', exam_started_at=?, exam_remaining=${PRUEFUNGS_TIMER}, tatsaechlich_gestartet=? WHERE schueler_id=?`,
        [now, uhrzeitStr, id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true, tatsaechlich_gestartet: uhrzeitStr });
        });
});

app.post('/api/timer/:id/exam_pause', requireAuth, (req, res) => {
    const id = req.params.id; const { exam_remaining } = req.body;
    db.run(`UPDATE timer_status SET exam_state='paused', exam_started_at=NULL, exam_remaining=? WHERE schueler_id=?`,
        [exam_remaining, id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
});

app.post('/api/timer/:id/exam_resume', requireAuth, (req, res) => {
    const id = req.params.id; const now = Date.now();
    db.run(`UPDATE timer_status SET exam_state='running', exam_started_at=? WHERE schueler_id=?`, [now, id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
    });
});

// ===== EXAM FINISH: In timer_status + Pruefer_Auswertung speichern =====
app.post('/api/timer/:id/exam_finish', requireAuth, (req, res) => {
    const id = req.params.id;
    const { note, themenpool, kommentar, pruefungsdauer,
        vorname, nachname, klasse, fach, pruefer, beisitz, datum, geplant_start, tatsaechlich_gestartet } = req.body;
    if (!note || !themenpool) return res.status(400).json({ error: 'Note und Themenpool sind Pflicht' });

    db.run(`UPDATE timer_status SET exam_state='done', note=?, themenpool=?, kommentar=?, pruefungsdauer=? WHERE schueler_id=?`,
        [note, themenpool, kommentar || '', pruefungsdauer || '', id], (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run(`INSERT INTO Pruefer_Auswertung
                    (vorname, nachname, klasse, fach, pruefer, beisitz, datum, note, themenpool, kommentar, geplant_start, tatsaechlich_gestartet, pruefungsdauer)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(vorname, nachname, klasse) DO UPDATE SET
                        fach=excluded.fach, pruefer=excluded.pruefer, beisitz=excluded.beisitz, datum=excluded.datum,
                                                                      note=excluded.note, themenpool=excluded.themenpool, kommentar=excluded.kommentar,
                                                                      geplant_start=excluded.geplant_start, tatsaechlich_gestartet=excluded.tatsaechlich_gestartet, pruefungsdauer=excluded.pruefungsdauer`,
                [vorname || '', nachname || '', klasse || '', fach || '', pruefer || '', beisitz || '', datum || '',
                    note, themenpool, kommentar || '', geplant_start || '', tatsaechlich_gestartet || '', pruefungsdauer || ''],
                (err2) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    res.json({ ok: true });
                });
        });
});

// Alle Timer laden
app.get('/api/timers/all', requireAuth, (req, res) => {
    db.all('SELECT * FROM timer_status', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const timers = {}; const now = Date.now();
        (rows || []).forEach(row => {
            const t = {
                state: row.state, remaining_seconds: row.remaining_seconds,
                exam_state: row.exam_state || 'idle', exam_remaining: row.exam_remaining || PRUEFUNGS_TIMER,
                note: row.note, themenpool: row.themenpool, kommentar: row.kommentar,
                tatsaechlich_gestartet: row.tatsaechlich_gestartet, pruefungsdauer: row.pruefungsdauer
            };
            if (row.state === 'running' && row.started_at) {
                const el = (now - row.started_at) / 1000;
                t.remaining_seconds = Math.max(0, row.remaining_seconds - el);
                if (t.remaining_seconds <= 0) t.state = 'prep_done';
            }
            if (row.exam_state === 'running' && row.exam_started_at) {
                const el = (now - row.exam_started_at) / 1000;
                t.exam_remaining = row.exam_remaining - el;
            }
            timers[row.schueler_id] = t;
        });
        res.json(timers);
    });
});

// Auswertungs-Export
app.get('/api/auswertung', requireAuth, (req, res) => {
    db.all('SELECT * FROM Pruefer_Auswertung ORDER BY klasse, nachname, vorname', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
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

app.get('/', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/home');
    res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>HTL - Login</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#07175e;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}.container{background:#fff;border-radius:20px;padding:60px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:500px;width:100%;text-align:center}h1{color:#333;margin-bottom:20px;font-size:2.5em}p{color:#666;margin-bottom:40px;font-size:1.2em}.login-button{display:inline-block;padding:15px 40px;background:#0078d4;color:#fff;text-decoration:none;border-radius:8px;font-size:1.2em;font-weight:700;transition:all .3s;box-shadow:0 5px 15px rgba(0,0,0,.2)}.login-button:hover{background:#005a9e;transform:translateY(-2px)}</style></head>
    <body><div class="container"><h1>Willkommen</h1><p>Bitte loggen Sie sich ein</p><a href="/microsoft-login" class="login-button">Mit Microsoft einloggen</a></div></body></html>`);
});

app.get('/microsoft-login', (req, res) => {
    res.redirect(`https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_mode=query&scope=openid%20email%20profile`);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('<h1>Login abgebrochen</h1><a href="/">Zurück</a>');
    try {
        const tr = await axios.post('https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
            new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.REDIRECT_URI }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const idToken = tr.data.id_token;
        if (!idToken) return res.status(500).send('Kein id_token.');
        const payload = JSON.parse(base64UrlDecode(idToken.split('.')[1]));
        const email = (payload.preferred_username || payload.upn || payload.email || '').toLowerCase();
        if (!email) return res.status(403).send('Keine Email.');
        if (!email.endsWith('@ms.bulme.at')) return res.status(403).send('<h1>Zugriff verweigert</h1><p>Nur @ms.bulme.at</p><a href="/">Zurück</a>');
        req.session.user = { email };
        return res.redirect('/home');
    } catch (err) {
        console.error(err.response?.data || err.message);
        return res.status(500).send('<h1>Fehler beim Login</h1><a href="/">Zurück</a>');
    }
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

// ==================== HAUPTSEITE: ALLE SCHÜLER DIREKT ====================

app.get('/home', requireAuth, async (req, res) => {
    try {
        const schueler = await getAlleSchueler();

        const cardsHtml = schueler.map((s, i) => {
            const zweig = zweigZuordnung[s.klasse] || 'elektronik';
            const sid = zweig + '_' + (s.rowid || i);
            const farbe = zweigFarben[zweig] || '#666';
            const tf = (zweig === 'elektrotechnik' || zweig === 'wirtschaft') ? '#333' : '#fff';
            return '<div class="schueler-item" id="card-' + sid + '" data-sid="' + sid + '" style="border-left-color:' + farbe + '">'
                + '<div class="timer-progress-bg" id="progress-' + sid + '"></div>'
                + '<div class="card-content">'
                +   '<div class="schueler-header">'
                +     '<div class="schueler-name-container">'
                +       '<span class="schueler-name">' + (s.vorname || '') + ' ' + (s.nachname || '') + '</span>'
                +       (s.klasse ? '<span class="klassen-badge" style="background:' + farbe + ';color:' + tf + '">' + s.klasse + '</span>' : '')
                +       '<span class="timer-badge" id="badge-' + sid + '"></span>'
                +     '</div>'
                +     '<div class="schueler-meta">'
                +       (s.fach ? '<span class="meta-tag"><b>Fach:</b> ' + s.fach + '</span>' : '')
                +       (s.pruefer ? '<span class="meta-tag"><b>Prüfer:</b> ' + s.pruefer + '</span>' : '')
                +       (s.beisitz ? '<span class="meta-tag"><b>Beisitz:</b> ' + s.beisitz + '</span>' : '')
                +       (s.exam_start ? '<span class="meta-tag pruefung"><b>Prüfung:</b> ' + s.exam_start + (s.exam_end ? ' - ' + s.exam_end : '') + '</span>' : '')
                +       (s.datum ? '<span class="meta-tag datum">' + s.datum + '</span>' : '')
                +     '</div>'
                +   '</div>'
                +   '<div class="expand-hint" id="hint-' + sid + '">▼</div>'
                +   '<div class="expanded-section" id="exp-' + sid + '">'
                +     '<div class="expanded-content" id="expcontent-' + sid + '"></div>'
                +   '</div>'
                + '</div></div>';
        }).join('');

        res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HTL - Matura Prüfungen</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Arial,sans-serif;background:#07175e;min-height:100vh;padding:20px}
.top-bar{display:flex;justify-content:space-between;align-items:center;max-width:900px;margin:0 auto 15px auto;padding:0 5px}
.top-bar h1{color:#fff;font-size:1.4em;font-weight:700;text-shadow:0 0 20px rgba(100,180,255,.4)}
.logout-btn{padding:8px 18px;background:rgba(255,255,255,.1);color:rgba(255,255,255,.8);text-decoration:none;border-radius:6px;font-size:.85em;transition:all .3s;border:1px solid rgba(255,255,255,.15)}
.logout-btn:hover{background:rgba(255,255,255,.2);border-color:rgba(255,255,255,.3);color:#fff}

/* Logo */
.logo-container{position:fixed;top:30px;left:30px;z-index:400;pointer-events:none}
.logo-glow{width:90px;height:90px;border-radius:16px;overflow:hidden;background:rgba(255,255,255,.06);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1);box-shadow:0 0 30px rgba(80,140,255,.15),0 0 60px rgba(80,140,255,.05),inset 0 0 20px rgba(255,255,255,.03);display:flex;align-items:center;justify-content:center;transition:all .4s}
.logo-glow img{width:68px;height:68px;object-fit:contain;filter:brightness(1.1) drop-shadow(0 0 8px rgba(150,200,255,.3));opacity:.85;transition:all .4s}
.logo-ring{position:absolute;top:-4px;left:-4px;right:-4px;bottom:-4px;border-radius:20px;border:1px solid transparent;background:linear-gradient(135deg,rgba(100,180,255,.2),transparent,rgba(100,180,255,.1)) border-box;-webkit-mask:linear-gradient(#fff 0 0) padding-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:ring-rotate 8s linear infinite}
@keyframes ring-rotate{0%{background:linear-gradient(0deg,rgba(100,180,255,.3),transparent 40%,rgba(100,180,255,.15)) border-box}25%{background:linear-gradient(90deg,rgba(100,180,255,.3),transparent 40%,rgba(100,180,255,.15)) border-box}50%{background:linear-gradient(180deg,rgba(100,180,255,.3),transparent 40%,rgba(100,180,255,.15)) border-box}75%{background:linear-gradient(270deg,rgba(100,180,255,.3),transparent 40%,rgba(100,180,255,.15)) border-box}100%{background:linear-gradient(360deg,rgba(100,180,255,.3),transparent 40%,rgba(100,180,255,.15)) border-box}}
.logo-pulse{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:100px;height:100px;border-radius:20px;background:radial-gradient(circle,rgba(80,140,255,.1) 0%,transparent 70%);animation:pulse-glow 4s ease-in-out infinite}
@keyframes pulse-glow{0%,100%{opacity:.3;transform:translate(-50%,-50%) scale(1)}50%{opacity:.7;transform:translate(-50%,-50%) scale(1.15)}}
.schueler-liste{max-width:900px;margin:0 auto}

.schueler-item{position:relative;margin:6px 0;border-radius:8px;border-left:4px solid #666;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1);cursor:pointer;overflow:hidden;transition:box-shadow .2s,transform .15s}
.schueler-item:hover{transform:translateX(3px);box-shadow:0 2px 8px rgba(0,0,0,.15)}
.schueler-item.expanded{transform:none;box-shadow:0 4px 16px rgba(0,0,0,.2)}

.timer-progress-bg{position:absolute;top:0;left:0;height:100%;width:0%;z-index:0;pointer-events:none;transition:width .8s linear}
.card-content{position:relative;z-index:1;padding:10px 14px}

.schueler-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.schueler-name-container{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.schueler-name{font-weight:700;font-size:1em;color:#222}
.klassen-badge{padding:2px 8px;border-radius:10px;font-size:.7em;font-weight:700}
.schueler-meta{display:flex;gap:6px;flex-wrap:wrap}
.meta-tag{background:#f0f0f0;color:#555;padding:2px 8px;border-radius:10px;font-size:.72em}
.meta-tag.datum{background:#e3f2fd;color:#1565c0;font-weight:600}
.meta-tag.pruefung{background:#f3e5f5;color:#7b1fa2;font-weight:600}

.timer-badge{display:none;padding:2px 10px;border-radius:10px;font-size:.75em;font-weight:700}
.timer-badge.visible{display:inline-block}
.timer-badge.st-prep{background:#ffe0cc;color:#c0392b}
.timer-badge.st-paused{background:#ff9800;color:#fff}
.timer-badge.st-prep-done{background:#ff9800;color:#fff}
.timer-badge.st-exam{background:#fff3cd;color:#856404}
.timer-badge.st-done{background:#4caf50;color:#fff}

.expand-hint{text-align:right;font-size:.7em;color:#ccc;margin-top:2px}
.schueler-item.expanded .expand-hint{opacity:0;height:0;margin:0;overflow:hidden}
.expanded-section{max-height:0;overflow:hidden;transition:max-height .35s ease}
.schueler-item.expanded .expanded-section{max-height:600px}
.expanded-content{border-top:1px solid rgba(0,0,0,.08);padding-top:12px;margin-top:8px}

.timer-display{text-align:center;margin-bottom:10px}
.timer-time{font-size:2.2em;font-weight:700;color:#222;font-variant-numeric:tabular-nums;letter-spacing:2px}
.timer-label{font-size:.85em;color:#555;margin-top:2px}
.timer-over{color:#c0392b;font-weight:700}
.timer-buttons{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:8px}
.timer-btn{padding:8px 20px;border:none;border-radius:8px;font-size:.9em;font-weight:700;cursor:pointer;transition:all .15s;box-shadow:0 2px 5px rgba(0,0,0,.12)}
.timer-btn:hover{transform:translateY(-1px);box-shadow:0 3px 10px rgba(0,0,0,.2)}
.timer-btn:active{transform:translateY(0)}
.btn-start{background:#f0c230;color:#333}
.btn-pause{background:#ff9800;color:#fff}
.btn-resume{background:#4caf50;color:#fff}
.btn-reset{background:#f44336;color:#fff}
.btn-skip{background:#9c27b0;color:#fff}
.btn-exam{background:#2196f3;color:#fff}
.btn-finish{background:#4caf50;color:#fff}
.btn-finish:disabled{background:#ccc;color:#888;cursor:not-allowed;transform:none;box-shadow:none}

.exam-form{margin-top:12px;padding:12px;background:rgba(0,0,0,.03);border-radius:8px;border:1px solid #e0e0e0}
.exam-form h3{margin-bottom:8px;color:#333;text-align:center;font-size:1em}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.form-field{display:flex;flex-direction:column;gap:2px}
.form-field label{font-weight:600;font-size:.8em;color:#555}
.form-field select,.form-field textarea{padding:6px 8px;border:1px solid #ddd;border-radius:6px;font-size:.9em}
.form-field textarea{resize:vertical;min-height:40px}
.form-field.full{grid-column:1/-1}
.pflicht{color:#c0392b}

.done-card{text-align:center;padding:12px}
.done-card h3{color:#4caf50;margin-bottom:6px;font-size:1.1em}
.done-info{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;text-align:left}
.done-info div{padding:5px 8px;background:rgba(0,0,0,.03);border-radius:5px;font-size:.9em}
.dl{font-weight:700;color:#222}

.confirm-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:1000;justify-content:center;align-items:center}
.confirm-overlay.active{display:flex}
.confirm-box{background:#fff;border-radius:12px;padding:24px 30px;max-width:380px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.3)}
.confirm-box h3{margin-bottom:10px;color:#333;font-size:1.1em}
.confirm-box p{margin-bottom:16px;color:#666;font-size:.9em}
.confirm-box .cbtns{display:flex;gap:8px;justify-content:center}
.confirm-box .cbtns button{padding:8px 20px;border:none;border-radius:6px;font-size:.9em;font-weight:700;cursor:pointer}
.cbtn-yes{background:#f44336;color:#fff}
.cbtn-no{background:#9e9e9e;color:#fff}

.next-exam-widget{position:fixed;top:15px;right:15px;width:280px;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);z-index:500;overflow:hidden;user-select:none}
.new-header{padding:8px 14px;font-weight:700;font-size:.9em;color:#fff;background:#333;display:flex;justify-content:space-between;align-items:center;cursor:grab}
.new-header:active{cursor:grabbing}
.new-header-text{pointer-events:none}
.widget-toggle{background:none;border:2px solid rgba(255,255,255,.5);color:#fff;width:26px;height:26px;border-radius:50%;font-size:1em;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1}
.widget-toggle:hover{background:rgba(255,255,255,.2);border-color:#fff}
.widget-body{transition:max-height .3s ease,opacity .3s ease;max-height:350px;opacity:1;overflow:hidden}
.widget-body.collapsed{max-height:0;opacity:0}
#nextExamContent{padding:12px}
.new-loading{text-align:center;color:#999;padding:8px;font-size:.9em}
.nex-countdown{font-size:1.8em;font-weight:700;text-align:center;margin:6px 0;font-variant-numeric:tabular-nums;letter-spacing:1px}
.nex-countdown.soon{color:#e74c3c}
.nex-countdown.normal{color:#333}
.nex-name{font-size:1em;font-weight:700;color:#222;text-align:center;margin-bottom:2px}
.nex-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.7em;font-weight:700}
.nex-details{text-align:center;color:#555;font-size:.8em;margin-top:4px;line-height:1.6}
.nex-done{text-align:center;color:#4caf50;font-weight:700;font-size:.95em;padding:12px 0}
.nex-status{text-align:center;margin-top:4px;font-size:.8em;padding:3px 8px;border-radius:6px;display:inline-block}
.nex-status.waiting{background:#fff3cd;color:#856404}
.nex-status.call-student{background:#f8d7da;color:#721c24;animation:pulse-call 1.5s infinite}
.nex-call-msg{text-align:center;margin-top:6px;padding:8px 10px;background:#fff3cd;border-radius:6px;color:#856404;font-size:.8em;line-height:1.3}
@keyframes pulse-call{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.7;transform:scale(1.05)}}

@media(max-width:600px){body{padding:10px}.top-bar h1{font-size:1.1em}.timer-time{font-size:1.8em}.timer-btn{padding:7px 14px;font-size:.85em}.form-grid{grid-template-columns:1fr}.next-exam-widget{position:relative;top:auto!important;right:auto!important;left:auto!important;width:100%;margin:0 auto 12px auto}.logo-container{position:relative;top:auto;left:auto;margin:0 auto 15px auto;display:flex;justify-content:center}}
</style>
</head>
<body>
<!-- BULME Logo -->
<div class="logo-container">
  <div class="logo-pulse"></div>
  <div class="logo-glow">
    <div class="logo-ring"></div>
    <img src="data:image/jpeg;base64,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" alt="BULME">
  </div>
</div>

<div class="top-bar">
  <h1>Matura Prüfungen</h1>
  <a href="/logout" class="logout-btn">Logout</a>
</div>

${schueler.length > 0 ? '<div class="schueler-liste">' + cardsHtml + '</div>' : '<div style="text-align:center;color:#fff;margin-top:60px;font-size:1.3em">Keine Schüler gefunden.</div>'}

<!-- Nächste Prüfung Widget -->
<div class="next-exam-widget" id="nextExamWidget">
  <div class="new-header" id="widgetHeader">
    <span class="new-header-text">Nächste Vorbereitung</span>
    <button class="widget-toggle" id="widgetToggle" title="Einklappen">−</button>
  </div>
  <div class="widget-body" id="widgetBody">
    <div id="nextExamContent"><div class="new-loading">Lade...</div></div>
  </div>
</div>

<!-- Schüler-Daten für JS -->
<script>var SCHUELER_DATA = ${JSON.stringify(schueler.map((s,i) => {
            const zw = zweigZuordnung[s.klasse] || 'elektronik';
            return {
                sid: zw + '_' + (s.rowid || i),
                vorname: s.vorname || '', nachname: s.nachname || '',
                klasse: s.klasse || '', fach: s.fach || '',
                pruefer: s.pruefer || '', beisitz: s.beisitz || '',
                datum: s.datum || '',
                prep_start: s.prep_start || s.rep_start || '',
                exam_start: s.exam_start || '', exam_end: s.exam_end || '',
                zweig: zw
            };
        }))};
var ZWEIG_FARBEN = ${JSON.stringify(zweigFarben)};
</script>

<!-- Confirm Reset -->
<div class="confirm-overlay" id="confirmOverlay">
  <div class="confirm-box">
    <h3>Wirklich zurücksetzen?</h3>
    <p id="confirmText">Alle Daten gehen verloren.</p>
    <div class="cbtns">
      <button class="cbtn-yes" id="confirmYes">Ja, zurücksetzen</button>
      <button class="cbtn-no" id="confirmNo">Abbrechen</button>
    </div>
  </div>
</div>

<script>
(function(){
var PREP = ${VORBEREITUNGS_TIMER};
var EXAM = ${PRUEFUNGS_TIMER};
var T = {};
var lastRenderedState = {};

function g(sid){
  if(!T[sid]) T[sid]={
    state:'idle', rem:PREP, iid:null,
    examState:'idle', examRem:EXAM, eiid:null,
    note:null, themen:null, komm:'',
    examStartedAt:null,
    pruefDauer:null
  };
  return T[sid];
}
function fmt(s){
  var neg=s<0; s=Math.abs(s);
  var m=Math.floor(s/60),sc=Math.floor(s%60);
  return(neg?'+':'')+(m<10?'0':'')+m+':'+(sc<10?'0':'')+sc;
}
function prepColor(p){
  var r=Math.round(231+(255-231)*p),gg=Math.round(76+(152-76)*p),b=Math.round(60+(0-60)*p);
  return 'rgba('+r+','+gg+','+b+',0.35)';
}
function examColor(p){
  var r=Math.round(240+(76-240)*p),gg=Math.round(194+(175-194)*p),b=Math.round(48+(80-48)*p);
  return 'rgba('+r+','+gg+','+b+',0.4)';
}
function findSchueler(sid){
  for(var i=0;i<SCHUELER_DATA.length;i++){if(SCHUELER_DATA[i].sid===sid) return SCHUELER_DATA[i];}
  return null;
}
function nowHHMM(){
  var d=new Date();
  return (d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes();
}
function fmtDauer(sek){
  sek=Math.round(Math.abs(sek));
  var m=Math.floor(sek/60),s=sek%60;
  return (m<10?'0':'')+m+':'+(s<10?'0':'')+s;
}

function tickUpdate(sid){
  var t=g(sid);
  var prog=document.getElementById('progress-'+sid);
  var badge=document.getElementById('badge-'+sid);
  var timeEl=document.querySelector('#expcontent-'+sid+' .timer-time');
  var labEl=document.querySelector('#expcontent-'+sid+' .timer-label');
  if(!prog) return;
  if(t.state==='running'){
    var p=Math.max(0,Math.min(1,1-(t.rem/PREP)));
    prog.style.width=(p*100)+'%';prog.style.backgroundColor=prepColor(p);
    if(badge){badge.className='timer-badge visible st-prep';badge.textContent=fmt(t.rem)+' ⏱';}
    if(timeEl) timeEl.textContent=fmt(t.rem);
  } else if(t.examState==='running'){
    var ep=t.examRem>=0?Math.max(0,Math.min(1,1-(t.examRem/EXAM))):1;
    prog.style.width=(ep*100)+'%';prog.style.backgroundColor=t.examRem<0?'rgba(231,76,60,0.3)':examColor(ep);
    if(badge){badge.className='timer-badge visible st-exam';badge.textContent=(t.examRem<0?'ÜBER ':'')+fmt(t.examRem)+' ⏱';}
    if(timeEl){timeEl.textContent=(t.examRem<0?'+':'')+fmt(t.examRem);timeEl.style.color=t.examRem<0?'#c0392b':'#222';}
    if(labEl){labEl.innerHTML=t.examRem<0?'<span class="timer-over">Überzogen!</span>':'Prüfung läuft...';}
  }
}

function render(sid){
  var t=g(sid);
  var card=document.getElementById('card-'+sid);
  var prog=document.getElementById('progress-'+sid);
  var badge=document.getElementById('badge-'+sid);
  var ec=document.getElementById('expcontent-'+sid);
  if(!card||!ec) return;
  lastRenderedState[sid]=t.state+'|'+t.examState;
  var html='',p;

  if(t.state==='idle'){
    prog.style.width='0%';prog.style.backgroundColor='transparent';badge.className='timer-badge';
    html='<div class="timer-display"><div class="timer-time">'+fmt(PREP)+'</div><div class="timer-label">Vorbereitung</div></div>'
      +'<div class="timer-buttons"><button class="timer-btn btn-start" data-action="start" data-sid="'+sid+'">Vorbereitung starten</button></div>';
  }
  else if(t.state==='running'){
    p=Math.max(0,Math.min(1,1-(t.rem/PREP)));
    prog.style.width=(p*100)+'%';prog.style.backgroundColor=prepColor(p);
    badge.className='timer-badge visible st-prep';badge.textContent=fmt(t.rem)+' ⏱';
    html='<div class="timer-display"><div class="timer-time">'+fmt(t.rem)+'</div><div class="timer-label">Vorbereitung läuft...</div></div>'
      +'<div class="timer-buttons">'
      +'<button class="timer-btn btn-pause" data-action="pause" data-sid="'+sid+'">Pause</button>'
      +'<button class="timer-btn btn-skip" data-action="skip_prep" data-sid="'+sid+'">Überspringen ⏭</button>'
      +'<button class="timer-btn btn-reset" data-action="reset" data-sid="'+sid+'">Reset</button></div>';
  }
  else if(t.state==='paused'){
    p=Math.max(0,Math.min(1,1-(t.rem/PREP)));
    prog.style.width=(p*100)+'%';prog.style.backgroundColor=prepColor(p);
    badge.className='timer-badge visible st-paused';badge.textContent=fmt(t.rem)+' ⏸';
    html='<div class="timer-display"><div class="timer-time">'+fmt(t.rem)+'</div><div class="timer-label">Pausiert</div></div>'
      +'<div class="timer-buttons">'
      +'<button class="timer-btn btn-resume" data-action="resume" data-sid="'+sid+'">Fortsetzen</button>'
      +'<button class="timer-btn btn-skip" data-action="skip_prep" data-sid="'+sid+'">Überspringen ⏭</button>'
      +'<button class="timer-btn btn-reset" data-action="reset" data-sid="'+sid+'">Reset</button></div>';
  }
  else if(t.state==='prep_done'&&t.examState==='idle'){
    prog.style.width='100%';prog.style.backgroundColor='rgba(255,152,0,0.4)';
    badge.className='timer-badge visible st-prep-done';badge.textContent='Vorb. fertig ✓';
    html='<div class="timer-display"><div class="timer-time" style="color:#e67e22">00:00</div><div class="timer-label" style="color:#e67e22;font-weight:700">Vorbereitung fertig ✓</div></div>'
      +'<div class="timer-buttons"><button class="timer-btn btn-exam" data-action="exam_start" data-sid="'+sid+'">Prüfung starten</button></div>';
  }
  else if(t.examState==='running'){
    var ep=t.examRem>=0?Math.max(0,Math.min(1,1-(t.examRem/EXAM))):1;
    prog.style.width=(ep*100)+'%';prog.style.backgroundColor=t.examRem<0?'rgba(231,76,60,0.3)':examColor(ep);
    badge.className='timer-badge visible st-exam';badge.textContent=(t.examRem<0?'ÜBER ':'')+fmt(t.examRem)+' ⏱';
    var ts=t.examRem<0?' style="color:#c0392b"':'';
    html='<div class="timer-display"><div class="timer-time"'+ts+'>'+(t.examRem<0?'+':'')+fmt(t.examRem)+'</div>'
      +'<div class="timer-label">'+(t.examRem<0?'<span class="timer-over">Überzogen!</span>':'Prüfung läuft...')+'</div></div>'
      +'<div class="timer-buttons"><button class="timer-btn btn-pause" data-action="exam_pause" data-sid="'+sid+'">Pause</button></div>'
      +examFormHtml(sid,t);
  }
  else if(t.examState==='paused'){
    var ep2=t.examRem>=0?Math.max(0,Math.min(1,1-(t.examRem/EXAM))):1;
    prog.style.width=(ep2*100)+'%';prog.style.backgroundColor=t.examRem<0?'rgba(231,76,60,0.3)':examColor(ep2);
    badge.className='timer-badge visible st-paused';badge.textContent=fmt(t.examRem)+' ⏸';
    html='<div class="timer-display"><div class="timer-time">'+fmt(t.examRem)+'</div><div class="timer-label">Prüfung pausiert</div></div>'
      +'<div class="timer-buttons"><button class="timer-btn btn-resume" data-action="exam_resume" data-sid="'+sid+'">Fortsetzen</button></div>'
      +examFormHtml(sid,t);
  }
  else if(t.examState==='done'){
    prog.style.width='100%';prog.style.backgroundColor='rgba(76,175,80,0.3)';
    badge.className='timer-badge visible st-done';badge.textContent='Fertig ✓';
    var sInfo=findSchueler(sid)||{};
    html='<div class="done-card"><h3>Abgeschlossen ✓</h3>'
      +'<div class="done-info">'
      +'<div><span class="dl">Note:</span> '+t.note+'</div>'
      +'<div><span class="dl">Themenpool:</span> '+t.themen+'</div>'
      +(sInfo.exam_start?'<div><span class="dl">Geplant:</span> '+sInfo.exam_start+(sInfo.exam_end?' - '+sInfo.exam_end:'')+'</div>':'')
      +(t.examStartedAt?'<div><span class="dl">Tatsächlich:</span> '+t.examStartedAt+' Uhr</div>':'')
      +(t.pruefDauer?'<div><span class="dl">Dauer:</span> '+t.pruefDauer+'</div>':'')
      +(t.komm?'<div style="grid-column:1/-1"><span class="dl">Kommentar:</span> '+t.komm+'</div>':'')
      +'</div>'
      +'</div>';
  }
  ec.innerHTML=html;
}

function examFormHtml(sid,t){
  var noteOpts='<option value="">--</option>';
  for(var i=1;i<=5;i++) noteOpts+='<option value="'+i+'"'+(t.note==i?' selected':'')+'>'+i+'</option>';
  var thOpts='<option value="">--</option>';
  for(var j=1;j<=8;j++) thOpts+='<option value="'+j+'"'+(t.themen==j?' selected':'')+'>'+j+'</option>';
  return '<div class="exam-form"><h3>Ergebnis eintragen</h3>'
    +'<div class="form-grid">'
    +'<div class="form-field"><label>Note<span class="pflicht">*</span></label><select id="note-'+sid+'" data-field="note" data-sid="'+sid+'">'+noteOpts+'</select></div>'
    +'<div class="form-field"><label>Themenpool<span class="pflicht">*</span></label><select id="themen-'+sid+'" data-field="themen" data-sid="'+sid+'">'+thOpts+'</select></div>'
    +'<div class="form-field full"><label>Kommentar</label><textarea id="komm-'+sid+'" data-field="komm" data-sid="'+sid+'" placeholder="Optional...">'+(t.komm||'')+'</textarea></div>'
    +'</div>'
    +'<div class="timer-buttons" style="margin-top:10px"><button class="timer-btn btn-finish" data-action="exam_finish" data-sid="'+sid+'">Abschließen</button></div>'
    +'</div>';
}

function prepTick(sid){
  var t=g(sid);if(t.state!=='running')return;
  t.rem=Math.max(0,t.rem-1);
  if(t.rem<=0){t.state='prep_done';if(t.iid){clearInterval(t.iid);t.iid=null;}api(sid,'prep_done');render(sid);}
  else tickUpdate(sid);
}
function examTick(sid){
  var t=g(sid);if(t.examState!=='running')return;
  t.examRem=t.examRem-1;tickUpdate(sid);
}

function api(sid,action,body){
  var o={method:'POST',headers:{'Content-Type':'application/json'}};
  if(body)o.body=JSON.stringify(body);
  return fetch('/api/timer/'+sid+'/'+action,o).then(function(r){return r.json();}).catch(function(e){console.warn('Sync:',e);return {};});
}

function sortCards(){
  var liste=document.querySelector('.schueler-liste');if(!liste)return;
  var cards=Array.from(liste.querySelectorAll('.schueler-item'));
  cards.sort(function(a,b){
    var sa=g(a.getAttribute('data-sid')),sb=g(b.getAttribute('data-sid'));
    return(sa.examState==='done'?1:0)-(sb.examState==='done'?1:0);
  });
  cards.forEach(function(c){liste.appendChild(c);});
}

var pendingResetSid=null;
var overlay=document.getElementById('confirmOverlay');
document.getElementById('confirmYes').addEventListener('click',function(){
  if(pendingResetSid){
    var t=g(pendingResetSid);
    if(t.iid){clearInterval(t.iid);t.iid=null;}
    if(t.eiid){clearInterval(t.eiid);t.eiid=null;}
    t.state='idle';t.rem=PREP;t.examState='idle';t.examRem=EXAM;
    t.note=null;t.themen=null;t.komm='';t.examStartedAt=null;t.pruefDauer=null;
    render(pendingResetSid);api(pendingResetSid,'reset');sortCards();
  }
  overlay.classList.remove('active');pendingResetSid=null;
});
document.getElementById('confirmNo').addEventListener('click',function(){
  overlay.classList.remove('active');pendingResetSid=null;
});

document.addEventListener('click',function(e){
  var btn=e.target.closest('.timer-btn');
  if(btn){
    e.stopPropagation();e.preventDefault();
    var action=btn.getAttribute('data-action'),sid=btn.getAttribute('data-sid');
    if(!action||!sid)return;
    var t=g(sid);

    if(action==='start'){
      if(t.iid)clearInterval(t.iid);
      t.state='running';t.rem=PREP;
      t.iid=setInterval(function(){prepTick(sid);},1000);
      render(sid);api(sid,'start');
    }
    else if(action==='pause'){
      t.state='paused';if(t.iid){clearInterval(t.iid);t.iid=null;}
      render(sid);api(sid,'pause',{remaining_seconds:t.rem});
    }
    else if(action==='resume'){
      t.state='running';if(t.iid)clearInterval(t.iid);
      t.iid=setInterval(function(){prepTick(sid);},1000);
      render(sid);api(sid,'resume');
    }
    else if(action==='skip_prep'){
      if(t.iid){clearInterval(t.iid);t.iid=null;}
      t.state='prep_done';t.rem=0;render(sid);api(sid,'prep_done');
    }
    else if(action==='reset'){
      var card=document.getElementById('card-'+sid);
      var nameEl=card?card.querySelector('.schueler-name'):null;
      var sname=nameEl?nameEl.textContent:'diesen Schüler';
      document.getElementById('confirmText').textContent='"'+sname.trim()+'" zurücksetzen? Alle Daten gehen verloren.';
      pendingResetSid=sid;overlay.classList.add('active');
    }
    else if(action==='exam_start'){
      t.examState='running';t.examRem=EXAM;
      t.examStartedAt=nowHHMM();
      if(t.eiid)clearInterval(t.eiid);
      t.eiid=setInterval(function(){examTick(sid);},1000);
      var card2=document.getElementById('card-'+sid);
      if(card2)card2.classList.add('expanded');
      render(sid);
      api(sid,'exam_start');
    }
    else if(action==='exam_pause'){
      t.examState='paused';if(t.eiid){clearInterval(t.eiid);t.eiid=null;}
      render(sid);api(sid,'exam_pause',{exam_remaining:t.examRem});
    }
    else if(action==='exam_resume'){
      t.examState='running';if(t.eiid)clearInterval(t.eiid);
      t.eiid=setInterval(function(){examTick(sid);},1000);
      render(sid);api(sid,'exam_resume');
    }
    else if(action==='exam_finish'){
      var noteEl=document.getElementById('note-'+sid);
      var themenEl=document.getElementById('themen-'+sid);
      var kommEl=document.getElementById('komm-'+sid);
      var note=noteEl?noteEl.value:'';
      var themen=themenEl?themenEl.value:'';
      var komm=kommEl?kommEl.value:'';
      if(!note||!themen){alert('Bitte Note und Themenpool auswählen!');return;}
      if(t.eiid){clearInterval(t.eiid);t.eiid=null;}
      t.examState='done';t.note=parseInt(note);t.themen=parseInt(themen);t.komm=komm;
      var dauerSek=EXAM-t.examRem;
      t.pruefDauer=fmtDauer(dauerSek);
      render(sid);
      var info=findSchueler(sid)||{};
      api(sid,'exam_finish',{
        note:t.note, themenpool:t.themen, kommentar:komm,
        pruefungsdauer:t.pruefDauer,
        tatsaechlich_gestartet:t.examStartedAt||'',
        vorname:info.vorname, nachname:info.nachname, klasse:info.klasse,
        fach:info.fach, pruefer:info.pruefer, beisitz:info.beisitz,
        datum:info.datum, geplant_start:info.exam_start||''
      });
      sortCards();
    }
    return;
  }
  if(e.target.closest('.exam-form')){e.stopPropagation();return;}
  var card=e.target.closest('.schueler-item');
  if(card)card.classList.toggle('expanded');
});

document.addEventListener('change',function(e){
  var el=e.target;
  if(el.matches('select[data-field]')){
    var sid=el.getAttribute('data-sid'),field=el.getAttribute('data-field'),t=g(sid);
    if(field==='note')t.note=parseInt(el.value)||null;
    if(field==='themen')t.themen=parseInt(el.value)||null;
  }
});
document.addEventListener('input',function(e){
  var el=e.target;
  if(el.matches('textarea[data-field]')){var sid=el.getAttribute('data-sid');g(sid).komm=el.value;}
});
document.addEventListener('mousedown',function(e){if(e.target.closest('.exam-form'))e.stopPropagation();},true);

document.querySelectorAll('.schueler-item').forEach(function(c){
  var sid=c.getAttribute('data-sid');if(sid)render(sid);
});

fetch('/api/timers/all')
  .then(function(r){return r.json();})
  .then(function(data){
    for(var sid in data){
      if(!data.hasOwnProperty(sid))continue;
      var info=data[sid],t=g(sid);
      t.rem=Math.max(0,info.remaining_seconds);t.state=info.state||'idle';
      t.examState=info.exam_state||'idle';
      t.examRem=info.exam_remaining!==undefined?info.exam_remaining:EXAM;
      t.note=info.note||null;t.themen=info.themenpool||null;
      t.komm=info.kommentar||'';
      t.examStartedAt=info.tatsaechlich_gestartet||null;
      t.pruefDauer=info.pruefungsdauer||null;
      if(t.state==='prep_done')t.rem=0;
      if(t.state==='running'&&t.rem>0){(function(id){t.iid=setInterval(function(){prepTick(id);},1000);})(sid);}
      if(t.examState==='running'){(function(id){t.eiid=setInterval(function(){examTick(id);},1000);})(sid);}
      render(sid);
    }
    sortCards();
  }).catch(function(e){console.warn('Load:',e);});
})();

// ===== NÄCHSTE PRÜFUNG WIDGET =====
(function(){
  var widget=document.getElementById('nextExamWidget');
  var content=document.getElementById('nextExamContent');
  var header=document.getElementById('widgetHeader');
  var body=document.getElementById('widgetBody');
  var toggleBtn=document.getElementById('widgetToggle');
  if(!widget||!content||typeof SCHUELER_DATA==='undefined') return;

  var isCollapsed=false;
  toggleBtn.addEventListener('click',function(e){
    e.stopPropagation();isCollapsed=!isCollapsed;
    body.classList.toggle('collapsed',isCollapsed);
    toggleBtn.textContent=isCollapsed?'+':'−';
  });

  var isDragging=false,dragOffX=0,dragOffY=0;
  header.addEventListener('mousedown',function(e){
    if(e.target===toggleBtn)return;isDragging=true;
    var rect=widget.getBoundingClientRect();
    dragOffX=e.clientX-rect.left;dragOffY=e.clientY-rect.top;
    widget.style.transition='none';e.preventDefault();
  });
  document.addEventListener('mousemove',function(e){
    if(!isDragging)return;
    var x=Math.max(0,Math.min(window.innerWidth-widget.offsetWidth,e.clientX-dragOffX));
    var y=Math.max(0,Math.min(window.innerHeight-widget.offsetHeight,e.clientY-dragOffY));
    widget.style.left=x+'px';widget.style.top=y+'px';widget.style.right='auto';
  });
  document.addEventListener('mouseup',function(){if(isDragging){isDragging=false;widget.style.transition='';}});

  header.addEventListener('touchstart',function(e){
    if(e.target===toggleBtn)return;isDragging=true;
    var touch=e.touches[0],rect=widget.getBoundingClientRect();
    dragOffX=touch.clientX-rect.left;dragOffY=touch.clientY-rect.top;widget.style.transition='none';
  },{passive:true});
  document.addEventListener('touchmove',function(e){
    if(!isDragging)return;var touch=e.touches[0];
    var x=Math.max(0,Math.min(window.innerWidth-widget.offsetWidth,touch.clientX-dragOffX));
    var y=Math.max(0,Math.min(window.innerHeight-widget.offsetHeight,touch.clientY-dragOffY));
    widget.style.left=x+'px';widget.style.top=y+'px';widget.style.right='auto';
  },{passive:true});
  document.addEventListener('touchend',function(){if(isDragging){isDragging=false;widget.style.transition='';}});

  function parseDateTime(datum,zeit){
    if(!datum||!zeit)return null;
    var dm=datum.match(/(\\d{2})\\.(\\d{2})\\.(\\d{4})/);if(!dm)return null;
    var tm=zeit.match(/(\\d{1,2}):(\\d{2})/);if(!tm)return null;
    return new Date(parseInt(dm[3]),parseInt(dm[2])-1,parseInt(dm[1]),parseInt(tm[1]),parseInt(tm[2]),0);
  }
  function fmtCD(ms){
    var neg=ms<0;ms=Math.abs(ms);var sec=Math.floor(ms/1000);
    var h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
    var str='';if(h>0)str+=h+'h ';str+=(m<10?'0':'')+m+':'+(s<10?'0':'')+s;
    return(neg?'-':'')+str;
  }

  function updateWidget(){
    if(isCollapsed)return;
    var now=new Date(),best=null,bestDiff=Infinity;
    SCHUELER_DATA.forEach(function(s){
      var badge=document.getElementById('badge-'+s.sid);if(!badge)return;
      var cl=badge.className||'';
      if(cl.indexOf('st-done')!==-1||cl.indexOf('st-prep')!==-1||cl.indexOf('st-paused')!==-1||cl.indexOf('st-prep-done')!==-1||cl.indexOf('st-exam')!==-1)return;
      var prepTime=parseDateTime(s.datum,s.prep_start);if(!prepTime)return;
      var diff=prepTime.getTime()-now.getTime();
      if(diff>-7200000&&diff<bestDiff){bestDiff=diff;best={s:s,prepTime:prepTime,diff:diff};}
    });
    if(!best){content.innerHTML='<div class="nex-done">Keine weiteren Prüfungen</div>';return;}
    var s=best.s,diff=best.diff,cdClass,cdText,label,statusHtml,extraHtml='';
    var farbe=ZWEIG_FARBEN[s.zweig]||'#666';
    if(diff>0){
      cdText=fmtCD(diff);cdClass=diff<600000?'soon':'normal';label='Vorbereitung beginnt in';
      statusHtml='<div style="text-align:center"><span class="nex-status waiting">⏳ Wartet</span></div>';
    } else {
      cdText='JETZT';cdClass='soon';label='';
      statusHtml='<div style="text-align:center"><span class="nex-status call-student">📢 Schüler rufen!</span></div>';
      extraHtml='<div class="nex-call-msg">Bitte „Vorbereitung starten" drücken</div>';
    }
    content.innerHTML=
      '<div class="nex-name">'+s.vorname+' '+s.nachname+'</div>'
      +'<div style="text-align:center;margin:3px 0">'
      +'<span class="nex-badge" style="background:'+farbe+';color:#fff">'+s.klasse+'</span>'
      +(s.fach?' <span style="color:#666;font-size:.8em">'+s.fach+'</span>':'')
      +'</div>'+statusHtml
      +'<div class="nex-countdown '+cdClass+'">'+cdText+'</div>'
      +(label?'<div class="nex-details">'+label+(s.prep_start?' · '+s.prep_start:'')+(s.pruefer?' · '+s.pruefer:'')+'</div>':'')
      +extraHtml;
  }
  updateWidget();setInterval(updateWidget,1000);
})();
</script>
</body></html>`);
    } catch(err){ console.error(err); res.status(500).send('Fehler'); }
});

// ==================== HTTPS ====================
const httpsOptions = { key: fs.readFileSync('./cert/key.pem'), cert: fs.readFileSync('./cert/cert.pem') };
https.createServer(httpsOptions, app).listen(process.env.PORT || port, () => {
    console.log('HTTPS auf https://localhost:' + (process.env.PORT || port));
});
process.on('SIGINT', () => { db.close(() => process.exit(0)); });