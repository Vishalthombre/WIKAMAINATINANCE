// routes/admin.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const webPush = require('web-push');
const authenticateJWT = require('../middleware/authenticateJWT');

// -------- Import subscriptionsPerUser directly --------
const subscriptionsPerUser = require('../subscriptions');

// Helper: send notification to a specific user
async function sendNotificationToUser(message, targetGlobalId) {
  const userSubs = subscriptionsPerUser[targetGlobalId] || [];
  for (const sub of userSubs) {
    try {
      await webPush.sendNotification(
        sub,
        JSON.stringify({
          title: 'Ticket Update',
          body: message
        })
      );
    } catch (err) {
      console.warn('⚠️ Failed to send notification to', targetGlobalId, err);
    }
  }
}

// ✅ Middleware for Admin-only access
function requireAdmin(req, res, next) {
  const user = req.user;
  if (!user) return res.redirect('/login');

  // Support both role and department as admin indicators
  const role = user.role || user.department;
  if (role !== 'admin') {
    return res.redirect('/login');
  }
  next();
}

// ==============================
// GET: Admin Dashboard
// ==============================
router.get('/dashboard/admin', authenticateJWT, requireAdmin, async (req, res) => {
  const user = req.user;
  const userLocation = user?.location;

  try {
    let query = `
      SELECT 
        t.*, 
        u.name AS assigned_to_name,
        t.completed_at
      FROM tickets t
      LEFT JOIN users u ON t.assigned_to = u.global_id
      WHERE 1=1
    `;
    const params = [];

    // ✅ Location restriction unless Pune admin
    if (userLocation && userLocation !== 'Pune') {
      query += ` AND t.location = ?`;
      params.push(userLocation);
    }

    query += ` ORDER BY t.created_at DESC`;

    const result = await db.query(query, params);
    const tickets = result.recordset || result;

    // ✅ Fetch breakdown & safety tickets
    let breakdownTickets = [];
    let safetyTickets = [];
    if (userLocation && userLocation !== 'Pune') {
      const breakdownResult = await db.query(`SELECT * FROM breakdown WHERE location = ?`, [userLocation]);
      breakdownTickets = breakdownResult.recordset || breakdownResult;

      const safetyResult = await db.query(`SELECT * FROM safety WHERE location = ?`, [userLocation]);
      safetyTickets = safetyResult.recordset || safetyResult;
    } else {
      const breakdownResult = await db.query(`SELECT * FROM breakdown`);
      breakdownTickets = breakdownResult.recordset || breakdownResult;

      const safetyResult = await db.query(`SELECT * FROM safety`);
      safetyTickets = safetyResult.recordset || safetyResult;
    }

    // Summary stats
    const summary = {
      total: tickets.length,
      statusCounts: {},
      categoryCounts: {}
    };

    tickets.forEach(t => {
      summary.statusCounts[t.status] = (summary.statusCounts[t.status] || 0) + 1;
      summary.categoryCounts[t.category] = (summary.categoryCounts[t.category] || 0) + 1;
    });

    res.render('admin-dashboard', {
      tickets,
      breakdownTickets,
      safetyTickets,
      summary,
      user
    });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).send("Something went wrong loading admin dashboard.");
  }
});

// ==============================
// POST: Save Push Notification Subscription
// ==============================
router.post('/notifications/subscribe', authenticateJWT, (req, res) => {
  const user = req.user;
  if (!user?.globalId) return res.status(401).send("Unauthorized: Please log in.");

  const userId = user.globalId;
  const subscription = req.body;

  if (!subscriptionsPerUser[userId]) subscriptionsPerUser[userId] = [];

  // Avoid duplicates
  const exists = subscriptionsPerUser[userId].some(sub => sub.endpoint === subscription.endpoint);
  if (!exists) {
    subscriptionsPerUser[userId].push(subscription);
    console.log(`✅ Subscription saved for user ${userId}:`, subscription.endpoint);
  }

  res.sendStatus(201);
});

module.exports = router;