const express = require('express');
const cors = require('cors');
const { v4: uuid } = require('uuid');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());

// ponytail: SQLite, no migrations needed — schema on first run
const db = new Database('rides.db');
db.pragma('journal_mode=WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT, role TEXT, password TEXT, created TEXT
  );
  CREATE TABLE IF NOT EXISTS rides (
    id TEXT PRIMARY KEY, clientId TEXT, driverId TEXT, pickup TEXT, dropoff TEXT,
    status TEXT, fare REAL, currency TEXT DEFAULT 'ZAR', created TEXT, completed TEXT
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY, userId TEXT
  );
  CREATE TABLE IF NOT EXISTS locations (
    userId TEXT PRIMARY KEY, lat REAL, lng REAL, updated TEXT
  );
`);

// ponytail: login with phone or email
const insertUser = db.prepare('INSERT INTO users (id,name,phone,email,role,password,created) VALUES (?,?,?,?,?,?,?)');
const findByPhone = db.prepare('SELECT * FROM users WHERE phone = ?');
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findById = db.prepare('SELECT * FROM users WHERE id = ?');
const saveToken = db.prepare('INSERT OR REPLACE INTO tokens (token,userId) VALUES (?,?)');
const findToken = db.prepare('SELECT * FROM tokens WHERE token = ?');
const insertRide = db.prepare('INSERT INTO rides (id,clientId,pickup,dropoff,status,fare,created) VALUES (?,?,?,?,?,?,?)');
const updateRide = db.prepare('UPDATE rides SET driverId=?,status=? WHERE id=?');
const completeRide = db.prepare('UPDATE rides SET status=?,fare=?,completed=? WHERE id=?');
const getRide = db.prepare('SELECT * FROM rides WHERE id=?');
const getAllRides = db.prepare('SELECT * FROM rides ORDER BY created DESC');
const getClientRides = db.prepare('SELECT * FROM rides WHERE clientId=? ORDER BY created DESC');
const getDriverRides = db.prepare('SELECT * FROM rides WHERE driverId=? OR (status=? AND driverId IS NULL) ORDER BY created DESC');
const getAllUsers = db.prepare('SELECT id,name,phone,role,created FROM users');
const upsertLocation = db.prepare('INSERT OR REPLACE INTO locations (userId,lat,lng,updated) VALUES (?,?,?,?)');
const getLocation = db.prepare('SELECT * FROM locations WHERE userId=?');
const getOnlineDrivers = db.prepare("SELECT l.userId,u.name,l.lat,l.lng,l.updated FROM locations l JOIN users u ON l.userId=u.id WHERE u.role='driver' AND l.updated > ?");

// --- Auth: login with phone or email ---

app.post('/api/auth/register', (req, res) => {
  const { name, phone, email, role, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'name and password required' });
  if (!phone && !email) return res.status(400).json({ error: 'phone or email required' });
  if (phone && findByPhone.get(phone)) return res.status(409).json({ error: 'phone already registered' });
  if (email && findByEmail.get(email)) return res.status(409).json({ error: 'email already registered' });
  const id = uuid();
  insertUser.run(id, name, phone || null, email || null, role || 'client', password, new Date().toISOString());
  const token = uuid();
  saveToken.run(token, id);
  res.status(201).json({ user: { id, name, phone: phone || null, email: email || null, role: role || 'client' }, token });
});

app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'login and password required' });
  const user = login.includes('@') ? findByEmail.get(login) : findByPhone.get(login);
  if (!user || user.password !== password) return res.status(401).json({ error: 'invalid credentials' });
  const token = uuid();
  saveToken.run(token, user.id);
  res.json({ user: { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role }, token });
});

// ponytail: forgot password — knows phone/email = you. Add email reset token when SMTP exists.
app.put('/api/auth/forgot', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'login and new password required' });
  if (password.length < 4) return res.status(400).json({ error: 'password too short' });
  const user = login.includes('@') ? findByEmail.get(login) : findByPhone.get(login);
  if (!user) return res.status(404).json({ error: 'account not found' });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(password, user.id);
  res.json({ ok: true });
});

// --- Location sharing ---

app.put('/api/location', auth, (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng required' });
  upsertLocation.run(req.user.id, lat, lng, new Date().toISOString());
  res.json({ ok: true });
});

app.get('/api/location/drivers', auth, (req, res) => {
  // drivers who updated location in last 2 minutes
  const cutoff = new Date(Date.now() - 120000).toISOString();
  res.json(getOnlineDrivers.all(cutoff));
});

app.get('/api/location/:userId', auth, (req, res) => {
  const loc = getLocation.get(req.params.userId);
  if (!loc) return res.status(404).json({ error: 'no location' });
  res.json(loc);
});

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const t = token ? findToken.get(token) : null;
  if (!t) return res.status(401).json({ error: 'unauthorized' });
  req.user = findById.get(t.userId);
  next();
}

// --- Rides ---

app.post('/api/rides', auth, (req, res) => {
  if (req.user.role !== 'client' && req.user.role !== 'admin') return res.status(403).json({ error: 'only clients can request rides' });
  const { pickup, dropoff, fare } = req.body;
  if (!pickup || !dropoff) return res.status(400).json({ error: 'pickup and dropoff required' });
  const id = uuid();
  insertRide.run(id, req.user.id, pickup, dropoff, 'requested', fare || null, new Date().toISOString());
  res.status(201).json(getRide.get(id));
});

app.get('/api/rides', auth, (req, res) => {
  let list;
  if (req.user.role === 'client') list = getClientRides.all(req.user.id);
  else if (req.user.role === 'driver') list = getDriverRides.all(req.user.id, 'requested');
  else list = getAllRides.all();
  res.json(list);
});

app.get('/api/rides/:id', auth, (req, res) => {
  const ride = getRide.get(req.params.id);
  if (!ride) return res.status(404).json({ error: 'not found' });
  res.json(ride);
});

app.put('/api/rides/:id/accept', auth, (req, res) => {
  if (req.user.role !== 'driver' && req.user.role !== 'admin') return res.status(403).json({ error: 'only drivers can accept' });
  const ride = getRide.get(req.params.id);
  if (!ride) return res.status(404).json({ error: 'not found' });
  if (ride.status !== 'requested') return res.status(400).json({ error: 'already accepted' });
  updateRide.run(req.user.id, 'accepted', req.params.id);
  res.json(getRide.get(req.params.id));
});

app.put('/api/rides/:id/complete', auth, (req, res) => {
  const ride = getRide.get(req.params.id);
  if (!ride) return res.status(404).json({ error: 'not found' });
  if (ride.driverId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'not your ride' });
  if (ride.status !== 'accepted') return res.status(400).json({ error: 'ride not accepted' });
  // ponytail: use stored fare estimate, fallback to R50
  completeRide.run('completed', ride.fare || 50, new Date().toISOString(), req.params.id);
  res.json(getRide.get(req.params.id));
});

app.put('/api/rides/:id/cancel', auth, (req, res) => {
  const ride = getRide.get(req.params.id);
  if (!ride) return res.status(404).json({ error: 'not found' });
  if (ride.clientId !== req.user.id && ride.driverId !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'not your ride' });
  if (ride.status === 'completed') return res.status(400).json({ error: 'already completed' });
  db.prepare("UPDATE rides SET status='cancelled' WHERE id=?").run(req.params.id);
  res.json(getRide.get(req.params.id));
});

// --- Admin ---

app.get('/api/admin/users', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  res.json(getAllUsers.all());
});

app.get('/api/admin/rides', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  res.json(getAllRides.all());
});

// --- Static files ---

app.get('/manifest.json', (req, res) => res.sendFile(__dirname + '/manifest.json'));
app.get('/sw.js', (req, res) => res.sendFile(__dirname + '/sw.js'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));
app.get('/client', (req, res) => res.sendFile(__dirname + '/client.html'));
app.get('/driver', (req, res) => res.sendFile(__dirname + '/driver.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RideSA API running on :${PORT}`));