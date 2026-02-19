const express = require('express');
const app = express();
const https = require('https');
const fs = require('fs');
const session = require('express-session');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config({ override: true });

const port = 3000;

/* =======================
   SQLITE VERBINDUNG
======================= */

const DB_PATH = path.join(__dirname, 'termine.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error("DB Fehler:", err.message);
    else console.log("SQLite verbunden:", DB_PATH);
});

/* =======================
   SESSION
======================= */

app.use(session({
    secret: process.env.SESSION_SECRET || 'BITTE_SETZEN',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, sameSite: 'lax' }
}));

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.redirect('/');
}

/* =======================
   MICROSOFT LOGIN
======================= */

function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString('utf8');
}

app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/home');

    res.send(`
        <h1>Login</h1>
        <a href="/microsoft-login">Mit Microsoft einloggen</a>
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
    if (!code) return res.send("Kein Code erhalten");

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
        const payload = JSON.parse(base64UrlDecode(idToken.split('.')[1]));
        const email = (payload.preferred_username || '').toLowerCase();

        if (!email.endsWith('@ms.bulme.at')) {
            return res.send("Nur @ms.bulme.at erlaubt");
        }

        req.session.user = { email };
        res.redirect('/home');

    } catch (err) {
        console.error(err);
        res.send("Login Fehler");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

/* =======================
   HOME (ZWEIG)
======================= */

app.get('/home', requireAuth, (req, res) => {
    res.send(`
        <h1>Elektronik</h1>
        <a href="/klasse/5AHEL">5AHEL</a><br>
        <a href="/klasse/5BHEL">5BHEL</a><br>
        <a href="/klasse/5CHEL">5CHEL</a><br>
        <br>
        <a href="/logout">Logout</a>
    `);
});

/* =======================
   KLASSE → SCHÜLER AUS DB
======================= */

app.get('/klasse/:klasse', requireAuth, (req, res) => {

    const klasse = req.params.klasse.toUpperCase();

    if (!klasse.endsWith("HEL")) {
        return res.redirect('/home');
    }

    const sql = `
        SELECT nachname, vorname, fach, pruefer, beisitz, prep_start, exam_start, exam_end
        FROM termine
        WHERE klasse = ?
        ORDER BY prep_start
    `;

    db.all(sql, [klasse], (err, rows) => {

        if (err) {
            console.error(err);
            return res.send("DB Fehler");
        }

        res.send(`
            <html>
            <head>
                <style>
                    body { font-family: Arial; padding:40px; background:#07175e; }
                    .box { background:white; padding:30px; border-radius:15px; }
                    table { width:100%; border-collapse:collapse; }
                    th, td { border:1px solid #ccc; padding:8px; }
                    th { background:#2d5016; color:white; }
                </style>
            </head>
            <body>
                <div class="box">
                    <a href="/home">← Zurück</a>
                    <h2>Klasse ${klasse}</h2>

                    <table>
                        <tr>
                            <th>Name</th>
                            <th>Fach</th>
                            <th>Prüfer</th>
                            <th>Beisitz</th>
                            <th>Prep</th>
                            <th>Exam</th>
                        </tr>

                        ${rows.map(r => `
                            <tr>
                                <td>${r.nachname} ${r.vorname}</td>
                                <td>${r.fach}</td>
                                <td>${r.pruefer}</td>
                                <td>${r.beisitz}</td>
                                <td>${r.prep_start}</td>
                                <td>${r.exam_start} - ${r.exam_end}</td>
                            </tr>
                        `).join('')}

                    </table>
                </div>
            </body>
            </html>
        `);
    });
});

/* =======================
   HTTPS STARTEN
======================= */

const httpsOptions = {
    key: fs.readFileSync('./cert/key.pem'),
    cert: fs.readFileSync('./cert/cert.pem'),
};

https.createServer(httpsOptions, app).listen(process.env.PORT || port, () => {
    console.log('HTTPS Server läuft auf Port ' + (process.env.PORT || port));
});
