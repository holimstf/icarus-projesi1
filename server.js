const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg'); // PostgreSQL kütüphanesi
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;
const saltRounds = 10;

// Supabase'den gelen gizli adresi kullanarak veritabanına bağlan
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Sunucu her başladığında, tabloların var olup olmadığını kontrol et/oluştur
const initializeDatabase = async () => {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL);`);
        await client.query(`CREATE TABLE IF NOT EXISTS projects (id SERIAL PRIMARY KEY, name TEXT NOT NULL, user_id INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);`);
        await client.query(`CREATE TABLE IF NOT EXISTS segments (id SERIAL PRIMARY KEY, source_text TEXT NOT NULL, translation_text TEXT, project_id INTEGER NOT NULL, FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE);`);
        console.log('Veritabanı tabloları başarıyla kontrol edildi/oluşturuldu.');
    } catch (err) {
        console.error('Veritabanı kurulum hatası:', err);
    } finally {
        client.release();
    }
};

app.use(express.json());
const upload = multer({ dest: '/tmp' }); // Vercel için geçici klasör '/tmp' olmalı

app.use(session({
    secret: 'bu-cok-gizli-bir-anahtar-olmali-ve-uzun',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

const isAuthenticated = (req, res, next) => { if (req.session.userId) next(); else res.status(401).json({ error: 'Lütfen giriş yapın.' }); };

// --- TÜM API'LER (PostgreSQL'e güncellendi) ---
app.post('/api/register', async (req, res) => { const { username, password } = req.body; if (!username || !password) return res.status(400).json({ message: 'Kullanıcı adı ve şifre gerekli.' }); try { const hashedPassword = bcrypt.hashSync(password, saltRounds); const result = await pool.query('INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id', [username, hashedPassword]); req.session.userId = result.rows[0].id; res.json({ success: true, username: username }); } catch (error) { res.status(409).json({ message: 'Bu kullanıcı adı zaten alınmış.' }); } });
app.post('/api/login', async (req, res) => { const { username, password } = req.body; const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]); const user = result.rows[0]; if (user && bcrypt.compareSync(password, user.password)) { req.session.userId = user.id; res.json({ success: true, username: user.username }); } else { res.status(401).json({ message: 'Geçersiz kullanıcı adı veya şifre.' }); } });
app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });
app.get('/api/session', async (req, res) => { if (req.session.userId) { const result = await pool.query('SELECT id, username FROM users WHERE id = $1', [req.session.userId]); res.json({ loggedIn: true, user: result.rows[0] }); } else { res.json({ loggedIn: false }); } });
app.get('/api/projects', isAuthenticated, async (req, res) => { const result = await pool.query('SELECT * FROM projects WHERE user_id = $1', [req.session.userId]); res.json(result.rows); });
app.get('/api/segments/:projectId', isAuthenticated, async (req, res) => { const project = await pool.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [req.params.projectId, req.session.userId]); if (project.rows.length === 0) return res.status(403).json({ error: 'Yetkisiz erişim.' }); const segments = await pool.query('SELECT id, source_text AS source, translation_text AS translation FROM segments WHERE project_id = $1', [req.params.projectId]); res.json(segments.rows); });
app.post('/api/save', isAuthenticated, async (req, res) => { const { id, newTranslation } = req.body; await pool.query('UPDATE segments SET translation_text = $1 WHERE id = $2', [newTranslation, id]); res.json({ success: true }); });
app.post('/api/upload', isAuthenticated, upload.single('projectFile'), async (req, res) => { const client = await pool.connect(); try { await client.query('BEGIN'); const { projectName } = req.body; const file = req.file; const projectResult = await client.query('INSERT INTO projects (name, user_id) VALUES ($1, $2) RETURNING id', [projectName, req.session.userId]); const newProjectId = projectResult.rows[0].id; const fileContent = fs.readFileSync(file.path, 'utf-8'); let segmentsToInsert = []; if (path.extname(file.originalname).toLowerCase() === '.json') { const jsonObject = JSON.parse(fileContent); for (const key in jsonObject) segmentsToInsert.push({ source: key, translation: jsonObject[key] || '' }); } else if (path.extname(file.originalname).toLowerCase() === '.txt') { const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== ''); lines.forEach(line => segmentsToInsert.push({ source: line, translation: '' })); } for (const seg of segmentsToInsert) { await client.query('INSERT INTO segments (source_text, translation_text, project_id) VALUES ($1, $2, $3)', [seg.source, seg.translation, newProjectId]); } await client.query('COMMIT'); fs.unlinkSync(file.path); res.json({ success: true, newProjectId: newProjectId }); } catch (e) { await client.query('ROLLBACK'); console.error("Yükleme hatası:", e); res.status(500).json({ success: false, message: 'Proje oluşturulamadı.' }); } finally { client.release(); } });
app.delete('/api/projects/:projectId', isAuthenticated, async (req, res) => { const project = await pool.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [req.params.projectId, req.session.userId]); if (project.rows.length === 0) return res.status(403).json({ message: 'Bu projeyi silme yetkiniz yok.' }); await pool.query('DELETE FROM projects WHERE id = $1', [req.params.projectId]); res.json({ success: true }); });

// Vercel, public klasörünü otomatik olarak sunar, bu satıra gerek kalmaz ama zararı da olmaz.
app.use(express.static(path.join(__dirname, 'public'))); 

// Sunucu başlamadan önce veritabanını başlat
initializeDatabase().then(() => {
    app.listen(PORT, () => console.log(`ICARUS sunucusu http://localhost:${PORT} adresinde çalışıyor!`));
});