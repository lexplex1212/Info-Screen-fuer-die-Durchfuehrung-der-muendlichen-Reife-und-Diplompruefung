// ============================================================================
// IMPORTS & GRUNDKONFIGURATION
// ============================================================================
// Express ist das Web-Framework — es nimmt HTTP-Anfragen entgegen und gibt
// Antworten zurück. Jede URL wie /home oder /api/timer/... wird hier definiert.
// 'session' merkt sich, wer eingeloggt ist (über ein Cookie im Browser).
// 'axios' wird nur einmal gebraucht: um beim Microsoft-Login den Token zu holen.
// 'https' + 'fs' erstellen einen verschlüsselten Server mit SSL-Zertifikat.
// 'dotenv' lädt geheime Daten (Client-ID, Secret) aus einer .env-Datei,
// damit sie nicht im Code stehen. 'override: true' überschreibt bestehende Werte.
// 'sqlite3' ist die Datenbank — eine einfache Datei, kein Server nötig.
// 'path' hilft beim Zusammenbauen von Dateipfaden (funktioniert auf jedem OS).
// ============================================================================
const express = require('express');
const app = express();
const session = require('express-session');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config({ override: true });


// ============================================================================
// TIMER-DAUER (in Sekunden)
// ============================================================================
// Diese zwei Werte steuern die gesamte App:
// VORBEREITUNGS_TIMER = wie lange ein Schüler sich vorbereiten darf (20 Min).
// PRUEFUNGS_TIMER = wie lange die mündliche Prüfung dauern soll (12 Min).
// Sie werden überall referenziert: beim Erstellen der DB-Einträge, beim
// Zurücksetzen, beim Berechnen der Restzeit, und im Frontend für die Anzeige.
// Wenn du die Zeiten ändern willst, reicht es, NUR diese zwei Zahlen zu ändern.
// ============================================================================
const VORBEREITUNGS_TIMER = 1200;
const PRUEFUNGS_TIMER = 720;


// ============================================================================
// KLASSEN- UND ZWEIG-KONFIGURATION
// ============================================================================
// Die Schule hat 4 Zweige, jeder mit bestimmten Klassen.
// 'klassen' = welche Klassen gibt es pro Zweig (wird beim DB-Laden gebraucht).
// 'zweigFarben' = Farbe für die Anzeige im Frontend (Karten-Rand, Badges).
// 'zweigZuordnung' = das Gegenteil: von Klasse -> Zweig.
//   Wird gebraucht um die schueler_id zu bauen (z.B. "elektronik_42")
//   und um im Frontend die richtige Farbe zuzuordnen.
// Das sind reine Lookup-Tabellen, sie ändern sich nie zur Laufzeit.
// ============================================================================
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


// ============================================================================
// DATENBANK ÖFFNEN & TABELLEN ERSTELLEN
// ============================================================================
// Die SQLite-Datenbank liegt eine Ebene höher im Ordner 'termineordner'.
// In dieser DB gibt es schon eine Tabelle 'termine' mit allen Schülerdaten
// (Name, Klasse, Fach, Prüfer, Datum, etc.) — die wird NICHT hier erstellt,
// sondern existiert bereits.
//
// Wir erstellen hier ZWEI zusätzliche Tabellen:
//
// 1) 'timer_status' — speichert den LIVE-Zustand jedes Timers:
//    - schueler_id: eindeutiger Key wie "elektronik_42"
//    - state: 'idle' / 'running' / 'paused' / 'prep_done'
//    - started_at: wann der Timer gestartet wurde (Millisekunden-Timestamp)
//    - remaining_seconds: wie viele Sekunden noch übrig sind
//    - exam_state / exam_started_at / exam_remaining: dasselbe für Prüfung
//    - note, themenpool, kommentar: Ergebnis der Prüfung
//    - tatsaechlich_gestartet: Uhrzeit als String ("09:35")
//    - pruefungsdauer: Dauer als String ("11:23")
//
// 2) 'Pruefer_Auswertung' — saubere Export-Tabelle mit allen Ergebnissen:
//    Enthält Schülerinfos + Note + Themenpool + Zeiten.
//    UNIQUE auf (vorname, nachname, klasse) damit keine Duplikate entstehen.
//
// Die ALTER TABLE Befehle sind ein einfacher Migrations-Trick:
// Falls die Tabelle schon existiert aber alte Spalten fehlen, werden sie
// nachträglich hinzugefügt. "duplicate column" Fehler werden ignoriert.
// ============================================================================
const dbPath = path.join(__dirname, '..', 'termineordner', 'termine.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) return console.error('DB-Fehler:', err.message);
    console.log('DB verbunden:', dbPath);
    erstelleTabellen();
});

