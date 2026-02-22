const express = require('express');
const app = express();
const port = 3000;

// Zusätzliche Imports:
const session = require('express-session');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
require('dotenv').config({override: true});

// NEU - SQLite3 Import
//const sqlite3 = require('sqlite3').verbose();

let isLoggedIn = false;

/* NEU - Datenbankverbindung erstellen
const dbPath = '/Documents/AlexFineas/Server-Git/Info-Screen-fuer-die-Durchfuehrung-der-muendlichen-Reife-und-Diplompruefung/termineordner/termine.db';
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('Fehler beim Öffnen der DB:', err.message);
        console.error('Geprüfter Pfad:', dbPath);
    } else {
        console.log(' Verbindung zur Datenbank termine.db erfolgreich hergestellt');
    }
});*/

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Eine Ebene hoch aus /js, dann in /termineordner
const dbPath = path.join(__dirname, '..', 'termineordner', 'termine.db');

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('Fehler beim Öffnen der DB:', err.message);
        console.error('Geprüfter Pfad:', dbPath);
    } else {
        console.log('Verbindung zur Datenbank termine.db erfolgreich hergestellt');
    }
});


// Session speichern (damit Login "merkt", dass man drin ist)
app.use(session({
    secret: process.env.SESSION_SECRET || 'BITTE_IN_.env_SETZEN',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, sameSite: 'lax' } // weil HTTPS
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

// NEU - Feste Zweig-Zuordnung für die automatische Erkennung
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

// NEU - Funktion zum Auslesen der Klassenstruktur aus der Datenbank
function getKlassenStrukturAusDB() {
    return new Promise((resolve, reject) => {
        // Zuerst versuchen wir verschiedene mögliche Spaltennamen zu finden
        db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
            if (err) {
                return reject(err);
            }

            // Versuche verschiedene Tabellennamen (termine, klassen, schueler, etc.)
            const possibleTables = ['termine', 'klassen', 'schueler', 'students', 'classes'];
            let targetTable = null;

            for (const table of tables) {
                if (possibleTables.includes(table.name.toLowerCase())) {
                    targetTable = table.name;
                    break;
                }
            }

            if (!targetTable && tables.length > 0) {
                targetTable = tables[0].name; // Nimm erste Tabelle als Fallback
            }

            if (!targetTable) {
                console.warn('Keine passende Tabelle gefunden, verwende statische Klassen');
                return resolve(null);
            }

            // Versuche Klassen zu extrahieren (verschiedene mögliche Spaltennamen)
            const query = `SELECT DISTINCT 
                COALESCE(klasse, class, klassenname, gruppe) as klasse 
                FROM ${targetTable} 
                WHERE COALESCE(klasse, class, klassenname, gruppe) IS NOT NULL`;

            db.all(query, [], (err, rows) => {
                if (err) {
                    console.error('Fehler beim Auslesen der Klassen:', err.message);
                    return resolve(null);
                }

                // Struktur aufbauen
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
                        struktur[zweig][klassenname] = []; // Später mit Schülern füllen
                    }
                });

                console.log('Klassenstruktur aus DB geladen:', JSON.stringify(struktur, null, 2));
                resolve(struktur);
            });
        });
    });
}

