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
.top-bar h1{color:#fff;font-size:1.4em;font-weight:700}
.logout-btn{padding:8px 18px;background:rgba(255,255,255,.15);color:#fff;text-decoration:none;border-radius:6px;font-size:.85em;transition:background .2s}
.logout-btn:hover{background:rgba(255,255,255,.25)}
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

@media(max-width:600px){body{padding:10px}.top-bar h1{font-size:1.1em}.timer-time{font-size:1.8em}.timer-btn{padding:7px 14px;font-size:.85em}.form-grid{grid-template-columns:1fr}.next-exam-widget{position:relative;top:auto!important;right:auto!important;left:auto!important;width:100%;margin:0 auto 12px auto}}
</style>
</head>
<body>
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