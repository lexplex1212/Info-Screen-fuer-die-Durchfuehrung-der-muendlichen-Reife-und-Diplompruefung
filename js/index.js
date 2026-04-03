// Imports & Grundkonfiguration
const express = require('express');
const app = express();
const session = require('express-session');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config({ override: true });


// Timer-Dauer Fallback (Sekunden)
const VORBEREITUNGS_TIMER = 300;
const PRUEFUNGS_TIMER = 300;

function zeitDifferenz(start, end, fallback) {
    if (!start || !end) return fallback || 300;
    var sp = start.split(':').map(Number);
    var ep = end.split(':').map(Number);
    var diff = (ep[0] * 60 + ep[1] - sp[0] * 60 - sp[1]) * 60;
    return diff > 0 ? diff : (fallback || 300);
}


// Klassen- & Zweig-Konfiguration
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

const zweigZuordnung = {
    '5AHEL': 'elektronik', '5BHEL': 'elektronik', '5CHEL': 'elektronik',
    '5AHET': 'elektrotechnik', '5BHET': 'elektrotechnik', '5CHET': 'elektrotechnik',
    '5AHMBS': 'maschinenbau', '5BHMBZ': 'maschinenbau', '5VHMBS': 'maschinenbau',
    '5AHWIE': 'wirtschaft', '5BHWIE': 'wirtschaft', '5DHWIE': 'wirtschaft'
};


// Datenbank
const dbPath = path.join(__dirname, '..', 'termineordner', 'termine.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) return console.error('DB-Fehler:', err.message);
    console.log('DB verbunden:', dbPath);
    erstelleTabellen();
});

