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
const VORBEREITUNGS_TIMER = 120;
const PRUEFUNGS_TIMER = 120; // 12 Minuten
// ================================================

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, '..', 'termineordner', 'termine.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Fehler beim Öffnen der DB:', err.message);
    } else {
        console.log('Verbindung zur Datenbank termine.db erfolgreich hergestellt');
        db.run(`CREATE TABLE IF NOT EXISTS timer_status (
                                                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                            schueler_id TEXT UNIQUE NOT NULL,
                                                            started_at INTEGER, paused_at INTEGER,
                                                            remaining_seconds REAL NOT NULL DEFAULT ${VORBEREITUNGS_TIMER},
                                                            state TEXT NOT NULL DEFAULT 'idle'
                )`, () => {
            const newCols = [
                ['exam_started_at', 'INTEGER'],
                ['exam_remaining', 'REAL DEFAULT ' + PRUEFUNGS_TIMER],
                ['exam_state', "TEXT DEFAULT 'idle'"],
                ['exam_start_real', 'TEXT']
            ];
            let done = 0;
            newCols.forEach(([col, type]) => {
                db.run(`ALTER TABLE timer_status ADD COLUMN ${col} ${type}`, (err) => {
                    if (err && !err.message.includes('duplicate column')) console.error('Spalte ' + col + ':', err.message);
                    done++;
                    if (done === newCols.length) {
                        db.run(`CREATE TABLE IF NOT EXISTS Pruefungs_Auswertung (
                                                                                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                                                    schueler_id TEXT NOT NULL,
                                                                                    Klasse TEXT, Vorname TEXT, Nachname TEXT,
                                                                                    Pruefung_geplant TEXT,
                                                                                    Pruefung_real TEXT,
                                                                                    Pruefungsdauer TEXT,
                                                                                    Themenpool INTEGER, Note INTEGER, Kommentar TEXT
                                )`, () => { console.log('Alle Tabellen bereit'); initAlleTimer(); });
                    }
                });
            });
        });
    }
});

function nowTimeStr() { const d=new Date(); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+':'+('0'+d.getSeconds()).slice(-2); }

function initAlleTimer() {
    const alleKlassen = Object.values(klassen).flat();
    const placeholders = alleKlassen.map(() => '?').join(',');
    db.all(`SELECT id, klasse FROM termine WHERE klasse IN (${placeholders})`, alleKlassen, (err, rows) => {
        if (err) { console.error('Fehler beim Timer-Init:', err.message); return; }
        if (!rows || rows.length === 0) { console.log('Keine Schüler gefunden.'); return; }
        let neu = 0;
        const stmt = db.prepare(`INSERT OR IGNORE INTO timer_status (schueler_id, remaining_seconds, state, exam_remaining, exam_state) VALUES (?, ${VORBEREITUNGS_TIMER}, 'idle', ${PRUEFUNGS_TIMER}, 'idle')`);
        rows.forEach(row => { const zweig = zweigZuordnung[row.klasse]; if (!zweig) return; stmt.run([zweig + '_' + row.id], function(err) { if (!err && this.changes > 0) neu++; }); });
        stmt.finalize(() => { console.log('Timer-Init: ' + rows.length + ' Schüler, ' + neu + ' neue Einträge. Bestehende unverändert.'); });
    });
}

app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET || 'BITTE_IN_.env_SETZEN', resave: false, saveUninitialized: false, cookie: { secure: true, sameSite: 'lax' } }));
function requireAuth(req, res, next) { if (req.session && req.session.user) return next(); return res.redirect('/'); }
function base64UrlDecode(str) { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; return Buffer.from(str, 'base64').toString('utf8'); }

const klassen = { elektronik: ['5AHEL', '5BHEL', '5CHEL'], elektrotechnik: ['5AHET', '5BHET', '5CHET'], maschinenbau: ['5AHMBS', '5BHMBZ', '5VHMBS'], wirtschaft: ['5AHWIE', '5BHWIE', '5DHWIE'] };
const zweigFarben = { elektronik: '#2d5016', elektrotechnik: '#e60505', maschinenbau: '#4f56d0', wirtschaft: '#ffeb3b' };
const zweigNamen = { elektronik: 'Elektronik', elektrotechnik: 'Elektrotechnik', maschinenbau: 'Maschinenbau', wirtschaft: 'Wirtschaft' };
const zweigZuordnung = { '5AHEL': 'elektronik', '5BHEL': 'elektronik', '5CHEL': 'elektronik', '5AHET': 'elektrotechnik', '5BHET': 'elektrotechnik', '5CHET': 'elektrotechnik', '5AHMBS': 'maschinenbau', '5BHMBZ': 'maschinenbau', '5VHMBS': 'maschinenbau', '5AHWIE': 'wirtschaft', '5BHWIE': 'wirtschaft', '5DHWIE': 'wirtschaft' };

function getKlassenStrukturAusDB() { return new Promise((resolve) => { db.all('SELECT DISTINCT klasse FROM termine WHERE klasse IS NOT NULL ORDER BY klasse', [], (err, rows) => { if (err) return resolve(null); const s = { elektronik: {}, elektrotechnik: {}, maschinenbau: {}, wirtschaft: {} }; rows.forEach(r => { const z = zweigZuordnung[r.klasse]; if (z) s[z][r.klasse] = []; }); resolve(s); }); }); }
function getSchuelerFuerZweig(zweig) { return new Promise((resolve) => { const kl = klassen[zweig] || []; if (!kl.length) return resolve([]); const ph = kl.map(() => '?').join(','); db.all(`SELECT * FROM termine WHERE klasse IN (${ph}) ORDER BY klasse, nachname, vorname`, kl, (err, rows) => resolve(err ? [] : rows)); }); }

// ==================== TIMER API ====================

app.get('/api/timer/:id', requireAuth, (req, res) => {
    const id = req.params.id;
    db.get('SELECT * FROM timer_status WHERE schueler_id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json({ state: 'idle', remaining_seconds: VORBEREITUNGS_TIMER, exam_state: 'idle', exam_remaining: PRUEFUNGS_TIMER });
        const now = Date.now();
        const result = { state: row.state, remaining_seconds: row.remaining_seconds, exam_state: row.exam_state || 'idle', exam_remaining: row.exam_remaining || PRUEFUNGS_TIMER };
        if (row.state === 'running' && row.started_at) { const elapsed = (now - row.started_at) / 1000; result.remaining_seconds = Math.max(0, row.remaining_seconds - elapsed); if (result.remaining_seconds <= 0) result.state = 'prep_done'; }
        if (row.exam_state === 'running' && row.exam_started_at) { result.exam_remaining = row.exam_remaining - (now - row.exam_started_at) / 1000; }
        res.json(result);
    });
});