function erstelleTabellen() {
    // Tabelle 1: Timer-Zustand für jeden Schüler
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
        // Spalten nachrüsten (falls DB schon existiert aber Spalten fehlen)
        const spalten = ['note INTEGER', 'themenpool INTEGER', 'kommentar TEXT',
            'tatsaechlich_gestartet TEXT', 'pruefungsdauer TEXT'];
        spalten.forEach(s => {
            const name = s.split(' ')[0];
            db.run(`ALTER TABLE timer_status ADD COLUMN ${s}`, (err) => {
                if (err && !err.message.includes('duplicate')) {}
            });
        });

        // Tabelle 2: Saubere Export-Tabelle für Auswertung
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


// ============================================================================
// TIMER-INITIALISIERUNG BEIM SERVERSTART
// ============================================================================
// Wenn der Server startet, müssen alle Schüler einen Eintrag in 'timer_status'
// haben. Diese Funktion:
// 1. Holt alle Schüler aus 'termine' deren Klasse konfiguriert ist
// 2. Erstellt für jeden einen Timer-Eintrag mit INSERT OR IGNORE
//    (= nur wenn noch keiner existiert, bestehende werden nicht überschrieben)
// 3. Die schueler_id wird aus Zweig + rowid gebaut (z.B. "elektronik_42")
//
// Das ist wichtig, weil neue Schüler die nach dem letzten Start hinzugefügt
// wurden sonst keinen Timer hätten.
// ============================================================================
function initAlleTimer() {
    const alleKlassen = Object.values(klassen).flat();
    const ph = alleKlassen.map(() => '?').join(',');

    db.all(`SELECT rowid, klasse FROM termine WHERE klasse IN (${ph})`, alleKlassen, (err, rows) => {
        if (err || !rows || !rows.length) return console.log('Keine Schüler gefunden');

        const stmt = db.prepare(`INSERT OR IGNORE INTO timer_status
            (schueler_id, remaining_seconds, state, exam_remaining, exam_state)
            VALUES (?, ${VORBEREITUNGS_TIMER}, 'idle', ${PRUEFUNGS_TIMER}, 'idle')`);

        rows.forEach(row => {
            const zweig = zweigZuordnung[row.klasse];
            if (zweig) stmt.run(zweig + '_' + row.rowid);
        });

        stmt.finalize(() => console.log('Timer-Init: ' + rows.length + ' Schüler'));
    });
}


// ============================================================================
// MIDDLEWARE: JSON-PARSING & SESSION
// ============================================================================
// express.json() = wenn das Frontend Daten per POST schickt (z.B. Note),
//   wird der JSON-Body automatisch geparst und steht in req.body bereit.
//
// session() = verwaltet Benutzer-Sitzungen. Jeder Browser bekommt ein Cookie.
//   'secret' signiert das Cookie (damit es nicht gefälscht werden kann).
//   'secure: true' = Cookie nur über HTTPS senden.
//   'sameSite: lax' = Schutz vor Cross-Site-Request-Forgery Angriffen.
//
// requireAuth() = Schutzfunktion. Wird vor jede Route gehängt die nur für
//   eingeloggte User zugänglich sein soll. Prüft ob session.user existiert.
//   Wenn nicht → zurück zur Login-Seite.
// ============================================================================
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


// ============================================================================
// HILFSFUNKTIONEN
// ============================================================================
// base64UrlDecode: Wird beim Microsoft-Login gebraucht. Ein JWT-Token besteht
//   aus 3 Base64-kodierten Teilen. Der mittlere enthält die Userdaten (Email).
//   Diese Funktion dekodiert diesen Teil.
//
// getAlleSchueler: Liest ALLE Schüler aus der termine-Tabelle die zu einer
//   konfigurierten Klasse gehören. Sortiert nach Klasse, Nachname, Vorname.
//   Gibt ein Promise zurück (wird mit await aufgerufen).
//
// getSchuelerInfoFromSid: Extrahiert aus einer schueler_id wie "elektronik_42"
//   die Zahl 42 und holt den Schüler aus 'termine'. Wird beim Reset gebraucht,
//   um den zugehörigen Eintrag in Pruefer_Auswertung zu löschen.
// ============================================================================
function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString('utf8');
}