function erstelleTabellen() {
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
    )`, () => {
        const spalten = ['note INTEGER', 'themenpool INTEGER', 'kommentar TEXT',
            'tatsaechlich_gestartet TEXT', 'pruefungsdauer TEXT'];
        spalten.forEach(s => {
            const name = s.split(' ')[0];
            db.run(`ALTER TABLE timer_status ADD COLUMN ${s}`, (err) => {
                if (err && !err.message.includes('duplicate')) {}
            });
        });

        db.run(`CREATE TABLE IF NOT EXISTS Pruefer_Auswertung (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vorname TEXT, nachname TEXT, klasse TEXT,
            fach TEXT, pruefer TEXT, beisitz TEXT, datum TEXT,
            note INTEGER NOT NULL, themenpool INTEGER NOT NULL,
            kommentar TEXT, geplant_start TEXT,
            tatsaechlich_gestartet TEXT, pruefungsdauer TEXT,
            UNIQUE(vorname, nachname, klasse)
        )`, () => {
            ['geplant_start TEXT', 'tatsaechlich_gestartet TEXT', 'pruefungsdauer TEXT'].forEach(s => {
                db.run(`ALTER TABLE Pruefer_Auswertung ADD COLUMN ${s}`, () => {});
            });
            console.log('Tabellen bereit');
            initAlleTimer();
        });
    });
}


// Timer-Init beim Serverstart
function initAlleTimer() {
    const alleKlassen = Object.values(klassen).flat();
    const ph = alleKlassen.map(() => '?').join(',');

    db.all(`SELECT rowid, klasse, prep_start, prep_end, exam_start, exam_end FROM termine WHERE klasse IN (${ph})`, alleKlassen, (err, rows) => {
        if (err || !rows || !rows.length) return console.log('Keine Schüler gefunden');

        const stmt = db.prepare(`INSERT OR IGNORE INTO timer_status
            (schueler_id, remaining_seconds, state, exam_remaining, exam_state)
            VALUES (?, ?, 'idle', ?, 'idle')`);

        rows.forEach(row => {
            const zweig = zweigZuordnung[row.klasse];
            if (zweig) {
                var pd = zeitDifferenz(row.prep_start, row.prep_end, VORBEREITUNGS_TIMER);
                var ed = zeitDifferenz(row.exam_start, row.exam_end, PRUEFUNGS_TIMER);
                stmt.run(zweig + '_' + row.rowid, pd, ed);
            }
        });

        stmt.finalize(() => console.log('Timer-Init: ' + rows.length + ' Schüler'));
    });
}


// Middleware
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'FALLBACK_SECRET',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, sameSite: 'lax' }
}));

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.redirect('/');
}


// Hilfsfunktionen
function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString('utf8');
}

function getAlleSchueler(kuerzel) {
    return new Promise(resolve => {
        const alleKlassen = Object.values(klassen).flat();
        const ph = alleKlassen.map(() => '?').join(',');
        const k = kuerzel.toUpperCase();
        db.all(`SELECT rowid, * FROM termine WHERE klasse IN (${ph})
                AND (UPPER(pruefer) = ? OR UPPER(beisitz) = ?)
                ORDER BY datum, exam_start`, [...alleKlassen, k, k], (err, rows) => {
            resolve(err ? [] : rows);
        });
    });
}

function getAlleSchuelerAV() {
    return new Promise(resolve => {
        const alleKlassen = Object.values(klassen).flat();
        const ph = alleKlassen.map(() => '?').join(',');
        db.all(`SELECT rowid, * FROM termine WHERE klasse IN (${ph})
                ORDER BY datum, exam_start`, alleKlassen, (err, rows) => {
            resolve(err ? [] : rows);
        });
    });
}

function getSchuelerInfoFromSid(sid) {
    return new Promise(resolve => {
        const rowid = parseInt(sid.split('_').pop());
        if (isNaN(rowid)) return resolve(null);
        db.get('SELECT rowid, * FROM termine WHERE rowid = ?', [rowid], (err, row) => {
            resolve(err ? null : row);
        });
    });
}

function prueferExistiert(kuerzel) {
    return new Promise(resolve => {
        db.get('SELECT id FROM pruefer_login WHERE UPPER(kuerzel) = ?',
            [kuerzel.toUpperCase()], (err, row) => {
                resolve(!err && !!row);
            });
    });
}

function avExistiert(kuerzel) {
    return new Promise(resolve => {
        db.get('SELECT id, rolle FROM vorsitz_av WHERE UPPER(kuerzel) = ?',
            [kuerzel.toUpperCase()], (err, row) => {
                resolve(!err && row ? row : null);
            });
    });
}


// Timer-Berechnung
function berechneTimerStatus(row) {
    const now = Date.now();
    const t = {
        state: row.state,
        remaining_seconds: row.remaining_seconds,
        exam_state: row.exam_state || 'idle',
        exam_remaining: row.exam_remaining || PRUEFUNGS_TIMER,
        note: row.note,
        themenpool: row.themenpool,
        kommentar: row.kommentar,
        tatsaechlich_gestartet: row.tatsaechlich_gestartet,
        pruefungsdauer: row.pruefungsdauer
    };

    if (row.state === 'running' && row.started_at) {
        t.remaining_seconds = Math.max(0, row.remaining_seconds - (now - row.started_at) / 1000);
        if (t.remaining_seconds <= 0) t.state = 'prep_done';
    }

    if (row.exam_state === 'running' && row.exam_started_at) {
        t.exam_remaining = row.exam_remaining - (now - row.exam_started_at) / 1000;
    }

    return t;
}


// --- API: Vorbereitungs-Timer ---

app.post('/api/timer/:id/start', requireAuth, (req, res) => {
    const now = Date.now();
    const dur = req.body.duration || VORBEREITUNGS_TIMER;
    db.run(`INSERT INTO timer_status (schueler_id, started_at, remaining_seconds, state)
            VALUES (?, ?, ?, 'running')
            ON CONFLICT(schueler_id) DO UPDATE SET
            started_at=?, remaining_seconds=?, state='running', paused_at=NULL`,
        [req.params.id, now, dur, now, dur], err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
});

app.post('/api/timer/:id/pause', requireAuth, (req, res) => {
    db.run(`UPDATE timer_status SET state='paused', paused_at=?, remaining_seconds=?,
            started_at=NULL WHERE schueler_id=?`,
        [Date.now(), req.body.remaining_seconds, req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
});

app.post('/api/timer/:id/resume', requireAuth, (req, res) => {
    db.run(`UPDATE timer_status SET state='running', started_at=?, paused_at=NULL
            WHERE schueler_id=?`,
        [Date.now(), req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
});

app.post('/api/timer/:id/prep_done', requireAuth, (req, res) => {
    db.run(`INSERT INTO timer_status (schueler_id, state, remaining_seconds)
            VALUES (?, 'prep_done', 0)
            ON CONFLICT(schueler_id) DO UPDATE SET
            state='prep_done', remaining_seconds=0, started_at=NULL, paused_at=NULL`,
        [req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
});

app.post('/api/timer/:id/reset', requireAuth, async (req, res) => {
    const info = await getSchuelerInfoFromSid(req.params.id);
    const pd = req.body.prepDauer || VORBEREITUNGS_TIMER;
    const ed = req.body.examDauer || PRUEFUNGS_TIMER;
    db.run(`UPDATE timer_status SET
            state='idle', started_at=NULL, paused_at=NULL,
            remaining_seconds=?,
            exam_state='idle', exam_started_at=NULL, exam_remaining=?,
            note=NULL, themenpool=NULL, kommentar=NULL,
            tatsaechlich_gestartet=NULL, pruefungsdauer=NULL
            WHERE schueler_id=?`,
        [pd, ed, req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });
            if (info) {
                db.run('DELETE FROM Pruefer_Auswertung WHERE vorname=? AND nachname=? AND klasse=?',
                    [info.vorname || '', info.nachname || '', info.klasse || '']);
            }
            res.json({ ok: true });
        });
});


// --- API: Krank / Anwesend ---

app.post('/api/timer/:id/krank', requireAuth, (req, res) => {
    db.run(`INSERT INTO timer_status (schueler_id, state, remaining_seconds)
            VALUES (?, 'krank', 0)
            ON CONFLICT(schueler_id) DO UPDATE SET
            state='krank', started_at=NULL, paused_at=NULL, remaining_seconds=0`,
        [req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
});

app.post('/api/timer/:id/anwesend', requireAuth, (req, res) => {
    const pd = req.body.prepDauer || VORBEREITUNGS_TIMER;
    db.run(`UPDATE timer_status SET
            state='idle', started_at=NULL, paused_at=NULL,
            remaining_seconds=?
            WHERE schueler_id=?`,
        [pd, req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
});


// --- API: Prüfungs-Timer ---

app.post('/api/timer/:id/exam_start', requireAuth, (req, res) => {
    const now = Date.now();
    const d = new Date(now);
    const uhrzeit = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const dur = req.body.duration || PRUEFUNGS_TIMER;

    db.run(`UPDATE timer_status SET exam_state='running', exam_started_at=?,
            exam_remaining=?, tatsaechlich_gestartet=?
            WHERE schueler_id=?`,
        [now, dur, uhrzeit, req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true, tatsaechlich_gestartet: uhrzeit });
        });
});

app.post('/api/timer/:id/exam_pause', requireAuth, (req, res) => {
    db.run(`UPDATE timer_status SET exam_state='paused', exam_started_at=NULL,
            exam_remaining=? WHERE schueler_id=?`,
        [req.body.exam_remaining, req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
});

app.post('/api/timer/:id/exam_resume', requireAuth, (req, res) => {
    db.run(`UPDATE timer_status SET exam_state='running', exam_started_at=?
            WHERE schueler_id=?`,
        [Date.now(), req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
});


// --- API: Prüfung abschließen ---

app.post('/api/timer/:id/exam_finish', requireAuth, (req, res) => {
    const { note, themenpool, kommentar, pruefungsdauer,
        vorname, nachname, klasse, fach, pruefer, beisitz,
        datum, geplant_start, tatsaechlich_gestartet } = req.body;

    if (!note || !themenpool) return res.status(400).json({ error: 'Note und Themenpool sind Pflicht' });

    db.run(`UPDATE timer_status SET exam_state='done', note=?, themenpool=?,
            kommentar=?, pruefungsdauer=? WHERE schueler_id=?`,
        [note, themenpool, kommentar || '', pruefungsdauer || '', req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });

            db.run(`INSERT INTO Pruefer_Auswertung
                    (vorname, nachname, klasse, fach, pruefer, beisitz, datum,
                     note, themenpool, kommentar, geplant_start,
                     tatsaechlich_gestartet, pruefungsdauer)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(vorname, nachname, klasse) DO UPDATE SET
                    fach=excluded.fach, pruefer=excluded.pruefer,
                    beisitz=excluded.beisitz, datum=excluded.datum,
                    note=excluded.note, themenpool=excluded.themenpool,
                    kommentar=excluded.kommentar, geplant_start=excluded.geplant_start,
                    tatsaechlich_gestartet=excluded.tatsaechlich_gestartet,
                    pruefungsdauer=excluded.pruefungsdauer`,
                [vorname || '', nachname || '', klasse || '', fach || '',
                    pruefer || '', beisitz || '', datum || '', note, themenpool,
                    kommentar || '', geplant_start || '',
                    tatsaechlich_gestartet || '', pruefungsdauer || ''], err2 => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    res.json({ ok: true });
                });
        });
});


// --- API: AV Note bearbeiten ---

app.post('/api/timer/:id/edit_note', requireAuth, (req, res) => {
    if (!req.session.user || req.session.user.rolle !== 'av') {
        return res.status(403).json({ error: 'Nur AV darf Noten bearbeiten' });
    }
    const { note, themenpool, kommentar } = req.body;
    if (!note || !themenpool) return res.status(400).json({ error: 'Note und Themenpool sind Pflicht' });

    db.run(`UPDATE timer_status SET note=?, themenpool=?, kommentar=? WHERE schueler_id=?`,
        [note, themenpool, kommentar || '', req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });
            getSchuelerInfoFromSid(req.params.id).then(info => {
                if (info) {
                    db.run(`UPDATE Pruefer_Auswertung SET note=?, themenpool=?, kommentar=?
                            WHERE vorname=? AND nachname=? AND klasse=?`,
                        [note, themenpool, kommentar || '',
                            info.vorname || '', info.nachname || '', info.klasse || '']);
                }
                res.json({ ok: true });
            });
        });
});


// --- API: Alle Timer laden (für Frontend-Init) ---

app.get('/api/timers/all', requireAuth, (req, res) => {
    db.all('SELECT * FROM timer_status', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const timers = {};
        (rows || []).forEach(row => {
            timers[row.schueler_id] = berechneTimerStatus(row);
        });
        res.json(timers);
    });
});


// --- Login: Microsoft OAuth2 ---

app.get('/', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/home');
    res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>HTL Login</title>
    <style>
        body{font-family:Arial,sans-serif;background:#07175e;min-height:100vh;
             display:flex;justify-content:center;align-items:center}
        .box{background:#fff;border-radius:20px;padding:60px;text-align:center;
             box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:500px;width:100%}
        a.btn{display:inline-block;padding:15px 40px;background:#0078d4;color:#fff;
              text-decoration:none;border-radius:8px;font-size:1.2em;font-weight:700}
    </style></head>
    <body><div class="box">
        <h1>Willkommen</h1>
        <p>Bitte einloggen</p>
        <a href="/microsoft-login" class="btn">Mit Microsoft einloggen</a>
    </div></body></html>`);
});

