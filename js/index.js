const express = require('express');
const app = express();
const port = 3000;

// Zusätzliche Imports:
const session = require('express-session'); //  NEU
const axios = require('axios');
const https = require('https');
const fs = require('fs');
require('dotenv').config();

// (sqlite3 brauchst du für den Domain-Check nicht – kann bleiben oder weg)
// const sqlite3 = require('sqlite3').verbose();

let isLoggedIn = false;

//  Session speichern (damit Login "merkt", dass man drin ist)
app.use(session({
    secret: process.env.SESSION_SECRET || 'BITTE_IN_.env_SETZEN',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, sameSite: 'lax' } // weil HTTPS
}));

//  Schutz: Nur eingeloggte dürfen /home, /zweig, /klasse sehen
function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.redirect('/');
}

//  Helper: JWT payload (Base64URL) decodieren
function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString('utf8');
}

// Klassen-Zuordnung zu den Zweigen
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

// NEU: Callback Route (Microsoft schickt nach Login hierhin)
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
        // Code -> Token tauschen
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

        // ID Token auslesen
        const payload = JSON.parse(base64UrlDecode(idToken.split('.')[1]));
        const email = (payload.preferred_username || payload.upn || payload.email || '').toLowerCase();

        if (!email) {
            return res.status(403).send('Keine Email im Token gefunden.');
        }

        //  Domain-Check: NUR @ms.bulme.at
        if (!email.endsWith('@ms.bulme.at')) {
            return res.status(403).send(`
        <h1>Zugriff verweigert</h1>
        <p>Nur <b>@ms.bulme.at</b> Accounts sind erlaubt.</p>
        <p>Du bist eingeloggt als: ${email}</p>
        <a href="/">Zurück</a>
      `);
        }

        //  Login OK -> Session setzen -> /home
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

// optional: Logout
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.get('/home', requireAuth, (req, res) => {
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
          <a href="/zweig/elektronik" class="zweig-button elektronik">Elektronik</a>
          <a href="/zweig/elektrotechnik" class="zweig-button elektrotechnik">Elektrotechnik</a>
          <a href="/zweig/maschinenbau" class="zweig-button maschinenbau">Maschinenbau</a>
          <a href="/zweig/wirtschaft" class="zweig-button wirtschaft">Wirtschaft</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get('/zweig/:zweig', requireAuth, (req, res) => {
    const zweig = req.params.zweig.toLowerCase();

    if (!klassen[zweig]) {
        return res.redirect('/home');
    }

    const klassenListe = klassen[zweig];
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
});

app.get('/klasse/:klasse', requireAuth, (req, res) => {
    const klasse = req.params.klasse.toUpperCase();

    let zweig = '';
    for (const [key, value] of Object.entries(klassen)) {
        if (value.includes(klasse)) {
            zweig = key;
            break;
        }
    }

    if (!zweig) {
        return res.redirect('/home');
    }

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
        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #07175e 0%, #07175e 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
        .container { background: white; border-radius: 20px; padding: 60px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 700px; width: 100%; text-align: center; }
        .back-button { display: inline-block; margin-bottom: 30px; padding: 12px 25px; background-color: #666; color: white; text-decoration: none; border-radius: 8px; transition: background-color 0.3s; }
        .back-button:hover { background-color: #444; }
        .klasse-badge { display: inline-block; padding: 30px 60px; background-color: ${farbe}; color: ${textFarbe}; font-size: 3em; font-weight: bold; border-radius: 15px; margin: 30px 0; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        h1 { color: #333; font-size: 2em; margin-top: 20px; }
        p { color: #666; font-size: 1.2em; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <a href="/zweig/${zweig}" class="back-button">← Zurück zu ${zweigNamen[zweig]}</a>
        <div class="klasse-badge">${klasse}</div>
        <h1>Du bist auf Klasse ${klasse} gegangen</h1>
        <p>Hier werden später die Schüler und Informationen dieser Klasse angezeigt.</p>
      </div>
    </body>
    </html>
  `);
});

const httpsOptions = {
    key: fs.readFileSync('./cert/key.pem'),
    cert: fs.readFileSync('./cert/cert.pem'),
};

https.createServer(httpsOptions, app).listen(process.env.PORT || port, () => {
    console.log('HTTPS-Server läuft auf Port ' + (process.env.PORT || port));
});
