// app.js
const express = require('express');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./db'); // our MSSQL wrapper (exports query)
const requireRole = require('./middleware/requireRole');
const jwt = require('jsonwebtoken');
const fs = require('fs').promises;

require('dotenv').config();

const app = express();

// -------- Middleware setup --------
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

const webPush = require('web-push');

webPush.setVapidDetails(
  'mailto:info@yourcompany.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// -------- Helper: normalize db.query output --------
async function runQuery(sqlText, params = []) {
  try {
    const res = await db.query(sqlText, params);
    if (Array.isArray(res)) {
      if (res.length > 0 && Array.isArray(res[0])) {
        return res[0];
      }
      return res;
    }
    if (res && Array.isArray(res.recordset)) {
      return res.recordset;
    }
    return [];
  } catch (err) {
    console.error('DB query error:', { sqlText, params, err });
    throw err;
  }
}

// -------- Helpers --------
function authenticateJWT(req, res, next) {
  // Accept token from cookie OR Authorization header
  let token = req.cookies?.token;

  if (!token && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
  }

  // Helper to detect request expecting JSON (AJAX / fetch / API)
  const expectsJson = () => {
    try {
      const accept = (req.get('Accept') || '').toLowerCase();
      const xRequestedWith = (req.get('X-Requested-With') || '').toLowerCase();
      const contentType = (req.get('Content-Type') || '').toLowerCase();

      if (req.xhr) return true;
      if (xRequestedWith === 'xmlhttprequest') return true;
      if (accept.includes('application/json')) return true;
      if (contentType.includes('application/json')) return true;
      // If client sent Authorization header, likely an API/fetch call
      if (req.headers.authorization && typeof req.headers.authorization === 'string') return true;
      // otherwise default false
      return false;
    } catch (e) {
      return false;
    }
  };

  if (!token) {
    if (expectsJson()) {
      return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }
    return res.redirect('/login');
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.error('JWT verify error:', err);
      if (expectsJson()) {
        return res.status(401).json({ error: 'Unauthorized - Invalid token' });
      }
      return res.redirect('/login');
    }
    req.user = user; // decoded payload
    next();
  });
}

function locationFilterSQL(user) {
  return 'WHERE t.location = ?';
}
function locationFilterParams(user) {
  return [user.location];
}

