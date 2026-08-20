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
  CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY, driverId TEXT, pickup TEXT, dropoff TEXT, departure TEXT,
    price REAL, max_seats INTEGER, status TEXT DEFAULT 'scheduled', created TEXT
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY, tripId TEXT, riderId TEXT, status TEXT DEFAULT 'paid', created TEXT
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

// ponytail: carpool — trips + bookings. Add payment gateway when real money flows.
const insertTrip = db.prepare('INSERT INTO trips (id,driverId,pickup,dropoff,departure,price,max_seats,created) VALUES (?,?,?,?,?,?,?,?)');
const getTrip = db.prepare('SELECT * FROM trips WHERE id=?');
const getUpcomingTrips = db.prepare("SELECT t.*, u.name as driverName FROM trips t JOIN users u ON t.driverId=u.id WHERE t.departure > ? AND t.status='scheduled' ORDER BY t.departure");
const getDriverTrips = db.prepare('SELECT * FROM trips WHERE driverId=? ORDER BY departure DESC');
const updateTripStatus = db.prepare('UPDATE trips SET status=? WHERE id=?');
const insertBooking = db.prepare('INSERT INTO bookings (id,tripId,riderId,created) VALUES (?,?,?,?)');
const getBookings = db.prepare('SELECT b.*, u.name as riderName FROM bookings b JOIN users u ON b.riderId=u.id WHERE b.tripId=?');
const getMyBookings = db.prepare('SELECT b.*, t.pickup, t.dropoff, t.departure, t.price, u.name as driverName FROM bookings b JOIN trips t ON b.tripId=t.id JOIN users u ON t.driverId=u.id WHERE b.riderId=? ORDER BY t.departure DESC');
const getRiderCount = db.prepare('SELECT COUNT(*) as cnt FROM bookings WHERE tripId=? AND status=?');
const updateBooking = db.prepare('UPDATE bookings SET status=? WHERE id=?');
const getBooking = db.prepare('SELECT * FROM bookings WHERE id=?');

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

// ponytail: panic — sets ride to panicked. Admin sees it in red.
app.put('/api/rides/:id/panic', auth, (req, res) => {
  const ride = getRide.get(req.params.id);
  if (!ride) return res.status(404).json({ error: 'not found' });
  if (ride.clientId !== req.user.id && ride.driverId !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'not your ride' });
  db.prepare("UPDATE rides SET status='panicked' WHERE id=?").run(req.params.id);
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

app.get('/api/carpool/admin/trips', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const trips = db.prepare('SELECT * FROM trips ORDER BY departure DESC').all();
  res.json(trips);
});

// --- Carpool ---

app.post('/api/carpool/trips', auth, (req, res) => {
  const { pickup, dropoff, departure, price, max_seats } = req.body;
  if (!pickup || !dropoff || !departure || !price || !max_seats) return res.status(400).json({ error: 'pickup, dropoff, departure, price, max_seats required' });
  const id = uuid();
  insertTrip.run(id, req.user.id, pickup, dropoff, departure, price, max_seats, new Date().toISOString());
  res.status(201).json(getTrip.get(id));
});

app.get('/api/carpool/trips', auth, (req, res) => {
  let list;
  if (req.user.role === 'driver' && req.query.mine === '1') list = getDriverTrips.all(req.user.id);
  else if (req.user.role === 'driver' && req.query.mine === '1') list = getDriverTrips.all(req.user.id);
  else {
    const now = new Date().toISOString();
    list = getUpcomingTrips.all(now);
    // attach booking counts
    list = list.map(t => { t.booked = getRiderCount.get(t.id, 'paid').cnt; return t; });
  }
  res.json(list);
});

app.get('/api/carpool/my-bookings', auth, (req, res) => {
  res.json(getMyBookings.all(req.user.id));
});

app.get('/api/carpool/trips/:id', auth, (req, res) => {
  const trip = getTrip.get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'not found' });
  trip.bookings = getBookings.all(req.params.id);
  trip.booked = trip.bookings.filter(b => b.status === 'paid').length;
  res.json(trip);
});

app.post('/api/carpool/trips/:id/book', auth, (req, res) => {
  const trip = getTrip.get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'not found' });
  if (trip.status !== 'scheduled') return res.status(400).json({ error: 'trip not available' });
  const booked = getRiderCount.get(req.params.id, 'paid').cnt;
  if (booked.cnt >= trip.max_seats) return res.status(400).json({ error: 'trip full' });
  const existing = getMyBookings.all(req.user.id).find(b => b.tripId === req.params.id && b.status === 'paid');
  if (existing) return res.status(400).json({ error: 'already booked' });
  // ponytail: credits not implemented — free booking. Add payment when real money flows.
  const id = uuid();
  insertBooking.run(id, req.params.id, req.user.id, new Date().toISOString());
  res.status(201).json(getBooking.get(id));
});

app.put('/api/carpool/bookings/:id/board', auth, (req, res) => {
  const b = getBooking.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  const trip = getTrip.get(b.tripId);
  if (trip.driverId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'not your trip' });
  if (b.status !== 'paid') return res.status(400).json({ error: 'already boarded or missed' });
  updateBooking.run('boarded', req.params.id);
  res.json(getBooking.get(req.params.id));
});

app.put('/api/carpool/trips/:id/depart', auth, (req, res) => {
  const trip = getTrip.get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'not found' });
  if (trip.driverId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'not your trip' });
  if (trip.status !== 'scheduled') return res.status(400).json({ error: 'already departed' });
  // Mark all unboarded paid bookings as missed
  const paid = getBookings.all(req.params.id).filter(b => b.status === 'paid');
  paid.forEach(b => updateBooking.run('missed', b.id));
  updateTripStatus.run('departed', req.params.id);
  res.json(getTrip.get(req.params.id));
});

// ponytail: carpool panic — driver, rider in trip, or admin can trigger
app.put('/api/carpool/trips/:id/panic', auth, (req, res) => {
  const trip = getTrip.get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'not found' });
  const isRider = getBookings.all(req.params.id).some(b => b.riderId === req.user.id && b.status !== 'missed');
  if (trip.driverId !== req.user.id && !isRider && req.user.role !== 'admin') return res.status(403).json({ error: 'not your trip' });
  if (trip.status === 'completed' || trip.status === 'cancelled') return res.status(400).json({ error: 'trip already ended' });
  updateTripStatus.run('panicked', req.params.id);
  res.json(getTrip.get(req.params.id));
});

// --- Static files ---

app.get('/manifest.json', (req, res) => res.sendFile(__dirname + '/manifest.json'));
app.get('/sw.js', (req, res) => res.sendFile(__dirname + '/sw.js'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));
app.get('/client', (req, res) => res.sendFile(__dirname + '/client.html'));
app.get('/driver', (req, res) => res.sendFile(__dirname + '/driver.html'));
app.get('/carpool', (req, res) => res.sendFile(__dirname + '/carpool.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RideSA API running on :${PORT}`));