app.get('/microsoft-login', (req, res) => {
    const url = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize'
        + '?client_id=' + process.env.CLIENT_ID
        + '&response_type=code'
        + '&redirect_uri=' + encodeURIComponent(process.env.REDIRECT_URI)
        + '&response_mode=query'
        + '&scope=openid%20email%20profile';
    res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
    if (!req.query.code) return res.status(400).send('Login abgebrochen. <a href="/">Zurück</a>');
    try {
        const tr = await axios.post(
            'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
            new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: req.query.code,
                redirect_uri: process.env.REDIRECT_URI
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const payload = JSON.parse(base64UrlDecode(tr.data.id_token.split('.')[1]));
        const email = (payload.preferred_username || payload.upn || payload.email || '').toLowerCase();

        if (!email || !email.endsWith('@ms.bulme.at')) {
            return res.status(403).send('Zugriff verweigert. Nur @ms.bulme.at. <a href="/">Zurück</a>');
        }

        const kuerzel = email.split('@')[0];
        const avInfo = await avExistiert(kuerzel);
        if (avInfo) {
            req.session.user = { email, kuerzel, rolle: 'av' };
            return res.redirect('/home');
        }
        const istPruefer = await prueferExistiert(kuerzel);
        if (!istPruefer) {
            return res.status(403).send('Zugriff verweigert. Sie sind nicht als Prüfer eingetragen. <a href="/">Zurück</a>');
        }

        req.session.user = { email, kuerzel, rolle: 'pruefer' };
        res.redirect('/home');
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).send('Login-Fehler. <a href="/">Zurück</a>');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});


// --- Hauptseite ---

app.get('/home', requireAuth, async (req, res) => {
    try {
        const kuerzel = req.session.user.kuerzel;
        const userRolle = req.session.user.rolle || 'pruefer';
        const schueler = userRolle === 'av' ? await getAlleSchuelerAV() : await getAlleSchueler(kuerzel);

        const cardsHtml = schueler.map((s, i) => {
            const zweig = zweigZuordnung[s.klasse] || 'elektronik';
            const sid = zweig + '_' + (s.rowid || i);
            const farbe = zweigFarben[zweig] || '#666';
            const textFarbe = (zweig === 'elektrotechnik' || zweig === 'wirtschaft') ? '#333' : '#fff';

            let rolle;
            if (userRolle === 'av') rolle = 'av';
            else if ((s.pruefer || '').toUpperCase() === kuerzel.toUpperCase()) rolle = 'pruefer';
            else rolle = 'beisitz';

            const beisitzClass = rolle === 'beisitz' ? ' beisitz' : '';
            const rolleBadge = rolle === 'beisitz' ? '<span class="badge" style="background:#999;color:#fff">Beisitz</span>'
                : rolle === 'av' ? '<span class="badge" style="background:#d4a017;color:#fff">AV</span>' : '';

            return `<div class="card${beisitzClass}" id="card-${sid}" data-sid="${sid}" data-rolle="${rolle}" style="border-left:4px solid ${farbe}">
                <div class="progress" id="progress-${sid}"></div>
                <div class="card-inner">
                    <div class="card-top">
                        <span class="name">${s.vorname || ''} ${s.nachname || ''}</span>
                        ${s.klasse ? `<span class="badge" style="background:${farbe};color:${textFarbe}">${s.klasse}</span>` : ''}
                        ${rolleBadge}
                        <span class="timer-badge" id="badge-${sid}"></span>
                        <span class="meta">
                            ${s.fach ? `<b>Fach:</b> ${s.fach}` : ''}
                            ${s.pruefer ? ` | <b>Prüfer:</b> ${s.pruefer}` : ''}
                            ${s.beisitz ? ` | <b>Beisitz:</b> ${s.beisitz}` : ''}
                            ${s.exam_start ? ` | <b>Prüfung:</b> ${s.exam_start}${s.exam_end ? '-' + s.exam_end : ''}` : ''}
                            ${s.datum ? ` | ${s.datum}` : ''}
                        </span>
                    </div>
                    <div class="expand-area" id="exp-${sid}"></div>
                </div>
            </div>`;
        }).join('');

        const schuelerJson = JSON.stringify(schueler.map((s, i) => {
            const zw = zweigZuordnung[s.klasse] || 'elektronik';
            let rolle;
            if (userRolle === 'av') rolle = 'av';
            else if ((s.pruefer || '').toUpperCase() === kuerzel.toUpperCase()) rolle = 'pruefer';
            else rolle = 'beisitz';
            const pd = zeitDifferenz(s.prep_start, s.prep_end, VORBEREITUNGS_TIMER);
            const ed = zeitDifferenz(s.exam_start, s.exam_end, PRUEFUNGS_TIMER);
            return {
                sid: zw + '_' + (s.rowid || i),
                vorname: s.vorname || '', nachname: s.nachname || '',
                klasse: s.klasse || '', fach: s.fach || '',
                pruefer: s.pruefer || '', beisitz: s.beisitz || '',
                datum: s.datum || '',
                prep_start: s.prep_start || s.rep_start || '',
                exam_start: s.exam_start || '', exam_end: s.exam_end || '',
                zweig: zw,
                rolle: rolle,
                prepDauer: pd,
                examDauer: ed
            };
        }));

        res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HTL Matura</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Arial,sans-serif;background:#07175e;min-height:100vh;padding:20px}

.top{display:flex;justify-content:space-between;align-items:center;max-width:900px;margin:0 auto 15px;color:#fff}
.top a{color:#fff;background:rgba(255,255,255,.15);padding:6px 16px;border-radius:6px;text-decoration:none;font-size:.85em}

.liste{max-width:900px;margin:0 auto}
.card{position:relative;margin:6px 0;border-radius:8px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1);cursor:pointer;overflow:hidden;transition:box-shadow .2s}
.card:hover{box-shadow:0 2px 8px rgba(0,0,0,.15)}
.card.beisitz{opacity:.5}
.card.beisitz .card-inner{background:rgba(240,240,240,.6)}
.progress{position:absolute;top:0;left:0;height:100%;width:0%;z-index:0;pointer-events:none;transition:width .8s linear}
.card-inner{position:relative;z-index:1;padding:10px 14px}
.card-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.name{font-weight:700;font-size:1em}
.badge{padding:2px 8px;border-radius:10px;font-size:.7em;font-weight:700}
.meta{color:#777;font-size:.75em}

.timer-badge{display:none;padding:2px 8px;border-radius:10px;font-size:.75em;font-weight:700}
.timer-badge.on{display:inline-block}

.expand-area{max-height:0;overflow:hidden;transition:max-height .3s ease}
.card.open .expand-area{max-height:500px}
.expand-inner{border-top:1px solid #eee;padding:12px 0 4px}

.timer-big{font-size:2em;font-weight:700;text-align:center;font-variant-numeric:tabular-nums;letter-spacing:2px}
.timer-label{text-align:center;font-size:.85em;color:#666;margin:4px 0 8px}

.btns{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:8px 0}
.btn{padding:8px 18px;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:.9em}
.btn-start{background:#f0c230;color:#333}
.btn-pause{background:#ff9800;color:#fff}
.btn-resume{background:#4caf50;color:#fff}
.btn-reset{background:#f44336;color:#fff}
.btn-skip{background:#9c27b0;color:#fff}
.btn-exam{background:#2196f3;color:#fff}
.btn-finish{background:#4caf50;color:#fff}
.btn-krank{background:#888;color:#fff;font-size:.8em}
.btn-edit{background:#ff9800;color:#fff}

.form{margin-top:10px;padding:10px;background:#f9f9f9;border-radius:8px;border:1px solid #e0e0e0}
.form h4{text-align:center;margin-bottom:8px}
.form-row{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0}
.form-row label{font-weight:600;font-size:.85em}
.form-row select,.form-row textarea{padding:5px;border:1px solid #ddd;border-radius:5px;font-size:.9em}
.form-row textarea{width:100%;min-height:36px;resize:vertical}

.done{text-align:center;padding:10px}
.done h4{color:#4caf50}
.done-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:8px;text-align:left;font-size:.9em}
.done-grid div{padding:4px 8px;background:#f5f5f5;border-radius:4px}

.widget{position:fixed;top:15px;right:15px;width:260px;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);z-index:500;overflow:hidden}
.widget-head{padding:8px 12px;background:#333;color:#fff;font-weight:700;font-size:.9em;display:flex;justify-content:space-between;align-items:center;cursor:grab}
.widget-body{padding:10px;transition:max-height .3s;max-height:300px;overflow:hidden}
.widget-body.hide{max-height:0;padding:0 10px;opacity:0}
.widget-cd{font-size:1.6em;font-weight:700;text-align:center;margin:6px 0;font-variant-numeric:tabular-nums}
.widget-name{text-align:center;font-weight:700}
.widget-info{text-align:center;font-size:.8em;color:#666;margin-top:4px}
.call-alert{text-align:center;color:#c0392b;font-weight:700;animation:pulse 1.5s infinite}
@keyframes pulse{50%{opacity:.6}}

@media(max-width:600px){.widget{position:relative;top:auto!important;right:auto!important;left:auto!important;width:100%;margin-bottom:12px}}
</style>
</head>
<body>

<div class="top">
    <h1>Matura Prüfungen</h1>
    <div style="display:flex;gap:10px;align-items:center">
        <span style="font-size:.85em">${kuerzel.toUpperCase()}${userRolle === 'av' ? ' (AV)' : ''}</span>
        <a href="/logout">Logout</a>
    </div>
</div>

<div class="liste">${cardsHtml}</div>

<div class="widget" id="widget">
    <div class="widget-head" id="wHead">
        <span>Nächste Vorbereitung</span>
        <button onclick="toggleWidget()" style="background:none;border:1px solid rgba(255,255,255,.5);color:#fff;border-radius:50%;width:24px;height:24px;cursor:pointer" id="wBtn">-</button>
    </div>
    <div class="widget-body" id="wBody">
        <div id="wContent" style="text-align:center;color:#999">Lade...</div>
    </div>
</div>

<script>
var SD = ${schuelerJson};
var ZF = ${JSON.stringify(zweigFarben)};
</script>

<script>
(function(){

var T = {};
function g(sid) {
    if (!T[sid]) {
        var info = find(sid);
        var pd = info.prepDauer || 300;
        var ed = info.examDauer || 300;
        T[sid] = {
            state:'idle', rem:pd, iid:null,
            examState:'idle', examRem:ed, eiid:null,
            note:null, themen:null, komm:'',
            startedAt:null, dauer:null,
            prepDauer:pd, examDauer:ed
        };
    }
    return T[sid];
}

function fmt(s) {
    var neg = s < 0; s = Math.abs(s);
    var m = Math.floor(s/60), sc = Math.floor(s%60);
    return (neg?'+':'') + (m<10?'0':'') + m + ':' + (sc<10?'0':'') + sc;
}
function nowHHMM() {
    var d = new Date();
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
function fmtDauer(sek) {
    sek = Math.round(Math.abs(sek));
    var m = Math.floor(sek/60), s = sek%60;
    return (m<10?'0':'') + m + ':' + (s<10?'0':'') + s;
}

function find(sid) {
    for (var i = 0; i < SD.length; i++) {
        if (SD[i].sid === sid) return SD[i];
    }
    return {};
}

function prepTick(sid) {
    var t = g(sid);
    if (t.state !== 'running') return;
    t.rem = Math.max(0, t.rem - 1);
    if (t.rem <= 0) {
        t.state = 'prep_done';
        if (t.iid) { clearInterval(t.iid); t.iid = null; }
        api(sid, 'prep_done');
        render(sid);
    } else {
        tickUpdate(sid);
    }
}

function examTick(sid) {
    var t = g(sid);
    if (t.examState !== 'running') return;
    t.examRem -= 1;
    tickUpdate(sid);
}

function tickUpdate(sid) {
    var t = g(sid);
    var prog = document.getElementById('progress-' + sid);
    var badge = document.getElementById('badge-' + sid);
    var timeEl = document.querySelector('#exp-' + sid + ' .timer-big');
    if (!prog) return;

    if (t.state === 'running') {
        var p = Math.max(0, Math.min(1, 1 - t.rem / t.prepDauer));
        prog.style.width = (p * 100) + '%';
        prog.style.backgroundColor = 'rgba(231,76,60,' + (0.15 + p * 0.25) + ')';
        if (badge) { badge.className = 'timer-badge on'; badge.style.background = '#ffe0cc'; badge.style.color = '#c0392b'; badge.textContent = fmt(t.rem); }
        if (timeEl) timeEl.textContent = fmt(t.rem);
    }
    else if (t.examState === 'running') {
        var ep = t.examRem >= 0 ? Math.max(0, Math.min(1, 1 - t.examRem / t.examDauer)) : 1;
        prog.style.width = (ep * 100) + '%';
        prog.style.backgroundColor = t.examRem < 0 ? 'rgba(231,76,60,0.3)' : 'rgba(76,175,80,' + (0.1 + ep * 0.3) + ')';
        if (badge) { badge.className = 'timer-badge on'; badge.style.background = '#fff3cd'; badge.style.color = '#856404'; badge.textContent = (t.examRem < 0 ? 'ÜBER ' : '') + fmt(t.examRem); }
        if (timeEl) { timeEl.textContent = (t.examRem < 0 ? '+' : '') + fmt(t.examRem); timeEl.style.color = t.examRem < 0 ? '#c0392b' : '#222'; }
    }
}

function render(sid) {
    var t = g(sid);
    var prog = document.getElementById('progress-' + sid);
    var badge = document.getElementById('badge-' + sid);
    var exp = document.getElementById('exp-' + sid);
    if (!exp) return;

    var info = find(sid);
    var rolle = info.rolle || 'beisitz';
    var canControl = rolle !== 'beisitz';
    var istAV = rolle === 'av';
    var h = '<div class="expand-inner">';

    if (t.state === 'krank') {
        prog.style.width = '100%'; prog.style.backgroundColor = 'rgba(244,67,54,0.25)';
        badge.className = 'timer-badge on'; badge.style.background = '#f44336'; badge.style.color = '#fff'; badge.textContent = 'Krank';
        h += '<div class="done"><h4 style="color:#f44336">Krank / Abwesend</h4>';
        if (canControl) h += '<div class="btns"><button class="btn btn-resume" data-a="anwesend" data-s="' + sid + '">Wieder anwesend</button></div>';
        h += '</div>';
    }
    else if (t.state === 'idle') {
        prog.style.width = '0%';
        badge.className = 'timer-badge';
        h += '<div class="timer-big">' + fmt(t.prepDauer) + '</div>'
           + '<div class="timer-label">Vorbereitung</div>';
        if (canControl) h += '<div class="btns"><button class="btn btn-start" data-a="start" data-s="' + sid + '">Vorbereitung starten</button>'
           + ' <button class="btn btn-krank" data-a="krank" data-s="' + sid + '">Krank</button></div>';
    }
    else if (t.state === 'running') {
        tickUpdate(sid);
        h += '<div class="timer-big">' + fmt(t.rem) + '</div>'
           + '<div class="timer-label">Vorbereitung läuft...</div>';
        if (canControl) h += '<div class="btns">'
           + '<button class="btn btn-pause" data-a="pause" data-s="' + sid + '">Pause</button>'
           + '<button class="btn btn-skip" data-a="skip" data-s="' + sid + '">Überspringen</button>'
           + '<button class="btn btn-reset" data-a="reset" data-s="' + sid + '">Reset</button></div>';
    }
    else if (t.state === 'paused') {
        badge.className = 'timer-badge on'; badge.style.background = '#ff9800'; badge.style.color = '#fff'; badge.textContent = fmt(t.rem) + ' ⏸';
        h += '<div class="timer-big">' + fmt(t.rem) + '</div>'
           + '<div class="timer-label">Pausiert</div>';
        if (canControl) h += '<div class="btns">'
           + '<button class="btn btn-resume" data-a="resume" data-s="' + sid + '">Fortsetzen</button>'
           + '<button class="btn btn-skip" data-a="skip" data-s="' + sid + '">Überspringen</button>'
           + '<button class="btn btn-reset" data-a="reset" data-s="' + sid + '">Reset</button></div>';
    }
    else if (t.state === 'prep_done' && t.examState === 'idle') {
        prog.style.width = '100%'; prog.style.backgroundColor = 'rgba(255,152,0,0.3)';
        badge.className = 'timer-badge on'; badge.style.background = '#ff9800'; badge.style.color = '#fff'; badge.textContent = 'Vorb. fertig';
        h += '<div class="timer-big" style="color:#e67e22">00:00</div>'
           + '<div class="timer-label" style="color:#e67e22;font-weight:700">Vorbereitung fertig</div>';
        if (canControl) h += '<div class="btns"><button class="btn btn-exam" data-a="exam_start" data-s="' + sid + '">Prüfung starten</button></div>';
    }
    else if (t.examState === 'running' || t.examState === 'paused') {
        tickUpdate(sid);
        var isPaused = t.examState === 'paused';
        h += '<div class="timer-big">' + (t.examRem < 0 ? '+' : '') + fmt(t.examRem) + '</div>'
           + '<div class="timer-label">' + (t.examRem < 0 ? '<b style="color:#c0392b">Überzogen!</b>' : (isPaused ? 'Prüfung pausiert' : 'Prüfung läuft...')) + '</div>';
        if (canControl) {
            h += '<div class="btns">';
            if (isPaused) h += '<button class="btn btn-resume" data-a="exam_resume" data-s="' + sid + '">Fortsetzen</button>';
            else h += '<button class="btn btn-pause" data-a="exam_pause" data-s="' + sid + '">Pause</button>';
            h += '</div>';

            var noteOpts = '<option value="">--</option>';
            for (var i = 1; i <= 5; i++) noteOpts += '<option value="' + i + '"' + (t.note == i ? ' selected' : '') + '>' + i + '</option>';
            var thOpts = '<option value="">--</option>';
            for (var j = 1; j <= 8; j++) thOpts += '<option value="' + j + '"' + (t.themen == j ? ' selected' : '') + '>' + j + '</option>';

            h += '<div class="form"><h4>Ergebnis</h4>'
               + '<div class="form-row"><label>Note*</label> <select id="note-' + sid + '" data-f="note" data-s="' + sid + '">' + noteOpts + '</select>'
               + ' <label>Themenpool*</label> <select id="th-' + sid + '" data-f="themen" data-s="' + sid + '">' + thOpts + '</select></div>'
               + '<div class="form-row"><textarea id="komm-' + sid + '" data-f="komm" data-s="' + sid + '" placeholder="Kommentar (optional)">' + (t.komm || '') + '</textarea></div>'
               + '<div class="btns"><button class="btn btn-finish" data-a="exam_finish" data-s="' + sid + '">Abschließen</button></div></div>';
        }
    }
    else if (t.examState === 'done') {
        prog.style.width = '100%'; prog.style.backgroundColor = 'rgba(76,175,80,0.25)';
        badge.className = 'timer-badge on'; badge.style.background = '#4caf50'; badge.style.color = '#fff'; badge.textContent = 'Fertig';
        var dInfo = find(sid);
        h += '<div class="done"><h4>Abgeschlossen</h4><div class="done-grid">'
           + '<div><b>Note:</b> ' + t.note + '</div>'
           + '<div><b>Themenpool:</b> ' + t.themen + '</div>'
           + (dInfo.exam_start ? '<div><b>Geplant:</b> ' + dInfo.exam_start + '</div>' : '')
           + (t.startedAt ? '<div><b>Tatsächlich:</b> ' + t.startedAt + '</div>' : '')
           + (t.dauer ? '<div><b>Dauer:</b> ' + t.dauer + '</div>' : '')
           + (t.komm ? '<div style="grid-column:1/-1"><b>Kommentar:</b> ' + t.komm + '</div>' : '')
           + '</div>';
        if (istAV) {
            var enOpts = '<option value="">--</option>';
            for (var ei = 1; ei <= 5; ei++) enOpts += '<option value="' + ei + '"' + (t.note == ei ? ' selected' : '') + '>' + ei + '</option>';
            var etOpts = '<option value="">--</option>';
            for (var ej = 1; ej <= 8; ej++) etOpts += '<option value="' + ej + '"' + (t.themen == ej ? ' selected' : '') + '>' + ej + '</option>';
            h += '<div class="form" id="editform-' + sid + '" style="display:none"><h4>Bearbeiten (AV)</h4>'
               + '<div class="form-row"><label>Note*</label> <select id="enote-' + sid + '">' + enOpts + '</select>'
               + ' <label>Themenpool*</label> <select id="eth-' + sid + '">' + etOpts + '</select></div>'
               + '<div class="form-row"><textarea id="ekomm-' + sid + '" placeholder="Kommentar">' + (t.komm || '') + '</textarea></div>'
               + '<div class="btns"><button class="btn btn-finish" data-a="av_save" data-s="' + sid + '">Speichern</button></div></div>'
               + '<div class="btns"><button class="btn btn-edit" data-a="av_edit" data-s="' + sid + '">Bearbeiten</button></div>';
        }
        h += '</div>';
    }

    h += '</div>';
    exp.innerHTML = h;
}

function api(sid, action, body) {
    var opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    fetch('/api/timer/' + sid + '/' + action, opts).catch(function(e) { console.warn('Sync:', e); });
}

function sortCards() {
    var liste = document.querySelector('.liste');
    if (!liste) return;
    var cards = Array.from(liste.querySelectorAll('.card'));
    cards.sort(function(a, b) {
        var sa = g(a.dataset.sid), sb = g(b.dataset.sid);
        var wa = (sa.examState === 'done' || sa.state === 'krank') ? 1 : 0;
        var wb = (sb.examState === 'done' || sb.state === 'krank') ? 1 : 0;
        return wa - wb;
    });
    cards.forEach(function(c) { liste.appendChild(c); });
}

document.addEventListener('click', function(e) {
    var btn = e.target.closest('.btn[data-a]');
    if (btn) {
        e.stopPropagation();
        var a = btn.dataset.a, sid = btn.dataset.s, t = g(sid);

        if (a === 'start') {
            if (t.iid) clearInterval(t.iid);
            t.state = 'running'; t.rem = t.prepDauer;
            t.iid = setInterval(function() { prepTick(sid); }, 1000);
            render(sid); api(sid, 'start', { duration: t.prepDauer });
        }
        else if (a === 'pause') {
            t.state = 'paused'; if (t.iid) { clearInterval(t.iid); t.iid = null; }
            render(sid); api(sid, 'pause', { remaining_seconds: t.rem });
        }
        else if (a === 'resume') {
            t.state = 'running'; if (t.iid) clearInterval(t.iid);
            t.iid = setInterval(function() { prepTick(sid); }, 1000);
            render(sid); api(sid, 'resume');
        }
        else if (a === 'skip') {
            if (t.iid) { clearInterval(t.iid); t.iid = null; }
            t.state = 'prep_done'; t.rem = 0;
            render(sid); api(sid, 'prep_done');
        }
        else if (a === 'reset') {
            var card = document.getElementById('card-' + sid);
            var name = card ? card.querySelector('.name').textContent.trim() : 'Schüler';
            if (!confirm('"' + name + '" zurücksetzen? Alle Daten gehen verloren.')) return;
            if (t.iid) { clearInterval(t.iid); t.iid = null; }
            if (t.eiid) { clearInterval(t.eiid); t.eiid = null; }
            t.state = 'idle'; t.rem = t.prepDauer; t.examState = 'idle'; t.examRem = t.examDauer;
            t.note = null; t.themen = null; t.komm = ''; t.startedAt = null; t.dauer = null;
            render(sid); api(sid, 'reset', { prepDauer: t.prepDauer, examDauer: t.examDauer }); sortCards();
        }
        else if (a === 'exam_start') {
            t.examState = 'running'; t.examRem = t.examDauer; t.startedAt = nowHHMM();
            if (t.eiid) clearInterval(t.eiid);
            t.eiid = setInterval(function() { examTick(sid); }, 1000);
            var card2 = document.getElementById('card-' + sid);
            if (card2) card2.classList.add('open');
            render(sid); api(sid, 'exam_start', { duration: t.examDauer });
        }
        else if (a === 'exam_pause') {
            t.examState = 'paused'; if (t.eiid) { clearInterval(t.eiid); t.eiid = null; }
            render(sid); api(sid, 'exam_pause', { exam_remaining: t.examRem });
        }
        else if (a === 'exam_resume') {
            t.examState = 'running'; if (t.eiid) clearInterval(t.eiid);
            t.eiid = setInterval(function() { examTick(sid); }, 1000);
            render(sid); api(sid, 'exam_resume');
        }
        else if (a === 'exam_finish') {
            var note = document.getElementById('note-' + sid);
            var th = document.getElementById('th-' + sid);
            var komm = document.getElementById('komm-' + sid);
            if (!note || !note.value || !th || !th.value) { alert('Note und Themenpool auswählen!'); return; }
            if (t.eiid) { clearInterval(t.eiid); t.eiid = null; }
            t.examState = 'done'; t.note = parseInt(note.value); t.themen = parseInt(th.value);
            t.komm = komm ? komm.value : '';
            t.dauer = fmtDauer(t.examDauer - t.examRem);
            render(sid);
            var info = find(sid);
            api(sid, 'exam_finish', {
                note: t.note, themenpool: t.themen, kommentar: t.komm,
                pruefungsdauer: t.dauer, tatsaechlich_gestartet: t.startedAt || '',
                vorname: info.vorname, nachname: info.nachname, klasse: info.klasse,
                fach: info.fach, pruefer: info.pruefer, beisitz: info.beisitz,
                datum: info.datum, geplant_start: info.exam_start || ''
            });
            sortCards();
        }
        else if (a === 'krank') {
            var card3 = document.getElementById('card-' + sid);
            var name3 = card3 ? card3.querySelector('.name').textContent.trim() : 'Schüler';
            if (!confirm('"' + name3 + '" als krank eintragen?')) return;
            if (t.iid) { clearInterval(t.iid); t.iid = null; }
            if (t.eiid) { clearInterval(t.eiid); t.eiid = null; }
            t.state = 'krank'; t.rem = 0;
            render(sid); api(sid, 'krank'); sortCards();
        }
        else if (a === 'anwesend') {
            if (t.iid) { clearInterval(t.iid); t.iid = null; }
            t.state = 'idle'; t.rem = t.prepDauer;
            render(sid); api(sid, 'anwesend', { prepDauer: t.prepDauer }); sortCards();
        }
        else if (a === 'av_edit') {
            var ef = document.getElementById('editform-' + sid);
            if (ef) ef.style.display = ef.style.display === 'none' ? 'block' : 'none';
            return;
        }
        else if (a === 'av_save') {
            var en = document.getElementById('enote-' + sid);
            var et = document.getElementById('eth-' + sid);
            var ek = document.getElementById('ekomm-' + sid);
            if (!en || !en.value || !et || !et.value) { alert('Note und Themenpool auswählen!'); return; }
            t.note = parseInt(en.value); t.themen = parseInt(et.value);
            t.komm = ek ? ek.value : '';
            api(sid, 'edit_note', { note: t.note, themenpool: t.themen, kommentar: t.komm });
            render(sid);
        }
        return;
    }

    if (e.target.closest('.form')) return;

    var card = e.target.closest('.card');
    if (card) card.classList.toggle('open');
});

document.addEventListener('change', function(e) {
    if (e.target.matches('select[data-f]')) {
        var sid = e.target.dataset.s, t = g(sid);
        if (e.target.dataset.f === 'note') t.note = parseInt(e.target.value) || null;
        if (e.target.dataset.f === 'themen') t.themen = parseInt(e.target.value) || null;
    }
});
document.addEventListener('input', function(e) {
    if (e.target.matches('textarea[data-f]')) g(e.target.dataset.s).komm = e.target.value;
});

// Init: Timer vom Server laden
document.querySelectorAll('.card').forEach(function(c) {
    var sid = c.dataset.sid;
    if (sid) render(sid);
});

fetch('/api/timers/all').then(function(r) { return r.json(); }).then(function(data) {
    for (var sid in data) {
        var info = data[sid], t = g(sid);
        t.rem = Math.max(0, info.remaining_seconds);
        t.state = info.state || 'idle';
        t.examState = info.exam_state || 'idle';
        t.examRem = info.exam_remaining !== undefined ? info.exam_remaining : t.examDauer;
        t.note = info.note || null;
        t.themen = info.themenpool || null;
        t.komm = info.kommentar || '';
        t.startedAt = info.tatsaechlich_gestartet || null;
        t.dauer = info.pruefungsdauer || null;
        if (t.state === 'prep_done') t.rem = 0;

        if (t.state === 'running' && t.rem > 0) {
            var sInfo = find(sid);
            if (sInfo.rolle !== 'beisitz') {
                (function(id) { g(id).iid = setInterval(function() { prepTick(id); }, 1000); })(sid);
            }
        }
        if (t.examState === 'running') {
            var sInfo2 = find(sid);
            if (sInfo2.rolle !== 'beisitz') {
                (function(id) { g(id).eiid = setInterval(function() { examTick(id); }, 1000); })(sid);
            }
        }
        render(sid);
    }
    sortCards();
}).catch(function(e) { console.warn('Load:', e); });

// Polling: Beisitz/AV-Karten alle 5s synchronisieren
setInterval(function() {
    fetch('/api/timers/all').then(function(r) { return r.json(); }).then(function(data) {
        for (var sid in data) {
            var sInfo = find(sid);
            if (sInfo.rolle === 'pruefer') continue;

            var info = data[sid], t = g(sid);
            t.rem = Math.max(0, info.remaining_seconds);
            t.state = info.state || 'idle';
            t.examState = info.exam_state || 'idle';
            t.examRem = info.exam_remaining !== undefined ? info.exam_remaining : t.examDauer;
            t.note = info.note || null;
            t.themen = info.themenpool || null;
            t.komm = info.kommentar || '';
            t.startedAt = info.tatsaechlich_gestartet || null;
            t.dauer = info.pruefungsdauer || null;
            if (t.state === 'prep_done') t.rem = 0;

            render(sid);
        }
        sortCards();
    }).catch(function() {});
}, 5000);

})();


// Widget: Nächste Vorbereitung
function toggleWidget() {
    var b = document.getElementById('wBody');
    var btn = document.getElementById('wBtn');
    b.classList.toggle('hide');
    btn.textContent = b.classList.contains('hide') ? '+' : '-';
}

(function() {
    var widget = document.getElementById('widget');
    var wHead = document.getElementById('wHead');
    var content = document.getElementById('wContent');
    if (!widget || !content) return;

    var dragging = false, ox = 0, oy = 0;
    wHead.addEventListener('mousedown', function(e) {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        var r = widget.getBoundingClientRect();
        ox = e.clientX - r.left; oy = e.clientY - r.top;
        widget.style.transition = 'none';
    });
    document.addEventListener('mousemove', function(e) {
        if (!dragging) return;
        widget.style.left = Math.max(0, e.clientX - ox) + 'px';
        widget.style.top = Math.max(0, e.clientY - oy) + 'px';
        widget.style.right = 'auto';
    });
    document.addEventListener('mouseup', function() { dragging = false; widget.style.transition = ''; });

    function parseDateTime(datum, zeit) {
        if (!datum || !zeit) return null;
        var dm = datum.match(/(\\d{2})\\.(\\d{2})\\.(\\d{4})/);
        var tm = zeit.match(/(\\d{1,2}):(\\d{2})/);
        if (!dm || !tm) return null;
        return new Date(parseInt(dm[3]), parseInt(dm[2]) - 1, parseInt(dm[1]), parseInt(tm[1]), parseInt(tm[2]));
    }

    function update() {
        var now = new Date(), best = null, bestDiff = Infinity;

        SD.forEach(function(s) {
            var badge = document.getElementById('badge-' + s.sid);
            if (badge && badge.classList.contains('on')) return;

            var prepTime = parseDateTime(s.datum, s.prep_start);
            if (!prepTime) return;
            var diff = prepTime.getTime() - now.getTime();

            if (diff > -7200000 && diff < bestDiff) {
                bestDiff = diff; best = { s: s, diff: diff };
            }
        });

        if (!best) { content.innerHTML = '<b style="color:#4caf50">Keine weiteren Prüfungen</b>'; return; }

        var s = best.s, diff = best.diff;
        var farbe = ZF[s.zweig] || '#666';

        if (diff > 0) {
            var sec = Math.floor(diff / 1000);
            var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), sc = sec % 60;
            var cdText = (h > 0 ? h + 'h ' : '') + (m < 10 ? '0' : '') + m + ':' + (sc < 10 ? '0' : '') + sc;
            content.innerHTML = '<div class="widget-name">' + s.vorname + ' ' + s.nachname + '</div>'
                + '<div style="text-align:center"><span class="badge" style="background:' + farbe + ';color:#fff">' + s.klasse + '</span></div>'
                + '<div class="widget-cd">' + cdText + '</div>'
                + '<div class="widget-info">Vorbereitung beginnt' + (s.prep_start ? ' um ' + s.prep_start : '') + '</div>';
        } else {
            content.innerHTML = '<div class="widget-name">' + s.vorname + ' ' + s.nachname + '</div>'
                + '<div style="text-align:center"><span class="badge" style="background:' + farbe + ';color:#fff">' + s.klasse + '</span></div>'
                + '<div class="widget-cd call-alert">JETZT</div>'
                + '<div class="widget-info call-alert">Schüler rufen! Vorbereitung starten!</div>';
        }
    }

    update();
    setInterval(update, 1000);
})();
</script>
</body></html>`);
    } catch (err) {
        console.error(err);
        res.status(500).send('Fehler');
    }
});


// HTTPS-Server starten
const port = process.env.PORT || 3000;
const httpsOpts = {
    key: fs.readFileSync('./cert/key.pem'),
    cert: fs.readFileSync('./cert/cert.pem')
};

https.createServer(httpsOpts, app).listen(port, () => {
    console.log('HTTPS auf https://localhost:' + port);
});

process.on('SIGINT', () => {
    db.close(() => process.exit(0));
});