// NEU - Funktion zum Laden der Schüler für eine bestimmte Klasse
function getSchuelerFuerKlasse(klassenname) {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT * FROM termine 
            WHERE COALESCE(klasse, class, klassenname, gruppe) = ? 
            ORDER BY nachname, vorname
        `;

        db.all(query, [klassenname], (err, rows) => {
            if (err) {
                console.error('Fehler beim Laden der Schüler:', err.message);
                return resolve([]);
            }
            resolve(rows);
        });
    });
}

// NEU - Debug-Route: Zeigt Datenbankstruktur
app.get('/debug/db', requireAuth, (req, res) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        const promises = tables.map(table => {
            return new Promise((resolve) => {
                db.all(`SELECT * FROM ${table.name} LIMIT 5`, [], (err, rows) => {
                    if (err) {
                        resolve({ table: table.name, error: err.message });
                    } else {
                        resolve({ table: table.name, rows: rows });
                    }
                });
            });
        });

        Promise.all(promises).then(results => {
            res.json({
                database: dbPath,
                tables: results
            });
        });
    });
});

// NEU - Test-Route: Zeigt Klassenstruktur als JSON
app.get('/klassenstruktur', requireAuth, async (req, res) => {
    try {
        const struktur = await getKlassenStrukturAusDB();
        if (!struktur) {
            return res.json({
                message: 'Keine Klassen in DB gefunden, verwende statische Klassen',
                struktur: klassen
            });
        }
        res.json(struktur);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// NEU - Test-Route: Zeigt alle Zweige mit Klassen
app.get('/zweige', requireAuth, async (req, res) => {
    try {
        const struktur = await getKlassenStrukturAusDB();
        if (!struktur) {
            return res.json({
                message: 'Keine Klassen in DB gefunden',
                zweige: Object.keys(klassen),
                klassen: klassen
            });
        }

        const result = {};
        for (const [zweig, klassenObj] of Object.entries(struktur)) {
            result[zweig] = Object.keys(klassenObj);
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/', (req, res) => {
    // Wenn schon eingeloggt -> direkt /home
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
        body {
          font-family: Arial, sans-serif;
          background: linear-gradient(135deg, #07175e 0%, #07175e 100%);
          min-height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 20px;
          padding: 60px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          max-width: 500px;
          width: 100%;
          text-align: center;
        }
        h1 { color: #333; margin-bottom: 20px; font-size: 2.5em; }
        p { color: #666; margin-bottom: 40px; font-size: 1.2em; }
        .login-button {
          display: inline-block;
          padding: 15px 40px;
          background-color: #0078d4;
          color: white;
          text-decoration: none;
          border-radius: 8px;
          font-size: 1.2em;
          font-weight: bold;
          transition: all 0.3s ease;
          box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        }
        .login-button:hover {
          background-color: #005a9e;
          transform: translateY(-2px);
          box-shadow: 0 8px 20px rgba(0,0,0,0.3);
        }
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
    if (!code) {
        return res.status(400).send(`
      <h1>Login abgebrochen</h1>
      <p>Kein Code erhalten.</p>
      <a href="/">Zurück</a>
    `);
    }

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
        if (!idToken) {
            return res.status(500).send('Kein id_token erhalten.');
        }

        const payload = JSON.parse(base64UrlDecode(idToken.split('.')[1]));
        const email = (payload.preferred_username || payload.upn || payload.email || '').toLowerCase();

        if (!email) {
            return res.status(403).send('Keine Email im Token gefunden.');
        }

        if (!email.endsWith('@ms.bulme.at')) {
            return res.status(403).send(`
        <h1>Zugriff verweigert</h1>
        <p>Nur <b>@ms.bulme.at</b> Accounts sind erlaubt.</p>
        <p>Du bist eingeloggt als: ${email}</p>
        <a href="/">Zurück</a>
      `);
        }

        req.session.user = { email };
        return res.redirect('/home');

    } catch (err) {
        console.error(err.response?.data || err.message);
        return res.status(500).send(`
      <h1>Fehler beim Login</h1>
      <p>Prüfe CLIENT_SECRET und ob REDIRECT_URI exakt mit Azure übereinstimmt.</p>
      <a href="/">Zurück</a>
    `);
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// NEU - /home verwendet jetzt Daten aus der DB
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
        body {
          font-family: Arial, sans-serif;
          background: linear-gradient(135deg, #07175e 0%, #07175e 100%);
          min-height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 20px;
          padding: 50px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          max-width: 800px;
          width: 100%;
        }
        h1 { text-align: center; color: #333; margin-bottom: 50px; font-size: 2.5em; }
        .button-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
        .zweig-button {
          padding: 40px; font-size: 1.5em; font-weight: bold;
          border: none; border-radius: 15px; cursor: pointer;
          transition: all 0.3s ease; text-decoration: none;
          display: flex; align-items: center; justify-content: center;
          text-align: center; box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        }
        .zweig-button:hover { transform: translateY(-5px); box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
        .elektronik { background-color: #2d5016; color: white; }
        .elektrotechnik { background-color: #e60505; color: #333; }
        .maschinenbau { background-color: #4f56d0; color: white; }
        .wirtschaft { background-color: #ffeb3b; color: #333; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Wähle Sie ihr Zweig aus</h1>
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

// NEU - /zweig/:zweig verwendet jetzt Daten aus der DB
app.get('/zweig/:zweig', requireAuth, async (req, res) => {
    const zweig = req.params.zweig.toLowerCase();

    try {
        const struktur = await getKlassenStrukturAusDB();
        let klassenListe;

        if (struktur && struktur[zweig]) {
            klassenListe = Object.keys(struktur[zweig]);
        } else {
            klassenListe = klassen[zweig] || [];
        }

        if (klassenListe.length === 0) {
            return res.redirect('/home');
        }

        const farbe = zweigFarben[zweig];
        const name = zweigNamen[zweig];
        const textFarbe = (zweig === 'elektrotechnik' || zweig === 'wirtschaft') ? '#333' : 'white';

        res.send(`
    <!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${name} - Klassenauswahl</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #07175e 0%, #07175e 100%); min-height: 100vh; padding: 40px 20px; }
        .container { background: white; border-radius: 20px; padding: 50px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 800px; margin: 0 auto; }
        .back-button { display: inline-block; margin-bottom: 30px; padding: 10px 20px; background-color: #666; color: white; text-decoration: none; border-radius: 8px; transition: background-color 0.3s; }
        .back-button:hover { background-color: #444; }
        h1 { text-align: center; color: #333; margin-bottom: 20px; font-size: 2.5em; }
        h2 { text-align: center; color: ${farbe}; margin-bottom: 40px; font-size: 2em; }
        .klassen-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-top: 30px; }
        .klassen-button {
          padding: 30px; font-size: 1.3em; font-weight: bold;
          border: none; border-radius: 12px; cursor: pointer;
          transition: all 0.3s ease; text-decoration: none;
          display: flex; align-items: center; justify-content: center;
          text-align: center; box-shadow: 0 5px 15px rgba(0,0,0,0.2);
          background-color: ${farbe}; color: ${textFarbe};
        }
        .klassen-button:hover { transform: translateY(-5px); box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
      </style>
    </head>
    <body>
      <div class="container">
        <a href="/home" class="back-button">← Zurück zur Zweigauswahl</a>
        <h1>Klassen</h1>
        <h2>${name}</h2>
        <div class="klassen-grid">
          ${klassenListe.map(klasse => `<a href="/klasse/${klasse}" class="klassen-button">${klasse}</a>`).join('')}
        </div>
      </div>
    </body>
    </html>
  `);
    } catch (err) {
        console.error('Fehler beim Laden der Klassen:', err);
        res.status(500).send('Fehler beim Laden der Daten');
    }
});

// NEU - /klasse/:klasse zeigt jetzt Schüler aus der DB
app.get('/klasse/:klasse', requireAuth, async (req, res) => {
    const klasse = req.params.klasse.toUpperCase();

    try {
        // Finde den Zweig dieser Klasse
        const zweig = zweigZuordnung[klasse];

        if (!zweig) {
            return res.redirect('/home');
        }

        // NEU - Lade Schüler aus der Datenbank
        const schueler = await getSchuelerFuerKlasse(klasse);

        const farbe = zweigFarben[zweig];
        const textFarbe = (zweig === 'elektrotechnik' || zweig === 'wirtschaft') ? '#333' : 'white';

        res.send(`
    <!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Klasse ${klasse}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #07175e 0%, #07175e 100%); min-height: 100vh; padding: 40px 20px; }
        .container { background: white; border-radius: 20px; padding: 60px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 900px; margin: 0 auto; }
        .back-button { display: inline-block; margin-bottom: 30px; padding: 12px 25px; background-color: #666; color: white; text-decoration: none; border-radius: 8px; transition: background-color 0.3s; }
        .back-button:hover { background-color: #444; }
        .klasse-badge { display: inline-block; padding: 30px 60px; background-color: ${farbe}; color: ${textFarbe}; font-size: 3em; font-weight: bold; border-radius: 15px; margin: 30px 0; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        h1 { color: #333; font-size: 2em; margin-top: 20px; text-align: center; }
        p { color: #666; font-size: 1.2em; margin-top: 20px; text-align: center; }
        .schueler-liste { margin-top: 40px; }
        
        :root {--zweigfarbe: #2d5016;}
        
        .schueler-item { padding: 15px; margin: 10px 0; background: #f5f5f5; border-radius: 8px; border-left: 4px solid var(--zweigfarbe); }
        .schueler-name { font-weight: bold; font-size: 1.1em; color: #333; }
        .schueler-info { color: #666; font-size: 0.9em; margin-top: 5px; }
      </style>
    </head>
    <body>
        <body style="--zweigfarbe: ${farbe};">
      <div class="container">
        <a href="/zweig/${zweig}" class="back-button">← Zurück zu ${zweigNamen[zweig]}</a>
        <div style="text-align: center;">
          <div class="klasse-badge">${klasse}</div>
          <h1>Klasse ${klasse}</h1>
          ${schueler.length > 0 ? `<p>${schueler.length} Schüler gefunden</p>` : '<p>Keine Schüler in der Datenbank gefunden.</p>'}
        </div>
        ${schueler.length > 0 ? `
        <div class="schueler-liste">
          ${schueler.map(s => `
            <div class="schueler-item">
              <div class="schueler-name">${s.vorname || s.firstname || 'Vorname'} ${s.nachname || s.lastname || 'Nachname'}</div>
              <div class="schueler-info">
                ${s.termin ? `Termin: ${s.termin}` : ''}
                ${s.pruefungsfach ? ` | Fach: ${s.pruefungsfach}` : ''}
                ${s.raum ? ` | Raum: ${s.raum}` : ''}
              </div>
            </div>
          `).join('')}
        </div>
        ` : ''}
      </div>
    </body>
    </html>
  `);
    } catch (err) {
        console.error('Fehler beim Laden der Schüler:', err);
        res.status(500).send('Fehler beim Laden der Daten');
    }
});

const httpsOptions = {
    key: fs.readFileSync('./cert/key.pem'),
    cert: fs.readFileSync('./cert/cert.pem'),
};

https.createServer(httpsOptions, app).listen(process.env.PORT || port, () => {
    console.log('HTTPS-Server läuft auf Port ' + (process.env.PORT || port));
});

// NEU - Sauberes Schließen der Datenbankverbindung beim Beenden
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error('Fehler beim Schließen der Datenbank:', err.message);
        } else {
            console.log('Datenbankverbindung geschlossen');
        }
        process.exit(0);
    });
});