// -------- Auth / Basic Routes --------
app.get('/', (req, res) => res.redirect('/login'));

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// ----- LOGIN -----
app.post('/login', async (req, res) => {
  try {
    const { globalId, password } = req.body;
    if (!globalId || !password) {
      return res.render('login', { error: 'Both fields are required' });
    }

    const id = String(globalId).trim();
    console.log('[login] lookup user global_id=', id);

    const rows = await runQuery('SELECT * FROM users WHERE global_id = ?', [id]);
    const user = rows && rows[0];
    if (!user || !user.password) {
      console.warn('[login] user not found or no password:', user);
      return res.render('login', { error: 'Invalid Global ID or unregistered user' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.render('login', { error: 'Incorrect password' });
    }

    // ✅ Create JWT
    const token = jwt.sign(
      {
        id: user.id,
        globalId: user.global_id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        department: user.department,
        role: user.department,
        location: user.location
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('✅ JWT created for user:', user.global_id);

    // ✅ Send token as HTTP-only cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    // Redirect based on department/role
    if (user.department === 'admin') {
      return res.redirect('/dashboard/admin');
    } else if (user.department === 'technician') {
      return res.redirect('/dashboard/technician');
    } else if (user.department === 'planner') {
      return res.redirect('/dashboard/planner');
    } else {
      return res.redirect('/dashboard/user');
    }

  } catch (err) {
    console.error('Login error:', err);
    return res.render('login', { error: 'Something went wrong. Check server logs.' });
  }
});

// -------- Logout Route --------
app.get('/logout', (req, res) => {
  res.clearCookie('token'); // clear the JWT cookie
  return res.redirect('/login');
});

// -------- Registration flow --------
app.get('/register', (req, res) => {
  res.render('register-id', { error: null, globalId: '' });
});

app.post('/register/check', async (req, res) => {
  try {
    const globalId = (req.body.globalId || '').trim();
    if (!globalId) {
      return res.render('register-id', { error: 'Please enter Global ID', globalId: '' });
    }

    console.log('[register/check] looking for globalId=', globalId);
    const rows = await runQuery('SELECT * FROM users WHERE global_id = ?', [globalId]);
    console.log('[register/check] db returned rows =', rows);

    const user = rows && rows[0];
    if (!user) {
      return res.render('register-id', { error: 'Global ID not found. Contact admin.', globalId });
    }

    if (user.password) {
      return res.render('register-id', { error: 'Already registered. Please login.', globalId });
    }

    return res.render('register-details', { user });
  } catch (err) {
    console.error('Register check error:', err);
    return res.render('register-id', { error: 'Server error during check', globalId: '' });
  }
});

app.post('/register/complete', async (req, res) => {
  try {
    const { globalId, password } = req.body;
    if (!globalId || !password) {
      return res.status(400).send('Missing required fields');
    }

    console.log('[register/complete] completing registration for', globalId);
    const hashed = await bcrypt.hash(password, 10);

    await runQuery('UPDATE users SET password = ? WHERE global_id = ?', [hashed, globalId]);

    return res.redirect('/login');
  } catch (err) {
    console.error('Register complete error:', err);
    return res.status(500).send('Failed to complete registration');
  }
});

// -------- Dashboards --------
app.get('/dashboard/planner', authenticateJWT, async (req, res) => {
  try {
    const locSQL = locationFilterSQL(req.user);
    const locParams = locationFilterParams(req.user);

    console.log('[planner] fetching tickets with locParams=', locParams);
    const tickets = await runQuery(
      `SELECT t.*, u.name AS assigned_to_name
       FROM tickets t
       LEFT JOIN users u ON t.assigned_to = u.global_id
       ${locSQL}
       ORDER BY t.created_at DESC`,
      locParams
    );
    console.log('[planner] tickets count=', tickets.length);

    const technicians = await runQuery(
      "SELECT global_id, name, location, department AS role FROM users WHERE department IN ('technician','planner','admin') AND location = ? ORDER BY name",
      [req.user.location]
    );
    console.log('[planner] technicians count=', technicians.length);

    res.render('dashboard-planner', {
      tickets,
      technicians,
      user: req.user
    });
  } catch (err) {
    console.error('Planner dashboard error:', err);
    res.send('Failed to load planner dashboard');
  }
});

app.get('/dashboard/admin', authenticateJWT, async (req, res) => {
  try {
    const locSQL = locationFilterSQL(req.user);
    const locParams = locationFilterParams(req.user);

    console.log('[admin] fetching tickets with locParams=', locParams);
    const tickets = await runQuery(
      `SELECT t.*, u.name AS assigned_to_name
       FROM tickets t
       LEFT JOIN users u ON t.assigned_to = u.global_id
       ${locSQL}
       ORDER BY t.created_at DESC`,
      locParams
    );
    console.log('[admin] tickets count=', tickets.length);

    const summary = { total: tickets.length, statusCounts: {}, categoryCounts: {} };
    tickets.forEach(t => {
      summary.statusCounts[t.status] = (summary.statusCounts[t.status] || 0) + 1;
      summary.categoryCounts[t.category] = (summary.categoryCounts[t.category] || 0) + 1;
    });

    res.render('admin-dashboard', {
      tickets,
      summary,
      user: req.user
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.send('Failed to load admin dashboard.');
  }
});

app.get('/dashboard/user', authenticateJWT, async (req, res) => {
  try {
    const tickets = await runQuery(
      `SELECT t.*, u.name AS assigned_to_name
       FROM tickets t
       LEFT JOIN users u ON t.assigned_to = u.global_id
       WHERE (t.global_id = ? OR t.assigned_to = ?)
         AND t.location = ?
       ORDER BY t.created_at DESC`,
      [req.user.globalId, req.user.globalId, req.user.location]
    );

    console.log('[user] tickets count for', req.user.globalId, tickets.length);

    res.render('dashboard-user', {
      tickets,
      user: req.user,
      message: req.query.message || null,
      error: req.query.error || null
    });
  } catch (err) {
    console.error('User dashboard error:', err);
    res.send('Failed to load user dashboard.');
  }
});

app.get('/dashboard/technician', authenticateJWT, async (req, res) => {
  try {
    const tickets = await runQuery(
      `SELECT t.*, u.name AS planner_name
       FROM tickets t
       LEFT JOIN users u ON t.planner_id = u.global_id
       WHERE t.assigned_to = ? AND t.location = ?
       ORDER BY t.created_at DESC`,
      [req.user.globalId, req.user.location]
    );
    console.log('[technician] tickets count=', tickets.length);
    res.render('dashboard-technician', {
      tickets,
      user: req.user
    });
  } catch (err) {
    console.error('Technician dashboard error:', err);
    res.send('Failed to load technician dashboard.');
  }
});

// -------- Mount other route modules --------
const ticketRoutes = require('./routes/ticket');
const plannerRoutes = require('./routes/planner');
const technicianRoutes = require('./routes/technician');
const adminRoutes = require('./routes/admin');
const forgotRoutes = require('./routes/forgot');
const masterRoutes = require('./routes/master');


app.use('/', ticketRoutes);
app.use('/', plannerRoutes);
app.use('/', technicianRoutes);
app.use('/', adminRoutes);
app.use('/', forgotRoutes);
app.use('/', masterRoutes);

// -------- Fallback / 404 --------
app.use((req, res) => {
  res.status(404).send('Not found');
});

// -------- Start server --------
const PORT = process.env.PORT || 3000;
(async () => {
  try {
    console.log('⏳ Running DB smoke test (SELECT 1) ...');
    const ok = await runQuery('SELECT 1 AS ok', []);
    console.log('✅ DB smoke test result:', ok);

    app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
  } catch (err) {
    console.error('❌ Failed to start server (DB issue):', err);
    process.exit(1);
  }
})();