// routes/technician.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const requireRole = require('../middleware/requireRole');
const webPush = require('web-push');
const jwt = require('jsonwebtoken');

// -------- Import shared subscriptions --------
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
      console.warn('Failed to send notification to', targetGlobalId, err);
    }
  }
}

// helper to read affected count from different DB drivers
function getAffectedCount(result) {
  if (!result) return undefined;
  if (typeof result.affectedRows === 'number') return result.affectedRows;
  if (Array.isArray(result.rowsAffected) && typeof result.rowsAffected[0] === 'number')
    return result.rowsAffected[0];
  if (typeof result.rowsAffected === 'number') return result.rowsAffected;
  return undefined;
}

// -------- JWT Middleware (cookie first, then Authorization header) --------
function authenticateJWT(req, res, next) {
  let token = req.cookies?.token;

  if (!token && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized - No token provided' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.error('JWT verify error (technician routes):', err);
      return res.status(401).json({ error: 'Unauthorized - Invalid token' });
    }
    req.user = user; // attach decoded payload
    next();
  });
}

// ==============================
// GET: Technician Dashboard
// Roles: technician, planner, admin
// ==============================
router.get(
  '/dashboard/technician',
  authenticateJWT,
  requireRole(['technician', 'planner', 'admin']),
  async (req, res) => {
    const { globalId, role, location } = req.user || req.session?.user || {};

    if (!globalId) return res.redirect('/login');

    try {
      let query = `
      SELECT 
        t.*, 
        u.name AS planner_name
      FROM tickets t
      LEFT JOIN users u ON t.planner_id = u.global_id
      WHERE t.assigned_to = ?
    `;
      const params = [globalId];

      // Location-bound filtering for non-admins
      if (role !== 'admin') {
        query += ` AND t.location = ?`;
        params.push(location);
      }

      query += ` ORDER BY t.created_at DESC`;

      const [tickets] = await db.query(query, params);

      res.render('dashboard-technician', {
        tickets,
        user: req.user || req.session?.user
      });
    } catch (err) {
      console.error('Technician dashboard error:', err);
      res.status(500).send('Error loading technician dashboard.');
    }
  }
);

// ==============================
// POST: Start Ticket
// ==============================
router.post(
  '/technician/start',
  authenticateJWT,
  requireRole(['technician', 'planner', 'admin']),
  async (req, res) => {
    const { ticketId } = req.body;
    const { role, location } = req.user || req.session?.user || {};

    if (!ticketId) return res.status(400).send('Missing ticketId');

    try {
      let query = `
      UPDATE tickets 
      SET status = ?, started_at = GETDATE(), updated_at = GETDATE()
      WHERE id = ?
    `;
      const params = ['In Progress', ticketId];

      if (role !== 'admin') {
        query += ` AND location = ?`;
        params.push(location);
      }

      const [result] = await db.query(query, params);
      const affected = getAffectedCount(result);
      if (typeof affected === 'number' && affected === 0) {
        return res.status(404).send("❌ Ticket not found or no permission.");
      }

      // Fetch ticket creator's globalId
      const [rows] = await db.query('SELECT global_id FROM tickets WHERE id = ?', [ticketId]);
      const ticketCreatorId = rows?.[0]?.global_id;
      if (ticketCreatorId) {
        sendNotificationToUser(`Your ticket #${ticketId} has been started by the technician.`, ticketCreatorId);
      }

      res.redirect('/dashboard/technician');
    } catch (err) {
      console.error("Error in /technician/start:", err);
      res.status(500).send('Error starting the ticket.');
    }
  }
);

// ==============================
// POST: Complete Ticket
// ==============================
router.post(
  '/technician/complete',
  authenticateJWT,
  requireRole(['technician', 'planner', 'admin']),
  async (req, res) => {
    const { ticketId, completion_note } = req.body;
    const { role, location } = req.user || req.session?.user || {};

    if (!ticketId) return res.status(400).send('Missing ticketId');

    try {
      let query = `
      UPDATE tickets 
      SET status = 'Completed', 
          completion_note = ?, 
          updated_at = GETDATE(),
          completed_at = GETDATE()
      WHERE id = ?
    `;
      const params = [completion_note || null, ticketId];

      if (role !== 'admin') {
        query += ` AND location = ?`;
        params.push(location);
      }

      const [result] = await db.query(query, params);
      const affected = getAffectedCount(result);
      if (typeof affected === 'number' && affected === 0) {
        return res.status(404).send("❌ Ticket not found or no permission.");
      }

      // Fetch ticket creator's globalId
      const [rows] = await db.query('SELECT global_id FROM tickets WHERE id = ?', [ticketId]);
      const ticketCreatorId = rows?.[0]?.global_id;
      if (ticketCreatorId) {
        sendNotificationToUser(`Your ticket #${ticketId} has been completed by the technician.`, ticketCreatorId);
      }

      res.redirect('/dashboard/technician');
    } catch (err) {
      console.error("Error in /technician/complete:", err);
      res.status(500).send('Internal Server Error');
    }
  }
);

// ==============================
// POST: Subscribe to Notifications
// ==============================
router.post(
  '/notifications/subscribe',
  authenticateJWT,
  (req, res) => {
    const user = req.user || req.session?.user;
    if (!user?.globalId) return res.status(401).send("Session not found. Please log in.");

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
  }
);

module.exports = router;