app.post('/api/timer/:id/start', requireAuth, (req, res) => {
    const id = req.params.id; const now = Date.now();
    db.run(`INSERT INTO timer_status (schueler_id, started_at, remaining_seconds, state) VALUES (?, ?, ${VORBEREITUNGS_TIMER}, 'running') ON CONFLICT(schueler_id) DO UPDATE SET started_at=?, remaining_seconds=${VORBEREITUNGS_TIMER}, state='running', paused_at=NULL`,
        [id, now, now], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); });
});

app.post('/api/timer/:id/pause', requireAuth, (req, res) => {
    const id = req.params.id; const { remaining_seconds } = req.body;
    db.run(`UPDATE timer_status SET state='paused', paused_at=?, remaining_seconds=?, started_at=NULL WHERE schueler_id=?`, [Date.now(), remaining_seconds, id], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); });
});

app.post('/api/timer/:id/resume', requireAuth, (req, res) => {
    const id = req.params.id; const now = Date.now();
    db.run(`UPDATE timer_status SET state='running', started_at=?, paused_at=NULL WHERE schueler_id=?`, [now, id], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); });
});

app.post('/api/timer/:id/reset', requireAuth, (req, res) => {
    const id = req.params.id;
    db.run(`UPDATE timer_status SET state='idle', started_at=NULL, paused_at=NULL, remaining_seconds=${VORBEREITUNGS_TIMER}, exam_state='idle', exam_started_at=NULL, exam_remaining=${PRUEFUNGS_TIMER}, exam_start_real=NULL WHERE schueler_id=?`,
        [id], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); });
});

app.post('/api/timer/:id/prep_done', requireAuth, (req, res) => {
    const id = req.params.id;
    db.run(`INSERT INTO timer_status (schueler_id, state, remaining_seconds) VALUES (?, 'prep_done', 0) ON CONFLICT(schueler_id) DO UPDATE SET state='prep_done', remaining_seconds=0, started_at=NULL, paused_at=NULL`, [id], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); });
});

app.post('/api/timer/:id/exam_start', requireAuth, (req, res) => {
    const id = req.params.id; const now = Date.now(); const ts = nowTimeStr();
    db.run(`UPDATE timer_status SET exam_state='running', exam_started_at=?, exam_remaining=${PRUEFUNGS_TIMER}, exam_start_real=? WHERE schueler_id=?`, [now, ts, id], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); });
});

app.post('/api/timer/:id/exam_pause', requireAuth, (req, res) => {
    const id = req.params.id; const { exam_remaining } = req.body;
    db.run(`UPDATE timer_status SET exam_state='paused', exam_started_at=NULL, exam_remaining=? WHERE schueler_id=?`, [exam_remaining, id], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); });
});

app.post('/api/timer/:id/exam_resume', requireAuth, (req, res) => {
    const id = req.params.id; const now = Date.now();
    db.run(`UPDATE timer_status SET exam_state='running', exam_started_at=? WHERE schueler_id=?`, [now, id], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); });
});

app.post('/api/timer/:id/exam_finish', requireAuth, (req, res) => {
    const id = req.params.id;
    const { note, themenpool, kommentar, zeit_differenz } = req.body;
    if (!note || !themenpool) return res.status(400).json({ error: 'Note und Themenpool sind Pflicht' });
    db.run(`UPDATE timer_status SET exam_state='done' WHERE schueler_id=?`, [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        const termineId = id.split('_').slice(1).join('_');
        db.get('SELECT * FROM termine WHERE id=?', [termineId], (e2, sch) => {
            db.get('SELECT exam_start_real FROM timer_status WHERE schueler_id=?', [id], (e3, ts) => {
                // Prüfungsdauer: PRUEFUNGS_TIMER - verbleibende Sekunden = tatsächlich gebraucht
                let dauer = '';
                if (zeit_differenz !== null && zeit_differenz !== undefined) {
                    const dauerSecs = Math.abs(PRUEFUNGS_TIMER - zeit_differenz);
                    const h = Math.floor(dauerSecs / 3600);
                    const m = Math.floor((dauerSecs % 3600) / 60);
                    const s = Math.floor(dauerSecs % 60);
                    dauer = ('0'+h).slice(-2) + ':' + ('0'+m).slice(-2) + ':' + ('0'+s).slice(-2);
                }
                db.run(`INSERT INTO Pruefungs_Auswertung (schueler_id,Klasse,Vorname,Nachname,Pruefung_geplant,Pruefung_real,Pruefungsdauer,Themenpool,Note,Kommentar) VALUES (?,?,?,?,?,?,?,?,?,?)`,
                    [id, sch?sch.klasse:'', sch?sch.vorname:'', sch?sch.nachname:'',
                        sch?(sch.exam_start||''):'', ts?ts.exam_start_real:'',
                        dauer, themenpool, note, kommentar||''],
                    (e4) => { if(e4) console.error('Pruefungs_Auswertung Fehler:', e4.message); else console.log('Pruefungs_Auswertung gespeichert:', id); });
                res.json({ ok: true });
            });
        });
    });
});

app.get('/api/timers/:zweig', requireAuth, (req, res) => {
    const zweig = req.params.zweig.toLowerCase();
    db.all('SELECT * FROM timer_status WHERE schueler_id LIKE ?', [`${zweig}_%`], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const timers = {}; const now = Date.now();
        (rows || []).forEach(row => {
            const t = { state: row.state, remaining_seconds: row.remaining_seconds, exam_state: row.exam_state || 'idle', exam_remaining: row.exam_remaining || PRUEFUNGS_TIMER };
            if (row.state === 'running' && row.started_at) { const el = (now - row.started_at) / 1000; t.remaining_seconds = Math.max(0, row.remaining_seconds - el); if (t.remaining_seconds <= 0) t.state = 'prep_done'; }
            if (row.exam_state === 'running' && row.exam_started_at) { t.exam_remaining = row.exam_remaining - (now - row.exam_started_at) / 1000; }
            timers[row.schueler_id] = t;
        });
        res.json(timers);
    });
});

