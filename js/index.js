const express = require('express');
const app = express();
const port = 3000;


const session = require('express-session');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
require('dotenv').config();


//const express = require('express');
//const app = express();
//const port = 3000;

let isLoggedIn = false;

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
    res.send(`
    <!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>HTL - Login</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
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
        h1 {
          color: #333;
          margin-bottom: 20px;
          font-size: 2.5em;
        }
        p {
          color: #666;
          margin-bottom: 40px;
          font-size: 1.2em;
        }
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
    res.send(`
    <!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Microsoft Login</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: Arial, sans-serif;
          background: white;
          min-height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          padding: 20px;
        }
        .login-container {
          text-align: center;
          max-width: 600px;
        }
        h1 {
          color: black;
          font-size: 2em;
          margin-bottom: 40px;
        }
        .continue-button {
          display: inline-block;
          padding: 15px 40px;
          background-color: #0078d4;
          color: white;
          text-decoration: none;
          border-radius: 8px;
          font-size: 1.1em;
          font-weight: bold;
          transition: all 0.3s ease;
          border: none;
          cursor: pointer;
        }
        .continue-button:hover {
          background-color: #005a9e;
        }
      </style>
    </head>
    <body>
      <div class="login-container">
        <h1>Hier müssen Sie sich dann einloggen.</h1>
        <a href="/home" class="continue-button">Weiter zur Hauptseite</a>
      </div>
    </body>
    </html>
  `);
});


app.get('/home', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>HTL - Zweigauswahl</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: Arial, sans-serif;
          background: linear-gradient(135deg, #07175e 0%, #07175e
           100%);
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
        h1 {
          text-align: center;
          color: #333;
          margin-bottom: 50px;
          font-size: 2.5em;
        }
        .button-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 20px;
        }
        .zweig-button {
          padding: 40px;
          font-size: 1.5em;
          font-weight: bold;
          border: none;
          border-radius: 15px;
          cursor: pointer;
          transition: all 0.3s ease;
          text-decoration: none;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        }
        .zweig-button:hover {
          transform: translateY(-5px);
          box-shadow: 0 10px 25px rgba(0,0,0,0.3);
        }
        .elektronik {
          background-color: #2d5016;
          color: white;
        }
        .elektrotechnik {
          background-color: #e60505;
          color: #333;
        }
        .maschinenbau {
          background-color: #4f56d0;
          color: white;
        }
        .wirtschaft {
          background-color: #ffeb3b;
          color: #333;
        }
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

app.get('/zweig/:zweig', (req, res) => {
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
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: Arial, sans-serif;
          background: linear-gradient(135deg, #07175e 0%, #07175e 100%);
          min-height: 100vh;
          padding: 40px 20px;
        }
        .container {
          background: white;
          border-radius: 20px;
          padding: 50px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          max-width: 800px;
          margin: 0 auto;
        }
        .back-button {
          display: inline-block;
          margin-bottom: 30px;
          padding: 10px 20px;
          background-color: #666;
          color: white;
          text-decoration: none;
          border-radius: 8px;
          transition: background-color 0.3s;
        }
        .back-button:hover {
          background-color: #444;
        }
        h1 {
          text-align: center;
          color: #333;
          margin-bottom: 20px;
          font-size: 2.5em;
        }
        h2 {
          text-align: center;
          color: ${farbe};
          margin-bottom: 40px;
          font-size: 2em;
        }
        .klassen-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 20px;
          margin-top: 30px;
        }
        .klassen-button {
          padding: 30px;
          font-size: 1.3em;
          font-weight: bold;
          border: none;
          border-radius: 12px;
          cursor: pointer;
          transition: all 0.3s ease;
          text-decoration: none;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          box-shadow: 0 5px 15px rgba(0,0,0,0.2);
          background-color: ${farbe};
          color: ${textFarbe};
        }
        .klassen-button:hover {
          transform: translateY(-5px);
          box-shadow: 0 10px 25px rgba(0,0,0,0.3);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <a href="/home" class="back-button">← Zurück zur Zweigauswahl</a>
        <h1>Klassen</h1>
        <h2>${name}</h2>
        <div class="klassen-grid">
          ${klassenListe.map(klasse =>
        `<a href="/klasse/${klasse}" class="klassen-button">${klasse}</a>`
    ).join('')}
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get('/klasse/:klasse', (req, res) => {
    const klasse = req.params.klasse.toUpperCase();

    // Finde den Zweig dieser Klasse
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
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
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
          max-width: 700px;
          width: 100%;
          text-align: center;
        }
        .back-button {
          display: inline-block;
          margin-bottom: 30px;
          padding: 12px 25px;
          background-color: #666;
          color: white;
          text-decoration: none;
          border-radius: 8px;
          transition: background-color 0.3s;
        }
        .back-button:hover {
          background-color: #444;
        }
        .klasse-badge {
          display: inline-block;
          padding: 30px 60px;
          background-color: ${farbe};
          color: ${textFarbe};
          font-size: 3em;
          font-weight: bold;
          border-radius: 15px;
          margin: 30px 0;
          box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        h1 {
          color: #333;
          font-size: 2em;
          margin-top: 20px;
        }
        p {
          color: #666;
          font-size: 1.2em;
          margin-top: 20px;
        }
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

https.createServer(httpsOptions, app).listen(process.env.PORT, () => {
    console.log('HTTPS-Server läuft auf Port ' + process.env.PORT);
});