function getAlleSchueler() {
    return new Promise(resolve => {
        const alleKlassen = Object.values(klassen).flat();
        const ph = alleKlassen.map(() => '?').join(',');
        db.all(`SELECT rowid, * FROM termine WHERE klasse IN (${ph})
                ORDER BY klasse, nachname, vorname`, alleKlassen, (err, rows) => {
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


// ============================================================================
// TIMER-BERECHNUNG: RESTZEIT LIVE AUSRECHNEN
// ============================================================================
// Der Server hat KEINE eigenen setInterval-Timer laufen. Stattdessen speichert
// er nur den Zeitpunkt wann gestartet wurde (started_at) und die Restzeit
// zum Zeitpunkt des Starts (remaining_seconds).
//
// Bei jedem Abruf wird die aktuelle Restzeit so berechnet:
//   restzeit = remaining_seconds - (jetzt - started_at)
//
// Diese Funktion nimmt einen DB-Eintrag und gibt ein berechnetes Objekt zurück
// mit den aktuellen Werten. Wird von GET /api/timer/:id und /api/timers/all
// verwendet (beide Stellen brauchen die gleiche Logik).
// ============================================================================
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

    // Wenn Vorbereitung läuft: Restzeit = gespeichert - vergangene Zeit
    if (row.state === 'running' && row.started_at) {
        t.remaining_seconds = Math.max(0, row.remaining_seconds - (now - row.started_at) / 1000);
        if (t.remaining_seconds <= 0) t.state = 'prep_done';
    }

    // Wenn Prüfung läuft: dasselbe (kann negativ werden = Überziehung)
    if (row.exam_state === 'running' && row.exam_started_at) {
        t.exam_remaining = row.exam_remaining - (now - row.exam_started_at) / 1000;
    }

    return t;
}


// ============================================================================
// API: EINZELNEN TIMER ABRUFEN
// ============================================================================
// GET /api/timer/elektronik_42
// Gibt den aktuellen Zustand eines Schüler-Timers zurück.
// Wenn kein Eintrag existiert, wird ein Default zurückgegeben.
// Wenn ein Eintrag existiert, wird die Restzeit live berechnet.
// Das Frontend ruft das nicht ständig ab — es nutzt /api/timers/all beim Laden
// und rechnet dann selbst mit setInterval weiter.
// ============================================================================
app.get('/api/timer/:id', requireAuth, (req, res) => {
    db.get('SELECT * FROM timer_status WHERE schueler_id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json({
            state: 'idle', remaining_seconds: VORBEREITUNGS_TIMER,
            exam_state: 'idle', exam_remaining: PRUEFUNGS_TIMER
        });
        res.json(berechneTimerStatus(row));
    });
});


// ============================================================================
// API: VORBEREITUNGS-TIMER STEUERN (start / pause / resume / skip / reset)
// ============================================================================
// POST /api/timer/:id/start
//   Setzt state='running' und started_at=jetzt. remaining_seconds wird auf
//   den vollen Wert gesetzt. INSERT...ON CONFLICT = erstellt oder aktualisiert.
//
// POST /api/timer/:id/pause
//   Das Frontend schickt die aktuelle remaining_seconds mit (weil es genauer
//   weiß wie viel Zeit übrig ist). started_at wird auf NULL gesetzt.
//
// POST /api/timer/:id/resume
//   Setzt ein neues started_at. Die gespeicherte remaining_seconds bleibt,
//   und die Berechnung remaining - (jetzt - started_at) stimmt wieder.
//
// POST /api/timer/:id/prep_done
//   Markiert Vorbereitung als fertig. Wird aufgerufen wenn Timer abläuft
//   ODER wenn "Überspringen" gedrückt wird.
//
// POST /api/timer/:id/reset
//   Setzt ALLES zurück: beide Timer, Ergebnisse, Kommentar.
//   Löscht auch den Eintrag in Pruefer_Auswertung (damit Export konsistent).
// ============================================================================
app.post('/api/timer/:id/start', requireAuth, (req, res) => {
    const now = Date.now();
    db.run(`INSERT INTO timer_status (schueler_id, started_at, remaining_seconds, state)
            VALUES (?, ?, ${VORBEREITUNGS_TIMER}, 'running')
            ON CONFLICT(schueler_id) DO UPDATE SET
            started_at=?, remaining_seconds=${VORBEREITUNGS_TIMER}, state='running', paused_at=NULL`,
        [req.params.id, now, now], err => {
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
    db.run(`UPDATE timer_status SET
            state='idle', started_at=NULL, paused_at=NULL,
            remaining_seconds=${VORBEREITUNGS_TIMER},
            exam_state='idle', exam_started_at=NULL, exam_remaining=${PRUEFUNGS_TIMER},
            note=NULL, themenpool=NULL, kommentar=NULL,
            tatsaechlich_gestartet=NULL, pruefungsdauer=NULL
            WHERE schueler_id=?`,
        [req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });
            // Auch aus der Export-Tabelle löschen
            if (info) {
                db.run('DELETE FROM Pruefer_Auswertung WHERE vorname=? AND nachname=? AND klasse=?',
                    [info.vorname || '', info.nachname || '', info.klasse || '']);
            }
            res.json({ ok: true });
        });
});


// ============================================================================
// API: PRÜFUNGS-TIMER STEUERN (exam_start / exam_pause / exam_resume)
// ============================================================================
// POST /api/timer/:id/exam_start
//   Startet den Prüfungs-Timer. Speichert auch die Uhrzeit als lesbaren
//   String (z.B. "09:35") — das wird für den Export gebraucht.
//   exam_remaining wird auf den vollen Wert gesetzt.
//
// POST /api/timer/:id/exam_pause
//   Wie bei Vorbereitung: Frontend schickt aktuelle Restzeit mit.
//
// POST /api/timer/:id/exam_resume
//   Neues exam_started_at setzen, Berechnung stimmt dann wieder.
// ============================================================================
app.post('/api/timer/:id/exam_start', requireAuth, (req, res) => {
    const now = Date.now();
    const d = new Date(now);
    const uhrzeit = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

    db.run(`UPDATE timer_status SET exam_state='running', exam_started_at=?,
            exam_remaining=${PRUEFUNGS_TIMER}, tatsaechlich_gestartet=?
            WHERE schueler_id=?`,
        [now, uhrzeit, req.params.id], err => {
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


// ============================================================================
// API: PRÜFUNG ABSCHLIESSEN
// ============================================================================
// POST /api/timer/:id/exam_finish
// Der wichtigste Endpunkt. Speichert das Ergebnis an ZWEI Stellen:
//
// 1) timer_status — damit die Live-Anzeige "Abgeschlossen" zeigt
// 2) Pruefer_Auswertung — saubere Export-Tabelle mit allen Infos
//
// Note und Themenpool sind Pflichtfelder.
// ON CONFLICT DO UPDATE = wenn der Schüler schon existiert (z.B. nach Reset
// und erneutem Abschluss), wird der alte Eintrag überschrieben.
//
// Das Frontend schickt ALLE Daten mit (Name, Klasse, Fach, Prüfer etc.),
// weil es diese aus SCHUELER_DATA kennt. Der Server muss sie nicht nochmal
// aus der DB lesen.
// ============================================================================
app.post('/api/timer/:id/exam_finish', requireAuth, (req, res) => {
    const { note, themenpool, kommentar, pruefungsdauer,
        vorname, nachname, klasse, fach, pruefer, beisitz,
        datum, geplant_start, tatsaechlich_gestartet } = req.body;

    if (!note || !themenpool) return res.status(400).json({ error: 'Note und Themenpool sind Pflicht' });

    // Schritt 1: timer_status aktualisieren
    db.run(`UPDATE timer_status SET exam_state='done', note=?, themenpool=?,
            kommentar=?, pruefungsdauer=? WHERE schueler_id=?`,
        [note, themenpool, kommentar || '', pruefungsdauer || '', req.params.id], err => {
            if (err) return res.status(500).json({ error: err.message });

            // Schritt 2: In Export-Tabelle einfügen/aktualisieren
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


// ============================================================================
// API: ALLE TIMER AUF EINMAL LADEN
// ============================================================================
// GET /api/timers/all
// Wird einmal beim Laden der Seite aufgerufen. Gibt ein Objekt zurück:
//   { "elektronik_42": { state, remaining_seconds, ... }, "elektronik_43": ... }
// Für jeden Eintrag wird die Restzeit live berechnet (berechneTimerStatus).
// Das Frontend übernimmt dann die Werte und tickt selbst per setInterval weiter.
// ============================================================================
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


// ============================================================================
// API: AUSWERTUNG EXPORTIEREN
// ============================================================================
// GET /api/auswertung
// Gibt alle abgeschlossenen Prüfungen aus der Export-Tabelle zurück.
// Sortiert nach Klasse, Nachname, Vorname.
// Kann z.B. von einem Excel-Export-Tool abgerufen werden.
// ============================================================================
app.get('/api/auswertung', requireAuth, (req, res) => {
    db.all('SELECT * FROM Pruefer_Auswertung ORDER BY klasse, nachname, vorname', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});


// ============================================================================
// LOGIN-SYSTEM: MICROSOFT OAUTH2
// ============================================================================
// Der Login-Ablauf funktioniert so:
//
// 1. User klickt "Mit Microsoft einloggen" → wird zu Microsoft weitergeleitet
//    (GET /microsoft-login → redirect zu login.microsoftonline.com)
//
// 2. User loggt sich bei Microsoft ein → Microsoft leitet zurück zu
//    /auth/callback mit einem 'code' Parameter in der URL
//
// 3. Wir tauschen den 'code' gegen ein 'id_token' ein (POST an Microsoft)
//    Das id_token ist ein JWT (JSON Web Token) mit 3 Base64-Teilen.
//    Der mittlere Teil enthält die Userdaten.
//
// 4. Wir dekodieren den mittleren Teil und holen die Email raus.
//    Nur @ms.bulme.at Adressen werden akzeptiert.
//
// 5. Bei Erfolg: session.user setzen → User ist eingeloggt.
//    Ab jetzt erkennt requireAuth() diesen User.
//
// GET /logout → Session zerstören → Cookie wird ungültig.
// ============================================================================
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
        // Code gegen Token tauschen
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

        // JWT dekodieren und Email extrahieren
        const payload = JSON.parse(base64UrlDecode(tr.data.id_token.split('.')[1]));
        const email = (payload.preferred_username || payload.upn || payload.email || '').toLowerCase();

        // Nur @ms.bulme.at erlaubt
        if (!email || !email.endsWith('@ms.bulme.at')) {
            return res.status(403).send('Zugriff verweigert. Nur @ms.bulme.at. <a href="/">Zurück</a>');
        }

        req.session.user = { email };
        res.redirect('/home');
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).send('Login-Fehler. <a href="/">Zurück</a>');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});


// ============================================================================
// HAUPTSEITE: /home — HTML + CSS + FRONTEND-JAVASCRIPT
// ============================================================================
// Diese Route generiert die komplette Seite. Ablauf:
//
// 1. Alle Schüler aus der DB laden
// 2. Für jeden Schüler eine HTML-Karte erstellen (Name, Klasse, Fach, etc.)
// 3. Die Schülerdaten als JavaScript-Variable (SCHUELER_DATA) in die Seite
//    einbetten, damit das Frontend darauf zugreifen kann ohne weitere API-Calls
// 4. Das Frontend-JavaScript (Timer-Logik, Button-Handler, Widget) einfügen
//
// AUFBAU DER SEITE:
// - Top-Bar mit Titel und Logout
// - Liste aller Schüler-Karten (klickbar zum Aufklappen)
// - "Nächste Prüfung" Widget (zeigt wer als nächstes dran ist)
// - Bestätigungs-Dialog für Reset
//
// JEDE KARTE hat:
// - Farbigen Rand je nach Zweig
// - Progress-Bar (füllt sich mit Timer-Fortschritt)
// - Name, Klasse-Badge, Fach/Prüfer/Beisitz Info
// - Aufklappbaren Bereich mit Timer-Steuerung
// ============================================================================
app.get('/home', requireAuth, async (req, res) => {
    try {
        const schueler = await getAlleSchueler();

        // ============================================================
        // HTML-KARTEN FÜR JEDEN SCHÜLER GENERIEREN
        // ============================================================
        // Jede Karte bekommt eine data-sid (z.B. "elektronik_42") als
        // Identifier. IDs wie "card-elektronik_42", "progress-elektronik_42"
        // etc. werden vom JavaScript verwendet um die richtigen Elemente
        // zu finden und zu aktualisieren.
        // ============================================================
        const cardsHtml = schueler.map((s, i) => {
            const zweig = zweigZuordnung[s.klasse] || 'elektronik';
            const sid = zweig + '_' + (s.rowid || i);
            const farbe = zweigFarben[zweig] || '#666';
            // Dunkle Textfarbe für helle Hintergründe (Elektrotechnik=rot, Wirtschaft=gelb)
            const textFarbe = (zweig === 'elektrotechnik' || zweig === 'wirtschaft') ? '#333' : '#fff';

            return `<div class="card" id="card-${sid}" data-sid="${sid}" style="border-left:4px solid ${farbe}">
                <div class="progress" id="progress-${sid}"></div>
                <div class="card-inner">
                    <div class="card-top">
                        <span class="name">${s.vorname || ''} ${s.nachname || ''}</span>
                        ${s.klasse ? `<span class="badge" style="background:${farbe};color:${textFarbe}">${s.klasse}</span>` : ''}
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

        // ============================================================
        // SCHÜLER-DATEN ALS JS-VARIABLE EINBETTEN
        // ============================================================
        // Das Frontend braucht diese Daten um beim "Abschließen" einer
        // Prüfung alle Infos (Name, Fach, Prüfer etc.) an den Server
        // mitzuschicken. Außerdem braucht das Widget die prep_start
        // Zeit um zu berechnen wer als nächstes dran ist.
        // ============================================================
        const schuelerJson = JSON.stringify(schueler.map((s, i) => {
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
        }));

        res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HTL Matura</title>

<!-- ================================================================
     CSS: STYLING DER GESAMTEN SEITE
     ================================================================
     Alles in einer Datei (kein separates CSS-File nötig).
     Wichtige Klassen:
     - .card = eine Schüler-Karte (klickbar, aufklappbar)
     - .progress = der Fortschrittsbalken (absolut positioniert, füllt Karte)
     - .timer-badge = kleines Badge neben dem Namen (zeigt Status kompakt an)
     - .expand-area = aufklappbarer Bereich mit Timer + Buttons
     - .widget = das "Nächste Prüfung" Fenster (fest positioniert, draggable)
     ================================================================ -->
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Arial,sans-serif;background:#07175e;min-height:100vh;padding:20px}

/* Top-Bar */
.top{display:flex;justify-content:space-between;align-items:center;max-width:900px;margin:0 auto 15px;color:#fff}
.top a{color:#fff;background:rgba(255,255,255,.15);padding:6px 16px;border-radius:6px;text-decoration:none;font-size:.85em}

/* Schüler-Karten */
.liste{max-width:900px;margin:0 auto}
.card{position:relative;margin:6px 0;border-radius:8px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1);cursor:pointer;overflow:hidden;transition:box-shadow .2s}
.card:hover{box-shadow:0 2px 8px rgba(0,0,0,.15)}
.progress{position:absolute;top:0;left:0;height:100%;width:0%;z-index:0;pointer-events:none;transition:width .8s linear}
.card-inner{position:relative;z-index:1;padding:10px 14px}
.card-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.name{font-weight:700;font-size:1em}
.badge{padding:2px 8px;border-radius:10px;font-size:.7em;font-weight:700}
.meta{color:#777;font-size:.75em}

/* Timer-Badge (neben Name) */
.timer-badge{display:none;padding:2px 8px;border-radius:10px;font-size:.75em;font-weight:700}
.timer-badge.on{display:inline-block}

/* Aufklappbarer Bereich */
.expand-area{max-height:0;overflow:hidden;transition:max-height .3s ease}
.card.open .expand-area{max-height:500px}
.expand-inner{border-top:1px solid #eee;padding:12px 0 4px}

/* Timer-Anzeige */
.timer-big{font-size:2em;font-weight:700;text-align:center;font-variant-numeric:tabular-nums;letter-spacing:2px}
.timer-label{text-align:center;font-size:.85em;color:#666;margin:4px 0 8px}

/* Buttons */
.btns{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:8px 0}
.btn{padding:8px 18px;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:.9em}
.btn-start{background:#f0c230;color:#333}
.btn-pause{background:#ff9800;color:#fff}
.btn-resume{background:#4caf50;color:#fff}
.btn-reset{background:#f44336;color:#fff}
.btn-skip{background:#9c27b0;color:#fff}
.btn-exam{background:#2196f3;color:#fff}
.btn-finish{background:#4caf50;color:#fff}

/* Formular */
.form{margin-top:10px;padding:10px;background:#f9f9f9;border-radius:8px;border:1px solid #e0e0e0}
.form h4{text-align:center;margin-bottom:8px}
.form-row{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0}
.form-row label{font-weight:600;font-size:.85em}
.form-row select,.form-row textarea{padding:5px;border:1px solid #ddd;border-radius:5px;font-size:.9em}
.form-row textarea{width:100%;min-height:36px;resize:vertical}

/* Ergebnis-Karte */
.done{text-align:center;padding:10px}
.done h4{color:#4caf50}
.done-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:8px;text-align:left;font-size:.9em}
.done-grid div{padding:4px 8px;background:#f5f5f5;border-radius:4px}

/* Widget: Nächste Prüfung */
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

<!-- ================================================================
     TOP-BAR: Titel und Logout-Button
     ================================================================ -->
<div class="top">
    <h1>Matura Prüfungen</h1>
    <a href="/logout">Logout</a>
</div>

<!-- ================================================================
     SCHÜLER-KARTEN: Eine pro Schüler, serverseitig generiert
     ================================================================ -->
<div class="liste">${cardsHtml}</div>

<!-- ================================================================
     WIDGET: Zeigt an wer als nächstes dran ist
     ================================================================ -->
<div class="widget" id="widget">
    <div class="widget-head" id="wHead">
        <span>Nächste Vorbereitung</span>
        <button onclick="toggleWidget()" style="background:none;border:1px solid rgba(255,255,255,.5);color:#fff;border-radius:50%;width:24px;height:24px;cursor:pointer" id="wBtn">−</button>
    </div>
    <div class="widget-body" id="wBody">
        <div id="wContent" style="text-align:center;color:#999">Lade...</div>
    </div>
</div>

<!-- ================================================================
     SCHÜLER-DATEN ALS JS-VARIABLE
     Wird vom Frontend-JavaScript benutzt um beim Abschließen alle
     Infos (Name, Fach, Prüfer) an den Server mitzuschicken, und
     vom Widget um die nächste Prüfung zu berechnen.
     ================================================================ -->
<script>
var SD = ${schuelerJson};
var ZF = ${JSON.stringify(zweigFarben)};
var PREP = ${VORBEREITUNGS_TIMER};
var EXAM = ${PRUEFUNGS_TIMER};
</script>

<script>
// ================================================================
// FRONTEND-JAVASCRIPT: TIMER-LOGIK & EVENT-HANDLING
// ================================================================
// Alles in einem IIFE (Immediately Invoked Function Expression)
// gekapselt, damit keine globalen Variablen entstehen.
//
// ARCHITEKTUR:
// - T = Objekt mit Timer-Zustand pro Schüler (lokal im Browser)
// - Jede Sekunde tickt ein setInterval und zählt die Restzeit runter
// - Bei jeder Aktion (Start, Pause etc.) wird ZUERST die UI aktualisiert,
//   DANN ein API-Call an den Server geschickt ("optimistisch")
// - render(sid) baut den kompletten aufklappbaren Bereich neu
// - tick(sid) aktualisiert nur die sich ändernden Elemente (Performance)
// ================================================================
(function(){

// ================================================================
// T = lokaler Timer-Zustand pro Schüler
// ================================================================
// Für jeden Schüler wird ein Objekt angelegt:
//   state: 'idle'|'running'|'paused'|'prep_done' (Vorbereitungs-Phase)
//   rem: verbleibende Sekunden Vorbereitung
//   iid: setInterval-ID für Vorbereitung (zum Stoppen)
//   examState: 'idle'|'running'|'paused'|'done' (Prüfungs-Phase)
//   examRem: verbleibende Sekunden Prüfung (kann negativ werden!)
//   eiid: setInterval-ID für Prüfung
//   note/themen/komm: eingetragenes Ergebnis
//   startedAt: Uhrzeit als String wann Prüfung begann
//   dauer: Prüfungsdauer als String
// ================================================================
var T = {};
function g(sid) {
    if (!T[sid]) T[sid] = {
        state:'idle', rem:PREP, iid:null,
        examState:'idle', examRem:EXAM, eiid:null,
        note:null, themen:null, komm:'',
        startedAt:null, dauer:null
    };
    return T[sid];
}

// ================================================================
// FORMATIERUNGS-HILFSFUNKTIONEN
// ================================================================
// fmt(sekunden) → "MM:SS" (bei negativen Werten "+MM:SS" für Überziehung)
// nowHHMM() → aktuelle Uhrzeit als "HH:MM"
// fmtDauer(sekunden) → Dauer als "MM:SS" (immer positiv)
// ================================================================
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

// ================================================================
// SCHÜLER-LOOKUP
// ================================================================
// Findet in SD (SCHUELER_DATA) den Eintrag mit der passenden sid.
// Wird beim Abschließen gebraucht um Name/Fach/Prüfer mitzuschicken.
// ================================================================
function find(sid) {
    for (var i = 0; i < SD.length; i++) {
        if (SD[i].sid === sid) return SD[i];
    }
    return {};
}

// ================================================================
// TICK-FUNKTIONEN: Werden jede Sekunde aufgerufen
// ================================================================
// prepTick: Zählt Vorbereitungs-Timer um 1 Sekunde runter.
//   Bei 0 → state wird 'prep_done', Interval wird gestoppt,
//   Server wird informiert, Karte wird neu gerendert.
//
// examTick: Zählt Prüfungs-Timer runter. Kann ins Negative gehen
//   (Überziehung) — wird dann rot angezeigt aber nicht gestoppt.
//
// Beide rufen nur tickUpdate() auf (aktualisiert Fortschrittsbalken
// und Badge), NICHT render() (das wäre zu langsam jede Sekunde).
// ================================================================
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

// ================================================================
// TICK-UPDATE: Aktualisiert nur die sich ändernden Elemente
// ================================================================
// Statt jede Sekunde den gesamten HTML-Inhalt neu zu bauen (was
// Formular-Eingaben zerstören würde), werden hier nur 3 Dinge
// aktualisiert:
// 1. Fortschrittsbalken (Breite + Farbe)
// 2. Timer-Badge neben dem Namen
// 3. Die große Zeitanzeige im aufgeklappten Bereich
//
// Die Farbe des Fortschrittsbalkens ändert sich mit dem Fortschritt:
// Vorbereitung: orange → rot
// Prüfung: gelb → grün (bei Überziehung: rot)
// ================================================================
function tickUpdate(sid) {
    var t = g(sid);
    var prog = document.getElementById('progress-' + sid);
    var badge = document.getElementById('badge-' + sid);
    var timeEl = document.querySelector('#exp-' + sid + ' .timer-big');
    if (!prog) return;

    if (t.state === 'running') {
        var p = Math.max(0, Math.min(1, 1 - t.rem / PREP));
        prog.style.width = (p * 100) + '%';
        prog.style.backgroundColor = 'rgba(231,76,60,' + (0.15 + p * 0.25) + ')';
        if (badge) { badge.className = 'timer-badge on'; badge.style.background = '#ffe0cc'; badge.style.color = '#c0392b'; badge.textContent = fmt(t.rem); }
        if (timeEl) timeEl.textContent = fmt(t.rem);
    }
    else if (t.examState === 'running') {
        var ep = t.examRem >= 0 ? Math.max(0, Math.min(1, 1 - t.examRem / EXAM)) : 1;
        prog.style.width = (ep * 100) + '%';
        prog.style.backgroundColor = t.examRem < 0 ? 'rgba(231,76,60,0.3)' : 'rgba(76,175,80,' + (0.1 + ep * 0.3) + ')';
        if (badge) { badge.className = 'timer-badge on'; badge.style.background = '#fff3cd'; badge.style.color = '#856404'; badge.textContent = (t.examRem < 0 ? 'ÜBER ' : '') + fmt(t.examRem); }
        if (timeEl) { timeEl.textContent = (t.examRem < 0 ? '+' : '') + fmt(t.examRem); timeEl.style.color = t.examRem < 0 ? '#c0392b' : '#222'; }
    }
}

// ================================================================
// RENDER: Baut den aufklappbaren Bereich einer Karte komplett neu
// ================================================================
// Wird aufgerufen bei Zustandswechseln (nicht jede Sekunde!).
// Je nach Zustand wird unterschiedliches HTML erzeugt:
//
// idle → "Vorbereitung starten" Button
// running → Countdown + Pause/Skip/Reset Buttons
// paused → Countdown (eingefroren) + Fortsetzen/Skip/Reset
// prep_done + exam idle → "Prüfung starten" Button
// exam running/paused → Countdown + Formular (Note, Themenpool)
// exam done → Zusammenfassung (Note, Themenpool, Dauer, Kommentar)
//
// Aktualisiert auch: Fortschrittsbalken + Badge
// ================================================================
function render(sid) {
    var t = g(sid);
    var prog = document.getElementById('progress-' + sid);
    var badge = document.getElementById('badge-' + sid);
    var exp = document.getElementById('exp-' + sid);
    if (!exp) return;
    var h = '<div class="expand-inner">';

    // --- IDLE: Noch nicht gestartet ---
    if (t.state === 'idle') {
        prog.style.width = '0%';
        badge.className = 'timer-badge';
        h += '<div class="timer-big">' + fmt(PREP) + '</div>'
           + '<div class="timer-label">Vorbereitung</div>'
           + '<div class="btns"><button class="btn btn-start" data-a="start" data-s="' + sid + '">Vorbereitung starten</button></div>';
    }
    // --- VORBEREITUNG LÄUFT ---
    else if (t.state === 'running') {
        tickUpdate(sid);
        h += '<div class="timer-big">' + fmt(t.rem) + '</div>'
           + '<div class="timer-label">Vorbereitung läuft...</div>'
           + '<div class="btns">'
           + '<button class="btn btn-pause" data-a="pause" data-s="' + sid + '">Pause</button>'
           + '<button class="btn btn-skip" data-a="skip" data-s="' + sid + '">Überspringen</button>'
           + '<button class="btn btn-reset" data-a="reset" data-s="' + sid + '">Reset</button></div>';
    }
    // --- PAUSIERT ---
    else if (t.state === 'paused') {
        badge.className = 'timer-badge on'; badge.style.background = '#ff9800'; badge.style.color = '#fff'; badge.textContent = fmt(t.rem) + ' ⏸';
        h += '<div class="timer-big">' + fmt(t.rem) + '</div>'
           + '<div class="timer-label">Pausiert</div>'
           + '<div class="btns">'
           + '<button class="btn btn-resume" data-a="resume" data-s="' + sid + '">Fortsetzen</button>'
           + '<button class="btn btn-skip" data-a="skip" data-s="' + sid + '">Überspringen</button>'
           + '<button class="btn btn-reset" data-a="reset" data-s="' + sid + '">Reset</button></div>';
    }
    // --- VORBEREITUNG FERTIG, PRÜFUNG NOCH NICHT GESTARTET ---
    else if (t.state === 'prep_done' && t.examState === 'idle') {
        prog.style.width = '100%'; prog.style.backgroundColor = 'rgba(255,152,0,0.3)';
        badge.className = 'timer-badge on'; badge.style.background = '#ff9800'; badge.style.color = '#fff'; badge.textContent = 'Vorb. fertig ✓';
        h += '<div class="timer-big" style="color:#e67e22">00:00</div>'
           + '<div class="timer-label" style="color:#e67e22;font-weight:700">Vorbereitung fertig</div>'
           + '<div class="btns"><button class="btn btn-exam" data-a="exam_start" data-s="' + sid + '">Prüfung starten</button></div>';
    }
    // --- PRÜFUNG LÄUFT oder PAUSIERT ---
    else if (t.examState === 'running' || t.examState === 'paused') {
        tickUpdate(sid);
        var isPaused = t.examState === 'paused';
        h += '<div class="timer-big">' + (t.examRem < 0 ? '+' : '') + fmt(t.examRem) + '</div>'
           + '<div class="timer-label">' + (t.examRem < 0 ? '<b style="color:#c0392b">Überzogen!</b>' : (isPaused ? 'Prüfung pausiert' : 'Prüfung läuft...')) + '</div>'
           + '<div class="btns">';
        if (isPaused) h += '<button class="btn btn-resume" data-a="exam_resume" data-s="' + sid + '">Fortsetzen</button>';
        else h += '<button class="btn btn-pause" data-a="exam_pause" data-s="' + sid + '">Pause</button>';
        h += '</div>';

        // Ergebnis-Formular (Note + Themenpool + Kommentar)
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
    // --- PRÜFUNG ABGESCHLOSSEN ---
    else if (t.examState === 'done') {
        prog.style.width = '100%'; prog.style.backgroundColor = 'rgba(76,175,80,0.25)';
        badge.className = 'timer-badge on'; badge.style.background = '#4caf50'; badge.style.color = '#fff'; badge.textContent = 'Fertig ✓';
        var info = find(sid);
        h += '<div class="done"><h4>Abgeschlossen ✓</h4><div class="done-grid">'
           + '<div><b>Note:</b> ' + t.note + '</div>'
           + '<div><b>Themenpool:</b> ' + t.themen + '</div>'
           + (info.exam_start ? '<div><b>Geplant:</b> ' + info.exam_start + '</div>' : '')
           + (t.startedAt ? '<div><b>Tatsächlich:</b> ' + t.startedAt + '</div>' : '')
           + (t.dauer ? '<div><b>Dauer:</b> ' + t.dauer + '</div>' : '')
           + (t.komm ? '<div style="grid-column:1/-1"><b>Kommentar:</b> ' + t.komm + '</div>' : '')
           + '</div></div>';
    }

    h += '</div>';
    exp.innerHTML = h;
}

// ================================================================
// API-CALL: Sendet Aktionen an den Server
// ================================================================
// Einfacher Wrapper für fetch(). Sendet POST-Requests mit JSON-Body.
// Arbeitet "optimistisch": Die UI wird SOFORT aktualisiert, der
// Server-Call läuft im Hintergrund. Fehler werden nur geloggt.
// Das fühlt sich für den User schneller an.
// ================================================================
function api(sid, action, body) {
    var opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    fetch('/api/timer/' + sid + '/' + action, opts).catch(function(e) { console.warn('Sync:', e); });
}

// ================================================================
// KARTEN SORTIEREN: Abgeschlossene nach unten
// ================================================================
// Durchläuft alle Karten und sortiert sie so, dass Schüler mit
// examState='done' am Ende stehen. Alle anderen behalten ihre
// ursprüngliche Reihenfolge. Wird nach jedem Abschluss aufgerufen.
// ================================================================
function sortCards() {
    var liste = document.querySelector('.liste');
    if (!liste) return;
    var cards = Array.from(liste.querySelectorAll('.card'));
    cards.sort(function(a, b) {
        var sa = g(a.dataset.sid), sb = g(b.dataset.sid);
        return (sa.examState === 'done' ? 1 : 0) - (sb.examState === 'done' ? 1 : 0);
    });
    cards.forEach(function(c) { liste.appendChild(c); });
}

// ================================================================
// EVENT-HANDLER: Ein einziger Handler für alle Buttons
// ================================================================
// Statt jedem Button einen eigenen Listener zu geben, nutzen wir
// Event-Delegation: Ein Listener auf document fängt ALLE Clicks.
// Die Buttons haben data-a (action) und data-s (sid) Attribute.
//
// Ablauf für jede Aktion:
// 1. Lokalen Zustand T[sid] aktualisieren
// 2. setInterval starten/stoppen je nach Aktion
// 3. render(sid) aufrufen (UI aktualisieren)
// 4. api() aufrufen (Server informieren)
//
// Der Reset zeigt einen confirm()-Dialog (einfacher als ein Overlay).
// ================================================================
document.addEventListener('click', function(e) {
    var btn = e.target.closest('.btn[data-a]');
    if (btn) {
        e.stopPropagation();
        var a = btn.dataset.a, sid = btn.dataset.s, t = g(sid);

        if (a === 'start') {
            if (t.iid) clearInterval(t.iid);
            t.state = 'running'; t.rem = PREP;
            t.iid = setInterval(function() { prepTick(sid); }, 1000);
            render(sid); api(sid, 'start');
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
            t.state = 'idle'; t.rem = PREP; t.examState = 'idle'; t.examRem = EXAM;
            t.note = null; t.themen = null; t.komm = ''; t.startedAt = null; t.dauer = null;
            render(sid); api(sid, 'reset'); sortCards();
        }
        else if (a === 'exam_start') {
            t.examState = 'running'; t.examRem = EXAM; t.startedAt = nowHHMM();
            if (t.eiid) clearInterval(t.eiid);
            t.eiid = setInterval(function() { examTick(sid); }, 1000);
            var card2 = document.getElementById('card-' + sid);
            if (card2) card2.classList.add('open');
            render(sid); api(sid, 'exam_start');
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
            t.dauer = fmtDauer(EXAM - t.examRem);
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
        return;
    }

    // Klick auf Formular → nicht zuklappen
    if (e.target.closest('.form')) return;

    // Klick auf Karte → aufklappen/zuklappen
    var card = e.target.closest('.card');
    if (card) card.classList.toggle('open');
});

// ================================================================
// FORMULAR-WERTE LIVE SPEICHERN
// ================================================================
// Wenn jemand im Dropdown die Note oder den Themenpool ändert,
// wird der Wert sofort in T[sid] gespeichert. Beim Abschließen
// werden die Werte aus den DOM-Elementen gelesen, aber als Fallback
// sind sie auch im lokalen Zustand.
// ================================================================
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

// ================================================================
// INITIALER LOAD: Alle Timer vom Server laden
// ================================================================
// Beim Seitenaufruf wird /api/timers/all abgerufen. Das gibt den
// Zustand ALLER Schüler-Timer zurück. Für jeden:
// 1. Lokalen Zustand in T[sid] übernehmen
// 2. Falls Timer läuft: setInterval starten
// 3. render(sid) aufrufen um die Karte korrekt anzuzeigen
// Am Ende werden die Karten sortiert (Abgeschlossene nach unten).
// ================================================================
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
        t.examRem = info.exam_remaining !== undefined ? info.exam_remaining : EXAM;
        t.note = info.note || null;
        t.themen = info.themenpool || null;
        t.komm = info.kommentar || '';
        t.startedAt = info.tatsaechlich_gestartet || null;
        t.dauer = info.pruefungsdauer || null;
        if (t.state === 'prep_done') t.rem = 0;

        // Laufende Timer: Interval starten damit sie weitertickern
        if (t.state === 'running' && t.rem > 0) {
            (function(id) { g(id).iid = setInterval(function() { prepTick(id); }, 1000); })(sid);
        }
        if (t.examState === 'running') {
            (function(id) { g(id).eiid = setInterval(function() { examTick(id); }, 1000); })(sid);
        }
        render(sid);
    }
    sortCards();
}).catch(function(e) { console.warn('Load:', e); });

})();

// ================================================================
// WIDGET: "NÄCHSTE VORBEREITUNG"
// ================================================================
// Dieses Widget zeigt an, welcher Schüler als nächstes dran ist.
// Es sucht unter allen Schülern die NOCH NICHT gestartet sind nach
// demjenigen, dessen geplante Vorbereitungszeit am nächsten liegt.
//
// Ablauf jede Sekunde:
// 1. Alle Schüler durchgehen, aktive rausfiltern (Badge prüfen)
// 2. Für jeden inaktiven: Datum + Vorbereitungszeit parsen
// 3. Differenz zur aktuellen Zeit berechnen
// 4. Den mit der kleinsten positiven Differenz anzeigen
// 5. Bei negativer Differenz (überfällig): "JETZT" + "Schüler rufen!"
//
// Das Widget ist per Maus verschiebbar (drag) und einklappbar.
// ================================================================
function toggleWidget() {
    var b = document.getElementById('wBody');
    var btn = document.getElementById('wBtn');
    b.classList.toggle('hide');
    btn.textContent = b.classList.contains('hide') ? '+' : '−';
}

(function() {
    var widget = document.getElementById('widget');
    var wHead = document.getElementById('wHead');
    var content = document.getElementById('wContent');
    if (!widget || !content) return;

    // --- Drag-Logik ---
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
            // Schüler überspringen die schon aktiv sind
            var badge = document.getElementById('badge-' + s.sid);
            if (badge && badge.classList.contains('on')) return;

            var prepTime = parseDateTime(s.datum, s.prep_start);
            if (!prepTime) return;
            var diff = prepTime.getTime() - now.getTime();

            // Maximal 2 Stunden in der Vergangenheit berücksichtigen
            if (diff > -7200000 && diff < bestDiff) {
                bestDiff = diff; best = { s: s, diff: diff };
            }
        });

        if (!best) { content.innerHTML = '<b style="color:#4caf50">Keine weiteren Prüfungen</b>'; return; }

        var s = best.s, diff = best.diff;
        var farbe = ZF[s.zweig] || '#666';

        if (diff > 0) {
            // Countdown bis zum Start
            var sec = Math.floor(diff / 1000);
            var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), sc = sec % 60;
            var cdText = (h > 0 ? h + 'h ' : '') + (m < 10 ? '0' : '') + m + ':' + (sc < 10 ? '0' : '') + sc;
            content.innerHTML = '<div class="widget-name">' + s.vorname + ' ' + s.nachname + '</div>'
                + '<div style="text-align:center"><span class="badge" style="background:' + farbe + ';color:#fff">' + s.klasse + '</span></div>'
                + '<div class="widget-cd">' + cdText + '</div>'
                + '<div class="widget-info">Vorbereitung beginnt' + (s.prep_start ? ' um ' + s.prep_start : '') + '</div>';
        } else {
            // Überfällig!
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


// ============================================================================
// HTTPS-SERVER STARTEN
// ============================================================================
// Der Server läuft AUSSCHLIESSLICH über HTTPS (verschlüsselt).
// Er liest ein SSL-Zertifikat und den privaten Schlüssel aus dem cert-Ordner.
// Das ist nötig weil:
// 1. Die Session-Cookies 'secure: true' haben (nur über HTTPS)
// 2. Microsoft OAuth eine HTTPS-Redirect-URI erwartet
// 3. Es generell sicherer ist (Passwörter, Session-Daten)
//
// Bei Strg+C (SIGINT) wird die Datenbank sauber geschlossen,
// um Datenkorruption zu verhindern.
// ============================================================================
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