// ===== GLOBALE API: Nächste Prüfung über ALLE Zweige =====
app.get('/api/next-exam', requireAuth, (req, res) => {
    const alleKlassen = Object.values(klassen).flat();
    db.all('SELECT * FROM termine WHERE klasse IN (' + alleKlassen.map(()=>'?').join(',') + ') ORDER BY datum, prep_start, exam_start', alleKlassen, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all('SELECT schueler_id, state, exam_state FROM timer_status', [], (e2, timers) => {
            const tMap = {}; (timers || []).forEach(t => tMap[t.schueler_id] = t);
            res.json((rows || []).map(s => {
                const z = zweigZuordnung[s.klasse] || '', sid = z + '_' + s.id, ts = tMap[sid];
                return { sid, vorname: s.vorname||'', nachname: s.nachname||'', klasse: s.klasse||'', fach: s.fach||'', pruefer: s.pruefer||'', datum: s.datum||'', prep_start: s.prep_start||s.rep_start||'', exam_start: s.exam_start||'', zweig: z, farbe: zweigFarben[z]||'#333', textFarbe: (z==='elektrotechnik'||z==='wirtschaft')?'#333':'white', state: ts?ts.state:'idle', exam_state: ts?ts.exam_state:'idle' };
            }));
        });
    });
});


// ===== ALLE TIMER auf einmal laden =====
app.get('/api/timers/all', requireAuth, (req, res) => {
    db.all('SELECT * FROM timer_status', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const timers = {}; const now = Date.now();
        (rows || []).forEach(row => {
            const t = { state: row.state, remaining_seconds: row.remaining_seconds, exam_state: row.exam_state || 'idle', exam_remaining: row.exam_remaining || PRUEFUNGS_TIMER };
            if (row.state === 'running' && row.started_at) { const el = (now - row.started_at) / 1000; t.remaining_seconds = Math.max(0, row.remaining_seconds - el); if (t.remaining_seconds <= 0) t.state = 'prep_done'; }
            if (row.exam_state === 'running' && row.exam_started_at) { t.exam_remaining = row.exam_remaining - (now - row.exam_started_at) / 1000; }
            timers[row.schueler_id] = t;
        });
        res.json(timers);
    });
});
// ==================== GLOBALES WIDGET (1 Popup für Home + Zweig) ====================
function globalWidgetHtml() {
    return `
<div class="next-exam-widget" id="nextExamWidget">
  <div class="new-header" id="widgetHeader">
    <span class="wh-text">Nächste Vorbereitung</span>
    <button class="widget-toggle" id="widgetToggle" title="Einklappen">&minus;</button>
  </div>
  <div class="widget-body" id="widgetBody">
    <div id="nextExamContent"><div class="new-loading">Lade...</div></div>
  </div>
</div>
<style>
.next-exam-widget{position:fixed;top:20px;right:20px;width:240px;background:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.22);z-index:9999;overflow:hidden;user-select:none}
.new-header{padding:8px 14px;font-weight:700;font-size:.95em;color:#fff;background:#333;display:flex;justify-content:space-between;align-items:center;cursor:grab}
.new-header:active{cursor:grabbing}.wh-text{pointer-events:none}
.widget-toggle{background:none;border:2px solid rgba(255,255,255,.5);color:#fff;width:26px;height:26px;border-radius:50%;font-size:1.1em;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
.widget-toggle:hover{background:rgba(255,255,255,.2);border-color:#fff}
.widget-body{transition:max-height .3s ease,opacity .3s ease;max-height:300px;opacity:1;overflow:hidden}
.widget-body.collapsed{max-height:0;opacity:0}
#nextExamContent{padding:10px 12px}
.new-loading{text-align:center;color:#999;padding:8px;font-size:.9em}
.nex-countdown{font-size:1.8em;font-weight:700;text-align:center;margin:4px 0;font-variant-numeric:tabular-nums;letter-spacing:1px}
.nex-countdown.soon{color:#e74c3c}.nex-countdown.normal{color:#333}
.nex-name{font-size:1em;font-weight:700;color:#222;text-align:center}
.nex-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.75em;font-weight:700}
.nex-info{text-align:center;color:#666;font-size:.8em;margin-top:4px}
.nex-done{text-align:center;color:#4caf50;font-weight:700;font-size:1em;padding:10px 0}
.nex-status{display:inline-block;font-size:.8em;padding:3px 8px;border-radius:6px;margin-top:2px}
.nex-status.waiting{background:#fff3cd;color:#856404}
.nex-status.call-student{background:#f8d7da;color:#721c24;animation:pulse-call 1.5s infinite}
.nex-call-msg{text-align:center;margin-top:6px;padding:8px 10px;background:#fff3cd;border-radius:6px;color:#856404;font-size:.8em;line-height:1.3}
@keyframes pulse-call{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.7;transform:scale(1.05)}}
@media(max-width:600px){.next-exam-widget{position:relative;top:auto!important;right:auto!important;left:auto!important;width:100%;margin:10px auto;border-radius:10px}}
</style>
<script>
(function(){
  var w=document.getElementById('nextExamWidget'),content=document.getElementById('nextExamContent'),
      header=document.getElementById('widgetHeader'),wBody=document.getElementById('widgetBody'),
      togBtn=document.getElementById('widgetToggle');
  if(!w)return;
  var isC=false;
  togBtn.addEventListener('click',function(e){e.stopPropagation();isC=!isC;wBody.classList.toggle('collapsed',isC);togBtn.innerHTML=isC?'+':'&minus;';});
  var drag=false,ox=0,oy=0;
  header.addEventListener('mousedown',function(e){if(e.target===togBtn)return;drag=true;var r=w.getBoundingClientRect();ox=e.clientX-r.left;oy=e.clientY-r.top;w.style.transition='none';e.preventDefault();});
  document.addEventListener('mousemove',function(e){if(!drag)return;w.style.left=Math.max(0,Math.min(innerWidth-w.offsetWidth,e.clientX-ox))+'px';w.style.top=Math.max(0,Math.min(innerHeight-w.offsetHeight,e.clientY-oy))+'px';w.style.right='auto';});
  document.addEventListener('mouseup',function(){if(drag){drag=false;w.style.transition='';}});
  header.addEventListener('touchstart',function(e){if(e.target===togBtn)return;drag=true;var t=e.touches[0],r=w.getBoundingClientRect();ox=t.clientX-r.left;oy=t.clientY-r.top;w.style.transition='none';},{passive:true});
  document.addEventListener('touchmove',function(e){if(!drag)return;var t=e.touches[0];w.style.left=Math.max(0,Math.min(innerWidth-w.offsetWidth,t.clientX-ox))+'px';w.style.top=Math.max(0,Math.min(innerHeight-w.offsetHeight,t.clientY-oy))+'px';w.style.right='auto';},{passive:true});
  document.addEventListener('touchend',function(){if(drag){drag=false;w.style.transition='';}});
  function pdt(datum,zeit){if(!datum||!zeit)return null;var dm=datum.match(/(\\d{2})\\.(\\d{2})\\.(\\d{4})/);if(!dm)return null;var tm=zeit.match(/(\\d{1,2}):(\\d{2})/);if(!tm)return null;return new Date(parseInt(dm[3]),parseInt(dm[2])-1,parseInt(dm[1]),parseInt(tm[1]),parseInt(tm[2]),0);}
  function fcd(ms){var neg=ms<0;ms=Math.abs(ms);var sec=Math.floor(ms/1000),h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;var str='';if(h>0)str+=h+'h ';str+=(m<10?'0':'')+m+':'+(s<10?'0':'')+s;return(neg?'-':'')+str;}
  var allData=null;
  function loadData(){fetch('/api/next-exam').then(function(r){return r.json();}).then(function(d){allData=d;}).catch(function(){});}
  function update(){
    if(isC||!allData)return;var now=new Date(),best=null,bestDiff=Infinity;
    allData.forEach(function(s){
      if(s.state==='running'||s.state==='paused'||s.state==='prep_done')return;
      if(s.exam_state==='running'||s.exam_state==='paused'||s.exam_state==='done')return;
      var pt=pdt(s.datum,s.prep_start);if(!pt)return;var diff=pt.getTime()-now.getTime();
      if(diff>-7200000&&diff<bestDiff){bestDiff=diff;best={s:s,diff:diff};}
    });
    if(!best){content.innerHTML='<div class="nex-done">Keine weiteren Pr\\u00fcfungen</div>';return;}
    var s=best.s,diff=best.diff,cdClass,cdText,statusHtml,extraHtml='';
    if(diff>0){cdText=fcd(diff);cdClass=diff<600000?'soon':'normal';statusHtml='<div style="text-align:center"><span class="nex-status waiting">Vorbereitung beginnt um '+s.prep_start+'</span></div>';}
    else{cdText='JETZT';cdClass='soon';statusHtml='<div style="text-align:center"><span class="nex-status call-student">\\uD83D\\uDCE2 Sch\\u00fcler rufen!</span></div>';extraHtml='<div class="nex-call-msg">Bitte <b>\\u201EVorbereitung starten\\u201C</b> dr\\u00fccken</div>';}
    content.innerHTML='<div class="nex-name">'+s.vorname+' '+s.nachname+'</div><div style="text-align:center;margin:2px 0"><span class="nex-badge" style="background:'+s.farbe+';color:'+s.textFarbe+'">'+s.klasse+'</span>'+(s.fach?' <span style="color:#888;font-size:.8em">'+s.fach+'</span>':'')+'</div>'+statusHtml+'<div class="nex-countdown '+cdClass+'">'+cdText+'</div>'+extraHtml;
  }
  loadData();setInterval(loadData,10000);setInterval(update,1000);
})();
</script>`;
}

// ==================== STANDARD ROUTES ====================

app.get('/debug/db', requireAuth, (req, res) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
        if (err) return res.status(500).json({ error: err.message });
        const promises = tables.map(table => new Promise((resolve) => { db.all(`SELECT * FROM ${table.name} LIMIT 5`, [], (err, rows) => { resolve(err ? { table: table.name, error: err.message } : { table: table.name, rows }); }); }));
        Promise.all(promises).then(results => res.json({ database: dbPath, tables: results }));
    });
});

app.get('/klassenstruktur', requireAuth, async (req, res) => { try { const s = await getKlassenStrukturAusDB(); res.json(s || { fallback: klassen }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/zweige', requireAuth, async (req, res) => { try { const s = await getKlassenStrukturAusDB(); if (!s) return res.json({ zweige: Object.keys(klassen), klassen }); const r = {}; for (const [z, k] of Object.entries(s)) r[z] = Object.keys(k); res.json(r); } catch (e) { res.status(500).json({ error: e.message }); } });

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

// ===== ALLE SCHÜLER laden (sortiert nach Prüfungszeit) =====
function getAlleSchueler() {
    return new Promise((resolve) => {
        const alleKlassen = Object.values(klassen).flat();
        db.all('SELECT * FROM termine WHERE klasse IN (' + alleKlassen.map(()=>'?').join(',') + ') ORDER BY datum, prep_start, exam_start', alleKlassen, (err, rows) => {
            if (err) return resolve([]);
            resolve(rows || []);
        });
    });
}

// ===== HOME: Alle Schüler auf einer Seite =====
app.get('/home', requireAuth, async (req, res) => {
    try {
        const schueler = await getAlleSchueler();
        const cardsHtml = schueler.map((s) => {
            const zweig = zweigZuordnung[s.klasse] || 'elektronik';
            const farbe = zweigFarben[zweig] || '#333';
            const tf = (zweig === 'elektrotechnik' || zweig === 'wirtschaft') ? '#333' : 'white';
            const sid = zweig + '_' + s.id;
            return '<div class="schueler-item" id="card-' + sid + '" data-sid="' + sid + '" style="border-left-color:' + farbe + '">'
                + '<div class="timer-progress-bg" id="progress-' + sid + '"></div>'
                + '<div class="card-content">'
                +   '<div class="schueler-header">'
                +     '<div class="schueler-name-container">'
                +       '<div class="schueler-name">' + (s.vorname || '') + ' ' + (s.nachname || '') + '</div>'
                +       (s.klasse ? '<span class="klassen-badge" style="background:' + farbe + ';color:' + tf + '">' + s.klasse + '</span>' : '')
                +       '<span class="timer-badge" id="badge-' + sid + '"></span>'
                +     '</div>'
                +     (s.datum ? '<div class="schueler-datum" style="background:' + farbe + ';color:' + tf + '">' + s.datum + '</div>' : '')
                +   '</div>'
                +   '<div class="schueler-details">'
                +     (s.fach ? '<div class="detail-item"><span class="dl">Fach:</span> ' + s.fach + '</div>' : '')
                +     (s.pruefer ? '<div class="detail-item"><span class="dl">Prüfer:</span> ' + s.pruefer + '</div>' : '')
                +     (s.beisitz ? '<div class="detail-item"><span class="dl">Beisitz:</span> ' + s.beisitz + '</div>' : '')
                +     (s.exam_start ? '<div class="detail-item"><span class="dl">Prüfung:</span> ' + s.exam_start + ' - ' + (s.exam_end || '?') + '</div>' : '')
                +   '</div>'
                +   '<div class="expand-hint" id="hint-' + sid + '">▼ Klicken zum Öffnen</div>'
                +   '<div class="expanded-section" id="exp-' + sid + '">'
                +     '<div class="expanded-content" id="expcontent-' + sid + '"></div>'
                +   '</div>'
                + '</div></div>';
        }).join('');

        res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HTL - Matura Übersicht</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#07175e;min-height:100vh;padding:40px 20px}
.container{background:#fff;border-radius:20px;padding:60px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:1050px;margin:0 auto}
h1{color:#333;font-size:2.2em;margin-bottom:10px;text-align:center}p.subtitle{color:#666;font-size:1.2em;margin-top:10px;text-align:center;margin-bottom:30px}
.schueler-liste{margin-top:20px}
.schueler-item{position:relative;margin:15px 0;border-radius:12px;border-left:5px solid #333;box-shadow:0 2px 5px rgba(0,0,0,.1);cursor:pointer;overflow:hidden;transition:box-shadow .3s,transform .2s}
.schueler-item:hover{transform:translateX(5px);box-shadow:0 4px 12px rgba(0,0,0,.15)}.schueler-item.expanded{transform:none;box-shadow:0 6px 25px rgba(0,0,0,.2)}
.timer-progress-bg{position:absolute;top:0;left:0;height:100%;width:0%;z-index:0;pointer-events:none;transition:width .8s linear}.card-content{position:relative;z-index:1;padding:20px}
.schueler-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:10px}
.schueler-name-container{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.schueler-name{font-weight:700;font-size:1.3em;color:#222}
.klassen-badge{padding:4px 12px;border-radius:15px;font-size:.8em;font-weight:700}
.schueler-datum{padding:5px 15px;border-radius:20px;font-size:.9em;font-weight:700}
.schueler-details{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:10px}.detail-item{color:#444;font-size:.95em;padding:5px}.dl{font-weight:700;color:#222}
.timer-badge{display:none;padding:4px 14px;border-radius:15px;font-size:.85em;font-weight:700}.timer-badge.visible{display:inline-block}
.timer-badge.st-prep{background:#ffe0cc;color:#c0392b}.timer-badge.st-paused{background:#ff9800;color:#fff}.timer-badge.st-prep-done{background:#ff9800;color:#fff}.timer-badge.st-exam{background:#fff3cd;color:#856404}.timer-badge.st-done{background:#4caf50;color:#fff}
.expand-hint{text-align:right;font-size:.8em;color:#aaa;margin-top:8px}.schueler-item.expanded .expand-hint{opacity:0;height:0;margin:0;overflow:hidden}
.expanded-section{max-height:0;overflow:hidden;transition:max-height .4s ease}.schueler-item.expanded .expanded-section{max-height:800px}
.expanded-content{border-top:2px solid rgba(0,0,0,.08);padding-top:20px;margin-top:15px}
.timer-display{text-align:center;margin-bottom:15px}.timer-time{font-size:2.8em;font-weight:700;color:#222;font-variant-numeric:tabular-nums;letter-spacing:3px}.timer-label{font-size:.95em;color:#555;margin-top:4px}.timer-over{color:#c0392b;font-weight:700}
.timer-buttons{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:10px}
.timer-btn{padding:12px 28px;border:none;border-radius:10px;font-size:1.05em;font-weight:700;cursor:pointer;transition:all .2s;box-shadow:0 3px 8px rgba(0,0,0,.15)}.timer-btn:hover{transform:translateY(-2px);box-shadow:0 5px 15px rgba(0,0,0,.25)}.timer-btn:active{transform:translateY(0)}
.btn-start{background:#f0c230;color:#333}.btn-start:hover{background:#e6b420}.btn-pause{background:#ff9800;color:#fff}.btn-pause:hover{background:#e68900}.btn-resume{background:#4caf50;color:#fff}.btn-resume:hover{background:#43a047}.btn-reset{background:#f44336;color:#fff}.btn-reset:hover{background:#d32f2f}.btn-skip{background:#9c27b0;color:#fff}.btn-skip:hover{background:#7b1fa2}.btn-exam{background:#2196f3;color:#fff}.btn-exam:hover{background:#1976d2}.btn-finish{background:#4caf50;color:#fff}.btn-finish:hover{background:#388e3c}.btn-finish:disabled{background:#ccc;color:#888;cursor:not-allowed;transform:none;box-shadow:none}
.exam-form{margin-top:20px;padding:20px;background:rgba(255,255,255,.8);border-radius:10px;border:2px solid #e0e0e0}.exam-form h3{margin-bottom:15px;color:#333;text-align:center;font-size:1.2em}
.form-row{display:flex;gap:15px;margin-bottom:12px;align-items:center;flex-wrap:wrap}.form-row label{font-weight:700;min-width:120px;color:#333}.form-row select,.form-row textarea{padding:8px 12px;border:2px solid #ddd;border-radius:8px;font-size:1em;transition:border .2s}.form-row select:focus,.form-row textarea:focus{border-color:#2196f3;outline:none}.form-row select{min-width:100px}.form-row textarea{flex:1;min-height:60px;resize:vertical}.pflicht{color:#c0392b;font-size:.8em;margin-left:4px}
.zeit-info{text-align:center;margin:15px 0;padding:10px;border-radius:8px;font-weight:700;font-size:1.1em}.zeit-info.over{background:#ffebee;color:#c0392b}.zeit-info.under{background:#e8f5e9;color:#2e7d32}
.done-card{text-align:center;padding:20px}.done-card h3{color:#4caf50;margin-bottom:10px;font-size:1.3em}.done-info{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:15px;text-align:left}.done-info div{padding:8px;background:rgba(0,0,0,.03);border-radius:6px}
.confirm-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:10000;justify-content:center;align-items:center}.confirm-overlay.active{display:flex}.confirm-box{background:#fff;border-radius:15px;padding:30px 40px;max-width:400px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.3)}.confirm-box h3{margin-bottom:15px;color:#333}.confirm-box p{margin-bottom:20px;color:#666}.confirm-box .cbtns{display:flex;gap:10px;justify-content:center}.confirm-box .cbtns button{padding:10px 25px;border:none;border-radius:8px;font-size:1em;font-weight:700;cursor:pointer}.cbtn-yes{background:#f44336;color:#fff}.cbtn-no{background:#9e9e9e;color:#fff}
.logout-btn{display:inline-block;margin-bottom:20px;padding:10px 20px;background:#666;color:#fff;text-decoration:none;border-radius:8px;font-size:.9em;transition:background .3s}.logout-btn:hover{background:#444}
@media(max-width:600px){.container{padding:30px 15px}.timer-time{font-size:2em}.timer-btn{padding:10px 18px;font-size:.95em}.form-row{flex-direction:column}.form-row label{min-width:auto}}
</style></head><body>
<div class="container">
  <a href="/logout" class="logout-btn">Abmelden</a>
  <h1>Matura Übersicht</h1>
  ${schueler.length > 0 ? '<p class="subtitle">' + schueler.length + ' Schüler maturieren</p>' : '<p class="subtitle">Keine Schüler gefunden.</p>'}
  ${schueler.length > 0 ? '<div class="schueler-liste">' + cardsHtml + '</div>' : ''}
</div>
<div class="confirm-overlay" id="confirmOverlay"><div class="confirm-box"><h3>Wirklich zurücksetzen?</h3><p id="confirmText">Möchten Sie wirklich zurücksetzen?</p><div class="cbtns"><button class="cbtn-yes" id="confirmYes">Ja, zurücksetzen</button><button class="cbtn-no" id="confirmNo">Abbrechen</button></div></div></div>
${globalWidgetHtml()}
<script>
(function(){
var PREP=${VORBEREITUNGS_TIMER},EXAM=${PRUEFUNGS_TIMER},T={};
function g(sid){if(!T[sid])T[sid]={state:'idle',rem:PREP,iid:null,examState:'idle',examRem:EXAM,eiid:null,note:null,themen:null,komm:'',zeitDiff:null};return T[sid];}
function fmt(s){var neg=s<0;s=Math.abs(s);var m=Math.floor(s/60),sc=Math.floor(s%60);return(neg?'+':'')+(m<10?'0':'')+m+':'+(sc<10?'0':'')+sc;}
function prepColor(p){var r=Math.round(231+(255-231)*p),g2=Math.round(76+(152-76)*p),b=Math.round(60+(0-60)*p);return 'rgba('+r+','+g2+','+b+',0.4)';}
function examColor(p){var r=Math.round(240+(76-240)*p),g2=Math.round(194+(175-194)*p),b=Math.round(48+(80-48)*p);return 'rgba('+r+','+g2+','+b+',0.45)';}
function tickUpdate(sid){var t=g(sid),prog=document.getElementById('progress-'+sid),badge=document.getElementById('badge-'+sid),timeEl=document.querySelector('#expcontent-'+sid+' .timer-time'),labEl=document.querySelector('#expcontent-'+sid+' .timer-label');if(!prog)return;if(t.state==='running'){var p=Math.max(0,Math.min(1,1-(t.rem/PREP)));prog.style.width=(p*100)+'%';prog.style.backgroundColor=prepColor(p);if(badge){badge.className='timer-badge visible st-prep';badge.textContent=fmt(t.rem)+' ⏱';}if(timeEl)timeEl.textContent=fmt(t.rem);}else if(t.examState==='running'){var ep=t.examRem>=0?Math.max(0,Math.min(1,1-(t.examRem/EXAM))):1;prog.style.width=(ep*100)+'%';prog.style.backgroundColor=t.examRem<0?'rgba(231,76,60,0.35)':examColor(ep);if(badge){badge.className='timer-badge visible st-exam';badge.textContent=(t.examRem<0?'ÜBER ':'')+fmt(t.examRem)+' ⏱';}if(timeEl){timeEl.textContent=(t.examRem<0?'+':'')+fmt(t.examRem);timeEl.style.color=t.examRem<0?'#c0392b':'#222';}if(labEl)labEl.innerHTML=t.examRem<0?'<span class="timer-over">Prüfung überzogen!</span>':'Prüfung läuft...';}}
function render(sid){var t=g(sid),card=document.getElementById('card-'+sid),prog=document.getElementById('progress-'+sid),badge=document.getElementById('badge-'+sid),ec=document.getElementById('expcontent-'+sid);if(!card||!ec)return;var html='',p;if(t.state==='idle'){prog.style.width='0%';prog.style.backgroundColor='transparent';badge.className='timer-badge';html='<div class="timer-display"><div class="timer-time">'+fmt(PREP)+'</div><div class="timer-label">Vorbereitung</div></div><div class="timer-buttons"><button class="timer-btn btn-start" data-action="start" data-sid="'+sid+'">Vorbereitung starten</button></div>';}else if(t.state==='running'){p=Math.max(0,Math.min(1,1-(t.rem/PREP)));prog.style.width=(p*100)+'%';prog.style.backgroundColor=prepColor(p);badge.className='timer-badge visible st-prep';badge.textContent=fmt(t.rem)+' ⏱';html='<div class="timer-display"><div class="timer-time">'+fmt(t.rem)+'</div><div class="timer-label">Vorbereitung läuft...</div></div><div class="timer-buttons"><button class="timer-btn btn-pause" data-action="pause" data-sid="'+sid+'">Pause</button><button class="timer-btn btn-skip" data-action="skip_prep" data-sid="'+sid+'">Überspringen ⏭</button><button class="timer-btn btn-reset" data-action="reset" data-sid="'+sid+'">Reset</button></div>';}else if(t.state==='paused'){p=Math.max(0,Math.min(1,1-(t.rem/PREP)));prog.style.width=(p*100)+'%';prog.style.backgroundColor=prepColor(p);badge.className='timer-badge visible st-paused';badge.textContent=fmt(t.rem)+' ⏸';html='<div class="timer-display"><div class="timer-time">'+fmt(t.rem)+'</div><div class="timer-label">Pausiert</div></div><div class="timer-buttons"><button class="timer-btn btn-resume" data-action="resume" data-sid="'+sid+'">Fortsetzen</button><button class="timer-btn btn-skip" data-action="skip_prep" data-sid="'+sid+'">Überspringen ⏭</button><button class="timer-btn btn-reset" data-action="reset" data-sid="'+sid+'">Reset</button></div>';}else if(t.state==='prep_done'&&t.examState==='idle'){prog.style.width='100%';prog.style.backgroundColor='rgba(255,152,0,0.45)';badge.className='timer-badge visible st-prep-done';badge.textContent='Vorbereitung fertig ✓';html='<div class="timer-display"><div class="timer-time" style="color:#e67e22">00:00</div><div class="timer-label" style="color:#e67e22;font-weight:700">Vorbereitung abgeschlossen! ✓</div></div><div class="timer-buttons"><button class="timer-btn btn-exam" data-action="exam_start" data-sid="'+sid+'">Prüfung starten</button></div>';}else if(t.examState==='running'){var ep=t.examRem>=0?Math.max(0,Math.min(1,1-(t.examRem/EXAM))):1;prog.style.width=(ep*100)+'%';prog.style.backgroundColor=t.examRem<0?'rgba(231,76,60,0.35)':examColor(ep);badge.className='timer-badge visible st-exam';badge.textContent=(t.examRem<0?'ÜBER ':'')+fmt(t.examRem)+' ⏱';var ts2=t.examRem<0?' style="color:#c0392b"':'';html='<div class="timer-display"><div class="timer-time"'+ts2+'>'+(t.examRem<0?'+':'')+fmt(t.examRem)+'</div><div class="timer-label">'+(t.examRem<0?'<span class="timer-over">Prüfung überzogen!</span>':'Prüfung läuft...')+'</div></div><div class="timer-buttons"><button class="timer-btn btn-pause" data-action="exam_pause" data-sid="'+sid+'">Pause</button></div>'+examFormHtml(sid,t);}else if(t.examState==='paused'){var ep3=t.examRem>=0?Math.max(0,Math.min(1,1-(t.examRem/EXAM))):1;prog.style.width=(ep3*100)+'%';prog.style.backgroundColor=t.examRem<0?'rgba(231,76,60,0.35)':examColor(ep3);badge.className='timer-badge visible st-paused';badge.textContent=fmt(t.examRem)+' ⏸';html='<div class="timer-display"><div class="timer-time">'+fmt(t.examRem)+'</div><div class="timer-label">Prüfung pausiert</div></div><div class="timer-buttons"><button class="timer-btn btn-resume" data-action="exam_resume" data-sid="'+sid+'">Fortsetzen</button></div>'+examFormHtml(sid,t);}else if(t.examState==='done'){prog.style.width='100%';prog.style.backgroundColor='rgba(76,175,80,0.35)';badge.className='timer-badge visible st-done';badge.textContent='Abgeschlossen ✓';var zd=t.zeitDiff,zdText='',zdClass='';if(zd!==null&&zd!==undefined){if(zd>0){zdText=fmt(zd)+' früher fertig';zdClass='under';}else if(zd<0){zdText=fmt(Math.abs(zd))+' überzogen';zdClass='over';}else{zdText='Genau in der Zeit';zdClass='under';}}html='<div class="done-card"><h3 style="color:#4caf50">Prüfung abgeschlossen ✓</h3>'+(zdText?'<div class="zeit-info '+zdClass+'">'+zdText+'</div>':'')+'<div class="done-info"><div><span class="dl">Note:</span> '+t.note+'</div><div><span class="dl">Themenpool:</span> '+t.themen+'</div>'+(t.komm?'<div style="grid-column:1/-1"><span class="dl">Kommentar:</span> '+t.komm+'</div>':'')+'</div></div>';}ec.innerHTML=html;}
function examFormHtml(sid,t){var noteOpts='<option value="">-- Note --</option>';for(var i=1;i<=5;i++)noteOpts+='<option value="'+i+'"'+(t.note==i?' selected':'')+'>'+i+'</option>';var thOpts='<option value="">-- Themenpool --</option>';for(var j=1;j<=8;j++)thOpts+='<option value="'+j+'"'+(t.themen==j?' selected':'')+'>'+j+'</option>';return '<div class="exam-form"><h3>Prüfungsergebnis eintragen</h3><div class="form-row"><label>Note<span class="pflicht">*</span></label><select id="note-'+sid+'" data-field="note" data-sid="'+sid+'">'+noteOpts+'</select></div><div class="form-row"><label>Themenpool<span class="pflicht">*</span></label><select id="themen-'+sid+'" data-field="themen" data-sid="'+sid+'">'+thOpts+'</select></div><div class="form-row"><label>Kommentar</label><textarea id="komm-'+sid+'" data-field="komm" data-sid="'+sid+'" placeholder="Optional...">'+(t.komm||'')+'</textarea></div><div class="timer-buttons"><button class="timer-btn btn-finish" data-action="exam_finish" data-sid="'+sid+'">Prüfung abschließen</button></div></div>';}
function prepTick(sid){var t=g(sid);if(t.state!=='running')return;t.rem=Math.max(0,t.rem-1);if(t.rem<=0){t.state='prep_done';if(t.iid){clearInterval(t.iid);t.iid=null;}api(sid,'prep_done');render(sid);}else tickUpdate(sid);}
function examTick(sid){var t=g(sid);if(t.examState!=='running')return;t.examRem-=1;tickUpdate(sid);}
function api(sid,action,body){var o={method:'POST',headers:{'Content-Type':'application/json'}};if(body)o.body=JSON.stringify(body);fetch('/api/timer/'+sid+'/'+action,o).catch(function(e){console.warn('Sync:',e);});}
function sortCards(){var l=document.querySelector('.schueler-liste');if(!l)return;var c=Array.from(l.querySelectorAll('.schueler-item'));c.sort(function(a,b){return(g(a.getAttribute('data-sid')).examState==='done'?1:0)-(g(b.getAttribute('data-sid')).examState==='done'?1:0);});c.forEach(function(x){l.appendChild(x);});}
var pendingResetSid=null,ov=document.getElementById('confirmOverlay'),ct=document.getElementById('confirmText');
document.getElementById('confirmYes').addEventListener('click',function(){if(pendingResetSid){var t=g(pendingResetSid);if(t.iid)clearInterval(t.iid);if(t.eiid)clearInterval(t.eiid);t.iid=null;t.eiid=null;t.state='idle';t.rem=PREP;t.examState='idle';t.examRem=EXAM;t.note=null;t.themen=null;t.komm='';t.zeitDiff=null;render(pendingResetSid);api(pendingResetSid,'reset');sortCards();}ov.classList.remove('active');pendingResetSid=null;});
document.getElementById('confirmNo').addEventListener('click',function(){ov.classList.remove('active');pendingResetSid=null;});
document.addEventListener('click',function(e){var btn=e.target.closest('.timer-btn');if(btn){e.stopPropagation();e.preventDefault();var action=btn.getAttribute('data-action'),sid=btn.getAttribute('data-sid');if(!action||!sid)return;var t=g(sid);if(action==='start'){if(t.iid)clearInterval(t.iid);t.state='running';t.rem=PREP;t.iid=setInterval(function(){prepTick(sid);},1000);render(sid);api(sid,'start');}else if(action==='pause'){t.state='paused';if(t.iid){clearInterval(t.iid);t.iid=null;}render(sid);api(sid,'pause',{remaining_seconds:t.rem});}else if(action==='resume'){t.state='running';if(t.iid)clearInterval(t.iid);t.iid=setInterval(function(){prepTick(sid);},1000);render(sid);api(sid,'resume');}else if(action==='skip_prep'){if(t.iid){clearInterval(t.iid);t.iid=null;}t.state='prep_done';t.rem=0;render(sid);api(sid,'prep_done');}else if(action==='reset'){var card=document.getElementById('card-'+sid),ne=card?card.querySelector('.schueler-name'):null;ct.textContent='Möchten Sie "'+(ne?ne.textContent.trim():'diesen Schüler')+'" wirklich zurücksetzen?';pendingResetSid=sid;ov.classList.add('active');}else if(action==='exam_start'){t.examState='running';t.examRem=EXAM;if(t.eiid)clearInterval(t.eiid);t.eiid=setInterval(function(){examTick(sid);},1000);var c2=document.getElementById('card-'+sid);if(c2)c2.classList.add('expanded');render(sid);api(sid,'exam_start');}else if(action==='exam_pause'){t.examState='paused';if(t.eiid){clearInterval(t.eiid);t.eiid=null;}render(sid);api(sid,'exam_pause',{exam_remaining:t.examRem});}else if(action==='exam_resume'){t.examState='running';if(t.eiid)clearInterval(t.eiid);t.eiid=setInterval(function(){examTick(sid);},1000);render(sid);api(sid,'exam_resume');}else if(action==='exam_finish'){var noteEl=document.getElementById('note-'+sid),thEl=document.getElementById('themen-'+sid),koEl=document.getElementById('komm-'+sid),note=noteEl?noteEl.value:'',th=thEl?thEl.value:'',ko=koEl?koEl.value:'';if(!note||!th){alert('Bitte Note und Themenpool auswählen!');return;}if(t.eiid){clearInterval(t.eiid);t.eiid=null;}t.examState='done';t.note=parseInt(note);t.themen=parseInt(th);t.komm=ko;t.zeitDiff=t.examRem;render(sid);api(sid,'exam_finish',{note:t.note,themenpool:t.themen,kommentar:ko,zeit_differenz:t.zeitDiff});sortCards();}return;}if(e.target.closest('.exam-form')){e.stopPropagation();return;}var card=e.target.closest('.schueler-item');if(card)card.classList.toggle('expanded');});
document.addEventListener('change',function(e){var el=e.target;if(el.matches('select[data-field]')){var sid=el.getAttribute('data-sid'),f=el.getAttribute('data-field'),t=g(sid);if(f==='note')t.note=parseInt(el.value)||null;if(f==='themen')t.themen=parseInt(el.value)||null;}});
document.addEventListener('input',function(e){var el=e.target;if(el.matches('textarea[data-field]'))g(el.getAttribute('data-sid')).komm=el.value;});
document.addEventListener('mousedown',function(e){if(e.target.closest('.exam-form'))e.stopPropagation();},true);
document.querySelectorAll('.schueler-item').forEach(function(c){var sid=c.getAttribute('data-sid');if(sid)render(sid);});
fetch('/api/timers/all').then(function(r){return r.json();}).then(function(data){applyServerData(data,true);}).catch(function(e){console.warn('Load:',e);});
function applyServerData(data,isInit){var changed=false;for(var sid in data){if(!data.hasOwnProperty(sid))continue;var info=data[sid],t=g(sid);var oldKey=t.state+'|'+t.examState;var newState=info.state||'idle';var newExam=info.exam_state||'idle';
t.state=newState;t.examState=newExam;
t.rem=Math.max(0,info.remaining_seconds);
t.examRem=info.exam_remaining!==undefined?info.exam_remaining:EXAM;
if(t.state==='prep_done')t.rem=0;
if(t.state==='running'&&t.rem>0){if(!t.iid){(function(id){t.iid=setInterval(function(){prepTick(id);},1000);})(sid);}}else{if(t.iid){clearInterval(t.iid);t.iid=null;}}
if(t.examState==='running'){if(!t.eiid){(function(id){t.eiid=setInterval(function(){examTick(id);},1000);})(sid);}}else{if(t.eiid){clearInterval(t.eiid);t.eiid=null;}}
var newKey=t.state+'|'+t.examState;if(isInit||oldKey!==newKey){render(sid);changed=true;}}if(changed)sortCards();}
setInterval(function(){fetch('/api/timers/all').then(function(r){return r.json();}).then(function(data){applyServerData(data,false);}).catch(function(){});},3000);
})();
</script></body></html>`);
    } catch(err) { console.error(err); res.status(500).send('Fehler'); }
});

// ==================== HTTPS ====================
const httpsOptions = { key: fs.readFileSync('./cert/key.pem'), cert: fs.readFileSync('./cert/cert.pem') };
https.createServer(httpsOptions, app).listen(process.env.PORT || port, () => {
    console.log('HTTPS auf https://localhost:' + (process.env.PORT || port));
});
process.on('SIGINT', () => { db.close(() => process.exit(0)); });